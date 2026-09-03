import { PROJECT_LABEL } from '@openpanel/gigapipe';
import { formatClickhouseDate } from '../../clickhouse/client';
import type { ConcreteSeries } from '../types';

/**
 * Turn a Prometheus matrix response into the shape OpenPanel's chart pipeline
 * already speaks.
 *
 * This adapter is the highest-leverage piece of the metrics work. The existing
 * `format()` stage converts `ConcreteSeries[]` into `FinalChart`, and every
 * visual surface in the product consumes `FinalChart` — the chart renderers,
 * dashboards and their grid layout, public share links, embed widgets, the MCP
 * report tools. Producing `ConcreteSeries` here means a metric report is an
 * ordinary report everywhere downstream, rather than a parallel rendering path
 * that has to be kept in sync forever.
 *
 * What it deliberately does NOT do is invent event-shaped context. A metric
 * series has no `event` and no profile drill-down, so `context.event` stays
 * undefined and `filters` stays empty; the UI already treats those as optional,
 * and faking them would make "view these users" offer something that cannot
 * work.
 */

/** A single series in a Prometheus `matrix` result. */
export interface PromMatrixSeries {
  metric: Record<string, string>;
  /** `[unixSeconds, "value"]`, value as a string per the Prometheus wire format. */
  values: [number, string][];
}

export interface PromMatrixResponse {
  status: string;
  data?: {
    resultType?: string;
    result?: PromMatrixSeries[];
  };
}

export class MetricsResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetricsResponseError';
  }
}

/**
 * Build the display name for one series.
 *
 * With group-by labels present, the name is their values — `["/checkout"]` —
 * which matches how an event report names a breakdown series. With none, the
 * metric name is the only meaningful label.
 */
function seriesName(
  labels: Record<string, string>,
  groupBy: string[],
  metricName: string,
): string[] {
  const parts = groupBy
    .filter((label) => label !== PROJECT_LABEL)
    .map((label) => labels[label])
    .filter((value): value is string => value !== undefined && value !== '');

  if (parts.length > 0) {
    return parts;
  }

  // The compiled `by (...)` normally guarantees the response carries only the
  // grouped labels, so the branch above answers it. But if a response ever
  // arrives with distinguishing labels the query did not group by, naming every
  // series after the metric would render several identically-labelled lines
  // that the user cannot tell apart. Fall back to whatever actually
  // distinguishes them before falling back to the metric name.
  const distinguishing = Object.entries(labels)
    .filter(([key]) => key !== PROJECT_LABEL && key !== '__name__')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, value]) => value)
    .filter((value) => value !== '');

  return distinguishing.length > 0 ? distinguishing : [metricName];
}

/**
 * Everything except the project label becomes a breakdown.
 *
 * The project label is stripped because it is infrastructure, not data: it is
 * the same for every series in the response — the compiler injects it and
 * `assertOwnedBy` has already verified it on this very series — so surfacing it
 * would add a constant column to every chart legend and leak an internal
 * identifier into a user-facing label.
 *
 * Stripping is only safe BECAUSE the check ran first. Every function here that
 * drops the label (this one, `seriesName`, `seriesId`) destroys the only
 * evidence of which project a series came from, so the order is load-bearing:
 * verify, then strip.
 */
function breakdownsOf(labels: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(labels)) {
    if (key === PROJECT_LABEL || key === '__name__') {
      continue;
    }
    out[key] = value;
  }

  return out;
}

/**
 * A stable id for a series, so React keys and colour assignment survive a
 * refetch. Derived from the label set rather than the array index, which
 * reorders whenever a series appears or disappears.
 */
function seriesId(labels: Record<string, string>): string {
  const parts = Object.entries(labels)
    .filter(([key]) => key !== PROJECT_LABEL)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`);

  return parts.join(',') || 'series';
}

/**
 * The response-side half of the tenancy boundary.
 *
 * The compiler injects `op_project_id="<project>"` into every selector, and
 * forces the same label into the `by (...)` of every aggregation
 * (`renderGrouping`, packages/gigapipe/src/promql/compile.ts) specifically so
 * it survives aggregation and arrives here — that comment says the alternative
 * would leave the response-side ownership check vacuous. Which it would: a rule
 * that preserves evidence buys nothing until something reads the evidence. This
 * is the reader.
 *
 * It is not a restatement of the injected matcher, because it fails for reasons
 * the matcher cannot see: a gigapipe-side bug, a transpiler regression that
 * drops the fingerprint filter (its stream planner rewrites an empty-valued
 * matcher into "every series WITHOUT this label" —
 * docs/observability/01-tenancy-and-security.md section 3), or a future caller
 * pointing this adapter at a response the structured compiler did not produce,
 * such as a raw-PromQL path.
 *
 * A MISSING label fails too. A series that lost the label is indistinguishable
 * from one that was never scoped, and accepting it is exactly the vacuous mode
 * the spec deleted.
 *
 * The WHOLE response is dropped rather than the offending series filtered out.
 * Filtering would render a chart that silently omits the evidence of its own
 * failure; the spec is explicit that an empty or quietly-shortened chart is not
 * an acceptable rendering of a failed ownership check.
 */
function assertOwnedBy(
  labels: Record<string, string>,
  projectId: string,
): void {
  const owner = labels[PROJECT_LABEL];

  if (owner === undefined) {
    throw new MetricsResponseError(
      `Telemetry response contains a series with no ${PROJECT_LABEL} label (expected ${projectId}); refusing to render it`,
    );
  }

  if (owner !== projectId) {
    // The foreign value is deliberately not interpolated. This message reaches
    // logs and, through the chart error, a user; echoing another project's id
    // would turn a containment failure into a disclosure as well. The expected
    // id is the caller's own, so it is safe and is what identifies the query.
    throw new MetricsResponseError(
      `Telemetry response contains a series belonging to a different project (expected ${projectId}); refusing to render it`,
    );
  }
}

export interface AdaptOptions {
  /**
   * The project this query was compiled for.
   *
   * Required, not optional: an ownership check a caller can omit is one a
   * caller eventually omits, and it fails open when they do. Putting it in the
   * call signature makes every present and future caller state which project it
   * believes the response belongs to.
   */
  projectId: string;
  /** Group-by labels from the compiled query, project label first. */
  groupBy: string[];
  /** Metric name, used when there is nothing to name a series by. */
  metricName: string;
  /**
   * Every bucket the chart expects, as `formatClickhouseDate` strings.
   *
   * Prometheus omits steps with no data, while the chart renderers expect a
   * dense series — a missing bucket shifts every later point left and silently
   * misdates the whole line. Passing the expected grid makes the gaps explicit.
   */
  buckets?: string[];
  /**
   * Epoch milliseconds for each entry of {@link buckets}, in the same order.
   *
   * Present so samples can be SNAPPED to the nearest bucket instead of matched
   * by an exact formatted date. The backend does not return the grid it was
   * asked for: a range starting at :137 past the hour comes back at :135, and
   * a start that is not step-aligned shifts every point by the remainder.
   * Exact matching therefore found nothing and, because a missing bucket reads
   * as zero, drew a flat zero line — indistinguishable from "no data".
   */
  bucketTimes?: number[];
}

/**
 * Convert a matrix response into `ConcreteSeries[]`.
 *
 * Values arrive as strings and may be `NaN` (Prometheus renders a missing
 * quantile that way). `NaN` becomes a gap rather than a zero: zero is a real
 * measurement and drawing one where the backend said "no data" invents a fact.
 */
export function adaptMatrixToConcreteSeries(
  response: PromMatrixResponse,
  options: AdaptOptions,
): ConcreteSeries[] {
  if (response.status !== 'success') {
    throw new MetricsResponseError(
      `Telemetry backend returned status ${response.status}`,
    );
  }

  const resultType = response.data?.resultType;
  if (resultType && resultType !== 'matrix') {
    throw new MetricsResponseError(
      `Expected a matrix result, got ${resultType}`,
    );
  }

  const result = response.data?.result ?? [];

  return result.map((series) => {
    const labels = series.metric ?? {};

    // FIRST, before seriesName/breakdownsOf/seriesId strip the label and take
    // the evidence with it.
    assertOwnedBy(labels, options.projectId);

    const byDate = new Map<string, number>();
    const grid = options.buckets;
    const gridTimes = options.bucketTimes;
    // Half a step: the widest a sample can be from a bucket's centre and still
    // belong to it.
    const tolerance =
      gridTimes && gridTimes.length > 1
        ? ((gridTimes[1] as number) - (gridTimes[0] as number)) / 2
        : 0;

    for (const [unixSeconds, raw] of series.values ?? []) {
      const value = Number.parseFloat(raw);
      if (Number.isNaN(value)) {
        continue;
      }

      const ms = unixSeconds * 1000;

      if (grid && gridTimes && gridTimes.length > 0 && tolerance > 0) {
        const first = gridTimes[0] as number;
        const step = tolerance * 2;
        const index = Math.round((ms - first) / step);

        if (index >= 0 && index < grid.length) {
          const bucketMs = gridTimes[index] as number;
          if (Math.abs(ms - bucketMs) <= tolerance) {
            byDate.set(grid[index] as string, value);
            continue;
          }
        }
        // Outside the grid entirely: drop it rather than misdate it.
        continue;
      }

      byDate.set(formatClickhouseDate(new Date(ms)), value);
    }

    const dates = options.buckets ?? [...byDate.keys()].sort();

    return {
      id: seriesId(labels),
      definitionId: 'metric',
      definitionIndex: 0,
      name: seriesName(labels, options.groupBy, options.metricName),
      context: {
        // No event and no filters: a metric series has no profile drill-down,
        // and pretending otherwise would offer a "view these users" action that
        // cannot be answered.
        filters: [],
        breakdowns: breakdownsOf(labels),
      },
      data: dates.map((date) => ({
        date,
        count: byDate.get(date) ?? 0,
      })),
      definition: {
        id: 'metric',
        type: 'event',
        name: options.metricName,
        // NO displayName. format() splices a definition's displayName over the
        // first element of every series name (format.ts:67-68), which is right
        // for an event report where the user named the series — and wrong here,
        // where it would overwrite each series' distinguishing label value and
        // render every line in the legend under the same metric name.
        segment: 'event',
        filters: [],
      } as unknown as ConcreteSeries['definition'],
    } satisfies ConcreteSeries;
  });
}
