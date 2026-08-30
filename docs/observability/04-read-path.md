# The read path and gigapipe client

Everything between "a user opens a chart" and "gigapipe answers": a new workspace package
`@openpanel/gigapipe` holding the HTTP transport (route table, per-route time-unit
encoding, the tenancy gate, byte-capped streaming reads, error taxonomy, per-project
concurrency lease), an `observability.*` tRPC router in `packages/trpc` built on the
existing `protectedProcedure` with a share-link rejection, a direct-ClickHouse metadata
service that bypasses gigapipe entirely for metric-name/label enumeration because every
one of gigapipe's own metadata endpoints is untenanted, and a polled live-tail WebSocket
in `apps/api`. The design's three load-bearing constraints, all read out of the gigapipe
source this pass: the reader has **no** tenant input of any kind, so the only isolation is
the label matcher the tenancy layer compiles in and the response verification on the way
back; every time parameter has a **different unit per endpoint** and one of them is parsed
as `float64`, which makes exact-nanosecond log cursoring impossible and forces
overlap-and-deduplicate; and gigapipe queries the **same ClickHouse instance** the event
charts query, so a per-project concurrency lease, a step ladder, a fan-out limiter and a
runtime kill switch are correctness features, not polish.

Written against OpenPanel `main` @ `247744a8` and the gigapipe checkout at
`/Users/drew/projects/gigapipe`. Every `file:line` citation below was opened during this
pass; where an earlier draft's citation had drifted it has been re-anchored. Anything that
could not be settled from disk is marked **UNVERIFIED** with the exact command or query
that settles it.

---

## Revision note — cross-document settlements

This revision absorbs a cross-cutting review of all eleven specifications. Where this
document and a sibling disagreed, the disagreement is **settled here** rather than
deferred. Every settlement that changes a decision another document depends on is listed
below with the edit that document now owes; nothing in the table is a suggestion.

| # | The conflict | Settled as | Edits owed by other documents |
|---|---|---|---|
| 1 | `Report.dataSource` column vs. derivation | **Derivation.** `getReportDataSource(series)` (`03-metrics-engine.md` §15.1). There is no `Report.dataSource` column and no `DataSource` enum. D4 below is rewritten. | `08-schema-changes.md`: delete `DataSource` + `Report.dataSource` from S1, the inventory, the migration list, the sequencing table and the rollback table; retarget its nine-site whitelist inventory at the **series union member**. `09-ui-surfaces.md` D8: retarget the eight-write-path table the same way. |
| 2 | Four table-name helpers in four files | **One module: `packages/db/src/clickhouse/telemetry-client.ts`.** `t()` (read), `getTelemetryMutationTable()` (DDL/mutation), `TELEMETRY_IN`, `TELEMETRY_TABLES` (**unqualified values**), `telemetryDb()`, `isGigapipeClustered()`, `getTelemetryClient()`. D12 below is rewritten and `G()` is deleted. | `05-logs.md`: delete `packages/db/src/gigapipe/table-name.ts` and `gigapipeTable()`. `06-traces-and-correlation.md` §5: move its block to `telemetry-client.ts`, unqualify `TELEMETRY_TABLES`' values, drop its duplicate `g()`. `08-schema-changes.md` §11: adopt `GIGAPIPE_DB` and add the read helper. |
| 3 | Five retention numbers | **`10-ops-retention-billing.md` owns retention, per signal.** This document reads `TELEMETRY_RETENTION` from `@openpanel/constants`; `GIGAPIPE_RETENTION_DAYS` is deleted. D14 and §8.3 are rewritten. | `10`: rename the **object** export to `TELEMETRY_RETENTION` so it stops colliding with the scalar compose var `TELEMETRY_RETENTION_DAYS`. `06` §6.0: derive `TRACE_SEARCH_MAX_WINDOW_H` from `TELEMETRY_RETENTION.traces`. `08` §13: correct the worked example and its citation. `05` §5.1: `PLAN_DEFAULT_RETENTION_DAYS` becomes `TELEMETRY_RETENTION.logs`. |
| 4 | `LOG_DRILLDOWN` on vs. off | **Off.** `01-tenancy-and-security.md` D9 and D3 below both block the four drilldown routes, and `05-logs.md` I6 independently confirms the `QueryVolume` injection surface. `10`'s `LOG_DRILLDOWN=false` is correct. | `05-logs.md` D8: rewrite the first paragraph; `logs.labels` derives cardinality from §9's direct-ClickHouse metadata service, not from `/detected_labels`. |
| 5 | `topk` in the compiler | **Deleted.** `03-metrics-engine.md` D8 and `07-alerting.md` D4 are right and independently so. §8.2 is rewritten to 03's two-phase rank-then-pin. | `09-ui-surfaces.md` D4: rewrite the `limit` paragraph, which is currently justified by the `topk` wrap. |
| 6 | Three chart-response envelopes | **One: `MetricChartResult` (`03` D2), a structural supertype of `FinalChart`.** `IObservabilityChartResult` is deleted; its `resolution` fields become additional properties on `MetricChartResult`. D5 below is rewritten. | `09-ui-surfaces.md` D15: use 03's seven notice codes, not its own seven; D14's `compiled` is an explicit addition this document accepts (D5) and 03 must ratify. |
| 7 | Router namespace | **`observability.{metrics,logs,traces,status}`, one router, base procedure per D13.** New D17. | `05-logs.md` §5.3: fold `logsRouter` in. `03`: no `packages/trpc/src/routers/metrics.ts`. `01` §7.1: replace the `publicProcedure` sample with a pointer to §6.1 here. `09` Q1 and `11` Q1 close on this answer. |
| 8 | Interfaces consumed but not exposed | `verifyResponseLabels` and `compileAggregation(q, inner)` are **hard dependencies with no stub**. See § Interfaces. | `01-tenancy-and-security.md`: add both to its "Exposed" table with these signatures, add the third `extraMatchers?` parameter to `compileSelector`, and delete `compileGroupBy` (subsumed by `compileAggregation`). |
| 9 | Five env-var naming schemes | **`10-ops-retention-billing.md` §3.1's names win**, because they are the ones written into `.env.template`, `coolify.yml` and `quiz.ts`. §3 below now matches them. | `02` §15: `GIGAPIPE_INTERNAL_URL`/`GIGAPIPE_LOGIN` → `GIGAPIPE_URL`/`GIGAPIPE_USER`. `05`: delete `GIGAPIPE_READ_URL`/`GIGAPIPE_WRITE_URL`. `11` gate 1.7: rename. `10` §3.1: its cross-doc edit list is stale against this revision and should be re-derived from §3 below. |
| 10 | Five kill switches, two polarities | **One namespace, `telemetry:disabled:*`, presence means disabled**, with 04's read/ingest split and 02's TTL policy. D15 below is rewritten. | `01` §11: delete `telemetry:ingest:enabled`/`telemetry:read:enabled` (opposite polarity). `06` §15: delete `GIGAPIPE_TRACES_*_ENABLED`. `10` §10.3: publish the four keys in one operator table. |
| 11 | Three point budgets, two step algorithms | **`03-metrics-engine.md` owns the grid.** `resolveStepMs` is deleted from `src/units.ts`; `maxPoints` is 3000; interval coarsening is reported by 03's `interval_coarsened` notice, not by a second `effectiveInterval` channel. D9 and §4.3 are rewritten. | `09` Interfaces item 5: 8 000 → 3 000. |
| 12 | Four capability surfaces | **One: `observability.status`**, extended with `blocked`. New D18. | `09`: rewrite `telemetry.capabilities` to `observability.status`. `05` D12: derive `telemetryEnabled` from it. `06` §15: `signals.traces` is not env-flipped. |
| 13 | `packages/gigapipe` vs `packages/db/src/gigapipe` | **`packages/gigapipe`** (D1), **minus** the ingest rows: `02-ingest-gateway.md` D9's `apps/api/src/telemetry/` placement is better argued and this document does not defend its version. D1's layer table is corrected. | `05-logs.md`: rewrite its file table. `11`: unblock Q1. |
| 14 | Migration 22 pre-creates gigapipe's tables vs. §11's "no DDL" | **08/10 win.** PARTITION BY cannot be `ALTER`ed and both tables are `CREATE TABLE IF NOT EXISTS`, so per-signal retention is impossible without the pre-create. §11's first bullet is rewritten. | none — this document was the one contradicting `08` S6 and `10` D4. |
| 15 | Live tail in P3 (here) vs. P6 (`05` D5) | **`05` D5 wins for phasing**: a `refetchInterval` Follow toggle in P3, the WebSocket tail in P6. §10's design stands as the P6 design of record, including its re-authorisation and hard lifetime. The 1.0 w row moves out of the P3 total. | `05` D5: keep, and cite §10 here as the P6 design rather than specifying a second one. |

Three findings are **rejected or reassigned** rather than absorbed; each says so at the
point of the decision it touches: the aggregate ClickHouse ceiling stays with ops (§8),
`/api/metrics` authentication stays with ops (§11) and is **not** owned here despite
`01-tenancy-and-security.md` § Detection(e) claiming it is, and the P6 MCP tool surface
has no owner in any document (§11).

---

## Decisions

### D1. The client is a workspace package, `packages/gigapipe`, not `packages/db/src/gigapipe/`

Three sibling drafts disagree. `03-metrics-engine.md:2113` and `05-logs.md:1093,2131`
place the shared HTTP client at `packages/db/src/gigapipe/`; `05-logs.md` open question 9
(`:2227`) defers the choice; `01-tenancy-and-security.md:542-549` places the compilers,
the label primitives, the vendored `.proto` files and the outbound client at
`packages/gigapipe/`.

**Chosen: `packages/gigapipe`, one package, three layers, three owners.**

| Layer | Owner | Files |
|---|---|---|
| Tenancy / query construction | tenancy work-stream | `src/labels.ts`, `src/query/promql.ts`, `src/query/logql.ts`, `src/query/traceql.ts`, `src/query/verify.ts` |
| Transport / read mechanics | **this work-stream** | `src/config.ts`, `src/transport.ts`, `src/routes.ts`, `src/errors.ts`, `src/types.ts`, `src/lease.ts`, `src/units.ts`, `src/killswitch.ts`, `src/read/prometheus.ts`, `src/read/loki.ts`, `index.ts` |

**Correction, settlement 13: the ingest codecs are not in this package.** The previous
version of this table assigned `src/ingest/*.ts` and `vendor/opentelemetry-proto/**` to the
ingest work-stream *inside* `packages/gigapipe`. `02-ingest-gateway.md` D9 puts all of it in
`apps/api/src/telemetry/` — one directory, one Prisma seam in `deps.ts`, so a later lift-out
is a `git mv` — and argues the placement at length. This document never defended its
version, so 02 wins. `packages/gigapipe` contains **no** protobuf decoding, no vendored
`.proto` tree, and therefore no `protobufjs`/`long` dependency at all; reason 1 below gets
*stronger*, not weaker, because the package now has nothing heavy in it in the first place.
The only ingest-shaped thing that stays here is the five **write route keys** in
`GIGAPIPE_ROUTES` (§4.1), which are route-table data, not codecs.

**The ClickHouse-side pieces are not in this package either.** `telemetryDb()`,
`TELEMETRY_TABLES`, `t()`, `getTelemetryMutationTable()`, `TELEMETRY_IN`,
`isGigapipeClustered()` and `getTelemetryClient()` live in
`packages/db/src/clickhouse/telemetry-client.ts` (D12), because they need the existing
ClickHouse client machinery and `packages/gigapipe` must not depend on `@openpanel/db`.

Reasons, in order of weight:

1. **Dependency direction.** `packages/db` is imported by `apps/api`, `apps/worker`,
   `packages/trpc`, `packages/mcp` and the importer. Putting the client in
   `packages/db/src/gigapipe/` drags `protobufjs`, `long` and a vendored
   `opentelemetry-proto` tree — the ingest half, which shares that directory in
   `05-logs.md`'s layout — into every one of them. `packages/gigapipe` depending on
   `@openpanel/constants` + `@openpanel/logger` + `@openpanel/redis` +
   `@openpanel/validation`, and `packages/db` depending on `@openpanel/gigapipe`, is
   acyclic and keeps the ingest surface out of the worker's graph.
2. **The security argument is a totality argument.** `01-tenancy-and-security.md:234-236`
   rests the phase-1 tenancy case on "there is exactly one function in the system that
   emits a `{`". That is auditable and CODEOWNER-able at package granularity. Inside
   `packages/db` — 40-plus service files, a ClickHouse client, a Prisma client — it is not.
3. **The metadata half genuinely belongs in `packages/db`**, because it is ClickHouse SQL
   and needs `chQuery` (§9). Splitting on "HTTP to gigapipe, or SQL to ClickHouse?" puts
   each half where its dependencies already live.

**Rejected: `packages/db/src/gigapipe/`.** Smaller diff, and it is where `chQuery` lives.
But §9 does not need the HTTP client and the HTTP client does not need ClickHouse; the
coupling is illusory.

**Rejected: two packages** (`gigapipe-client` + `gigapipe-query`). The D2 gate only works
if the verifier and the socket write sit behind one function call. A package boundary
between them makes the gate advisory.

**Ratified, not open.** `11-testing-strategy.md` Q1 calls this blocking "before anyone
writes a test file" and `09-ui-surfaces.md` Q1 calls it blocking for the UI; both are
answered by this decision plus D17. The P0 owner records it in `00-blueprint.md` and does
the mechanical sweep of `03-metrics-engine.md:2113` and `05-logs.md`'s file table
(`logql.ts`, `client.ts`, `envelope.ts`, `severity.ts`, `logs.ingest.ts`, `logs.parse.ts`,
`retention.ts`, `cardinality.ts`) to `packages/gigapipe/src/...` in **one commit**, before
P2.1. `05-logs.md`'s `table-name.ts` is not swept — it is deleted (D12). Do not ship both
layouts. This is no longer an open question; Q1 below is closed.

### D2. Selector declaration is **route-table data**, never a caller-supplied field

The previous draft put `selectorParams?: string[]` on the *request* and had the transport
verify the params the caller named. That is not a gate: a read function that passes
`selectorParams: ['start']` while smuggling a selector into `match[]`, or that names the
wrong key, sails through and opens the socket. It is exactly the advisory gate D1's
"rejected: two packages" exists to avoid.

**Chosen:** every route in `GIGAPIPE_ROUTES` declares `dialect`, `selectorParams` (the
keys the *route* treats as selectors) and `knownParams` (every key the route accepts).
`transport.ts` reads both **from the route**, never from the request, and:

- if `dialect === null`, requires `selectorless: true` and a `why: string`;
- otherwise requires every key in `route.selectorParams` to be present and non-empty in
  `req.query`/`req.form`, and runs `verify[dialect](value, projectId)` over **every element**
  of every one of them;
- rejects any key present in `req.query` or `req.form` that is not in `route.knownParams`.

`selectorParams` is deleted from `GigapipeRequest`. Adding an endpoint without a
declaration does not compile, because `GIGAPIPE_ROUTES` is `as const` and the route
record's type requires the fields.

The selector-bearing parameter set is wider than "a parameter named `query`", and wider
than the previous draft said. `ParseLogSeriesParamsV2` **unions `query` into `match[]`**:

```go
// reader/controller/query_labels.go:123-130
res.Raw.Match = append(res.Raw.Match, r.URL.Query()["match[]"]...)
if len(r.URL.Query()["query"]) > 0 { res.Raw.Query = r.URL.Query().Get("query") }
res.Match = res.Raw.Match
if res.Raw.Query != "" { res.Match = append(res.Match, res.Raw.Query) }
```

so `/api/v1/label/{n}/values`, `/loki/api/v1/label/{n}/values` and `/loki/api/v1/series`
take **both** `match[]` and `query`, and both widen the result.
`/loki/api/v1/index/stats` takes `query` and returns global stats when it is empty
(`reader/controller/query_range.go:248-278`).

For `match[]` the rule is stronger than per-element verification, because appending an
element **widens**: `getMultiMatchValuesPlanner` (`reader/service/query_abels.go:242-262`)
combines one fingerprint planner per element under a `MultiStreamSelectPlanner`, i.e. a
union. So the rule is **emit exactly one element across the union of `match[]` and
`query`, which we constructed**, then verify it.

### D3. Metric names, label keys and label values come from ClickHouse directly, and the proxy routes are not in the route table at all

Seven findings, all read this pass:

1. **`GET /api/v1/metadata` has no tenant filter and no time bound** — `SELECT
   JSONExtractString(labels,'__name__'), metadata FROM time_series WHERE metadata != ''`
   plus an optional exact-name equality (`reader/service/metadata.go:39-62`). Proxying it
   hands every project every other project's metric names and help strings.
2. **`GET /loki/api/v1/labels` hardcodes `match = nil`** —
   `q.QueryLabelsService.Labels(internalCtx, start, end, 1, nil)`
   (`reader/controller/query_labels.go:39-40`). There is no parameter through which it
   could be scoped.
3. **`GET /api/search/tags` is `SELECT DISTINCT key FROM tempo_traces_kv`** with no tenant
   and no time predicate (`reader/service/tempo.go:161-172`).
4. **The label endpoints lose rows silently.** `GenericLabelReq` `break`s out of its scan
   loop on a scan or marshal error (`reader/service/query_abels.go:62,67`) and still emits
   a well-formed `{"status":"success","data":[…]}`. A truncated answer is
   indistinguishable from a complete one.
5. **They hardcode `Limit: 10000`** with no paging (`query_abels.go:220,292`).
6. **`Prom2LogqlMatch` calls `panic(err)`** on a `match[]` the Prometheus parser rejects
   (`query_abels.go:165`), recovered by `tamePanic` into a plain 500.
7. On the **GET** path `getLabelsParams` defaults *both* `start` and `end` to `now-6h`
   (`reader/controller/prom_query_labels.go:202-203`) — a zero-width window — while the
   POST form path defaults `end` to `now` (`:196-197`). A `GET /api/v1/labels` with no
   explicit times returns an empty list, always.

**Chosen:** §9's direct ClickHouse queries, and `promSeries`, `promLabelValues`,
`lokiLabelValues` are **removed from `GIGAPIPE_ROUTES`** and from `src/read/prometheus.ts`.
The previous draft kept them "because the parity test needs both sides"; there is no
parity test, and the only test that touches those endpoints (T52) deliberately asserts
their *untenanted* behaviour and therefore must use a raw `fetch`, bypassing the client —
that is the point of it. Keeping three unused route keys alive is keeping three routes
that carry findings 4-6 including a `panic`.

**The four `LOG_DRILLDOWN` routes are blocked too, and that settles a live conflict
(settlement 4).** `/loki/api/v1/index/volume`, `/detected_labels`, `/detected_fields` and
`/patterns` are registered inside a single `if …LogDrilldown` block
(`reader/router/query_range.go:25-33`, env read at `cmd/gigapipe/main.go:241-243`), so they
are one switch, not four. `01-tenancy-and-security.md` D9 blocks all four from the
allowlist and `05-logs.md` I6 independently identifies the injection surface — `QueryVolume`
string-interpolates `targetLabels` into a query and re-parses it. Two of them are also
untenantable by the same argument as finding 2: `QueryDetectedLabels` accepts `query == ""`
and simply skips parsing (`reader/service/query_range.go:222-240`), which `05-logs.md` I7
records itself.

So none of the four is in `GIGAPIPE_ROUTES`, `10-ops-retention-billing.md`'s
`LOG_DRILLDOWN=false` is **correct**, and `05-logs.md` D8's first paragraph
("`LOG_DRILLDOWN=true` in every deployment") is overruled. `05-logs.md`'s `logs.labels`
procedure gets its label list and its cardinality hint from §9.2/§9.3 here — a
`uniqExact(fingerprint)` per key over `time_series_gin`, which is the same number
`/detected_labels` reports and is a sort-key prefix seek — not from a proxied endpoint. The
settings card's "top-10 label cardinality" is the same query with `LIMIT 10`.

`time_series_gin` has `ORDER BY (key, val, fingerprint, type)` (`ctrl/qryn/sql/log.sql:122-124`),
so `key = 'op_project_id' AND val = <pid>` is a sort-key prefix seek — for the
fingerprint subqueries the direct query is also the faster one. That is **not** true of a
`SELECT DISTINCT key … WHERE fingerprint IN (…)`, which filters the third sort-key column
with the first two unbounded; §9.2 is therefore restructured to read label keys out of
`time_series.labels`, whose sort key **is** `fingerprint` (`log.sql:115-117`).

### D4. Ship as a sibling `observability.*` router; do not branch inside `chart.chart` yet — and there is **no `Report.dataSource` column**

`chart.chart` is `chartProcedure.use(cacher)` wrapping three lines of report/input merge
plus `ChartEngine.execute` (`packages/trpc/src/routers/chart.ts:588-611`). Branching there
needs a discriminator that survives the wire, and today it does not:

- `zReportInput` is a plain `z.object()` (`packages/validation/src/index.ts:233`), so zod
  **strips** any unknown top-level key. A frontend that "already sends everything" does not
  reach the resolver.
- `ctx.report` is `null` for every authenticated in-app query (`chart.ts:137-141`), so
  nothing stored can drive the branch on the live path either.

**Settlement 1 — the discriminator is derived, not stored.** The previous version of this
decision priced a `Report.dataSource` column at "three write sites plus one read mapper",
and `08-schema-changes.md` S1 and `09-ui-surfaces.md` D8 built a migration, an enum, a
sequencing row, a rollback row and an eight-write-path table on top of that price.
`03-metrics-engine.md` §15.1 rejects the column and is right on the merits:

- The discriminator **already arrives on the wire** as the `type: 'metric'` member of the
  `zReportInput.series` union. 08's own argument for the column — "the discriminator has to
  arrive from the browser regardless" — is therefore satisfied without one.
- A Postgres enum is an irreversible migration. `DataSource { events metrics }` buys a
  denormalised copy of a fact the row already carries, and a copy that can *disagree* with
  the series it describes is strictly worse than no copy: `duplicate_report`'s inline
  `data: {}` literal (`packages/mcp/src/tools/dashboard-management.ts:488-506`) would
  silently write the column default `events` onto a duplicated metric report, which is
  exactly the corruption class 09 D8 exists to prevent.
- Dispatch is one helper: `getReportDataSource(series)` in
  `packages/db/src/engine/data-source.ts`, on `series.some(s => s.type === 'metric')`.
  `Report.dataSource` as an identifier exists nowhere in either repository today.

**So: no migration, no enum, no column.** `08-schema-changes.md` must drop `DataSource` and
`Report.dataSource` from S1, its inventory (P2/P3 rows), its migration list, its sequencing
table and its rollback table. Its nine-site whitelist inventory and `09-ui-surfaces.md`
D8's eight-write-path table are **correct and valuable work** — the sites really do all need
auditing — but their subject is the **series union member**, not a column: the question at
each site is "does this write path preserve a `type: 'metric'` series through
`transformReportEventItem`?", not "does it copy a column?". `03-metrics-engine.md` D1's
data-loss argument (`transformReportEventItem` rewrites every non-formula item and
`report.update` writes it straight back) is the reason those sites matter, and it is a
series-shape hazard, not a column hazard.

The union-member work belongs to the metrics-engine work-stream (`03-metrics-engine.md`
owns `zMetricQuery`, `transformReportMetricItem` and `getReportDataSource`). This
work-stream ships `observability.metrics.chart`; `chart.chart` delegates in one line at
P2.5 once the union member and its release-N soak have landed.

**Ordering note for `09-ui-surfaces.md`.** 09's Effort leads with P2a — the persistence
plumbing and the §7.2 union audit, which 09 itself calls "the largest single risk … eight
files of casts the compiler will not help with, in the middle of the report editor, which
has no tests" — *ahead* of the explorer. That inverts both sibling specs: this decision and
`03-metrics-engine.md` §15 both file report adoption as P2.5, separately schedulable, after
an engine that something has actually exercised. The order that follows from this document
is P2a′ (`data` prop) → P2a″ (shared-component fixes) → P2b (explorer, which proves the
engine end to end through `observability.metrics.chart`) → P2c (settings/token/snippet) →
P2.5 (persistence and the eight write sites). 03 §15.2's release-N pass-through arms should
ship on day one of P0 so the soak clock is already running when P2.5 starts.

**Direct consequence: the public share path is out of scope for `observability.*` in every
phase.** No stored report can hold a metric series in P2, so "a shared metric report" is not
constructible; and independently of that, logs and traces must never be shareable. The base
procedure **hard-rejects** `shareId`; it never falls back to `input`. See §7.2.

**But `observability.*` is not the whole share surface, and nobody owns the rest.**
`09-ui-surfaces.md` D5 routes *saved* metric reports through `chart.chart` — i.e.
`chartProcedure`, a `publicProcedure` that serves anonymous viewers whenever `shareId` is
present — and `03-metrics-engine.md` §15 (P2.5) makes that the plan of record. This
document's share rejection does **not** cover that path, and the guarantee "telemetry is
never share-reachable" evaporates the moment P2.5 ships. The exposure is concrete and
verified: `packages/trpc/src/trpc.ts:206-211` keys the 60 s response cache on
`` `trpc:${path}:` `` plus `JSON.stringify(getRawInput())` with **no user component**, and
09 §6 confirms `chart.chart` merges caller-supplied `range`/`startDate`/`endDate`/`interval`
over `ctx.report`. One public share link therefore gives an unauthenticated caller window
control, cache-key control and an unmetered, unrate-limited query generator against a single
Go process with a hardcoded non-configurable 30 s PromQL timeout and one global
`MaxSamples` budget shared across every tenant
(`reader/router/prometheus_query_range.go:31-32`). That is cross-tenant denial of service
requiring no credential.

**Requirement on whoever owns P2.5** — `03-metrics-engine.md` §12.5 already states the first
half of this as "a hard prerequisite"; `09-ui-surfaces.md` §6 currently requires only a
wind-down/quota check. All four must be in one document before the metric series union
member reaches `zReportInput`:

1. `01-tenancy-and-security.md` §7.1's four-field window allow-list (`range`, `startDate`,
   `endDate`, `interval`) with an explicit `isMetricReport(ctx.report)` rejection and **no**
   fallback to `input.series`, `input.filters` or `input.breakdowns`.
2. `rateLimitMiddleware` keyed on `shareId` + trusted IP on **every** share-served chart
   procedure, not only the metric one — an event chart on the same link is the same cache
   and the same ClickHouse.
3. A separate `withProjectLease` bucket for share traffic (§8.4), as `07-alerting.md` D15
   does for alert evaluation, so anonymous readers cannot consume the authenticated budget.
4. A Tier-1 test that a share link cannot vary `series`, `filters` or `breakdowns`.

Until that document exists and those four ship, P2.5 does not ship. This work-stream's
contribution is the statement of the requirement and the kill switch (D15).

### D5. `metrics.chart` returns `MetricChartResult` — one envelope, owned by the metrics engine

`FinalChart` is exactly `{ series: IChartSerie[]; metrics: Metrics }`
(`packages/validation/src/types.validation.ts:106-109`), and adding a field to it destroys
the structural-assignability property the whole plan rests on. That property is preserved,
but **not** by the wrapper this document used to specify.

**Settlement 6.** Three documents specified three envelopes for one procedure: this one's
`IObservabilityChartResult { chart, resolution }`, `03-metrics-engine.md` D2's
`MetricChartResult = FinalChart & { notices }`, and `09-ui-surfaces.md` D14/D15's
`{ series, metrics, notices, compiled }`. 03 owns the engine's return type and its
structural-supertype approach is strictly better than a wrapper: it preserves this
document's stated property (a renderer can be handed the value untouched) **without**
editing `FinalChart` and **without** an unwrapping step at every call site.

**Chosen: `MetricChartResult`, with this document's `resolution` fields merged in as
additional properties rather than a second envelope.**

```ts
// owned by 03-metrics-engine.md — packages/db/src/engine/metrics/notices.ts
export type MetricChartResult = FinalChart & {
  notices: MetricNotice[];
  /** Added by this work-stream; 03 must ratify. See below. */
  resolution: {
    stepSec: number;
    /** The interval actually used. Coarsening is REPORTED BY the notice, not by a diff. */
    interval: IInterval;
    /** For the signal this procedure serves. Per-signal, from TELEMETRY_RETENTION (D14). */
    oldestQueryableAt: string;
  };
  /** 09 D14. Populated for every caller, because every caller is authenticated (§7.2). */
  compiled?: string;
};
```

Three consequences, each of which retires something this document or a sibling used to say:

1. **`requestedInterval`/`effectiveInterval` are gone.** They were a second mechanism for
   the fact 03's `interval_coarsened` notice already carries, with `asked` and `used` in its
   meta (`03-metrics-engine.md` D2). Two channels for one fact is how a UI ends up rendering
   it twice or neither. D9 below is rewritten accordingly.
2. **`previous: 'ok' | 'unavailable_retention' | 'not_requested'` is gone.** 03's
   `previous_period_unavailable` notice carries a `reason`, and `retention` is a value of it.
   F19's behaviour is unchanged; only the channel is.
3. **The notice code set is 03's seven**, not a fourth invention:
   `series_capped`, `interval_coarsened`, `rate_window_widened`, `increase_window_pinned`,
   `gaps_filled_with_zero`, `non_finite_samples_dropped`, `previous_period_unavailable`.
   `09-ui-surfaces.md` D15 lists a different seven (`dst_bucket_drift`, `window_clamped`,
   `interval_widened`, `rank_window_truncated`, `series_filled`, `series_limited`, plus one
   overlap) and asserts that "`03` D7 adds `notices?` to `FinalChart`" — which is the
   opposite of what 03 D2 decided. 09 must be rewritten to 03's list and to
   `MetricChartResult`.

**On `compiled` (09 D14), this document's position.** Returning the compiled PromQL is
accepted for `observability.metrics.chart`, unconditionally, because §7.2 hard-rejects
`shareId`: **every** caller of this procedure is an authenticated project member, so D14's
rule "populate only when `ctx.report === null`" is vacuously true here and needs no
conditional. It is not vacuous on `chart.chart`, where D14's rule is correct and must be
implemented as written when P2.5 lands. The consequence for 09's test table is in §Test
requirements (T25 already covers it) and is noted for 09 in settlement 6: 09's T9, which
asserts the omission on a `shareId` request, cannot fire against `observability.*` because
the router refuses that request before the resolver runs — it should assert the
**rejection** instead, and 09 should record that its F12 is unreachable rather than
mitigated until the share path is actually enabled.

`observability.status` still carries every fact that is about the *deployment* rather than
the request — schema-not-ready, gigapipe-down, an insecure backend, the kill switch, the
retention windows (D18). `resolution.oldestQueryableAt` is duplicated onto the chart
response only so a dashboard tile that never fetched `status` can still render the
retention edge in one round trip.

`logs.histogram` returns the same type. The type is exported from
`packages/db/src/engine/metrics/notices.ts`, not from `packages/gigapipe`, because 03 owns
it; this document imports it.

### D6. Live tail is a server-side poll, not a proxy to `/loki/api/v1/tail` — and it ships in **P6**, not P3

gigapipe's `Tail` is itself a ClickHouse poll, so proxying buys no latency. Proxying also
means holding a second WebSocket per browser tab, mirroring `watcher.Close()` semantics
(`reader/controller/query_range.go:196-222`) to avoid leaking a goroutine per abandoned
tab, and — worst — carrying a LogQL string into `logql_transpiler.Transpile` through a
path where the D2 gate cannot run, because `Tail` reads `query` straight off the URL. So
whenever a live tail exists, it is a server-side poll pushed down a fifth
`@fastify/websocket` route, and §10 is its design.

**Rejected: SSE.** `apps/api` already has four WebSocket routes with an established
session-auth shape (`apps/api/src/routes/live.router.ts:8-29`); a fifth is free, a second
streaming transport is not.

**Settlement 15 — the phase, which this document had wrong.** `05-logs.md` D5 rejects a
bespoke tail *for P3* in favour of a Follow toggle that sets `refetchInterval: 5000` on the
newest page, and defers the WebSocket tail to P6, arguing that the bespoke tail "is a
scaling answer to a load nobody has yet". That argument is right and this document
previously specified a competing P3 tail with a *different* cursor design, different
re-authorisation and different socket caps — two careful designs for one stream, which is
worse than either.

**Chosen: 05 D5's phasing, this document's design.** P3 ships the Follow toggle and no
WebSocket. §10 stays in this document as the **P6 design of record**, because it carries two
properties 05's deferred sketch does not and which are not optional for a stream that §7.2
argues "must never leave an authenticated context — user emails, tokens, stack traces,
request bodies": **periodic re-authorisation every 60 s** and a **hard 30-minute socket
lifetime**. Every existing socket in `apps/api` authorises once at open
(`live.controller.ts:56-95`); a log tail must not. Whichever cursor design survives to P6
must also keep D16's overlap-and-dedupe, because that is a property of the server, not of
the design.

Consequence for the schedule: the 1.0 w tail row moves out of this work-stream's P3 total
into a P6 line (§ Effort). `05-logs.md` D5 should cite §10 here as the P6 design rather
than specifying a second one.

### D7. The tail does **not** use Redis pub/sub; the `publisher.ts` refcount bug is a separate PR

The previous draft made a pub/sub "nudge" (ingest publishes `telemetry.logs`, the tail
polls immediately) part of P3, which dragged in a cross-work-stream contract with the
ingest gateway's hot path *and* made a `packages/redis` bug fix a hard prerequisite. The
nudge buys at most one poll interval — 2 s — on a pane that already backfills 30 s on
open. Nobody watching a log pane can tell.

**Chosen: cut the nudge from P3.** The tail is a plain 2 s poll and subscribes to nothing.
Revisit if anyone complains.

The bug is real and reproduces on `main` today: `subscribeToPublishedEvent`
(`packages/redis/publisher.ts:44-68`) calls `getRedisSub().subscribe(channel)` per call and
`getRedisSub().unsubscribe(channel)` per teardown on one shared connection, so with two
browser tabs on the visitors page — `wsVisitors` (`apps/api/src/controllers/live.controller.ts:41`)
and `wsProjectEvents` (`:88`) both subscribe to `events:batch` — the first `close`
unsubscribes the channel out from under the second. It ships as its own ~40-line PR
against `packages/redis` on its own merits, not on this work-stream's critical path, and
its regression test (T32) is a `packages/redis` test.

That PR must do three things, not one:

1. Refcount per channel: `Map<channel, {count, unsubscribeChain}>`.
2. **Serialise subscribe/unsubscribe per channel.** Both calls are un-awaited today
   (`publisher.ts:52,66`), so an open→close→open interleaving can drive the count 1→0→1 and
   fire `unsubscribe()` while the first `subscribe()` promise is still pending; if the
   unsubscribe lands after the second subscribe resolves, the channel is left unsubscribed
   with a refcount of 1 and the second socket receives nothing, forever, silently. A
   refcount **without** serialisation exposes this race rather than removing it. Chain
   every transition on a per-channel promise.
3. Route all dispatch through a single `on('message')` installed once plus a
   `Map<channel, Set<callback>>`. Today every subscriber adds its own listener to one
   ioredis connection (`publisher.ts:63`); Node's default `maxListeners` is 10, so the
   eleventh concurrent socket emits `MaxListenersExceededWarning`.

**Rollback:** the PR changes no call site (the signature does not move) and touches one
file, so `git revert` restores current behaviour exactly. It is safe to ship before the
tail and safe to revert after.

**Schedule note.** Because it blocks on nothing in gigapipe, this PR belongs in the P0
"repo readiness" lane a second engineer can run concurrently with P0 — alongside
re-enabling `pnpm typecheck` in CI (commented out at
`.github/workflows/docker-build.yml:124-128`, and that file is the repository's only
workflow), landing the `FinalChart` contract test against the **event** engine, shipping
`03-metrics-engine.md` §15.2's release-N pass-through arms so the soak clock starts on day
one, and `09-ui-surfaces.md`'s P2a′/P2a″ component fixes. None of those touches gigapipe;
serialising them behind it is what makes the critical path single-threaded when it need not
be.

**Rejected: a parallel `subscribeShared()` API.** Two subscription functions with
different lifetime semantics on one connection is how the bug comes back.

### D8. Cost is metered per **chart**, and the fan-out inside the lease is itself bounded

A legal six-series metric report with `previous: true` is twelve `query_range` calls. A
per-HTTP-call lease with a cap of 4 returns `TOO_MANY_REQUESTS` deterministically on every
multi-series chart from day one. So the lease is acquired once in the procedure and
released in a `finally`, and the twelve calls run inside it.

But a per-chart lease with `maxConcurrencyPerProject: 4` permits 4 × 12 = 48 concurrent
`query_range` calls for one project, each picking a ClickHouse node at random on the
instance the event charts use (`reader/registry/static.go:33-38`). The fan-out is the
unbounded part. So the `Promise.all` over series × periods runs behind a small
`FANOUT_CONCURRENCY` limiter (default 4, `GIGAPIPE_FANOUT_CONCURRENCY`), which caps one
project at `maxConcurrencyPerProject × FANOUT_CONCURRENCY` = 16 in-flight upstream calls.

### D9. The grid belongs to the metrics engine; this work-stream owns the ladder's **constraints**, not the algorithm

The constraints are real and come from source: gigapipe floors `start` and ceils `end` to a
15 s boundary (`reader/controller/prom_query_range.go:55-56`) and rejects
`(end-start)/step > 11000` with a **500** (`:65-71`); OpenPanel's finest interval is
`minute` (`packages/constants/index.ts:236-242`); and a step that does not divide the target
calendar bucket exactly makes the shaper fold points across every hour and day seam. So the
step must come from a ladder whose every value divides 60, 3600 and 86400.

**Settlement 11 — but this document must not implement it.** The previous version shipped
`resolveStepMs(interval, rangeMs)` in `src/units.ts` with `TARGET_MAX_POINTS = 1_500` and a
find-**first**-fitting loop, while `03-metrics-engine.md` §6.1 ships `resolveStep(interval,
spanSec, maxPoints)` in `packages/db/src/engine/metrics/grid.ts` walking
`MAX_SUB_BUCKET[interval]` — the **coarsest** sub-bucket — at `maxPoints = 3000`. Three
observations settle it in 03's favour:

1. The find-first loop contradicted this document's own worked example (30 d at `hour`
   was documented as a 3600 s step; the loop returns 1800) and costs 2-4× the points for
   zero display benefit, because the shaper folds sub-buckets into calendar buckets anyway.
2. 1 500 is too low for an ordinary chart: at `maxPoints = 1500` the `day` ceiling of 3600
   caps a daily chart at 62.5 days, so `range: '3m', interval: 'day'` would coarsen to
   weekly for no reason. 3 000 covers 3m/day (2 208) and 90d/hour (2 160) exactly and stays
   far below gigapipe's 11 000.
3. The grid is not just a step. It is also alignment (`fromSec % stepSec === 0`, without
   which the series comes back **blank, not wrong** — `03` D7), the dense project-local
   bucket array, the Monday-week rule and the DST fold. Those all live with the shaper.

**Chosen:** `resolveStepMs` and `TARGET_MAX_POINTS` are **deleted** from
`packages/gigapipe/src/units.ts`. `src/units.ts` keeps `encodeTime` and `encodeStep` — the
per-route unit encoding, which is genuinely transport — and nothing else. `cfg.maxPoints`
becomes **3000** in `GigapipeConfig` (§3), which is where 03 §5 reads it from.
`STEP_LADDER_SEC` and `MAX_SUB_BUCKET` are 03's constants, not this document's; the
requirement this document places on them is one line and is testable: **every ladder value
must divide 86 400 exactly and be a multiple of 15**, the first so the calendar fold is
whole-bucket, the second so gigapipe's 15 s snap is a no-op on our boundaries.

**Coarsening is reported once, by 03's `interval_coarsened` notice** (D5), which carries
`asked` and `used`. This document no longer defines `effectiveInterval` and no longer
carries a requested/effective pair on the response. Rejecting with `BAD_REQUEST` remains
the wrong alternative for the reason it always was: `range: '30d' + interval: 'minute'` is
server-accepted today (only the UI blocks it, via `isMinuteIntervalEnabledByRange`,
`packages/constants/index.ts:281-285`), and turning an accepted input into an error is a
regression for anything that saves one.

`09-ui-surfaces.md` Interfaces item 5 cites "an 8 000-point engine ceiling under gigapipe's
11 000". There is no 8 000 anywhere; the number is **3 000** and 09 should be corrected.

### D10. `observability.status` never throws **for an authorized caller**

It is the one procedure whose job is to answer "is any of this working?". If it throws
when `GIGAPIPE_URL` is unset, the dashboard shell renders an error card instead of
"observability is not configured". Every *backend* branch inside it is wrapped and its
return type has no error variant, only booleans and nulls.

The previous draft stated this absolutely. It is not absolute: the base procedure throws
`UNAUTHORIZED` with no session and `FORBIDDEN` with no project access, before the handler
runs. The dashboard shell must therefore treat `UNAUTHORIZED`/`FORBIDDEN` from `status`
as "not my project / not signed in" and render nothing, not an error card — the same way
it already treats those codes elsewhere. Everything downstream of the access check is
wrapped.

### D11. Trace read procedures are **not** in this work-stream's endpoint list

`06-traces-and-correlation.md:1466-1474` amends the previous version of this spec: trace
search and the waterfall go to ClickHouse directly, not through gigapipe's reader. **The
amendment is accepted**, and this pass produced two independent confirmations:

- `GET /api/traces/{traceId}` has **no project predicate at all** — `GetQueryRequest`
  filters on `trace_id` plus optional time and nothing else (`reader/service/tempo.go:53-89`),
  with a hard `LIMIT 2000`. Given a trace id it returns another project's spans.
- `GET /api/search` with an empty `q` falls through to a **tag** search
  (`reader/controller/tempo.go:417-424`), which takes a logfmt `tags` string and is not
  TraceQL — so a bug that dropped `q` would silently downgrade to an untenanted query.

`src/read/tempo.ts` is therefore **not created**. What this work-stream still owns for
traces: the base procedure, the concurrency lease, `observability.status.signals.traces`,
and the ClickHouse scoping/grants section (§9.6) the trace queries reuse.

### D12. One module names gigapipe's tables: `packages/db/src/clickhouse/telemetry-client.ts`

**Settlement 2, and it was the worst of the set.** Four documents specified four helpers, in
four files, reading four different env vars, and two of them exported the *same symbol name*
with different value shapes:

| Where | Symbols | Database from | Cluster from |
|---|---|---|---|
| this document, previously | `TELEMETRY_DB`, `TELEMETRY_TABLES` (unqualified), `G()` in `clickhouse/client.ts` | `TELEMETRY_CLICKHOUSE_DATABASE` | `GIGAPIPE_CLUSTER_NAME` |
| `06` §5 | `TELEMETRY_DB`, `TELEMETRY_TABLES` (**pre-qualified**), `getTelemetryMutationTable()`, `TELEMETRY_IN` in the same file | `GIGAPIPE_DB` | `GIGAPIPE_CLUSTER` |
| `05` §7.2 | `gigapipeTable(name, 'read'\|'mutate')` in `db/src/gigapipe/table-name.ts` | `GIGAPIPE_DB` | OpenPanel's own `isClickhouseClustered()` |
| `08` §11 | a third `TELEMETRY_TABLES` (unqualified), `telemetryDatabase()`, `getTelemetryClient()` in `clickhouse/telemetry-client.ts` | `CLICKHOUSE_TELEMETRY_URL` / `CLICKHOUSE_TELEMETRY_DB` | *(none)* |

**Chosen: `packages/db/src/clickhouse/telemetry-client.ts` is the single home**, because it
is the only one of the four that is lazy, memoised and pins a single ClickHouse node —
which the DDL and mutation paths require and neither of the other candidates provides. It
absorbs 06's `getTelemetryMutationTable()` and `TELEMETRY_IN`, and this document's read-side
`_dist` suffix. §9.0 below is the resulting module.

Four rules, each of which deletes something:

1. **`G()` is deleted.** The read helper is `t(key)` (`10-ops-retention-billing.md` §3.1
   already writes `t()` / `T` as this document's helper, which was stale against the old
   `G()`; it is now true).
2. **`TELEMETRY_TABLES`' values are unqualified** — `samples: 'samples_v3'`, not
   `'gigapipe.samples_v3_dist'`. Qualification is `t()`'s job and `ON CLUSTER` is
   `getTelemetryMutationTable()`'s, so a caller cannot double-qualify by accident. `06` §5
   pre-qualifies and must change; its member names (`traces`, `traceAttrs`, `traceKv`,
   `samples`, `timeSeries`) merge into `08`'s wider set.
3. **`packages/db/src/gigapipe/table-name.ts` is deleted** from `05-logs.md`, along with
   `gigapipeTable()`. Its `mode: 'read' | 'mutate'` distinction is right and survives as the
   two functions; its cluster source is wrong — it reads OpenPanel's
   `isClickhouseClustered()`, which defaults to **true** unless `SELF_HOSTED` is set and says
   nothing whatever about gigapipe.
4. **One database variable: `GIGAPIPE_DB`.** `TELEMETRY_CLICKHOUSE_DATABASE` and
   `CLICKHOUSE_TELEMETRY_DB` are deleted. `08` §11's `CLICKHOUSE_TELEMETRY_URL` survives as
   an **explicit, documented alias for a different thing** — a separate ClickHouse *endpoint*
   for BYO-ClickHouse deployments — and its path segment continues to win over `GIGAPIPE_DB`
   when present, which is 08's rule and is correct. It is not a second name for the database.

**Reads and mutations use different clients, deliberately** (this is the other half of the
conflict, raised independently against §9). `chQuery`/`chQueryWithMeta` round-robin across
every entry in a comma-separated `CLICKHOUSE_URL` with failover (`client.ts:212,373`) and
carry the repo's existing statistics logging and integer coercion — right for catalogue and
trace reads, and F21 below is honest about the one case where round-robin bites.
`getTelemetryClient()` pins one node and takes ClickHouse settings per statement — required
for anything that must be written and then read back on the same node: migration 22, the TTL
reconciler, the deletion sweep. So:

- **reads** → `chQuery` / `chQueryWithMeta`, table names from `t()`;
- **DDL and mutations** → `getTelemetryClient()`, table names from
  `getTelemetryMutationTable()`;
- **never** `chMigrationClient` for a gigapipe table, and never `getReplicatedTableName()`
  (`client.ts:101`), whose `_replicated` convention gigapipe's schema does not use.

**Every** SQL string in §9 goes through `t()`, and every subquery goes through
`TELEMETRY_IN`; a test asserts no emitted query contains a bare `gigapipe.` literal (T18a).

### D13. The base procedure is `protectedProcedure` + a share rejection, not hand-rolled auth

The previous draft built `observabilityProcedure` on `publicProcedure` and re-derived
session validation and `requireProjectAccess` by hand. `enforceAccess`
(`packages/trpc/src/trpc.ts:90-112`) already does exactly that for any procedure with a
top-level `projectId`, including the `organizationId` branch and the demo-mode mutation
guard, and its own comment says it "Fails closed … including ones added later"
(`trpc.ts:100-103`). Re-deriving it opts the one router the plan calls a security boundary
out of every future change to the repo's central access middleware.

```ts
const observabilityProcedure = protectedProcedure.use(rejectShareId);
```

Two corrections to the previous draft's stated justification, both verified:

- "`requireProjectAccess` rather than a raw `getProjectAccess` truthiness test: the
  truthiness test is the bug behind GHSA-f9rx-pxgw-c6rg" **oversells**. Every procedure
  here is a query at `level: 'read'`, and at `level: 'read'` `requireProjectAccess` *is*
  the truthiness test — the `canWriteProject` branch is only added when `level === 'write'`
  (`packages/trpc/src/access.ts:39-61`). Using the named helper is about not diverging
  from `enforceAccess`, not about closing a hole.
- `enforceAccess` only fires when `projectId` is a **top-level** key of the raw input. A
  procedure that resolves its project from something else — `traces.forSession`, whose
  input is `{ sessionId, from, to }` (`06-traces-and-correlation.md:1463`) — is invisible
  to it. The previous draft's §6.1 threw `BAD_REQUEST` on a missing `projectId` *and*
  §6.4 said `traces.forSession` composes the same procedure; those two statements
  contradict and `traces.forSession` would have 400'd unconditionally. Resolved by an
  explicit fail-closed allow-list (§6.1).

### D14. Retention is **annotated**, not clamped — and it is **per signal**, read from `10-ops-retention-billing.md`

The previous version clamped `startDate` up to `now - GIGAPIPE_RETENTION_DAYS`
unconditionally, then softened to annotation while keeping a single scalar env var.
Annotation is right; the scalar is wrong.

**Chosen: fail toward showing data.** The query is issued for the range the user asked
for; `oldestQueryableAt` is reported on `status` and on the chart response, and the UI
renders "data before `<date>` has been deleted" beside the chart. Cost of not clamping: a
wider date range on a table partitioned by day, which ClickHouse prunes; the point budget
bounds the sample count independently. The one place the number is still *acted* on is the
previous period (F19): when the **entire** comparison window ends before
`oldestQueryableAt`, the previous-period calls are not issued at all and the response
carries 03's `previous_period_unavailable` notice with `reason: 'retention'`, because a
delta computed against a guaranteed-empty window renders a confident `-100 %` the user will
act on.

**Settlement 3 — one number became five across the document set**, and two of them were
load-bearing for query clamps: `GIGAPIPE_RETENTION_DAYS` default 7 here;
`PLAN_DEFAULT_RETENTION_DAYS = 30` for logs in `05-logs.md` §5.1; "default 7" plus
`TRACE_SEARCH_MAX_WINDOW_H = 24 * 7` in `06-traces-and-correlation.md` §6.0; a worked
example of 90 metrics / 30 logs in `08-schema-changes.md` §13 citing a tier table that
`10-ops-retention-billing.md` §6.3 **defers**; and 10 §6.1's actual shipped windows.

**`10-ops-retention-billing.md` owns retention.** This document reads one constant:

```ts
import { TELEMETRY_RETENTION } from '@openpanel/constants';
// { metrics: 30, logs: 14, traces: 7, labels: 30 } on cloud
// self-hosted: every signal = TELEMETRY_RETENTION_DAYS (the compose scalar, default 14)
```

`GIGAPIPE_RETENTION_DAYS` is **deleted** from §3. `oldestQueryableAt` is computed per signal
— `metrics.chart` reports the metrics window, `logs.*` the logs window, `traces.*` the
traces window — and `observability.status.retention` is the whole record, not one number
(D18). A single scalar was wrong for two of three signals by construction.

**Naming edit owed by `10`.** 10's Interfaces exports the **object**
`{metrics, logs, traces, labels}` under the name `TELEMETRY_RETENTION_DAYS`, while 10 §2 and
§3.1 use the *same name* for a scalar compose env var. Two different things must not share a
name in a document set that has just spent this much effort on env-var collisions. This
document reads the object as **`TELEMETRY_RETENTION`** and the compose scalar keeps
`TELEMETRY_RETENTION_DAYS`. `06` §6.0's `TRACE_SEARCH_MAX_WINDOW_H` should be
`TELEMETRY_RETENTION.traces * 24` rather than a hardcoded 7 days, and `08` §13's worked
example and its citation should be corrected to the deferred-tier reality.

### D15. One kill-switch namespace, one polarity: `telemetry:disabled:*`

`GIGAPIPE_URL` is the only off switch a fresh design has, and unsetting it also kills
ingest (the write routes come from the same config) and needs a rolling restart of every
API replica. §8's whole premise is that an unbounded observability dashboard degrades
product analytics for every customer on the shared ClickHouse; that premise demands a
brake an operator can pull in ten seconds.

**Settlement 10 — five mechanisms, two of them with opposite polarity.** This document used
`op:gp:off` / `op:gp:off:<projectId>` (presence means disabled, no TTL);
`02-ingest-gateway.md` §4 uses `telemetry:disabled:{projectId}` / `telemetry:disabled:*`
with a **mandatory** TTL; `01-tenancy-and-security.md` §11 uses
`telemetry:ingest:enabled` / `telemetry:read:enabled` (**a value means enabled** — the
opposite polarity, so an operator who `DEL`s the key to "turn it off" turns it on);
`06-traces-and-correlation.md` §15 uses two env vars; `05-logs.md` D12 unsets
`GIGAPIPE_READ_URL`. An on-call engineer reading any one of these pulls a lever the other
four do not observe.

**Chosen: 02's namespace, this document's read/ingest split, 02's TTL policy.**

| Key | Scope | TTL | Owner |
|---|---|---|---|
| `telemetry:disabled:*` | everything, every project — reads **and** ingest | **none** | ops runbook; also written by `10` §10.3's disk guard |
| `telemetry:disabled:{projectId}` | one project, reads and ingest | **mandatory** | on-call |
| `telemetry:disabled:read:*` | all reads, ingest untouched | none | on-call |
| `telemetry:disabled:read:{projectId}` | one project's reads | **mandatory** | on-call |
| `telemetry:disabled:ingest:*`, `…:ingest:{projectId}` | ingest only | per `02` §4 | `02` |

Three properties, each argued:

- **Presence means disabled.** A brake is pulled by writing, not by deleting. `01` §11's
  enable-flag polarity is deleted; so is `06` §15's env-var pair, which cannot be changed
  without a deploy and therefore is not a brake at all.
- **The read/ingest split is kept**, because a read-path enforcement bug must not stop
  correctly-stamped ingest — the data is fine, the query is not, and dropping telemetry an
  exporter will not re-send is unrecoverable while a disabled dashboard is not.
- **TTL: none on the global keys, mandatory on the per-project keys.** These are not the
  same decision. A global brake that un-pulls itself at 3 a.m. is not a brake; a per-project
  block set during an incident and then forgotten is a customer silently losing a feature
  they pay for, which is `02`'s argument and is right at that scope.

Checked in the base procedure and at tail-socket open, read through a 10 s in-process
cache. Set → `status.degraded = 'disabled'`, every read procedure returns its empty shape,
the tail refuses to open and open tails close on their next tick.

`10-ops-retention-billing.md` §10.3 owns the operator table — all of these keys, with the
`redis-cli` commands, in one place, because that is the document an on-call engineer opens.

### D16. Exact-nanosecond log cursoring is impossible; the cursor is a hint and dedupe is the mechanism

This is the single most consequential correction to the previous draft, which specified
`cursorNs + 1n` on a `BigInt` "because nanosecond epochs exceed 2^53" and asserted (T36 in that draft)
that "two lines 1 ns apart are not collapsed".

The **server** cannot consume that precision. Loki `start`/`end` are parsed by
`getRequiredFloat` → `strconv.ParseFloat(strRes, 64)` (`reader/controller/utils.go:21-33`),
called at `reader/controller/query_range.go:41-42`, and truncated with `int64(start)` at
`:57`. A `float64` at a 2026 nanosecond epoch (~1.77e18, 61 bits) has a ULP of **256**, so
whatever the client sends lands on a 256 ns grid. `+1n` is rounded away; the grid cell may
sit *before* the last line already emitted (re-emit) or after it (silent drop).

**Chosen:** poll from `cursorNs - OVERLAP_NS` and deduplicate client-side, per socket, on
a `(timestamp_ns, line)` key. The same rule governs `logs.query` paging (§6.3): the cursor
carries a boundary plus the hashes of the lines already returned at that boundary. The ns
*string* discipline on the response side (never `Number()` a Loki timestamp) is unchanged
and still correct — that finding was about the response; this one is about the request,
and the previous draft never carried it across.

### D17. One router: `observability.{metrics, logs, traces, status}`

**Settlement 7, closed here rather than deferred again.** Four documents wrote call sites
against three answers: this one mounts `observability: observabilityRouter` with
`metrics.*`, `logs.*`, `traces.*`; `06-traces-and-correlation.md` §6.6 lists seven
procedures under `observability.traces.*`; `03-metrics-engine.md` § Interfaces consumes
`observability.metrics.chart` (while its self-observability section adds a
`packages/trpc/src/routers/metrics.ts`); and `05-logs.md` §5.3 creates
`packages/trpc/src/routers/logs.ts` exporting `logsRouter`, with every 05 call site written
as `trpc.logs.*`. `09-ui-surfaces.md` Q1 states the consequence — "the UI cannot import
three namespaces for one feature" — and `11-testing-strategy.md` Q1 calls it blocking
before anyone writes a test file.

**Chosen:** one router, `packages/trpc/src/routers/observability.ts`, mounted once in
`root.ts`, with `metrics`, `logs`, `traces` and `status` beneath it. `05-logs.md`'s
`logsRouter` folds in as the `logs` sub-router — its procedures and their bodies are
unchanged, only the file and the namespace move. No `routers/metrics.ts`, no
`routers/logs.ts`.

**And one base procedure**, which matters more than the name. The three specs also
disagreed on the base: this document's `protectedProcedure.use(rejectShareId)` (D13), 05's
plain `protectedProcedure.use(telemetryGate)` throwing `PRECONDITION_FAILED`, and
`01-tenancy-and-security.md` §7.1's hand-rolled `publicProcedure` with its own session and
access checks. D13's is the one, for the reason D13 gives: re-deriving `enforceAccess` opts
the one router the plan calls a security boundary out of every future change to the repo's
central access middleware. 05's `telemetryGate` survives as **behaviour inside** the base
procedure — a deployment with no backend answers with the empty shape and a `status.degraded`
value, not with a connection error — not as a second base.

**Page-local versus saved-report**, per `09-ui-surfaces.md` D5, which this document
confirms: page-local surfaces (the metrics explorer, the log pane, the span waterfall,
`traces.latency`) call `observability.*`; anything loaded from a `Report` row calls
`chart.*`. That split is why D4's share-path requirement lands on `chart.chart` and not
here.

Sweep owed: `03`, `05` and `06`'s router paths, and `11`'s test file paths, in one PR
alongside D1's package sweep. They are the same conversation and should not be two PRs.

### D18. `observability.status` is the **only** capability surface

**Settlement 12.** Four were specified: this document's `observability.status`;
`09-ui-surfaces.md`'s `telemetry.capabilities → {enabled, hasMetrics, hasLogs, hasTraces,
patterns, blocked}`, on which its sidebar gating, route gating and settings tab are all
built; `05-logs.md` D12's server-side `telemetryEnabled` boolean on the app context; and
`06-traces-and-correlation.md` §15 flipping `signals.traces` from an env var.

**Chosen: `observability.status`, extended.** Two changes to §6.5's shape:

- **`blocked` is added.** 09 genuinely needs it — the wind-down banner is not derivable from
  anything else this procedure returns, and `subscriptionHook`
  (`apps/api/src/hooks/subscription.hook.ts`) gates ingest, not reads. It is always `false`
  when `SELF_HOSTED === 'true'`, matching how the events path short-circuits.
- **`patterns` is not added.** It exists in 09's shape only to gate pattern grouping, which
  needs `LOG_DRILLDOWN`, which settlement 4 turns off. If `LOG_DRILLDOWN` is ever turned on,
  `patterns` is added then, together with `05-logs.md` I6's validator as a hard requirement.

Consequences elsewhere: 09 rewrites `telemetry.capabilities` and its sidebar query to
`observability.status`; 05's app-context `telemetryEnabled` derives from the same procedure
rather than being a second boolean with its own truth source; 06 stops flipping
`signals.traces` from an env var and lets it be what §9.4 measures — whether the project has
trace rows in the window. An operator who wants traces off pulls D15's kill switch, which is
observable in one place.

`09-ui-surfaces.md` D12 is right that this must **not** be awaited in the project route
loader: `routes/_app.$organizationId.$projectId.tsx` already awaits two prefetches, and a
third that probes gigapipe would block navigation into every project page behind an
unreachable backend. It is fetched once per project navigation, unawaited, with
`staleTime: 30_000` (§6.5).

### D19. Migration 22 pre-creates gigapipe's tables, and §11's "no DDL" is scoped to **this** work-stream

**Settlement 14, and this is the one place a reader was most likely to find permission not
to do the irreversible thing.** §11 stated as a principle that this plan "does not create,
migrate or `ALTER` anything in the telemetry database", reasoning that gigapipe creates its
own database and runs its own schema upgrades at boot and that duplicating that invites
drift against gigapipe's own migration ledger. `08-schema-changes.md` S6 does exactly the
opposite — `packages/db/code-migrations/22-telemetry-database.ts` pre-creates the database
and two of its tables so that `type` lands in the `PARTITION BY` — and
`10-ops-retention-billing.md` D4 calls that "the one irreversible choice in the whole
work-stream". Neither cited this document; this document cited neither.

**08 and 10 are right.** `PARTITION BY` cannot be `ALTER`ed; `rotateTables` unconditionally
forces `ttl_only_drop_parts = 1`; and both tables are `CREATE TABLE IF NOT EXISTS`, so the
first writer wins. Per-signal retention — the whole of `10` §6, and D14 above — is
**impossible** without the pre-create. The drift concern is real, but it is answered by
`08` S7's column-order and sorting-key contract plus the per-bump `log.sql`/`traces.sql`
diff in 08's CI harness, not by declining to pre-create.

§11's first bullet is rewritten accordingly: *this work-stream* does not create or `ALTER`
anything in the telemetry database; `08-schema-changes.md`'s migration 22 owns the two
pre-created tables and the per-bump schema diff. The two documents no longer contradict
each other in the place a reader is most likely to look.

### D20. Version skew is detected by **schema shape**, not by a version string, and `status` reports it

**No document owned this.** `10-ops-retention-billing.md` §11.2 is a sound upgrade runbook
*for the OpenPanel team* — read the schema diff first, run the init container alone on a
copy or in a maintenance window, re-check the fan-out arithmetic — none of which a
self-hoster can perform. Meanwhile the generated `docker-compose.yml` is gitignored and
hand-edited, `get_latest_images` deliberately does not manage the gigapipe tag (`10` §4.2),
and `./update` pulls the `self-hosting` branch. So the fleet fragments across gigapipe
versions while every line-number-pinned behaviour in this document set is valid "only for
the pinned tag" against a tag the operator controls.

And gigapipe cannot tell us which version it is: §4.1 establishes that
`/api/v1/status/buildinfo` writes `uc.Version` verbatim and it is always the empty string,
and the alternate `/api/status/buildinfo` returns a hardcoded `"0.0.1"` with a `//TODO`.
`11-testing-strategy.md` D14/K22 reads the version from `docker inspect` on the container
runtime, which `apps/api` cannot do.

**Chosen, jointly with the ops work-stream:**

1. A checked-in `GIGAPIPE_SUPPORTED_VERSIONS` range in `packages/constants`, asserted by the
   upgrade-qualification suite and stated on the docs page.
2. **Probe shape, not version.** At boot and on the `status` cache tick, the `system.tables`
   read `08` §10 already builds answers the two questions that actually matter: does
   `samples_v3` carry `type` in its `PARTITION BY`, and does `type_v2` exist? Both come from
   `system.tables.partition_key` and `system.columns`, with no new machinery and no new
   round trip beyond §9.5's existing `system.tables` probe.
3. A new `degraded: 'schema_unsupported'` value (§6.5), ordered immediately after
   `schema_missing`, with a named remedy. It is a **degraded** state, never a throw: charts
   that still work keep working.
4. An operator-facing page at `self-hosting/observability.mdx` covering the
   init-container-first sequence and the "there is no downgrade" fact `10` §11.2 already
   establishes.

About 3-5 days, split between this work-stream (the probe and the `status` value) and ops
(the constant, the compose ordering and the page).

### D21. A stated kill criterion for the gigapipe dependency

Worth saying out loud once, because after every work-stream finished its analysis the
residual is much smaller than the plan's framing. What the plan actually uses from gigapipe:
its OTLP-metrics decoder, its Loki-JSON writer, its trace writer, its **PromQL→ClickHouse
accelerated planner** and its LogQL→ClickHouse transpiler. What it bypasses: every metadata
endpoint (D3, seven findings), the entire Tempo reader (D11, and `06` T1/T2), the OTLP log
ingest path (`05` D1), `detected_fields` (`05` D7 — a stub), the tail (D6), the four
drilldown routes (settlement 4), the ruler (`10` D23), the UI, profiles, and roughly twenty
routes blocked outright (`01` D9). What it costs: an AGPL-3.0 Go dependency, a protobuf
decode/mutate/re-encode gateway, pre-creation of its own tables (D19), its retention, its
deletion, its cardinality problems, and a per-bump contract-test harness — because every
rule in the ingest spec is read off its internals.

**This is not an argument to abandon gigapipe.** The accelerated PromQL planner over
`metrics_15s` is genuinely hard to reproduce and is worth the dependency on its own. It is
an argument to say out loud that it is the *only* thing that is, and to name the condition
under which that stops being true:

> **Kill criterion, evaluated at every phase boundary.** If P2 finds we are compiling
> *around* the PromQL planner rather than *through* it — that is, if the accelerated path is
> being avoided for correctness reasons the way every metadata endpoint already is — stop and
> re-run the adopt-versus-build decision before P3 starts. The three writers are perhaps 2-3
> weeks of TypeScript against tables this plan already pre-creates, already applies TTL to
> and already deletes from.

`11-testing-strategy.md` Q14's decommissioning path belongs in `00-blueprint.md` as a
standing item, not in a testing-strategy open question.

---

## Design

### 1. Findings from source this design rests on

**1.1 Every time parameter has a different unit, per dialect.** The largest source of
"returns empty, no error" in this work-stream.

| Endpoint | `start`/`end` accepted as | Source |
|---|---|---|
| `GET,POST /api/v1/query_range` | RFC3339, **or** epoch auto-detected as s / ms / µs / ns by magnitude | `ParseTimeSecOrRFC` + `epochToTime`, `reader/controller/utils.go:83-118` |
| `GET,POST /api/v1/query` | same | same |
| `GET,POST /api/v1/labels`, `/api/v1/series` | RFC3339 **or unix seconds only** (`parserTimeString`) | `reader/controller/prom_query_labels.go:167-177` |
| `GET,POST /api/v1/label/{n}/values` | **integer, unit = seconds** — RFC3339 is a 400 | `prom_query_labels.go:63` → `ParseLogSeriesParamsV2(r, time.Second)` |
| `GET /loki/api/v1/query_range`, `/query` | **nanoseconds**, plain `float64`, no magnitude detection, **~256 ns effective resolution** | `reader/controller/query_range.go:41-42,57`; `getRequiredFloat`, `utils.go:21-33` |
| `GET /loki/api/v1/index/stats` | **nanoseconds, exact** - `strconv.ParseInt`, not `ParseFloat`; empty `start` defaults to `end - 1h`, empty `end` to `now` | `reader/controller/query_range.go:256-276` |
| `GET,POST /loki/api/v1/label/{n}/values` | **integer, unit = nanoseconds** | `reader/controller/query_labels.go:54` → `ParseLogSeriesParamsV2(r, time.Nanosecond)` |
| `GET /api/search` | epoch auto-detected (`epochToTime`) | `reader/controller/tempo.go:476-490` |
| `GET /api/traces/{id}` | **unix seconds only**, multiplied by `1e9` | `reader/controller/tempo.go:41-70` |

The float64 rounding is specific to `query_range` / `query`: `/loki/api/v1/index/stats`
parses its own times with `strconv.ParseInt` (`query_range.go:261-269`) and is exact. D16's
overlap-and-dedupe therefore applies to the tail and to `logs.query`, not to `logs.volume`.

`step` is a third axis. `parseDuration` (`reader/controller/prom_query_range.go:355-366`)
tries `ParseFloat` first and treats a bare number as **seconds**, then falls back to
`model.ParseDuration` (`ms`/`s`/`m`/`h`/`d`/`w`/`y`). So `step=60000` is sixty *thousand*
seconds and `step=60000ms` is sixty seconds. On the Loki path the same string goes through
`getRequiredDuration` → seconds-as-float → `int64(step*1000)` ms
(`query_range.go:43,57`), so the suffixed form is correct on both.

→ **`src/units.ts` is the only place in the codebase that formats a gigapipe time
parameter**, and it takes the route key so it cannot pick the wrong unit. `step` is always
emitted with an explicit `ms` suffix.

**1.2 A POST with a `URLSearchParams` body silently does nothing.** Every form-decoding
branch compares the header **exactly**:
`r.Header.Get("Content-Type") == "application/x-www-form-urlencoded"`
(`prom_query_range.go:122`, `prom_query_labels.go:180`, `query_labels.go:115`). Node/undici
sets `content-type: application/x-www-form-urlencoded;charset=UTF-8` for a
`URLSearchParams` body. The `;charset=UTF-8` breaks the equality, the form is never
parsed, the handler falls through to `r.URL.Query()` — empty — and `/api/v1/query_range`
answers `400 query parameter is required`.

→ The transport sets `Content-Type` itself, to the literal string, and passes a
pre-serialised body string. T4 asserts the emitted header has no parameters.

**1.3 `/api/v1/query_range` can return HTTP 200 with truncated JSON.** `writeResponse`
writes `{"status":"success","data":{"resultType":"matrix","result":[` before serialising
the matrix (`prom_query_range.go:177-192`), then streams series. If `writeMatrix` fails
mid-stream the handler calls `PromError(500, …)` (`:100`) — but the status line is already
committed as 200, Go discards the second `WriteHeader`, and the client receives 200 with
unbalanced JSON plus an error object appended.

→ `JSON.parse` failure on a **2xx** is a distinct kind (`malformed_response`), never a
transport error, and never returns the prefix that did parse.

By contrast the Loki paths buffer fully before writing (`SmartBufferServe`,
`reader/controller/utils.go:176-195`), so their errors are clean 500s with a JSON body.
The Tempo search path streams like Prometheus does (`tempo.go:401-414`).

**1.4 The PromQL engine has a hardcoded 30 s timeout, `EnableNegativeOffset: false`, and
`LookbackDelta: 0`.** `reader/router/prometheus_query_range.go:28-43`:

```go
promql.NewEngine(promql.EngineOpts{
    MaxSamples: maxSamples,          // = SYSTEM_SETTINGS.MetricsMaxSamples
    Timeout:    time.Second * 30,    // not configurable
    LookbackDelta: 0,                // => Prometheus' 5m default
    EnableAtModifier: true, EnableNegativeOffset: false,
})
```

Three consequences. The 30 s is the ceiling on any single metric call, so the client
timeout sits just above it (§3). The compiler must never emit a negative offset, which
stock Prometheus accepts. And with the 5-minute default lookback, a gap wider than 5
minutes produces holes in the matrix that the shaper must zero- or carry-fill.

`MaxSamples` comes only from `ADVANCED_PROMETHEUS_MAX_SAMPLES` (`cmd/gigapipe/main.go:201-206`),
whose upstream default lives in the `cloki-config` module — **UNVERIFIED**, that module is
not in this machine's Go module cache. A value of `0` would fail every PromQL query. §3
pins it.

**1.5 Errors are always `{"status":"error","errorType":"error","error":"<msg>"}`**
(`PromError`, `prom_query_range.go:160-168`) on every read route — Prometheus, Loki and
Tempo alike. There is no error-code taxonomy; the only machine-readable signal is the HTTP
status, and the status is frequently wrong: a client-side "step too small" is a **500**
(`:65-71`), and so are an engine timeout and `promql.ErrTooManySamples`.

**1.6 There is no read-time tenant header.** `X-Scope-OrgID` appears once in the whole
gigapipe tree, in `ruler/controller/controller.go:3` saying it is not read. The reader
picks its ClickHouse connection at **random** per call from a boot-time pool
(`reader/registry/static.go:33-38`), ignoring the request context entirely. Label
enforcement is not the better option on the read side; it is the only one.

**1.7 Basic auth covers every route including `/ready` and `/metrics`, and is installed
only if both credentials are non-empty.**

```go
// cmd/gigapipe/main.go:321-325
if cfg.Setting.AUTH_SETTINGS.BASIC.Username != "" &&
   cfg.Setting.AUTH_SETTINGS.BASIC.Password != "" {
    app.Use(middleware.BasicAuthMiddleware(...))
}
```

gorilla/mux applies `Use()` to any matched route, so a health probe without credentials
401s. And a deployment that never set the credentials runs a **fully unauthenticated**
gigapipe — including `/api/v1/metadata`, `/loki/api/v1/labels`, `/api/search/tags` and
`/api/traces/{id}`, the four untenanted endpoints D3 and D11 exist because of. §3 treats
that as a first-class degraded state (F18).

**1.8 gigapipe's default ClickHouse database is `cloki`, not `gigapipe`.**
`cmd/gigapipe/main.go:92-95`: `db := "cloki"`, overridden only by `CLICKHOUSE_DB`. Nothing
couples it to OpenPanel's `TELEMETRY_CLICKHOUSE_DATABASE`. A deploy that forgets
`CLICKHOUSE_DB=gigapipe` on the container produces the worst possible split-brain: metric
charts and ingest work perfectly (they go over HTTP and never see the database name) while
every §9 query hits a nonexistent database, so the pickers are permanently empty and
`status` says the schema is missing. §3 pins it and `status` surfaces the resolved name.

**1.9 `time_series.name` is never written.** The column exists in the DDL
(`ctrl/qryn/sql/log.sql:16-20`), which is why it looks safe. The only INSERT into that
table is `INSERT INTO %s (type, date, fingerprint, labels, metadata)`
(`writer/service/insert/time_series.go:57`) and `TimeSeriesAcquirer` has no `Name` field
(`time_series.go:13-19`). gigapipe's own reader says so:
`// Note: Extract metric name from labels JSON since name column is not populated`
(`reader/service/metadata.go:35`). §9.1 reads `JSONExtractString(labels,'__name__')`.
This closes the previous draft's Q3 from disk — it was never a live-instance question.

**1.10 `tempo_traces_attrs_gin.oid` is `''`, not `'0'`.** `tempo_traces` declares
`oid String DEFAULT '0'` (`ctrl/qryn/sql/traces.sql:8`) and so does the dead `traces_input`
Null table (`:54`) — but `tempo_traces_attrs_gin` declares a bare `oid String` with **no**
DEFAULT (`:22`), and the live writer's INSERT omits the column:
`INSERT INTO tempo_traces_attrs_gin (date, key, val, trace_id, span_id, timestamp_ns, duration)`
(`writer/service/insert/tempo.go:189`). ClickHouse fills an omitted `String` with `''`.
`traces_input` appears in no Go file — the Null-table + MV path that would have supplied
`'0'` is dead schema. A probe with `WHERE oid = '0'` on that table returns nothing,
forever. gigapipe's own reader never exercises the value: the oid predicate is commented
out on both trace paths (`reader/tempo/sql_index_query.go:61`,
`reader/tempo/traces_query.go:29`, both marked `TURNED OFF`).

Partition keys differ between the two GIN-ish tables and the previous draft conflated
them: `tempo_traces_attrs_gin` is `PARTITION BY date` with
`ORDER BY (oid, date, key, val, timestamp_ns, trace_id, span_id)` (`traces.sql:31-32`);
only `tempo_traces_kv` is `PARTITION BY (oid, date)` (`:41`).

**1.11 `time_series` metadata (`type`/`unit`/`help`) is populated only on the OTLP metrics
path.** `time_series.metadata` is written from the special labels `__metric_type__`,
`__metric_help__`, `__metric_unit__` (`writer/utils/metadata/parser.go:19-47`, consumed at
`writer/utils/unmarshal/builder.go:326`), and `ToJSON()` returns `""` when all three are
absent (`parser.go:49-59`). A repo-wide grep finds `__metric_type__` set in exactly one
place: `writer/utils/unmarshal/otlp_metrics.go:256,510`. **Prometheus remote-write sets
none of them.** So for remote-write series the catalogue's `type`/`unit`/`help` are all
`''`, and F16's native-histogram mitigation is unavailable for exactly the ingest path
most likely to carry them. This is an obligation on the ingest work-stream (§Interfaces).

**1.12 Loki read methods are not uniform.** `/loki/api/v1/query_range`, `/query`, `/tail`
and `/index/stats` are `Methods("GET","OPTIONS")` (`reader/router/query_range.go:20-23`).
`/loki/api/v1/label`, `/labels`, `/label/{name}/values` and `/series` are
`Methods("GET","POST","OPTIONS")` (`reader/router/select_labels.go:17-20`). The previous
draft's "the entire Loki read surface is GET-only" is false and cited the file that
disproves it. The operative constraint survives — the 8 KiB URL cap applies to
`query_range`/`query`, which really are GET-only, and those are the only Loki read routes
this work-stream calls.

### 2. Module layout

```
packages/gigapipe/
  package.json                      # name: @openpanel/gigapipe
  index.ts                          # public surface, re-export only
  src/config.ts                     # env parse, once, at import time (never throws)
  src/units.ts                      # THE per-route time/step formatter (1.1). NO step ladder — D9
  src/transport.ts                  # fetch, auth, timeout, retry, breaker, D2 gate, observer
  src/routes.ts                     # GIGAPIPE_ROUTES (tenancy owns writes, we own reads)
  src/errors.ts                     # GigapipeError + kinds + toTRPCError
  src/types.ts                      # wire types: PromMatrix, LokiStreams, ...
  src/lease.ts                      # per-project concurrency lease (Redis Lua)
  src/killswitch.ts                 # D15
  src/read/prometheus.ts            # promQueryRange, promQueryInstant
  src/read/loki.ts                  # lokiQueryRange (streams + matrix), lokiIndexStats
  src/query/*.ts, src/labels.ts     # tenancy work-stream
                                    # NO src/ingest/**, NO vendor/** — D1, settlement 13

packages/db/src/services/telemetry-metadata.service.ts   # §9, direct ClickHouse
packages/db/src/clickhouse/telemetry-client.ts           # D12: telemetryDb, TELEMETRY_TABLES,
                                                         #      t(), getTelemetryMutationTable(),
                                                         #      TELEMETRY_IN, isGigapipeClustered(),
                                                         #      getTelemetryClient()   [08 owns the file]
packages/db/src/engine/metrics/notices.ts                # MetricChartResult [03 owns the file]

packages/trpc/src/routers/observability.ts               # THE router — D17; 05's logsRouter folds in
packages/trpc/src/routers/observability.test.ts          # modelled on share.test.ts

apps/api/src/controllers/live.controller.ts              # + wsProjectLogs   — P6 only, D6
apps/api/src/routes/live.router.ts                       # + GET /live/logs/:projectId — P6 only, D6
apps/api/src/telemetry/**                                # ingest work-stream, 02 D9 — NOT here
```

`packages/gigapipe/package.json` dependencies: `@openpanel/constants`,
`@openpanel/logger`, `@openpanel/redis`, `@openpanel/validation`, `zod` (catalog). No
`@openpanel/db` — which is what keeps `t()` and the metadata service on the other side of
the boundary (D12) — and, after settlement 13, no `protobufjs` and no `long` either,
because the ingest codecs are in `apps/api/src/telemetry/`. No HTTP library — Node's global `fetch`, per `.nvmrc` (`24.19.0`).
Neither `apps/api`, `packages/db`, `packages/trpc` nor the root declares `undici` or
`node-fetch`; `@openpanel/common` does (`packages/common/package.json:29`) and is not a
dependency of this package, so the previous draft's repo-wide "there is no undici anywhere"
was wrong while its conclusion stands.

`src/read/tempo.ts` is **not** created (D11).

### 3. Config

`src/config.ts`, parsed once at module load, **never throwing** — an unset `GIGAPIPE_URL`
degrades to `enabled: false`, it does not crash `apps/api` at import.

```ts
// packages/gigapipe/src/config.ts
export type GigapipeConfigProblem =
  | 'not_configured'      // GIGAPIPE_URL unset
  | 'insecure'            // GIGAPIPE_URL set, no credentials  (finding 1.7)
  | 'bad_base_url'        // GIGAPIPE_URL unparseable, or carries a path
  ;

export interface GigapipeConfig {
  enabled: boolean;
  baseUrl: string | null;          // origin only, no path, no trailing slash
  authHeader: string | null;
  problems: GigapipeConfigProblem[];
  /** Node-level socket timeout. Sits ABOVE the reader's fixed 30s engine timeout. */
  requestTimeoutMs: number;
  /** Per-project in-flight *charts*. See §8.4. */
  maxConcurrencyPerProject: number;
  /** In-flight upstream calls inside one lease. See D8. */
  fanoutConcurrency: number;
  /** Response body cap, DECOMPRESSED bytes. Streamed and aborted, never buffered blind. */
  maxResponseBytes: number;

  // ---- read by 03-metrics-engine.md §5; declared here because this is the config object ----
  /** Point budget per series. 3000 (D9, 03 §6.3). NOT 1500. */
  maxPoints: number;
  /** Series kept per definition AFTER the ranking pass (03 D8). GIGAPIPE_MAX_SERIES. */
  maxSeries: number;
  /** Ranking-response cardinality guard (03 §8.1). */
  maxRankSeries: number;
  /** Limiter inside one lease, for the metric fan-out (D8, 03 §5). */
  metricFanoutConcurrency: number;
  /** Strictly below gigapipe's fixed 30s engine timeout (finding 1.4). */
  metricDeadlineMs: number;
}

/**
 * Retention is NOT here. It is per signal and it belongs to
 * 10-ops-retention-billing.md: `import { TELEMETRY_RETENTION } from '@openpanel/constants'`
 * (D14). There is no `retentionDays` scalar and no GIGAPIPE_RETENTION_DAYS.
 */

const num = (v: string | undefined, d: number) => {
  const n = v === undefined ? Number.NaN : Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : d;
};

export const gigapipeConfig: GigapipeConfig = (() => {
  const problems: GigapipeConfigProblem[] = [];
  const raw = process.env.GIGAPIPE_URL?.replace(/\/+$/, '') || null;

  let baseUrl: string | null = null;
  if (!raw) {
    problems.push('not_configured');
  } else {
    try {
      const u = new URL(raw);
      // `new URL('/api/v1/query_range', 'http://h/gigapipe')` is
      // 'http://h/api/v1/query_range' — an absolute path DISCARDS the base path.
      // Rather than silently querying the wrong prefix, refuse the config.
      if (u.pathname !== '/' || u.search || u.hash) problems.push('bad_base_url');
      else baseUrl = u.origin;
    } catch {
      problems.push('bad_base_url');
    }
  }

  const user = process.env.GIGAPIPE_USER;
  const pass = process.env.GIGAPIPE_PASSWORD;
  if (baseUrl && !(user && pass)) problems.push('insecure');

  return {
    enabled: Boolean(baseUrl),
    baseUrl,
    authHeader: user && pass
      ? `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
      : null,
    problems,
    requestTimeoutMs: num(process.env.GIGAPIPE_TIMEOUT_MS, 35_000),
    maxConcurrencyPerProject: num(process.env.GIGAPIPE_MAX_CONCURRENCY, 4),
    fanoutConcurrency: num(process.env.GIGAPIPE_FANOUT_CONCURRENCY, 4),
    maxResponseBytes: num(process.env.GIGAPIPE_MAX_RESPONSE_BYTES, 32 * 1024 * 1024),
    maxPoints: num(process.env.GIGAPIPE_MAX_POINTS, 3_000),
    maxSeries: num(process.env.GIGAPIPE_MAX_SERIES, 20),
    maxRankSeries: num(process.env.GIGAPIPE_MAX_RANK_SERIES, 1_000),
    metricFanoutConcurrency: num(process.env.GIGAPIPE_FANOUT_CONCURRENCY, 4),
    metricDeadlineMs: num(process.env.GIGAPIPE_METRIC_DEADLINE_MS, 25_000),
  };
})();
```

`35_000` is load-bearing: the reader's PromQL engine timeout is a hardcoded
`time.Second * 30` (finding 1.4). A client timeout *below* it turns every genuinely slow
query into a client-side abort with no server-side log line — the worst debugging posture.
Above it, gigapipe answers first with a 500 carrying its own message, which §4.5 re-kinds.

`insecure` is a real degraded state, not a warning. `GIGAPIPE_URL` set with no credentials
means an unauthenticated gigapipe on the network (finding 1.7); it is logged at `error`
once at boot, surfaced as `status.degraded = 'insecure'`, and rendered as a red banner
(F18).

`bad_base_url` sets `enabled: false` with its own log line rather than throwing: §4.2
builds URLs with `new URL(path, baseUrl)`, and an absolute path argument discards the
base's pathname, so a path-prefixed ingress (`http://host/gigapipe`) would silently query
`http://host/api/v1/query_range`. The previous draft warned against exactly this failure
in §4.1 and then specified the construction that has it. Refusing the config at parse time
is cheaper than prefix-aware joining and gives a diagnosable boot log.

**Env vars this work-stream adds.** All of them must land in `.env.example` (dev parity)
**and** `self-hosting/.env.template`, `self-hosting/docker-compose.template.yml`,
`self-hosting/coolify.yml`, `self-hosting/quiz.ts` and
`apps/public/content/docs/self-hosting/environment-variables.mdx`. The self-hosting
compose reads `env_file: - .env` (`self-hosting/docker-compose.template.yml:114-115,128-129,148-149`),
generated from `self-hosting/.env.template` — `.env.example` alone does not reach a running
container. The deployment work-stream owns the edits; this spec owns the list.

**Settlement 9 — the naming, which had five schemes and now has one.** The base URL was
`GIGAPIPE_URL` here and in 08/10, `GIGAPIPE_INTERNAL_URL` in 02 (and in `11`'s gate 1.7),
and `GIGAPIPE_READ_URL` + `GIGAPIPE_WRITE_URL` in 05. The credential was
`GIGAPIPE_LOGIN`/`GIGAPIPE_PASSWORD` (02), `GIGAPIPE_USERNAME`/`GIGAPIPE_PASSWORD` (this
document), `GIGAPIPE_USER`/`GIGAPIPE_PASSWORD` (05/10). The cluster was
`GIGAPIPE_CLUSTER_NAME` here, `GIGAPIPE_CLUSTER` in 06/10, `CLICKHOUSE_CLUSTER_NAME` in 05.
The database was `TELEMETRY_CLICKHOUSE_DATABASE` here, `GIGAPIPE_DB` in 04/05/06/10,
`CLICKHOUSE_TELEMETRY_DB` in 08/10.

`10-ops-retention-billing.md` §3.1 declared the matter settled and named *this* document the
authority — but its list (`GIGAPIPE_URL`, `GIGAPIPE_USER`, `GIGAPIPE_PASSWORD`,
`GIGAPIPE_DB`, `GIGAPIPE_CLUSTER`, helper `t()`) matched no version of this document. **The
resolution is the reverse of what 10 wrote and the same as what 10 listed:** 10 owns the
compose and env surface, because its names are the ones written into `.env.template`,
`coolify.yml` and `quiz.ts`, and this table now matches them exactly. 10's own cross-document
edit list is stale against this revision and should be re-derived from this table.

Why `GIGAPIPE_URL` and not 05's read/write split: the split has no consumer in any other
document, and it makes the base URL double as a feature flag, which is how a rolled-back
reader silently disables ingest. One URL, one enable flag —
`isTelemetryEnabled() = !!process.env.GIGAPIPE_URL`, which is `08` §11's predicate and is
already the one every other document reads.

**Deleted names, which must not reappear:** `GIGAPIPE_INTERNAL_URL`, `GIGAPIPE_READ_URL`,
`GIGAPIPE_WRITE_URL`, `GIGAPIPE_LOGIN`, `GIGAPIPE_USERNAME`, `GIGAPIPE_CLUSTER_NAME`,
`CLICKHOUSE_CLUSTER_NAME`, `CLICKHOUSE_TELEMETRY_DB`, `TELEMETRY_CLICKHOUSE_DATABASE`,
`GIGAPIPE_RETENTION_DAYS`.

| Var | Default | Notes |
|---|---|---|
| `GIGAPIPE_URL` | *(unset)* | `http://op-gigapipe:3100`. **Origin only** — a path is refused (`bad_base_url`). Unset ⇒ `status.enabled: false`, no procedure throws, and it is the single "telemetry is configured" predicate for every document. |
| `GIGAPIPE_USER` / `GIGAPIPE_PASSWORD` | *(unset)* | Must match **`CLOKI_LOGIN`/`CLOKI_PASSWORD`** on the container. **Unset with a set URL ⇒ `degraded: 'insecure'`** (finding 1.7). |
| `GIGAPIPE_DB` | `gigapipe` | **The gigapipe container's `CLICKHOUSE_DB` must be set to the same value.** gigapipe's own default is `cloki` (finding 1.8); nothing couples them. Read by `telemetryDb()` (D12). |
| `GIGAPIPE_CLUSTER` | *(unset)* | **Set if and only if the gigapipe container's `CLUSTER_NAME` is set**, and to the same value. Drives `_dist` naming, `ON CLUSTER` and `GLOBAL IN` in §9 (D12). |
| `GIGAPIPE_TIMEOUT_MS` | `35000` | Keep above 30 000 (finding 1.4). |
| `GIGAPIPE_MAX_CONCURRENCY` | `4` | Per project, per *chart* (§8.4). |
| `GIGAPIPE_FANOUT_CONCURRENCY` | `4` | Upstream calls in flight inside one lease (D8). |
| `GIGAPIPE_MAX_RESPONSE_BYTES` | `33554432` | Decompressed bytes (§4.2 step 9). |
| `GIGAPIPE_MAX_POINTS` | `3000` | 03 §6.3's point budget (D9). |
| `GIGAPIPE_MAX_SERIES` | `20` | Series kept after 03 D8's ranking pass. |
| `GIGAPIPE_MAX_RANK_SERIES` | `1000` | Ranking-response cardinality guard (03 §8.1). |
| `GIGAPIPE_METRIC_DEADLINE_MS` | `25000` | Strictly below the engine's fixed 30 s. |

Twelve variables, plus `TELEMETRY_RETENTION_DAYS` and `CLICKHOUSE_TELEMETRY_URL`, both of
which belong to other documents (`10` and `08` respectively) and are listed here only so the
CI grep has a complete allow-list.

**Container-side names, once, so nobody guesses.** gigapipe reads both `QRYN_*` and
`CLOKI_*` and `CLOKI_*` is assigned **after** `QRYN_*` in `portEnv`
(`cmd/gigapipe/main.go:172-183`), so `CLOKI_*` wins when both are set. `10` §3 already sets
`CLOKI_LOGIN`/`CLOKI_PASSWORD`. **Use `CLOKI_*`.** The previous version of this table said
`GIGAPIPE_USERNAME` "must match `QRYN_LOGIN`/`QRYN_PASSWORD`", which is false whenever ops
sets only `CLOKI_*` — the values would still match at runtime, but the *contract* named a
variable the compose file does not set, and `02:1860`, `05:1847` and `11`'s test compose all
inherited it. All four citations should say `CLOKI_*`.

**Three duplicated constants with no enforcement**, unchanged in kind and reduced in number:
`GIGAPIPE_DB`/`CLICKHOUSE_DB`, `GIGAPIPE_CLUSTER`/`CLUSTER_NAME`, and
`TELEMETRY_RETENTION_DAYS`/`SAMPLES_DAYS`. All three are surfaced on `observability.status`
(`database`, `clustered`, `retention`) so a mismatch is at least visible in the UI, and the
cluster one gets an active probe (§9.5). F14 / F20 / F21.

**The CI grep this table earns.** A `rg -n 'GIGAPIPE_[A-Z_]+|TELEMETRY_CLICKHOUSE|CLICKHOUSE_TELEMETRY'`
over `apps/`, `packages/`, `self-hosting/` and `docs/observability/`, with every hit
required to be in the allow-list above. It is the only mechanism that stops a sixth spelling
appearing, and settlement 9 is the evidence that it will otherwise happen. **The
credential-name half of it is load-bearing for security, not tidiness**: gigapipe installs
its Basic-auth middleware only when *both* values are non-empty
(`cmd/gigapipe/main.go:321-324`), and Compose substitutes a missing `.env` key with the
**empty string plus a warning**. A mismatch between the compose-set name and the
boot-asserted name therefore yields a *silently unauthenticated* gigapipe: `apps/api` keeps
sending an `Authorization` header, every healthcheck stays green, and gigapipe serves
`/loki/api/v1/push`, the Elastic `POST /_bulk` write routes and the always-on cleartext
HTTP/2 gRPC OTLP receiver to anything on the compose network. `10` F2's `${GIGAPIPE_USER:?…}`
guard only protects the name 10 happens to use. `11-testing-strategy.md` must promote 10's
smoke assertion — **an unauthenticated `GET /ready` against `op-gigapipe` returns 401** — to
a **blocking P0 gate**, because it is the only detector for the empty-credential state, and
add a gate asserting that the compose-set name and the boot-asserted name are the same
string.

**One more knob, on the container, that this work-stream must pin.**
`ADVANCED_PROMETHEUS_MAX_SAMPLES` is the only setting that feeds the PromQL engine's
`MaxSamples` (`cmd/gigapipe/main.go:201-206`). Its upstream default is in the `cloki-config`
module, which is not on disk here — **UNVERIFIED**, and `0` would fail every query. Pin it
explicitly at **`50000000`** (50 M, Prometheus' own default) in the ops work-stream's
compose service, and assert it in the upgrade-qualification suite beside T50.

### 4. The gigapipe client

#### 4.1 Route table and the request type

`src/routes.ts` is data. The client takes a route **key**, never a path, so an unlisted
endpoint is unreachable by construction. gigapipe mounts read and write routes on one
unprefixed `*mux.Router`, so there is no prefix a proxy could safely pass through.

```ts
// packages/gigapipe/src/routes.ts
export type GigapipeDialect = 'promql' | 'logql' | 'traceql';

export interface GigapipeRoute {
  method: 'GET' | 'POST';
  path: string;
  /** null => carries no selector. Requires `selectorless` + `why`. */
  dialect: GigapipeDialect | null;
  /** Keys the ROUTE treats as selector-bearing. Verified per element. D2. */
  selectorParams: readonly string[];
  /** Every key the route accepts. An unlisted key in query/form throws. D2. */
  knownParams: readonly string[];
  selectorless?: true;
  why?: string;
}

export const GIGAPIPE_ROUTES = {
  // ---- reads (this work-stream) ----
  promQueryRange: {
    method: 'POST', path: '/api/v1/query_range', dialect: 'promql',
    selectorParams: ['query'],
    knownParams: ['query', 'start', 'end', 'step', 'timeout'],
  },
  promQuery: {
    method: 'POST', path: '/api/v1/query', dialect: 'promql',
    selectorParams: ['query'],
    knownParams: ['query', 'time', 'timeout'],
  },
  lokiQueryRange: {
    method: 'GET', path: '/loki/api/v1/query_range', dialect: 'logql',
    selectorParams: ['query'],
    knownParams: ['query', 'start', 'end', 'step', 'limit', 'direction'],
  },
  lokiIndexStats: {
    method: 'GET', path: '/loki/api/v1/index/stats', dialect: 'logql',
    // `query` is selector-bearing AND mandatory: empty => GLOBAL stats
    // (reader/controller/query_range.go:248-278).
    selectorParams: ['query'],
    knownParams: ['query', 'start', 'end'],
  },

  // ---- reads deliberately absent ----
  //   /api/v1/metadata                 untenantable            (reader/service/metadata.go:39-62)
  //   /api/v1/labels, /api/v1/series   D3 — direct SQL (§9); also findings 4-6
  //   /api/v1/label/{n}/values         D3 — findings 4-6, incl. panic(err) at query_abels.go:165
  //   /loki/api/v1/labels              match hardcoded nil     (query_labels.go:39-40)
  //   /loki/api/v1/label/{n}/values    D3 — direct SQL (§9)
  //   /loki/api/v1/series              D3 — direct SQL (§9)
  //   /loki/api/v1/tail                D6
  //   /api/search, /api/traces/*       D11 — traces read ClickHouse directly
  //   /api/search/tags, /api/v2/search/tags  untenanted DISTINCT (reader/service/tempo.go:161-172)
  //   /api/v1/status/buildinfo         Version is hardcoded ""  (reader/router/misc.go:10)
  //   /pyroscope/*, /querier.v1.*      profiles are not ingested

  // ---- writes (ingest work-stream) ----
  otlpMetrics:     { method: 'POST', path: '/v1/metrics', dialect: null, selectorParams: [], knownParams: [], selectorless: true, why: 'ingest' },
  otlpLogs:        { method: 'POST', path: '/v1/logs',    dialect: null, selectorParams: [], knownParams: [], selectorless: true, why: 'ingest' },
  otlpTraces:      { method: 'POST', path: '/v1/traces',  dialect: null, selectorParams: [], knownParams: [], selectorless: true, why: 'ingest' },
  promRemoteWrite: { method: 'POST', path: '/api/v1/prom/remote/write', dialect: null, selectorParams: [], knownParams: [], selectorless: true, why: 'ingest' },
  lokiPush:        { method: 'POST', path: '/loki/api/v1/push',         dialect: null, selectorParams: [], knownParams: [], selectorless: true, why: 'ingest' },
} as const satisfies Record<string, GigapipeRoute>;

export type GigapipeRouteKey = keyof typeof GIGAPIPE_ROUTES;
```

**Method matters and is not guessable.** `/api/v1/query` and `/api/v1/query_range` take
GET **and** POST (`reader/router/prometheus_query_range.go:64-65`).
`/loki/api/v1/query_range`, `/query`, `/tail`, `/index/stats` are **GET-only**
(`reader/router/query_range.go:20-23`). The Loki *label/series* routes accept
`GET, POST, OPTIONS` (`reader/router/select_labels.go:17-20`) — but we do not call them
(D3), so the GET-only constraint that actually binds this work-stream is
`lokiQueryRange`'s, which is where §8.2's 8 KiB URL cap is load-bearing. gorilla/mux
answers a method mismatch with 405 and canonicalises the path with a **301 before
matching**, so a doubled slash converts a POST into a GET and drops the body. Emit
canonical paths.

`promQueryRange` is POST deliberately: a compiled PromQL selector with a `topk` wrapper,
eight `by (…)` labels and a long regex matcher runs past what is comfortable in a URL, and
the POST form path exists. `lokiQueryRange` has no choice.

**`buildInfo` is not in the table.** The previous draft used it as a version probe.
`RouteMiscApis` constructs `MiscController{Version: ""}` (`reader/router/misc.go:8-11`) and
`Buildinfo` writes `uc.Version` verbatim (`reader/controller/misc.go:64`), so it is always
the empty string; the alternate `/api/status/buildinfo` in `commonroutes` returns a
hardcoded `"0.0.1"` with a `//TODO: Replace with actual version`
(`shared/commonroutes/controller.go:28-34`). There is no version signal to key upgrade
qualification off. `status.version` is instead the **pinned image tag** from ops config
(§6.5), and reachability is probed by the cheapest real read we already make.

```ts
// packages/gigapipe/src/transport.ts
export interface GigapipeRequest {
  route: GigapipeRouteKey;
  /** Fills `:name` path params. Values are encodeURIComponent'd. */
  pathParams?: Record<string, string>;
  query?: Record<string, string | string[] | undefined>;
  /** POST form pairs. Serialised by us; see finding 1.2. */
  form?: Record<string, string | string[] | undefined>;
  body?: Uint8Array;            // ingest only
  contentType?: string;         // ingest only
  projectId: string;
  signal?: AbortSignal;
}

export async function gigapipeFetch<T>(req: GigapipeRequest): Promise<T>;
```

Note what is **absent**: `selectorParams`. D2.

#### 4.2 Transport — order of operations

1. `if (!gigapipeConfig.enabled) throw new GigapipeError('not_configured')`.
2. Look up the route. An unknown key is a `TypeError` at compile time and a throw at runtime.
3. **D2 gate**, all before the socket:
   - `route.dialect === null` ⇒ require `route.selectorless === true`, else throw `tenancy`.
   - else: every key in `route.selectorParams` must be present and non-empty in
     `query`/`form`; run `verify[route.dialect](element, req.projectId)` over **every
     element** of each; for `match[]`-style unions assert exactly one element across the
     union (D2).
   - every key present in `req.query`/`req.form` must be in `route.knownParams`, else throw
     `tenancy`. An undeclared parameter is how a selector smuggles itself in.
4. **Kill switch** (D15) and **circuit breaker** (§4.6) checks.
5. Build the URL: `new URL(route.path, gigapipeConfig.baseUrl)` after substituting
   `pathParams`, then append `query` via `URLSearchParams` (which handles repeated keys
   natively). Safe because §3 guarantees `baseUrl` is origin-only.
6. Headers: `Authorization` if configured; `Accept: application/json`;
   `Accept-Encoding: gzip` (see step 9); and for `form` requests the literal
   `Content-Type: application/x-www-form-urlencoded` with **no parameters** (finding 1.2).
   Never forward a caller-supplied header. Explicitly **strip** `X-CH-DSN`,
   `X-Scope-Meta`, `X-Ttl-Days` — the writer honours all three
   (`writer/controller/middleware.go:165-174`) and `writer/chwrapper/factory.go:246-268`
   contains dormant caller-supplied-DSN dialing primitives that a future release could wire
   up in one line.
7. `AbortSignal.any([timeoutSignal, req.signal])` so a client disconnect cancels the
   upstream call. **UNVERIFIED:** whether `@trpc/server` v11's Fastify adapter aborts
   `opts.signal` on client disconnect. *Settled by:* start a `metrics.chart` against a slow
   gigapipe, close the tab, look for an `abort` log line. If it does not, the timeout is
   the backstop and the lease still releases in `finally`.
8. `fetch(url, init)`.
9. **Read the body under a byte cap.** `res.body` is streamed through a counting reader
   that aborts at `maxResponseBytes`. Never `await res.text()` on an unbounded body.
   **The cap counts decompressed bytes.** gigapipe installs `AcceptEncodingMiddleware`
   globally (`cmd/gigapipe/main.go:320`) and Node's `fetch` transparently decompresses, so
   `res.body`'s chunks are already inflated and that is the number that matters for heap.
   A `Content-Length` header, when present, is the *compressed* size and is checked first
   as a cheap pre-abort at `maxResponseBytes` (a 32 MiB compressed body is at least 32 MiB
   decompressed), but its absence is normal on a chunked response and is not an error.
10. Map the status and parse (§4.4, §4.5).
11. Record duration, status, decompressed bytes and route on the injected observer (§4.7).

#### 4.3 Units and the step ladder

```ts
// packages/gigapipe/src/units.ts
type TimeEncoding = 'seconds' | 'nanoseconds' | 'auto';

/**
 * Total over every route key. `null` = the route takes no time parameter, which
 * makes T6's exhaustiveness test meaningful: `Record<K, TimeEncoding>` with a
 * `// ... ingest: never` comment does not compile, because Record is total.
 */
const TIME_ENCODING: Record<GigapipeRouteKey, TimeEncoding | null> = {
  promQueryRange:  'auto',          // ParseTimeSecOrRFC + epochToTime
  promQuery:       'auto',
  lokiQueryRange:  'nanoseconds',   // getRequiredFloat -> int64(ns)
  lokiIndexStats:  'nanoseconds',
  otlpMetrics:     null,
  otlpLogs:        null,
  otlpTraces:      null,
  promRemoteWrite: null,
  lokiPush:        null,
};

/** `Date` -> the wire string this specific route understands. Throws on a null route. */
export function encodeTime(route: GigapipeRouteKey, at: Date): string;

/**
 * Always unit-suffixed milliseconds. A bare number is SECONDS to `parseDuration`
 * (reader/controller/prom_query_range.go:355-366), so `step=60000` would be
 * 60 000 seconds. `60000ms` is unambiguous on both the Prometheus and Loki paths.
 */
export const encodeStep = (ms: number) => `${Math.round(ms)}ms`;
```

`'auto'` is encoded as unix **seconds** — the narrowest thing every parser accepts — so a
bug in `epochToTime`'s magnitude thresholds can never bite us. `'nanoseconds'` is emitted
as an integer decimal string derived from a `BigInt`, never from a `Number` (§4.4 note 4),
and the caller is told (D16) that the server rounds it to a ~256 ns grid regardless.

```ts
const STEP_LADDER_MS = [
  15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000,
  1_800_000, 3_600_000, 7_200_000, 10_800_000, 21_600_000, 43_200_000, 86_400_000,
] as const;

const GIGAPIPE_STEP_FLOOR_MS = 15_000;   // reader floors start/ceils end to 15s
const GIGAPIPE_MAX_POINTS = 11_000;      // 500 above this (prom_query_range.go:65-71)
const TARGET_MAX_POINTS = 1_500;         // our budget, well under, so the 500 never fires

const INTERVAL_MS: Record<IInterval, number> = {
  minute: 60_000, hour: 3_600_000, day: 86_400_000,
  week: 86_400_000, month: 86_400_000,
};

export interface ResolvedStep {
  stepMs: number;
  /** Coarsened when stepMs exceeds the requested bucket. D9. */
  effectiveInterval: IInterval;
}

export function resolveStepMs(interval: IInterval, rangeMs: number): ResolvedStep {
  const desired = INTERVAL_MS[interval];
  const needed = Math.ceil(rangeMs / TARGET_MAX_POINTS);
  const stepMs =
    STEP_LADDER_MS.find((s) => s >= Math.max(desired, needed, GIGAPIPE_STEP_FLOOR_MS)) ??
    STEP_LADDER_MS[STEP_LADDER_MS.length - 1]!;

  // The smallest interval whose bucket is >= stepMs. `week`/`month` share a
  // daily step because PromQL has no calendar arithmetic; the shaper folds
  // daily points into calendar weeks/months in the project's timezone, which is
  // only correct because every ladder value divides a day exactly.
  const effectiveInterval: IInterval =
    stepMs <= INTERVAL_MS.minute ? interval
    : stepMs <= INTERVAL_MS.hour ? (interval === 'minute' ? 'hour' : interval)
    : interval === 'minute' || interval === 'hour' ? 'day'
    : interval;

  return { stepMs, effectiveInterval };
}
```

**Worked example — nothing changes.** `range: '30d'`, `interval: 'hour'`.
`rangeMs = 2 592 000 000`; `desired = 3 600 000`; `needed = 1 728 000`; `stepMs = 3 600 000`
(1 h); 720 points/series; `effectiveInterval = 'hour'`. `resolution.effectiveInterval ===
requestedInterval`, so the UI says nothing.

**Worked example — the chart is coarsened and the user is told.** `range: '3m'`,
`interval: 'minute'` (server-accepted; only the UI blocks it, `constants/index.ts:281-285`).
`rangeMs ≈ 7 776 000 000`; `desired = 60 000`; `needed = 5 184 000`; `stepMs = 7 200 000`
(2 h); 1 080 points/series; `effectiveInterval = 'day'` — the smallest ladder-compatible
`IInterval` whose bucket (86 400 000) is `>= 7 200 000`. The shaper builds a **daily**
grid, twelve upstream points fold into each day, and `resolution` carries
`{ requestedInterval: 'minute', effectiveInterval: 'day', stepMs: 7_200_000 }`. The UI
renders "Showing daily resolution — the selected range is too long for minute buckets."
Without the ladder this would have been 129 600 points/series and gigapipe would have
answered **500**, which the UI would have rendered as "backend error".

Note the asymmetry the previous draft got right and this preserves: a step *finer* than
the bucket is normal and the shaper folds (a daily step under a `week` interval); a step
*coarser* than the bucket is the case that needs reporting, and `effectiveInterval` is how.

#### 4.4 Response parsing

Three wire shapes, all in `src/types.ts`, all validated with hand-written narrow guards
rather than zod (hot paths returning up to 11 000 points × 200 series; a zod parse of that
is real CPU).

```ts
// Prometheus matrix — reader/controller/prom_query_range.go:240-286
export interface PromMatrixResponse {
  status: 'success';
  data: {
    resultType: 'matrix';
    result: Array<{ metric: Record<string, string>; values: Array<[number, string]> }>;
  };
}
// Prometheus instant vector — same file, writeVector
export interface PromVectorResponse {
  status: 'success';
  data: { resultType: 'vector'; result: Array<{ metric: Record<string, string>; value: [number, string] }> };
}
// Loki streams — reader/service/query_range.go:430-520
export interface LokiStreamsResponse {
  status: 'success';
  data: { resultType: 'streams'; result: Array<{ stream: Record<string, string>; values: Array<[string, string]> }> };
}
```

Four properties a naive implementation gets wrong:

1. **Timestamps are float seconds, values are strings.** `writeMatrix` emits
   `stream.WriteFloat64(v.T/1000)` and `strconv.FormatFloat(v.F,'f',-1,64)`
   (`prom_query_range.go:266-276`). `"NaN"`, `"+Inf"`, `"-Inf"` are all legal on the wire.
   `Number("NaN")` is `NaN`, and `sum()` in `packages/common/src/math.ts:20-25` filters
   with a bare `isNumber` and therefore **propagates `NaN` into `metrics.sum`**, which then
   sorts the series array (`packages/db/src/engine/format.ts:153`) into an undefined order.
   The parser coerces every non-finite to `0` at the boundary and counts it.
2. **Label order is Go map order.** `for name, value := range s.Metric.Map()`
   (`prom_query_range.go:257`) is randomised per call. `IChartSerie.id` feeds a recharts
   `dataKey`, a React key **and** the persisted `visibleSeries` string array
   (`packages/db/prisma/schema.prisma:446`), so non-deterministic ordering silently decays
   saved chart selections. The client returns labels as a key-sorted
   `[string, string][]` alongside the raw record so the shaper cannot get this wrong.
3. **Only `s.Floats` is serialised** (`prom_query_range.go:266`). Native histogram samples
   (`s.Histograms`) are dropped without a marker: a metric ingested as a native histogram
   returns an empty `values` array, not an error. F16.
4. **Loki stream values are `[nsString, line]`** — nanoseconds as a decimal *string*,
   because they exceed 2^53. Never `Number()` them; keep them as strings and compare as
   `BigInt`. This is a **response**-side rule and remains correct; the matching
   request-side rule is the opposite (D16): the server rounds request timestamps to a
   ~256 ns grid, so cursoring is overlap-and-dedupe, not `+1n`.

**Response verification** runs on the **raw wire array**, before any mapping. The tenancy
work-stream declares
`verifyResponseLabels(series: Array<{ metric: Record<string, string> }>, projectId: string)`
(`01-tenancy-and-security.md:1424-1436`). §5's `PromSeries` exposes the label bag as
`labels`, and Loki stream objects carry `stream`, so **neither maps onto that signature
after conversion**. Pin it here and mirror it in the tenancy spec:

```ts
// packages/gigapipe/src/read/prometheus.ts
const parsed = assertPromMatrix(json);
verifyResponseLabels(parsed.data.result, projectId);        // { metric } — exact shape
return parsed.data.result.map(toPromSeries);

// packages/gigapipe/src/read/loki.ts — the Loki objects carry `stream`, not `metric`
verifyResponseLabels(
  parsed.data.result.map((r) => ({ metric: r.stream })),    // adapter, no copy of values
  projectId,
);
```

The tenancy work-stream owns the function; this work-stream owns the two call sites and
the adapter, and both specs must state the same shape. `verifyResponseLabels` has **no
stub**: `packages/gigapipe` imports it as a hard dependency and does not ship a
`() => true` placeholder, because a placeholder silently disables F11 and F11 is a paging
signal. If the tenancy layer ships later, `src/read/*.ts` does not compile — which is the
correct failure.

#### 4.5 Errors

```ts
// packages/gigapipe/src/errors.ts
export type GigapipeErrorKind =
  | 'not_configured'      // GIGAPIPE_URL unset or bad_base_url
  | 'disabled'            // kill switch (D15)
  | 'unauthorized'        // 401 from BasicAuthMiddleware
  | 'bad_request'         // 400, or a re-kinded 500 (below)
  | 'not_found'           // 404 — includes the plain-text trace 404
  | 'method_not_allowed'  // 405 — a route-table bug, always
  | 'too_large'           // 413 from the OTLP size cap, or our own byte cap
  | 'upstream_error'      // 5xx with a parseable {status:"error"} envelope
  | 'malformed_response'  // 2xx whose body will not parse — finding 1.3
  | 'timeout'             // our AbortSignal fired, or a re-kinded engine timeout
  | 'unavailable'         // ECONNREFUSED / DNS / breaker open
  | 'cancelled'           // the caller's signal fired
  | 'too_many_requests'   // our own lease, not gigapipe's
  | 'tenancy'             // D2 gate or response verification refused
  ;

export class GigapipeError extends Error {
  constructor(
    readonly kind: GigapipeErrorKind,
    message: string,
    readonly detail?: { status?: number; route?: GigapipeRouteKey; upstream?: string },
  ) { super(message); }
}
```

`upstream` carries gigapipe's own `error` string verbatim **for the log line only**. It is
never returned to the browser: those strings contain generated SQL and ClickHouse table
names (`res.Err.Error()` at `prom_query_range.go:93-94` is the ClickHouse driver's error).
The tRPC message is a fixed sentence per kind.

| kind | tRPC code | Message shown to the user | UI retry? |
|---|---|---|---|
| `not_configured` | — | *never thrown from a procedure*; `status.enabled=false` | — |
| `disabled` | — | *never thrown*; `status.degraded='disabled'`, empty shapes | — |
| `unauthorized` | `INTERNAL_SERVER_ERROR` | "Observability backend is misconfigured." | no |
| `bad_request` | `BAD_REQUEST` | see the three re-kind rules below | no |
| `not_found` | `NOT_FOUND` | "Not found." | no |
| `method_not_allowed` | `INTERNAL_SERVER_ERROR` | "Observability backend is misconfigured." | no |
| `too_large` | `PAYLOAD_TOO_LARGE` | "That query returned too much data. Narrow the range or add a filter." | no |
| `upstream_error` | `INTERNAL_SERVER_ERROR` | "The observability backend could not answer that query." | yes, with backoff |
| `malformed_response` | `INTERNAL_SERVER_ERROR` | same | **exactly one retry, then no** |
| `timeout` | `TIMEOUT` | "That query took too long. Narrow the range, add a filter, or shorten the interval." | **no** |
| `unavailable` | `INTERNAL_SERVER_ERROR` | "Observability is temporarily unavailable." | yes, with backoff |
| `cancelled` | — | swallowed; nothing is thrown to a socket that is gone | — |
| `too_many_requests` | `TOO_MANY_REQUESTS` | "Too many observability queries running for this project. Try again in a moment." | yes |
| `tenancy` | `FORBIDDEN` | "Query rejected." | **no — and it pages** |

**Three 500-body re-kind rules, not one.** Finding 1.5: gigapipe returns 500 for several
things that are not server faults, and the previous draft special-cased only the rarest.
`src/read/prometheus.ts` matches the upstream message, case-insensitively, in this order:

| Upstream 500 body contains | Re-kinded to | Message | UI retry? |
|---|---|---|---|
| `11,000 points` | `bad_request` | "That range needs a larger step." | no |
| `too many samples` (`promql.ErrTooManySamples`) | `bad_request` | "That query touches too much data. Narrow the range or add a filter." | no |
| `context deadline exceeded` / `query timed out` | `timeout` | as `timeout` above | **no** |
| *(anything else)* | `upstream_error` | "The observability backend could not answer that query." | yes, with backoff |

The middle two matter more than the first. The PromQL engine's timeout is a hardcoded 30 s
(finding 1.4) and §3 deliberately sets the client timeout *above* it, so a slow query
normally comes back as a **gigapipe 500**, not as the client's `timeout`. Without the rule
the UI would retry — with backoff — a query that just burned 30 s of the ClickHouse the
event charts share. `ErrTooManySamples` is likewise far more likely on a real
high-cardinality metric than the `11,000 points` case §8.1 already makes unreachable.

**This is string matching against upstream error text and it will break on a gigapipe
upgrade.** T49 asserts all three strings against a real instance and gates every
image-digest bump.

**`tenancy` is not a user error.** Every path that produces it is either the D2 gate
refusing to send or `verifyResponseLabels` finding a series that does not carry our project
id. Both mean a compiler invariant broke. The response is dropped whole,
`openpanel_telemetry_response_label_mismatch_total` increments, and it pages.

#### 4.6 Timeouts, retries, cancellation, circuit breaker

**Retries.** Only `unavailable` (connection-level), and only for idempotent reads — every
route in the read half. Two retries, `120 ms` then `480 ms`, full jitter. Plus exactly one
retry for `malformed_response` (finding 1.3 is a race, not a determinism). **Not retried
at all:** `timeout` (a query that took 35 s will take 35 s again and the retry stacks on
the shared ClickHouse), `upstream_error`, `bad_request`, `unauthorized`, `too_large`,
`tenancy`, `too_many_requests`. One number, stated once: `malformed_response` gets exactly
one retry, no backoff.

**Circuit breaker.** Per-process, keyed by nothing (there is one gigapipe). Ten consecutive
`unavailable`/`timeout` results within 30 s opens it for 15 s; the next call after that is
a single probe. While open, every call throws `unavailable` without touching the socket,
which is what keeps `observability.status` cheap when gigapipe is down. Exposed as
`getBreakerState()`.

The breaker is **not** in the minimum shippable slice. There is one internal service, a
35 s timeout bounds every call, and `status` already reports reachability; it is the most
deferrable thing in the transport. It ships in the full work-stream row with its own test
(T11).

**Rejected: a shared breaker in Redis.** With `OP_API_REPLICAS` typically 2-3 a per-process
breaker converges within one probe interval and costs no round trip. A Redis-backed breaker
adds a Redis dependency to the exact code path that runs when infrastructure is unhealthy.

**Cancellation.** `req.signal` from the tRPC procedure, per §4.2 step 7.

#### 4.7 Instrumentation

`packages/gigapipe` does **not** import `prom-client`. `apps/api` declares
`fastify-metrics@^12.1.0` and no `prom-client`; `apps/worker` declares `prom-client@^15.1.3`
(`apps/worker/package.json:35`) and builds its own `new Registry()`
(`apps/worker/src/metrics.ts:14-16`). Under pnpm's isolated `node_modules` an undeclared
`import 'prom-client'` from `packages/gigapipe` is a hard `MODULE_NOT_FOUND`.

```ts
// packages/gigapipe/src/transport.ts
export interface GigapipeObserver {
  onRequest(sample: {
    route: GigapipeRouteKey;
    projectId: string;
    status: number | null;
    kind: GigapipeErrorKind | 'ok';
    durationMs: number;
    bytes: number;
  }): void;
}
export function setGigapipeObserver(o: GigapipeObserver): void;
```

**Lifecycle, which the previous draft left undefined.**

- `setGigapipeObserver` is **process-wide module state**, not per-Fastify-instance. It
  defaults to a no-op. `apps/api` and `apps/worker` each wire their own; the worker's P5
  alert evaluation gets no metrics unless it calls it, so that wiring is an explicit item
  on the alerting work-stream's list, not an inherited freebie.
- In `apps/api` the observer **cannot** be wired "after the metrics plugin" from the
  dashboard instance. `metricsPlugin` is registered at `apps/api/src/app.ts:372`, inside
  the *public API* encapsulated instance and behind `if (!testing)`; the tRPC router and
  `/live` live in a different encapsulated instance (`app.ts:137-214`). Fastify decorators
  do not cross that boundary. So the wiring is a two-line plugin registered immediately
  after `metricsPlugin`, in the same encapsulation and under the same guard:

  ```ts
  if (!testing) {
    instance.register(metricsPlugin, { endpoint: '/metrics' });
    instance.register(async (i) => setGigapipeObserver(createPromObserver(i.metrics.client)));
  }
  ```

  Under Vitest, and if the plugin is ever removed, no observer is set and the transport's
  `observer?.onRequest` is a no-op. That is the specified behaviour, not an accident: the
  transport must never depend on an observer being present.
- **UNVERIFIED:** which registry `fastify-metrics` v12 serves — whether metrics created on
  `i.metrics.client`'s default registry are scraped, or whether the plugin owns a private
  one. The module is not installed in this checkout. *Settled by:* `pnpm install`, then
  read `node_modules/fastify-metrics/dist/plugin.js` for the `promClient`/`register`
  handling. `createPromObserver` takes the client and registers explicitly on the registry
  the plugin serves, so this is a wiring detail behind the indirection, not a design risk.

Metrics emitted by the `apps/api` adapter — the names matter because "gigapipe is slow"
and "ClickHouse is slow" must be separable from a dashboard:

- `openpanel_gigapipe_request_duration_seconds{route,kind}` histogram
- `openpanel_gigapipe_response_bytes{route}` histogram
- `openpanel_gigapipe_errors_total{route,kind}` counter
- `openpanel_gigapipe_breaker_open` gauge
- `openpanel_telemetry_lease_wait_seconds` histogram, `…_lease_rejected_total` counter
- `openpanel_telemetry_metadata_query_duration_seconds{query}` histogram — the §9 SQL,
  which does **not** go through gigapipe and would otherwise be invisible
- `openpanel_telemetry_response_label_mismatch_total` counter (pages)

`projectId` is a **log field, never a metric label**. Cardinality.

### 5. Seam with the metrics engine

This work-stream hands the metrics engine a parsed, verified, unit-normalised matrix. It
does not build `FinalChart`.

```ts
// packages/gigapipe/index.ts — the read surface consumed by @openpanel/db
export interface PromSeries {
  /** raw labels exactly as gigapipe sent them, op_project_id still present */
  labels: Record<string, string>;
  /** the same, key-sorted, for deterministic identity (§4.4 note 2) */
  sortedLabels: Array<[string, string]>;
  /** epoch milliseconds (integers), value already finite-coerced */
  points: Array<{ t: number; v: number }>;
  /** how many non-finite wire values were coerced to 0 in this series */
  coerced: number;
}

export function promQueryRange(args: {
  projectId: string;
  query: string;            // already compiled + tenancy-scoped by the tenancy layer
  start: Date;
  end: Date;
  stepMs: number;
  signal?: AbortSignal;
}): Promise<PromSeries[]>;

export function promQueryInstant(args: {
  projectId: string; query: string; at: Date; signal?: AbortSignal;
}): Promise<PromSeries[]>;   // one point per series
```

`promQueryRange` runs `verifyResponseLabels` on the raw wire array before mapping (§4.4)
and leaves `op_project_id` **in** the labels. Stripping it is the shaper's job and must
happen *after* verification, so verification has something to verify.

**The shaper contract**, amended from the previous draft in three places (D5, D9, and
`visibleSeries`):

```ts
// owned by 03-metrics-engine.md
export function shapeMatrixToFinalChart(
  series: PromSeries[],
  opts: {
    /** what the shaper builds the date grid from — may be coarser than requested (D9) */
    effectiveInterval: IInterval;
    /** the upstream resolution, so the shaper knows how many points fold per bucket */
    stepMs: number;
    timezone: string;
    startDate: string;          // 'yyyy-MM-dd HH:mm:ss', naive project-local
    endDate: string;
    previous: PromSeries[] | null;
    /** feeds globalMetrics BEFORE the limit slice — format.ts:155-168 */
    visibleSeries: string[] | null;
    limit: number | null;
  },
): FinalChart;
```

`visibleSeries` and `limit` are not cosmetic and the previous draft's schema declared them
with no consumer. In the event path `globalMetrics` is computed from
`visibleConcreteSeries` **before** `series.slice(0, limit)`
(`packages/db/src/engine/format.ts:155-168`); a metrics shaper that ignores them makes an
observability chart's `metrics.sum` disagree with an event chart's under identical UI
state. Conversely `unit`, `lineType` and `chartType` are renderer props with no resolver
consumer, and are **removed** from `zObservabilityChartInput` (§6.2).

The engine owns: zero/carry fill against gigapipe's 5-minute lookback (finding 1.4),
`slug()`ed ids built from `sortedLabels`, the `'yyyy-MM-dd HH:mm:ss'` naive project-local
date strings that `use-rechart-data-model.ts:28` matches by exact string equality, and the
calendar fold for `week`/`month`.

### 6. The `observability` router

Mounted in `packages/trpc/src/root.ts` as `observability: observabilityRouter`.

#### 6.1 The base procedure

```ts
// packages/trpc/src/routers/observability.ts

/**
 * Procedures whose input has no top-level `projectId`, and which are therefore
 * INVISIBLE to `enforceAccess` (packages/trpc/src/trpc.ts:99-103 documents this
 * hole). Each one MUST resolve its project and call `requireProjectAccess` in
 * its own handler. Fail-closed: anything not on this list and without a
 * projectId is a BAD_REQUEST, so a new procedure cannot slip through by
 * forgetting the field.
 */
const NO_PROJECT_ID: ReadonlySet<string> = new Set([
  'observability.traces.forSession',   // { sessionId, from, to } - 06-traces-and-correlation.md:1463
]);

const observabilityProcedure = protectedProcedure.use(
  async ({ ctx, path, next, getRawInput }) => {
    const raw = (await getRawInput()) as
      | { projectId?: string; shareId?: string }
      | undefined;

    // D4 / 7.2: telemetry is never reachable through a share, in any phase.
    if (raw?.shareId) {
      throw new TRPCForbiddenError('Observability data is not available on shared links');
    }
    if (!raw?.projectId && !NO_PROJECT_ID.has(path)) {
      throw new TRPCBadRequestError('projectId is required');
    }
    // D15
    if (await isObservabilityDisabled(raw?.projectId ?? null)) {
      throw new GigapipeError('disabled', 'Observability reads are disabled');
    }
    return next();
  },
);
```

Everything the previous draft hand-rolled - session validation, `requireProjectAccess`,
the demo-mode guard, the `organizationId` branch - is already `enforceAccess`, which
`protectedProcedure` composes (`packages/trpc/src/trpc.ts:90-112, 175-180`). D13.

Ordering is safe in both directions: `enforceAccess` runs first and either throws or
passes; the share rejection and the kill-switch check then run before the handler. A
caller who sends both `shareId` and `projectId` gets `FORBIDDEN` from whichever fires
first, which is the correct answer either way.

**Caching.** `cacher` is applied per-procedure, not folded into the base, because
`cacheMiddleware` (`packages/trpc/src/trpc.ts:186-213`) must run **after** the access
check - a cache hit must never answer a caller with no access to the project.

```ts
const AUTOCOMPLETE = new Set([
  'observability.metrics.names',
  'observability.metrics.labelKeys',
  'observability.metrics.labelValues',
  'observability.logs.labelKeys',
  'observability.logs.labelValues',
]);

const cacher = cacheMiddleware((_input, opts) => {
  if (opts.path === 'observability.status') return 10;
  if (opts.path === 'observability.logs.query') return 0;   // never cached
  if (AUTOCOMPLETE.has(opts.path)) return 0;                // cached in the service
  if (opts.path.startsWith('observability.logs.')) return 30;
  return 60;                                                // metrics.chart / instant
});
```

Two fixes to the previous draft. Its `observability.metadata.*` branch was dead code - no
procedure has that path prefix - so `metrics.labelValues` silently took the 60 s default
and `logs.labelKeys` took the 30 s logs branch. And the autocomplete procedures are already
Redis-cached for 5 minutes *inside* the metadata service (9.1); a second tRPC-level TTL
stacks to up to 10 minutes of staleness on a newly-ingested metric (Q5). One cache layer,
in the service, where the key includes `sinceDays` and the search term.

**Local-dev note for anyone verifying caching by hand:** `cacheMiddleware` always *writes*
but only *reads* when `process.env.NODE_ENV === 'production'` (`trpc.ts:203`). Locally you
will observe no caching in either direction. T27 therefore asserts the cache **key**, not
observed cache behaviour.

#### 6.2 Procedures - metrics

| Procedure | Input | Output | gigapipe endpoint |
|---|---|---|---|
| `metrics.chart` | `zObservabilityChartInput` | `IObservabilityChartResult` (D5) | `POST /api/v1/query_range` x (series x periods) |
| `metrics.instant` | `{ projectId, query: zMetricQuery, at? }` | `Array<{ labels, value }>` | `POST /api/v1/query` |
| `metrics.names` | `{ projectId, search?, sinceDays? }` | `Array<{ name, type, unit, help }>` | **none** - section 9.1 |
| `metrics.labelKeys` | `{ projectId, metric, sinceDays? }` | `string[]` | **none** - section 9.2 |
| `metrics.labelValues` | `{ projectId, metric, key, search?, sinceDays? }` | `string[]` | **none** - section 9.3 |

```ts
export const zObservabilityChartInput = z.object({
  projectId: z.string(),
  /** Max 6 - the lease covers 2x this on `previous` (D8). */
  series: z.array(zMetricQuery).min(1).max(6),
  range: zRange.default('30d'),
  startDate: z.string().nullish(),
  endDate: z.string().nullish(),
  interval: zTimeInterval.default('hour'),
  previous: z.boolean().default(false),
  /** Feeds globalMetrics before the limit slice - format.ts:155-168. */
  visibleSeries: z.array(z.string()).nullish(),
  limit: z.number().int().min(1).max(200).nullish(),
});
```

`range` / `startDate` / `endDate` / `interval` are reused verbatim from `zReportInput`
(`packages/validation/src/index.ts:238-268`) so the existing date-picker component and
`getChartStartEndDate` (`packages/db/src/services/date.service.ts:248`) work unchanged, and
so the cache key has the same shape as an event chart's. `unit`, `lineType` and `chartType`
are **not** on the input: the resolver has no use for them and the renderer already has
them from the report/tile config.

`metrics.chart` body, in order:

1. `getSettingsForProject(projectId)` gives `timezone`.
2. `getChartStartEndDate(input, timezone)` gives naive `'yyyy-MM-dd HH:mm:ss'` strings.
3. Subscription clamp. **`getOrganizationSubscriptionChartEndDate` returns `null` when the
   organization cannot be resolved** (`packages/db/src/services/organization.service.ts:321-328`),
   so the literal clamp the previous draft described would set `endDate = null` and produce
   an invalid range. Copy `executeChart`'s guard exactly
   (`packages/db/src/engine/index.ts:29-37`):

   ```ts
   const clamped = await getOrganizationSubscriptionChartEndDate(projectId, endDate);
   if (clamped) endDate = clamped;
   ```
4. `resolveStepMs(interval, rangeMs)` gives `{ stepMs, effectiveInterval }` (D9).
5. Retention **annotation** (D14): compute `oldestQueryableAt = now - retentionDays`. Do
   not move `startDate`. If `previous` is requested and the whole previous window ends
   before `oldestQueryableAt`, set `resolution.previous = 'unavailable_retention'` and do
   not issue those calls - which also halves the fan-out.
6. Acquire the lease, once (D8, section 8.4).
7. `Promise.all` over series x periods **behind a `fanoutConcurrency` limiter** (D8), each
   `compileSelector` + `compileAggregation` (tenancy) then `promQueryRange` (this package).
8. `shapeMatrixToFinalChart(...)` with `effectiveInterval`, `stepMs`, `visibleSeries`,
   `limit` (section 5).
9. Release the lease in `finally`.
10. Return `{ chart, resolution }`.

`metrics.instant` returns `[]` for an empty vector - an instant query over a metric with no
samples in the 5-minute lookback is a legitimate empty answer, not an error.

#### 6.3 Procedures - logs

| Procedure | Input | Output | gigapipe endpoint |
|---|---|---|---|
| `logs.query` | `{ projectId, stream, filters, from, to, direction, limit (max 1000), cursor? }` | `ILogPage` | `GET /loki/api/v1/query_range` (streams) |
| `logs.histogram` | same minus paging, plus `interval` | `IObservabilityChartResult` | `GET /loki/api/v1/query_range` (matrix) |
| `logs.labelKeys` | `{ projectId, sinceDays? }` | `string[]` | **none** - section 9.2 with `type IN (1,0)` |
| `logs.labelValues` | `{ projectId, key, search?, sinceDays? }` | `string[]` | **none** - section 9.3 |
| `logs.volume` | `{ projectId, from, to }` | `{ bytes, lines }` | `GET /loki/api/v1/index/stats` |

Two transport constraints specific to logs:

- **`/loki/api/v1/query_range` is GET-only** (`reader/router/query_range.go:20-21`), so the
  compiled LogQL travels in the query string. Section 8.2 caps the compiled length at 8 KiB
  and the router returns `BAD_REQUEST` above it, because the alternative - a 431 or a silent
  truncation at a proxy - is undebuggable. (The Loki *label/series* routes do accept POST,
  `select_labels.go:17-20`, but we do not call them; D3.)
- **`start`/`end` are nanoseconds with ~256 ns effective resolution** (finding 1.1, D16).

**Cursor semantics - specified, not implied.** The previous draft said only "the cursor is
a string, never a number", which does not survive contact with a server that rounds
timestamps.

```ts
export interface ILogCursor {
  /** ns as a decimal string. The BOUNDARY of the previous page, not an exclusive bound. */
  edgeNs: string;
  /** Hashes of every line already returned within EDGE_NS of edgeNs. */
  edgeHashes: string[];
}
export interface ILogPage {
  lines: ILogLine[];
  cursor: ILogCursor | null;   // null => no further page
}

/** Comfortably above the ~256 ns float64 grid, small enough that edgeHashes stays tiny. */
const EDGE_NS = 1_000n;         // 1 microsecond
const lineKey = (tsNs: string, line: string) => `${tsNs} ${line}`;
```

- `direction: 'backward'` (newest first, the explorer default): page n+1 queries
  `[from, edgeNs + EDGE_NS]`, drops any line whose `lineKey` hash is in `edgeHashes`, and
  takes `limit`. The `+ EDGE_NS` guarantees the boundary is *included* despite rounding;
  the hash set is what removes the duplicates. A bound of `edgeNs - 1` would drop lines.
- `direction: 'forward'`: mirror image, `[edgeNs - EDGE_NS, to]`.
- Two lines sharing a nanosecond are distinguished by the line body, which is the only
  discriminator the wire provides. Two byte-identical lines at the same nanosecond are
  genuinely indistinguishable and one is dropped; that is a documented limit, not a bug to
  chase.
- The cursor is opaque to the client: base64 of the JSON above, validated on the way back
  in and rejected (not trusted) if `edgeHashes.length > 256`.

`logs.query` is **never cached** (TTL 0). A log explorer whose "refresh" returns a
60-second-old page is worse than one that is slow, and a 60 s key would be shared across
every member of the project.

#### 6.4 Procedures - traces

Per D11 the trace procedures listed in `06-traces-and-correlation.md:1460-1465`
(`traces.search`, `traces.byId`, `traces.tagValues`, `traces.forSession`, `traces.latency`)
live on this router but their bodies are direct ClickHouse and are specified in that
document. What this spec owns for them: they compose `observabilityProcedure`, they take
the lease, and `traces.forSession` is on the `NO_PROJECT_ID` allow-list (6.1) and therefore
**must** resolve the session's project and call `requireProjectAccess` in its own handler.
A test asserts the allow-list has exactly the members listed and that each member performs
its own check (T25b).

#### 6.5 `observability.status`

```ts
export interface IObservabilityStatus {
  enabled: boolean;            // GIGAPIPE_URL is set and parseable
  reachable: boolean;          // last probe succeeded / breaker closed
  schemaReady: boolean;        // gigapipe's tables exist and are readable in TELEMETRY_DB
  hasData: boolean;            // this project has at least one time_series_gin row
  signals: { metrics: boolean; logs: boolean; traces: boolean };
  retentionDays: number;
  oldestQueryableAt: string;   // 'yyyy-MM-dd HH:mm:ss', project-local
  /** Resolved TELEMETRY_DB - must equal the container's CLICKHOUSE_DB (finding 1.8). */
  database: string;
  /** Resolved GIGAPIPE_CLUSTER_NAME decision - must match the container's CLUSTER_NAME. */
  clustered: boolean;
  /** Pinned image tag from ops config. NOT from /api/v1/status/buildinfo (4.1). */
  version: string | null;
  degraded:
    | null
    | 'not_configured'
    | 'disabled'          // D15 kill switch
    | 'insecure'          // GIGAPIPE_URL set, no credentials - finding 1.7, F18
    | 'unreachable'
    | 'breaker_open'
    | 'schema_missing'
    | 'cluster_mismatch'; // section 9.5 probe
}

status: observabilityProcedure
  .use(cacher)
  .input(z.object({ projectId: z.string() }))
  .query(async ({ input }) => { /* every probe individually wrapped */ }),
```

Two corrections to the previous draft: it wrote `.use(cacheMiddleware(10))` on top of a
`cacher` that already returns 10 for this path (two middlewares, two Redis round trips),
and `.input({projectId})` is not a zod schema and does not compile.

`degraded` is a single value; when several apply the first in the enum order above wins,
which is also decreasing order of "the operator must fix this first".

A ClickHouse `UNKNOWN_TABLE` (60), `UNKNOWN_DATABASE` (81) or `ACCESS_DENIED` (497) from the
`hasData` probe becomes `schemaReady: false` - the correct answer during the window between
"the compose file gained a gigapipe service" and "gigapipe finished `InitDB`", and also
what a missing grant looks like (section 9.6). `signals.*` comes from one cheap query plus
one trace probe (section 9.4).

**Client contract**, because D5 makes the renderer responsible for acting on this:

- The dashboard shell fetches `status` **once per project navigation** and holds it in the
  tRPC query cache with `staleTime: 30_000`. The server-side TTL is 10 s; the client's is
  longer on purpose, so a shell re-render is free.
- `enabled: false` means the observability nav items are **hidden**, not disabled. There is
  nothing for the user to do.
- `enabled: true, schemaReady: false` means the nav is visible and each surface renders
  "Setting up - the telemetry backend has not finished creating its tables." That state is
  expected for seconds after first boot and permanent if `CLICKHOUSE_DB` is wrong (F20), so
  the panel also shows `database` and a doc link.
- `degraded: 'insecure'` renders a red banner on every observability surface, for org
  admins only, naming `GIGAPIPE_USERNAME` / `GIGAPIPE_PASSWORD`.
- `degraded: 'disabled'` renders "Observability is temporarily disabled by your
  administrator."
- `UNAUTHORIZED` / `FORBIDDEN` from `status` itself renders nothing (D10). It means the
  shell asked before project access resolved, or the page was reached via a share link.
- The chart surfaces compare their resolved range against `oldestQueryableAt` and render
  "Data before <date> has been deleted" (F4). `metrics.chart` also returns
  `oldestQueryableAt` on `resolution`, so a chart tile that never fetched `status` still
  has it.

### 7. Access control

#### 7.1 Member path

Entirely `enforceAccess` via `protectedProcedure` (D13): authenticated session plus
`requireProjectAccess({ level: 'read' })` for every query with a top-level `projectId`.
Note honestly what that buys at `level: 'read'`: membership. The `canWriteProject` branch
only exists at `level: 'write'` (`packages/trpc/src/access.ts:39-61`). Using the named
helper is about not diverging from the central middleware, not about closing a hole.

This router has **no mutations**. That distinction would bind the moment saved metric
reports land (D4), and at that point the write goes through `report.create` /
`report.update`, which are `protectedProcedure` mutations already covered by
`enforceAccess`'s `needsWrite` branch (`trpc.ts:104-111`). Nothing extra is needed - but
the metrics-engine work-stream **must not** add a "save metric report" mutation to *this*
router, where the reader-level default would apply. A test asserts the router contains no
mutation (T25c).

#### 7.2 Share path - closed, deliberately, in every phase

The base procedure **rejects any input carrying `shareId`** rather than validating it.
Three reasons, in increasing order of durability:

1. Per D4 no stored report can hold a metric series, so a valid share of one cannot exist.
   A share branch that "works" would be dead code nobody tests.
2. Logs and traces must never be shareable, in any phase. A shared dashboard link is
   unauthenticated by design; log lines contain user emails, tokens, stack traces and
   request bodies. That policy should not be re-litigated per phase, so the rejection lives
   in the base procedure where a new procedure inherits it by default.
3. `validateShareAccess` throws a bare `new Error(...)` for a missing or non-public share
   (`packages/db/src/services/share.service.ts:148,186,214`), which tRPC renders as
   `INTERNAL_SERVER_ERROR`, not `FORBIDDEN`. Cloning `chartProcedure`'s share branch clones
   that inconsistency into the one router the plan calls a security boundary.

When metric reports become shareable the change is: `metrics.chart` gains a share branch
**that requires `ctx.report.dataSource === 'metrics'`** and never falls back to
`input.series`; `logs.*` and `traces.*` keep the rejection. Separate PR, its own
`createCaller` test modelled on `packages/trpc/src/routers/share.test.ts`.

One pre-existing bug worth recording because a reviewer will find it next door:
`share.dashboardReports` (`packages/trpc/src/routers/share.ts:262`) returns every report on
a shared dashboard with no chart-type filtering, so a `sankey` report on a shared dashboard
renders a component that calls a `protectedProcedure`. Not introduced here, not fixed here.

#### 7.3 Deleted projects, wind-down, and subscription state

`subscriptionHook` (`apps/api/src/hooks/subscription.hook.ts:28`; the file is 74 lines)
gates *ingest*, not reads, and this router does not touch it. The read-side equivalent is
the `getOrganizationSubscriptionChartEndDate` clamp in 6.2 step 3: an organization past its
subscription chart end date sees metrics stop at that date, exactly as event charts do. A
metrics engine that skips the clamp produces a billing-enforcement asymmetry where the
metric chart shows data the event chart hides.

**Deleted projects - the read-path containment argument.** `cron.wind-down.ts` arms
`deleteAt`, the delete cron sweeps, and `deleteFromClickhouse`
(`packages/db/src/services/delete.service.ts:39-72`) enumerates a fixed list of
**OpenPanel** tables and touches nothing in `TELEMETRY_DB`. So after a project is deleted
the Postgres project and organization rows are gone while gigapipe still holds that
project's log lines and spans until the global TTL or the ops work-stream's sweep. The
read surface is nonetheless closed, and this is the whole GDPR answer for it:

> Every procedure on this router runs `requireProjectAccess`, which resolves membership
> from Postgres and fails closed when the project row is gone. There is no path from a
> deleted project's id to its telemetry.

That argument only holds if the metadata service is never called with a projectId that did
not come from an access-checked procedure. **This forbids P6's MCP tools from calling
`getMetricCatalog` / `getMetricLabelKeys` / ... directly**, which contradicts the previous
draft's Interfaces row. The row is corrected below: MCP either goes through the router, or
performs its own `requireProjectAccess`-equivalent check first. The service functions carry
a doc comment saying so.

### 8. Query cost controls

Everything here exists because gigapipe queries the **same ClickHouse instance** the event
charts query. An unbounded observability dashboard degrades product analytics for the same
customer, on a shared cluster for every customer.

**What is bounded and what is not.** The lease bounds one project. The fan-out limiter
bounds one chart. Nothing here bounds the **aggregate** across projects, and it cannot:
gigapipe holds its own ClickHouse connection pool (`reader/registry/static.go:33-38`), so
OpenPanel's `max_open_connections` and ClickHouse settings do not apply to it. The
aggregate ceiling is therefore set on the gigapipe container and on ClickHouse itself -
that is the ops work-stream's item, and this spec's contribution to it is the kill switch
(D15), which is the only lever `apps/api` holds when the aggregate is the problem.

#### 8.1 Step ladder

See 4.3. `resolveStepMs` returns `{ stepMs, effectiveInterval }` and the coarsening is
reported (D9).

#### 8.2 Cardinality and query size

- `maxSeries` is passed to the tenancy compiler, which wraps any query carrying a `groupBy`
  in `topk(maxSeries, ...)` - **server-side, in PromQL**, not by trimming in the shaper.
  Trimming in the shaper (`format.ts:168` slices *after* computing global metrics) means
  gigapipe already did the expensive part and `metrics.sum` already includes the dropped
  series. Default 50, hard max 200.
- Compiled LogQL length is capped at 8 KiB before it goes into a URL (6.3).
- The response byte cap is `GIGAPIPE_MAX_RESPONSE_BYTES` (32 MiB decompressed), enforced by
  the counting reader in 4.2 step 9 and surfaced as `too_large`.

#### 8.3 Retention

Annotation only (D14). `oldestQueryableAt = now - GIGAPIPE_RETENTION_DAYS`, reported on
`status` and on `resolution`; the current window is queried as asked. The single acted-on
case is the previous period (6.2 step 5, F19).

The floor is real: gigapipe applies one `SAMPLES_DAYS`-derived TTL to eight tables and its
default is 7 days (`ctrl/qryn/maintenance/rotate.go:122-208`, `cmd/gigapipe/main.go:146`).
Querying before it returns an empty matrix indistinguishable from "you have no data", which
is the single most likely support ticket this feature generates - which is why the number
is surfaced rather than silently applied.

#### 8.4 Per-project concurrency lease

One lease per **user-visible query** (D8), not per HTTP call.

The previous draft's `INCR` plus conditional `EXPIRE` implementation had two independent
defects, both of which invert its stated behaviour:

- The TTL was set only on the `n === 1` transition and never refreshed, so under sustained
  load the key expired at 60 s with holders still in flight. The `finally { decr }` then ran
  against a missing key: Redis `DECR` **creates** it at `-1` with **no TTL**, and the
  `n === 1` branch never fires for a `DECR`, so the counter sat negative and TTL-less
  forever. The effective cap was then silently raised by the number of orphaned decrements.
  The comment claimed "the counter can only leak upward ... the TTL is the self-heal"; the
  leak is downward and does not self-heal.
- There was no `try`/`catch` anywhere, while F17 said the lease "fails open" on a Redis
  outage. As written it failed **closed** and a Redis blip took the whole observability read
  path down.

`INCR` and `EXPIRE` are also not atomic. Both halves are therefore one Lua script each.

```ts
// packages/gigapipe/src/lease.ts
const ACQUIRE = `
  local n = redis.call('INCR', KEYS[1])
  redis.call('EXPIRE', KEYS[1], ARGV[2])      -- refresh on EVERY acquire
  if n > tonumber(ARGV[1]) then
    local m = redis.call('DECR', KEYS[1])
    if m <= 0 then redis.call('DEL', KEYS[1]) end
    return -1
  end
  return n`;

const RELEASE = `
  local n = redis.call('DECR', KEYS[1])
  if n <= 0 then redis.call('DEL', KEYS[1]) end   -- floor at 0, never negative
  return n`;

/**
 * Max hold: requestTimeoutMs (35s) x attempts (3) + shaping. 120s covers it with
 * headroom. Callers MUST NOT hold a lease longer than this; P5 alert evaluation
 * takes one lease per rule evaluation, never one per batch.
 */
const LEASE_TTL_SECONDS = 120;

export async function withProjectLease<T>(
  projectId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `op:gp:lease:${projectId}`;
  const redis = getRedisCache();          // ioredis (packages/redis/redis.ts:66-73)
  let held = false;

  try {
    const n = await redis.eval(
      ACQUIRE, 1, key,
      String(gigapipeConfig.maxConcurrencyPerProject), String(LEASE_TTL_SECONDS),
    );
    if (n === -1) {
      throw new GigapipeError('too_many_requests', 'Too many concurrent telemetry queries');
    }
    held = true;
  } catch (err) {
    // F17: the cap is a fairness control, not a security control. A Redis
    // outage must not take the read path down. Rethrow only OUR rejection.
    if (err instanceof GigapipeError) throw err;
    logger.warn({ err, projectId }, 'gigapipe lease unavailable, proceeding without it');
  }

  try {
    return await fn();
  } finally {
    if (held) {
      try { await redis.eval(RELEASE, 1, key); }
      catch (err) { logger.warn({ err, projectId }, 'gigapipe lease release failed'); }
    }
  }
}
```

In production `ACQUIRE` / `RELEASE` are registered with `redis.defineCommand` so ioredis
uses `EVALSHA` with an `EVAL` fallback; the inline `eval` above is the readable form.

The TTL is a leak ceiling, not a lease duration: a process killed mid-query leaves the
counter high for at most 120 s. There is no queueing - a rejected call returns
`TOO_MANY_REQUESTS` immediately and the UI retries with backoff, because a queue in front of
a 35 s timeout is a way to build a four-minute-deep queue.

**Rejected: a global (not per-project) cap.** One project's dashboard could starve every
other project's - exactly the noisy-neighbour problem the cap exists to prevent. The global
brake is D15's kill switch, which is manual on purpose. **Rejected: relying on ClickHouse's
`max_concurrent_queries`.** That control exists but rejects with a ClickHouse error that
surfaces on the *event* chart path too.

#### 8.5 Kill switch (D15)

```ts
// packages/gigapipe/src/killswitch.ts
const TTL_MS = 10_000;
let cache: { at: number; global: boolean; projects: Set<string> } | null = null;

/** Never throws: a Redis outage means "not disabled". */
export async function isObservabilityDisabled(projectId: string | null): Promise<boolean>;
```

`op:gp:off` disables every project; `op:gp:off:<projectId>` disables one. Both are plain
existence checks (`EXISTS`), refreshed at most every 10 s per process, so the switch takes
effect within about 10 s across every replica with no deploy. Set, the base procedure
throws `disabled`, which each procedure catches and turns into its empty shape with
`status.degraded = 'disabled'`. Ingest is untouched - it does not go through this router.

Operator runbook: `redis-cli SET op:gp:off 1` stops all observability reads;
`redis-cli DEL op:gp:off` restores them. The keys carry no TTL deliberately - a brake that
un-pulls itself at 3 a.m. is not a brake.

### 9. Metadata via direct ClickHouse

Per D3. All of this lives in `packages/db/src/services/telemetry-metadata.service.ts` and
uses `chQuery` (`packages/db/src/clickhouse/client.ts:373`), which already gives
round-robin across nodes plus retry on a different node.

**Read this before the first query block.** `chQuery` takes `(query, clickhouse_settings)`
only - there is **no** `query_params` argument (`client.ts:373-378`), so ClickHouse
server-side `{name:Type}` parameters are not available. Every query below is written the
way it ships: escaped literals via `sqlstring.escape`, exactly as `chart.ts:166,237,759`
and every other hand-written ClickHouse query in the repo does. `projectId` additionally
passes `assertProjectLabelValue` (`^[a-zA-Z0-9_-]{1,100}$`, tenancy work-stream) *before*
escaping, so it is doubly constrained; `sinceDays` is a validated integer; `search` is
`sqlstring.escape` of `%term%` after stripping `%` and `_` from the term. The alternative -
extending `chQuery` with a third `params` argument - is cleaner but changes the function
every analytics query in the repo goes through, in a work-stream that should not be
touching it.

```ts
import sqlstring from 'sqlstring';
const lit = (v: string | number) => sqlstring.escape(v);
```

Every table reference goes through `G()` (D12). A test asserts no emitted query contains a
bare `gigapipe.` or any other unqualified literal (T18a).

#### 9.0 Names and qualification

```ts
// packages/db/src/clickhouse/client.ts  (D12)
export const TELEMETRY_DB = process.env.TELEMETRY_CLICKHOUSE_DATABASE ?? 'gigapipe';

export const TELEMETRY_TABLES = {
  time_series:      'time_series',
  time_series_gin:  'time_series_gin',
  samples:          'samples_v3',
  metrics_15s:      'metrics_15s',
  traces:           'tempo_traces',
  traces_attrs_gin: 'tempo_traces_attrs_gin',
  traces_kv:        'tempo_traces_kv',
} as const;

/**
 * gigapipe's CLUSTER_NAME is independent of OpenPanel's. Do NOT reuse
 * isClickhouseClustered() (client.ts:83), which defaults to TRUE unless
 * SELF_HOSTED is set, nor getIsCluster() in helpers.ts, which defaults to
 * FALSE - the two drifted apart in commit bcfb4f25 and neither says anything
 * about gigapipe, whose ON CLUSTER behaviour comes from its own CLUSTER_NAME
 * (ctrl/maintenance/shared.go:50-53).
 *
 * MUST be set if and only if the gigapipe container's CLUSTER_NAME is set.
 * Mismatch in either direction is silent and wrong; see section 9.5.
 */
export function isGigapipeClustered(): boolean {
  return Boolean(process.env.GIGAPIPE_CLUSTER_NAME);
}

/**
 * Qualify a gigapipe table. `ch` and `chMigrationClient` are both bound to the
 * CLICKHOUSE_URL path database (`openpanel`), so every reference to gigapipe's
 * tables must be database-qualified. Migration 4 proves qualified names work
 * through this client (packages/db/code-migrations/4-add-sessions.ts:123,127).
 *
 * gigapipe's clustered tables are named `<t>_dist`, NOT `<t>_replicated ON
 * CLUSTER`, so `getReplicatedTableName` (client.ts:101) must never be used here.
 */
export function G(t: keyof typeof TELEMETRY_TABLES): string {
  const name = TELEMETRY_TABLES[t];
  return `${TELEMETRY_DB}.${isGigapipeClustered() ? `${name}_dist` : name}`;
}
```

Getting `isGigapipeClustered()` wrong is silent in both directions and neither is an error:

- **False when it should be true.** `G()` returns the *local* shard table. `chQuery`
  round-robins across ClickHouse nodes (`RoundRobinPicker`, `client.ts:212`, used by
  `chQuery` at `:373`), so the metric catalogue, label keys and label values return a
  different shard-local subset on **every call**, non-deterministically. The autocomplete
  flickers and `hasData` is a coin flip.
- **True when it should be false.** The `_dist` tables only exist if gigapipe itself booted
  with `CLUSTER_NAME` (`ctrl/qryn/sql/log_dist.sql`), so every query is ClickHouse error 60.

Hence the active probe in 9.5 and `status.clustered`.

#### 9.1 Metric catalogue - names, type, unit, help

`metadata` is a JSON string added by `ALTER` at the end of `log.sql`
(`ctrl/qryn/sql/log.sql:189-190`) holding `{"type":"counter","help":"...","unit":"..."}`;
`updated_at_ns` (`:192-193`) is the ReplacingMergeTree recency signal.

**The metric name comes from `labels`, not from the `name` column.** The previous draft
made this an open question (Q3) to be settled on a live instance. It is settleable from
disk and the answer is definitive (finding 1.9): the only INSERT into `time_series` is
`(type, date, fingerprint, labels, metadata)`
(`writer/service/insert/time_series.go:57`), `TimeSeriesAcquirer` has no `Name` field
(`:13-19`), and gigapipe's own reader carries the comment
`// Note: Extract metric name from labels JSON since name column is not populated`
(`reader/service/metadata.go:35`). The DDL column exists (`log.sql:16-20`), which is the
only reason using it looked safe; a catalogue built on it returns `[]` on every call and
the metric picker is permanently empty. **Do not "optimise" this back to the real column.**

```ts
export async function getMetricCatalog(
  projectId: string, sinceDays: number, search?: string,
) {
  const pid = lit(assertProjectLabelValue(projectId));
  const like = search ? lit(`%${search.replace(/[%_]/g, '')}%`) : null;

  return chQuery<{ name: string; type: string; unit: string; help: string }>(`
    SELECT
        JSONExtractString(labels, '__name__') AS name,
        argMax(JSONExtractString(metadata, 'type'), updated_at_ns) AS type,
        argMax(JSONExtractString(metadata, 'unit'), updated_at_ns) AS unit,
        argMax(JSONExtractString(metadata, 'help'), updated_at_ns) AS help
    FROM ${G('time_series')}
    WHERE fingerprint IN (
            SELECT fingerprint
            FROM ${G('time_series_gin')}
            WHERE key = 'op_project_id'
              AND val = ${pid}
              AND type IN (2, 0)
              AND date >= today() - ${sinceDays}
          )
      AND type IN (2, 0)
      AND date >= today() - ${sinceDays}
      AND name != ''
      ${like ? `AND name ILIKE ${like}` : ''}
    GROUP BY name
    ORDER BY name
    LIMIT 2000`);
}
```

Why this shape:

- The subquery is a sort-key **prefix seek** on `time_series_gin`'s
  `ORDER BY (key, val, fingerprint, type)` (`ctrl/qryn/sql/log.sql:122-124`). This is the
  whole reason the direct query beats the proxy.
- The outer filter is `fingerprint IN (...)`, and `time_series` is
  `ORDER BY (fingerprint, type)` (`log.sql:115-117`), so the outer is also a seek.
- `type IN (2, 0)`, never `type = 2`. Value `0` is `SAMPLE_TYPE_UNDEF`
  (`writer/model/insert_request.go:8-12`), written by the live Loki-JSON path when a record
  carries both a line and a numeric value (`writer/utils/unmarshal/unmarshal.go:163-165,225-228`,
  `if tp == 3 { tp = 0 }`). Every predicate in gigapipe's own reader is `type IN (n, 0)`;
  equality silently drops rows. If the ingest gateway restricts ingest to OTLP plus
  remote-write plus Loki protobuf, `0` never occurs - but that is a gateway invariant, not
  a schema one, so the read side does not assume it.
- `LIMIT 2000` matches the metric picker's usefulness, not gigapipe's 10 000.

**`type`, `unit` and `help` are empty for Prometheus remote-write series.**
`time_series.metadata` is only written when the pushed label set carries `__metric_type__`
/ `__metric_help__` / `__metric_unit__` (`writer/utils/metadata/parser.go:19-47`, consumed
at `writer/utils/unmarshal/builder.go:326`), and `ToJSON()` returns `""` when all three are
absent (`parser.go:49-59`). Those labels are set in exactly one place in the whole writer:
`writer/utils/unmarshal/otlp_metrics.go:256,510`. Remote-write sets none. The UI must
render an empty `type` as "unknown metric type", never assert on it, and F16's
native-histogram mitigation is unavailable on that path. Closing this is an obligation on
the ingest work-stream (see Interfaces).

Redis-cached for 5 minutes under `op:tm:catalog:<projectId>:<sinceDays>:<search>`, and this
is the **only** cache layer for the autocomplete procedures (6.1). Q5 asks whether the
ingest gateway should invalidate it on a new series.

#### 9.2 Label keys

The previous draft read these from `time_series_gin` with `WHERE fingerprint IN (...)` and
justified it with D3's "the direct query is also the faster one". That justification does
not hold for this query: `fingerprint` is the **third** sort-key column, so with `key` and
`val` unbounded ClickHouse cannot use the primary index and every label-key autocomplete is
a full read of every date partition in range. Restructured to go through `time_series`,
whose sort key *is* `fingerprint`:

```ts
export async function getMetricLabelKeys(
  projectId: string, metric: string, sinceDays: number,
) {
  const pid = lit(assertProjectLabelValue(projectId));
  const m = lit(metric);

  return chQuery<{ key: string }>(`
    SELECT key FROM (
      SELECT DISTINCT arrayJoin(JSONExtractKeys(labels)) AS key
      FROM ${G('time_series')}
      WHERE type IN (2, 0)
        AND date >= today() - ${sinceDays}
        AND fingerprint IN (
              SELECT fingerprint FROM ${G('time_series_gin')}
              WHERE key = 'op_project_id' AND val = ${pid}
                AND type IN (2, 0) AND date >= today() - ${sinceDays}
              INTERSECT
              SELECT fingerprint FROM ${G('time_series_gin')}
              WHERE key = '__name__' AND val = ${m}
                AND type IN (2, 0) AND date >= today() - ${sinceDays}
            )
    )
    WHERE key NOT IN ('op_project_id', '__name__')
    ORDER BY key
    LIMIT 500`);
}
```

Both `INTERSECT` branches are `(key, val)` prefix seeks; the outer is a `fingerprint` seek.
`op_project_id` is excluded from the output so it never reaches a breakdown picker - if a
user could group by it they would see exactly one value, and the label would then travel
into a saved report's `breakdowns` and into `visibleSeries`.

`getLogLabelKeys` is the same query with `type IN (1, 0)` and without the `__name__`
`INTERSECT` branch.

#### 9.3 Label values

```ts
export async function getMetricLabelValues(
  projectId: string, metric: string, key: string, sinceDays: number, search?: string,
) {
  const pid = lit(assertProjectLabelValue(projectId));
  const m = lit(metric);
  const k = lit(key);                       // zod rejects 'op_project_id' and '__name__'
  const like = search ? lit(`%${search.replace(/[%_]/g, '')}%`) : null;

  return chQuery<{ val: string }>(`
    SELECT val
    FROM ${G('time_series_gin')}
    WHERE key = ${k}
      AND type IN (2, 0)
      AND date >= today() - ${sinceDays}
      AND fingerprint IN (
            SELECT fingerprint FROM ${G('time_series_gin')}
            WHERE key = 'op_project_id' AND val = ${pid}
              AND type IN (2, 0) AND date >= today() - ${sinceDays}
            INTERSECT
            SELECT fingerprint FROM ${G('time_series_gin')}
            WHERE key = '__name__' AND val = ${m}
              AND type IN (2, 0) AND date >= today() - ${sinceDays}
          )
      ${like ? `AND val ILIKE ${like}` : ''}
    GROUP BY val
    ORDER BY uniqExact(fingerprint) DESC, val ASC
    LIMIT 500`);
}
```

The outer `key = ...` is the leading sort-key column, so this is a range scan over one
key's slice.

**`uniqExact(fingerprint)`, not `count()`.** `time_series_gin` is a `ReplacingMergeTree`
`PARTITION BY date` (`log.sql:62-69`), so it holds one row per
`(key, val, fingerprint, type, date)` plus whatever duplicates have not merged. `count()`
therefore ranks by "number of days this value was seen, times unmerged parts", not by
series popularity: a value on one series seen for 30 days outranks a value on 20 series
seen today. The previous draft presented `count()` as "ordered by popularity - which is
what an autocomplete wants"; `uniqExact(fingerprint)` is what actually is.

The rank is a heuristic and is **not** returned to the caller - the procedure output is
`string[]`. A number a user can see is a number a user will ask about.

`op_project_id` and `__name__` are rejected as `key` at the zod layer, so this procedure
cannot be used to enumerate project ids.

#### 9.4 The status probes

```sql
-- hasTelemetry(projectId): one query answering hasData AND signals.metrics/logs
SELECT
    countIf(type IN (2, 0)) AS metrics,
    countIf(type IN (1, 0)) AS logs
FROM <G('time_series_gin')>
WHERE key = 'op_project_id'
  AND val = <pid>
  AND date >= today() - <retentionDays>
```

`signals.traces` is a separate cheap probe:

```sql
SELECT 1
FROM <G('traces_attrs_gin')>
WHERE oid IN ('', '0')
  AND date >= today() - <retentionDays>
  AND key = 'op_project_id'
  AND val = <pid>
LIMIT 1
```

**`oid IN ('', '0')`, not `oid = '0'`.** The previous draft asserted `oid = '0'` as fact
and called it "not optional", justified by "every row carries the schema `DEFAULT '0'`".
That is true of `tempo_traces` (`ctrl/qryn/sql/traces.sql:8`) and of the dead `traces_input`
Null table (`:54`), but **not** of `tempo_traces_attrs_gin`, which declares a bare
`oid String` with no DEFAULT (`:22`) and whose live INSERT omits the column entirely
(`writer/service/insert/tempo.go:189`), so ClickHouse fills it with `''`. The MV path that
would have supplied `'0'` is dead - `traces_input` appears in no Go file in the repository.
`signals.traces` would have been `false` forever and any P4 trace query copying the
predicate would have returned nothing.

The consequence for the index is honest: with `oid` given as a two-element `IN` rather than
an equality the seek still starts at the leading sort-key column
(`ORDER BY (oid, date, key, val, ...)`, `traces.sql:32`) but over two prefixes instead of
one, which on a `LIMIT 1` probe is free. If a live instance ever shows a third value the
probe should drop the predicate rather than guess (T44 asserts the observed values).

Two related corrections to the previous draft's prose, both minor but load-bearing for P4:
`oid` is the leading **sort-key** column of `tempo_traces_attrs_gin`, which is
`PARTITION BY date` (`traces.sql:31`); only `tempo_traces_kv` is `PARTITION BY (oid, date)`
(`:41`). And **`oid` must never be described anywhere as a tenancy layer** - it is
degenerate by construction, gigapipe's own reader has the predicate commented out on both
trace paths (`reader/tempo/sql_index_query.go:61`, `reader/tempo/traces_query.go:29`, both
marked `TURNED OFF`), and it does not exist at all on the logs/metrics tables
(`grep -n oid ctrl/qryn/sql/log.sql` returns nothing).

`schemaReady` is answered by these queries' errors: ClickHouse 60 (`UNKNOWN_TABLE`), 81
(`UNKNOWN_DATABASE`) or 497 (`ACCESS_DENIED`) gives `schemaReady: false`. No separate
`system.tables` probe.

#### 9.5 The cluster-consistency probe

Because a `GIGAPIPE_CLUSTER_NAME` mismatch is silent in one direction and a hard error in
the other (9.0), `status` runs one extra probe, cached with the rest of `status` for 10 s:

```sql
SELECT count() AS n
FROM system.tables
WHERE database = <TELEMETRY_DB>
  AND name IN ('time_series_gin', 'time_series_gin_dist')
  AND name = <isGigapipeClustered() ? 'time_series_gin_dist' : 'time_series_gin'>
```

`n = 0` gives `degraded: 'cluster_mismatch'` and a panel naming both variables. This is the
only probe in `status` that reads `system.tables`, and it exists because the failure it
detects otherwise presents as flickering autocomplete rather than as an error.

#### 9.6 Grants

`ch` connects with the credentials in `CLICKHOUSE_URL`. In the shipped self-hosting compose
the ClickHouse container sets `CLICKHOUSE_SKIP_USER_SETUP=1`
(`self-hosting/docker-compose.template.yml:76`) and the `default` user is password-less and
unrestricted, so `SELECT` on a second database needs no grant. On a managed cluster where
OpenPanel connects as a scoped user, it does. **UNVERIFIED for the cloud deployment.**
*Settled by:* `SHOW GRANTS` as the user in `CLICKHOUSE_URL` on the target cluster.
Minimum required:

```sql
GRANT SELECT ON gigapipe.time_series,
                gigapipe.time_series_gin,
                gigapipe.tempo_traces,
                gigapipe.tempo_traces_attrs_gin
   TO <user>;
```

A missing grant looks exactly like a missing schema from the UI (ClickHouse 497), so it maps
to `schemaReady: false` and is logged distinctly.

#### 9.7 Explicitly not this work-stream

The `ALTER ... DELETE` used by project deletion targets the same tables and is owned by
`10-ops-retention-billing.md`. Note only that `deleteFromClickhouse`
(`packages/db/src/services/delete.service.ts:39-72`) enumerates a fixed list of OpenPanel
tables and touches nothing in `TELEMETRY_DB` - the read-path consequence of that is 7.3.

### 10. Live tail

#### 10.1 Route and auth

```ts
// apps/api/src/routes/live.router.ts
fastify.get('/logs/:projectId', { websocket: true }, controller.wsProjectLogs);
```

Mounted under the existing `/live` prefix (`apps/api/src/app.ts:210`), inside the instance
whose `onRequest` hook has already populated `req.session` from the signed `session` cookie
(`app.ts:145-168`). So `wsProjectLogs` follows `wsProjectEvents`
(`apps/api/src/controllers/live.controller.ts:56-95`): read `req.session?.userId`, call
`getProjectAccess`, `socket.send('No access'); socket.close()` on failure.

Three deviations from the existing handlers, all deliberate:

- `guardSocket(socket, req)` **before the first `await`**
  (`live.controller.ts:14-18`). Without an `error` listener an ECONNRESET propagates to
  `uncaughtException` and kills the process. This is documented in that file and is easy to
  forget in a new handler.
- The kill switch (D15) is checked at open, and again on every tick; a socket open when the
  switch is thrown is sent `{ error: 'disabled' }` and closed.
- **Periodic re-authorisation.** The existing handlers authorise once at socket open and
  then stream for as long as the tab is open. For a visitor count or a notification row that
  is tolerable. This socket streams exactly what 7.2 argues must never leave an
  authenticated context - user emails, tokens, stack traces, request bodies - so session
  revocation, removal from the project, an access-level downgrade or organization deletion
  must actually stop it:

  ```
  every 60s: re-validate the session cookie AND re-run getProjectAccess
             -> on failure: socket.send('No access'); socket.close()
  hard maximum socket lifetime: 30 min, then close with a reconnect hint
  ```

  The 30-minute cap replaces the previous draft's "idle close" (which only fired without a
  pong, so an active tab lived forever) and doubles as the re-auth backstop.

The first client message is the tail spec, JSON, validated with a zod schema:
`{ stream: [...], filters: [...], limit?: number }`. It is compiled by the tenancy layer
with the **projectId from the URL**, never from the message.

#### 10.2 The poll loop

The previous draft's loop rested on `cursorNs + 1n` and asserted (T36 in that draft) that "two lines 1 ns
apart are not collapsed". The server cannot provide that (D16, finding 1.1): Loki
`start`/`end` are parsed as `float64` (`reader/controller/utils.go:21-33`, called at
`reader/controller/query_range.go:41-42`) and truncated with `int64(start)` at `:57`, and a
`float64` at a 2026 ns epoch has a ULP of **256**. Every poll boundary would either re-emit
lines already sent or silently drop lines, and no client-side `BigInt` discipline changes
that. Overlap and deduplicate instead:

```
on open:
  guardSocket; auth; kill-switch; parse spec; compile scoped LogQL
  cursorNs   = BigInt(now) * 1_000_000n - 30_000_000_000n   // 30s backfill
  seen       = new Set<string>()   // key = `${tsNs} ${line}`
  seenPrev   = new Set<string>()

  every TAIL_POLL_MS (default 2000):
    if socket.bufferedAmount > BACKPRESSURE_BYTES: skip this tick
    lines = lokiQueryRange({
      query,
      startNs: cursorNs - OVERLAP_NS,        // NOT cursorNs + 1n
      endNs:   BigInt(now) * 1_000_000n,
      direction: 'forward',
      limit: TAIL_MAX_LINES,
    })
    fresh = lines.filter(l => {
      const k = `${l.tsNs} ${l.line}`;
      if (seen.has(k) || seenPrev.has(k)) return false;
      seen.add(k);
      return true;
    })
    if (seen.size > 5000) { seenPrev = seen; seen = new Set(); }   // bounded, 2 generations
    if (fresh.length) { cursorNs = max(fresh.tsNs); socket.send(setSuperJson({ lines: fresh })) }

on close / error: clearInterval; release socket-cap slots
```

- `OVERLAP_NS = 1_000_000_000n` (1 s). It must exceed the 256 ns grid by orders of
  magnitude; 1 s additionally covers sub-second ingest lag, at the cost of re-fetching one
  second of lines per tick, which the dedupe set discards. **Lines that arrive with a
  timestamp more than 1 s in the past are not shown by the tail** and appear on the next
  `logs.query` refresh. gigapipe's own tail has the same property; stating it is the
  difference between a known limit and a bug report.
- The dedupe key is `(timestamp_ns, line)`. Two byte-identical lines at the same nanosecond
  collapse to one; there is no third discriminator on the wire.
- `seen` is bounded at 5 000 keys with a two-generation swap, so a long-lived socket has
  O(1) memory and a worst case of one duplicate line at a generation boundary.
- `direction: 'forward'` maps to `?direction=forward`
  (`reader/controller/query_range.go:44,58`).
- `TAIL_MAX_LINES` default 500, hard cap 1000. gigapipe's own tail caps at 5000
  (`tailMaxLimit`, `reader/controller/query_range.go:19`); we are stricter because we poll.
  If a tick returns exactly `TAIL_MAX_LINES` **after** dedupe the project is out-running the
  tail; send a `{ warning: 'rate_exceeded' }` frame so the pane can say so rather than
  silently dropping.
- A poll that errors does **not** close the socket: it sends
  `{ error: 'temporarily unavailable' }` and keeps the interval. A tail that dies on the
  first gigapipe hiccup is worse than one that shows a warning bar.
- 2 s, not gigapipe's 1 s: at 1 s a tail costs one ClickHouse query per second per open tab.

Per-socket lease: tail polls acquire a **separate**, smaller lease key
(`op:gp:tail:<projectId>`, cap 2) so a room full of open tail panes cannot consume the
`op:gp:lease:<projectId>` budget dashboards need.

#### 10.3 No Redis pub/sub (D7)

The tail subscribes to nothing. The previous draft's `telemetry.logs` nudge bought at most
one poll interval and cost a contract with the ingest gateway's hot path plus a
`packages/redis` prerequisite; it is cut. `IPublishChannels` is unchanged by this
work-stream.

#### 10.4 Caps, and how they are enforced

The previous draft gave numbers with no mechanism. `apps/api` runs multiple replicas
(`OP_API_REPLICAS`, typically 2-3) and a WebSocket lands on exactly one, so an in-process
counter makes the real caps `5N` and `3N`, and a naive Redis counter inherits the lease's
TTL and negative-drift problems **plus** a permanent leak when a replica is killed with
sockets open (no `finally` runs).

**Mechanism: a Redis ZSET per scope, with a heartbeat score and a reap-on-read.** The lease
rejected a ZSET "because it needs a reaper"; for long-lived sockets the reaper is exactly
what makes it correct, because there is no other way to recover a killed replica's slots.

```ts
const SOCKET_TTL_MS = 90_000;      // 3 x the 30s heartbeat
const member = `${REPLICA_ID}:${socketId}`;

// open:
await redis.zremrangebyscore(key, '-inf', Date.now() - SOCKET_TTL_MS);   // reap
if (await redis.zcard(key) >= cap) { reject }
await redis.zadd(key, Date.now(), member);
await redis.expire(key, 300);                                            // whole-key floor

// every 30s while open:  redis.zadd(key, Date.now(), member)  +  redis.expire(key, 300)
// close:                 redis.zrem(key, member)
```

| Cap | Key | Value | Why |
|---|---|---|---|
| Sockets per project | `op:gp:tailsock:p:<projectId>` | 5 | A tail is a repeating query; five panes is a team, fifty is an incident. |
| Sockets per user | `op:gp:tailsock:u:<userId>` | 3 | Tab hoarding. |
| Lines per poll | - | 500 (max 1000) | Below gigapipe's 5000. |
| `bufferedAmount` skip threshold | - | 1 MiB | A slow client must not grow the send buffer unboundedly. |
| Re-authorisation | - | every 60 s | 10.1. |
| Hard socket lifetime | - | 30 min | 10.1. |

A dead replica's members age out of both ZSETs within 90 s. Like the lease, the caps fail
**open**: a Redis error at open is logged and the socket is allowed, because a fairness cap
is not a security control (F17).

### 11. What this work-stream deliberately does not do

- It does not create, migrate or `ALTER` anything in `TELEMETRY_DB`. gigapipe creates its
  own database and runs its own schema upgrades at boot (`ctrl/ctrl.go` ->
  `ctrl/qryn/maintenance/maintain.go:40-49` -> `ctrl/maintenance/shared.go:47-61`,
  `CREATE DATABASE IF NOT EXISTS`). Duplicating that in `packages/db/code-migrations`
  invites drift against gigapipe's own migration ledger.
- It does not delete telemetry. `10-ops-retention-billing.md` owns retention TTLs and
  project-deletion sweeps.
- It does not proxy gigapipe's `/metrics` or its ruler.
- It does not expose raw PromQL, LogQL or TraceQL. Every query is compiled from a
  structured spec by the tenancy layer.
- It does not add anything to `IPublishChannels` (D7).
- It does not read traces through gigapipe's reader (D11).

---

## Interfaces

### Consumed from the tenancy work-stream (`01-tenancy-and-security.md`)

| Symbol | Where | Used by |
|---|---|---|
| `TELEMETRY_PROJECT_LABEL` (`op_project_id`) | `@openpanel/constants` | every query in section 9, `verifyResponseLabels` |
| `assertProjectLabelValue(v)` | `packages/gigapipe/src/labels.ts` | section 9's `lit()` call sites, every compile |
| `compileSelector`, `compileAggregation` | `src/query/promql.ts` | `metrics.chart`, `metrics.instant` |
| `compileLogSelector` | `src/query/logql.ts` | `logs.*`, live tail |
| `verifyPromql`, `verifyLogql`, `verifyTraceql` | `src/query/verify.ts` | the D2 gate, per route-declared param, per element |
| `verifyResponseLabels(series, projectId)` | `src/query/verify.ts` | **contract amendment below** |
| `zMetricQuery` | `@openpanel/validation` | `zObservabilityChartInput` |

**Contract amendment, which the tenancy work-stream must accept or reject.**
`01-tenancy-and-security.md:1424-1436` declares
`verifyResponseLabels(series: Array<{ metric: Record<string, string> }>, projectId: string)`.
That signature is correct and this spec adopts it **unchanged**, with two call-site rules
that must be mirrored in that document, because neither is implied by the signature:

1. It is called on the **raw wire `data.result` array**, before any mapping to `PromSeries`
   - `PromSeries` exposes labels as `labels`, not `metric`, so a post-mapping call does not
   type-check.
2. Loki responses carry `stream`, not `metric`, so the Loki call site passes
   `result.map(r => ({ metric: r.stream }))`. There is no second overload; the adapter is
   one line and lives in `src/read/loki.ts`.

There is **no stub**. `packages/gigapipe` imports the real function; if the tenancy layer
ships later, `src/read/*.ts` does not compile. A `() => true` placeholder would silently
disable F11, which is a paging signal.

### Consumed from the metrics-engine work-stream (`03-metrics-engine.md`)

```ts
shapeMatrixToFinalChart(series: PromSeries[], opts: {
  effectiveInterval: IInterval;   // NOT the requested interval - D9
  stepMs: number;                 // upstream resolution, for the fold
  timezone: string;
  startDate: string;              // 'yyyy-MM-dd HH:mm:ss', naive project-local
  endDate: string;
  previous: PromSeries[] | null;
  visibleSeries: string[] | null; // globalMetrics before the limit slice - format.ts:155-168
  limit: number | null;
}): FinalChart
```

`PromSeries[]` (section 5) is its input contract. `effectiveInterval`, `stepMs`,
`visibleSeries` and `limit` are all additions to the previous draft's signature and all
four are load-bearing; see D9 and section 5.

That work-stream also owns `zDataSource`, `transformReportMetricItem` and the four
persistence whitelists (D4). Until they land, `chart.chart` is untouched.

### Consumed from the ingest work-stream (`02-ingest-gateway.md`) - new section

This work-stream had no ingest interface and needs one, because two read-side behaviours
depend entirely on gateway behaviour:

| Requirement | Why | Consequence if unmet |
|---|---|---|
| The gateway MUST attach `__metric_type__`, `__metric_help__`, `__metric_unit__` on **every** metric write path, including Prometheus remote-write, deriving type from exposition metadata where available and `untyped` otherwise. | Only `writer/utils/unmarshal/otlp_metrics.go:256,510` sets them today; `time_series.metadata` is `''` without them (`writer/utils/metadata/parser.go:49-59`). | `metrics.names` returns empty `type`/`unit`/`help` for remote-write series; F16's native-histogram mitigation is dead on exactly the path most likely to carry them. |
| The gateway MUST strip `X-CH-DSN`, `X-Scope-Meta`, `X-Ttl-Days` from customer requests. | The writer honours all three (`writer/controller/middleware.go:165-174`) and `writer/chwrapper/factory.go:246-268` holds dormant caller-supplied-DSN dialing. | The read side is unaffected, but the same rule is enforced in `gigapipeFetch` (4.2 step 6) and the two must agree. |
| The gateway SHOULD restrict ingest to OTLP, Prometheus remote-write and Loki protobuf. | `type = 0` is only produced by the Loki **JSON** path (`writer/utils/unmarshal/unmarshal.go:163-165,225-228`). | None - section 9 already uses `type IN (n, 0)` unconditionally and does not assume the invariant. |

### Consumed from the ops work-stream (`10-ops-retention-billing.md`)

The gigapipe service and its Basic credentials; `SAMPLES_DAYS`; `CLICKHOUSE_DB` set to the
same value as `TELEMETRY_CLICKHOUSE_DATABASE` (finding 1.8); `CLUSTER_NAME` left unset (or
mirrored into `GIGAPIPE_CLUSTER_NAME`); `ADVANCED_PROMETHEUS_MAX_SAMPLES` pinned to
`50000000`; the pinned image tag that becomes `status.version`; and the nine env vars in
section 3, landed in `.env.example`, `self-hosting/.env.template`,
`self-hosting/docker-compose.template.yml`, `self-hosting/coolify.yml`,
`self-hosting/quiz.ts` and
`apps/public/content/docs/self-hosting/environment-variables.mdx`.

### Exposed to others

| Symbol | Location | Contract |
|---|---|---|
| `gigapipeFetch`, `promQueryRange`, `promQueryInstant`, `lokiQueryRange`, `lokiIndexStats` | `@openpanel/gigapipe` | The only way anything reaches gigapipe's reader. |
| `GIGAPIPE_ROUTES` | `@openpanel/gigapipe/src/routes.ts` | Ingest adds write keys. Every key declares `dialect`, `selectorParams`, `knownParams` (D2); a key without them does not type-check. |
| `GigapipeError`, `GigapipeErrorKind`, `toTRPCError` | `@openpanel/gigapipe` | The worker (P5 alerting) maps the same kinds. |
| `withProjectLease` | `@openpanel/gigapipe/src/lease.ts` | P4 traces and P5 alert evaluation both take it. **Max hold 120 s** - one lease per rule evaluation, never one per batch (8.4). |
| `isObservabilityDisabled` | `@openpanel/gigapipe/src/killswitch.ts` | P5 alert evaluation should also honour the kill switch. |
| `setGigapipeObserver` | `@openpanel/gigapipe` | **Per process, not per Fastify instance** (4.7). `apps/api` wires it beside `metricsPlugin` under the same `!testing` guard; `apps/worker` must wire its own registry or its gigapipe calls emit no metrics. |
| `resolveStepMs` | `@openpanel/gigapipe/src/units.ts` | Returns `{ stepMs, effectiveInterval }` (D9). |
| `TELEMETRY_DB`, `TELEMETRY_TABLES`, `G()`, `isGigapipeClustered()` | `packages/db/src/clickhouse/client.ts` | One place decides the database name and the `_dist` suffix (D12). |
| `observabilityProcedure` | `packages/trpc/src/routers/observability.ts` | P4 traces compose it; it carries the share rejection, the kill switch and the `NO_PROJECT_ID` allow-list. |
| `observability.status` | same | Never throws for an authorized caller (D10). Extended by P4 with `signals.traces`. |
| `getMetricCatalog`, `getMetricLabelKeys`, `getMetricLabelValues`, `getLogLabelKeys`, `getLogLabelValues`, `hasTelemetry` | `packages/db/src/services/telemetry-metadata.service.ts` | **Access-checked callers only.** These functions perform no authorization. P6's MCP tools must either call the router or run their own `requireProjectAccess` first - 7.3's deletion-containment argument depends on it. |

### Changes this work-stream makes to shared code

1. `packages/db/src/clickhouse/client.ts` - add `TELEMETRY_DB`, `TELEMETRY_TABLES`, `G`,
   `isGigapipeClustered`. Additive; nothing existing reads them.
2. `packages/trpc/src/root.ts` - one line, `observability: observabilityRouter`.
3. `apps/api/src/routes/live.router.ts` + `live.controller.ts` - one route, one handler.
4. `apps/api/src/app.ts` - one two-line plugin registration immediately after
   `metricsPlugin` (`app.ts:372`), inside the same encapsulated instance and under the same
   `if (!testing)` guard (4.7).

**Not a change this work-stream makes:** the `packages/redis/publisher.ts` refcount. D7
moves it out of this work-stream entirely - it is an independent, revertible PR against a
pre-existing bug, and the tail does not depend on it.

---

## Failure modes

| # | Condition | Detection | Behaviour |
|---|---|---|---|
| F1 | `GIGAPIPE_URL` unset | `config.enabled === false` | `status.enabled=false`, `degraded='not_configured'`. **No procedure throws.** The UI hides the observability nav. |
| F2 | gigapipe container down | `fetch` rejects (ECONNREFUSED / EAI_AGAIN) | 2 retries, then `unavailable` -> `INTERNAL_SERVER_ERROR` "temporarily unavailable". After 10 in 30 s the breaker opens for 15 s and calls fail instantly. `status.reachable=false`. |
| F3 | Wrong Basic credentials | 401 | `unauthorized` -> `INTERNAL_SERVER_ERROR` "misconfigured". **Never retried.** Logged at `error`, deduped to once per minute per route. |
| F4 | Empty result (no data in range) | `data.result.length === 0` | Not an error. `metrics.chart` returns `{series: [], metrics: {sum:0,average:0,min:0,max:0,count:undefined}}`; the UI renders the standard empty state, plus "data before `oldestQueryableAt` has been deleted" when the requested start precedes it. |
| F5 | 200 with truncated JSON | `JSON.parse` throws on a 2xx (finding 1.3) | `malformed_response`, **exactly one retry, no backoff**, then `INTERNAL_SERVER_ERROR`. **Never** return the prefix that did parse - a chart drawn from half a matrix is a wrong chart, not a degraded one. The counter is a paging signal. |
| F6 | Label endpoints truncate silently | Impossible to detect (`GenericLabelReq` breaks and still writes `"success"`, `query_abels.go:62,67`) | **This is why section 9 exists.** Those routes are not in `GIGAPIPE_ROUTES` (D3), so the undetectable case never arises. Recorded so nobody re-adds them. |
| F7 | Query exceeds the engine's fixed 30 s | gigapipe 500 whose body contains `context deadline exceeded` / `query timed out` (finding 1.4) | Re-kinded to `timeout` -> `TIMEOUT` "narrow the range, add a filter, or shorten the interval". **Not UI-retryable.** Without the re-kind this arrives as `upstream_error`, which the UI *would* retry - re-running a query that just burned 30 s of the shared ClickHouse. |
| F8 | Step too small for the range | 500 containing `11,000 points` | Re-kinded to `bad_request` "that range needs a larger step". Section 8.1 should make this unreachable; a non-zero counter means the ladder has a hole. |
| F9 | `promql.ErrTooManySamples` | 500 containing `too many samples` | Re-kinded to `bad_request` "that query touches too much data". **Not UI-retryable.** More likely on a real high-cardinality metric than F8. |
| F10 | Oversized response | counting reader passes `maxResponseBytes` (decompressed) | Abort the stream, `too_large` -> `PAYLOAD_TOO_LARGE`. Never buffer to find out. `Content-Length`, when present, is checked first as a cheap pre-abort. |
| F11 | Response carries another project's series | `verifyResponseLabels` on the raw wire array | Drop the **whole** response, `tenancy` -> `FORBIDDEN`, increment `openpanel_telemetry_response_label_mismatch_total`, **page**. Do not filter and continue - a compiler that emitted an unscoped query got one thing wrong and may have got two. On a Loki `streams` response the same rule applies to the whole page: no lines are shown. |
| F12 | Concurrency lease exhausted | acquire script returns -1 | `TOO_MANY_REQUESTS` immediately, no queue. |
| F13 | ClickHouse says table/database unknown (60/81) or access denied (497) | error code on a section 9 query | `status.schemaReady=false`, `degraded='schema_missing'`. Metadata procedures return `[]` rather than throwing, so the picker renders empty instead of erroring. |
| F14 | `GIGAPIPE_RETENTION_DAYS` disagrees with the deployment's `SAMPLES_DAYS` | not detectable from OpenPanel | Since D14 annotates rather than clamps, an **over-conservative** value only mislabels the empty-state text; it never hides data that exists. An **under-conservative** value produces the pre-existing "empty range looks like no data" confusion. Surfaced as `status.retentionDays`. Q4. |
| F15 | Client disconnects mid-query | `req.signal` (UNVERIFIED, 4.2 step 7) | Upstream call aborted, `cancelled` swallowed, lease released in `finally`. If the signal does not propagate the 35 s timeout is the backstop and the lease still releases. |
| F16 | gigapipe returns a native-histogram metric | `values: []` with no error (only `s.Floats` is serialised, 4.4 note 3) | Indistinguishable from empty. The catalogue's `type` field lets the UI say "native histograms are not supported" for `type='histogram'` series whose matrix is empty - **but `type` is `''` on the remote-write path** (9.1), so the UI must degrade to "unknown metric type" rather than assert. Best available; not a real detection. |
| F17 | Redis unavailable | lease / kill-switch / socket-cap Redis call throws | Everything **fails open**: log a warning and proceed. A Redis outage must not take the read path down; these are fairness controls, not security controls. Contrast F11, which fails closed. |
| F18 | `GIGAPIPE_URL` set with no credentials | `config.problems` contains `insecure` (finding 1.7 - `BasicAuthMiddleware` is only installed when **both** are non-empty, `cmd/gigapipe/main.go:321-325`) | `status.degraded='insecure'`, logged at `error` at boot, red banner for org admins. This is the highest-consequence misconfiguration this work-stream can produce and it is otherwise **completely invisible**: the product works perfectly while an unauthenticated gigapipe sits on the network exposing `/api/v1/metadata`, `/loki/api/v1/labels`, `/api/search/tags` and `/api/traces/{id}` - the four untenanted endpoints D3 and D11 exist because of. |
| F19 | Comparison period entirely below retention | `prevEnd < oldestQueryableAt` | The previous-period calls are **not issued**; `resolution.previous = 'unavailable_retention'`; the UI says "comparison unavailable: data before `<date>` has been deleted". Without this the delta is computed against a guaranteed-empty window and renders a confident `-100%` the user will act on - worse than an error. |
| F20 | `TELEMETRY_CLICKHOUSE_DATABASE` != the container's `CLICKHOUSE_DB` | section 9 queries raise ClickHouse 81 | Split brain: **charts and ingest work perfectly** (they go over HTTP and never see the database name) while every picker is empty and `status.schemaReady` is false. gigapipe's default is `cloki`, not `gigapipe` (finding 1.8). `status.database` surfaces the resolved name so the panel can name the mismatch. |
| F21 | `GIGAPIPE_CLUSTER_NAME` != the container's `CLUSTER_NAME` | the 9.5 `system.tables` probe | Set-when-it-should-be-unset is ClickHouse 60 on every query. **Unset-when-it-should-be-set is silent and worse**: `G()` returns local shard tables and `chQuery` round-robins nodes (`client.ts:212,373`), so autocomplete returns a different subset per call and `hasData` is a coin flip. `degraded='cluster_mismatch'`. |
| F22 | Log line arrives more than `OVERLAP_NS` (1 s) late by its own timestamp | not detectable | Not shown by the tail; appears on the next `logs.query` refresh. gigapipe's own tail has the same property. Documented limit (10.2). |
| F23 | Project out-runs the tail | a tick returns `TAIL_MAX_LINES` after dedupe | `{ warning: 'rate_exceeded' }` frame; the pane says lines are being skipped rather than silently dropping them. |
| F24 | Session revoked / access removed while a tail is open | the 60 s re-authorisation (10.1) | `socket.send('No access'); socket.close()` within 60 s. Hard 30-minute lifetime is the backstop. |
| F25 | Kill switch thrown | `op:gp:off` or `op:gp:off:<projectId>` exists | Within ~10 s per replica: read procedures return empty shapes, `status.degraded='disabled'`, open tails close. Ingest unaffected. |

---

## Test requirements

### `packages/gigapipe` - transport

| # | Test |
|---|---|
| T1 | A route key not in `GIGAPIPE_ROUTES` does not type-check; a runtime key throws before `fetch`. |
| T2 | A route whose `dialect` is non-null and whose `selectorParams` key is missing or empty throws before `fetch` (assert `fetch` was not called). |
| T3 | A `match[]`-style union with two elements throws (D2's "exactly one element" rule), and `query` counts toward that union (`reader/controller/query_labels.go:123-130`). |
| T3a | A `query`/`form` key not in the route's `knownParams` throws before `fetch`. |
| T3b | `selectorParams` is not a field on `GigapipeRequest` (a type-level test - passing it is a compile error). |
| T4 | A `form` request emits `Content-Type: application/x-www-form-urlencoded` with **no** `charset` parameter (finding 1.2). Regression test against `URLSearchParams`. |
| T5 | `X-CH-DSN`, `X-Scope-Meta`, `X-Ttl-Days` are stripped even when a caller sets them. |
| T6 | `TIME_ENCODING` is exhaustive over `GigapipeRouteKey` (table-driven; `null` for routes with no time parameter), `encodeTime` returns nanoseconds for `lokiQueryRange` and seconds for `promQueryRange`, and throws for a `null` route. |
| T7 | `encodeStep(60_000) === '60000ms'`; a bare integer is never emitted. |
| T8 | 200 + truncated JSON gives `malformed_response`, **exactly one** retry, no partial data returned (finding 1.3). |
| T9 | A 500 body containing `11,000 points` gives `bad_request`; one containing `too many samples` gives `bad_request`; one containing `context deadline exceeded` gives `timeout` and is **not** marked UI-retryable; anything else gives `upstream_error`. |
| T10 | 401 is not retried. ECONNREFUSED is retried twice with jittered backoff, then `unavailable`. |
| T11 | Ten consecutive failures open the breaker; the eleventh call does not touch the socket; a probe closes it. *(full work-stream, not the minimum slice)* |
| T12 | A response exceeding `maxResponseBytes` aborts the stream and throws `too_large` without buffering the whole body; a gzipped body is counted **decompressed**. |
| T13 | `"NaN"`, `"+Inf"`, `"-Inf"` in a matrix coerce to `0` and increment `coerced`. |
| T14 | `sortedLabels` is deterministic across two responses whose `metric` objects have different key insertion order. |
| T15 | Aborting the caller's signal rejects with `cancelled` and does not log an error. |
| T16 | `config.enabled === false` when `GIGAPIPE_URL` is unset, and importing the module does not throw. |
| T16a | `GIGAPIPE_URL=http://host/gigapipe` (a path) gives `enabled: false` with `problems: ['bad_base_url']` and a distinct log line - it does **not** silently query `http://host/api/v1/query_range`. |
| T16b | `GIGAPIPE_URL` set with no credentials gives `problems: ['insecure']` (F18). |
| T17 | `resolveStepMs('minute', 3 months)` returns `{ stepMs: 7_200_000, effectiveInterval: 'day' }`; `resolveStepMs('hour', 30 days)` returns `{ stepMs: 3_600_000, effectiveInterval: 'hour' }`; every ladder value divides 86_400_000 exactly. |
| T17a | The lease: key expires mid-flight, then release runs. The counter never goes negative, `DEL` fires at zero, and the cap still holds on the next acquire. |
| T17b | The lease fails **open** when Redis throws on acquire (the call proceeds, a warning is logged) and rethrows only its own `too_many_requests`. |

### `packages/db` - metadata service

| # | Test |
|---|---|
| T18 | Every emitted query contains `key = 'op_project_id' AND val = <escaped pid>`. Snapshot the SQL. |
| T18a | No emitted query contains a bare `gigapipe.` literal or an unqualified gigapipe table name; every table reference came from `G()`. With `GIGAPIPE_CLUSTER_NAME` set, every reference ends in `_dist`. |
| T19 | Every emitted query uses `type IN (..., 0)`, never `type = n`. |
| T20 | A `projectId` containing `'` is rejected by `assertProjectLabelValue` before escaping, and escaped if it somehow gets past. |
| T21 | `op_project_id` and `__name__` never appear in `getMetricLabelKeys` output, and are rejected as the `key` input to `getMetricLabelValues` at the zod layer. |
| T22 | The trace probe uses `oid IN ('', '0')`, not `oid = '0'`. Paired with an integration assertion (T44) that reads the actual distinct `oid` values on a seeded instance rather than asserting a literal. |
| T23 | ClickHouse error 60 / 81 / 497 gives `[]` from the metadata functions and `schemaReady: false` from `hasTelemetry`, never a throw. |
| T23a | The catalogue selects `JSONExtractString(labels, '__name__')` and **never** the bare `name` column (finding 1.9). A grep-the-SQL test, because this is the one mistake that silently empties the metric picker. |
| T23b | `getMetricLabelValues` orders by `uniqExact(fingerprint)`, not `count()`, and does not return the rank to the caller. |

### `packages/trpc/src/routers/observability.test.ts` - modelled on `share.test.ts`

`share.test.ts` uses `router.createCaller` with a mocked `@openpanel/db`; copy that shape.

| # | Test |
|---|---|
| T24 | A caller with no project access gets `FORBIDDEN` **before any gigapipe call** (assert the client was not invoked). |
| T25 | Any input carrying `shareId` is `FORBIDDEN`, on every procedure, **including ones added later** - iterate the router's procedure list rather than enumerating names. |
| T25a | Every procedure either takes a top-level `projectId` or is in `NO_PROJECT_ID`; iterate the router. A procedure added without either fails the test. |
| T25b | Each `NO_PROJECT_ID` member calls `requireProjectAccess` in its handler (assert the mock was called with the resolved project). |
| T25c | The router contains **no mutation** (7.1). |
| T26 | An unauthenticated caller gets `UNAUTHORIZED`. |
| T27 | The cache **key** differs across projects for otherwise identical input (guards `cacheMiddleware`'s `getRawInput` key, `trpc.ts:200-208`, which has no `userId` component and is only project-scoped because `projectId` is in the input). Assert the key, not observed caching - reads are production-only (`trpc.ts:203`). |
| T28 | `observability.status` returns `{enabled:false, degraded:'not_configured'}` and does not throw with `GIGAPIPE_URL` unset. |
| T28a | `observability.status` does not throw when the ClickHouse probe raises code 60, 81 or 497. |
| T28b | `observability.status` **does** throw `FORBIDDEN` for a caller without project access, and `UNAUTHORIZED` with no session (D10 is scoped to backend reasons). |
| T29 | `metrics.chart` with 6 series and `previous: true` takes exactly **one** lease, not twelve (D8), and never has more than `fanoutConcurrency` upstream calls in flight. |
| T30 | `range: '3m'` + `interval: 'minute'` resolves to a step keeping points under 11 000, and the returned `resolution` reports `{requestedInterval:'minute', effectiveInterval:'day'}`. |
| T31 | With `retentionDays: 7` and `range: '30d', previous: true`, the previous-period calls are **not issued** and `resolution.previous === 'unavailable_retention'` (F19). |
| T32 | `metrics.chart`'s `chart` field is structurally assignable to `RouterOutputs['chart']['chart']` (a type-level test - `expectTypeOf`). |
| T33 | With `op:gp:off` set, every read procedure returns its empty shape and `status.degraded === 'disabled'`; with `op:gp:off:<other-project>` set, this project is unaffected. |
| T34 | `getOrganizationSubscriptionChartEndDate` returning `null` leaves `endDate` unchanged (it does not become `null`). |

### Live tail

| # | Test |
|---|---|
| T35 | An unauthenticated socket receives `'No active session'` and is closed. |
| T36 | A poll error sends a warning frame and does not close the socket. |
| T37 | `bufferedAmount` above the threshold skips a tick rather than queueing. |
| T38 | **Dedupe across an overlapping poll**: two consecutive polls whose windows overlap by `OVERLAP_NS` and which return the same line emit it exactly once. Replaces the previous draft's T36 ("two lines 1 ns apart are not collapsed"), which asserts a property the server cannot provide (D16). |
| T38a | The dedupe set is bounded: after 6 000 distinct lines, memory holds at most two generations and a line from the oldest generation may repeat at most once. |
| T39 | Re-authorisation: revoking project access closes the socket within one re-auth interval; a socket open for 30 minutes is closed with a reconnect hint. |
| T40 | Socket caps: opening a sixth socket for a project is refused; a member whose heartbeat stopped 90 s ago is reaped and its slot reused; a Redis error at open **allows** the socket (F17). |
| T41 | `logs.query` paging: a page boundary where three lines share a nanosecond returns each line exactly once across two pages, and no line is dropped. |

### `packages/redis` - the D7 PR, shipped separately

| # | Test |
|---|---|
| T42 | Two subscribers to one channel: closing the first does not silence the second (the refcount regression - reproduces on `main` today). |
| T43 | open, close, open in the same tick leaves the channel subscribed and the second subscriber receiving (the serialisation race, `publisher.ts:52,66`). |
| T43a | Eleven concurrent subscribers emit no `MaxListenersExceededWarning` (one shared `on('message')`). |

### Against a real gigapipe (integration; gates every image-digest bump)

| # | Test |
|---|---|
| T44 | `SELECT DISTINCT oid FROM <G('traces_attrs_gin')> LIMIT 10` on a seeded instance: assert the observed set is a subset of `{'', '0'}` and that the T22 predicate matches it. If a third value appears, the probe drops the predicate. |
| T45 | `POST /api/v1/query_range` with our exact header and form encoding returns a matrix (proves finding 1.2's fix). |
| T46 | `step` sent as `60000ms` produces 60-second buckets, not 60 000-second ones. |
| T47 | Loki `start`/`end` in nanoseconds return the expected window; the same numbers in seconds return empty (proves the unit table). |
| T48 | **Observed timestamp rounding**: send a Loki `start` of `X` and of `X+1`, and assert the returned first line is identical - i.e. assert the ~256 ns grid empirically, so a future gigapipe that fixes it is noticed and D16's overlap can be revisited. |
| T49 | A step below the ladder floor still produces the `11,000 points` 500; a deliberately huge selector still produces `too many samples`; a deliberately slow query still produces `context deadline exceeded`. All three T9 re-kindings still fire. **This is the string-matching guard and it gates the image bump.** |
| T50 | `ADVANCED_PROMETHEUS_MAX_SAMPLES` is set on the container and a query near the limit fails with `too many samples` rather than succeeding unbounded (guards the unverified upstream default). |
| T51 | The metric catalogue is **non-empty** on a seeded instance (guards finding 1.9 end to end). |
| T52 | `/api/v1/metadata`, `/loki/api/v1/labels` and `/api/search/tags` return **cross-project** data on a two-project fixture. This is a **raw `fetch`** test that deliberately bypasses `gigapipeFetch` - those routes are not in `GIGAPIPE_ROUTES` and the client cannot reach them. It asserts the untenanted behaviour that justifies D3, so a future gigapipe that fixes it is noticed. |

---

## Open questions

| # | Question | What settles it | Blocking |
|---|---|---|---|
| Q1 | `packages/gigapipe` vs `packages/db/src/gigapipe/` (D1) - three sibling drafts disagree. | The P0 owner picks one and rewrites `03-metrics-engine.md:2113` and `05-logs.md`'s file table, or reverses D1. | yes, for the client |
| Q2 | Does `@trpc/server` v11's Fastify adapter abort `opts.signal` on client disconnect? (4.2 step 7) | Start a `metrics.chart` against a slow gigapipe, close the tab, look for an `abort` log line. Half a day. | no - the 35 s timeout is the backstop and the lease releases in `finally` either way |
| Q3 | What is `ADVANCED_PROMETHEUS_MAX_SAMPLES`'s upstream default, and is `50000000` the right pin? | The `cloki-config` module is not in this machine's Go module cache. `go mod download github.com/metrico/cloki-config && grep -r MetricsMaxSamples $(go env GOMODCACHE)/github.com/metrico/cloki-config*`, or `curl /config` on a running instance. T50 guards the pin regardless. | no |
| Q4 | How is `GIGAPIPE_RETENTION_DAYS` kept equal to `SAMPLES_DAYS`? One env var read by both the compose service and `apps/api` is the obvious answer but crosses into the deployment work-stream. | ops owner. D14 downgrades the consequence from "hides real data" to "mislabels the empty state", so this is no longer urgent. | no |
| Q5 | Should the ingest gateway invalidate `op:tm:catalog:*` when a project's first series for a new metric name lands, so a metric appears immediately during onboarding? | Product call. The cost is one Redis `DEL` per new-series detection on the ingest hot path; the benefit is a 5-minute wait removed from the first-run experience only. | no |
| Q6 | Which ClickHouse user does the cloud deployment use, and does it hold `SELECT` on a second database? (9.6) | `SHOW GRANTS` as the `CLICKHOUSE_URL` user on the target cluster. | yes, for cloud |
| Q7 | Which registry does `fastify-metrics` v12 serve, so `createPromObserver` registers on the right one? (4.7) | `pnpm install`, then read `node_modules/fastify-metrics/dist/plugin.js` for its `promClient`/`register` handling. | no - the observer indirection makes it a wiring detail, and a missing observer is a no-op by design |
| Q8 | Is the 8 KiB compiled-LogQL cap right, or should the log explorer's filter UI be constrained to guarantee it? | logs work-stream plus this one, once the compiler's worst-case output is measurable. | no |
| Q9 | Is 1 s the right `OVERLAP_NS`, or does real ingest lag need more? | Measure `now - max(timestamp_ns)` on a live tail for a week. Raising it costs duplicate fetch volume, which the dedupe set absorbs; lowering it drops late lines (F22). | no |

Closed since the previous draft, from disk rather than from a live instance:

- **"Is `time_series.name` populated?"** No, definitively - finding 1.9. The catalogue reads
  `JSONExtractString(labels,'__name__')`.
- **"Does the trace probe's `oid = '0'` hold?"** No - finding 1.10. It is `''` on
  `tempo_traces_attrs_gin`. The probe is `oid IN ('', '0')` and T44 checks it empirically.
- **"Is the Loki read surface GET-only?"** Only `query_range` / `query` / `tail` /
  `index/stats` are; the label and series routes take POST too (finding 1.12). We call none
  of the latter, so the 8 KiB cap still binds where it mattered.

---

## Effort

Estimates assume the tenancy compiler (`compileSelector`, `verifyResponseLabels`), the
metrics shaper, and a gigapipe container in the compose file **already exist**. None of
these numbers is standalone.

### Minimum shippable slice - "one metric chart renders" (about 2.8 weeks)

| Piece | Weeks |
|---|---|
| `packages/gigapipe` scaffold, `config`, `routes` + the D2 gate, `units` + step ladder, `transport` (streaming byte-capped reader, retry with jitter, header discipline), `errors` + the three re-kind rules; T1-T10, T12-T17 | 1.3 |
| `read/prometheus.ts` (`queryRange` only) + parsing + verification call site; T13-T14 | 0.3 |
| `lease.ts` (Lua) + `killswitch.ts`; T17a-T17b, T33 | 0.3 |
| `telemetry-metadata.service.ts` (`getMetricCatalog`, `hasTelemetry`, the cluster probe) + `TELEMETRY_DB`/`G()`; T18-T23b | 0.4 |
| `observabilityProcedure` + `metrics.chart` + `status` + the client contract; T24-T34 | 0.5 |

The breaker (T11) is **not** in this slice - it was double-counted in the previous draft
(once inside the 1.0-week transport row via T11, once as its own 0.4 row). There is one
internal service, a 35 s timeout bounds every call, and `status` already reports
reachability; it is the most deferrable thing in the transport.

### Full work-stream

| Piece | Weeks |
|---|---|
| Minimum slice above | 2.8 |
| `metrics.instant`, `metrics.labelKeys/labelValues`, `logs.labelKeys/labelValues` | 0.5 |
| `read/loki.ts` + `logs.query` / `logs.histogram` / `logs.volume`, including the cursor + dedupe design; T41 | 1.1 |
| Live tail: the WS route, caps (ZSET + reaper), re-auth, overlap/dedupe, backpressure; T35-T40 | 1.0 |
| Circuit breaker + observer wiring + the seven metrics; T11 | 0.4 |
| Integration suite T44-T52 + the upgrade-qualification runbook | 0.6 |
| **Total** | **about 6.4** |

Not in this total: traces (D11, owned by `06-traces-and-correlation.md`) and the
`packages/redis` refcount PR (D7, about 0.2 w, shipped independently and revertible on its
own).

### What makes it bigger

- **Q1 resolving the other way** costs about 0.5 w of file moves plus a re-review of the
  tenancy totality argument.
- **Q6 resolving badly** - no `SELECT` grant available on the managed cluster - forces
  section 9 back onto gigapipe's label endpoints, which means re-accepting F6's undetectable
  truncation, losing `type`/`unit`/`help` entirely, and re-adding three route keys that
  carry a `panic(err)`. That is a product regression, not a schedule one; escalate rather
  than absorb.
- **The logs cursor** is the piece most likely to overrun. The 1.1 w assumes the dedupe
  design in 6.3 survives contact with a real explorer UI; if the UI needs stable
  bidirectional paging with jump-to-timestamp, add 0.5 w.
- **`OVERLAP_NS` tuning (Q9)** could turn the tail into a rate-limited firehose problem on a
  chatty project. The `rate_exceeded` frame (F23) is the cheap answer; a real answer is
  server-side sampling, which is a new feature.
- **If raw PromQL ever ships**, the D2 gate needs a real lezer-based rewriter with an
  explicit error-node walk (lezer is error-tolerant and never throws), and every estimate
  here roughly doubles. `@prometheus-io/lezer-promql@0.314.0` is version-matched to
  gigapipe's vendored `github.com/prometheus/prometheus v0.314.0`, which makes it the right
  tool - but it produces a read-only concrete syntax tree with no mutation or printing API,
  so injection is positional string splicing guided by `VectorSelector` node ranges. That is
  a different security posture from the structured compiler, and it is out of scope here.
