/**
 * Integration tests for POST /telemetry/v1/metrics.
 *
 * These drive the real Fastify route — real auth guard, real wire-level
 * stamping, real admission controls — with only the edges faked: the client
 * lookup, Redis, and the outbound call to gigapipe. That last one is captured
 * rather than stubbed away, so the assertions can inspect the exact bytes the
 * gateway would have forwarded.
 *
 * The point of testing at this level rather than on the stamping functions is
 * that the tenancy boundary is only real if the ROUTE enforces it. A unit test
 * proving `stampOtlpMetricsRequest` works says nothing about whether the
 * handler calls it, or calls it before forwarding.
 */

import zlib from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Module mocks (hoisted before imports) ───────────────────────────────────

vi.mock('@openpanel/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openpanel/db')>();
  return { ...actual, getClientByIdCached: vi.fn() };
});

vi.mock('@openpanel/common/server', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@openpanel/common/server')>();
  return { ...actual, verifyPassword: vi.fn().mockResolvedValue(true) };
});

vi.mock('@openpanel/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openpanel/redis')>();
  // The cardinality counter reads the second entry of the multi() result, so
  // the fake has to return a plausible pipeline shape rather than null.
  const pipeline = {
    pfadd: () => pipeline,
    pfcount: () => pipeline,
    hincrby: () => pipeline,
    expire: () => pipeline,
    exec: async () => [
      [null, 1],
      [null, 1],
      [null, 1],
    ],
  };
  const fakeRedisClient = new Proxy(
    {},
    {
      get: (_t, p) => {
        if (p === 'status') return 'ready';
        if (p === 'multi') return () => pipeline;
        return vi.fn().mockResolvedValue(null);
      },
    },
  );
  return {
    ...actual,
    getCache: async <T>(_k: string, _t: number, fn: () => Promise<T>) => fn(),
    getRedisCache: vi.fn().mockReturnValue(fakeRedisClient),
  };
});

// ─── Imports (after mocks) ───────────────────────────────────────────────────

import { ClientType, getClientByIdCached } from '@openpanel/db';
import {
  PROJECT_LABEL,
  readStampedProjectIds,
  seriesKeysFromMetricsPayload,
} from '@openpanel/gigapipe';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import {
  encodeLengthDelimited,
  encodeStringField,
  encodeTag,
} from '../../../../packages/gigapipe/src/otlp/wire';

// ─── Environment ─────────────────────────────────────────────────────────────

// The router registers nothing unless gigapipe is configured, so these must be
// set before buildApp() runs.
process.env.GIGAPIPE_URL = 'http://gigapipe.test';
process.env.GIGAPIPE_USER = 'op';
process.env.GIGAPIPE_PASSWORD = 'secret';

const PROJECT_ID = 'telemetry-test-project';
const CLIENT_ID = '00000000-0000-0000-0000-0000000000aa';
const AUTH = { authorization: `Bearer ${CLIENT_ID}:client-secret` };
const PROTOBUF = { 'content-type': 'application/x-protobuf' };

const telemetryClient = (type: ClientType = ClientType.telemetry) => ({
  id: CLIENT_ID,
  type,
  projectId: PROJECT_ID,
  organizationId: 'org',
  secret: 'hashed',
  name: 'Telemetry',
  cors: null,
  description: '',
  ignoreCorsAndSecret: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  project: null,
});

// ─── OTLP fixture ────────────────────────────────────────────────────────────

const kv = (key: string, value: string) =>
  Buffer.concat([
    encodeStringField(1, key),
    encodeLengthDelimited(2, encodeStringField(1, value)),
  ]);

const numberDataPoint = (attrs: Uint8Array[]) =>
  Buffer.concat([
    ...attrs.map((a) => encodeLengthDelimited(7, a)),
    Buffer.concat([encodeTag(3, 1), Buffer.alloc(8)]),
  ]);

function metricsPayload(dataPoints: Uint8Array[], resourceAttrs: Uint8Array[] = []) {
  return Buffer.from(
    encodeLengthDelimited(
      1,
      Buffer.concat([
        encodeLengthDelimited(
          1,
          Buffer.concat(resourceAttrs.map((a) => encodeLengthDelimited(1, a))),
        ),
        encodeLengthDelimited(
          2,
          encodeLengthDelimited(
            2,
            Buffer.concat([
              encodeStringField(1, 'http_requests'),
              encodeLengthDelimited(
                7,
                Buffer.concat(
                  dataPoints.map((dp) => encodeLengthDelimited(1, dp)),
                ),
              ),
            ]),
          ),
        ),
      ]),
    ),
  );
}

// ─── Captured outbound calls ─────────────────────────────────────────────────

let forwarded: { url: string; body: Buffer; headers: Record<string, string> }[] = [];
let nextForwardStatus = 200;

const originalFetch = globalThis.fetch;

// ─── Lifecycle ───────────────────────────────────────────────────────────────

let app: FastifyInstance;

beforeAll(async () => {
  globalThis.fetch = (async (url: string, init: any) => {
    forwarded.push({
      url: String(url),
      body: Buffer.from(init.body),
      headers: init.headers,
    });
    return {
      ok: nextForwardStatus < 400,
      status: nextForwardStatus,
      text: async () => 'backend said no',
    };
  }) as unknown as typeof fetch;

  app = await buildApp({ testing: true });
  await app.ready();
}, 30_000);

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await app.close();
}, 10_000);

beforeEach(() => {
  forwarded = [];
  nextForwardStatus = 200;
  vi.mocked(getClientByIdCached).mockResolvedValue(telemetryClient() as any);
});

function post(body: Buffer, headers: Record<string, string> = { ...AUTH, ...PROTOBUF }) {
  return app.inject({
    method: 'POST',
    url: '/telemetry/v1/metrics',
    headers,
    payload: body,
  });
}

// ─── Auth ────────────────────────────────────────────────────────────────────

describe('auth', () => {
  it('rejects a request with no Authorization header', async () => {
    const res = await post(metricsPayload([numberDataPoint([])]), PROTOBUF);
    expect(res.statusCode).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  it('rejects a malformed Authorization header', async () => {
    const res = await post(metricsPayload([numberDataPoint([])]), {
      ...PROTOBUF,
      authorization: 'Bearer no-colon-here',
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an ANALYTICS client — telemetry credentials only', async () => {
    // The escalation this guards: before the allow-list fix, client type was
    // never checked on the ingest paths at all.
    vi.mocked(getClientByIdCached).mockResolvedValue(
      telemetryClient(ClientType.write) as any,
    );

    const res = await post(metricsPayload([numberDataPoint([])]));
    expect(res.statusCode).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  it('never reveals which half of the credential was wrong', async () => {
    vi.mocked(getClientByIdCached).mockResolvedValue(null as any);
    const res = await post(metricsPayload([numberDataPoint([])]));

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Unauthorized' });
  });
});

// ─── Content type ────────────────────────────────────────────────────────────

describe('content type', () => {
  it('refuses anything that is not OTLP protobuf', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/telemetry/v1/metrics',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({ resourceMetrics: [] }),
    });

    expect(res.statusCode).toBe(415);
    expect(forwarded).toHaveLength(0);
  });
});

// ─── Content encoding ────────────────────────────────────────────────────────

/**
 * The OpenTelemetry Collector's otlphttp exporter gzips BY DEFAULT. A stock
 * collector pointed at these routes therefore sends gzipped protobuf, and
 * before the parser handled it the decoder read the gzip header as protobuf and
 * failed with "unsupported wire type 7 for field 3" — 0x1f is the gzip magic
 * byte and decodes as field 3, wire type 7.
 */
describe('content encoding', () => {
  it('accepts a gzipped payload and forwards it stamped', async () => {
    const raw = metricsPayload([numberDataPoint([kv('route', '/x')])]);
    const res = await post(zlib.gzipSync(raw), {
      ...AUTH,
      ...PROTOBUF,
      'content-encoding': 'gzip',
    });

    expect(res.statusCode).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(readStampedProjectIds(forwarded[0]!.body)).toEqual([PROJECT_ID]);
  });

  it('rejects a body that claims gzip but is not', async () => {
    const res = await post(Buffer.from([0x1f, 0x8b, 0x00, 0x01, 0x02]), {
      ...AUTH,
      ...PROTOBUF,
      'content-encoding': 'gzip',
    });

    expect(res.statusCode).toBe(400);
    expect(forwarded).toHaveLength(0);
  });

  // Prometheus remote-write posts the same content type with
  // `content-encoding: snappy` and decompresses in its own handler, so any
  // coding that is not gzip has to reach the handler byte-for-byte.
  it('passes a non-gzip coding through untouched', async () => {
    const raw = metricsPayload([numberDataPoint([kv('route', '/x')])]);
    const res = await post(raw, {
      ...AUTH,
      ...PROTOBUF,
      'content-encoding': 'snappy',
    });

    expect(res.statusCode).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(readStampedProjectIds(forwarded[0]!.body)).toEqual([PROJECT_ID]);
  });
});

// ─── The tenancy boundary, enforced by the route ─────────────────────────────

describe('tenancy', () => {
  it('forwards a payload stamped with the authenticated project', async () => {
    const res = await post(metricsPayload([numberDataPoint([kv('route', '/x')])]));

    expect(res.statusCode).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]!.url).toBe('http://gigapipe.test/v1/metrics');
    expect(readStampedProjectIds(forwarded[0]!.body)).toEqual([PROJECT_ID]);
  });

  it('strips a forged label the client supplied, at BOTH levels', async () => {
    const res = await post(
      metricsPayload(
        [numberDataPoint([kv('op-project-id', 'FORGED-DP'), kv('route', '/x')])],
        [kv('op–project–id', 'FORGED-RESOURCE')],
      ),
    );

    expect(res.statusCode).toBe(200);

    const body = forwarded[0]!.body;
    expect(body.includes(Buffer.from('FORGED-DP'))).toBe(false);
    expect(body.includes(Buffer.from('FORGED-RESOURCE'))).toBe(false);
    expect(readStampedProjectIds(body)).toEqual([PROJECT_ID]);

    // And the data-point series carries our label, which is what makes it
    // selectable per project at query time.
    const keys = seriesKeysFromMetricsPayload(body);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain(`${PROJECT_LABEL}=${PROJECT_ID}`);
  });

  it('never forwards client headers to gigapipe', async () => {
    // gigapipe reads X-CH-DSN and x-ttl-days from headers; forwarding either
    // would hand a caller control of backend routing.
    await post(metricsPayload([numberDataPoint([])]), {
      ...AUTH,
      ...PROTOBUF,
      'x-ch-dsn': 'attacker-controlled',
      'x-ttl-days': '9999',
    });

    const sent = Object.keys(forwarded[0]!.headers).map((h) => h.toLowerCase());
    expect(sent).not.toContain('x-ch-dsn');
    expect(sent).not.toContain('x-ttl-days');
    expect(sent).toEqual(expect.arrayContaining(['authorization', 'content-type']));
  });

  it('accepts an empty export without calling the backend', async () => {
    const res = await post(Buffer.alloc(0));
    expect(res.statusCode).toBe(200);
    expect(forwarded).toHaveLength(0);
  });

  it('rejects a payload that is not valid protobuf', async () => {
    const res = await post(Buffer.from([0xff, 0xff, 0xff, 0xff]));
    expect(res.statusCode).toBe(400);
    expect(forwarded).toHaveLength(0);
  });
});

// ─── Backend failure ─────────────────────────────────────────────────────────

describe('backend failure', () => {
  it('returns a retryable 503 when gigapipe is unavailable', async () => {
    nextForwardStatus = 502;
    const res = await post(metricsPayload([numberDataPoint([])]));

    // 503 rather than 500: OTLP clients back off on 503 and drop the batch on
    // 500.
    expect(res.statusCode).toBe(503);
  });

  it('passes a backend 400 through as a 400', async () => {
    nextForwardStatus = 400;
    const res = await post(metricsPayload([numberDataPoint([])]));
    expect(res.statusCode).toBe(400);
  });
});
