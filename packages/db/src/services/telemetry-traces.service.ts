import { PROJECT_LABEL, assertValidProjectId } from '@openpanel/gigapipe';
import {
  TELEMETRY_DATABASE,
  getTelemetryClickhouse,
} from '../clickhouse/telemetry-client';

/**
 * Trace search and retrieval, read with direct ClickHouse SQL.
 *
 * WHY NOT gigapipe's TEMPO API
 *
 * gigapipe's Tempo reader applies no tenant predicate anywhere, and reads
 * `X-Scope-OrgID` nowhere in its tree. Routing trace reads through it would
 * hand every project's spans to every project. So traces are ingested through
 * gigapipe (which owns the schema) and read here.
 *
 * THE OWNERSHIP PREDICATE
 *
 * `tempo_traces_attrs_gin` is an inverted (key, val) -> span index whose primary
 * key starts with `key`, so `key = 'op_project_id' AND val = {projectId}` is an
 * index-prefix lookup rather than a scan.
 *
 * Every aggregate below is SPAN-SCOPED, not trace-scoped, and that distinction
 * is the security-relevant one. A trace id can legitimately contain spans from
 * more than one project — a shared gateway, a client that reuses a trace id, or
 * an attacker who simply guesses one. Computing `spanCount` or `rootService`
 * from `tempo_traces` filtered only by `trace_id` would therefore describe a
 * co-tenant's spans. Restricting the outer read by `(trace_id, span_id)` from
 * the caller's own gin rows makes that impossible.
 */

/** Bound the work a single search can do. */
const MAX_TRACES = 200;
const MAX_SPANS_PER_TRACE = 2000;

export interface TraceSearchFilters {
  service?: string;
  /** Minimum duration in milliseconds. */
  minDurationMs?: number;
  /** Only traces containing an errored span. */
  errorsOnly?: boolean;
}

export interface TraceSummary {
  traceId: string;
  rootName: string;
  rootService: string;
  startTimeNs: string;
  durationMs: number;
  spanCount: number;
  hasError: boolean;
}

export interface TraceSpan {
  spanId: string;
  parentId: string | null;
  name: string;
  service: string;
  startTimeNs: string;
  durationMs: number;
  attributes: Record<string, string>;
}

/**
 * Span ids owned by this project.
 *
 * Written once and reused so no query can accidentally omit it. `{projectId:String}`
 * is a bound parameter, not interpolation.
 */
const OWNED_SPANS = `
  SELECT trace_id, span_id
  FROM ${TELEMETRY_DATABASE}.tempo_traces_attrs_gin
  WHERE key = '${PROJECT_LABEL}' AND val = {projectId:String}
`;

async function scopedQuery<T>(
  projectId: string,
  query: string,
  params: Record<string, unknown> = {},
): Promise<T[]> {
  assertValidProjectId(projectId);

  const result = await getTelemetryClickhouse().query({
    query,
    query_params: { projectId, ...params },
    format: 'JSONEachRow',
  });

  return result.json<T>();
}

export async function searchTraces(
  projectId: string,
  range: { start: Date; end: Date },
  filters: TraceSearchFilters = {},
  limit = 50,
): Promise<TraceSummary[]> {
  const conditions = [
    't.timestamp_ns >= {startNs:Int64}',
    't.timestamp_ns <= {endNs:Int64}',
  ];

  if (filters.service) {
    conditions.push('t.service_name = {service:String}');
  }

  const rows = await scopedQuery<{
    trace_id: string;
    root_name: string;
    root_service: string;
    start_ns: string;
    duration_ns: string;
    span_count: string;
    has_error: number;
  }>(
    projectId,
    `WITH owned AS (${OWNED_SPANS})
     SELECT
       hex(t.trace_id) AS trace_id,
       -- argMin over the earliest span is the root: a trace's entry point is
       -- the span that started first among the ones we own. Using
       -- \`parent_id = ''\` instead would return nothing whenever the true root
       -- belongs to another project in a shared trace.
       argMin(t.name, t.timestamp_ns) AS root_name,
       argMin(t.service_name, t.timestamp_ns) AS root_service,
       toString(min(t.timestamp_ns)) AS start_ns,
       toString(max(t.duration_ns)) AS duration_ns,
       toString(count()) AS span_count,
       max(t.name LIKE '%error%' OR t.duration_ns < 0) AS has_error
     FROM ${TELEMETRY_DATABASE}.tempo_traces AS t
     -- Span-scoped, not trace-scoped: without this join on span_id, every
     -- aggregate above would include a co-tenant's spans in a shared trace.
     INNER JOIN owned AS o
       ON t.trace_id = o.trace_id AND t.span_id = o.span_id
     WHERE ${conditions.join(' AND ')}
     GROUP BY t.trace_id
     ${filters.minDurationMs ? 'HAVING max(t.duration_ns) >= {minDurationNs:Int64}' : ''}
     ORDER BY min(t.timestamp_ns) DESC
     LIMIT ${Math.min(Math.max(1, Math.floor(limit)), MAX_TRACES)}`,
    {
      startNs: String(range.start.getTime() * 1_000_000),
      endNs: String(range.end.getTime() * 1_000_000),
      ...(filters.service ? { service: filters.service } : {}),
      ...(filters.minDurationMs
        ? { minDurationNs: String(Math.floor(filters.minDurationMs * 1_000_000)) }
        : {}),
    },
  );

  return rows.map((row) => ({
    traceId: row.trace_id,
    rootName: row.root_name,
    rootService: row.root_service,
    startTimeNs: row.start_ns,
    durationMs: Number(row.duration_ns) / 1_000_000,
    spanCount: Number(row.span_count),
    hasError: Boolean(row.has_error),
  }));
}

/**
 * Every span of one trace that this project owns.
 *
 * Returns an empty array — not an error — for a trace the project does not own.
 * Distinguishing "no such trace" from "not yours" would confirm the existence
 * of another project's trace id to anyone who guessed one.
 */
export async function getTrace(
  projectId: string,
  traceId: string,
): Promise<TraceSpan[]> {
  if (!/^[0-9a-fA-F]{1,32}$/.test(traceId)) {
    return [];
  }

  const rows = await scopedQuery<{
    span_id: string;
    parent_id: string;
    name: string;
    service_name: string;
    timestamp_ns: string;
    duration_ns: string;
    payload: string;
  }>(
    projectId,
    `WITH owned AS (${OWNED_SPANS})
     SELECT
       hex(t.span_id) AS span_id,
       hex(t.parent_id) AS parent_id,
       t.name AS name,
       t.service_name AS service_name,
       toString(t.timestamp_ns) AS timestamp_ns,
       toString(t.duration_ns) AS duration_ns,
       t.payload AS payload
     FROM ${TELEMETRY_DATABASE}.tempo_traces AS t
     INNER JOIN owned AS o
       ON t.trace_id = o.trace_id AND t.span_id = o.span_id
     WHERE t.trace_id = unhex({traceId:String})
     ORDER BY t.timestamp_ns
     LIMIT ${MAX_SPANS_PER_TRACE}`,
    { traceId },
  );

  return rows.map((row) => ({
    spanId: row.span_id,
    // ClickHouse renders an absent parent as an empty hex string; the waterfall
    // needs null to know a span is a root.
    parentId: row.parent_id ? row.parent_id : null,
    name: row.name,
    service: row.service_name,
    startTimeNs: row.timestamp_ns,
    durationMs: Number(row.duration_ns) / 1_000_000,
    attributes: safeAttributes(row.payload),
  }));
}

/**
 * The span payload is JSON written by gigapipe. Parse defensively: a payload we
 * cannot read should cost the span its attributes, never the whole trace view.
 */
function safeAttributes(payload: string): Record<string, string> {
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const out: Record<string, string> = {};

    for (const [key, value] of Object.entries(parsed)) {
      if (key === PROJECT_LABEL) {
        continue;
      }
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        out[key] = String(value);
      }
    }

    return out;
  } catch {
    return {};
  }
}

/** Services that have reported spans, for the search filter. */
export async function getTraceServices(projectId: string): Promise<string[]> {
  const rows = await scopedQuery<{ service_name: string }>(
    projectId,
    `WITH owned AS (${OWNED_SPANS})
     SELECT DISTINCT t.service_name
     FROM ${TELEMETRY_DATABASE}.tempo_traces AS t
     INNER JOIN owned AS o
       ON t.trace_id = o.trace_id AND t.span_id = o.span_id
     ORDER BY t.service_name
     LIMIT 200`,
  );

  return rows.map((r) => r.service_name).filter(Boolean);
}


/**
 * The attribute a server span must carry for a trace to be joinable to an
 * OpenPanel session.
 *
 * Deliberately NOT `op_session_id`. OpenPanel reserves the whole `op_` prefix
 * and strips matching attributes at ingest, so that spelling would be deleted
 * before storage and the join would silently never work. Kept in sync with
 * `OpenPanel.SESSION_ATTRIBUTE` in packages/sdks/sdk.
 */
export const SESSION_SPAN_ATTRIBUTE = 'openpanel.session.id';
export const PROFILE_SPAN_ATTRIBUTE = 'openpanel.profile.id';

/**
 * Traces produced by one OpenPanel session.
 *
 * This is the join no Grafana stack can offer: from a session replay to the
 * backend work that session caused. It is a plain gin lookup because the
 * session id is a span ATTRIBUTE — indexed like any other — rather than a
 * metric label, so it costs an index row per span and no series at all.
 *
 * Scoped the same way as every other trace read: the ownership predicate is
 * intersected with the session predicate, so a guessed session id from another
 * project returns nothing.
 */
export async function getTracesForSession(
  projectId: string,
  sessionId: string,
  limit = 50,
): Promise<TraceSummary[]> {
  if (!sessionId || sessionId.length > 200) {
    return [];
  }

  const rows = await scopedQuery<{
    trace_id: string;
    root_name: string;
    root_service: string;
    start_ns: string;
    duration_ns: string;
    span_count: string;
  }>(
    projectId,
    `WITH owned AS (${OWNED_SPANS}),
          session_spans AS (
            SELECT trace_id, span_id
            FROM ${TELEMETRY_DATABASE}.tempo_traces_attrs_gin
            WHERE key = {sessionAttribute:String} AND val = {sessionId:String}
          )
     SELECT
       hex(t.trace_id) AS trace_id,
       argMin(t.name, t.timestamp_ns) AS root_name,
       argMin(t.service_name, t.timestamp_ns) AS root_service,
       toString(min(t.timestamp_ns)) AS start_ns,
       toString(max(t.duration_ns)) AS duration_ns,
       toString(count()) AS span_count
     FROM ${TELEMETRY_DATABASE}.tempo_traces AS t
     INNER JOIN owned AS o
       ON t.trace_id = o.trace_id AND t.span_id = o.span_id
     -- Intersected, not unioned: a session id guessed from another project
     -- still has to pass the ownership predicate.
     INNER JOIN session_spans AS s
       ON t.trace_id = s.trace_id AND t.span_id = s.span_id
     GROUP BY t.trace_id
     ORDER BY min(t.timestamp_ns) DESC
     LIMIT ${Math.min(Math.max(1, Math.floor(limit)), MAX_TRACES)}`,
    { sessionId, sessionAttribute: SESSION_SPAN_ATTRIBUTE },
  );

  return rows.map((row) => ({
    traceId: row.trace_id,
    rootName: row.root_name,
    rootService: row.root_service,
    startTimeNs: row.start_ns,
    durationMs: Number(row.duration_ns) / 1_000_000,
    spanCount: Number(row.span_count),
    hasError: false,
  }));
}
