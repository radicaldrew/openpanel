import { type AgentToolDefinition, defineTool } from '@better-agent/core';
import type { IChartType, IReportDataSource } from '@openpanel/validation';
import {
  isMetricChartType,
  METRIC_CHART_TYPES,
  refineReportDataSource,
  zChartSeries,
  zReport,
} from '@openpanel/validation';
import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────
// THE WRITE PATH — WHY THERE IS NO MUTATION IN THIS FILE
// ─────────────────────────────────────────────────────────────────
//
// `save_report` and `create_dashboard` used to be server tools that wrote
// straight to the database, authorized with a `refuseWrite()` helper and
// gated on INTENT by prompt text alone ("ask first, always"). Authorization
// was never the hole; intent was. The same tool set hands the model
// `list_event_names`, `get_event_property_values`, `query_events` and
// `find_profiles`, all of which return raw event names, property values and
// profile properties collected through the PUBLIC track API — a client id
// embedded in the customer's own page. Anyone who can POST an event into the
// project can therefore plant text the model reads in the same turn it holds
// a write tool, and prompt text is not a gate. A prompt-injected (or merely
// over-eager) model creating dashboards and saving reports needed a real
// boundary, not a sterner sentence.
//
// So the model no longer completes a write. Both tools are `.client()`
// declarations: Better Agent emits the call, executes nothing server-side,
// and the frontend handler (apps/start/src/components/chat/tool-handlers.ts)
// opens the ORDINARY dialog a person uses — `SaveReport` / `AddDashboard` —
// prefilled with what the model proposed. The row is written only when the
// human submits that form, through the same trpc `report.create` /
// `dashboard.create` the Save button behind every chart uses. That is the
// pattern `apply_filters` / `set_property_filters` already follow, and it is
// what the comment on PERSIST_TOOLS in ./index.ts already called "the
// human-in-the-loop version of the same write".
//
// `refuseWrite()` is gone with the mutation, and nothing it enforced was
// lost: `enforceAccess` in packages/trpc/src/trpc.ts rejects every mutation
// when DEMO_USER_ID is set, and `report.create` / `dashboard.create` both
// call `requireProjectAccess({ level: 'write' })` — the same helper pair
// refuseWrite() reimplemented, running at the moment of the actual write
// rather than in a tool that no longer performs one.

// ─────────────────────────────────────────────────────────────────
// ONE MODEL-FACING REPORT CONTRACT
// ─────────────────────────────────────────────────────────────────

/**
 * The report shape a save is allowed to carry, expressed as the CANONICAL
 * write contract rather than as a second model-facing schema.
 *
 * There used to be two descriptions of a report in front of the model —
 * `generate_report`'s schema in base.ts and a `zReport.omit(...)` here — and
 * they disagreed in two places that both fail silently:
 *
 *   - `fn`. base.ts calls `.removeDefault()` on it so the model must state
 *     it; the raw `zMetricQuery` used here defaulted it to `rate`, and `rate`
 *     on a gauge is always zero. A metric report composed fresh for the write
 *     tool saved a flat-zero panel.
 *   - `series`. base.ts gives it `.default([])` so a metric report can omit
 *     it; `zReport.series` has no default, so it was the ONE required key on
 *     the write schema (verified by resolving the JSON Schema:
 *     `required: ["series"]`). The write tool rejected a shape the chart tool
 *     had just accepted.
 *
 * Patching each divergence would leave two schemas to keep in step. Instead
 * the write tool no longer takes a report the model composed: it takes the
 * `report` object `generate_report` echoed back, verbatim (see the tool
 * description). `generate_report` already ran that object through
 * `zReportInput`, so `fn` is present because base.ts forced the model to
 * supply it, and `series` is present because the handler normalized it. The
 * only remaining job here is to CHECK what arrives, against the same schema
 * `report.create` will parse at write time — no second contract to drift.
 *
 * Two deliberate deltas from `zReport`:
 *  - `projectId` is omitted: it is derived from the dashboard by both
 *    `report.create` and the model has no business naming it.
 *  - `series` gets `.default([])`, matching base.ts, so a metrics report can
 *    omit it. The "an events report needs at least one series" rule moves to
 *    `refineEventSeriesPresent` below, where it can explain itself.
 *
 * `limit` and `offset` are deliberately NOT omitted (the old schema dropped
 * them). Zod strips unknown keys, so omitting `limit` silently discarded the
 * top-N of a "top 10 pages" chart on the way to being saved.
 */
const savedReportContract = zReport
  .omit({ projectId: true })
  .extend({ series: zChartSeries.default([]) })
  .superRefine(refineReportDataSource)
  .superRefine(refineMetricChartType)
  .superRefine(refineEventSeriesPresent)
  .superRefine(refineCustomRangeDates);

/**
 * A metric report has to be saved as a chart type the metrics engine is
 * actually reachable from. `generate_report` refuses the rest up front, but
 * this is the path that leaves something behind: only
 * `linear`/`area`/`histogram`/`metric` route through `executeChart`, and every
 * other type renders the saved panel empty with no error for the user to act
 * on. See METRIC_CHART_TYPES in @openpanel/validation.
 */
function refineMetricChartType(
  report: { dataSource?: IReportDataSource; chartType: IChartType },
  ctx: z.RefinementCtx,
) {
  if (report.dataSource !== 'metrics') {
    return;
  }

  if (!isMetricChartType(report.chartType)) {
    ctx.addIssue({
      code: 'custom',
      path: ['chartType'],
      message: `chartType "${report.chartType}" cannot draw a metric series — it would save a panel that renders nothing. Use one of: ${METRIC_CHART_TYPES.join(', ')}`,
    });
  }
}

/**
 * The counterpart of the `series.default([])` above, and the same rule
 * `generate_report`'s handler enforces (base.ts). An events report with no
 * series is not a chart, but the minimum cannot sit on the schema itself
 * because a metrics report legitimately has none.
 */
function refineEventSeriesPresent(
  report: { dataSource?: IReportDataSource; series: unknown[] },
  ctx: z.RefinementCtx,
) {
  if (report.dataSource === 'metrics' || report.series.length > 0) {
    return;
  }

  ctx.addIssue({
    code: 'custom',
    path: ['series'],
    message:
      'An events report needs at least one entry in `series`. Copy the `report` object generate_report returned instead of rebuilding it, or set dataSource: "metrics" with a metricQuery for server telemetry.',
  });
}

/**
 * A saved report keeps its dates forever, so a `custom` range with missing or
 * malformed dates is a panel that errors on every future open. The engine's
 * schema allows nullish dates (a live editor fills them in later); a write
 * cannot.
 */
function refineCustomRangeDates(
  report: { range?: string; startDate?: string | null; endDate?: string | null },
  ctx: z.RefinementCtx,
) {
  if (report.range !== 'custom') {
    return;
  }

  const isDateOnly = (value: unknown): value is string =>
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

  for (const field of ['startDate', 'endDate'] as const) {
    if (!isDateOnly(report[field])) {
      ctx.addIssue({
        code: 'custom',
        path: [field],
        message: `${field} is required in YYYY-MM-DD format when range is "custom"`,
      });
    }
  }

  if (
    isDateOnly(report.startDate) &&
    isDateOnly(report.endDate) &&
    report.startDate > report.endDate
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['endDate'],
      message: 'endDate must be on or after startDate',
    });
  }
}

/**
 * The model-facing shape of `report`: an opaque object, checked against
 * `savedReportContract`.
 *
 * Opaque ON PURPOSE. Re-declaring the report's fields here would put a second
 * composable report schema in the tool list — the exact thing that let a
 * model build a save payload it had never rendered, which is how the `fn` and
 * `series` divergences above became reachable. With no field-level schema the
 * only way to produce a valid `report` is to copy the one `generate_report`
 * returned, which also enforces the rule the description has always claimed:
 * never save a chart the user has not seen.
 *
 * It also keeps the tool cheap. `zReport`'s JSON Schema (the series
 * discriminated union, filters, operators) is nearly the size of
 * `generate_report`'s, and it would sit in the context of every turn.
 */
const reportPayloadSchema = z
  .looseObject({})
  .superRefine((value, ctx) => {
    const parsed = savedReportContract.safeParse(value);
    if (parsed.success) {
      return;
    }
    for (const issue of parsed.error.issues) {
      ctx.addIssue({
        code: 'custom',
        path: issue.path,
        message: issue.message,
      });
    }
  })
  .describe(
    'The `report` object generate_report returned in its result, copied VERBATIM — same keys, same values. Do not rebuild it, rename its fields, or drop `dataSource`/`metricQuery`. The only field you may change is `range` (see the description above).',
  );

/**
 * Turn a failed schema validation into something the model can act on.
 *
 * Better Agent reports a validation failure to the model as the fixed string
 * "Tool arguments failed schema validation. The provided data is invalid
 * according to schema." — the Zod issues are attached to the error's
 * `context` and never reach the conversation (verified in
 * core/dist/run/execute-tool-calls.mjs: `createToolErrorOutcome` copies only
 * `message`). For a server tool we sidestepped that by returning errors as
 * RESULTS; a client tool has no server handler to return from, so the
 * `onToolError` hook is the one place left to put the detail. Without it the
 * agent loop gets told "invalid" with no idea which field.
 */
// biome-ignore lint/suspicious/noExplicitAny: the hook's return type is conditional on the error kind; see below
const explainValidationIssues = (context: any): any => {
  if (context.errorKind !== 'validation') {
    return undefined;
  }

  const issues: unknown = context.error?.context?.issues;
  if (!Array.isArray(issues) || issues.length === 0) {
    return undefined;
  }

  const lines = issues.slice(0, 10).map((issue: any) => {
    const path = Array.isArray(issue?.path)
      ? issue.path
          .map((segment: any) =>
            segment !== null && typeof segment === 'object' && 'key' in segment
              ? String(segment.key)
              : String(segment),
          )
          .join('.')
      : '';
    return path ? `${path}: ${issue?.message}` : String(issue?.message);
  });

  return {
    action: 'send_to_model',
    message: [
      'Nothing was saved — the config was rejected before the dialog opened:',
      ...lines,
      'Fix these and call the tool again.',
    ].join('\n'),
    retryable: true,
  };
};

// ─────────────────────────────────────────────────────────────────
// THE TOOLS
// ─────────────────────────────────────────────────────────────────

// Cast to `any` before `.client()` for the same reason `chatTool` does in
// `helpers.ts` and `ui.ts` does for the filter tools: TS otherwise fully
// instantiates `ClientToolDefinition<TSchema, ...>` over a deeply-nested Zod
// schema and trips its instantiation-depth limit. The runtime is fine; the
// `AgentToolDefinition` cast on the way out restores a usable type.
// biome-ignore lint/suspicious/noExplicitAny: see comment above
const saveReportContract: any = defineTool({
  name: 'save_report',
  description: [
    'Open the "Create report" dialog so the USER can save a chart you rendered onto one of their dashboards. You cannot save anything yourself: this opens the same dialog the Save button opens, prefilled with the chart and the name you propose, and nothing is written until the user picks a dashboard and clicks Save.',
    '',
    'Call it only after generate_report has actually drawn the chart, and pass that result\'s `report` object back VERBATIM plus a `name`. Do not compose a report here — a config the user has not seen is not savable.',
    '',
    'Do NOT call list_dashboards or create_dashboard first: the dialog lists the dashboards itself and can create a new one inline.',
    '',
    'Prefer a preset `range` ("30d", "7d", …) over the `range: "custom"` + fixed dates generate_report echoes back; a saved report keeps its dates forever and would show the same stale window on every future open. Keep `startDate`/`endDate` only when range stays "custom".',
    '',
    'After calling it, tell the user the dialog is open and what to do ("pick a dashboard and hit Save"). Never report the chart as saved — you do not find out whether they went through with it.',
  ].join('\n'),
  schema: z.object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .describe(
        'Report name as the user would title it (3-8 words) — prefills the dialog\'s name field. Reuse the `title` you gave generate_report unless the user asked for something else.',
      ),
    report: reportPayloadSchema,
  }),
  onToolError: explainValidationIssues,
});

export const saveReport: AgentToolDefinition =
  saveReportContract.client() as AgentToolDefinition;

// biome-ignore lint/suspicious/noExplicitAny: see comment on saveReportContract
const createDashboardContract: any = defineTool({
  name: 'create_dashboard',
  description: [
    'Open the "Add dashboard" dialog so the USER can create a new, empty dashboard. You cannot create one yourself — the dialog opens with an empty name field and nothing exists until the user types a name and confirms.',
    '',
    'Only for a direct "create a dashboard" request. Do NOT call it as a step before save_report: the save dialog creates a dashboard inline, and an empty dashboard created ahead of a save that never happens is litter the user has to clean up.',
    '',
    'The dialog cannot be prefilled, so state the name you suggest in your reply ("call it Checkout funnel") — that is what the user types.',
  ].join('\n'),
  schema: z.object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .describe(
        'The dashboard name you suggest (2-5 words). Shown back to the user to type into the dialog; it does not prefill the field.',
      ),
  }),
});

export const createDashboard: AgentToolDefinition =
  createDashboardContract.client() as AgentToolDefinition;
