import { substituteVariables } from '@openpanel/common';
import {
  GigapipeError,
  GigapipeNotConfiguredError,
  assertPromqlScoped,
  queryInstant,
  queryRange,
  rewritePromqlForProject,
} from '@openpanel/gigapipe';
import type {
  FinalChart,
  IChartSeriePanel,
  IInterval,
  IPanelQuery,
  IVariableValues,
} from '@openpanel/validation';
import { format } from '../format';
import type { ConcreteSeries } from '../types';
import {
  MetricsResponseError,
  type PromMatrixResponse,
  type PromVectorResponse,
  adaptMatrixToPanelSeries,
  adaptVectorToPanelSeries,
} from './adapter';
import {
  DEFAULT_SERIES_LIMIT,
  bucketGrid,
  capSeries,
  downsampleForStep,
  parseDuration,
  resolveStep,
  trimToObserved,
} from './step';

/**
 * The multi-query metrics panel.
 *
 * A sibling of `executeMetricChart`, not a replacement for it. The structured
 * compiler still serves the alert cron, the MCP telemetry tool and the chat
 * agent, all of which build a `MetricQuery` and none of which have a PromQL
 * expression to run. This path takes `expr` as the source of truth instead —
 * whatever the editor produced, whether from the builder or typed by hand.
 *
 * THE ORDER OF THE PIPELINE IS THE SECURITY ARGUMENT
 *
 *   substitute → rewrite → assert → run
 *
 * Variables are folded in FIRST so the string the rewriter parses is the string
 * that reaches gigapipe. Substituting afterwards would mean the tenancy gate
 * scoped an expression it never saw in final form, and a variable value could
 * introduce a selector that was never given the project matcher.
 */

/**
 * How much larger the whole panel may be than one query's share.
 *
 * Two, not ten: a panel is allowed to be busier than a single-query chart, but
 * not ten times busier — past roughly forty lines the legend is unreadable and
 * the palette has long since repeated.
 */
const PANEL_SERIES_LIMIT_FACTOR = 2;

export interface MetricPanelInput {
  projectId: string;
  queries: IPanelQuery[];
  interval: IInterval;
  startDate: string;
  endDate: string;
  previous?: boolean;
  variables?: IVariableValues;
  /** Maximum series per query. Defaults to {@link DEFAULT_SERIES_LIMIT}. */
  seriesLimit?: number;
}

export interface MetricPanelResult {
  chart: FinalChart;
  /** What actually ran, per query, for the editor's "show query" affordance. */
  compiled: { refId: string; promql: string }[];
  notices: string[];
}

/**
 * Attach a query's identity to the failure it caused.
 *
 * On a panel with five queries, "Query is too large" names none of them and the
 * user has to bisect by hand. The upstream message is kept verbatim after the
 * prefix, and a `GigapipeError`'s status is carried across so an over-large
 * query still arrives at the UI as 413 — which is what makes the difference
 * between "narrow the range" and "retry", the one distinction the read path
 * exists to preserve.
 */
function prefixQueryError(refId: string, error: unknown): Error {
  // Not query-specific: the whole deployment has no telemetry backend, and
  // naming a query would suggest the query is what is wrong.
  if (error instanceof GigapipeNotConfiguredError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  const prefixed = `Query ${refId}: ${message}`;

  if (error instanceof GigapipeError) {
    return new GigapipeError(prefixed, error.status, error.body);
  }

  return new MetricsResponseError(prefixed);
}

/**
 * The step every query on the panel is drawn at.
 *
 * ONE step for the whole panel, not one per query. `format()` aligns series by
 * index across a single bucket grid, so a query evaluated at a coarser step
 * would land on every Nth bucket and leave the ones between reading as zero —
 * a sawtooth to the axis that looks like an outage.
 *
 * `minStep` is therefore a floor on the PANEL's step rather than on that
 * query's alone. It is the widest of the visible queries' floors, and a notice
 * says so whenever one of them actually raised it.
 */
function resolvePanelStep(
  queries: IPanelQuery[],
  interval: IInterval,
  start: Date,
  end: Date,
  notices: string[],
): number {
  const base = resolveStep(interval, start, end, notices);

  let floor = 0;
  let raisedBy: string | undefined;

  for (const query of queries) {
    if (!query.minStep) {
      continue;
    }

    const parsed = parseDuration(query.minStep);

    if (parsed === undefined) {
      notices.push(
        `Query ${query.refId}: min step ${query.minStep} is not a Prometheus duration and was ignored.`,
      );
      continue;
    }

    if (parsed > floor) {
      floor = parsed;
      raisedBy = query.refId;
    }
  }

  if (floor <= base) {
    return base;
  }

  notices.push(
    `Interval widened to ${floor}s by query ${raisedBy}'s min step. Every query on a panel is drawn on one grid, so the floor applies to all of them.`,
  );

  return floor;
}

interface QueryRun {
  query: IPanelQuery;
  /** The query's index in the ORIGINAL list, so hiding one does not relabel the rest. */
  definitionIndex: number;
}

async function runQuery(
  run: QueryRun,
  input: MetricPanelInput,
  start: Date,
  end: Date,
  stepSeconds: number,
  multi: boolean,
  notices: string[],
): Promise<{ series: ConcreteSeries[]; promql: string }> {
  const rangeSeconds = Math.max(1, (end.getTime() - start.getTime()) / 1000);

  const substituted = substituteVariables(run.query.expr, input.variables, {
    step: stepSeconds,
    rangeSeconds,
  });

  const rewritten = rewritePromqlForProject(substituted, input.projectId);
  assertPromqlScoped(rewritten, input.projectId);

  const grid = bucketGrid(start, end, stepSeconds);

  const adaptOptions = {
    projectId: input.projectId,
    refId: run.query.refId,
    definitionIndex: run.definitionIndex,
    legendFormat: run.query.legendFormat,
    multi,
  };

  if (run.query.instant) {
    const response = (await queryInstant({
      promql: rewritten,
      time: end,
    })) as PromVectorResponse;

    return {
      promql: rewritten,
      series: adaptVectorToPanelSeries(response, {
        ...adaptOptions,
        buckets: grid.labels,
        bucketTimes: grid.times,
      }),
    };
  }

  const promql = downsampleForStep(rewritten, stepSeconds);

  const response = (await queryRange({
    promql,
    start,
    end,
    step: `${stepSeconds}s`,
  })) as PromMatrixResponse;

  // Only when there is nothing to compare against. A previous-period overlay is
  // aligned to the current period by index, so the two runs have to keep the
  // same grid length.
  const trimmed = input.previous
    ? grid
    : trimToObserved(response, grid, stepSeconds);

  const series = adaptMatrixToPanelSeries(response, {
    ...adaptOptions,
    buckets: trimmed.labels,
    bucketTimes: trimmed.times,
  });

  return {
    promql,
    series: capSeries(series, input.seriesLimit ?? DEFAULT_SERIES_LIMIT, notices),
  };
}

/**
 * The ceiling on the WHOLE panel, applied after each query has been capped.
 *
 * The per-query cap stops one query starving another, but it does not bound
 * the chart: ten queries at twenty series each is two hundred lines, on a
 * palette of about twenty. So the panel gets its own ceiling as well, and the
 * notice names the queries that lost series — "the chart was trimmed" is not
 * actionable unless you know which row to narrow.
 *
 * Series are dropped from the LARGEST contributors first, so a query returning
 * one line keeps it while a query returning eighty gives ground. Trimming
 * evenly would delete the single line someone added for comparison.
 */
function capPanel(
  series: ConcreteSeries[],
  perQueryLimit: number,
  notices: string[],
): ConcreteSeries[] {
  const limit = perQueryLimit * PANEL_SERIES_LIMIT_FACTOR;

  if (series.length <= limit) {
    return series;
  }

  const byRefId = new Map<string, ConcreteSeries[]>();

  for (const serie of series) {
    const bucket = byRefId.get(serie.definitionId) ?? [];
    bucket.push(serie);
    byRefId.set(serie.definitionId, bucket);
  }

  const kept = new Set<ConcreteSeries>();
  const trimmed = new Set<string>();

  // Round-robin across the queries, largest-peak series first within each, so
  // every query keeps at least its top line before any query keeps its second.
  const queues = [...byRefId.entries()].map(([refId, group]) => ({
    refId,
    rest: [...group].sort((a, b) => peakOf(b) - peakOf(a)),
  }));

  let index = 0;

  while (kept.size < limit) {
    const queue = queues[index % queues.length];

    if (!queue) {
      break;
    }

    const next = queue.rest.shift();

    if (next) {
      kept.add(next);
    }

    index += 1;

    if (queues.every((q) => q.rest.length === 0)) {
      break;
    }
  }

  for (const queue of queues) {
    if (queue.rest.length > 0) {
      trimmed.add(queue.refId);
    }
  }

  notices.push(
    `Showing ${kept.size} of ${series.length} series across the panel. ${
      trimmed.size === 1
        ? `Query ${[...trimmed][0]} was trimmed`
        : `Queries ${[...trimmed].sort().join(', ')} were trimmed`
    } — add a filter or group by fewer labels.`,
  );

  // Original order, so the chart does not reshuffle just because it was capped.
  return series.filter((serie) => kept.has(serie));
}

function peakOf(serie: ConcreteSeries): number {
  return serie.data.reduce((max, point) => Math.max(max, point.count), 0);
}

/**
 * Run every visible query and settle them together.
 *
 * `allSettled` rather than `all`: with `all` the reported failure is whichever
 * query lost the race, so the same broken panel names a different query on
 * every refresh. Reporting the FIRST failure in query order makes the message
 * stable and makes "Query B" mean the second row of the editor.
 */
async function runAll(
  runs: QueryRun[],
  input: MetricPanelInput,
  start: Date,
  end: Date,
  stepSeconds: number,
  notices: string[],
): Promise<{ series: ConcreteSeries[]; promql: string }[]> {
  const multi = runs.length > 1;

  const settled = await Promise.allSettled(
    runs.map((run) =>
      runQuery(run, input, start, end, stepSeconds, multi, notices),
    ),
  );

  const failure = settled.findIndex((result) => result.status === 'rejected');
  if (failure !== -1) {
    const rejected = settled[failure] as PromiseRejectedResult;
    throw prefixQueryError(
      (runs[failure] as QueryRun).query.refId,
      rejected.reason,
    );
  }

  return settled.map(
    (result) =>
      (result as PromiseFulfilledResult<{
        series: ConcreteSeries[];
        promql: string;
      }>).value,
  );
}

export async function executeMetricPanel(
  input: MetricPanelInput,
): Promise<MetricPanelResult> {
  const notices: string[] = [];
  const start = new Date(input.startDate);
  const end = new Date(input.endDate);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error('Metric panel requires a valid start and end date');
  }

  const runs: QueryRun[] = input.queries
    .map((query, definitionIndex) => ({ query, definitionIndex }))
    .filter(({ query }) => !query.hidden && query.expr.trim() !== '');

  // One definition per query, INCLUDING the hidden ones. `format()` reads
  // `definitions[definitionIndex]` for the `(A)` prefix, so leaving gaps would
  // relabel every query after a hidden one.
  const definitions = input.queries.map((query) => ({
    id: query.refId,
    type: 'event' as const,
    name: query.refId,
  }));

  if (runs.length === 0) {
    return {
      chart: format([], definitions, true, null, undefined),
      compiled: [],
      notices,
    };
  }

  const stepSeconds = resolvePanelStep(
    runs.map((run) => run.query),
    input.interval,
    start,
    end,
    notices,
  );

  const current = await runAll(runs, input, start, end, stepSeconds, notices);
  const currentSeries = capPanel(
    current.flatMap((result) => result.series),
    input.seriesLimit ?? DEFAULT_SERIES_LIMIT,
    notices,
  );

  let previousSeries: ConcreteSeries[] | null = null;
  if (input.previous) {
    // Shift by the range's own length rather than by a calendar unit, matching
    // how the event engine defines "previous period".
    const spanMs = end.getTime() - start.getTime();
    const previous = await runAll(
      runs,
      input,
      new Date(start.getTime() - spanMs),
      new Date(start.getTime()),
      stepSeconds,
      // Notices from the comparison run would duplicate the current run's.
      [],
    );

    // Cap the comparison period to the SAME series as the current one, not to
    // its own top N — otherwise the two periods rank differently and a line is
    // compared against a different label's history.
    const keep = new Set(currentSeries.map((series) => series.id));
    previousSeries = previous
      .flatMap((result) => result.series)
      .filter((series) => keep.has(series.id));
  }

  const chart = format(currentSeries, definitions, true, previousSeries, undefined);

  // `format()` copies the definition's id onto `series.event.id`, and the
  // definition id IS the refId — so this is a lookup rather than a re-derivation
  // from the series name, which the user can change.
  const byRefId = new Map(input.queries.map((query) => [query.refId, query]));

  for (const series of chart.series) {
    const query = byRefId.get(series.event.id ?? '');

    if (!query) {
      continue;
    }

    Object.assign(series, {
      panel: {
        refId: query.refId,
        unit: query.unit,
        yAxis: query.yAxis,
      } satisfies IChartSeriePanel,
    });
  }

  return {
    chart,
    compiled: runs.map((run, index) => ({
      refId: run.query.refId,
      promql: (current[index] as { promql: string }).promql,
    })),
    notices,
  };
}
