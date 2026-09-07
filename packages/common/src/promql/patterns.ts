import type { IPromqlBuilderState } from '@openpanel/validation';

/**
 * Ready-made query shapes, offered as a dropdown beside the query rows.
 *
 * Every one of these is a thing people re-derive from memory and get subtly
 * wrong — a rate window narrower than the step, a quantile taken over summed
 * buckets instead of summed rates, a `topk` that flickers because it is
 * re-ranked at every step. Shipping them as data means the correct shape is one
 * click away and the incorrect one has to be typed on purpose.
 *
 * `state.metric` is deliberately EMPTY. A pattern describes the pipeline, not
 * the series: the editor merges the user's chosen metric into it, so "p95" is
 * the same three operations whichever histogram it is applied to.
 */

export interface QueryPattern {
  id: string;
  label: string;
  description: string;
  state: IPromqlBuilderState;
}

/**
 * The label used for grouping in the patterns that group.
 *
 * `service_name` is what the OTLP collector writes for every resource, so it is
 * the one label present on essentially every series in a project.
 */
const SERVICE_LABEL = 'service_name';

export const QUERY_PATTERNS: QueryPattern[] = [
  {
    id: 'request-rate',
    label: 'Request rate',
    description: 'Per-second rate of a counter, summed across every series.',
    state: {
      metric: '',
      labelMatchers: [],
      operations: [
        { op: 'rate', range: '$__rate_interval' },
        { op: 'sum' },
      ],
    },
  },
  {
    id: 'request-rate-by-service',
    label: 'Request rate by service',
    description: 'Per-second rate of a counter, one line per service.',
    state: {
      metric: '',
      labelMatchers: [],
      operations: [
        { op: 'rate', range: '$__rate_interval' },
        { op: 'sum', by: [SERVICE_LABEL] },
      ],
    },
  },
  {
    id: 'error-rate',
    label: 'Error rate',
    description:
      'Per-second rate of the 5xx slice of a counter. Adjust the status matcher if the label differs.',
    state: {
      metric: '',
      labelMatchers: [{ label: 'status', op: '=~', value: '5..' }],
      operations: [
        { op: 'rate', range: '$__rate_interval' },
        { op: 'sum' },
      ],
    },
  },
  {
    id: 'p50',
    label: 'p50 latency',
    description:
      'Median, over the rate of a histogram bucket series. Pick a metric ending in _bucket.',
    state: {
      metric: '',
      labelMatchers: [],
      operations: [
        { op: 'rate', range: '$__rate_interval' },
        { op: 'sum', by: ['le'] },
        { op: 'histogram_quantile', q: 0.5 },
      ],
    },
  },
  {
    id: 'p95',
    label: 'p95 latency',
    description:
      '95th percentile, over the rate of a histogram bucket series. Pick a metric ending in _bucket.',
    state: {
      metric: '',
      labelMatchers: [],
      operations: [
        { op: 'rate', range: '$__rate_interval' },
        { op: 'sum', by: ['le'] },
        { op: 'histogram_quantile', q: 0.95 },
      ],
    },
  },
  {
    id: 'p99',
    label: 'p99 latency',
    description:
      '99th percentile, over the rate of a histogram bucket series. Pick a metric ending in _bucket.',
    state: {
      metric: '',
      labelMatchers: [],
      operations: [
        { op: 'rate', range: '$__rate_interval' },
        { op: 'sum', by: ['le'] },
        { op: 'histogram_quantile', q: 0.99 },
      ],
    },
  },
  {
    id: 'saturation',
    label: 'Saturation',
    description:
      'Peak value of a gauge per service — queue depth, in-flight requests, connections held.',
    state: {
      metric: '',
      labelMatchers: [],
      operations: [{ op: 'max', by: [SERVICE_LABEL] }],
    },
  },
  {
    id: 'top-k',
    label: 'Top 5 series',
    description:
      'The five busiest series by rate. Ranked per step, so a line can appear and disappear.',
    state: {
      metric: '',
      labelMatchers: [],
      operations: [
        { op: 'rate', range: '$__rate_interval' },
        { op: 'sum', by: [SERVICE_LABEL] },
        { op: 'topk', k: 5 },
      ],
    },
  },
  {
    id: 'increase',
    label: 'Increase per interval',
    description:
      'How much a counter grew in each bucket — the absolute count rather than a per-second rate.',
    state: {
      metric: '',
      labelMatchers: [],
      operations: [
        { op: 'increase', range: '$__interval' },
        { op: 'sum' },
      ],
    },
  },
];

/** Look one up by id, for a URL or a saved panel that names a pattern. */
export function findQueryPattern(id: string): QueryPattern | undefined {
  return QUERY_PATTERNS.find((pattern) => pattern.id === id);
}

/**
 * Apply a pattern to a metric.
 *
 * Returns a fresh state rather than mutating the pattern, which is a module-level
 * constant shared by every caller in the process.
 */
export function applyQueryPattern(
  pattern: QueryPattern,
  metric: string,
): IPromqlBuilderState {
  return {
    metric,
    labelMatchers: pattern.state.labelMatchers.map((matcher) => ({ ...matcher })),
    operations: pattern.state.operations.map((op) => ({ ...op })),
  };
}
