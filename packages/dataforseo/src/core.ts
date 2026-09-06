import type { DataforseoResponseLike, DataforseoTaskLike } from './envelope';
import { DataForSeoError, type DataForSeoErrorKind } from './errors';

export const DATAFORSEO_API_BASE = 'https://api.dataforseo.com';
const MAX_ERROR_PAYLOAD_LENGTH = 1600;
// Safety ceiling on any live call (Lighthouse is the slowest, ~tens of seconds).
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
// Retry idempotent reads on transient 5xx. Total attempts = retries + 1; the
// shared request-timeout signal still caps overall wall time.
const DEFAULT_MAX_SERVER_ERROR_RETRIES = 2;
const RETRY_BACKOFF_MS = 250;

/**
 * Called once per parsed DataForSEO envelope with the request path
 * ("/v3/backlinks/summary/live") and the envelope's `cost` in USD. Free
 * endpoints report 0. Returning a promise is fine; the transport awaits it and
 * lets a rejection propagate to the caller, so keep the hook's own failure
 * handling inside the hook.
 */
export type DataforseoCostHook = (
  path: string,
  costUsd: number,
) => void | Promise<void>;

export interface DataforseoTransportOptions {
  /** `base64(login:password)` — sent as `Authorization: Basic <apiKey>`. */
  apiKey: string;
  fetchImpl?: typeof fetch;
  onCost?: DataforseoCostHook;
  /** Per-request deadline; defaults to 60s. */
  requestTimeoutMs?: number;
}

export interface DataforseoRequestOptions {
  /**
   * Set 0 for billed, non-idempotent calls (task_post, Lighthouse): a 5xx does
   * not prove the provider skipped the charge, so those must never be
   * replayed. Defaults to retrying idempotent reads on transient 5xx.
   */
  maxServerErrorRetries?: number;
  /** Overrides the transport-wide request deadline for one call. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface DataforseoTransport {
  /** POST `tasks` (the standard array-of-task-payloads body). */
  post<TTask extends DataforseoTaskLike = DataforseoTaskLike>(
    path: string,
    tasks: unknown[],
    options?: DataforseoRequestOptions,
  ): Promise<DataforseoResponseLike<TTask> | null>;
  /** GET an endpoint (task_get collection, appendix, locations). */
  get<TTask extends DataforseoTaskLike = DataforseoTaskLike>(
    path: string,
    options?: DataforseoRequestOptions,
  ): Promise<DataforseoResponseLike<TTask> | null>;
}

function truncatePayload(value: unknown): string {
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  return text.length > MAX_ERROR_PAYLOAD_LENGTH
    ? `${text.slice(0, MAX_ERROR_PAYLOAD_LENGTH)}... [truncated]`
    : text;
}

function classifyHttpStatus(status: number): DataForSeoErrorKind {
  if (status >= 500) {
    return 'upstream';
  }
  if (status === 429) {
    return 'rate_limited';
  }
  if (status === 401) {
    return 'auth';
  }
  if (status === 402) {
    return 'billing';
  }
  return 'http';
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The envelope's own `cost` is the sum over its tasks; older/free endpoints
 * omit it, so fall back to summing task costs. Returns null when neither is
 * present (nothing to report).
 */
function readEnvelopeCost(envelope: unknown): number | null {
  if (!isRecord(envelope)) {
    return null;
  }
  if (typeof envelope.cost === 'number' && Number.isFinite(envelope.cost)) {
    return envelope.cost;
  }
  if (!Array.isArray(envelope.tasks)) {
    return null;
  }
  let total = 0;
  let found = false;
  for (const task of envelope.tasks) {
    if (isRecord(task) && typeof task.cost === 'number') {
      total += task.cost;
      found = true;
    }
  }
  return found ? total : null;
}

export function createDataforseoTransport(
  options: DataforseoTransportOptions,
): DataforseoTransport {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('createDataforseoTransport: no fetch implementation available');
  }
  const authorization = `Basic ${options.apiKey}`;
  const defaultTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  async function authenticatedFetch(
    path: string,
    init: RequestInit,
    requestOptions: DataforseoRequestOptions,
  ): Promise<Response> {
    const url = `${DATAFORSEO_API_BASE}${path}`;
    const headers = new Headers(init.headers);
    headers.set('Authorization', authorization);
    // Resolve the signal once so retries share the overall request timeout
    // rather than restarting a fresh budget on each attempt.
    const signal =
      requestOptions.signal ??
      AbortSignal.timeout(requestOptions.timeoutMs ?? defaultTimeoutMs);
    const maxRetries =
      requestOptions.maxServerErrorRetries ?? DEFAULT_MAX_SERVER_ERROR_RETRIES;

    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetchImpl(url, { ...init, headers, signal });
      } catch (error) {
        // Deliberately not retried: a call that ran past the deadline may
        // already be billed by DataForSEO, so replaying it is spend we eat
        // twice.
        if (isAbortError(error)) {
          throw new DataForSeoError(`DataForSEO request timed out on ${path}`, {
            kind: 'timeout',
            path,
            cause: error,
          });
        }
        throw error;
      }
      if (response.ok) {
        return response;
      }

      // Transient upstream 5xx on an idempotent read -> back off and retry.
      if (response.status >= 500 && attempt < maxRetries) {
        await sleep(RETRY_BACKOFF_MS * (attempt + 1));
        continue;
      }

      const rawText = await response.text();
      throw new DataForSeoError(
        `DataForSEO HTTP ${response.status} on ${path}`,
        {
          kind: classifyHttpStatus(response.status),
          path,
          status: response.status,
          dfsStatusCode: readDfsStatusCode(rawText),
          responseBody: truncatePayload(rawText),
        },
      );
    }
  }

  async function request<TTask extends DataforseoTaskLike>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    requestOptions: DataforseoRequestOptions,
  ): Promise<DataforseoResponseLike<TTask> | null> {
    const response = await authenticatedFetch(
      path,
      {
        method,
        headers: {
          Accept: 'application/json',
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        },
        body: method === 'POST' ? JSON.stringify(body) : undefined,
      },
      requestOptions,
    );
    const text = await response.text();
    if (text === '') {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new DataForSeoError(`DataForSEO returned non-JSON on ${path}`, {
        kind: 'invalid_response',
        path,
        status: response.status,
        responseBody: truncatePayload(text),
        cause: error,
      });
    }

    const cost = readEnvelopeCost(parsed);
    if (cost !== null && options.onCost) {
      await options.onCost(path, cost);
    }

    // The task type is the caller's claim about the payload; billing metadata
    // and item fields are validated downstream (envelope.ts + section Zod
    // schemas).
    return parsed as DataforseoResponseLike<TTask>;
  }

  return {
    post: (path, tasks, requestOptions = {}) =>
      request('POST', path, tasks, requestOptions),
    get: (path, requestOptions = {}) =>
      request('GET', path, undefined, requestOptions),
  };
}

/** DataForSEO echoes its own status_code in HTTP error bodies (e.g. 40100 on a 401). */
function readDfsStatusCode(rawText: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(rawText);
    if (isRecord(parsed) && typeof parsed.status_code === 'number') {
      return parsed.status_code;
    }
  } catch {
    // Non-JSON body (HTML error page, empty) — nothing to read.
  }
  return undefined;
}
