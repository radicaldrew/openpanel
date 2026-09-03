import {
  chartSegments,
  chartTypes,
  intervals,
  lineTypes,
  metrics,
  operators,
} from '@openpanel/constants';
import {
  isMetricChartType,
  METRIC_CHART_TYPES,
  objectToZodEnums,
  stampSeriesDiscriminator,
  zMetricQuery,
  zReportDataSource,
  zReportInput,
} from '@openpanel/validation';
import { z } from 'zod';
import {
  ChartEngine,
  findProfilesCore,
  getAnalyticsOverviewCore,
  getEventPropertyValuesCore,
  getFunnelCore,
  getRetentionCohortCore,
  getRollingActiveUsersCore,
  getTopPagesCore,
  getTrafficBreakdownCore,
  getUserFlowCore,
  listDashboardsCore,
  listEventNamesCore,
  listEventPropertiesCore,
  listReportsCore,
  queryEventsCore,
  querySessionsCore,
} from '@openpanel/db';
import { isGigapipeEnabled } from '@openpanel/gigapipe';
import { runReport, runReportFromConfig } from '@openpanel/mcp';
import {
  chatTool,
  compactEventProperties,
  dashboardUrl,
  pageContextFilters,
  resolveDateRange,
  truncateRows,
} from './helpers';

// ─────────────────────────────────────────────────────────────────
// DISCOVERY
// ─────────────────────────────────────────────────────────────────

export const listEventNames = chatTool(
  {
    name: 'list_event_names',
    description:
      'Get the top 50 event names tracked in this project. Call this BEFORE referencing event names in generate_report or other tools — never guess at event names.',
    schema: z.object({}),
  },
  async (_input, context) => {
    const names = await listEventNamesCore(context.projectId);
    return { event_names: names };
  },
);

export const listEventProperties = chatTool(
  {
    name: 'list_event_properties',
    description:
      'List fields available for filtering or breaking down events. Returns TWO buckets:\n\n- `columns`: top-level event columns (path, referrer, country, device, browser, os, etc.). Apply to every event. Use the bare name in filters/breakdowns (e.g. `{ name: "path", operator: "endsWith", value: ["/cohorts"] }`).\n- `properties`: custom keys from the event\'s JSON `properties` map. Use prefixed as `properties.<key>` in filters/breakdowns (e.g. `properties.plan`).\n\nCall this before using any field as a filter or breakdown in generate_report. NOTE: dotted sub-keys inside `properties` are rolled up to their root — e.g. all `__query.foo`, `__query.bar`, … are represented by a single `__query` entry, ordered by how many sub-keys roll up under them (most prominent first). To filter on a specific sub-key like `properties.__query.utm_source`, use that exact full key — the rollup is purely a discovery optimization.',
    schema: z.object({
      eventName: z
        .string()
        .optional()
        .describe('Optional — filter to one event. Omit to list properties across all events.'),
    }),
  },
  async ({ eventName }, context) => {
    const raw = await listEventPropertiesCore({
      projectId: context.projectId,
      eventName,
    });
    return compactEventProperties(raw, { eventName });
  },
);

export const getEventPropertyValues = chatTool(
  {
    name: 'get_event_property_values',
    description:
      'List distinct values for a specific event property. Useful when the user wants to filter on something concrete like "country = SE".',
    schema: z.object({
      eventName: z.string().describe('The event name (e.g. screen_view)'),
      propertyKey: z.string().describe('The property key (e.g. path, country)'),
    }),
  },
  async ({ eventName, propertyKey }, context) =>
    getEventPropertyValuesCore({
      projectId: context.projectId,
      eventName,
      propertyKey,
    }),
);

// ─────────────────────────────────────────────────────────────────
// SAVED DASHBOARDS & REPORTS (PREFER THESE OVER generate_report)
// ─────────────────────────────────────────────────────────────────

export const listDashboards = chatTool(
  {
    name: 'list_dashboards',
    description:
      'List all dashboards in this project. Each dashboard groups a set of reports the user has built. Use this to discover what already exists before building anything new.',
    schema: z.object({}),
  },
  async (_input, context) => {
    const dashboards = await listDashboardsCore({
      projectId: context.projectId,
      organizationId: context.organizationId,
    });
    return dashboards.map((d) => ({
      ...d,
      dashboard_url: dashboardUrl(context.organizationId, context.projectId, `/dashboards/${d.id}`),
    }));
  },
);

export const listReports = chatTool(
  {
    name: 'list_reports',
    description:
      'List the reports inside a dashboard. Returns chart type, range, interval, and event series for each. Use this with get_report_data to fetch real numbers.',
    schema: z.object({
      dashboardId: z.string().describe('The dashboard ID (from list_dashboards)'),
    }),
  },
  async ({ dashboardId }, context) =>
    listReportsCore({
      projectId: context.projectId,
      dashboardId,
      organizationId: context.organizationId,
    }),
);

export const getReportData = chatTool(
  {
    name: 'get_report_data',
    description:
      'Execute a saved report by ID and return its data. Works for every chart type (linear, bar, area, pie, metric, funnel, retention, etc.). PREFER this over generate_report when the user asks about something a saved report likely already covers.',
    schema: z.object({
      reportId: z.string().describe('The report ID (from list_reports)'),
    }),
  },
  async ({ reportId }, context) =>
    runReport({
      organizationId: context.organizationId,
      projectId: context.projectId,
      reportId,
    }),
);

/**
 * The model-facing metric query.
 *
 * Extended from the canonical `zMetricQuery` rather than hand-rolled. That shape
 * already exists in three places in this repo (validation, the observability
 * router, the PromQL compiler's own interface) and a fourth copy would drift
 * silently; `.extend` re-describes fields without redeclaring their
 * constraints, so a rename upstream becomes a compile error here instead of a
 * tool definition that quietly stops matching what the engine accepts.
 *
 * Everything added here is prose, and for metrics the prose is load-bearing:
 * a model that picks the wrong `fn` gets a flat zero line, not an error.
 */
const metricQuerySchema = zMetricQuery.extend({
  metric: zMetricQuery.shape.metric.describe(
    'Prometheus metric name exactly as the service exports it — e.g. `http_requests_total`, `process_resident_memory_bytes`, `queue_depth`. Letters, digits and underscores only (a `:` is rejected). Verify it with list_metrics first: an unknown name returns an empty chart rather than an error, so a guessed name fails silently.',
  ),
  matchers: zMetricQuery.shape.matchers.describe(
    'Label filters, ANDed together. `operator` is `eq`/`neq` for an exact value, `match`/`notMatch` for an RE2 regex — e.g. `{ name: "status", operator: "match", value: "5.." }` to keep only 5xx. Max 20.',
  ),
  // `.removeDefault()` makes `fn` required for the model. Upstream it defaults
  // to `rate` because the UI picks a kind-aware default before the user ever
  // sees the control; here there is nothing between the model and the query,
  // and `rate` on a steady gauge is ALWAYS zero — a flat line indistinguishable
  // from "no data". Forcing the model to state it is the difference between a
  // chart that answers the question and one that silently answers nothing.
  fn: zMetricQuery.shape.fn
    .removeDefault()
    .describe(
      'How the stored series becomes a charted value. It depends on what the metric measures. Counter (name ends `_total`/`_count`/`_sum`, value only ever climbs): `rate` for "how fast" (per second) or `increase` for "how many across the window". Gauge (everything else — `up`, `queue_depth`, `go_goroutines`, `*_bytes`): `raw` for the level, `delta` only when the question is how much it MOVED. `rate` on a gauge draws a flat zero line that looks exactly like an empty chart.',
    ),
  aggregation: zMetricQuery.shape.aggregation.describe(
    'How the per-instance series combine into lines. `sum` for a counter split across pods/instances, `avg`/`max`/`min` for a gauge you want the typical or worst value of, `count` counts SERIES (not events) and is almost never what is meant. `p50`/`p90`/`p95`/`p99` compute a histogram quantile and REQUIRE a metric ending in `_bucket` — they hard-error on anything else.',
  ),
  groupBy: zMetricQuery.shape.groupBy.describe(
    'Label names to split into one line each — the metric equivalent of `breakdowns`, max 5. Only labels this metric actually carries (`service`, `job`, `instance`, `status`, `pod`, …); an unknown label just collapses everything into a single line. Omit for one aggregated line.',
  ),
  window: zMetricQuery.shape.window.describe(
    'Prometheus duration backing `rate`/`increase`/`delta`, e.g. `5m`. OMIT IT unless the user asked for a specific window: the engine sizes it against the chart interval, and a window narrower than the step samples the gaps and draws a sawtooth that reads as real instability.',
  ),
});


export const generateReport = chatTool(
  {
    name: 'generate_report',
    description: [
      'Generate an ad-hoc chart from a report config. Use only when no saved report fits. ALWAYS supply a concise `title` (3-8 words) describing what the chart shows.',
      '',
      'TWO DATA SOURCES, picked with `dataSource`:',
      '- `events` (the default — omit the field) — OpenPanel product analytics, described by `series`. Always call list_event_names first to verify event names exist; call list_event_properties if you need a breakdown property.',
      '- `metrics` — server telemetry (Prometheus-style) from the observability stack: request rates, latency, memory, queue depth, error counts. Described by `metricQuery` alone; `series` and `breakdowns` do not apply. Call list_metrics first to see what this project actually exports, and describe_metric for a metric\'s labels — never guess a metric name. `dataSource` and `metricQuery` always travel together; one without the other is rejected.',
      '',
      'EVENT REPORTS',
      'Series are ordered A, B, C, … (based on array index). Use the letter id from a `formula` series like "A / B * 100" for ratios or conversions.',
      '',
      'Examples:',
      '- **Unique users per day**: one event series with `segment: "user"` + `chartType: "linear"`.',
      '- **Revenue per day**: one event series with `segment: "property_sum"` + `property: "revenue"`.',
      '- **Conversion rate over time**: two event series (A = completed, B = started) + a `formula` series `"A / B * 100"` with all three visible, or set `hideSeries: ["A","B"]` to show only the rate.',
      '- **Period-over-period**: set `previous: true` to overlay the prior period of equal length.',
      '',
      'METRIC REPORTS',
      "A metric's name tells you how to read it, and picking `fn` wrong is the one mistake that yields a chart instead of an error:",
      '- Counter — name ends `_total`, `_count` or `_sum`. The stored value only ever climbs, so chart its change: `fn: "rate"` for "how fast" (per second), `fn: "increase"` for "how many during the window". `fn: "raw"` on a counter plots an ever-rising line that says more about process uptime than about traffic.',
      '- Gauge — everything else (`up`, `queue_depth`, `go_goroutines`, `process_resident_memory_bytes`). The stored value already IS the level, so `fn: "raw"`; use `fn: "delta"` only when the question is how much it moved. `rate` on a steady gauge is always zero and draws a flat line indistinguishable from "no data".',
      '- Histogram — name ends `_bucket`. Ask for a percentile through `aggregation` (`p50`/`p90`/`p95`/`p99`) with `fn: "rate"`. Percentiles REQUIRE the `_bucket` series and hard-error on anything else, so chart `http_request_duration_seconds_bucket`, never `http_request_duration_seconds`.',
      '',
      '`aggregation` combines the per-instance series: `sum` for a counter split across pods, `avg`/`max`/`min` for a gauge, `count` counts series rather than events, percentiles for `_bucket` metrics only. `groupBy` splits into one line per label value (the breakdown equivalent, max 5). `matchers` filter by label. Omit `window` — the engine sizes it against the interval.',
      '',
      'Examples:',
      '- **Request rate per service**: `dataSource: "metrics"`, `metricQuery: { metric: "http_requests_total", fn: "rate", aggregation: "sum", groupBy: ["service"] }`, `chartType: "linear"`.',
      '- **p95 latency**: `metricQuery: { metric: "http_request_duration_seconds_bucket", fn: "rate", aggregation: "p95" }`, `chartType: "linear"`, `unit: "s"`.',
      '- **Memory per pod**: `metricQuery: { metric: "process_resident_memory_bytes", fn: "raw", aggregation: "max", groupBy: ["pod"] }` — a gauge, so `raw`.',
      '- **5xx responses in the window**: `metricQuery: { metric: "http_requests_total", fn: "increase", aggregation: "sum", matchers: [{ name: "status", operator: "match", value: "5.." }] }`, `chartType: "metric"`.',
    ].join('\n'),
    schema: z.object({
      dataSource: zReportDataSource
        .optional()
        .describe(
          'Where the numbers come from. Omit it (or send `events`) for OpenPanel product analytics described by `series`. Send `metrics` to chart server telemetry, described by `metricQuery` instead — see the METRIC REPORTS section above for how to pick `fn`.',
        ),
      metricQuery: metricQuerySchema
        .optional()
        .describe(
          'The telemetry query to chart. REQUIRED when `dataSource` is "metrics", and rejected when it is not — a query on an events report is never looked at, so it is treated as a mistake rather than ignored.',
        ),
      chartType: z
        .enum(objectToZodEnums(chartTypes))
        .describe(
          'Chart type. See the decision table in the system prompt — pick `linear`/`area` for trends, `bar`/`pie`/`map` for breakdowns, `metric` for a single number, `funnel`/`conversion`/`sankey` for flows, `retention` for cohorts, `histogram` for numeric distributions. A `metrics` report can only use `linear`, `area`, `histogram` or `metric`; the rest never reach the metrics engine and render an empty panel.',
        ),
      // Derived from `intervals`, not re-listed, for the same reason
      // `chartType` above derives from `chartTypes`: this is a model-facing
      // copy of a value set the engine owns. A hand-written copy that falls
      // behind offers the model an interval the `zReportInput` parse below
      // rejects — or, when a value is added upstream, hides one that works.
      interval: z.enum(objectToZodEnums(intervals)).default('day'),
      startDate: z.string().describe('ISO date YYYY-MM-DD'),
      endDate: z.string().describe('ISO date YYYY-MM-DD'),
      series: z
        .array(
          // THE DISCRIMINATOR REPAIR HAS TO LIVE HERE TOO, NOT ONLY ON
          // `zChartEventItem` IN @openpanel/validation.
          //
          // better-agent validates the model's raw arguments against THIS
          // schema (run/execute-tool-calls.mjs -> validateInput ->
          // `~standard.validate`) and passes the parsed value to the handler,
          // so the canonical `zReportInput` parse further down only ever sees
          // input that already got past this point. An LLM routinely omits
          // `type` on an event series — the field carries no information from
          // where the model sits, since only a formula has to announce itself
          // — and without this the whole call came back as `invalid_union` at
          // `series.0`, carrying BOTH branches' errors, before the handler
          // could return anything the agent loop could act on.
          //
          // Deliberately NOT `zChartEventItem` itself, even though the repair
          // is identical: every description below is prompt text written for
          // this tool (verify names with list_event_names, the segment menu,
          // the `properties.<key>` filter convention), and the canonical shape
          // also exposes an `id` that the handler overwrites with a letter id.
          // Only the PROSE is allowed to differ — each value set below is
          // pinned to the same constant the canonical schema derives from.
          //
          // `z.literal('event').default('event')` is not an alternative: zod 4
          // reads a discriminated union's discriminator off the raw input,
          // before any field-level default runs (verified on 4.3.6). The union
          // stays discriminated rather than becoming a plain `z.union` so a
          // genuinely malformed event still comes back as the one field-level
          // issue the model can act on.
          //
          // The one cost, measured against the schema better-agent actually
          // emits: wrapping the element in a pipe makes zod drop the enclosing
          // array's `"default": []` from the generated JSON Schema (the branch
          // `oneOf` and its `const` discriminators are unchanged, and `series`
          // stays out of `required`). That default was advisory only — the
          // handler reads `input.series ?? []` and the description already
          // says to omit the field for a metrics report.
          // The same helper `zChartEventItem` uses, not a second copy of it.
          // A copy would drift silently: both schemas keep parsing, the model
          // just starts getting "No matching discriminator" back on one path
          // and not the other.
          z.preprocess(
            stampSeriesDiscriminator,
            z.discriminatedUnion('type', [
              z.object({
                type: z.literal('event'),
                name: z.string().describe('Event name — verify with list_event_names'),
                displayName: z.string().optional(),
                // `chartSegments`, not a copy of it. The prose below is this
                // tool's own, but the VALUES have to be exactly what
                // `zChartEventSegment` accepts: a segment the model can send but
                // the canonical parse rejects fails in the handler as a bare zod
                // path, and one that exists upstream but is missing here is
                // simply unreachable from chat.
                segment: z
                  .enum(objectToZodEnums(chartSegments))
                  .default('event')
                  .optional()
                  .describe(
                    [
                      'How to segment/aggregate the event:',
                      '- `event` — every event firing (default, "all events")',
                      '- `user` — unique users (e.g. for DAU/MAU)',
                      '- `session` — unique sessions',
                      '- `group` — unique groups/accounts',
                      '- `user_average` — average events per user',
                      '- `one_event_per_user` — count users who did it at least once',
                      '- `property_sum` / `property_average` / `property_max` / `property_min` — aggregate a numeric property from the event (requires `property`)',
                    ].join('\n'),
                  ),
                property: z
                  .string()
                  .optional()
                  .describe(
                    'Numeric property on the event to aggregate. Required when segment is `property_sum`/`average`/`max`/`min`. Example: `revenue`, `duration`, `score`.',
                  ),
                filters: z
                  .array(
                    z.object({
                      name: z
                        .string()
                        .describe(
                          'Field to filter on — verify with list_event_properties. Use the bare column name for top-level columns (e.g. `path`, `country`, `device`) or `properties.<key>` for custom JSON properties (e.g. `properties.plan`).',
                        ),
                      // `inCohort`/`notInCohort` are excluded, not merely left
                      // out of the description. They need a `cohortIds` on the
                      // filter, which this tool has no field for, and
                      // `buildCohortClause` returns null for a cohort filter
                      // with no ids — the filter is DROPPED from the SQL, so the
                      // model gets an unfiltered chart it then describes to the
                      // user as filtered. Not offering them is the only outcome
                      // that fails visibly.
                      operator: z
                        .enum(objectToZodEnums(operators))
                        .exclude(['inCohort', 'notInCohort'])
                        .describe(
                          'One of: is, isNot, contains, doesNotContain, startsWith, endsWith, regex, isNull, isNotNull, gt, lt, gte, lte. `is` is the default for equality (NOT `equals` / `eq` / `==`).',
                        ),
                      value: z
                        .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
                        .describe('Values to match. Use [] with isNull/isNotNull.'),
                    }),
                  )
                  .default([])
                  .optional(),
              }),
              z.object({
                type: z.literal('formula'),
                formula: z
                  .string()
                  .describe(
                    'Expression referencing other series by letter id. Examples: `A / B * 100` (conversion rate), `A + B` (union total), `A - B` (difference). Earlier series are A, B, C, …',
                  ),
                displayName: z.string().optional(),
                hideSeries: z
                  .array(z.string())
                  .optional()
                  .describe(
                    'Letter ids (e.g. ["A", "B"]) of series used by the formula that should be hidden from the chart — useful when you only want to display the computed ratio.',
                  ),
              }),
            ]),
          ),
        )
        // The `.min(1)` that used to sit here now lives in the handler. A
        // metrics report has no series at all, and a schema-level minimum would
        // leave the model no way to satisfy it except by inventing an event.
        // A JSON-Schema violation is also rejected before the handler runs, so
        // the agent loop would never see an explanation it could act on.
        .default([])
        .optional()
        .describe(
          'The event series to chart — at least one is REQUIRED for an events report. Mix event series and formula series to compute ratios. Leave it out entirely when `dataSource` is "metrics": a metric report is described by `metricQuery` alone, and anything sent here is dropped.',
        ),
      breakdowns: z
        .array(
          z.object({
            name: z.string().describe('Property key to group by'),
          }),
        )
        .default([])
        .optional(),
      // No `.default()` here on purpose: it would make an omitted metric
      // indistinguishable from an explicit `sum`, and the fallback depends on
      // the chart type (see below).
      metric: z
        .enum(objectToZodEnums(metrics))
        .optional()
        .describe(
          'How a series is aggregated for display. Only the metric and map chart types read this; `count` is unique profiles. Omit it unless the user asked for a specific aggregation — metric cards then default to unique profiles.',
        ),
      previous: z
        .boolean()
        .optional()
        .describe(
          'Overlay the same-length previous period for comparison. Great for "vs last week" / "vs last month" questions.',
        ),
      lineType: z
        .enum(objectToZodEnums(lineTypes))
        .optional()
        .describe(
          'Line style for linear/area charts. Default to `monotone` unless you have a reason not to.',
        ),
      limit: z
        .number()
        .min(1)
        .max(500)
        .optional()
        .describe('Top-N limit for bar/pie/sankey. Example: "top 10 pages" → limit: 10.'),
      unit: z
        .string()
        .optional()
        .describe('Y-axis unit suffix, e.g. `%`, `$`, `ms`, `users`.'),
      // `session_id` / `profile_id`, not `session` / `profile`.
      // `FunnelService.getFunnelGroup` compares against the literal
      // `'profile_id'` and falls back to `session_id` for everything else, so
      // `'profile'` never selected a profile funnel — it silently drew a
      // session one, and the description promising a profile default made that
      // the likelier of the two. These are also the values the report editor's
      // own control reads back (ReportSettings: `funnelGroup || 'session_id'`),
      // so a funnel saved from chat now round-trips.
      funnelGroup: z
        .enum(['session_id', 'profile_id'])
        .optional()
        .describe(
          'Only for `chartType: "funnel"`. Whether each funnel step counts by unique session (`session_id`) or unique profile (`profile_id`). Defaults to `session_id`.',
        ),
      title: z
        .string()
        .optional()
        .describe(
          'Short, descriptive card title (3-8 words) — e.g. "Signups per day, last 7 days". Always provide one.',
        ),
    }),
  },
  async (input, context) => {
    const isMetrics = input.dataSource === 'metrics';

    // Telemetry is optional per deployment, but `generate_report` is a BASE
    // tool: unlike the four in metrics.ts it is offered on every page of every
    // install, so `dataSource: "metrics"` is reachable on an events-only one.
    // Without this the metrics branch below runs `ChartEngine.execute` ->
    // `executeMetricChart` -> gigapipe's `queryRange`, which throws
    // `GigapipeNotConfiguredError` — a hard tool failure the agent loop cannot
    // act on. Returned rather than thrown, and worded the way
    // `telemetryUnavailable()` words it in metrics.ts (that helper is
    // module-private there, so the check is repeated rather than imported),
    // so the model can tell the user and move on.
    if (isMetrics && !isGigapipeEnabled()) {
      return {
        error:
          'Telemetry is not configured on this deployment — there are no metrics to chart. Tell the user rather than retrying.',
      };
    }

    // The same cross-field rule the validation layer enforces as
    // `refineReportDataSource`. Repeated here rather than left to the
    // `zReportInput` parse below, because that rule is a standalone refinement
    // the schema itself does not carry — and because a Zod issue list is a poor
    // prompt: `path: "metricQuery"` tells the model where the problem is, not
    // what to send instead. Neither half is meaningful alone and neither
    // failure announces itself; both render an empty panel with no error.
    if (isMetrics && !input.metricQuery) {
      return {
        error:
          'A metrics report is described entirely by `metricQuery`, and none was sent. Call generate_report again with `metricQuery: { metric, fn, aggregation }` — or drop `dataSource` and describe the chart with `series` if you meant an events report.',
        dataSource: 'metrics',
      };
    }
    if (input.metricQuery && !isMetrics) {
      return {
        error:
          'A `metricQuery` only runs when `dataSource` is "metrics". As sent it would be ignored and the chart would come back empty, so call generate_report again with `dataSource: "metrics"` — or remove `metricQuery` and describe the chart with `series`.',
        dataSource: input.dataSource ?? 'events',
      };
    }
    // The shared list, not a local one: `save_report` and the report editor
    // narrow to exactly these four, and a type this tool renders ad-hoc but
    // the editor cannot draw is a chart the user is told to save and then
    // finds empty.
    if (isMetrics && !isMetricChartType(input.chartType)) {
      return {
        error: `chartType "${input.chartType}" cannot draw a metric series — bar and pie run through the aggregate engine, and funnel/retention/conversion/sankey/map are shaped by event data, none of which a metric query produces. Each renders an empty panel rather than an error. Call generate_report again with one of: ${METRIC_CHART_TYPES.join(', ')}.`,
        chartType: input.chartType,
      };
    }

    const rawSeries: unknown[] = input.series ?? [];

    if (!isMetrics && rawSeries.length === 0) {
      return {
        error:
          'An events report needs at least one entry in `series`. Add an event series (call list_event_names first to verify the name), or set `dataSource: "metrics"` with a `metricQuery` if you meant to chart server telemetry.',
      };
    }

    // A metrics report is described entirely by `metricQuery` — the metric
    // branch of the engine never reads `series` or `breakdowns`
    // (packages/db/src/engine/index.ts). Empty them here rather than pass them
    // through, so a stray series cannot make the config we echo back — and that
    // a later "save this to a dashboard" would persist — disagree with what ran.
    // biome-ignore lint/suspicious/noExplicitAny: union discrimination between event/formula series is easier to do explicitly
    const series = (isMetrics ? [] : rawSeries).map((s: any, i: number) => {
      const id = ALPHABET_IDS[i] ?? String(i + 1);
      if (s?.type === 'formula') {
        return {
          id,
          type: 'formula' as const,
          formula: s.formula,
          displayName: s.displayName,
          ...(Array.isArray(s.hideSeries) ? { hideSeries: s.hideSeries } : {}),
        };
      }
      return {
        id,
        type: 'event' as const,
        name: s.name,
        displayName: s.displayName ?? s.name,
        segment: s.segment ?? 'event',
        ...(s.property ? { property: s.property } : {}),
        filters: s.filters ?? [],
      };
    });

    const options =
      input.chartType === 'funnel' && input.funnelGroup
        ? { type: 'funnel' as const, funnelGroup: input.funnelGroup }
        : undefined;

    const config = {
      projectId: context.projectId,
      // Conditional spread so an events config stays byte-identical to before:
      // `dataSource: undefined` is not the same as an absent key once this
      // object is echoed back as `report` and possibly saved.
      ...(isMetrics
        ? { dataSource: 'metrics' as const, metricQuery: input.metricQuery }
        : {}),
      chartType: input.chartType,
      interval: input.interval,
      startDate: input.startDate,
      endDate: input.endDate,
      series,
      breakdowns: isMetrics
        ? []
        : (input.breakdowns ?? []).map((b: { name: string }, i: number) => ({
            id: String(i + 1),
            name: b.name,
          })),
      range: 'custom' as const,
      // A metric card has always shown the total unique count, so an
      // unspecified metric must stay `count` there — `sum` would silently turn
      // "1.2k users" into "45k events".
      metric:
        input.metric ?? (input.chartType === 'metric' ? 'count' : 'sum'),
      previous: input.previous ?? false,
      ...(input.lineType ? { lineType: input.lineType } : {}),
      ...(input.limit ? { limit: input.limit } : {}),
      ...(input.unit ? { unit: input.unit } : {}),
      ...(options ? { options } : {}),
    };

    // Pre-validate against the real report schema so invalid shapes
    // (bad operator, wrong filter value type, unknown chartType) are
    // returned to the model as a structured error, letting the agent
    // loop self-correct instead of producing a broken chart.
    const parsed = zReportInput.safeParse(config);
    if (!parsed.success) {
      return {
        error: 'Invalid report config — fix the issues and call generate_report again.',
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      };
    }

    if (isMetrics) {
      // `runReportFromConfig` dispatches on chartType, and only `ChartEngine`
      // (executeChart) branches on dataSource. The funnel service and the
      // aggregate engine it would pick for chartType `funnel`/`metric` never
      // look at dataSource — they would run the events pipeline over an empty
      // series and hand back an empty chart with no error. So route the metric
      // path straight at executeChart rather than teach three engines about
      // metrics, and return the keys runReportFromConfig returns so the
      // frontend report renderer stays unaware there are two data sources.
      const data = await ChartEngine.execute(parsed.data);
      return {
        ...(input.title?.trim() ? { name: input.title.trim() } : {}),
        chartType: parsed.data.chartType,
        interval: parsed.data.interval,
        startDate: input.startDate,
        endDate: input.endDate,
        report: parsed.data,
        data,
        ...(rawSeries.length > 0 || (input.breakdowns?.length ?? 0) > 0
          ? {
              note: '`series` and `breakdowns` were ignored — a metrics report is described by `metricQuery` alone. To split it into several lines use `metricQuery.groupBy`.',
            }
          : {}),
      };
    }

    const chart = await runReportFromConfig({
      organizationId: context.organizationId,
      projectId: context.projectId,
      config: parsed.data as Parameters<typeof runReportFromConfig>[0]['config'],
    });
    return {
      // Use the model-supplied title when present; the frontend
      // falls back to a derived title from input if this is empty.
      ...(input.title?.trim() ? { name: input.title.trim() } : {}),
      ...chart,
    };
  },
);

// Letter ids for series. Must match the chart engine's expectation
// that series are referenced by A, B, C, … in formula expressions.
const ALPHABET_IDS = [
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J',
  'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T',
  'U', 'V', 'W', 'X', 'Y', 'Z',
] as const;

// ─────────────────────────────────────────────────────────────────
// AGGREGATE ANALYTICS — default to current page's filters
// ─────────────────────────────────────────────────────────────────

export const getAnalyticsOverview = chatTool(
  {
    name: 'get_analytics_overview',
    description:
      'Top-level metrics: unique visitors, total pageviews, sessions, bounce rate, avg session duration, plus an optional time series. Defaults to the user\'s current date range.',
    schema: z.object({
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      interval: z.enum(['hour', 'day', 'week', 'month']).default('day').optional(),
    }),
  },
  async ({ startDate, endDate, interval }, context) => {
    const pageContext = context.pageContext;
    const range = resolveDateRange({
      ...pageContext?.filters,
      startDate: startDate ?? pageContext?.filters?.startDate,
      endDate: endDate ?? pageContext?.filters?.endDate,
    });
    return getAnalyticsOverviewCore({
      projectId: context.projectId,
      startDate: range.startDate,
      endDate: range.endDate,
      interval: interval ?? 'day',
      filters: pageContextFilters(pageContext),
    });
  },
);

export const getTopPages = chatTool(
  {
    name: 'get_top_pages',
    description:
      'Top pages ranked by visitors / pageviews. Returns path, sessions, pageviews, bounce rate, avg duration. Respects the page\'s active property filters.',
    schema: z.object({
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      limit: z.number().min(1).max(100).default(20).optional(),
    }),
  },
  async ({ startDate, endDate, limit }, context) => {
    const pageContext = context.pageContext;
    const range = resolveDateRange({
      ...pageContext?.filters,
      startDate: startDate ?? pageContext?.filters?.startDate,
      endDate: endDate ?? pageContext?.filters?.endDate,
    });
    const pages = await getTopPagesCore({
      projectId: context.projectId,
      startDate: range.startDate,
      endDate: range.endDate,
      limit: limit ?? 20,
      filters: pageContextFilters(pageContext),
    });
    return truncateRows(pages, 50);
  },
);

export const getTopReferrers = chatTool(
  {
    name: 'get_top_referrers',
    description:
      'Traffic source breakdown — by referrer name, type, or UTM source/medium/campaign. Respects the page\'s active property filters.',
    schema: z.object({
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      breakdown: z
        .enum(['referrer_name', 'referrer_type', 'referrer'])
        .default('referrer_name')
        .optional(),
    }),
  },
  async ({ startDate, endDate, breakdown }, context) => {
    const pageContext = context.pageContext;
    const range = resolveDateRange({
      ...pageContext?.filters,
      startDate: startDate ?? pageContext?.filters?.startDate,
      endDate: endDate ?? pageContext?.filters?.endDate,
    });
    const rows = await getTrafficBreakdownCore({
      projectId: context.projectId,
      startDate: range.startDate,
      endDate: range.endDate,
      column: (breakdown ?? 'referrer_name') as 'referrer_name' | 'referrer_type' | 'referrer',
      filters: pageContextFilters(pageContext),
    });
    return truncateRows(rows, 50);
  },
);

export const getCountryBreakdown = chatTool(
  {
    name: 'get_country_breakdown',
    description:
      'Visitor breakdown by country / region / city. Returns sessions and percentage of total. Respects the page\'s active property filters.',
    schema: z.object({
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      breakdown: z
        .enum(['country', 'region', 'city'])
        .default('country')
        .optional(),
    }),
  },
  async ({ startDate, endDate, breakdown }, context) => {
    const pageContext = context.pageContext;
    const range = resolveDateRange({
      ...pageContext?.filters,
      startDate: startDate ?? pageContext?.filters?.startDate,
      endDate: endDate ?? pageContext?.filters?.endDate,
    });
    const rows = await getTrafficBreakdownCore({
      projectId: context.projectId,
      startDate: range.startDate,
      endDate: range.endDate,
      column: (breakdown ?? 'country') as 'country' | 'region' | 'city',
      filters: pageContextFilters(pageContext),
    });
    return truncateRows(rows, 100);
  },
);

export const getDeviceBreakdown = chatTool(
  {
    name: 'get_device_breakdown',
    description:
      'Visitor breakdown by device / browser / OS. Respects the page\'s active property filters.',
    schema: z.object({
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      breakdown: z
        .enum(['device', 'browser', 'os'])
        .default('device')
        .optional(),
    }),
  },
  async ({ startDate, endDate, breakdown }, context) => {
    const pageContext = context.pageContext;
    const range = resolveDateRange({
      ...pageContext?.filters,
      startDate: startDate ?? pageContext?.filters?.startDate,
      endDate: endDate ?? pageContext?.filters?.endDate,
    });
    const rows = await getTrafficBreakdownCore({
      projectId: context.projectId,
      startDate: range.startDate,
      endDate: range.endDate,
      column: (breakdown ?? 'device') as 'device' | 'browser' | 'os',
      filters: pageContextFilters(pageContext),
    });
    return truncateRows(rows, 50);
  },
);

export const getRollingActiveUsers = chatTool(
  {
    name: 'get_rolling_active_users',
    description:
      "Rolling active-users trend (DAU/WAU/MAU). Returns BOTH the latest single value AND a renderable chart config (so the UI draws a line chart). Default is DAU over 30 days; pass `windowDays: 7` for WAU or `windowDays: 30` for MAU. ALWAYS supply a concise `title` (3-8 words) that describes what the chart shows.",
    schema: z.object({
      /**
       * The rolling window. 1 = DAU (default), 7 = WAU, 30 = MAU.
       */
      windowDays: z.number().min(1).max(90).default(1).optional(),
      /** Number of days to chart. Defaults to 30. */
      days: z.number().min(1).max(365).default(30).optional(),
      title: z
        .string()
        .optional()
        .describe(
          'Short, descriptive card title (3-8 words) — e.g. "Monthly active users trend". Always provide one.',
        ),
    }),
  },
  async ({ windowDays, days, title }, context) => {
    const window = windowDays ?? 1;
    const range = days ?? 30;

    // Build a chart config that represents "unique users per day".
    // We use a user-segment on `screen_view` — OpenPanel's standard
    // pageview event — with a linear chart. The ChartEngine dedupes
    // per profile_id because of `segment: 'user'`.
    const endDate = new Date().toISOString().slice(0, 10);
    const startDate = new Date(Date.now() - (range - 1) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const label =
      window === 1 ? 'DAU' : window === 7 ? 'WAU' : window === 30 ? 'MAU' : `${window}-day active users`;

    const config = {
      chartType: 'linear' as const,
      interval: 'day' as const,
      startDate,
      endDate,
      range: 'custom' as const,
      metric: 'sum' as const,
      previous: false,
      breakdowns: [],
      series: [
        {
          id: '1',
          type: 'event' as const,
          name: 'screen_view',
          displayName: label,
          segment: 'user' as const,
          filters: [],
        },
      ],
    };

    const chart = await runReportFromConfig({
      organizationId: context.organizationId,
      projectId: context.projectId,
      config: config as Parameters<typeof runReportFromConfig>[0]['config'],
    });

    // Also keep the rolling summary so the model can quote the
    // single-number "MAU is 205,127" line.
    const summary = await getRollingActiveUsersCore({
      projectId: context.projectId,
      days: window,
    });

    return {
      // `name` is the title the frontend `ChatReportResult` uses for
      // the card header. The model is asked to supply a `title` —
      // we use it when present, falling back to a generic label.
      name: title?.trim() || `${label} — last ${range} days`,
      label,
      window,
      summary,
      // Keys the frontend report renderer knows about.
      ...chart,
    };
  },
);

export const getFunnel = chatTool(
  {
    name: 'get_funnel',
    description:
      'Multi-step conversion funnel. Returns BOTH a renderable funnel chart AND the numeric breakdown (users per step, conversion rates, drop-off). The UI draws an actual funnel chart. Provide an ordered list of event names — verify with list_event_names first. ALWAYS supply a concise `title` (3-8 words) describing what the funnel measures.',
    schema: z.object({
      steps: z
        .array(z.string())
        .min(2)
        .max(10)
        .describe('Ordered event names. Verify with list_event_names first.'),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      windowHours: z.number().min(1).max(720).default(24).optional(),
      groupBy: z
        .enum(['session_id', 'profile_id'])
        .default('session_id')
        .optional(),
      title: z
        .string()
        .optional()
        .describe(
          'Short, descriptive card title (3-8 words) — e.g. "Cart to checkout conversion" or "Signup to paid funnel". Always provide one.',
        ),
    }),
  },
  async ({ steps, startDate, endDate, windowHours, groupBy, title }, context) => {
    const pageContext = context.pageContext;
    const range = resolveDateRange({
      ...pageContext?.filters,
      startDate: startDate ?? pageContext?.filters?.startDate,
      endDate: endDate ?? pageContext?.filters?.endDate,
    });

    // Raw funnel numbers — step-by-step breakdown for the model to
    // reason about.
    const numbers = await getFunnelCore({
      projectId: context.projectId,
      steps,
      startDate: range.startDate,
      endDate: range.endDate,
      windowHours,
      groupBy,
    });

    // Chart config — same shape `generate_report` returns, so the
    // frontend's `ChatReportResult` renderer draws an actual funnel
    // chart via `<ReportChart>`.
    const chartConfig = {
      chartType: 'funnel' as const,
      interval: 'day' as const,
      startDate: range.startDate,
      endDate: range.endDate,
      range: 'custom' as const,
      metric: 'sum' as const,
      previous: false,
      breakdowns: [],
      // Both settings belong under `options`, and in these units.
      // `FunnelService.getFunnel` reads them as
      // `options?.type === 'funnel' ? options : undefined` and nowhere else,
      // so the top-level `funnelGroup` / `funnelWindowSeconds` this used to
      // send were dropped on the floor: the chart was always a 24-hour session
      // funnel while `numbers` above honoured `groupBy` / `windowHours`, and
      // the two halves of one tool result disagreed with no error.
      // `funnelWindow` is in HOURS (buildFunnelBase multiplies by 3600 * 1000),
      // so pass hours, not seconds.
      options: {
        type: 'funnel' as const,
        funnelGroup: groupBy ?? 'session_id',
        funnelWindow: windowHours ?? 24,
      },
      series: (steps as string[]).map((name: string, i: number) => ({
        id: String(i + 1),
        type: 'event' as const,
        name,
        displayName: name,
        segment: 'event' as const,
        filters: [],
      })),
    };

    const chart = await runReportFromConfig({
      organizationId: context.organizationId,
      projectId: context.projectId,
      config: chartConfig as Parameters<typeof runReportFromConfig>[0]['config'],
    });

    return {
      name: title?.trim() || `Funnel: ${steps.join(' → ')}`,
      numbers,
      // Keys the frontend report renderer knows about.
      ...chart,
    };
  },
);

export const getRetentionCohort = chatTool(
  {
    name: 'get_retention_cohort',
    description:
      'Weekly active-user retention cohort for the last 12 weeks. Each row is a cohort (the week users were first seen) with cohort size (sum), retained user counts (values) and retained share (percentages) for subsequent weeks; a leading weighted-average row summarises all cohorts.',
    schema: z.object({}),
  },
  async (_input, context) => getRetentionCohortCore(context.projectId),
);

export const getUserFlow = chatTool(
  {
    name: 'get_user_flow',
    description:
      'Sankey-style user navigation flow from a starting event. Returns nodes + links suitable for visualizing common paths.',
    schema: z.object({
      startEvent: z.string().describe('Event name where the flow starts'),
      endEvent: z
        .string()
        .optional()
        .describe('Required when mode=between'),
      mode: z.enum(['after', 'before', 'between']).default('after'),
      steps: z.number().min(2).max(10).default(5).optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
    }),
  },
  async ({ startEvent, endEvent, mode, steps, startDate, endDate }, context) => {
    const pageContext = context.pageContext;
    const range = resolveDateRange({
      ...pageContext?.filters,
      startDate: startDate ?? pageContext?.filters?.startDate,
      endDate: endDate ?? pageContext?.filters?.endDate,
    });
    return getUserFlowCore({
      projectId: context.projectId,
      startEvent,
      endEvent,
      mode,
      steps,
      startDate: range.startDate,
      endDate: range.endDate,
    });
  },
);

// ─────────────────────────────────────────────────────────────────
// FREE-FORM QUERIES (escape hatches when nothing else fits)
// ─────────────────────────────────────────────────────────────────

export const queryEvents = chatTool(
  {
    name: 'query_events',
    description:
      'Free-form query over raw events with filters (path, country, device, browser, OS, referrer, custom properties, profileId, eventNames). Use this when aggregate tools don\'t cover the question.',
    schema: z.object({
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      eventNames: z.array(z.string()).optional(),
      path: z.string().optional(),
      country: z.string().optional(),
      city: z.string().optional(),
      device: z.string().optional(),
      browser: z.string().optional(),
      os: z.string().optional(),
      referrer: z.string().optional(),
      referrerName: z.string().optional(),
      referrerType: z.string().optional(),
      profileId: z.string().optional(),
      properties: z.record(z.string(), z.string()).optional(),
      limit: z.number().min(1).max(100).default(20).optional(),
    }),
  },
  async (input, context) => {
    const pageContext = context.pageContext;
    const range = resolveDateRange({
      ...pageContext?.filters,
      startDate: input.startDate ?? pageContext?.filters?.startDate,
      endDate: input.endDate ?? pageContext?.filters?.endDate,
    });
    const rows = await queryEventsCore({
      projectId: context.projectId,
      ...input,
      startDate: range.startDate,
      endDate: range.endDate,
      limit: input.limit ?? 20,
    });
    return truncateRows(rows, 100);
  },
);

export const querySessions = chatTool(
  {
    name: 'query_sessions',
    description:
      'Free-form query over raw sessions with filters (country, device, browser, OS, referrer, profileId).',
    schema: z.object({
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      country: z.string().optional(),
      city: z.string().optional(),
      device: z.string().optional(),
      browser: z.string().optional(),
      os: z.string().optional(),
      referrer: z.string().optional(),
      referrerName: z.string().optional(),
      referrerType: z.string().optional(),
      profileId: z.string().optional(),
      limit: z.number().min(1).max(100).default(20).optional(),
    }),
  },
  async (input, context) => {
    const pageContext = context.pageContext;
    const range = resolveDateRange({
      ...pageContext?.filters,
      startDate: input.startDate ?? pageContext?.filters?.startDate,
      endDate: input.endDate ?? pageContext?.filters?.endDate,
    });
    const rows = await querySessionsCore({
      projectId: context.projectId,
      ...input,
      startDate: range.startDate,
      endDate: range.endDate,
      limit: input.limit ?? 20,
    });
    return truncateRows(rows, 100);
  },
);

export const findProfiles = chatTool(
  {
    name: 'find_profiles',
    description:
      'Search for user profiles by name, email, country, device, inactivity, minimum sessions, or having performed a specific event.',
    schema: z.object({
      name: z.string().optional(),
      email: z.string().optional(),
      country: z.string().optional(),
      city: z.string().optional(),
      device: z.string().optional(),
      browser: z.string().optional(),
      inactiveDays: z.number().min(1).optional(),
      minSessions: z.number().min(1).optional(),
      performedEvent: z.string().optional(),
      sortOrder: z.enum(['asc', 'desc']).default('desc').optional(),
      limit: z.number().min(1).max(100).default(20).optional(),
    }),
  },
  async (input, context) => {
    const profiles = await findProfilesCore({
      projectId: context.projectId,
      ...input,
    });
    return truncateRows(
      profiles.map((p) => ({
        ...p,
        dashboard_url: dashboardUrl(context.organizationId, context.projectId, `/profiles/${p.id}`),
      })),
      100,
    );
  },
);
