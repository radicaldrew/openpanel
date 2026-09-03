/**
 * The only way OpenPanel talks to gigapipe.
 *
 * Two properties this module exists to guarantee:
 *
 *  1. Requests go to an exact-path allow-list, never a caller-supplied path.
 *     gigapipe serves far more than we expose — Elastic `_bulk` write routes,
 *     Loki push, an always-on gRPC OTLP receiver, and (with LOG_DRILLDOWN on)
 *     several routes that carry no tenant predicate at all. A path built from
 *     user input is a way to reach all of it.
 *
 *  2. No client header is ever copied through. gigapipe reads `X-CH-DSN` and
 *     `x-ttl-days` from request headers; both would be attacker-controlled if
 *     we forwarded headers, and the first is a fail-open node selector.
 *     Outbound headers are constructed here, from nothing.
 */

export const GIGAPIPE_ROUTES = {
  /** OTLP/HTTP metrics ingest — protobuf. */
  otlpMetrics: '/v1/metrics',
  /** Instant PromQL query. */
  promQuery: '/api/v1/query',
  /** Range PromQL query. */
  promQueryRange: '/api/v1/query_range',
  /** Label-name enumeration. */
  promLabels: '/api/v1/labels',
  /** Prometheus remote-write 1.0 — snappy-compressed protobuf. */
  promRemoteWrite: '/api/v1/prom/remote/write',
  /** OTLP/HTTP traces ingest — protobuf. */
  otlpTraces: '/v1/traces',
  /** Loki JSON push — the ONLY log ingest path (see decisions D5). */
  lokiPush: '/loki/api/v1/push',
  /** LogQL range query. */
  lokiQueryRange: '/loki/api/v1/query_range',
  /**
   * Log pattern grouping. Takes a `query` parameter, so it is scoped by the
   * same compiled LogQL as any other read (reader/controller/volume.go:137).
   *
   * Its siblings behind LOG_DRILLDOWN are deliberately NOT here:
   *   /loki/api/v1/index/volume    — `targetLabels` is string-interpolated into
   *                                  a LogQL expression and re-parsed
   *   /loki/api/v1/detected_labels
   *   /loki/api/v1/detected_fields
   * See docs/observability/14-decisions.md D9.
   */
  lokiPatterns: '/loki/api/v1/patterns',
} as const;

export type GigapipeRoute =
  (typeof GIGAPIPE_ROUTES)[keyof typeof GIGAPIPE_ROUTES];

export interface GigapipeConfig {
  url: string;
  username: string;
  password: string;
  /**
   * gigapipe's PromQL engine has its own hardcoded 30s ceiling, so a query that
   * is still running past this has already failed upstream. Sitting just above
   * it means a timeout here is a genuine transport problem, not a slow query.
   */
  timeoutMs?: number;
}

export class GigapipeError extends Error {
  readonly status: number | undefined;
  readonly body: string | undefined;

  constructor(message: string, status?: number, body?: string) {
    super(message);
    this.name = 'GigapipeError';
    this.status = status;
    this.body = body;
  }
}

/**
 * gigapipe response bodies are unbounded, and `res.json()` buffers and parses
 * the whole thing before any caller can look at it. A grouped metric query on a
 * high-cardinality label (`instance`, `pod`, `path`, `le`) fans out exactly that
 * way, and the agent picks its own group-by labels from the keys
 * `describe_metric` hands it and can issue a query per turn — so "nobody would
 * group by that" is not a bound. gigapipe's own sample ceiling only turns the
 * very largest of those into a 413; everything under it arrives in full and is
 * parsed into this process.
 *
 * Reading in chunks and giving up past the ceiling makes an oversized response
 * cost bounded memory instead of the whole matrix. Reported as 413 because that
 * is the status the read path already treats as "narrow the query" rather than
 * as something to retry.
 *
 * Deliberately NOT a PromQL-level cap. `topk` in a range query is re-evaluated
 * at every step and returns the union of every step's top-K, so it bounds
 * nothing reliably — see docs/observability/03-metrics-engine.md D8, which
 * prescribes a two-phase ranking query as the real fix for fan-out. This is a
 * memory backstop, not that fix.
 */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/** What an over-ceiling response reports, so callers can match on it. */
export const GIGAPIPE_ERROR_STATUS_TOO_LARGE = 413;

async function readJsonCapped(res: Response, what: string): Promise<unknown> {
  // No stream to meter (a buffered or stubbed response) — nothing to do.
  if (!res.body) {
    return await res.json();
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      size += value.byteLength;

      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new GigapipeError(
          `gigapipe returned more than ${Math.floor(MAX_RESPONSE_BYTES / 1024 / 1024)}MB for a ${what} — narrow the time range, add a filter, or group by fewer labels`,
          GIGAPIPE_ERROR_STATUS_TOO_LARGE,
        );
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return JSON.parse(new TextDecoder().decode(merged));
}

export class GigapipeNotConfiguredError extends Error {
  constructor() {
    super(
      'Telemetry is not configured: set GIGAPIPE_URL, GIGAPIPE_USER and GIGAPIPE_PASSWORD',
    );
    this.name = 'GigapipeNotConfiguredError';
  }
}

const DEFAULT_TIMEOUT_MS = 35_000;

/**
 * Reads config from the environment.
 *
 * Returns undefined — rather than a half-configured client — when any part is
 * missing, so telemetry routes can be absent instead of failing per-request.
 * gigapipe installs its auth middleware only when both credentials are
 * non-empty, so an empty username or password here means the far side is very
 * likely unauthenticated too; treating that as "not configured" keeps us from
 * sending data to an open endpoint.
 */
export function getGigapipeConfig(): GigapipeConfig | undefined {
  const url = process.env.GIGAPIPE_URL;
  const username = process.env.GIGAPIPE_USER;
  const password = process.env.GIGAPIPE_PASSWORD;

  if (!url || !username || !password) {
    return undefined;
  }

  return { url: url.replace(/\/$/, ''), username, password };
}

export function isGigapipeEnabled(): boolean {
  return getGigapipeConfig() !== undefined;
}

function authHeader(config: GigapipeConfig): string {
  const raw = `${config.username}:${config.password}`;
  return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
}

/**
 * POST a body to one of the allow-listed ingest routes.
 *
 * `route` is typed to the allow-list rather than to `string`, so a path can
 * only reach here by being added to GIGAPIPE_ROUTES above — where it is
 * reviewed alongside whether that route carries a tenant predicate.
 */
export async function postToGigapipe(
  route: GigapipeRoute,
  body: Uint8Array,
  contentType: string,
  config: GigapipeConfig | undefined = getGigapipeConfig(),
): Promise<void> {
  if (!config) {
    throw new GigapipeNotConfiguredError();
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  try {
    const res = await fetch(`${config.url}${route}`, {
      method: 'POST',
      headers: {
        'content-type': contentType,
        authorization: authHeader(config),
      },
      // TypeScript's body type wants `ArrayBufferView<ArrayBuffer>`, while
      // `Uint8Array`/`Buffer` are typed `<ArrayBufferLike>` since TS 5.7. The
      // runtime accepts either; converting would copy the whole payload on the
      // ingest hot path, so this is a typing-only cast.
      //
      // Indexed off `RequestInit` rather than naming `BodyInit`: that global
      // only exists with the DOM lib, and `admin/tsconfig.json` builds on
      // `lib: ["ES2022"] + types: ["node"]`, where it is an unresolved name.
      body: body as unknown as RequestInit['body'],
      signal: controller.signal,
    });

    if (!res.ok) {
      // Bounded read: a failing gigapipe can return a large body, and this
      // string ends up in logs and error paths.
      const text = (await res.text().catch(() => '')).slice(0, 2000);
      throw new GigapipeError(
        `gigapipe responded ${res.status} for ${route}`,
        res.status,
        text,
      );
    }
  } catch (error) {
    if (error instanceof GigapipeError) {
      throw error;
    }

    if (error instanceof Error && error.name === 'AbortError') {
      throw new GigapipeError(`gigapipe timed out for ${route}`);
    }

    throw new GigapipeError(
      `gigapipe request failed for ${route}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

export interface RangeQueryParams {
  promql: string;
  /** Inclusive range start. */
  start: Date;
  /** Inclusive range end. */
  end: Date;
  /** Prometheus step, e.g. `60s`. */
  step: string;
}

/**
 * Run a PromQL range query.
 *
 * Sent as a POST form body rather than a GET query string. A compiled query
 * with several matchers and a long window comfortably exceeds what some proxies
 * will accept in a URL, and a truncated query is far worse than a rejected one:
 * dropping a trailing matcher can silently widen the selection.
 */
export async function queryRange(
  params: RangeQueryParams,
  config: GigapipeConfig | undefined = getGigapipeConfig(),
): Promise<unknown> {
  if (!config) {
    throw new GigapipeNotConfiguredError();
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  const form = new URLSearchParams({
    query: params.promql,
    start: String(Math.floor(params.start.getTime() / 1000)),
    end: String(Math.floor(params.end.getTime() / 1000)),
    step: params.step,
  });

  try {
    const res = await fetch(`${config.url}${GIGAPIPE_ROUTES.promQueryRange}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: authHeader(config),
      },
      body: form.toString(),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 2000);

      // gigapipe's PromQL engine has a hardcoded 30s timeout and reports
      // several over-limit conditions as a 500 with a recognisable body. Left
      // as a bare 500 the UI would retry them, which makes an expensive query
      // more expensive rather than less.
      const overLimit =
        /points|too many samples|context deadline exceeded/i.test(text);

      throw new GigapipeError(
        overLimit
          ? 'Query is too large — narrow the time range or increase the interval'
          : `gigapipe responded ${res.status} for a range query`,
        overLimit ? 413 : res.status,
        text,
      );
    }

    return await readJsonCapped(res, 'range query');
  } catch (error) {
    if (error instanceof GigapipeError) {
      throw error;
    }

    if (error instanceof Error && error.name === 'AbortError') {
      throw new GigapipeError('gigapipe timed out running a range query');
    }

    throw new GigapipeError(
      `gigapipe range query failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

export interface LogRangeQueryParams {
  logql: string;
  start: Date;
  end: Date;
  limit: number;
  /** Loki returns newest-first by default; the explorer wants that too. */
  direction?: 'forward' | 'backward';
}

/** Run a LogQL range query. */
export async function queryLogRange(
  params: LogRangeQueryParams,
  config: GigapipeConfig | undefined = getGigapipeConfig(),
): Promise<unknown> {
  if (!config) {
    throw new GigapipeNotConfiguredError();
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  const query = new URLSearchParams({
    query: params.logql,
    // Loki takes nanoseconds here. Milliseconds would silently select a window
    // a million times too small and return nothing.
    start: `${params.start.getTime()}000000`,
    end: `${params.end.getTime()}000000`,
    limit: String(params.limit),
    direction: params.direction ?? 'backward',
  });

  try {
    const res = await fetch(
      `${config.url}${GIGAPIPE_ROUTES.lokiQueryRange}?${query.toString()}`,
      {
        method: 'GET',
        headers: { authorization: authHeader(config) },
        signal: controller.signal,
      },
    );

    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 2000);
      throw new GigapipeError(
        `gigapipe responded ${res.status} for a log query`,
        res.status,
        text,
      );
    }

    return await readJsonCapped(res, 'log query');
  } catch (error) {
    if (error instanceof GigapipeError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new GigapipeError('gigapipe timed out running a log query');
    }
    throw new GigapipeError(
      `gigapipe log query failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

/** Push log streams as Loki JSON. */
export async function pushLogs(
  body: unknown,
  config: GigapipeConfig | undefined = getGigapipeConfig(),
): Promise<void> {
  await postToGigapipe(
    GIGAPIPE_ROUTES.lokiPush,
    Buffer.from(JSON.stringify(body), 'utf8'),
    'application/json',
    config,
  );
}

export interface LogPatternsParams {
  logql: string;
  start: Date;
  end: Date;
  stepSeconds?: number;
}

/**
 * Log pattern grouping.
 *
 * Scoped by the compiled LogQL in `logql`, exactly like a normal log query —
 * this endpoint takes a `query` parameter, which is why it is the one
 * LOG_DRILLDOWN route on the allowlist.
 */
export async function queryLogPatterns(
  params: LogPatternsParams,
  config: GigapipeConfig | undefined = getGigapipeConfig(),
): Promise<unknown> {
  if (!config) {
    throw new GigapipeNotConfiguredError();
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  const query = new URLSearchParams({
    query: params.logql,
    start: `${params.start.getTime()}000000`,
    end: `${params.end.getTime()}000000`,
    step: String(params.stepSeconds ?? 60),
  });

  try {
    const res = await fetch(
      `${config.url}${GIGAPIPE_ROUTES.lokiPatterns}?${query.toString()}`,
      {
        method: 'GET',
        headers: { authorization: authHeader(config) },
        signal: controller.signal,
      },
    );

    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 2000);
      throw new GigapipeError(
        `gigapipe responded ${res.status} for a patterns query`,
        res.status,
        text,
      );
    }

    return await readJsonCapped(res, 'patterns query');
  } catch (error) {
    if (error instanceof GigapipeError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new GigapipeError('gigapipe timed out running a patterns query');
    }
    throw new GigapipeError(
      `gigapipe patterns query failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}
