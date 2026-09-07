# 15 — PromQL panels: multi-query metrics, editor, Explore, variables, correlation, annotations

Reconciled plan for the spec at `/tmp/OPENPANEL-OBSERVE.md`, checked against the source on 2026-09-07.
Orchestrated from the `openpanel-manager` session; built by `openpanel-dev1`, `openpanel-dev2`, `openpanel-dev3`
on the single shared checkout (no worktrees). File ownership per wave is in §9; **never edit a file another
session owns in the current wave — message its owner instead.**

---

## 1. Discovery — what the spec assumed vs what exists

The spec's §1 asked for `DISCOVERY.md`. The answers already live in `docs/observability/00-14`, and the rest were
verified for this plan. Summary:

| Spec assumption | Reality |
|---|---|
| Metrics path is "Metric + Function + Aggregation + Group by" sent as raw values | True, but narrower than feared: `zMetricQuery` (`packages/validation/src/index.ts:305`) defaults `fn` by metric kind (`packages/common/src/metric-kind.ts`), hides rate for gauges, and has `p50…p99` aggregations that compile to `histogram_quantile`. The sawtooth/“sum of buckets” bug is only reachable by choosing `raw`. What is genuinely missing: joins, binary ops between selectors, `topk`, multi-query panels, legends, units. |
| Need to build a PromQL query path to Gigapipe | Exists: `packages/gigapipe/src/client.ts` `queryRange` (POST form to `GIGAPIPE_URL/api/v1/query_range`, basic auth from `GIGAPIPE_USER/PASSWORD`, 30s+ timeout, over-limit → 413). Engine: `packages/db/src/engine/metrics/index.ts` `executeMetricChart` (step from interval, 1500-point clamp, subquery downsampling above a 300s step, rate window ≥ 4×step, bucket grid, 20-series cap, previous period). Adapter `adapter.ts` → `ConcreteSeries[]` → shared `format()` → `FinalChart`. |
| Raw PromQL is forbidden by the tenancy design | Structured compiler is one path; **raw PromQL is already sanctioned** through `rewritePromqlForProject` + `assertPromqlScoped` (`packages/gigapipe/src/promql/rewrite.ts`, lezer parser, injects `op_project_id="<project>"` into every VectorSelector, rejects `label_replace/label_join`). Was exposed as `observability.rawQuery` with no UI caller; **deleted in this build** (superseded by `observability.panel`, and it was the only read path without the adapter's ownership check). The AGPL §13 note in docs 03/05 refers to forking gigapipe, not to this rewriter. |
| Need label/series/metadata proxies | Autocomplete data already comes from project-scoped ClickHouse reads of `time_series_gin` (`packages/db/src/services/telemetry-metadata.service.ts`) via `observability.metricNames / labelKeys / labelValues / services`. Gigapipe's own endpoints are global (not tenant-scoped), so they must not be proxied to the browser. |
| Gigapipe capabilities unknown | Verified live 2026-09-07 on the deployed instance: `/api/v1/labels` 200, `/api/v1/label/__name__/values` 200 (GET only), `/api/v1/series` 200, `/api/v1/query` (instant) 200, `/api/v1/metadata` 200 **but `{}`** — metric type must keep being inferred from the name. Real metrics present: `http_request_duration_seconds_{bucket,count,sum}`, `git_operations_in_flight`, `active_workers`, labels `service_name`, `job`, `route`, `method`, `status`, `le`. |
| Report model unknown | Prisma `Report` (`packages/db/prisma/schema.prisma:452`): `events Json` holds the events `series[]`; `dataSource ReportDataSource`; `metricQuery Json?` (single structured query). No `description` column. `Dashboard` has no variables. No annotations table. `SavedTelemetrySearch` exists for logs/traces only. |
| Chart renderer unknown | `apps/start/src/components/report-chart/{line,area,histogram,metric}` on Recharts 2.15, single `YAxis`, `unit` is a free string applied through `useNumber().formatWithUnit` (`'%'` scales ×100, `'min'` special-cased). `ReportTable` has Sum/Average/Min/Max columns. `ChartClickMenu` already wraps the line chart. `lineType` = Recharts curve type. Interval comes from `ReportInterval`. |
| Logs/Traces URL params | **None.** Both routes keep range/service/level/search/duration in `useState`. Deep links need `validateSearch` (zod, see `reports_.$reportId.tsx`) or `nuqs` (see `useOverviewOptions.ts`). Logs range values: `15m,1h,6h,24h,7d`; traces: `15m,1h,6h,24h` + `minDuration` ms. |
| React version | 19.2 (`pnpm-workspace.yaml` catalog). CodeMirror 6 core (`@codemirror/state|view|commands`, `codemirror`) is already in `apps/start`. `@prometheus-io/lezer-promql@0.314` is already in `packages/gigapipe`. |
| Alerting is a non-goal | Already shipped: `apps/worker/src/jobs/cron.metric-alerts.ts`, `MetricAlertState`, `zNotificationRuleMetricConfig` (uses the structured `zMetricQuery`). **Must keep working untouched.** |
| Playwright flow | No Playwright in the repo. Dropped; vitest only. |

Consumers of the structured `MetricQuery` that stay on the legacy compiler and must not break:
`cron.metric-alerts.ts`, `cron.measure-signals.ts`, `packages/mcp/src/tools/observability/telemetry.ts`,
`apps/api/src/agents/tools/metrics.ts`, `apps/start/src/components/chat/tool-handlers.ts`.

---

## 2. Decisions (deltas from the spec)

1. **`expr` is the source of truth; the rewriter is the tenancy gate.** Builder compiles to PromQL **without** the
   project label; the server injects it. `compileMetricQuery` stays for the legacy consumers above.
2. **Rewriter must also protect the response check.** `adaptMatrixToConcreteSeries` throws if a series lacks
   `op_project_id`. A raw `sum by (method)` strips it. So `rewritePromqlForProject` gains: append `op_project_id`
   to every `by (…)` grouping list (AggregateExpr), and reject `without (… op_project_id …)`. `count_values`,
   `label_replace`, `label_join` stay rejected. Queries with no labels at all (`scalar()`, `vector(1)`, `absent()`)
   are rejected at the response check with a clear message — accepted limitation.
3. **New JSON column `Report.metricQueries` (default `[]`)** holding `IPanelQuery[]`. `metricQuery` stays as a
   read fallback until the migration script has run, then is dropped in a later PR. Engine prefers
   `metricQueries` when non-empty. This is the "feature flag": new UI writes the new column, old rows still render.
4. **Do not put PromQL queries into the events `series[]` union.** Events series run through
   normalize → plan → fetch → compute (ClickHouse). Metrics dispatch on `dataSource` already. One `dataSource` per
   panel, as the spec says.
5. **Keep the interval selector.** It drives the bucket grid, the table and the x-axis for both sources. A per-query
   `minStep` is a floor on top of it. `maxDataPoints` stays the existing 1500 clamp.
6. **One migration** for everything schema-side (metricQueries, Dashboard.variables, `Annotation`,
   `PromqlQueryHistory`) so wave 0 touches `schema.prisma` once.
7. **Explore = the metrics route rebuilt** and it shares `QueryRows` with the report editor. Overrides doc 09 D13
   (single-query explorer). Split view deferred.
8. **Codemirror-promql completion is fed by a tRPC-backed `PrometheusClient`**, not by proxying Gigapipe HTTP.
   Only new dependencies: `@prometheus-io/codemirror-promql` and `@prometheus-io/lezer-promql` in `apps/start`.
9. **Partial failure = panel error.** If any query fails, the panel shows `Query B: <upstream message>` with an
   "Edit query" link. No half-rendered panels.
10. **No `Panel.variables` cache column.** `referencedVariables(expr)` is a cheap regex, computed where needed.

---

## 3. Contracts (code against these before the other session lands)

### 3.1 Zod (owner: dev2, `packages/validation/src/index.ts`)

```ts
export const zPromqlUnit = z.enum(['none','short','percent','percentunit','seconds','ms','bytes','ops']);

export const zBuilderOp = z.discriminatedUnion('op', [
  z.object({ op: z.enum(['rate','increase','irate','delta']), range: z.string().max(20) }), // '5m' | '$__rate_interval'
  z.object({ op: z.literal('histogram_quantile'), q: z.number().min(0).max(1) }),
  z.object({ op: z.enum(['sum','avg','min','max','count']), by: z.array(z.string().max(200)).max(10).optional(), without: z.array(z.string().max(200)).max(10).optional() }),
  z.object({ op: z.enum(['topk','bottomk']), k: z.number().int().min(1).max(100) }),
  z.object({ op: z.literal('binary'), operator: z.enum(['+','-','*','/']), rhs: z.string().max(2000) }),
  z.object({ op: z.literal('raw'), expr: z.string().max(4000) }),
]);

export const zPromqlBuilderState = z.object({
  metric: z.string().max(200),
  labelMatchers: z.array(z.object({ label: z.string().min(1).max(200), op: z.enum(['=','!=','=~','!~']), value: z.string().max(2000) })).max(20).default([]),
  operations: z.array(zBuilderOp).max(20).default([]),
});

export const zPanelQuery = z.object({
  refId: z.string().min(1).max(4),          // 'A', 'B', …
  expr: z.string().min(1).max(4000),        // ALWAYS what runs (after variable substitution + rewrite)
  mode: z.enum(['builder','code']).default('code'),
  builder: zPromqlBuilderState.optional(),
  legendFormat: z.string().max(200).optional(),
  hidden: z.boolean().default(false),
  unit: zPromqlUnit.default('none'),
  yAxis: z.enum(['left','right']).default('left'),
  minStep: z.string().max(20).optional(),   // '15s'
  instant: z.boolean().default(false),
});
export type IPanelQuery = z.infer<typeof zPanelQuery>;

export const zDashboardVariable = z.object({
  name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/).max(64),
  label: z.string().max(100).optional(),
  type: z.enum(['query','custom','interval']),
  query: z.string().max(500).optional(),     // label_values(<selector>, <label>) | label_names()
  options: z.array(z.string().max(500)).max(500).optional(),
  multi: z.boolean().default(false),
  includeAll: z.boolean().default(false),
  current: z.union([z.string(), z.array(z.string())]).optional(),
});
export type IDashboardVariable = z.infer<typeof zDashboardVariable>;

/** Values as resolved on the client; substituted server-side. */
export const zVariableValues = z.record(z.string().max(64), z.union([z.string().max(2000), z.array(z.string().max(2000)).max(200)]));

export const zAnnotationInput = z.object({
  projectId: z.string(),
  dashboardId: z.string().nullable().default(null),
  time: z.string(),                 // ISO
  timeEnd: z.string().nullable().default(null),
  text: z.string().min(1).max(2000),
  tags: z.array(z.string().max(50)).max(20).default([]),
});
```

`zReportInput` gains `metricQueries: z.array(zPanelQuery).max(10).default([])` and
`variables: zVariableValues.optional()`. `refineReportDataSource`: a `metrics` report needs
`metricQueries.length > 0 || metricQuery`; an events report must have neither.

### 3.2 Prisma (owner: dev2, one migration `add_promql_panels`)

```prisma
model Report     { … metricQueries Json @default("[]")  /// [IPrismaPanelQuery[]] }
model Dashboard  { … variables     Json @default("[]")  /// [IPrismaDashboardVariable[]] }

model Annotation {
  id          String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  projectId   String
  project     Project   @relation(fields: [projectId], references: [id], onDelete: Cascade)
  dashboardId String?   // null = global (every dashboard in the project)
  time        DateTime
  timeEnd     DateTime?
  text        String
  tags        String[]
  createdBy   String?
  source      String    @default("manual") // manual | api
  createdAt   DateTime  @default(now())
  @@index([projectId, time])
  @@map("annotations")
}

model PromqlQueryHistory {
  id        String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  projectId String
  userId    String
  expr      String
  createdAt DateTime @default(now())
  @@index([projectId, userId, createdAt])
  @@map("promql_query_history")
}
```

### 3.3 Pure helpers (owner: dev1, `packages/common/src/promql/`, browser-safe, no deps)

```ts
compileBuilder(state: IPromqlBuilderState): string           // left→right pipeline → nested PromQL, no project label
defaultOperationsFor(metric: string): IBuilderOp[]           // histogram → rate + sum by(le) + hq(0.95); counter → rate + sum; gauge → []
QUERY_PATTERNS: { id, label, description, state: IPromqlBuilderState }[]   // request rate, error rate, p50/p95/p99, saturation, top-k, increase
formatLegend(legendFormat: string|undefined, labels: Record<string,string>, ctx: { refId: string; multi: boolean }): string
   // '{{method}} {{status}}', '{{__refId}}'; fallback: labels as {k="v",…} minus op_project_id/__name__; then metric name; then refId
formatValue(value: number, unit: IPromqlUnit): string        // seconds→auto ms/µs; bytes→KiB/MiB/GiB; percent 0–1→%, percentunit 0–100
isAdditiveUnit(unit): boolean                                // none|short|ops → true
referencedVariables(expr: string): string[]                  // $name / ${name}, excluding $__*
substituteVariables(expr, values: IVariableValues, opts: { step: number; rangeSeconds: number; scrapeIntervalSeconds?: number }): string
   // $__rate_interval = max(4*step, 4*scrape(15s)) as Prom duration; $__interval = step; $__range = range
   // $name single → regex-escaped literal; multi → (a|b) regex-escaped; includeAll sentinel '__all__' → .+
   // escapes " and \ so a value can never leave the string literal it sits in
```

### 3.4 Engine + tRPC (owner: dev1)

```ts
// packages/db/src/engine/metrics/panel.ts
executeMetricPanel({ projectId, queries: IPanelQuery[], interval, startDate, endDate, previous?, variables? })
  : Promise<{ chart: FinalChart; compiled: { refId: string; promql: string }[]; notices: string[] }>
// per visible query: substitute → rewritePromqlForProject → assertPromqlScoped → downsample → queryRange | queryInstant
// → adapt (legend via formatLegend, series id = `${refId}:${sortedLabels}`, definitionIndex = query index)
// → format(allSeries, oneDefinitionPerQuery, includeAlphaIds=true, previous)
// on any query error: throw MetricsResponseError(`Query ${refId}: ${upstream message}`)

// packages/db/src/engine/index.ts: if dataSource==='metrics' → metricQueries.length ? executeMetricPanel : legacy executeMetricChart

// packages/trpc/src/routers/observability.ts
panel:        input { projectId, queries, interval, range, startDate?, endDate?, previous?, variables? } → executeMetricPanel result (page-local; Explore)
queryHistory: input { projectId, search? } → last 50 exprs for ctx user
recordQuery:  mutation { projectId, expr }  (dedupe consecutive identical, trim to 50 per user)
variableOptions: input { projectId, query: string, startDate, endDate } → string[]   // label_values(sel, label) via labelValues service; label_names() via labelKeys
```

`chart.chart` (saved reports) passes `metricQueries` + `variables` through `executeChart`; nothing else changes.

### 3.5 Frontend component contract (owner: dev3, `apps/start/src/components/promql/`)

```
promql-code-editor.tsx   CodeMirror 6 + @prometheus-io/codemirror-promql; lint on; Cmd/Ctrl+Enter → onRun; completion via trpc-prometheus-client.ts
trpc-prometheus-client.ts implements codemirror-promql's PrometheusClient over observability.metricNames/labelKeys/labelValues (metadata → {}, series → [])
promql-builder.tsx       metric combobox (kind badge from inferMetricKind), label matcher rows, operation chips (+ add), read-only compiled preview, rate-removed warning
builder-parse.ts         PromQL → IPromqlBuilderState | null (lezer, apps/start dep); null ⇒ builder tab disabled with tooltip
query-row.tsx            [refId] Builder|Code  [hide][duplicate][delete]; options row: legend, unit, y-axis, min step, instant (metric chart only)
query-rows.tsx           list + "+ Add query" + "Query patterns" dropdown; value: IPanelQuery[]; onChange
```

State: `reportSlice` gets `metricQueries: IPanelQuery[]` with `setMetricQueries`, `addMetricQuery`, `updateMetricQuery(refId)`,
`removeMetricQuery`, `duplicateMetricQuery`. `changeDataSource('metrics')` seeds `[ { refId:'A', expr:'', mode:'builder' } ]`.

---

## 4. Phase map → waves

| Spec phase | Wave | Owner |
|---|---|---|
| §3 backend path, guardrails, proxies | 0 | dev1 |
| §2 data model, migration script (dry-run) | 0 | dev2 |
| Phase 1 editor (code + builder), wired to report editor | 0 | dev3 |
| Phase 2 multi-query renderer, units, dual axis, table | 1 | dev1 |
| Phase 4 dashboard variables | 1 | dev2 |
| Phase 3 Explore page, then run migration | 1 | dev3 |
| Phase 6 annotations | 2 | dev2 |
| Phase 5 correlation | 2 | dev3 |
| Docs, review, legacy cleanup, final gate | 2 | dev1 + manager |

---

## 5. Wave 0 (parallel, disjoint files)

### dev1 — backend query path
1. `packages/common/src/promql/{compile-builder,legend,units,variables,patterns}.ts` + `*.test.ts` (table-driven,
   every `BuilderOp`, every unit, every variable form). Export from `packages/common/src/index.ts`.
2. `packages/gigapipe/src/promql/rewrite.ts`: `by (…)` injection, `without` guard; tests for `sum by (m)`,
   `sum without (instance)`, nested aggregations, `histogram_quantile(0.95, sum by (le) (rate(x[5m])))`, binary
   ops, subqueries, `topk`. `packages/gigapipe/src/client.ts`: `queryInstant` (POST `/api/v1/query`, same error
   handling). Export both from `packages/gigapipe/index.ts`.
3. `packages/db/src/engine/metrics/panel.ts` + `panel.test.ts` (mock `queryRange`), adapter changes for legend/refId
   naming (keep `assertOwnedBy` first), `packages/db/src/engine/index.ts` dispatch.
4. `packages/trpc/src/routers/observability.ts`: `panel`, `queryHistory`, `recordQuery`, `variableOptions`.
   `packages/trpc/src/routers/chart.ts`: pass `variables` through.
5. Until dev2's zod lands, define the input types locally as `import type` from validation and stub with a local
   interface if needed; swap when dev2 pings.

### dev2 — schema, validation, migration
1. Zod contracts in §3.1 **first**, typecheck `packages/validation`, then message dev1 and dev3.
2. Prisma changes in §3.2 + migration via `prisma migrate diff` (as done for SEO; strip the banner), `prisma-json-types.ts`
   entries, `pnpm codegen`.
3. `packages/db/src/services/reports.service.ts` (read/write `metricQueries`), `dashboard.service.ts` (variables),
   `packages/trpc/src/routers/report.ts` create/update field lists + tests, `packages/trpc/src/routers/dashboard.ts`
   `updateVariables`, new `packages/trpc/src/routers/annotation.ts` (list by project+dashboard+range+tags, create,
   delete) registered in the root router, `apps/api` `POST /api/annotations` authenticated with the project client
   secret (follow the existing client-auth pattern in `apps/api/src/routes`), returning the row.
4. `packages/db/scripts/migrate-metric-panels.ts` with `--dry-run` printing before/after per report: legacy
   `metricQuery` → `[{ refId:'A', mode:'builder', builder, expr: compileBuilder(builder), unit: inferMetricUnit }]`.
   Mapping: `fn rate/increase/delta + window` → op; `aggregation sum/avg/…` → op with `by: groupBy`; `p50..p99` →
   `rate` + `sum by (le, …groupBy)` + `histogram_quantile`; `raw` on a counter/histogram → prepend `rate` and print
   "auto-converted". Add `package.json` script `migrate:metric-panels`. Unit test the mapping.

### dev3 — editor
1. Add `@prometheus-io/codemirror-promql` + `@prometheus-io/lezer-promql` (pin the same 0.314 line) to `apps/start`.
2. Build everything in §3.5 with local state first; compile preview uses `compileBuilder` from `@openpanel/common`
   (after dev1's step 1 lands; until then a local copy is acceptable **only** inside the component, deleted on swap).
3. Wire into `report-editor.tsx` + `reportSlice.ts` + `ReportSaveButton.tsx` + `modals/save-report.tsx` so a metric
   report saves `metricQueries`. `MetricQueryEditor` stays in the tree unused (deletion needs user sign-off).
4. Interim: metrics route renders one `QueryRow` and runs through `observability.panel` once dev1 lands.
5. Acceptance: typing `histo` offers `histogram_quantile`; `http_req` offers real metric names; a syntax error
   underlines before Run; picking `http_request_duration_seconds_bucket` seeds rate→sum by(le)→hq(0.95).

Wave 0 exit: repo `pnpm typecheck` green, package-local vitest green, a metric report with two queries saves and
renders through `chart.chart` (legend may still be single-axis).

---

## 6. Wave 1

### dev1 — renderer for multi-query (Phase 2)
`report-chart/{line,area,histogram,metric}/chart.tsx`, `common/{axis,report-chart-tooltip,report-table,report-table-utils,error}.tsx`,
`hooks/use-numer-formatter.ts`. Per-series unit + `yAxisId` from `FinalChart` (carry `refId`, `unit`, `yAxis` on the
series via the definition — dev1 adds that in the engine), second `YAxis` when any visible query is `right`,
`formatValue` in axis/tooltip/table, hide `Sum` and add `Last` when no visible query is additive, stable colours by
series `id`, error card shows upstream message + "Edit query" link (report id known) — no toast. Leave a
`<AnnotationsLayer />` slot prop on line/area charts for dev2's wave 2 work. Metric (stat) chart uses `instant`
queries and shows a sparkline from the range run.

### dev2 — dashboard variables (Phase 4)
`apps/start/src/components/dashboard/variables/*` (bar, editor modal), dashboard route wiring, `variableOptions`
consumer, URL state for current values via `nuqs` (`var_<name>`), pass `variables` into each panel's `chart.chart`
call **filtered to `referencedVariables(expr)`** so only panels that reference a changed variable refetch. Variable
substitution in panel titles. Explore receives `variables` when opened from a dashboard.

### dev3 — Explore (Phase 3)
Rebuild `_app.$organizationId.$projectId.metrics.tsx`: range/zoom/refresh toolbar, `QueryRows`, Run (Cmd+Enter),
result chart via `observability.panel` + `ReportChart data=` (doc 09 D2; add the `data` prop if not present), result
table (series → labels → last value, click to toggle), query history drawer (`queryHistory`/`recordQuery`), "Add to
dashboard" through the existing `SaveReport` modal carrying `metricQueries`, URL state (`nuqs` JSON of
`{expr,legendFormat,hidden,unit,yAxis}[]` + range + refresh), drag-to-zoom via Recharts `ReferenceArea` setting an
absolute range. Then run `migrate:metric-panels --dry-run` locally against a seeded DB, review output with the manager.

---

## 7. Wave 2

- **dev3 — correlation (Phase 5).** `validateSearch` on logs/traces routes (`range|start|end`, `service`, `level`,
  `q`, `minDuration`, `trace`), state moves to the URL. Metric charts' `ChartClickMenu` gains "View logs for this
  range" / "View traces for this range" (bucket ±1 step; service from `service_name`/`job`/`service` label, else
  `$service`). Logs: trace-id regex (`trace_id=`, `traceID=`, `traceparent`) → links; "Show traces around this time".
  Traces: "Logs for this span" (reuse `observability.logsForTrace`, ±2s, contains trace id). Logs → "Open in Explore"
  prefilled rate query when a counter with a matching `service_name` exists.
- **dev2 — annotations (Phase 6).** `AnnotationsLayer` (ReferenceLine / ReferenceArea + hover), Cmd/Cmd+click create
  modal, dashboard toolbar tag filter + toggle, settings page curl example for `POST /api/annotations`.
- **dev1 — docs + review + hardening.** `docs/observability/16-querying-metrics.md` (rate/increase/quantile in three
  paragraphs + patterns list + annotation webhook example), review dev2/dev3 diffs, MCP `telemetry` tool optional
  `queries` input, chat `tool-handlers.ts` compatibility, remove `MetricQueryEditor` **only after** user sign-off.
- **Manager.** Final `pnpm typecheck`, `pnpm check` on touched files (no formatting runs), per-package vitest, commit
  decision with the user, deploy, run `migrate:metric-panels` against production after a dry-run review.

---

## 8. Acceptance (from the spec, kept)

1. Code mode: `histo` → `histogram_quantile`; `http_req` → real names; syntax error underlined pre-Run; Gigapipe's
   upstream error text shown in the panel.
2. Git Operations panel rebuilt as p95 via the builder shows low-ms values with no sawtooth (check on the deployed
   `gitgraph` project against the Logs page).
3. One panel: A = request rate by method, B = p95 on the right axis, correct units, legends from `legendFormat`,
   colours stable across refreshes.
4. Shared Explore URL reopens identically; "Add to dashboard" yields the same panel.
5. `$service` from `label_values(up, service_name)` drives four panels; changing it refetches those four only.
6. From a p95 spike, two clicks reach the log lines for that minute.

---

## 9. Ownership map

| Path | Wave 0 | Wave 1 | Wave 2 |
|---|---|---|---|
| `packages/validation/src/index.ts` | dev2 | dev2 | dev2 |
| `packages/db/prisma/**`, `prisma-json-types.ts`, `packages/db/scripts/**` | dev2 | dev2 | dev2 |
| `packages/db/src/services/{reports,dashboard}.service.ts` | dev2 | dev2 | — |
| `packages/common/src/promql/**`, `packages/common/src/index.ts` | dev1 | dev1 | dev1 |
| `packages/gigapipe/**` | dev1 | dev1 | dev1 |
| `packages/db/src/engine/**` | dev1 | dev1 | dev1 |
| `packages/trpc/src/routers/observability.ts`, `chart.ts` | dev1 | dev1 | dev1 |
| `packages/trpc/src/routers/{report,dashboard,annotation}.ts`, root router | dev2 | dev2 | dev2 |
| `apps/api/src/routes/annotations*` | dev2 | — | dev2 |
| `apps/start/src/components/promql/**` | dev3 | dev3 | dev3 |
| `apps/start/src/components/report/{reportSlice.ts,ReportSaveButton.tsx}`, `report-chart/report-editor.tsx`, `modals/save-report.tsx` | dev3 | dev3 | dev3 |
| `apps/start/src/components/report-chart/{line,area,histogram,metric,common}/**` | — | dev1 | dev1 (dev2 for `annotations-layer.tsx`) |
| `apps/start/src/hooks/use-numer-formatter.ts` | — | dev1 | — |
| `apps/start/src/components/dashboard/variables/**`, dashboards route | — | dev2 | dev2 |
| `apps/start/src/routes/…metrics.tsx` | dev3 (interim) | dev3 | dev3 |
| `apps/start/src/routes/…{logs,traces}.tsx` | — | — | dev3 |
| `docs/observability/**` | manager | — | dev1 |

Rules: **never `git stash` on the shared checkout** (use a scratchpad `git worktree` for clean-tree comparisons); `pnpm typecheck` at the package level before reporting done; never run formatting; add tests beside the
code; message the owner for anything outside your column; report to `openpanel-manager` with files touched, test
counts, and anything the contract in §3 had to change.

---

## 10. Deviations log (accepted by the manager)

Wave 0, dev2 (2026-09-07):
- `metricQueries` on `zReportInput` is `.optional()`, not `.default([])` — a zod default makes the output field required and breaks every existing chart-input constructor. Callers check `metricQueries?.length`.
- `refineReportDataSource` reports on path `['metricQueries']` with "A metrics report needs at least one metric query".
- Annotation ingest is `POST /annotations` (apps/api has no `/api` prefix). Credential allow-list is `write` + `root` (an annotation is a write; a deploy hook holds the track secret). Secret mandatory. Validator in `apps/api/src/utils/auth.ts`, handler in `src/controllers/annotation.controller.ts`.
- `migrate:metric-panels` is dry-run by default; `--apply` writes.
- Migrated rows keep their legacy `5m` window; only raw counters/histograms (which had none) get `$__rate_interval` and are reported as auto-converted. Percentile aggregations on non-`_bucket` metrics are skipped (they never rendered).
- Migration `20260907120000_add_promql_panels`, generated offline with `migrate diff`; not applied anywhere.

Wave 0, dev1 (2026-09-07):
- Rewriter adds `by (op_project_id)` to bare aggregations too (`sum(rate(x))` is the default counter query and would otherwise fail the response check). `count_values` added to the forbidden list (it was not there). `assertPromqlScoped` also checks every aggregation modifier. Rewriter re-parses its own output.
- `minStep` is a floor on the panel step (widest visible query wins, with a notice), because `format()` aligns all series on one bucket grid.
- Query failures keep `GigapipeError` class and status (so 413 "narrow the range" survives); message is `Query B: <upstream>`.
- Series cap is per query, not per panel.
- `variableOptions` takes `range` + optional dates (server resolves presets and timezone); supports `label_values(label)`, `label_values(metric, label)`, `label_names()`; throws instead of returning `[]`.
- `chart.ts` needed no change: `zReportInput` already carries `metricQueries`/`variables`, and the cache key is the raw input.
- Step/grid/cap helpers extracted to `packages/db/src/engine/metrics/step.ts`; `executeMetricChart` unchanged.
- Per-series `{ refId, unit, yAxis }` is typed on `IChartSerie` (dev2 added `IChartSeriePanel`) so the renderer reads it off `FinalChart`.

Follow-ups (wave 2, dev1): `variableOptions` ignores the time window (`time_series_gin` is a series index, so options are a superset of the range); `label_values(up{job="api"}, pod)` is rejected because the metadata service scopes by metric + project only. Both need matcher/time support in `telemetry-metadata.service.ts`.

Wave 1, dev2 (2026-09-07):
- Variable URL state is one `useQueryStates` over `var_<name>` keys; multi values comma-joined (a value containing a comma is a known ambiguity, documented). Explore hand-off reuses the same keys.
- Panels wait on the skeleton only while variable options are LOADING; a failed option query shows the error on the control and lets panels through.
- Client-side validation of variable queries mirrors the server's three accepted forms.
- Known: `name` is part of the chart input, so a panel whose title alone references a variable refetches on change. Fix is stripping `name` from the query key in `report-chart/context.tsx` (dev1, wave 1).
- Selective-refetch acceptance asserted by test on the chart-input keys (45 tests); browser-level confirmation still owed once Explore is up.

Wave 0, dev3 (2026-09-07):
- `$__rate_interval` and `$var` are not parseable PromQL, so `promql-variables.ts` masks them with equal-length duration tokens before any client-side parse; `promql-lint.ts` keeps the full upstream linter for variable-free queries and falls back to a masked syntax-only check otherwise. Server substitution is unaffected.
- `panel-query.ts` holds the refId allocator and the explicit spelling of `zPanelQuery` defaults, shared by reportSlice, QueryRows and the metrics route.
- The builder never emits what `builder-parse` cannot read: the `raw` op is left out of the menu (code mode is the escape hatch); the step-less subquery form `rate((sum(x))[5m:])` round-trips.
- Repo fact: `@prometheus-io/codemirror-promql` has no `exports` map; Vite bundles one `@codemirror/state` but Node/vitest resolves a second copy, so any test constructing a real EditorState fails. `test.server.deps.inline` cannot fix it because `wrapVinxiConfigWithSentry` drops the `test` key from `apps/start/vite.config.ts`. Editor mount is verified by a lib build run in Node, not by a committed test. A separate `vitest.config.ts` for apps/start is the eventual fix (final-gate list).
- `components/json-editor.tsx` wraps oklch tokens in `hsl()`, which yields an invalid border colour (latent, untouched).
- Browser pass of the mounted editor (theme, Cmd+Enter) still owed before the wave 2 gate.

Wave 2, dev2 (2026-09-07):
- Metadata service: `ITelemetryLabelMatcher` (`=`/`!=` only; regex ops throw because the table's primary key stops at `key`) and `ITelemetryMetadataScope { metric?, matchers?, startDate?, endDate?, limit? }` on all four lookups. `time_series_gin` is partitioned by `date`, so the range bound prunes partitions and the picker becomes a subset of the window (30-day gigapipe TTL is the ceiling). Label/metric names are validated as identifiers and THROW instead of returning `[]` (behaviour change; `variableOptions` maps it to BAD_REQUEST). Verified against seeded ClickHouse including a cross-project negative.
- Annotations: recharts 2.15 does not draw `ReferenceLine`s inside a Fragment passed as a child, so the layer is a function returning `ReactNode[]` (`renderAnnotations()`), with a jsdom test rendering inside a real LineChart. `annotation.list` takes `range` + optional dates and returns `{ annotations, window }` so markers use the same resolved window as the panels. Toggle is per-dashboard localStorage read in an effect (SSR hydration); tag filter is in the URL. Curl example lives on the Tracking script settings tab (no telemetry tab exists).
- Plumbing `annotations` through `ReportChartProps` → line/area `<Chart>` and the Cmd/Ctrl+click "Add annotation" hook are dev1's (wave 1 renderer).

Wave 1, dev1 (2026-09-07):
- Colours: hash of series id to a preferred palette slot with forward probing, assigned in sorted-id order, so the result depends only on the SET of series and is collision-free while series ≤ palette. Root cause was `format()` sorting by sum, which reorders on every refresh. Events reports keep index colouring. Tooltip swatch now comes from the same map via context.
- Area charts stack per axis; histogram honours unit but ignores `yAxis: 'right'` (documented); `allowDecimals` only with a typed panel unit; stat card shows last value for panel series only; Last replaces Sum over VISIBLE series, group summary Last is the mean.
- `percent` = 0–100, `percentunit` = 0–1 (both render as %).
- `name` stripped from the chart query key EXCEPT for legacy structured metrics reports (no `metricQueries`), which name their series from it.
- Annotations slot typed `React.ReactNode[]`; `options.onModifierClick` on ChartClickMenu (ref-held); empty-menu open fixed.
- `variableOptions` accepts `label_values(metric{k="v"}, label)`, rejects regex ops with a message, maps `TelemetryMetadataError` to BAD_REQUEST, passes the resolved window through.
- Doc 09 D2 `data` prop delivered on linear/area/histogram/metric via `useOwnedChartResult()`; `options.onRangeSelect` drag-to-zoom on line/area.
- Acceptance §8 item 3 asserted at engine level (`metrics/acceptance.test.ts`); browser check still on the final gate.

Follow-ups: `@lezer/lr` peer dep missing in apps/start (dev3); `chat-report-result.tsx` should take the `data` prop; `use-rechart-data-model.ts` bakes a dead index-derived colour.

Wave 1, dev3 (2026-09-07):
- Zoom-out derives its window from the drawn bucket grid (server-resolved, project timezone), not the range picker; centred except at the live edge (extends backwards only within 5 minutes of now); disabled until there is a result.
- A shared URL auto-runs on arrival and does not write history; editing a row never auto-runs.
- URL `q` and "Add to dashboard" both read the live rows; `q` encodes expr + display fields only (builder state is recovered by parse); `?chart=` restricted to METRIC_CHART_TYPES; row toggles are local state, not `visibleSeries`.
- `promqlEditorExtensions` extracted so the dedupe proof-test builds the real extension list. Mod-Enter double-run fixed (guard on `defaultPrevented`).
- `vite build` of apps/start succeeds with exactly one `@codemirror/state`; the duplicate is vitest-only.
- Browser pass: no browser automation in the session; a self-contained HTML build of the real editor with the five checks was sent to the user. Still unobserved.
- Migration dry-run blocked: no root `.env` / DATABASE_URL, and the local `openpanel-op-*` containers are the user's deployment. Manager/user to run.

Final-gate infra, dev2 (2026-09-07):
- CodeMirror under vitest: NOT two versions. `@codemirror/state` has `exports` with `import`/`require` conditions; codemirror-promql's CJS `main` pulls `dist/index.cjs` while the app holds `dist/index.js`, so one package loads twice. `server.deps.inline`, `mainFields` and `dedupe` all fail (dead ends recorded in `apps/start/vitest.config.ts`); a one-line `resolve.alias` to the ESM build fixes it. Config typed against `UserConfig` from `vitest/config` (vitest 3.1 pins vite 6, the plugins resolve vite 7). `promql-extensions.test.ts` builds the real extension list and constructs a state.
- `chart-sql.test.ts`: the two cohort tests reached Postgres (`fetchProjectCohorts`) behind a ClickHouse-only skip guard and asserted "0 cohorts" by hope; now stub `db.cohort.findMany` → `[]` and assert the stub was called. Code was correct.
- `json-editor.tsx`: five `hsl(var(--…))` → bare tokens; repo count now zero.
- Review fixes: migration now carries the legacy display `unit` (`'%'` → `percentunit`, not `percent`, or values render 100× too small); variable-query client validation made permissive; marker click-to-delete built and `canDelete` removed (server is the authority). Annotations reach the plot via `annotationNodes` → ReportItem → ReportChart slot; `onModifierClick` opens the create modal.
- Owed: multi-day `time_series_gin` fixture proving rows are written per day (doc 10 says so).

Wave 2, dev1 (2026-09-07):
- Review of dev3 Explore: HIGH — `windowFromChart` returned `formatClickhouseDate` strings (`"2026-09-07 10:00:00"`, UTC, no zone marker) and `zoomOut` parsed them with `new Date(...)`, which JS treats as LOCAL time; window shifted by the browser offset and the live-edge branch stopped firing. All test fixtures were ISO, so CI on UTC never sees it. Fix sent to dev3. Everything else clean (arrival auto-run is a lazy initialiser, URL parse re-validates each query via zPanelQuery, `exprsToRecord` dedupe).
- `chat-report-result.tsx` uses the D2 `data` prop with a runtime shape guard (tool output is `unknown`); dead index colour removed from `use-rechart-data-model.ts`, tooltip now takes an `id → colour` map from the charts; `options.extraMenuItems` added for correlation (area chart gained `serieId`).
- MCP `query_metric`: `metric` optional, `queries[]` routes to `executeMetricPanel`, wins over `query` if both sent; structured path untouched (7 tests). `apps/api` agent tools and chat handlers needed no change (engine fallback + dispatch tests).
- Docs: `16-querying-metrics.md` (132 lines) and `14-decisions.md` D17 (both reversals, and that the rewriter now carries the tenancy label through aggregation).

Final gate, dev2 (2026-09-07):
- Multi-day fixture `telemetry-metadata.date-bound.test.ts` (6 tests, live ClickHouse, skip-if-unreachable) proves `time_series_gin` is one row per series per day. Gotcha: the table has `TTL date + 30 days`, so rows dated older than 30 days are dropped AT INSERT (ClickHouse returns 200 and keeps nothing); fixtures must use dates relative to today.
- Public docs: `apps/public/content/docs/dashboard/{metrics-panels,dashboard-variables,metrics-explore,annotations}.mdx`, registered in `meta.json`; substitution rules and unit tables identical to doc 16. Metrics → logs/traces section carries a "being built" callout until dev3's correlation lands (dev2 to update).

Lint sweep, dev1 (2026-09-07): `biome lint` (not `pnpm check`, whose 507 format-only diagnostics are out of scope) over the 92 changed files against a HEAD baseline in a scratchpad worktree. dev1 columns 15 → 0 (two `noBitwiseOperators` suppressed in `series-color.ts`: FNV-1a needs them). 133 pre-existing findings in touched files left alone (83 in `report-table.tsx`). Manager decision: `complexity/noVoid` turned off in `biome.json` (CI runs no lint; `void setX(...)` is the existing nuqs convention). Note: biome silently lints zero files outside its project root, so a worktree baseline must be run with the main repo's binary from inside the worktree. CI has no non-UTC timezone run; the zoom-out/correlation date bug would only show under one.

Wave 2, dev3 (2026-09-07):
- Correlation shipped: `components/telemetry-links/{telemetry-urls,trace-ids,use-explore-suggestion,use-metric-correlation-items}`, `utils/chart-dates.ts` (`parseChartDate`/`chartDateToIso`, the ONE place a zone-less chart bucket string is read), logs/traces routes on nuqs (not `validateSearch`, which strips unknown keys), absolute dates supersede the preset and disable Follow, `resolveTelemetryWindow` shared between link builders and pages. 295 apps/start tests under UTC, Europe/Stockholm and America/Los_Angeles; timezone tests assert the naive reading would differ.
- Drag-selection variant of "View logs for this range" not built: `consumeDrag()` means a drag never produces a menu; click inside the zoomed window instead.
- Same date bug found in dev2's Cmd-click annotation handler (fixed via `parseChartDate`) and in four `report-chart/{line,area,histogram,conversion}/chart.tsx` AddReference items that WRITE `new Date(clickedData.date).toISOString()` to the database (dev1 to fix).
- CI: `TZ: America/Los_Angeles` added to the test step by the manager.
- Biome note: the repo pins `@biomejs/biome@2.3.15` via ultracite 7.2; use `pnpm exec biome`, not a global binary.

Review of dev1 by dev2 (2026-09-07), probed with ~30 crafted queries against the real rewriter:
- MEDIUM: forbidden-function regex (`\blabel_replace\s*\(`) is evaded by a comment between name and paren (`label_replace # x\n(...)`); passes rewrite + scoping assertion. No cross-project read (selector still scoped) and the panel path's `assertOwnedBy` drops a forged value, but `observability.rawQuery` returns the raw response with no ownership check. Fix: reject by parse-tree node; manager decision: delete `rawQuery` (no callers, superseded by `panel`).
- MEDIUM: four AddReference sites persist a locally-parsed bucket date (already assigned to dev1). dev2's own Cmd-click handler had it too; fixed.
- LOW: per-query series cap means a 10-query panel can reach 200 series (palette ~20); `assertPromqlScoped` selector check is a substring test (make structural); possible `showsSumColumn` edge with empty `visibleSeries` (unverified).
- Verified good: 20 other attack shapes scoped; 8 hostile variable values stay inside their literal; substitute → rewrite → assert ordering; hidden queries filtered before execution with `definitionIndex` preserved; history userId from session only; MCP caps match zPanelQuery.
- dev2 retracted one finding ("chart-dates.ts has zero callers"), caused by a truncated grep.

Dashboard correlation wiring, dev2 (2026-09-07): `components/dashboard/dashboard-panel.tsx` wraps each metrics panel so the hook sees the panel's own interval; events panels get no items. Limitation: a dashboard panel cannot map a clicked series id back to its labels (the chart fetches inside ReportChart), so service falls back to `$service` until dev1 adds the clicked series' `breakdowns` to the `extraMenuItems` payload. Docs: callout replaced in `metrics-explore.mdx`, both directions documented, dashboard limitation called out; no `rawQuery` mention existed.

Security fixes, dev1 (2026-09-07): forbidden functions rejected by grammar node (`LabelReplace`/`LabelJoin`/`CountValues`), regex gone; `label_replace/**/(` and split identifiers fail as unparseable. `assertPromqlScoped` now reads the LabelMatchers subtree (name, `=` op, exact value); the substring form was exploitable via single-quoted and backtick strings (`up{job='op_project_id="victim"'}` passed before). `rawQuery` deleted. Panel-wide cap `DEFAULT_SERIES_LIMIT × 2` filled round-robin across queries, largest peak first. `showsSumColumn([])` was reachable (untick all rows) and now falls back to the full set. Four AddReference sites use `chartDateToIso`, with a test that fails if `new Date(clickedData.date)` returns. `labels` on `extraMenuItems` for line/area/histogram, built from ALL series. rewrite tests 40 → 54.
Correlation review by dev1: MEDIUM — `trace-ids.ts` accepted the all-zero id (OpenTelemetry `INVALID_TRACE_ID`, emitted for every line with no active span), producing dead links at volume; LOW — `traceparent` version `ff` accepted. Both to dev3. Display-only chart-date readers (tooltips, dashed-last-segment `isSameHour/Day`) are off by one bucket at zone boundaries; dev1 fixing the ones in their files.

Closeout, dev2 (2026-09-07): dashboard-panel.tsx passes no `chart`; service resolves from the clicked series' payload labels on dashboards and Explore alike, `$service` only when no series resolves. Docs name the chart types: line/area have correlation menu + Cmd-click annotations + annotations layer; histogram has the correlation menu only; stat has none. Product follow-up: should histogram get annotations and modifier-click? apps/start 19 suites / 321 tests, apps/public typecheck clean.

Closeout, dev3 (2026-09-07): all-zero trace id (OTel `INVALID_TRACE_ID`) and all-zero span id rejected, leading-zero ids still resolve; `traceparent` version `ff` rejected. Payload-first labels in `useMetricCorrelationItems` pinned by a test where the chart disagrees with the payload. Traces route gained a "Linked trace" card so `?trace=<id>` renders even when the trace is outside the 50 most recent (untested by agreement: a JSX conditional over three query states). apps/start 321 tests under UTC and Los_Angeles; `biome lint` clean on telemetry-links.

Closeout, dev1 (2026-09-07): D17 updated (rawQuery deleted, grammar-node checks incl. the quote forms). Display-only readers in tooltip (incl. `getMatchingReferences`, which picks reference markers per bucket) and the line/area "now" dot and dashed-last-segment fixed via `parseChartDate`; 10-case TZ-guarded test verified to fail on revert. Final lint caught histogram `extraMenuItems` half-wired (`items.push` never applied; `noUnusedVariables` on `serieId`) — now wired. Follow-up ticket, display-only, untouched: `pie/chart.tsx:41`, `conversion/summary.tsx:175-185`, `organization/billing-usage.tsx:273`.
