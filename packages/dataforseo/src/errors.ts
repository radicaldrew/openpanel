import type { DataforseoApiCallCost } from './envelope';

/**
 * Coarse classification of a DataForSEO failure. `retryable` on the error is
 * derived from it: timeouts, upstream flakes and rate limits may be replayed
 * (by an idempotent caller), everything else is either our request, the
 * account, or the provider rejecting the task.
 */
export type DataForSeoErrorKind =
  /** Non-2xx HTTP response not covered by a more specific kind. */
  | 'http'
  /** Request deadline hit (AbortSignal timeout). Never retried in-package. */
  | 'timeout'
  /** HTTP 401 or DataForSEO 40100: wrong login / password. */
  | 'auth'
  /** Balance / payment problem on the connected DataForSEO account. */
  | 'billing'
  /** HTTP 429 or DataForSEO "too many requests". */
  | 'rate_limited'
  /** DataForSEO's own backend failed (HTTP 5xx or a 5xxxx/40101 task). */
  | 'upstream'
  /** The task itself failed (invalid field, unsupported market, ...). */
  | 'task'
  /** HTTP 200 but the payload did not match the expected shape. */
  | 'invalid_response'
  /** Rejected before any request was made (bad input). */
  | 'validation';

const RETRYABLE_KINDS = new Set<DataForSeoErrorKind>([
  'timeout',
  'upstream',
  'rate_limited',
]);

export interface DataForSeoErrorOptions {
  kind: DataForSeoErrorKind;
  /** Request path, e.g. "/v3/backlinks/summary/live". */
  path: string;
  /** HTTP status when the failure came from the HTTP layer. */
  status?: number;
  /** DataForSEO status_code (top-level or task-level). */
  dfsStatusCode?: number;
  /** Truncated response body for HTTP failures. */
  responseBody?: string;
  cause?: unknown;
}

export class DataForSeoError extends Error {
  readonly kind: DataForSeoErrorKind;
  readonly path: string;
  readonly status: number | undefined;
  readonly dfsStatusCode: number | undefined;
  readonly responseBody: string | undefined;
  readonly retryable: boolean;

  constructor(message: string, options: DataForSeoErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DataForSeoError';
    this.kind = options.kind;
    this.path = options.path;
    this.status = options.status;
    this.dfsStatusCode = options.dfsStatusCode;
    this.responseBody = options.responseBody;
    this.retryable = RETRYABLE_KINDS.has(options.kind);
  }
}

/**
 * Thrown when a DataForSEO task fails *after* it was billed (cost + path are
 * present on the task). The transport has already reported the cost through
 * `onCost`; this carries it to the caller too so a failed-but-charged call can
 * be recorded against whatever the caller was doing. Access / balance failures
 * are classified as `billing` before this is thrown, even when DataForSEO
 * attaches billing metadata to the failed task.
 */
export class DataForSeoChargedTaskError extends DataForSeoError {
  readonly billing: DataforseoApiCallCost;
  /**
   * True when the task failed because OUR request was malformed (DataForSEO
   * "Invalid Field: ..."). Callers that map errors to user-facing messages
   * should treat an unbilled invalid-field failure as a validation error.
   */
  readonly isInvalidField: boolean;

  constructor(
    message: string,
    billing: DataforseoApiCallCost,
    options: Omit<DataForSeoErrorOptions, 'kind'> & {
      kind?: Extract<DataForSeoErrorKind, 'task' | 'upstream' | 'invalid_response'>;
      isInvalidField?: boolean;
    },
  ) {
    super(message, { ...options, kind: options.kind ?? 'task' });
    this.name = 'DataForSeoChargedTaskError';
    this.billing = billing;
    this.isInvalidField = options.isInvalidField ?? false;
  }
}

export function isDataForSeoError(value: unknown): value is DataForSeoError {
  return value instanceof DataForSeoError;
}
