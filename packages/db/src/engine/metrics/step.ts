import type { IInterval } from '@openpanel/validation';
import { formatClickhouseDate } from '../../clickhouse/client';
import type { ConcreteSeries } from '../types';
import type { PromMatrixResponse } from './adapter';

/**
 * Step, window and bucket-grid arithmetic shared by both metrics engines.
 *
 * Extracted rather than duplicated. Every constant here is a MEASURED bound on
 * the deployed gigapipe — the 300s direct-step ceiling and the 1500-point clamp
 * were each found by a chart coming back empty — so a second copy would be a
 * second thing to re-measure, and the copy that was not updated would draw a
 * blank chart with no error.
 */

/** Seconds per interval bucket. */
export const INTERVAL_SECONDS: Record<IInterval, number> = {
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
export const MAX_POINTS = 1500;

/**
 * The widest Prometheus step gigapipe answers directly.
 *
 * gigapipe fills gaps with `ORDER BY ... WITH FILL ... STALENESS 300000`, and a
 * step wider than about twice that staleness returns an EMPTY result rather
 * than a sparse one. Measured against a live instance: a 601s step returns
 * data, 650s returns nothing, and the bare selector and every aggregation over
 * it fail together — so this is the step, not the query shape.
 *
 * That made every chart on the metrics page come back empty while the metric
 * names listed fine, because the page asks for an hourly interval and an hour
 * is six times this bound.
 *
 * Above the bound the expression is evaluated as a SUBQUERY: the inner
 * selector runs at a step gigapipe does answer, and each output point
 * aggregates one bucket of those inner samples. Verified to return data at a
 * 3600s step where the same expression unwrapped returns none. Downsampling a
 * dense inner evaluation is also what Grafana does at wide intervals.
 */
export const MAX_DIRECT_STEP_SECONDS = 300;

/**
 * Wrap an expression in a subquery when the step is too wide to evaluate
 * directly. Below the bound the query is sent unchanged.
 */
export function downsampleForStep(promql: string, stepSeconds: number): string {
  if (stepSeconds <= MAX_DIRECT_STEP_SECONDS) {
    return promql;
  }

  // avg over the bucket: for a gauge it is the bucket's level, and for a rate
  // it is the mean rate across the bucket. Both are what a chart at this
  // interval is asking for.
  return `avg_over_time((${promql})[${stepSeconds}s:${MAX_DIRECT_STEP_SECONDS}s])`;
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
export function capSeries(
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

/**
 * Choose the Prometheus step, coarsening it when the range is too long.
 *
 * Coarsening rather than refusing: a user who picks "last 90 days at minute
 * resolution" wants a 90-day chart far more than they want an error, and 90
 * days of minutes is 129,600 points that no screen can show. The coarsening is
 * reported as a notice so the axis never silently disagrees with the control
 * that produced it.
 */
export function resolveStep(
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

const DURATION_UNITS: Record<string, number> = {
  ms: 0.001,
  s: 1,
  m: 60,
  h: 3600,
  d: 86_400,
  w: 604_800,
  y: 31_536_000,
};

export function parseDuration(value: string): number | undefined {
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
export function bucketGrid(
  start: Date,
  end: Date,
  stepSeconds: number,
): { labels: string[]; times: number[] } {
  const out: string[] = [];
  const times: number[] = [];
  const stepMs = stepSeconds * 1000;

  // Align to `start`, NOT to the step.
  //
  // The backend returns points at start + k*step, so a grid floored to the step
  // sits at a constant offset from them. Every sample then rounds to a bucket
  // one place further on than its own, and the LAST sample rounds past the end
  // of the grid and is dropped — leaving the final bucket at zero and drawing a
  // cliff at the right-hand edge of every chart. Measured: a 24h range starting
  // at 08:56 produced 14 points ending at 08:56, and the chart showed the last
  // hour as zero.
  let cursor = start.getTime();

  while (cursor <= end.getTime()) {
    out.push(formatClickhouseDate(new Date(cursor)));
    times.push(cursor);
    cursor += stepMs;
  }

  return { labels: out, times };
}

/**
 * Narrow a bucket grid to the span the backend actually covered.
 *
 * A bucket with no sample renders as ZERO, not as a gap: a chart data point is
 * a plain number and has no way to say "not observed". Drawing zero where
 * nothing was measured invents a fact — for a gauge that sat at 1 all day it
 * produces a cliff to zero on both sides of the data, which reads as an outage
 * rather than as the edge of what we know.
 *
 * Trimming is the honest option available without teaching every renderer to
 * handle nulls: outside the observed span the chart simply says nothing. Inside
 * it a genuine gap still reads as zero, which is a much smaller lie and a much
 * rarer one — the scrape interval is far shorter than any bucket.
 */
export function trimToObserved(
  response: PromMatrixResponse,
  grid: { labels: string[]; times: number[] },
  stepSeconds: number,
): { labels: string[]; times: number[] } {
  const stamps: number[] = [];

  for (const series of response.data?.result ?? []) {
    for (const [unixSeconds] of series.values ?? []) {
      stamps.push(unixSeconds * 1000);
    }
  }

  if (stamps.length === 0 || grid.times.length === 0) {
    return grid;
  }

  const tolerance = (stepSeconds * 1000) / 2;
  const earliest = Math.min(...stamps) - tolerance;
  const latest = Math.max(...stamps) + tolerance;

  const from = grid.times.findIndex((t) => t >= earliest);
  if (from === -1) {
    return grid;
  }

  let to = grid.times.length - 1;
  while (to > from && (grid.times[to] as number) > latest) {
    to -= 1;
  }

  return {
    labels: grid.labels.slice(from, to + 1),
    times: grid.times.slice(from, to + 1),
  };
}
