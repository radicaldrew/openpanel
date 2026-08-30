import { PROJECT_LABEL, assertValidProjectId } from '../tenancy/project-label';
import { sanitizeLokiLabelName } from '../tenancy/sanitize';

/**
 * Build a Loki push payload from log records.
 *
 * WHY OPENPANEL BUILDS THIS RATHER THAN FORWARDING OTLP
 *
 * gigapipe's OTLP log decoder folds resource, scope AND record attributes into
 * one map and appends `trace_id` and `span_id` as stream labels
 * (`writer/utils/unmarshal/otlplogs.go:22-58`). The stream fingerprint is
 * computed over the whole surviving label set, so ONE TRACE ID IS ONE NEW
 * STREAM — about 10k new streams per second for a busy service, with no
 * configuration that turns it off. Each stream costs a `time_series` row plus a
 * `time_series_gin` row per label, per day, and because the fingerprint is part
 * of the storage key the damage cannot be repaired in place: only deleted and
 * re-ingested.
 *
 * So the label set is ours, and it is CLOSED. Anything a service sends that is
 * not on the allowlist below travels inside the log line as structured JSON,
 * where it is searchable but costs nothing in cardinality.
 *
 * See docs/observability/14-decisions.md D5.
 */

/**
 * The only labels that may become a Loki stream label.
 *
 * Every one is bounded by something operational — how many services you run,
 * how many environments you deploy to — rather than by traffic. That is the
 * test for adding one: if a busy hour can produce more distinct values than a
 * quiet one, it does not belong here.
 */
export const LOG_LABEL_ALLOWLIST = [
  'service',
  'env',
  'level',
  'scope',
  'source',
] as const;

export type LogLabel = (typeof LOG_LABEL_ALLOWLIST)[number];

/**
 * Fields that must NEVER be labels, however they arrive.
 *
 * Each is unbounded by construction — one value per request, per trace, per
 * user. They are carried in the envelope instead, where a query can still find
 * them with a line filter.
 */
export const LOG_DENIED_LABELS = [
  'trace_id',
  'span_id',
  'session_id',
  'profile_id',
  'request_id',
  'user_id',
] as const;

/** Envelope schema version. Bumped when the shape changes incompatibly. */
export const LOG_ENVELOPE_VERSION = 1;

export interface LogRecordInput {
  /** Nanosecond timestamp. */
  timestampNs: string;
  body: string;
  severity?: string;
  labels?: Partial<Record<LogLabel, string>>;
  /** Correlation ids — carried in the envelope, never as labels. */
  traceId?: string;
  spanId?: string;
  sessionId?: string;
  profileId?: string;
  /** Everything else the service sent. */
  attributes?: Record<string, string>;
}

/**
 * The JSON written as the Loki log line.
 *
 * Short keys because this is stored once per log line and the volume is the
 * whole cost model — `b` rather than `body` saves ~3 bytes a line, which at a
 * billion lines is gigabytes. The version field makes a future shape change
 * detectable rather than a silent misparse.
 */
export interface LogEnvelope {
  v: number;
  b: string;
  sev?: string;
  tid?: string;
  sid?: string;
  sess?: string;
  prof?: string;
  attr?: Record<string, string>;
}

export interface LokiStream {
  stream: Record<string, string>;
  values: [string, string][];
}

export interface LokiPushBody {
  streams: LokiStream[];
}

export class LogIngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LogIngestError';
  }
}

/**
 * gigapipe truncates label values at 100 bytes and does not de-duplicate.
 * Truncating here instead means two values sharing a 100-byte prefix become one
 * label deliberately rather than by accident, and it keeps the stream key
 * identical to what we believe we wrote.
 */
const MAX_LABEL_VALUE_BYTES = 100;

function clampLabelValue(value: string): string {
  if (Buffer.byteLength(value, 'utf8') <= MAX_LABEL_VALUE_BYTES) {
    return value;
  }

  // Cut on a character boundary, not a byte one, so the value stays valid UTF-8.
  let out = value;
  while (Buffer.byteLength(out, 'utf8') > MAX_LABEL_VALUE_BYTES) {
    out = out.slice(0, -1);
  }

  return out;
}

const DENIED = new Set<string>(LOG_DENIED_LABELS);
const ALLOWED = new Set<string>(LOG_LABEL_ALLOWLIST);

/**
 * Build the stream label set for one record.
 *
 * Starts from the project label, adds only allowlisted values, and never
 * consults anything the caller could have influenced beyond those five keys.
 */
function buildLabels(
  record: LogRecordInput,
  projectId: string,
): Record<string, string> {
  const labels: Record<string, string> = { [PROJECT_LABEL]: projectId };

  for (const [key, value] of Object.entries(record.labels ?? {})) {
    if (value === undefined || value === '') {
      continue;
    }

    // The allowlist is checked on the SANITIZED name, because that is the name
    // gigapipe will store. A key that sanitizes onto an allowlisted name is
    // still the allowlisted label as far as storage is concerned.
    const sanitized = sanitizeLokiLabelName(key);

    if (!ALLOWED.has(sanitized) || DENIED.has(sanitized)) {
      continue;
    }

    if (sanitized === PROJECT_LABEL) {
      continue;
    }

    labels[sanitized] = clampLabelValue(value);
  }

  return labels;
}

function buildEnvelope(record: LogRecordInput): LogEnvelope {
  const envelope: LogEnvelope = {
    v: LOG_ENVELOPE_VERSION,
    b: record.body,
  };

  if (record.severity) envelope.sev = record.severity;
  if (record.traceId) envelope.tid = record.traceId;
  if (record.spanId) envelope.sid = record.spanId;
  if (record.sessionId) envelope.sess = record.sessionId;
  if (record.profileId) envelope.prof = record.profileId;

  const attributes = record.attributes ?? {};
  if (Object.keys(attributes).length > 0) {
    envelope.attr = attributes;
  }

  return envelope;
}

/** A stable key for grouping records that share a stream. */
function streamKey(labels: Record<string, string>): string {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
}

/**
 * Group records into Loki streams.
 *
 * Grouping matters for more than tidiness: Loki requires the entries of a
 * stream to be sorted by timestamp, and sending one stream per record would
 * multiply the `time_series` writes by the number of lines.
 */
export function buildLokiPush(
  records: LogRecordInput[],
  projectId: string,
): LokiPushBody {
  assertValidProjectId(projectId);

  const streams = new Map<string, LokiStream>();

  for (const record of records) {
    if (!record.timestampNs || !/^[0-9]+$/.test(record.timestampNs)) {
      throw new LogIngestError(
        `Log record has an invalid nanosecond timestamp: ${JSON.stringify(record.timestampNs)}`,
      );
    }

    const labels = buildLabels(record, projectId);
    const key = streamKey(labels);

    let stream = streams.get(key);
    if (!stream) {
      stream = { stream: labels, values: [] };
      streams.set(key, stream);
    }

    stream.values.push([
      record.timestampNs,
      JSON.stringify(buildEnvelope(record)),
    ]);
  }

  for (const stream of streams.values()) {
    // Loki rejects a stream whose entries are not in timestamp order.
    stream.values.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }

  return { streams: [...streams.values()] };
}

/** Parse a stored line back into its envelope, tolerating older writers. */
export function parseLogEnvelope(line: string): LogEnvelope | undefined {
  try {
    const parsed = JSON.parse(line) as LogEnvelope;
    if (typeof parsed?.b !== 'string') {
      return undefined;
    }
    return parsed;
  } catch {
    // A line that is not our envelope — ingested before this format, or written
    // by something else pointed at the same backend. Surface it as the body so
    // the explorer shows the text rather than an error.
    return undefined;
  }
}
