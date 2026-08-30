# The metrics query engine

**Work-stream: P2 — metrics.** This spec defines `zMetricQuery` (a structured metric-series
definition), the compiler that turns it into PromQL with a mandatory `op_project_id` matcher,
the two-stage time grid that reconstructs `week`/`month`/DST-correct `day` buckets a fixed
PromQL `step` cannot express, the two-phase series-selection pass that replaces the `topk`
cardinality cap the draft got wrong, and the shaper that turns a Prometheus matrix into
`ConcreteSeries[]` so the **existing** `format()` (`packages/db/src/engine/format.ts:18-171`)
produces the **existing** `FinalChart` (`packages/validation/src/types.validation.ts:106-109`)
— which is what makes every chart renderer, dashboard tile and MCP shaper work on metric
reports. The engine is a **pure function**, `executeMetricChart(spec, deps)` returning
`MetricChartResult`, with no router and no report-persistence change: in P2 its only caller is
`observability.metrics.chart` from the read-path work-stream (`04-read-path.md` D6 stands), and
folding metric series into `zChartEventItem` / `chart.chart` / shares is a separately specified
later phase (§ P2.5) with its own deploy ordering, because `transformReportEventItem` is a
lossy read projection and a rollback past it destroys saved metric reports. Everything the
engine cannot do faithfully — capped series, widened rate windows, filled gaps, coarsened
intervals, dropped non-finite samples — is reported through `notices` on the engine's own
return type rather than being silently absorbed.

Line and symbol citations were regenerated against the OpenPanel working tree at `247744a8`
(clean) and against `/Users/drew/projects/gigapipe` at `HEAD` (the tree containing
`reader/promql/promql_transpiler/optimizer/vector_agg.go`). Anything I could not settle from
disk is marked **UNVERIFIED** with the experiment that settles it.

**Revision R2 — the cross-cutting pass.** Five reviewers read all eleven specifications
together. This revision absorbs their findings against this document. Six decisions are new
(D15–D20), two are changed (D2, D10), and every change that a sibling document must now reflect
is collected in one place: § Interfaces, "Amendments this revision creates". Three of the new
decisions close questions that three other documents mark **blocking** — `07-alerting.md` Q1,
`09-ui-surfaces.md` Q1 and `11-testing-strategy.md` Q1. They are settled *here* rather than in
`00-blueprint.md` because **no `00-blueprint.md` exists on disk** (verified: `docs/observability/`
holds `01`…`11` plus `_drafts/`). If a blueprint is later written, D15–D20 are what belongs in
it; until then this document is the record and the other streams should cite it.

**On citations, and a warning.** Citations into the OpenPanel and gigapipe *trees* are file:line
and were checked at `247744a8`. Citations into *sibling specifications* are by **section and
symbol, not by line**: the siblings are under concurrent revision, and during this pass
`01-tenancy-and-security.md`'s line numbers moved by 137 lines between two reads of the same
file. Every bare line citation into a sibling document — in this document and in the five that
cite this one — should be treated as indicative, and any tooling that resolves them will be
wrong. The stale ones this revision found are listed in § Interfaces.

**Not owned here:** the ingest gateway (P1); the label-enforcement primitives `compileSelector`
/ `compileAggregation` / `verifyResponseLabels` / `quote` (tenancy,
`01-tenancy-and-security.md:1056-1129, 1408-1436`); the gigapipe HTTP transport, error
taxonomy, lease, config and the `observability.*` router (read-path,
`04-read-path.md:417-1542`); logs (P3); traces (P4); alerting (P5). § Interfaces lists every
seam and every amendment this spec requires of a neighbouring document.

---

## Decisions

### D1. Scope: this work-stream ships an engine, not a router. `04-read-path.md` D6 stands

The draft of this document put metric series inside `zChartEventItem` / `zReportInput` and
dispatched inside `chart.chart` / `chart.aggregate`, with a worked share-link walkthrough.
`04-read-path.md:147-160` (D6) had already decided the opposite and rejected exactly that work
as "a different work-stream's migration", and `04-read-path.md:156-160` states that the share
path is consequently out of scope. Three reviewers flagged this as two mutually exclusive plans
for one phase. **Read-path D6 wins**, for reasons stronger than precedence:

1. **Rollback is unsafe until a whitelist ships and soaks.** `Report.events` is an unversioned
   Prisma `Json` column (`packages/db/prisma/schema.prisma:433`), `transformReport` casts it
   with `report.events as IChartEventItem[]` and never re-parses
   (`packages/db/src/services/reports.service.ts:99`), and `transformReportEventItem` (`:56-81`)
   rewrites **every** non-formula item into
   `{type:'event', name: item.name || 'unknown_event', segment, filters, id, displayName, property}`.
   `report.update` then writes `events: report.series` straight back
   (`packages/trpc/src/routers/report.ts:101`). So one pod without the metric arm, serving one
   `report.get` that a user then saves, **permanently destroys** the metric query with no error.
   That is a data-loss hazard, and it is not one to take on in the same phase as a new storage
   backend.
2. `zMetricQuery` and `zReportInput` disagree structurally. A metric report has no
   `breakdowns`, no `globalFilters`, no `metric: 'count'`, and a series limit of 6, not
   unbounded (§ Design 12.6).
3. Read-path already has the router, the procedure, the cacher policy, the lease and the error
   taxonomy written and reviewed. Duplicating a `chartProcedure` clone is the third copy of an
   auth middleware that has zero test coverage and one historical share CVE
   (`packages/trpc/src/routers/share.test.ts`, GHSA-7gv7-c464-9wh8).

**Rejected: ship both.** Two entry points to one engine with different auth, different input
schemas and different cache keys is how a tenancy boundary acquires a hole.

**Consequence.** In P2 the engine is called from exactly one place. § P2.5 specifies the
report-adoption phase — seven executor call sites, the `transformReportEventItem` arm, the
homogeneity refine, the chart-type gate, and the deploy ordering that makes it safe — as a
follow-on, not as speculation. `04-read-path.md` needs the amendments in § Interfaces
(§5.1, §5.2, §6.1, §8.1, §8.2); all of them narrow it, none reopens D6.

### D2. `FinalChart` is not modified. Notices, resolution and the compiled PromQL ride on **one** structural supertype

*(Changed in R2: `resolution` and `compiled` are folded in. Three documents specified three
different envelopes for one procedure; this is now the only one.)*

`04-read-path.md` D5 rejects adding a field to `FinalChart` because every renderer types against
`IChartData = RouterOutputs['chart']['chart']`. That reasoning applies to an optional field too,
so the draft's `FinalChart.notices` is dropped — and so is every later proposal to put anything
else on `FinalChart`.

```ts
// packages/db/src/engine/metrics/notices.ts
export type MetricNotice = {
  code: MetricNoticeCode;
  /** Already user-facing and already formatted. The UI renders it verbatim. */
  message: string;
  /** Set when the notice belongs to one definition. The alpha id (A, B, C…). */
  definitionId?: string;
  meta?: Record<string, string | number>;
};

/**
 * Structurally assignable to FinalChart. Nothing in types.validation.ts changes.
 *
 * `resolution` is 04-read-path.md D5's `IObservabilityChartResult.resolution`, moved off its
 * WRAPPER and onto this supertype (R2). One envelope, one procedure return type.
 *
 * `compiled` is 09-ui-surfaces.md D14's compiled PromQL. It lives HERE and never on
 * FinalChart — which is what keeps it off the public share path by construction rather than
 * by a conditional in a resolver (D18).
 */
export type MetricChartResult = FinalChart & {
  notices: MetricNotice[];
  resolution: {
    requestedInterval: IInterval;
    /** May be coarser (D7/D19). Same fact the `interval_coarsened` notice reports. */
    effectiveInterval: IInterval;
    stepSec: number;
    previous: 'ok' | 'unavailable' | 'not_requested';
    /** From read-path D14's retention annotation. Null when not known. */
    oldestQueryableAt: string | null;
  };
  /** One compiled expression per definition, in definition order. See D18 for who may see it. */
  compiled?: string[];
};
```

TypeScript is structural: a `MetricChartResult` satisfies every `FinalChart` parameter,
`IChartData` keeps its shape for event charts, and
`RouterOutputs['observability']['metrics']['chart']` gains the three extra properties only
because that one resolver declares the wider return type. No shared type is edited, no existing
consumer changes, and read-path D5's stated property is preserved exactly — which is precisely
why `resolution` does not need to be a wrapper to get it.

**Rejected: `04-read-path.md` D5's `{ chart, resolution }` wrapper.** It is not wrong, it is
redundant: it exists to avoid editing `FinalChart`, and the supertype already achieves that
while keeping the value assignable to `IChartData` with no `.chart` unwrap at every call site.
Two envelopes for one procedure is how a renderer ends up written against the wrong one.
`04-read-path.md` must delete `IObservabilityChartResult` and return `MetricChartResult`.

**Rejected: `FinalChart.notices?: MetricNotice[]`.** `09-ui-surfaces.md` D15 asserts that "03
D7 adds `notices?` to `FinalChart`". That is the opposite of what this decision says and has
been since the draft; `04-read-path.md` D5 records the same proposal as "additive and
structurally compatible; this work-stream does not depend on it". Both citations are stale.
Nothing is added to `FinalChart` in any phase.

The catalogue is seven codes, each of which reports an action the engine took that changed what
is on screen:

| Code | Emitted when | Meta |
|---|---|---|
| `series_capped` | the ranking pass saw more label sets than `maxSeries` (§8.1) | `seen`, `kept` |
| `interval_coarsened` | the requested interval could not meet the point budget (§6.1) | `asked`, `used` |
| `rate_window_widened` | an explicit window was narrower than the step (§7) | `asked`, `usedSec` |
| `increase_window_pinned` | `fn: 'increase'` with an explicit non-step window (§7.3) | `asked`, `usedSec` |
| `gaps_unmeasured` | at least one calendar bucket had no samples (D10) | `buckets` |
| `non_finite_samples_dropped` | at least one `NaN`/`Inf` sample was dropped (D11) | `samples` |
| `previous_period_unavailable` | the previous-window query failed while the current succeeded (§11) | `reason` |

**Renamed in R2:** `gaps_unmeasured` is now `gaps_unmeasured`, because D10 no longer fills
with zero. The name has to survive the fallback in D10 as well as the chosen behaviour, and
"unmeasured" is true either way.

**This catalogue is closed, and it is the only one.** `09-ui-surfaces.md` D15 specifies a
different, disjoint set against a response no server spec produces. The mapping, so that
document can be corrected mechanically rather than re-derived:

| `09` D15 code | This document | Note |
|---|---|---|
| `interval_widened` | `interval_coarsened` | same fact; `09` Interfaces item 5 and its §6 also cite it |
| `series_limited` | `series_capped` | `09`'s name predates the two-phase ranking pass (D8) |
| `series_filled` | `gaps_unmeasured` | and the behaviour changed — D10 |
| `rate_window_widened` | `rate_window_widened` | the one code that already agrees |
| `window_clamped` | *(none)* | there is no window clamp; §7.2 rejects clamping the step, and `increase` is pinned, which is `increase_window_pinned` |
| `rank_window_truncated` | *(none)* | phase A takes a coarse grid over the **whole** window (§8.1); nothing is truncated |
| `dst_bucket_drift` | *(none)* | designed out in §6.4 with `offsetGranularitySec`; the residual is Q7, not a runtime notice |
| *(none)* | `increase_window_pinned`, `non_finite_samples_dropped`, `previous_period_unavailable` | three codes `09` has no case for |

**Cut from the draft:** `percent_of_total_unreliable`, `small_magnitude_values`,
`bucket_boundary_approximate` and `formula_window_mismatch`. Each annotated a caveat the user
could not act on inside the chart, each cost a message string plus a meta shape plus a UI case
plus a test, and three of the four are now designed out rather than annotated
(`bucket_boundary_approximate` by cutting `offsetGranularitySec` in §6.4,
`formula_window_mismatch` by D5's naming rule in §14.4, `small_magnitude_values` by D12's
deterministic ordering).

**Rejected:** `{ chart, meta }` (breaks every renderer — read-path D5's own reason); a
`console.warn` (reaches nobody); an HTTP header (does not survive tRPC/superjson).

### D3. The engine stops at `ConcreteSeries[]`; `format()` is reused, not forked

`format()` is the only producer of `FinalChart` in the tree and stays that way. The metrics
pipeline is `normalize -> resolve grid -> compile -> rank -> fetch -> shape -> compute ->
format`, mirroring the event pipeline `normalize -> plan -> fetch -> compute -> format`
(`packages/db/src/engine/index.ts:27-78`).

**Rejected:** a parallel formatter. `format()` carries four behaviours the renderers depend on
that are not obvious: previous-series matching on `definitionIndex` **and**
`name.slice(1).join(':::')` (`format.ts:94-98`), previous-point alignment strictly by array
index (`:142`), sort by `metrics.sum` descending (`:153`), and `limit` slice after sorting
(`:168`). There is no test over `format()` anywhere in the repo, so a second copy would drift
silently.

**Cost, exactly two one-line widenings:**

| File | Line | Edit |
|---|---|---|
| `packages/db/src/engine/format.ts` | 22 | `type: 'event' \| 'formula'` becomes `type: 'event' \| 'formula' \| 'metric'` |
| `packages/db/src/engine/compute.ts` | 14 | the same widening on `definitions` |

Both parameters are **structural object types**, not the `IChartEventItem` union, so
`definition.hideSeries` (`format.ts:37`) and `definition.formula` (`compute.ts:27`) stay
accessible without narrowing, and no runtime behaviour changes for event reports.

`format.ts:88-91` needs no third arm:

```ts
const eventName =
  definition?.type === 'formula'
    ? definition.displayName || definition.formula || 'Formula'
    : definition?.name || cs.context.event || 'unknown';
```

A metric definition has no `name`, so the shaper sets `cs.context.event = q.metric` and the
existing fallback yields the metric name. `displayName` is honoured by `format.ts:63-69`
unchanged.

### D4. `metricType` is required, explicit and persisted. There is no `auto`

`metricType: 'counter' | 'gauge' | 'histogram' | 'summary'`, no default, chosen in the picker.

**Rejected:** resolving the type at query time from `GET /api/v1/metadata`. Three reasons, each
fatal alone:

1. It is **not project-scoped**. `MetadataService.Metadata` selects
   `JSONExtractString(labels,'__name__'), metadata FROM time_series WHERE metadata != ''` with
   an optional exact-name filter and no `match[]` (`reader/service/metadata.go:38-61`, per
   `04-read-path.md:113-117`). Calling it enumerates every metric name in the shared database
   across every project. It is permanently off the route allow-list.
2. **gigapipe's Prometheus remote-write decoder discards the protocol's metadata.**
   `promMetricsProtoDec.Decode` iterates `req.GetTimeseries()` and copies `ts.GetLabels()`
   verbatim, never reading `req.Metadata` and never setting `__metric_type__`
   (`writer/utils/unmarshal/metrics_protobuf.go:16-68`). The draft said "remote-write carries no
   metadata at all", which is wrong about the protocol — `WriteRequest.metadata` exists. The
   decoder is the citation to keep, because a gigapipe upgrade could change the decoder and
   could not change the protocol.
3. `__metric_type__` is **stripped from the label set** before storage and folded into a
   separate `metadata` JSON column on `time_series`
   (`writer/utils/unmarshal/builder.go`, via `metadata.IsMetadataLabel`). It is not a PromQL
   label and cannot be matched or grouped on.

The picker gets its *suggestion* from OpenPanel's own scoped catalogue (read-path D4,
`04-read-path.md:109-134`: ClickHouse read with an `op_project_id` predicate). The stored query
always carries an explicit `metricType`.

### D5. The stored metric name is what the user picked. Only `histogram_quantile` suffixes

gigapipe's OTLP translation is the authority on what is in storage
(`writer/utils/unmarshal/otlp_metrics.go:186-483`): a classic histogram becomes
`M_bucket{le=...}`, `M_sum`, `M_count` (`:373-392`; exponential histograms are converted to the
same `le` shape at `:427-452`), and a summary becomes `M{quantile=...}`, `M_sum`, `M_count`
(`:471-482`). Counters get `_total` appended and every metric gets unit words appended
(`otlp_metrics_naming.go:148-159`), all before storage. Remote-write names arrive verbatim.

So the picker offers real stored names and `q.metric` holds one verbatim. The compiler appends
**one** suffix, in **one** case: `metricType === 'histogram'` implies
`fn === 'histogram_quantile'` implies `_bucket`.

**Rejected:** the draft's `HISTOGRAM_SUFFIX` / `SUMMARY_COUNT_FNS` tables, which mapped every
`fn` onto `_sum` / `_count` / `_bucket`. They produced combinations with no reducer row
(reviewer finding, confirmed: `counter + last_over_time`, `histogram + none`,
`summary + avg_over_time` all passed the deny-list refinements and had no table entry), and they
hid the fact that `M_sum` and `M_count` are *counters in their own right*. Addressing them
directly — pick `rpc_duration_seconds_sum`, `metricType: 'counter'`, `fn: 'rate'` — is simpler,
is what a Prometheus user expects, and makes the mean-latency formula
(`rate(_sum) / rate(_count)`) dimensionally consistent by construction (§14.4).
`metricType: 'histogram'` therefore exists solely to enable `histogram_quantile`, and
`metricType: 'summary'` solely to mark "the `quantile` label is a filter, not a breakdown".

### D6. Two-stage time grid: fixed epoch-aligned PromQL step, calendar buckets rebuilt in JS

PromQL has no calendar. `step` is a fixed duration; OpenPanel's intervals are
`{minute, day, hour, week, month}` (`packages/constants/index.ts:236-242`) and the event engine
buckets with `toStartOfWeek(created_at, 1, '<tz>')` / `toStartOfMonth(created_at, '<tz>')`. A
month is not a duration; a DST day is 23 or 25 hours.

So: query gigapipe at a **sub-bucket** step, then fold each returned sample into its
project-local calendar bucket by absolute timestamp
(`DateTime.fromMillis(ms, { zone: tz }).startOf(unit)`). Luxon's `startOf('week')` is
Monday-based, matching ClickHouse mode `1`.

**Rejected:** `step = <interval width>`. It cannot express week or month, and it drifts an hour
off local midnight the moment a DST transition falls inside the window.

### D7. `start` is an exact multiple of `step`, and the step is the **coarsest** sub-bucket

Two rules, both load-bearing, one of which contradicts the code block in
`04-read-path.md:1328-1339`.

**Alignment.** gigapipe's accelerated planners bucket in ClickHouse on an epoch-anchored grid
(`intDiv(timestamp_ns, step_ns) * step_ms`,
`reader/promql/promql_transpiler/planner/bucket_producer.go:42-43`), and the Prometheus engine
evaluates at `start + k*step`. If `start` is not a multiple of `step`, every evaluation point
sits some delta after the nearest ClickHouse bucket key; past the lookback delta the series
comes back **empty**, not wrong — blank, with no error. So `alignWindow()` snaps `start` down
and `end` up to multiples of the step in UTC epoch seconds, and `resolveGrid` asserts
`fromSec % stepSec === 0`.

**Coarsest, not finest.** `04-read-path.md:1332-1335` returns the *smallest* ladder value that
fits the point budget:
`for (const s of STEP_LADDER_SEC) { if (s > ceiling) break; if (ceil(span/s) <= maxPoints) return s; }`.
That contradicts read-path's own worked examples (`:1365-1370` says 30d/hour gives 3600; the
loop returns 1800) and costs 2-4x for zero display benefit, because §6.2 folds sub-buckets into
calendar buckets anyway. The correct step is the **coarsest sub-bucket that still resolves the
calendar bucket**, which is exactly `MAX_SUB_BUCKET[interval]` — every value in that map is
already a ladder member. See § Interfaces for the amendment read-path owes.

**Budget failure coarsens the interval; it does not throw.** `interval` and `range` are
independent fields on `zMetricReportInput` (mirroring `zReportInput`,
`packages/validation/src/index.ts:238,255`) and `isHourIntervalEnabledByRange`
(`packages/constants/index.ts:287-296`) is a UI-only helper, so `range:'12m', interval:'hour'`
is reachable from MCP, from the agent and from any saved spec. An event report at that input
returns a chart; a metric report must not return an exception. `resolveGrid` walks the display
interval up the ladder `minute -> hour -> day -> week -> month` until the point budget is met
and emits `interval_coarsened`. Only a custom date range beyond about eight years exhausts the
ladder, and that throws.

### D8. Series capping is done in JS after a ranking pass. `topk` never appears in a range query

The draft used `topk(maxSeries, ...)` as a cardinality cap, and
`04-read-path.md:884-886, 1389-1399` codified it. **It is not a cap.** `topk` is a Prometheus
aggregation operator evaluated independently at every evaluation timestamp of a range query.
gigapipe does not accelerate it and says so verbatim: `aggFns` maps only
SUM/MIN/MAX/AVG/COUNT/GROUP/STDDEV/STDVAR, above the comment "topk/bottomk (which keep the input
series) and quantile/count_values (which need bespoke shapes) are absent and fall back to the
engine" (`reader/promql/promql_transpiler/optimizer/vector_agg.go:12-25`), so
`Aggregate.Applicable` (`:33-43`) returns false and stock per-step semantics apply. Four
consequences, every one silent:

- the response holds the **union** of every step's top-K, routinely far more than `maxSeries`;
- each series is **ragged** — no sample at the steps where it left the top-K;
- D10's zero-fill then paints a real, healthy series diving to zero, and blames the target;
- `04-read-path.md:1397-1399` classifies more than `maxSeries` series as a compiler bug and
  raises `GigapipeUpstreamError`, so an ordinary grouped chart would **hard-error** on any
  series churn.

It is not a cost cap either: because it is not pushed down, it trims the JSON and nothing else.

**Replacement — two phases, both accelerated:**

- **Phase A (ranking).** The identical compiled expression, minus `topk`, issued as a
  `query_range` at a coarse `rankStepSec` (at most 24 points over the whole window). Rank the
  returned label sets by the sum of absolute values over that coarse grid, keep the top
  `maxSeries`, emit `series_capped` with the **exact** number seen. Skipped when there is
  nothing to rank, merged into phase B when the chart grid is already coarse enough.
- **Phase B (chart).** A `query_range` at `stepSec` **pinned** to exactly those label sets
  (D9's pinning mechanism), with no `topk` anywhere.

**Rejected:** a single instant `topk(k, <fn>_over_time(<inner>[<whole window>]))` ranking query,
which is exact at one timestamp and would be one call instead of two. It cannot serve a window
over about 24.8 days: `rangeFrame` calls `windowOffset`, whose `WindowPoint.Offset` is an int32
of milliseconds and which errors "range %s is too large to accelerate"
(`reader/promql/promql_transpiler/planner/shared.go:45-55`, reached from
`OverTimePlanner.Process`, `planner/over_time.go:85-87`). 30d, 3m, 6m and 12m are all past it.

**Rejected:** capping in the shaper only. `format.ts:168` slices *after* building and sorting
everything, so the ClickHouse cost and the JSON are already paid.

### D9. Previous period is a shifted, pinned second query — and pinning is regex alternation, not equality

`offset` is rejected: `EnableNegativeOffset: false`
(`reader/router/prometheus_query_range.go:42`) makes half the offset space unavailable, and
`getChartPrevStartEndDate` shifts by an arbitrary millisecond delta not expressible as a PromQL
duration literal (`packages/db/src/services/date.service.ts:273-296`).

**Pinning cannot be equality matchers.** The draft specified "explicit equality matchers for
each resolved label set, appended to the selector as ordinary filters", and matchers inside one
PromQL selector are **conjoined** — `compileSelector` joins with `,`
(`01-tenancy-and-security.md:1104-1108`). Pinning `{route="/a"}` and `{route="/b"}` emits
`route="/a",route="/b"`, which matches nothing, and §12's absence table then classifies the
empty result as "a series absent for the whole window", so the comparison vanishes with no
error — the exact failure pinning exists to prevent. The correct form is **one regex-alternation
matcher per identity label**, with every value regex-escaped and passed through the tenancy
compiler's `quote()`, plus a **membership filter in the shaper**, because a multi-label
alternation is a cross-product and is over-inclusive (§8.2).

**The pinned values are untrusted.** They come out of a gigapipe response, i.e. out of ingested
telemetry, i.e. from anyone holding a write token. They never passed `zMetricLabelFilter`, so
they get `quote()` (`01-tenancy-and-security.md:1084-1090`) plus regex escaping, and the pin set
is bounded by count and by total bytes.

**The previous grid is the current grid shifted by a whole number of steps**, not
`resolveGrid(previousWindow)`. Two reasons: `format.ts:142` pairs `previousSerie.data[index]`
with `cs.data[index]`, so a different bucket count shifts the whole comparison by one bucket
with no error anywhere; and the shift must stay step-aligned or D7's blank-series failure fires
on the previous window. `shiftSteps = Math.round(shiftMs / (stepSec * 1000))`.

**Accepted, stated out loud:** the previous buckets are therefore *duration*-shifted, not
calendar-aligned. At `interval: 'month'` the previous "months" are equal-length windows, not
calendar months. This is **not** a metrics-specific regression — the event path shifts by a
fixed millisecond delta too (`getChartPrevStartEndDate`, and `executeChart` re-plans on those
shifted dates, `engine/index.ts:51-65`) — so metric reports inherit the app's existing
previous-period semantics rather than inventing worse ones. No notice: a notice on behaviour the
event path shares would be noise.

### D10. An unmeasured bucket is `null`, not `0`. The `count: number | null` widening is pulled into v1

*(Changed in R2. The draft, and R1, filled with `0` and deferred the widening. A reviewer is
right that this is the wrong trade for an observability product, and the cost turns out to be
about half of what R1 priced.)*

`IChartSerie['data'][number].count` is `number` today (`types.validation.ts:97-103`). Filling an
empty bucket with `0` makes a measured zero and a missing sample **indistinguishable** — which
is the single most important distinction there is during an incident. "The service served 0
requests" and "we have no data for the service" produce the same line, and D8's ranking pass
plus the empty-state card do nothing about it: the failure is inside a series that *does* have
data, at the bucket where the target went away.

**v1 emits `null` for a bucket with no samples**, widens
`IChartSerie['data'][number].count` to `number | null`, and still attaches `gaps_unmeasured`
with the count so the fact is also legible outside the chart.

**The real cost, re-priced from disk.** R1 said "all seven renderers, `report-table-utils`, the
tooltip and the MCP shaper". Four of those are already null-tolerant, and the arithmetic layer
needs nothing at all:

| Site | Today | Change |
|---|---|---|
| `packages/common/src/math.ts:20-33` | `sum`/`min`/`max` are already typed `(number \| null \| undefined)[]` and filter with mathjs `isNumber`; `average` (`:8-18`) takes `(number \| null)[]` | **none.** `format.ts:78-84` computes every `Metrics` field through these |
| `report-table-utils.ts:421` | `dataPoint?.count ?? 0` | **none** (already coalesces) |
| `report-table.tsx:401-402` | `a.count ?? 0` | **none** |
| `report-chart-tooltip.tsx:92` | `(b.count \|\| 0) - (a.count \|\| 0)` for sorting | **none** for sorting; `:113` `formatWithUnit(item.count)` must render `null` as "—", not `0` |
| `use-rechart-data-model.ts:35` | `acc2[…:count] = item.count` | **none in code.** A `null` dataKey is exactly how recharts draws a gap, which is the display we want |
| `pie/chart.tsx:51` | `formatWithUnit(item.count)` | null-guard |
| `packages/mcp/src/tools/analytics/reports.ts:88, 105` | `lookup.get(date) ?? 0` | render `null` as an empty cell. **This one is a wrong answer today and would stay one:** `?? 0` turns a null gap back into a zero for the agent |
| `packages/db/src/engine/compute.ts:135, 147` | `dataPoint?.count ?? 0` into the formula scope | **stated, not changed in v1:** a formula over a gap still reads `0`. §14.4's `A/B` with a null `B` yields `Infinity`, which is the case D11 does not catch. Widening the formula scope to skip the date is a separate change with its own semantics question (Q9) |
| `packages/validation/src/types.validation.ts:99-103` | `count: number` | `count: number \| null` — the one shared-type edit this document makes |

That last row is a real shared-type edit and it is the reason this decision is a decision and
not a detail: it is the only thing in this work-stream that changes a type every event-chart
consumer sees. It is safe because the consumers above already coalesce, and it is worth it
because the alternative is a confidently displayed wrong number.

**Fallback, and how to tell.** If the type-widening audit finds a consumer that is not
null-safe and cannot cheaply be made so, ship the `0` fill with the same `gaps_unmeasured`
notice and file the widening as a named follow-up. That is R1's behaviour, so the fallback is a
one-line change in the shaper, not a redesign. The notice name survives either way — that is
why it was renamed in D2.

Both behaviours are less bad than they sound in the common case, because PromQL carries a
sample forward for 5 minutes before declaring it stale (`staleness = time.Minute * 5`,
`reader/promql/promql_transpiler/planner/shared.go:14`), so ordinary scrape jitter never reaches
the shaper as a gap — and because D8 removes the ragged-series case that would otherwise have
made a zero-fill actively lie.

### D11. Non-finite values are dropped at parse

gigapipe serialises sample values with `strconv.FormatFloat(v.F, 'f', -1, 64)`
(`reader/controller/prom_query_range.go:280`), so a PromQL division by zero arrives as the JSON
string `"NaN"`, `"+Inf"` or `"-Inf"`. `Number("+Inf")` is `NaN`, and `sum`, `min` and `max`
filter with mathjs `isNumber`, which is `true` for `NaN`
(`packages/common/src/math.ts:20-33`); only `average` guards (`:8-18`). One non-finite point
makes `metrics.sum` `NaN`, which makes `format.ts:153`'s comparator return `NaN` and leaves the
series order unspecified. So non-finite samples are treated as **absent** during bucket
reduction, and `non_finite_samples_dropped` carries the count.

### D12. Display order is made deterministic in the shaper, not by changing `format()`

`sum()` is `round(arr.filter(isNumber).reduce(...))` with `round`'s default 2 decimals
(`packages/common/src/math.ts:3-6, 20-21`), so `metrics.sum` is **quantised to 0.01**. For a
0..1 CPU ratio or any sub-0.005 per-bucket rate, every series' `metrics.sum` is `0`,
`format.ts:153`'s comparator returns `0` for every pair, `format.ts:168` slices `limit` off that
order and `use-visible-series.ts:31` renders the first 5 ids off it.

The fix costs nothing shared: `Array.prototype.sort` is **stable** (ES2019), so a comparator
returning 0 preserves input order. The shaper therefore emits `ConcreteSeries` already sorted by
unrounded rank descending, tie-broken by `id` ascending, and `format()`'s sort becomes a no-op
for tied sums. Order is then deterministic across identical requests, which is what
`Report.visibleSeries` (`schema.prisma:446`) needs.

**Rejected:** carrying a `rank` field on `ConcreteSeries` and changing `format.ts:153` to sort
on it. It edits shared, untested code for a case a stable sort already covers.

**Rejected:** a `small_magnitude_values` notice. It reports nothing the user can act on inside
the chart; the actionable fix is the y-axis conditional plus `scale` and `unit` in the picker,
which is a UI item (§ Interfaces).

### D13. Only chart types that mean something for a metric are offered

Allowed: `linear`, `area`, `metric`, `bar`, `pie`, `histogram`. Hidden: `funnel`, `retention`,
`conversion`, `sankey`, `map`.

The four hidden non-`map` types are not `FinalChart` surfaces at all — they hit `chart.funnel`,
`chart.cohort`, `chart.conversion` and `chart.sankey`, each with its own result type
(`packages/trpc/src/routers/chart.ts:456, 498, 554, 636`). `map` *is* a `FinalChart` surface but
keys its choropleth on ISO country codes; a metric label is not one. In P2 the gate is one line
in the engine because there is one entry point. § P2.5 lists the five additional call sites the
gate needs once reports can hold metric series.

### D14. Fan-out, deadline and partial failure are the engine's problem, not the caller's

One report is up to 6 metric definitions times up to 3 gigapipe calls (rank, chart, previous) =
18 range queries against a **single Go process** with a hard-coded 30 s engine timeout
(`reader/router/prometheus_query_range.go:32`) and one **global** `MaxSamples` budget shared by
every tenant (`:31, :49`, set only from `ADVANCED_PROMETHEUS_MAX_SAMPLES`). The engine bounds
its own fan-out with a concurrency limiter, carries one `AbortSignal` for the whole report with
a deadline strictly below gigapipe's 30 s, and does **not** return partial charts: a chart
missing one of its two lines is indistinguishable from "no data". The single exception is the
previous window, which degrades to "no comparison" plus a notice.

### D15. There is no `Report.dataSource` column. Dispatch is derived from the series array

*(New in R2. This promotes § P2.5's rejection to a decision, because two other documents build
work on the opposite answer and one of them prices it.)*

`08-schema-changes.md` S1 makes `Report.dataSource` a new Postgres enum `DataSource { events
metrics }` plus a column, with a migration, an inventory entry, a rollback entry, nine whitelist
sites and a two-day line item. `09-ui-surfaces.md` D8 builds an eight-write-path table on it and
`04-read-path.md` D4 assigns `zDataSource` to this work-stream. **There is no column.**

The argument, which is a cost argument and not a taste argument:

1. **The discriminator has to arrive from the browser anyway.** `ctx.report` is `null` for every
   authenticated in-app query — verified, `packages/trpc/src/routers/chart.ts:137-141` returns
   `next({ ctx: { report: null } })` on the non-share branch. A Prisma column cannot drive a
   branch on a request that never loads a row. So the field must also be on `zReportInput`,
   which is where `08` S1's own reasoning ends up.
2. **It already arrives.** `zReportInput.series` carries the `type: 'metric'` union member. A
   second discriminator is a second copy of one fact, and two copies of a discriminator that can
   disagree is worse than none: a report whose `dataSource` is `events` and whose series are
   metric series is a state the column makes representable and the derivation does not.
3. What the column buys over `series.some(s => s.type === 'metric')` is a filterable, indexable
   predicate. `08` §3 itself decides **not** to add the index, on the correct grounds that no
   query filters reports by data source.
4. What it costs is an irreversible Postgres enum (`08`'s own rollback section: the honest
   rollback is `DELETE FROM reports WHERE "dataSource" = 'metrics'` first), a migration, three
   write-side literals in `report.ts`, three more in MCP, and a `.strict()` behaviour change.

**Chosen:** one helper, `getReportDataSource(series)` in `packages/db/src/engine/data-source.ts`,
returning `'events' | 'metrics'`, derived. `zDataSource` as a *validation* type may still exist
as the helper's return type; there is no Prisma enum and no column.

**What the other documents keep.** `08` §3's nine-site inventory and `09` D8's eight-site table
are correct and valuable work — their *subject* is wrong. Retarget both at the **series union
member**: the question at each site stops being "does it write `dataSource`?" and becomes "does
a `type: 'metric'` item survive this projection unchanged?". That is a smaller change at the
three `report.ts` write literals (they write `events: report.series` whole and need nothing) and
the same change at the read projections, which is where the data loss actually lives (§15.1).

**Rejected: `Report.options`.** `08` S1 rejects it correctly — `zReportOptions` is a
discriminated union keyed on chart type, and overloading it makes `dataSource: 'metrics'` and
`chartType: 'histogram'` mutually exclusive. That rejection stands; it just is not an argument
for a column.

**Deploy-ordering hazard is unchanged either way.** §15.2's release ordering exists because
`Report.events` is unversioned and `transformReportEventItem` is lossy. A column would not have
protected the series array. Do not read D15 as making §15.2 optional.

### D16. There is exactly one `zMetricQuery`, and it is § 2 of this document

*(New in R2. Closes `07-alerting.md` Q1, which is marked blocking for four of its sections.)*

Four incompatible definitions are on disk or implied:

| Source | Shape |
|---|---|
| `01-tenancy-and-security.md` §7.2 | `{metric, filters[{name,operator:eq\|neq\|re\|nre}], fn(11, incl. `irate`/`deriv`), window(7), aggregation(incl. `quantile`/`topk`/`bottomk`), groupBy, quantile, k}` |
| **This document § 2** | `{type, id, metric, metricType(4), filters, fn(11, incl. `last_over_time`, no `irate`/`deriv`), window(11 incl. `auto`), aggregation(`sum\|avg\|min\|max\|count`), groupBy, quantile, scale, displayName, hideSeries}` + `refineMetricQuery` |
| `09-ui-surfaces.md` D3, quoted as "consumed verbatim" from here | `metricType(3)`, `fn` of 5 including a `value` member, `matchers[{name,op:=\|!=\|=~\|!~}]`, `fill`, `seriesLimit(1–200)` |
| `07-alerting.md` Q1, quoting "03's version" | the same as `09`'s |

The third and fourth are the same **stale** shape, and it is not a version of this document that
ever shipped: grep this file — `seriesLimit` appears zero times, `fill` zero times, `matchers`
appears only as a local variable inside `01`'s `compileSelector`, and `'value'` is not a member
of `zMetricFn`. `07` Q1 also places this schema in `packages/validation/src/index.ts`; § 1 puts
it in `packages/validation/src/telemetry.validation.ts`, which is where `01` puts it and has
been since R1. Anyone re-deriving from `07` Q1 or `09` D3 is building against a document that
does not exist.

**Chosen: § 2 is the definition, in `packages/validation/src/telemetry.validation.ts`, owned
here, reviewed by tenancy.** It wins on merits and not only on ownership: it is the only version
whose `fn` set is provably a subset of gigapipe's accelerated `rangeFns` and whose `aggregation`
set is a subset of `aggFns` (§ 0, asserted by T-C6), and it is the only one that has already
removed `topk`/`bottomk`, which D8 and § 4.2 depend on.

Consequences, all of them mechanical:

- `01-tenancy-and-security.md` §7.2's schema block becomes a **pointer** to § 2 here. `01` keeps
  the reserved-prefix refinements and the charset regexes — they are its security argument — and
  stops re-declaring the object. The § Interfaces diff table itemises every field difference.
- `07-alerting.md` Q1 resolves to "P2's, and it is the current § 2 body, not the shape Q1
  quotes". `07`'s own stated position is already this; it just needs to stop being a question.
- `09-ui-surfaces.md` D3 is rewritten field-for-field, and with it §4.2's nuqs key table (`mt`
  enumerates three `metricType`s where there are four; `max` keys a `seriesLimit` that does not
  exist), §4.3's picker defaults (`fn: 'value'` for gauges — the gauge default is `none`), and
  D9's four-way operator adapter (the schema's operators are `eq\|neq\|re\|nre`, not
  `=\|!=\|=~\|!~`; the PromQL operator appears only inside the compiler).
- `11-testing-strategy.md` §3.4 Q1–Q3 and § 4's goldens name `zMetricMatcher`. The type is
  `zMetricLabelFilter` and the field is `filters`.

**One name, checked.** Add a doc test or a CI grep asserting that the string `export const
zMetricQuery` appears in exactly one specification. Cheap, and it is the control that would have
caught this a month ago.

### D17. Package home and router namespace, ratified

*(New in R2. Closes `09-ui-surfaces.md` Q1 and `11-testing-strategy.md` Q1, both marked
blocking, and `04-read-path.md` Q1. This document does not own either question; it is recording
the decision because three documents are blocked on a blueprint that does not exist and this one
is the only place all three converge.)*

**Package home: `04-read-path.md` D1 is ratified.** Transport, errors, lease, kill switch, label
primitives, route table and the three query compilers live in the workspace package
`packages/gigapipe`. The ClickHouse-side pieces — `getTelemetryClient`, `TELEMETRY_TABLES`,
`G()`, `gigapipeTable()` — live in `packages/db`, because they need `chQuery` and the existing
clustered-table machinery (`04-read-path.md` D12; `08-schema-changes.md` S10/S11 says the same).
The **metrics engine itself** (§ 1's `packages/db/src/engine/metrics/*`) stays in `packages/db`,
because `compute()` and `format()` are there and P2.5 and P5 both call it outside tRPC.

Two corrections that follow:

- This document already uses `packages/gigapipe` and `@openpanel/gigapipe` throughout (§ 4).
  `04-read-path.md` D1's "Action for the P0 owner: rewrite `03-metrics-engine.md:2113`" is
  **already done** and should be struck. `05-logs.md` still places nine files under
  `packages/db/src/gigapipe/`; that is the rewrite that remains.
- `04-read-path.md` D1's layer table assigns `src/ingest/*.ts` and `vendor/opentelemetry-proto/**`
  inside `packages/gigapipe` to the ingest work-stream, while `02-ingest-gateway.md` D9 puts all
  of it in `apps/api/src/telemetry/` and argues the case at length (one directory, one Prisma
  seam in `deps.ts`, so a later lift-out is a `git mv`). `02` is the better-argued of the two and
  `04` does not defend its version. Those two rows come out of `04` D1's table.

**Router namespace: one root, `observability.{metrics,logs,traces,status}`.** Base procedure per
`04-read-path.md` D13 — `protectedProcedure.use(rejectShareId)` plus the kill-switch check, with
the fail-closed `NO_PROJECT_ID` allow-list for procedures whose input carries no top-level
`projectId`. Consequences:

- `01-tenancy-and-security.md` §7.1's hand-rolled `publicProcedure` block becomes a pointer to
  `04` D13. `04` is right on the merits: re-deriving `enforceAccess`
  (`packages/trpc/src/trpc.ts:90-112`) opts the one router the plan calls a security boundary
  out of every future change to the repo's central access middleware. `01` keeps the two *rules*
  — derived project id, derived query spec — which is what it actually owns.
- `05-logs.md` §5.3's `logsRouter` in `packages/trpc/src/routers/logs.ts` folds in as
  `observability.logs`. Every `trpc.logs.*` call site in `05` becomes `trpc.observability.logs.*`.
- This document adds **no** `packages/trpc/src/routers/metrics.ts`. `09` Q1 says it does; that is
  stale — grep this file, there is no such path. Its only router touch point is
  `observability.metrics.chart`, which `04` owns.
- Saved-report execution stays on `chart.*` (`09` D5), which is § P2.5 here, gated by D18.

### D18. The metric-report **share path** is owned here, and it has four hard prerequisites

*(New in R2. A reviewer found that nothing owned it and that the "telemetry is never
share-reachable" guarantee evaporates the moment saved metric reports render.)*

Today's guarantee lives in `observabilityProcedure`, which hard-rejects `shareId`
(`04-read-path.md` D4/D13, `01-tenancy-and-security.md` D12). That covers `observability.*` and
nothing else. `09-ui-surfaces.md` D5 routes **saved** metric reports through `chart.chart`, i.e.
`chartProcedure` — a `publicProcedure` that serves anonymous viewers whenever `shareId` is
present (`packages/trpc/src/routers/chart.ts:83-141`) — and § P2.5 of this document makes that
the plan of record. So the guarantee ends exactly when P2.5 ships, and no document owned the
transition. **This document owns it**, because it owns P2.5.

What an anonymous share viewer controls today, all verified in the tree:

- the time window: `chart.chart` merges caller-supplied `range` / `startDate` / `endDate` /
  `interval` over `ctx.report` (`chart.ts:598-607`);
- the cache key: `cacheMiddleware` keys on `trpc:${path}:` plus `JSON.stringify(getRawInput())`
  with **no user, session or project component** (`packages/trpc/src/trpc.ts:196-208`), so every
  distinct window is a fresh miss;
- the rate: `chartRouter` has no `rateLimitMiddleware` anywhere (`packages/trpc/src/trpc.ts:135-140`
  defines it; grep `chart.ts` — zero occurrences).

Against gigapipe that is materially worse than against ClickHouse, because gigapipe is one Go
process with a **hard-coded, non-configurable 30 s** PromQL engine timeout and **one global**
`MaxSamples` budget shared by every tenant (`reader/router/prometheus_query_range.go:31-32, 49`).
One public share link is then an unmetered, unauthenticated, cross-tenant query generator.

**The share path does not ship until all four of these are true. This is a gate, not a
checklist.**

1. **Derived spec, not received.** `chartProcedure`'s existing four-field window allow-list
   (`range`, `startDate`, `endDate`, `interval`) with an explicit `isMetricReport(ctx.report)`
   check and **no** fallback to `input.series`, `input.filters` or `input.breakdowns`. This is
   `01-tenancy-and-security.md` §7.1's share rule, applied to `chart.*` rather than to
   `observability.*`.
2. **`rateLimitMiddleware` keyed on `shareId` plus trusted IP** on every share-served chart
   procedure — not only the metric one. An events chart on the same share is the same cache-key
   generator against the same cluster.
3. **A separate `withProjectLease` bucket for share traffic**, as `07-alerting.md` D15 does for
   alert evaluation, so anonymous readers cannot consume the authenticated members' concurrency
   budget.
4. **A Tier-1 test that a share link cannot vary `series`, `filters` or `breakdowns`**, plus the
   existing `observability.*` rejection test.

**`compiled` and the share path.** `09-ui-surfaces.md` D14 wants the compiled PromQL on the chart
response and mitigates the leak with "populated only when `ctx.report === null`". The rule is
correct and cheap, and D2 makes it unnecessary: `compiled` is on `MetricChartResult`, which only
`observability.metrics.chart` returns, and that procedure rejects `shareId` before the resolver
runs. The leak is closed by construction. Two consequences for `09` and `11`:

- Keep D14's rule for whenever `chart.chart` starts returning `MetricChartResult` — at that
  point it is the only thing standing between an anonymous viewer and the internal project id
  plus the full matcher set, and it should be an assertion in the transport, not a conditional
  in a resolver.
- **Rewrite `11-testing-strategy.md` T9 / `09` T9.** As written it asserts on a request shape the
  router refuses: an `observability.*` call carrying a `shareId` never reaches the resolver, so
  "`compiled` is absent from every response served with a `shareId`" is vacuously true. The test
  that has value is the rejection itself — any `observability.*` call carrying a `shareId` is
  `FORBIDDEN` — which is already `11`'s Q27. Until the share path ships, `09`'s failure mode F12
  is **unreachable**, not mitigated; say so rather than claiming a control.

### D19. One point budget, one step algorithm, one channel for "the interval changed"

*(New in R2. Three documents carry three point budgets and two step algorithms for one grid.)*

| Source | Budget | Algorithm |
|---|---|---|
| This document, § 6.1/§ 6.3 | `cfg.maxPoints = 3000` | `resolveStep` walks `MAX_SUB_BUCKET[interval]` — the **coarsest** sub-bucket that still resolves the calendar bucket — and coarsens the *interval* when the budget is exceeded |
| `04-read-path.md` § 4.3 | `TARGET_MAX_POINTS = 1_500` | `resolveStepMs` returns the **smallest** fitting ladder value |
| `09-ui-surfaces.md` Interfaces item 5 | "8 000-point engine ceiling" | — |

Three numbers produce three different charts for the same `(range, interval)`. **This document
owns the grid**, for the reason § 6.2 gives: the step only exists to be folded into calendar
buckets in the project's timezone, so the correct step is a property of the *interval*, not of
the point budget, and the budget only decides whether the interval itself has to coarsen.
`04`'s loop is also internally inconsistent — it contradicts its own worked examples in the same
section (30 d at `hour` is documented as a 3600 s step; the loop returns 1800) and costs 2-4x
for zero display benefit.

**Settled: `maxPoints = 3000`, `resolveStep` as in § 6.1, and `04`'s `resolveStepMs` /
`clampStep` is deleted or explicitly marked not-used-by-metrics.** `09`'s 8 000 is corrected to
3 000. Q3 in § Open questions is the one measurement that can still move the number, and it
moves it *down*, to 2 400.

**And one channel, reported twice.** `04` D9 reports coarsening as
`resolution.effectiveInterval`; this document reports it as the `interval_coarsened` notice.
These are the same fact and both should exist, but they must be produced **once**: `resolveGrid`
returns `interval` and a notice, and the resolver copies the interval into `resolution` (D2).
Two independent derivations of "did the interval change" is how they end up disagreeing on the
one chart where it matters.

### D20. The query surface has a ceiling, and it is not "PromQL"

*(New in R2. A reviewer is right that the plan offers a Prometheus-shaped product to users who
already run Prometheus, without ever stating what is not expressible.)*

`zMetricQuery` compiles to one selector under one aggregation. Arithmetic **between** two metric
series is done by `compute()`, after the fact, on `ConcreteSeries` — and `compute()` pairs
series by a **positional breakdown signature**: `serie.name.slice(1).join(':::')`, an ordered
tuple of label *values* (`packages/db/src/engine/compute.ts:42-53`, verified). Two consequences,
neither of which any document states today:

1. **Formulas are post-hoc arithmetic over aligned buckets with identical `groupBy`, in
   identical order.** § 14.4 works because both operands were authored with the same `groupBy`;
   change one and the formula silently produces nothing, or pairs the wrong rows.
2. **PromQL vector matching — `on()`, `ignoring()`, `group_left`, `group_right` — is not
   expressible in v1 and is not expressible in any planned phase before P6's raw PromQL.** So
   the most common non-trivial observability query, an error ratio joining two series with
   different label sets (`sum by (route)(rate(errors)) / sum by (route,method)(rate(total))`),
   cannot be written. `01-tenancy-and-security.md` §10's evasion table already names
   `group_left` as "the one that bites" in the raw-PromQL phase, which is the same fact from the
   other end.

**Chosen for v1: state the ceiling, ship the aligned-`groupBy` formula, and do not build a join
primitive yet.** The two queries every observability user writes first — error ratio and mean
latency — are both expressible *when both operands carry the same `groupBy`*, which is the
common authoring shape and which § 14.4's pin-set intersection makes reliable. The honest
follow-up, if the ceiling turns out to bind, is an explicit two-series ratio member on
`zMetricQuery` with a declared join-label list — much smaller than raw PromQL, and specifiable
without a parser. That is Q8, not v1.

This is a **product** statement as much as an engineering one and it belongs in the plan's
product section as well as in § 0's exclusion table: *the metrics surface is a structured query
builder over one selector, not PromQL; joins across differently-labelled series arrive with raw
PromQL in P6 or not at all.*

---

## Design

### 0. The v1 cut, and why every v1 query is accelerated

**In:** counters, gauges, classic histograms (via `histogram_quantile`), summaries (via the
`quantile` label); `sum/avg/min/max/count` cross-series aggregation;
`rate/increase/delta/*_over_time/histogram_quantile`; groupBy mapped to breakdowns; previous
period; formulas over metric series **that share a `groupBy`** (D20); the six chart types in D13.

**Out of v1, each with its reason:**

| Excluded | Reason |
|---|---|
| raw PromQL | P6, and an AGPL §13 fork trigger (`10-ops-retention-billing.md:1801-1840`) |
| `irate`, `deriv` | Absent from `rangeFns` (`optimizer/vector_range.go:21-35`), so `VectorRange.Applicable` is false, the enclosing `sum by (...)` then fails `Aggregate.Applicable` (which requires a `*VectorSelector` child, `vector_agg.go:33-43`), and **neither** level is pushed down: the engine pulls every rollup point over the whole read window for every matching series. Worse, `irate` over gigapipe is computed on 15 s rollup points, not raw samples (`hints.Func` is unknown, so `useRawData` is false, `reader/service/prom_queryable.go:147-158`), so it is not Prometheus `irate` and would not agree with one. This is the same cost argument the draft used to exclude `quantile_over_time`, applied consistently |
| `quantile_over_time`, `stddev_over_time`, `stdvar_over_time` | Explicitly `false` in `supportedFunctions` (`prom_queryable.go:124-126`), which forces the raw `samples_v3` read path instead of the `metrics_15s` rollup — a different and much heavier cost profile that deserves its own quota decision |
| `topk`/`bottomk`/`quantile` as a user aggregation | Not in `aggFns` (`vector_agg.go:16-25`); unaccelerated, and `topk` in particular is per-instant (D8). The tenancy schema's `k` field goes with them |
| native histograms | `writeMatrix` walks `s.Floats` only (`prom_query_range.go:273`) and drops `s.Histograms` silently; gigapipe's OTLP path converts exponential histograms to `le` buckets anyway (`otlp_metrics.go:427-452`), so there are none in storage |
| negative offsets, `@`, subqueries, `absent`, `label_replace` | Not expressible in `zMetricQuery`; `EnableNegativeOffset` is `false` (`prometheus_query_range.go:42`), so even a P6 raw surface must reject them explicitly rather than inherit stock Prometheus behaviour |
| **vector matching** — `on()`, `ignoring()`, `group_left`, `group_right` | **Not expressible in v1 and not in any planned phase before P6 (D20).** `compute()` pairs series by a positional breakdown signature, `serie.name.slice(1).join(':::')` (`packages/db/src/engine/compute.ts:42-53`) — an ordered tuple of label *values*. A formula is arithmetic over aligned buckets whose operands share a `groupBy`, not a join. An error ratio over two different label sets is the query this excludes, and it is a common one |
| binary operators between two **selectors** (`a / b` inside one expression) | Same reason. `a / b` is authored as two definitions plus a `formula`, evaluated in JS after both matrices land. The PromQL the engine emits never contains a binary operator between two vector selectors |

**The property this buys, and a test asserts it (T-C6):** every member of `zMetricFn` except
`none` and `histogram_quantile` is a key of gigapipe's `rangeFns`, and every member of
`zMetricAggregation` is a key of `aggFns`. There is no v1 query the engine can emit that
gigapipe evaluates in memory.

### 1. File layout

```
packages/validation/src/
  telemetry.validation.ts   # zMetricQuery — tenancy owns the file, this spec owns these fields

packages/db/src/engine/metrics/
  compile.ts    # compileMetricQuery()
  grid.ts       # resolveGrid(), resolveStep(), alignWindow(), shiftGrid(), bucketOf()
  window.ts     # resolveRateWindow()
  rank.ts       # resolveSeriesSet()   — phase A (D8)
  pin.ts        # pinMatchers(), matchesPin()
  identity.ts   # seriesIdentity()
  reduce.ts     # reduceBucket()
  shape.ts      # shapeMatrixToFinalChart(), shapeMatrixToConcreteSeries()
  notices.ts    # MetricNotice, MetricChartResult, the catalogue
  execute.ts    # executeMetricChart(), executeMetricAggregate()
```

`packages/db` and not `packages/trpc`, because P2.5 and P5 both need it outside tRPC. The repo
avoids barrel files (`.claude/CLAUDE.md`), so each module is imported directly. The engine lives
in `packages/db` and the transport plus the three query compilers live in `packages/gigapipe`
(D17); the split is "does it need `chQuery` and `compute()`/`format()`, or does it open a socket
to gigapipe?". This document adds no file under `packages/trpc`.

### 2. `zMetricQuery` — the full schema

The tenancy work-stream owns the *file* because `compileSelector` is a security primitive
(`01-tenancy-and-security.md` §7.2). This spec owns the *body*; the diff against `01`'s current
block is itemised in § Interfaces and it is a rewrite, not an extension.

**This is the only definition of `zMetricQuery` in the plan (D16).** `01` §7.2's block becomes a
pointer to this one. `09-ui-surfaces.md` D3 and `07-alerting.md` Q1 quote a shape with
`matchers`, `fill`, `seriesLimit` and an `fn` member called `value`; none of those identifiers
appears anywhere in this document, in any revision. The field is `filters`, its member type is
`zMetricLabelFilter`, its operators are `eq | neq | re | nre`, and the per-definition series cap
is `cfg.maxSeries` on the server, not a persisted `seriesLimit`.

```ts
// packages/validation/src/telemetry.validation.ts
import {
  TELEMETRY_PROJECT_LABEL,
  TELEMETRY_RESERVED_LABEL_PREFIX,
} from '@openpanel/constants';
import { z } from 'zod';

/** Prometheus label-name and metric-name charsets. Anchored. */
const PROM_LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const PROM_METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

const notReserved = (n: string) => !n.startsWith(TELEMETRY_RESERVED_LABEL_PREFIX);

export const zMetricLabelFilter = z
  .object({
    name: z.string().max(200).regex(PROM_LABEL_NAME),
    operator: z.enum(['eq', 'neq', 're', 'nre']),
    value: z.string().max(1024),
  })
  .refine((f) => notReserved(f.name), {
    message: `Label names starting with "${TELEMETRY_RESERVED_LABEL_PREFIX}" are reserved`,
    path: ['name'],
  });

/**
 * Rate/range windows offered to the user. `auto` is the default and resolves against the
 * grid step (section 7).
 *
 * The ladder stops at 24h deliberately: gigapipe expresses an accelerated range frame as an
 * int32 of milliseconds (windowOffset, planner/shared.go:48-55), so anything past ~24.8 days
 * is rejected upstream with "range %s is too large to accelerate". 24h leaves three orders of
 * magnitude of headroom and is far past any window a chart step asks for.
 */
export const zMetricWindow = z.enum([
  'auto', '1m', '5m', '10m', '15m', '30m', '1h', '3h', '6h', '12h', '24h',
]);

export const zMetricFn = z.enum([
  'none',
  'rate',
  'increase',
  'delta',
  'avg_over_time',
  'min_over_time',
  'max_over_time',
  'sum_over_time',
  'count_over_time',
  'last_over_time',
  'histogram_quantile',
]);

export const zMetricAggregation = z.enum(['sum', 'avg', 'min', 'max', 'count']);
export const zMetricType = z.enum(['counter', 'gauge', 'histogram', 'summary']);

/**
 * The plain-object half. z.discriminatedUnion requires object members and P2.5 adds this to
 * zChartEventItem, so the cross-field rules live in refineMetricQuery and are applied by
 * whoever composes the schema.
 */
export const zMetricQueryBase = z.object({
  /** Discriminator. Present in P2 (unused) so P2.5 is a pure union addition. */
  type: z.literal('metric'),

  /** Alpha id (A, B, C...) assigned by normalize() when absent. Formulas reference it. */
  id: z.string().optional(),

  /**
   * The stored Prometheus metric name, verbatim, INCLUDING _total / _sum / _count and unit
   * words. For metricType 'histogram' this is the base name without `_bucket` — D5, the only
   * case the compiler suffixes.
   */
  metric: z.string().max(200).regex(PROM_METRIC_NAME),

  metricType: zMetricType,

  filters: z.array(zMetricLabelFilter).max(32).default([]),

  fn: zMetricFn.default('none'),

  window: zMetricWindow.default('auto'),

  /** Cross-series aggregation. Required whenever groupBy is non-empty. */
  aggregation: zMetricAggregation.optional(),

  /** Becomes the report's breakdowns. Order is preserved into IChartSerie.names. */
  groupBy: z
    .array(z.string().max(200).regex(PROM_LABEL_NAME))
    .max(8)
    .default([])
    .refine((n) => n.every(notReserved), {
      message: `Label names starting with "${TELEMETRY_RESERVED_LABEL_PREFIX}" are reserved`,
    })
    .refine((n) => new Set(n).size === n.length, {
      message: 'groupBy labels must be unique',
    }),

  /** Only for fn === 'histogram_quantile'. */
  quantile: z.number().min(0).max(1).optional(),

  /**
   * Linear multiplier applied to every sample once, at parse (9.1). Exists for unit
   * conversion (bytes to MB) and for 0..1 ratios, whose y-axis is allowDecimals:false
   * (apps/start/src/components/report-chart/common/axis.tsx:39). scale:100 plus unit:'%'.
   */
  scale: z.number().finite().default(1),

  displayName: z.string().max(200).optional(),

  /**
   * Present so format.ts:36-46's hidden-definition pass keeps type-checking against the
   * widened definitions type. A metric series never sets it; a formula over metric series
   * does.
   */
  hideSeries: z.array(z.string()).optional(),
});

/**
 * The legal (metricType, fn) set IS the reducer table (section 4.2). A combination with no
 * entry is rejected here and throws in the compiler; there is no path to an undefined reducer.
 */
export const REDUCER_TABLE = {
  counter:   { rate: 'avg', increase: 'sum', delta: 'sum' },
  gauge:     { none: 'last', avg_over_time: 'avg', min_over_time: 'min',
               max_over_time: 'max', sum_over_time: 'sum', count_over_time: 'sum',
               last_over_time: 'last' },
  histogram: { histogram_quantile: 'avg' },
  summary:   { none: 'last' },
} as const satisfies Record<
  z.infer<typeof zMetricType>,
  Partial<Record<z.infer<typeof zMetricFn>, 'sum' | 'avg' | 'min' | 'max' | 'last'>>
>;

export function refineMetricQuery(
  q: z.infer<typeof zMetricQueryBase>,
  ctx: z.RefinementCtx,
  basePath: (string | number)[] = [],
) {
  const at = (...p: (string | number)[]) => [...basePath, ...p];

  if (!(q.fn in REDUCER_TABLE[q.metricType])) {
    ctx.addIssue({
      code: 'custom',
      path: at('fn'),
      message:
        `"${q.fn}" is not a valid function for a ${q.metricType}. Allowed: ` +
        `${Object.keys(REDUCER_TABLE[q.metricType]).join(', ')}.`,
    });
  }
  if (q.groupBy.length > 0 && !q.aggregation) {
    ctx.addIssue({ code: 'custom', path: at('aggregation'),
      message: 'groupBy requires an aggregation' });
  }
  if (q.fn === 'histogram_quantile' && q.quantile === undefined) {
    ctx.addIssue({ code: 'custom', path: at('quantile'),
      message: 'histogram_quantile requires a quantile' });
  }
  if (q.fn !== 'histogram_quantile' && q.quantile !== undefined) {
    ctx.addIssue({ code: 'custom', path: at('quantile'),
      message: 'quantile is only valid with histogram_quantile' });
  }
  if (q.metricType === 'summary' && !q.filters.some((f) => f.name === 'quantile')) {
    ctx.addIssue({ code: 'custom', path: at('filters'),
      message:
        'A summary stores one series per quantile. Add a `quantile` filter (e.g. "0.95") ' +
        'or the aggregation mixes p50, p90 and p99 into one number.' });
  }
}

export const zMetricQuery = zMetricQueryBase.superRefine((q, ctx) => refineMetricQuery(q, ctx));

export type IMetricQuery = z.infer<typeof zMetricQueryBase>;
export type IMetricFn = z.infer<typeof zMetricFn>;
export type IMetricType = z.infer<typeof zMetricType>;
export type BucketReducer = 'sum' | 'avg' | 'min' | 'max' | 'last';
```

Note the explicit `basePath` parameter on `refineMetricQuery`. The draft used a `withPath(ctx, ['series', i])`
helper, which is not a zod API — a `RefinementCtx` has no path-scoping wrapper — so per-item
issues could not have been re-pathed. P2.5 calls `refineMetricQuery(s, ctx, ['series', i])`.

**On zod version.** The draft's largest self-declared risk — "`superRefine` turns `zReportInput`
into a `ZodEffects`, and `ZodEffects` has neither `.extend()` nor a `ZodObject`-shaped `.and()`"
— is a **Zod 3 fact on a Zod 4 repo**. `pnpm-workspace.yaml:77` pins `zod: ^4.1.8`,
`packages/validation` and `packages/trpc` both consume `zod: catalog:`, and the repo's own idiom
confirms v4: `packages/validation/src/index.ts:392-427` uses `code: 'custom'`, not the v3
`z.ZodIssueCode.custom`. In Zod 4 `ZodEffects` does not exist and `.refine()`/`.superRefine()`
return the original class, so `.extend()` (`validation/index.ts:312`), `.and()`
(`chart.ts:459, 501, 591, 615`) and `.omit().strict()`
(`packages/mcp/src/tools/dashboard-management.ts:15`) all remain available. The risk is not a
compile error; it is the **opposite and worse** shape — object methods carry refinements
differently in v4, so `zReport = zReportInput.extend(...)` and `.omit().strict()` may silently
**drop** refinements rather than fail to build. That is a P2.5 concern and it is a runtime test
(T-P1), not an architectural fork, and it is emphatically not the scope-doubling contingency
the draft's Effort section priced. **UNVERIFIED:** the drop-vs-carry behaviour is from Zod 4's
release notes, not read off disk — `node_modules` is not installed in this checkout.

In P2 none of this bites: `zMetricReportInput.series` is `z.array(zMetricQuery)`
(`04-read-path.md:993`), and `zMetricQuery` is a `superRefine`d schema used only as an array
member, which every zod version supports.

**Defaults, in one table.**

| Field | Default | Why |
|---|---|---|
| `type` | literal | discriminator, unused until P2.5 |
| `id` | assigned by `normalize()` | `engine/normalize.ts:42` assigns `alphabetIds[index]` |
| `metric` | required | no sane default |
| `metricType` | required | D4 |
| `filters` | `[]` | matches `zChartEvent.filters` (`validation/index.ts:106-109`) |
| `fn` | `'none'` | valid only for gauge/summary; the refine catches the rest |
| `window` | `'auto'` | §7 |
| `aggregation` | `undefined` | absent means one series per stored label set |
| `groupBy` | `[]` | |
| `quantile` | `undefined` | only with `histogram_quantile` |
| `scale` | `1` | |
| `displayName` | `undefined` | `format.ts:63-69` falls back to `names[0]` |
| `hideSeries` | `undefined` | mirrors `zChartFormula.hideSeries` (`validation/index.ts:130-135`) |

### 3. Entry point

```ts
// packages/db/src/engine/metrics/execute.ts
import type { FinalChart, IInterval } from '@openpanel/validation';

export interface MetricChartSpec {
  projectId: string;                 // ALWAYS ctx.scopedProjectId, never input.projectId
  series: IMetricQuery[];            // <= 6 (zMetricReportInput, 04-read-path.md:993)
  interval: IInterval;
  /**
   * 'yyyy-MM-dd HH:mm:ss', naive, project-local — already through getChartStartEndDate and
   * getOrganizationSubscriptionChartEndDate.
   */
  startDate: string;
  endDate: string;
  timezone: string;
  previous: boolean;
  limit?: number;
  intent: 'timeseries' | 'aggregate';
}

export async function executeMetricChart(
  spec: MetricChartSpec,
  deps: { signal: AbortSignal },
): Promise<MetricChartResult>;

/** Same pipeline with a one-bucket grid (section 13). */
export async function executeMetricAggregate(
  spec: MetricChartSpec,
  deps: { signal: AbortSignal },
): Promise<MetricChartResult>;
```

Sequence, in order, for `executeMetricChart`:

```
 1. assert spec.series.length <= cfg.maxMetricSeriesPerReport   (6; 12.5)
 2. grid           = resolveGrid(spec)                          (6)
 3. per definition: compiled = compileMetricQuery(q, { projectId, stepSec, ... })  (4)
 4. withProjectLease(projectId, async () => {                   (04-read-path.md:1416)
 5.   phase A  resolveSeriesSet(compiled, grid)  — parallel, limit 4, one per definition (8.1)
 6.   phase B  queryRange pinned                 — parallel, limit 4                    (8.2)
 7.   previous  queryRange pinned + shifted grid — parallel, limit 4                    (11)
    })
 8. verifyResponseLabels(result, projectId)  — a STATEMENT, before any stripping (9.0)
 9. shapeMatrixToConcreteSeries(...) per definition             (9)
10. compute(current, definitions)   — formulas, reused verbatim (engine/compute.ts:11)
11. format(computed, definitions, definitions.length > 1, previous, spec.limit)
12. return { ...chart, notices }
```

Steps 5-7 share one `AbortSignal` and one lease. `normalize()`, `plan()` and `fetch()` from the
event engine are **not** reused: `normalize()` is `IReportInput`-shaped and the read-path
resolver already does its two useful jobs (`getChartStartEndDate`,
`getOrganizationSubscriptionChartEndDate`, `04-read-path.md:1014-1027`); `plan()` and `fetch()`
are ClickHouse-specific (`engine/plan.ts:19`, `engine/fetch.ts:59`). `compute()` and `format()`
**are** reused, unchanged apart from D3's two type widenings.

### 4. Compilation

```ts
// packages/db/src/engine/metrics/compile.ts
import { compileAggregation, compileSelector } from '@openpanel/gigapipe';

export interface CompiledMetricQuery {
  /** The full PromQL expression. The tenancy matcher is always the first matcher. */
  promql: string;
  /** Resolved range-vector window in seconds. 0 when the fn takes no window. */
  windowSec: number;
  /**
   * Label keys that carry series identity, in groupBy order. Empty when the response's own
   * residual labels are the identity (no aggregation, no groupBy) — see 9.2.
   */
  identityLabels: string[];
  /** Stripped before naming: __name__, op_project_id, and `le` for histogram_quantile. */
  dropLabels: string[];
  reducer: BucketReducer;
  notices: MetricNotice[];
}

export function compileMetricQuery(
  q: IMetricQuery,
  opts: {
    projectId: string;
    /** Resolved PromQL step in seconds, from resolveGrid(). */
    stepSec: number;
    /** When present, pin to exactly these label sets (8.2). */
    pinnedSeries?: Array<Record<string, string>>;
  },
): CompiledMetricQuery;
```

`compileMetricQuery` **never** builds a selector string itself. It calls
`compileSelector(qWithSuffix, projectId, pinMatchers)` and `compileAggregation(qWithLe, ranged)`
because those two are the only functions allowed to emit PromQL and the only place
`op_project_id` is guaranteed to be prepended. This layer contributes the range-vector window,
the function call, the `le` injection and the pin matchers.

#### 4.1 Emission order

```
1. inner   := compileSelector(qWithSuffix, projectId, pinMatchers)
                                                  -> M{op_project_id="...",...,pins}
2. ranged  := fn === 'none' ? inner : `${fn}(${inner}[${W}s])`
3. aggd    := compileAggregation(qWithLe, ranged) -> sum by (..., le, op_project_id) (...)
4. final   := fn === 'histogram_quantile'
                ? `histogram_quantile(${p}, ${aggd})`
                : aggd
```

There is **no step 5**. `topk` never appears (D8).

Step 3 wraps step 2 — the aggregation is **outside** the range function. That is the only
correct order for `sum(rate(...))` and the only order gigapipe accelerates:
`Aggregate.Applicable` requires the aggregate's child to be a `*prom_parser.VectorSelector`
(`optimizer/vector_agg.go:33-43`), and `VectorRange` has already substituted the `rate(...)`
call with a synthetic selector by the time the post-order walk reaches the parent
(`promql_transpiler/transpiler_v2.go`). `rate(sum(...))` would be both semantically wrong and
un-accelerated.

#### 4.2 The complete (metricType, fn) table

`W` is the resolved window (§7), `M` the metric name after suffixing, `A` the user's
`aggregation`, `G` the `groupBy`. Every emitted aggregation carries `op_project_id` in
`by (...)`, added by `compileAggregation`; elided below. **This table is `REDUCER_TABLE` (§2),
literally** — the schema and the compiler read the same object, and `compileMetricQuery` throws
`MetricCompileError` on a missing entry rather than returning an undefined reducer.

| metricType | fn | Emitted | Reducer | Note |
|---|---|---|---|---|
| counter | `rate` | `A by (G) (rate(M[W]))` | `avg` | the default counter read |
| counter | `increase` | `A by (G) (increase(M[W]))` | `sum` | `W` is pinned to the step (§7.3) |
| counter | `delta` | `A by (G) (delta(M[W]))` | `sum` | reset-unaware by design (`planner/counter.go`) |
| gauge | `none` | `A by (G) (M)` | `last` | with no `A`, one series per stored label set |
| gauge | `avg_over_time` | `A by (G) (avg_over_time(M[W]))` | `avg` | |
| gauge | `min_over_time` / `max_over_time` | `A by (G) (fn(M[W]))` | `min` / `max` | |
| gauge | `sum_over_time` / `count_over_time` | `A by (G) (fn(M[W]))` | `sum` | |
| gauge | `last_over_time` | `A by (G) (last_over_time(M[W]))` | `last` | |
| histogram | `histogram_quantile` | `histogram_quantile(p, sum by (G, le) (rate(M_bucket[W])))` | `avg` | `A` is **forced** to `sum` and `le` force-added to `by`; the user's `aggregation` is ignored |
| summary | `none` | `A by (G) (M{quantile="..."})` | `last` | the `quantile` filter is mandatory (§2 refine) |

Everything else is rejected at parse. `_sum` and `_count` of a histogram or summary are
addressed as `metricType: 'counter'` by their real stored names (D5).

When `A` is absent, step 3 is a no-op — `compileAggregation` returns `inner` when
`q.aggregation` is falsy (`01-tenancy-and-security.md:1119`) — and every stored label set
becomes its own series.

#### 4.3 Suffixing and re-validation

```ts
function resolveMetricName(q: IMetricQuery): string {
  const out = q.fn === 'histogram_quantile' ? `${q.metric}_bucket` : q.metric;
  // Re-validate: a future edit here cannot open a hole in compileSelector's assumptions.
  if (!PROM_METRIC_NAME.test(out)) throw new MetricCompileError(`bad metric name: ${out}`);
  return out;
}
```

`compileSelector` receives a shallow clone with `metric: resolveMetricName(q)`;
`compileAggregation` receives a shallow clone with `groupBy: [...q.groupBy, 'le']` for
`histogram_quantile` only. The reserved-prefix refine does not reject `le`.

#### 4.4 What the compiler refuses, and why refusal beats silence

- **`rate`/`increase`/`delta` on a gauge.** `CounterPlanner` adds back the pre-reset value at
  every decrease (`reader/promql/promql_transpiler/planner/counter.go`); on a gauge every
  downward movement reads as a counter reset and inflates the result. The user sees a plausible
  line that is arithmetic nonsense.
- **A counter with `fn: 'none'`.** A monotonically rising sawtooth that resets on every process
  restart.
- **A summary with no `quantile` filter.** The stored family carries one series per quantile;
  aggregating across them averages p50, p90 and p99 into a number with no meaning.
- **`groupBy` without `aggregation`.** PromQL has no such form; it would be silently dropped.

### 5. Configuration this engine reads

| Key | Default | Owner | Note |
|---|---|---|---|
| `cfg.maxPoints` | **3000** | read-path `GigapipeConfig` | **not on `GigapipeConfig` today** — verified, the interface carries `requestTimeoutMs`, `maxConcurrencyPerProject`, `fanoutConcurrency`, `maxResponseBytes`, `retentionDays` and nothing else. `04`'s budget is a module constant `TARGET_MAX_POINTS = 1_500` in `units.ts`. D19 settles the number at 3000 and this must become a real config field |
| `cfg.maxSeries` | **20** | read-path | series kept per definition after ranking. `04` §8.2 says "default 50, hard max 200" for its `topk` cap; that sentence goes with the `topk` wrap (D8) and the default is 20 here. Also **not** a `GigapipeConfig` field today |
| `cfg.maxRankSeries` | 1000 | **new, this spec** | ranking-response cardinality guard (§8.1) |
| `cfg.maxMetricSeriesPerReport` | 6 | matches `zObservabilityChartInput.series.min(1).max(6)` (`04-read-path.md` §6.2) | re-asserted in the engine |
| `cfg.fanoutConcurrency` | 4 | read-path (`GIGAPIPE_FANOUT_CONCURRENCY`) | **reused, not duplicated** (R2). R1 asked for a second key `fanoutConcurrency`; `04` D8 already ships this one at the same default and for the same purpose. One limiter |
| `cfg.metricDeadlineMs` | 25 000 | **new, this spec** | per-*report* deadline, strictly below gigapipe's fixed 30 s engine timeout (`prometheus_query_range.go:32`). Distinct from `requestTimeoutMs`, which is a per-*socket* timeout and sits above it |
| `ADVANCED_PROMETHEUS_MAX_SAMPLES` | `50000000`, **pending `10-ops-retention-billing.md` Q6** | ops/deployment | gigapipe's `MetricsMaxSamples`, read only from this env var (`cmd/gigapipe/main.go:201-206`) and **global across every tenant** (`reader/router/prometheus_query_range.go:31, 49`). `10` §3 pins 50 M and then says, correctly, that 50 M is *also* Prometheus's own upstream default for `--query.max-samples`, so the pin may be a no-op. **Stated plainly, in all three documents that carry it:** until Q6 is answered this pin is documentation of intent, and the only enforced bound on a runaway metric query is gigapipe's fixed, non-configurable 30 s engine timeout — with `cfg.metricDeadlineMs` (25 s) as the bound OpenPanel actually controls. Q6 is one `curl /config` against a booted container; do it in P0 and pick a value deliberately *below* the discovered default |

### 6. The time grid

```ts
// packages/db/src/engine/metrics/grid.ts
export interface ResolvedGrid {
  /** PromQL step, seconds. Always a member of STEP_LADDER_SEC. */
  stepSec: number;
  /** The interval actually used — may be coarser than requested (6.1). */
  interval: IInterval;
  /** UTC epoch seconds, a multiple of stepSec (D7). */
  fromSec: number;
  /** UTC epoch seconds >= endDate, aligned up to a multiple of stepSec. */
  toSec: number;
  /** Ordered, dense, project-local calendar bucket starts, 'yyyy-MM-dd HH:mm:ss'. */
  buckets: string[];
  /** Ascending millisecond boundaries, length buckets.length + 1. */
  bucketEdgesMs: number[];
  notices: MetricNotice[];
}

export function resolveGrid(input: {
  interval: IInterval;
  startDate: string;   // 'yyyy-MM-dd HH:mm:ss', naive, project-local
  endDate: string;
  timezone: string;
  maxPoints: number;
}): ResolvedGrid;
```

#### 6.1 Step and interval resolution

```ts
/** Read-path's ladder. Every value divides 60, 3600 and 86400. */
const STEP_LADDER_SEC = [15, 30, 60, 300, 900, 1800, 3600, 21600, 86400] as const;

/** The coarsest sub-bucket that still resolves the interval's calendar bucket. */
const MAX_SUB_BUCKET: Record<IInterval, number> = {
  minute: 60,
  hour: 3600,
  day: 3600,     // sub-hour so a DST-shifted 23h/25h day folds from whole sub-buckets
  week: 86400,
  month: 86400,
};

const COARSER: Record<IInterval, IInterval | null> = {
  minute: 'hour', hour: 'day', day: 'week', week: 'month', month: null,
};

export function resolveStep(interval: IInterval, spanSec: number, maxPoints: number) {
  let it = interval;
  for (;;) {
    const step = MAX_SUB_BUCKET[it];            // always a ladder member
    if (Math.ceil(spanSec / step) <= maxPoints) return { interval: it, stepSec: step };
    const next = COARSER[it];
    if (!next) {
      throw new GigapipeQueryTooLargeError(
        'That date range is too long to chart. Narrow it to under eight years.',
        { route: 'promQueryRange', retryable: false },
      );
    }
    it = next;
  }
}
```

If `it !== interval` the grid attaches `interval_coarsened` naming both intervals. This is the
D7 decision: a metric report never returns an exception where an event report returns a chart.

#### 6.2 Alignment and calendar folding

```ts
export function alignWindow(fromSec: number, toSec: number, stepSec: number) {
  return {
    fromSec: Math.floor(fromSec / stepSec) * stepSec,
    toSec: Math.ceil(toSec / stepSec) * stepSec,
  };
}

const LUXON_UNIT: Record<IInterval, 'minute' | 'hour' | 'day' | 'week' | 'month'> = {
  minute: 'minute', hour: 'hour', day: 'day', week: 'week', month: 'month',
};

export function bucketOf(ms: number, interval: IInterval, tz: string): string {
  return DateTime.fromMillis(ms, { zone: tz })
    .startOf(LUXON_UNIT[interval])
    .toFormat('yyyy-MM-dd HH:mm:ss');
}
```

`startDate`/`endDate` convert with
`DateTime.fromFormat(s, 'yyyy-MM-dd HH:mm:ss', { zone: timezone }).toSeconds()`. `resolveGrid`
asserts `fromSec % stepSec === 0` and throws if not — a silent blank chart is the failure this
guards. gigapipe additionally floors `start` and ceils `end` to 15 s
(`reader/controller/prom_query_range.go:55-56`); every ladder value is a multiple of 15, so our
alignment survives untouched. The shaper trims back to `[startDate, endDate]` afterwards.

Three properties the bucket string must have, all verifiable:

1. **`'yyyy-MM-dd HH:mm:ss'`, naive, project-local.** It is consumed four ways: exact string
   equality (`use-rechart-data-model.ts:31`), `new Date(date).getTime()` for the x-axis (`:25`,
   with `dataKey: 'timestamp'`), `new Date(a.date).getTime()` for sorting inside
   `groupByLabels` (`packages/common/src/group-by-labels.ts`), and **lexicographic**
   `dates.sort()` in the MCP shaper (`packages/mcp/src/tools/analytics/reports.ts:82`), which
   works only because the format is zero-padded and big-endian. Emitting ISO-with-`Z` passes the
   equality checks and displaces every point by the viewer's UTC offset.
2. **Monday weeks.** Luxon `startOf('week')` is ISO/Monday; the event engine uses
   `toStartOfWeek(created_at, 1, tz)`, mode 1 = Monday. A metric report and an event report on
   one dashboard line up.
3. **Dense and identical across series.** `resolveGrid` computes the full bucket list up front
   by stepping `startOf(unit).plus({ [unit]: 1 })`; every `ConcreteSeries` is emitted on exactly
   that array. `use-rechart-data-model.ts:22` builds the x-axis from `series[0]` only, and after
   `format.ts:153` `series[0]` is the largest-sum series, not the widest.

#### 6.3 Why `maxPoints` rises to 3000

At `maxPoints = 1500` the `day` ceiling of 3600 caps a daily chart at 62.5 days, so
`range: '3m', interval: 'day'` — an ordinary chart — would coarsen to weekly. 3000 covers 3m/day
(2208) and 90d/hour (2160) exactly, keeps every 12m chart at week or month, and stays far below
gigapipe's hard 11 000-point ceiling (`prom_query_range.go:65-70`, returned as a **500** with
the pinned string read-path already classifies). Worst case per query is 3000 points times 20
series = 60 000 samples. Q3 in § Open questions is the measurement that confirms or lowers it.

#### 6.4 Worked grid table

Derived from `resolveStep` above at `maxPoints = 3000`. Every row in the draft's version of this
table was wrong, because it was derived from prose rather than from the code it cited.

| Range | Interval asked | span (s) | step | points | Interval used | Buckets |
|---|---|---|---|---|---|---|
| `lastHour` | minute | 3 600 | 60 | 60 | minute | 60, 1:1 |
| `7d` | hour | 604 800 | 3600 | 168 | hour | 168, 1:1 |
| `30d` | day | 2 592 000 | 3600 | 720 | day | 30; the DST days fold 23 and 25 sub-buckets |
| `3m` | day | ~7 949 000 | 3600 | 2208 | day | ~92 |
| `90d` (custom) | hour | 7 776 000 | 3600 | 2160 | hour | 2160, 1:1 |
| `12m` | day | ~31 536 000 | 3600 gives 8760 > 3000, coarsen | 86400 | 365 | week | 53, plus `interval_coarsened` |
| `12m` | month | ~31 536 000 | 86400 | 365 | month | 12, each folding 28-31 sub-buckets |
| `30d` | minute | 2 592 000 | 60 gives 43 200 > 3000, coarsen | 3600 | 720 | hour | 720, plus `interval_coarsened` |

**Cut from the draft: `offsetGranularitySec` and `bucket_boundary_approximate`.** The draft
lowered the `day`/`week`/`month` ceiling in half-hour and 45-minute zones (`Asia/Kolkata`,
`Asia/Kathmandu`), which required turning another work-stream's `MAX_SUB_BUCKET` constant into a
function of `(interval, timezone)`, a luxon offset helper, a fallback path, a notice code, a
tzdb research question and two tests — to fix at most one sub-bucket of N attributed to the
wrong side of a local midnight, in a mechanism that fell back to the notice anyway in most of
its own worked examples. Cut. `day` already uses a 3600 ceiling, which is a whole divisor of
every half-hour offset; `week` and `month` at 86400 misattribute at most one 24 h sub-bucket at
each end of a 7- or 28-to-31-bucket window in a non-whole-hour zone. `offsetGranularitySec` is
recorded as a named follow-up (Q7), not a v1 item, and `MAX_SUB_BUCKET` stays a constant map,
which removes one item from what read-path owes this work-stream.

### 7. Rate-window derivation

```ts
// packages/db/src/engine/metrics/window.ts
const WINDOW_LADDER_SEC = [60, 300, 600, 900, 1800, 3600, 10800, 21600, 43200, 86400];
const FN_TAKES_WINDOW = new Set<IMetricFn>([
  'rate', 'increase', 'delta', 'avg_over_time', 'min_over_time', 'max_over_time',
  'sum_over_time', 'count_over_time', 'last_over_time', 'histogram_quantile',
]);

export function resolveRateWindow(q: IMetricQuery, stepSec: number):
  { windowSec: number; notice: MetricNotice | null } {

  if (!FN_TAKES_WINDOW.has(q.fn)) return { windowSec: 0, notice: null };

  // 7.3: increase double-counts across overlapping windows, so it is pinned to the step.
  if (q.fn === 'increase') {
    return {
      windowSec: stepSec,
      notice: q.window === 'auto' ? null
        : notice('increase_window_pinned', { asked: q.window, usedSec: stepSec }),
    };
  }

  if (q.window === 'auto') {
    return { windowSec: snapUp(Math.max(4 * stepSec, 60)), notice: null };
  }

  const asked = WINDOW_SEC[q.window];
  if (asked >= stepSec) return { windowSec: asked, notice: null };

  return {
    windowSec: snapUp(stepSec),
    notice: notice('rate_window_widened', { asked: q.window, usedSec: snapUp(stepSec) }),
  };
}

const snapUp = (sec: number) =>
  WINDOW_LADDER_SEC.find((w) => w >= sec) ?? WINDOW_LADDER_SEC.at(-1)!;
```

#### 7.1 Why `4 * step`

`rate` needs at least two samples inside the frame. gigapipe's `CounterPlanner` reads the last
value per bucket and computes the change between the first and last **real** sample in the
frame, dividing by the actual time between them. With `window == step` and a scrape interval
equal to the step, a frame frequently holds exactly one sample and the point is dropped.
`4 * step` makes that a non-event at the cost of a four-step smoothing lag — the standard
Prometheus tradeoff. The 60 s floor is because `metrics_15s` is the finest real grain.

#### 7.2 A chart never renders a window shorter than its own step

That is the whole content of the `asked >= stepSec` branch. `rate(x[1m])` sampled hourly reports
the slope of 1/60th of each hour and labels it the hour: a chart that looks like real data and
is wrong by whatever happened in the other 59 minutes.

The asymmetry is deliberate — a window *wider* than the step is ordinary overlapping smoothing
and is left alone. The only ceiling is `24h`, for the `windowOffset` int32 reason in §2.

**Rejected:** clamping the *step* down to the window. That is how a "just make the numbers
agree" fix blows the point budget on a 30-day chart.

#### 7.3 The `increase` honesty problem

`increase(x[W])` summed across `n` sub-buckets counts each sample up to `W/step` times when
`W > step`. So for `increase` — and only for it — the window is pinned to the step exactly,
ignoring `auto` and any user window, with `increase_window_pinned` when the user asked for
something else.

**Rejected:** dividing the reducer's sum by `W/step`. Arithmetically equivalent only when the
series is perfectly dense, and quietly wrong at every gap.
**Rejected:** reducing `increase` with `last`. Throws away `n-1` of `n` sub-buckets and is wrong
whenever the final one has the gap.

### 8. Series selection (D8) and pinning (D9)

#### 8.1 Phase A — `resolveSeriesSet`

```ts
// packages/db/src/engine/metrics/rank.ts
const RANK_POINTS = 24;

export interface ResolvedSeriesSet {
  /** Identity label sets to pin, ranked, at most cfg.maxSeries. */
  pins: Array<Record<string, string>>;
  /** Distinct label sets the ranking pass saw. Exact — this is what series_capped reports. */
  seen: number;
  /** True when phase B may reuse this response instead of issuing a second query. */
  reusable: boolean;
  matrix: PromMatrixSeries[];
  notices: MetricNotice[];
}

export async function resolveSeriesSet(
  compiled: CompiledMetricQuery,
  grid: ResolvedGrid,
  opts: { projectId: string; maxSeries: number; maxRankSeries: number; signal: AbortSignal },
): Promise<ResolvedSeriesSet>;
```

Rules:

- **Skipped entirely** when `compiled.identityLabels.length === 0 && q.aggregation` — a fully
  aggregated query returns exactly one series, so there is nothing to rank. `pins` is empty and
  phase B runs unpinned.
- **Merged with phase B** when `ceil(span / grid.stepSec) <= RANK_POINTS` — the chart grid is
  already coarse enough to rank on. One query, capped in the shaper, `reusable: true`.
- Otherwise: one `query_range` with `compiled.promql` (which contains no `topk` and no pins) at
  `rankStepSec` = the coarsest ladder value with `ceil(span/s) <= RANK_POINTS`, floored at
  `grid.stepSec`.
- **Rank** by the sum of absolute sample values over the coarse grid, descending, tie-broken by
  the identity string ascending. That is a valid comparator for every reducer because all series
  share one coarse grid length, and the absolute value keeps negative gauges from sorting to the
  bottom.
- If `seen > maxSeries`: keep the top `maxSeries` and attach `series_capped { seen, kept }`.
  **This count is exact**, which is what the draft's `topk` formulation could not give — the
  draft's open question about a `series_capped` threshold is closed by construction.
- If `seen > maxRankSeries` (1000): throw `GigapipeQueryTooLargeError` with
  "That breakdown produces N series. Add a filter, or group by fewer labels." A ranking response
  of 1000 series times 24 points is about 24 000 samples — the guard fires before anything large
  is materialised.

Cost: one extra range query per grouped definition, at most 24 points per series, on the same
accelerated shape as the chart. It runs **inside the same lease** as phase B and counts against
`fanoutConcurrency`.

#### 8.2 Pinning

```ts
// packages/db/src/engine/metrics/pin.ts
const RE_META = /[.*+?^${}()|[\]\\]/g;
const reEscape = (s: string) => s.replace(RE_META, '\\$&');

export type PromMatcher = { name: string; op: '=' | '!=' | '=~' | '!~'; value: string };

/**
 * A set of label sets is a DISJUNCTION; matchers inside one selector are conjoined. So pin
 * one matcher per identity label, alternating over that label's observed values. For more
 * than one identity label this is the CROSS-PRODUCT and is over-inclusive, which is why
 * matchesPin() must run in the shaper.
 *
 * An identity label absent from a pinned set contributes the empty alternative, which in
 * PromQL matches a series that does not carry the label at all.
 */
export function pinMatchers(
  pins: Array<Record<string, string>>,
  identityLabels: string[],
): PromMatcher[] {
  return identityLabels.map((k) => {
    const vals = [...new Set(pins.map((p) => p[k] ?? ''))];
    return vals.length === 1
      ? { name: k, op: '=' as const, value: vals[0]! }
      : { name: k, op: '=~' as const, value: `^(?:${vals.map(reEscape).join('|')})$` };
  });
}

/** Exact membership, applied to every returned series before it becomes a ConcreteSeries. */
export function matchesPin(
  labels: Record<string, string>,
  pins: Array<Record<string, string>>,
  identityLabels: string[],
): boolean {
  return pins.some((p) => identityLabels.every((k) => (labels[k] ?? '') === (p[k] ?? '')));
}
```

Every matcher value goes through the tenancy compiler's `quote()`
(`01-tenancy-and-security.md:1084-1090`) when the selector is built, because these values came
from ingested telemetry and never passed `zMetricLabelFilter`. Two bounds:

- `pins.length <= cfg.maxSeries` (20) and `identityLabels.length <= 8` by schema.
- Total pin-matcher bytes at most 64 KB. Past that, phase B runs **unpinned** and `matchesPin`
  does all the work; the query is not truncated and the cap is not lost. URL length is a
  non-issue because read-path's transport POSTs (`04-read-path.md:986`), which gigapipe accepts
  only with `Content-Type: application/x-www-form-urlencoded`
  (`reader/controller/prom_query_range.go:122-131`) — anything else silently falls through to
  the query string.

**Rejected:** `n` separate range queries, one per pinned label set. Correct, but 20 pins times 6
definitions times 2 windows = 240 calls per report.
**Rejected:** `expr{pin1} or expr{pin2} or ...`. Expressible and exact, but the query string is
`n` copies of the whole expression, and a `BinaryExpr` root is not a shape the optimizer's
`Applicable` checks were written against — it would need its own integration test before it
could be trusted.

#### 8.3 What this means for the read-path guard

`04-read-path.md:1397-1399` ("more than `maxSeries` series means the `topk` wrap was omitted;
raise `GigapipeUpstreamError`") must be **deleted**. Under this design phase B can legitimately
return more than `maxSeries` series — the cross-product case — and the shaper drops the extras.
The invariant that survives is stated in the shaper instead: after `matchesPin` and the cap,
`series.length <= maxSeries` for every definition.

### 9. Matrix to `ConcreteSeries`

```ts
// packages/db/src/engine/metrics/shape.ts
export interface PromMatrixSeries {
  metric: Record<string, string>;
  values: Array<[number, string]>;   // [float seconds, formatted float string]
}

type ShapeInput = {
  matrix: PromMatrixSeries[];
  compiled: CompiledMetricQuery;
  query: IMetricQuery;
  definitionIndex: number;
};

/**
 * The seam 04-read-path.md:894-907 declares, with a corrected input shape. Internally it is
 * shapeMatrixToConcreteSeries per definition, then compute(), then format().
 */
export function shapeMatrixToFinalChart(input: {
  current: ShapeInput[];
  previous: ShapeInput[] | null;
  definitions: IMetricQuery[];
  grid: ResolvedGrid;
  previousGrid: ResolvedGrid | null;
  pins: Array<Array<Record<string, string>> | null>;
  timezone: string;
  limit?: number;
  maxSeries: number;
}): MetricChartResult;

export function shapeMatrixToConcreteSeries(input: ShapeInput & {
  grid: ResolvedGrid;
  pins: Array<Record<string, string>> | null;
  maxSeries: number;
}): { series: ConcreteSeries[]; notices: MetricNotice[] };
```

The draft renamed this seam to `shapeMatrixToConcreteSeries` and dropped `previous` and `limit`,
which would have broken read-path's §6.1 resolver. `shapeMatrixToFinalChart` stays the exported
name and keeps returning a `FinalChart` (structurally); `shapeMatrixToConcreteSeries` is the
internal step behind it, exported only so it is separately testable.

#### 9.0 Verification is a statement, not an expression

```ts
verifyResponseLabels(response.data.result, projectId);   // throws TenancyError; returns void
const shaped = shapeMatrixToConcreteSeries({ matrix: response.data.result, ... });
```

`verifyResponseLabels` is declared `): void` (`01-tenancy-and-security.md:1423-1435`). The draft
wrote `matrix: verifyResponseLabels(r, projectId)`, which does not type-check — and the obvious
repair during implementation ("it returns nothing, delete it") would silently remove the tenancy
check this plan calls a security boundary. It runs on the **raw** response, before any label
stripping, because stripping first removes the thing being verified. T-S7 asserts the shaper is
never reached when verification throws.

#### 9.1 Per-sample parse

```ts
function parseSample(v: [number, string], scale: number) {
  const n = Number(v[1]);
  if (!Number.isFinite(n)) return null;        // "NaN" | "+Inf" | "-Inf"   (D11)
  return { ms: Math.round(v[0] * 1000), value: n * scale };
}
```

`Math.round`, not `Math.trunc`: timestamps are whole seconds in every path we generate (the step
is a multiple of 15 and `start` is aligned), but a future sub-15 s step would produce `.5` and
truncation would move a point into the previous bucket at a boundary. `scale` is applied here
and **only** here — T-S6 asserts it is not applied again per bucket.

Timestamps are float seconds written with `stream.WriteFloat64`
(`reader/controller/prom_query_range.go:278`) — the full-precision jsoniter path, not the
6-digit lossy encoder extension — so multiplying by 1000 is safe.

#### 9.2 Identity

```ts
// packages/db/src/engine/metrics/identity.ts
const ALWAYS_DROP = new Set(['__name__', TELEMETRY_PROJECT_LABEL]);
```

Order of operations, and all four steps matter:

1. **Verify** (§9.0), on the raw label set.
2. **Drop** `ALWAYS_DROP` plus `compiled.dropLabels` (which holds `le` for `histogram_quantile`
   — the function removes it itself, but the defensive drop covers a user who grouped by `le`).
3. **Order deterministically.** `names[1+]` follows `q.groupBy` order, exactly as the event
   engine's `name[1+]` follows `breakdowns` order (`engine/fetch.ts:99-105`). Residual labels —
   present on the series but not in `groupBy`, reachable only when `aggregation` is absent — are
   appended sorted by key ascending. gigapipe emits `metric` keys in **Go map iteration order**
   (`s.Metric.Map()`, `prom_query_range.go:259`), i.e. reshuffled per response, so nothing may
   depend on key order.
4. Empty or missing values render as `EMPTY_BREAKDOWN_LABEL` (`'Not set'`,
   `packages/db/src/services/funnel.service.ts:29`), matching the event engine.

`compiled.identityLabels` is `q.groupBy` when non-empty. When it is empty **and** `aggregation`
is absent, identity is per-series: the sorted residual key set of that series. `pinMatchers` then
pins on the union of those keys across the ranked sets, capped at 8; past 8 the pin is skipped
and `matchesPin` alone enforces the set. This is the case the draft's
`pinnedSeries = current.map(cs => cs.context.breakdowns ?? {})` collapsed into a list of empty
objects, pinning nothing.

```
names[0]  = q.displayName ?? q.metric
names[1+] = identityLabels.map(k => labels[k] || EMPTY_BREAKDOWN_LABEL)
```

`format()` prefixes `(A) ` to `names[0]` when the report has more than one definition
(`format.ts:58-75`), unchanged. `SerieName` uses each name part as a React key
(`apps/start/src/components/report-chart/common/serie-name.tsx:25-27`); the `groupBy` uniqueness
refine makes duplicate parts impossible for the label positions.

#### 9.3 The series id

`format.ts:101` does `id: slug(cs.id)`, and `slug()` is
`slugify(..., { lower: true, strict: true })` (`packages/common/src/slug.ts`), which is
**lossy**: `/api/v1` and `api-v1` slug to the same string. That id is a recharts `dataKey`, a
React key, the `useVisibleSeries` identity (`apps/start/src/hooks/use-visible-series.ts:22, 27`)
and the persisted `Report.visibleSeries` array (`schema.prisma:446`). A collision merges two
lines and corrupts a saved selection.

```ts
const parts = identityLabels.map((k) => labels[k] ?? '');
const raw = [q.metric, ...parts].join(' ');
const id = `${definitionIndex}-${q.metric}-${parts.join('-')}-${fnv1a32(raw).toString(36)}`;
```

Three corrections to the draft, each a real defect:

- **The id does not use `displayName`.** The draft built it from `names`, whose `[0]` is
  `q.displayName ?? q.metric`, so renaming a series changed every id and silently invalidated
  the persisted `visibleSeries`. T-S5 asserts that changing `displayName` leaves every id
  byte-identical.
- **`raw` joins with a space**, not the empty string, so it is injective across the
  metric/label boundary. A space cannot appear in a Prometheus metric name.
- Base36 output is lowercase alphanumeric, so it survives `slug()` unchanged.

`fnv1a32` is a dozen lines and needs no dependency. **Settled from disk:** `packages/common/src`
holds `date, get-previous-metric, group-by-labels, id, math, names, object, slug, string,
timezones, try-catch, url` — there is no non-crypto string hash to reuse. (The draft left this
open; it is closed.)

#### 9.4 Bucket assignment and reducers

Samples arrive ascending per series (`writeMatrix` iterates `s.Floats` in order,
`prom_query_range.go:273`) and `grid.bucketEdgesMs` is ascending, so assignment is a merge walk
— O(points + buckets), no `Array.find` per point. 20 series times 3000 points is 60 000 samples
per definition and eight dashboard widgets refresh together.

```ts
export function reduceBucket(r: BucketReducer, xs: number[]): number | undefined {
  if (xs.length === 0) return undefined;          // caller fills 0 and counts a gap
  switch (r) {
    case 'sum':  return xs.reduce((a, b) => a + b, 0);
    case 'avg':  return xs.reduce((a, b) => a + b, 0) / xs.length;
    // Iterative, NOT Math.min(...xs): xs.length is bounded by maxPoints (3000), which is a
    // config value, not a constant. The draft asserted "xs.length <= 96 by construction",
    // which was false the moment week or month folded 336 or ~2976 sub-buckets.
    case 'min':  return xs.reduce((a, b) => (b < a ? b : a), xs[0]!);
    case 'max':  return xs.reduce((a, b) => (b > a ? b : a), xs[0]!);
    case 'last': return xs[xs.length - 1]!;
  }
}
```

The reducer comes from `compiled.reducer` (§4.2), never chosen here — it is a property of the
query, not of the data. The `avg` reducer is a **plain** mean of sub-buckets, not time-weighted;
that is exact because every sub-bucket is the same width by construction, and `alignWindow` plus
the shaper's trim remove the partial sub-buckets at each end.

#### 9.5 Rounding, and what `metrics.sum` does to it

`data[].count` gets `Number(v.toPrecision(12))` once at bucket-reduce time, purely to strip
float-accumulation noise like `0.30000000000000004`. Nothing else rounds it: the event engine's
`count` comes from ClickHouse unrounded and `compute()` rounds only formula outputs
(`compute.ts:160`).

But `metrics.sum` **is** rounded — `sum()` is `round(...)` with the default 2 decimals
(`packages/common/src/math.ts:20-21`), not just `metrics.average` (`format.ts:80` is the sum,
`:81` the average; the draft cited the wrong line and drew the wrong conclusion). So a CPU
fraction of `0.00123` survives in `data[].count` and renders correctly in the tooltip, while
`metrics.sum` for that series is `0`. D12's stable-sort ordering is what makes that harmless
rather than nondeterministic. The user-facing fix is the y-axis conditional plus `scale` and
`unit`, and the picker should default `scale: 100, unit: '%'` for a metric whose sampled values
are all in `[0, 1]` (§ Interfaces, UI item 4).

#### 9.6 Emitting `ConcreteSeries`

```ts
const concrete: ConcreteSeries = {
  id,                                   // 9.3; format() will slug() it
  definitionId: q.id ?? alphabetIds[definitionIndex] ?? `series-${definitionIndex}`,
  definitionIndex,
  name: names,
  context: { event: q.metric, filters: [], breakdownValue, breakdowns },
  data: grid.buckets.map((date, i) => ({
    date,
    count: reduced[i] ?? 0,             // D10
    total_count: undefined,             // 10.3
  })),
  definition: q,
};
```

`definitionId` uses exactly the fallback chain at `engine/fetch.ts:126`, so `compute()`'s
`seriesByIndex` lookups (`compute.ts:56-62`) behave identically for metric and event series.

`context.filters` is deliberately **empty**. It is typed `IChartEventFilter[]` and exists to
answer "who are these users?"; a metric label is not an event property and cannot be translated
into one. Populating it with lookalike filters would produce a "View Users" modal that runs a
real event query with nonsense predicates and returns an empty audience — the worst of both
worlds. The drill-down is suppressed at the UI layer instead.

`breakdowns` is set only when `identityLabels` is non-empty.

Finally the shaper sorts by unrounded magnitude descending, tie-broken by `id` ascending (D12),
applies `matchesPin` and the `maxSeries` cap, and asserts every emitted series has
`data.length === grid.buckets.length`.

### 10. The `Metrics` object

`format()` computes it (`format.ts:78-85`); this section says what those five numbers *mean* for
a metric series, because three are traps.

| Field | Computed by | Meaning for a metric series |
|---|---|---|
| `sum` | `sum(counts)` — `math.ts:20-21`, **rounded to 2 dp** | correct for `sum`-reduced series (`increase`, `sum_over_time`, `count_over_time`); **dimensionally meaningless** for `avg`/`last` series — a sum of rates |
| `average` | `round(average(counts), 2)` | mean over **non-zero** buckets: `average()` defaults `includeZero = false` (`math.ts:8`) |
| `min` / `max` | `math.ts:23-33` | correct; both return `0` for an empty array |
| `count` | `cs.data.find(d => !!d.total_count)?.total_count` | always `undefined` (§10.3) |

#### 10.1 `metrics.sum` on an intensive series

It is wrong-by-dimension and load-bearing in two places: `format.ts:153` sorts by it and
`bar/chart.tsx:59, 99` computes percent-of-total from it.

**Chosen resolution:** leave `format()` alone. *Selection* is now exact and value-ranked in
phase A (§8.1), which is the part that must be right — the draft justified selection with
"PromQL `topk` ranks by value and is correct", which was false because `topk` ranks per instant.
*Ordering* is deterministic by D12. Percent-of-total in `bar`/`pie` is genuinely wrong for a
rate or gauge; the answer is that the picker steers a metric report to `report.metric: 'average'`
and that `bar`/`pie` are offered mainly for `increase`-reduced counters, where the percentage is
correct (§14.6).

**Rejected:** a `percent_of_total_unreliable` notice. It fires on a condition the user cannot act
on without re-authoring the report, and it would fire on most gauge bar charts, i.e. constantly.
Documented here instead, as a UI-steering item.

#### 10.2 `metrics.average` excludes zeros

A gauge legitimately `0` for half the window reports the mean of the other half. Pre-existing
behaviour shared with event charts; the metric card reads `serie.metrics[metric]` directly.
**Accepted and documented.** It has an accidental benefit: D10's zero-filled gaps are excluded
from the average, which is the right answer for a gap.

**Rejected:** passing `includeZero = true` from the metrics path. `average()`'s second argument
would have to be threaded through `format()`, changing event-chart behaviour for every existing
report.

#### 10.3 `metrics.count` is always `undefined`

There is no `total_count` analogue for a metric query. `metric-card.tsx` renders `undefined` as
`N/A`, which is honest. superjson is the tRPC transformer, so `undefined` survives the wire.
**Consequence:** `report.metric: 'count'` must not be offered for a metric report, or every
metric card renders `N/A`.

#### 10.4 The chart-level `metrics`

`format.ts:155-165` computes it from every visible series' points flattened together and
hard-codes `count: undefined`. For metrics that is a sum of sums across unrelated label sets. No
change; §10.1 covers it.

### 11. Previous period

```ts
// inside executeMetricChart
if (spec.previous) {
  const prev = getChartPrevStartEndDate({ startDate: spec.startDate, endDate: spec.endDate });
  //          packages/db/src/services/date.service.ts:273-296

  const toSec = (s: string) =>
    DateTime.fromFormat(s, 'yyyy-MM-dd HH:mm:ss', { zone: spec.timezone }).toSeconds();

  const shiftSteps = Math.round((toSec(spec.startDate) - toSec(prev.startDate)) / grid.stepSec);
  const previousGrid = shiftGrid(grid, shiftSteps);      // NOT resolveGrid(prev)

  const previousCompiled = compileMetricQuery(q, {
    projectId, stepSec: grid.stepSec, pinnedSeries: pins,
  });
}
```

```ts
export function shiftGrid(grid: ResolvedGrid, shiftSteps: number): ResolvedGrid {
  const d = shiftSteps * grid.stepSec;
  const out = { ...grid, fromSec: grid.fromSec - d, toSec: grid.toSec - d };
  // The D7 invariant must hold on the previous window too, or it comes back BLANK.
  if (out.fromSec % grid.stepSec !== 0) throw new Error('previous grid unaligned');
  return out;
}
```

Five requirements, each of which fails invisibly if missed:

1. **Same step.** A different step changes the sub-bucket count per calendar bucket and
   therefore the `avg` reducer's denominator.
2. **Same window.** Re-resolving `auto` against the same step gives the same answer; T-W3
   asserts it rather than assuming it.
3. **Pinned to the current window's label sets**, via §8.2 — never re-ranked. `format.ts:94-98`
   matches a previous series on `definitionIndex` **and** `name.slice(1).join(':::')`; a
   different set matches the wrong pairs, or none, silently dropping the whole comparison. The
   draft quoted only the name half of that predicate.
4. **Same bucket count**, guaranteed by `shiftGrid`. `format.ts:142` pairs
   `previousSerie.data[index]` with `cs.data[index]`; a length mismatch shifts the entire
   comparison by one bucket with no error anywhere in the stack.
5. **Step-aligned shift.** `Math.round` to whole steps is what makes requirement 4 and D7 both
   hold. The draft shifted by the raw millisecond delta with an explicit "NOT resolveGrid(prev)"
   and no re-assertion, so nothing caught an unaligned previous window. Concretely:
   `getDatesFromRange` ends most ranges at `23:59:59`, so a 30 d window is 2 591 999 s, and
   `getChartPrevStartEndDate` adds 1 ms when the second count is odd (`date.service.ts:284-286`)
   — giving a shift of 2 678 399.001 s, which is neither integral nor a multiple of 3600.

**On zones.** `getChartPrevStartEndDate` parses with
`DateTime.fromFormat(s, 'yyyy-MM-dd HH:mm:ss')` and **no `{ zone }`**, i.e. in the server
process's zone (`date.service.ts:280-282`). We re-derive the shift by parsing both strings in
the **project** zone and then rounding to whole steps, which absorbs both the 1 ms nudge and any
DST disagreement of up to an hour into the rounding. The residual is at most one step on a window
containing a DST transition, which is the same order of error the event path already carries.
The consequence — the previous window is not byte-identical to `getChartPrevStartEndDate`'s
window, but rounded to the step — is deliberate and is in the failure-modes table.

The current and previous queries for one definition run **inside one lease**
(`04-read-path.md:1416`), not two, or a `previous: true` dashboard doubles its concurrency
footprint.

`getPreviousMetric` (`packages/common/src/get-previous-metric.ts`) then computes the
`diff`/`state` pairs unchanged.

**Degradation.** If the previous-window query fails while the current one succeeded, the chart
renders without the comparison and attaches `previous_period_unavailable`. This is the one
partial result the engine returns (D14), because a missing comparison is visible as a missing
comparison, whereas a missing *series* is indistinguishable from no data.

### 12. Missing data, concurrency, deadlines, quotas

#### 12.1 Three distinct absences

| Absence | Origin | Behaviour |
|---|---|---|
| scrape jitter under 5 min | ingest cadence | invisible — PromQL carries the last sample forward (`staleness = 5m`, `planner/shared.go:14`) |
| a real gap over 5 min | target down | sub-buckets missing, calendar bucket empty, `count: 0` plus `gaps_unmeasured` (D10) |
| a series absent for the whole window | never existed, renamed, retention-expired, filtered out | gigapipe returns no series; the engine emits `series: []` and the UI renders an **empty-state card naming the metric**, not a blank chart |

Two properties the renderers need, both asserted in the shaper:

- **Every series has the same dense `data` array.** `use-rechart-data-model.ts:22` builds the
  x-axis from `series[0]?.data` only, and `format.ts:153` makes `series[0]` the largest-sum
  series rather than the widest. A sparse metric series would make other series' points vanish.
  D8 is what makes this true at the source; before it, `topk`'s per-step behaviour violated it
  in the response itself.
- **A series with zero points never reaches `format()`.** gigapipe already omits it, but the
  shaper asserts it: an all-empty series would sort as `sum = 0` and displace real data out of
  `limit`.

**What we lose:** a filled `0` is indistinguishable from a measured `0` in the `FinalChart`. The
notice says how many buckets were filled but not which. Fixing that properly is the
`count: number | null` widening priced in D10.

#### 12.2 Fan-out

```ts
const limit = pLimit(cfg.fanoutConcurrency);              // 4, read-path D8's existing key
await withProjectLease(spec.projectId, async () => {
  const ranked  = await Promise.all(compiled.map((c) => limit(() => resolveSeriesSet(c, grid, o))));
  const current = await Promise.all(compiled.map((c, i) => limit(() => fetchPhaseB(c, i))));
  const prev    = spec.previous
    ? await Promise.allSettled(compiled.map((c, i) => limit(() => fetchPrevious(c, i))))
    : null;
});
```

Worst case per report: 6 definitions times 3 calls = 18 range queries, 4 in flight, one lease.
`Promise.all` for phases A and B (one failure fails the chart, D14); `Promise.allSettled` for the
previous window (degradable). The draft's bare `Promise.all` over an unbounded `series` array is
what this replaces: `zChartSeries` has no `.max()` (`packages/validation/src/index.ts:153-157`),
so a 40-series report with `previous` would have been 80 concurrent range queries from one HTTP
request.

#### 12.3 Deadline and cancellation

One `AbortController` per report, `cfg.metricDeadlineMs` (25 s), strictly below gigapipe's
hard-coded 30 s engine timeout (`reader/router/prometheus_query_range.go:32`) so the engine's own
timeout is never the thing the user waits on. The signal is passed to every `gigapipe.request()`
call and is also aborted when the tRPC request signal aborts, so a closed dashboard tab stops the
fan-out instead of holding the lease for 25 s. The draft's §7 showed a `signal` parameter that
nothing created or aborted.

An `AbortError` classifies as `GigapipeTimeoutError` in read-path's taxonomy, which is retryable
once — the retry must **not** happen for a client-disconnect abort, so the engine distinguishes
the two by which controller fired.

#### 12.4 The truncated-200 case is already covered

`writeResponse` writes the 200 header and the `{"status":"success",..."result":[` prelude to the
socket **before** dispatching to `writeMatrix`
(`reader/controller/prom_query_range.go:170-192`), so a failure inside `writeMatrix` returns to
`QueryRange`, which then calls `PromError(500, ...)` on an already-committed 200 (`:97-102`). The
client sees HTTP 200 with a truncated, unparseable body. Read-path already classifies that as
`GigapipePartialResponseError` (retryable once) and its transport already does the `JSON.parse`
in a `try`. Nothing extra is needed here; the engine must simply not treat a parse failure as an
empty chart.

Related, and worth stating so nobody promises it: `res.Warnings` from `rangeQuery.Exec` is never
serialised anywhere in `writeResponse`, so PromQL engine warnings — including sample-limit
warnings — are invisible to OpenPanel and cannot be surfaced as notices.

#### 12.5 Rate limiting is a read-path requirement, and it is not optional

`chartRouter` has no rate limiting: `rateLimitMiddleware` exists
(`packages/trpc/src/trpc.ts:135-139`) and is applied to `auth` and `organization`, and to nothing
in `chart.ts` (verified by grep — zero occurrences). The 60 s cache keys on `trpc:${path}:` plus
`JSON.stringify(rawInput)` with no user component (`trpc.ts:206-208`), so every distinct
`range`/`startDate`/`endDate`/`interval` combination is a cache miss. Against ClickHouse that is
a per-project cost; against gigapipe it is a **single Go process with one global `MaxSamples`
budget**, so the blast radius of abuse is **cross-tenant** in a way the event path's is not.

In P2 `observability.*` is authenticated-only and rejects `shareId` outright
(`04-read-path.md:951-965`), which contains this. § P2.5 cannot ship the share path without
`rateLimitMiddleware` on the metric procedure, keyed on `shareId` plus IP. That is a hard
prerequisite, not a nice-to-have.

#### 12.6 Series-count bound and report-level fields

`cfg.maxMetricSeriesPerReport = 6` matches `zMetricReportInput.series.min(1).max(6)`
(`04-read-path.md:993`) and is **re-asserted in `executeMetricChart`**, because a schema bound
alone is not enough: `runReportFromConfig` casts around zod entirely
(`packages/mcp/src/tools/analytics/reports.ts:331-335`, `as unknown as Parameters<...>[0]` over a
`[key: string]: unknown` config) and is a live P2.5 call site.

| Report-level field | Status for a metric report |
|---|---|
| `breakdowns` | **Ignored.** The breakdown lives on the series as `groupBy`. `zMetricReportInput` does not carry it at all, which is one more reason for D1. In P2.5 the picker must hide it and `refineReportInput` must reject a non-empty `breakdowns` rather than persisting a field nothing reads |
| `globalFilters` | **Ignored, safely.** Settled on disk: `mergeGlobalFilters` returns early when there are no global filters and otherwise maps `item.type === 'event' ? {...} : item` (`packages/db/src/services/reports.service.ts:29-41`), so formula and metric items pass through untouched. No guard needs adding; the draft's speculative "read it and add a `type === 'event'` guard if needed" is deleted, and the regression test stays in `reports.service.test.ts` |
| `metric` | `count` is disallowed (§10.3); `average` is the sensible default for intensive series |
| `limit` | Honoured — folded into the effective `maxSeries` as `min(cfg.maxSeries, limit)` and passed to `format()` |
| `offset` | **Inert, and inert on the event path too.** `plan.input.offset` is passed into `getChartSql`'s input object (`packages/db/src/engine/fetch.ts:55`) and `chart.service.ts` never reads it — a grep for `offset` in that file returns nothing. Ignoring it on the metrics path introduces no asymmetry. Stated so nobody "fixes" it here |
| `visibleSeries` | Honoured by the UI; D12 and §9.3 are what make it survive a reload |
| `unit`, `lineType`, `chartType` | Honoured; `chartType` is gated by D13 |

#### 12.7 Wind-down, trial expiry and deletion

`executeMetricChart` consumes an `endDate` that the read-path resolver has already clamped
through `getOrganizationSubscriptionChartEndDate` (`04-read-path.md:1023-1027`), so a downgraded
organisation cannot see live telemetry beside frozen event charts. Two further cases the draft
did not address:

- **Ingest blocked at wind-down day 21** (`apps/worker/src/jobs/cron.wind-down.ts`): metric
  charts keep rendering historical data and simply stop at the block date. No engine change; the
  empty-state card in §12.1 covers the tail.
- **Telemetry swept at day 44, or a project deleted**: gigapipe returns an empty matrix, which is
  the third absence row. There is no per-project delete on the gigapipe side
  (`01-tenancy-and-security.md` §6), so "the data is gone" and "the metric never existed" are
  indistinguishable to this engine, and the empty-state card must not claim which.

### 13. `executeMetricAggregate`

Identical pipeline with the grid forced to a **single bucket** spanning
`[startDate, endDate]`: `grid.buckets.length === 1`, the reducer collapses the whole window, and
the date string is the local start of the window — matching what `getAggregateChartSql` does for
event aggregates. The PromQL step is still a sub-bucket step; the reduction happens in JS.

This is why the reducer table matters twice: a `bar` chart of `increase(http_requests_total[...])`
correctly **sums** to a total, while a `bar` chart of `avg_over_time(cpu[...])` correctly
**averages**.

`previous` **is** supported here, on the same shifted-and-pinned mechanism, because
`executeAggregateChart` supports it and `metric-card.tsx` renders the diff indicator from it. The
previous grid is also a single bucket. The draft left this unspecified.

**Rejected:** `/api/v1/query` (instant) instead. It returns one point evaluated at `end` with 5 m
lookback, which is a *sample* of the window rather than an aggregate over it, and would disagree
with the line chart of the same report. `observability.metrics.instant`
(`04-read-path.md:1064-1072`) is a different product surface — a single-value tile — and is
correct to use the instant endpoint.

### 14. Worked examples

Project `proj_abc`, timezone `Europe/Stockholm`, `maxPoints = 3000`, `maxSeries = 20`.
`op_project_id` is written first by `compileSelector`.

#### 14.1 Request rate by route, 7 days, hourly

```jsonc
{ "type": "metric", "id": "A",
  "metric": "http_server_requests_total", "metricType": "counter",
  "filters": [{ "name": "service_name", "operator": "eq", "value": "api" }],
  "fn": "rate", "window": "auto",
  "aggregation": "sum", "groupBy": ["http_route"] }
```

Grid: span 604 800 s, `MAX_SUB_BUCKET.hour = 3600`, `ceil(604800/3600) = 168 <= 3000`, so
`stepSec = 3600`, interval `hour`, 168 buckets, 1:1 fold.
Window: `auto` gives `max(4*3600, 60) = 14400`, snapped up the ladder to `21600` (`6h`).

Phase A runs (168 > 24), at `rankStepSec = 21600`, 28 points:

```promql
sum by (http_route, op_project_id) (
  rate(http_server_requests_total{op_project_id="proj_abc",service_name="api"}[6h])
)
```

Say it returns 34 label sets. `series_capped { seen: 34, kept: 20 }`. Phase B, pinned:

```promql
sum by (http_route, op_project_id) (
  rate(http_server_requests_total{op_project_id="proj_abc",service_name="api",
       http_route=~"^(?:/v1/events|/v1/profiles|/api/track|...)$"}[6h])
)
```

`POST /api/v1/query_range` with `start=<aligned>&end=<aligned>&step=3600`.
Reducer `avg` (a rate is an intensity); one sub-bucket per calendar hour, so the fold is 1:1 and
the reducer never actually averages — which is exactly right at `interval: 'hour'`.

Series: `names: ['http_server_requests_total', '/v1/events']`,
`event.breakdowns: { http_route: '/v1/events' }`,
`id: slug('0-http_server_requests_total-/v1/events-1x9k2z')`.

#### 14.2 The same metric, 30 days, daily — where the fold does work

`stepSec = 3600` (`ceil(2592000/3600) = 720 <= 3000`), 30 calendar buckets. Window `auto` is
still `6h` — it is a function of the step, not of the range. Each daily bucket folds 24
sub-buckets with `avg`, so the chart shows the mean request rate per day. Across the October
transition one bucket folds 25 sub-buckets and one in March folds 23; the mean stays correct
because it divides by the actual count.

`metrics.sum` here is the sum of 30 daily mean rates — meaningless. `report.metric` should be
`average` (§10.1).

#### 14.3 p95 latency by route, classic histogram

```jsonc
{ "type": "metric", "id": "A",
  "metric": "http_server_duration_seconds", "metricType": "histogram",
  "fn": "histogram_quantile", "quantile": 0.95, "window": "auto",
  "aggregation": "sum", "groupBy": ["http_route"] }
```

`_bucket` is appended by `resolveMetricName`; `le` is force-added to `by`; the aggregation is
forced to `sum` regardless of what the user chose.

```promql
histogram_quantile(0.95, sum by (http_route, le, op_project_id) (
  rate(http_server_duration_seconds_bucket{op_project_id="proj_abc"}[6h])
))
```

`le` is dropped from identity by `histogram_quantile` itself and again defensively by
`dropLabels`. Reducer `avg` — a quantile does not add, and averaging p95 across sub-buckets is an
approximation. It is the standard one every Grafana panel makes; the honest alternative (one
query per calendar bucket) costs 30 queries for a monthly chart.

Phase A ranks on the same expression, which is correct here: the ranking is over the p95 value,
not over request volume.

#### 14.4 Mean latency from a summary — the formula case

`zMetricQuery` cannot express `a / b`. Formulas can, and `compute()`
(`packages/db/src/engine/compute.ts:11-198`) works on `ConcreteSeries` without caring where they
came from. Both series address a `_sum`/`_count` **counter by its real name** (D5), so both are
`rate`, both are intensities, both resolve the same window, and the ratio is dimensionally
correct. The draft's version used `metricType: 'summary'` with `rate` and `increase`, which
compiled both sides to `_count` and then needed a `formula_window_mismatch` notice to describe
its own bug.

```jsonc
"series": [
  { "type": "metric", "id": "A", "metric": "rpc_duration_seconds_sum",
    "metricType": "counter", "fn": "rate", "window": "5m",
    "aggregation": "sum", "groupBy": ["rpc_method"] },
  { "type": "metric", "id": "B", "metric": "rpc_duration_seconds_count",
    "metricType": "counter", "fn": "rate", "window": "5m",
    "aggregation": "sum", "groupBy": ["rpc_method"] },
  { "type": "formula", "id": "C", "formula": "A/B",
    "displayName": "mean latency", "hideSeries": ["A", "B"] }
]
```

`compute()` pairs A and B by breakdown signature `name.slice(1).join(':::')`
(`compute.ts:46-53`), which works because both were built from the same `groupBy` in the same
order — the reason §9.2 step 3 fixes the order. `hideSeries` then removes A and B from the chart
via `format.ts:36-53`, unchanged.

**Caveat that stays, and the engine handles it:** A and B are ranked independently in phase A, so
an `rpc_method` in A's top 20 but not B's would yield a formula series with a missing
denominator. `compute()` substitutes `0` for a missing series in the scope, producing `Infinity`,
which D11 does **not** catch because that happens after parse. So when any formula references
more than one metric definition, the engine **intersects the pin sets across those definitions
before phase B**, and every referenced definition resolves the same label sets. T-E4 pins this.

#### 14.5 A gauge as a single number

```jsonc
{ "type": "metric", "id": "A", "metric": "system_memory_utilization",
  "metricType": "gauge", "fn": "avg_over_time", "window": "auto",
  "aggregation": "avg", "groupBy": [], "scale": 100 }
```

with `chartType: 'metric'`, `report.metric: 'average'`, `report.unit: '%'`.

```promql
avg by (op_project_id) (
  avg_over_time(system_memory_utilization{op_project_id="proj_abc"}[6h])
)
```

Phase A is skipped (`groupBy` empty and `aggregation` present, so exactly one series comes back).
One series, `names: ['system_memory_utilization']`, `event.breakdowns: undefined`. `scale: 100`
turns `0.62` into `62`, which the `allowDecimals: false` axis
(`apps/start/src/components/report-chart/common/axis.tsx:39`) renders as `62%` instead of `0`.

#### 14.6 Bar chart of 5xx by service, last 30 days

`chartType: 'bar'` gives `intent: 'aggregate'` and therefore `executeMetricAggregate`.

```jsonc
{ "type": "metric", "id": "A", "metric": "http_server_requests_total",
  "metricType": "counter",
  "filters": [{ "name": "http_status_class", "operator": "eq", "value": "5xx" }],
  "fn": "increase", "aggregation": "sum", "groupBy": ["service_name"] }
```

`fn: 'increase'` pins the window to the step (§7.3); the grid is one bucket spanning the window;
the reducer is `sum`, so each bar is the true count of 5xx responses over 30 days. `metrics.sum`
is meaningful here and the bar chart's percent-of-total is correct — this is the shape §10.1's
caveat does not apply to, and the reason `bar`/`pie` are offered at all.

---

## P2.5 — report adoption (specified, not shipped in P2)

This is the phase that makes a metric series storable as a `Report` and renderable through
`chart.chart`. It is written here because this work-stream owns the engine it depends on, and
because its ordering constraints are not obvious.

### 15.1 The whitelists a metric series must cross

| Site | File:line | Change |
|---|---|---|
| **Read projection (mandatory, ships first)** | `packages/db/src/services/reports.service.ts:56-81` | `transformReportEventItem` gains `if (item.type === 'metric') return { ...item, id: item.id ?? alphabetIds[index]! };` **before** the event fallthrough. Without it, every share, dashboard read, MCP read and `getReportDataCore` sees `unknown_event` |
| List projection | `reports.service.ts:171-175` | add a `metric` arm to the `s.type === 'formula' ? ... : ...` ternary, else a metric series is listed to MCP and the agent as an event with `name: undefined` |
| Write (create / update / duplicate) | `packages/trpc/src/routers/report.ts:59, 101, 229` | none — `events: report.series` passes the array whole |
| `transformReport` | `reports.service.ts:83-116` | none — `series` is mapped through `transformReportEventItem` |
| MCP write | `packages/mcp/src/tools/dashboard-management.ts:15` | none — `.strict()` rejects *unknown keys*, and the union member is now known. **Verify** the Zod 4 refinement-carrying behaviour through `.omit().strict()` (T-P1) |
| Prisma | `schema.prisma:433` | none — `events` is `Json` |

That last row is the point: **no migration**. Dispatch is on
`series.some(s => s.type === 'metric')` behind one helper
(`packages/db/src/engine/data-source.ts`, `getReportDataSource(series)`), not on a
`Report.dataSource` column — that identifier exists nowhere in either repo today — because a
column would cost a Prisma migration plus three write whitelists plus a read whitelist plus a
list projection **plus** a field on `zReportInput` anyway: `ctx.report` is `null` on every
non-shared query (`chart.ts:139`), so the discriminator has to arrive from the browser
regardless.

### 15.2 Deploy ordering — this is the part that must not be improvised

`Report.events` is unversioned and `transformReportEventItem` is lossy, so old code coexisting
with new code destroys metric reports on save: `report.get` (old pod) rewrites the item to
`{type:'event', name:'unknown_event'}`, the user saves, and `report.update` persists the mangled
series (`report.ts:101`). `report.duplicate` is safe (it copies `report.events!` raw, `:229`);
`create` and `update` are not.

1. **Release N:** ship the `transformReportEventItem` metric arm and the `listReportsCore` arm —
   pure pass-throughs, no behaviour change for any existing report — and **soak** until every pod
   that can serve `report.get` carries them.
2. **Release N+1:** ship the union member, `refineReportInput`, the seven dispatch sites and the
   chart-type gate, behind a runtime flag.
3. **Flip the flag** only after N has fully rolled.
4. **Rolling back past release N is a data-loss migration.** It requires either disabling
   `report.update` for reports whose `events` contain a `type:'metric'` item, or a pre-rollback
   export. State it in the runbook.

`refineReportInput` also enforces homogeneity: a `series` array containing both `type:'event'`
and `type:'metric'` items is rejected. Mixing is not merely unsupported, it is uncheckable — the
two backends produce different date grids and `use-rechart-data-model.ts:22` builds the x-axis
from `series[0]` alone. Formulas may accompany either.

### 15.3 The seven executor call sites

`grep -rn 'ChartEngine.execute\|AggregateChartEngine.execute' apps packages`:

| # | Site | Today | Risk if not adopted |
|---|---|---|---|
| 1 | `packages/trpc/src/routers/chart.ts:609` | `ChartEngine.execute` | empty chart, no error |
| 2 | `chart.ts:633` | `AggregateChartEngine.execute` | empty chart, no error |
| 3 | `packages/db/src/services/reports.service.ts:215, 219` | dispatches `chartType === 'metric'` to aggregate | empty chart, no error |
| 4 | `packages/mcp/src/tools/analytics/reports.ts:302, 304` (`runReport`) | same | empty chart, no error |
| 5 | `reports.ts:349, 351` (`runReportFromConfig`) | same, and casts around zod (`:331-335`) | empty chart, no error |
| 6 | `apps/api/src/agents/tools/dashboard.ts:102, 104` | same | empty chart, no error |
| 7 | `apps/api/src/controllers/export.controller.ts:201` | `ChartEngine.execute`, hard-coded `chartType:'linear'` | **none — corrected below** |

Sites 1-6: `plan.ts:19-42` skips every non-`event` definition, so `format([])` returns an empty
`FinalChart` with no error.

**Site 7 is corrected from the draft.** The draft claimed `/export/charts` would run a metric
report through `getChartSql`. It cannot. The route validates against `chartSchemeFull`
(`export.controller.ts:148-181`), whose `series`/`events` members are
`z.object({ name: z.string(), filters?, segment?, property? })` — `name` is **required** and
`type` is **not in the shape**, so zod strips it and `type: event.type ?? 'event'` at `:196` is
always `'event'`. A metric series is not expressible at that endpoint at any input, and there is
no saved-report path here (series arrive ad hoc in the query string). Adopting the shared
executor at site 7 is uniformity, not a fix, and it is a no-op unless `chartSchemeFull` is
widened — which is a separate product decision about whether the public export API should accept
metric series at all.

Execution is centralised so nobody has to remember:

```ts
// packages/db/src/engine/index.ts
export type ReportIntent = 'timeseries' | 'aggregate';

export async function executeReport(
  input: IReportInput,
  opts: { intent: ReportIntent; signal?: AbortSignal },
): Promise<FinalChart> {
  if (getReportDataSource(input.series) === 'metrics') {
    assertMetricChartTypeSupported(input.chartType);
    return opts.intent === 'aggregate'
      ? executeMetricAggregate(toSpec(input), { signal: ... })
      : executeMetricChart(toSpec(input), { signal: ... });
  }
  return opts.intent === 'aggregate'
    ? executeAggregateChart(input)
    : executeChart(input);
}
```

`intent` is the **caller's**, because the existing sites already disagree about it and this
function must not change any of their answers: sites 3-6 route `chartType: 'metric'` to
`AggregateChartEngine` while the browser routes it to `trpc.chart.chart` and therefore
`ChartEngine`. That divergence is **pre-existing** and is preserved, not fixed; fixing it is a
behaviour change to event reports with its own blast radius.

### 15.4 The chart-type gate needs five more call sites than the engine

`assertMetricChartTypeSupported` inside `executeReport` never runs for the five hidden types,
because they never reach the engine: `chart.funnel`, `chart.conversion`, `chart.sankey` and
`chart.cohort` are separate procedures calling their services directly
(`chart.ts:456, 498, 554, 636`), and `getReportDataCore` routes `chartType === 'funnel'` to
`funnelService.getFunnel` before consulting the engine (`reports.service.ts:209-212`). A metric
report with `chartType: 'funnel'` therefore reaches `onlyReportEvents` (`:17-21`), which filters
it to `[]`, and throws "Start and end events are required" — an opaque error, not the designed
one. So the gate goes in `transformReport` (every report-shaped read passes it) **or** is added
explicitly at `chart.ts:456, 498, 554, 636` and `reports.service.ts:209`. Pick one and list it;
do not rely on the engine.

Note also that `chart.cohort` takes a bespoke `z.object` input, not `zReportInput`
(`chart.ts:638-652`), so widening `zReportInput` does not reach it at all.

### 15.5 Availability gate

`executeReport` dispatching on series shape assumes gigapipe is reachable. A self-hoster who does
not run the container has no telemetry backend, and every metric report there throws. Read-path
already provides the primitives: the transport throws `GigapipeDisabledError` when `GIGAPIPE_URL`
is unset (`04-read-path.md:455`) and `observability.status` answers `{ enabled: false }`
(`:448-449`). P2.5 must (a) surface `observability.status.enabled` to the series-type and
chart-type pickers so the metric option is not offered on an install with no backend, (b)
condition the metric union member's advertisement in the MCP and agent tool schemas on the same
flag, and (c) render a per-widget error card on a mixed dashboard rather than failing the page.

---

## Interfaces

### Consumed from the tenancy work-stream (`01-tenancy-and-security.md`)

| Symbol | Location | Contract |
|---|---|---|
| `compileSelector(q, projectId, extraMatchers?)` | `packages/gigapipe/src/query/promql.ts:1102` | **signature change requested**: a third parameter `extraMatchers: PromMatcher[]`, appended after `q.filters`, each value through `quote()`. Needed for §8.2 pinning, whose values are untrusted and are not `zMetricLabelFilter`s |
| `compileAggregation(q, inner)` | `:1118` | **body change required**: the `quantile` / `topk` / `bottomk` branches (`:1121-1126`) and their `q.k ?? 10` / `q.quantile` reads become dead the moment `zMetricAggregation` narrows to `sum\|avg\|min\|max\|count`, and `q.k` no longer exists. Delete them in the same change or it will not compile |
| `verifyResponseLabels(series, projectId): void` | `src/query/verify.ts:1423` | called as a **statement**, on the raw response, before stripping |
| `quote(value): string` | `:1084` | applied to every pinned label value |
| `TELEMETRY_PROJECT_LABEL`, `TELEMETRY_RESERVED_LABEL_PREFIX` | `@openpanel/constants` | |

**`zMetricQuery` is rewritten, not extended.** The draft called this "the additions are the
report-shaped fields and one enum change", which understated it. Field by field against
`01-tenancy-and-security.md:1028-1051`:

| Field | Tenancy today | This spec |
|---|---|---|
| `type`, `id`, `metricType`, `scale`, `displayName`, `hideSeries` | absent | added |
| `window` | `1m,5m,15m,30m,1h,6h,24h`, default `5m` | **plus four members** `auto,10m,3h,12h`, default `auto` |
| `fn` | includes `irate`, `deriv`; no `last_over_time` | **minus two, plus one**: `irate` and `deriv` removed (§0), `last_over_time` added |
| `aggregation` | `sum,avg,min,max,count,quantile,topk,bottomk` | **minus three**: `quantile`, `topk`, `bottomk` removed |
| `k` | `z.number().int().min(1).max(100).optional()` | **deleted** |
| `groupBy` | no uniqueness refine | uniqueness refine added |
| cross-field rules | none | `refineMetricQuery` (§2), including `REDUCER_TABLE` totality and the summary-quantile rule |

Whoever lands the tenancy schema and whoever lands this must land the schema **and**
`compileAggregation` together. This spec's author lands both; tenancy reviews.

### Consumed from the read-path work-stream (`04-read-path.md`)

`GigapipeConfig` (`:423-430`), `request()` / `prometheus.queryRange()` and the `enforcement`
gate, `withProjectLease()` (`:1416`), `STEP_LADDER_SEC` / `MAX_SUB_BUCKET` (`:1317-1326`), the
error taxonomy (`GigapipeQueryTooLargeError`, `GigapipeUpstreamError`,
`GigapipePartialResponseError`, `GigapipeTimeoutError`, `GigapipeDisabledError`,
`GigapipeScopeError`, `GigapipeBusyError`), the `getChartStartEndDate` plus
`getOrganizationSubscriptionChartEndDate` resolution order (`:1014-1027`), and
`observability.status`.

**Six amendments this spec requires of `04-read-path.md`.** All narrow it; none reopens D6.

1. **§5.1 `compileMetricQuery`** — `opts` becomes `{ projectId, stepSec: number, pinnedSeries? }`.
   `step: string` and `timezone` are removed (the step is resolved by `resolveGrid`, and the
   compiler never sees a timezone). The return type is `CompiledMetricQuery` (§4), not
   `{ promql, legend }`. **Delete the "`topk` wrapping" required behaviour** (`:884-886`) — see
   D8. `maxSeries` moves off the compiler and onto `resolveSeriesSet`.
2. **§5.2 `shapeMatrixToFinalChart`** — input becomes the shape in §9; return type becomes
   `MetricChartResult` (structurally still a `FinalChart`).
3. **§6.1 resolver body (`:1011-1060`)** — steps 4-8 are replaced by one call to
   `executeMetricChart(spec, { signal })`. Steps 1-3 (timezone, window, billing cutoff) stay in
   the resolver. The declared `output:` becomes `MetricChartResult`.
4. **§8.1 `clampStep`** — the loop returns the *smallest* fitting ladder value, which contradicts
   its own worked examples at `:1365-1370` and costs 2-4x. Either fix it to return the coarsest
   (`MAX_SUB_BUCKET[interval]`, always a ladder member) or mark it unused by the metrics engine,
   which owns `resolveStep` (§6.1). `cfg.maxPoints` default rises to **3000** (§6.3), and the "90
   days at `hour` throws" example is replaced by D7's interval-coarsening.
5. **§8.2 (`:1397-1399`)** — delete "a response with more than `maxSeries` series ... is a bug,
   and the resolver raises `GigapipeUpstreamError`". Under §8.2 that is a legitimate
   cross-product response and the shaper filters it. Add `cfg.maxRankSeries`,
   `cfg.metricFanoutConcurrency` and `cfg.metricDeadlineMs` to `GigapipeConfig`.
6. **§ Interfaces (`:2117-2123`)** — update the "Consumed from the metrics-engine work-stream"
   table to the corrected signatures, and add `executeMetricChart` / `executeMetricAggregate`.

`MAX_SUB_BUCKET` stays a **constant map** — the draft asked read-path to make it a function of
`(interval, timezone)`; §6.4 cuts that requirement.

### Exposed to other work-streams

| Symbol | Location | For |
|---|---|---|
| `executeMetricChart(spec, deps)` / `executeMetricAggregate(spec, deps)` | `engine/metrics/execute.ts` | read-path `observability.metrics.chart` (P2); `executeReport` (P2.5) |
| `shapeMatrixToFinalChart(input)` | `engine/metrics/shape.ts` | read-path §5.2; kept as a named export so it is separately testable |
| `compileMetricQuery(q, opts)` | `engine/metrics/compile.ts` | read-path §5.1; **P5 alerting** — a rule evaluates the same spec at instant resolution. Do not build a second compiler |
| `REDUCER_TABLE`, `reduceBucket`, `BucketReducer` | `validation` / `engine/metrics/reduce.ts` | P5 alerting, so "CPU above 90%" in an alert means what the chart shows |
| `MetricChartResult`, `MetricNotice`, `MetricNoticeCode` | `engine/metrics/notices.ts` | UI notice strip |
| `getReportDataSource(series)` | `engine/data-source.ts` | P2.5: UI picker filtering, drill-down suppression, MCP |
| `zMetricQuery` / `IMetricQuery` | `@openpanel/validation` | everyone |

### For the UI work-stream (`09-ui-surfaces.md`)

1. **Notice strip** rendering `MetricChartResult.notices` on the chart card. Seven codes, each
   reporting an action the engine took that changed what is on screen.
2. **`report.metric` must exclude `count`** for metric reports (§10.3) and should default to
   `average`, not `sum`, for a series whose reducer is `avg` or `last` (§10.1).
3. **`allowDecimals: false`** at `apps/start/src/components/report-chart/common/axis.tsx:39`
   flattens sub-unit gauges to a zero line. **This is the primary fix, ahead of `scale`** — it is
   one conditional in one file, while `scale` is a persisted field, a multiply, a picker control
   and a value that disagrees with the raw metric in the tooltip, CSV export and MCP output.
   `scale` stays in v1 for genuine unit conversion (bytes to MB) and as the `%`-rendering idiom;
   if the axis is fixed first, `scale` becomes optional and could be deferred.
4. **Picker defaults:** offer `scale: 100, unit: '%'` when the catalogue's sampled values for a
   metric are all within `[0, 1]`.
5. **Chart-type filtering** for metric reports (D13), and **"View Users" suppression** —
   `line/chart.tsx` pushes the `ViewChartUsers` modal with `series: reportSeries`, which for a
   metric report would run an event query over series named after metrics.
6. **Label pickers** must hide `op_project_id`, `__name__` and `target_info`, while offering
   `le`, `quantile`, `job` and `instance` — `job` and `instance` are set from resource attributes
   (`writer/utils/unmarshal/otlp_metrics.go:248-252`) and are the two most useful group-by labels
   in practice.
7. **Empty state:** `series: []` must render a card naming the metric and saying the engine found
   no series in the window, never a blank chart (§12.1).
8. **P2.5 only:** hide the report-level breakdown picker for metric reports (§12.6).

### For the alerting work-stream (`07-alerting.md`)

A metric alert rule carries an `IMetricQuery` and reuses `compileMetricQuery` plus `reduceBucket`,
so that "CPU above 90%" in an alert means exactly what the chart shows. Do not build a second
compiler, and do not re-derive the reducer — read `REDUCER_TABLE`.

### For the ops / deployment work-stream (`10-ops-retention-billing.md`)

- **`ADVANCED_PROMETHEUS_MAX_SAMPLES` must be set and documented.** It is the only source of
  gigapipe's `MetricsMaxSamples` (`cmd/gigapipe/main.go:201-206`), it has no default in
  `reader/config`, and it is **global across every tenant** — one project's breakdown can exhaust
  it for everyone. §5 names it as a real deployment parameter.
- gigapipe's image pinned by digest, with the digest to vendored-Prometheus-version mapping
  checked in, because `LookbackDelta`, `EnableNegativeOffset` and `MaxSamples` semantics are
  Prometheus-version-dependent.

### Self-observability (new, and this work-stream owns it)

Nothing else in the plan says what an on-call engineer sees. The engine emits, per request:

- `openpanel_metrics_query_duration_seconds{phase="rank"|"chart"|"previous"}` — histogram;
- `openpanel_metrics_series_seen` and `_kept` — so `series_capped` frequency is visible;
- `openpanel_metrics_notice_total{code}` — a spike in `interval_coarsened` means the point budget
  is wrong; a spike in `gaps_unmeasured` means ingest is broken;
- one structured log line per gigapipe call at debug:
  `{ projectId, promql, stepSec, windowSec, fromSec, toSec, phase }`. The compiled PromQL contains
  `op_project_id` and user-supplied label values, so it is logged at debug only and label values
  are truncated to 64 characters.

That is what distinguishes "gigapipe is slow" from "the compiler is emitting a bad query".

---

## Failure modes

| Symptom | Cause | Detection | What the user sees |
|---|---|---|---|
| Chart renders empty, no error | `start` not a multiple of `step` (D7) | T-G1; plus `resolveGrid`'s `fromSec % stepSec === 0` assert and `shiftGrid`'s | nothing — the asserts exist to convert this into an error |
| Previous line shifted by one bucket | previous grid re-bucketed instead of shifted (D9) | shaper asserts `previous.data.length === current.data.length` | a comparison that is wrong by one bucket everywhere |
| Previous window blank | shift not a whole number of steps (§11 item 5) | `shiftGrid`'s alignment throw | an error, not a silently missing comparison |
| Previous comparison silently absent | previous window ran its own ranking, or equality-matcher pinning matched nothing | T-E2 asserts pins are passed whenever `previous`; T-C4 asserts the emitted pin is `=~`, never two `=` on one label | no comparison, no explanation |
| Real series dives to zero mid-chart | `topk` inside a range query (D8) — **prevented, not detected** | T-C5 asserts `topk` never appears in any emitted expression | a chart that looks like an outage |
| More than `maxSeries` series in the response | legitimate cross-product from multi-label pinning (§8.2) | shaper's `matchesPin` plus the cap; **not** an error | correct chart |
| `GigapipeQueryTooLargeError` "That breakdown produces N series" | `seen > maxRankSeries` (§8.1) | phase A | an actionable message naming the count |
| Series order changes between identical requests | a non-finite reached `metrics.sum` (D11), or label key order leaked into the id (§9.2), or sub-0.01 sums tied and nothing broke the tie (D12) | T-S3, T-S4 | a different five series visible on each reload |
| Two lines merge into one | `slug()` id collision (§9.3) | T-S5 | one line where there were two |
| Saved `visibleSeries` stops matching | id depends on `displayName` (§9.3) | T-S5 | the chart forgets the user's selection after a rename |
| Interval silently coarser than asked | point budget (D7) | `interval_coarsened` notice | a notice naming both intervals |
| HTTP 200, unparseable body | `writeResponse` committed the 200 before `writeMatrix` failed (§12.4) | read-path's `GigapipePartialResponseError` | retryable error card, **not** an empty chart |
| 500 after about 30 s, no message | gigapipe's fixed engine timeout — should be unreachable, our deadline is 25 s | `GigapipeUpstreamError` | retryable error card |
| 500 "query processing would load too many samples" | global `MaxSamples` exhausted, possibly by another tenant | read-path's pinned string maps it to `GigapipeQueryTooLargeError` | "That query is too large" — and the ops metric above shows it was someone else |
| Numbers plausible but wrong | `rate` on a gauge, a counter read raw, a summary with no `quantile` filter | rejected at parse (§2, §4.4) | a field-level validation message explaining why |
| Chart empty because the metric no longer exists | renamed, retention-expired, ingest stopped, project deleted | gigapipe returns an empty matrix; the engine emits zero series | **an empty-state card naming the metric** (§12.1), not a blank chart |
| Whole dashboard slow | 8 widgets times up to 18 calls; lease queueing | `GigapipeBusyError` from the lease | per-widget "busy, retrying" |
| One series fails, the rest succeed | a phase-B query errored | `Promise.all` rejects (D14) | one error card, not a chart missing a line |
| **P2.5:** saved metric report becomes `unknown_event` and is re-saved | an old pod served `report.get` and the user saved (§15.2) | round-trip test T-P2; the release ordering is what prevents it | **permanent, silent data loss** — this is why §15.2 exists |
| **P2.5:** metric report as a funnel throws "Start and end events are required" | the chart-type gate is only in the engine (§15.4) | a gate test per call site | an opaque error |
| **P2.5:** share link becomes an unmetered query generator | no rate limiting on `chartRouter` (§12.5) | — | cross-tenant latency |

---

## Test requirements

`format()` and the `FinalChart` contract have **no** test coverage today — no test file in the
repo references `FinalChart`, `ChartEngine`, `executeChart` or `format`, and the only tests under
`packages/db/src/engine` are in `formula.test.ts`. None of the equivalence below is inherited;
all of it is new.

### Integration, against a real gigapipe (gates every image-digest bump)

The repo has **no** integration harness: no testcontainers dependency, no
`*.integration.test.ts`, no docker-backed vitest project; `pnpm dock:up` is a manual developer
command (`package.json:13-16`). Building it is named work (§ Effort, Q6). Until it exists, T-G1
has a cheap non-gating fallback: a recorded `curl` against a dev stack, with the request and both
responses pasted into this document. T-G1 is on the critical path because it is the only thing
that settles the `LookbackDelta` unknown.

- **T-G1 — grid alignment (D7).** Write a synthetic counter at a known cadence; query with
  `start` a multiple of `step`, then again offset by `step/2`, at `step = 3600`. Assert the first
  returns points and the second returns none. Also settles Q1.
- **T-G2 — suffix conventions (D5).** Push one OTLP histogram and one summary; assert the stored
  `__name__` set is exactly `{M_bucket, M_sum, M_count}` and `{M, M_sum, M_count}`, with `le` and
  `quantile` labels present.
- **T-G3 — `histogram_quantile` end to end.** Known bucket counts in, known quantile out, within
  one bucket width.
- **T-G4 — non-finite serialisation (D11).** Query `x / 0`; assert the body literally contains
  `"+Inf"` and that the shaper drops it.
- **T-G5 — label order instability.** Issue the same query N times; assert the `metric` key order
  differs at least once while every `IChartSerie.id` is byte-identical.
- **T-G6 — pinned regex alternation round-trips.** Pin three label values including one with `.`,
  one with `|` and one empty; assert exactly those three series come back and, for a two-label
  pin, that the cross-product extras are present in the response and absent from the
  `FinalChart`.
- **T-G7 — the three pinned upstream strings.** Assert the 11 000-point 500, the buffer-exceeded
  500 and the too-many-samples 500 with their exact messages, so read-path's classification stays
  pinned.
- **T-G8 — acceleration.** For one query of every row in §4.2, assert the ClickHouse query log
  shows a `metrics_15s` read, not a `samples_v3` scan. This is the executable form of the §0
  property.

### Unit — compiler (`compile.test.ts`)

- **T-C1** Table-driven over the whole §4.2 matrix: `(metricType, fn, aggregation, groupBy)` to
  an exact PromQL string.
- **T-C2** The tenancy matcher is the **first** matcher in every emitted selector.
- **T-C3** `le` is in `by (...)` for and only for `histogram_quantile`; the user's `aggregation`
  is ignored there.
- **T-C4** `pinnedSeries` with two values on one label emits one `=~"^(?:a|b)$"` matcher, never
  two `=` matchers; values containing `.`, `|`, `(`, `\` and `"` are regex-escaped **and**
  `quote()`d.
- **T-C5** `topk` and `bottomk` never appear in any emitted expression, for any input.
- **T-C6** Every `zMetricFn` member except `none`/`histogram_quantile` is a key of gigapipe's
  `rangeFns`, and every `zMetricAggregation` member is a key of `aggFns` — asserted against a
  checked-in copy of both key lists, refreshed on every image bump.
- **T-C7** Every `(metricType, fn)` pair accepted by `refineMetricQuery` has a `REDUCER_TABLE`
  entry, and `compileMetricQuery` throws on a synthesised pair that does not.

### Unit — grid (`grid.test.ts`)

- **T-GR1** Every `(zRange x zTimeInterval)` combination resolves **without throwing**, and
  `fromSec % stepSec === 0` for all of them.
- **T-GR2** `Europe/Stockholm`, 30 d at `day`, across both DST transitions: 30 buckets, and the
  23 h and 25 h buckets fold from 23 and 25 sub-buckets.
- **T-GR3** `12m` at `month`: 12 buckets; February folds 28 or 29.
- **T-GR4** `12m` at `day` and `30d` at `minute` coarsen and emit exactly one
  `interval_coarsened`.
- **T-GR5** Every emitted date matches `/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/` and
  `dates.slice().sort()` equals `dates` — the MCP shaper's assumption
  (`packages/mcp/src/tools/analytics/reports.ts:82`).
- **T-GR6** Week buckets equal `toStartOfWeek(t, 1, tz)` for the same instants, against a fixture
  table (a unit test cannot call ClickHouse).
- **T-GR7** `shiftGrid` preserves `buckets.length` and step alignment across a DST boundary, and
  throws when handed a non-integral shift.

### Unit — ranking and pinning (`rank.test.ts`, `pin.test.ts`)

- **T-R1** Phase A is skipped when `groupBy` is empty and `aggregation` is set; merged when the
  chart grid is 24 points or fewer; issued otherwise.
- **T-R2** `series_capped.seen` is the exact distinct label-set count, and `kept` is
  `min(seen, maxSeries)`.
- **T-R3** `seen > maxRankSeries` throws with the actionable message.
- **T-R4** Ranking is stable: the same coarse matrix produces the same order across shuffles of
  the response array.
- **T-P-1** `matchesPin` rejects a cross-product series that no pin contains, and accepts a
  series whose pinned label is absent when the pin's value was empty.

### Unit — shaper (`shape.test.ts`)

- **T-S1** All series share one dense, identical `data` array of `grid.buckets.length`.
- **T-S2** A gap becomes `count: 0` plus exactly one `gaps_unmeasured` with the right
  count.
- **T-S3** `NaN`, `+Inf`, `-Inf` never reach `metrics.sum`, and the notice carries the count.
- **T-S4** Ten series whose sums all round to `0` come back in a stable, documented order across
  repeated shapes and across shuffles of the input matrix (D12).
- **T-S5** Two label values that `slug()` to the same string produce different ids (`/api/v1`
  versus `api-v1`); and changing `displayName` leaves every id byte-identical.
- **T-S6** `scale` is applied exactly once, not once per bucket member.
- **T-S7** When `verifyResponseLabels` throws, `shapeMatrixToConcreteSeries` is never called
  (spy assertion).

### Unit — window (`window.test.ts`)

- **T-W1** A window narrower than the step widens and notices; wider is left alone.
- **T-W2** `increase` pins to the step and notices only when the user asked for something else.
- **T-W3** Re-resolving `auto` for the previous window yields the identical `windowSec`.

### Engine (`execute.test.ts`, mocked transport)

- **T-E1** One failing phase-B query fails the whole chart — no partial series.
- **T-E2** A failing previous-window query returns the current chart plus
  `previous_period_unavailable`.
- **T-E3** Fan-out never exceeds `fanoutConcurrency` in flight, and all calls share one
  lease and one signal.
- **T-E4** With a formula referencing two metric definitions, both resolve the same pinned label
  sets (§14.4).
- **T-E5** Aborting the caller's signal aborts every in-flight gigapipe call and does not retry.
- **T-E6** `executeMetricAggregate` with `previous: true` returns a one-bucket chart with a
  populated `metrics.previous`.

### P2.5 only

- **T-P1** `zReport.omit({ projectId: true }).strict().parse(<mixed event and metric report>)`
  still **rejects** — the Zod 4 refinement-carrying check (§2).
- **T-P2** Round trip: `report.create` to `getReportById` to `transformReport` to `executeReport`
  preserves the metric series byte for byte. This is the regression test for §15.1's mandatory
  whitelist edit.
- **T-P3** A report saved by new code and read by code **without** the `transformReportEventItem`
  arm is detected — a test that pins the failure §15.2 exists to prevent, so nobody removes the
  release ordering.
- **T-P4** Router tests modelled on `packages/trpc/src/routers/share.test.ts` (which uses
  `router.createCaller` with a mocked `@openpanel/db` and exists because of
  GHSA-7gv7-c464-9wh8): a metric report over a valid share returns data and never reaches
  `getChartSql`; an invalid share is `FORBIDDEN`; the compiled PromQL contains
  `ctx.report.projectId`, never the input's; the cache key differs between an event and a metric
  report with otherwise identical inputs.
- **T-P5** `assertMetricChartTypeSupported` fires at every one of the five call sites in §15.4.

---

## Open questions

| # | Question | What would settle it | Blocking? |
|---|---|---|---|
| Q1 | Is `promql.NewEngine`'s `LookbackDelta: 0` (`reader/router/prometheus_query_range.go:34`) substituted with Prometheus' 5 m default in the pinned version? D7's blank-chart failure mode and D10's "scrape jitter never reaches the shaper" both depend on it | `go doc github.com/prometheus/prometheus/promql EngineOpts` against the pinned version, or T-G1 empirically. The vendored module is not on this machine's module path | No — D7's alignment is correct under any lookback |
| Q2 | Does Zod 4 carry `superRefine` refinements through `.extend()` and `.omit().strict()`, or silently drop them? | T-P1, once `node_modules` exists. **Cannot be settled from disk here** — the repo is not installed in this checkout | P2.5 only |
| Q3 | `cfg.maxPoints = 3000`: is 60 000 samples per query (3000 times 20 series) an acceptable JSON and ClickHouse cost for a dashboard widget on the production cluster? | One timing run of §14.2's query at 3m/day against a populated gigapipe. If not, the fallback is `maxPoints = 2400`, and `3m` at `day` then coarsens to week | Before P2 ships; the value is a config default, not a design change |
| Q4 | Should `executeMetricAggregate` honour `report.metric` when reducing (so `metric: 'max'` implies reducer `max`) instead of always using the query's reducer? | Product call. Today the reducer is a property of the query, which I believe is right — but "max CPU over the window, as a bar per service" is a reasonable ask the current design cannot express | No — additive later |
| Q5 | Should `bar`/`pie` be offered at all for `avg`/`last`-reduced metric series, given percent-of-total is dimensionally wrong there (§10.1)? | Product call. The narrow answer is to offer them only when every series in the report has reducer `sum`, which the engine can compute and the picker can read | No — a picker rule, not an engine change |
| Q6 | Who builds the integration harness (testcontainers or a compose-backed vitest project), and in which phase? | Owner decision. T-G1 has a recorded-curl fallback so the D7 unknown is not blocked on CI work, but T-G8 (acceleration) is not meaningfully fakeable | Yes for T-G8; no for the rest |
| Q7 | `offsetGranularitySec` (§6.4, cut): is the week/month bucket skew in `Asia/Kolkata` and `Asia/Kathmandu` visible enough to a real user to justify the cross-work-stream API change? | Ship v1, then see whether anyone in a non-whole-hour zone reports it. Cheap to add later; expensive to carry now | No |

Draft questions now **closed on disk**, recorded so nobody reopens them: `mergeGlobalFilters`
already passes non-event items through (`reports.service.ts:29-41`) — no guard needed;
`packages/common` has **no** non-crypto string hash — add `fnv1a32`; the `ZodEffects` risk was a
Zod 3 fact on a Zod 4 repo (`pnpm-workspace.yaml:77`); `series_capped`'s threshold is exact under
phase A and needs no heuristic; `/export/charts` cannot express a metric series at any input.

---

## Effort

**Minimum shippable slice — "one gauge renders as a line chart through
`observability.metrics.chart`" (about 2 weeks):** `zMetricQuery` plus `refineMetricQuery` plus
`REDUCER_TABLE`; `compileMetricQuery` for the four gauge rows; `resolveGrid` / `resolveStep` /
`alignWindow`; the shaper including identity, reducers and D12 ordering; `executeMetricChart`;
the two one-line widenings in `format.ts` and `compute.ts`. No previous period, no ranking pass
(`groupBy` empty only), no histograms, no aggregate intent. `linear`, `area`, `metric`.

**Full P2 (about 5-6 weeks):** the whole §4.2 matrix; the two-phase ranking pass and pinning; the
aggregate intent including `previous`; previous-period shifting and pinning; notices; fan-out,
deadline and cancellation; self-observability; § Test requirements minus the P2.5 block. Of
these, the ranking pass and pinning (§8) are new work the draft did not contain at all, and they
are the riskiest single piece.

**P2.5 report adoption (about 2-3 weeks, separately schedulable):** the union member, the two
whitelist arms, `refineReportInput`, `executeReport` and seven call sites, the chart-type gate at
five more sites, the availability gate, rate limiting on the metric procedure, and the staged
release in §15.2.

**What makes it bigger:**

- **The integration harness (Q6).** There is none today. If T-G8 is required to gate merges, add
  1-2 weeks and a CI job. This is the single largest unpriced item, and the draft acknowledged
  "17.1 needs a running gigapipe" without pricing it.
- **`cfg.maxPoints` failing Q3.** Not a redesign, but it changes the interval-coarsening
  behaviour of every long chart and invalidates §6.4's table.
- **Widening `data[].count` to `number | null`** being pulled into v1 (D10). Seven renderers, the
  report table, the tooltip and the MCP shaper.
- **The tenancy schema landing separately from `compileAggregation`.** They must land together
  (§ Interfaces) or the build breaks in a way that looks like this work-stream's fault.
- **`04-read-path.md`'s six amendments being contested rather than accepted.** Amendments 4 and 5
  change numbers that document already asserts; if read-path's owner disagrees with the
  coarsest-step policy or with deleting the `maxSeries` guard, that is a design conversation, not
  an edit.
- **Fixing the `chartType: 'metric'` intent divergence** (§15.3) inside this work-stream rather
  than alongside it. It is a behaviour change to existing event reports and belongs in its own
  change with its own rollout.
