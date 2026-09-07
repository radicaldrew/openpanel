import {
  type MetricQuery,
  compileMetricQuery,
  queryRange,
} from '@openpanel/gigapipe';
import type { IInterval } from '@openpanel/validation';
import type { FinalChart } from '@openpanel/validation';
import { format } from '../format';
import type { ConcreteSeries } from '../types';
import {
  type PromMatrixResponse,
  adaptMatrixToConcreteSeries,
} from './adapter';
import {
  DEFAULT_SERIES_LIMIT,
  MAX_DIRECT_STEP_SECONDS,
  bucketGrid,
  capSeries,
  downsampleForStep,
  parseDuration,
  resolveStep,
  trimToObserved,
} from './step';

// Re-exported so `@openpanel/db`'s public surface keeps the name it has always
// had; the MCP report tools and the alert cron both read it.
export { DEFAULT_SERIES_LIMIT } from './step';
export { executeMetricPanel } from './panel';
export type { MetricPanelInput, MetricPanelResult } from './panel';

/**
 * The metrics chart engine.
 *
 * Mirrors the event engine's contract exactly — same `FinalChart` out, same
 * previous-period option — so `chart.ts` can dispatch on the report's data
 * source and everything downstream stays unaware there are two engines.
 */


export interface MetricChartInput {
  projectId: string;
  query: MetricQuery;
  interval: IInterval;
  startDate: string;
  endDate: string;
  previous?: boolean;
  name?: string;
  /** Maximum series to render. Defaults to {@link DEFAULT_SERIES_LIMIT}. */
  seriesLimit?: number;
}


export interface MetricChartResult {
  chart: FinalChart;
  /** The PromQL actually sent, for the UI's "show query" affordance. */
  compiled: string;
  /** Things the user should know: a widened window, a coarsened interval. */
  notices: string[];
}


/**
 * The rate window must never be shorter than the step.
 *
 * A `rate()` over a window narrower than the step samples the gaps between
 * buckets and draws a sawtooth that reads as real instability in the service.
 * Prometheus's own guidance is at least four scrape intervals; four steps is
 * the same reasoning expressed in the units we control.
 */
function resolveWindow(
  query: MetricQuery,
  stepSeconds: number,
  notices: string[],
): string | undefined {
  if (query.fn === 'raw') {
    return undefined;
  }

  const minimum = stepSeconds * 4;

  if (query.window) {
    const parsed = parseDuration(query.window);
    if (parsed !== undefined && parsed >= minimum) {
      return query.window;
    }

    notices.push(
      `Rate window widened to ${minimum}s so it is not shorter than the ${stepSeconds}s interval.`,
    );
  }

  return `${minimum}s`;
}


async function runOnce(
  input: MetricChartInput,
  start: Date,
  end: Date,
  stepSeconds: number,
  notices: string[],
): Promise<{ series: ConcreteSeries[]; compiled: string }> {
  // When the query will be evaluated as a subquery, the rate window has to be
  // sized against the INNER step. Sizing it against the outer one would put a
  // four-hour window on an hourly chart and smooth away everything the chart
  // exists to show.
  const windowStep = Math.min(stepSeconds, MAX_DIRECT_STEP_SECONDS);

  const compiled = compileMetricQuery(
    { ...input.query, window: resolveWindow(input.query, windowStep, notices) },
    input.projectId,
  );

  notices.push(...compiled.notices);

  const promql = downsampleForStep(compiled.promql, stepSeconds);

  const response = (await queryRange({
    promql,
    start,
    end,
    step: `${stepSeconds}s`,
  })) as PromMatrixResponse;

  const full = bucketGrid(start, end, stepSeconds);

  // Only when there is nothing to compare against. A previous-period overlay is
  // aligned to the current period by index, so the two runs have to keep the
  // same grid length.
  const grid = input.previous
    ? full
    : trimToObserved(response, full, stepSeconds);

  return {
    // The query actually sent, so the UI's "show query" is not a fiction.
    compiled: promql,
    series: adaptMatrixToConcreteSeries(response, {
      // The same value `compileMetricQuery` was given above, so the adapter
      // compares the response against the scope that was actually requested
      // rather than against anything re-derived from the response itself.
      projectId: input.projectId,
      groupBy: compiled.groupBy,
      metricName: input.name ?? input.query.metric,
      buckets: grid.labels,
      bucketTimes: grid.times,
    }),
  };
}

export async function executeMetricChart(
  input: MetricChartInput,
): Promise<MetricChartResult> {
  const notices: string[] = [];
  const start = new Date(input.startDate);
  const end = new Date(input.endDate);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error('Metric chart requires a valid start and end date');
  }

  const stepSeconds = resolveStep(input.interval, start, end, notices);

  const limit = input.seriesLimit ?? DEFAULT_SERIES_LIMIT;
  const current = await runOnce(input, start, end, stepSeconds, notices);
  const currentSeries = capSeries(current.series, limit, notices);

  let previousSeries: ConcreteSeries[] | null = null;
  if (input.previous) {
    // Shift by the range's own length rather than by a calendar unit, matching
    // how the event engine defines "previous period".
    const spanMs = end.getTime() - start.getTime();
    const prevEnd = new Date(start.getTime());
    const prevStart = new Date(start.getTime() - spanMs);

    const previous = await runOnce(
      input,
      prevStart,
      prevEnd,
      stepSeconds,
      // Notices from the comparison run would duplicate the current run's.
      [],
    );
    // Cap the comparison period to the SAME series as the current one, not to
    // its own top N — otherwise the two periods rank differently and a line is
    // compared against a different service's history.
    const keep = new Set(currentSeries.map((s) => s.id));
    previousSeries = previous.series.filter((s) => keep.has(s.id));
  }

  const chart = format(
    currentSeries,
    [
      {
        id: 'metric',
        type: 'event',
        name: input.name ?? input.query.metric,
        displayName: input.name ?? input.query.metric,
      },
    ],
    false,
    previousSeries,
    undefined,
  );

  return { chart, compiled: current.compiled, notices };
}
