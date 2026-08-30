# UI surfaces in `apps/start`

**Work-stream: front-end.** **Phases: P2 (metrics), P3 (logs shell), P4 (traces shell + correlation), P6 (services, polish).**

This stream owns three things and deliberately not a fourth. It owns **the shared shell** — the sidebar Observability group, the five routes, capability gating, the first-run/empty/error/blocked states, and `/settings/telemetry`. It owns **the metrics explorer**, the only telemetry surface no sibling spec has claimed (`03-metrics-engine.md` § Interfaces: *"the picker's UI belongs to `ui.md`"*). And it owns **the report-integration seams** that let a metric query be saved as an ordinary `Report` row and rendered by the chart components that already exist. It does **not** re-specify the log explorer or the span waterfall: `05-logs.md` §7 and `06-traces-and-correlation.md` §7 already name every file, hook and virtualiser for those, down to `getItemKey` on `spanId`; this document lists only the seams they share with the rest of `apps/start`. The single load-bearing change is **D2 — `<ReportChart>` gains a `data` prop.** Every other hard problem in the draft this replaces (a query firing on first paint, no home for the compiled PromQL, 30 sparkline round-trips, a double-fetch to read `notices`) dissolves once the caller can hand a `FinalChart` to a renderer instead of making the renderer refetch it.

Every file path below was opened at `247744a8`; gigapipe at that checkout's HEAD. Line numbers are `grep` hints, prose anchors on symbols. Claims I could not settle from disk are marked `UNVERIFIED:` with the thing that settles them.

---

## Revision note — cross-spec settlements adopted in this pass

A joint read of all eleven specifications found this document asserting several things its siblings contradict. Every one is settled below, in the direction the evidence supports rather than in this stream's favour, and each is marked with what the other document now has to change. **Where a row says "changes X", that document has not yet been edited — this is the ask.**

| # | Settled | This document's old position | Why this way |
|---|---|---|---|
| S-A | **`zMetricQuery` is exactly `03-metrics-engine.md` §2 as written today** — `filters: zMetricLabelFilter[]` with `operator: eq\|neq\|re\|nre`, an eleven-member `fn`, `metricType` including `summary`, `window` including `auto`, `scale`, and **no** `seriesLimit`, **no** `matchers`, **no** `fill` | D3 described a fourth shape ("consumed verbatim" while quoting a schema that exists nowhere) | 03 owns the file and is the only version whose `fn` set is proved a subset of gigapipe's accelerated `rangeFns`/`aggFns` (03 §0, T-C6). **Changes:** `01-tenancy-and-security.md` §7.2's schema block becomes a pointer (keeping only the reserved-prefix refinements); `11-testing-strategy.md` Q1–Q3 rename `zMetricMatcher` → `zMetricLabelFilter`; `07-alerting.md` Q1 closes as "03 §2's current body, not the shape Q1 quotes" |
| S-B | **There is no `Report.dataSource` column and no `DataSource` enum.** Dispatch is `getReportDataSource(series)` (`packages/db/src/engine/data-source.ts`, 03 §15.1) over `series.some(s => s.type === 'metric')` | D8's whole table was built on the column; D5, F2, F4 and the Effort table priced it | The discriminator has to arrive on `zReportInput.series` regardless — `ctx.report` is `null` on every non-shared query (`chart.ts:139`) — so the column buys a filterable index and costs an irreversible Postgres enum plus three write literals. **Changes:** `08-schema-changes.md` deletes S1, the `<ts>_report_data_source` migration, its inventory row, its sequencing row and its rollback row, and retargets its nine-site table at the *series union member* (that inventory is correct and valuable; only its subject was wrong); `04-read-path.md` D4's cost paragraph loses the column |
| S-C | **One chart envelope: `MetricChartResult = FinalChart & { notices: MetricNotice[]; resolution: {...} }`** (03 D2's structural supertype), with 04 D5's `resolution` fields merged in as additional properties rather than a `{ chart, resolution }` wrapper | D14/D15 described a third shape and claimed 03 adds `notices?` to `FinalChart` — the opposite of what 03 D2 says | 03 owns the engine return type; the supertype preserves 04 D5's stated property (renderers keep typing against `IChartData`) without editing `FinalChart`. **Changes:** `04-read-path.md` D5 drops the `IObservabilityChartResult` wrapper and moves `resolution` onto `MetricChartResult` |
| S-D | **The notice catalogue is 03 D2's seven codes**: `series_capped`, `interval_coarsened`, `rate_window_widened`, `increase_window_pinned`, `gaps_filled_with_zero`, `non_finite_samples_dropped`, `previous_period_unavailable` | D15 listed seven different codes, only one of which overlapped | 03 owns them and each names an action the engine took |
| S-E | **Router namespace: `observability.{metrics,logs,traces,status}` on one router**, base procedure `protectedProcedure.use(rejectShareId)` per `04-read-path.md` D13, plus its kill switch and `NO_PROJECT_ID` allow-list. Saved-report execution stays on `chart.*` (D5) | Q1, open and blocking | 04 D13 is right against `01-tenancy-and-security.md` §7.1's hand-rolled `publicProcedure`: re-deriving `enforceAccess` opts the router the plan calls a security boundary out of every future change to the repo's central access middleware. **Changes:** `05-logs.md` §5.3's `logsRouter` folds under `observability.logs.*`; `03`'s `packages/trpc/src/routers/metrics.ts` procedures move under `observability.metrics.*`; `01` §7.1's code block becomes a pointer; `11`'s file paths follow |
| S-F | **Package homes:** `packages/gigapipe` holds transport, error taxonomy, lease, kill switch, label constants and the compilers (04 D1). `getTelemetryClient`, `TELEMETRY_TABLES` and `gigapipeTable` live in `packages/db` (08 S10/S11), because they need the existing ClickHouse client machinery. One exported table constant, shared by the retention sweep, the deletion function and the T2 teardown (11 I14) | not stated | Four homes were proposed across 04/05/08; three documents marked it blocking. **Changes:** file paths in 03, 05, 08 and 11 swept in one mechanical PR |
| S-G | **The point budget is `cfg.maxPoints = 3000` and the step is the *coarsest* fitting sub-bucket** (`resolveStep`, 03 §6.1/§6.3/D7). Over-budget is reported by the `interval_coarsened` **notice**, and that is the only user-facing message | Interfaces item 5 said "8 000-point engine ceiling" — a third number | 03 owns the grid. **Changes:** `04-read-path.md` deletes or rewrites `resolveStepMs`/`clampStep` and its `TARGET_MAX_POINTS = 1_500`. `resolution.effectiveInterval` survives as machine-readable data the shaper and axis need; it must **not** render a second sentence beside the notice |
| S-H | **One capability surface: `observability.status`** (04 §6.5), extended with `blocked: 'winddown' \| 'quota' \| null` | a separate `telemetry.capabilities → {enabled, hasMetrics, hasLogs, hasTraces, patterns, blocked}` | 04 owns it and D10 already guarantees it never throws for an authorized caller. `patterns` is dropped unless `LOG_DRILLDOWN` is on. **Changes:** `04` adds `blocked`; `05-logs.md` D12's app-context `telemetryEnabled` derives from this procedure rather than a second boolean; `06` §15's traces flag is already `status.signals.traces` |
| S-I | **One deletion function: `deleteTelemetryFromClickhouse(projectIds, opts?)`** in `packages/db/src/services/delete.service.ts`, called **from inside** `deleteFromClickhouse`, never throwing, with the `TelemetryErasure` ledger — and 05's resumability (durable fingerprint set, `resumeJobId`) folded into it | §14 cited 05's `purgeTelemetry` + `TelemetryPurgeJob` | 08 owns `delete.service.ts` and its call site is the only one covering both `cron.delete.ts:46` and `admin/src/commands/delete-organization.ts:191`; `jobDelete()` has no try/catch, so an unguarded throw stops every project and organization deletion on the deployment. **Changes:** `05-logs.md` drops `purgeTelemetry`/`TelemetryPurgeJob` and contributes its journal to 08's ledger; `06` §11.6's two function names collapse into a `subject`/`signals` argument; `11` I13/I14 already name 08's function |
| S-J | **`topk` never appears in a range query.** Capping is 03 D8's two-phase rank-then-pin, in JS | D4 justified cutting the persisted `limit` control partly by "the compiler wraps breakdowns in `topk`" | 03 D8 and `07-alerting.md` D4 reject it independently and both are right: `topk` is evaluated per timestamp, gigapipe does not accelerate it, and for an `lt` alert rule it keeps the healthiest series. **Changes:** `04-read-path.md` §8.2 deletes the `topk` wrap and the `maxSeries`-exceeded `GigapipeUpstreamError`, and adds `cfg.maxRankSeries` / `metricFanoutConcurrency` / `metricDeadlineMs` |

Two consequences worth stating up front, because they change what this stream ships: **Q1 is closed** (S-E), and the P2 ordering in the Effort table is inverted from the draft — the report-persistence work moves last and is renamed P2.5, matching `03-metrics-engine.md`.

---

## Decisions

### D1 — Scope: this stream owns the shell, the metrics explorer, and the report seams

`05-logs.md` §7.2 already enumerates twelve files under `apps/start/src/components/logs/`, and `06-traces-and-correlation.md` §7 already specifies `components/traces/waterfall/` including `buildWaterfall`, `bigint` time arithmetic, element-scroll virtualisation and error-ancestor highlighting. Re-specifying them here creates two sources of truth that will disagree within a sprint.

What this document owns for logs and traces is only what they cannot own alone: the route files, the sidebar entry, `PAGE_TITLES`, capability gating, the empty/blocked states, and the `PureFilterItem` seam they share with metrics.

**Rejected:** a single UI spec covering all four surfaces. It was the draft's shape, and it produced a `LogsTable`/`LogsToolbar`/`LogRow` inventory that contradicts `05-logs.md` §7.2's `log-list.tsx`/`log-selector-builder.tsx`/`log-row.tsx` file-for-file.

### D2 — `ReportChartProps` gains `data`, `isLoading` and `error`; the caller may own the query

This resolves the draft's open Q7 as **yes, in P2**. It is the highest-leverage change in the stream.

Today every renderer's `index.tsx` is a fetch wrapper with an identical five-line body — `useQuery(trpc.chart.chart.queryOptions({...chartInput, shareId}, { enabled: !isLazyLoading }))`, then Loading / Error / Empty, then `<Chart data={res.data}/>` (`components/report-chart/line/index.tsx:11-42`, structurally identical in `area/`, `histogram/`, `metric/`, `map/`; `bar/` and `pie/` differ only in using `trpc.chart.aggregate`). `ReportChartProps` has no `data` (`components/report-chart/context.tsx:36-39`), so anything already holding a `FinalChart` must throw it away — which `components/chat/tool-results/chat-report-result.tsx` demonstrably does: it receives `{ report, data }` from an MCP tool, passes only `report`, and lets `ReportChart` refetch.

```ts
// components/report-chart/context.tsx
export type ReportChartContextType = {
  options: Partial<{ /* unchanged */ }>;
  report: IReportInput & { id?: string };
  isLazyLoading: boolean;
  isEditMode: boolean;
  shareId?: string;
  reportId?: string;
  /**
   * When present the renderer does NOT fetch. The caller owns the query and
   * the four states below. Omitting it preserves today's behaviour exactly,
   * so every existing call site is a no-op diff.
   */
  data?: IChartData;
  isLoading?: boolean;
  isFetching?: boolean;
  error?: unknown;
};
```

and in each of the seven `index.tsx` files, three lines at the top:

```tsx
export function ReportLineChart() {
  const ctx = useReportChartContext();
  const owned = ctx.data !== undefined || ctx.isLoading !== undefined;
  const res = useQuery(
    trpc.chart.chart.queryOptions(
      { ...chartInput, shareId },
      { placeholderData: keepPreviousData, enabled: !isLazyLoading && !owned },
    ),
  );
  const view = owned
    ? { data: ctx.data, isLoading: !!ctx.isLoading, isFetching: !!ctx.isFetching, isError: !!ctx.error }
    : res;
  // ...unchanged from here
}
```

What it buys, all of which the draft paid for separately and worse:

| Problem | Draft's answer | With `data` |
|---|---|---|
| Explorer fires a query with `series: []` on first paint | claimed "no series ⇒ no query" — **false**, the only gate is `enabled: !isLazyLoading` | explorer never issues the query until a metric is picked |
| `compiled` / `notices` must be read outside the chart | `<Syntax code={data.compiled}/>` with `data` undefined | explorer holds the response |
| Reading them anyway | duplicate the query with a byte-identical key, reproducing `useChartInput`'s `visibleSeries` strip | one query |
| 30 services sparklines | 30 synthetic reports, 30 chart queries | one list query, `data` per card |
| `chat-report-result.tsx` | throws the payload away | can stop |

**Rejected:** an `enabled?: boolean` prop. Same seven-file diff, solves only the first row, and leaves the explorer unable to read `compiled` without a second request against the same compiler — which for a mandatory-matcher security boundary is exactly the wrong property (D14).

### D3 — The metric schema is `03-metrics-engine.md` §2, field for field (rewritten — S-A)

**This decision was wrong in the previous revision and is corrected here.** It claimed to consume 03 "verbatim" and then described a schema that appears in no document on disk: `metricType` limited to three values, a five-member `fn` including `value`, `matchers: zMetricMatcher[]` with PromQL glyph operators, `fill` and `seriesLimit`. Verified against 03: `seriesLimit` appears zero times, `'value'` as an `fn` appears zero times, and the field is called `filters`. Everything downstream that was derived from the invented shape — §4.2's key table, §4.3's defaults, D9's operator adapter — is corrected with it.

The real schema (`packages/validation/src/telemetry.validation.ts`, 03 §2; the file is tenancy's, the fields are 03's):

| Field | Type | Notes for the UI |
|---|---|---|
| `type` | `z.literal('metric')` | the discriminator, and the **only** thing dispatch reads (S-B) |
| `id` | `string?` | alpha id assigned by `normalize()`; formulas reference it |
| `metric` | `string`, `PROM_METRIC_NAME` | the stored name verbatim, including `_total`/`_sum`/`_count` and unit words. For a histogram it is the base name **without** `_bucket` — the compiler suffixes (03 D5) |
| `metricType` | `counter \| gauge \| histogram \| summary` | **four** values. `summary` is real and the picker must offer it |
| `filters` | `zMetricLabelFilter[]`, max 32 | `{ name, operator: 'eq' \| 'neq' \| 're' \| 'nre', value: string }`. Not `matchers`, not glyphs, and **not** `IChartEventFilter` |
| `fn` | eleven values | `none`, `rate`, `increase`, `delta`, `avg_over_time`, `min_over_time`, `max_over_time`, `sum_over_time`, `count_over_time`, `last_over_time`, `histogram_quantile`. Default `none` |
| `window` | `auto\|1m\|5m\|10m\|15m\|30m\|1h\|3h\|6h\|12h\|24h` | an enum, **not** a free-text duration. Default `auto` |
| `aggregation` | `sum\|avg\|min\|max\|count`, optional | no `topk`, no `bottomk`, no `quantile`, and no `k` field — all three were removed by 03, which is what makes D4 and S-J consistent |
| `groupBy` | `string[]`, max 8, unique | per series; there is no report-level breakdown (D19) |
| `quantile` | `number?` in [0,1] | **only** with `fn: 'histogram_quantile'`, and required there |
| `scale` | `number`, default 1 | linear multiplier applied once at parse (03 §9.1). The `%` idiom is `scale: 100` + `unit: '%'` |
| `displayName`, `hideSeries` | | as on an event item |

Two cross-field rules the UI must mirror rather than discover at submit time:

- **`REDUCER_TABLE` (03 §2) is the legal `(metricType, fn)` set.** `counter` allows only `rate`/`increase`/`delta`; `gauge` allows `none` and the five `*_over_time`; `histogram` allows only `histogram_quantile`; `summary` allows only `none`. The `FnPicker` offers exactly `Object.keys(REDUCER_TABLE[metricType])` — it does not carry its own list.
- **A `summary` requires a `quantile` label filter** (`refineMetricQuery`), or the aggregation mixes p50, p90 and p99 into one number. The picker adds that filter row itself when `metricType === 'summary'` and no `quantile` filter is present.

There is **no `seriesLimit` field**, so nothing per-series is persisted for cardinality; see the rewritten D4.

Consequence for the UI: the filter model is still not `IChartEventFilter` — `zMetricLabelFilter.value` is a single `string`, not `string[]`, and its operator set is four symbolic names that happen to map one-to-one onto PromQL glyphs in the compiler. The UI adapts at the component boundary (D9).

**Rejected:** keeping a UI-local schema and adapting server-side. Two schemas for one persisted object is how a metric series silently stops round-tripping — and, as this decision demonstrates, how three documents end up describing four shapes.

### D4 — No `limit` column, and no `step` control. Both were solving problems the engine spec already solves

Two of the draft's structural decisions are now redundant, and shipping them would be net harm.

**`limit`.** The draft made a persisted `limit` column a P2 cost blocker: *"the difference between a dashboard card that returns 12 series and one that returns 4 000."* It is not one, but the previous revision's reasoning was also wrong and is replaced (S-A, S-J). There is no `zMetricQuery.seriesLimit`, and `compileMetricQuery` does **not** wrap breakdowns in `topk` — `03-metrics-engine.md` D8 rejects that outright, with gigapipe's own source: `topk` is evaluated independently at every step, gigapipe's `aggFns` does not accelerate it (`optimizer/vector_agg.go:12-25`), so the response is the *union* of every step's top-K, each series ragged, and D10's zero-fill then paints a healthy series diving to zero. `07-alerting.md` D4 rejects it a second time for a different reason: on an `lt` rule it keeps the healthiest series and the rule never fires.

What actually bounds cardinality, and it is entirely engine-side:

- `cfg.maxSeries` (default 20, `GIGAPIPE_MAX_SERIES`) — applied in JS by `resolveSeriesSet` after a coarse **ranking** pass, with the exact `seen` count reported as the `series_capped` notice (03 D8, D2).
- `cfg.maxRankSeries` (1000) — a ranking-cardinality guard that throws `GigapipeQueryTooLargeError` with an actionable message.
- `report.limit`, which the engine honours as `min(cfg.maxSeries, limit)` (03 §12.6). It exists on `zReportInput` already and is **not** a Prisma column, so it is page-local: the explorer may set it, a saved report will not remember it. That pre-existing papercut is real and out of scope here.

So the UI needs no per-series limit control and no migration. What it does need is to render `series_capped` (D15) — the honest surface for "you asked for a breakdown that produced 34 series and you are seeing 20".

**`step`.** `03-metrics-engine.md` D2 is explicit: PromQL's fixed `step` cannot express `week`, `month`, or a DST-correct `day`, so the engine takes OpenPanel's `interval`, picks its own sub-step (a multiple of 15 000 ms), and folds into project-timezone calendar buckets itself (`grid.ts`, `BASE_SUB_STEP_MS`, `chooseSubStep`). There is no `step` on the wire and there must not be: a client-chosen step would break DST correctness and the 15 s-multiple constraint. A `StepPicker` that writes a nuqs key nothing reads is a component, a picker and a save-time mapping rule built on a control that does nothing — which is precisely what the draft specified, since `zReportInput` is a strip `z.object()` and `chart.chart`'s input is `zReportInput.and(...)`, so an extra key is discarded before the resolver (`packages/validation/src/index.ts:233`; `packages/trpc/src/routers/chart.ts:588-597`).

Sub-minute resolution therefore is not offered in P2. When the range is short enough that `interval: 'minute'` is coarse, the engine's own `interval_coarsened` notice (D15, S-D) is the honest surface, not a picker.

**Rejected:** `zReportInput.step`, and `ALTER TYPE "Interval" ADD VALUE 'second'`.

### D5 — Explorer queries `observability.metrics.chart`; **saved** metric reports go through `chart.chart` → `executeReport`

The two sibling specs describe two paths and both are right for their case:

- `04-read-path.md` D6 ships `observability.metrics.chart` and explicitly puts the share path out of its scope, because in its phase no stored report can hold a metric series.
- `03-metrics-engine.md` §13.3 centralises execution in `executeReport(input, { mode })` and maps `packages/trpc/src/routers/chart.ts:609` (`chart.chart`) and `:633` (`chart.aggregate`) onto it.

Resolution this stream adopts and asks the other two to confirm: **page-local surfaces call `observability.*`; anything loaded from a `Report` row calls `chart.*`.** That matches `06-traces-and-correlation.md` T13, which already marks `observability.traces.latency` as *"page-local; not saveable"*. The explorer is page-local. A saved metric tile on a dashboard is not.

**Namespace: settled (S-E).** One router, `observability.{metrics,logs,traces,status}`, on `04-read-path.md` D13's base procedure (`protectedProcedure.use(rejectShareId)` plus the kill switch and the `NO_PROJECT_ID` allow-list). `05-logs.md`'s `logsRouter` and `03`'s `packages/trpc/src/routers/metrics.ts` procedures fold under it; `01-tenancy-and-security.md` §7.1's hand-rolled `publicProcedure` is replaced by a pointer at D13. This was Q1 and it is no longer open.

**Rejected:** the explorer calling `chart.chart` with an unsaved draft report. It would need `dataSource` and a metric series to survive `zReportInput` before the persistence work lands, and it would put an editor-only surface behind `chartProcedure`, whose share branch exists for a different threat model.

### D6 — Server-side dispatch happens at **seven** engine entry points; the canonical list is `03-metrics-engine.md` §15.3

The draft named two (`chart.chart`, `chart.aggregate`). The previous revision named four. **`03-metrics-engine.md` §15.3 names seven and is the canonical list** — this decision defers to it rather than maintaining a third inventory, and the two it adds beyond the four below are MCP's `runReport` (`packages/mcp/src/tools/analytics/reports.ts:302,304`) and `runReportFromConfig` (`:349,351`, which also casts around zod at `:331-335`). Its seventh row, `apps/api/src/controllers/export.controller.ts:201`, 03 then corrects to a **no-op**: `chartSchemeFull` requires `name` and has no `type` in its shape, so a metric series is not expressible at `/export/charts` at any input.

The four this stream verified independently, kept because they are the ones with a UI consequence:

| Site | Today |
|---|---|
| `packages/trpc/src/routers/chart.ts:588-610` (`chart.chart`) | `ChartEngine.execute(chartInput)` |
| `packages/trpc/src/routers/chart.ts:612-635` (`chart.aggregate`) | `AggregateChartEngine.execute(chartInput)` |
| `packages/db/src/services/reports.service.ts:196-221` (`getReportDataCore`) | branches `chartType`: `funnel` → `funnelService`, `metric` → `AggregateChartEngine`, else `ChartEngine` |
| `apps/api/src/agents/tools/dashboard.ts:96-104` | the identical three-way branch |

`getReportDataCore` is the public Insights REST API (`apps/api/src/controllers/insights.controller.ts:651`) and `dashboard.ts` is `summarize_dashboard`. §Design §6 says a metric report tiles on a dashboard with no changes — which means an un-dispatched `summarize_dashboard` runs a metric report through the ClickHouse event engine and hands the model plausible-looking zeros. Not an error. Not "No data".

`03-metrics-engine.md` §15.3's `executeReport(input, { intent })` is that helper and all seven sites adopt it. Note the parameter is named `intent`, not `mode`, in 03's signature; this document follows 03. The dispatch predicate inside it is `getReportDataSource(input.series) === 'metrics'` — a derivation, not a column (S-B). Note the two server sites also disagree with the browser about `chartType === 'metric'`: they call `AggregateChartEngine`, while `components/report-chart/index.tsx:51` routes `metric` to `ReportMetricChart`, which queries `trpc.chart.chart` (`ChartEngine`). `executeReport`'s `mode` parameter exists to preserve each caller's current behaviour; the divergence is pre-existing and must not be "fixed" as a side effect.

**Rejected:** seven hand-written `if (getReportDataSource(series) === 'metrics')` branches. The eighth entry point is the one that forgets.

**Note for `08-schema-changes.md`.** Its §3 enumerates nine sites, which is a *different axis*: those are the whitelists a **persisted field** must cross, not the executor call sites. With S-B removing the column, that inventory retargets at the series union member (see the rewritten D8) and the two lists stop competing.

### D7 — `transformReportEventItem` and `listReportsCore` both need a `metric` branch; only one of them is silent

The draft's framing — *"a third union member compiles clean and every persisted metric series is destroyed on read"* — is wrong, and the correction matters for how the work is sequenced.

`transformReportEventItem` (`packages/db/src/services/reports.service.ts:56-80`) early-returns on `formula`, then builds `{ type: 'event', segment: item.segment, …, property: item.property }`. After the early return `item` narrows to `IChartEventWithType | IMetricQuery`, and `zMetricQuery` has neither `segment` nor `property`. **`tsc` fails on both lines.** The `default: { const _exhaustive: never = item; }` switch is still the right shape, but it is a readability change, not the only thing standing between the product and permanent data loss.

`listReportsCore` (`:154-177`) **is** silent, because its ternary *constructs* a literal rather than reading metric-only fields:

```ts
s.type === 'formula'
  ? { type: 'formula', id: s.id, formula: s.formula }
  : { type: 'event', id: s.id, name: s.name, displayName: s.displayName, segment: s.segment },
```

`s.segment` on a metric item is `undefined`, which is assignable, so this compiles and coerces. It feeds `apps/api/src/agents/tools/base.ts:124` and Insights `GET …/dashboards/:id/reports` — and it is a **write-back** path, contrary to the draft's "lower severity (no write-back)": an agent reads a report through `listReportsCore`, sees `{type:'event', name:'…'}`, and calls MCP `update_report`, documented as taking "the complete saved report configuration". That writes the coerced series into `events`.

The genuinely silent surfaces are therefore `listReportsCore` and the `apps/start` casts (Design §7.2).

**Rejected:** relying on `tsc` to catch the coercion. It catches `transformReportEventItem` and nothing else; `listReportsCore` compiles and corrupts.

**Ask for `08-schema-changes.md`.** Its F4 gives this omission a detection column of "none". That is right for `listReportsCore` and for the `apps/start` read casts (§7.2), and wrong for `transformReportEventItem`, which fails to compile — verified in the repo: the final `return` reads `item.segment` and `item.property` after the `formula` early return (`packages/db/src/services/reports.service.ts:70-79`), and `zMetricQueryBase` has neither field. Split the row. 08's own sequencing ("same PR as … the whitelist sites") depends on knowing which arms are mechanical and which need a human to notice them.

### D8 — There is no `dataSource` column; the thing that must survive eight projections is the `type: 'metric'` **union member** — and MCP fails **open** on it (rewritten — S-B)

The previous revision built this decision on `Report.dataSource`, a Postgres enum plus a column proposed by `08-schema-changes.md` S1. **`03-metrics-engine.md` §15.1 rejects that column and is right**: `ctx.report` is `null` on every non-shared query (`chart.ts:139`), so the discriminator has to arrive from the browser on `zReportInput.series` regardless, and once it is there `getReportDataSource(series)` is a pure function of data the report already stores in its `events` Json column. The column would add an irreversible Postgres enum, a migration, three write literals and a read whitelist to buy a filterable index nothing in this plan queries on.

So the inventory below is retargeted, not deleted. Its subject is now: **does a `series` item with `type: 'metric'` survive this projection unchanged?** The write-side rows mostly become no-ops — which is the point — and the read-side and MCP rows become *more* important, because with no column the union member is the only carrier.

| # | File | Symbol | Under `getReportDataSource(series)` |
|---|---|---|---|
| 1 | `packages/validation/src/index.ts:233` | `zReportInput.series` | **Change.** `zChartSeries` gains `zMetricQuery` as a union member, and `refineReportInput` rejects a mixed `event`+`metric` array (03 §15.2). Without this zod strips nothing but the union never accepts a metric item |
| 2 | `packages/trpc/src/routers/report.ts:54` | `report.create` | none — `events: report.series` passes the array whole |
| 3 | `packages/trpc/src/routers/report.ts:101` | `report.update` | none, same reason |
| 4 | `packages/trpc/src/routers/report.ts:226` | `report.duplicate` | none — it copies `report.events!` raw |
| 5 | `packages/db/src/services/reports.service.ts:56` | `transformReportEventItem` | **Change, and it ships first.** Add `if (item.type === 'metric') return { ...item, id: item.id ?? alphabetIds[index]! };` before the event fallthrough, or every read rewrites the series to `unknown_event`. `tsc` catches the omission (D7) |
| 6 | `packages/db/src/services/reports.service.ts:83` | `transformReport` | none — `series` maps through the item transformer above |
| 7 | `packages/db/src/services/reports.service.ts:154` | `listReportsCore` | **Change, silent, and it is a write-back path.** D7 |
| 8 | `packages/mcp/src/tools/dashboard-management.ts:15` | `reportSchema` = `zReport.omit(...).strict()` | **Verify.** `.strict()` rejects unknown *keys*; the union member is nested inside `series`, so `type: 'metric'` becomes **immediately expressible** through `create_report` and `update_report` the moment 03's schema lands. MCP does not fail closed here, it fails silently open — see below |
| 9 | `packages/mcp/src/tools/dashboard-management.ts:130` | `reportData()` | none — `events: report.series` |
| 10 | `packages/mcp/src/tools/dashboard-management.ts:488` | `duplicate_report` inline literal | **none, corrected.** Verified in the repo: it reads `requireReport()`, a raw `db.report.findFirst`, and writes `events: report.events!` — the Json round-trips untouched. The previous revision claimed this literal corrupts a metric report; that was true only under the column design and is now false |

**The MCP fail-open is the real finding and it survives the rewrite.** `reportSchema` is `zReport.omit({projectId, limit, offset}).strict()` and `zReport = zReportInput.extend({…})`, so widening `zChartSeries` makes a metric series expressible through two shipped write tools with no code change and no advertisement in their descriptions. Decision: in the **same PR as the union member**, `create_report` and `update_report` either accept it deliberately (03 §15.5's availability gate conditions the advertisement on `observability.status.enabled`) or reject it with a named error. Silently accepting it is the one option that is not allowed, because MCP is the surface plan decision 4 leans on.

Also note the Zod 4 caveat 03 §2 raises: `.omit().strict()` may **carry or drop** `refineMetricQuery`'s refinements differently from Zod 3, so item 8 is a runtime test (03's T-P1, this document's T2b), not a reading exercise.

### D9 — Filter primitives: extend the `PureFilterItem` seam `05-logs.md` already opened; create no new pill component

The draft asserted that the horizontal filter pill *"lives in `components/overview/filters/overview-filters-buttons.tsx` … and it is not exported"*, and proposed extracting it to `components/filters/filter-pill.tsx`. That directory already contains two production components the draft never mentions:

- **`components/filters/TableFilterPills.tsx`** — a horizontal pill row, parameterised by URL key (`useTableFilters(urlKey, nuqsOptions)`), keyed by array index (`key={`${filter.name}-${index}`}`, `removeAt(index)` at `:132`, `:92-94`). In production on the sessions and profiles tables (`components/sessions/table/index.tsx:370`, `components/profiles/table/index.tsx:123`). It already satisfies D10 and D11.
- **`components/filters/FiltersBuilder.tsx`** — a Redux-free `value`/`onChange` filter list over `PureFilterItem` + `PureCohortFilterItem`. `05-logs.md` §7 already names it as the logs baseline.

So the extraction is unnecessary and would land a *third* implementation in the directory that holds the first two.

Two real gaps remain, and they are the ones to write down:

1. **`FiltersBuilder` identifies rows by `f.id`** (`:39-45`: `value.map(f => f.id === updated.id ? updated : f)`), which D11 rules out. Change to index.
2. **Both are hardwired to event-property discovery.** `TableFilterPills`'s three buttons all call `openSheet` → `pushModal('TableFilters', { urlKey, categories })`; `FiltersBuilder`'s add-trigger is `PropertiesCombobox`; `PureFilterItem` calls `usePropertyValues` unconditionally.

`05-logs.md` §Interfaces already commits to extending `PureFilterItem` with `values`, `valuesLoading`, `operatorAllowlist` and an optional `eventName`, with the note *"metrics (P2) should reuse the same seam rather than adding a third"*. This stream takes that as binding and adds one requirement it is missing: the `usePropertyValues` call must be **disabled**, not merely overridden.

```ts
// components/report/sidebar/filters/FilterItem.tsx — inside PureFilterItem
const potentialValues = usePropertyValues({
  event: eventName ?? '',
  property: filter.name,
  projectId,
  // `values` supplied ⇒ the caller owns discovery. Without this the hook still
  // fires: usePropertyValues (hooks/use-property-values.ts:5-11) queries
  // trpc.chart.values whenever `enabled !== false && !!projectId`.
  enabled: values === undefined && !filter.name.startsWith('session.'),
});
const options = values ?? potentialValues;
```

Same treatment for the `useEventNames` call immediately below it if a telemetry caller can ever reach `session.performed_event` — it cannot today, because `operatorAllowlist` and the injected label list keep `session.*` out of the namespace, but the guard is one argument.

The metrics explorer's filter row is `FiltersBuilder`-shaped (`layout: 'rows'`), with `PropertiesCombobox` replaced by an injected picker. The label trigger is a prop, not a modal:

```ts
// components/telemetry/metrics/metric-label-filters.tsx
interface MetricLabelFiltersProps {
  metric: string;
  value: IMetricLabelFilter[];              // zMetricLabelFilter[] — 03 §2, S-A
  onChange: (next: IMetricLabelFilter[]) => void;
}
```

and it renders `PureFilterItem` per row with an adapter both ways — `IMetricLabelFilter {name, operator: 'eq'|'neq'|'re'|'nre', value: string}` ⇄ `IChartEventFilter {name, operator, value: string[]}` — mirroring `components/logs/log-matcher-adapter.ts` (`05-logs.md` §7). Two asymmetries the adapter owns, both corrected from the previous revision (S-A):

- **Operator mapping is four ways onto 03's names, not onto PromQL glyphs**: `is`↔`eq`, `isNot`↔`neq`, `regex`↔`re`, `notRegex`↔`nre`. The glyphs `=`/`!=`/`=~`/`!~` appear only inside `compileSelector`, and the UI never produces them. `operatorAllowlist` restricts `FilterOperatorSelect` to those four so nothing else can be produced.
- **`value` is a single string, not an array.** `IChartEventFilter.value` is `string[]`; `zMetricLabelFilter.value` is one `string` (a regex on `re`/`nre`, a literal otherwise). The adapter takes `value[0] ?? ''` inbound and wraps outbound, and the value control is single-select. A user who wants two alternatives writes `re` with `a|b` — which is what PromQL does — rather than getting a multi-select that would silently drop entries.

One naming trap: `TableFilterPills` runs names through `getPropertyLabel` (`translations/properties.ts`), which maps `path`, `country`, `os`, `region`, `model` to prose. A label called `path` is a `path`. Telemetry passes raw names.

**Rejected:** `components/filters/filter-pill.tsx`. **Rejected:** copying `PureFilterItem` into `components/telemetry/` — it would fork the operator UI, which is exactly the chrome that must look identical between an event filter and a label filter.

### D10 — Explorer state lives in `nuqs` under **`lf`**, and observability routes register no chat page context

`useEventQueryFilters()` (`hooks/use-event-query-filters.ts`) is hardcoded to `'f'`, and `setPropertyFilters` in `components/chat/tool-handlers.ts:79-94` does `url.searchParams.set('f', …)` against `window.location.href` with **no page check** — while `SidebarChatComposer` is mounted in `SidebarProjectMenu` on every project page (`components/sidebar-project-menu.tsx:36`). A user on `/metrics` whose question triggers `set_property_filters` gets their label matchers silently replaced by event-property filters, and the compiled PromQL then reads `{op_project_id="…",country="SE"}` and returns nothing.

`useTableFilters(key)` already takes the key (`hooks/use-table-filters.ts:16`). Telemetry uses `lf`, and the four observability routes register no page context in P2/P3.

**Rejected:** reusing `'f'` plus a page guard in `set_property_filters`. It puts the correctness of the metrics explorer inside a file the chat stream owns and can regress without touching this one.

### D11 — Matcher rows are keyed by array index, never by `filter.id`

`eventQueryFiltersParser.parse` sets `id: name` (`hooks/use-event-query-filters.ts:32`) and `serialize` writes `filter.name`. So `{ id: shortId(), name: 'job' }` becomes `{ id: 'job', name: 'job' }` after one reload, and `job=~"a.*"` plus `job!~"b.*"` — an ordinary PromQL pattern — share an id. Remove and change dispatch by index.

**Rejected:** `filter.id`. It is not an identity — it is the label name, restored on every reload.

### D12 — `observability.status` is **not** awaited in the project route loader, and never flips `enabled` on a transient error (retargeted — S-H)

`routes/_app.$organizationId.$projectId.tsx:22-35` is `await Promise.all([two prefetchQuery calls])`. Adding a third awaited prefetch that probes gigapipe blocks navigation into **every** project page — Overview, Sessions, Events, SEO, Settings — behind an unreachable or slow gigapipe, for users who never asked for observability. That contradicts this stream's own principle (Design §9.3) that a query outage must not become a dashboard outage.

The procedure is `observability.status` (`04-read-path.md` §6.5), not a second `telemetry.capabilities` — the previous revision invented one, with a different shape, a `patterns` field and a `blocked` field. Settled per S-H: **one procedure**, extended with `blocked`, `patterns` dropped unless `LOG_DRILLDOWN` ships. The field renames that follow through this document: `hasMetrics`/`hasLogs`/`hasTraces` → `status.signals.{metrics,logs,traces}`; `enabled` keeps its name and meaning.

- The prefetch is started, not awaited, or the query lives in the component with `staleTime: 5 * 60_000` — which is 04 §6.5's own client contract (`staleTime: 30_000` server TTL 10 s; this stream asks for the longer client stale time and 04 should reconcile to whichever it prefers, the requirement being only that it is not awaited in the loader).
- Server side it carries a hard single-digit-second timeout and a Redis-cached result. 04 D10 already guarantees `status` never throws for an authorized caller, which is what makes the non-awaited prefetch safe.
- It distinguishes **`enabled: false`** (gigapipe not configured for this deployment — stable, derived from `GIGAPIPE_URL` being unset, never from a probe) from **probe failure**, which surfaces as `reachable: false` / `degraded: 'unreachable'` while `enabled` stays true. Never flip `enabled` to false mid-session and make the whole sidebar group vanish under the user.

`enabled` is a **deployment** fact. `signals.*` are project facts and may legitimately go stale. `degraded` is a single value whose enum order is "fix this first" (04 §6.5), and the UI renders it in that order rather than composing sentences.

**Rejected:** a third awaited `prefetchQuery` in the project route loader. It makes gigapipe a hard dependency of the analytics product.

### D13 — The metrics explorer edits one metric query; composition happens in the report editor

The explorer URL carries a single query. "Save to dashboard" produces a `Report` with `series: [oneMetricQuery]`; the user then adds series and formulas in the existing editor, which already has drag-reorder, alpha ids and visibility.

**Rejected:** a multi-query explorer. It needs either a nested URL encoding — losing the hand-editable-URL property every other surface here has — or Redux state thrown away on save. The editor already is the multi-series surface.

### D14 — The compiled PromQL rides on `MetricChartResult`, which only `observability.metrics.chart` returns — so it never reaches the share path at all (rewritten — S-C)

The previous revision put `compiled?: string` on "the chart response" of both `chart.chart` and `observability.metrics.chart`, and mitigated the resulting leak with a conditional in a resolver: *"`compiled` is populated only when `ctx.report === null`"*. Two things are wrong with that, and the security critic and the interfaces critic found them independently.

**It leaks by convention rather than by construction.** `chartProcedure` is a `publicProcedure` that serves anonymous viewers whenever `shareId` is present (`packages/trpc/src/routers/chart.ts:83-141`), and today's `FinalChart` — `{ series, metrics }`, `packages/validation/src/types.validation.ts:106-109` — carries no project identifier at all. `compiled` contains the internal project UUID and the full label-matcher set. Guarding that with one `if` in a resolver, in a repo where **no test file references `FinalChart`, `ChartEngine` or `chartProcedure`**, is a guarantee with nothing behind it.

**And the code path it guards does not exist.** `04-read-path.md` D4/D6 and `01-tenancy-and-security.md` D12 both hard-reject `shareId` on `observability.*` — "it never falls back to `input`" — and 03 D1 confirms no stored report can hold a metric series in P2. A `shareId` never reaches this resolver.

**Decision:** `compiled` is a field on **`MetricChartResult`**, the envelope only `observability.metrics.chart` returns (S-C). `chart.chart` returns a bare `FinalChart` and gains no new field, ever. The explorer — an authenticated, page-local surface — is the only place the compiled query is shown, which is also the only place anyone wants it. That removes the leak by construction rather than by a conditional, which is the class of mitigation this plan should prefer wherever it is available.

Two consequences, stated because they are real costs:

1. **A saved metric report on a dashboard shows no compiled query.** Accepted for P2.5. If it is ever wanted there, it arrives as an explicit `observability.metrics.compile`-style call from an authenticated surface, never as a field on the share-served envelope.
2. **`compiled` is an addition to a type `03-metrics-engine.md` owns.** 03 §2/D2 defines `MetricChartResult = FinalChart & { notices }` and says nothing about `compiled`. **Ask for 03:** accept `compiled?: string` on `MetricChartResult` — populated from the string that actually ran, not recompiled — or reject it, in which case the explorer's Query disclosure is cut and D2's "one query, not two" argument loses one of its four rows. This document cannot decide it alone; it appears in no engine spec today.

**Rejected:** a separate `metrics.compile` procedure in P2. A second round-trip against the same compiler with an independently cached result means the string on screen can disagree with the string that ran — for a mandatory-matcher boundary, exactly the wrong property.

**Rejected:** the `ctx.report === null` conditional. Kept in spirit only: if a future phase does serve metric reports over a share link, the omission belongs in the transport, asserted by a test, not in a resolver.

### D15 — Notices render, and the catalogue is `03-metrics-engine.md` D2's seven codes (corrected — S-C, S-D)

The previous revision stated that *"`03-metrics-engine.md` D7 adds `notices?: MetricNotice[]` to `FinalChart`"*. **03 D2 says the opposite**: it explicitly rejects adding any field to `FinalChart`, optional included, because every renderer types against `IChartData = RouterOutputs['chart']['chart']`, and puts notices on a structural supertype instead. It also lists seven codes, of which the previous revision's list shared exactly one.

The envelope, settled (S-C):

```ts
// packages/db/src/engine/metrics/notices.ts — 03 D2, plus 04 D5's resolution fields merged in
export type MetricChartResult = FinalChart & {
  notices: MetricNotice[];
  resolution: {
    requestedInterval: IInterval;
    effectiveInterval: IInterval;   // may be coarser
    stepMs: number;
    previous: 'ok' | 'unavailable_retention' | 'not_requested';
    oldestQueryableAt: string;
  };
  compiled?: string;                // D14 — pending 03's accept/reject
};
```

Structurally still a `FinalChart`, so `<ReportChart data={…}>` takes it untouched and no shared type is edited. `04-read-path.md` D5's `IObservabilityChartResult { chart, resolution }` wrapper is superseded: it preserved the same property by wrapping, which then needs every consumer to reach through `.chart`. One envelope, not two.

The seven codes, verbatim from 03 D2:

| Code | Emitted when | Meta |
|---|---|---|
| `series_capped` | the ranking pass saw more label sets than `maxSeries` | `seen`, `kept` |
| `interval_coarsened` | the requested interval could not meet the point budget | `asked`, `used` |
| `rate_window_widened` | an explicit window was narrower than the step | `asked`, `usedSec` |
| `increase_window_pinned` | `fn: 'increase'` with an explicit non-step window | `asked`, `usedSec` |
| `gaps_filled_with_zero` | at least one calendar bucket had no samples | `buckets` |
| `non_finite_samples_dropped` | at least one `NaN`/`Inf` sample was dropped | `samples` |
| `previous_period_unavailable` | the previous-window query failed while the current succeeded | `reason` |

`MetricNotice.message` is **already user-facing and already formatted** (03 D2) — the UI renders it verbatim and holds no message table of its own. That is what keeps the catalogue single-sourced.

Rendering: a single `TooltipComplete`-wrapped `TriangleAlertIcon` in the chart card's top-right, listing the messages; a `meta.definitionId`, where the engine supplies one, maps to the series' alpha id so a per-series notice names its row. Never a toast — notices describe the data on screen and must persist as long as it does.

**One mechanism, not two (S-G).** `interval_coarsened` and `resolution.effectiveInterval` are the same fact. The **notice** is the user-facing surface; `effectiveInterval` stays on the envelope because the shaper and the axis formatter need it, and it must not render a second "showing 2-hour resolution" sentence beside the notice. `04-read-path.md` D9 currently specifies that sentence; it should defer to the notice.

**Rejected:** a toast. Notices describe the data on screen and must persist exactly as long as it does.

**Rejected:** the previous revision's code set (`dst_bucket_drift`, `window_clamped`, `interval_widened`, `rank_window_truncated`, `series_filled`, `series_limited`). Six of the seven named engine behaviours the engine spec does not have, and the UI would have rendered messages nothing emits.

### D16 — Allowed chart types for `dataSource: 'metrics'`: `linear`, `area`, `bar`, `histogram`, `pie`, `metric`

Excluded: `map` (needs a `country`-shaped breakdown), and `funnel` / `retention` / `conversion` / `sankey`, which are event-sequence engines with their own procedures and non-`FinalChart` result shapes.

`bar` and `pie` route to `chart.aggregate` (`components/report-chart/bar/index.tsx:17`, `pie/index.tsx:17`), so **`executeReport(input, { mode: 'aggregate' })` must define what an aggregate metric report computes.** For a range-vector `rate(...)` the honest answer is the same one the event engine gives: collapse the time series to one number per series using `report.metric` (`sum`/`average`/`min`/`max`/`count`). That is a contract this stream consumes and does not own (Interfaces, item 4).

Implemented by an additive optional prop on the existing picker, which builds `items` from `objectToZodEnums(chartTypes)`:

```ts
// components/report/ReportChartType.tsx
interface ReportChartTypeProps {
  className?: string;
  value: IChartType;
  onChange: (type: IChartType) => void;
  /** Restricts the offered types. Defaults to all — the events editor is unchanged. */
  include?: readonly IChartType[];
}

const items = objectToZodEnums(chartTypes)
  .filter((key) => !include || include.includes(key))
  .map((key) => ({ label: chartTypes[key], value: key }));
```

`METRIC_CHART_TYPES` lives in `components/telemetry/constants.ts` — UI policy, not a shared domain fact.

Consequence the draft missed: `ReportSaveButton` derives its busy state from `useIsFetching(trpc.chart.chart.pathFilter())` and `useIsFetching(trpc.chart.cohort.pathFilter())` only (`components/report/ReportSaveButton.tsx:22-26`). `chart.aggregate` is not watched, so bar and pie reports — metric *and* event, this is pre-existing — can be saved mid-fetch. Add `trpc.chart.aggregate.pathFilter()` to the list and put the file in the Modified inventory.

### D17 — "View Users" is suppressed for metric reports, in `line`, `area` and `histogram`

`ChartClickMenu`'s `getMenuItems` pushes a `View Users` item that opens `pushModal('ViewChartUsers', {…})` in exactly three files: `components/report-chart/line/chart.tsx:151-164`, `area/chart.tsx:148-151`, `histogram/chart.tsx:108-111`. (`03-metrics-engine.md` §Drill-down says "line, area and bar" — verified against source, `bar/chart.tsx` has no such item. Correct the engine spec, not the code.) `context.event` is `undefined` for every metric series and `getProfiles` throws on a non-event series.

`Add Reference` stays — pinning a deploy marker onto a latency chart is the most useful thing on that menu.

**Rejected:** leaving the item and letting `getProfiles` throw. A menu entry that always errors is worse than an absent one.

### D18 — `ReportTable` reads `interval`/`breakdowns` from the chart context, not from Redux

The draft put a `MetricSeriesTable (reuses report-table)` in the explorer and simultaneously declared "No Redux". Those cannot both hold today. `ReportTable` renders **only** when `isEditMode` (`line/chart.tsx:327`, `area/chart.tsx:308`, `histogram/chart.tsx:224`, `pie/chart.tsx:123`) and reads Redux directly — `useSelector((state) => state.report.interval)` and `state.report.breakdowns` (`common/report-table.tsx:231-232`). And `isEditMode` is a Redux **write** path, not a styling flag: `onVisibleSeriesChange: isEditMode ? (ids) => dispatch(changeVisibleSeries(ids)) : undefined` (`line/chart.tsx:74-76`).

Fix, one file, behaviour-preserving:

```ts
// components/report-chart/common/report-table.tsx
// Both call sites live inside a ReportChartProvider, and in the editor the
// context report IS the redux report — report-editor.tsx:118 renders
// <ReportChart isEditMode report={{ ...report, projectId }} /> off
// useSelector((state) => state.report) at :37. So this is identical in the
// editor and correct everywhere else.
const { report: { interval, breakdowns } } = useReportChartContext();
```

and one line in the four `chart.tsx` files:

```tsx
{(isEditMode || options.showTable) && <ReportTable data={data} visibleSeries={series} setVisibleSeries={setVisibleSeries} />}
```

`options.showTable` is a new `ReportChartContextType['options']` key. The explorer passes `options={{ showTable: true }}` **without** `isEditMode`, so it gets the table and dispatches nothing.

Note that with D3's `groupBy` living per metric series and `report.breakdowns` empty for metrics (D19), `transformToHierarchicalGroups(data, breakdowns)` (`report-table.tsx:247`) receives `[]` and the grouped view has no columns. That is acceptable for P2 — the flat view is the useful one for metric series — and is called out as a known limitation rather than silently shipped.

**Rejected:** a fifth new component `MetricSeriesTable`. `ReportTable` is ~1300 lines of column sizing, virtualisation and CSV export; a parallel one drifts immediately.

### D19 — Group-by is per metric series (`zMetricQuery.groupBy`); `report.breakdowns` is empty and hidden for metrics

PromQL has no report-global `by()`. `sum by (le) (rate(http_…_bucket[5m]))` and `avg by (pod) (process_resident_memory_bytes)` are both legitimate in one chart, and there is no honest single control that emits two different `by()` clauses.

**Rejected:** reusing `report.breakdowns`. It reads simpler right until the compiled-PromQL disclosure (D14) becomes nonsense.

### D20 — `SerieIcon` is suppressed for metric series through the existing `options.renderSerieIcon` escape hatch

`resolveIcon` (`components/report-chart/common/serie-icon.tsx:261-286`) ends with two catch-all branches:

```ts
if (name.includes('http')) return { type: 'image', url: getProxyImageUrl(name) };
if (name.match(/^.+\.\w{2,3}$/)) return { type: 'image', url: getProxyImageUrl('https://' + name) };
```

Legends and tooltips call `<SerieIcon name={serie.names}/>` per series (`line/chart.tsx:129`, `area/chart.tsx:124`, `common/report-chart-tooltip.tsx:108`, `pie/chart.tsx:46`). `http_requests_total`, `http_server_request_duration_seconds_count`, `http_client_duration` — the most common OTel metric family — all hit `/misc/favicon?url=http_requests_total`, once per series per render. That is a broken-image-plus-request-storm on the flagship screen.

`ReportChartContextType['options'].renderSerieIcon: (serie: IChartSerie) => ReactNode` already exists (`context.tsx:19`). Metric surfaces pass a metric-type badge. No change to `serie-icon.tsx`.

This is the clearest single piece of evidence for how to read plan decision #4: **`FinalChart` buys the renderers' structure, not their event-shaped heuristics.**

**Rejected:** adding a metric-name branch to `resolveIcon`. It would put telemetry knowledge inside a component whose whole job is event-shaped heuristics, and the context already has the hook.

### D21 — `useRechartDataModel` is rewritten to one `Map` pass before any metric surface ships

```ts
// hooks/use-rechart-data-model.ts — today
series[0]?.data.map(({ date }) =>
  ({ date, timestamp, ...series.reduce((acc, serie, idx) =>
      ({ ...acc, ...serie.data.reduce(/* scan every point of every series */) }), {}) }))
```

That is O(points² × series) with an object spread per series per date. Event reports never exceed ~100 buckets, so it has never mattered. Metric reports at `interval: 'minute'` over `last24h` are 1 440 buckets × 5 visible series × 1 440 inner iterations ≈ 10M iterations plus millions of allocations — on the surface whose whole selling point is resolution. The rewrite is one pass building `Map<date, row>` over every series, then materialising. Semantics unchanged; T3 pins them.

It also takes the x-axis from `series[0]` and matches by exact string equality, which is why the dense-identical-grid contract (Interfaces, item 3) is load-bearing and why the rewrite must preserve the "date domain comes from the series set" behaviour rather than quietly switching to a union.

**Rejected:** capping metric reports below the point count where the existing model is acceptable. That caps the feature to protect a hot loop nobody has profiled.

### D22 — `Combobox` and `ComboboxAdvanced` gain controlled search; they move out of "reused unchanged"

The metric picker specifies server-side search — a busy project has tens of thousands of series names — but `Combobox` keeps its term in internal `React.useState('')` with no `onSearchChange`, and re-filters client-side: `items.filter(item => item.label.toLowerCase().includes(search.toLowerCase()))` (`components/ui/combobox.tsx:74`, `:129-136`). `ComboboxAdvanced` has the identical problem with `inputValue` (`:46-56`). So the typed term cannot reach the server, and any server match that does not literally substring-match the label is filtered back out.

Additive, optional, both components:

```ts
  /** Controlled search term. When provided the parent owns it. */
  search?: string;
  onSearchChange?: (value: string) => void;
  /** Skip the built-in substring filter — the server already matched. */
  disableInternalFilter?: boolean;
```

`Command` already runs with `shouldFilter={false}` (`combobox.tsx:104`), so only the `VirtualList` predicate needs the flag.

**Rejected:** a bespoke metric-name picker. The virtualisation, keyboard handling and popover behaviour are the expensive parts and they already work.

### D23 — `useYAxisProps` gains an `allowDecimals` escape hatch, and `unit` is never auto-prefilled from OTel metadata

Two separate rendering defects, both invisible until a real metric is on screen.

**Fractional values.** `useYAxisProps` hardcodes `allowDecimals: false` (`components/report-chart/common/axis.tsx:39`) and is consumed by line, area, histogram, conversion, retention and funnel. Metric series are routinely fractional — `rate()` of a counter, error ratios, CPU seconds/sec, p95 in seconds. A metric report whose values are all below 1 gets a degenerate 0/1 axis with every point flattened against the floor. Add `allowDecimals?: boolean` to the options object and derive it from the data range at the metric call sites.

**`unit`.** The draft claimed `meta.unit` prefills the report's unit "so a saved bytes metric renders with a unit on the axis". `report.unit` never reaches an axis: it is read only by the tooltip (`common/report-chart-tooltip.tsx:113`), the metric card (`metric/metric-card.tsx:76`), the map's `value-suffix` (`map/chart.tsx:42`) and the retention table (`retention/table.tsx:114`). The shared Y axis formats with `number.short(value)` and no unit at all.

Worse, auto-prefilling would corrupt displayed values. `useNumber().formatWithUnit` special-cases `unit === '%'` by returning `format(round(value * 100, 1))` and `unit === 'min'` by re-interpreting the number as seconds through `fancyMinutes` (`hooks/use-numer-formatter.ts`). `%` is a legal OTel/UCUM unit, so a metric that is already a percentage would be shown 100× too large in every tooltip.

Decision: **no auto-prefill.** `meta.unit` is displayed as read-only metadata next to the metric name. If the user wants a unit on the report they type it, exactly as for an event report. If a later phase wants prefill, it goes through an explicit allowlist table that can never emit `%` or `min`.

**Rejected:** an `allowlist` of safe units for prefill in P2. It is the right eventual shape, but every entry is a guess until someone has looked at real catalogues.

### D24 — The connect flow is a Settings tab, unguarded by `isAdmin`, with the collector snippet as the only artefact

**A Settings tab, not a `_steps` wizard.** `routes/_steps.tsx` is the project-creation funnel: a full-screen overlay over `SkeletonDashboard` with a three-dot progress bar hardcoded to `Create project → Connect data → Verify`, whose children `beforeLoad`-redirect to `/onboarding` without a session. Telemetry is added to a project that already exists, from inside the app, possibly years later, by someone who is not the project creator.

**No `isAdmin` gate.** The draft gated the credentials block on `isAdmin` "matching how client secrets are treated in `_steps/onboarding/$projectId/connect`". That precedent does not exist: neither that route nor `settings/_tabs/clients` has an `isAdmin` gate, and a repo-wide grep finds `isAdmin` in `apps/start/src` only in `sidebar-organization-menu.tsx`, `project-selector.tsx`, `organization/yearly-switch-prompt.tsx`, `routes/_app.$organizationId.index.tsx` and the hook itself. Adding one here would make `/settings/telemetry` unusable for members who can read every other client secret in the product. Match the Clients tab.

Relatedly, `useOrganizationAccess` returns the **organization** role only (`{ role, isAdmin }` off `trpc.organization.myAccess`). Project access levels (`read`/`write`) are enforced server-side by `requireProjectAccess` (`packages/trpc/src/access.ts`) and there is **no client-facing procedure exposing "my access level on this project"**. So "hide Save to dashboard for read-level members" has no primitive to implement against. The honest version: the save affordance stays visible and `report.create` fails with a 403 that the `SaveReport` modal surfaces through `handleError` — which is what the app does today for every other write.

**One snippet, not six.** The draft's `FrameworkGrid` — "SDK-specific instructions (Node, Go, Python, Java, .NET, Rails)" from a new local list — is six correct OTel SDK setup guides. That is documentation work, it will not be verified by anyone on this stream, and it will rot. Ship the OTel Collector YAML from `buildCollectorSnippet()` plus a docs link; defer the per-language grid to P6 with its own owner, driven from a docs page rather than a component.

### D25 — Demo mode: explorers are read-only by construction, and the telemetry tab is hidden

`enforceAccess` throws on every mutation when `DEMO_USER_ID` is set (`packages/trpc/src/trpc.ts:95-97`), so "Save to dashboard" already fails. Rather than let the user find that out by clicking, `useAppContext().isDemo` hides the save button and hides the Telemetry settings tab entirely — there is no demo telemetry client and nothing useful behind it. The explorers themselves render against whatever the demo project has; if `observability.status.enabled` is false they show the not-enabled state (Design §9.1), which is the correct and cheap answer.

---

## Design

**Rejected:** letting the demo user click Save and read the 403. The mutation is guaranteed to fail; surfacing that as an error is a worse answer than not offering it.

### 1. Sidebar

`components/sidebar-project-menu.tsx` is a flat list of `<SidebarLink href icon label />` under two plain-`div` group headings, `Analytics` and `Manage`. A third group goes between them.

The component is **hook-free**: its only input is `dashboards: IServiceDashboards` (`:40-46`), and the `trpc.dashboard.list` query lives in `components/sidebar.tsx:39-44` and is prop-drilled. `projectId` is not in scope. Follow that pattern rather than introducing the file's first hook:

```tsx
// components/sidebar.tsx — beside the existing dashboards query
const { data: telemetry } = useQuery({
  ...trpc.observability.status.queryOptions({ projectId: projectId || '' }),   // S-H
  enabled: !!projectId,
  staleTime: 5 * 60_000,
});
// ...
<SidebarProjectMenu dashboards={dashboards} telemetry={telemetry} />
```

```tsx
// components/sidebar-project-menu.tsx — after Cohorts, before "Manage"
{telemetry?.enabled && (
  <>
    <div className="mt-4 mb-2 font-medium text-muted-foreground text-sm">Observability</div>
    <SidebarLink href={'/services'} icon={ServerIcon} label="Services" />
    <SidebarLink href={'/metrics'} icon={ActivityIcon} label="Metrics" />
    <SidebarLink href={'/logs'} icon={ScrollTextIcon} label="Logs" />
    <SidebarLink exact={false} href={'/traces'} icon={NetworkIcon} label="Traces" />
  </>
)}
```

- `SidebarLink` wraps `ProjectLink`, which builds `` `/$organizationId/$projectId/${href.replace(/^\//,'')}` `` and sets `activeOptions={{ exact: exact ?? true }}` (`components/links.tsx:32-56`). **`/traces` needs `exact={false}`** so the link stays lit on `/traces/$traceId`, the way `/settings` already does.
- Icons are `lucide-react` named imports, added to the existing import list.
- When `enabled` is false the group is absent, not greyed. A self-hoster without gigapipe should not see four dead links.
- `05-logs.md` §7.1 places `/logs` between Events and Sessions and `06` §7 places `/traces` between `/sessions` and `/profiles`. Both predate this grouping decision; one group with four entries is the position this stream takes, and those two lines in the sibling specs should be reconciled to it.
- `ActionCTAButton` gains one entry: `{ label: 'Explore metrics', icon: ActivityIcon, onClick: () => navigate({ to: '/$organizationId/$projectId/metrics', from: '/$organizationId/$projectId' }) }`. The rotating-label animation is index-driven over `ACTIONS` and needs nothing else.

### 2. Routes

File-based routing under `apps/start/src/routes/`, flat-dotted. A trailing `_` opts a child out of the parent layout — what `reports_.$reportId.tsx` does. `routeTree.gen.ts` is generated; never hand-edited.

| New file | Route id | Shape |
|---|---|---|
| `_app.$organizationId.$projectId.metrics.tsx` | `…/metrics` | explorer |
| `_app.$organizationId.$projectId.logs.tsx` | `…/logs` | `05-logs.md` §7.1 |
| `_app.$organizationId.$projectId.traces.tsx` | `…/traces` | `06` §7 |
| `_app.$organizationId.$projectId.traces_.$traceId.tsx` | `…/traces_/$traceId` | `loader` prefetch + waterfall, `pendingComponent: FullPageLoadingState` |
| `_app.$organizationId.$projectId.services.tsx` | `…/services` | card grid (P6) |
| `_app.$organizationId.$projectId.settings._tabs.telemetry.tsx` | `…/settings/_tabs/telemetry` | settings tab |

```tsx
// routes/_app.$organizationId.$projectId.metrics.tsx
import { createFileRoute } from '@tanstack/react-router';
import FullPageLoadingState from '@/components/full-page-loading-state';
import { MetricsExplorer } from '@/components/telemetry/metrics/metrics-explorer';
import { createProjectTitle, PAGE_TITLES } from '@/utils/title';

export const Route = createFileRoute('/_app/$organizationId/$projectId/metrics')({
  component: Component,
  head: () => ({ meta: [{ title: createProjectTitle(PAGE_TITLES.METRICS) }] }),
  pendingComponent: FullPageLoadingState,
});

function Component() {
  return <MetricsExplorer />;
}
```

**No `validateSearch`.** The draft declared `validateSearch: z.object({}).passthrough()` on all four routes and attributed the convention to `sessions.tsx`. `sessions.tsx` declares none (`routes/_app.$organizationId.$projectId.sessions.tsx:11-24`) while using `useSearchQueryState` and `useTableFilters('f')`; neither do `events._tabs.events.tsx` or the overview routes. Only routes with a real typed search param declare one. An empty passthrough schema is a no-op that adds a parse step and a router-search dependency to a page whose state is entirely nuqs-owned.

`PAGE_TITLES` (`utils/title.ts:78`) gains `METRICS`, `LOGS`, `TRACES`, `SERVICES`, `TELEMETRY`.

The settings tab is appended to the inline `settingsTabs` array literal in `routes/_app.$organizationId.$projectId.settings._tabs.tsx:41-50` — a plain literal in the component body, no registry — and **gated on `observability.status.enabled`**, or a self-hoster with no gigapipe gets a tab leading to "Observability is not enabled on this deployment", which is the same dead-link problem D12 rejects for the sidebar. While the status query is loading the tab is omitted, not rendered-then-removed.

**Rejected:** a `_tabs` shell over metrics/logs/traces. The three surfaces do not share a time range in any useful way — you land on a trace from a log line, not from a tab — and `usePageTabs` derives the active tab from the last path segment, which breaks the moment `/traces/$traceId` is open.

### 3. The time window

The surfaces reuse `<OverviewRange />` and `<OverviewInterval />` (`components/overview/`), thin wrappers over `TimeWindowPicker` / `ReportInterval` bound to `useOverviewOptions()`. That gives the same nuqs keys as every other page (`range`, `start`, `end`, `overrideInterval`) for free.

Two consequences the draft presented only as benefits:

1. **The default is `7d` from a shared cookie** (`components/overview/useOverviewOptions.ts:30-32`), and `getDefaultIntervalByRange('7d') === 'day'`. The first metrics chart a user ever sees would be seven daily buckets — which the engine's calendar grid renders faithfully, but which is not what anyone opens a metrics explorer for.
2. **`setRange` writes the shared cookie** for every non-custom value (`useOverviewOptions.ts:71-80`). A user who picks "Last 30 min" on `/metrics` re-defaults Overview, Sessions, Events, Pages and SEO to 30 minutes on their next visit.

Decision: the observability routes call `useOverviewOptions({ cookieKey: 'telemetryRange', defaultRange: 'lastHour' })` — an additive two-option signature on a hook whose current behaviour is the no-argument default. Telemetry defaults to `lastHour` and does not touch the analytics cookie.

`ReportInterval` returns `null` unless `chartType` is one of `linear | histogram | area | metric | retention | conversion`, and `OverviewInterval` passes `chartType="linear"`, so it renders. `isMinuteIntervalEnabledByRange` allows `minute` only on `30min` / `lastHour` — which is exactly the telemetry default, so minute resolution is available on the range that matters. Note that gating is **client-side only**; the server accepts any `(range, interval)` pair, which is why the engine owns the point-budget guard (Interfaces, item 5).

### 4. Metrics explorer — `/metrics`

#### 4.1 Layout

```
PageContainer
├─ PageHeader title="Metrics" description="Query metrics sent by your services"
│   actions: [ <OverviewRange/> <OverviewInterval/> <SaveMetricReportButton/> ]
├─ MetricQueryCard                          (card, always visible)
│   ├─ row 1: MetricPicker [type badge] | FnPicker | WindowPicker | AggregationPicker
│   ├─ row 2: GroupByCombobox (multi) | ScaleInput | unit (read-only, D23)
│   ├─ row 3: MetricLabelFilters  (+ Add filter → LabelCombobox)
│   └─ footer: <details> Query → <Syntax code={compiled}/>   (D14, pending 03's accept)
└─ result
    ├─ <ReportChart report={draftReport} data={…} isLoading={…} error={…}
    │      lazy={false} options={{ showTable: true, renderSerieIcon }} />
    └─ (ReportTable comes from options.showTable — D18)
```

`PageContainer` is `container p-8`; `PageHeader` takes `title`/`description`/`actions`. Both are used exactly this way on `sessions.tsx` and `dashboards_.$dashboardId.tsx`.

The explorer owns the query (D2/D5):

```tsx
const q = useMetricExplorerState();            // nuqs, §4.2
const res = useQuery({
  ...trpc.observability.metrics.chart.queryOptions({   // S-E: one observability.* root
    projectId, range, startDate, endDate, interval,
    chartType, metric: reportMetric, limit: q.limit,   // report.limit — page-local, D4
    series: [q.metricQuery],                            // zMetricQuery, 03 §2 (S-A)
  }),
  enabled: !!q.metricQuery,                    // ← the whole of F5's mitigation
  placeholderData: keepPreviousData,
});

if (!q.metricQuery) return <MetricsPickAMetricCard />;   // never mounts ReportChart

return (
  <>
    <ReportChart
      lazy={false}
      report={draftReport}
      data={res.data}
      isLoading={res.isLoading}
      isFetching={res.isFetching}
      error={res.error}
      options={{ showTable: true, renderSerieIcon: renderMetricBadge }}
    />
    {res.data?.notices?.length ? <ChartNotices notices={res.data.notices} /> : null}
    <CompiledQuery compiled={res.data?.compiled} />
  </>
);
```

`MetricsPickAMetricCard` is a small local component, **not** `ReportChartEmpty`. The draft proposed handing `<ReportChart>` a report with `series: []` and letting `ReportChartEmpty`'s no-series branch render "Start here / Ready when you're". Three things are wrong with that: the query fires anyway (the only gate is `enabled: !isLazyLoading`, and §4.1 sets `lazy={false}` to defeat the other one); with the query pending `res.isLoading` is true so the component returns `<Loading/>` and the user never sees the affordance; and the copy is `"Pick atleast one event to start visualize"` (`components/report-chart/common/empty.tsx:40`) — event-specific, and with a typo. Copy the markup, write metric copy.

`ReportChartEmpty` should still gain an optional `description` prop so its no-series branch is not hardcoded to events, but that is a nicety, not the mechanism.

The draft report handed to `<ReportChart>` is a plain `IReportInput` — the same trick `components/profiles/profile-charts.tsx` already uses:

```ts
const draftReport: IReportInput & { id?: string } = {
  projectId,
  // No `dataSource` key. S-B: the data source is DERIVED from the series
  // (`getReportDataSource(series)`), and an unknown key is stripped by zod anyway.
  chartType,                 // nuqs `chart`, default 'linear'
  interval, range, startDate, endDate,   // useOverviewOptions
  previous: false,           // see §4.6
  metric: 'average',         // only read by the `metric` card renderer
  breakdowns: [],            // D19 — always empty for metrics
  series: [metricQuery],
  name: '',
};
```

#### 4.2 Explorer state (nuqs keys)

| Key | Parser | Default | Meaning |
|---|---|---|---|
| `range`, `start`, `end`, `overrideInterval` | `useOverviewOptions()` | `lastHour` (telemetry cookie, §3) | shared vocabulary, separate cookie |
| `m` | `parseAsString` | `null` | `zMetricQuery.metric` — the stored Prometheus name |
| `mt` | `parseAsStringEnum(zMetricType.options)` | from the catalogue entry | `metricType`. **Four** values including `summary` (S-A) |
| `fn` | `parseAsStringEnum(zMetricFn.options)` | `REDUCER_TABLE[mt]`'s first key (§4.3) | eleven-member enum, narrowed per `mt` by `REDUCER_TABLE` |
| `w` | `parseAsStringEnum(zMetricWindow.options)` | `auto` | `window` is an **enum**, not free text (S-A) |
| `agg` | `parseAsStringEnum(zMetricAggregation.options)` | `sum` | `sum\|avg\|min\|max\|count`. Required once `by` is non-empty |
| `q` | `parseAsFloat` | `0.95` | `quantile`, only for `fn === 'histogram_quantile'`, and required there |
| `by` | `parseAsArrayOf(parseAsString)` | `[]` | `groupBy`, max 8, unique |
| `lf` | `eventQueryFiltersParser` via `useTableFilters('lf')` | `[]` | `filters` (D10), adapted to `IMetricLabelFilter` by D9's adapter |
| `sc` | `parseAsFloat` | `1` | `scale`. `sc=100` with `unit: '%'` is the ratio idiom (03 §9.1) |
| `chart` | `parseAsStringEnum(METRIC_CHART_TYPES)` | `linear` | |
| `limit` | `parseAsInteger` | unset | `zReportInput.limit`, honoured as `min(cfg.maxSeries, limit)` (03 §12.6). **Page-local: it is not a Prisma column and a saved report will not remember it** (D4) |

Corrected from the previous revision (S-A): the keys `mt` (three values) and `max` (`seriesLimit`) described fields that do not exist. `max` is replaced by `limit`, which does, and which is honoured by the engine rather than by a picker.

All with `{ history: 'push' }`, matching `nuqsOptions` in `use-event-query-filters.ts` and `useOverviewOptions.ts`.

**No Redux.** The report editor's slice exists for a `dirty` flag, a save button and a teardown `reset()`; the explorer has none of those — its "save" is a modal that takes a plain object. With D18 that claim is now actually true; in the draft it was not.

#### 4.3 `MetricPicker`

Two calls, one control. Both are `protectedProcedure`s owned by `03-metrics-engine.md` (`metricNames`, `metricLabels`, `labelValues` in `packages/trpc/src/routers/metrics.ts`), whose non-negotiable rule is that `match[]` is constructed server-side from the authenticated `projectId` and a client-supplied matcher array is rejected outright.

- `metricNames({ projectId })` → `MetricCatalogEntry[]` (`resolveMetricCatalog`, Redis-cached 5 min). Search is client-side over the catalog when it is small and server-side via `search` when it is not; either way the control uses the D22 controlled-search props so the two are interchangeable without touching the picker.
- `metricLabels({ projectId, metric })` → `string[]`, `enabled: !!m`, feeds `GroupByCombobox` and the label-filter picker.

The catalog entry carries `type` and `unit`, which drives the badge, the read-only unit display (D23) and the defaults. **Corrected against `REDUCER_TABLE` (03 §2, S-A)** — the previous revision's `fn: 'value'` for a gauge is not a member of `zMetricFn`:

| `metricType` | default `fn` | default `agg` | note |
|---|---|---|---|
| `counter` | `rate` | `sum` | a raw counter is a monotonically rising line nobody wants. Legal: `rate`, `increase`, `delta` |
| `gauge` | `none` | `avg` | `none` is the instantaneous value; `rate` on a gauge is meaningless and `REDUCER_TABLE` forbids it. Legal: `none` plus the five `*_over_time` |
| `histogram` | `histogram_quantile` | `sum` | the only legal `fn`. Compiles to `histogram_quantile(q, sum by (le) (rate(…_bucket[w])))`; the engine appends `_bucket`, so `metric` stays the base name (03 D5) |
| `summary` | `none` | `avg` | the fourth type the previous revision omitted. `refineMetricQuery` **requires** a `quantile` label filter, so the picker adds that row itself — without it p50, p90 and p99 are averaged into one meaningless number |

`FnPicker`'s options are `Object.keys(REDUCER_TABLE[metricType])`, not a UI-local list, so an illegal combination cannot be produced and the zod error is unreachable from the picker. Defaults are applied on metric change, not locks.

**Metric names are rewritten on ingest, and the picker must say so.** `buildMetricName` (`writer/utils/unmarshal/otlp_metrics_naming.go:148-161`) normalises the charset, appends the unit word, appends `_per_<unit>`, and appends `_total` for monotonic sums. `http.server.request.duration` with unit `s` is stored as `http_server_request_duration_seconds`; `messages.sent` as a monotonic counter becomes `messages_sent_total`. A user searching for the name they wrote in their code gets zero results and concludes ingest is broken — on the first screen after setup. So: the picker normalises the query the same way (dots and dashes to underscores, tolerate a missing unit suffix and a missing `_total`), and both the picker's empty state and the settings tab carry one line — *"Metric names are normalised to Prometheus convention: `http.server.request.duration` (unit `s`) is stored as `http_server_request_duration_seconds`."*

#### 4.4 Label names — `job` is the query key on metrics, and `service.name` never appears

This is the single most consequential naming fact in the stream, and the draft got it wrong in both directions.

gigapipe's OTLP metrics decoder follows the OTel→Prometheus compatibility spec. In `otlpMetricsDec.Decode` (`writer/utils/unmarshal/otlp_metrics.go:118-160`), `service.name` and `service.namespace` are folded into **`job`** (`rs.job = serviceName`, or `namespace + "/" + serviceName`), `service.instance.id` becomes **`instance`**, and every *other* resource attribute goes into `rs.targetAttrs` — which is consumed only by `emitTargetInfo` (`:495-518`), writing a **separate `target_info` gauge**. `seriesLabels` (`:239-268`) merges scope labels, **data-point** attributes, `__name__`, `job`, `instance`, the extras (`le`, `quantile`) and metric metadata. Nothing else.

So on metric series there is **no `service.name` and no `service_name` derived from the resource**. The correct query key is `job`.

`service_name` does nonetheless exist on metric series, and this is where a naive reading goes wrong in the other direction: the shared insert pipeline runs `discoverServiceName` (`writer/utils/unmarshal/builder.go:300-316`, called at `:348` for every signal), which appends `service_name` derived from the last matching entry of a candidate set that includes `job`, `name`, `container`, `workload`, `component`, `app`… `otlp_metrics_test.go:469-471` asserts it is present alongside `job`. But because the candidates are scanned in the sorted label order and the *last* match wins, an unrelated data-point attribute called `name` or `workload` captures it. **`service_name` on metrics is a heuristic convenience label, not an identity.** Correlation link builders must use `job`.

```ts
// apps/start/src/components/telemetry/labels.ts  (new)
/**
 * The same OTel concept is spelled three ways because three decoders wrote it.
 * Verified in gigapipe at HEAD:
 *  - metrics: otlp_metrics.go:142-146 folds service.name -> `job`; resource
 *    attributes never reach a series label (:245-260 + :495-518).
 *  - logs:    otlplogs.go:107-117 SanitizeKey rewrites [^a-zA-Z0-9_] to '_'.
 *  - traces:  otlp.go writes attribute keys literally; dots survive.
 */
export const TELEMETRY_LABELS = {
  metrics: {
    service: 'job',          // canonical. NOT service_name — see the note above.
    instance: 'instance',
    project: 'op_project_id',
  },
  logs: {
    service: 'service_name',
    session: 'op_session_id',
    profile: 'op_profile_id',
    trace: 'trace_id',
    span: 'span_id',
    level: 'level',
    project: 'op_project_id',
  },
  traces: {
    service: 'service.name',
    session: 'op_session_id',   // T4: snake_case on purpose, on all three signals
    profile: 'op_profile_id',
    project: 'op_project_id',
  },
} as const;
```

`op_session_id` / `op_profile_id` are fixed by `06-traces-and-correlation.md` T4 — deliberately snake_case with no dots, precisely so the log decoder's `SanitizeKey` cannot make them differ across signals. `service` is the field that genuinely differs and must be read from this map, per signal, everywhere.

**The `op_project_id`-on-metrics question is already closed, and not by this stream.** Because resource attributes never reach a series label, a resource-level `op_project_id` — which is what a collector `resource` processor produces — would land on `target_info` and nothing else, and the mandatory matcher would match zero series. `02-ingest-gateway.md` D3 and §4.1 solve this by stamping `op_project_id` on the resource **and on every data point**, for exactly this reason, and keep the resource stamp so `target_info` is itself deletable. Nothing here needs escalating; the UI just must never build a metrics matcher out of a resource attribute it did not see stamped per-point.

Attribute-key collisions are merged, not overwritten: `mergeSanitizedAttrs` (`otlp_metrics.go:98-116`) joins the values of distinct keys that sanitize to the same label name with `';'`, in lexicographic order of the original keys, per the OTel spec. Two attributes `user.id` and `user-id` become one label `user_id` with value `a;b`. The label-value UI shows the raw stored value; it does not attempt to split it.

#### 4.5 `LabelCombobox` and `MetricLabelFilters`

`PropertiesCombobox` is a two-level dropdown over `event | profile | group | cohort | session` with a hardcoded `SESSION_ACTIONS` list and `useEventProperties`. Threading a signal, a metric name and a project window through an API whose shape is `{ event, categories, onSelect }` buys nothing when there is exactly one flat namespace.

New `components/telemetry/label-combobox.tsx`, built on `Combobox` (which already does `searchable`, `rc-virtual-list` virtualisation and a `CommandEmpty` slot) with D22's controlled-search props. Props `{ signal, metric?, value, onChange, projectId, range, startDate, endDate }`; calls `metricLabels` / `logs.labels` / `traces.tagKeys` per signal with `staleTime: 10 * 60_000`, matching `useEventNames`.

`MetricLabelFilters` (§D9) renders one `PureFilterItem` per filter with `values` supplied and `operatorAllowlist` fixed to `eq`/`neq`/`re`/`nre`. Candidate values come from `labelValues({ projectId, metric, label, search })` — one query per rendered row, owned by the **parent**, because a hook cannot be called conditionally.

**Trace tag keys are the expensive one, and this control is what fires them.** `06-traces-and-correlation.md` §6.4's "load all tag keys" query and §13.3's `span_profile` CTE are declared exceptions to that spec's own prefix invariant: the outer read has no `key` predicate, so it scans the window's `tempo_traces_attrs_gin` rows for **every project** before the `(trace_id, span_id)` intersection prunes it — 06 §12 prices that at ~1.5 M gin rows per minute across all tenants, ~22 M at the 15-minute clamp. This document wires a combobox to it on a user action with a 10-minute `staleTime`, and `04-read-path.md` §8.4's per-project lease **fails open on any Redis error** (its F17: "these are fairness controls, not security controls"). Three requirements follow, and they are asks on other streams:

1. **Prefer promoting `06` T16's gateway-written tag dictionary (`telemetry_trace_tag_keys`) from P6 to a P4 prerequisite.** 06 itself prices it as "a rounding error next to the 2.8 GB/day the gateway already writes". Then the combobox reads a dictionary and none of this applies.
2. Failing that, **`rateLimitMiddleware` on `observability.traces.tagKeys` and `.tagValues`** (06 §6.6), because the lease is not a control here.
3. Until one of those lands, the "load all keys" action stays behind an explicit click with the 15-minute clamp and a visible cost hint — never on focus, never prefetched, never on mount. The default remains 06 T16's page-derived key set.

The same posture applies to `metricLabels`/`labelValues`: page-scoped, `staleTime: 10 * 60_000`, fired on open rather than on render.

#### 4.6 `previous`, and what the explorer does not offer

`format()` populates `IChartSerie.data[].previous` and `Metrics.previous` by aligning the previous-period response **by array index** (`packages/db/src/engine/format.ts:142`). `PreviousDiffIndicator`, the tooltip's previous row (`common/report-chart-tooltip.tsx:116`), `MetricCard` and `useDashedStroke` all read those fields.

For metrics that alignment is only sound when both windows produce the same bucket count, which the calendar grid guarantees for `hour`/`day` and does not guarantee across a DST boundary or a month of different length. Rather than render a silently mis-aligned comparison, **the explorer sets `previous: false` and hides the toggle in P2**; the editor keeps it for saved metric reports only once the engine confirms bucket-count parity (Interfaces, item 6). This is a deliberate P2 cut, not an oversight.

#### 4.7 Series identity, ordering, colour

`getChartColor(idx)` is called by `useRechartDataModel` with the **array index**, and `useVisibleSeries` resolves visibility against `serie.id` behind a `seriesKey = data.series.map(s => s.id).join(',')` guard that resets the selection whenever the id set changes (`hooks/use-visible-series.ts:23-32`). Both are index/id-stable-or-nothing.

So the engine contract is: `IChartSerie.id` is a pure function of `(definitionId, sorted label tuple)`, and `series[]` arrives in a deterministic order. gigapipe emits labels in Go map order, so an id built by concatenating labels in emission order returns different ids on consecutive identical calls — the recharts `dataKey` changes under the tooltip and the persisted `visibleSeries` string array on the `Report` row decays to nothing. The UI cannot defend against this; it is a blocker, not a mitigation (Interfaces, item 2).

Beyond `id`, the renderers read three more fields the draft never specified. `useRechartDataModel` puts `serie.event` and `serie.names` into every tooltip payload (`hooks/use-rechart-data-model.ts:36-41`); `SerieName` renders `names[]` as a chevron-joined path (`common/serie-name.tsx:19-35`); `report-table` groups by `event.breakdowns`. The contract this stream needs:

```ts
names = [displayName ?? metric, ...groupByValues in the declared groupBy order]
event = {
  id: definitionId,                     // the alpha id, so colour/letter line up
  name: displayName ?? metric,
  breakdowns: Object.fromEntries(groupBy.map((l, i) => [l, labelValues[i]])),
}
```

#### 4.8 Save to dashboard

```tsx
const report: IReport = {
  ...draftReport,
  name: suggestName(metricQuery),        // e.g. "rate(http_requests_total) by job"
  lineType: 'monotone',
};
pushModal('SaveReport', { report, disableRedirect: true });
```

`SaveReport` (`modals/save-report.tsx:22, 56-83`) navigates to `/$organizationId/$projectId/reports/$reportId` **unless** `disableRedirect` is passed. The draft omitted it while its own rejected-alternative argued that throwing the user out of the explorer was a reason to reject a different design. Pass it; the toast already carries a "View report" action (`:70-76`), and `chat-report-result.tsx:101-103` sets the same flag for the same reason.

`SaveReport` reads a pre-selected dashboard from `useSearch({ from: '/_app/$organizationId/$projectId/reports', shouldThrow: false })`, which returns `undefined` on the explorer routes, so `SelectDashboard` requires an explicit pick. Correct behaviour, no change.

**Rejected:** `dispatch(setReport(draft))` then navigating to `/reports`. `ReportEditor`'s effect teardown dispatches `reset()` on unmount, so the dispatch races the route transition.

### 5. Metric reports in the editor

`components/report-chart/report-editor.tsx` is a `Sheet` whose left side is `ReportSidebar` and whose toolbar is a 6-column grid: `[Pick events] [ReportChartType] [TimeWindowPicker] [ReportInterval] [ReportLineType] [ReportSaveButton]`. It renders `<ReportChart isEditMode report={{ ...report, projectId }} />` off `useSelector((state) => state.report)` (`:37`, `:118`).

Changes, all conditioned on `getReportDataSource(report.series) === 'metrics'` — a derivation, not a column (S-B). The helper is imported from `packages/db/src/engine/data-source.ts`; the editor does not re-implement `series.some(...)` inline, because the picker gating, the drill-down suppression and MCP all have to agree with the executor:

| Control | Change |
|---|---|
| `[Pick events]` `SheetTrigger` | relabel **"Pick metrics"**, icon `ActivityIcon` |
| `ReportChartType` | `include={METRIC_CHART_TYPES}` (D16) |
| `TimeWindowPicker`, `ReportInterval`, `ReportLineType` | unchanged |
| `ReportSaveButton` | `useIsFetching` list gains `trpc.chart.aggregate.pathFilter()` (D16) — unconditional, fixes bar/pie for event reports too |

`ReportSidebar` composes `ReportSeries | ReportFixedEvents`, `ReportGlobalFilters`, `ReportBreakdowns`, `ReportSettings`. For metrics:

- `ReportSeries` → `ReportMetricSeries` (new).
- `ReportGlobalFilters` — **hidden**. Global filters are `zChartEventFilter[]` applied to every series; for metrics the equivalent is per-series label filters, and a global label filter applied to two series with disjoint label sets silently empties one of them. Rejected the alternative (compile global filters into every metric series' `filters`) for exactly that reason. This agrees with 03 §12.6, which records `globalFilters` as **ignored, safely**: `mergeGlobalFilters` maps `item.type === 'event' ? {...} : item` (`reports.service.ts:29-41`), so a metric item passes through untouched and no guard needs adding.
- `ReportBreakdowns` — **hidden** (D19).
- `ReportSettings` — `fields` gains a metrics branch: drop `previous` in P2 (§4.6), keep `metric` when `chartType === 'metric'` (and **exclude `count`**, which is always `undefined` for a metric report — 03 §10.3), default `metric` to `average` rather than `sum` for series whose reducer is `avg` or `last` (03 §10.1), keep `stacked` for histograms, add a read-only unit display plus the `scale` field (D23, 03 §9.1). There is no "Max series" control — `seriesLimit` does not exist (S-A, D4).

The editor has **no data-source switcher**. A report's data source is a function of its series, and it is immutable in practice: switching would have to discard every series, and there is no non-destructive semantics for "turn this event report into a metric report". `refineReportInput` (03 §15.2) enforces the homogeneity rule server-side — a `series` array containing both `type:'event'` and `type:'metric'` items is rejected, because the two backends produce different date grids and `use-rechart-data-model.ts` builds the x-axis from `series[0]` alone. Formulas may accompany either.

`ReportMetricSeries` (`components/report/sidebar/ReportMetricSeries.tsx`) is the same shell as `ReportSeries` — `DndContext` + `SortableContext` + a `ColorSquare`/`alphabetIds[index]` drag handle — with each row's body a compact `MetricQueryCard` instead of `ComboboxEvents`:

```
[A]  MetricPicker  [type]            [displayName]   [⋯]
     fn ▾   window ▾   agg ▾   by ▾   scale
     MetricLabelFilters
```

`[⋯]` is the existing `ReportEventMore`. `[+ Add metric]` dispatches `addSerie({ type: 'metric', metric: '', metricType: 'gauge', fn: 'none', aggregation: 'avg', filters: [], groupBy: [], window: 'auto', scale: 1 })` — corrected to 03 §2's field names and legal values (S-A: `filters` not `matchers`, `fn: 'none'` not `'value'`). `addSerie` takes `UnionOmit<IChartEventItem,'id'>` and assigns `shortId()`, so it accepts the new member with no reducer change. Note the empty `metric: ''` fails `PROM_METRIC_NAME`, so the row is draft-only until a metric is picked and the save button must reflect that — the editor's existing `dirty`/`ready` lifecycle is where that lives.

`[Add Formula]` **is** shown: `03-metrics-engine.md` D1 reuses `compute()` verbatim over metric series and `refineReportInput` explicitly permits formulas in both data sources. The draft hid it behind an `UNVERIFIED`; that question is settled.

**Series bound:** `cfg.maxMetricSeriesPerReport = 6` (03 §12.6), matching `zMetricReportInput.series.min(1).max(6)`. `[+ Add metric]` disables at six with the reason stated, rather than letting the save fail on a zod error.

### 6. Dashboard grid and the public share

`components/report/report-item.tsx` renders `<ReportChart report={{ ...report, range, startDate, endDate, interval }} />` inside a `card` with a `.drag-handle` for `GrafanaGrid`; `useReportLayouts(reports)` reads `report.layout?.{x,y,w,h}`. None of it touches `chartType` or the series shape, so a metric report tiles, drags, resizes and persists its layout with no changes — **provided D6 and D8 land**, because `report.list → getReportsByDashboardId → transformReport` is the read path.

Two real edits:

- `report-item.tsx` types `report: any`, which is why nothing here breaks and also why nothing here is checked. Tighten to **`NonNullable<IServiceReport>`** — `IServiceReport = Awaited<ReturnType<typeof getReportById>>` and `getReportById` returns `null` (`packages/db/src/services/reports.service.ts:15, 131-145`), so the bare alias includes `null` and every `report.chartType` access would error. `components/grafana-grid.tsx:9-11` already uses `NonNullable<IServiceReport>[]`.
- `report-item.tsx` applies `report.chartType === 'metric' && 'p-0'` to the body. Unchanged.

**Public share — and this is the one place in the stream with an unowned security requirement.**

`chartProcedure` (`packages/trpc/src/routers/chart.ts:83-141`) is a `publicProcedure` that, given a `shareId`, validates the share, loads the report and puts it on `ctx.report`; `chart.chart` then merges caller-supplied `range`/`startDate`/`endDate`/`interval` over it (`:598-606`). So an **anonymous** caller controls the time window of a saved metric report.

`01-tenancy-and-security.md` D12 and `04-read-path.md` D4/§7.2 put the "telemetry is never share-reachable" guarantee in `observabilityProcedure`, which rejects `shareId` outright — but that only covers the `observability.*` router. The moment P2.5 lets a `Report` hold a metric series, D5 routes it through `chart.chart`, i.e. `chartProcedure`, and the guarantee no longer describes reality. **Nothing in the plan owns that transition.** Verified: `packages/trpc/src/trpc.ts:206-211` keys the 60 s cache on `trpc:${path}:` + `JSON.stringify(getRawInput())` with **no user component**, so an anonymous caller varying the window also controls the cache key; `rateLimitMiddleware` exists (`trpc.ts:135-139`) and appears **zero times** in `chart.ts`; and gigapipe is a single Go process with a hard-coded 30 s PromQL timeout and one **global** `MaxSamples` budget shared across every tenant (`reader/router/prometheus_query_range.go:31-32`). One share link is therefore an unmetered, unrate-limited cross-tenant query generator requiring no credential.

**Owner: the P2.5 report-adoption work in `03-metrics-engine.md` §15**, which is where the metric series first becomes share-reachable; `03` §12.5 already states the core of it ("P2.5 cannot ship the share path without `rateLimitMiddleware` on the metric procedure, keyed on `shareId` plus IP. That is a hard prerequisite"). This document adds the three requirements 03 §12.5 does not carry, and makes all four a gate on P2.5 rather than on P2:

- **(a) A four-field window allow-list on the share path.** `01-tenancy-and-security.md` §7.1's allow-list — `range`, `startDate`, `endDate`, `interval` and nothing else — applied in `chart.chart` when `ctx.report !== null`, with an explicit `getReportDataSource(ctx.report.series) === 'metrics'` branch and **no fallback to `input.series`**. A share link must not be able to vary `series`, `filters`, `groupBy` or `breakdowns`.
- **(b) `rateLimitMiddleware` keyed on `shareId` + trusted IP on every share-served chart procedure** — not only the metric one. The event path has the same unmetered property today; adding it for metrics alone leaves the cheaper half of the hole open, and the middleware already exists.
- **(c) A separate `withProjectLease` bucket for share traffic**, the way `07-alerting.md` D15 does for alert evaluation, so anonymous readers cannot consume the authenticated members' concurrency budget.
- **(d) A Tier-1 test** that a share link cannot vary `series`, `filters` or `breakdowns` (T11).

Three further consequences:

1. `compiled` never reaches this path at all — it is a field on `MetricChartResult`, which only `observability.metrics.chart` returns (D14, S-C). `chart.chart` returns a bare `FinalChart` and gains no new field. This is a change from the previous revision, which relied on a `ctx.report === null` conditional inside a resolver.
2. The point-budget guard is server-side and applies to the share path identically. gigapipe aligns `start`/`end` to a 15 s boundary and rejects `(end - start) / step > 11000` with a **500** (`reader/controller/prom_query_range.go:55-70`) — it does not floor the step, which the draft asserted. The engine's ceiling is **`cfg.maxPoints = 3000`** with the step resolved to the *coarsest* fitting sub-bucket (`resolveStep`, 03 §6.1/§6.3/D7) — not the "8 000" the previous revision cited and not `04-read-path.md` §4.3's `TARGET_MAX_POINTS = 1_500` smallest-fitting loop, which 03 §Interfaces amendment 4 asks 04 to delete (S-G). It sits well below gigapipe's 11 000, so a share viewer gets a coarsened interval and a visible `interval_coarsened` notice rather than a broken card.
3. **Wind-down / quota must be enforced on the read side, on the share path too.** `observability.status.blocked` is a `protectedProcedure` an anonymous viewer never calls, and `subscriptionHook` (`apps/api/src/hooks/subscription.hook.ts`) gates only ingest. Without a server-side check, a wound-down organisation's public metric share keeps issuing gigapipe queries indefinitely — which matters more than for events, because the plan meters telemetry volume separately for billing. `executeReport` performs the `blocked` check when `getReportDataSource(input.series) === 'metrics'` (S-B) and returns a typed `TRPCError` the share page renders as an "unavailable" state, conditioned the same way `subscriptionHook` is (`SELF_HOSTED === 'true'` short-circuits). This is the reason S-H asks 04 to add `blocked` to `observability.status`: the banner and the server-side gate must read one value.

`share.dashboardReports` returns `getReportsByDashboardId(...)` with no chart-type filtering, so any report on a shared dashboard renders; metric reports inherit that correctly. A pre-existing bug sits next door — a `sankey` report on a shared dashboard calls a `protectedProcedure` with no `shareId` and errors for anonymous viewers. Not introduced here, not fixed here.

### 7. The union-narrowing audit

`apps/start` narrows `zChartEventItem` with **casts**, not switches, so widening the union to three members produces zero TypeScript errors in the places that matter most.

#### 7.1 Sites the compiler catches

`transformReportEventItem` (D7) — `item.segment` and `item.property` after the `formula` early return. Two errors, both real.

#### 7.2 Sites the compiler does not catch — the hand-audit list

| Site | Today | Required change |
|---|---|---|
| `components/report/sidebar/ReportSeriesItem.tsx` | `isFormula ? null : (normalizedEvent as IChartEventItem & { type: 'event' })` | 3-way switch + `never` default; `metric` renders the metric row |
| `components/report/sidebar/ReportSeries.tsx` | six inline `(event as IChartEventItem & { type:'event' }).name` / `.displayName` / `.filters[0]?.value` | 3-way switch + `never`; **and** an early `return <ReportMetricSeries/>` when `dataSource === 'metrics'` |
| `modals/view-chart-users.tsx` | `serie.type === 'event' ? … : 'Formula'` | would label a metric serie "Formula"; make it a switch. The drilldown itself is suppressed by D17 |
| `components/report/reportSlice.ts` `duplicateEvent` | branches `'event'` vs else | add a `'metric'` branch that re-ids the copied item and its `filters` the way the event branch does (the field is `filters` on both — S-A) |
| `packages/db/src/services/reports.service.ts:154` `listReportsCore` | ternary constructing `{type:'event', …}` | **silent coercion with a write-back path** — D7 |
| `packages/db/src/engine/index.ts:112` | `definition as IChartEventItem & { type: 'event' }` | defence in depth: unreachable only if D6's dispatch is complete at all four sites |
| `packages/db/src/engine/index.ts:239` | same | same |
| `packages/db/src/engine/plan.ts:20` | same | same |
| `components/report-chart/retention/index.tsx`, `conversion/summary.tsx` | `.filter(i => i.type === 'event')` | correct by construction — unreachable for metrics (D16) |
| `packages/db/src/services/reports.service.ts` `onlyReportEvents` | `.filter(i => i.type === 'event')` | correct by construction |

Every listed switch gets `default: { const _exhaustive: never = item; return _exhaustive; }`. That arm is not decoration — it is the only mechanism that turns the *next* union addition into a compile error instead of a silent coercion.

### 8. Logs and traces — the seams only

Both surfaces are specified in full elsewhere. What this stream contributes:

- **Routes, sidebar entries, `PAGE_TITLES`** (§1, §2).
- **Capability gating and the empty/blocked states** (§9). `05-logs.md` and `06` assume these exist.
- **The `PureFilterItem` seam** (D9), including the `enabled: values === undefined` guard `05-logs.md` does not currently specify.
- **`components/syntax.tsx`** — it registers exactly four languages (`typescript`, `json`, `bash`, `markdown`, at `:11-14`) and types its `language` prop to that union (`:19`). The collector snippet is YAML. Passing an unregistered language renders plain text; passing `bash` applies shell rules to YAML, which is worse than plain. Register `yaml` from `react-syntax-highlighter/dist/esm/languages/hljs/yaml` and widen the union. (A `promql` highlighter does not exist in hljs; the compiled-query disclosure uses the widened union's `bash`, which is honest for a single-line selector, or plain — decide at implementation time, it is cosmetic.)
- **Correlation link direction and key names** (§4.4's `TELEMETRY_LABELS`). A link out of a span to logs flips from dotted to underscored across one navigation; that is the whole reason the map exists.
- **`routes/…sessions_.$sessionId.tsx`** gains a "Server logs" `Widget` below the existing session widgets in P4, querying by `TELEMETRY_LABELS.logs.session` with `enabled: status.signals.logs` (S-H), rendering **nothing** when the result is empty. A session that never touched an instrumented backend must not grow an empty panel. `06-traces-and-correlation.md` §8/§11 owns how `op_session_id` gets propagated in the first place; until that lands this widget is dark.

  **And the widget must state the retention asymmetry, because the funnel behind it is long.** 06 §11 puts session correlation behind five steps, every one of which can be skipped: `propagateSession.enabled` defaults to false (correctly — it sends a user identifier into a backend telemetry store), `patchFetch` defaults to false and 06's own effort table lists it as "cut first", the customer must install a published `@openpanel/otel` package and register a span processor, the `baggage` header is not CORS-safelisted so any cross-origin call needs the customer's own `Access-Control-Allow-Headers`, and the first request of every new session carries no session id at all because `this.sessionId` is populated from the `/track` response. On top of that, traces inherit gigapipe's `SAMPLES_DAYS`-derived TTL — 7 days on `10-ops-retention-billing.md` D9's cloud defaults — while sessions are retained far longer. **So for the majority of sessions a user clicks, the correct render is "traces are retained for N days" and not "no traces".** 06 already requires that sentence; this document makes it a hard requirement of the widget rather than a nicety, and adds: the widget renders the retention line whenever the session's `createdAt` is older than `status.retentionDays`, *before* issuing the query.

  **Ask, before P4 is committed:** run 06's correlation funnel end to end against one real design partner — their SDK version, their collector, their actual cross-origin topology — and record how many of the five steps they complete unassisted, next to plan decision 5 in `00-blueprint.md`. Decision 5 is what justifies the schedule; nothing in the plan multiplies its five opt-ins together. If it does not convert, decision 5 survives as a design and the metrics-only cut becomes the obvious shape. Two cheap changes worth evaluating in the same prototype: a longer trace retention default for correlated traces specifically, and whether `patchFetch` off-by-default is the right trade given that every hazard 06 lists for it is a solved problem in the RUM industry.
- **`/traces/$traceId` must render "not found", not an error**, when a trace id is unknown *or* belongs to another project — with **no timing difference between the two**. `06` T2 reads `tempo_traces` directly with a project-scoped pre-check, so the scoping is already right.

  **But 06 T19's no-`ts` fallback contradicts the no-timing-difference requirement, and this document overstated the threat.** T19 specifies a bounded per-partition walk, newest retention day first, **stopping at the first hit**. A trace the caller owns returns after one or two partition reads; a foreign or fabricated id runs the full `retentionDays` sequence. A 128-bit trace id is not guessable, so this is not a discovery primitive — the previous revision's "the id is guessable from a pasted URL" was wrong and is withdrawn — but it *is* an existence-and-ownership oracle for anyone who obtains an id out of band (a log line, an error page, a support ticket), which is exactly the paste-a-URL case being legislated for. **Resolution: `ts` is effectively required.** Every link source in 06 §6.3 already carries `traceStartUnixMs`, so the UI never emits a link without `?ts=`; the no-`ts` path is reached only by a hand-edited URL and must then walk the **full** retention window and return a constant-shaped result rather than short-circuiting. Add the case to 06's T-15 fixture. If 06 prefers to keep the early exit, then this document's no-timing-difference requirement is the thing that has to be relaxed, and it should say so explicitly — the two cannot both stand.
- **Live tail: one design, and it is not this stream's.** `04-read-path.md` D6 ships a bespoke polled WebSocket tail in P3 (its own cursor, ZSET socket caps, 60 s re-authorisation, 30-minute hard lifetime); `05-logs.md` D5 rejects a bespoke tail for P3 in favour of a `refetchInterval: 5000` Follow toggle and defers a differently-designed tail to P6. **This stream's position: 05 D5 for P3** — the Follow toggle is local `useState` (§12), it needs no new transport, and 05's argument (zero logs customers at P3) is the honest one. Whichever tail eventually ships **must** keep 04 §10.1's periodic re-authorisation and hard socket lifetime; that is the property distinguishing it from `wsProjectEvents`' authorise-once behaviour, and it matters because 04 §7.2 is right that a log stream "must never leave an authenticated context — user emails, tokens, stack traces, request bodies". 04 and 05 should delete the losing design rather than leaving two.

### 9. Loading, empty, error and blocked states

Three full-page states exist, all on `FullPageEmptyState` (`components/full-page-empty-state.tsx`): `FullPageLoadingState` (route `pendingComponent`), `FullPageErrorState`, and the base. Inside a chart card, `ReportChartLoading` / `ReportChartEmpty` / `ReportChartError` apply; with D2 the explorer drives them through `isLoading` / `error` instead of an internal query.

The three new tables need skeletons the draft never specified. `EventsTable` solves this with a `LOADING_DATA` placeholder array (`components/events/table/index.tsx:41`) rendered through the real row component — copy that, because a virtualised table that swaps a spinner for rows reflows the whole viewport on settle.

#### 9.1 The first-run empty state

The most important screen in the stream: it is what a user sees the first time they click "Metrics".

```tsx
// components/telemetry/telemetry-empty-state.tsx
export function TelemetryEmptyState({ signal }: { signal: 'metrics'|'logs'|'traces'|'services' }) {
  const { projectId } = useAppParams();
  const { data } = useQuery(trpc.observability.ingestConfig.queryOptions({ projectId }));  // S-E
  // ...
}
```

In order:

1. `FullPageEmptyState` with a signal icon and a title naming the signal ("No metrics yet").
2. One sentence: "Point an OpenTelemetry collector at OpenPanel and your metrics show up here within a minute."
3. The endpoint in a `CopyInput` (`components/forms/copy-input.tsx`, already used by the onboarding connect step), from `observability.ingestConfig.otlpHttpUrl` — never a hardcoded path.
4. The collector snippet (§9.2).
5. `<ProjectLink to="/settings/telemetry">` wrapped in a button. **Not `<LinkButton href=…>`**: `LinkButton` wraps TanStack `Link` directly with `LinkComponentProps` (`components/ui/button.tsx:177-195`) and does not prepend `/$organizationId/$projectId` the way `ProjectLink` does (`components/links.tsx:31-56`), so the href resolves against the app root where no `/settings/telemetry` route exists.

When `status.enabled === false` the page shows "Observability is not enabled on this deployment" with a docs link and **no snippet** — telling a self-hoster to point a collector at a server that is not running is worse than saying nothing. This branch should rarely render, since D12 hides the sidebar group; it is reachable by direct URL.

#### 9.2 The collector snippet

One source of truth: `buildCollectorSnippet({ endpoint, clientId, clientSecret, serviceName })` in `components/telemetry/collector-snippet.ts`, consumed by exactly two components (the empty state and the settings tab), so a header rename is one edit.

```yaml
# ~/otel-collector.yaml
exporters:
  otlphttp/openpanel:
    endpoint: https://api.openpanel.dev/otlp
    headers:
      openpanel-client-id: <client id>
      openpanel-client-secret: <client secret>

processors:
  # gigapipe stores cumulative metrics only. Delta data points are rejected at
  # ingest and counted, never stored (writer/utils/unmarshal/otlp_metrics.go,
  # checkTemporality). The .NET SDK and several Python/Go configurations prefer
  # delta by default, so this is not optional.
  deltatocumulative: {}
  resource/openpanel:
    attributes:
      - key: service.name
        value: checkout-api
        action: upsert

service:
  pipelines:
    metrics: { processors: [deltatocumulative, resource/openpanel], exporters: [otlphttp/openpanel] }
    logs:    { processors: [resource/openpanel], exporters: [otlphttp/openpanel] }
    traces:  { processors: [resource/openpanel], exporters: [otlphttp/openpanel] }
```

The `deltatocumulative` processor is load-bearing and the draft omitted it. Without it the collector gets a 2xx, the verify panel polls forever with `hasMetrics: false`, and nothing anywhere says why — precisely the silent-empty class §9.3 identifies as the worst outcome. The `.NET`/`Python` entries in any later per-language guide (D24, P6) must additionally set the SDK's `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=cumulative`.

The snippet must **not** include an `op_project_id` attribute: the gateway overwrites it from the authenticated token (`02-ingest-gateway.md` D3), so showing it would teach users to set a value that is dropped and make the security boundary look like a convention.

Header names above are illustrative — `UNVERIFIED:` see Q2.

#### 9.3 Error states

| Condition | Render |
|---|---|
| tRPC error on an explorer query | `FullPageErrorState` with Retry → `query.refetch()` |
| tRPC error on the chart | `ReportChartError`, driven by D2's `error` prop |
| gigapipe unreachable (probe failed after being reachable) | banner above the explorer: "Telemetry storage is unreachable. Data is still being received." Deliberately not a full-page error — ingest and query fail independently, and a query outage must not imply data loss |
| `enabled: false` | the not-enabled state (§9.1), never the "no data yet" state |
| Trace id unknown *or* not yours | one identical `FullPageEmptyState`, "Trace not found", with a line about retention |
| Point budget exceeded | the engine coarsens the interval and returns `interval_coarsened`; the notice renders (D15). A hard rejection (`GigapipeQueryTooLargeError`, e.g. `seen > cfg.maxRankSeries`) is a card error naming the count and the fix, never a generic failure |
| Wind-down / quota blocked | §9.4 |

Every one renders text, not a spinner that never resolves. The single worst outcome on these surfaces is the silent-empty: a matcher that matches nothing looks identical to a backend that is down. That is why `compiled` (D14) and `notices` (D15) are on screen — together they are the only way a user can tell those apart without opening a support ticket.

Two ambiguities the draft never separated, and which the UI must:

- **"No series matched"** (the selector is wrong) vs **"series exist, no samples in this window"** (the metric stopped being emitted, or aged out on the shared `SAMPLES_DAYS` TTL). These are different sentences and different next actions. `observability.metrics.chart` distinguishes them cheaply — an empty result with a non-empty label-matcher probe is the second case.
- A saved metric report or dashboard tile whose metric stopped existing renders identically to a broken query today. Same distinction, same fix.

#### 9.4 Blocked states

`observability.status.blocked` returns `'winddown' | 'quota' | null` (S-H — the field 04 §6.5 must add); non-null renders a `BillingPrompt`-shaped banner above the explorer rather than an empty chart (`components/organization/billing-prompt.tsx` is the precedent, used by the project layout route). The share path enforces the same check server-side (§6).

### 10. `/settings/telemetry`

```
Tab: Telemetry                                     ← gated on observability.status.enabled
├─ TelemetryStatusCard      ✅/⏳ per signal, from observability.status.signals
├─ CredentialsBlock         (no isAdmin gate — D24)
│    CopyInput "Client ID"
│    CopyInput "Client secret"   ← only right after creation
│    [Copy all] [Save]
├─ CollectorSnippet         (Syntax, yaml, from buildCollectorSnippet)
└─ VerifyPanel              live "waiting for first data" → "✅ received"
```

Everything except `VerifyPanel` reuses existing pieces verbatim: `CopyInput` (`components/forms/copy-input.tsx`), `clipboard` (`utils/clipboard.ts`), and the "Copy all / Save" pair with the `Blob` + `URL.createObjectURL` download, all lifted from `_steps/onboarding/$projectId/connect`, which already builds a `credentials.txt`. The **secret-shown-once** rule and its copy come from that file too — `useClientSecret()` + `isRealClientSecret(secret)`, "Your client secret is only shown once, right after the client is created." A telemetry token is created through the same `Client` machinery, so the constraint and the wording transfer exactly. Do not invent new wording.

**The Clients tab must be updated in the same PR.** The telemetry token appears in Settings → Clients, whose table shows Name / Client ID / Created at and no `type` column (`components/clients/table/columns.tsx:17-31`), and whose Revoke action sits behind a generic confirm reading "Client revoked, incoming requests will be rejected". Nothing distinguishes a telemetry client from a web tracking client, and nothing warns that revoking it stops the collector. Add `type` as a column or badge once `ClientType` gains `telemetry` (`01-tenancy-and-security.md`), and name the consequence in the revoke confirm when the client is a telemetry client.

Correspondingly, `/settings/telemetry` needs a state the draft never had: **"the telemetry client this project was bound to no longer exists"**, with a re-create action. `VerifyPanel` distinguishes only "waiting" from "received", so a revoked token today looks identical to a collector that was never configured.

`VerifyPanel` polls `observability.status` with `refetchInterval: 5_000` while all three `signals.*` flags are false and stops once any turns true. Where the ingest side can surface it, "receiving data but rejecting N points: delta temporality is not supported" is the single most valuable string on this screen (Interfaces, item 9). The onboarding verify step uses `useWS('/live/events/$projectId')` for instant feedback; there is no equivalent live channel for telemetry and adding one is not worth it for a one-time setup screen. **Rejected:** a telemetry WS channel for verification.

On success: a `ProjectLink` button to whichever surface got data, and `op.track('telemetry_first_data_verified', { projectId, signal })`, matching the existing `op.track('onboarding_first_event_verified', …)`.

### 11. Services overview — `/services` (P6)

A responsive card grid, one card per service, each: name, request-rate sparkline, error-rate %, p95 latency, log count, last-seen. Cards are `Widget` / `WidgetHead` / `WidgetTitle` / `WidgetBody` (`components/widget.tsx`). Click → `/traces?service=<name>`.

With D2, each card renders `<ReportChart report={syntheticSparklineReport} data={service.spanRate} lazy options={{ hideLegend: true, hideXAxis: true, hideYAxis: true }} />` off **one** list query — `observability.services.list` returning every sparkline in a single response — rather than 30 synthetic reports each issuing its own chart query. That is the concrete payoff of D2 and the reason it belongs in P2 even though `/services` is P6. A bare recharts `<AreaChart>` remains a legitimate fallback if the shared renderer's chrome proves too heavy; measure before choosing.

Cards render `null` metrics as `—`, not `0`. A service with traces but no logs has `logCount: null`, and showing `0` asserts something false.

### 12. State ownership

| State | Where | Why |
|---|---|---|
| Explorer query (metric, type, fn, window, agg, quantile, by, matchers, chart type, max) | **nuqs** search params | shareable, back/forward works, matches every other filterable surface |
| Time range | **nuqs** via `useOverviewOptions({ cookieKey: 'telemetryRange' })` | one vocabulary, separate default (§3) |
| Log search text | **nuqs** via `useSearchQueryState()` | already debounced at 500 ms with page reset |
| Live/refresh toggle | **local `useState`** | ephemeral; must not survive a reload |
| Wrap-lines, waterfall collapse set, selected span | **local `useState`** | view state, not query state |
| Column visibility | `useDataTableColumnVisibility(columns, key)` | localStorage-backed, same as `events` |
| Report being edited | **Redux `report` slice** | unchanged; the slice exists for the editor's `dirty`/`ready`/`reset` lifecycle |
| Metric/label lists, values, `observability.status` | **TanStack Query** | `staleTime: 10m` for autocompletes, `5m` for status (D12) |
| Chart results | **TanStack Query** — explorer via `observability.metrics.chart`, saved tiles via `trpc.chart.*` | D5 |

The explorers add **no Redux slice** — and with D18 that is now literally true rather than aspirational.

### 13. Bundle and code-splitting

The stream adds five routes, a virtualised log list, a hand-written span waterfall, a sparkline and an hljs YAML registration to a SPA that today ships one syntax highlighter with four languages. Three requirements:

1. `registerLanguage('yaml', …)` in the shared `components/syntax.tsx` pulls hljs YAML into whatever chunk `syntax.tsx` lands in, for every user including self-hosters with no gigapipe. Import it lazily inside the telemetry components, or accept the (small, measured) cost explicitly — do not add it and not look.
2. TanStack Router code-splits by route file, so the five new routes are already separate chunks provided nothing in the shared shell imports their components eagerly. `sidebar-project-menu.tsx` must import only icons.
3. `components/lazy-component.tsx` exists and wraps `useInViewport`; it is viewport-gating, not code-splitting. Use it for the waterfall's collapsed subtrees if that proves necessary; do not mistake it for a bundle answer.

Measure the `apps/start` bundle before and after P2 and record the delta in the PR. This is one line of work, and skipping it is how a 200 KB regression ships unnoticed.

### 14. Data deletion

`cron.delete.ts:44-47` deletes scheduled orgs and projects by calling `deleteFromClickhouse(projectIds)`, which targets the analytics tables only.

**The function is `deleteTelemetryFromClickhouse(projectIds, opts?)` (S-I), not `purgeTelemetry`.** Three specs proposed three names, three ledgers, three call sites and opposite failure semantics: `05-logs.md` §7.4's `purgeTelemetry` + `TelemetryPurgeJob`, called per project from `jobDelete` where **only successfully-purged projects proceed to `deleteProjects`**; `08-schema-changes.md` §14's `deleteTelemetryFromClickhouse` + `TelemetryErasure`, called **inside** `deleteFromClickhouse` and forbidden to throw; `06-traces-and-correlation.md` §11.6's two further names in `delete.service.ts`. This document previously cited 05's; it now cites 08's, because 08 owns `delete.service.ts`, its call site is the only one covering **both** `apps/worker/src/jobs/cron.delete.ts:46` **and** `admin/src/commands/delete-organization.ts:191` (the tool a GDPR erasure actually travels through), and its non-throwing contract is grounded in a verified fact: `jobDelete()` has no try/catch, so one unguarded throw stops every project and organization deletion on the deployment, silently, forever. 05's resumability — the durable fingerprint set that survives a worker dying between fingerprint resolution and the mutations — is genuinely better and folds into 08's ledger rather than being lost. 06's per-profile erasure becomes a `subject`/`signals` argument on the same function, not a second one.

Three UI obligations follow:

- The **delete-project confirmation** (`settings/_tabs/details.tsx`) names telemetry alongside events once telemetry exists for the project.
- Per-profile GDPR deletion reaches log and span attributes carrying `op_profile_id`. That is the deletion function's problem, not this stream's, but the copy on any "delete this profile's data" affordance must not claim completeness the backend does not deliver. The UI states what is actually deleted, and — because the erasure SLA is "within 24 hours of the deletion job running", bounded by ClickHouse mutation completion — it says *scheduled*, not *deleted*.
- Because the function **never throws**, a failed telemetry erasure is invisible to the user by design. The pending `TelemetryErasure` row is the operator's surface, not the customer's; the UI must not claim success it cannot observe.

---

## Interfaces

### Consumed

| # | Symbol / contract | Owner | Notes |
|---|---|---|---|
| 1 | `zMetricQuery`, `zMetricLabelFilter`, `zMetricType`, `zMetricFn`, `zMetricWindow`, `zMetricAggregation`, `REDUCER_TABLE`, `IMetricQuery`, `MetricNotice`, `MetricChartResult` — `packages/validation/src/telemetry.validation.ts` and `engine/metrics/notices.ts` | metrics engine (03 §2, D2) | consumed **as written in 03 today** (S-A). This stream defines no metric schema of its own (D3). `zDataSource` is **not** consumed — it does not exist under S-B |
| 2 | Deterministic `IChartSerie.id` = f(`definitionId`, sorted label tuple), deterministic series order, and the `names`/`event.name`/`event.breakdowns` shape of §4.7 | metrics engine | **Blocker.** Non-deterministic ids decay `visibleSeries` and destabilise the recharts `dataKey` |
| 3 | Dense, identical date grid across series; `'yyyy-MM-dd HH:mm:ss'` naive project-local strings | metrics engine (03 §5.1) | `useRechartDataModel` takes the x-axis from `series[0]` and matches by exact string equality. `05-logs.md` already commits its histogram to the same invariant |
| 4 | `executeReport(input, { intent: 'timeseries' \| 'aggregate' })` adopted at **all seven** engine entry points listed in 03 §15.3 (the seventh, `export.controller.ts:201`, is a no-op) | metrics engine + API | D6. The parameter is `intent`, per 03. `intent: 'aggregate'` must define what a metric report collapses to for bar/pie (Q3) |
| 5 | A server-side point-budget guard applied on **every** metric query, authenticated and anonymous, that coarsens the interval and emits `interval_coarsened` rather than letting gigapipe 500 | metrics engine (03 §6.1/§6.3, D7) | **`cfg.maxPoints = 3000`**, coarsest fitting sub-bucket, under gigapipe's 11 000 (`reader/controller/prom_query_range.go:65`). Corrected from "8 000" (S-G); `04-read-path.md`'s `TARGET_MAX_POINTS = 1_500` smallest-fitting loop is retired |
| 6 | Whether previous-period bucket counts are guaranteed to match for a given `(range, interval)` | metrics engine | gates re-enabling the `previous` toggle for metrics (§4.6) |
| 7 | **`MetricChartResult = FinalChart & { notices; resolution; compiled? }`** — one envelope, returned only by `observability.metrics.chart`. `FinalChart` itself is **not** modified (03 D2), and `04-read-path.md` D5's `IObservabilityChartResult { chart, resolution }` wrapper is superseded | metrics engine (03 D2) owns the type; read-path returns it | S-C. **`compiled` is an addition 03 has not yet accepted or rejected** (D14) — it appears in no engine spec today. If 03 rejects it, the explorer's Query disclosure is cut |
| 8 | `metricNames` / `metricLabels` / `labelValues` `protectedProcedure`s with server-constructed `match[]` | metrics engine (03) | the picker's only server dependency |
| 9 | **`observability.status`** (04 §6.5) — `{ enabled, reachable, schemaReady, hasData, signals:{metrics,logs,traces}, retentionDays, oldestQueryableAt, database, clustered, version, degraded }` — **plus two additions this stream needs**: `blocked: 'winddown' \| 'quota' \| null` (§9.4, §6) and, where reachable, gigapipe's **ingest reject counts** (the string that turns VerifyPanel's spinner into a sentence, §9.2). Never throws for an authorized caller (04 D10) | read-path (04) | S-H. Replaces the `telemetry.capabilities` this document previously invented. `patterns` is **not** requested unless `LOG_DRILLDOWN` ships |
| 10 | `observability.ingestConfig` → `{ otlpHttpUrl, clientId }` | ingest (P1) | the endpoint and headers are never hardcoded in a component. Namespaced under the one root per S-E |
| 11 | `op_project_id` stamped on **every metric data point**, not only the resource | ingest (`02-ingest-gateway.md` D3, §4.1) | already decided; recorded here because §4.4 is where a UI engineer would otherwise re-derive it wrongly |
| 12 | `observability.logs.*` / `observability.traces.*` procedures on 04 D13's base procedure | 05 §6.2, 06 §Interfaces | S-E — namespace settled, Q1 closed. `05-logs.md`'s `logsRouter` folds in. **Plus:** `rateLimitMiddleware` on `traces.tagKeys`/`tagValues` unless 06 T16's tag dictionary is promoted to P4 (§4.5) |
| 13 | **`deleteTelemetryFromClickhouse(projectIds, opts?)`** in `packages/db/src/services/delete.service.ts`, called from inside `deleteFromClickhouse`, non-throwing, `TelemetryErasure` ledger, resumable, `signals`/`subject` arguments covering per-profile erasure | schema (08), with 05's journal folded in | §14, S-I. Supersedes this document's earlier citation of 05's `purgeTelemetry`; `11-testing-strategy.md` I13/I14 already use this name |
| 14 | `ClientType.telemetry` plus the four deny-list→allow-list conversions | tenancy (01) | the settings tab is where a user mints such a token |
| 15 | **Package homes:** `packages/gigapipe` (transport, errors, lease, kill switch, label constants, compilers) and `packages/db` (`getTelemetryClient`, `TELEMETRY_TABLES`, `gigapipeTable`) | 04 D1 + 08 S10/S11 | S-F. Four homes were proposed across 04/05/08 and three documents marked it blocking; the UI imports the client from neither, but every path in this document's test table depends on the answer |
| 16 | **`IChartSerie.data[].count` widened to `number \| null` for the metrics path** | metrics engine (03 D10) | **Requested, not yet granted.** 03 D10 fills gaps with `0` in v1 and prices the widening at seven renderers, `report-table-utils`, the tooltip and the MCP shaper. In an observability product a filled zero that is indistinguishable from a measured zero is a wrong answer during an incident, not a rendering nicety — this stream will pay its share of the seven-renderer cost (D26). Until it lands, `gaps_filled_with_zero` (D15) is the only thing separating the two, and the notice is a chart-level count, not a per-point marker |

### Exposed

| Symbol | Location | Consumers |
|---|---|---|
| `ReportChartProps.data \| isLoading \| isFetching \| error` | `components/report-chart/context.tsx` | metrics explorer, services grid, **and the MCP/chat stream** — `chat-report-result.tsx` can stop discarding its payload |
| `ReportChartContextType['options'].showTable` | same | explorer table without `isEditMode`'s Redux writes (D18) |
| `ReportChartType.include?: readonly IChartType[]` | `components/report/ReportChartType.tsx` | metric editor; any future restricted picker |
| `TELEMETRY_LABELS` | `components/telemetry/labels.ts` | every correlation link, chip and deep-link builder, in all three signals |
| `buildCollectorSnippet(...)` | `components/telemetry/collector-snippet.ts` | empty state + settings tab; one edit on a header rename |
| `Combobox` / `ComboboxAdvanced` `search` \| `onSearchChange` \| `disableInternalFilter` | `components/ui/combobox*.tsx` | metric picker, label pickers, logs selector builder |
| `useYAxisProps({ allowDecimals })` | `components/report-chart/common/axis.tsx` | any fractional-valued chart |
| Extended `PureFilterItem` props with the `enabled: values === undefined` guard | `components/report/sidebar/filters/FilterItem.tsx` | shared with `05-logs.md`, which opened this seam |

### Notes for other streams

| Stream | What |
|---|---|
| **Alerts (P5)** | Two `apps/start` files break when `zNotificationRuleConfig` gains a member without an `events` array: `components/notifications/rule-card.tsx:21` (`NotificationRule['config']['events'][number]` — a hard type error) and `modals/add-notification-rule.tsx:89` (`useFieldArray({ name: 'config.events' })`, plus a hardcoded two-option type picker at `:266-280`). Both are this stream's files; schedule against its capacity. A metric rule needs a sibling branch in the modal, not a tweak |
| **Chat** | `pageContextPageSchema` gains `'metrics' \| 'logs' \| 'traces' \| 'services'`, unused in P2/P3. **`set_property_filters` must not be reachable on the observability routes** — it writes `f` on `window.location.href` with no page check (`components/chat/tool-handlers.ts:79-94`) |
| **MCP** | `reportSchema` accepts `type: 'metric'` the moment 03's schema lands, because `.strict()` guards keys and the union member is nested inside `series` — it fails silently **open**. `create_report` and `update_report` must accept it deliberately or reject it with a named error, in the same PR as the union member. `duplicate_report` is **safe** and the previous revision was wrong about it: verified, it copies `report.events!` raw from a `db.report.findFirst` (`dashboard-management.ts:488-506`) (D8, S-B) |
| **Schema (08)** | Delete `DataSource` / `Report.dataSource` — the enum, the column, the migration, the inventory row, the sequencing row and the rollback row (S-B). Retarget the nine-site table at the **series union member**; the inventory itself is correct and valuable. Split F4's detection column: `transformReportEventItem` fails `tsc`, `listReportsCore` and the `apps/start` casts do not (D7) |
| **Docs (unowned — see Effort)** | This document links out to a docs page from the first-run empty state (§9.1), the settings tab (§10) and the metric-naming note (§4.3), and defers D24's per-language SDK grid to "a docs page rather than a component". **No documentation work-stream exists.** Nothing owns an `Observability` section in `apps/public/content/docs/`, an `api/telemetry.mdx` beside the existing `api/track.mdx`, or a home for `02-ingest-gateway.md` §16's finished collector/SDK/remote-write/Alloy snippets. Every "docs link" in this stream is a dangling reference until someone owns it |
| **Product / growth (unowned)** | The repo ships four wind-down templates (`packages/email/src/emails/wind-down-{blocked,expired,final-warning,stopping-soon}.tsx`) whose job is telling a customer what is about to be deleted, and §14's telemetry erasure rides the same terminus without appearing in any of them. Also unowned: whether telemetry appears in `weekly-digest.tsx`; a telemetry analogue of the `tracking-no-data.tsx` / `tracking-data-stopped.tsx` data-health alert reusing the `Project.noDataNotifiedAt` / `dataStoppedNotifiedAt` dedupe pattern — "your collector stopped shipping" is the single most useful alert an observability product can send, and the machinery exists; the `self-hosting/changelog.mdx` entry; and an in-app announcement for existing self-hosters, for whom the common state is that gigapipe is simply absent (05 F6b). This stream owns the in-app surface if one is wanted, and needs ~2 days' notice |
| **Metrics engine** | Its §Drill-down says "line, area and bar". Verified: the `View Users` item is in `line`, `area` and **`histogram`**; `bar/chart.tsx` has none (D17) |

---

## Failure modes

| # | Failure | Trigger | User sees | Detection / mitigation |
|---|---|---|---|---|
| F1 | Saved metric series coerced to an event series | `listReportsCore` missing its `metric` branch | dashboard/MCP shows `unknown_event`; an agent's `update_report` writes it back permanently | T1. `transformReportEventItem` fails `tsc`; `listReportsCore` does not (D7) |
| F2 | `dataSource` stops round-tripping | any of the eight write sites missed (D8) | metric report silently runs the event engine | T2, exercising the real read path — **not** a mocked `transformReport` |
| F3 | `summarize_dashboard` / Insights returns wrong numbers for a metric report | dispatch missing at `getReportDataCore` or `agents/tools/dashboard.ts` | a 200 with plausible zeros; no error anywhere | D6's single `executeReport`; T4 |
| F4 | MCP `duplicate_report` corrupts a metric report | its inline `data: {}` literal lacks `dataSource` | the copy renders as an event report | D8 item 5; T2b |
| F5 | Explorer fires a full-cardinality query on first paint | `m` null and `<ReportChart>` mounted anyway | slow page, gigapipe load | D2 — `ReportChart` is not mounted until a metric is picked; T5 |
| F6 | Label matchers overwritten by the AI chat | user asks a question on `/metrics` | chart empties, no error | D10's `lf` key; T6 |
| F7 | Correlation links match nothing | `service.name` used on metrics, or `service_name` treated as identity | empty results, no error | `TELEMETRY_LABELS` (§4.4). `job` is the metrics key |
| F8 | Metric report renders a degenerate 0/1 axis | all values below 1 (rates, ratios, CPU seconds/sec) | a flat line on the floor | D23's `allowDecimals`; T7 |
| F9 | Tooltip shows a percentage 100× too large | `unit: '%'` prefilled from OTel metadata | wrong numbers, confidently displayed | D23 — no auto-prefill |
| F10 | Favicon request storm on the metrics chart | `resolveIcon`'s `name.includes('http')` catch-all | broken images, one proxied request per series per render | D20's `renderSerieIcon` |
| F11 | Tab locks up at high resolution | `useRechartDataModel`'s quadratic reduce over many buckets | frozen page, no error | D21's rewrite; T3 |
| F12 | Project id and matcher set leaked to anonymous share viewers | `compiled` populated on the share path | nothing — the leak is invisible | D14; T9 |
| F13 | Wound-down org keeps querying gigapipe through a public share | share path has no `blocked` check | a working chart that should not be | §6 item 3 |
| F14 | Navigation into every project page blocks on gigapipe | `observability.status` awaited in the project route loader | Overview/Sessions/Settings hang | D12 — not awaited, cached, timed out; 04 D10 guarantees it does not throw |
| F15 | Observability group vanishes mid-session | a transient probe failure flips `enabled` to false | links disappear under the user | D12 — `enabled` is a deployment fact |
| F16 | Collector reports success, no metrics ever appear | delta temporality; points rejected and counted, never stored | VerifyPanel spins forever | §9.2's `deltatocumulative`; Interfaces item 9 |
| F17 | User cannot find their metric in the picker | `buildMetricName` appended a unit word and `_total` | "ingest is broken" | §4.3's query normalisation + the naming note |
| F18 | Revoking a client silently stops the collector | Clients tab shows no `type` and no warning | telemetry stops, cause unknown | §10 — `type` badge, revoke warning, revoked-client state |
| F19 | Editor table shows no columns for a grouped metric report | `report.breakdowns` is `[]` for metrics (D19) | flat table only | Known and accepted for P2 (D18); flat view is the useful one |
| F20 | Waterfall renders nothing | trace with no root, or a cycle | blank page | `06` §7's `buildWaterfall` orphan handling; not this stream's code |

---

## Test requirements

Two of these run in packages that already have test infrastructure. Six do not, and that gap is a real line item, not a rounding error.

**`apps/start` has no test harness.** `vitest.workspace.ts` is one line — `export default ['packages/*', 'apps/*', '!apps/start']` — the exclusion is documented in the project `CLAUDE.md`, there are zero `*.test.*` files under `apps/start/src`, `apps/start/package.json` has no `test` script, and `apps/start/vite.config.ts` has no `test` block. RTL, jsdom and vitest sit in devDependencies unwired. T5–T8 all need a workspace entry, a jsdom environment, a setup file and a render-with-providers helper (TanStack Router memory history + a nuqs adapter + a Redux store + a mocked tRPC/QueryClient) before a single assertion runs. **That bootstrap is a named P2 task, and because the exclusion is deliberate it needs the repo owner's sign-off.** If the answer is no, T5–T8 become a written manual-QA checklist and the estimate below drops by a week — say which, do not leave it implied.

Also correcting the draft: `packages/db/src/services/reports.service.test.ts` **does** exist (it covers `mergeGlobalFilters`), and `packages/trpc/src/routers/share.test.ts` **does** reference `transformReport` — by mocking it as identity (`share.test.ts:20`: `transformReport: (report: unknown) => report`). That mock is exactly the trap T2 must avoid.

| # | Test | Where | Guards |
|---|---|---|---|
| T1 | `transformReportEventItem` round-trips a metric item unchanged; `listReportsCore` preserves `type: 'metric'` | `packages/db/src/services/reports.service.test.ts` (exists) | F1 |
| T2 | create → read → update → read preserves `dataSource` and every `zMetricQuery` field, through the **real** `transformReport` | `packages/trpc`, `createCaller`; pattern from `share.test.ts` but **without** its identity mock of `transformReport` | F2 |
| T2b | the same round-trip through MCP `create_report` → `update_report` → `duplicate_report` | `packages/mcp` | F2, F4 |
| T3 | `useRechartDataModel` produces byte-identical output before and after the D21 rewrite, over a fixture with ragged series, and completes 5 series × 1 440 buckets under a stated budget | `apps/start` (or extracted to `packages/common` and tested there — the function is pure) | F11 |
| T4 | `executeReport` dispatches on `dataSource` at all four entry points; `chart.chart`, `chart.aggregate`, `getReportDataCore` and the dashboard agent each return metrics-engine output for a metric report | `packages/db` + `packages/trpc` | F3 |
| T5 | the explorer issues **no** chart query while `m` is null, and `<ReportChart>` with `data` supplied issues none ever | `apps/start` RTL | F5 |
| T6 | `lf` and `f` do not alias: setting one leaves the other untouched | `apps/start` RTL | F6 |
| T7 | a series of values in [0, 1] produces more than two Y ticks | `apps/start` RTL | F8 |
| T8 | `PureFilterItem` with a `values` prop issues no `chart.values` query | `apps/start` RTL | §D9 regression guard for the events editor |
| T9 | `compiled` is absent from every response served with a `shareId`, present without one | `packages/trpc`, `createCaller` | F12 |
| T10 | a metric query whose window implies more than `cfg.maxPoints` (3000) is coarsened and returns `interval_coarsened`, on the saved-report path too | `packages/db` | F13, and the engine's contract |

---

## Open questions

| # | Question | Blocks | Settled by |
|---|---|---|---|
| Q1 | **Router namespace.** `04-read-path.md` D6 and `06` expose `observability.metrics.*` / `observability.traces.*`; `05-logs.md` exposes `trpc.logs.*` (`packages/trpc/src/routers/logs.ts`); `03` adds `packages/trpc/src/routers/metrics.ts`. The UI cannot import three namespaces for one feature | every `useQuery` call site in the stream | a one-hour decision across 03/04/05/06. This stream's position: one `observability.*` root with `metrics`/`logs`/`traces`/`services`/`capabilities`/`ingestConfig` beneath it, and saved-report execution staying on `chart.*` (D5) |
| Q2 | Exact OTLP gateway path and ingest header names | §9.2's snippet | `02-ingest-gateway.md` publishing `telemetry.ingestConfig.otlpHttpUrl` and the header contract. Until then `buildCollectorSnippet` is the single edit point (F9 is already mitigated) |
| Q3 | Does `mode: 'aggregate'` on a metric report collapse with `report.metric` (`sum`/`average`/…) over the time series? | bar and pie in `METRIC_CHART_TYPES` (D16) | metrics-engine stream. If the answer is "undefined for range vectors", drop `bar` and `pie` from `METRIC_CHART_TYPES` and say so — a bar chart of `rate()` with no stated aggregation is a lie |
| Q4 | Do previous-period bucket counts match for every legal `(range, interval)` including DST boundaries and month lengths? | re-enabling `previous` for metrics (§4.6) | metrics-engine stream. `format()` aligns by array index (`format.ts:142`); a mismatch is a silently shifted comparison |
| Q5 | Is an `apps/start` test harness in scope? | T5–T8, and 3–5 d of the estimate | repo owner. The workspace exclusion is deliberate |
| Q6 | Does `useOverviewOptions` accept a `cookieKey`/`defaultRange` option, or does telemetry get its own hook? | §3 | one small PR either way; the requirement (telemetry must not re-default the analytics range cookie) is not negotiable |
| Q7 | `UNVERIFIED:` do OpenPanel's SDKs propagate a session id such that the backend emits `op_session_id` on log records? | the session→logs widget (§8) | `06-traces-and-correlation.md` §8 owns the propagation design; `packages/sdks/*` was not read for this document |

---

## Effort

Assuming Q1 is closed and the four consumed blockers (Interfaces 1–5) land on schedule.

| Phase | Scope | Estimate |
|---|---|---|
| P2a | `dataSource` plumbing across the eight write sites, the union audit (§7.2), `ReportMetricSeries`, `ReportChartType.include`, editor relabels, `ReportSaveButton` fetch list | 1.5–2 w |
| P2a′ | **The `data` prop (D2)** — 7 renderer `index.tsx` files, the context type, and converting `chat-report-result.tsx` | 3 d |
| P2a″ | Shared-component fixes: `report-table` off Redux (D18), `useRechartDataModel` rewrite (D21), `useYAxisProps.allowDecimals` (D23), `Combobox` controlled search (D22), `renderSerieIcon` wiring (D20), `syntax.tsx` yaml | 4 d |
| P2b | Metrics explorer: picker, matchers, group-by, controls, compiled disclosure, notices, save-to-dashboard, empty states | 2–2.5 w |
| P2c | Sidebar, five routes, capability gating, `/settings/telemetry`, Clients-tab `type` badge and revoke warning, collector snippet | 1 w |
| P3 | Logs **shell** only — route, sidebar, empty/blocked states, `PureFilterItem` seam. The explorer itself is `05-logs.md`'s | 3 d |
| P4 | Traces **shell** only — routes, not-found state, session→logs widget, correlation link builders. The waterfall is `06`'s | 4 d |
| P6 | Services overview + sparklines (cheap once D2 exists) | 4 d |
| — | Tests T1, T2, T2b, T4, T9, T10 (packages side) | 4 d |
| — | `apps/start` harness bootstrap + T3, T5–T8 — **only if Q5 is yes** | 3–5 d + 3 d |

**Total: ~8–9 weeks** with the harness, ~7 without.

What could make it bigger, honestly ranked:

1. **Q1 landing the other way.** If saved metric reports do not go through `chart.chart`, the dashboard-tile story is not free and §6 becomes a work item rather than a paragraph.
2. **The union audit (§7.2).** Eight files of casts the compiler will not help with, in the middle of the report editor, which has no tests. This is where the draft's estimate was most optimistic and it remains the largest single risk.
3. **D2's blast radius.** Seven renderer files plus a context type is small, but every one of them is on the critical path of the events product, and there are no tests over `FinalChart`, `ChartEngine`, `ReportChart` or `chartProcedure` anywhere in the repo. Land it first, on its own, behind its own review.
4. **Q3 answering "undefined".** Dropping `bar` and `pie` is cheap; discovering it after the picker ships is not.
5. **The Clients-tab work** is coupled to `ClientType.telemetry` landing in the tenancy stream, and that PR touches four validators. If it slips, `/settings/telemetry` ships without a way to mint the token it documents.

