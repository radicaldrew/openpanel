/**
 * What kind of thing a Prometheus metric measures, inferred from its name.
 *
 * WHY INFERRED RATHER THAN READ
 *
 * The kind decides which functions are meaningful. `rate` over a counter is the
 * whole point of a counter; `rate` over a gauge is ALWAYS ZERO when the gauge is
 * steady, because a gauge's value is not cumulative and its per-second change is
 * nothing. Defaulting every metric to `rate` therefore draws a flat zero line
 * over most of an instance's metrics and reads as "there is no data".
 *
 * The exporter knows the real answer — gitgraph publishes `# TYPE queue_depth
 * gauge` — but nothing downstream keeps it. The OpenTelemetry Collector parses
 * the TYPE line and the Prometheus remote-write exporter does not forward it,
 * and gigapipe's `/api/v1/metadata` answers `{}`. So until the type is captured
 * at ingest, the name is the only signal available.
 *
 * That is not a hack: the suffixes below are Prometheus's own naming convention,
 * which exporters follow precisely so that a reader can tell a counter from a
 * gauge. It is a convention rather than a guarantee, so this is used to pick a
 * DEFAULT and to order a menu — never to reject what someone explicitly asks
 * for.
 */

export type IMetricKind = 'counter' | 'gauge' | 'histogram' | 'summary';

/**
 * Suffixes that mark a cumulative series, longest first so `_bucket` is tested
 * before the bare name and `_seconds_total` resolves as a counter.
 */
const COUNTER_SUFFIXES = ['_total', '_count', '_sum'] as const;

export function inferMetricKind(name: string): IMetricKind {
  const lower = name.toLowerCase();

  // A `_bucket` series is one cumulative histogram bucket. It is a counter
  // underneath, but naming it so would hide that the useful thing to do with it
  // is a quantile, not a rate.
  if (lower.endsWith('_bucket')) {
    return 'histogram';
  }

  if (COUNTER_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
    return 'counter';
  }

  return 'gauge';
}

/**
 * The function to select when a metric is first picked.
 *
 * A counter is meaningless unrated — it only ever climbs — and a gauge is
 * meaningless rated. Getting this right is the difference between a chart that
 * answers the question on the first click and one that has to be corrected
 * before it shows anything at all.
 */
export function defaultMetricFn(name: string): 'rate' | 'raw' {
  return inferMetricKind(name) === 'counter' ? 'rate' : 'raw';
}

/**
 * Whether a rate-style function can say anything about this metric.
 *
 * Used to hide `rate`, `increase` and `delta` for a gauge rather than to block
 * them: an option that can only ever draw zero is worse than no option, and
 * removing it is the difference between a control that teaches the model and one
 * that traps the user.
 */
export function supportsRateFunctions(name: string): boolean {
  return inferMetricKind(name) !== 'gauge';
}

/**
 * A Y-axis unit for metrics whose name states one.
 *
 * Only the unambiguous suffixes, and only where the renderer can do something
 * with the answer. `_ratio` and `_percent` map to `%` because the formatter
 * scales those by 100; the rest are appended as written.
 */
export function inferMetricUnit(name: string): string | undefined {
  const lower = name.toLowerCase();

  // Strip a cumulative suffix first, so `request_duration_seconds_sum` is still
  // recognised as seconds.
  const base = COUNTER_SUFFIXES.reduce(
    (acc, suffix) => (acc.endsWith(suffix) ? acc.slice(0, -suffix.length) : acc),
    lower,
  );

  if (base.endsWith('_seconds')) {
    return 's';
  }
  if (base.endsWith('_milliseconds') || base.endsWith('_ms')) {
    return 'ms';
  }
  if (base.endsWith('_bytes')) {
    return 'bytes';
  }
  if (base.endsWith('_ratio') || base.endsWith('_percent')) {
    return '%';
  }

  return undefined;
}
