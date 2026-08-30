import {
  type MetricQuery,
  compileMetricQuery,
  queryRange,
} from '@openpanel/gigapipe';
import type { IInterval } from '@openpanel/validation';
import type { FinalChart } from '@openpanel/validation';
import { formatClickhouseDate } from '../../clickhouse/client';
import { format } from '../format';
import type { ConcreteSeries } from '../types';
import {
  type PromMatrixResponse,
  adaptMatrixToConcreteSeries,
} from './adapter';

/**
 * The metrics chart engine.
 *
 * Mirrors the event engine's contract exactly — same `FinalChart` out, same
 * previous-period option — so `chart.ts` can dispatch on the report's data
 * source and everything downstream stays unaware there are two engines.
 */

/** Seconds per interval bucket. */
const INTERVAL_SECONDS: Record<IInterval, number> = {
  minute: 60,
  hour: 3600,
  day: 86_400,
  week: 604_800,
  // Nominal: months are uneven, and this value is only used to pick a Prometheus
  // step and a rate window. The bucket grid itself is generated from real dates
  // below, so the unevenness never reaches the chart.
  month: 2_592_000,
};

/**
 * Prometheus refuses a range query that would return more points than its
 * sample ceiling, and a chart cannot render more points than it has pixels.
 * Clamping here turns "backend returned a 500" into "chart drew at a coarser
 * interval, and said so".
 */
const MAX_POINTS = 1500;

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

/**
 * A chart with more lines than this is unreadable, and the browser pays for
 * every one of them. Capping is a rendering decision, not a correctness one —
 * the notice below makes it visible rather than silent.
 */
export const DEFAULT_SERIES_LIMIT = 20;

/**
 * Keep the largest N series, by peak value.
 *
 * Deliberately done in JS rather than with PromQL's `topk`. `topk` is evaluated
 * independently at every step, so a series that is in the top N at one timestamp
 * and not at the next produces a line that appears and disappears — which reads
 * as missing data rather than as ranking. Ranking once over the whole window
 * gives a stable set of lines.
 *
 * Peak rather than mean: a spike is usually the reason someone opened the chart,
 * and averaging hides exactly the series they came to find.
 */
function capSeries(
  series: ConcreteSeries[],
  limit: number,
  notices: string[],
): ConcreteSeries[] {
  if (series.length <= limit) {
    return series;
  }

  const ranked = [...series].sort((a, b) => {
    const peak = (s: ConcreteSeries) =>
      s.data.reduce((max, point) => Math.max(max, point.count), 0);
    return peak(b) - peak(a);
  });

  notices.push(
    `Showing the ${limit} largest series of ${series.length}. Add a filter or group by fewer labels to see the rest.`,
  );

  return ranked.slice(0, limit);
}

export interface MetricChartResult {
  chart: FinalChart;
  /** The PromQL actually sent, for the UI's "show query" affordance. */
  compiled: string;
  /** Things the user should know: a widened window, a coarsened interval. */
  notices: string[];
}

/**
 * Choose the Prometheus step, coarsening it when the range is too long.
 *
 * Coarsening rather than refusing: a user who picks "last 90 days at minute
 * resolution" wants a 90-day chart far more than they want an error, and 90
 * days of minutes is 129,600 points that no screen can show. The coarsening is
 * reported as a notice so the axis never silently disagrees with the control
 * that produced it.
 */
function resolveStep(
  interval: IInterval,
  start: Date,
  end: Date,
  notices: string[],
): number {
  const requested = INTERVAL_SECONDS[interval];
  const spanSeconds = Math.max(1, (end.getTime() - start.getTime()) / 1000);
  const points = spanSeconds / requested;

  if (points <= MAX_POINTS) {
    return requested;
  }

  const coarsened = Math.ceil(spanSeconds / MAX_POINTS);
  notices.push(
    `Interval coarsened to ${coarsened}s — ${Math.round(points)} points exceeds the ${MAX_POINTS}-point limit for this range.`,
  );

  return coarsened;
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

const DURATION_UNITS: Record<string, number> = {
  ms: 0.001,
  s: 1,
  m: 60,
  h: 3600,
  d: 86_400,
  w: 604_800,
  y: 31_536_000,
};

function parseDuration(value: string): number | undefined {
  const match = /^([0-9]+)(ms|s|m|h|d|w|y)$/.exec(value);
  if (!match) {
    return undefined;
  }

  return Number(match[1]) * (DURATION_UNITS[match[2] as string] as number);
}

/**
 * Every bucket the chart expects, so a step Prometheus omitted for lack of data
 * does not shift every later point left.
 */
function bucketGrid(start: Date, end: Date, stepSeconds: number): string[] {
  const out: string[] = [];
  const stepMs = stepSeconds * 1000;

  // Align to the step so the grid matches the timestamps Prometheus returns,
  // which are themselves step-aligned. Without this every bucket is offset by
  // the range's sub-step remainder and nothing lines up.
  let cursor = Math.floor(start.getTime() / stepMs) * stepMs;

  while (cursor <= end.getTime()) {
    out.push(formatClickhouseDate(new Date(cursor)));
    cursor += stepMs;
  }

  return out;
}

async function runOnce(
  input: MetricChartInput,
  start: Date,
  end: Date,
  stepSeconds: number,
  notices: string[],
): Promise<{ series: ConcreteSeries[]; compiled: string }> {
  const compiled = compileMetricQuery(
    { ...input.query, window: resolveWindow(input.query, stepSeconds, notices) },
    input.projectId,
  );

  notices.push(...compiled.notices);

  const response = (await queryRange({
    promql: compiled.promql,
    start,
    end,
    step: `${stepSeconds}s`,
  })) as PromMatrixResponse;

  return {
    compiled: compiled.promql,
    series: adaptMatrixToConcreteSeries(response, {
      groupBy: compiled.groupBy,
      metricName: input.name ?? input.query.metric,
      buckets: bucketGrid(start, end, stepSeconds),
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
