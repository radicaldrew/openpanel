import {
  defaultMetricFn,
  type IMetricKind,
  inferMetricKind,
  inferMetricUnit,
} from '@openpanel/common';
import {
  getTelemetryLabelKeys,
  getTelemetryLabelValues,
  getTelemetryMetricNames,
  getTelemetryServices,
} from '@openpanel/db';
import { isGigapipeEnabled, RESERVED_LABEL_PREFIX } from '@openpanel/gigapipe';
import { z } from 'zod';
import { chatTool } from './helpers';

/**
 * Observability discovery — the metric analogue of `list_event_names` /
 * `list_event_properties`.
 *
 * Metric names are exact, project-specific and invented by whatever
 * instrumentation the customer happens to run. Without a way to enumerate them
 * the model guesses, and a guessed name compiles into a perfectly valid PromQL
 * selector that matches nothing — an empty chart that reads as "you have no
 * traffic" rather than "that metric does not exist". Same for label keys and
 * values, which is why all four tools exist before any charting tool does.
 *
 * TENANCY. Every function called here takes `context.projectId` and nothing
 * else: the project comes from the authenticated context the Fastify guard
 * already validated, never from the model. The services underneath scope every
 * query through the same `op_project_id` fingerprint sub-select
 * (`telemetry-metadata.service.ts`), so there is no listing path that is not
 * project-scoped. Do not add a `projectId` field to any schema in this file,
 * and do not reach for gigapipe's own label/metadata endpoints: their `match[]`
 * is optional-means-unscoped and OR-combined, so appending a tenancy matcher
 * there WIDENS the result instead of narrowing it.
 */

// ─────────────────────────────────────────────────────────────────
// LIMITS
// ─────────────────────────────────────────────────────────────────

/**
 * How many names we pull to answer "does this metric exist" and to search over.
 * Higher than anything we return, because it backs existence checks — a name
 * missing from a short list would be reported as "unknown metric" when it is
 * really just past the cap.
 */
const METRIC_INDEX_LIMIT = 2000;

/** Names returned to the model per call, before `search` narrowing. */
const DEFAULT_METRIC_LIMIT = 200;

/** Label keys per metric. Bounded in practice; the cap is a backstop. */
const LABEL_KEY_LIMIT = 200;

/**
 * Label VALUES per call. The one genuinely unbounded dimension here — a
 * `path`, `pod` or `trace_id` label carries as many values as the service has
 * seen, and dumping them would blow the turn's context for no benefit. Small
 * default, and every truncation is stated in the payload (see `capList`).
 */
const DEFAULT_VALUE_LIMIT = 100;
const MAX_VALUE_LIMIT = 500;

/**
 * Prometheus identifier shape, mirroring `IDENTIFIER_RE` in
 * `packages/gigapipe/src/promql/compile.ts`. Duplicated rather than imported
 * because the compiler does not export it, and checking here turns "the
 * compiler threw" into a message that tells the model what to do instead.
 * Note it rejects `:` — recording-rule names are not reachable through the
 * structured path at all.
 */
const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Plural bucket names for the grouped `list_metrics` payload. */
const KIND_KEYS: Record<IMetricKind, string> = {
  counter: 'counters',
  gauge: 'gauges',
  histogram: 'histograms',
  summary: 'summaries',
};

/** Suffixes stripped to find the histogram sibling of a `_sum` / `_count`. */
const CUMULATIVE_SUFFIXES = ['_total', '_count', '_sum'] as const;

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────

/**
 * Telemetry is optional per deployment. Returned rather than thrown: a thrown
 * error renders as a failed tool call the model cannot act on, whereas this
 * lets it say "this project has no telemetry configured" and move on.
 */
function telemetryUnavailable() {
  if (isGigapipeEnabled()) {
    return null;
  }
  return {
    error:
      'Telemetry is not configured on this deployment — there are no metrics to list or query. Tell the user rather than retrying.',
  };
}

/**
 * Cap a list and SAY SO in the payload.
 *
 * A silently truncated list reads to the model as "these are all the values",
 * which it then states to the user as fact. The `_truncated` flag is the
 * contract the rest of the tool layer uses; `_note` exists because a flag alone
 * has repeatedly proved easier to skip past than a sentence.
 */
function capList(
  values: string[],
  limit: number,
  what: string
): { values: string[]; total: number; _truncated: boolean; _note?: string } {
  if (values.length <= limit) {
    return { values, total: values.length, _truncated: false };
  }
  return {
    values: values.slice(0, limit),
    total: values.length,
    _truncated: true,
    _note: `Showing the first ${limit} of ${values.length} ${what} (alphabetical). This is NOT the complete set — narrow with a search/metric filter or raise the limit before telling the user what exists.`,
  };
}

/** Recoverable "that is not a queryable name" reply, echoing the input. */
function invalidIdentifier(field: string, value: string) {
  return {
    error: `${field} ${JSON.stringify(value)} is not a valid Prometheus identifier (must match ${IDENTIFIER_RE.source}). Names containing ':' are recording rules and cannot be queried through the structured metric path.`,
    [field.toLowerCase().replace(/ /g, '_')]: value,
  };
}

/**
 * The `_bucket` series a percentile would have to run against.
 *
 * `p50`–`p99` are compiled as `histogram_quantile(...)` and the compiler HARD
 * ERRORS on anything not ending in `_bucket`, so pointing at the sibling up
 * front is the difference between one tool call and a failed chart.
 */
function histogramSiblingOf(metric: string): string {
  const base = CUMULATIVE_SUFFIXES.reduce(
    (acc, suffix) =>
      acc.endsWith(suffix) ? acc.slice(0, -suffix.length) : acc,
    metric
  );
  return `${base}_bucket`;
}

/** Cheap "did you mean" over the project's own names — shared name segments. */
function nearestNames(metric: string, names: string[], max = 8): string[] {
  const segments = metric
    .toLowerCase()
    .split('_')
    .filter((s) => s.length > 2);
  if (!segments.length) {
    return [];
  }
  return names
    .map((name) => {
      const lower = name.toLowerCase();
      return { name, score: segments.filter((s) => lower.includes(s)).length };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, max)
    .map((entry) => entry.name);
}

// ─────────────────────────────────────────────────────────────────
// DISCOVERY
// ─────────────────────────────────────────────────────────────────

export const listMetrics = chatTool(
  {
    name: 'list_metrics',
    description: [
      'List the server/infrastructure metric names this project has recorded (http_server_request_duration_seconds_bucket, process_resident_memory_bytes, …). Call this BEFORE naming a metric in any metric chart — metric names are exact, come from whatever instrumentation the customer runs, and a guessed name compiles fine but matches nothing, producing an empty chart that looks like "no traffic" rather than "no such metric".',
      '',
      'Results are grouped by the kind the name implies, because the kind decides the function that makes the chart show anything:',
      '- `counters` (names ending `_total` / `_count` / `_sum`) — use `fn: "rate"` for a per-second rate, or `fn: "increase"` for "how many happened over the window".',
      '- `gauges` (everything else) — use `fn: "raw"`. `rate` on a steady gauge is ALWAYS zero, which draws a flat line indistinguishable from no data.',
      '- `histograms` (names ending `_bucket`) — the only series a `p50`/`p90`/`p95`/`p99` aggregation can run against.',
      '',
      'This is server telemetry (metrics/traces), NOT product analytics events — for event names use list_event_names instead.',
    ].join('\n'),
    schema: z.object({
      search: z
        .string()
        .optional()
        .describe(
          'Case-insensitive substring to narrow the list (e.g. "http", "memory", "queue"). Strongly preferred over paging through everything when you already know what you are looking for.'
        ),
      limit: z
        .number()
        .min(1)
        .max(500)
        .optional()
        .describe(`Max names to return. Defaults to ${DEFAULT_METRIC_LIMIT}.`),
    }),
  },
  async ({ search, limit }, context) => {
    const unavailable = telemetryUnavailable();
    if (unavailable) {
      return unavailable;
    }

    const max = limit ?? DEFAULT_METRIC_LIMIT;
    const all = await getTelemetryMetricNames(context.projectId, {
      limit: METRIC_INDEX_LIMIT,
    });

    // The index itself can be capped, in which case even `total` is a floor.
    // Say that separately from the display cap, or "247 metrics" gets quoted
    // to the user as a complete inventory.
    const indexCapped = all.length >= METRIC_INDEX_LIMIT;
    const needle = search?.trim().toLowerCase();
    const matched = needle
      ? all.filter((name) => name.toLowerCase().includes(needle))
      : all;

    const capped = capList(matched, max, 'metric names');
    const grouped: Record<string, string[]> = {};
    for (const name of capped.values) {
      const key = KIND_KEYS[inferMetricKind(name)];
      const bucket = grouped[key] ?? [];
      bucket.push(name);
      grouped[key] = bucket;
    }

    const notes = [
      capped._note,
      indexCapped
        ? `This project reports more than ${METRIC_INDEX_LIMIT} distinct metric names; the totals here are a floor, not the full inventory.`
        : undefined,
      matched.length === 0 && needle
        ? `No metric name contains ${JSON.stringify(search)}. Call list_metrics again without a search to see what exists.`
        : undefined,
    ].filter(Boolean);

    return {
      ...(needle ? { search } : {}),
      ...grouped,
      total: capped.total,
      _truncated: capped._truncated || indexCapped,
      ...(notes.length ? { _note: notes.join(' ') } : {}),
    };
  }
);

export const describeMetric = chatTool(
  {
    name: 'describe_metric',
    description: [
      'Everything needed to compose a query against one metric: whether it is a counter/gauge/histogram, the `fn` to use, the unit its name implies, whether percentiles are available, and the label keys carried by its series. Call this after list_metrics and BEFORE charting — the labels it returns are the only legal entries for `groupBy` and for matcher names on this metric, and a label that exists elsewhere in the project selects nothing here.',
      '',
      'Percentiles: `p50`–`p99` are compiled as histogram_quantile and are a HARD ERROR on anything but a `_bucket` series. When this metric is not a bucket, the reply names the `_bucket` sibling to use instead (if the project records one).',
      '',
      'Do not use `op_project_id`, or any `op_`-prefixed label, in a matcher or groupBy — those are reserved for tenancy and the compiler refuses them. Do not pass a `window` either: the chart engine sizes it against the interval, and a hand-picked narrow window draws a sawtooth that reads as real instability.',
    ].join('\n'),
    schema: z.object({
      metric: z
        .string()
        .describe('Exact metric name from list_metrics. No wildcards.'),
    }),
  },
  async ({ metric }, context) => {
    const unavailable = telemetryUnavailable();
    if (unavailable) {
      return unavailable;
    }

    if (!IDENTIFIER_RE.test(metric)) {
      return invalidIdentifier('Metric', metric);
    }

    const [labelKeys, allNames] = await Promise.all([
      getTelemetryLabelKeys(context.projectId, {
        metric,
        limit: LABEL_KEY_LIMIT + 1,
      }),
      getTelemetryMetricNames(context.projectId, { limit: METRIC_INDEX_LIMIT }),
    ]);

    const indexCapped = allNames.length >= METRIC_INDEX_LIMIT;
    const known = allNames.includes(metric);

    // Only claim "unknown" when the index is complete. Past the cap a real
    // metric is simply absent from the list, and a false "no such metric"
    // sends the model off to invent a different name.
    if (!(known || indexCapped)) {
      return {
        error: `No metric named ${JSON.stringify(metric)} in this project. Metric names are exact — pick one from list_metrics.`,
        metric,
        did_you_mean: nearestNames(metric, allNames),
      };
    }

    const kind = inferMetricKind(metric);
    const unit = inferMetricUnit(metric);
    const labels = capList(labelKeys, LABEL_KEY_LIMIT, 'label keys');
    const sibling = histogramSiblingOf(metric);

    return {
      metric,
      kind,
      suggested_fn: defaultMetricFn(metric),
      ...(unit ? { unit } : {}),
      fn_note:
        kind === 'counter'
          ? 'Counter: `rate` for per-second, `increase` for a total over the window. `raw` only ever climbs and is not useful.'
          : kind === 'histogram'
            ? 'Histogram buckets: use a p50–p99 aggregation, which rates the buckets internally and ignores `fn`. With sum/avg use `fn: "rate"`.'
            : 'Gauge: use `fn: "raw"` for the level, or `fn: "delta"` for the change across the window. `rate` on a gauge is always zero.',
      percentiles:
        kind === 'histogram'
          ? { available: true }
          : allNames.includes(sibling)
            ? { available: false, use_metric_instead: sibling }
            : {
                available: false,
                reason:
                  'This project records no _bucket series for this metric, so no percentile is computable. Use avg/max instead and say so.',
              },
      // Legal groupBy entries and matcher names, for this metric only.
      labels: labels.values,
      label_count: labels.total,
      _truncated: labels._truncated,
      ...(labels._note ? { _note: labels._note } : {}),
      ...(labels.values.length === 0
        ? {
            labels_note:
              'This metric carries no labels beyond the internal ones, so it cannot be broken down — leave groupBy empty.',
          }
        : {}),
    };
  }
);

export const getMetricLabelValues = chatTool(
  {
    name: 'get_metric_label_values',
    description: [
      'List the values one label takes on one metric — what you need before writing a matcher like `{ name: "http_route", operator: "eq", value: "/checkout" }`. Call describe_metric first to learn which labels exist; call this only for the label you are about to filter on.',
      '',
      'Label values are the highest-cardinality thing in telemetry (a `path` or `pod` label can carry thousands), so results are capped and every truncation is flagged in the reply. When `_truncated` is true the list is a sample, not an inventory — never tell the user "the values are X, Y, Z" from a truncated reply.',
    ].join('\n'),
    schema: z.object({
      metric: z
        .string()
        .describe(
          'Exact metric name from list_metrics. Required — values are scoped to the metric you will actually query, since the same label carries different values on different metrics.'
        ),
      label: z.string().describe('Label key from describe_metric.'),
      limit: z
        .number()
        .min(1)
        .max(MAX_VALUE_LIMIT)
        .optional()
        .describe(
          `Max values to return. Defaults to ${DEFAULT_VALUE_LIMIT}; raise it only when the user genuinely needs the long tail.`
        ),
    }),
  },
  async ({ metric, label, limit }, context) => {
    const unavailable = telemetryUnavailable();
    if (unavailable) {
      return unavailable;
    }

    if (!IDENTIFIER_RE.test(metric)) {
      return invalidIdentifier('Metric', metric);
    }
    if (!IDENTIFIER_RE.test(label)) {
      return invalidIdentifier('Label', label);
    }

    // The `op_` namespace is ours. The compiler refuses these outright and the
    // values service answers `[]` for the tenancy label — which would read as
    // "this label has no values" rather than "you may not filter on it". Say
    // the real reason instead, and do not strip-and-retry.
    if (label.toLowerCase().startsWith(RESERVED_LABEL_PREFIX)) {
      return {
        error: `${JSON.stringify(label)} is a reserved internal label. It cannot be filtered on or grouped by, and queries are already scoped to this project automatically. Pick a label from describe_metric.`,
        metric,
        label,
      };
    }

    const max = Math.min(limit ?? DEFAULT_VALUE_LIMIT, MAX_VALUE_LIMIT);

    // Over-fetch by one so "there are more" is observed rather than assumed:
    // asking for exactly `max` and receiving `max` is ambiguous.
    const values = await getTelemetryLabelValues(context.projectId, label, {
      metric,
      limit: max + 1,
    });
    const capped = capList(values, max, `values of "${label}"`);

    return {
      metric,
      label,
      values: capped.values,
      // `total` is a floor when truncated: we only ever fetched max + 1.
      total: capped._truncated ? `${max}+` : capped.total,
      _truncated: capped._truncated,
      ...(capped._note ? { _note: capped._note } : {}),
      ...(capped.values.length === 0
        ? {
            _note: `No values for ${JSON.stringify(label)} on ${JSON.stringify(metric)} — the label probably does not exist on this metric. Call describe_metric to see the labels it actually carries.`,
          }
        : {}),
    };
  }
);

export const listTelemetryServices = chatTool(
  {
    name: 'list_telemetry_services',
    description:
      'List the services reporting telemetry to this project (from the `job` label each instrumented process sets). Use it to orient before list_metrics when the user names a service ("is the worker healthy?"), and to filter a metric down with a `{ name: "job", operator: "eq", value: "<service>" }` matcher.',
    schema: z.object({}),
  },
  async (_input, context) => {
    const unavailable = telemetryUnavailable();
    if (unavailable) {
      return unavailable;
    }

    const services = await getTelemetryServices(context.projectId);
    return {
      services,
      total: services.length,
      ...(services.length === 0
        ? {
            _note:
              'No services are reporting telemetry yet. This project may be sending metrics without a `job` label, or none at all — check list_metrics before concluding it is empty.',
          }
        : {}),
    };
  }
);
