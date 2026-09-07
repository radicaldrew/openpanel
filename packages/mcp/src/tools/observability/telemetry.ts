import {
  executeMetricChart,
  executeMetricPanel,
  getTelemetryLabelKeys,
  getTelemetryLabelValues,
  getTelemetryMetricNames,
  getTelemetryServices,
  getTrace,
  searchTraces,
} from '@openpanel/db';
import { isGigapipeEnabled } from '@openpanel/gigapipe';
import { zPromqlUnit } from '@openpanel/validation';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpAuthContext } from '../../auth';
import { projectIdSchema, resolveProjectId, withErrorHandling } from '../shared';

/**
 * Server telemetry tools.
 *
 * These are what make "why did checkout get slow last Tuesday?" answerable
 * against product AND infrastructure data in one conversation — the thing a
 * separate Grafana cannot do, because the model would have to hold two
 * disconnected systems.
 *
 * Every tool resolves the project through `resolveProjectId`, so the same
 * per-client scoping that applies to analytics tools applies here. Beyond that
 * the query compilers inject the tenancy matcher themselves, so a caller cannot
 * widen the selection even by asking.
 */

const RANGE_HELP =
  'ISO-8601 timestamps. Keep the window as narrow as the question allows — a wide range at a fine interval is refused or coarsened.';

function requireTelemetry() {
  if (!isGigapipeEnabled()) {
    throw new Error(
      'Telemetry is not configured on this deployment. There are no metrics, logs or traces to query.',
    );
  }
}

export function registerTelemetryTools(
  server: McpServer,
  context: McpAuthContext,
) {
  server.tool(
    'list_metrics',
    'List the server metric names this project has recorded (e.g. http_server_requests_total). Always call this before query_metric — metric names are exact and vary by service instrumentation.',
    { projectId: projectIdSchema(context) },
    async ({ projectId: input }) =>
      withErrorHandling(async () => {
        requireTelemetry();
        const projectId = await resolveProjectId(context, input);
        return { metrics: await getTelemetryMetricNames(projectId) };
      }),
  );

  server.tool(
    'list_metric_labels',
    'List the labels available on a metric, and optionally the values one label takes. Use this to discover what you can filter or group by before calling query_metric.',
    {
      projectId: projectIdSchema(context),
      metric: z.string().describe('Metric name from list_metrics.'),
      label: z
        .string()
        .optional()
        .describe('If given, returns this label’s values instead of the label names.'),
    },
    async ({ projectId: input, metric, label }) =>
      withErrorHandling(async () => {
        requireTelemetry();
        const projectId = await resolveProjectId(context, input);

        if (label) {
          return {
            label,
            values: await getTelemetryLabelValues(projectId, label, { metric }),
          };
        }

        return { labels: await getTelemetryLabelKeys(projectId, { metric }) };
      }),
  );

  server.tool(
    'query_metric',
    'Chart a server metric over time. Returns one series per group-by combination with timestamped values, plus the PromQL that was generated. Use rate for counters (anything ending in _total) and raw for gauges. For anything the structured fields cannot express — a ratio between two metrics, topk, a binary operation — send `queries` with raw PromQL instead of `metric`.',
    {
      projectId: projectIdSchema(context),
      metric: z
        .string()
        .optional()
        .describe(
          'Metric name from list_metrics. Required unless `queries` is given.',
        ),
      queries: z
        .array(
          z.object({
            expr: z
              .string()
              .min(1)
              .max(4000)
              .describe(
                'PromQL. Do NOT write op_project_id yourself — the server injects the tenancy matcher into every selector and rejects a query that tries to set it. $__rate_interval, $__interval and $__range resolve against the chart step.',
              ),
            legendFormat: z
              .string()
              .max(200)
              .optional()
              .describe('Series name template, e.g. "{{method}} {{status}}".'),
            unit: zPromqlUnit
              .optional()
              .describe('How the values read: seconds, bytes, percentunit, ops…'),
            instant: z
              .boolean()
              .optional()
              .describe('Evaluate once at the end of the range, not over it.'),
          }),
        )
        .max(10)
        .optional()
        .describe(
          'Raw PromQL queries, one series set each. Use INSTEAD of metric/fn/aggregation/groupBy/matchers when the question needs an expression those cannot build.',
        ),
      fn: z
        .enum(['rate', 'increase', 'delta', 'raw'])
        .default('rate')
        .describe('rate/increase/delta for counters; raw for gauges.'),
      aggregation: z
        .enum(['sum', 'avg', 'min', 'max', 'count', 'p50', 'p90', 'p95', 'p99'])
        .default('sum')
        .describe(
          'Percentiles require a histogram bucket series — a metric name ending in _bucket.',
        ),
      groupBy: z
        .array(z.string())
        .max(3)
        .default([])
        .describe('Labels to break the series down by, from list_metric_labels.'),
      matchers: z
        .array(
          z.object({
            name: z.string(),
            operator: z.enum(['eq', 'neq', 'match', 'notMatch']),
            value: z.string(),
          }),
        )
        .max(10)
        .default([])
        .describe('Label filters.'),
      interval: z
        .enum(['minute', 'hour', 'day', 'week', 'month'])
        .default('hour'),
      startDate: z.string().describe(RANGE_HELP),
      endDate: z.string().describe(RANGE_HELP),
    },
    async ({ projectId: input, metric, queries, fn, aggregation, groupBy, matchers, interval, startDate, endDate }) =>
      withErrorHandling(async () => {
        requireTelemetry();
        const projectId = await resolveProjectId(context, input);

        const seriesOf = (chart: { series: { names: string[]; event?: { breakdowns?: Record<string, string> }; data: { date: string; count: number }[] }[] }) =>
          chart.series.map((serie) => ({
            name: serie.names.join(' / '),
            labels: serie.event?.breakdowns ?? {},
            points: serie.data.map((point) => ({
              date: point.date,
              value: point.count,
            })),
          }));

        // The PromQL path. `expr` is the source of truth, exactly as it is for
        // a panel saved from the editor, and it goes through the same
        // substitute -> rewrite -> assert pipeline — so the tenancy matcher is
        // injected server-side and a query the grammar cannot parse is refused
        // rather than forwarded. See packages/db/src/engine/metrics/panel.ts.
        if (queries?.length) {
          const result = await executeMetricPanel({
            projectId,
            queries: queries.map((query, index) => ({
              // 'A', 'B', … — the same labels the editor uses, so the PromQL
              // this returns is quotable straight into a panel.
              refId: String.fromCharCode(65 + index),
              expr: query.expr,
              mode: 'code' as const,
              hidden: false,
              unit: query.unit ?? 'none',
              yAxis: 'left' as const,
              instant: query.instant ?? false,
              ...(query.legendFormat
                ? { legendFormat: query.legendFormat }
                : {}),
            })),
            interval,
            startDate,
            endDate,
          });

          return {
            promql: result.compiled,
            notices: result.notices,
            series: seriesOf(result.chart),
          };
        }

        if (!metric) {
          return {
            error:
              'query_metric needs either `metric` (with the structured fn/aggregation/groupBy fields) or `queries` with raw PromQL. Neither was sent.',
          };
        }

        const result = await executeMetricChart({
          projectId,
          query: { metric, fn, aggregation, groupBy, matchers },
          interval,
          startDate,
          endDate,
          name: metric,
        });

        return {
          // The compiled query is returned deliberately: it lets the model
          // explain what it actually measured, and lets a human check it.
          promql: result.compiled,
          notices: result.notices,
          series: seriesOf(result.chart),
        };
      }),
  );

  server.tool(
    'list_services',
    'List the services reporting telemetry for this project. Useful for narrowing a metric, log or trace query to one service.',
    { projectId: projectIdSchema(context) },
    async ({ projectId: input }) =>
      withErrorHandling(async () => {
        requireTelemetry();
        const projectId = await resolveProjectId(context, input);
        return { services: await getTelemetryServices(projectId) };
      }),
  );

  server.tool(
    'search_traces',
    'Find distributed traces, newest first. Use minDurationMs to hunt slow requests. Returns trace IDs you can pass to get_trace.',
    {
      projectId: projectIdSchema(context),
      startDate: z.string().describe(RANGE_HELP),
      endDate: z.string().describe(RANGE_HELP),
      service: z.string().optional().describe('Service name from list_services.'),
      minDurationMs: z
        .number()
        .optional()
        .describe('Only traces at least this slow. The usual way to find a regression.'),
      limit: z.number().int().min(1).max(100).default(20),
    },
    async ({ projectId: input, startDate, endDate, service, minDurationMs, limit }) =>
      withErrorHandling(async () => {
        requireTelemetry();
        const projectId = await resolveProjectId(context, input);

        return {
          traces: await searchTraces(
            projectId,
            { start: new Date(startDate), end: new Date(endDate) },
            { service, minDurationMs },
            limit,
          ),
        };
      }),
  );

  server.tool(
    'get_trace',
    'Get every span of one trace, in time order, with durations and attributes. Use this after search_traces to see where the time actually went.',
    {
      projectId: projectIdSchema(context),
      traceId: z.string().describe('Trace ID from search_traces.'),
    },
    async ({ projectId: input, traceId }) =>
      withErrorHandling(async () => {
        requireTelemetry();
        const projectId = await resolveProjectId(context, input);

        const spans = await getTrace(projectId, traceId);

        // An empty result means "not yours or not found" — the service does not
        // distinguish the two, so neither does this.
        return {
          traceId,
          spanCount: spans.length,
          spans: spans.map((span) => ({
            name: span.name,
            service: span.service,
            durationMs: span.durationMs,
            parentSpanId: span.parentId,
            spanId: span.spanId,
            attributes: span.attributes,
          })),
        };
      }),
  );
}
