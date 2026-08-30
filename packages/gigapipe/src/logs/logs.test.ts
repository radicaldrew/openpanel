import { describe, expect, it } from 'vitest';
import { InvalidProjectIdError, PROJECT_LABEL } from '../tenancy/project-label';
import { LogQueryError, compileLogQuery } from '../logql/compile';
import {
  LOG_ENVELOPE_VERSION,
  LogIngestError,
  buildLokiPush,
  parseLogEnvelope,
} from './envelope';

const P = 'proj_123';

// ─── LogQL compiler: the read half of the boundary ───────────────────────────

describe('compileLogQuery — tenancy', () => {
  it('puts the project matcher first in every selector', () => {
    expect(compileLogQuery({}, P).logql).toBe(`{${PROJECT_LABEL}="proj_123"}`);
  });

  it('keeps it alongside user matchers', () => {
    expect(
      compileLogQuery(
        { matchers: [{ name: 'service', operator: 'eq', value: 'api' }] },
        P,
      ).logql,
    ).toBe(`{${PROJECT_LABEL}="proj_123",service="api"}`);
  });

  it('refuses a user matcher on the tenancy label', () => {
    for (const operator of ['eq', 'neq', 'match', 'notMatch'] as const) {
      expect(() =>
        compileLogQuery(
          { matchers: [{ name: PROJECT_LABEL, operator, value: '.*' }] },
          P,
        ),
      ).toThrow(LogQueryError);
    }
  });

  it('refuses an EMPTY matcher value, which the planner silently drops', () => {
    // With ADVANCED_OMIT_EMPTY_VALUES=false the LogQL planner removes matchers
    // with empty values outright (planner_stream_select.go:31-46). The flag is
    // set correctly in compose, but a config regression must not be able to
    // turn a user's filter into a wider query.
    expect(() =>
      compileLogQuery(
        { matchers: [{ name: 'service', operator: 'eq', value: '' }] },
        P,
      ),
    ).toThrow(/silently dropped/);
  });

  it('refuses an invalid project id rather than emitting an unscoped selector', () => {
    expect(() => compileLogQuery({}, '')).toThrow(InvalidProjectIdError);
  });
});

describe('compileLogQuery — injection resistance', () => {
  it('rejects a label name that is not an identifier', () => {
    expect(() =>
      compileLogQuery(
        { matchers: [{ name: 'bad"name', operator: 'eq', value: 'x' }] },
        P,
      ),
    ).toThrow(LogQueryError);
  });

  it('escapes values so a quote cannot close the selector', () => {
    const out = compileLogQuery(
      {
        matchers: [
          { name: 'service', operator: 'eq', value: 'a"} or {b="' },
        ],
      },
      P,
    ).logql;

    expect(out).toContain('service="a\\"} or {b=\\""');
    expect(out.match(/(?<!\\)"/g)).toHaveLength(4);
  });

  it('escapes line filter values too', () => {
    expect(
      compileLogQuery(
        { lineFilters: [{ operator: 'contains', value: 'say "hi"' }] },
        P,
      ).logql,
    ).toBe(`{${PROJECT_LABEL}="proj_123"} |= "say \\"hi\\""`);
  });

  it('supports every line filter operator', () => {
    const ops = {
      contains: '|=',
      notContains: '!=',
      match: '|~',
      notMatch: '!~',
    } as const;

    for (const [operator, symbol] of Object.entries(ops)) {
      expect(
        compileLogQuery(
          {
            lineFilters: [
              { operator: operator as keyof typeof ops, value: 'x' },
            ],
          },
          P,
        ).logql,
      ).toContain(`${symbol} "x"`);
    }
  });

  it('clamps the limit', () => {
    expect(compileLogQuery({ limit: 10_000_000 }, P).limit).toBeLessThanOrEqual(
      5000,
    );
    expect(compileLogQuery({ limit: -5 }, P).limit).toBeGreaterThan(0);
  });
});

// ─── Ingest: the closed label set ───────────────────────────────────────────

const record = (over: Partial<Parameters<typeof buildLokiPush>[0][number]> = {}) => ({
  timestampNs: '1700000000000000000',
  body: 'hello',
  ...over,
});

describe('buildLokiPush — cardinality', () => {
  it('stamps the project label on every stream', () => {
    const push = buildLokiPush([record()], P);
    expect(push.streams[0]?.stream[PROJECT_LABEL]).toBe(P);
  });

  it('admits only allowlisted labels', () => {
    const push = buildLokiPush(
      [
        record({
          labels: {
            service: 'api',
            env: 'prod',
            // Not on the allowlist — must not become a stream label.
            region: 'eu-west-1',
          } as never,
        }),
      ],
      P,
    );

    expect(Object.keys(push.streams[0]!.stream).sort()).toEqual([
      'env',
      PROJECT_LABEL,
      'service',
    ]);
  });

  it('NEVER promotes a correlation id to a label', () => {
    // This is the whole reason OpenPanel builds the push instead of forwarding
    // OTLP: gigapipe's decoder would make each trace id its own stream.
    const push = buildLokiPush(
      [
        record({
          traceId: 'abc123',
          spanId: 'def456',
          sessionId: 'sess-1',
          profileId: 'prof-1',
        }),
      ],
      P,
    );

    const labels = Object.keys(push.streams[0]!.stream);
    expect(labels).not.toContain('trace_id');
    expect(labels).not.toContain('session_id');
    expect(JSON.stringify(push.streams[0]!.stream)).not.toContain('abc123');

    // But they are still queryable, inside the line.
    const envelope = parseLogEnvelope(push.streams[0]!.values[0]![1]);
    expect(envelope?.tid).toBe('abc123');
    expect(envelope?.sess).toBe('sess-1');
  });

  it('rejects a label whose SANITIZED name is denied', () => {
    // gigapipe sanitizes before storing, so the check has to be on the stored
    // name — `trace.id` becomes `trace_id`.
    const push = buildLokiPush(
      [record({ labels: { 'trace.id': 'abc' } as never })],
      P,
    );

    expect(Object.keys(push.streams[0]!.stream)).toEqual([PROJECT_LABEL]);
  });

  it('cannot have the project label overwritten by a supplied label', () => {
    const push = buildLokiPush(
      [record({ labels: { [PROJECT_LABEL]: 'other' } as never })],
      P,
    );

    expect(push.streams[0]!.stream[PROJECT_LABEL]).toBe(P);
  });

  it('truncates a long label value on a character boundary', () => {
    const push = buildLokiPush(
      [record({ labels: { service: '€'.repeat(200) } })],
      P,
    );

    const value = push.streams[0]!.stream.service as string;
    expect(Buffer.byteLength(value, 'utf8')).toBeLessThanOrEqual(100);
    // Still valid UTF-8 — no replacement characters from a mid-codepoint cut.
    expect(value).not.toContain('�');
  });
});

describe('buildLokiPush — streams', () => {
  it('groups records that share a label set into one stream', () => {
    const push = buildLokiPush(
      [
        record({ labels: { service: 'api' } }),
        record({ labels: { service: 'api' }, body: 'second' }),
        record({ labels: { service: 'worker' } }),
      ],
      P,
    );

    expect(push.streams).toHaveLength(2);
    const api = push.streams.find((s) => s.stream.service === 'api');
    expect(api?.values).toHaveLength(2);
  });

  it('sorts entries by timestamp — Loki rejects out-of-order streams', () => {
    const push = buildLokiPush(
      [
        record({ timestampNs: '300' }),
        record({ timestampNs: '100' }),
        record({ timestampNs: '200' }),
      ],
      P,
    );

    expect(push.streams[0]!.values.map(([ts]) => ts)).toEqual([
      '100',
      '200',
      '300',
    ]);
  });

  it('refuses a malformed timestamp rather than writing an undated line', () => {
    expect(() =>
      buildLokiPush([record({ timestampNs: 'not-a-number' })], P),
    ).toThrow(LogIngestError);
  });
});

describe('envelope', () => {
  it('carries a version so a future shape change is detectable', () => {
    const push = buildLokiPush([record()], P);
    expect(parseLogEnvelope(push.streams[0]!.values[0]![1])?.v).toBe(
      LOG_ENVELOPE_VERSION,
    );
  });

  it('keeps non-label attributes searchable inside the line', () => {
    const push = buildLokiPush(
      [record({ attributes: { region: 'eu-west-1', pod: 'api-7f9' } })],
      P,
    );

    expect(parseLogEnvelope(push.streams[0]!.values[0]![1])?.attr).toEqual({
      region: 'eu-west-1',
      pod: 'api-7f9',
    });
  });

  it('returns undefined for a line that is not our envelope', () => {
    // Written before this format, or by something else pointed at the same
    // backend. The explorer shows the raw text rather than erroring.
    expect(parseLogEnvelope('plain text log line')).toBeUndefined();
  });
});
