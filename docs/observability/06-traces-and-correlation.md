# Traces, and the session correlation that differentiates this

OpenPanel ingests OTLP spans through its own gateway into gigapipe's `tempo_traces` /
`tempo_traces_attrs_gin` tables and reads them back with **direct ClickHouse SQL from
`apps/api`** — gigapipe's Tempo-compatible reader is never called on the trace path, because
it applies no tenant predicate of any kind (`GET /api/traces/{traceId}` filters on `trace_id`
alone at `reader/service/tempo.go:53-89`, and `X-Scope-OrgID` is read nowhere in the tree).
Isolation is therefore ours: a mandatory `key = 'op_project_id' AND val = <projectId>`
predicate on the gin table, which is that table's primary-key prefix. The differentiator is
that the browser's OpenPanel session id (`op_session_id`) and profile id (`op_profile_id`)
ride a W3C `baggage` header from the web SDK into the customer's backend spans, so "show me
the backend traces behind this session replay" is one indexed range scan — a join no
Grafana/Tempo stack can make, because nothing in that stack knows a product-analytics session
exists. This document specifies the storage contract, the six read procedures and their SQL,
the ingest-side stamping rules the gateway must implement, the two correlation surfaces that
ship in P4 and the two that ship in P6, and the operational envelope (quotas, retention,
erasure, rollback) the whole thing runs inside.

Every gigapipe claim below was read from Go source in `/Users/drew/projects/gigapipe` at the
currently checked-out commit; every OpenPanel claim from `/Users/drew/projects/openpanel`.
Anything not settled from disk is marked **UNVERIFIED** with the command that settles it.

**Depends on:** P0 (`10-ops-retention-billing.md` — the gigapipe service, `GIGAPIPE_DB`,
per-signal retention, the ClickHouse grants), P1 (`02-ingest-gateway.md` — the telemetry
gateway, telemetry tokens, the OTLP protobuf codec), P2/P3 (`04-read-path.md` — the
`observability` tRPC router, `packages/gigapipe`, the per-project lease), and
`08-schema-changes.md` (the telemetry ClickHouse client and the one telemetry table constant).
**Checked against:** the current `04-read-path.md` (D11, D12, D13, D15, §4.1, §6.5, §8.4),
`02-ingest-gateway.md` (§1, §4, §6.3, §15), `05-logs.md` (§4.1, §4.3, §7.2, §7.4),
`08-schema-changes.md` (S11, §11, §14), `10-ops-retention-billing.md` (D15, D19, §3.1, §6.1,
§6.2) and `11-testing-strategy.md` (I13, I14, A15, E29, gate 1.9).
**Blocks:** nothing. **Consumed by:** P5 (alerting on span error rate), P6 (MCP trace tools —
**unowned**, see §16).

---

## Cross-document reconciliation (this revision)

Five critics read all eleven specifications together. This revision settles the conflicts that
reach traces. The table is here rather than buried in the sections so that an owner of another
document can see, in one place, what changed under them. **Every row marked "other doc must
change" is a decision this document previously stated differently, or a decision another
document states differently and is wrong about.**

| # | Conflict | Settled as | Who else must change |
|---|---|---|---|
| 1 | Four table-name helpers, two exporting `TELEMETRY_TABLES` with different value shapes | **`08`'s `packages/db/src/clickhouse/telemetry-client.ts` is the one home.** `TELEMETRY_TABLES` values stay **unqualified**; `telemetryReadTable()` / `telemetryMutationTable()` / `telemetryIn()` do the qualifying (§5) | `04` deletes `G()`; `05` deletes `packages/db/src/gigapipe/table-name.ts` and `gigapipeTable()`; `08` adds the three helpers; this doc drops its own `TELEMETRY_DB`/`g()`/`getTelemetryMutationTable()` from `client.ts` |
| 2 | `11` I14 requires gigapipe mutations to route through `getReplicatedTableName` | **Deleted.** That helper emits `<table>_replicated ON CLUSTER '{cluster}'` (`packages/db/src/clickhouse/client.ts:101-106`, read on disk). gigapipe has no `_replicated` table: its clustered layout is a plain-named local `ReplicatedMergeTree` plus a `_dist` Distributed companion (`ctrl/qryn/sql/traces_dist.sql`, `log_dist.sql`). Following `11` emits `UNKNOWN_TABLE` on exactly the clustered installs where the paying customers are | `11` I14 / gate 1.9 — replace with "every gigapipe mutation target goes through `telemetryMutationTable()`, and no emitted statement contains the substring `_replicated`" |
| 3 | Three project-deletion designs (`05` `purgeTelemetry`, `08` `deleteTelemetryFromClickhouse`, this doc's `deleteTelemetryForProjects`) | **`08` owns it.** One function, called *inside* `deleteFromClickhouse`, non-throwing, `TelemetryErasure` ledger, `05`'s resumability folded in. This document's two function names are **deleted**; per-profile erasure becomes a `subject` argument on `08`'s function (§11.6) | `05` drops `purgeTelemetry` and `TelemetryPurgeJob`; `09` §14 and `11` I13/I14 use the one name |
| 4 | `11` I13 asserts zero rows in `tempo_traces_kv` after deletion | **Wrong by construction.** `tempo_traces_kv` holds `(date, key, val_id, val)` with no trace or project reference; it is a shared 10 000-bucket dictionary and is deliberately never deleted from (this doc §11.6, `08` §14 agree) | `11` I13 drops it; the table list becomes one imported constant per `11` I14 |
| 5 | `01` D2 / `02` §6.0 strip the whole `op_` namespace with no restore hook, which silently deletes the correlation ids this document exists for | **A named, closed re-attach set** — `OP_CORRELATION_RESTORE_KEYS` (§4.1) — snapshotted before the strip and re-attached after it, bounded by T17. Traces keep them; metrics and logs do not (T11) | `01` D2/D7 and `02` §6.0 must carry the same list and make the traces walk snapshot-first; `11` §3.2 needs the two-signal test |
| 6 | Five retention numbers | **`10` owns retention, per signal.** This document reads `TELEMETRY_RETENTION.traces` and hardcodes nothing (§6.0) | `10` renames its object export `TELEMETRY_RETENTION` so it stops colliding with the scalar `TELEMETRY_RETENTION_DAYS` compose var; `04` replaces `GIGAPIPE_RETENTION_DAYS` |
| 7 | tRPC namespace (`observability.*` vs `logs.*` vs `metrics.*`) | **One router: `observability.{metrics,logs,traces,status}`**, base procedure `protectedProcedure.use(rejectShareId)` per `04` D13 (§6.6). This document was already on it and stays | `05` folds `logsRouter` in; `01` §7.1's hand-rolled `publicProcedure` becomes a pointer to `04` D13; `03`, `09`, `11` sweep paths |
| 8 | Five `GIGAPIPE_*` naming schemes | **`10` §3.1's list wins**: `GIGAPIPE_URL`, `GIGAPIPE_USER`, `GIGAPIPE_PASSWORD`, `GIGAPIPE_DB`, `GIGAPIPE_CLUSTER`. This document already uses `GIGAPIPE_DB` and `GIGAPIPE_CLUSTER` and needs no edit | `10`'s cross-document edit list still says this document reads `GIGAPIPE_CLUSTERED` — **stale, drop that row** |
| 9 | Five kill-switch mechanisms | **One Redis namespace, `telemetry:disabled:{read\|ingest}:{projectId\|*}`**, presence means disabled, per-project keys carry a mandatory TTL and global keys carry none (§15) | This document's `GIGAPIPE_TRACES_READ_ENABLED` / `GIGAPIPE_TRACES_INGEST_ENABLED` are **deleted**; `01` §11's opposite-polarity keys are deleted; `02` §4 and `04` D15 adopt the segment; `10` publishes it |
| 10 | Four HTTP statuses for wind-down-blocked ingest | **403** with a `google.rpc.Status` body, per `02` §4 and `10` D15. This document's "202-and-drop" is **withdrawn** (T20, §4.1 step 0, F-15, T-33) | `05` §4.3's 200/204; `11` A15's 429 |
| 11 | Four capability surfaces | **`observability.status` only** (`04` §6.5), extended with `blocked`. This document reads `status.signals.traces` and nothing else | `09` rewrites `telemetry.capabilities`; `05` derives its app-context flag from the same procedure |
| 12 | Five documents add crons with no inventory, and `telemetryRetention` names two different jobs | This document's weekly sweep is named **`telemetryOrphanSweep`**, `40 5 * * 0`, with the full registration triple written out (§11.7) | `05` renames its purge cron `telemetryPurge`; someone publishes the inventory (no blueprint document exists on disk — see the note below) |
| 13 | Four body limits | **`02` §15 owns them.** This document's "16 MiB" is **deleted** (§4.2). It contributes one fact instead: `/v1/traces` has **no** server-side bound at all, so `11` E29's 64 MiB ceiling is a `/v1/metrics` fact and is not a trace-path bound | `05` deletes `OTLP_MAX_BODY`; `11` E29 asserts against `02`'s configured value |
| 14 | `01` §7.7's `GIGAPIPE_ROUTES` still lists four untenanted Tempo routes | **`04` §4.1's route table is normative.** No Tempo route may appear anywhere (T1/T2). `01` §7.5's ownership pre-check has no route left to guard and its function is subsumed by §6.3's `owned` CTE | `01` §7.7 becomes a pointer plus ingest keys; `01` §7.5 is deleted, not moved |
| 15 | P1 opens `/telemetry/v1/traces` before the shaping rules exist | **P1's route table opens metrics and remote-write only.** `/telemetry/v1/traces` opens in **P4**, with `stampTraces` (§4.1). Mis-stamped rows are unrepairable and undeletable (T21), so this is not a scheduling preference | `02` §1 restricts its P1 table |
| 16 | Gateway limits disagree numerically (backfill 24 h/48 h, value 1024/2048, attrs 64/128) | **`02` §15's numbers win**, all three. This document's `TELEMETRY_MAX_ATTR_BYTES` and `TELEMETRY_MAX_ATTRS_PER_SPAN` are **deleted** and §12's arithmetic redone | none — this document moves to `02` |

**There is no `00-blueprint.md` on disk.** Several of the critics' proposed fixes are "write it
in the blueprint". The eleven specifications are the whole corpus. Where a finding asked for a
blueprint entry that belongs to this work-stream, it is written here and flagged; where it
belongs to nobody, it is recorded in §16 as unowned rather than silently absorbed.

---

## Decisions

| # | Decision | Rejected alternative, and why |
|---|---|---|
| **T1** | **Trace search is direct ClickHouse SQL** from `apps/api` against `<db>.tempo_traces_attrs_gin` and `<db>.tempo_traces`. gigapipe's reader is not called on the trace path at all; P4 depends on gigapipe's **writer only**. | Proxy `GET /api/search?q=<traceql>`. Rejected on four independent grounds, each fatal. **(a)** An injected `op_project_id` matcher lands in the *first selector only*. `{A} && {B}` intersects `(trace_id, span_id, max_timestamp_ns)` rows (`reader/traceql/traceql_transpiler/clickhouse_transpiler/complex_and.go:16-45`), but the final data assembly then re-reads **every span of a matching trace** with only `traces.trace_id IN (…)` (`.../traces_data.go:44-55`), so nothing about the output is span-scoped. **(b)** There is no Node parser for gigapipe's TraceQL dialect, so scope-correct injection means writing one against a Go grammar that moves. **(c)** None of the four correlation surfaces is expressible in TraceQL — they join to `openpanel.events` / `sessions` / `cohort_members`. **(d)** `/api/search` with neither `q` nor `tags` applies **no predicate at all** and returns the newest rows of `tempo_traces` instance-wide (`reader/tempo/traces_query.go:21-49`; `reader/service/tempo.go:351-371` passes a nil `idxQuery`). |
| **T2** | **Trace-by-id is direct SQL over `tempo_traces.payload`**, decoded in `apps/api` with P1's protobuf codec. | gigapipe's `GET /api/traces/{traceId}`. Rejected: hardcoded `Limit(2000)` (`reader/service/tempo.go:83`), no project predicate whatsoever, and a plain-text `Not found` 404 indistinguishable from "not yours". Our own SQL costs almost nothing — the gateway only accepts OTLP, so `payload_type` is always `2` and gigapipe's Zipkin branch never applies. |
| **T3** | **`op_project_id` is stamped on every span** as an OTLP *resource* attribute, overwritten by the gateway from the authenticated telemetry token. Every read carries a mandatory `key='op_project_id' AND val=<projectId>` gin predicate. | **(a)** gigapipe's `oid` column. Rejected: it exists only on the traces family, and both writer `INSERT` column lists omit it (`writer/service/insert/tempo.go:90-93`, `:189-190`), so it is `'0'` on `tempo_traces` and `''` on the gin table forever; the reader's own oid predicates are commented out. **(b)** An OpenPanel-owned `telemetry_trace_index(project_id, date, trace_id, span_id)` table written by the gateway — ~25× fewer rows (§12). Genuinely attractive, rejected for P4 only because it makes the project predicate an *intersection* rather than a *prefix*: one forgotten intersection is a cross-tenant leak, whereas with T3 a forgotten predicate is an empty result. Kept on the shelf as the P6 storage optimisation, together with the tag dictionary (T16). |
| **T4** | **Correlation keys are `op_session_id` and `op_profile_id`** — snake_case, no dots, one definition each in `@openpanel/constants`. | `op.session.id`. Rejected: gigapipe's *log* decoder runs `SanitizeKey` (`writer/utils/unmarshal/otlplogs.go:100-116`), rewriting every non-`[a-zA-Z0-9_]` character to `_`. A dotted name would be `op.session.id` on traces and `op_session_id` on logs. One name across three signals beats semconv cosmetics. |
| **T5** | **Correlation ids are attached to the local root span only**, by a span processor in the customer's process, and the gateway enforces a bound rather than a filter (T17). | Every span. Rejected on gin cost: ~20× more rows for a lookup that only ever needs one hit per trace (§12: 340 MB/day versus 6.9 GB/day at the baseline). Descendants stay reachable by `trace_id`, which is `tempo_traces`' PK prefix. |
| **T6** | **Browser→server transport is the W3C `baggage` header.** P4 ships `op.getBaggage()`, `parseBaggage()`, an Express middleware field and a Next.js App-Router helper, an OTel `SpanProcessor` in a **published** package, and customer-facing documentation. The automatic `fetch`/`XHR` patch is opt-in (`propagateSession.patchFetch`), off by default, and is the first thing cut. | **(a)** A bespoke `x-openpanel-session` header — rejected: `baggage` is already in the OTel JS default composite propagator, so the server side is free for anyone running an OTel SDK, and a custom header needs the same CORS allowlisting anyway. **(b)** Making the fetch patch core — rejected: `propagateSession` is opt-in regardless, so the customer edits init code either way; having done so, `headers: { baggage: op.getBaggage() }` in their own request wrapper is one line and avoids the entire hazard list in §11.4. |
| **T7** | **No raw TraceQL from users, in any planned phase.** Search is a structured `zTraceQuery` compiled to SQL server-side. | Accepting TraceQL text. Same reason as the parent plan's decision 3, plus three specific to this dialect: structural operators `&>>`, `!>>`, `<<&`, `<<~`, `~` are silently rewritten to `&&` (`clickhouse_transpiler/planner.go:98-103`), so "A is a descendant of B" executes as "A and B are in the same trace"; `\| select(...)`, `\| topk(N)`, `\| bottomk(N)` and `with(...)` are parsed and then never read by any planner; and on the TraceQL-*metrics* path `\|\|` is flattened into the same AND-ed filter list as `&&` (`reader/service/tempo_metrics.go:454-484`). Shipping a query language that silently mis-answers is worse than shipping none. |
| **T8** | **User filters are trace-scoped AND; the `op_project_id` predicate is span-scoped.** Two user filters may be satisfied by two different spans of one trace. | Span-scoped AND for user filters. Rejected: `service.name = frontend AND db.system = postgres` — the most natural two-filter query anyone types — returns zero rows under span-scoped AND, silently, because no single span carries both. A per-filter "same span" toggle is P6. The security predicate stays span-scoped, which is the half that matters. |
| **T9** | **A `trace_id` is not a tenancy key.** One trace legitimately contains spans from two OpenPanel projects when a customer instruments two services under two telemetry tokens. Authorisation is always `(trace_id, span_id) ∈ project`, never `trace_id ∈ project` — **including every aggregate we compute** (T18). | Assuming trace ownership. Rejected because it is false, and because it is the shape of bug that turns a truncated result into an authorisation bypass. |
| **T10** | **Search filter operators in P4 are equality and set-membership only** (`is`, over 1–20 values). `contains`, `isNot`, regex: P6. | Shipping `contains` now. Rejected: `positionCaseInsensitive(val, …)` cannot use the `(date, key, val, timestamp_ns)` prefix, so it degrades to a scan of every value of that key for the window. `isNot` additionally has ambiguous semantics on an inverted index ("has the key with another value" ≠ "does not have the key with this value"), invisibly to the user. |
| **T11** | **`op_session_id` / `op_profile_id` are span attributes and nothing else.** The gateway strips both from OTLP metric data-point attributes, metric resource attributes, and log record attributes. | Letting them through on logs for a one-hop log→session join. Rejected: gigapipe's log and metric label sets *are* the `time_series` fingerprint (`writer/utils/unmarshal/unmarshal.go:250-270`). One series per session is ~10⁵ new series/day for a mid-sized project. Logs reach a session in two hops via `trace_id` instead (§9). |
| **T12** | **The gateway also zeroes `LogRecord.SpanId`** by default (`TELEMETRY_LOG_SPAN_ID=1` re-enables it). **This is a requirement on the logs work-stream, not on this one.** | Keeping it. gigapipe promotes both `trace_id` and `span_id` to first-class labels (`otlplogs.go:52-58`). `trace_id` alone costs one series per trace; adding `span_id` multiplies that by spans-per-trace (~20). §9 shows the trace-level join is sufficient for every surface we ship. |
| **T13** | **Trace-derived charts are page-local in P4.** They are not saveable `Report` rows and never reach `chartProcedure`. | Making them `Report`s so the `FinalChart` renderers come free. Rejected for P4: `chartProcedure` is a `publicProcedure` that serves a `shareId` with no session (`packages/trpc/src/routers/chart.ts:83`), and the latency series carries raw exemplar trace ids. Deciding shareability after the type is already shared is how GHSA-7gv7-c464-9wh8 happened. |
| **T14** | **Nanosecond timestamps never cross the tRPC boundary as `number`, and never leave ClickHouse as `Int64` either.** Every bucket and offset is converted to **milliseconds in SQL**; raw nanoseconds are returned only as `String`. | Returning `Number(timestamp_ns)`. Rejected twice over: a 2026 nanosecond epoch is ≈1.79×10¹⁸, three orders past `Number.MAX_SAFE_INTEGER`; and `chQueryWithMeta` coerces **any** column whose ClickHouse meta type contains `Int` through `Number.parseFloat` (`packages/db/src/clickhouse/client.ts:346-353`), so an `Int64` nanosecond column is already a lossy double before our code sees it. |
| **T15** | **Two correlation surfaces ship in P4** — session replay → traces (§13.1) and trace → user (§13.2a). **Three ship in P6** — the funnel half of §13.2, p99 by cohort (§13.3), and conversion drop overlaid with backend error rate (§13.4). | Shipping all of them in P4. The funnel half needs a funnel picker, a `localStorage` preference and a project-day scan on a sort key that does not contain `session_id`; §13.3/§13.4 need the metrics work-stream's interval→bucket + zero-fill contract. None of them is what the differentiator rests on. Their SQL is written out below so the P6 estimate is real. |
| **T16** | **Filter-bar tag keys come from the current page of search results by default** (zero extra queries, F3 gives us the merged attribute set for free). A window-scoped "load all keys" query exists behind an explicit user action, with a 15-minute clamp, hard row caps, **`rateLimitMiddleware` and a deployment-wide concurrency of one** (§6.4, §6.6). The gateway-written tag dictionary is **promoted from "P6 someday" to the first P6 item and a P4 exit gate: if Q3's load test cannot hold p95 on the 15-minute window, the unprefixed variant is removed and the dictionary ships in P4 instead.** | A dedicated untenanted-scan tag-keys query as the default. Rejected on the spec's own arithmetic: ~25 gin rows/span × 86.4 M spans/day ≈ 2.16 B rows/day, so a 6-hour window is ~540 M rows — 2.7× the row cap the draft proposed. The filter bar would return a ClickHouse error on exactly the projects that need one. **Also rejected: leaving the cost side to `04-read-path.md` §8.4's per-project lease.** That lease fails *open* on any Redis error (`04` F17: "these are fairness controls, not security controls"), so it is not a brake on a user-triggered scan of every tenant's index; a real IP-scoped rate limit and a hard concurrency cap are. |
| **T17** | **The gateway keeps correlation ids only on a span with an empty `ParentSpanId`, or one the customer's processor explicitly marked `op_root = "1"`**, and additionally caps correlation-carrying spans to `TELEMETRY_MAX_CORRELATED_SPANS_PER_TRACE = 4` per request. | "Preserve on a span whose parent is not in this batch." Rejected as **undecidable**: under OTel's `BatchSpanProcessor` a parent is normally exported in a *later* batch than its children, so "parent not in this batch" is true for the majority of spans in any real service — the rule would preserve the keys almost everywhere and the drop counter would read near zero while the index grew 20×. The explicit marker is the only signal the gateway can evaluate from one export. |
| **T18** | **Every aggregate a search or correlation surface returns is computed over the caller's own spans only.** `rootServiceName`, `rootName`, `durationMs`, `spanCount`, `serviceCount` and `errorCount` mean "the earliest / longest / count of the spans **you own**", and the UI says so. | Aggregating over all spans of an owned trace. Rejected: it leaks another tenant's `service_name` through `argMin` whenever their span is earliest — an authorisation leak hiding inside a row the caller is entitled to see, and one that a "no foreign rows returned" test does not catch. |
| **T19** | **`observability.traces.byId` takes an explicit time window, supplied by the caller as a URL parameter**, and falls back to a **constant-shaped** per-partition walk when it is absent: every retention-day partition is probed, **always, with no early exit**, and the union of hits is returned. | Taking the window from the dashboard's ambient date-range picker. Rejected: a trace link pasted into Slack, bookmarked, or arriving from a P5 alert would 404 for a colleague whose picker says "last 24 h" — reported as data loss, and entirely avoidable. Taking *no* window is also rejected: without a `timestamp_ns` bound the gin read degrades from a range scan to the whole `(date, key, val)` range, i.e. the project's every span for the retention window. **Stopping at the first hit is also rejected**, and this is a change from the previous revision: a trace the caller owns would return after one or two partition reads while a foreign or fabricated id ran the full sequence, which is an existence-and-ownership oracle for anyone who obtains an id out of band — precisely the pasted-URL case `09-ui-surfaces.md` §8 legislates for ("no timing difference between the two"). Seven cheap single-partition prefix reads, always, is the price of making that requirement true rather than asserted. |
| **T20** | **Telemetry ingest runs the same lifecycle gate as event ingest, and answers `403`, not `202`.** The `/v1/traces` route registers `subscriptionHook` (or an equivalent resolving the org from the telemetry token's `projectId`) and a per-project span-rate ceiling; a blocked org gets **403 with a `google.rpc.Status` body**, per `02-ingest-gateway.md` §4 and `10-ops-retention-billing.md` D15. | Leaving the telemetry route ungated because it is "just telemetry". Rejected: `subscriptionHook` is registered on exactly three routers today — `event.router.ts:12`, `profile.router.ts:10`, `track.router.ts:14` — so a new route inherits nothing, and a blocked expired-trial org would keep writing ~2.8 GB/day of gin index into shared storage after being cut off from events. **The previous revision of this row said "202-and-drop, the same semantics as `track.router.ts:14`" and it was wrong.** `subscription.hook.ts:19-23` explains that 202 exists because *OpenPanel's own SDKs* retry everything but 401/2xx; an OTLP exporter is the opposite and reads any 2xx as "delivered, drop it", so 202 discards a blocked org's spans with no signal anywhere. 403 is permanent to an OTel exporter, stops the retry loop, and shows up in the customer's own exporter metrics. `02` owns this status and this document now follows it. |
| **T22** | **The gigapipe database name, the `_dist` read suffix and the `ON CLUSTER` mutation form are decided in ONE file — `packages/db/src/clickhouse/telemetry-client.ts` (`08-schema-changes.md` S11) — and nowhere else.** Reads go through `chQuery` / `chQueryWithMeta` with `telemetryReadTable()`; DDL and mutations go through `getTelemetryClient()` with `telemetryMutationTable()` (§5). | **(a)** This document's previous `TELEMETRY_DB` / `g()` / `getTelemetryMutationTable()` in `packages/db/src/clickhouse/client.ts` — withdrawn: it was the second of four helpers, and the second of two exporting the symbol `TELEMETRY_TABLES` with a *different value shape* (pre-qualified here, unqualified in `08`). **(b)** `04` D12's `G()` and `05` §7.2's `gigapipeTable()` — same reason. **(c)** Routing everything through `getTelemetryClient()` (`10` D19's literal reading) — rejected for **reads**: `chQueryWithMeta` is what logs per-query `statistics` (`client.ts:357-366`, the only detection F-1 has) and what performs the `Int` coercion T14 is written against, and re-deriving both on a second client is how the two diverge. **(d)** Routing mutations through `chQuery` — rejected: `chQuery`'s second argument is ClickHouse *settings*, not query params (`10` D19), and `ch`/`chQuery` round-robin a comma-separated `CLICKHOUSE_URL`, so a `DELETE` issued on one node and verified on another is a coin flip (`04` F21 documents that exact failure and then uses `chQuery` anyway). |
| **T23** | **`/telemetry/v1/traces` opens in P4, not P1.** P1's route table is `/telemetry/v1/metrics` and `/telemetry/api/v1/write` only. | Opening all three OTLP routes in P1 and letting the shaping rules follow. Rejected because the rows cannot be repaired: T11, T12 and T17 are *gateway* rules costed in P4, and a span written without them is either a 20× gin blow-up or — per T21 — permanently invisible to every read **and** permanently undeletable by erasure and by project deletion. `01`'s own Effort section makes the same point for metrics ("not repairable, only deletable"). Opening the route with the rules is two or three days later; opening it without them is a retention window of unfixable data. |
| **T24** | **Project-deletion and profile erasure are ONE function, owned by `08-schema-changes.md`** — `deleteTelemetryFromClickhouse`, called *inside* `deleteFromClickhouse`, never throwing (§11.6). | This document's own `deleteTelemetryForProjects` / `deleteTelemetryForProfile` — withdrawn, and `05` §7.4's `purgeTelemetry` with it. Three functions with three ledgers and opposite failure semantics is worse than any one of them. `08`'s call site is the right one because it is the only one that covers **both** `apps/worker/src/jobs/cron.delete.ts:46` and `apps/admin/src/commands/delete-organization.ts:191`, and its non-throwing contract is verified: `jobDelete()` has no `try`/`catch`, so an unguarded throw stops **every** project and organisation deletion on the deployment. `05`'s "only successfully-purged projects proceed to `deleteProjects`" is the opposite rule and is wrong for that reason — a gigapipe outage would freeze GDPR erasure product-wide. |
| **T21** | **The `op_project_id` label is versioned and its name may never change in place.** Renaming it requires a dual-read window and an explicit re-key job (§11.7). | Treating the label as a free-floating constant. Rejected: it is the only project handle on either trace table (`ctrl/qryn/sql/traces.sql` has no project column and `oid` is never written), so a span written without it — a bad deploy, a rolled-back gateway, an exporter pointed straight at gigapipe — is permanently invisible to every read **and** permanently undeletable by erasure and by project deletion. It can only age out on the TTL. |

---

## Design

### 1. gigapipe's actual trace API surface, and why none of it is used

Registered in `reader/router/tempo.go:10-36`. This is the whole of it.

| Method + path | Handler | What it actually does |
|---|---|---|
| `GET /api/traces/{traceId}`, `/tempo/api/traces/{traceId}`, `/api/traces/{traceId}/json` | `TempoController.Trace` | `SELECT … FROM tempo_traces WHERE trace_id = unhex(:id) ORDER BY timestamp_ns LIMIT 2000` (`reader/service/tempo.go:53-89`), then decodes each `payload`. **No project, tenant or attribute predicate.** 404 with a plain-text `Not found` body when empty. |
| `GET /api/search` | `TempoController.Search` | Two different code paths. With `q=` it parses TraceQL and runs the transpiler (§2). Without `q`, it parses the `tags` logfmt string into one `SELECT trace_id, span_id FROM tempo_traces_attrs_gin` subselect per tag and `INNER ANY JOIN`s them (`reader/tempo/sql_index_query.go:41-118`). **With neither `q` nor `tags` there is no filter at all** (`reader/service/tempo.go:351-371` passes a nil `idxQuery`; `traces_query.go:29-31` adds no predicate) and it returns the newest `limit` rows instance-wide. |
| `GET /api/search/tags`, `/tempo/api/search/tags` | `Tags` | `SELECT DISTINCT key FROM tempo_traces_kv` — no time bound, no project bound, whole instance. |
| `GET /api/search/tag/{tag}/values` | `Values` | `SELECT DISTINCT val FROM tempo_traces_kv WHERE key = :tag` — same. |
| `GET /api/v2/search/tags`, `GET /api/v2/search/tag/{tag}/values` | `TagsV2` / `ValuesV2` | With `start`/`end`, a TraceQL-scoped tag query; otherwise falls through to the untenanted form. Splits results into `resource` / `span` / `intrinsic` scopes using a hardcoded prefix list plus an exact-match set (`reader/controller/tempo.go:233-239`). |
| `GET /api/metrics/query_range`, `GET /api/metrics/query` | `MetricsQueryRange` / `MetricsQueryInstant` | TraceQL-metrics over `tempo_traces` (§3). Note the path: this is **Tempo's** metrics API, not Prometheus's. Auto-step targets 5000 points (`reader/controller/tempo.go:663-690`). |
| `GET /api/echo`, `/tempo/api/echo` | `Echo` | Returns the string `echo`. |

Three consequences the plan text should absorb:

* **There is no service-graph endpoint.** A repo-wide grep for `service_graph`, `servicegraph`
  and `service-graph` returns nothing and there is no `service_graph_*` table in
  `ctrl/qryn/sql/`. Any plan sentence promising "gigapipe's service-graph endpoints" is wrong.
  §14 records the query so nobody re-derives it.
* **The non-TraceQL search response is span-level, mislabelled as trace-level.**
  `GetTracesQuery` (`reader/tempo/traces_query.go:21-28`) selects `service_name AS
  root_service_name` with **no `GROUP BY` and no `DISTINCT`**, so a trace with five matching
  spans comes back as five rows with five different "root" names. Only the TraceQL path
  aggregates, via `argMin(service_name, timestamp_ns)` (`.../traces_data.go:48-50`).
* **The two `_kv`-backed autocomplete endpoints are lossy by construction.**
  `tempo_traces_kv_mv` computes `val_id = cityHash64(val) % 10000` into a `ReplacingMergeTree`
  keyed `(oid, date, key, val_id)` (`ctrl/qryn/sql/traces.sql:34-42`), so at most 10 000
  distinct values survive per `(date, key)` and collisions silently replace each other.

### 2. TraceQL: the dialect, and what it silently ignores

Grammar: `reader/traceql/traceql_parser/model_v2.go` + `lexer_rules_v2.go`. Planner:
`reader/traceql/traceql_transpiler/` (note the full prefix — `clickhouse_transpiler/` alone
does not resolve).

Supported and actually executed: `{ key = "value" }` with `=`, `!=`, `<`, `<=`, `>`, `>=`,
`=~`, `!~`; `&&` / `||` inside one `{}`; `{A} && {B}` / `{A} || {B}` between selectors;
`| count() > 3` and the other aggregators; the intrinsics `duration`, `name`, `status`,
`kind`, `rootName`, `rootServiceName`; and a complexity pre-flight that switches processor
above `COMPLEXITY_THRESHOLD = 10000000`.

Parsed and then **discarded**: `| select(a, b)` (the returned `SpanSet.Attributes` is
unconditionally `make([]model.SpanAttr, 0)`, `traceql_transpiler/reqest_processor.go:80`);
`| topk(N)`, `| bottomk(N)`, `with(sample=…)` (`SecondStage` and `WithHints` appear in no
planner); and the structural operators, rewritten to `&&`.

One defect worth recording as a further reason not to proxy: on the TraceQL-**metrics** path
only, `buildFilterCTE`'s `=~` branch interpolates the user's regex with
`strings.ReplaceAll(valCopy, "'", "\\'")` and **no backslash escaping**
(`reader/tempo/metrics_query.go:369-384`), so a value ending in a single backslash escapes the
closing quote. The search path is safe — it goes through `StringVal.String`
(`reader/utils/sql_select/objects.go:266-274`).

### 3. TraceQL metrics, and the two unrelated things called "exemplars"

`metricsWalkAttrSelector` (`reader/service/tempo_metrics.go:454-484`) flattens the whole
selector tree — including `||` branches — into one flat AND-ed `(keys, ops, vals)` triple, so
`{ a="1" || b="2" } | rate()` executes as `a="1" AND b="2"`. That is the single strongest
argument for T7. Aggregation columns are also restricted to the intrinsics map, so in practice
only `duration` is aggregatable (`metrics_query.go:278-281`).

**Exemplars**, both halves corrected:

* **OTLP metric exemplars are stored and unreadable through any API.** The writer takes the
  first exemplar carrying a non-zero 16-byte trace id and writes its hex string into the
  sample's `string` column (`writer/utils/unmarshal/otlp_metrics.go:293-303, :331, :353, :413`).
  On the read side `/api/v1/query_exemplars` is registered to `qrCtrl.Metadata`
  (`reader/router/prometheus_labels.go:23`) and the PromQL engine is built with
  `ExemplarQueryable: nil` (`reader/router/prometheus_query_range.go:56`). To use them at all
  we read `<db>.samples_v3.string` directly (§10.1). **Side effect for the metrics/billing
  work-stream:** `metrics_15s_mv` computes `bytes = sumSimpleState(length(string))`
  (`ctrl/qryn/sql/log.sql:146-158`), so stored exemplar trace ids inflate `metrics_15s.bytes`
  — it is only a log meter under a `type = 1` filter.
* **TraceQL-metrics exemplars are not stored at all.** They are computed at query time by
  sampling one span per bucket out of `tempo_traces` (`reader/tempo/metrics_query.go:636-717`).
  §10.2 reimplements the idea against the gin table and gets a better answer for less.

### 4. Storage shape, and what the gateway must stamp

`ctrl/qryn/sql/traces.sql` — verbatim, single-node:

```sql
CREATE TABLE IF NOT EXISTS {{.DB}}.tempo_traces {{.OnCluster}} (
    oid String DEFAULT '0',
    trace_id FixedString(16), span_id FixedString(8), parent_id String,
    name String, timestamp_ns Int64 CODEC(DoubleDelta), duration_ns Int64,
    service_name String, payload_type Int8, payload String
) Engine = {{.MergeTree}}() ORDER BY (oid, trace_id, timestamp_ns)
PARTITION BY (oid, toDate(FROM_UNIXTIME(intDiv(timestamp_ns, 1000000000))));

CREATE TABLE IF NOT EXISTS {{.DB}}.tempo_traces_attrs_gin {{.OnCluster}} (
    oid String, date Date, key String, val String,
    trace_id FixedString(16), span_id FixedString(8),
    timestamp_ns Int64, duration Int64
) Engine = {{.ReplacingMergeTree}}()
PARTITION BY date
ORDER BY (oid, date, key, val, timestamp_ns, trace_id, span_id);
```

Nine facts the whole read design rests on.

**F1 — `oid` is constant, which is what makes our predicate a prefix.** `tempo_traces.oid` has
`DEFAULT '0'` and is omitted from the insert column list
(`writer/service/insert/tempo.go:90-93`); `tempo_traces_attrs_gin.oid` has no default and is
likewise omitted (`:189-190`), so it is `''`. The two are *different constants* — do not assume
symmetry. Because it is constant, the gin table's effective sort order is
`(date, key, val, timestamp_ns, trace_id, span_id)`.

*We never put `oid` in a `WHERE` clause.* With cardinality 1, ClickHouse's generic exclusion
search resolves the leading column for free, and hardcoding `oid = ''` would silently return
nothing the day gigapipe's closed `GetTracesInsertServicePlugin`
(`writer/service/insert/tempo.go:79-82`) starts populating it. `oid` being degenerate also
means it is a dead leading component of both the sort key and the partition key of
`tempo_traces` — project-scoped trace lookups get no benefit from it and must come through the
gin table.

**F2 — the gin prefix invariant.** Every gin read this work-stream issues **must** supply a
`date` range **and** `key` **and** `val` **and** a `timestamp_ns` range, in that order — the
full prefix up to `timestamp_ns`. This is enforced by a single query-builder function (§6.1)
and by test T-2. Exactly three sanctioned exceptions exist, each of which must carry explicit
ClickHouse limits and a window clamp, and each is named in T-2's allow-list: the "load all
tag keys" query (§6.4), the `span_profile` CTE in §13.3, and the tag-values query when a key
is chosen but no value is (§6.4, which still has `date + key + timestamp_ns`).

**F3 — resource attributes are APPENDED to span attributes, not merged, and the payload keeps
both.** `OTLPDecoder.Decode` does `span.Attributes = append(span.Attributes,
res.Resource.Attributes...)` and *then* `proto.Marshal(span)`
(`writer/utils/unmarshal/otlp.go:81, :85`). Only `initAttributesMap` (`:154-160`) collapses the
appended list into a `map[string]string` where the later entry — the resource one — wins.
Therefore:

* **(a)** The gin index and the `service_name` column hold the **resource-level** value for any
  key present at both levels, which is why the gateway's `op_project_id` overwrite must be
  applied to `ResourceSpans.Resource.Attributes` and why it wins.
* **(b)** The stored `payload` contains **both** entries, in span-then-resource order. A by-id
  decoder that does the natural `attributes.find(a => a.key === 'service.name')` returns the
  *span-level* value while the search index returns the resource-level one. The decoder
  **must** apply last-wins over the appended list before building `ITraceSpan.attributes`
  (§6.6). Test T-25 pins this.
* **(c)** Because the payload carries the merged set, trace-by-id needs **no** gin lookup to
  read `op_session_id`, `op_profile_id` or `service.name`. That is the opposite of the logs
  path, where record attributes are merged last.

**F4 — one span attribute is one gin row, untruncated, unsanitised.** `parserDoer.onSpan`
(`writer/utils/unmarshal/builder.go:403-428`) loops the key/val slices and appends a row each,
accounting `40 + len(key) + len(val)` bytes. There is no `SanitizeKey` and no 100-character
value cap — unlike the logs path, where `sanitizeLabels` truncates at 100 chars
(`writer/utils/unmarshal/unmarshal.go:274-282`). A 20 KB stack trace on a span attribute lands
verbatim in the index. The gateway caps value length; P1 owns that, this work-stream sets the
number (§12). Because keys are unsanitised, an attribute key may contain spaces, `/`, `:` or a
leading digit — which is why `zTraceAttrFilter.key` is charset- and length-bounded but **not**
identifier-shaped (§6.2).

**F5 — every span already produces five gin rows before you add anything.**
`populateServiceNames` injects `service.name` and `remoteService.name` when absent
(`otlp.go:60-74`), and `Decode` adds `name`, `status` and `kind` (`otlp.go:88-109`). Budget
from five, not zero.

**F6 — span *event* and *link* attributes are never indexed.** `Decode` walks only
`span.Attributes`. Exception details live on span events by OTel convention, so
`exception.type` is not searchable — though it is still *renderable*, because the full span
proto is what gets marshalled into `payload`. The gateway therefore lifts `exception.type` and
`exception.message` off the first `exception` span event onto the span as `op_exception_type` /
`op_exception_message` (truncated to 256 chars). This is the only ingest-side **denormalisation**
this work-stream asks for; §4.1 lists the full set of ingest-side mutations, which is larger.

**F7 — `parent_id` holds raw bytes, not hex.** The OTLP decoder passes
`string(span.ParentSpanId)` (`otlp.go:120`) while the Zipkin decoder hex-decodes first
(`zipkin_json.go:94-95`). So `parent_id` is an 8-byte binary string, or `''` for a root span.
Read it as `lower(hex(parent_id))`; `parent_id = ''` is the cheap root-span predicate. (The
`traces_input` Null table and its two MVs in `traces.sql:53-88` are **dead** — the string
`traces_input` appears in no Go file in the repository. Do not target them.)

**F8 — `duration_ns` can be negative.** It is `int64(span.EndTimeUnixNano -
span.StartTimeUnixNano)` (`otlp.go:118-119`) — an unsigned subtraction cast to signed — so a
span whose end precedes its start underflows to a huge `uint64` and lands as a negative
`Int64`. Clamp to 0 at the API boundary and set `clockSkew: true`.

**F9 — the gin `date` column is written in the gigapipe container's LOCAL timezone, and read
in the ClickHouse server's.** This is new to this revision and it is load-bearing, because
`date` is the first component of the F2 prefix. The writer sets
`p.attrs.MDate = time.Unix(timestampNs/1000000000, 0)` (`builder.go:425`) — a `time.Time` in
`time.Local` — and the column is a `proto.ColDate` appended through
`service.DateAppender` (`writer/service/insert/tempo.go:220`, `writer/service/col_adaptors.go:12-20`),
whose `ToDate` encodes `(t.Unix() + zoneOffset) / 86400` using **that time's zone**
(`$GOMODCACHE/github.com/!click!house/ch-go@v0.73.0/proto/date.go:35-41`). Our `toDate(<unix
seconds>)` resolves in the ClickHouse server's timezone. The two agree only while both are UTC.
Set `TZ=UTC` on the gigapipe container and an explicit UTC `timezone` on the ClickHouse
server in P0, assert `SELECT timezone()` in the same boot check as the F1 schema assertion
(T-22), **and** widen every gin `date` bound by one day either side as defence in depth — it
costs one extra partition on each end of a range that is already prefix-bounded by `key` and
`val`, and it removes the entire class of bug. Without both, rows near local midnight satisfy
the `timestamp_ns` bound, fail the `date` bound, and vanish silently from search, from by-id
authorisation, from session correlation and from erasure alike.

Note also that the illustrative SQL in this document writes `toDate(intDiv(F, 1000000000))`
— integer division. `toDate` of a float is not the same function; `ginSelect` emits the
integer form and the prose must match it.

#### 4.1 Ingest-side mutations required of the gateway — the complete list

**Whose walk this is, and when it ships (T23).** These steps are the *traces* branch of
`02-ingest-gateway.md` §6.3's rewrite walk. `02` currently specifies a generic three-level
`scrubAttrs` walk for spans that contains **none** of steps 1–5: a repo-wide grep of
`02-ingest-gateway.md` finds `op_session_id`, `op_profile_id`, `op_root` and
`TELEMETRY_MAX_CORRELATED_SPANS_PER_TRACE` **zero times**, and `02`'s `scrubAttrs`
unconditionally drops every key matching `isReserved('op_')` — which would delete the
correlation ids the entire P4 differentiator rests on, silently, on every span. So:

* **These seven steps replace `02` §6.3's traces walk.** `02` is the implementing document and
  the code lives in its `apps/api/src/telemetry/rewrite/`; this section is the specification of
  what that code must do for spans, and `02` §6.3 should carry it rather than point at it.
* **The route opens in P4** (T23), so the 2–3 d in this document's Effort table is not
  double-booked against `02`'s P1a. `02`'s P1a *proto vendoring* row (2–4 d, which already
  lists `opentelemetry/proto/trace/v1/trace.proto` among the vendored files) **is** P1 work and
  is **not** counted here — the previous revision's note that it "is estimated in neither
  document and must be" was wrong, and is corrected in Effort.

`POST /v1/traces`, after decoding `ExportTraceServiceRequest` / `TracesData`. Steps run in
this order; the ordering is part of the contract, because step 2 restores what step 1 removed.

0. **Gate.** Run `subscriptionHook` (or an equivalent resolving the org from the telemetry
   token's `projectId`) and the §4.2 quota check. A blocked org gets **403 with a
   `google.rpc.Status` body** — *not* the 202-and-drop of `track.router.ts:14`, which the
   previous revision of this section specified and which is withdrawn (T20). `02` §4 owns the
   status and `10` D15 agrees with it; `05` §4.3's 200-with-`partialSuccess` and 204, and `11`
   A15's 429, are the two remaining divergences and both should move to 403 in one edit.
   `subscriptionHook` returns early when `SELF_HOSTED === 'true'`
   (`apps/api/src/hooks/subscription.hook.ts:33-35`); its typed `Body` is
   `ITrackHandlerPayload | DeprecatedPostEventPayload` and must be widened (it never reads the
   body).
1. **Snapshot then strip.** For each span, record whether it arrived carrying `op_session_id`,
   `op_profile_id` or `op_root`, and their values, into a local variable. **The snapshot is
   taken before `scrubAttrs` runs, not after** — this is the whole content of the exception and
   it is the ordering `02` §6.0 must adopt. Then delete every
   `op_project_id`, `op_session_id`, `op_profile_id`, `op_root` from `Resource.Attributes` and
   from **every** `Span.Attributes`. Then set
   `op_project_id = <projectId from the authenticated telemetry token>` on
   `Resource.Attributes`. Overwrite, never merge — this is the tenancy boundary, and by F3(a)
   a resource attribute wins over a same-named span attribute in the index.
2. **Restore, bounded (T17).** Re-attach the snapshotted `op_session_id` (≤64 bytes) and
   `op_profile_id` (≤256 bytes) to a span **iff** `len(span.ParentSpanId) == 0` **or** the span
   carried `op_root == "1"`. Cap the number of correlation-carrying spans per `trace_id` per
   request at `TELEMETRY_MAX_CORRELATED_SPANS_PER_TRACE = 4`; count the rest on
   `telemetry_span_attrs_dropped_total{reason="non_root_correlation"|"per_trace_cap"}`.
   `op_root` itself is never persisted — it is a transport marker, dropped after step 2.

   **The closed re-attach set, which `01` and `02` must carry verbatim.** `01` D2 reserves the
   whole `op_` prefix and its §5 `enforceLabelPairs` removes every key where `isReservedKey` is
   true; `02` §6.0's `isReserved` tests three spellings and `scrubAttrs` drops them all, on
   every signal, with no restore hook anywhere. As written that ships a gateway that deletes
   `op_session_id` and `op_profile_id` off every span. The exception is **not** "unreserve
   `op_`"; it is a named, closed, gateway-owned set:

   ```ts
   // @openpanel/constants — the ONLY keys the gateway may re-attach after the strip.
   export const OP_CORRELATION_RESTORE_KEYS = [
     OP_SESSION_LABEL,            // 'op_session_id'   — spans only, local root only
     OP_PROFILE_LABEL,            // 'op_profile_id'   — spans only, local root only
     OP_EXCEPTION_TYPE_LABEL,     // 'op_exception_type'    — spans only, from step 4
     OP_EXCEPTION_MESSAGE_LABEL,  // 'op_exception_message' — spans only, from step 4
   ] as const;
   ```

   `op_root` is **not** in the set: it is consumed by step 2 and never written. `op_project_id`
   is not in it either — it is written by step 1 from the token, never restored from a
   snapshot. The values re-attached are the *snapshotted client values* for the two correlation
   keys and *gateway-computed values* for the two exception keys; nothing else in the `op_`
   namespace survives, on any signal, at any level. `11` §3.2 needs the pair of tests that pins
   the asymmetry: a **span** arriving with `op_session_id` comes out with it intact, and a
   **log record** arriving with the same attribute comes out with it removed (T11/T-18).

   The honest statement of what this buys: **enforcement is primarily the customer's span
   processor; the gateway is a bound, not a filter.** A service entered with a remote
   `traceparent` has a non-empty `ParentSpanId`, so the marker is the only way its entry span
   keeps the ids — which is exactly why §11.3's processor sets it.
3. **Clamp timestamps.** Reject a span whose `StartTimeUnixNano` falls outside
   `[now − TELEMETRY_MAX_BACKFILL_HOURS, now + TELEMETRY_MAX_SKEW_MINUTES]` — **`02` §15's env
   vars and `02` §15's values, 24 h and 5 min**, not this document's former 48 h. `02` owns the
   gateway's limits table and one number per limit is worth more than this document's
   preference. Counted on
   `telemetry_spans_dropped_total{reason="timestamp_out_of_range"}`. Both trace tables are
   partitioned on the timestamp (`traces.sql:19`, `:31`), so one process with a broken clock or
   a millisecond/nanosecond unit bug creates partitions across decades and trips ClickHouse's
   "Too many parts" on a table every tenant shares. Far-future rows are worse than noisy: the
   TTL expression is `toDateTime(timestamp_ns / 1000000000) + toIntervalDay(N)`
   (`ctrl/qryn/maintenance/rotate.go:174-190`), so they never expire, and they are invisible to
   every retention-bounded query including §11.6's erasure.
4. **Lift exceptions.** `exception.type` / `exception.message` off the first span event named
   `exception` into `op_exception_type` / `op_exception_message`, truncated to 256 chars (F6).
5. **Cap attributes.** Every remaining attribute value at **`TELEMETRY_MAX_VALUE_LEN` (1024)**
   and the attribute count per span at **`TELEMETRY_MAX_ATTRS` (64)**, incrementing
   `DroppedAttributesCount`. Both are `02` §15's env vars and `02` §15's values; this
   document's `TELEMETRY_MAX_ATTR_BYTES = 2048` and `TELEMETRY_MAX_ATTRS_PER_SPAN = 128` are
   **deleted**, and §12's worst-case arithmetic is redone against the smaller numbers. F4 is
   still the *reason* a cap is needed on this signal — the traces path applies no `SanitizeKey`
   and no 100-character truncation, so an uncapped 20 KB stack trace lands verbatim in the gin
   index — but the number belongs to one owner.
6. **Strip transport headers.** `X-CH-DSN`, `x-ch-dsn`, `X-Ttl-Days`, `x-ttl-days`,
   `X-Scope-Meta` from the proxied request. P1 owns this; it is restated because the trace path
   is the one where `X-CH-DSN` selects a real preconfigured node name, and because
   `writer/chwrapper` carries dormant caller-supplied-DSN dialing that a future gigapipe
   release could wire up in one line.
7. **Forward as binary protobuf** with an explicit `Content-Type: application/x-protobuf`.
   `/v1/traces` registers exactly one parser, keyed `"*"`, ending in `proto.Unmarshal`
   (`writer/router/tempo.go:12`, `writer/controller/tempo.go:37-61`). There is **no** protojson
   branch for traces — that exists only on `/v1/metrics`. Do not plan a JSON forwarding leg.

Corresponding strips on the other two signals (T11, T12), owned by their work-streams but
required by this one: `op_session_id` / `op_profile_id` deleted from OTLP metric data-point
attributes, metric resource attributes and log record attributes; `LogRecord.SpanId` zeroed
unless `TELEMETRY_LOG_SPAN_ID=1`.

That is **seven** ingest-side mutations plus two cross-signal strips, not "three `op_*` stamps".

#### 4.2 Quotas, metering and body limits

* **Body limit is ours alone, and the number is `02`'s.** gigapipe's 64 MiB OTLP cap applies
  to `/v1/metrics` (`OTLPMaxMessageSize()` → `io.ReadAll(io.LimitReader(getBodyStream(r),
  maxSize+1))`, `writer/controller/otlp_metrics.go:38-45, :74-80`) and to the gRPC server's
  `MaxRecvMsgSize`. `/v1/traces` is `OTLPPushV2`, whose pre-request middleware does a plain
  **unbounded** `io.ReadAll(r.Body)` (`writer/controller/tempo.go:41-48`, re-read this
  revision). So the gateway's own limit is the only one on this route. **This document sets no
  number**: the previous revision's "at or below 16 MiB" is deleted, and the route takes
  `02` §15's `TELEMETRY_MAX_COMPRESSED_BYTES` (8 MiB) and `TELEMETRY_MAX_DECOMPRESSED_BYTES`
  (32 MiB) like every other OTLP route, rejecting with 413. Two consequences for other
  documents: `05` §4.1's `OTLP_MAX_BODY = 4 MiB` is a third number and should go; and
  **`11` E29 is wrong for traces** — it asserts "payload over 64 MiB" against "gigapipe's
  ceiling", but there is no ceiling on this route, so the test must assert against `02`'s
  *configured* value or it passes while the real cap is unset.
* **Per-project ceilings.** `TELEMETRY_MAX_SPANS_PER_MIN` and `TELEMETRY_MAX_BYTES_PER_DAY`,
  derived from the subscription tier, enforced with the same Redis counter idiom as
  `04-read-path.md` §8.4's lease. Over the ceiling the gateway sheds with **429 and a
  `Retry-After`**, not 202 and not 403: a quota overrun is recoverable and the exporter should
  back off and re-deliver, which is exactly the distinction `02` D7 draws (hard quota → 429,
  upstream failure → 503, wind-down → 403). The previous revision's "sheds with 202 (never
  4xx — the SDK retry semantics documented in `subscription.hook.ts:18-22` apply to any
  collector too)" had the reasoning backwards: those semantics are *OpenPanel SDK* semantics,
  and an OTLP collector reads 2xx as delivered. Increments
  `telemetry_spans_shed_total{project_id, reason}`. There is **no** existing
  rate limiter to inherit: `activateRateLimiter` appears only on the mcp/manage/export/insights
  routers; track/event/profile/import have none.
* **Metering.** Span count is at-least-once (a retried export re-counts). The gin table's
  `ReplacingMergeTree` collapses byte-identical re-deliveries on read but the meter counts at
  the gateway, before storage, so the stated over-count error bar is the retry rate. Billing
  consumes that number; this work-stream states it rather than correcting it.

### 5. Table constants, and the read/mutation split

**This section changed materially in this revision (T22).** The previous version added
`TELEMETRY_DB`, a pre-qualifying `g()`, `TELEMETRY_TABLES` (pre-qualified values),
`getTelemetryMutationTable()` and `TELEMETRY_IN` to `packages/db/src/clickhouse/client.ts`.
That was the second of **four** helpers for the same job across the corpus, and the second of
**two** exporting the symbol `TELEMETRY_TABLES` — from different modules, with different member
names *and* different value semantics (pre-qualified `'gigapipe.tempo_traces_dist'` here,
unqualified `'tempo_traces'` in `08`). A caller that imported the wrong one would emit
`gigapipe.gigapipe.tempo_traces_dist` or a bare local name, and both fail late.

**One owner, one file, one env var.** The home is
**`packages/db/src/clickhouse/telemetry-client.ts`** (`08-schema-changes.md` S11 / §11), which
already exists in that document's plan and is the only candidate that is lazy, memoised and
pinned to a single node — properties the DDL and mutation paths require and which
`client.ts`'s round-robin `ch`/`chQuery` cannot provide. This document contributes the two
things `08` is missing: the `_dist` read suffix and the `ON CLUSTER` mutation form.

Deleted by this decision: `04` D12's `G()` and its `TELEMETRY_CLICKHOUSE_DATABASE`;
`05` §7.2's `packages/db/src/gigapipe/table-name.ts` and `gigapipeTable(name, mode)`; and this
document's own `client.ts` additions. `CLICKHOUSE_TELEMETRY_DB` survives only as an explicit
**alias** below `GIGAPIPE_DB`, because `08` already documents it and `10` §3.1 already asserts
the two must be equal; `CLICKHOUSE_TELEMETRY_URL` survives because it is the only way to put
telemetry on a *different ClickHouse host*, which is a real managed-deployment shape — but it
no longer decides the *database name*.

```ts
// packages/db/src/clickhouse/telemetry-client.ts   (extends 08-schema-changes.md §11)

/**
 * The gigapipe database name. ONE resolver, in resolution order:
 *   GIGAPIPE_DB  (10-ops-retention-billing.md §3.1 — the name written into
 *                 .env.template, coolify.yml and quiz.ts, and the one 10 §3.1
 *                 declares settled)
 *   CLICKHOUSE_TELEMETRY_DB  (alias, retained for 08's existing text)
 *   'gigapipe'
 * The path segment of CLICKHOUSE_TELEMETRY_URL is NOT consulted for the name --
 * 08's draft let it win, which meant three sources could disagree. That URL now
 * selects a HOST only. assertTelemetryDatabase() (08 §11) still verifies
 * positively that gigapipe wrote where we think it did.
 */
export function telemetryDatabase(): string {
  return (
    process.env.GIGAPIPE_DB?.trim() ||
    process.env.CLICKHOUSE_TELEMETRY_DB?.trim() ||
    'gigapipe'
  );
}

const TELEMETRY_DB_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validated LAZILY, never at module scope. packages/db/index.ts is a barrel
 * imported by apps/api, apps/worker, apps/start, packages/mcp, packages/trpc,
 * the migration runner and every vitest file; a module-scope throw for a
 * malformed GIGAPIPE_DB is an unhandled exception before any logger exists and
 * takes down event ingestion for a feature the operator may not use (08 S11).
 * A bad value degrades to observability.status.signals.traces === false (F-8).
 */
export function isTelemetryDbValid(): boolean {
  return TELEMETRY_DB_RE.test(telemetryDatabase());
}

/**
 * gigapipe's OWN cluster flag (its CLUSTER_NAME, cmd/gigapipe/main.go:96-99).
 *
 * Deliberately NOT isClickhouseClustered() (client.ts:83-93) and not
 * getIsCluster(): that helper returns TRUE unless SELF_HOSTED is set, so on any
 * cloud deployment where gigapipe is single-node it would send every telemetry
 * statement ON CLUSTER against a cluster gigapipe never created. 04 D12 forbids
 * reusing it and is right; 05 §7.2 reuses it and is wrong.
 * 10 D20 additionally leaves CLUSTER_NAME unset on every self-host surface.
 */
export function isGigapipeClustered(): boolean {
  return !!process.env.GIGAPIPE_CLUSTER;
}

/**
 * Table names, UNQUALIFIED. Qualification is the helpers' job, so a caller
 * cannot double-qualify. This is 08 §11's constant, extended with nothing --
 * it is already the complete list, and 11 I14 asks for exactly one of it.
 */
export const TELEMETRY_TABLES = {
  samples:        'samples_v3',
  timeSeries:     'time_series',
  timeSeriesGin:  'time_series_gin',
  metrics15s:     'metrics_15s',
  patterns:       'patterns',
  traces:         'tempo_traces',
  tracesAttrsGin: 'tempo_traces_attrs_gin',
  tracesKv:       'tempo_traces_kv',
  ver:            'ver',
  settings:       'settings',
} as const;

function assertDb(): string {
  const db = telemetryDatabase();
  if (!TELEMETRY_DB_RE.test(db)) {
    throw new Error(`GIGAPIPE_DB is not a valid ClickHouse identifier: ${db}`);
  }
  return db;
}

/** READ name: the Distributed companion in clustered mode. */
export function telemetryReadTable(base: string): string {
  return `${assertDb()}.${base}${isGigapipeClustered() ? '_dist' : ''}`;
}

/**
 * MUTATION name. ClickHouse supports neither `ALTER ... DELETE` nor lightweight
 * `DELETE` on a Distributed table, so every mutation must target the LOCAL table
 * with ON CLUSTER.
 *
 * gigapipe names its local tables WITHOUT a suffix -- its clustered layout is a
 * plain-named local ReplicatedMergeTree plus a `_dist` Distributed companion
 * (ctrl/qryn/sql/traces_dist.sql, log_dist.sql, both read on disk). There is no
 * `_replicated` table anywhere in gigapipe. So this is emphatically NOT
 * getReplicatedTableName() (client.ts:101-106), which returns
 * `${name}_replicated ON CLUSTER '{cluster}'` and would emit
 * `ALTER TABLE gigapipe.samples_v3_replicated ...` -- UNKNOWN_TABLE, on exactly
 * the clustered installs where the paying customers are.
 * 11-testing-strategy.md I14 currently REQUIRES getReplicatedTableName here and
 * must be corrected; see Cross-document reconciliation row 2.
 */
export function telemetryMutationTable(base: string): string {
  const name = `${assertDb()}.${base}`;
  return isGigapipeClustered()
    ? `${name} ON CLUSTER '${process.env.GIGAPIPE_CLUSTER}'`
    : name;
}

/** `IN` must become `GLOBAL IN` when the right-hand side reads a Distributed table. */
export function telemetryIn(): string {
  return isGigapipeClustered() ? 'GLOBAL IN' : 'IN';
}
```

**Which client, for which statement (T22).** This is the distinction `04`/`06` and `08`/`10`
were arguing past each other about, and both halves are right about their own half:

| Statement class | Client | Table helper | Why |
|---|---|---|---|
| Catalogue and trace **reads** (§6, §10, §13) | `chQuery` / `chQueryWithMeta` | `telemetryReadTable()` | `chQueryWithMeta` is what logs per-query `statistics` (`client.ts:357-366`) — the *only* detection F-1 has, since `log_queries` is `0` out of the box — and what applies the `Int` coercion T14 is written against (`client.ts:346-353`). Re-deriving both on a second client is how the two silently diverge. |
| **DDL and mutations** (§11.6 erasure, `08`'s migration 22, `10`'s TTL reconciler) | `getTelemetryClient()` | `telemetryMutationTable()` | `chQuery`'s second argument is settings, not query params, and `ch`/`chQuery` round-robin a comma-separated `CLICKHOUSE_URL` with failover. A statement that must be issued and then read back on the same node needs one pinned node (`10` D19, `08` S11). |

`04` F21's coin-flip — "`G()` returns local shard tables and `chQuery` round-robins nodes, so
autocomplete returns a different subset per call and `hasData` is a coin flip" — is then a
**mitigated** read-path caveat rather than an unmitigated one: `telemetryReadTable()` returns
`_dist` whenever `GIGAPIPE_CLUSTER` is set, so a read that lands on any node sees the whole
cluster. What remains is the *misconfiguration* case (`GIGAPIPE_CLUSTER` unset on a genuinely
clustered gigapipe), which `04` §9.5's active probe already surfaces as
`degraded = 'cluster_mismatch'`. That is the right place for it.

`telemetryIn()` is **used**, not merely declared: every `IN (SELECT … FROM <telemetry table>)`
in §6, §10, §11.6 and §13 is emitted through it. This matters because OpenPanel sets
`distributed_product_mode: 'allow'` globally (`client.ts:114`), which changes what a bare `IN`
over a Distributed right-hand side means rather than erroring. Both trace tables shard on
`sipHash64(oid, trace_id)` (`ctrl/qryn/sql/traces_dist.sql:15, :28`), so trace-keyed subqueries
are co-located and a local `IN` would in fact be correct — but relying on that silently is how
the next sharding-key change becomes a correctness bug, so we emit `GLOBAL IN` and say why. (It
is a function rather than the previous `const TELEMETRY_IN` for the same reason
`telemetryDatabase()` is: nothing in this file may read `process.env` at module scope.)

OpenPanel's own tables stay **bare** via `TABLE_NAMES`: there is no `openpanel` database
constant in the repo, the database comes from the path of `CLICKHOUSE_URL`, and
`self-hosting/quiz.ts` explicitly invites operators to supply their own. Qualified and bare
names mix freely in one statement; migration 4 already proves it
(`packages/db/code-migrations/4-add-sessions.ts:123,127`). Note that
`getExistingTables()` is hardcoded to `WHERE database = 'openpanel'`
(`packages/db/src/clickhouse/migration.ts:177`), so the gigapipe database is invisible to
OpenPanel's migration runner — which is correct: gigapipe creates and upgrades its own schema
(`ctrl/ctrl.go` → `ctrl/maintenance/shared.go:53`) and we must not duplicate that.

**Grants.** Partly settled from disk. `self-hosting/clickhouse/clickhouse-user-config.xml`
contains only a `<profiles><default>` block with `log_queries` and `log_query_threads` set to
`0` — **no `<readonly>`, no `<allow_databases>`** — and `docker-compose.template.yml:76` sets
`CLICKHOUSE_SKIP_USER_SETUP=1`, so the shipped default user is unrestricted and needs no grant
work. What remains genuinely open (Q1) is a bring-your-own-ClickHouse or managed deployment
where the user is not `default`: that user needs `SELECT` on `gigapipe.*` plus `ALTER` /
`DELETE` on `gigapipe.tempo_traces` and `gigapipe.tempo_traces_attrs_gin`. A second
P0 requirement falls out of the same read: `init-db.sh` creates only the `openpanel`
database, and `/docker-entrypoint-initdb.d` runs only on a fresh data directory — so
**who creates `gigapipe`** must be answered explicitly. The answer is gigapipe itself, at
boot, provided its ClickHouse user holds `CREATE DATABASE`.

The same file explains why failure mode F-1's detection cannot be `query_log`:
`log_queries` is `0` for the default profile, so `system.query_log` is empty out of the box.
Use the per-query statistics `chQueryWithMeta` already logs (`client.ts:357-366` logs
`response.statistics`, which the JSON format returns as `{elapsed, rows_read, bytes_read}`).

### 6. Read path

New service file: **`packages/db/src/services/telemetry-traces.service.ts`**, re-exported from
**`packages/db/index.ts`** (the package barrel named by `package.json`'s `main`; there is no
`packages/db/src/index.ts`). It uses `chQuery` + `sqlstring.escape`, the same convention as
`chart.service.ts:151-152, 260`. `clix` is not used: these queries are CTE-heavy with
cross-database names, past the point where the builder helps.

#### 6.0 Query budget — settings, clamps and the lease

Every statement this service emits carries ClickHouse settings via `chQuery`'s second
argument. There is no unlimited statement.

```ts
export const TRACE_QUERY_SETTINGS = {
  max_execution_time: 20,
  max_rows_to_read: 150_000_000,
  max_bytes_to_read: '20000000000',   // 20 GB
  max_result_bytes: '134217728',      // 128 MB
  max_query_size: '262144',           // ClickHouse's own default, stated so it is not a surprise
  timeout_overflow_mode: 'throw',
} as const;

/**
 * Window clamps. Every one is also enforced in zod, so a client cannot widen it.
 *
 * TRACE_SEARCH_MAX_WINDOW_H is DERIVED, not a literal. The previous revision wrote
 * `24 * 7; // == the telemetry retention ceiling`, which hardcoded one of the five
 * different retention numbers in circulation across the corpus. Retention is owned by
 * 10-ops-retention-billing.md and it is PER SIGNAL (10 §6.1: metrics 30 d, logs 14 d,
 * traces 7 d, labels 30 d on cloud; one operator-set window self-hosted). Reading the
 * constant means raising the traces window later is one edit in one document.
 *
 * NOTE FOR 10: its Interfaces table exports that object under the name
 * TELEMETRY_RETENTION_DAYS, which is ALSO the name of the scalar compose env var in
 * 10 §2/§3.1. Rename the object export -- TELEMETRY_RETENTION is the obvious choice --
 * so the two stop colliding. This document imports the renamed symbol.
 */
import { TELEMETRY_RETENTION } from '@openpanel/constants';
export const TRACE_SEARCH_MAX_WINDOW_H     = TELEMETRY_RETENTION.traces * 24;
export const TRACE_METADATA_MAX_WINDOW_MIN = 15;      // §6.4, sized in §12
export const TRACE_LATENCY_MAX_WINDOW_H    = 24;
export const TRACE_MAX_SPANS               = 5000;
export const TRACE_SPAN_WINDOW_PAD_NS      = 3_600_000_000_000n; // 1 h
export const TRACE_ATTRS_IN_LIST           = 24;
```

Three further budget facts, stated because they are easy to discover late:

* **Every window is additionally clamped to the *traces* retention window,
  `TELEMETRY_RETENTION.traces`.** gigapipe's own rotation derives **one** drop interval from
  **one** `SAMPLES_DAYS` and applies it to all eight tables alike
  (`ctrl/qryn/maintenance/rotate.go:122-208`) — which is why `10` D9 installs a *conditional*
  TTL on top of it and why the per-signal windows are OpenPanel's, not gigapipe's. On `10`
  §6.1's cloud defaults the traces window is 7 days and `SAMPLES_DAYS` is set to the **longest**
  window (30) so that a gigapipe clobber over-retains rather than deletes. Asking for older
  data than the traces window is a guaranteed-empty scan. Self-hosted there is one window for
  all signals (`TELEMETRY_RETENTION_DAYS`, default 14) and the same constant resolves to it.
* **The per-project concurrency lease is `04-read-path.md` §8.4's `withProjectLease`,** taken
  once per user-visible query — including `byId`, whose payload decode is the expensive part.
  That spec's §6.4 already commits the trace procedures to it. Beyond it, telemetry queries
  should run as a **separate ClickHouse user with its own quota** from the one the event
  dashboards and `/track` use, so a runaway trace query cannot starve either. That is a P0
  provisioning item (Q1).
* **tRPC and `/track` share one Fastify process.** `apps/api/src/app.ts:171` registers
  `fastifyTRPCPlugin` at prefix `/trpc` and `:380` registers `trackRouter` at `/track`. Decoding
  up to 5000 protobuf span payloads is CPU-bound and synchronous, so one large waterfall stalls
  the event-ingest event loop for **every** project on that instance. Three mitigations, in the
  order to reach for them: (1) `TRACE_MAX_SPANS` is a *measured* number, not an asserted one —
  the P4 exit criterion is a benchmark of decode+serialise wall time at 5000 spans on the
  production instance size, and the constant moves to whatever keeps it under 50 ms;
  (2) the decode loop yields every 250 spans (`await new Promise(setImmediate)`); (3) if (1)
  lands above budget, the telemetry tRPC router moves to `apps/worker`. State the chosen option
  in the PR; do not leave it implicit.

#### 6.1 The one function that may build a gin predicate

```ts
// packages/db/src/services/telemetry-traces.service.ts
import sqlstring from 'sqlstring';
import {
  TELEMETRY_TABLES,
  telemetryReadTable,
  telemetryIn,
} from '../clickhouse/telemetry-client';   // §5 (T22) — NOT clickhouse/client.ts
import { OP_PROJECT_LABEL } from '@openpanel/constants';

/**
 * The ONLY way this service is allowed to touch tempo_traces_attrs_gin.
 * Enforces F2: date range, key, val, timestamp_ns range — the full PK prefix.
 *
 * The date bound is deliberately widened by one day on each side (F9): the writer
 * stamps `date` in the gigapipe process's local timezone and we read it in the
 * ClickHouse server's. P0 pins both to UTC; this is the belt to that pair of braces,
 * and it costs one extra partition at each end of a range already narrowed by key+val.
 */
function ginSelect(opts: {
  key: string;
  values?: string[];            // omit ONLY for a sanctioned F2 exception
  fromNs: bigint;
  toNs: bigint;
  select?: string;              // default 'trace_id, span_id'
  extraWhere?: string[];
  exception?: 'tag-keys' | 'tag-values-any' | 'span-profile';
}): string {
  if (!opts.values?.length && !opts.exception) {
    throw new Error('ginSelect: at least one value is required (or a named F2 exception)');
  }
  const fromDate = `toDate(${opts.fromNs / 1_000_000_000n}) - 1`;
  const toDate = `toDate(${opts.toNs / 1_000_000_000n}) + 1`;
  const valPredicate = !opts.values?.length
    ? null
    : opts.values.length === 1
      ? `val = ${sqlstring.escape(opts.values[0])}`
      : `val IN (${opts.values.map((v) => sqlstring.escape(v)).join(', ')})`;

  return `SELECT ${opts.select ?? 'trace_id, span_id'}
    FROM ${telemetryReadTable(TELEMETRY_TABLES.tracesAttrsGin)}
    WHERE date >= ${fromDate} AND date <= ${toDate}
      AND key = ${sqlstring.escape(opts.key)}
      ${valPredicate ? `AND ${valPredicate}` : ''}
      AND timestamp_ns >= ${opts.fromNs} AND timestamp_ns < ${opts.toNs}
      ${(opts.extraWhere ?? []).map((w) => `AND ${w}`).join('\n      ')}`;
}
```

**Binary ids never leave ClickHouse.** `trace_id` is `FixedString(16)` and `span_id` is
`FixedString(8)` of arbitrary binary (`traces.sql:26-27`), and `chQuery` reads results via
`res.json()` (`packages/db/src/clickhouse/client.ts:340`) — ClickHouse's JSON formats replace
invalid UTF-8 with U+FFFD, so those bytes do **not** survive the round trip. Two absolute rules
follow:

1. Any id that is **selected** is selected as `lower(hex(...))`.
2. Any id that is **compared** against a value from a previous query is compared as
   `unhex('…')` — and in this spec that case never arises, because every id set stays
   server-side as a CTE. `getTraceById` and `deleteTelemetryForProfile` are written that way
   specifically to keep it true.

Test T-24 pins this with a span id containing a `0x80`–`0xFF` byte. The failure mode is not an
error: it is silent under-selection, and in `deleteTelemetryForProfile` it is silent
under-deletion of a GDPR request.

**No `FINAL` on the gin table.** It is a `ReplacingMergeTree` whose `ORDER BY` includes
`timestamp_ns, trace_id, span_id`, so the only rows that collapse are byte-identical
re-deliveries of the same span — which changes nothing in a `DISTINCT` / `IN` / `min()`
context, while `FINAL` would cost a merge on every read. gigapipe's own search path does not
use `FINAL` either (`reader/tempo/sql_index_query.go:57`); its metrics path does
(`reader/tempo/metrics_query.go:358`), inconsistently.

#### 6.2 Search

```ts
export const zTraceSpanStatus = z.enum(['unset', 'ok', 'error']);
export const zTraceSpanKind = z.enum(['internal','server','client','producer','consumer']);

/** Ours: filtering on them either duplicates the mandatory predicate or reaches another tenant. */
const RESERVED_TRACE_KEYS = new Set([OP_PROJECT_LABEL, OP_SESSION_LABEL, OP_PROFILE_LABEL]);

// NOT identifier-shaped. F4 establishes that the traces path applies no SanitizeKey, so real
// keys contain spaces, '/', ':' and leading digits. Bound length, forbid the C0/C1 control
// set, and let everything else through — otherwise tagKeys offers keys that search rejects.
const TRACE_ATTR_KEY_RE = /^[^\u0000-\u001f\u007f]{1,128}$/;

export const zTraceAttrFilter = z.object({
  key: z.string().regex(TRACE_ATTR_KEY_RE, 'invalid attribute key')
    .refine((k) => !RESERVED_TRACE_KEYS.has(k), 'reserved attribute key'),
  operator: z.literal('is'),                                    // T10
  value: z.array(z.string().min(1).max(512)).min(1).max(20),
});

export const zTraceQuery = z.object({
  projectId: z.string(),
  // Resolved by getDatesFromRange(range, timezone) (packages/db/src/services/date.service.ts:15)
  // — NOT resolveDateRange(), which exists in the same file at :4 but truncates to
  // 'YYYY-MM-DD' and would widen a '30min' or 'lastHour' window to whole days. Format is
  // 'yyyy-MM-dd HH:mm:ss' in the project's timezone; the service converts to nanoseconds.
  startDate: z.string(),
  endDate: z.string(),
  service: z.array(z.string().max(256)).max(20).default([]),
  spanName: z.array(z.string().max(256)).max(20).default([]),
  status: z.array(zTraceSpanStatus).max(3).default([]),
  kind: z.array(zTraceSpanKind).max(5).default([]),
  minDurationMs: z.number().int().min(0).max(3_600_000).optional(),
  maxDurationMs: z.number().int().min(0).max(3_600_000).optional(),
  attributes: z.array(zTraceAttrFilter).max(8).default([]),
  // Correlation entry points. Not user-typed — set by the "traces for this session" and
  // "traces for this user" links.
  sessionId: z.string().max(64).optional(),
  profileId: z.string().max(256).optional(),
  take: z.number().int().min(1).max(100).default(50),
  cursor: z.string().nullish(),   // opaque: base64url({ startTs: string, traceId: string })
});
export type ITraceQuery = z.infer<typeof zTraceQuery>;
```

`service`, `spanName`, `status`, `kind` are not special-cased: they are the gin keys
`service.name`, `name`, `status`, `kind`, all written by the OTLP decoder (F5). One code path.

Emitted SQL for `projectId='p_abc'`, unpadded window `[F, T)`, padded window
`[Fp, Tp) = [F − PAD, T + PAD)`, filters `service.name IN ('api')` and
`http.status_code = '500'`, `take = 50`:

```sql
WITH
  -- (1) The mandatory predicate, over the PADDED window. One row per owned span:
  --     op_project_id is a resource attribute, so exactly one gin row per span carries it.
  --     PK prefix: (date, key, val, timestamp_ns).
  scoped_spans AS (
    SELECT trace_id, span_id, timestamp_ns
    FROM gigapipe.tempo_traces_attrs_gin
    WHERE date >= toDate(intDiv(Fp,1000000000)) - 1
      AND date <= toDate(intDiv(Tp,1000000000)) + 1
      AND key = 'op_project_id' AND val = 'p_abc'
      AND timestamp_ns >= Fp AND timestamp_ns < Tp
  ),
  -- (2) The ONE ordering key: startTs = min over the caller's OWN spans of that trace.
  --     `inWindow` restricts membership to traces with an owned span inside the UNPADDED
  --     search window, while startTs is computed over the padded set so it is stable.
  scoped AS (
    SELECT trace_id,
           min(timestamp_ns)                            AS startTs,
           max(timestamp_ns >= F AND timestamp_ns < T)  AS inWindow
    FROM scoped_spans
    GROUP BY trace_id
    HAVING inWindow = 1
  ),
  f0 AS (
    SELECT DISTINCT trace_id FROM gigapipe.tempo_traces_attrs_gin
    WHERE date >= toDate(intDiv(Fp,1000000000)) - 1 AND date <= toDate(intDiv(Tp,1000000000)) + 1
      AND key = 'service.name' AND val IN ('api')
      AND timestamp_ns >= Fp AND timestamp_ns < Tp
  ),
  f1 AS (
    SELECT DISTINCT trace_id FROM gigapipe.tempo_traces_attrs_gin
    WHERE date >= toDate(intDiv(Fp,1000000000)) - 1 AND date <= toDate(intDiv(Tp,1000000000)) + 1
      AND key = 'http.status_code' AND val IN ('500')
      AND timestamp_ns >= Fp AND timestamp_ns < Tp
  ),
  cand AS (
    SELECT trace_id, startTs FROM scoped
    WHERE trace_id GLOBAL IN (SELECT trace_id FROM f0)
      AND trace_id GLOBAL IN (SELECT trace_id FROM f1)
      -- cursor, on the SAME key the page is ordered and displayed by
      AND (startTs, trace_id) < (:cursorTs, unhex(:cursorTraceId))
    ORDER BY startTs DESC, trace_id DESC
    LIMIT 50
  )
SELECT
  lower(hex(t.trace_id))                                          AS traceId,
  argMin(t.service_name, t.timestamp_ns)                          AS rootServiceName,
  argMin(t.name, t.timestamp_ns)                                  AS rootName,
  toString(min(t.timestamp_ns))                                   AS startTimeUnixNano,
  toUInt64(intDiv(min(t.timestamp_ns), 1000000))                  AS traceStartUnixMs,
  intDiv(max(t.timestamp_ns + greatest(t.duration_ns, 0))
         - min(t.timestamp_ns), 1000000)                          AS durationMs,
  count()                                                         AS spanCount,
  uniqExact(t.service_name)                                       AS serviceCount
FROM gigapipe.tempo_traces t
WHERE t.trace_id GLOBAL IN (SELECT trace_id FROM cand)             -- PK-prefix seek
  AND (t.trace_id, t.span_id) GLOBAL IN (SELECT trace_id, span_id FROM scoped_spans)  -- T18
  AND t.timestamp_ns >= Fp AND t.timestamp_ns < Tp
GROUP BY t.trace_id
ORDER BY min(t.timestamp_ns) DESC, t.trace_id DESC
LIMIT 50
```

Six properties, each of which a test pins:

* **One ordering key, provably the same value in both places.** `scoped.startTs` is
  `min(timestamp_ns)` over the trace's owned **gin** rows; the outer `min(t.timestamp_ns)` is
  over the same `(trace_id, span_id)` set in `tempo_traces` within the same padded window. The
  gin row's `timestamp_ns` **is** the span's start — `parserDoer.onSpan` appends the same
  `timestampNs` to the span row and to every attribute row (`builder.go:407, :420`) — so the two
  minima are equal by construction. Selection key, cursor key, display key and outer sort key
  are one value. (Selecting on `max(timestamp_ns)` while displaying the `min`, as an earlier
  draft did, drops every trace whose span window overlaps the last row of the previous page.)
* **The cursor is on trace start, which is immutable.** A late-arriving span changes a trace's
  `max` but never its `min`, so paging a live list neither repeats nor skips.
* **Aggregates are span-scoped (T18).** The outer read is restricted by
  `(trace_id, span_id) IN scoped_spans`, so `rootServiceName`, `spanCount` and `serviceCount`
  describe the caller's own spans. The UI labels the column **"Root (yours)"** and the row
  tooltip reads "earliest span you own in this trace". Grouping by `trace_id` alone returns
  another tenant's `service_name` from `argMin` whenever their span is earliest — an
  authorisation leak hiding inside a row the caller is entitled to see.
* **The ±1 h pad is applied to the `op_project_id` gin read, not only to the outer read.** That
  is what keeps a root span that started just before the window inside `scoped_spans`. It is
  still a full F2 prefix, so it costs two extra hours of one project's index range.
* **`ORDER BY` never sorts a stringified number.** `startTimeUnixNano` is a projection only;
  ordering is on the `Int64`. A span with `TimeUnixNano = 0` would otherwise sort to the wrong
  end of a lexicographic 19-digit compare, and F8 establishes that exporters send malformed
  times.
* **`greatest(duration_ns, 0)`** guards F8.

**Error count** is a second, span-scoped query over the ≤50 candidate trace ids, which keeps
the main query a pure prefix scan:

```sql
WITH mine AS ( <ginSelect op_project_id, padded window, extraWhere: trace_id IN (:candIds)> )
SELECT lower(hex(g.trace_id)) AS traceId, count() AS errorCount
FROM gigapipe.tempo_traces_attrs_gin g
WHERE g.date >= … AND g.date <= … AND g.key = 'status' AND g.val = 'error'
  AND g.timestamp_ns >= Fp AND g.timestamp_ns < Tp
  AND g.trace_id GLOBAL IN (:candIds)
  AND (g.trace_id, g.span_id) GLOBAL IN (SELECT trace_id, span_id FROM mine)
GROUP BY g.trace_id
```

**Which CTE drives the plan.** With at least one user filter, ClickHouse is free to start from
whichever CTE is smaller and the `cand` shape lets it: `scoped` and `f0…fn` are independent
prefix reads intersected by trace id, and the security predicate is preserved either way. With
**no** filter, `scoped_spans` is both the security predicate and the driving set, and at the
§12 baseline a 24-hour unfiltered search reads ~86.4 M gin rows and aggregates them into
~4.3 M groups. That is the honest cost of an unfiltered search and it is why
`TRACE_QUERY_SETTINGS` exists, why the window is clamped, and why the UI defaults to the
project's picker range rather than to "all". The summary's line about the security predicate
being the cheapest is true *per row* and false *per query*: it is the only prefix-shaped
predicate available, which is a weaker and more accurate claim.

**Duration filters** are a `HAVING` on the outer query, because `minDurationMs` means *trace*
duration while the gin `duration` column is *span* duration. When either is set, `cand`'s
`LIMIT` is raised to `take * 20`, the outer query adds `ORDER BY durationMs DESC` — so the UI
copy ("showing the 50 slowest of the most recent 1000 matching traces") is literally what runs
— `truncated: true` is returned if the raised limit was reached, and **the cursor is disabled
in that mode**: there is no stable second page of a re-sorted sample, so the UI shows a
"refine your filters" affordance instead of an infinite scroll.

Return type:

```ts
export interface IServiceTraceSummary {
  traceId: string;              // 32 lowercase hex
  rootServiceName: string;      // earliest span YOU own (T18)
  rootName: string;
  startTimeUnixNano: string;    // T14, display/copy only
  traceStartUnixMs: number;     // drives the ?ts= link (T19)
  durationMs: number;
  spanCount: number;            // your spans
  serviceCount: number;         // your services
  errorCount: number;
}
```

#### 6.3 Trace by id

**One statement, not two.** The authorisation set is a CTE, so no id ever leaves ClickHouse
(§6.1) and no id list is ever inlined into a second statement — which also removes the
multi-megabyte `span_id IN (…)` string a 200k-span trace would otherwise produce, and the
`max_query_size` failure that follows it.

```sql
WITH owned AS (
  -- Authorisation. Deliberately NOT limited: the check must not be a LIMIT-able part of
  -- the read (T9/F-4). It is bounded instead by being a full F2 prefix on ONE trace_id,
  -- and by TRACE_QUERY_SETTINGS.max_rows_to_read.
  SELECT span_id
  FROM gigapipe.tempo_traces_attrs_gin
  WHERE date >= toDate(intDiv(:fromNs,1000000000)) - 1
    AND date <= toDate(intDiv(:toNs,1000000000)) + 1
    AND key = 'op_project_id' AND val = :projectId
    AND timestamp_ns >= :fromNs AND timestamp_ns < :toNs
    AND trace_id = unhex(:traceId)
)
SELECT
  lower(hex(span_id))          AS spanId,
  lower(hex(parent_id))        AS parentSpanId,    -- F7; '' for a root span
  toString(timestamp_ns)       AS startTimeUnixNano,
  toString(greatest(duration_ns, 0)) AS durationNs,
  duration_ns < 0              AS clockSkew,
  service_name                 AS serviceName,
  name                         AS name,
  payload_type                 AS payloadType,
  payload                      AS payload
FROM gigapipe.tempo_traces
WHERE trace_id = unhex(:traceId)
  AND span_id GLOBAL IN (SELECT span_id FROM owned)
  AND timestamp_ns >= :fromNs AND timestamp_ns < :toNs
ORDER BY timestamp_ns
LIMIT 5001
```

An empty result is `NOT_FOUND` — never `FORBIDDEN`, which would confirm the trace exists.
`TRACE_MAX_SPANS = 5000`; the `+1` detects truncation. (gigapipe's own cap is 2000, hardcoded
at `reader/service/tempo.go:83`.) `payload_type` is always `2` for anything the gateway
accepted; a row with `payload_type = 1` means Zipkin data reached gigapipe some other way and
is dropped with a `logger.warn` and a counter, not parsed.

**The time window (T19).** `byId` takes `{ projectId, traceId, fromNs?, toNs? }`. Every link
into it — search rows, the session-page widget, the trace→user panel, P5 alert payloads —
carries `?ts=<traceStartUnixMs>` from `IServiceTraceSummary.traceStartUnixMs`, and the
procedure derives `[ts − 1 h, ts + TRACE_MAX_DURATION_H (6 h)]`. When `ts` is **absent** (a
pasted or bookmarked link) the procedure does a **constant-shaped per-partition walk**:
`TELEMETRY_RETENTION.traces` probes, one per retention day, `date = D` with a `timestamp_ns`
range covering that day. Each step is a single-partition F2 prefix read, so the whole walk is
seven cheap queries rather than one unbounded `(date, key, val)` range scan over the whole
retention window. The ambient dashboard date-range picker is **never** an input to this
procedure.

**Changed in this revision: the walk does not stop at the first hit.** The previous version
did, and `09-ui-surfaces.md` §8 independently requires `/traces/$traceId` to render "not found"
for an unknown id *and* for one belonging to another project "with **no timing difference
between the two**, since the id is guessable from a pasted URL". Early exit breaks that
requirement outright: a trace the caller owns returns after one or two partition reads, while a
foreign id or a fabricated one runs the full sequence. A 128-bit trace id is not guessable, so
this is not a discovery primitive — but it is an **existence-and-ownership oracle** for anyone
who obtains an id out of band (a log line, an error page, a support ticket), which is exactly
the paste-a-URL case `09` is legislating for. So: issue all `TELEMETRY_RETENTION.traces`
probes, union the hits, and return. Wall time on the no-`ts` path is then independent of both
existence and ownership. The cost is six extra single-partition prefix reads on a path that
only a pasted link takes; every link source in §6.3, §13.1 and §13.2 already carries
`traceStartUnixMs`, so the fast path is unaffected. T-15's fixture gains the case, and `09` §8
can keep its wording unchanged because it is now true.

**Where `01-tenancy-and-security.md` §7.5's trace-ownership pre-check went.** That section
specifies a `SELECT 1 FROM gigapipe.tempo_traces_attrs_gin WHERE key = … AND val = :projectId
AND trace_id = unhex(:traceId)` pre-check to run **before proxying `GET /api/traces/{traceId}`**
— but `04-read-path.md` D11 deletes that proxy route entirely, and T1/T2 here confirm it, so
there is no proxy left for the pre-check to guard. Its *function* is not lost: the `owned` CTE
above is the same predicate, on the same table, with the same fail-closed property, and it is
inside the one statement that reads the payload rather than beside it. `01` §7.5 should be
**deleted rather than moved** — a pre-check whose only caller is gone is dead code that reads
as live policy — and its three stated requirements survive here: it fails closed (an empty
`owned` set yields `NOT_FOUND`, and a ClickHouse error propagates as an error, never as an
allow); it goes through the shared table helper (§5, `telemetryReadTable()`); and its Redis
`(traceId → projectId)` cache is **not** carried over, because there is no second statement to
save and caching an authorisation decision keyed on an attacker-supplied id is a liability
with no benefit here.

#### 6.4 Filter-bar metadata (T16)

**Default: no query at all.** The filter bar's key list is the union of attribute keys present
in the decoded payloads of the current page of search results. F3(c) gives us the merged
attribute set for free, so this costs zero round trips and is always consistent with what the
user is looking at. Keys are filtered through `TRACE_ATTR_KEY_RE` and
`RESERVED_TRACE_KEYS` before being offered, so the bar can never suggest a key that
`zTraceAttrFilter` will reject.

**Behind an explicit "load all keys for this window" action**, a sanctioned F2 exception:

```sql
SELECT key, count() AS n
FROM gigapipe.tempo_traces_attrs_gin
WHERE date >= toDate(intDiv(F,1000000000)) - 1 AND date <= toDate(intDiv(T,1000000000)) + 1
  AND timestamp_ns >= F AND timestamp_ns < T
  AND (trace_id, span_id) GLOBAL IN (
        SELECT trace_id, span_id FROM gigapipe.tempo_traces_attrs_gin
        WHERE date >= toDate(intDiv(F,1000000000)) - 1 AND date <= toDate(intDiv(T,1000000000)) + 1
          AND key = 'op_project_id' AND val = :projectId
          AND timestamp_ns >= F AND timestamp_ns < T)
GROUP BY key ORDER BY n DESC LIMIT 200
```

The outer scan has no `key` prefix, so it reads the window's gin rows for **every** tenant.
Sized against §12: ~2.16 B gin rows/day across all tenants at the baseline is ~1.5 M rows/minute,
so `TRACE_METADATA_MAX_WINDOW_MIN = 15` puts the read at ~22 M rows — comfortably inside
`max_rows_to_read`. A 6-hour window would be ~540 M rows, i.e. 3.6× the cap; that is the
number that makes this query non-viable as a default and it is why T16 exists.

**Three brakes, because there were none (T16, changed in this revision).** Correctness of this
query depends *entirely* on the `(trace_id, span_id)` intersection being present — the outer
read has no project predicate of its own — so it is one careless edit away from being a
cross-tenant **read** rather than a cross-tenant **scan**, and T-2's allow-list is the only
thing standing between those two. The cost side had no brake at all: `04-read-path.md` §8.4's
per-project lease **fails open on any Redis error** (`04` F17 is explicit that it is a fairness
control, not a security control), there was no rate limit on `traces.tagKeys`, and
`09-ui-surfaces.md` §4.5 wires the label combobox to fire on a user action with only a
10-minute `staleTime`. So:

1. **`rateLimitMiddleware({ max: 6, windowMs: 60_000 })`** on `traces.tagKeys` and
   `traces.tagValues` (§6.6). It exists (`packages/trpc/src/trpc.ts:135-140`), throttles by
   client IP with an escalating lockout, and is what `auth.ts` and `organization.ts` already
   use. This is a real control; the lease is not.
2. **A deployment-wide concurrency of one** for the unprefixed variant, taken as a Redis
   `SET NX PX 30000` on `telemetry:tracekeys:lock`. A second caller gets the page-derived list
   and a toast, never a queue. Unlike the lease, this one **fails closed**: a Redis error means
   the unprefixed scan does not run, because it is not a fairness control here — it is the only
   thing bounding a whole-instance scan.
3. **The permanent fix is promoted.** The gateway-written tag dictionary below is no longer
   "P6 someday": it is the first P6 item, and it becomes a **P4 deliverable** if Q3's load test
   cannot hold p95 on the 15-minute window. `06` prices it as a rounding error next to the
   2.8 GB/day the gateway already writes, so the trade is cheap and should be made on evidence
   rather than deferred by default.

Results are
cached in Redis for 5 minutes under
`telemetry:tracekeys:<projectId>:<fromMinuteBucket>:<toMinuteBucket>` — the **resolved window**
is in the key, because the user picks the start and two different windows inside one bucket
would otherwise return each other's key list. On error or timeout the action degrades to the
page-derived list with a toast, never to an error card.

Values for one key are cheap when a value prefix is available and a sanctioned exception when
it is not (`date + key + timestamp_ns` is still three of four prefix components):

```sql
SELECT val, count() AS n
FROM gigapipe.tempo_traces_attrs_gin
WHERE date >= … AND date <= … AND key = 'http.route'
  AND timestamp_ns >= F AND timestamp_ns < T
  AND (trace_id, span_id) GLOBAL IN ( <project-scoped set> )
GROUP BY val ORDER BY n DESC LIMIT 100
```

`op_project_id`, `op_session_id` and `op_profile_id` never appear in either result: the first
duplicates the mandatory predicate, and the other two are unique per session/user, so a value
list would be a privacy leak *and* useless.

**The permanent fix is P6:** an OpenPanel-owned `telemetry_trace_tag_keys(project_id, date,
key, val_sample)` dictionary written by the gateway. At 4.3 M traces/day it is a rounding error
next to the 2.8 GB/day the gateway already writes, and it ships alongside T3's index table.

#### 6.5 Payload decode rules

The by-id decoder is the only place OTLP protobuf becomes `ITraceSpan`, and three of its rules
are non-obvious.

1. **Duplicate keys: last wins.** F3 establishes that `payload` holds `span.Attributes`
   **appended with** `resource.Attributes`, unmerged, span-first. Build the attribute map by
   iterating the list in order and overwriting, so the panel agrees with the gin index and with
   `service_name`. A naive `attributes.find(a => a.key === k)` returns the span-level value and
   disagrees with everything else. Test T-25 sets `service.name` at both levels and asserts the
   panel and the index agree.
2. **`AnyValue` kinds that `Array<{key,value}>` cannot represent.** gigapipe's indexer flattens
   arrays and kvlists into dotted, index-suffixed keys — `writeAttrValue`
   (`writer/utils/unmarshal/otlp.go:135-152`) recurses with `prefix+key+"."` and, for arrays,
   the element index as the key. The **payload** keeps them structured. The decoder applies the
   same flattening so the panel and the search index use one vocabulary: `http.header` as an
   array of two strings renders as `http.header.0` and `http.header.1`. Bytes values render as
   base64 with a `(bytes)` suffix; that is our own convention, since gigapipe's
   `writeAttrValue` has no `BytesValue` case and drops them from the index entirely.
3. **`TRACE_ATTRS_IN_LIST = 24`, by explicit priority.** The by-id response trims each span's
   attribute list to the first 24 in this order, then alphabetical within each band:
   `op_*` → `error.*`, `exception.*` → `http.*` → `rpc.*` → `db.*` → `messaging.*` →
   `net.*`, `server.*`, `client.*` → `service.*`, `telemetry.*` → everything else.
   `droppedAttributesCount` is the sum of the gateway's `DroppedAttributesCount` and the number
   trimmed here, and the two are reported separately in the panel so "the customer's SDK
   dropped these" is distinguishable from "we trimmed these".

There is **no server-side decoded-trace cache.** Selecting a waterfall row that has trimmed
attributes calls `observability.traces.spanAttributes({ projectId, traceId, spanId, fromNs,
toNs })`, which re-reads that one row — a `(oid, trace_id, timestamp_ns)` PK-prefix seek plus
one payload decode. It is stateless, so it works behind a load balancer, and it needs no size,
TTL or eviction policy. Q5 still governs whether it is ever called in practice.

#### 6.6 tRPC surface

**The namespace is settled here as one router, and this document was already on it.** The
corpus had three answers — `04` mounts `observability: observabilityRouter` with
`metrics.*` / `logs.*` / `traces.*`, `03` consumes `observability.metrics.chart`, but `05` §5.3
creates `packages/trpc/src/routers/logs.ts` exporting `logsRouter` and every one of its call
sites is `trpc.logs.*`; `09` Q1 flags the consequence ("the UI cannot import three namespaces
for one feature") and `11` Q1 flags the package-location half as blocking before anyone writes
a test file. **Settled: `observability.{metrics, logs, traces, status}`, one router, base
procedure `protectedProcedure.use(rejectShareId)` per `04` D13.** `05`'s `logsRouter` folds in
under `observability.logs`. `01` §7.1's hand-rolled `publicProcedure` with its own session and
access checks is **rejected** and should become a pointer to `04` D13: re-deriving
`enforceAccess` opts the one router the plan calls a security boundary out of every future
change to the repo's central access middleware, which is `04` D13's argument and it is right.
`09`'s proposed `capabilities` child collapses into `observability.status` (below).

All procedures `protectedProcedure`, all composing `observabilityProcedure` and taking `04`
§8.4's lease:

```ts
observability.traces.search
  // zTraceQuery -> { data: IServiceTraceSummary[]; nextCursor?: string; truncated: boolean }
observability.traces.byId
  // { projectId, traceId, fromNs?: string, toNs?: string } -> ITraceByIdResult
observability.traces.spanAttributes
  // { projectId, traceId, spanId, fromNs, toNs } -> { attributes: Array<{key,value}> }
observability.traces.tagKeys
  // { projectId, startDate, endDate } -> Array<{ key: string; n: number }>
  // .use(rateLimitMiddleware({ max: 6, windowMs: 60_000 }))   <- §6.4 brake 1
observability.traces.tagValues
  // { projectId, key, startDate, endDate } -> Array<{ val: string; n: number }>
  // .use(rateLimitMiddleware({ max: 6, windowMs: 60_000 }))   <- §6.4 brake 1
observability.traces.forSession
  // { projectId, sessionId } -> IServiceTraceSummary[]
observability.traces.latency
  // { projectId, startDate, endDate, interval, services?: string[] } -> FinalChart (page-local, T13)
```

`traces.tagKeys` and `traces.tagValues` are the only two procedures in this document that carry
a rate limit, and the reason is specific rather than general: they are the two that issue an
F2 exception — a scan across every tenant's index — on a user action. Everything else in this
list is prefix-bounded to the caller's own project.

**Capability gating reads `observability.status` and nothing else.** `04` §6.5 defines it, `04`
D10 guarantees it never throws for an authorized caller, and this document's §13.1 widget, §15
kill switch and F-8/F-11 all key on `status.signals.traces`. The corpus has three competing
surfaces — `09`'s `telemetry.capabilities → { enabled, hasMetrics, hasLogs, hasTraces,
patterns, blocked }`, `05` D12's server-side `telemetryEnabled` app-context boolean, and this
document's former env-var flip (§15). **One procedure wins: `observability.status`**, extended
with `09`'s `blocked` (it genuinely needs it, for the wind-down banner) and *without*
`patterns` unless `LOG_DRILLDOWN` is on. `09` rewrites its sidebar query and Q-list onto it;
`05`'s app-context flag derives from the same procedure rather than being a second boolean.

Every one takes a top-level `projectId` so `enforceAccess` (`packages/trpc/src/trpc.ts:90-110`)
fires — that middleware only checks when `projectId` is a **top-level** key of the raw input,
and it documents the hole in its own comment at `:97-101`.

**`forSession` is settled here, and `04-read-path.md` §6.4 must be amended to match.** It takes
**both** `projectId` and `sessionId`, **and** calls `requireProjectAccess` explicitly in its
handler regardless — belt and braces, because a future refactor that drops `projectId` from the
input would otherwise silently remove the only check. It then re-verifies session ownership via
`sessionService.byId(sessionId, projectId)`, wrapped: that function throws a bare
`new Error('Session not found')` (`packages/db/src/services/session.service.ts:451-453`), which
through tRPC becomes `INTERNAL_SERVER_ERROR` and a red toast rather than the absent widget
§13.1 promises. On throw, return `[]`.

**Amendment to `04-read-path.md` §6.4** (not §6.3, which is "Procedures — logs"), for its owner:
D11 and D12 are already accepted there and `04` §4.1's route table already omits every Tempo
route — nothing further is needed on that front and this document confirms it rather than
re-opening it. Three deltas remain: (a) §6.4's `forSession` description ("receives a
`sessionId` and no `projectId`") is superseded by the paragraph above; (b) §6.4's procedure
list omits `traces.tagKeys` and `traces.spanAttributes`, which also live on that router and also
take the lease; (c) §8.4 should state explicitly that the lease's fail-open posture (`04` F17)
means it is **not** a control for the three F2 exceptions, so nobody later reads it as one —
§6.4's rate limit and lock are.

**And an amendment to `01-tenancy-and-security.md` §7.7, which is the more urgent one.** Its
`GIGAPIPE_ROUTES` block still lists `tempoSearch`, `tempoTagsV2`, `tempoValuesV2` and
`tempoTraceById` (plus `promSeries`, `promLabels`, `promLabelValues`, `lokiLabelValues`,
`lokiSeries`, which `04` D3 removed in favour of direct ClickHouse). `04` §4.1's table — read
this revision — contains none of them, and lists them under "reads deliberately absent" with
the reasons. Since `01` D11 already assigns read keys to `04`, **`04` §4.1 is the single
normative definition** and `01` §7.7's block should become a pointer plus the five ingest keys.
This is not cosmetic: `01` keeps `tempoTraceById` "gated by §7.5", and §7.5's pre-check is
deleted by `04` D11 (see §6.3 above) — so if `01`'s table is what gets written, the client can
reach the four untenanted Tempo endpoints that T1, T2 and `04` D11 exist to keep it away from,
guarded by a check whose only home has been removed. `11` Q23/Q24 stay as the enforcement, plus
one new assertion: **the two documents' route sets are identical**, tested rather than
maintained by hand.

### 7. Trace search UI

Routes: `apps/start/src/routes/_app.$organizationId.$projectId.traces.tsx` and
`_app.$organizationId.$projectId.traces_.$traceId.tsx`, the same convention as
`sessions.tsx` / `sessions_.$sessionId.tsx`, which is the closest existing analogue (a filtered
infinite list plus a detail page).

* `PageContainer` + `PageHeader`.
* Filter bar: `TableFilterPills` + `AnimatedSearchInput` + `DataTableToolbarContainer` from
  `@/components/ui/data-table/data-table-toolbar`, exactly as
  `components/sessions/table/index.tsx:47-58` uses them. Pill options come from the page's own
  results by default and from `observability.traces.tagKeys` behind the explicit action (T16).
* List: `useWindowVirtualizer` over an infinite query, following
  `components/sessions/table/index.tsx` (`ROW_HEIGHT = 40`, `useInViewport` sentinel). Row:
  status dot · **Root (yours)** = `rootServiceName` · `rootName` · duration bar · span count ·
  relative time. The duration bar's width is `durationMs / p99DurationMsInPage`, the same
  relative-bar idiom as `VisitedRoutes` on the session detail page.
* Empty state `FullPageEmptyState`; loading, nine skeleton rows.
* Row click navigates to `traces/$traceId?ts=<traceStartUnixMs>` (T19), skipping when the click
  landed on an `a, button` — same guard as the sessions table.

The time range comes from `getDatesFromRange(range, timezone)` driven by the existing
`timeWindows` picker, so traces share the project's global range state; the resolved
`yyyy-MM-dd HH:mm:ss` strings are converted to nanoseconds in the service. Note that the picker
offers `30min` and `lastHour`, which is exactly why `resolveDateRange` (day granularity) is not
the helper used.

### 8. The span waterfall

```
apps/start/src/components/traces/
  waterfall.tsx           # virtualized rows + the time ruler
  waterfall-row.tsx       # one span row (memo'd)
  span-detail-panel.tsx   # right-hand attribute panel
  span-status.tsx         # status dot / colour mapping
  use-waterfall-model.ts  # spans[] -> flattened, ordered, depth-annotated rows
```

#### 8.1 Data shape

```ts
export interface ITraceSpan {
  spanId: string;                 // 16 lowercase hex
  parentSpanId: string;           // 16 hex, '' for a root span
  name: string;
  serviceName: string;
  kind: ITraceSpanKind;
  status: ITraceSpanStatus;
  statusMessage: string;
  /** Offset from the trace's earliest span, in ms. Float. T14. */
  startOffsetMs: number;
  durationMs: number;
  /** duration_ns was negative on the row — end preceded start (F8). */
  clockSkew: boolean;
  /** Sorted, resource-merged last-wins (F3/§6.5), trimmed to TRACE_ATTRS_IN_LIST. */
  attributes: Array<{ key: string; value: string }>;
  events: Array<{ offsetMs: number; name: string; attributes: Array<{ key: string; value: string }> }>;
  links: Array<{ traceId: string; spanId: string }>;
  /** From the customer's SDK. */
  droppedAttributesCount: number;
  /** Trimmed by us; a non-zero value is what enables the spanAttributes fetch. */
  trimmedAttributesCount: number;
  /** Debug/copy only. */
  startTimeUnixNano: string;
}

export interface ITraceByIdResult {
  traceId: string;
  traceStartUnixMs: number;
  traceDurationMs: number;
  spans: ITraceSpan[];            // ordered by startTimeUnixNano ASC
  spanCount: number;
  truncated: boolean;             // > TRACE_MAX_SPANS
  /** Spans whose parentSpanId is not present in `spans`. See §8.4. */
  orphanCount: number;
  correlation: {
    sessionId: string | null;     // op_session_id from any span (F3c)
    profileId: string | null;
  };
  services: Array<{ name: string; spanCount: number; errorCount: number; colorIndex: number }>;
}
```

`services[].colorIndex` indexes `chartColors` from `@openpanel/constants` (`index.ts:626`), so
service colours match the rest of the product.

#### 8.2 Flattening and ordering

`use-waterfall-model.ts`, one `useMemo` pass: bucket by `parentSpanId`; roots are spans whose
`parentSpanId` is `''` **or** whose parent id is absent from the set; DFS from each root with
children sorted by `startOffsetMs` then `spanId` (stable tiebreak — identical start times are
common in batched exporters); emit
`IWaterfallRow[] = { span, depth, hasChildren, subtreeErrorCount, subtreeSpanCount }`. A
separate `collapsed: Set<string>` filters the flat array through a second `useMemo`, never a
mutation.

Cycle guard: a `visited` set. `parent_id` is attacker-influenced — a customer's exporter sets
it — and a span pointing at its own descendant would hang the DFS. On a cycle the offending
span is re-parented to the synthetic root and counted in `orphanCount`.

#### 8.3 Virtualisation

`useVirtualizer` from `@tanstack/react-virtual` (already a dependency,
`apps/start/package.json:82`), scoped to a scroll container rather than the window, because the
waterfall sits beside a detail panel and must scroll independently:

```ts
const virtualizer = useVirtualizer({
  count: visibleRows.length,
  getScrollElement: () => scrollRef.current,
  estimateSize: () => WATERFALL_ROW_HEIGHT,   // 28
  overscan: 20,
});
```

The **structural** pattern is the one in `components/sessions/table/index.tsx:79-120`: a
`React.memo`'d, absolutely-positioned row translated with `translateY`, with a
`closest('a, button')` click guard. Two things here deliberately **diverge** from that
component, and they are this component's own decisions rather than inherited practice:

* **Primitives-only props.** `VirtualRow` in the sessions table takes `row`, `virtualRow` and
  `headerColumns` as objects and arrays, so its `memo` almost never holds. Waterfall rows take
  scalars (`spanId`, `depth`, `startOffsetMs`, `durationMs`, `status`, `colorIndex`,
  `isCollapsed`, `subtreeErrorCount`) plus stable callbacks, so it does.
* **No `measureElement`.** The sessions table sets `ref={virtualRow.measureElement}`. Every
  waterfall row is one line, so measuring buys nothing and costs a layout pass per row. The one
  variable-height element — the expanded span-events list — lives in the detail panel.

At `TRACE_MAX_SPANS` rows the DOM holds ~40 nodes and the flatten pass is O(n log n) on 5000
spans, sub-millisecond. The real cost is transferring and deserialising the spans; §12 has the
byte budget.

#### 8.4 Rendering rules

* **Time ruler**: 5 ticks over `traceDurationMs`. Bar left offset
  `startOffsetMs / traceDurationMs`, width `max(durationMs / traceDurationMs, 0.002)` so a 0 ms
  span is still visible.
* **Service colour** as a 3 px left border from `services[].colorIndex`.
* **Errors.** `status === 'error'` renders the name `text-destructive` and fills the bar
  destructive. A **collapsed** row with `subtreeErrorCount > 0` gets a red count badge, so an
  error never hides inside a collapsed subtree. This is the single most important affordance in
  the component.
* **Clock skew.** `clockSkew` renders an amber left marker with a `title` reading "reported end
  time precedes start time".
* **Orphans.** When `orphanCount > 0`, a synthetic root row reading "N spans with no parent in
  this trace" is inserted at depth 0. Its tooltip explains the two causes without
  distinguishing them: truncation, or spans belonging to a different OpenPanel project in the
  same trace (T9). It must not say which — that would confirm another tenant's spans exist.
* **Truncation.** `truncated` renders a banner: "Showing the first 5000 spans of this trace,
  ordered by start time."

#### 8.5 Attribute display

Right-hand `span-detail-panel.tsx`. Grouping uses **the same vocabulary gigapipe uses** for its
`/api/v2/search/tags` scopes (`reader/controller/tempo.go:233-239`) — the prefix list *and* the
exact-match set, so "the same list gigapipe uses" is literally true:

```ts
const RESOURCE_PREFIXES = [
  'service.', 'telemetry.', 'deployment.', 'host.', 'os.', 'process.',
  'container.', 'k8s.', 'cloud.', 'faas.', 'device.', 'webengine.',
] as const;
const RESOURCE_EXACT = new Set(['instance', 'local_endpoint_service_name']);
```

Four groups in order: **Span** (`name`, `kind`, `status`, `statusMessage`, `durationMs`,
`spanId`, `parentSpanId`), **Correlation** (`op_session_id`, `op_profile_id`,
`op_exception_type` — each a link, §13), **Resource (inferred)** (prefix or exact match),
**Attributes** (everything else). Each is a `KeyValueGrid` with `columns={1} copyable`, the
same component the session detail page uses.

The "(inferred)" is load-bearing: we **cannot** faithfully separate resource from span
attributes after ingest, because `otlp.go:81` appends them into one list before marshalling and
the boundary is not recorded (F3). The prefix heuristic is what gigapipe does and what Grafana
does; the label stops anyone building on a guarantee that is not there.

Span events get a collapsible section below, each with `offsetMs`, name and its own
`KeyValueGrid`. Exception events are pinned to the top with the stack trace in a `<pre>` inside
an `overflow-x: auto` container.

---

### 9. Span ↔ log correlation

gigapipe promotes OTLP log-record trace context to first-class **labels**:
`attrsMap["trace_id"] = hex(...)` and `attrsMap["span_id"] = hex(...)`, both overriding any
same-named attribute (`writer/utils/unmarshal/otlplogs.go:52-58`). Labels are what
`fingerprintLabels` hashes (`writer/utils/unmarshal/unmarshal.go:250-270`), so each distinct
label set is a `time_series` row plus one `time_series_gin` row per label pair.

**The join.** From a trace or a span, the logs surface is queried with an added `trace_id`
matcher on the logs work-stream's compiled path:
`{ op_project_id="p_abc", trace_id="4bf92f3577b34da6a3ce929d0e0e4736" }`. From a log line, the
reverse link is that label's value → `traces_.$traceId`.

**The cost, and T12.** Every distinct trace that emits a log line mints a `time_series` row. At
the §12 baseline (~4.3 M traces/day) that is ~4.3 M new series/day, and `time_series_gin` gets
one row per label pair per series — with ~8 labels, ~34 M rows/day. Adding `span_id` multiplies
it by spans-per-trace (~20): ~86 M series/day. Hence T12: the gateway zeroes
`LogRecord.SpanId` unless `TELEMETRY_LOG_SPAN_ID=1`. **The logs work-stream must ratify this**
— it is their table and their series budget. If they decline, the fallback is to keep `span_id`
only for records with `SeverityNumber >= 17` (ERROR and above), preserving "which span threw
this" at a fraction of the cardinality.

**Rejected:** putting `trace_id` in the log *line* and finding it with a LogQL `|= "4bf92f…"`.
Zero cardinality cost, but it turns an indexed lookup into a full scan of the project's log
volume for the window.

### 10. Metric ↔ trace correlation

#### 10.1 Stored OTLP exemplars (P6)

They exist in `samples_v3.string` for metric rows (§3) and no API reads them. If we want them:

```sql
SELECT s.timestamp_ns, s.value, s.string AS traceId
FROM gigapipe.samples_v3 s
WHERE s.type IN (2, 0)
  AND s.string != ''
  AND s.timestamp_ns >= F AND s.timestamp_ns < T
  AND s.fingerprint GLOBAL IN (
    SELECT fingerprint FROM gigapipe.time_series
    WHERE date >= toDate(intDiv(F,1000000000)) AND date <= toDate(intDiv(T,1000000000))
      AND type IN (2, 0)
      AND JSONExtractString(labels, '__name__') = 'http_server_duration_bucket'
      AND JSONExtractString(labels, 'op_project_id') = :projectId)
ORDER BY s.timestamp_ns
LIMIT 200
```

Three warnings, all verified: `type IN (2, 0)` never `type = 2` (0 means UNDEF/both and is
written whenever a Loki-JSON entry carries a line *and* a value, `unmarshal.go:163-165,
:225-228`; gigapipe's own predicates are all `type IN (n, 0)`); `samples_v3` alone kept
`ORDER BY (timestamp_ns)` — `type` was added by `ALTER … ADD COLUMN` with no sort-key change
(`ctrl/qryn/sql/log.sql:115-128`), so the time bound is the only index this query gets; and
almost no OTel SDK emits exemplars without explicit configuration, so this is **P6, gated on a
customer actually asking**.

#### 10.2 Trace-derived latency with exemplars (P4)

This is what "click the p99 spike, land on a slow trace" needs, and it does not depend on the
customer emitting anything special. **It reads only the gin table.** The gin row carries the
span's own `duration` (`traces.sql:30`, written by `builder.go:423`), and the `op_project_id`
row exists exactly once per span, so a per-bucket quantile over the project's spans is a pure
F2 prefix read with **no `tempo_traces` access at all**:

```sql
SELECT
  toUInt64(intDiv(intDiv(timestamp_ns, {stepNs}) * {stepNs}, 1000000))  AS tsMs,
  quantile(0.99)(greatest(duration, 0)) / 1e6                           AS p99Ms,
  quantile(0.50)(greatest(duration, 0)) / 1e6                           AS p50Ms,
  count()                                                               AS spanCount,
  argMax(lower(hex(trace_id)), greatest(duration, 0))                   AS exemplarTraceId,
  toUInt64(intDiv(argMax(timestamp_ns, greatest(duration, 0)), 1000000)) AS exemplarTsMs
FROM gigapipe.tempo_traces_attrs_gin
WHERE date >= toDate(intDiv(F,1000000000)) - 1 AND date <= toDate(intDiv(T,1000000000)) + 1
  AND key = 'op_project_id' AND val = :projectId
  AND timestamp_ns >= F AND timestamp_ns < T
GROUP BY tsMs ORDER BY tsMs
```

Four things to note:

* **The bucket is converted to milliseconds in SQL** (T14). `intDiv(timestamp_ns, stepNs) *
  stepNs` is an `Int64` nanosecond value, and `chQueryWithMeta` runs any column whose meta type
  contains `Int` through `Number.parseFloat` (`client.ts:346-353`), so returning it raw would
  be a lossy double before any transformation ran. Milliseconds fit a double exactly.
* **`argMax(trace_id, duration)`** rather than gigapipe's `any(trace_id)`
  (`reader/tempo/metrics_query.go:636-717`) — the exemplar you want from a latency bucket is
  the *slowest* trace in it. `exemplarTsMs` rides along so the click-through can emit `?ts=`
  (T19).
* **Breakdown by service keeps the prefix.** `services?: string[]` on the input adds a second
  gin CTE with `key = 'service.name' AND val IN (…)` — a full F2 prefix — intersected on
  `(trace_id, span_id)`. Breakdown by *all* services would need `key='service.name'` with no
  `val`, which is not offered: the user picks up to 20 services, or gets the aggregate.
* **This measures span duration, not trace duration**, because that is what the gin row holds.
  The chart is labelled "span latency". Trace-level latency is a `tempo_traces` aggregate and
  is not in P4.

Result is shaped into `FinalChart` (`packages/validation/src/types.validation.ts:106-109`) so
the existing line/area renderers draw it, with `exemplarTraceId` / `exemplarTsMs` carried in a
parallel array consumed by the chart's click handler. Per T13 this chart is page-local and
never persisted. `TRACE_LATENCY_MAX_WINDOW_H = 24` and `TRACE_QUERY_SETTINGS` apply.

---

### 11. The differentiator: propagating `op_session_id` and `op_profile_id`

#### 11.1 Where the ids come from

`op.getSessionId()` and `op.getDeviceId()` exist on the base SDK
(`packages/sdks/sdk/src/index.ts:263-269`). `sessionId` is populated from the `/track`
**response** (`index.ts:132-141`); the API resolves it in `getInfoFromSession`
(`apps/api/src/utils/ids.ts:84-136`) and returns it on every track call. Format: base64url of a
128-bit SHA-256 prefix, 22 characters, alphabet `[A-Za-z0-9_-]`
(`apps/api/src/utils/ids.ts:186-195`) — a valid W3C baggage value with no percent-encoding.

`profileId` is whatever the customer passed to `identify()` — arbitrary, frequently an email.
It **must** be percent-encoded and length-capped.

**Cold start is accepted, not closed.** `this.sessionId` is `undefined` until the first
`/track` response lands, so the very first request of a brand-new session carries no
`op_session_id`. Closing it needs a synchronous id or an extra round trip on every page load;
the surfaces this work-stream ships all start from a session that already has events.
Documented, not fixed.

#### 11.2 SDK changes — exactly which files

**`packages/sdks/sdk/src/index.ts`** (`@openpanel/sdk`, the base every other SDK extends):

```ts
export const MAX_BAGGAGE_BYTES = 512;

const byteLen = (s: string) => new TextEncoder().encode(s).length;

/** W3C baggage member value: percent-encode everything outside the safe set. */
function encodeBaggageValue(v: string): string {
  return encodeURIComponent(v).replace(/[()']/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Never returns a header over MAX_BAGGAGE_BYTES. Members are dropped from the least
 * important end (the customer's existing baggage first, then op_profile_id, then
 * op_session_id) until the result fits; if even one of ours does not fit alone, the
 * result is ''. Measurement is in BYTES, not UTF-16 code units — a 256-byte profile id
 * can percent-encode to ~768 bytes.
 */
export function buildBaggage(
  parts: Record<string, string | undefined>,
  existing?: string,
): string {
  const ours: string[] = [];
  for (const [k, v] of Object.entries(parts)) {
    if (v) ours.push(`${k}=${encodeBaggageValue(v)}`);
  }
  // Drop-order: existing (whole), then ours from the end.
  const candidates: string[][] = [];
  if (existing) candidates.push([existing, ...ours]);
  candidates.push([...ours]);
  for (let drop = 0; drop <= ours.length; drop++) {
    for (const c of candidates) {
      const members = drop === 0 ? c : c.slice(0, c.length - drop);
      if (members.length === 0) continue;
      const joined = members.join(',');
      if (byteLen(joined) <= MAX_BAGGAGE_BYTES) return joined;
    }
  }
  return '';
}

export function parseBaggage(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const member of header.split(',')) {
    const [rawKey, ...rest] = member.split('=');
    if (!rawKey || rest.length === 0) continue;
    // Strip W3C baggage properties (`key=value;prop=x`) before decoding.
    const rawVal = rest.join('=').split(';')[0]!;
    const key = rawKey.trim();
    if (!/^[A-Za-z0-9_.\-]+$/.test(key)) continue;
    try { out[key] = decodeURIComponent(rawVal.trim()); } catch { /* skip */ }
  }
  return out;
}
```

and on the class:

```ts
  /** W3C `baggage` value carrying the OpenPanel correlation ids.
   *  Empty string when there is nothing to send yet (cold start). */
  getBaggage(): string {
    return buildBaggage({
      [OP_SESSION_LABEL]: this.sessionId,
      [OP_PROFILE_LABEL]: this.profileId ? String(this.profileId) : undefined,
    });
  }
```

**`OP_SESSION_LABEL` / `OP_PROFILE_LABEL` are declared locally in the SDK and asserted equal to
`@openpanel/constants` by a test in `packages/constants`.** That is the plan, not the fallback.
The reason is not the `.d.ts` inlining problem the deep-import comment at
`packages/sdks/sdk/src/index.ts:1-7` describes — that comment is about `import type`, which is
erased — it is a **bundle-content** problem: `@openpanel/constants` is a single 640-line barrel
whose first line is `import { differenceInDays, isSameDay } from 'date-fns'`, it declares no
`exports` map (so the `@openpanel/constants/index` specifier is unverified), and
`@openpanel/sdk` ships `"dependencies": {}` with `tsup` bundling everything not listed there. A
runtime import would put the first cross-package code, and possibly date-fns, into the
published browser bundle. Two string literals and an equality test is the cheaper trade.

**`packages/sdks/web/src/index.ts`** (`@openpanel/web`) — a new option:

```ts
export type PropagateSessionOptions = {
  enabled: boolean;
  /** Origins that receive the header. Exact match on `new URL(u).origin`, or RegExp
   *  against the full URL. Default: same-origin only. */
  origins?: (string | RegExp)[];
  /** Patch window.fetch and XMLHttpRequest. Default false — see §11.4. */
  patchFetch?: boolean;
};
```

With `patchFetch` on, the patch installs beside the existing `trackOutgoingLinks` /
`trackAttributes` wiring (`web/src/index.ts:99-111`): it sets a `__openpanel_patched` marker on
`window.fetch` and bails if present; never touches a request whose origin is not in `origins`;
merges rather than replaces any existing `baggage`; and leaves the body untouched by
constructing a new `Headers` from `init.headers` (or `input.headers` when
`input instanceof Request`) rather than cloning the request.

**`packages/sdks/express/index.ts`** — the middleware already builds a per-request `OpenPanel`
and hangs it off `req.op` (`express/index.ts:22-48`). Add, with
`correlation?: Record<string, string>` on the class:

```ts
    sdk.correlation = parseBaggage(req.headers.baggage as string | undefined);
```

**Next.js is a different deliverable, not "the same three lines".** `packages/sdks/nextjs/server.ts`
is exactly one line — `export { createRouteHandler } from './createNextRouteHandler';` — and
`createNextRouteHandler.ts` is a Web-`Request` proxy that forwards `/track` to the API. There is
no per-request `OpenPanel` instance, no `req` and no `req.op` anywhere in `@openpanel/nextjs`.
What we ship instead is a small App-Router helper on the same entry point:

```ts
// packages/sdks/nextjs/server.ts
export { createRouteHandler } from './createNextRouteHandler';
export { getCorrelation } from './getCorrelation';

// packages/sdks/nextjs/getCorrelation.ts
import { parseBaggage } from '@openpanel/sdk';

/** App Router: `const { op_session_id } = await getCorrelation();` */
export async function getCorrelation(): Promise<Record<string, string>> {
  const { headers } = await import('next/headers');
  return parseBaggage((await headers()).get('baggage') ?? undefined);
}
```

Pages Router and middleware users read `req.headers.baggage` and call `parseBaggage`
themselves; that is one line and it is what the docs show.

**No change** to `astro`, `nuxt` or `react-native`: they re-export the base SDK, so
`getBaggage()` arrives for free — including React Native, where the mobile app's session id
rides the same header.

#### 11.3 Server side: baggage → span attribute

The customer's process needs one span processor. **Which published package owns it is a
decision, not an implementation detail:** `packages/logger` is a single `index.ts` with
`"main": "index.ts"` pointing at raw TypeScript, no build script, no `publishConfig`, and
`@hyperdx/node-opentelemetry` as its only OTel-adjacent dependency — customers cannot install
it. The processor therefore ships from a **new published package `@openpanel/otel`**, with
`@opentelemetry/api` and `@opentelemetry/sdk-trace-base` as **peerDependencies** ranged
`^1.30.1 || ^2.0.0` (the range `@hyperdx/node-opentelemetry` already declares in
`pnpm-lock.yaml:8522`, against the `1.30.1` the lockfile currently resolves at `:6161`), a
`tsup` build, and the same dual `cjs`/`esm` output as the other SDKs. `packages/logger` may
depend on it for dogfooding; it does not own it.

```ts
// packages/sdks/otel/src/correlation-processor.ts
import { propagation, type Context } from '@opentelemetry/api';
import type { Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';

const OP_KEYS = ['op_session_id', 'op_profile_id'] as const;

/**
 * Copies OpenPanel correlation ids from baggage onto the LOCAL ROOT span only (T5),
 * and marks that span `op_root = "1"` so the gateway can keep them (T17).
 *
 * "Local root" means: this span has NO parent, or its parent is REMOTE. A server span
 * created from an extracted `traceparent` HAS a parentSpanId — a remote one — and is
 * precisely the span we want. Testing `if (parentSpanId) return` skips it, which makes
 * correlation silently absent for every multi-service customer.
 *
 * `parentSpanContext` is the 2.x accessor; `parentSpanId` is 1.x and carries no
 * remoteness flag. When neither is readable we attach NOTHING: the failure direction is
 * missing data, never a 20x gin blow-up.
 */
export class OpenPanelCorrelationProcessor implements SpanProcessor {
  onStart(span: Span, parentContext: Context): void {
    if (!isLocalRoot(span)) return;
    const baggage = propagation.getBaggage(parentContext);
    if (!baggage) return;
    let attached = false;
    for (const key of OP_KEYS) {
      const entry = baggage.getEntry(key);
      if (entry?.value) {
        span.setAttribute(key, entry.value.slice(0, 256));
        attached = true;
      }
    }
    if (attached) span.setAttribute('op_root', '1');
  }
  onEnd(): void {}
  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

type MaybeParent = {
  parentSpanContext?: { spanId?: string; isRemote?: boolean };
  parentSpanId?: string;
};

function isLocalRoot(span: Span): boolean {
  const s = span as unknown as MaybeParent;
  if (s.parentSpanContext !== undefined) {
    const pc = s.parentSpanContext;
    if (!pc || !pc.spanId) return true;        // no parent at all
    return pc.isRemote === true;               // remote parent -> still a local root
  }
  if ('parentSpanId' in s) {
    // 1.x: no remoteness flag. An empty parent is unambiguously a local root; a
    // populated one is ambiguous, so we do not attach. Documented in the setup guide,
    // with the 2.x upgrade as the fix.
    return !s.parentSpanId;
  }
  return false;                                 // unreadable -> attach nothing
}
```

The OTel JS default propagator is a composite of `W3CTraceContextPropagator` and
`W3CBaggagePropagator`, so `baggage` is already extracted server-side and already propagated
onward to downstream services; nothing else has to be configured.

For customers not running an OTel SDK, `req.op.correlation` / `getCorrelation()` plus
`span.setAttribute('op_session_id', …)` and `span.setAttribute('op_root', '1')` in their own
middleware is the documented fallback, and it is four lines.

The supported `@opentelemetry/sdk-trace-base` range is in the T-22 canary list: a major bump
that renames the parent accessor again must fail a test, not a customer's dashboard.

#### 11.4 Why the fetch patch is opt-in (T6)

`baggage` is not a CORS-safelisted request header. A cross-origin `fetch` carrying it triggers
a preflight, and the customer's server must answer `Access-Control-Allow-Headers: baggage`. If
it does not, the request **fails** — the patch would break the customer's app rather than
degrade. That alone justifies opt-in. Same-origin API calls, the common SaaS shape, are
unaffected.

The rest of the hazard list, for the record: double-wrapping when the customer already patched
`fetch` (Sentry, Datadog RUM, Next.js's own override); an existing `baggage` header from their
own OTel browser SDK, which must be merged not replaced; `Request` objects passed as the first
argument, whose headers live elsewhere; our own `keepalive: true` `/track` calls
(`packages/sdks/sdk/src/api.ts:50-56`), which must be excluded or they carry a session id to
our own API pointlessly; and requests issued before the tracker script finishes loading, which
are simply missed.

#### 11.5 Why it is never a metric or log label (T11)

gigapipe's metric and log label sets *are* the `time_series` fingerprint. A project with
100 000 sessions/day that let `op_session_id` through on one metric would add 100 000
series/day to `time_series` and ~800 000 rows/day to `time_series_gin`, permanently, for a
label nobody can usefully aggregate by. On the **trace** side the same id costs one *row* in
`tempo_traces_attrs_gin` per root span — no fingerprint, no series.

Enforcement is at the gateway, in three places, as a hard filter rather than a warning
(§4.1). Test T-18 asserts a payload carrying them on all three signals comes out clean on two
and intact on traces.

One knock-on: `tempo_traces_kv_mv` will hash `op_session_id` values into its 10 000-bucket
space, filling `tempo_traces_kv` with useless rows. It is a `ReplacingMergeTree`, so volume is
bounded at 10 000 per `(date, key)`, and §6.4 excludes the key from autocomplete. Noted rather
than fixed: suppressing the MV would mean patching gigapipe's schema, which §14 rules out.

#### 11.6 Privacy, retention, erasure and project deletion

**What is stored where.** `op_profile_id` lands in three places: `tempo_traces_attrs_gin.val`
(one row per correlated span), `tempo_traces.payload` (inside the marshalled span proto,
because resource attributes are appended before marshalling — F3), and `tempo_traces_kv.val`.
It is not hashed, because every correlation surface joins it to `openpanel.profiles`.

**Default is off.** `propagateSession.enabled` defaults to `false`. Sending a user identifier
into a backend telemetry store is the customer's decision, and the docs say so in the same
paragraph that shows the config.

**Retention asymmetry, which the UI must state.** Trace retention is
`TELEMETRY_RETENTION.traces` — 7 days on `10` §6.1's cloud defaults — while event data is
retained far longer. "Traces for this session" is therefore empty for any session older than
the telemetry window, and the session page renders "traces are retained for N days", not "no
traces". §11.9 argues that this asymmetry is not only a UI copy problem: it is one of five
multiplied steps in the correlation funnel, and it is one of the two that a cheap change could
move.

**Erasure and project deletion are ONE function, and it is not this document's (T24).** This
section previously specified `deleteTelemetryForProjects(projectIds)` and
`deleteTelemetryForProfile(projectId, profileId)` in `delete.service.ts`, called *between*
`deleteFromClickhouse` and `deleteProjects`. That was the third of three designs for the same
job: `05` §7.4 specifies `purgeTelemetry({projectId, reason, olderThanNs, signals,
resumeJobId})` with a `TelemetryPurgeJob` journal, called from `jobDelete` in a per-project
`try`/`catch` where **only successfully-purged projects proceed to `deleteProjects`**; `08` §14
specifies `deleteTelemetryFromClickhouse(projectIds)` with a `TelemetryErasure` ledger, called
**inside** `deleteFromClickhouse`, which "must never throw … NEVER propagate". Three names,
three ledgers, three call sites, and `05` and `08` are semantically **opposite** on whether a
failed purge blocks the Postgres delete.

**Settled: `08` owns it.** Its two function names here are withdrawn. The reasoning, verified:

* **The call site.** `08`'s inside-`deleteFromClickhouse` position is the only one that covers
  both `apps/worker/src/jobs/cron.delete.ts:46` **and**
  `apps/admin/src/commands/delete-organization.ts:191`. A call bolted into `cron.delete.ts` —
  which is what this document previously said — misses the admin path entirely, and the admin
  path is the one a support engineer uses for a GDPR request.
* **The failure semantics.** `jobDelete()` has no `try`/`catch` anywhere; `08` §14 reproduces
  the four lines and the reading is correct. An unguarded throw from the telemetry delete
  therefore aborts the cron **before `deleteProjects` runs**, and the blast radius is not
  telemetry: no project and no organisation is ever deleted again, on that deployment, silently
  — the GDPR erasure path, the scheduled-delete path and the wind-down terminus all at once.
  `05`'s "only projects whose journal row is committed may have their Postgres rows removed" is
  the opposite rule and would freeze product-wide deletion on a gigapipe outage. `08`'s
  non-throwing contract with a pending ledger row as the retry record is right.
* **What `05` had that `08` should take.** Resumability. `08` resolves fingerprints in Node and
  then mutates; if the worker dies between the resolve and the mutations, the projectId is
  already gone from Postgres and the rows are unreachable forever. `05`'s durable fingerprint
  set and `resumeJobId` close exactly that window and should be folded into
  `TelemetryErasure` — a `resolvedFingerprints` payload plus a state column, drained by the
  same cron. That is the one genuinely better part of `05`'s design and it should not be lost
  with the rest of it.
* **What this document contributes.** The per-profile case. It becomes a **`subject` argument**
  on the one function rather than a second function:

  ```ts
  deleteTelemetryFromClickhouse(
    projectIds: string[],
    opts?: {
      subject?: { profileId: string },       // GDPR erasure for one user
      signals?: ('metrics' | 'logs' | 'traces')[],
      olderThanNs?: bigint | null,
      resumeJobId?: string,
    },
  ): Promise<void>                            // never throws
  ```

  With no `subject`, the trace half resolves `(trace_id, span_id)` from
  `key = 'op_project_id' AND val IN (…)` — which is what `08` §14 already does. With
  `subject.profileId`, it resolves from `key = 'op_profile_id' AND val = :profileId`
  *intersected* with the project set, which is the statement below.

**Profile erasure — the SQL, and the phase it ships in.** The mechanism is written out here so
the deferred estimate is real, but the *job* is scheduled for the phase that either turns
propagation on by default or raises `TELEMETRY_RETENTION.traces` past ~30 days, whichever comes
first. The reason is stated plainly rather than hidden: with `propagateSession.enabled = false`
by default and a 7-day window, **expiry is the erasure mechanism**, comfortably inside any GDPR
response window, and the DPA note can say so honestly. Building a mutation job in P4 for data
most projects do not have is work spent early.

```sql
-- deleteTelemetryFromClickhouse([projectId], { subject: { profileId }, signals: ['traces'] })
-- ONE statement per table. No ids in JS: FixedString(8)/(16) do not survive res.json()
-- (§6.1), so a materialised pair list would silently under-delete a GDPR request.
DELETE FROM gigapipe.tempo_traces          -- telemetryMutationTable(TELEMETRY_TABLES.traces)
WHERE (trace_id, span_id) IN (
  SELECT g.trace_id, g.span_id
  FROM gigapipe.tempo_traces_attrs_gin g
  WHERE g.date >= toDate(now() - INTERVAL :retentionDays DAY) - 1
    AND g.key = 'op_profile_id' AND g.val = :profileId
    AND g.timestamp_ns >= :retentionStartNs AND g.timestamp_ns < :nowNs
    AND (g.trace_id, g.span_id) IN (
      SELECT trace_id, span_id FROM gigapipe.tempo_traces_attrs_gin
      WHERE date >= toDate(now() - INTERVAL :retentionDays DAY) - 1
        AND key = 'op_project_id' AND val = :projectId
        AND timestamp_ns >= :retentionStartNs AND timestamp_ns < :nowNs))
SETTINGS lightweight_deletes_sync = 0
```

…and the same statement against `gigapipe.tempo_traces_attrs_gin`. `:retentionDays` is
`TELEMETRY_RETENTION.traces`.

Five operational facts about that statement:

* **Lightweight `DELETE FROM`, not `ALTER … DELETE`** — the convention
  `packages/db/src/services/delete.service.ts:60-70` already uses for non-MV tables, with
  `lightweight_deletes_sync: '0'`. It writes a `_row_exists` mask instead of rewriting parts
  synchronously, which matters because gigapipe is actively writing to these tables.
  (`08` §14's own open question about `DELETE FROM` on `metrics_15s`, an `AggregatingMergeTree`,
  does not reach the two trace tables: `tempo_traces` is a plain `MergeTree` and
  `tempo_traces_attrs_gin` a `ReplacingMergeTree`, `ctrl/qryn/sql/traces.sql`.)
* **Mutation table, not the read table — and this is a defect in `08` §14 as written.** That
  section emits `DELETE FROM ${db}.${table}` with the plain database-qualified name and the
  pinned `getTelemetryClient()`. On a **clustered** gigapipe that deletes rows on one node only
  and reports success, which is a half-completed GDPR erasure. Every mutation target must go
  through `telemetryMutationTable()` (§5), which returns the local name plus `ON CLUSTER`.
  Equally: it must **not** go through `getReplicatedTableName()`, which `11` I14 currently
  requires and which emits `_replicated` names gigapipe does not have. Both corrections are
  the same one-line change and they are in the reconciliation table as rows 1 and 2.
* **It is still a mutation on a table every tenant shares.** Bound concurrency to one erasure
  job at a time and report "scheduled", not "deleted"; a follow-up check reads
  `system.mutations WHERE is_done = 0 AND table IN (…)` and
  `system.parts WHERE has_lightweight_delete`.
* **`tempo_traces_kv` is not deleted from.** It holds only `(date, key, val_id, val)` with no
  trace or project reference, so a per-profile *or* per-project delete is impossible there; it
  is a shared value dictionary whose buckets other projects still use. `08` §14 says the same
  thing independently. It is bounded at 10 000 values per `(date, key)` and expires with the
  TTL. Say so in the DPA notes rather than pretending otherwise. **`11-testing-strategy.md` I13
  asserts zero rows in `tempo_traces_kv` after `jobDelete()` and therefore fails by
  construction — drop it from that list.** While the list is being edited: `02` §17 enumerates
  seven tables with no `patterns`, `05` §7.4 five (logs only), `08` §14 seven with `patterns`
  and no `_kv`, and `11` eight. Per `11` I14's own request, publish **one** exported constant —
  it already exists, it is `08`'s `TELEMETRY_TABLES` (§5) — and have all four reference it.
* **`tempo_traces` and the gin table are deleted in that order, before the label tables.**
  `08` §14's ordering requirement ("the samples predicate was resolved through
  `time_series_gin`, and `time_series_gin` is itself a target") applies to the trace pair too:
  the `(trace_id, span_id)` set is resolved *from* `tempo_traces_attrs_gin`, so if the gin rows
  went first the payload rows would be orphaned with the only thing that could find them gone.
  `08` already sequences it correctly; it is restated because it is not obvious from the SQL.

**Project deletion — the call site, named.** `apps/worker/src/jobs/cron.delete.ts:44-47` calls
`deleteFromClickhouse(projectIds)` and then `deleteProjects(projectIds)`; the Postgres row is
gone immediately after, so any implementation that reads the project afterwards is reading
nothing. The telemetry step runs **inside** `deleteFromClickhouse` (`08` §14), not between the
two calls, so `apps/admin/src/commands/delete-organization.ts:191` gets it for free.

The cost is stated rather than glossed: `tempo_traces` has no project column, so this is a
mask-write across every part the project's spans touch in the retention window of a shared
table, once per delete-cron tick. The alternative — let the TTL expire the rows and say so in
the DPA notes — is legitimate and cheaper. We enqueue the delete anyway, because retention is
configurable upward and "we deleted your project" has to mean it; but if the telemetry window
is at its 7-day default and the mutation backlog is hurting merges, switching to expiry is a
supported, documented downgrade rather than a regression.

Telemetry tokens themselves cascade-delete with the project (`clients.projectId ON DELETE
CASCADE`), which is why the ClickHouse side needs its own explicit step.

**One acceptance test to add, for `11` gate 1.9's owner:** a throw from the telemetry purge
does **not** prevent any other project or organisation from being deleted. That is the property
`08`'s non-throwing contract exists for and the one `05`'s design would have broken; a source
inspection does not prove it and gate 1.9 already runs the real `jobDelete()`.

#### 11.7 Rollback, repair, and why the label name is versioned (T21)

Every read and every delete in this document is keyed on `key = 'op_project_id'`. There is no
other project column on either trace table: `oid` exists only on the traces family, is never
written by the writer (`writer/service/insert/tempo.go:90-93`, `:189-190`), and does not exist
at all on the logs/metrics or profiles families. So a span written **without** a correct
`op_project_id` — a bad gateway deploy, a rollback, an exporter pointed straight at gigapipe
before the port was locked down, a renamed constant — is permanently invisible to every surface
**and** permanently undeletable by §11.6. It can only age out on the TTL. Four requirements
follow.

1. **The label is versioned and never renamed in place.** It is `op_project_id`, v1, defined
   once in `@openpanel/constants` as `OP_PROJECT_LABEL`. Changing it requires: ship the writer
   stamping both names; wait one full retention window; switch reads to the new name behind a
   dual-read (`key IN ('op_project_id','op_project_id_v2')` — which is still a `(date, key)`
   prefix, just two of them); stop stamping the old name; wait another retention window; drop
   the dual read. There is no in-place `ALTER … UPDATE` path that is cheaper, because the label
   is part of the sort key.
2. **Deploy ordering is a P0 gate, not a runbook note.** In order: gigapipe's port is
   unpublished and reachable only from `apps/api`; the stamping gateway is live and verified by
   T-16 against the real stack; **only then** is any read surface enabled. Enabling reads first
   is harmless (they return nothing); enabling ingest first writes unstampable data.
3. **A scheduled orphan sweep**, weekly, in `apps/worker`: count gin rows in the retention
   window that have **no** `op_project_id` sibling for the same `(trace_id, span_id)`, emit
   `telemetry_orphan_gin_rows` as a gauge, and alert on non-zero. The count query is a
   sanctioned F2 exception with the same caps as §6.4. Deletion of orphans is manual and
   deliberate: a non-zero count is a signal that ingest is misconfigured, and silently deleting
   the evidence is the wrong default.

   **Named, scheduled and registered, because `boot-cron.ts` deletes what it does not know
   about.** Five documents add crons to the same three files with no shared inventory, and
   `apps/worker/src/boot-cron.ts:138-160` **removes every job scheduler whose key is not in its
   in-code `jobs` array** — so a partial landing silently unschedules whichever job lost, which
   `07` A31 correctly calls the worst failure an alerting system has. This sweep is therefore
   specified as the full registration triple, not as a sentence:

   | | |
   |---|---|
   | name / type | **`telemetryOrphanSweep`** |
   | schedule | `40 5 * * 0` (Sunday 05:40) |
   | `CronQueuePayload` | `{ type: 'telemetryOrphanSweep'; payload: undefined }` in `packages/queue` |
   | `cron.ts` switch | `case 'telemetryOrphanSweep'` |
   | `boot-cron.ts` | pushed inside the existing `if (process.env.GIGAPIPE_URL)` guard `10` §6.2 adds |
   | job file | `apps/worker/src/jobs/cron.telemetry-orphan-sweep.ts` |

   The slot is checked against the only inventory that exists today, `10` §6.2's list: `0 2`
   insightsDaily, `0 3` gscSync, `0 4` sessionVacuum, `30 4` insightCleanup, `30 7` dataHealth,
   `0 8` Mon weeklyDigest, hourly `0 *` delete/onboarding/windDown, plus `10`'s `10 */6`
   and `20 1`, plus `05`'s `5 * * * *`, `15 3` and `45 3`, plus `07`'s 60-second `metricAlerts`.
   `40 5 * * 0` is free and avoids the `:00` cluster.

   **Two collisions the inventory exposes, for their owners.** `05` §4.7 and `10` §6.2 both
   register a job named **`telemetryRetention`** with different schedules and different bodies
   — `10`'s is the TTL re-assert, `05`'s is the per-project purge. Under `boot-cron.ts`'s
   remove-what-is-not-listed rule that is not a merge conflict, it is a job that vanishes.
   Rename `05`'s to **`telemetryPurge`**. And someone should publish the whole inventory in one
   place, with `11` §7.2's exhaustive registration test asserting against it; there is no
   blueprint document on disk to put it in, so until there is, `10` §6.2's list is the de facto
   register and every stream should add its row there.
4. **Recovery for already-ingested unstamped data is drop-by-partition.** Both tables partition
   on the timestamp (`traces.sql:19`, `:31`), so `ALTER TABLE … DROP PARTITION` for the affected
   days is the only bounded operation available. It removes every tenant's spans for those days.
   That is the honest recovery story and it is why (2) is a gate.

---

### 12. Cardinality and cost

Baseline: a busy project at **1000 spans/second** = 86.4 M spans/day, ~20 spans/trace =
4.3 M traces/day.

**gin rows per span.** Five from the decoder (F5: `service.name`, `remoteService.name`, `name`,
`status`, `kind`), one for `op_project_id` (T3), plus the customer's own resource attributes
(typically 8–15 for an OTel SDK) and span attributes (5–20 for HTTP/DB spans). Call it
**~25 gin rows per span**, of which we add exactly one.

**Bytes per gin row.** No codecs are declared on any `tempo_traces_attrs_gin` column, so
everything is default LZ4. `trace_id FixedString(16)` + `span_id FixedString(8)` are random and
incompressible: 24 bytes. `timestamp_ns` and `duration` are `Int64` with no codec but land
nearly sorted: ~4 bytes each after LZ4. `date`, `key` and `val` are constant or near-constant
within a prefix range and compress to well under a byte each. **~32 bytes/row.**

**Totals first, because the total is the number an operator needs.**

| | per day | at the 7-day default |
|---|---|---|
| `tempo_traces_attrs_gin` | ~2.16 B rows ≈ **69 GB** | ~15 B rows ≈ **480 GB** |
| `tempo_traces` (payload-dominated, ~600 B/span compressed — *estimate*) | ~86.4 M rows ≈ **52 GB** | ≈ **365 GB** |
| **combined** | **~120 GB/day** | **~850 GB** |

Only the payload figure is an estimate; the gin arithmetic is derived from the column types
above. That total is also what §6.4's untenanted key scan runs against, which is why T16 exists.

**The marginal cost of the security boundary.** `op_project_id` on every span is
86.4 M × 32 B ≈ **2.8 GB/day**, i.e. ~4 % of the gin table. That is the price of decision T3
and it is worth stating out loud in the sizing docs. The rejected alternative (an
OpenPanel-owned `(project_id, date, trace_id, span_id)` table) would cost ~86.4 M rows/day of a
narrower row — call it 1 GB/day — but turns the project predicate from a prefix into an
intersection, so a forgotten predicate becomes a leak instead of an empty result. Revisit at P6
if gin size becomes the binding constraint; the query shapes in §6 change in exactly one place
(`scoped_spans`).

**`op_session_id` / `op_profile_id`, correlated spans only (T5/T17).** 4.3 M correlated
spans/day × 2 rows × ~40 bytes ≈ **340 MB/day**. On every span instead:
86.4 M × 2 × 40 ≈ **6.9 GB/day** — the 20× that T5 avoids and that T17's per-trace cap bounds
even when a customer's processor misbehaves.

**Attribute value cap.** F4 says values are stored untruncated: a 20 KB stack trace on a span
attribute is 20 KB in the gin index *and* 20 KB in the payload.
`TELEMETRY_MAX_ATTR_BYTES = 2048` and `TELEMETRY_MAX_ATTRS_PER_SPAN = 128` are this
work-stream's numbers, enforced by P1. At the cap, worst case per span is
128 × (40 + 128 + 2048) ≈ 283 KB — which is why the cap matters more than it looks.

**Waterfall payload.** 5000 spans × (name, service, 64 attributes averaging 60 bytes) ≈ 20 MB
of JSON before superjson overhead — too much. At `TRACE_ATTRS_IN_LIST = 24` (§6.5) a 5000-span
trace is ≈6 MB, which is why `TRACE_MAX_SPANS` is 5000 and not 50 000, and why §6.0 makes that
constant a measured one. Attributes beyond the trim are fetched per span by
`observability.traces.spanAttributes`, statelessly; there is no server-side cache anywhere in
this design.

---

### 13. The correlation surfaces

#### 13.1 Session replay → backend traces (P4 — ship this first)

**Surface.** A `Backend traces` widget on
`routes/_app.$organizationId.$projectId.sessions_.$sessionId.tsx`, in the left column beside
`Session info` / `Profile` / `Visited pages`. Rendered only when
`observability.status.signals.traces` is true **and** the query returns rows; otherwise the
widget is absent entirely rather than showing an empty state, because most projects will never
send traces.

**The join.** `sessions.id` ⇔ `tempo_traces_attrs_gin` where `key = 'op_session_id'`.

**The window, and its cost.** The caller supplies it. The session detail page already has the
session row in hand, so `forSession` takes `{ projectId, sessionId }` and the **page** passes
`createdAt` / `endedAt`; the procedure only falls back to `sessionService.byId` when it was
called without them (the correlation link from elsewhere). That fallback is **not** a
PK-prefix read and the earlier draft was wrong to say it was: migration 8 rewrote `sessions`
with `orderBy: ['project_id', 'toDate(created_at)', 'created_at']`
(`packages/db/code-migrations/8-order-keys.ts:121`) and renamed it into place (`:254, :280`),
so `id` is **not** in the sort key at all, and `sessionService.byId` applies no date bound
(`packages/db/src/services/session.service.ts:433-449`) — it scans the project's whole session
history. `getProfileById` genuinely *is* a prefix read (`profiles` is
`ORDER BY (project_id, id)`, `16-restructure-profiles.ts:94`); sessions is not. Passing the
window in from the page removes the scan on the surface that matters.

**Open sessions.** `endedAt` is not settled while a session is live. The window end is
`min(now, endedAt ?? now)` plus the 5-minute pad, and the widget re-queries on the session
page's existing polling interval, so a trace arriving mid-session appears without a reload.

```sql
WITH
  -- T18: the project's own spans, in the padded session window. One row per owned span.
  scoped_spans AS (
    SELECT trace_id, span_id
    FROM gigapipe.tempo_traces_attrs_gin
    WHERE date >= toDate(intDiv(:fromNs,1000000000)) - 1
      AND date <= toDate(intDiv(:toNs,1000000000)) + 1
      AND key = 'op_project_id' AND val = :projectId
      AND timestamp_ns >= :fromNs AND timestamp_ns < :toNs
  ),
  sess AS (
    SELECT trace_id, span_id
    FROM gigapipe.tempo_traces_attrs_gin
    WHERE date >= toDate(intDiv(:fromNs,1000000000)) - 1
      AND date <= toDate(intDiv(:toNs,1000000000)) + 1
      AND key = 'op_session_id' AND val = :sessionId
      AND timestamp_ns >= :fromNs AND timestamp_ns < :toNs
  ),
  owned AS (
    -- T9: authorise per span, never per trace.
    SELECT DISTINCT trace_id FROM sess
    WHERE (trace_id, span_id) GLOBAL IN (SELECT trace_id, span_id FROM scoped_spans)
  )
SELECT lower(hex(t.trace_id))                     AS traceId,
       argMin(t.service_name, t.timestamp_ns)     AS rootServiceName,
       argMin(t.name, t.timestamp_ns)             AS rootName,
       toString(min(t.timestamp_ns))              AS startTimeUnixNano,
       toUInt64(intDiv(min(t.timestamp_ns), 1000000)) AS traceStartUnixMs,
       intDiv(max(t.timestamp_ns + greatest(t.duration_ns,0)) - min(t.timestamp_ns), 1000000) AS durationMs,
       count()                                    AS spanCount
FROM gigapipe.tempo_traces t
WHERE t.trace_id GLOBAL IN (SELECT trace_id FROM owned)
  AND (t.trace_id, t.span_id) GLOBAL IN (SELECT trace_id, span_id FROM scoped_spans)   -- T18
  AND t.timestamp_ns >= :fromNs AND t.timestamp_ns < :toNs
GROUP BY t.trace_id
ORDER BY min(t.timestamp_ns) DESC, t.trace_id DESC
LIMIT 200
```

**Cost.** Both gin CTEs are full `(date, key, val, timestamp_ns)` prefixes over a window that is
at most the session length plus 10 minutes (a session times out after `SESSION_TIMEOUT_MS`), so
each touches a few hundred rows. The outer query is a `trace_id` prefix seek on `tempo_traces`
for ≤200 ids, with the span tuple applied as a filter on top. This is the cheapest of the
surfaces by a wide margin and it is the one nobody else can build.

**Reverse direction:** the waterfall's correlation panel renders `op_session_id` as a `Link` to
`/$organizationId/$projectId/sessions/$sessionId` and, when
`sessionService.byId(...).hasReplay` is true, a second "Watch replay" link. That closes the
loop: replay → trace → replay.

#### 13.2 Trace → user (P4), and their funnel outcome (P6)

**The user half — P4, and genuinely two cheap reads.** `op_profile_id` comes off the decoded
payload (no extra query, F3c) → `getProfileById(profileId, projectId)`
(`packages/db/src/services/profile.service.ts:114`), a true PK-prefix read on
`ORDER BY (project_id, id)`. `op_session_id` → `sessionService.byId(sessionId, projectId)`,
which is **not** a prefix read (see §13.1) — on the trace detail page that is one scan of one
project's session history per trace opened, which is acceptable on a detail page and is stated
rather than hidden. Rendered in the correlation panel as a `ProfileAvatar` + name + link,
identical to the profile card at `sessions_.$sessionId.tsx:325-354`.

**The funnel half — moved to P6.** "Did this user complete the funnel in this session?" is
speculative product work inside an infrastructure phase: it needs a funnel picker, a
`localStorage` preference, and a `windowFunnel` over `openpanel.events` on a sort key that does
not contain `session_id`. Nothing else in P4 depends on it, and the differentiator ships
complete without it — clicking through to the session page answers the same question with the
events already there. The SQL is recorded so the P6 estimate is real:

```sql
SELECT session_id,
       windowFunnel({windowMs}{strictness})(
         toUInt64(toUnixTimestamp64Milli(created_at)),
         {step0Condition}, {step1Condition}, {step2Condition}) AS level
FROM openpanel.events
WHERE project_id = {projectId}
  AND created_at >= {sessionCreatedAt} AND created_at <= {sessionEndedAt} + INTERVAL 1 DAY
  AND session_id = {sessionId}
GROUP BY session_id
```

`{strictness}` is **not** a literal: `buildFunnelCte` makes `', \'strict_increase\''`
conditional on `FUNNEL_NON_STRICT_ORDERING`
(`packages/db/src/services/funnel.service.ts:105-113`), so this SQL is illustrative and the
implementation must reuse `funnelService.getFunnelConditions()` and `buildFunnelCte()` rather
than copying the literal. Cost: `events` is
`ORDER BY (project_id, toDate(created_at), profile_id, name)`
(`code-migrations/3-init-ch.ts:118`) with no `session_id`, so `project_id` + `created_at` do all
the pruning and this is a project-day scan; when the profile is identified we add
`AND profile_id = {profileId}`, which restores the third sort-key component and makes it a true
prefix read.

#### 13.3 p99 broken down by cohort (P6)

**The join.** span → `op_profile_id` → `openpanel.cohort_members.profile_id` → `cohort_id`.
Like §10.2, this reads latency straight off the gin table's `duration` column, so
`tempo_traces` is never touched:

```sql
WITH
  scoped_spans AS (
    SELECT trace_id, span_id FROM gigapipe.tempo_traces_attrs_gin
    WHERE date >= toDate(intDiv(F,1000000000)) - 1 AND date <= toDate(intDiv(T,1000000000)) + 1
      AND key = 'op_project_id' AND val = {projectId}
      AND timestamp_ns >= F AND timestamp_ns < T
  ),
  span_profile AS (
    -- SANCTIONED F2 EXCEPTION: no `val` predicate — we want every profile id, not one.
    -- (date, key, timestamp_ns) only. One row per CORRELATED span (T5), so ~1/20 of scoped.
    SELECT trace_id, span_id, val AS profile_id, timestamp_ns, duration
    FROM gigapipe.tempo_traces_attrs_gin
    WHERE date >= toDate(intDiv(F,1000000000)) - 1 AND date <= toDate(intDiv(T,1000000000)) + 1
      AND key = 'op_profile_id'
      AND timestamp_ns >= F AND timestamp_ns < T
      AND (trace_id, span_id) GLOBAL IN (SELECT trace_id, span_id FROM scoped_spans)
  ),
  members AS (
    SELECT profile_id, cohort_id FROM openpanel.cohort_members FINAL
    WHERE project_id = {projectId} AND cohort_id IN ({cohortIds})
  )
SELECT m.cohort_id                                                              AS cohortId,
       toStartOfInterval(toDateTime(intDiv(sp.timestamp_ns, 1000000000)),
                         INTERVAL {n} {unit})                                   AS date,
       quantile(0.99)(greatest(sp.duration, 0)) / 1e6                           AS p99Ms,
       count()                                                                  AS spanCount
FROM span_profile sp
INNER JOIN members m ON m.profile_id = sp.profile_id
GROUP BY cohortId, date
ORDER BY date
```

**Why P6, honestly.** Three reasons, each real. (1) `span_profile` is the sanctioned F2
exception: it reads every correlated span of **every** project in the window before the
`(trace_id, span_id)` intersection prunes it — ~4.3 M rows/day at the baseline across all
tenants — so it needs the §6.0 caps and a window clamp, not just a comment. (2) The join to
`openpanel.cohort_members` is cross-database, works (migration 4 proves qualified names resolve
through this client), but `FINAL` on a `ReplacingMergeTree` is a merge-on-read, and in a
clustered deployment both joins need `GLOBAL`. (3) It measures **correlated-span** latency
only, because that is the only span carrying `op_profile_id`: "p99 of the checkout endpoint by
cohort" is answerable, "p99 of the Postgres query by cohort" is not, unless T5 is reversed.

If it ships it is a `FinalChart` from `observability.traces.latency` with
`breakdown: { type: 'cohort', cohortIds }`, page-local per T13.

#### 13.4 Conversion drop overlaid with backend error rate (P6)

Two independent series on one chart. There is no join — the correlation is *visual*, and
pretending otherwise would be dishonest.

**Series A — conversion rate per interval.** The existing funnel path, bucketed:
`funnelService.buildFunnelCte()` with
`additionalSelects: ['toStartOfInterval(min(created_at), INTERVAL {n} {unit}) AS date']` and
`additionalGroupBy: ['date']`, then `countIf(level >= steps) / count()` per bucket. This is
already what `conversion.service.ts:169` computes; the bucket column is the only new thing.

**Series B — backend error rate per interval.** Both sides read the gin table only, so both are
full F2 prefixes and `tempo_traces` is never touched:

```sql
WITH
  mine AS (
    SELECT trace_id, span_id, timestamp_ns FROM gigapipe.tempo_traces_attrs_gin
    WHERE date >= toDate(intDiv(F,1000000000)) - 1 AND date <= toDate(intDiv(T,1000000000)) + 1
      AND key = 'op_project_id' AND val = {projectId}
      AND timestamp_ns >= F AND timestamp_ns < T
  ),
  errs AS (
    SELECT trace_id, span_id FROM gigapipe.tempo_traces_attrs_gin
    WHERE date >= toDate(intDiv(F,1000000000)) - 1 AND date <= toDate(intDiv(T,1000000000)) + 1
      AND key = 'status' AND val = 'error'
      AND timestamp_ns >= F AND timestamp_ns < T
  )
SELECT toStartOfInterval(toDateTime(intDiv(m.timestamp_ns, 1000000000)),
                         INTERVAL {n} {unit})                                     AS date,
       countIf((m.trace_id, m.span_id) GLOBAL IN (SELECT trace_id, span_id FROM errs))
         / count()                                                                AS errorRate
FROM mine m
GROUP BY date ORDER BY date
```

`mine` is the driving set and it is the project's whole span index for the window — bounded by
the same clamps as §10.2, not free. Series **A** is the more expensive of the two, and it costs
exactly what the existing funnel report costs.

**The output.** One `FinalChart` with two `IChartSerie`s on the same zero-filled date grid.
That grid is the hard part and it is not this work-stream's to invent: the metrics engine owns
the interval→bucket contract and the zero-fill, and this surface consumes it rather than
growing a second one. That, not the SQL, is why it is P6.

**Why "overlaid" and not "correlated".** A conversion drop at 14:05 and an error spike at 14:05
is a coincidence until someone clicks through, so the chart's click handler navigates to
`traces?status=error&start=…&end=…` for that bucket. Shipping a computed correlation
coefficient here would be a lie dressed as a number.

### 14. Service map (not shipped; recorded so nobody re-derives it)

gigapipe has no service graph (§1). The edges are derivable from `tempo_traces` alone, because
`populateServiceNames` writes both `service.name` and `remoteService.name` onto every span
(`writer/utils/unmarshal/otlp.go:60-74`):

```sql
SELECT parent.service_name AS caller, child.service_name AS callee, count() AS calls
FROM gigapipe.tempo_traces child
INNER JOIN gigapipe.tempo_traces parent
  ON child.trace_id = parent.trace_id AND child.parent_id = parent.span_id
WHERE (child.trace_id, child.span_id) GLOBAL IN ( <project-scoped set> )
  AND (parent.trace_id, parent.span_id) GLOBAL IN ( <the same set> )   -- T18
  AND child.timestamp_ns >= F AND child.timestamp_ns < T
  AND parent.timestamp_ns >= F - 3600000000000 AND parent.timestamp_ns < T
  AND child.service_name != parent.service_name
GROUP BY caller, callee
```

A self-join on a table whose sort key starts with `trace_id` — not absurd, but a full read of
the window's spans. Not P4, not P6: it needs its own sizing.

**Not shipped, deliberately:** patching gigapipe to add a service-graph MV, or to suppress
`tempo_traces_kv_mv`, or to make its ruler evaluate alerts. gigapipe is AGPL-3.0 and §13 of
that licence attaches a publication obligation to a modified network service. The standing
position across this plan is that everything is achieved by configuration; nothing in this
document requires a gigapipe patch, and this section is the one place the temptation exists.

### 15. Operational runbook

**Kill switch, no deploy.** `GIGAPIPE_TRACES_READ_ENABLED=0` (env, read per request, not
cached at module scope) forces `observability.status.signals.traces` to `false`, which hides
every trace surface and removes the session-page widget (F-8). `GIGAPIPE_TRACES_INGEST_ENABLED=0`
makes the gateway 202-and-drop `/v1/traces` with a counter. Read and ingest are separate
switches because the useful emergency is usually one of them.

**Pinned version, and what the schema canary means.** The compose template pins an exact
gigapipe tag; upgrading is a deliberate act. T-22 asserts the column lists and sort keys of
both trace tables plus `SELECT timezone()`. When it fires, trace surfaces **fail closed** —
`signals.traces` goes false, reads stop, ingest continues (spans keep landing; we are not
losing data, we are declining to query a schema we do not recognise). The procedure is:
qualify the new gigapipe tag against a staging stack running T-15…T-22; if it passes, bump the
pin; if it does not, stay on the old tag and open an issue. Because §14 rules out patching
gigapipe, the upgrade path is the only lever, which is why the canary asserts sort keys and not
just column names — a sort-key change silently turns a prefix seek into a scan.

**When the gin-growth alarm fires**, in order of preference: (1) identify the project from
`telemetry_spans_ingested_total` and talk to them — the usual cause is a mis-instrumented
service or a high-cardinality attribute, and T17's per-trace cap plus §4.2's per-project
ceiling should already be shedding; (2) tighten that project's `TELEMETRY_MAX_SPANS_PER_MIN`;
(3) revoke or rotate that project's telemetry token, which stops ingest without touching anyone
else; (4) shorten `SAMPLES_DAYS` — **global**, so it shortens logs and metrics retention too,
and it is fought by `ctrl.Rotate` on the next gigapipe boot (F-10, ops work-stream); (5) last
resort, `ALTER TABLE … DROP PARTITION` for the oldest days, which drops every tenant's data for
those days. Do (3) before (4), and never (5) without (1).

**Customer-facing documentation** is a deliverable of this work-stream, not an afterthought:
the OTLP endpoint URL, which header carries the telemetry token, protobuf-only (§4.1 step 7),
a collector config, the `@openpanel/otel` processor snippet plus the non-OTel fallback, the
CORS note from §11.4, and the retention statement from §11.6. It has its own line in the
effort table.

---

## Interfaces

### Exposed by this work-stream

**tRPC** — seven procedures on `04-read-path.md`'s `observability` router (§6.6):
`traces.search`, `traces.byId`, `traces.spanAttributes`, `traces.tagKeys`, `traces.tagValues`,
`traces.forSession`, `traces.latency`. (`read-path.md` §6.4's list is missing `tagKeys` and
`spanAttributes`.)

**Constants** — `@openpanel/constants`: `OP_SESSION_LABEL = 'op_session_id'`,
`OP_PROFILE_LABEL = 'op_profile_id'`, `OP_EXCEPTION_TYPE_LABEL = 'op_exception_type'`,
`OP_EXCEPTION_MESSAGE_LABEL = 'op_exception_message'`, `OP_ROOT_LABEL = 'op_root'`, beside the
tenancy work-stream's `OP_PROJECT_LABEL`. One definition each, except the two the SDK declares
locally and asserts equal (§11.2). Two divergent copies of any of these literals is a
correlation that silently returns nothing.

**DB constants** — `packages/db/src/clickhouse/client.ts`: `TELEMETRY_DB`, `TELEMETRY_TABLES`,
`TELEMETRY_IN`, `isGigapipeClustered()`, `isTelemetryDbValid()`, `getTelemetryMutationTable()`
(§5). `read-path.md` D12 already accepts this collapse.

**DB service** — `packages/db/src/services/telemetry-traces.service.ts`, re-exported from
`packages/db/index.ts`: `searchTraces`, `getTraceById`, `getSpanAttributes`, `getTraceTagKeys`,
`getTraceTagValues`, `getTracesForSession`, `getTraceLatencySeries`. Plus
`deleteTelemetryForProfile` and `deleteTelemetryForProjects` in
`packages/db/src/services/delete.service.ts`, beside `deleteFromClickhouse`.

**SDK** — `op.getBaggage(): string`, `buildBaggage`, `parseBaggage`, `MAX_BAGGAGE_BYTES` from
`@openpanel/sdk`; `PropagateSessionOptions` from `@openpanel/web`; `req.op.correlation` from
`@openpanel/express`; `getCorrelation()` from `@openpanel/nextjs/server`;
`OpenPanelCorrelationProcessor` from a **new published** `@openpanel/otel` with
`@opentelemetry/api` and `@opentelemetry/sdk-trace-base` as peers (`^1.30.1 || ^2.0.0`).

**Gateway contract** — the eight-step `stampTraces` behaviour in §4.1, implemented in P1's
`apps/api/src/services/otlp-traces.ts`, plus the §4.2 quota and lifecycle gate.

**UI** — `apps/start/src/components/traces/*` (§8), consumable by the session page and, later,
by the logs explorer.

### Consumed from other work-streams

| From | What |
|---|---|
| **P0 / ops** | the gigapipe service with its port unpublished; `GIGAPIPE_DB`; `GIGAPIPE_CLUSTER` left unset unless real; **`TZ=UTC` on the gigapipe container and an explicit UTC ClickHouse `timezone`** (F9); the ClickHouse grants and the separate telemetry query user/quota (§5, §6.0); confirmation that gigapipe's ClickHouse user holds `CREATE DATABASE`; the retention cron; the pinned gigapipe tag; the F1/F9 boot assertion |
| **P1 / ingest** | the telemetry router and `validateTelemetryRequest`; `subscriptionHook` (or equivalent) on `/v1/traces` (T20); the protobufjs codec and vendored `opentelemetry/proto/trace/v1/trace.proto`; header stripping; the `stampTraces` call site; **the request body limit, which is the only one — `/v1/traces` has no server-side cap** (§4.2) |
| **P2/P3 / read-path** | the `observability` router, `observabilityProcedure`, `observability.status`, the §8.4 per-project lease, and the `GIGAPIPE_ROUTES` exclusions (already recorded as D11) |
| **P3 / logs** | ratification of T12 (`span_id` zeroed on log records) and of the `trace_id`-label cardinality in §9 |
| **P2 / metrics** | `op_session_id`/`op_profile_id` stripped from metric labels (T11); acknowledgement that `metrics_15s.bytes` is inflated by stored exemplars (§3); the interval→bucket + zero-fill contract §13.4 consumes |
| **Schema** | `ClientType.telemetry`, and the allow-list retrofit that adding it forces |
| **Billing** | span count is at-least-once, over-counted by the collector retry rate (§4.2) |

### Deliberately not exposed

`/api/search/tags` and `/api/search/tag/{tag}/values` are unbounded, untenanted
`SELECT DISTINCT`s over `tempo_traces_kv` (`reader/service/tempo.go:161-172`, `:299-311`), and
`/api/traces/{traceId}` applies no attribute predicate at all — any caller with a trace id gets
its spans from any project. None may appear in `GIGAPIPE_ROUTES`, and gigapipe's port must not
be published. `04-read-path.md`'s route table already reflects this.

---

## Failure modes

| # | Failure | Detection | Response |
|---|---|---|---|
| F-1 | A gin query is written without the full `(date, key, val, timestamp_ns)` prefix and degrades to a partition scan. | The `statistics.rows_read` that `chQueryWithMeta` already logs (`client.ts:357-366`), alarmed per procedure. **Not** `system.query_log`: `self-hosting/clickhouse/clickhouse-user-config.xml` sets `log_queries` to `0` for the default profile, so it is empty out of the box. Plus test T-2. | All gin access goes through `ginSelect()` (§6.1); T-2 parses every emitted statement and allows only the three named F2 exceptions, each of which must carry caps. |
| F-2 | The `op_project_id` predicate is omitted from a new query and the surface returns another tenant's traces. | T-15's two-project fixture. | Structural: `ginSelect` throws without a key/value pair or a named exception, and every read composes `scoped_spans` unconditionally. |
| F-3 | A trace legitimately spans two projects; the waterfall shows holes. | `orphanCount > 0` with `truncated === false`. | Synthetic root row (§8.4), worded so it does not confirm another tenant's existence. |
| F-4 | Truncation at `TRACE_MAX_SPANS` hides the caller's own spans while showing another project's. | Cannot occur: the `owned` CTE in §6.3 restricts to owned span ids and is not itself limited; the `LIMIT` applies to the read. | Structural. This is exactly the failure proxying `/api/traces/{traceId}` would have. |
| F-5 | Aggregates leak another tenant's `service_name` through `argMin` (T18). | T-15 asserts on the returned **aggregate fields**, not merely on the absence of foreign rows — the leak lives inside a row the caller is entitled to see. | Every outer read carries `(trace_id, span_id) IN scoped_spans`. |
| F-6 | `duration_ns` underflow (F8) produces a 292-year bar and destroys the waterfall scale. | `clockSkew` flag. | `greatest(duration_ns, 0)` in SQL; amber marker in the UI. |
| F-7 | A customer sprays `op_session_id` onto every span, or their processor's local-root test is wrong, 20×-ing the gin index. | `telemetry_span_attrs_dropped_total{reason}` **plus** a direct gauge of gin rows/minute for `key IN ('op_session_id','op_profile_id')` per project — the drop counter alone reads near zero in exactly the case that matters. | T17: the gateway keeps the keys only on an empty-`ParentSpanId` span or an `op_root`-marked one, and caps correlated spans per trace per request. Enforcement is primarily the customer's processor; the gateway is a bound. Over the per-project ceiling, §4.2 sheds. |
| F-8 | A customer's clock is wrong, or an exporter sends ms-as-ns, creating partitions across decades. | `telemetry_spans_dropped_total{reason="timestamp_out_of_range"}`; ClickHouse "Too many parts" on a shared table. | §4.1 step 3 clamps to `[now − 48 h, now + 5 min]`. Far-future rows would otherwise never satisfy the TTL expression (`rotate.go:174-190`) and would be invisible to every retention-bounded query including erasure. |
| F-9 | The gigapipe container's `TZ` and the ClickHouse server timezone disagree, so spans near local midnight vanish from every gin read (F9). | T-22 asserts `SELECT timezone()`; the P0 boot check asserts the container env. | `TZ=UTC` on both, **and** every gin `date` bound widened by one day either side in `ginSelect` — the second is what makes the failure impossible rather than merely unlikely. |
| F-10 | The fetch patch breaks a customer's cross-origin API because their server rejects the `baggage` preflight. | Their error rate, not ours. | `patchFetch` off by default; `origins` same-origin by default; documented in the same paragraph as the option (§11.4). |
| F-11 | `GIGAPIPE_URL` unset, gigapipe down, or `GIGAPIPE_DB` malformed. | `observability.status.signals.traces === false`. | Every trace surface is hidden, not errored; the session widget is absent, not empty. `isTelemetryDbValid()` is checked lazily so a bad value never throws at module scope and never takes down event ingestion (§5). |
| F-12 | Telemetry retention (default 7 d) is shorter than event retention, so old sessions show no traces and users report a bug. | Support volume. | The widget states the retention window explicitly instead of rendering an empty state. |
| F-13 | gigapipe's `ctrl.Rotate` re-applies a global TTL over a per-signal TTL the ops work-stream installed, silently shortening trace retention. | P0's nightly reconciler. | Ops work-stream owns it; recorded because traces share `SAMPLES_DAYS` with logs and metrics. |
| F-14 | Spans land with a missing or wrong `op_project_id` and become permanently invisible **and** undeletable. | The weekly orphan sweep gauge (§11.7). | Deploy ordering is a P0 gate; the label is versioned; recovery is drop-by-partition. |
| F-15 | A blocked/expired-trial org keeps writing spans after event ingestion has been cut off. | `telemetry_spans_shed_total{reason="wind_down"}` should be non-zero for such orgs; a zero counter with a blocked org present is the alarm. | T20: `subscriptionHook` on `/v1/traces`, 202-and-drop, self-hosted carve-out intact. |
| F-16 | One project's waterfall decode stalls `/track` for every project on that API instance. | Event-loop lag metric on `apps/api`, correlated with `traces.byId` calls. | §6.0: measured `TRACE_MAX_SPANS`, a yield every 250 spans, and the documented escape hatch of moving the telemetry router to `apps/worker`. |
| F-17 | `tempo_traces_kv` fills with hashed `op_session_id` values. | Row count on `(date, key='op_session_id')`. | Bounded at 10 000/day by the `ReplacingMergeTree` key; excluded from autocomplete (§6.4). Accepted. |

---

## Test requirements

Nothing in this area has coverage today: no test in either repo references `tempo_traces`, and
`apps/api/src/utils/auth.ts` has no test file at all. Everything below is new. The harness is
not from zero, though — `.github/smoke/docker-compose.yml` already boots
`clickhouse/clickhouse-server:25.10.2.65` with the self-hosting config and init script, so the
integration tier is "add a pinned gigapipe service and OTLP fixtures to an existing compose",
not "build a compose".

**Unit — SQL shape** (`packages/db/src/services/telemetry-traces.test.ts`, vitest):

* **T-1** every statement emitted by `searchTraces`, `getTracesForSession`, `getTraceById`,
  `getTraceLatencySeries`, `getTraceTagValues` contains `key = 'op_project_id'` **or** is
  composed with a CTE that does — asserted by parsing the emitted SQL, not by snapshot.
* **T-2** every gin `SELECT` contains all four of `date >=`, `key =`, `val`, `timestamp_ns >=`
  — **except** the three named exceptions (`tag-keys`, `tag-values-any`, `span-profile`), each
  of which must be reachable only via `ginSelect({ exception })` and each of which must carry a
  window clamp and `TRACE_QUERY_SETTINGS`. The test asserts both halves; an unnamed exception
  is a failure. This is the single highest-value test here.
* **T-3** a value containing `'`, `\`, a newline and `\x1a` round-trips through
  `sqlstring.escape` without breaking the statement.
* **T-4** `zTraceQuery` rejects `op_project_id` / `op_session_id` / `op_profile_id` as filter
  keys, rejects a 129-character key, rejects 21 values, rejects an operator other than `is`,
  and **accepts** a key containing a space, a `/`, a `:` and a leading digit (F4).
* **T-5** cursor encode/decode round-trips; a malformed cursor yields `null`, not a throw.
* **T-23** every emitted statement is passed `TRACE_QUERY_SETTINGS` (assert on the second
  argument to the `chQuery` spy, for all seven service functions).
* **T-26** `getTraceById` emits exactly one statement, and no statement anywhere in the service
  interpolates a value that came from a previous query result.

**Unit — baggage** (`packages/sdks/sdk/src/baggage.test.ts`):

* **T-6** `buildBaggage` percent-encodes `,`, `;`, `=`, `"`, space and non-ASCII; a profile id
  of `a,b=c` produces one member, not three.
* **T-7** `parseBaggage` handles W3C properties (`k=v;p=1`), ignores malformed members, and
  rejects keys outside `[A-Za-z0-9_.\-]`.
* **T-8** `buildBaggage` never returns a header over `MAX_BAGGAGE_BYTES` **measured in bytes**
  (`TextEncoder`), including the case where the customer's existing header alone exceeds it and
  the case where a 256-character profile id percent-encodes past the cap on its own — the
  latter must yield `''` or a session-only header, never an oversized one.
* **T-9** round-trip `parseBaggage(buildBaggage(x)) === x` over a property-based sample of
  session and profile ids.
* **T-27** `OP_SESSION_LABEL` / `OP_PROFILE_LABEL` declared in `@openpanel/sdk` equal the
  `@openpanel/constants` values (lives in `packages/constants`, §11.2).

**Unit — correlation processor** (`packages/sdks/otel/src/correlation-processor.test.ts`):

* **T-28** a span with a **remote** parent span context IS stamped (`op_session_id`,
  `op_profile_id`, `op_root`) — the multi-service case the naive `if (parentSpanId) return`
  breaks.
* **T-29** a span with a **local** (non-remote) parent is NOT stamped.
* **T-30** a span with no parent at all IS stamped.
* **T-31** a span object exposing neither `parentSpanContext` nor `parentSpanId` is NOT stamped
  — the failure direction is missing data, never cardinality.

**Unit — waterfall model** (`apps/start/src/components/traces/use-waterfall-model.test.ts`):

* **T-10** a well-formed 3-level trace flattens in DFS order with correct depths.
* **T-11** a span whose parent is absent becomes a root and increments `orphanCount`.
* **T-12** a parent/child cycle terminates and re-parents rather than hanging.
* **T-13** `subtreeErrorCount` propagates to a collapsed ancestor.
* **T-14** two siblings with identical `startOffsetMs` order deterministically by `spanId`.

**Integration — real ClickHouse + pinned gigapipe** (`apps/api`, extending
`.github/smoke/docker-compose.yml`):

* **T-15 (the important one)** two projects, two telemetry tokens, spans pushed under both with
  a **shared `trace_id`** and interleaved timestamps such that B's span is the earliest. Assert:
  A's search returns the trace but `rootServiceName`/`rootName` are **A's** earliest span, and
  `spanCount`/`serviceCount`/`errorCount` count **A's** spans only (T18/F-5); A's `getTraceById`
  returns only A's spans with a non-zero `orphanCount`; A's `getTraceById` on a trace containing
  only B's spans returns `NOT_FOUND`, not `FORBIDDEN`.
* **T-16** a client sending `op_project_id="other_project"` as a resource attribute has it
  overwritten; the row lands under its own project.
* **T-17** correlation stamping: `op_session_id` on a span with an empty `ParentSpanId`
  survives; on a span with a populated `ParentSpanId` and **no** `op_root` marker it is
  dropped; on a span with a populated `ParentSpanId` **and** `op_root="1"` it survives; a batch
  exporting a child **without** its parent still drops the child's keys (the batch-split case
  the old "parent not in this batch" rule got wrong); a request carrying the keys on 10 spans of
  one trace keeps at most `TELEMETRY_MAX_CORRELATED_SPANS_PER_TRACE`.
* **T-18** `op_session_id` on a metric data point and on a log record does **not** appear in
  `time_series.labels`; `LogRecord.SpanId` is zeroed.
* **T-19** a span with `EndTimeUnixNano < StartTimeUnixNano` yields `durationMs === 0` and
  `clockSkew === true`.
* **T-20** a 6000-span trace returns 5000 spans with `truncated === true`.
* **T-21** `deleteTelemetryForProfile` removes the profile's spans from `tempo_traces` and
  `tempo_traces_attrs_gin` and leaves another project's spans in the same trace untouched;
  `deleteTelemetryForProjects` does the same for a whole project. Both run against the
  **mutation** table name in a clustered fixture (§5) — the clustered path is where the naive
  implementation fails at runtime.
* **T-22** schema + environment canary: `DESCRIBE gigapipe.tempo_traces` and
  `DESCRIBE gigapipe.tempo_traces_attrs_gin` match the expected column lists; `SHOW CREATE
  TABLE` sort keys match; `SELECT timezone()` is `UTC`; the gigapipe container's `TZ` is `UTC`;
  the resolved `@opentelemetry/sdk-trace-base` version is inside the supported peer range. This
  is the canary for a gigapipe version bump and for §15's fail-closed rule.
* **T-24** a span whose `span_id` contains a `0x80`–`0xFF` byte is returned by `getTraceById`
  and deleted by `deleteTelemetryForProfile`. Guards the JSON-round-trip trap (§6.1) — the
  failure mode is silent under-selection and silent under-deletion, not an error.
* **T-25** a span with `service.name` set on **both** the span and the resource: the by-id
  panel and the search index agree, and both show the resource value (F3).
* **T-32** paging: seed 120 traces with overlapping durations and interleaved span timestamps;
  three pages of 50 concatenated yield exactly the 120 distinct ids a single unpaginated query
  returns, with no repeats and no gaps.
* **T-33** a blocked org (`windDownStep = 'blocked'`) pushing to `/v1/traces` gets 202 and
  writes nothing; the same push with `SELF_HOSTED=true` succeeds.
* **T-34** a span with `StartTimeUnixNano` in 1970 and one in 2106 are both dropped with
  `reason="timestamp_out_of_range"`, and no partition outside the expected range exists
  afterwards.

**Manual, once, before P4 closes:** push a trace with an `exception` span event and confirm
`op_exception_type` is searchable and the stack trace renders; and run the §6.0 decode
benchmark at 5000 spans, recording the number that sets `TRACE_MAX_SPANS`.

---

## Open questions

| # | Question | What would settle it |
|---|---|---|
| **Q1** | For a **bring-your-own / managed** ClickHouse where the connecting user is not `default`: does it hold `SELECT` on `gigapipe.*`, `ALTER`/`DELETE` on the two trace tables, and `CREATE DATABASE` for gigapipe's own boot? And can we provision a *separate* telemetry query user with its own quota? | `SELECT * FROM system.grants WHERE user_name = currentUser()` against that deployment. **Half of this is already settled from disk and no longer blocking:** `self-hosting/clickhouse/clickhouse-user-config.xml` applies no `<readonly>` and no `<allow_databases>`, and `docker-compose.template.yml:76` sets `CLICKHOUSE_SKIP_USER_SETUP=1`, so the shipped self-hosting user is unrestricted. `init-db.sh` creates only `openpanel`, so "who creates `gigapipe`" is a real P0 item (answer: gigapipe, at boot). |
| **Q2** | Is the local-declaration + equality-test approach for `OP_SESSION_LABEL` / `OP_PROFILE_LABEL` acceptable to the SDK owner, or do they want an `exports` map added to `@openpanel/constants`? | A decision, not an investigation. The constraint is established: `@openpanel/constants` has no `exports` map, its first line imports `date-fns`, and `@openpanel/sdk` ships `"dependencies": {}` with `tsup` bundling everything unlisted — so a runtime import puts cross-package code and possibly date-fns into the published browser bundle. |
| **Q3** | What is the real p95 of `searchTraces` **unfiltered** at 10 M spans/day, and of the §6.4 "all keys" query at the 15-minute clamp? | Load-test against a seeded ClickHouse before promising an unfiltered search or an autocompleting filter bar. §12's arithmetic sizes them; it does not measure them. If unfiltered search cannot hold p95, the fix is to require at least one filter, not to widen the caps. |
| **Q4** | Does the logs work-stream accept T12 (`span_id` zeroed)? | Their call. If not, §9's ERROR-and-above fallback is the compromise. |
| **Q5** | Is `observability.traces.spanAttributes` ever called in practice, or is `TRACE_ATTRS_IN_LIST = 24` enough? | Measure the `trimmedAttributesCount` distribution on dogfood data. If it is always zero, the procedure stays as dead-simple insurance; it costs one PK-prefix read when used and nothing when not. |
| **Q6** | Does `payload` ever contain a span whose `payload_type` is not `2`? | Only if something bypasses our gateway. The counter in `getTraceById` answers it in production; until then the branch logs and drops. |
| **Q7** | Should OpenPanel's own `apps/api` / `apps/worker` traces go into gigapipe, dogfooding P4? | Attractive — a ready-made ingest client. It needs an OTLP tracing path not gated on `HYPERDX_API_KEY` (`apps/api/src/utils/observability.ts:16`) and an SDK flush added to `apps/api/src/utils/graceful-shutdown.ts`, which today ends in `process.exit()` with no flush. Belongs to the self-instrumentation work-stream; flagged here because P4 benefits first, and because it is the only way T-15's fixtures get exercised by real traffic before a customer sends any. |
| **Q8** | Cluster mode: `traces_data.go:52` builds its `traces_info` CTE from `ctx.TracesTable` (local) rather than `ctx.TracesDistTable`, which looks like a gigapipe bug. | Irrelevant to us (we do not use the reader) and irrelevant single-node. Recorded so nobody re-discovers it while debugging a clustered deployment. |
| **Q9** | Is `TRACE_MAX_SPANS = 5000` the right number? | The §6.0 benchmark, which is a P4 exit criterion rather than an open question in the usual sense: the number moves to whatever keeps decode+serialise under 50 ms on the production instance size. |

---

## Effort

Ranges, not point estimates, with the assumption that moves each one named.

| Item | Estimate | What makes it the high end |
|---|---|---|
| `telemetry-traces.service.ts` — seven queries + `ginSelect` + escaping + T-1…T-5, T-23, T-26 | **4–5 d** | The paging invariant (T-32) and the span-scoped aggregates (T18) are subtle; budget a day for getting `scoped_spans` / `scoped` / `cand` right against real data rather than against a fixture. |
| `stampTraces` contribution to P1's gateway (§4.1 steps 1–7) + T-16, T-17, T-34 | **2–3 d** | Step 1's snapshot-then-strip-then-restore ordering and the per-trace cap need a real OTLP fixture set. High end if P1 has not yet vendored `trace.proto` and stood up the protobufjs codec — **which is estimated in neither document and must be**. |
| §4.2 quota + `subscriptionHook` on the telemetry route + T-33 | **1 d** | Low risk; the hook is a copy and the counter idiom exists. |
| tRPC procedures + `observability.status` extension + `forSession` auth | **1 d** | — |
| Trace search route, filter bar, virtualized list | **3 d** | Assumes T16's page-derived keys; the "load all keys" action is inside this number. |
| Waterfall (model, virtualisation, rows, detail panel) + T-10…T-14 | **5 d** | Covers only the §8.4 rendering rules. **Excludes** search-within-trace, span filtering and a minimap — those are separate and not scoped here. |
| SDK: `getBaggage`/`buildBaggage`/`parseBaggage`, Express field, Next.js `getCorrelation`, + T-6…T-9, T-27 | **2–3 d** | The Next.js piece is a new export with a `next/headers` dependency, not the three lines an earlier draft assumed. |
| New published `@openpanel/otel` package: processor, peers, build, + T-28…T-31 | **2 d** | A new publishable package with a `tsup` build and a peer range, not a file in `packages/logger` — that package has no build, no `publishConfig` and no OTel deps, so customers cannot install from it. |
| Optional `patchFetch` (cut first) | **2 d** | The hazard list in §11.4 is the work; the patch itself is short. |
| Session-page traces widget (§13.1) | **1 d** | — |
| Trace → user panel (§13.2, user half only) | **1 d** | Two reads and a card. |
| Customer-facing documentation (§15) | **1 d** | Endpoint, token header, protobuf-only, collector config, processor snippet, CORS note, retention statement. Promised by T6 and previously unbudgeted. |
| Rollback/repair: orphan sweep job + deploy-ordering gate + label-version note (§11.7) | **1 d** | — |
| Project-deletion hook in `cron.delete.ts` + `deleteTelemetryForProjects` + T-21 | **1 d** | Call site is named; the clustered mutation-table path is the part that bites. |
| Integration harness + T-15, T-19, T-20, T-22, T-24, T-25, T-32 | **3–5 d** | **3 d if** P1 has already added a pinned gigapipe service to `.github/smoke/docker-compose.yml` and produced OTLP protobuf fixtures; **5 d if** this work-stream does both. ClickHouse itself is already there, which is why this is not the 6–8 d a from-zero harness would be. |
| **P4 total** | **28–34 d** (26–32 d if `patchFetch` is cut) | |
| §13.2 funnel half (P6) | 2 d | Needs a funnel picker and a `localStorage` preference; the query is a project-day scan. |
| §13.3 p99 by cohort (P6) | 3 d | Down from 4 d: reading `duration` off the gin table removes the `tempo_traces` join entirely. Still needs the `span_profile` F2 exception signed off. |
| §13.4 conversion/error overlay (P6) | 3 d | Depends on the metrics engine's zero-fill contract, not on the SQL. |
| §10.1 stored OTLP exemplars (P6) | 2 d | Gated on a customer asking. |
| Profile-erasure job (§11.6) | 2 d | Deferred to the phase that enables propagation by default or raises retention past ~30 d; until then, expiry *is* the erasure mechanism and the DPA note says so. |
| T3/T16 storage optimisation: OpenPanel-owned trace index + tag dictionary (P6) | not estimated | Needs its own sizing; §12 has the arithmetic that would justify it. |
| §14 service map | not estimated | Needs its own sizing. |

**What could make the whole thing bigger, in order of likelihood:** (1) the §6.0 decode
benchmark comes in above budget and the telemetry router has to move to `apps/worker` (+3–5 d);
(2) P1's protobuf codec slips, which blocks §6.3 entirely and every by-id test with it;
(3) Q3's load test says unfiltered search cannot hold p95, and the search UI has to require at
least one filter (+2 d of UX, and a product conversation); (4) the logs work-stream declines
T12 and §9's fallback has to be implemented and tested on their side.

---

## Appendix: review claims corrected or rejected

Everything else raised in review is fixed above. These are the ones where the reviewer was
wrong, or where the fix taken differs from the one proposed, recorded so nobody re-opens them.

* **"The only `resolveDateRange` in the repo is an MCP helper (`packages/mcp/src/tools/shared.ts:63`)."**
  False. `packages/db/src/services/date.service.ts:4` exports one and it is on the tRPC read
  path. The substantive point stands and is adopted — it truncates to `YYYY-MM-DD`, so the
  minute-granularity helper `getDatesFromRange(range, timezone)` (`:15`) is what `zTraceQuery`
  names — but the premise for it was wrong.
* **"The repo has no `@opentelemetry/sdk-trace-base` dependency to check against."** False.
  `pnpm-lock.yaml:6161` resolves `@opentelemetry/sdk-trace-base@1.30.1` transitively via
  `@hyperdx/node-opentelemetry`, whose declared peer range is `^1.30.1 || ^2.0.0`
  (`:8522, :8536`). That range is exactly why the processor must handle **both** the 1.x
  `parentSpanId` and the 2.x `parentSpanContext` shapes, which §11.3 does; the version is in
  T-22's canary list.
* **The suggested local-root guard `if (pc?.spanId && pc.isRemote === false) return;`** was not
  adopted as written: it contradicts the same reviewer's (correct) statement that the failure
  direction must be missing data rather than cardinality, because it *attaches* on an
  unreadable parent. §11.3's `isLocalRoot` attaches only on a positively-determined local root
  and returns `false` when the parent shape is unreadable.
* **"Cap §6.3 step 1 at `TRACE_MAX_SPANS + 1` and compare `span_id IN (unhex(…), …)`."**
  Superseded by something strictly better: §6.3 is now **one statement** with the ownership set
  as a CTE, so no id list is materialised, no `unhex` round trip is needed, no
  `max_query_size` limit is approached, and the authorisation check is still not `LIMIT`-able.
  The hex/`unhex` rule is nonetheless stated as an absolute in §6.1, because the next query
  someone adds may not have that luxury.
* **"Cut the erasure work entirely — expiry already erases."** Adopted for the *profile*
  erasure **job** (moved to the phase that enables propagation by default or raises retention),
  and the reasoning is written into §11.6. Not adopted for **project deletion**: that is a
  promise, not a deadline, and it stays in P4 with its cost stated. The SQL for both stays in
  this document so the deferred estimate is real.
* **"Filter `tagKeys` through `zTraceAttrFilter`'s regex so the bar only offers usable keys."**
  Inverted: the *validator* was widened to what the index can actually hold, because F4
  establishes that the traces path applies no `SanitizeKey` and real keys contain spaces, `/`,
  `:` and leading digits. Narrowing the suggestions instead would have hidden real keys from
  the user rather than fixing the mismatch. Both ends now use `TRACE_ATTR_KEY_RE`.
* **"`F3` — resource attributes win, so the payload contains the merged set."** Half right, and
  the half that is wrong is the dangerous half. `otlp.go:81` *appends*; only `attrsMap` merges.
  §6.5 rule 1 and test T-25 exist because of it.
* **Line-number corrections applied** to the gigapipe citations, all re-verified against source:
  `reader/controller/tempo.go:233-239` (the resource prefix list **and** the `resourceExact`
  set, both now reproduced in §8.5), `reader/controller/tempo.go:663-690` (the 5000-point
  auto-step), `writer/service/insert/tempo.go:90-93` and `:189-190` (the two `INSERT` column
  lists that omit `oid`), `.../traces_data.go:48-50` (`argMin`), and the full transpiler prefix
  `reader/traceql/traceql_transpiler/clickhouse_transpiler/`. T1 ground (a) was rewritten: the
  operands are intersected on `(trace_id, span_id, max_timestamp_ns)`, not on trace ids — it is
  the *final* assembly that is trace-scoped, which is the part that makes injection unsound.
