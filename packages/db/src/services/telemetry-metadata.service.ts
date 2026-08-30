import { PROJECT_LABEL, assertValidProjectId } from '@openpanel/gigapipe';
import {
  TELEMETRY_DATABASE,
  getTelemetryClickhouse,
} from '../clickhouse/telemetry-client';

/**
 * Metric- and label-name discovery for the query builder.
 *
 * These read ClickHouse directly rather than going through gigapipe, which is
 * the one place the plan carves out for direct SQL. gigapipe's label endpoints
 * answer "what labels exist" globally; scoping them to a project would mean
 * passing a selector and hoping every endpoint honours it consistently.
 * `time_series_gin` is an inverted (key, val) -> fingerprint index whose primary
 * key starts with `key`, so the scoped question — "which fingerprints carry
 * op_project_id=X, and what else do they carry" — is a fast index lookup and is
 * scoped by construction.
 *
 * EVERY query here is scoped through the same fingerprint sub-select. There is
 * no code path that lists metrics without a project.
 */

/**
 * Fingerprints belonging to one project.
 *
 * Written once and reused so the scoping cannot be forgotten in a new query.
 * `{projectId:String}` is a ClickHouse bound parameter, not interpolation.
 */
const PROJECT_FINGERPRINTS = `
  SELECT fingerprint
  FROM ${TELEMETRY_DATABASE}.time_series_gin
  WHERE key = '${PROJECT_LABEL}' AND val = {projectId:String}
`;

/** Labels that are ours or Prometheus's, not the customer's data. */
const INTERNAL_LABELS = ['__name__', PROJECT_LABEL];

async function scopedQuery<T>(
  projectId: string,
  query: string,
  extraParams: Record<string, unknown> = {},
): Promise<T[]> {
  // Defence in depth. The value is a bound parameter, so this is not what stops
  // injection — it stops a malformed id from silently matching nothing and
  // presenting an empty metric list as "you have no telemetry".
  assertValidProjectId(projectId);

  const result = await getTelemetryClickhouse().query({
    query,
    query_params: { projectId, ...extraParams },
    format: 'JSONEachRow',
  });

  return result.json<T>();
}

/** Metric names this project has written. */
export async function getTelemetryMetricNames(
  projectId: string,
  { limit = 1000 }: { limit?: number } = {},
): Promise<string[]> {
  const rows = await scopedQuery<{ metric: string }>(
    projectId,
    `SELECT DISTINCT val AS metric
     FROM ${TELEMETRY_DATABASE}.time_series_gin
     WHERE key = '__name__' AND fingerprint IN (${PROJECT_FINGERPRINTS})
     ORDER BY metric
     LIMIT ${Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1000}`,
  );

  return rows.map((r) => r.metric);
}

/**
 * Label keys available on a project's series.
 *
 * Optionally narrowed to one metric — which is what the filter builder wants,
 * since offering every label in the project would suggest filters that select
 * nothing on the chosen metric.
 */
export async function getTelemetryLabelKeys(
  projectId: string,
  { metric, limit = 500 }: { metric?: string; limit?: number } = {},
): Promise<string[]> {
  const scope = metric
    ? `fingerprint IN (
         SELECT fingerprint FROM ${TELEMETRY_DATABASE}.time_series_gin
         WHERE key = '__name__' AND val = {metric:String}
           AND fingerprint IN (${PROJECT_FINGERPRINTS})
       )`
    : `fingerprint IN (${PROJECT_FINGERPRINTS})`;

  const rows = await scopedQuery<{ key: string }>(
    projectId,
    `SELECT DISTINCT key
     FROM ${TELEMETRY_DATABASE}.time_series_gin
     WHERE ${scope}
       AND key NOT IN (${INTERNAL_LABELS.map((l) => `'${l}'`).join(', ')})
     ORDER BY key
     LIMIT ${Math.max(1, Math.floor(limit))}`,
    metric ? { metric } : {},
  );

  return rows.map((r) => r.key);
}

/** Values a given label takes, within one project. */
export async function getTelemetryLabelValues(
  projectId: string,
  label: string,
  { metric, limit = 500 }: { metric?: string; limit?: number } = {},
): Promise<string[]> {
  // The tenancy label is never offered as a filter dimension: its only value is
  // this project's own id, so exposing it would put an internal identifier in
  // the UI and imply it can be changed.
  if (label === PROJECT_LABEL) {
    return [];
  }

  const scope = metric
    ? `AND fingerprint IN (
         SELECT fingerprint FROM ${TELEMETRY_DATABASE}.time_series_gin
         WHERE key = '__name__' AND val = {metric:String}
           AND fingerprint IN (${PROJECT_FINGERPRINTS})
       )`
    : `AND fingerprint IN (${PROJECT_FINGERPRINTS})`;

  const rows = await scopedQuery<{ val: string }>(
    projectId,
    `SELECT DISTINCT val
     FROM ${TELEMETRY_DATABASE}.time_series_gin
     WHERE key = {label:String} ${scope}
     ORDER BY val
     LIMIT ${Math.max(1, Math.floor(limit))}`,
    metric ? { label, metric } : { label },
  );

  return rows.map((r) => r.val);
}

/**
 * Services reporting telemetry, from the `target_info` gauge gigapipe writes
 * per resource. This is what a services overview page lists.
 */
export async function getTelemetryServices(
  projectId: string,
): Promise<string[]> {
  const rows = await scopedQuery<{ val: string }>(
    projectId,
    `SELECT DISTINCT val
     FROM ${TELEMETRY_DATABASE}.time_series_gin
     WHERE key = 'job' AND fingerprint IN (${PROJECT_FINGERPRINTS})
     ORDER BY val
     LIMIT 500`,
  );

  return rows.map((r) => r.val);
}
