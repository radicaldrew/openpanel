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

/** Labels that are ours or Prometheus's, not the customer's data. */
const INTERNAL_LABELS = ['__name__', PROJECT_LABEL];

/**
 * A label name, as Prometheus defines one.
 *
 * Checked for the same reason `assertValidProjectId` is: label names reach
 * ClickHouse as bound parameters, so this is not what stops injection. It stops
 * a malformed name from matching nothing and presenting the empty result as
 * "this label has no values".
 */
const LABEL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Metric names may also carry colons, by Prometheus recording-rule convention. */
const METRIC_NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

export class TelemetryMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelemetryMetadataError';
  }
}

function assertLabelName(value: string): string {
  if (!LABEL_NAME_RE.test(value)) {
    throw new TelemetryMetadataError(
      `${JSON.stringify(value)} is not a valid label name`,
    );
  }

  return value;
}

function assertMetricName(value: string): string {
  if (!METRIC_NAME_RE.test(value)) {
    throw new TelemetryMetadataError(
      `${JSON.stringify(value)} is not a valid metric name`,
    );
  }

  return value;
}

/**
 * One label matcher, as it narrows a fingerprint set.
 *
 * Equality only. `=` and `!=` are set operations over the inverted index — the
 * fingerprints carrying (key, val), kept or excluded — which is what makes them
 * cheap. `=~` and `!~` would have to scan every value of that key and run a
 * regex per row, on a table whose primary key gives no help beyond `key`, so
 * they are rejected rather than quietly made slow. Callers that parse a
 * selector should refuse regex matchers with a message saying so.
 */
export interface ITelemetryLabelMatcher {
  label: string;
  op: '=' | '!=';
  value: string;
}

/** At most this many matchers on one lookup; each one is a sub-select. */
const MAX_MATCHERS = 10;

export interface ITelemetryMetadataScope {
  /** Narrow to one metric name (`__name__`). */
  metric?: string;
  /** Narrow to series carrying (or not carrying) these label values. */
  matchers?: ITelemetryLabelMatcher[];
  /**
   * Inclusive day bounds on when the series was last seen.
   *
   * `time_series_gin` carries a `date` and is PARTITIONed by it, so bounding
   * the read prunes partitions rather than filtering rows — this is cheaper
   * than the unbounded read, not more expensive.
   *
   * Omit both for everything retained, which is what the autocomplete callers
   * want: while typing a filter you want every label you have ever written,
   * not only the ones alive in the panel's window. A variable picker wants the
   * opposite, and passes the range.
   *
   * Note the ceiling either way: gigapipe puts a 30-day TTL on these tables, so
   * "unbounded" already means "the last 30 days".
   */
  startDate?: Date | string;
  endDate?: Date | string;
  limit?: number;
}

/**
 * A `Date` bound parameter wants a plain `YYYY-MM-DD`.
 *
 * UTC deliberately: the column is a `Date` written by gigapipe from UTC
 * timestamps, so converting in the server's local zone would shift the bound by
 * a day for half the world.
 */
function toClickhouseDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new TelemetryMetadataError(
      `${JSON.stringify(String(value))} is not a valid date`,
    );
  }

  return date.toISOString().slice(0, 10);
}

interface IScopeSql {
  /** ` AND date >= … AND date <= …`, or empty. Applied to every gin read. */
  date: string;
  /** ` AND fingerprint IN (…)` clauses: project first, then metric, then matchers. */
  fingerprints: string;
  params: Record<string, unknown>;
}

/**
 * The scope every query in this file is built from.
 *
 * One function rather than a string constant per query so a new lookup cannot
 * accidentally omit the project predicate, and so the date bound reaches the
 * sub-selects too — a project-fingerprint row is itself dated, and bounding
 * only the outer query would read every partition of the inner one.
 */
function buildScope(scope: ITelemetryMetadataScope): IScopeSql {
  const params: Record<string, unknown> = {};
  const dateClauses: string[] = [];

  if (scope.startDate !== undefined) {
    params.dateFrom = toClickhouseDate(scope.startDate);
    dateClauses.push('date >= {dateFrom:Date}');
  }

  if (scope.endDate !== undefined) {
    params.dateTo = toClickhouseDate(scope.endDate);
    dateClauses.push('date <= {dateTo:Date}');
  }

  const date = dateClauses.length > 0 ? ` AND ${dateClauses.join(' AND ')}` : '';

  const gin = (where: string) =>
    `SELECT fingerprint FROM ${TELEMETRY_DATABASE}.time_series_gin WHERE ${where}${date}`;

  const projectFingerprints = gin(
    `key = '${PROJECT_LABEL}' AND val = {projectId:String}`,
  );

  // Unconditional, and deliberately not behind an option. An earlier version
  // took a `requireProjectScope` flag that nothing ever passed as false; the
  // only way to reach it was for someone to add a caller, at which point the
  // tenancy predicate would vanish from every sub-select at once. The file's
  // header promises there is no code path that lists metrics without a
  // project — this is what makes that true rather than merely currently true.
  const clauses: string[] = [` AND fingerprint IN (${projectFingerprints})`];

  if (scope.metric) {
    params.metric = assertMetricName(scope.metric);
    clauses.push(
      ` AND fingerprint IN (${gin("key = '__name__' AND val = {metric:String}")})`,
    );
  }

  const matchers = scope.matchers ?? [];

  if (matchers.length > MAX_MATCHERS) {
    throw new TelemetryMetadataError(
      `At most ${MAX_MATCHERS} label matchers are supported, got ${matchers.length}`,
    );
  }

  matchers.forEach((matcher, index) => {
    const keyParam = `m${index}k`;
    const valParam = `m${index}v`;

    params[keyParam] = assertLabelName(matcher.label);
    params[valParam] = matcher.value;

    // The negative case is scoped to the project as well as inverted. It would
    // be correct either way — the outer query intersects with the project set
    // regardless — but an unscoped NOT IN builds the set of every fingerprint
    // in the cluster carrying that label value, across every tenant.
    const subject = gin(
      `key = {${keyParam}:String} AND val = {${valParam}:String} AND fingerprint IN (${projectFingerprints})`,
    );

    clauses.push(
      matcher.op === '='
        ? ` AND fingerprint IN (${subject})`
        : ` AND fingerprint NOT IN (${subject})`,
    );
  });

  return { date, fingerprints: clauses.join(''), params };
}

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

const boundedLimit = (limit: number | undefined, fallback: number) =>
  Number.isFinite(limit) ? Math.max(1, Math.floor(limit as number)) : fallback;

/** Metric names this project has written. */
export async function getTelemetryMetricNames(
  projectId: string,
  { limit = 1000, ...scope }: ITelemetryMetadataScope = {},
): Promise<string[]> {
  const { date, fingerprints, params } = buildScope(scope);

  const rows = await scopedQuery<{ metric: string }>(
    projectId,
    `SELECT DISTINCT val AS metric
     FROM ${TELEMETRY_DATABASE}.time_series_gin
     WHERE key = '__name__'${date}${fingerprints}
     ORDER BY metric
     LIMIT ${boundedLimit(limit, 1000)}`,
    params,
  );

  return rows.map((r) => r.metric);
}

/**
 * Label keys available on a project's series.
 *
 * Optionally narrowed to one metric — which is what the filter builder wants,
 * since offering every label in the project would suggest filters that select
 * nothing on the chosen metric — and optionally to series matching a set of
 * label matchers.
 */
export async function getTelemetryLabelKeys(
  projectId: string,
  { limit = 500, ...scope }: ITelemetryMetadataScope = {},
): Promise<string[]> {
  const { date, fingerprints, params } = buildScope(scope);

  const rows = await scopedQuery<{ key: string }>(
    projectId,
    `SELECT DISTINCT key
     FROM ${TELEMETRY_DATABASE}.time_series_gin
     WHERE key NOT IN (${INTERNAL_LABELS.map((l) => `'${l}'`).join(', ')})${date}${fingerprints}
     ORDER BY key
     LIMIT ${boundedLimit(limit, 500)}`,
    params,
  );

  return rows.map((r) => r.key);
}

/**
 * Values a given label takes, within one project.
 *
 * With `matchers`, this answers the narrowed question a query variable asks:
 * `label_values(up{job="api"}, pod)` is `label: 'pod'`, `metric: 'up'`,
 * `matchers: [{ label: 'job', op: '=', value: 'api' }]`.
 */
export async function getTelemetryLabelValues(
  projectId: string,
  label: string,
  { limit = 500, ...scope }: ITelemetryMetadataScope = {},
): Promise<string[]> {
  // The tenancy label is never offered as a filter dimension: its only value is
  // this project's own id, so exposing it would put an internal identifier in
  // the UI and imply it can be changed.
  if (label === PROJECT_LABEL) {
    return [];
  }

  assertLabelName(label);

  const { date, fingerprints, params } = buildScope(scope);

  const rows = await scopedQuery<{ val: string }>(
    projectId,
    `SELECT DISTINCT val
     FROM ${TELEMETRY_DATABASE}.time_series_gin
     WHERE key = {label:String}${date}${fingerprints}
     ORDER BY val
     LIMIT ${boundedLimit(limit, 500)}`,
    { ...params, label },
  );

  return rows.map((r) => r.val);
}

/**
 * Services reporting telemetry, from the `target_info` gauge gigapipe writes
 * per resource. This is what a services overview page lists.
 */
export async function getTelemetryServices(
  projectId: string,
  scope: Pick<ITelemetryMetadataScope, 'startDate' | 'endDate'> = {},
): Promise<string[]> {
  const { date, fingerprints, params } = buildScope(scope);

  const rows = await scopedQuery<{ val: string }>(
    projectId,
    `SELECT DISTINCT val
     FROM ${TELEMETRY_DATABASE}.time_series_gin
     WHERE key = 'job'${date}${fingerprints}
     ORDER BY val
     LIMIT 500`,
    params,
  );

  return rows.map((r) => r.val);
}

/**
 * The SQL a metadata lookup would run, for tests.
 *
 * Exported so the scoping invariants — project predicate present, values bound
 * rather than interpolated, date bounds reaching the sub-selects — can be
 * asserted without a live ClickHouse. Nothing in the application calls this.
 */
export const __testing = { buildScope, toClickhouseDate };
