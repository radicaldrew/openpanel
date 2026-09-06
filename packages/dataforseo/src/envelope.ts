import { z } from 'zod';
import {
  DataForSeoChargedTaskError,
  DataForSeoError,
  type DataForSeoErrorKind,
} from './errors';

// ---------------------------------------------------------------------------
// Billing envelope — every section fetcher returns DataforseoApiResponse<T>
// so the per-call USD cost travels with the data. The transport reports the
// same number through onCost; this copy is for callers that need it inline
// (e.g. summing a run's cost onto its own row).
// ---------------------------------------------------------------------------

export interface DataforseoApiCallCost {
  path: string[];
  costUsd: number;
}

export interface DataforseoApiResponse<T> {
  data: T;
  billing: DataforseoApiCallCost;
}

// cost / path / result_count arrive from the wire untyped and optional, so
// this is the one guard that guarantees we can bill a call.
const billingMetadataSchema = z.object({
  path: z.array(z.string()),
  cost: z.number(),
  result_count: z.number().nullable().optional(),
});

export interface DataforseoTaskLike {
  id?: string;
  status_code?: number;
  status_message?: string;
  path?: string[];
  cost?: number;
  result_count?: number;
  result?: unknown[];
  [key: string]: unknown;
}

export interface DataforseoResponseLike<T extends DataforseoTaskLike> {
  status_code?: number;
  status_message?: string;
  cost?: number;
  tasks?: T[];
  [key: string]: unknown;
}

/** `task.result[0]` entry carrying an `items` list — the common live-endpoint
 *  shape. The index signature covers per-endpoint extras (`check_url`, …). */
export interface DataforseoItemsResult<TItem> {
  items?: TItem[] | null;
  total_count?: number | null;
  [key: string]: unknown;
}

/** Task whose `result` entries follow the `items` shape. Item types are the
 *  caller's claim about the payload; fields we act on are Zod-validated by the
 *  section fetchers. */
export interface DataforseoItemsTask<TItem> extends DataforseoTaskLike {
  result?: DataforseoItemsResult<TItem>[];
}

function tryBuildTaskBilling(task: unknown): DataforseoApiCallCost | null {
  const parsed = billingMetadataSchema.safeParse(task);
  if (!parsed.success) {
    return null;
  }
  return {
    path: parsed.data.path,
    costUsd: parsed.data.cost,
  };
}

export function buildTaskBilling(task: DataforseoTaskLike): DataforseoApiCallCost {
  const billing = tryBuildTaskBilling(task);
  if (!billing) {
    throw new DataForSeoError(
      'DataForSEO task is missing billing metadata (path/cost)',
      { kind: 'invalid_response', path: taskPath(task) },
    );
  }
  return billing;
}

/**
 * Free endpoints (appendix, locations, task_get) sometimes omit `cost`; this
 * builds a zero-cost envelope from the task path or the request path.
 */
export function buildFreeTaskBilling(
  task: DataforseoTaskLike,
  requestPath: string,
): DataforseoApiCallCost {
  return {
    path: task.path ?? requestPath.split('/').filter(Boolean),
    costUsd: typeof task.cost === 'number' ? task.cost : 0,
  };
}

function taskPath(task: DataforseoTaskLike): string {
  return task.path ? `/${task.path.join('/')}` : '';
}

const INVALID_FIELD_MESSAGE_RE = /Invalid Field:\s*'([^']+)'/i;

/**
 * DataForSEO echoes the posted request params back on `task.data`. Its
 * validation rejections are opaque ("Invalid Field: 'target'.") and name the
 * field but not the value we sent — and these tasks are charged, so we want to
 * know exactly what tripped them. Append the offending value so the charged
 * failure is diagnosable from the message alone.
 */
function describeInvalidField(message: string, task: DataforseoTaskLike): string {
  const match = message.match(INVALID_FIELD_MESSAGE_RE);
  if (!match) {
    return message;
  }
  const field = match[1];
  if (field === undefined || !isRecord(task.data)) {
    return message;
  }
  const value = task.data[field];
  if (value === undefined) {
    return message;
  }
  return `${message} (sent ${field}=${JSON.stringify(value)})`;
}

/**
 * DataForSEO's "No Search Results" — a successful empty result, not a failure.
 * Match on the status message, not the code alone: 40_501 also covers
 * validation rejections like "Invalid Field: 'target'.", which are real charged
 * failures we must surface rather than mask as empty results.
 */
export function isNoResultsTask(task: DataforseoTaskLike): boolean {
  return task.status_message?.toLowerCase().includes('no search results') ?? false;
}

/**
 * Status codes where DataForSEO's own backend failed, returned on an HTTP 200
 * with a failed task. These are provider flakes, not our bug, so they classify
 * as `upstream` (retryable).
 *
 * An explicit list, not a `>= 50000` range: 40101 "Internal SE Server Error."
 * is the one that actually fires and it sits in the 40000 family, while 50100
 * "Not Implemented." means we posted a non-existing task or parameter — our
 * bug, and it must stay a plain task failure. Likewise 50001 "Error While
 * Checking the Balance." stays visible.
 * @see https://docs.dataforseo.com/v3/appendix/errors/
 */
const UPSTREAM_FAILURE_STATUS_CODES = new Set([
  40_101, // Internal SE Server Error.
  40_103, // Task execution failed, please try to resubmit.
  50_000, // Internal Error.
  50_301, // 3rd Party API Service Unavailable.
  50_302, // Internal 3rd Party API Service Unavailable.
  50_303, // Update in progress. Please try after a few minutes.
  50_304, // This function temporarily unavailable.
  50_401, // Internal Error - Timeout.
  50_402, // Target page took too long to respond.
]);

function isUpstreamServerErrorTask(task: DataforseoTaskLike): boolean {
  return (
    task.status_code !== undefined &&
    UPSTREAM_FAILURE_STATUS_CODES.has(task.status_code)
  );
}

/** Task lifecycle codes meaning "not done yet": Task Created / Task Handed /
 *  Task In Queue. A task_get returning one of these is pending, not failed. */
const TASK_IN_PROGRESS_STATUS_CODES = new Set([20_100, 40_601, 40_602]);

export function isTaskInProgress(task: DataforseoTaskLike): boolean {
  return (
    task.status_code !== undefined &&
    TASK_IN_PROGRESS_STATUS_CODES.has(task.status_code)
  );
}

// ---------------------------------------------------------------------------
// Account-level failure classification (formerly open-seo's billing
// classifier). Balance and payment problems are the only account-level task
// failures left: Backlinks and AI Optimization are included in every account.
// ---------------------------------------------------------------------------

const BILLING_SIGNALS = [
  'insufficient funds',
  'balance is too low',
  'payment required',
  'billing',
  'balance',
  'problem billing',
  'recharged',
];
const BILLING_STATUS_CODES = new Set([40_200, 40_210, 402]);
const AUTH_STATUS_CODES = new Set([40_100, 401]);
const RATE_LIMIT_STATUS_CODES = new Set([40_202, 429]);

function classifyAccountFailure(
  statusCode: number | undefined,
  message: string,
): Extract<DataForSeoErrorKind, 'auth' | 'billing' | 'rate_limited'> | null {
  if (statusCode !== undefined && AUTH_STATUS_CODES.has(statusCode)) {
    return 'auth';
  }
  if (statusCode !== undefined && RATE_LIMIT_STATUS_CODES.has(statusCode)) {
    return 'rate_limited';
  }
  const text = message.toLowerCase();
  if (
    (statusCode !== undefined && BILLING_STATUS_CODES.has(statusCode)) ||
    BILLING_SIGNALS.some((signal) => text.includes(signal))
  ) {
    return 'billing';
  }
  return null;
}

interface AssertOkOptions {
  /** Request path for error reporting when the task carries none. */
  path?: string;
  /** Treat DataForSEO's "no search results" as an empty success. */
  treatNoResultsAsEmpty?: boolean;
  /** Task status that counts as success. Live endpoints return 20000; task_post
   *  entries return 20100 "Task Created". */
  okTaskStatusCode?: number;
}

/**
 * Validates that the top-level response and its first task both succeeded, and
 * returns that task. The single status / billing ladder shared by every
 * endpoint:
 *  - access / balance failure -> DataForSeoError(auth | billing | rate_limited)
 *  - DataForSEO's own backend erring -> upstream (retryable)
 *  - charged-but-failed task (cost present) -> DataForSeoChargedTaskError
 *  - anything else -> DataForSeoError(task)
 */
export function assertOk<T extends DataforseoTaskLike>(
  response: DataforseoResponseLike<T> | null,
  options: AssertOkOptions = {},
): T {
  const { treatNoResultsAsEmpty, okTaskStatusCode } = options;
  const requestPath = options.path ?? '';

  if (!response) {
    throw new DataForSeoError('DataForSEO returned an empty response', {
      kind: 'invalid_response',
      path: requestPath,
    });
  }

  if (response.status_code !== 20_000) {
    const message = response.status_message || 'DataForSEO request failed';
    throw new DataForSeoError(message, {
      kind: classifyAccountFailure(response.status_code, message) ?? 'task',
      path: requestPath,
      dfsStatusCode: response.status_code,
    });
  }

  const task = response.tasks?.[0];
  if (!task) {
    throw new DataForSeoError('DataForSEO response missing task', {
      kind: 'invalid_response',
      path: requestPath,
    });
  }

  if (task.status_code !== (okTaskStatusCode ?? 20_000)) {
    if (treatNoResultsAsEmpty && isNoResultsTask(task)) {
      return task;
    }

    const message = task.status_message || 'DataForSEO task failed';
    const path = taskPath(task) || requestPath;
    const accountKind = classifyAccountFailure(task.status_code, message);
    if (accountKind) {
      throw new DataForSeoError(message, {
        kind: accountKind,
        path,
        dfsStatusCode: task.status_code,
      });
    }

    const detailedMessage = describeInvalidField(message, task);
    const kind = isUpstreamServerErrorTask(task) ? 'upstream' : 'task';

    const billing = tryBuildTaskBilling(task);
    if (billing) {
      throw new DataForSeoChargedTaskError(detailedMessage, billing, {
        kind,
        path,
        dfsStatusCode: task.status_code,
        isInvalidField: INVALID_FIELD_MESSAGE_RE.test(message),
      });
    }

    throw new DataForSeoError(detailedMessage, {
      kind,
      path,
      dfsStatusCode: task.status_code,
    });
  }

  return task;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Reads `task.result[0].total_count` for paginated list endpoints. */
export function parseTaskTotalCount(task: DataforseoTaskLike): number | null {
  const first = task.result?.[0];
  if (!isRecord(first)) {
    return null;
  }
  return typeof first.total_count === 'number' ? first.total_count : null;
}

/** Reads `task.result[0].items`, validating against a Zod schema. */
export function parseTaskItems<T extends z.ZodType>(
  endpoint: string,
  task: DataforseoTaskLike,
  itemSchema: T,
): z.infer<T>[] {
  const first = task.result?.[0];
  const items = isRecord(first) ? first.items : [];
  const parsed = z.array(itemSchema).safeParse(items ?? []);
  if (!parsed.success) {
    throw new DataForSeoError(
      `DataForSEO ${endpoint} returned an invalid response shape: ${summarizeIssues(parsed.error)}`,
      { kind: 'invalid_response', path: taskPath(task) },
    );
  }
  return parsed.data;
}

/** Validates a single value (a `result[0]` object, a `total` block, ...). */
export function parseWithSchema<T extends z.ZodType>(
  endpoint: string,
  task: DataforseoTaskLike,
  value: unknown,
  schema: T,
): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new DataForSeoError(
      `DataForSEO ${endpoint} returned an invalid response shape: ${summarizeIssues(parsed.error)}`,
      { kind: 'invalid_response', path: taskPath(task) },
    );
  }
  return parsed.data;
}

export function summarizeIssues(error: z.ZodError, maxIssues = 3): string {
  return error.issues
    .slice(0, maxIssues)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}
