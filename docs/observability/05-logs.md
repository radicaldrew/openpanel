# Logs: ingest, query and explorer

`apps/api` accepts server-side logs on two protocols — OTLP/HTTP (`POST /telemetry/v1/logs`) and Loki push (`POST /telemetry/loki/api/v1/push`) — decodes them itself, and rewrites every record into **a small allowlisted label set plus a fixed JSON envelope**, stamping `op_project_id` from the authenticated telemetry client. It then pushes Loki JSON to gigapipe's `/loki/api/v1/push`. Reads go the other way: a structured `zLogQuery` is compiled server-side into LogQL carrying a mandatory `op_project_id="<uuid>"` matcher, executed against `/loki/api/v1/query_range`, and rendered by a virtualised explorer with a volume histogram, a selector builder that reuses the report editor's filter chrome, detected fields, context expansion and shareable URL state. Every procedure lives under `observability.logs.*` on the one `observabilityRouter`. gigapipe is never exposed, never handed a client header, and never given a user-authored LogQL string. Live tail, pattern grouping and saved queries are designed here and shipped in P6, not P3 — the minimum shippable slice is Loki JSON push + OTLP push + compiler + query + histogram + list + detail + URL state.

**Written against** `openpanel@247744a8` and the gigapipe working tree at `/Users/drew/projects/gigapipe` on 2026-08-29. Every file path and line number is one that was opened and re-verified during the review pass that produced this document. Anything that could not be read or executed is marked `UNVERIFIED:` together with the experiment that would settle it.

---

## Revision note — cross-document settlements absorbed in this pass

Five reviewers read all eleven specifications together. This revision settles every conflict
they found that touches logs. **Where a settlement changes something another document
depends on, it is listed here so the edit is not lost.** Nothing below is a private
preference; each line names the document that wins and why.

| # | Conflict | Settled as | What must change elsewhere |
|---|---|---|---|
| 1 | Log ingest topology: `02` forwards OTLP to gigapipe's `/v1/logs`; this document decodes it and pushes Loki JSON | **This document wins** (D1). Four of five reviewers verified the evidence independently: `otlplogs.go:22-58` folds resource + scope + record attributes *and* `trace_id`/`span_id` into the label set, and the OTLP path never calls `sanitizeLabels`. There is no configuration that disables it | `02` §1 drops `/telemetry/v1/logs` from its forwarding table and moves the OTLP-logs leg into P3.4 here; `02`'s "Explicitly not exposed" rationale becomes "we never forward *to* gigapipe's `/loki/api/v1/push` except from `pushLogs`"; `02`'s Interfaces guarantee about `type` is rewritten per row 2; `01` §4.4/§4.8's logs row and `11` E12–E15/E22–E24 retarget to `buildEnvelope` / `sanitizeAttrKey` / the label allowlist |
| 2 | `type ∈ {1,2}` was said to be safe "only because this gateway does not expose `/loki/api/v1/push`" | **The invariant is preserved, by a different mechanism.** `pushLogs` is the only writer of a Loki value tuple in the product and it emits **exactly two elements** — never index 2 — so `tp == 3 → 0` (`unmarshal.go:163-165`) is unreachable from customer traffic. New invariant **I12**, with a test | `02`'s Interfaces row and its not-exposed table; `08` S13 and `10` D10 may keep their type-0 totality argument, which is correct anyway and is now belt-and-braces rather than the only control |
| 3 | Conditional TTL written two ways, with type-0 on opposite windows | **`08` S13 / `10` §6.1 win**: `type != 1` / `type = 1`, total clauses, type-0 on the *metric* window, `metricDays >= logDays` asserted before emit. §7.3's DDL is deleted and replaced by a pointer | none — this document was the outlier |
| 4 | `samples_v3` pre-create DDL specified twice, with different partition-key column order | **`08` S6/S7 win** (`PARTITION BY (type, day)`, both `samples_v3` **and** `metrics_15s`). §7.1's DDL and its `gigapipe-bootstrap.test.ts` rows are deleted | none |
| 5 | Cloud topology: this document reasoned from `isClickhouseClustered()` | **`10` §5.2 wins**: Cloud runs **one non-clustered gigapipe against a dedicated ClickHouse node**. `isClickhouseClustered()` is *never* consulted for a gigapipe table (verified: `client.ts:83-95` returns true unless `SELF_HOSTED`, which says nothing about gigapipe). §7.1's Replicated branch is dead and is deleted | `08` S9's `getIsCluster()` skip must be re-derived — a dedicated node is not the analytics cluster |
| 6 | Four helpers for naming gigapipe tables, two exporting `TELEMETRY_TABLES` with different value shapes | **`08` S10/S11's `packages/db/src/clickhouse/telemetry-client.ts` is the single home** (it is the only lazy, memoised, single-node-pinned one, which DDL and mutations both require), extended with `06`'s read/mutate split and `TELEMETRY_IN`. `TELEMETRY_TABLES` values are **unqualified**; qualification is the helper's job. `packages/db/src/gigapipe/table-name.ts` is **deleted from this document** (D14, §7.2) | `04` D12 drops `G()` and `TELEMETRY_DB`; `06` §5 drops its duplicate; `08` renames `telemetryDatabase()`'s source to `GIGAPIPE_DB` |
| 7 | `getReplicatedTableName` mandated on the gigapipe erasure path by `11` I14 | **This document was right and `11` is repeating a stale draft.** Verified: `getReplicatedTableName` (`packages/db/src/clickhouse/client.ts:100-106`) returns `` `${t}_replicated ON CLUSTER '{cluster}'` ``; gigapipe has no `_replicated` tables (`ctrl/qryn/sql/log_dist.sql`) | `11` I14 and gate 1.9: replace the `getReplicatedTableName` clause with "every gigapipe mutation target goes through the shared telemetry table helper, and no emitted statement contains `_replicated`" |
| 8 | Three project-deletion designs | **`08` §14 wins**: `deleteTelemetryFromClickhouse(projectIds)`, called *inside* `deleteFromClickhouse`, non-throwing, `TelemetryErasure` ledger. `purgeTelemetry` and `model TelemetryPurgeJob` are **deleted from this document** (§7.4); the resumability idea is handed to `08` as a request | `06` §11.6 folds into the same function; `09` §14 and `11` I13/I14 use the one name; `11` I13 drops `tempo_traces_kv` (`06` §11.6 and `08` §14 both say it is deliberately never deleted from) |
| 9 | Three telemetry-metering Prisma models | **`08`'s `TelemetryUsageDaily` wins, with `10`'s field list.** `model TelemetryUsage`, `TelemetrySignal` and `TelemetryGranularity` are **deleted from this document**; the logs meter writes `10` §8.2's Redis keys and `10`'s daily rollup owns Postgres | `08` replaces `TelemetryUsageDaily`'s field list with `10` §8.3's and states the key once |
| 10 | Five retention numbers | **`10` owns retention.** `PLAN_DEFAULT_RETENTION_DAYS = 30` is deleted; the logs window is read from `10`'s per-signal constant (14 d cloud v1). Per-project log retention is **cut from v1** per `10` D9 ("one window per signal for everyone") | `10` renames its object export so one name is not both a scalar env var and a record; `04` replaces `GIGAPIPE_RETENTION_DAYS` with per-signal values |
| 11 | `ADVANCED_OMIT_EMPTY_VALUES` pinned `false` here and `true` in `01` §3.1 | **`01` wins**, `true`. I2's *rule* survives, re-justified from I3's `analyzeStreamSelect` path exactly as `01` proposes. The one-line edit is made below | `10` §3's env table must actually contain the variable — today it contains neither this nor `LOG_DRILLDOWN`'s justification |
| 12 | `LOG_DRILLDOWN` required on here, shipped off in `10`, and its routes blocked outright by `01` D9 / `04` D3 | **`01`/`04`/`10` win**: `LOG_DRILLDOWN=false`. D8 is rewritten. Label discovery and the volume snapshot move to `04` §9's direct-ClickHouse metadata service | `01` §7.6 and `04` §4.1 already exclude the four routes; no change needed there |
| 13 | tRPC router namespace | **`observability.logs.*` on one `observabilityRouter`**, base procedure `protectedProcedure.use(rejectShareId)` per `04` D13, plus the kill-switch check. `logsRouter` is folded in | `03`, `06`, `09`, `11` sweep their paths in one PR; `09` Q1 closes |
| 14 | Five names for gigapipe's base URL and credentials | **`GIGAPIPE_URL`, `GIGAPIPE_USER`, `GIGAPIPE_PASSWORD`, `GIGAPIPE_DB`, `GIGAPIPE_CLUSTER`** on the OpenPanel side; **`CLOKI_LOGIN`/`CLOKI_PASSWORD`** on the container (verified: `CLOKI_*` is assigned after `QRYN_*` in `portEnv`, `cmd/gigapipe/main.go:172-183`, so it wins). `GIGAPIPE_READ_URL`/`GIGAPIPE_WRITE_URL` are **deleted from this document** | `02` §15 (`GIGAPIPE_INTERNAL_URL`, `GIGAPIPE_LOGIN`), `04` §3 (`GIGAPIPE_USERNAME`, `TELEMETRY_CLICKHOUSE_DATABASE`, `GIGAPIPE_CLUSTER_NAME`), `11` gate 1.7 |
| 15 | Five kill switches | **`telemetry:disabled:*` / `telemetry:disabled:{projectId}` (`02` §4, written by `10` §10.3) for ingest, plus a read-side sibling per `04` D15's split.** Mandatory TTL on the per-project key, none on the global one. Unsetting `GIGAPIPE_URL` is the *deployment* switch, not the brake | `01` §11 and `06` §15 delete their variants; `04` D15 renames `op:gp:off*` into the `telemetry:disabled:*` namespace; `10` documents the one namespace in the runbook |
| 16 | Four HTTP statuses for a blocked ingest | **`02` owns it.** 403 for wind-down (`02` §4 + `10` D15 already agree), 503 + `Retry-After` for the operator kill switch (`02` §4 + `10` §10.3 already agree), 404 when telemetry is not installed on this deployment (`01` §11 already says the routes are not registered). §4.3's `200 partialSuccess` / `204 X-OP-Blocked` are **deleted** | `11` A15's 429 is the outlier and must change; `06` §4.1's 202-and-drop must change |
| 17 | Four telemetry auth-cache designs | **`01` §6.1 wins**: key `telemetry:auth:${clientId}` alone, `{hash, digest}` in the value, re-verify on any mismatch, TTL **60 s**, `clearTelemetryAuth(clientId)`. §4.2's 5-minute digest-in-key is **deleted**, and so is the 5-minute revocation SLA | `02` §2.2 adopts the same shape; `11` A18 publishes 60 s; `11` A17's `client:authv2:` migration of the *shared* `validateSdkRequest` cache still needs a named owner |
| 18 | Request body limits specified four ways | **`02` §15 owns them.** `OTLP_MAX_BODY` is **deleted**; the routes cite `TELEMETRY_MAX_COMPRESSED_BYTES` / `TELEMETRY_MAX_DECOMPRESSED_BYTES`. The 4 MiB that remains here is the *outbound* sub-batch size to gigapipe, which is a different number | `11` E29 asserts against `02`'s configured value, not gigapipe's 64 MiB ceiling |
| 19 | Rate limiting | **`02` D11 §9.1 wins.** `activateRateLimiter` is **deleted** from §4.1: its fallback prefers the public `openpanel-client-id` header over the trusted IP (verified, `apps/api/src/utils/rate-limiter.ts:31-42`), so header rotation mints unlimited buckets *before* auth | none — this document was the outlier |
| 20 | Where the shared code lives | **`packages/gigapipe`** per `04` D1 for the compilers, envelope, severity and transport; **`apps/api/src/telemetry/`** per `02` D9 for the OTLP decode and the vendored protos; **`packages/db/src/clickhouse/telemetry-client.ts`** for everything that speaks ClickHouse. Every path in this document is rewritten. Open question 8 closes | `04` D1's own layer table should drop its `src/ingest/*.ts` and `vendor/` rows in favour of `02` D9 |
| 21 | Live tail phase | **This document's D5 wins** (Follow toggle in P3, WS tail in P6), with `04` §10.1's periodic re-authorisation *and* its 30-minute hard socket lifetime folded into §9 | `04` D6/D7 remove the 1.0 w P3 tail row, or overrule D5 explicitly |
| 22 | CORS | **This document's D11 wins** — verified again this pass at `apps/api/src/app.ts:109-125` | `02` D16 is rewritten (membership in `corsPaths` is *permissive-for-the-dashboard*, not a deny); `01` §6's citation of D16 as a control is corrected |
| 23 | Capability/status surface | **`04` §6.5's `observability.status` is the one procedure**, extended with `09`'s `blocked`. This document's `telemetryEnabled` app-context flag derives from it rather than being a second boolean | `09` rewrites `telemetry.capabilities` to `observability.status` and drops `patterns` (D8 turns the flag off); `06` §15 flips `signals.traces` on the same procedure |
| 24 | Cron inventory | This document now registers **one** cron (`telemetryReconcile`, `45 3 * * *`). `telemetryUsage` and `telemetryRetention` are **deleted** — `10` §6.2 owns both names | `00-blueprint.md` should carry the single cron inventory that `11` §7.2 asserts against |
| 25 | ClickHouse settings profile phasing | **Split, and both halves keep their phase.** The `<profiles>` block lands in the tracked `self-hosting/clickhouse/clickhouse-user-config.xml` at **P0**, applied to the user gigapipe actually connects as (`default` in v1). The dedicated `op_gigapipe` user with scoped grants stays at **P7** where `10` D16 puts it. §7.5 is rewritten to that split | `08` S16 and `10` D16 point at the one decision instead of restating it |

Two findings are **rejected** rather than absorbed; both are argued where they arise:
`06` T12 (zero `LogRecord.SpanId`) is unnecessary under D1 and is declined (§3.2), and
`11` I14's `getReplicatedTableName` requirement is declined (row 7 above).

---

## Decisions

### D1 — apps/api decodes OTLP itself and pushes Loki JSON. It never forwards OTLP to gigapipe.

*Rejected:* rewrite the OTLP protobuf's resource attributes and forward the body to `gigapipe:/v1/logs`.

gigapipe's OTLP log decoder turns **every** attribute — resource, scope and record — into a *stream label*, and adds `trace_id` and `span_id` as labels on top (`writer/utils/unmarshal/otlplogs.go:22-58`). The fingerprint is computed over the whole surviving label set (`writer/utils/unmarshal/builder.go:351`, `unmarshal.go:250-270`), so one trace id is one new fingerprint, which is one `time_series` row per stream per day and one `time_series_gin` row **per label** per stream per day. At 10k lines/s with trace context that is ~10k new series/s. There is no configuration that disables it.

Second reason: the OTLP path never calls `sanitizeLabels`. `sanitizeLabels` — which truncates a label value to 100 bytes — is called only from the Loki-JSON decoder (`unmarshal.go:103,117`), Influx (`influx.go:73`), the Loki protobuf decoder (`logs_protobuf.go:24`) and Prometheus remote-write (`metrics_protobuf.go:32`). A 4 KB OTLP attribute value becomes a 4 KB label value, and the OTLP path uses a *different* key sanitiser (`SanitizeKey`, `otlplogs.go:107-117`) than the Loki path (`sanitizeRe`, `unmarshal.go:272`) — they disagree for any key starting with a digit.

Third reason: `/v1/logs` registers a single `withSimpleParser("*", …)` resolving to `UnmarshalOTLPLogsV2` (`writer/controller/insert.go:146-158`), which is protobuf-only. There is no protojson branch, so forwarding would mean re-**encoding** protobuf outbound as well as decoding it inbound. Loki JSON is a plain `JSON.stringify`.

**This overrides `02-ingest-gateway.md` §1, and the consequence for the schema work-stream is stated rather than assumed.** `02` forwards `POST /telemetry/v1/logs` to gigapipe's `/v1/logs` and lists `/loki/api/v1/push` as "explicitly not exposed", telling `08-schema-changes.md` that `type ∈ {1,2}` is safe *because that route does not exist*. Under D1 the premise is gone but **the invariant is not**: `pushLogs` (§4.5) is the only writer of a Loki value tuple anywhere in the product, and it emits a two-element tuple — `["<ns>","<envelope>"]` — always. gigapipe's `tp == 3 → 0` collapse (`unmarshal.go:163-165`, `:225-227`) fires only when index 2 parses as a number, and there is no index 2. That is **invariant I12** below, with a test, and it is a strictly stronger control than a route not existing, because a route not existing is one PR away from being wrong while a shape assertion in the writer is not.

`02`'s P1 route table therefore drops `/telemetry/v1/logs`, and the OTLP-logs decode moves into P3.4 of this document where it already is. `02` keeps `/telemetry/v1/metrics`, `/telemetry/v1/traces` and `/telemetry/api/v1/write`, all of which really are forwards. The sequencing consequence the reviewers raised — that opening a logs route in P1 while its shaping rules are specified in P3 writes unrepairable rows — is resolved the same way: **P1 opens no logs route at all.**

### D2 — the stored line is a fixed JSON envelope, not the raw body

*Rejected:* raw body plus Loki "structured metadata".

gigapipe has no structured metadata. The Loki push value tuple is read positionally: index 0 is the ns string, index 1 the line (sets `SAMPLE_TYPE_LOG`), index 2 is read as a `float64` and skipped when it is not a number (`unmarshal.go:139-161`). There is nowhere for per-line fields to live except labels (a cardinality bomb) or the line itself. We put them in the line, in a shape we control and can index into with LogQL's JSON parser.

### D3 — labels are a closed allowlist plus at most five project-promoted keys

*Rejected:* "let the customer send whatever labels they like."

Every distinct label *value combination* is a new fingerprint. There is no ClickHouse-side backstop, no per-tenant series limit anywhere in gigapipe, and `time_series_gin` costs one row per label per stream per day. An accidental `request_id` label is an outage for every tenant on the shared instance.

### D4 — the query surface is a structured `zLogQuery` compiled to LogQL server-side; raw LogQL is not exposed

*Rejected:* raw LogQL passthrough, even read-only, even behind a feature flag.

The metrics work-stream can lean on a real JS parser (`@prometheus-io/lezer-promql`). **LogQL has no published JS grammar.** gigapipe's is a Go `participle` struct set (`reader/logql/logql_parser/model.go`), usable only in-process. Writing a second LogQL parser in TypeScript and keeping it in lockstep with gigapipe's is exactly the string-concatenation risk the parent plan's decision 3 exists to prevent, and the failure mode is invariant **I3** below: a selector whose matchers are all `=~".*"` reads *every project's* logs (`clickhouse_planner/analyze.go:74-87`, `planner_fingerprint_filter.go:17-19`).

Because D4 makes the compiler the only writer of LogQL, **every value the compiler interpolates must be constrained by the schema, not by the compiler's escaping**. The numeric label-filter form is the case that bit the draft: gigapipe's grammar for an unquoted numeric value is `NumVal string \`| @(Integer "."? Integer*)\`` (`reader/logql/logql_parser/model.go:249-254`) — no sign, no exponent, no arbitrary text. See §"Query schema" for the `superRefine` that enforces it.

If raw LogQL is ever wanted, the correct place is inside `StreamSelectPlanner` in a gigapipe fork — which is an AGPL §13 publication obligation. P6+ at the earliest.

### D5 — live tail is a WebSocket poller owned by apps/api, and it ships in P6, not P3

*Rejected (a):* proxying gigapipe's `/loki/api/v1/tail`. Three disqualifying properties:

1. **`dropped_entries` is a hard-coded empty array on every frame** (`reader/service/query_range.go:793-795`). It is a lie, not an unimplemented feature: a client that trusts it believes no data was lost.
2. **It silently drops data above its per-tick limit.** The poll runs `OrderASC: false` with `Limit: min(tailIncrementalLimit=1000, tailLimit)` over `[from, now]` (`query_range.go:718-735`; `tailIncrementalLimit` at `:26`), then advances `from` to `max(timestamp)+1` (`:783`). Anything in the window that was *not* in the newest N is skipped forever. The default `tailLimit` is **100** (`reader/controller/query_range.go:17`), so out of the box a stream above 100 lines/s loses most of its lines with no signal.
3. **One goroutine and one `SELECT` per second per viewer**, against a reader connection that sets no ClickHouse limits at all (I10).

*Rejected (b) for the successor, accepted for P3:* a `refetchInterval` on the newest-page `useInfiniteQuery`. Reviewer 3 is right that this is the honest v1. With zero logs customers at P3, a 5-second poll of the newest page gets most of the deploy-watching UX for roughly zero incremental design, and the bespoke tail — a WS controller, a per-socket poller, a lag accountant, a `bufferedAmount` backpressure gate, three env caps, a four-variant frame union, a `count_over_time` per lag event, a 2000-line client ring with multiset dedupe, **and a change to the shared `useWS` hook** — is a scaling answer to a load nobody has yet.

**Chosen for P3:** a *Follow* toggle that sets `refetchInterval: 5000` on the newest page and pins the range to `range: 'lastHour'` with `direction: 'backward'`. **Chosen for P6:** the design in §"Live tail (P6)", kept in this document because D5's analysis of gigapipe's tail is correct and worth recording, and because two of its mechanisms (the second-granular cursor, the counted `dropped` frame) are the non-obvious parts.

**This is the surviving tail design; `04-read-path.md` D6 specifies a second one in P3.** Two bespoke tails must not both exist. D5 wins on phasing — a bespoke WS tail is a scaling answer to a load nobody has at P3 — and `04`'s P3 effort table should lose its 1.0 w tail row. What `04` D6 has that this design lacked is kept: §9 now carries **both** the periodic re-authorisation (`04` §10.1) *and* the **30-minute hard socket lifetime**, because a stream carrying stack traces and `attr.user_id` must not outlive a session boundary. If `04`'s owner would rather overrule D5, that is a legitimate call — but it must be made explicitly and one of the two designs deleted.

One argument the parent plan's earlier draft made against an apps/api-owned tail does **not** hold and should not be repeated: `wsProjectEvents` fans out through Redis pub/sub (`apps/api/src/controllers/live.controller.ts:83-93`) because the event *buffer* is per-process state that one replica cannot see from another. A log tail reads shared ClickHouse through gigapipe, so any replica can serve any tail with no cross-replica coordination. The real constraint is cost per socket.

### D6 — saved log queries are a `SavedLogQuery` Prisma model, shipped in P6; URL state ships in P3

*Rejected for P3:* building the model now. Reviewer 3 is right that D6's case against URL-only ("it cannot be listed, it cannot be pinned to a project") is true and not P3-blocking — a URL in a runbook covers the incident-review use case. The real cost is not the "~150 lines" the draft claimed: a Prisma model and a coordinated migration, a typed-`Json` entry in the bespoke `packages/db/prisma/prisma-json-types.ts` post-processor, four tRPC procedures with two different access-resolution paths, mandatory re-validation-on-read with a `valid:false` UI state and an Edit-not-Run affordance, a combobox, a modal registered in `apps/start/src/modals/index.tsx`, and two test rows.

`Cohort` (`packages/db/prisma/schema.prisma:306-322`) is the precedent, and it proves this is exactly as cheap to add in P6 as in P3. The design is retained in §"Saved queries (P6)" because the re-validation-on-read rule is the load-bearing part and would otherwise be rediscovered.

### D7 — `detected_fields` is computed by OpenPanel; we never call gigapipe's endpoint

gigapipe's `/loki/api/v1/detected_fields` handler writes `{"fields":[]}` and returns — it does not touch the database or read the query (`reader/controller/volume.go:116-128`). It is a stub.

**Partially rejecting reviewer 3's proposal to defer the detected-fields panel to P6.** The panel is one extra `logs.query` call at `limit: 500` parsed through code that already exists for the list, and it is what makes the field-filter UI usable at all — without it a user must know the envelope's `attr` keys by heart before they can filter on one. It stays in P3 at 0.4 w. What *is* deferred with it is nothing; the pattern panel (D8) is the expensive neighbour and that one goes.

### D8 — `LOG_DRILLDOWN=false` in every deployment; label discovery comes from ClickHouse, and pattern grouping is deferred to P6

*Revised.* The previous position was `LOG_DRILLDOWN=true` everywhere, on the grounds that the selector builder's cardinality hints and the settings card need `/detected_labels` and `/index/volume`. Three other documents make that unreachable, and they are right:

- `10-ops-retention-billing.md` §3 sets `LOG_DRILLDOWN=false` — "cost with no consumer".
- `01-tenancy-and-security.md` D9 blocks `/loki/api/v1/index/volume`, `/detected_labels`, `/detected_fields` and `/patterns` from the client outright, and its test T1.18 asserts `index/volume` is unreachable.
- `04-read-path.md` D3 removes the label/series proxy routes from `GIGAPIPE_ROUTES` entirely and replaces them with **direct ClickHouse queries** (`04` §9), because gigapipe's label endpoints `break` out of their scan loop on error and still return `{"status":"success"}` (`reader/service/query_abels.go:62,67`), hardcode `Limit: 10000` (`:220,:292`), and `panic` on a rejected `match[]` (`:165`).

`01`'s injection argument is decisive and this document's own I6 independently confirms it: `QueryVolume` string-interpolates `targetLabels` into `fmt.Sprintf("sum(bytes_over_time(%s [%dms])) by (%s)", …)` and re-parses the result (`reader/service/query_range.go:166-177`), so a `targetLabels` element is a cross-tenant read primitive. A validator is a fine second line of defence and a poor first one.

**Chosen:** `LOG_DRILLDOWN=false`; none of the four routes is in the client's allowlist. What this document needed from them is served from ClickHouse instead, through `04` §9's metadata service:

| Was | Now |
|---|---|
| `GET /loki/api/v1/detected_labels` → `{label, cardinality}` for the selector builder | `SELECT` over `gigapipe.time_series.labels` scoped by `fingerprint IN (<gin CTE keyed on op_project_id>)` — `time_series`' sort key **is** `fingerprint` (`log.sql:115-117`), which is why `04` §9.2 reads label keys from there rather than from `time_series_gin` |
| `GET /loki/api/v1/label/{name}/values` | the same seek, projecting one key's values |
| `GET /loki/api/v1/index/volume?targetLabels=…` for the settings card's top-10 by bytes | a daily `GROUP BY fingerprint` over `samples_v3` in `cron.telemetry-reconcile.ts`, joined to `time_series.labels`, stored as a Postgres snapshot (§8.3) |

`GET /loki/api/v1/index/stats` is **kept** — it is in `04`'s `GIGAPIPE_ROUTES` with `query` declared selector-bearing and mandatory, which is exactly I8.

I6 is retained below as a recorded rationale, not as a shipping requirement: if anyone ever re-enables `LOG_DRILLDOWN`, the validator is the minimum price of admission.

**Pattern grouping is deferred to P6 for the reason it always was, and the reason is now stronger.** gigapipe's clusterer has no tenant dimension — `LogClusterer.getOrCreate` keys the process-global cluster map on `id.FirstToken.Value` (`writer/pattern/clustering/pattern.go:345-355`) and `flush` copies the cluster's whole generalised token array onto every sample (`pattern.go:211-230`). The *read* is fingerprint-scoped (`clickhouse_planner/planner_patterns.go:30-36`), so project B never sees project A's counts, but the pattern *text* B reads back may contain a literal token that only project A ever emitted. That is a text leak. With `LOG_DRILLDOWN=false` the read endpoint is not even registered, so the feature is off by construction rather than by policy. Deferring it also removes `matchesPattern` from `zLogLineFilter`, which shrinks the compiler and its escaping test surface. `09-ui-surfaces.md` should drop `patterns` from its capability shape accordingly.

**What is not deferrable, and what the draft missed:** the pattern *writer* runs unconditionally. `IngestParsed` calls `doLogsPattern(response.SamplesRequest)` for every samples request with no config gate (`writer/controller/builder.go:221-223`, `:247-249`), and the only `LOG_PATTERN_*` env vars are similarity and read limit (`cmd/gigapipe/main.go:252-263`). So `checkMatch` takes an RLock and iterates every cluster sharing a first token for **every line we push**, on a map that is process-global across tenants. That is an ungateable per-line ingest cost and a cross-tenant coupling: one project with high log-shape diversity measurably slows every other project's ingest. `LOG_DRILLDOWN=false` does **not** turn it off. It is in the cost model and in the operator alerts, and it is the first thing to measure in the §8.1 load test.

### D9 — exact-path allowlist outbound; no client header is ever forwarded

`X-CH-DSN`, `X-Scope-Meta` and `X-Ttl-Days` are read off the request by gigapipe's writer middleware (`writer/controller/middleware.go:164-175`). We construct every gigapipe request from scratch and forward nothing; a regression test asserts their absence. `X-Ttl-Days` is parsed into `MTTLDays` and consumed by no insert statement — do not build retention on it.

**The outbound allowlist is short, and it got shorter.** After D8 and `04` D3 the only gigapipe read paths this work-stream uses are `/loki/api/v1/query_range`, `/loki/api/v1/query` and `/loki/api/v1/index/stats`. `/loki/api/v1/labels` is **never** proxied: the controller calls the service with a nil match set, so it enumerates every label name in the database across all tenants (I7). `/loki/api/v1/label/{name}/values` is no longer proxied either — `04` D3 removes it from `GIGAPIPE_ROUTES` and §9 answers from ClickHouse — but its zero-match hazard is recorded because it is the same failure by a different door: `QueryLabelsService.Values` falls through to `clickhouse_planner.NewValuesPlanner(nil, label, nil)` when `len(match) == 0` (`reader/service/query_abels.go:200-209`). I5 survives as a rule on any future proxied label call: exactly one `match[]`, and **throw** on an empty list rather than sending the request.

### D10 — line identity is content-derived with multiplicity

gigapipe returns no row identity. The streams payload is `[ts, line]` pairs, grouped by fingerprint. Neither `timestampNs` nor `${streamHash}:${timestampNs}` is unique: pino and most OTLP SDKs carry millisecond clock resolution, so several records per stream per millisecond is the normal case. Using such a key for React rendering, cross-page dedupe or a tail ring would **drop real log lines**. §"Line identity and pagination" specifies a content key plus an occurrence counter, and multiset (not set) dedupe.

### D11 — `/telemetry/*` is explicitly CORS-denied, and the reason is the opposite of what the draft said

*Rejected:* omitting `/telemetry` from `corsPaths` and calling that a browser block.

The draft asserted that omitting the prefix made the route unreachable from a browser. That is inverted. `apps/api/src/app.ts:109-125` treats membership in `corsPaths` as the **restricted** case — a private path is pinned to `dashboardOrigins` with credentials — and everything else falls through to:

```ts
return callback(null, { origin: '*', maxAge: 86_400 * 7 });
```

So omitting `/telemetry` would make it **maximally open to browsers**, exactly like `/track`, which is how the web SDK works. Documenting a protection that does not exist, on the one route whose credential is the sole source of truth for the injected `op_project_id`, is the worst of both worlds.

**Chosen:** an explicit third branch. `/telemetry` is a *denied* path, not a private one and not a default one:

```ts
const corsPaths = ['/trpc', '/live', '/webhook', '/oauth', '/misc', '/ai'];
const corsDeniedPaths = ['/telemetry'];

fastify.register(cors, () => (req, callback) => {
  if (corsDeniedPaths.some((p) => req.url.startsWith(p))) {
    // Telemetry credentials are server-side ingest secrets. A browser exporter
    // would put one in a bundle; the cardinality and volume model does not
    // assume browser-originated logs. Preflight fails outright.
    return callback(null, { origin: false });
  }
  if (corsPaths.some((p) => req.url.startsWith(p))) { /* unchanged */ }
  return callback(null, { origin: '*', maxAge: 86_400 * 7 });
});
```

A router test asserts that an `OPTIONS /telemetry/v1/logs` carrying an arbitrary `Origin` is rejected. Server agents send no `Origin` and are unaffected.

**Two documents depend on the mechanism this replaces.** `02-ingest-gateway.md` D16 says `/telemetry` is added to `corsPaths` "so a browser cannot reach it cross-origin", and `01-tenancy-and-security.md` §6 cites D16 as a settled control. Both are wrong in the same direction, and the code was re-read this pass to be sure: `apps/api/src/app.ts:109-125`, `const corsPaths = ['/trpc','/live','/webhook','/oauth','/misc','/ai']`, and a matching path returns `{ origin: isAllowed ? origin : false, credentials: true }` while everything else falls through to `{ origin: '*' }`. Adding `/telemetry` to `corsPaths` makes the dashboard origin an *allowed* credentialed cross-origin caller. `02` D16 must be rewritten to say membership is permissive-for-the-dashboard, and `01` §6's reference corrected to point here.

### D12 — telemetry is a capability, read from `observability.status`, and off when gigapipe is not installed

*Rejected:* unconditional routes and an unconditional sidebar entry. *Also rejected (revised):* a second, logs-local `telemetryEnabled` boolean derived from a logs-local env var.

Open question 11 concedes that the generated `docker-compose.yml` is gitignored and the update script runs `--remove-orphans`, so `op-gigapipe` reaches no existing self-hosted install by itself. An unconditional Logs tab therefore ships **broken** to every existing self-hoster who updates: a sidebar link where every procedure fails with a connection error, and `/telemetry/*` routes that 500. "gigapipe was never installed" is a far more common state than "gigapipe crash-loops", and the draft's failure table only covered the latter.

**Chosen: one procedure, one predicate, one env var.**

- The predicate is `isTelemetryEnabled()` = `!!process.env.GIGAPIPE_URL`, defined once in `packages/db/src/clickhouse/telemetry-client.ts` (`08` S10) and read by everything. The earlier `GIGAPIPE_READ_URL` / `GIGAPIPE_WRITE_URL` split is **deleted**: no other document has a consumer for two URLs, and `10-ops-retention-billing.md` §3.1 writes `GIGAPIPE_URL` into `.env.template`, `coolify.yml` and `quiz.ts`, which is where a name becomes real.
- The user-facing surface is **`observability.status`** (`04-read-path.md` §6.5), which already returns `{enabled, reachable, schemaReady, hasData, signals:{metrics,logs,traces}, retentionDays, oldestQueryableAt, database, clustered, version, degraded}` and which `04` D10 guarantees never throws for an authorized caller. `09-ui-surfaces.md`'s `telemetry.capabilities` is the same thing under a second name and must be rewritten to this one; it contributes one field that `04` genuinely lacks and needs — **`blocked`**, for the wind-down banner — and one that D8 removes, `patterns`.
- The app-context `telemetryEnabled` flag that gates the `/logs` route and its `SidebarLink` **derives from `observability.status.enabled && signals.logs`**, not from a second server boolean. One source of truth, one place to be wrong.
- `/telemetry/*` routes are **not registered at all** when `isTelemetryEnabled()` is false, which is `01-tenancy-and-security.md` §11's position and produces an honest 404 rather than a synthesised one.

**`GIGAPIPE_URL` is the deployment switch, not the brake.** Unsetting it needs an `.env` edit and a restart of every `op-api` and `op-worker` replica. The ten-second lever is the Redis kill switch (§4.3), which is `02-ingest-gateway.md` §4's `telemetry:disabled:*` namespace with `04` D15's read/ingest split — one namespace, documented in `10`'s runbook, not the five variants the doc set currently carries.

### D13 — transport failures are 503, never OTLP `partialSuccess`

*Rejected:* the draft's `partialSuccess.rejectedLogRecords = <records in sub-batches that failed after retries>`.

That is backwards under the OTLP/HTTP contract. `partialSuccess` means the server **permanently** rejected those records; a conforming exporter logs a warning and drops them. It does not retry. So as drafted, a 30-second gigapipe blip destroys customer log data behind a `200 OK`. The Loki route had the mirror bug — `204` on a partial write reads as full success to a Loki client.

**Chosen:** two counters that never mix.

- `rejectedInvalid` — records **we** rejected as malformed: no body, timestamp outside `[now − 7 d, now + 1 h]`, envelope over the hard cap. These are permanent and go in `partialSuccess.rejectedLogRecords`.
- `failedTransport` — sub-batches that failed after retries for any transport reason. If `failedTransport > 0`, **both** routes return `503` with `Retry-After: 5`, regardless of how many other sub-batches succeeded. The resulting duplicates are already covered by the at-least-once statement.

**A *blocked* ingest is a different thing and gets a different status; see D16.** The draft answered a wind-down block with `200 partialSuccess` on OTLP and `204 X-OP-Blocked` on Loki, which makes a blocked organization look healthy to its collector — the exact failure this decision otherwise argues against.

### D14 — one home per concern: `packages/gigapipe`, `apps/api/src/telemetry/`, `packages/db/src/clickhouse/telemetry-client.ts`

*Revised.* Every file path in this document used to be under `packages/db/src/gigapipe/`, and open question 8 left the choice open. `04-read-path.md` D1 closed it and asked for the rewrite; this is the rewrite.

| Concern | Home | Why |
|---|---|---|
| LogQL compiler, envelope, severity, response parsing, HTTP transport, route allowlist, kill switch | **`packages/gigapipe/src/…`** (`04` D1) | `packages/db` is imported by `apps/api`, `apps/worker`, `packages/trpc`, `packages/mcp` and the importer. `04` D1's dependency-direction argument is decisive, and so is its totality argument: "there is exactly one function in the system that emits a `{`" is CODEOWNER-able at package granularity and is not inside a 40-file `packages/db`. |
| OTLP decode, the vendored `opentelemetry-proto` tree, `logproto.proto`, the Fastify routes and hooks | **`apps/api/src/telemetry/`** (`02` D9) | `04` D1's own layer table puts ingest codecs inside `packages/gigapipe`, but `02` D9 argues the alternative at length and is the better-argued of the two: one directory in `apps/api`, one Prisma seam in `deps.ts`, so a later lift-out is a `git mv`. It also keeps `protobufjs` and `long` out of `packages/gigapipe`'s dependents. `04` D1's `src/ingest/*.ts` and `vendor/` rows should be dropped. |
| gigapipe table names, database resolution, the ClickHouse client, `isTelemetryEnabled()` | **`packages/db/src/clickhouse/telemetry-client.ts`** (`08` S10/S11) | It is the only one of the four competing helpers that is lazy, memoised and pins a single node — both of which the DDL and mutation paths require. `packages/db/src/gigapipe/table-name.ts` is deleted from this document (§7.2). |

`TELEMETRY_TABLES`' values are **unqualified** (`samples: 'samples_v3'`), and qualification is the helper's job, so a caller cannot double-qualify. The database comes from `GIGAPIPE_DB`; `CLICKHOUSE_TELEMETRY_DB` and `CLICKHOUSE_TELEMETRY_URL` survive only as explicit aliases if `08` wants a separate ClickHouse endpoint for Cloud. **`isClickhouseClustered()` is never consulted for a gigapipe table** — `04` D12's warning is correct and was re-verified this pass (`packages/db/src/clickhouse/client.ts:83-95` returns `true` unless `SELF_HOSTED` is set, which says nothing about gigapipe's `CLUSTER_NAME`); the gigapipe-side predicate is `!!process.env.GIGAPIPE_CLUSTER`.

### D15 — logs defines no purge routine, no retention cron, no usage model and no TTL statement

*Revised.* The draft defined `purgeTelemetry`, `model TelemetryPurgeJob`, `model TelemetryUsage`, three crons and a conditional-TTL `ALTER`. Every one of those is defined in at least one other document, and in three cases the two definitions were semantically opposite. Owning something twice is worse than owning it nowhere, because the second owner writes tests that pass against a function nobody ships.

| Thing | Owner | This document's role |
|---|---|---|
| Project-deletion erasure | `08` §14 — `deleteTelemetryFromClickhouse(projectIds)`, called *inside* `deleteFromClickhouse`, non-throwing, `TelemetryErasure` ledger | consume; contribute the resumability requirement (§7.4) |
| Per-signal TTL | `08` S12/S13, re-asserted by `10` §6.2's `telemetryRetention` cron | consume; contribute the `SAMPLES_DAYS`-immutability rule (§7.3) |
| Retention windows | `10` §6.1 | consume the logs window for the query clamp (§5.1) |
| Metering | `10` §8.2 (Redis contract) + `10` §8.3 (daily rollup) into `08`'s `TelemetryUsageDaily` | write the Redis keys after a successful push (§4.6) |
| Quota shedding and the volume block | `10` §9 | consume `isIngestionBlocked` (§4.3) |
| The gigapipe table helper | `08` S10/S11 | consume (D14) |

What this document still owns end to end: the ingest routes and their decode, the envelope and label model, the LogQL compiler and its invariants, the read path and its cursor, the explorer, and one cron (`telemetryReconcile`) that produces the settings card's daily snapshot.

### D16 — a blocked ingest is 403 (wind-down), 503 (kill switch) or 404 (not installed); never a 2xx

*Rejected:* the draft's `200 {"partialSuccess":…}` for OTLP and `204` + `X-OP-Blocked` for Loki.

Four documents specified four statuses for one event. `02-ingest-gateway.md` owns the gateway's error semantics, and two pairs of documents already agree with each other:

| Cause | Status | Agreed by |
|---|---|---|
| Organization in `windDownStep ∈ {blocked, final_warning}` | **403** with a `google.rpc.Status` body on OTLP and a plain-text body on Loki | `02` §4 and `10` D15. OTel exporters treat 403 as permanent and stop retrying, which is right: the block clears when the customer acts, not when the exporter backs off |
| Operator kill switch (`telemetry:disabled:*` or `telemetry:disabled:{projectId}`) | **503** + `Retry-After: 900` | `02` §4 and `10` §10.3. Recoverable, so exporters must back off rather than drop |
| Telemetry not installed on this deployment (`GIGAPIPE_URL` unset) | **404** | `01` §11 — the routes are not registered at all, so this is not a synthesised status |

`11-testing-strategy.md` A15's **429 + `Retry-After`** is the outlier and must change; so must `06-traces-and-correlation.md` §4.1 step 0's 202-and-drop, which copies `/track`'s semantics onto a protocol that reads 2xx as "delivered, drop it". The reasoning against 429 is not that it is indefensible — it preserves the data if the block lifts — but that 403 is already written down twice and 429 once, and a status code is not worth a third round.



---

## Design

### 1. What gigapipe actually does with a log line

Facts, not design.

#### 1.1 Ingest routes

`writer/router/insert.go:8-20` registers on the single root mux:

```
POST /loki/api/v1/push      -> controllerv1.PushStreamV2    (JSON default; protobuf+snappy via content-type)
POST /v1/logs               -> controllerv1.OTLPLogsV2      (protobuf ONLY)
POST /api/v2/logs           -> controllerv1.PushDatadogV2
POST /influx/api/v2/write   -> controllerv1.PushInfluxV2
POST /cf/v1/insert          -> controllerv1.PushCfDatadogV2
```

`PushStreamV2` is `withSimpleParser("*", DecodePushRequestStringV2)` plus a `withComplexParser("application/x-protobuf", UnmarshalProtoV2, withUnsnappyRequest)` branch, answering **204** with an empty body (`writer/controller/insert.go:49-60`). `OTLPLogsV2` is `withSimpleParser("*", UnmarshalOTLPLogsV2)` answering **204** with the body `Ok` (`insert.go:146-158`).

`Content-Encoding: gzip` and `snappy` are decompressed before parsing, and an unknown encoding is a 400 (`writer/controller/middleware.go:176-199`). Two details that matter for our own gateway's rules:

- gigapipe's snappy is **block format** (`snappy.Decode(nil, body)`, `middleware.go:191`), not the framed/streaming format. Loki's own push client uses block format too. Reviewer 1 and reviewer 2 both wrote "snappy-framed"; that is imprecise and would send an implementer to the wrong npm API.
- a `snappy` body that fails to decode is passed through **as-is** rather than rejected (`middleware.go:189-193`, with an in-source comment calling it "a complete mess"), and that branch applies no decompressed-size cap — unlike the remote-write path at `middleware.go:117-129`, which caps at 10 MiB.

#### 1.2 The Loki JSON push decoder — the path we use

`writer/utils/unmarshal/unmarshal.go:43-64` parses `{"streams":[{"stream":{…},"values":[["<ns>","<line>"],…]}]}` and calls `onEntries` once per stream object.

- `stream` keys are sanitised by `sanitizeRe = (^[^a-zA-Z_]|[^a-zA-Z0-9_])` → `_` (`unmarshal.go:272-277`). It **replaces** a leading non-letter rather than prefixing it: `500ms` becomes `_00ms`, not `_500ms`.
- Label values longer than 100 bytes are truncated and then have a literal `...` appended: `lbls[i][1] = lbls[i][1][:100] + "..."` (`unmarshal.go:276-278`). That is a Go **byte** slice, not a rune slice — a multi-byte codepoint straddling byte 100 is cut mid-character. The stored value is 103 bytes, not 100.
- `sanitizeLabels` does **not** drop empty-valued labels. It rewrites the key and truncates the value, nothing else (`unmarshal.go:272-281`), and `onEntries` filters only `__ttl_days__` and metric-metadata labels before fingerprinting (`builder.go:318-351`). An empty-valued label **is** stored and **does** contribute to the fingerprint. The draft's cardinality rule 5 claimed gigapipe drops it; it does not. This is a gateway rule, restated in §3.3.
- `entries: [{ts|timestamp, line, value}]` is an accepted alternative to `values` (`unmarshal.go:178-237`); `ts` may be RFC3339 or an ns string (`parseTime`, `unmarshal.go:284-311`).
- When a value tuple carries *both* a line and a numeric value, `tp` becomes 3 and is then collapsed to **0** (`unmarshal.go:163-165`, `:225-227`). Type 0 means "both" and is matched by every reader predicate. **Our gateway never emits index 2 and never forwards a customer's**, because it never forwards a customer's tuple at all: `/telemetry/loki/api/v1/push` is decoded into `ILogIngestLine[]` and re-serialised by `pushLogs`, which builds a two-element tuple unconditionally. A hand-written `curl` at *gigapipe* could produce type 0; a hand-written `curl` at *our* route cannot, and gigapipe is not reachable from outside `apps/api` (`10` D2: no published port on any surface). This is invariant **I12** and it is what preserves `08-schema-changes.md` S13's and `10-ops-retention-billing.md` D10's two-valued `type` model now that D1 has removed the "the Loki route is not exposed" premise. Note that both of those documents write their TTL clauses as a *total* partition (`type != 1` / `type = 1`) anyway, so a type-0 row that somehow appeared would still be expired rather than retained forever — I12 is what keeps it from being *created*, and the totality is what keeps it from being *stranded*.

Then, for every ingest path, `parserDoer.onEntries` (`writer/utils/unmarshal/builder.go:318-401` — note `writer/utils/unmarshal/builder.go`, not the unrelated `writer/controller/builder.go`):

- strips `__ttl_days__` and metric-metadata labels (`builder.go:326-346`);
- calls `discoverServiceName` (`builder.go:300-316`). The loop breaks only on an exact `service_name` label; otherwise it keeps overwriting `serviceName` from a 13-entry candidate map (`builder.go:284-298`: `service, app, application, app_name, name, app_kubernetes_io_name, container, container_name, k8s_container_name, component, workload, job, k8s_job_name`) and takes the **last** match in label order, defaulting to `"unknown"`. On the OTLP path the label slice is built by ranging a Go map (`otlplogs.go:58-60`), so the chosen value is nondeterministic across requests. **This is why we always set `service_name` ourselves.**
- fingerprints the surviving labels (`builder.go:351`) and appends to the `samples_v3` and `time_series` batches with `type = 1`.

`fingerprintLabels` (`unmarshal.go:250-270`) folds each `(key, value)` cityhash into a sum, an xor and a product. All three are commutative, so **the fingerprint is label-order independent** — we can compute it client-side for a given label set and compare it against what gigapipe stored. That property is what makes the byte-truncation test meaningful.

#### 1.3 Read surface

`reader/router/query_range.go:20-33` and `reader/router/select_labels.go:17-20`:

```
GET,OPTIONS  /loki/api/v1/query_range          streams | matrix
GET,OPTIONS  /loki/api/v1/query                instant
GET,OPTIONS  /loki/api/v1/tail                 WebSocket
GET,OPTIONS  /loki/api/v1/index/stats          {streams,chunks,bytes,entries}
GET,POST,OPTIONS  /loki/api/v1/label, /labels       ALL label names, no match filter -- DO NOT PROXY
GET,POST,OPTIONS  /loki/api/v1/label/{name}/values
GET,POST,OPTIONS  /loki/api/v1/series
-- the following four only when LOG_DRILLDOWN is truthy; ONE gate, not four --
GET,OPTIONS  /loki/api/v1/index/volume
GET,OPTIONS  /loki/api/v1/detected_labels
GET,OPTIONS  /loki/api/v1/detected_fields      STUB, always {"fields":[]}
GET,OPTIONS  /loki/api/v1/patterns
```

**Correction to the draft:** it said "the read routes register `GET` and `OPTIONS` only — no `POST`", contradicting its own table three lines above. `reader/router/select_labels.go:17-20` registers `.Methods("GET", "POST", "OPTIONS")` on all four label endpoints. The operational conclusion is unchanged — the client sends canonical paths over GET, because gorilla/mux answers **405** when a path matches but the method does not, and 301-redirects a non-canonical path before any handler runs — but `/series` and `/label/{name}/values` **do** accept POST if a compiled selector ever outgrows a proxy's URL limit. It is a real escape hatch, not an unavailable one. The `query_range.go`-registered routes are the GET-only ones.

**Parameter semantics, all of which bite:**

- `start` and `end` are parsed as **float64** and cast to int64 nanoseconds (`reader/controller/utils.go:21-34`, `reader/controller/query_range.go:41-42`). A 2026 nanosecond timestamp is ~1.79e18, past float64's exact-integer range of 2^53, so roughly 256 ns of precision is lost in transit. Irrelevant in practice because…
- …**`From`/`To` are floored to whole seconds** before they reach the planner: `From: time.Unix(fromNs/1000000000, 0)` (`reader/service/query_range.go:550-551`), and `QueryRange` always routes through `prepareOutput` (`:415-418`).
- the resulting predicate is `Ge(samples.timestamp_ns, from) AND Lt(samples.timestamp_ns, to)` — **inclusive lower, exclusive upper**, both second-granular (`clickhouse_planner/planner_main_init.go:42-45`). This is load-bearing for pagination, for context expansion **and for the tail cursor**; the draft applied it to the first two and forgot it for the third.
- `step` goes through `getRequiredDuration` → `parseDuration` (`utils.go:36-49`, `reader/controller/prom_query_range.go:355-367`) where **a bare numeric value is SECONDS** (`d * float64(time.Second)`), and the controller then multiplies by 1000 to get ms (`query_range.go:57-58`). `step=60000` requests a 60,000-second step. **Always send `step=60000ms`.** The default is `"1"`, i.e. one second.
- `limit` defaults to **100** (`reader/controller/query_range.go:19,47-52`).
- `direction=forward` sets `OrderASC`; anything else is descending (`query_range.go:57-58`).
- The tail endpoint parses `start` with `strconv.ParseInt` (`reader/controller/query_range.go:183-188`) — exact nanoseconds. **`query_range` does not.** Two endpoints, two different lower-bound semantics.

**Regex semantics.** gigapipe's `=~` and `!~` are **unanchored** in both the stream selector and the label filter: every regex matcher compiles to `match(col, pattern)` (`clickhouse_planner/sql_misc.go:18-34`; `planner_stream_select.go:57-62`; `planner_label_filter.go:141-155`), which is a *search*, not a full match — unlike Loki, whose label matchers are fully anchored. This is load-bearing in two directions and the draft never stated it: it is why the `contains → =~` mapping for field filters works at all, and it means a user-facing "Regex" operator on `service_name` behaves as substring-search (a pattern `api` also matches `payments-api-v2`). `level=~"error|fatal"` is safe only because `level` is a closed six-value set.

**Response shape** (`reader/service/query_range.go:56-141`):

```json
{"status":"success","data":{"resultType":"streams","result":[
  {"stream":{"op_project_id":"…","service_name":"api"},
   "values":[["1756425600123456789","{\"v\":1,\"body\":\"…\"}"]]}]}}
```

Entries are **grouped by fingerprint**. The `LIMIT` is applied *before* that regroup, on `timestamp_ns` alone (`planner_main_limit.go:12-21`, `planner_main_order_by.go:13-28`), so it is a correct global top-N by time — but the caller must merge-sort across streams itself.

#### 1.4 Storage

`ctrl/qryn/sql/log.sql`:

```sql
CREATE TABLE IF NOT EXISTS {{.DB}}.samples_v3 {{.OnCluster}} (
  fingerprint UInt64,
  timestamp_ns Int64 CODEC(DoubleDelta),
  value Float64 CODEC(Gorilla),
  string String
) ENGINE = {{.MergeTree}}
PARTITION BY toStartOfDay(toDateTime(timestamp_ns / 1000000000))
ORDER BY ({{.SAMPLES_ORDER_RUL}});                      -- log.sql:25-32
```

`type UInt8` is added later by `ALTER TABLE … ADD COLUMN IF NOT EXISTS type UInt8` (`log.sql:119-120`) — and, unlike `time_series` (`:115-117`), `time_series_gin` (`:122-124`) and `metrics_15s` (`:126-128`), samples_v3 gets **no `MODIFY ORDER BY`**. A `type_v2 UInt8 ALIAS type` column is then added *without* `IF NOT EXISTS` (`log.sql:168-169`) — so we must not pre-create it or that statement fails and the boot panics.

`metrics_15s_mv` (`log.sql:146-158`) selects `FROM samples_v3` with **no WHERE**, grouping by `(fingerprint, timestamp_ns, type)`, and computes `bytes = sumSimpleState(length(string))`. Log rows are rolled up too. The MV is insert-triggered only: deleting rows from `samples_v3` does **not** retract the corresponding `metrics_15s` aggregates.

The `patterns` table is `log.sql:174`. It is written by the always-on clusterer (D8).

On a cluster, gigapipe additionally creates Distributed companions itself, with `IF NOT EXISTS`: `samples_v3_dist` sharded by `fingerprint` (`ctrl/qryn/sql/log_dist.sql:18-23`), `time_series_dist` by `fingerprint`, `metrics_15s_dist` by `fingerprint`, and `time_series_gin_dist` by **`rand()`** (`log_dist.sql:7-45`). We do not pre-create any of them — see §7.1.

`ADVANCED_SAMPLES_ORDERING` (`cmd/gigapipe/main.go:123-124`) is the only lever over `SAMPLES_ORDER_RUL`, and it is interpolated into the `CREATE TABLE` only. It is a **fresh-install-only** knob.

### 2. The isolation boundary for LogQL

The parent plan's decision 2 is a mandatory `op_project_id` matcher. For LogQL it holds only if all of the following are true. Each is a compiler invariant with a test in `packages/gigapipe/src/query/logql.test.ts` (D14).

| # | Invariant | Why, with evidence |
|---|---|---|
| **I1** | The compiled selector always contains `op_project_id="<uuid>"` — operator `=`, non-empty value, first position. | An `=` or `=~` matcher with an **empty** value is spliced out of the matcher list into an `emptyLabels` branch that becomes `simpleJSONHas(labels, 'op_project_id') = 0`, i.e. a predicate matching series *without* the label (`planner_stream_select.go:31-41`, `:84-116`). Worse: the removal loop then evaluates `if s.Ops[i] == "=~"` on the **same, now-shifted** index (`:42`), so an empty matcher in the last position reads past the end of the slice and the planner panics — recovered by the controller's `defer tamePanic` as a 500. Both outcomes are wrong. `compileLogQuery` throws rather than emits when `projectId` is falsy. |
| **I2** | No emitted matcher uses `=~` with the value `.*`. | **Re-justified, because the env manifest now pins `ADVANCED_OMIT_EMPTY_VALUES=true`** (`01-tenancy-and-security.md` §3.1 decides it; this document previously pinned `false` and that was the wrong trade). Under `false`, such a matcher is deleted from the selector with no replacement (`planner_stream_select.go:42-46`) — that was I2's original evidence and it is no longer observable, because the whole loop `break`s on its first iteration when `ClokiReader.OmitEmptyValues` is set (`:32-35`, env var at `cmd/gigapipe/main.go:159`). **The rule survives on I3's evidence instead**, which does not read `OmitEmptyValues` at all: `analyzeStreamSelect` (`analyze.go:74-87`) counts matchers that are *not* `=~".*"`, and if that count is zero the fingerprint filter vanishes entirely. Emitting a `.*` matcher is therefore never useful and always one deleted sibling away from a full cross-tenant scan. The flag is worth more than the evidence: at `true`, `{op_project_id=""}` compiles to an ordinary `key='op_project_id' AND val=''`, matching nothing — **fail closed** — instead of `simpleJSONHas(labels,'op_project_id') = 0`, which selects every series *lacking* the tenancy label. |
| **I3** | At least one matcher is not a `.*` regex. | `analyzeStreamSelect` counts matchers where `c.Op != "=~" \|\| val is not ".*"` and sets `noStreamSelect = true` when that count is 0 (`analyze.go:74-87`). `FingerprintFilterPlanner.Process` then returns the main query with **no fingerprint bound at all** (`planner_fingerprint_filter.go:17-19`) → a full cross-tenant scan of the window. I1 guarantees this. |
| **I4** | `op_project_id` is reserved: rejected in user matchers, in promoted label keys, in the context-expansion label map, and stripped from every response `stream` map. | Otherwise a user-supplied `op_project_id=~".*"` re-enters I2/I3. Enforced in `zLogStreamMatcher`, in `zLogContextInput`, and again in `parseStreamsResponse`. **Only `op_project_id` is stripped from responses — `source` is not.** See §5.3 for why the draft's extra stripping of `source` broke context expansion. |
| **I5** | Exactly one `match[]` is ever sent to `/series` and `/label/{name}/values`, and **the client throws when the match list is empty**. | Multiple `match[]` values are **OR-ed**, so a second matcher widens rather than narrows. And zero `match[]` is the real hazard the draft never stated: `Values` falls through to `NewValuesPlanner(nil, label, nil)` when `len(match) == 0` (`reader/service/query_abels.go:200-209`), which is a tenant-free enumeration — the I7 failure by a different door. A future refactor that drops an empty selector would reintroduce it with no invariant broken on paper, so the empty case is an explicit throw with its own test. |
| **I6** | *(recorded, not shipping — `LOG_DRILLDOWN=false` per D8, so the route is not registered and is not in the client allowlist.)* If it is ever re-enabled, `targetLabels` for `/index/volume` must be validated per element against `^[a-zA-Z_][a-zA-Z0-9_]*$`, as a second line of defence behind not proxying it at all. | `QueryVolume` string-interpolates both the query *and* the label list into `fmt.Sprintf("sum(bytes_over_time(%s [%dms])) by (%s)", …)` and then parses the result (`reader/service/query_range.go:166-177`). A `targetLabels` value of `foo) + sum(bytes_over_time({op_project_id="victim"}[1s])) by (bar` is a syntactically valid cross-tenant read. |
| **I7** | `/loki/api/v1/labels`, `/loki/api/v1/label/{name}/values`, `/detected_labels`, `/index/volume`, `/detected_fields` and `/patterns` are never reachable through our client. | `/labels` enumerates every label name in the database with no match filter (`reader/router/select_labels.go:17-19` → the controller's nil match set). `QueryDetectedLabels` accepts `query == ""` and simply skips parsing (`reader/service/query_range.go:222-240`). The last four are not registered at all at `LOG_DRILLDOWN=false` (D8) and none of the six is in `04-read-path.md`'s `GIGAPIPE_ROUTES` (D3). Label discovery is direct ClickHouse (`04` §9). |
| **I8** | Every `/loki/api/v1/index/stats` call carries a compiled selector. | `QueryIndexStats` applies the fingerprint filter only `if script != nil && script.Head.StrSelector != nil && len(…StrSelCmds) > 0`; otherwise it aggregates the whole `samples_v3` under `PREWHERE type_v2 IN (0,1)` with no tenant bound (`reader/service/query_range.go:843-870`). |
| **I9** | On ingest, `op_project_id` is removed from resource, scope **and** record attributes before the label set is built, then stamped once from the token. | Record attributes beat resource attributes in gigapipe's own merge order (`otlplogs.go:37-46`); in our mapper we own the order, but the input still arrives from an untrusted client. |
| **I10** | **gigapipe's reader sets no ClickHouse query limits — VERIFIED.** | `createDataDBSessions` builds the reader's `clickhouse.Options` with `Settings: nil` (`reader/registry/registry.go:69`). The writer's client does set settings (`writer/chwrapper/factory.go:46`); the reader's does not. A `\|~` regex over a wide window therefore runs unbounded on the same ClickHouse that serves OpenPanel's analytics. The mitigation is a dedicated ClickHouse user with a settings profile (§7.4). **This is a P0 dependency of the logs work-stream, not a P3 nicety.** The draft marked this UNVERIFIED and open question 14 blocked P3.0 on it; both are now closed. |
| **I11** | Outbound header hygiene. | See D9. |
| **I12** | **Every Loki value tuple `pushLogs` emits has exactly two elements.** | Index 2 is read as a `float64`; a tuple carrying both a line and a number sets `tp = 3`, collapsed to `type = 0` (`unmarshal.go:139-165`, `:225-227`), which every reader predicate matches as *both* signals. `pushLogs` is the only writer of a Loki tuple in the product, so a shape assertion in one function is the whole control. This is what preserves the two-valued `type` model that `08` S13 and `10` D10 build the per-signal TTL on, now that D1 has removed the "we do not expose the Loki route" premise. Asserted on the serialised body, not on an intermediate structure. |
| **I13** | **Every `op_`-prefixed key is removed from the envelope's `attr` map, not only `op_project_id`.** | `06-traces-and-correlation.md` T11 requires the gateway to strip `op_session_id` and `op_profile_id` from log record attributes; the reserved-key rule in §3.2 generalises it to the whole `op_` prefix so the next correlation key is covered without another edit. `op_root` (a transport marker `06` never persists) is covered by the same rule. |

### 3. Data model

#### 3.1 Labels — the indexed dimension

A log stream in OpenPanel is exactly this label set. Nothing else is ever a label.

| Label | Source (OTLP) | Source (Loki push) | Budget |
|---|---|---|---|
| `op_project_id` | injected from the authenticated `Client` | injected | 1 per project |
| `source` | constant `otlp` | constant `loki` (`op_self` for OpenPanel's own logs) | 3 |
| `service_name` | resource `service.name` | stream `service_name`/`service`/`app`/`job` | ≤ 200/project (soft) |
| `service_namespace` | resource `service.namespace` | stream `service_namespace` | ≤ 50 |
| `deployment_environment` | resource `deployment.environment.name`, falling back to `deployment.environment` | stream `deployment_environment`/`env` | ≤ 20 |
| `level` | normalised from `severityNumber`, falling back to `severityText` | normalised from stream `level`/`severity` | exactly 6 |
| `host_name` | resource `host.name` | stream `host`/`hostname`/`host_name` | ≤ 2 000 |
| `k8s_namespace_name`, `k8s_deployment_name`, `k8s_container_name` | resource `k8s.*` | same names | ≤ 500 combined |
| up to 5 promoted keys | `Project.telemetryLabelKeys` | same | checked at promotion time |

`level` is normalised to exactly one of `trace debug info warn error fatal` by `packages/gigapipe/src/severity.ts`, mapping OTLP severity numbers 1–24 into those six buckets and lower-casing/prefix-matching `severityText` when the number is absent. We do this rather than passing `severityText` through because gigapipe would otherwise set `level` from the raw text itself (`writer/utils/unmarshal/otlplogs.go:47-49`) and `WARNING`/`WARN`/`warn` would be three distinct series.

**`service_name` is never omitted.** If neither the resource nor any candidate key supplies one we set `service_name="unknown"`, because `discoverServiceName` would otherwise pick the last of thirteen candidates in nondeterministic map order (§1.2).

**`k8s_pod_name` is deliberately not a label.** Pod names churn on every deploy: a 30-replica service redeployed daily is ~900 new series a month for one label. It goes in `attr` and is fully searchable there.

**Where the label configuration is read.** `Project.telemetryLabelKeys` comes from **one** `getProjectTelemetryStateCached(projectId)` read with a 60 s TTL — never a Prisma round trip per push. The consequence is stated on the settings page: a label promotion takes up to 60 s to take effect on ingest, and the mutation invalidates the cache explicitly.

**Two columns the draft added here are cut.** `Project.telemetryLogRetention` is gone because `10-ops-retention-billing.md` D9 ships **one window per signal for everyone** in v1 and defers per-plan tiering behind a named trigger; a per-project column that nothing reads is a migration we would have to keep. `Project.telemetryLogsBlockedAt` is gone because `10` §9.4 owns the quota-marker lifecycle on `Organization`, and two independent block markers is exactly the class of duplication this revision exists to remove. `08-schema-changes.md` owns the one remaining column (`telemetryLabelKeys`) and it belongs in `08`'s migration inventory, where it is currently missing.

#### 3.2 The line envelope

Stored verbatim in `samples_v3.string`. One shape, always:

```jsonc
{
  "v": 1,                                        // envelope version; first key, cheap to sniff
  "body": "connection reset by peer",
  "sev": "error",                                // == the `level` label; row is self-describing
  "sevn": 17,                                    // OTLP severity number, 0 when unknown
  "tid": "4bf92f3577b34da6a3ce929d0e0e4736",     // omitted when absent
  "sid": "00f067aa0ba902b7",                     // omitted when absent
  "attr": { "http_status_code": "500", "peer": "10.0.3.7", "k8s_pod_name": "api-7f9c-x2k" }
}
```

Rules, in order, implemented by `packages/gigapipe/src/envelope.ts` (D14):

1. `attr` starts empty. Merge in this order, later wins: **body-derived keys → scope attributes → record attributes.** Resource attributes are *not* merged — the ones we care about are labels, and the rest are per-resource constants that would multiply stored bytes by the line count. (See open question 5.)
2. If `body` parses as a JSON **object**: take the first present of `msg | message | body | event | log` as `body`, delete it from the object, and merge the remaining top-level **scalar** keys into `attr` (nested values re-serialised with `JSON.stringify`). With no message key, `body` becomes `""`.
3. Every `attr` key is sanitised with **`sanitizeAttrKey`, the same function the label pipeline uses** — `s.replace(/(^[^a-zA-Z_]|[^a-zA-Z0-9_])/g, '_')`, matching gigapipe's `sanitizeRe` (`unmarshal.go:272`) exactly. Do **not** use gigapipe's OTLP-path `SanitizeKey` (`otlplogs.go:107-117`), which *prefixes* a leading digit rather than replacing it — the two disagree (`500ms` → `_00ms` vs `_500ms`), and it is the Loki-push rule that will actually run on the label if that key is later promoted.
4. Reserved keys are deleted from `attr` before serialisation: **every key matching `/^op_/`** — which covers `op_project_id`, `op_session_id`, `op_profile_id` and `op_root`, satisfying `06-traces-and-correlation.md` T11 for the logs signal (I13) — plus `source` and every label name in §3.1. The prefix rule rather than a list is deliberate: `06` will add correlation keys, and a list is one PR away from being stale.
5. Values are stringified. An `attr` value is truncated at **1 024 bytes** with a `…(truncated)` suffix; the whole envelope at **64 KiB**, dropping `attr` keys largest-first until it fits, then hard-truncating `body`. A dropped-key count is recorded as `attr_dropped: n`.
6. Key order is fixed (`v, body, sev, sevn, tid, sid, attr`) and `attr` keys are sorted, so identical records serialise to identical bytes. Load-bearing twice: the envelope test asserts byte-identical output, and the line's SHA-1 is half of the row's dedupe key (D10).

**`06-traces-and-correlation.md` T12 is declined for logs, with a reason.** T12 asks the gateway to zero `LogRecord.SpanId` by default, because "gigapipe promotes both `trace_id` and `span_id` to first-class labels (`otlplogs.go:52-58`)" and `span_id` multiplies the per-trace series count by spans-per-trace. That is true **on gigapipe's OTLP log path, which D1 does not use.** Under D1 the OTLP record never reaches gigapipe: `tid` and `sid` are envelope fields inside `samples_v3.string`, not labels, and contribute nothing to the fingerprint. Zeroing `sid` would delete the one field that makes "logs for this span" possible (§11) in exchange for a cardinality saving that is already zero. T12 remains correct as a rule on *anything that forwards OTLP logs to gigapipe*; nothing in this plan does after D1. `06` should record the dependency as satisfied rather than as an outstanding requirement on this work-stream.

**Envelope compatibility contract.** The draft had a `v` field and a byte-identity test but no rule for what to do with a `v` it does not know, which is a real gap at 30-day retention: any envelope change means both versions coexist in a single query result for a month, and a rollback means readers older than writers.

- Readers accept any `v <= CURRENT` and **ignore unknown keys**. A `v > CURRENT` line falls to the raw-line tolerance path (rendered as `{ body: raw, severity: 'info', attributes: {} }`) rather than throwing.
- Within a major version, writers may only **add optional keys**. Renaming, retyping or removing a key is a `v` bump.
- A `v` bump keeps the previous reader branch for at least one full retention window (`10-ops-retention-billing.md` §6.1's logs window — 14 days on cloud v1, `TELEMETRY_RETENTION_DAYS` self-hosted) before it may be deleted. Read the number from the constant; do not restate it.
- `envelope.test.ts` carries a `v: 2`-with-unknown-keys fixture asserting the v1 reader degrades cleanly.

**Worked example.** An OTLP record:

```
Resource: service.name=checkout, deployment.environment.name=prod, host.name=ip-10-0-3-7
Scope:    otel.library.name=net/http
Record:   severityNumber=17, severityText=ERROR, body="POST /pay failed"
          traceId=4bf9…4736, spanId=00f0…02b7
          attributes: http.status_code=500, k8s.pod.name=api-7f9c-x2k, user.id=u_884
```

becomes the stream

```
{op_project_id="9f1c…", source="otlp", service_name="checkout",
 deployment_environment="prod", host_name="ip-10-0-3-7", level="error"}
```

and the line

```json
{"v":1,"body":"POST /pay failed","sev":"error","sevn":17,
 "tid":"4bf92f3577b34da6a3ce929d0e0e4736","sid":"00f067aa0ba902b7",
 "attr":{"http_status_code":"500","k8s_pod_name":"api-7f9c-x2k",
         "otel_library_name":"net_http","user_id":"u_884"}}
```

One series for the whole service, instead of one series per request under gigapipe's native OTLP mapping.

#### 3.3 The cardinality rules a user must follow

Surfaced verbatim in the docs page and in the explorer's empty state.

1. **A label is a dimension you group by; a field is a value you search for.** If a value is unique per request — ids, timestamps, durations, URLs with query parameters — it is a field, and OpenPanel puts it in `attr` for you. Fields are fully searchable with `|=` and `| json`; they simply are not indexed.
2. **Your label budget is `service_name × deployment_environment × host_name × level × (your promoted labels)`.** A promotion whose measured 24 h distinct-value count would push the project past `OP_LOG_MAX_SERIES_PER_PROJECT` (default **50 000**) is refused at promotion time. Nothing is ever demoted afterwards — removing a label from a live stream changes its fingerprint and forks every stream that carried it, mid-incident, with no user action. The budget is enforced when you opt in, not behind your back.
3. **You cannot promote `trace_id`.** Reserved-deny list: `trace_id`, `span_id`, `request_id`, `session_id`, `user_id`, `profile_id`, `pod`, `k8s_pod_name`, `instance_id`, `container_id`, `thread_id`, and anything matching `/(^|_)(id|uuid|guid)$/`. Overridable only by an OpenPanel admin, never self-serve.
4. **Label values are truncated at 100 BYTES.** `unmarshal.go:276-278` is a Go byte slice and appends a literal `...`. The gateway truncates to ≤ 100 UTF-8 bytes **on a codepoint boundary** before sending, so what we send is what gets stored and the fingerprint we compute matches the one gigapipe computes. A 100-*character* truncation of an accented `service_name` or a CJK `deployment_environment` exceeds 100 bytes, gigapipe re-truncates mid-codepoint, and the fingerprint diverges.
5. **The gateway drops any label whose value is empty before pushing.** gigapipe does **not** — `sanitizeLabels` only rewrites the key and truncates the value (`unmarshal.go:272-281`), and `onEntries` filters only `__ttl_days__` and metric-metadata keys (`builder.go:318-351`). An empty-valued label is stored in `time_series.labels` and contributes to the fingerprint, which forks the stream and then makes it unreachable by any equality matcher. (The second half of the draft's rule 5 was correct and stands: `{x=""}` at *query* time is a has-no-label predicate, or a planner panic — I1.)

#### 3.4 What this costs in ClickHouse

Per log line: one `samples_v3` row, **plus one pass through gigapipe's pattern clusterer** (`writer/controller/builder.go:221-223`, `:247-249`) which takes an RLock and iterates every cluster sharing the line's first token, on a process-global map, and may write a `patterns` row (`ctrl/qryn/sql/log.sql:174`). That cost is ungateable and tenant-coupled (D8); it is why gigapipe writer CPU and RSS are operator alerts and why the P3 load test uses high shape diversity, not one repeated line.

Per **new stream per day**: one `time_series` row plus one `time_series_gin` row **per label**, plus a `metrics_15s` bucket per 15 s per stream.

With the model above, a 30-service / 3-environment / 200-host project has ~110 k daily series worst case and realistically ~2 k. Under gigapipe's native OTLP mapping with trace context it is one series *per line*.

`metrics_15s` carries `type` in its column list and sort key (`log.sql:126-128`) and `metrics_15s_mv` groups by it (`log.sql:146-158`), so log and metric rollups **are** separable with a `type IN (1,0)` predicate. We nevertheless do not meter from `metrics_15s.bytes`: `bytes = sumSimpleState(length(string))` also counts whatever the metrics path writes into `samples_v3.string`. We meter at the gateway, into `10-ops-retention-billing.md` §8.2's Redis contract (§4.6).

#### 3.5 Cardinality observation (warning only)

The draft ran a `PFCOUNT` union **on the ingest hot path**, per batch, for a number that nothing per-batch consumes. Reviewer 3 is right; the split is:

**On ingest** — `PFADD` only, pipelined, and **not awaited before the response**:

```ts
// packages/gigapipe/src/cardinality.ts -- called once per push batch, never per line
export function observeCardinality(projectId: string, byLabel: Map<string, Set<string>>): void {
  const day = utcDayStamp();                     // formatInTimeZone(new Date(),'UTC','yyyyMMdd')
  const pipe = getRedisCache().pipeline();
  for (const [labelName, values] of byLabel) {
    const key = `op:tel:card:${projectId}:${labelName}:${day}`;
    for (const chunk of chunked([...values], 500)) pipe.pfadd(key, ...chunk);
    pipe.expire(key, 60 * 60 * 50);              // 50h: today + yesterday both survive
  }
  // Fire-and-forget: one pipelined round trip, off the response path entirely.
  void pipe.exec().catch((err) => logger.warn({ err, projectId }, 'cardinality observe failed'));
}
```

Exactly **one** Redis round trip per push batch, and the response does not wait for it. `byLabel` has at most 14 entries (§3.1) and each set is bounded by the batch's distinct values.

**On read** — `PFCOUNT` moves to where its result is actually consumed: the promotion mutation's budget check and the settings card's query.

```ts
// Rolling ~24h window: PFCOUNT unions keys, so a label that blew the budget
// yesterday does not read clean for the first hours of today.
const distinct = await redis.pfcount(key(day), key(utcDayStamp(-1)));
```

**Fail-open.** A Redis error skips the guard and logs a warn — the same posture `subscriptionHook` takes. Uses `getRedisCache()`, the cache connection, not the queue connection that carries the event buffer.

#### 3.6 Project configuration — one column, owned by `08`

*Revised.* The draft added three `Project` columns, a `TelemetryPurgeJob` model and two enums. Two of the columns and the whole model are cut (D15, §3.1); what is left is one column, and `08-schema-changes.md` owns the declaration because it owns "every Prisma enum, model and field addition".

```prisma
  /// [IPrismaTelemetryLabelKeys]
  telemetryLabelKeys      Json      @default("[]")   // string[], max 5
```

`packages/db/src/types.ts` gets `type IPrismaTelemetryLabelKeys = string[]` next to the existing `IPrismaProjectFilters`. The typed-Json mapping is applied by `packages/db/prisma/prisma-json-types.ts`, a bespoke regex post-processor run as the second half of `pnpm codegen` — not by `prisma-json-types-generator`, whose generator block is commented out at `schema.prisma:12-14`.

**Request to `08`:** this column is absent from `08`'s Postgres inventory (P1–P10) and from its migration sequencing table. Either absorb it, or say that per-project label promotion is cut from v1 too — in which case §3.1's fifth row and §8.3's promotion-time budget check go with it, and the label set becomes a fixed eleven. `01-tenancy-and-security.md` D5's `ProjectIdTombstone` is in the same position: `01` calls it "the boundary" for failure mode F8 and `08`'s inventory does not contain it. Neither is this document's to declare, but both are this document's to notice.

**What replaced the purge journal.** The draft's `TelemetryPurgeJob` existed to make a fingerprint set durable across a worker crash between resolution and mutation. That requirement is real and survives; the model does not, because `08` §14 already ships a ledger (`TelemetryErasure`) for the same lifecycle and `08` owns the delete path. §7.4 states the resumability requirement as a request against `08`'s ledger rather than as a second model.

### 4. Ingest

#### 4.1 Routes and body handling

New `apps/api/src/routes/telemetry.router.ts`, registered in the **Public API** encapsulated scope in `apps/api/src/app.ts` alongside `trackRouter` (`app.ts:374-381`) as `instance.register(telemetryRouter, { prefix: '/telemetry' })`.

```
POST /telemetry/v1/logs                 OTLP/HTTP: application/x-protobuf | application/json
POST /telemetry/loki/api/v1/push        Loki JSON  (protobuf+snappy from P3.4b -- see below)
```

**OpenAPI exposure is a deliberate yes.** That scope registers `fastifyZodOpenApiPlugin`, `fastifySwagger` and `fastifySwaggerUI` (`app.ts:343-368`), so both routes appear in the published document and at `/documentation` unless `schema.hide` is set. The draft never said whether that was intended. It is: we tell customers to point an agent at these endpoints, so they belong in the API reference. Add a `{ name: 'Telemetry', description: 'Ingest logs, metrics and traces' }` tag to the `openapi.tags` array at `app.ts:349-357` and tag both routes.

**Body limits come from `02-ingest-gateway.md` §15, not from here.** The draft declared a local `OTLP_MAX_BODY = 4 MiB`; `02` §5.2/§15 declares `TELEMETRY_MAX_COMPRESSED_BYTES` (8 MiB, OTLP routes), `TELEMETRY_MAX_COMPRESSED_BYTES_REMOTE_WRITE` (2 MiB) and `TELEMETRY_MAX_DECOMPRESSED_BYTES` (32 MiB), with a justification for 32 over 64 that this document has no reason to relitigate. `02` owns the gateway; the local constant is deleted.

```ts
import { MAX_COMPRESSED_BYTES, MAX_DECOMPRESSED_BYTES } from '@/telemetry/limits'; // 02 §15

fastify.post('/v1/logs',
  { bodyLimit: MAX_COMPRESSED_BYTES, preHandler: [telemetryClientHook, ingestionBlockHook] },
  controller.otlpLogs);
fastify.post('/loki/api/v1/push',
  { bodyLimit: MAX_COMPRESSED_BYTES, preHandler: [telemetryClientHook, ingestionBlockHook] },
  controller.lokiPush);
```

Without a route-level limit the JSON paths inherit the global `bodyLimit: 1_048_576 * 500` (`app.ts:88`) — a 500 MB body buffered in the same Node process that serves event ingest, which is the reason a route-level limit exists at all.

**Note for `11-testing-strategy.md` E29.** It asserts "payload over 64 MiB" against gigapipe's `defaultOTLPMaxMessageSize`. Under `02` §15 the real cap is 8 MiB compressed / 32 MiB decompressed, so a 64 MiB test passes while an unset cap goes undetected. E29 must assert against `02`'s configured value.

**A separate 4 MiB survives and is not the same number.** `pushLogs` splits its *outbound* body so no sub-batch exceeds 4 MiB uncompressed (§4.5). That bounds what one gigapipe request costs, not what a customer may send.

**Content-type parsing — the draft's most immediately fatal bug.** `grep -rn addContentTypeParser apps/api/src` returns nothing: apps/api registers no content-type parser today, so `application/json` is handled by Fastify's **built-in JSON parser**. The draft added a parser only for `application/x-protobuf` and then did `req.body as Buffer`. A Loki push or OTLP/JSON request sent as `Content-Type: application/json` + `Content-Encoding: gzip` — which is what Promtail, Vector, Alloy, the OTel Collector's JSON encoder **and OpenPanel's own `pushLogs`** all send — reaches the built-in parser, which reads gzip bytes as UTF-8 and `JSON.parse`s them. Every such request 400s (`FST_ERR_CTP_INVALID_MEDIA_TYPE` is already in `app.ts`'s `SKIP_LOG_ERRORS`, so it would not even be logged loudly).

Fastify content-type parsers are **plugin-scoped**. Registering inside `telemetryRouter` overrides JSON parsing for `/telemetry/*` only and does not affect `/track`, `/event`, `/import` or `/trpc`:

```ts
// apps/api/src/routes/telemetry.router.ts -- scoped to this plugin instance
fastify.addContentTypeParser(
  ['application/json', 'application/x-protobuf', 'application/protobuf'],
  { parseAs: 'buffer', bodyLimit: MAX_COMPRESSED_BYTES },
  (_req, body, done) => done(null, body),
);
```

Decompression and `JSON.parse` then happen in the controller, after the decompressed-size guard:

```ts
const enc = String(req.headers['content-encoding'] ?? '').toLowerCase();
let raw: Buffer;
switch (enc) {
  case '':
  case 'identity':
    raw = req.body as Buffer; break;
  case 'gzip':
    raw = await gunzipWithLimit(req.body as Buffer, MAX_DECOMPRESSED_BYTES); break;
  case 'snappy':
    // P3.4b only; before that this arm does not exist and snappy falls to default.
    raw = snappyBlockDecodeWithLimit(req.body as Buffer, MAX_DECOMPRESSED_BYTES); break;
  default:
    return reply.status(415).send({
      message: `unsupported Content-Encoding '${enc}'; supported: identity, gzip`,
    });
}
```

**Stating the rule the draft left open:** an unknown `Content-Encoding` is a **415 with the supported list named**, never a silent pass-through. gigapipe 400s on unknown encodings and passes undecodable *snappy* through as-is (`writer/controller/middleware.go:189-193`); we do neither. We do not use `@fastify/compress` for inbound decompression — it is registered `{ global: false, encodings: ['gzip','deflate'] }` (`app.ts:135`) where `encodings` governs *response* compression, and making inbound gzip depend on undocumented plugin behaviour is not worth it when we own the parser anyway.

**Loki protobuf+snappy is advertised only once it exists.** The draft's route table promised `Loki JSON | protobuf+snappy` and nothing in the spec decoded it — no `logproto.proto`, no snappy dependency, no cost line. All three reviewers flagged it. Resolution: it is a **named, costed sub-step (P3.4b, 0.5 w)**, not an assumption.

- Until P3.4b lands, `Content-Type: application/x-protobuf` on the Loki route returns `415 {"message":"this endpoint accepts application/json only; configure your agent for JSON push, or use OTLP/HTTP at /telemetry/v1/logs"}`. Never a 400 and never a silent mis-parse.
- P3.4b vendors `logproto.proto` (the `PushRequest`/`StreamAdapter`/`EntryAdapter` messages) into `apps/api/proto/logproto/` under the same pinning discipline as the OTLP protos, adds a **block-format** snappy decoder with a decompressed-size guard, and normalises into the same `ILogIngestLine[]` the JSON path produces. Block format, not framed: gigapipe uses `snappy.Decode(nil, body)` (`middleware.go:191`) and so does Loki's own client. `snappyjs`'s `uncompress` is the pure-JS block-format API; a native `snappy` package is not required and is not taken as a dependency in P3.
- The docs page names, per agent, which encoding to configure until P3.4b: OTel Collector → `otlphttp` exporter at `/telemetry/v1/logs`; Vector → `loki` sink with JSON encoding; Promtail / Grafana Alloy → OTLP, or wait for P3.4b, because their Loki writers emit block-snappy protobuf and have no JSON mode.

**Rate limiting comes from `02-ingest-gateway.md` D11 §9.1, wholesale.** The draft called `activateRateLimiter` with an explicit `keyGenerator` returning the client id. `02` D11 rejects the shared wrapper for this route and it is right on both counts, verified again this pass:

- `apps/api/src/utils/rate-limiter.ts:28-41` — the wrapper's fallback returns `req.headers['openpanel-client-id']` **before** the trusted IP. Client ids are public values that ship in web-SDK bundles. The limiter's hook is installed at register time, so it runs **before** auth: an attacker rotating that header mints unlimited fresh 600/min buckets, and each one buys a `getClientByIdCached` lookup and — for any id that exists — the argon2 `verifyPassword` that `02` §2.2 deliberately puts a lockout in front of. Passing an explicit `keyGenerator` that returns the same attacker-chosen value does not fix this; it entrenches it.
- `apps/api/src/utils/rate-limiter.ts:19-25` — `errorResponseBuilder` is hard-coded to a JSON object with no override, so a 429 could never carry a `google.rpc.Status`.

So the telemetry plugin registers `@fastify/rate-limit` itself, with `02` §9.1's composite key `` `tel:${trustedIp}:${clientId ?? '-'}` `` and `02` §2.2's per-client-id and per-trusted-IP failed-auth counters checked **before** `verifyPassword`. Neither the composite key nor the lockout was in this document's draft.

Two facts worth keeping from the draft's analysis, because they are true and unobvious:

1. **The existing ingest routes have no rate limiting at all.** `activateRateLimiter` appears only on mcp, manage, export and insights; `/track`, `/event` and `/import` have none (`apps/api/src/routes/import.router.ts` is 41 lines with no limiter anywhere). This is new ground, not a copied convention, and it should be said out loud in both documents.
2. **`activateRateLimiter` has no `SELF_HOSTED` branch** — the draft asserted "unlimited when `SELF_HOSTED=true`" as existing behaviour. It is not. Whatever `02` chooses for the self-hosted ceiling, it is a value passed at the call site, not an inherited property.

**Error logging comes from `02` §11.3, and this document consumes it explicitly.** Verified: `apps/api/src/app.ts:392-427` — `SKIP_LOG_ERRORS` is exactly `['UNAUTHORIZED','FORBIDDEN','FST_ERR_CTP_INVALID_MEDIA_TYPE']`, and every other error logs `req: { …, headers: request.headers, body: rawBody ?? request.body }`, at `warn` for 4xx as well as `error` for 5xx. This document's own design produces precisely the statuses outside that list — 415 for an unknown `Content-Encoding`, 415 for protobuf on the Loki route until P3.4b, 413 for an oversize body, 400 for a malformed payload — and `openpanel-client-secret` is in `request.headers` on every one of them. The plugin therefore installs `02` §11.3's scoped `setErrorHandler`, which logs an explicit field list with no headers object and no body, and a test asserts that no log line emitted from a `/telemetry/*` 4xx contains the string `openpanel-client-secret`. The underlying repo-wide issue — the app-level handler logging all headers on 4xx for `/export`, `/insights` and every other public route — is **not** fixed here and needs an owner; `02`'s "Findings routed out" item 8 currently ends at "someone should fix it globally", which is not an owner.

**Responses.** See D13 for the counter split. `/v1/logs` returns `200 {"partialSuccess":{"rejectedLogRecords":N,"errorMessage":"…"}}` (or `{}` when nothing was rejected), where `N` counts **only** permanently-invalid records. The Loki route returns `204`, matching gigapipe's own `withOkStatusAndBody(204, nil)` (`writer/controller/insert.go:58`). Any transport failure returns `503` + `Retry-After: 5` on both. `413` is shaped per protocol: OTLP gets `partialSuccess` with every record rejected, Loki gets `413` with a message naming `02` §15's configured limit rather than a literal.

#### 4.2 Auth

We do **not** call `validateSdkRequest`, and the reason is a hard requirement rather than tidiness. It carries two pre-secret escape hatches: `client.ignoreCorsAndSecret` (`apps/api/src/utils/auth.ts:133-135`) and an `Origin` matching `project.cors` (`auth.ts:137-161`, including the `'*'` case at `:158`). **Both `return client` without verifying a secret.** Client ids are public values that ship in web SDK bundles, and `Origin` is freely settable from curl — so for any project with a non-empty `cors` array, possession of the public client id is sufficient to authenticate. A credential whose entire job is to be the source of truth for the injected `op_project_id` cannot be validated that way. It also body-parses credentials via ramda `path` over `req.body` (`auth.ts:52-56`), which is meaningless for a protobuf payload.

New `validateTelemetryRequest` in `apps/api/src/utils/auth.ts` plus `apps/api/src/hooks/telemetry-client.hook.ts`, shaped like the preHandler in `apps/api/src/routes/import.router.ts:8-30`:

- **Credentials, header-only.** `openpanel-client-id` / `openpanel-client-secret`, **and** `Authorization: Basic base64(clientId:clientSecret)`, documented as the recommended form for agents — Promtail, Alloy, Vector and the OTel Collector all carry Basic auth as a first-class field and custom headers as an afterthought. Both forms resolve through `resolveTelemetryClientId` / `resolveTelemetryCredentials` before any lookup. Never read from the body.
- **Secret required unconditionally.** No `ignoreCorsAndSecret`, no `Origin` bypass, and `project.cors` is never consulted.
- **Type.** `client.type === 'telemetry'`, a new `ClientType` enum value (`schema.prisma:353-357`). Adding the value is a **privilege grant** until four deny-lists become allow-lists, and nothing in either repo will fail a compile or a test if they are not:

  | Site | Today | Must become |
  |---|---|---|
  | `apps/api/src/utils/auth.ts:202` — `validateExportRequest`, which guards **both** `/export` and `/insights` (`apps/api/src/routes/insights.router.ts:36,52` imports and calls it in its own inline preHandler) | `if (client.type === ClientType.write) throw` | allow-list `read`/`root` only |
  | `apps/api/src/utils/auth.ts:237` (import) | `if (client.type === ClientType.write) throw` | allow-list `read`/`root` only |
  | `packages/mcp/src/auth.ts` | rejects `write` only | allow-list `read`/`root` only |
  | `apps/api/src/controllers/export.controller.ts` | scopes to the client's own project **only** when `type === read` | scope every non-`root` type, or reject `telemetry` explicitly |

  Note the count is **four surfaces, not three**: Insights shares the Export validator and is the larger read surface (chart engine, event names, profiles, groups, saved reports). Because they share one function, the fix belongs inside `validateExportRequest` rather than at the two call sites. The export controller is the sharpest of the four: it is not a type gate at all, it is a project-scoping check that fires only for `ClientType.read`, so a `telemetry` client would skip project scoping and inherit **org-wide export**. `validateManageRequest` (`auth.ts:272`, `client.type !== ClientType.root`) is already an allow-list and needs no change. Prefer inverting all of them to allow-lists so the *next* enum value fails closed.
- **Project scoping.** `Client.projectId` is nullable (`schema.prisma:364`). The tRPC create path requires it, the manage API does not, so `validateTelemetryRequest` **rejects `client.projectId == null` explicitly**, with a test. A null projectId reaching the stamper is precisely the I1 empty-value case the whole boundary rests on. Org-scoped telemetry tokens are not supported.
- **Minting.** `packages/trpc/src/routers/client.ts` pins `type: z.enum(['read','write','root']).optional()`; the enum is widened to include `telemetry` and `apps/start/src/modals/add-client.tsx` gains the option, behind the existing organization-admin guard.
- **Secret cache — `01-tenancy-and-security.md` §6.1's shape, verbatim.** The draft used a SHA-256 prefix of the *presented secret* in the cache key at a 5-minute TTL, copying `packages/mcp/src/auth.ts:106-108`. `02-ingest-gateway.md` §2.2 specifies the same shape. `01` §6.1 rejects it and its argument is decisive: **an entry keyed on the presented secret is unaddressable at rotation time** — no code path can reconstruct the key without the old plaintext, so nothing can clear it, and the *old* secret keeps hitting its own warm entry for the full TTL while the new one misses. So:

  - key on `telemetry:auth:${clientId}` **alone**;
  - store `{ hash, digest }` in the **value** — the stored argon2 hash and the SHA-256 of the presented secret;
  - on a hit where `entry.hash !== client.secret || entry.digest !== presented`, fall through to a full `verifyPassword` and `deleteCache(key)`;
  - TTL **60 s**, not 300;
  - export `clearTelemetryAuth(clientId)` and call it from `manage.controller.ts` and from tRPC `client.remove`.

  **The revocation SLA is 60 s, not 5 minutes**, and it is stated once — in `01` §6.1's table — with this document, `08` and `11` A18 citing it. `02` §2.2's code sample and this section's previous one should both be deleted in favour of `01`'s.

- **A prerequisite this document does not own.** `02-ingest-gateway.md` found that `packages/trpc/src/routers/client.ts`'s `client.remove` never calls `getClientByIdCached.clear()`, so dashboard revocation today is 300 s + 60 s rather than ≤ 60 s. That is a one-line fix and it must be a **P1a deliverable with a named owner**, because the 60 s SLA above is not true without it. Separately, `11` A17 requires migrating the *shared* `validateSdkRequest` cache off `client:auth:${clientId}:${base64(secret)}` (`apps/api/src/utils/auth.ts:165` — a reversible plaintext credential in the Redis keyspace, visible in `SCAN`, slowlog and RDB dumps) onto a `client:authv2:` prefix. `11` assigns it to "the ingest work-stream" and `02` never touches `validateSdkRequest`; it needs a real owner before `ClientType.telemetry` lands.
- **Project filters do not apply.** `Project.filters` (`IPrismaProjectFilters`, ip / profile_id) is enforced for events inside `validateSdkRequest` by reading `req.body` (`auth.ts:100-116`), and `validateTelemetryRequest` deliberately never touches the project's filter list. So a `profile_id` a customer has explicitly blocklisted keeps being ingested the moment their logs carry `attr.profile_id` — while §"Correlation" actively encourages exactly that attribute. That is a behavioural regression in a compliance control, not merely a missing feature, and it is stated in three places: the ingest docs, the DPA-facing retention docs, and the settings page. **P3 closes the cheap half of it:** the envelope builder consults the same cached project state it already reads for `telemetryLabelKeys` and drops `attr.profile_id` / `attr.session_id` whose value matches a `profile_id` filter. IP-body filtering is not attempted — a log body is unstructured and scanning it is a redaction feature (open question 6).

#### 4.3 Blocking — one predicate, three statuses, none of them 2xx

Three independent block gates that compose. `subscriptionHook` (`apps/api/src/hooks/subscription.hook.ts`) cannot be reused as-is: it sends its own reply (`reply.status(202).send({blocked:true})`) and types its request body as the track payload. Split it:

```ts
// apps/api/src/services/ingestion-block.ts  (new; subscription.hook.ts refactored onto it)
export type IngestionBlock =
  | { blocked: false }
  | { blocked: true; reason: 'wind_down' | 'kill_switch' | 'telemetry_quota' };

export async function isIngestionBlocked(
  projectId: string,
  signal: 'events' | 'logs',
): Promise<IngestionBlock>;
```

Precedence and semantics:

1. **Telemetry not installed** (`GIGAPIPE_URL` unset, or the boot assertion failed). The routes are **not registered at all** — `01-tenancy-and-security.md` §11's position — so this is a genuine **404**, not a synthesised one, and it is not a value of `IngestionBlock`.
2. `wind_down` (org-level, `Organization.windDownStep ∈ {blocked, final_warning}`) blocks **both** signals and answers **403**.
3. `kill_switch` — the operator brake, `telemetry:disabled:*` (global) or `telemetry:disabled:{projectId}` — blocks telemetry only and answers **503 + `Retry-After: 900`**.
4. `telemetry_quota` — `10-ops-retention-billing.md` §9's shed, evaluated in its quota hook against `Organization.subscriptionPeriodTelemetryLimit` — blocks telemetry only. Metrics, traces and event tracking are governed by the same hook; **event tracking is never shed by a telemetry condition** (`10` §10.3: "telemetry sheds before analytics, always").
5. Lifting one does **not** lift another.
6. `SELF_HOSTED=true` short-circuits 2 and 4 to `{ blocked: false }`, matching `subscription.hook.ts`. It does **not** short-circuit 1 or 3.

**The kill-switch namespace, settled.** Five variants exist across the doc set: `01` §11's `telemetry:ingest:enabled` / `telemetry:read:enabled` (a value means *enabled*), `04` D15's `op:gp:off` / `op:gp:off:<projectId>` (presence means *disabled*, no TTL), `02` §4's `telemetry:disabled:{projectId}` / `telemetry:disabled:*` (presence means *disabled*, mandatory TTL), `06` §15's two env vars, and this document's earlier "unset `GIGAPIPE_READ_URL`". An on-call engineer reading any one of them pulls a lever the other four do not observe. **Adopted: `02`'s namespace and polarity** — presence means disabled — because `10` §10.3 already writes those exact keys and `10` owns the runbook; **`04` D15's read/ingest split**, because `04`'s reasoning is right that a read-path enforcement bug must not stop correctly-stamped ingest; and **`02`'s TTL policy**: mandatory TTL (1 h default, 24 h max) on the per-project key so an emergency block expires rather than being forgotten, no TTL on the global one, because `04` is also right that "a brake that un-pulls itself at 3 a.m. is not a brake" — for the *global* case, which is the one an operator sets during an incident they are watching.

| Route | Blocked response |
|---|---|
| `/telemetry/v1/logs` (wind-down) | `403` + `google.rpc.Status` body naming the reason |
| `/telemetry/v1/logs` (kill switch / quota) | `503` + `Retry-After: 900` + `google.rpc.Status` |
| `/telemetry/loki/api/v1/push` | the same statuses, plain-text body |
| either, telemetry not installed | `404` (route not registered) |
| `/track` (unchanged) | `202 {"blocked":true}` |

**The draft's `200 partialSuccess` and `204 X-OP-Blocked` are deleted** (D16). They make a blocked organization look healthy to its collector: `partialSuccess` means "permanently rejected, do not retry", and a `204` on the Loki route reads as a full write. `06-traces-and-correlation.md` §4.1's 202-and-drop and `11-testing-strategy.md` A15's 429 are the two remaining divergences and both must move to this table.

#### 4.4 OTLP decode

`apps/api/src/telemetry/otlp/` — new, per D14 and `02-ingest-gateway.md` D9 (one directory in `apps/api`, one Prisma seam in `deps.ts`, so a later lift-out into a package is a `git mv`). **`@opentelemetry/otlp-transformer` cannot be used.** Its public contract is `serializeRequest` / `deserializeResponse` over SDK in-memory types with a write-only protobuf writer; there is no wire-request *decoder* in any published version. So we vendor the protos:

```
apps/api/proto/opentelemetry/proto/common/v1/common.proto
apps/api/proto/opentelemetry/proto/resource/v1/resource.proto
apps/api/proto/opentelemetry/proto/logs/v1/logs.proto
apps/api/proto/opentelemetry/proto/collector/logs/v1/logs_service.proto
apps/api/proto/VERSION            # the open-telemetry/opentelemetry-proto tag, pinned
```

loaded with `protobufjs`, added as a **direct** dependency of `apps/api` (plus `long`). Under pnpm's isolated `node_modules` an undeclared transitive import is an immediate `MODULE_NOT_FOUND`, not a latent risk — `protobufjs` reaches the tree today only via `@hyperdx/node-opentelemetry`, and newer OTel releases have dropped it. Prefer `protobufjs@8.x`: its manifest declares `requiresBuild:false`, no install scripts, and a single runtime dependency (`long`).

```ts
const root = protobuf.loadSync(resolve(__dirname,
  '../../proto/opentelemetry/proto/collector/logs/v1/logs_service.proto'));
const ExportLogsServiceRequest = root.lookupType(
  'opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest');
const decoded = ExportLogsServiceRequest.decode(raw);
```

For `application/json` we accept the OTLP-JSON encoding directly (lowerCamelCase field names, `traceId`/`spanId` as hex strings, `*Value` unions). One normaliser, `normaliseAnyValue`, covers both the decoded-protobuf and OTLP-JSON `AnyValue` shapes, mirroring gigapipe's `SanitizeValue` (`otlplogs.go:119+`) for scalar coercion.

**Rejections (permanent, per D13).** A record with no `body`, or a timestamp outside `[now − 7 d, now + 1 h]`, or an envelope that cannot be built, is counted into `rejectedInvalid` rather than failing the batch.

#### 4.5 Mapping, push, delivery and the bulkhead

`apps/api/src/telemetry/logs.controller.ts` calls `packages/gigapipe/src/ingest/logs.ts` (D14):

```ts
export type ILogIngestLine = {
  timestampNs: bigint;
  labels: Record<string, string>;   // sanitised, <=100 UTF-8 bytes, op_project_id stamped
  line: string;                     // the serialised envelope
};

export type IPushResult = {
  accepted: number;
  acceptedBytes: number;            // envelope bytes of accepted lines -- what the meter uses
  failedTransport: number;          // records in sub-batches that failed after retries
  subBatches: number;
};

export async function pushLogs(
  projectId: string,
  lines: ILogIngestLine[],
): Promise<IPushResult>;
```

`pushLogs` groups by serialised label set, builds `{"streams":[{"stream":{…},"values":[["<ns>","<envelope>"],…]}]}`, splits so no request body exceeds **4 MiB uncompressed**, and `POST`s each sub-batch gzip-compressed to `${GIGAPIPE_URL}/loki/api/v1/push` with `Content-Type: application/json`, `Content-Encoding: gzip` and the basic-auth header from `GIGAPIPE_USER`/`GIGAPIPE_PASSWORD` — which must equal `CLOKI_LOGIN`/`CLOKI_PASSWORD` on the container, **not** `QRYN_LOGIN`/`QRYN_PASSWORD`: `CLOKI_*` is assigned after `QRYN_*` in `portEnv` (`cmd/gigapipe/main.go:172-183`), so it wins when both are set, and `10-ops-retention-billing.md` §3 sets `CLOKI_*`. The auth middleware installs **only when both values are non-empty** (`:321-324`) and Compose substitutes a missing `.env` key with the empty string plus a warning, so a name mismatch yields a silently unauthenticated gigapipe on the compose network — serving `/loki/api/v1/push`, the Elastic `POST /_bulk` write routes and the always-on cleartext-HTTP/2 gRPC OTLP receiver to anything that can reach it. `10`'s smoke assertion "unauthenticated `GET /ready` against `op-gigapipe` returns 401" is the only detector for that state and should be a **blocking P0 gate** in `11`, not a smoke row.

**The tuple `pushLogs` builds always has exactly two elements** (I12). This is the whole of the `type ∈ {1,2}` control after D1; assert it on the serialised body.

Timestamps are `bigint` end-to-end. A 2026 nanosecond timestamp is ~1.79e18; `Number` loses precision above 2^53, and the Loki push wants a decimal string anyway, so `String(bigint)` is exact.

Ordering: gigapipe has no per-stream last-timestamp check anywhere in `writer/`, so we push in arrival order.

**The bulkhead the draft was missing.** Rejecting a BullMQ queue is defensible — a pipeline that buffers on our side while gigapipe is down turns a visible outage into silent unbounded memory — but leaving the synchronous path *unbounded* is not, and the draft did. gigapipe's push is genuinely blocking: `IngestParsed` pushes with `INSERT_MODE_SYNC` and then awaits `p.Get()` on every promise (`writer/controller/builder.go:228-256`), resolved only after the writer's batch flush (`BULK_MAX_AGE_MS`, default 100 ms, `cmd/gigapipe/main.go:231-238`) plus the ClickHouse insert. A degraded ClickHouse would otherwise convert each telemetry request into a multi-second held connection in the same Node process that serves `/track`, which has no rate limiter at all.

Four explicit bounds, all constants in `packages/gigapipe/src/ingest/logs.ts`:

| Bound | Value | Behaviour at the limit |
|---|---|---|
| `PUSH_SUBBATCH_TIMEOUT_MS` | 10 000 | `AbortSignal.timeout` on each sub-batch fetch. |
| `PUSH_REQUEST_DEADLINE_MS` | 25 000 | One deadline over the whole request. At the deadline, everything not yet accepted counts as `failedTransport` → 503. |
| `PUSH_SUBBATCH_CONCURRENCY` | 4 | Sub-batches go in bounded-parallel batches of 4, not sequentially and not all at once. Retries are 2 attempts at 200 ms / 600 ms, per sub-batch, independently. |
| `PUSH_MAX_INFLIGHT_PER_PROCESS` | 32 | A process-level semaphore over in-flight gigapipe pushes. Over it the route **fast-fails `503` + `Retry-After: 2`** rather than queueing a held connection. |

Plus a circuit breaker: after `PUSH_BREAKER_THRESHOLD = 20` consecutive sub-batch failures the breaker opens for 10 s and every push returns `503` immediately without touching the socket, halving to closed on the first success after the window. The breaker's state is a gauge (§"Pipeline observability").

**Ingestion is at-least-once, and this must be documented in-product.** A retry after a lost response, or an exporter resend after a 503, writes the already-accepted sub-batches a second time. There is no dedupe downstream: `samples_v3` is a plain `MergeTree` (`log.sql:25-32`), unlike `time_series`/`time_series_gin`, which are `ReplacingMergeTree`. The explorer's content-key dedupe (D10) collapses exact duplicates *within a rendered window* — which covers the common case of a duplicated sub-batch landing at the same nanosecond — but it is a display affordance, not a storage guarantee, and the meter counts both copies.

#### 4.6 Metering — write `10`'s Redis contract, define no model

*Revised.* The draft defined `model TelemetryUsage` with `(projectId, signal, granularity, hour)`, an hourly flush cron and a 30-day rollup. Three documents defined three incompatible metering models, and `10-ops-retention-billing.md` §8.3's rollup code would not compile against `08-schema-changes.md` §4's schema. **`08` owns Prisma declarations and `10` owns metering semantics**, so this document owns neither. It owns exactly one thing: incrementing the right counter with the right number at the right moment.

**The number.** The meter increments from `IPushResult.accepted` / `acceptedBytes`, **after** the push returns. The draft metered what was *sent* while allowing sub-batches to fail, which bills a customer for lines gigapipe refused. `10` D21 reaches the same conclusion independently ("the gateway meters after a successful forward"), so this is settled twice.

**The keys.** `10` §8.2's Redis contract, not a local invention:

```ts
const result = await pushLogs(projectId, lines);
// 10 §8.2 owns the key shapes and the day-set membership key the rollup reads.
await recordTelemetryUsage(projectId, {
  logsRecords: result.accepted,
  logsBytes:   result.acceptedBytes,
});
```

**The model.** `08`'s `TelemetryUsageDaily`, keyed once — `(projectId, day)` with `organizationId` denormalised, or `(organizationId, projectId, day)`; one of them, written once — with `10` §8.3's field list, which needs both `metricSamples` and `metricDatapoints` per `10` D11's fan-out argument. `model TelemetryUsage`, `enum TelemetrySignal` and `enum TelemetryGranularity` are **deleted from this document**, and so is the hourly grain: nothing else consumes it, and `10`'s rollup is idempotent by a different and better mechanism — it recomputes the whole day and overwrites, rather than incrementing, so the `granularity`-in-the-unique-key hazard the draft solved cannot arise. **This is one migration and one person must land it.**

We meter the **envelope** bytes, i.e. exactly what lands in `samples_v3.string` (open question 8). That is this document's input to `10`'s unit weights, not a billing decision.

#### 4.7 Cron registration — one cron, in a shared inventory

*Revised.* The draft registered three: `telemetryUsage` (`5 * * * *`), `telemetryRetention` (`15 3 * * *`) and `telemetryReconcile` (`45 3 * * *`). Two of those names and jobs belong to `10-ops-retention-billing.md` §6.2, which registers `telemetryRetention` (`10 */6 * * *`, the TTL re-assert) and `telemetryUsageRollup` (`20 1 * * *`). **`telemetryRetention` was the same name for two different jobs**, and `apps/worker/src/boot-cron.ts` removes every scheduler not in its `jobs` array (`boot-cron.ts:138-155`) — so whichever landed second would silently unschedule the first. `07-alerting.md` A31 correctly calls that "the worst failure an alerting system has".

**This document registers one cron:** `telemetryReconcile`, daily at `'45 3 * * *'`, which produces the settings card's stored snapshot (§8.3) — active streams, the top-10 by bytes, and the label-cardinality figures that D8 moved off `/detected_labels`. `45 3` is free against `10` §6.2's inventory of existing slots (`0 2` insightsDaily, `0 3` gscSync, `0 4` sessionVacuum, `30 4` insightCleanup, `30 7` dataHealth, `0 8` Mon weeklyDigest, hourly `0 *` delete/onboarding/windDown) and against `10`'s own two.

Adding it takes the same three coordinated edits any cron does, and the draft named the crons without naming the edits:

1. `packages/queue/src/queues.ts` — a `CronQueuePayloadTelemetryReconcile` member of the `CronQueuePayload` union (the union ends at `queues.ts:209`).
2. `apps/worker/src/jobs/cron.ts` — a `case` in the `cronJob` switch (`cron.ts:26-89`).
3. `apps/worker/src/boot-cron.ts` — an entry in the `jobs` array (`boot-cron.ts:30-124`), guarded on `process.env.GIGAPIPE_URL` exactly the way `10` §6.2 guards its two and the way the existing `ping` job is guarded (`:128-134`).

**Request to the blueprint.** Five documents add crons to these same three files — this one, `10` §6.2 (two), `07` D7 (`metricAlerts`, 60 s, plus a new `alerts` BullMQ queue), `01` §Detection(b) (`cron.telemetry-tenancy-probe.ts`, every 15 minutes) and `06` §11.7 (a weekly orphan sweep). **One cron inventory belongs in `00-blueprint.md`** — name, type, schedule, owning document, file — and `11-testing-strategy.md` §7.2's exhaustive registration test should assert against it rather than against each document's local list. `boot-cron.ts`'s remove-what-is-not-listed behaviour makes a partial landing silently destructive, and it is also the backout mechanism: reverting the file cleans up its own schedulers with no manual step.

Two properties of the cron worker worth writing down. It is a shared BullMQ worker, so a job must finish inside its lock — a job that **submits** ClickHouse mutations and returns is fine, one that polls a mutation to completion is not. And `10` §6.2's `telemetryRetention` is where the nightly TTL assertion lives (§7.3); this document does not duplicate it.

### 5. The query spec, its compiler, and the read path

#### 5.1 `packages/validation/src/logs.validation.ts` (new)

```ts
import { z } from 'zod';
import { zRange } from './index';

/** Label names gigapipe will accept, post-sanitisation. */
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
/** Envelope field paths: `body`, `sev`, `tid`, `attr.http_status_code`. */
const FIELD_PATH = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$/;
/**
 * gigapipe's unquoted numeric label-filter value, EXACTLY:
 *   NumVal string `| @(Integer "."? Integer*)`   -- logql_parser/model.go:249-254
 * No sign, no exponent, no text. Anything else is either a parse failure
 * surfaced as a 500 or an arbitrary LogQL fragment spliced into the query.
 */
const NUM_VAL = /^[0-9]+(\.[0-9]+)?$/;

/**
 * Reserved: never accepted in a user matcher, never a promotable label key,
 * never a key in a context label map. `level` is reserved because `severity`
 * already compiles to a `level=~"…"` matcher, and gigapipe AND-s selector
 * clauses through a bit-set HAVING (planner_stream_select.go:67-80) — a user
 * matcher `level!="error"` alongside `severity:['error']` produces a silently
 * unsatisfiable query with no explanation.
 */
export const RESERVED_LOG_LABELS = ['op_project_id', 'source', 'level'] as const;

export const logSeverities = ['trace','debug','info','warn','error','fatal'] as const;
export const zLogSeverity = z.enum(logSeverities);
export type ILogSeverity = z.infer<typeof zLogSeverity>;

export const zLogStreamMatcher = z.object({
  label: z.string().regex(LABEL_NAME).max(64)
    .refine((v) => !RESERVED_LOG_LABELS.includes(v as never), 'reserved label'),
  // No `notMatches`. The selector `!~` IS correct in gigapipe
  // (planner_stream_select.go:59-61 uses IntVal(0)), but `packages/constants`
  // `operators` carries no negated-regex entry, so there is no UI source for it
  // and the operator would be reachable only from a hand-edited URL.
  operator: z.enum(['is', 'isNot', 'matches']),
  // `.*` is rejected outright: gigapipe deletes such a matcher from the selector.
  value: z.string().min(1).max(200).refine((v) => v !== '.*', 'use no matcher instead'),
});

export const zLogLineFilter = z.object({
  // No `notMatches`: gigapipe compiles a `!~` LINE filter as a POSITIVE match
  // for any non-literal pattern (upstream bug, §"Upstream bugs").
  // No `matchesPattern`: the pattern panel that is its only source is P6 (D8).
  operator: z.enum(['contains', 'notContains', 'matches']),
  value: z.string().min(1).max(512),
});

export const zLogFieldFilter = z.object({
  field: z.string().regex(FIELD_PATH).max(128),
  // Label-filter negation IS correct: planner_label_filter uses Neq for `!=`
  // and IntVal(0) for `!~`. Only the LINE filter is broken.
  operator: z.enum(['is','isNot','contains','notContains','matches','gt','gte','lt','lte']),
  value: z.string().max(512),
}).superRefine((f, ctx) => {
  // The ordered operators emit the UNQUOTED numeric form (`| f0 > 500`), which
  // step 5's q() escaping does not cover. Constrain the value to gigapipe's
  // NumVal grammar at the schema, not in the compiler.
  if (['gt','gte','lt','lte'].includes(f.operator) && !NUM_VAL.test(f.value)) {
    ctx.addIssue({ code: 'custom', path: ['value'],
      message: 'numeric comparison requires an unsigned decimal number' });
  }
});

/**
 * BASE object, deliberately unrefined.
 *
 * Every derived schema (`zSavedLogQueryDefinition`, the histogram input) is
 * built from THIS, and re-applies `withWindow` explicitly. The draft used
 * `zLogQuery.innerType().omit(...)` in one place (Zod 3 ZodEffects semantics)
 * and `zLogQuery.pick(...).extend(...)` in another (Zod 4 semantics); the repo
 * pins `zod: ^4.1.8` (pnpm-workspace.yaml:77), so exactly one of them compiled.
 * Deriving from an unrefined base is correct under BOTH majors and removes the
 * question of whether a refinement survives `.omit()`.
 */
export const zLogQueryBase = z.object({
  projectId: z.string(),
  stream:    z.array(zLogStreamMatcher).max(10).default([]),
  severity:  z.array(zLogSeverity).max(6).default([]),
  line:      z.array(zLogLineFilter).max(5).default([]),
  fields:    z.array(zLogFieldFilter).max(5).default([]),
  range:     zRange.optional(),
  startDate: z.string().optional(),
  endDate:   z.string().optional(),
  direction: z.enum(['backward', 'forward']).default('backward'),
  limit:     z.number().int().min(1).max(1000).default(200),
});

const withWindow = <T extends z.ZodTypeAny>(s: T) => s.refine(
  (q: any) => !!q.range || (!!q.startDate && !!q.endDate),
  'either range, or both startDate and endDate, is required',
);

export const zLogQuery = withWindow(zLogQueryBase);

export const zLogCursor = z.object({
  /** Exclusive upper ns bound for the next page, as a decimal string. */
  endNs: z.string(),
  /** True when the previous page could not advance; see §5.4. */
  skipBoundarySecond: z.boolean().default(false),
});
export type ILogCursor = z.infer<typeof zLogCursor>;

/** The three inputs the draft's router sketch referenced and never defined. */
export const zLogLabelsInput = z.object({
  projectId: z.string(),
  stream:    z.array(zLogStreamMatcher).max(10).default([]),
  range:     zRange.optional(),
  startDate: z.string().optional(),
  endDate:   z.string().optional(),
});

export const zLogLabelValuesInput = zLogLabelsInput.extend({
  // Validated against LABEL_NAME because it is interpolated into a PATH
  // SEGMENT of '/loki/api/v1/label/{name}/values'. encodeURIComponent is
  // applied on top by the client; the regex is what makes it safe.
  name: z.string().regex(LABEL_NAME).max(64),
});

export const zLogContextInput = z.object({
  projectId:   z.string(),
  timestampNs: z.string().regex(/^[0-9]{1,20}$/),
  /**
   * The line's own label map, echoed back from the response. Reserved labels
   * are rejected here too — this is the one place a user can put arbitrary
   * label NAMES into a selector (I4).
   */
  labels: z.record(
    z.string().regex(LABEL_NAME).max(64)
      .refine((k) => !RESERVED_LOG_LABELS.includes(k as never), 'reserved label'),
    z.string().max(200),
  ),
  direction: z.enum(['backward', 'forward']),
  limit: z.number().int().min(1).max(100).default(25),
});

export type ILogQuery = z.infer<typeof zLogQuery>;
export type ILogStreamMatcher = z.infer<typeof zLogStreamMatcher>;
export type ILogLineFilter = z.infer<typeof zLogLineFilter>;
export type ILogFieldFilter = z.infer<typeof zLogFieldFilter>;
```

`zLogQuery` reuses `zRange` (`packages/validation/src/index.ts:169`) and therefore `getChartStartEndDate` (`packages/db/src/services/date.service.ts`) and the existing `TimeWindowPicker`, so the logs page inherits the product's time-range vocabulary.

**But the window is clamped server-side.** `zRange` spans `timeWindows` (`packages/constants/index.ts`), which includes `3m`, `6m`, `12m`, `lastYear` and `yearToDate`. Against a 30-day store, a reader with no `max_execution_time` (I10, verified) and a sort key that may not prune by tenant, "Last 12 months" with a `|~` line filter is a cluster-wide incident that returns nothing:

```ts
// packages/db/src/gigapipe/retention.ts
/**
 * P3: a constant, equal to the SAMPLES_DAYS the env manifest pins.
 * There is no per-plan telemetry retention field on Organization or Project
 * today (the subscription block carries subscriptionPeriodEventsLimit /
 * subscriptionPeriodEventsCount and nothing telemetry-shaped), and inventing
 * one is a P6 billing item. Named here so nobody invents it on day one of P3.5.
 */
export const PLAN_DEFAULT_RETENTION_DAYS = 30;

export const effectiveRetentionDays = (p: { telemetryLogRetention: number | null }) =>
  Math.min(p.telemetryLogRetention ?? PLAN_DEFAULT_RETENTION_DAYS, SAMPLES_DAYS);
```

```ts
const retentionDays = effectiveRetentionDays(project);
const floorNs = BigInt(Date.now() - retentionDays * 86_400_000) * 1_000_000n;
const clampedToRetention = startNs < floorNs;
startNs = clampedToRetention ? floorNs : startNs;
```

The `min()` against `SAMPLES_DAYS` is the backstop; the settings mutation that writes `telemetryLogRetention` **rejects** a value above `SAMPLES_DAYS` with a message naming the global store window, because retention longer than the global TTL is not supported and a clamp that silently shows an empty window with `clampedToRetention: false` is worse than an error at the point of configuration.

Every procedure returns `{ clampedToRetention: boolean }` so the UI can say "showing the last 30 days — your retention". The page's `TimeWindowPicker` also hides windows longer than the effective retention; the server clamp is the enforcement.

#### 5.2 `packages/db/src/gigapipe/logql.ts` (new)

```ts
export type ICompiledLogQL = {
  /** Full pipeline, for query_range / query. */
  query: string;
  /** Selector only, for /series and /label/{name}/values. Never empty. */
  selector: string;
  /** Selector + line filters, no parser. `groupBy: 'level'` emits `sum by (level)`. */
  countQuery: (stepMs: number, groupBy?: 'level') => string;
  startNs: bigint;
  endNs: bigint;
  clampedToRetention: boolean;
};

export function compileLogQuery(
  input: ILogQuery,
  opts: { timezone: string; retentionDays: number },
): ICompiledLogQL;
```

**Step 0 — resolve the window.** `getChartStartEndDate({range, startDate, endDate}, timezone)` produces naive project-local `'yyyy-MM-dd HH:mm:ss'` strings; convert to UTC nanoseconds using the project timezone, then apply the retention clamp above.

**Step 1 — selector.** `op_project_id="<projectId>"` first, always, with a `"`-escaped value (a project id is a uuid, but escape anyway). Then each `stream` matcher, mapped `is → =`, `isNot → !=`, `matches → =~`. Then, if `0 < severity.length < 6`, `level=~"error|fatal"` — one alternation rather than N matchers, because gigapipe AND-s selector clauses via a bit-set `HAVING` (`planner_stream_select.go:67-80`). `compileLogQuery` **throws** (never emits) if `projectId` is empty or falsy.

**Regex anchoring.** gigapipe's `=~` compiles to `match(col, pattern)` (`sql_misc.go:18-34`), which is **unanchored** — a *search*, not Loki's fully-anchored label match. The compiler therefore **wraps a user-supplied `matches` value in `^(?:…)$`** for stream matchers, so the product's "Matches" operator means what a user coming from Loki or Grafana expects. `level=~"error|fatal"` is emitted by the compiler itself and is left unanchored deliberately (`level` is a closed six-value set, so it cannot over-match). A compiler test pins both.

**Step 2 — line filters**, immediately after the selector and before any parser, so they compile to `like`/`match` on `samples.string` inside the same scan (`planner_line_filter.go:106-120`).

| `zLogLineFilter.operator` | LogQL | gigapipe compiles to |
|---|---|---|
| `contains` | `\|=` | `like(samples.string, '%…%')` |
| `notContains` | `!=` | `notLike(samples.string, '%…%')` |
| `matches` | `\|~` | `match(string, …) = 1`, or `like`/`ilike` when the regex parses to a plain literal (`re2Like`, `planner_line_filter.go:122-131`) |

`notMatches → !~` is **absent on purpose, and this is an upstream bug we must not step in.** `buildSimpleCondition` case `"!~"` falls through to `sql.Eq(&SqlMatch{col: "string", pattern: val}, sql.NewIntVal(1))` — byte-identical to the `"|~"` case — and only the `re2Like()` plain-literal shortcut takes the `notLike` path (`planner_line_filter.go:80-93` vs `:66-79`). So "does not match `<regex>`" returns exactly the lines that DO match. Compare `planner_stream_select.go:59-61`, which correctly uses `sql.NewIntVal(0)` for a selector `!~`.

A **line** `matches` value is left unanchored — it is an explicit free-text regex search over the serialised line and anchoring it would make it useless — but the search box labels it **"Matches (search)"** so the asymmetry with the selector's anchored "Matches" is visible rather than surprising.

Escaping, per operator:

- `contains` / `notContains`: JSON-fragment-escape the value before quoting — `JSON.stringify(v).slice(1, -1)` — because the stored line is a JSON envelope, so a user searching for `he said "no"` is really searching for `he said \"no\"`.
- `matches`: no escaping (it is a regex over the serialised line and the user is opting into that), but reject patterns longer than 512 chars and reject nested unbounded quantifiers (`/\(.*[+*]\)[+*]/`) as a ReDoS guard — see I10.

**A known gigapipe mangling, pinned by test rather than worked around.** `doLike` SQL-quotes the value with `StringVal.String` — which escapes `'` → `\'` and wraps the result in `'…'` (`reader/utils/sql_select/objects.go:262-275`) — and then does `strings.Trim(enqVal, "'")`, stripping **all** leading and trailing single quotes (`planner_line_filter.go:106-118`), before escaping `%` and `_`. A `contains` search for `'quoted'` therefore emits a different, over-broad pattern with a stray escaped `%`. It is not an injection — the value is still escaped — but it is a silently wrong result set. `logql.test.ts` carries a leading/trailing-apostrophe case so the behaviour is pinned rather than rediscovered.

**Step 3 — parser**, only when `fields.length > 0`, and always with explicit paths: `| json f0="attr.http_status_code", f1="tid"`. **Never a bare `| json`.** A bare `| json` or `| logfmt` sets a *breakpoint* in the transpiler which moves the rest of the pipeline out of ClickHouse into gigapipe's RAM; explicit paths compile to `mapFromArrays` over `JSONExtract*` and stay in SQL (`clickhouse_planner/planner_parser_json.go:11-71`).

**Step 4 — field filters** as label filters over the synthesised `f0..fN` names: `| f0 = "500" and f1 =~ "^4bf9"`.

| operator | emitted | note |
|---|---|---|
| `is` / `isNot` | `f0 = "…"` / `f0 != "…"` | quoted via step 5's `q()` |
| `contains` / `notContains` | `f0 =~ "…"` / `f0 !~ "…"` | value regex-escaped; **unanchored on purpose** — that is what makes the mapping mean "contains" (`planner_label_filter.go:141-155`) |
| `matches` | `f0 =~ "…"` | wrapped in `^(?:…)$`, same rule as the stream selector |
| `gt` / `gte` / `lt` / `lte` | `f0 > 500` — **unquoted** | value already constrained to `NUM_VAL` by the schema; `q()` is not applied and does not need to be |

**Step 5 — escaping.** Every quoted string is emitted through `q(s) = '"' + s.replace(/\\/g,'\\\\').replace(/"/g,'\\"') + '"'`. gigapipe's `QuotedString.Unquote` is `json.Unmarshal` over the token, so JSON escaping is exactly right at the LogQL layer. The numeric form deliberately bypasses `q()`, which is why the schema constraint above is load-bearing rather than defence in depth.

**Worked example.** Input:

```jsonc
{ "projectId": "9f1c…",
  "stream": [{"label":"service_name","operator":"is","value":"checkout"}],
  "severity": ["error","fatal"],
  "line": [{"operator":"contains","value":"timeout"}],
  "fields": [{"field":"attr.http_status_code","operator":"is","value":"500"}],
  "range": "last24h", "limit": 200 }
```

`query`:

```logql
{op_project_id="9f1c…",service_name="checkout",level=~"error|fatal"} |= "timeout" | json f0="attr.http_status_code" | f0 = "500"
```

`selector`:

```logql
{op_project_id="9f1c…",service_name="checkout",level=~"error|fatal"}
```

`countQuery(60000)`:

```logql
sum(count_over_time({op_project_id="9f1c…",service_name="checkout",level=~"error|fatal"} |= "timeout" [60000ms]))
```

`countQuery(60000, 'level')`:

```logql
sum by (level) (count_over_time({op_project_id="9f1c…",service_name="checkout"} |= "timeout" [60000ms]))
```

`countQuery` deliberately omits the parser and the field filters. The 15-second rollup shortcut (`AnalyzeMetrics15sShortcut`, `clickhouse_planner/analyze.go:99-133`) applies only when the function is `rate` or `count_over_time`, the range is ≥ 15 s, and the pipeline contains no parser, no `drop`/`keep`/`unwrap`, and no line filter with content. We keep the line filters — a histogram that ignores the user's search is a lie — but drop the parser stage, which buys nothing for a count and costs a `JSONExtract` per row. With no line filters at all the histogram is served straight off `metrics_15s` and is effectively free.

`bytes_over_time` is never used for the histogram: it is not in the shortcut's function list, so it always scans. A "bytes" toggle exists in the UI, is documented as slower, and is capped to a 24 h window.

#### 5.3 The gigapipe client and the tRPC router

`packages/db/src/gigapipe/client.ts` (owned by P0; logs, metrics and traces all import it):

```ts
const GIGAPIPE_READ_URL  = process.env.GIGAPIPE_READ_URL;   // undefined => telemetry disabled (D12)
const GIGAPIPE_WRITE_URL = process.env.GIGAPIPE_WRITE_URL ?? GIGAPIPE_READ_URL;

/** Exact-path allowlist. Nothing else is ever requested. */
const READ_PATHS = [
  '/loki/api/v1/query_range',
  '/loki/api/v1/query',
  '/loki/api/v1/series',
  '/loki/api/v1/label/{name}/values',
  '/loki/api/v1/index/stats',
  '/loki/api/v1/index/volume',      // requires LOG_DRILLDOWN
  '/loki/api/v1/detected_labels',   // requires LOG_DRILLDOWN
] as const;
```

`gigapipeGet(path, params, { timeoutMs, signal })` builds the URL with `URLSearchParams`, sets only `Authorization` and `Accept`, and uses `AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])` (default **20 000**). Paths are forwarded canonically, over GET only. **`step` is always emitted as `` `${stepMs}ms` ``** — a bare number is seconds (§1.3). `{name}` is filled with `encodeURIComponent(name)` after the value has already passed `LABEL_NAME`. **Passing the caller's abort signal through is mandatory, not optional:** a cancelled tRPC request must cancel the upstream fetch, or a user hammering the brush leaves N unbounded scans running against a reader with no `max_execution_time`.

Error mapping: gigapipe answers `PromError(code, msg, w)` for both 400 and 500. 4xx → `TRPCError BAD_REQUEST` carrying gigapipe's message; 5xx and timeouts → `INTERNAL_SERVER_ERROR` with a generic message and the real one in the pino log. A **405** means we sent a method the route does not register — a bug, logged at error. A **404** on `/index/volume` or `/detected_labels` means `LOG_DRILLDOWN` is off on the deployed container; surface it as `PRECONDITION_FAILED` with an operator-facing message, and never use it as a feature probe (whether an unmatched path is 404 or 401 depends on gigapipe's basic-auth config).

`packages/trpc/src/routers/logs.ts` (new). Every procedure is `protectedProcedure`, which runs `enforceAccess` → `requireProjectAccess({ level: 'read' })` for any input carrying a top-level `projectId` (`packages/trpc/src/trpc.ts:90-125`, `:175-180`). `op_project_id` injection is the *second* line of defence, not the first.

```ts
const telemetryGate = t.middleware(({ next }) => {
  if (!isTelemetryEnabled()) {          // D12
    throw new TRPCError({ code: 'PRECONDITION_FAILED',
      message: 'Telemetry is not configured on this deployment.' });
  }
  return next();
});

export const logsRouter = createTRPCRouter({
  query: protectedProcedure.use(telemetryGate)
    .use(rateLimitMiddleware({ max: 60, windowSeconds: 60 }))       // -> ILogPage
    .input(zLogQueryBase.extend({ cursor: zLogCursor.nullish() }).superRefine(windowRule))
    .query(...),
  histogram: protectedProcedure.use(telemetryGate)
    .use(cacheMiddleware(15))                                       // -> ILogHistogram
    .input(zLogQueryBase.pick({ projectId:true, stream:true, severity:true, line:true,
                                range:true, startDate:true, endDate:true })
           .extend({ stackByLevel: z.boolean().default(false) }).superRefine(windowRule))
    .query(...),
  labels:         protectedProcedure.use(telemetryGate).use(cacheMiddleware(15))
                    .input(zLogLabelsInput).query(...),
  labelValues:    protectedProcedure.use(telemetryGate).use(cacheMiddleware(15))
                    .input(zLogLabelValuesInput).query(...),
  detectedFields: protectedProcedure.use(telemetryGate)
                    .use(rateLimitMiddleware({ max: 20, windowSeconds: 60 }))
                    .input(zLogQuery).query(...),
  context:        protectedProcedure.use(telemetryGate).input(zLogContextInput).query(...),
});
```

Registered in the app router next to `chartRouter`. There is no `shareId` path for logs in P3, so this is plain `protectedProcedure` — **not** modelled on `overviewProcedure`, whose entire purpose is share validation.

**Read concurrency is bounded, and the draft did not bound it.** F8 claimed "the settings profile is the only bound", but the profile bounds a *single* query. `rateLimitMiddleware` exists (`packages/trpc/src/trpc.ts:135-141`) and is applied to no `logs.*` procedure in the draft; caching is deliberately absent on `logs.query`; the detected-fields panel fires a second full 500-line query; and the histogram brush re-runs `logs.query` and `logs.histogram` together. A read-level member holding the refresh key issues unbounded parallel 30-day scans against the ClickHouse that also serves event analytics. Three bounds together: `rateLimitMiddleware` on `query` and `detectedFields` as above; `max_concurrent_queries_for_user` in the `gigapipe_reader` profile (§7.4); and abort-signal pass-through in the client.

Caching is deliberately **absent on `logs.query`**: a log explorer that serves a 60-second-old page while the user watches a deploy is worse than a slow one. Note also that `cacheMiddleware` **writes** the key always but only **serves** from it when `process.env.NODE_ENV === 'production'` (`packages/trpc/src/trpc.ts:210`). Anything that leans on the 15-minute cache as a *protection* — the settings card's `/index/stats` and `/index/volume` calls — is therefore unprotected in staging and in any self-host running a non-production `NODE_ENV`. That is why the settings card reads a stored daily snapshot from Postgres rather than calling gigapipe live (§8).

The cache key is `trpc:${path}:` plus the raw input (`trpc.ts:200-210`) and contains `projectId`, so tenants cannot collide — and that is a constraint on every future `logs.*` input shape: **`projectId` must be present in the raw input of any cached telemetry procedure**, or the cache leaks across tenants.

**Access level is a decision, not an inheritance:** logs are readable by any project member with `read`. Server logs routinely carry more than product events do — auth failures with usernames, stack traces, `attr.user_id`. We accept read-level as the bar in P3 because a narrower level means touching `ProjectAccess` (`schema.prisma:330-343`) and every membership UI, and because the same members can already read the events those logs describe. Revisit if a design partner asks.

**Which gigapipe endpoint serves what:**

| Procedure | gigapipe call | Notes |
|---|---|---|
| `logs.query` | `GET /loki/api/v1/query_range?query&start&end&limit&direction` | `limit = input.limit + 1` to detect "more". |
| `logs.histogram` | `GET /loki/api/v1/query_range?query=<countQuery>&step=<n>ms` | matrix result. |
| `logs.labels` | `GET /loki/api/v1/detected_labels?query=<selector>` | never `/labels` (I7). Returns `{label, cardinality}`. |
| `logs.labelValues` | `GET /loki/api/v1/label/<name>/values?match[]=<selector>&start&end` | exactly one `match[]`, **throws on zero** (I5). |
| `logs.detectedFields` | *none* — computed from a `logs.query` sample | gigapipe's endpoint is a stub (D7). |
| `logs.context` | `GET /loki/api/v1/query_range` ×2 | §6.5. |
| usage reconciliation | `GET /loki/api/v1/index/stats?query=<selector>` | daily, from the worker, not per project per hour (§8). |

#### 5.4 Line identity and pagination

**Identity.**

```ts
// packages/db/src/gigapipe/logs.parse.ts
const streamHash = (labels: Record<string,string>) =>
  sha1(JSON.stringify(Object.entries(labels).sort())).slice(0, 16);

/** Stable across requests. Two byte-identical lines on one stream at one ns
 *  share a contentKey -- that is correct, they are indistinguishable. */
export const contentKey = (sh: string, ts: string, line: string) =>
  `${sh}:${ts}:${sha1(line).slice(0, 8)}`;

/** `id` = `${contentKey}#${occurrence}`, assigned after the merge-sort.
 *  Unique within a page; used as the React key. */
```

**Pagination.** `zLogCursor` is a single bound. There is no `seen` array on the wire — the client already holds every row it needs to dedupe against.

Because `To` is floored to a whole second (`reader/service/query_range.go:550-551`) and the predicate is `Lt` not `Le` (`planner_main_init.go:44`), the client computes the next `endNs` as **the end of the boundary second**:

```ts
const SEC = 1_000_000_000n;
const floorSec = (ns: bigint) => (ns / SEC) * SEC;
const nextEndNs = floorSec(oldestNs) + SEC;   // includes the whole boundary second
```

and drops rows it already holds using a **multiset** of the previous page's boundary-second rows:

```ts
const boundary = new Map<string, number>();   // contentKey -> count already rendered
for (const l of previousPage)
  if (floorSec(BigInt(l.timestampNs)) === floorSec(oldestNs))
    boundary.set(l.contentKey, (boundary.get(l.contentKey) ?? 0) + 1);

const fresh = nextPage.filter((l) => {
  const n = boundary.get(l.contentKey);
  if (!n) return true;
  boundary.set(l.contentKey, n - 1);          // drop at most `n` occurrences
  return false;
});
```

A set would drop genuine duplicate lines; the multiset does not, and it is order-independent, which matters because ClickHouse does not guarantee a stable order among rows tied on `(fingerprint, timestamp_ns)`.

**The stall, stated rather than hidden.** The `LIMIT` is a global top-N on `timestamp_ns` (`planner_main_limit.go:12-21`) and the window is second-granular *in the planner*, not in the parameter — there is no sub-second bound to escape with. If the boundary second contains ≥ `limit` matching rows (default 200; a project at 1k lines/s hits this constantly), the next page returns exactly the same top-N, `fresh` is empty, and every older line is unreachable.

```ts
if (page.rows.length === limit && fresh.length === 0) {
  // Force-advance past the boundary second. Lines in that second below the
  // top-N are SKIPPED, and the UI must say so.
  cursor = { endNs: String(floorSec(oldestNs)), skipBoundarySecond: true };
}
```

The list then renders a persistent inline marker at that position:

> **⚠ 2026-08-29 12:04:11 — more than 200 matching lines in this second.**
> Paging skipped the rest of it. Narrow the selector, add a line filter, or click here to zoom into this second.

Clicking the marker sets `startDate`/`endDate` to that single second, which is a fresh query whose top-N *is* the whole second up to `limit`, and repeats one level down. That is the honest UI for a limitation we cannot engineer away without a gigapipe patch.

Forward paging (`direction: 'forward'`, used by context expansion) is the mirror image, using `floorSec(newestNs)` as the next `startNs` — and it inherits the same flooring hazard in the other direction, which is why the same force-advance branch exists for it.

#### 5.5 Response shaping

```ts
export type IServiceLogLine = {
  id: string;              // `${contentKey}#${occurrence}` -- unique within a page
  contentKey: string;
  timestampNs: string;     // decimal string; never a JS number
  timestamp: Date;         // ms precision, for formatting
  /** `op_project_id` REMOVED (I4). `source` is KEPT -- see below. */
  labels: Record<string,string>;
  severity: ILogSeverity;
  body: string;
  traceId?: string;
  spanId?: string;
  attributes: Record<string,string>;
  /** The raw envelope, for "copy as JSON" and for envelopes we failed to parse. */
  raw: string;
};

export type ILogPage = {
  lines: IServiceLogLine[];
  hasMore: boolean;
  cursor: ILogCursor | null;
  clampedToRetention: boolean;
};

export type ILogHistogram = {
  /** IChartSerie[] -- one serie unstacked, one per level when stacked. */
  series: IChartSerie[];
  step: number;            // ms, so the UI can label the bucket width
  clampedToRetention: boolean;
};
```

**`source` is no longer stripped, and that is a correctness fix, not a relaxation.** The draft stripped both `op_project_id` and `source` from every response label map, and then built context expansion from "the line's own full label set" claiming it "pins one exact fingerprint". Those two statements contradict each other: with `source` missing, a rebuilt selector matches every fingerprint that differs only in that label, so a project ingesting via both OTLP and Loki push with otherwise identical labels gets two streams silently interleaved in its context view. `source` is not a boundary label — only `op_project_id` is — so it stays in the map and the context selector really does pin one fingerprint.

`parseStreamsResponse` flattens `data.result[]`, merge-sorts by `timestampNs` descending (the payload is grouped by stream, §1.3), assigns `contentKey` and `id`, strips `op_project_id` from every label map (I4), and tolerates a line that is not our envelope — an unparseable line, or one carrying a `v` we do not know (§3.2), yields `{ body: raw, severity: 'info', attributes: {} }` so a hand-written `curl` push still renders.

Superjson is the tRPC transformer, so `Date` survives. `timestampNs` stays a string; the UI never needs arithmetic on it beyond comparison.

**Histogram shaping.** `logs.histogram` returns real `IChartSerie[]` (`packages/validation/src/types.validation.ts:89-103`) so `useRechartDataModel` (`apps/start/src/hooks/use-rechart-data-model.ts:19-52`) is reused unchanged:

```ts
function toSeries(matrix: PromMatrix, stepMs: number, tz: string): IChartSerie[] {
  return matrix.result.map((r) => {
    const name = r.metric.level ?? 'lines';
    const data = r.values.map(([tsSec, v]) => ({
      // 'yyyy-MM-dd HH:mm:ss', naive project-local -- the same date invariant the
      // metrics work-stream established. use-rechart-data-model consumes it by
      // string equality for grid alignment AND by `new Date(date).getTime()` for
      // x-axis position, so an ISO-with-Z emission passes the first check and
      // silently misplaces every point.
      date: formatInTimeZone(new Date(tsSec * 1000), tz, 'yyyy-MM-dd HH:mm:ss'),
      count: Number(v),
      previous: undefined,
    }));
    return { id: `logs:${name}`, names: [name], event: { name },
             metrics: computeMetrics(data), data };
  });
}
```

Two consequences worth stating. gigapipe emits non-finite values as the strings `NaN`, `+Inf`, `-Inf` via `strconv.FormatFloat`; `computeMetrics` must coerce them to `0` before they reach `sum`, which is the series sort key. And the series must be **dense** on the same grid — zero-fill every step in the window, because `useRechartDataModel` builds the x-axis from `series[0].data` and matches by exact string equality.

### 6. The explorer

Route: `apps/start/src/routes/_app.$organizationId.$projectId.logs.tsx`, following `_app.$organizationId.$projectId.sessions.tsx` (file-based route, `PageContainer` + `PageHeader`, `useInfiniteQuery` on a tRPC procedure). Sidebar entry in `apps/start/src/components/sidebar-project-menu.tsx` between Events (`:67`) and Sessions (`:68`), **rendered only when `telemetryEnabled`** (D12):

```tsx
{telemetryEnabled && <SidebarLink href={'/logs'} icon={ScrollTextIcon} label="Logs" />}
```

`PAGE_TITLES.LOGS = 'Logs'` in `apps/start/src/utils/title.ts:78-95`.

#### 6.1 Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│ PageHeader "Logs"                    [TimeWindowPicker] [Follow ○]    │
├──────────────────────────────────────────────────────────────────────┤
│ LogSelectorBuilder:  service_name = checkout ×   severity: error ×   │
│                      [+ label]    [search: "timeout"]     [+ field]  │
├──────────────────────────────────────────────────────────────────────┤
│ LogVolumeHistogram   ▁▂▅█▃▁▂   (brush to narrow the range)            │
├───────────┬──────────────────────────────────┬───────────────────────┤
│ Fields    │ LogList (virtualised)            │ LogDetail (sheet)     │
│ (detected)│  12:04:11.882 ERROR checkout …   │  labels / fields /    │
│           │  ⚠ >200 lines in this second     │  trace link / actions │
└───────────┴──────────────────────────────────┴───────────────────────┘
```

#### 6.2 Files to create in `apps/start/src`

| Path | What |
|---|---|
| `routes/_app.$organizationId.$projectId.logs.tsx` | route; `useInfiniteQuery(trpc.logs.query…)` |
| `components/logs/log-explorer.tsx` | composition + shared `ILogQuery` state |
| `components/logs/log-list.tsx` | `useWindowVirtualizer` list, boundary marker |
| `components/logs/log-row.tsx` | one line; `memo`ised |
| `components/logs/log-detail.tsx` | right-hand `Sheet` |
| `components/logs/log-selector-builder.tsx` | label matchers + severity |
| `components/logs/log-matcher-adapter.ts` | `ILogStreamMatcher` ⇄ `IChartEventFilter`, **and** `ILogFieldFilter` ⇄ `IChartEventFilter` |
| `components/logs/log-line-search.tsx` | free-text + regex toggle |
| `components/logs/log-field-filters.tsx` | envelope-field filters |
| `components/logs/log-volume-histogram.tsx` | bar chart + brush |
| `components/logs/log-detected-fields.tsx` | left-rail field frequencies |
| `components/logs/log-severity-badge.tsx` | colour + label |
| `components/logs/log-follow-toggle.tsx` | `refetchInterval` follow mode (D5) |
| `hooks/use-log-query-state.ts` | `ILogQuery` ⇄ URL via `nuqs` |
| `modals/log-context.tsx` | context expansion around a line |

`modals/log-context.tsx` is registered in `apps/start/src/modals/index.tsx` (imports at `:2-47`, registry object from `:49`).

#### 6.3 Existing components and hooks to reuse, unchanged

| Reuse | Where it lives | For |
|---|---|---|
| `useWindowVirtualizer` pattern with `measureElement` | `components/events/table/index.tsx:5,60-120` | the virtualised list |
| `useInViewport` bottom sentinel | `components/events/table/index.tsx:12` | infinite scroll |
| `PageContainer` / `PageHeader` | `components/page-container.tsx`, `page-header.tsx` | page chrome |
| `SidebarLink` | `components/sidebar-link.tsx` | nav entry |
| `useRechartDataModel` | `hooks/use-rechart-data-model.ts:19-52` | histogram data model |
| `BarChart` / `Bar` | `components/charts/bar-chart.tsx`, `charts/bar.tsx` | histogram marks (see `components/overview/overview-live-histogram.tsx` for the shape) |
| `Sheet`, `Command`, `ComboboxAdvanced`, `DataTableViewOptions` | `components/ui/*` | detail panel, pickers, column toggles |
| `pushModal` | `modals/index.tsx` | context modal |
| `useTableFilters`'s `nuqs` conventions | `hooks/use-table-filters.ts` | URL state |
| `FiltersBuilder` + `PureFilterItem` | `components/filters/FiltersBuilder.tsx`, `components/report/sidebar/filters/FilterItem.tsx` | selector builder (§6.4) |

**`useWS` is deliberately absent from this table.** The draft listed it under "reuse, unchanged" while the tail design required the client to *send* a first message. `apps/start/src/hooks/use-ws.ts` calls `useWebSocket(baseUrl, {...})` and discards the return value — the module's default export returns `void`, exposing no `sendMessage`, no `sendJsonMessage` and no `readyState`. The handshake is unimplementable through it. That is one of the reasons the tail moves to P6 (D5); §9 specifies what has to change when it is built.

#### 6.4 Selector builder — extending the report editor's filter chrome

`FiltersBuilder` (`components/filters/FiltersBuilder.tsx:15-40`) is already prop-driven and explicitly documented as reusable "on any surface … without coupling to Redux". Its leaf, `PureFilterItem` (`components/report/sidebar/filters/FilterItem.tsx:192-245`), is the part that does not fit: it hard-wires `usePropertyValues({ event, property, projectId, enabled })` — the *event property* value source — and populates its operator dropdown from `getOperatorsForType(filter.type)`.

**This is not a six-line change.** It is an adapter plus three optional props, roughly **50 lines across three files**:

```ts
// FilterItem.tsx -- PureFilterProps, all additive, all optional
interface PureFilterProps {
  …
  /** Override the value-autocomplete source. When provided, usePropertyValues is
   *  gated off via its existing `enabled` option rather than skipped -- hooks are
   *  called unconditionally. */
  values?: string[];
  valuesLoading?: boolean;
  /** Restrict the operator dropdown. Defaults to getOperatorsForType(filter.type). */
  operatorAllowlist?: readonly (keyof typeof operators)[];
  /** `eventName` is meaningless for logs. */
  eventName?: string;
}
```

```ts
// FilterItem.tsx, inside PureFilterItem -- the existing `enabled` option is the seam
const potentialValues = usePropertyValues({
  event: eventName ?? '',
  property: filter.name,
  projectId,
  enabled: values === undefined && !filter.name.startsWith('session.'),
});
const options = values ?? potentialValues;
```

**The operator vocabularies do not line up, and the draft's "field filters use the string operator list unchanged" is false.** `packages/constants` `STRING_OPERATORS` (`packages/constants/index.ts:151-159`) is `[is, isNot, contains, doesNotContain, startsWith, endsWith, regex, isNull, isNotNull]`. Against `zLogFieldFilter` that is three mismatches: it names `doesNotContain` and `regex` where we name `notContains` and `matches`; it omits `gt`/`gte`/`lt`/`lte`, which we declare; and it offers `startsWith`/`endsWith`/`isNull`/`isNotNull`, which we reject. `ORDERED_OPERATORS` (`:161-170`) supplies the four comparisons. So `log-matcher-adapter.ts` maps **both** matcher kinds and each gets its own allowlist:

```ts
// components/logs/log-matcher-adapter.ts
const OP_TO_UI = { is:'is', isNot:'isNot', contains:'contains',
                   notContains:'doesNotContain', matches:'regex',
                   gt:'gt', gte:'gte', lt:'lt', lte:'lte' } as const;
const UI_TO_OP = Object.fromEntries(
  Object.entries(OP_TO_UI).map(([k, v]) => [v, k])) as Record<string, keyof typeof OP_TO_UI>;

/** Label matchers: three operators. */
export const STREAM_OPERATORS = ['is','isNot','regex'] as const;
/** Field filters: the union of the string and ordered lists, minus the four
 *  we do not compile (startsWith/endsWith/isNull/isNotNull). */
export const FIELD_OPERATORS =
  ['is','isNot','contains','doesNotContain','regex','gt','gte','lt','lte'] as const;

export const toFilter = (m: ILogStreamMatcher | ILogFieldFilter, i: number): IChartEventFilter => ({
  id: `log-${i}`,
  name: 'label' in m ? m.label : m.field,
  type: 'string',
  operator: OP_TO_UI[m.operator],
  value: [m.value],
});
export const fromStreamFilter = (f: IChartEventFilter): ILogStreamMatcher | null => { … };
export const fromFieldFilter  = (f: IChartEventFilter): ILogFieldFilter  | null => { … };
```

with `operatorAllowlist={STREAM_OPERATORS}` for label matchers and `{FIELD_OPERATORS}` for field filters. Values come from `trpc.logs.labelValues` for labels and from the detected-fields sample for fields.

*Rejected: copying `PureFilterItem` into `components/logs/`.* It would fork the operator UI and the two would drift the first time someone adds an operator to `packages/constants`. *Rejected: adding a `'log'` category to `PropertiesCombobox`* — that component already carries a `SESSION_ACTIONS` special case and a `State` union; a fifth category with a different backing query would make the report editor pay for a telemetry feature.

The label **picker** is a small local component using `Command` / `ComboboxAdvanced` fed by `trpc.logs.labels`, showing each label's cardinality from `/detected_labels` (`{label, cardinality}`, `reader/service/query_range.go:217-220`) so the user sees *why* a label is a good or bad grouping key before they pick it.

#### 6.5 Virtualised list, histogram, detected fields, context, columns, URL

**List.** `log-list.tsx` uses `useWindowVirtualizer` from `@tanstack/react-virtual` — already a dependency; `components/events/table/index.tsx` is the working example — rather than a scroll container, so the histogram and page header scroll away naturally and infinite scroll is a single `useInViewport` sentinel at the bottom. Row height is **not** fixed: a line wraps when "wrap lines" is on and is a single truncated line otherwise, so `measureElement` is used (`events/table/index.tsx:86`) with `estimateSize: () => wrap ? 56 : 28`, and toggling wrap calls `virtualizer.measure()`. `overscan: 20`. Keys are `line.id` (contentKey + occurrence, §5.4). Each row renders timestamp (monospace, ms precision), severity badge, `service_name`, and body. The boundary-second marker (§5.4) is interleaved by index.

**Histogram.** `log-volume-histogram.tsx`, a bar chart themed like `components/overview/overview-live-histogram.tsx`, driven by `useRechartDataModel(histogram.series)` on real `IChartSerie[]` (§5.5).

Step selection is **server-side**: `step = clamp(windowMs / 120, 15_000, 3_600_000)` rounded **up** to a multiple of 15 000 ms, emitted as `` `${step}ms` ``.

> **The 15 s floor and the multiple-of-15 s rule are a correctness constraint, not a performance one, and the draft had the reason backwards.** `AnalyzeMetrics15sShortcut` rejects only ranges *shorter* than 15 s (`analyze.go:111`, `if duration.Seconds() < 15 { return false }`). For any range ≥ 15 s the shortcut fires **regardless of whether it is a multiple of 15 s**, and `Metrics15ShortcutPlanner.GetQuery` then re-buckets the pre-aggregated 15 s rows with `intDiv(samples.timestamp_ns, Duration) * Duration` while truncating `from`/`to` to 15 s boundaries (`planner_metrics15s_shortcut.go:40-58`). A 20 s step therefore puts two 15 s buckets in `[0,20)` and one in `[20,40)`: the counts are **silently wrong**, not slow. The rounding is what makes the histogram correct. A future engineer reading "it just gets slower" would relax it; a test asserts the emitted step is always ≥ 15 000 and a multiple of 15 000.

The client never sends `interval`: OpenPanel's `Interval` enum has no sub-minute value, and the 15 s-multiple constraint means the client cannot be trusted to pick the step. Stacking by `level` is offered only when `severity` is unset; it sets `stackByLevel: true`, which makes the compiler emit `sum by (level) (…)`. Brushing sets `startDate`/`endDate` in URL state, re-running both `logs.query` and `logs.histogram`.

**Detected fields.** `logs.detectedFields` runs `logs.query` with `limit: 500` and no cursor, parses the envelopes, and returns per-field frequency plus up to five example values for `body`, `sev`, `tid`, `sid` and `attr.<key>` for every key seen. Type is inferred by majority. The panel is collapsed by default and fetches only when opened (`enabled: isOpen`), because it is a second full query. **Sampling caveat, shown in the UI:** the 500 lines are the *newest* 500 in the window, so a field that appears only in old lines is missing. The header says "from the 500 most recent matching lines". Clicking a field adds a `zLogFieldFilter`; clicking a sample value adds it with `operator: 'is'`.

**Context expansion.** `modals/log-context.tsx`, opened from a row's kebab menu or `c`:

1. Build a selector from **the line's own label map as returned**, every label as `=`, plus the mandatory `op_project_id` stamped server-side. Because `source` is no longer stripped (§5.5) this pins one exact fingerprint, which is stronger and cheaper than reusing the user's selector. `zLogContextInput` re-applies the reserved-label refinement, so a client cannot smuggle `op_project_id` into the map (I4).
2. Two `logs.context` calls: `direction: 'backward'` with `end = ts + 1s`, and `direction: 'forward'` with `start = ts`, both `limit: 25`, **no line filters, no field filters**.
3. Render 25 before / the pivot / 25 after, pivot highlighted, "load 25 more" at each end.

The one-second padding on `end` is required by two facts together: `To` is floored to a whole second, and the predicate is `Lt(to)` — exclusive (`planner_main_init.go:44`). Asking for `end = ts` exactly floors to the start of that second and then excludes it, dropping the pivot and everything else in that second.

**Pinning.** In `log-detail.tsx` every label row has **filter for** (`is`), **filter out** (`isNot`) and **add as column**. `op_project_id` is not present in `line.labels` at all — stripped in `parseStreamsResponse` (I4) — so there is nothing to pin that could weaken the boundary. Envelope fields get the same treatment, producing `zLogFieldFilter` entries. "Add as column" writes to a `nuqs` array param `cols`; `log-list.tsx` renders those `attr.*` values as extra grid columns, reusing `DataTableViewOptions`.

**URL state.** `hooks/use-log-query-state.ts` encodes the whole `ILogQuery` minus `projectId` into the URL with `nuqs`, using the `history: 'push'` option `useTableFilters` uses. Keys: `s` (stream matchers, JSON), `sev`, `q` (line filters), `ff` (field filters), `cols`, plus the existing `range` / `startDate` / `endDate` names so `TimeWindowPicker` works unchanged. Copying the URL shares the view; this is the whole sharing mechanism in P3 (D6). The `TimeWindowPicker` is rendered with a restricted option set — windows longer than the project's effective retention are hidden, because the server clamps them anyway and offering "Last 12 months" over a 30-day store is a lie.

**Follow mode (D5).** `log-follow-toggle.tsx` pins `range: 'lastHour'`, `direction: 'backward'`, discards any cursor, and sets `refetchInterval: 5000` on the newest page only. It renders a pulsing dot and "following — updated 3 s ago". It does **not** claim to be a tail: the label is *Follow*, not *Live*, and the tooltip says "refreshes the newest page every 5 seconds; lines that arrive and are superseded between refreshes may not be shown". That sentence is the honest version of what a polled view is, and it is why the counted-drop tail in §9 is worth building later rather than pretending now.

### 7. Storage, retention, cost and deletion

Logs and metrics share `samples_v3` (§1.4). This section is what follows from that.

#### 7.1 Bootstrap: two irreversible decisions, owned by P0, gated before first boot

**This is the piece the draft left ownerless.** §"Interfaces → Consumed" listed the gigapipe database, CH user, grants, settings profile and the pre-created `samples_v3` as **consumed from P0**, while P3.0 listed exactly the same artefacts as its own 1.5 w deliverable. If P0 ships first and boots gigapipe with defaults, F4's recovery is an offline table rebuild — there is no in-place fix and the logs work-stream has no move.

**Resolution: one owner, one gate.** The bootstrap migration is **P0's deliverable**, in P0's budget. P3 consumes it and is blocked on the *artifact*, not on a decision. The gate is stated as an operational rule, not a hope:

> **P0 does not start `op-gigapipe` against any ClickHouse instance — dev, CI, staging or production — until the pre-create migration has run and the boot assertion is green.** The compose template's `op-gigapipe` service carries `depends_on: { op-api: { condition: service_healthy } }` for exactly this reason, and the healthcheck does not pass until the assertion has run.

**Partition key.** gigapipe's default is `PARTITION BY toStartOfDay(...)` with `type` added later by `ALTER` and **no `MODIFY ORDER BY`** (`log.sql:25-32`, `:119-120`) — unlike `time_series` (`:115-117`), `time_series_gin` (`:122-124`) and `metrics_15s` (`:126-128`), which all do get `type` in their sort keys in the same block. A part therefore mixes logs and metrics, and with `ttl_only_drop_parts = 1` (which gigapipe's rotation forces) a part survives until **all** its rows expire, collapsing two per-signal TTLs into `max(log_ttl, metric_ttl)`. Adding `type` to the partition key makes partitions type-homogeneous and turns per-signal retention into a clean part drop with no row-level merge cost.

**Sort key.** gigapipe's default is `ORDER BY (timestamp_ns)`. The tenant boundary at query time is `samples.fingerprint IN (<gin CTE>)` (`planner_fingerprint_filter.go:22-28`) with only `timestamp_ns` and the type predicate in the `PREWHERE` (`planner_main_init.go:42-45`). With `fingerprint` absent from the sort key that `IN` is not an index prune: **every project's log query reads every other project's rows in the window and filters them.** Combined with I10 (verified: `Settings: nil` at `reader/registry/registry.go:69`) that is a shared-cluster amplification factor equal to the number of tenants. We therefore set `ADVANCED_SAMPLES_ORDERING="fingerprint, timestamp_ns"` (`cmd/gigapipe/main.go:123-124`) and match it in the pre-create. Daily partitioning preserves time pruning, and `timestamp_ns` is still monotonic *within* a fingerprint, so the `DoubleDelta` codec is unharmed. `ADVANCED_SAMPLES_ORDERING` is interpolated into `CREATE TABLE` only — a fresh-install-only knob.

Three details make the pre-create safe against gigapipe's own DDL:

- gigapipe's create is `CREATE TABLE IF NOT EXISTS` (`log.sql:25`) and its `ALTER TABLE samples_v3 ADD COLUMN IF NOT EXISTS type UInt8` (`log.sql:119-120`) is then a no-op. Ours wins.
- We must **not** pre-create the `type_v2` alias. gigapipe issues `ALTER TABLE samples_v3 ADD COLUMN \`type_v2\` UInt8 ALIAS type` (`log.sql:168-169`) **without** `IF NOT EXISTS`; pre-creating it makes that statement fail and the boot `panic`.
- **We pre-create the LOCAL `samples_v3` only — never `samples_v3_dist`.** The draft's test row required "the clustered branch emits `ReplicatedMergeTree` plus a `_dist` companion". gigapipe creates every Distributed companion itself, with `IF NOT EXISTS`, in `ctrl/qryn/sql/log_dist.sql` (`samples_v3_dist` at `:18-23`). Pre-creating ours means our `IF NOT EXISTS` wins and gigapipe's never runs — so any divergence in the sharding key (`fingerprint` for samples/time_series/metrics_15s, **`rand()` for time_series_gin**) silently persists, and we own byte-compatibility with upstream across every image bump for no gain. Only the local table carries the partition and sort key that matter. Drop it from the pre-create and from the test.

The DDL branches on `isClickhouseClustered()` (`packages/db/src/clickhouse/client.ts:83-95`), which returns **true by default** and only returns false when `SELF_HOSTED=true` — i.e. Cloud, the deployment the whole label-enforcement design exists to protect, runs clustered ClickHouse. A plain `MergeTree` pre-create on a multi-node cluster means gigapipe writes non-replicated local tables on whichever node its connection lands on: pushes scatter, reads return a random subset, and the explorer silently loses lines with no error anywhere.

**Boot assertion, because a lost race is otherwise silent.** On startup apps/api reads

```sql
SELECT partition_key, sorting_key, engine
FROM system.tables
WHERE database = 'gigapipe' AND name = 'samples_v3'
```

and, if any does not match the expected string, logs at `error`, emits `op_telemetry_bootstrap_ok 0`, sets `telemetryEnabled = false` (D12) and raises the operator alert. Recovery is an offline table rebuild, so it must be loud on day one rather than discovered at the first retention run.

#### 7.2 Local vs distributed naming for the `gigapipe` database — the rule the draft never stated

The draft mutated and read gigapipe tables in three places without ever saying which name is correct on a cluster, and then hand-waved "every statement goes through `getReplicatedTableName`-equivalent naming". That helper returns `` `${tableName}_replicated ON CLUSTER '{cluster}'` `` (`packages/db/src/clickhouse/client.ts:100-107`) — the `_replicated` suffix is an **OpenPanel** naming convention. gigapipe's clustered layout is the inverse: the plain-named local table becomes `ReplicatedMergeTree` and Distributed companions carry `_dist`. Following the draft literally emits `ALTER TABLE gigapipe.samples_v3_replicated …`, which does not exist — on Cloud, where the paying customers are. The draft's own test would have passed, because it asserted only "every statement is `ON CLUSTER`".

One small helper, used by every gigapipe-database statement, and `getReplicatedTableName` is never applied to a gigapipe table:

```ts
// packages/db/src/gigapipe/table-name.ts
const GIGAPIPE_DB = process.env.GIGAPIPE_DB ?? 'gigapipe';
const CLUSTER     = process.env.CLICKHOUSE_CLUSTER_NAME ?? '{cluster}';

/**
 * gigapipe's clustered layout, from ctrl/qryn/sql/log.sql + log_dist.sql:
 *   local:       gigapipe.samples_v3        (ReplicatedMergeTree on a cluster)
 *   distributed: gigapipe.samples_v3_dist   (Distributed(..., 'samples_v3', fingerprint))
 * There is NO `_replicated` variant. Reads must go through the Distributed table
 * or they see one shard; ALTER ... DELETE must go to the LOCAL table with
 * ON CLUSTER, because a mutation against a Distributed table is a no-op.
 */
export function gigapipeTable(name: string, mode: 'read' | 'mutate'): string {
  if (!isClickhouseClustered()) return `${GIGAPIPE_DB}.${name}`;
  return mode === 'read'
    ? `${GIGAPIPE_DB}.${name}_dist`
    : `${GIGAPIPE_DB}.${name} ON CLUSTER '${CLUSTER}'`;
}
```

This is not a performance nicety. A `SELECT fingerprint FROM gigapipe.time_series` against the local table on a cluster returns only the coordinating node's shard, so the resolved fingerprint set is **incomplete** and the erasure path silently under-deletes — a compliance defect in a routine that carries a DPA-facing SLA. The purge test asserts the exact emitted table names, not merely the presence of `ON CLUSTER`.

Note also that `packages/db/src/clickhouse/migration.ts`'s `getExistingTables()` hardcodes `WHERE database = 'openpanel'` (`migration.ts:177`), so it cannot see the gigapipe database at all. Any idempotency guard for gigapipe DDL writes its own `system.tables WHERE database = 'gigapipe'` query, following the pattern migrations 18 and 19 already use.

#### 7.3 The conditional TTL

```sql
ALTER TABLE gigapipe.samples_v3 MODIFY TTL
  toDateTime(timestamp_ns / 1000000000) + INTERVAL 30  DAY DELETE WHERE type IN (1, 0),
  toDateTime(timestamp_ns / 1000000000) + INTERVAL 395 DAY DELETE WHERE type = 2;
```

`type IN (1, 0)` and not `type = 1`: type 0 means "both", written whenever a Loki push value tuple carries a line *and* a number (`unmarshal.go:163-165`, `:225-227`), and every reader predicate matches `type IN (n, 0)`. A `WHERE type = 1` clause would leave type-0 rows behind forever. Type 0 rows are produced by **live** ingest on the Loki-JSON path, not only by legacy data.

Two mechanical facts:

- gigapipe's rotation reads a marker from its `settings` table and returns early when the computed TTL string is unchanged, so our conditional TTL **survives restarts** as long as the config is unchanged — but the moment `SAMPLES_DAYS` or `STORAGE_POLICY` changes, the guard misses and gigapipe silently replaces the per-signal TTL with its own single-expression one, restoring the `max(log_ttl, metric_ttl)` collapse with no error anyone reads. **`SAMPLES_DAYS` is documented as immutable after install**, and asserted nightly.
- Whoever issues the `ALTER` must set `materialize_ttl_after_modify` explicitly. gigapipe pins it to `0` on its own maintenance connection (`ctrl/maintenance/shared.go:34`) while ClickHouse defaults it to `1`, so the identical statement is a no-op-on-old-parts from gigapipe and a full-table mutation from OpenPanel's client. Set it to `0` when lengthening (type-homogeneous partitions mean the new TTL only needs to apply going forward, and existing parts are dropped by the old expression at the same or a shorter horizon) and `1` exactly once when shortening.

**Nightly assertion** (`apps/worker/src/jobs/cron.telemetry-retention.ts`, first step): read `create_table_query` from `system.tables` for `gigapipe.samples_v3`, compare the TTL clause to the expected conditional form, re-apply and alert if it differs. This is the only thing standing between a `SAMPLES_DAYS` edit and 395-day metrics being dropped at 30 days.

**Do not build anything on `X-Ttl-Days` / `x-ttl-days` / `__ttl_days__`.** All three are parsed into `MTTLDays` (`writer/controller/middleware.go:167-174`, `writer/utils/unmarshal/builder.go:326-338`) and read by no insert statement — the sample insert is five columns that do not include it.

**UNVERIFIED:** exactly how ClickHouse evaluates a multi-clause conditional TTL under `ttl_only_drop_parts = 1` over type-homogeneous partitions. The grammar (`TTL expr [DELETE] [WHERE cond][, …]`) is documented and the feature is old, but it could not be executed here — no ClickHouse binary is on this machine and nothing is listening on 8123 or 9000. Settle by running the `ALTER` against the pinned ClickHouse image with two days of mixed-type data and reading `system.parts.delete_ttl_info_max`. **Blocks P0's bootstrap, not P3.**

#### 7.4 Per-project retention and project deletion — one purge routine, two callers

Pruning `samples_v3` alone is wrong in a way users notice: `time_series`, `time_series_gin`, `metrics_15s` and `patterns` keep the project's rows, so `logs.labels`, `logs.labelValues` and the cardinality surfaces keep offering label values that can never return a line, and the rollup keeps reporting bytes for data that no longer exists. If the same routine is later used as the deletion path — and it is — "we deleted your data" would be false.

```ts
// packages/db/src/services/telemetry-delete.service.ts
export async function purgeTelemetry(opts: {
  projectId: string;
  reason: 'retention' | 'deletion';
  /** null = purge everything for the project (deletion). */
  olderThanNs: bigint | null;
  signals: ('logs' | 'metrics')[];
  /** Resume an existing journal row instead of creating one. */
  resumeJobId?: string;
}): Promise<{ jobId: string; mutationIds: string[] }>;
```

It is **idempotent and resumable from the journal** (§3.6). Order matters, because every step after the first needs the fingerprint set:

1. **Resolve and record fingerprints first.** If `resumeJobId` names a row already in `resolved` or later, skip straight to step 2 with its stored set.
   ```sql
   SELECT fingerprint FROM {{ gigapipeTable('time_series', 'read') }}
   WHERE type IN (1,0)
     AND simpleJSONExtractString(labels, 'op_project_id') = {projectId:String}
   ```
   Commit the journal row with `state = 'resolved'` **before returning**. For the deletion path this must happen before the `Project` row is gone, because ClickHouse mutations are asynchronous and the projectId is the only handle.
2. `ALTER TABLE {{ gigapipeTable('samples_v3','mutate') }} DELETE WHERE type IN (1,0) [AND timestamp_ns < {cutoffNs}] AND fingerprint IN (…)`
3. `ALTER TABLE {{ gigapipeTable('metrics_15s','mutate') }} DELETE WHERE type IN (1,0) [AND …] AND fingerprint IN (…)` — separate because `metrics_15s_mv` is insert-triggered only and does not retract (§1.4).
4. `ALTER TABLE {{ gigapipeTable('patterns','mutate') }} DELETE WHERE fingerprint IN (…)`
5. `ALTER TABLE {{ gigapipeTable('time_series_gin','mutate') }} DELETE WHERE type IN (1,0) AND fingerprint IN (…)` — deletion only
6. `ALTER TABLE {{ gigapipeTable('time_series','mutate') }} DELETE WHERE type IN (1,0) AND fingerprint IN (…)` — deletion only

Record the mutation ids on the journal row and set `state = 'submitted'`. Steps 5–6 run only on the deletion path; the retention path keeps label metadata, because a project with 7-day retention still has live streams. **Document that: label and series metadata lives to the global TTL regardless of per-project retention, and the cardinality guard measures the global window.**

Completion is polled from `system.mutations` (`is_done`, `latest_fail_reason`) by the next night's run, which flips the journal row to `done` or `failed`; the settings card shows "purge in progress" while any row for the project is `submitted`.

**Two callers:**

- **Retention** — `apps/worker/src/jobs/cron.telemetry-retention.ts`, nightly, for projects whose configured retention is *shorter* than the global TTL. **Budgeted, not counted**: "at most one project per night" silently means a customer who set 7-day retention for compliance gets `7 + N` days for N such projects. The stated SLA is **custom retention is applied within 24 hours**, implemented as a per-night budget — process projects oldest-unprocessed-first until either the queue is empty or the summed `system.mutations.parts_to_do` for our outstanding mutations exceeds a ceiling. If the budget cannot keep up, the job raises an operator alert rather than quietly falling behind. Retention *longer* than the global TTL is rejected at the settings mutation (§5.1).
- **Deletion** — called from `jobDelete` (`apps/worker/src/jobs/cron.delete.ts:44-52`), with `olderThanNs: null` and both signals. This is **not optional**: `deleteFromClickhouse` (`packages/db/src/services/delete.service.ts`) enumerates tables in the `openpanel` database and none in `gigapipe`, and there is no per-profile deletion API anywhere in the repo — **project deletion IS the erasure path**, and logs are by far the most PII-dense signal in the product. The wind-down feature (commit `a62e387c`) arms `deleteAt` for expired trials, so this fires on real customer data on a schedule. `Client.projectId` cascades on project delete (`schema.prisma:365`), so deleting a project silently deletes its telemetry ingest tokens while the ClickHouse rows under that `op_project_id` are **not** removed by any Postgres cascade; `purgeTelemetry` is what closes that gap. The stated erasure SLA is **within 24 hours of the deletion job running**, bounded by mutation completion, and it goes in the DPA-facing docs.

**Wiring into `jobDelete`, with the error isolation the draft did not have.** As it stands, `jobDelete` is `if (projectIds.length > 0) { await deleteFromClickhouse(...); await deleteProjects(...) }` followed by a loop of `deleteOrganization` (`cron.delete.ts:44-52`) — no try/catch anywhere. A throw from `purgeTelemetry` (gigapipe unreachable, a fingerprint query timing out) would abort the entire hourly delete cron, so **no** project and **no** organization is deleted until someone notices. Given `a62e387c` arms `deleteAt` on expired trials, that is a compliance stall that F13 does not cover, because F13 only watches mutations that were successfully submitted.

```ts
// apps/worker/src/jobs/cron.delete.ts
const purged: string[] = [];
for (const projectId of projectIds) {
  try {
    await purgeTelemetry({ projectId, reason: 'deletion', olderThanNs: null,
                           signals: ['logs', 'metrics'] });
    purged.push(projectId);
  } catch (err) {
    // One project's telemetry purge must never block every other deletion.
    await recordPurgeFailure(projectId, err);   // journal row -> state 'failed'
    logger.error({ err, projectId }, 'telemetry purge failed; project delete deferred');
  }
}
// Only projects whose journal row is committed may have their Postgres rows removed.
if (purged.length > 0) {
  await deleteFromClickhouse(purged);
  await deleteProjects(purged);
}
```

A project whose purge failed is left intact and retried on the next hourly run; the `failed` journal row is the alert. That is the right trade: a delayed deletion is recoverable, an orphaned ClickHouse row set with no handle is not.

#### 7.5 ClickHouse users, grants and guard rails (P0 dependency)

**Users.** Two:

| User | Used by | Needs |
|---|---|---|
| `gigapipe` | the gigapipe container (`CLICKHOUSE_AUTH`) | `SELECT, INSERT, ALTER, CREATE TABLE, CREATE VIEW, DROP TABLE ON gigapipe.*`; settings profile `gigapipe_reader` |
| `openpanel` (existing) | the bootstrap migration, the retention/deletion crons, the TTL assertion | additionally `CREATE DATABASE`, and `CREATE TABLE, ALTER TABLE, ALTER DELETE, SELECT, SHOW ON gigapipe.*` |

Bootstrap ordering: **the existing `openpanel` user creates the `gigapipe` database, the `gigapipe` user, and the local `samples_v3`** — in that order — *then* the gigapipe container starts and creates the rest of its schema. The gigapipe user cannot pre-create anything because it does not exist yet.

**The settings profile is the only per-query bound on a runaway LogQL query** (I10, verified):

```xml
<clickhouse>
  <profiles>
    <gigapipe_reader>
      <max_execution_time>30</max_execution_time>
      <timeout_overflow_mode>throw</timeout_overflow_mode>
      <max_memory_usage>4000000000</max_memory_usage>
      <max_bytes_to_read>200000000000</max_bytes_to_read>
      <read_overflow_mode>throw</read_overflow_mode>
      <max_result_rows>1000000</max_result_rows>
      <result_overflow_mode>throw</result_overflow_mode>
      <!-- The bound the draft was missing: per-query limits do not bound how
           many queries one user has in flight. -->
      <max_concurrent_queries_for_user>16</max_concurrent_queries_for_user>
      <queue_max_wait_ms>3000</queue_max_wait_ms>
    </gigapipe_reader>
  </profiles>
</clickhouse>
```

It must go in **two** self-host files, not one — `self-hosting/clickhouse/clickhouse-user-config.xml` and the inline copy inside `self-hosting/coolify.yml`, which does not bind the XML file but reproduces its body as a `content: |` block. On Cloud there is no compose file, so the profile is applied as a `CREATE SETTINGS PROFILE` / `ALTER SETTINGS PROFILE` from the bootstrap migration.

**UNVERIFIED:** whether a 30 s `max_execution_time` on the same user breaks gigapipe's *writer* under a large insert batch. Its own client sets settings explicitly (`writer/chwrapper/factory.go:46`), which as per-query `SETTINGS` should override the profile — but it was not run. Settle with the load test, or split into `gigapipe_reader` / `gigapipe_writer` users with two profiles. **Blocks P3.3.**

### 8. Capacity, pipeline observability and what an operator sees

#### 8.1 Capacity targets — the numbers the design is sized against

The draft turned on quantities it never stated, so none of its load tests could pass or fail. These are the P3 targets. They are budgets to be validated, not measurements.

| Target | P3 budget | Why this number |
|---|---|---|
| Lines/s per project, sustained | **2 000** | Above this the boundary-second stall (F1) is constant at `limit: 200` and the product is telling the user to narrow their query on every page. |
| Lines/s per apps/api replica, all projects | **10 000** | Each line is gunzipped, decoded, re-enveloped, re-serialised and gzipped again, synchronously, in the process that serves `/track`. |
| Peak push body | 4 MiB (`OTLP_MAX_BODY`) | Route limit; sub-batches never exceed it either. |
| Concurrent explorer users per project | **10** | Sets the `rateLimitMiddleware` numbers and `max_concurrent_queries_for_user`. |
| ClickHouse headroom the reader profile is sized against | 30 s / 200 GB / 4 GB per query, 16 concurrent | §7.5. |
| Cloud `apps/api` replicas | **stated in the P0 env manifest, not assumed here** | Every per-process cap below multiplies by it. |

**Per-process caps multiply by the replica count, and that must be written down somewhere.** `PUSH_MAX_INFLIGHT_PER_PROCESS = 32` is a global bound of `32 × replicas` in-flight pushes against one gigapipe; the P6 tail's `OP_LOG_TAIL_MAX_PER_PROJECT = 5` is `5 × replicas` sockets per project. P0's env manifest states the replica count, and this document's numbers are per-process on purpose — cost is per-process — but the operator alerts in §8.2 are on the aggregate.

**The load test that gates P3.3**, with a stated pass/fail rather than an open question: 10 000 lines/s into one apps/api replica for 10 minutes, **with high log-shape diversity** (≥ 5 000 distinct first tokens, because gigapipe's ungateable clusterer iterates every cluster sharing a first token — D8), while `/track` runs at its normal production rate against the same process. Pass = `/track` p99 latency degrades by < 20 %, telemetry push p99 < 2 s, no 503 from the semaphore, gigapipe writer RSS stable across the run.

#### 8.2 Pipeline observability — where "raises the operator alert" actually goes

The draft's failure table said "raises the operator alert in §13", and §13 was the failure table. That is circular; nothing defined what the pipeline emits or how an alert is raised. `apps/api` already registers a Prometheus `/metrics` plugin inside the Public API scope (`apps/api/src/app.ts:369-372`), and `apps/worker` already exposes its own registry, so the mechanism exists.

**Emitted by `apps/api`** (`fastify-metrics`' registry, alongside the existing HTTP metrics):

| Metric | Type | Labels |
|---|---|---|
| `op_telemetry_push_total` | counter | `signal`, `protocol`, `outcome` (`accepted`\|`rejected_invalid`\|`failed_transport`) |
| `op_telemetry_push_duration_seconds` | histogram | `signal`, `protocol` |
| `op_telemetry_subbatch_retry_total` | counter | `signal` |
| `op_telemetry_inflight_pushes` | gauge | — |
| `op_telemetry_breaker_open` | gauge (0/1) | — |
| `op_telemetry_bootstrap_ok` | gauge (0/1) | — (set once by the boot assertion, §7.1) |
| `op_telemetry_read_duration_seconds` | histogram | `procedure` |
| `op_telemetry_read_errors_total` | counter | `procedure`, `code` |

**Emitted by `apps/worker`:** `op_telemetry_purge_pending` (gauge, journal rows in `resolved`/`submitted`), `op_telemetry_purge_age_seconds` (gauge, oldest such row), `op_telemetry_ttl_drift` (gauge 0/1, set by the nightly assertion), `op_telemetry_usage_flush_lag_hours` (gauge).

**Not emitted by us, but scraped:** gigapipe publishes its own `/metrics` over `prometheus.DefaultGatherer` (`shared/commonroutes/routes.go:13-18`, registered at `cmd/gigapipe/main.go:319`) — behind the same Basic auth as every other route, so the scrape must carry credentials. gigapipe writer process CPU and RSS are the two that matter for the clusterer (D8).

**How an alert is raised** is a P0 decision, not a P3 one, because it is the same mechanism for metrics and traces: the alerts land wherever P0's operator alerting lands. What P3 owns is emitting the signals above and naming, per failure mode, which one fires. Every "detection" column in §"Failure modes" names a metric or a query, never a mechanism that does not exist.

#### 8.3 What an operator sees when a project logs far too much

Three tiers. **Tier 1 ships in P3; tiers 2 and 3 are P6**, because the parent plan puts quotas in P6 and because Tier 1 plus the meter is what billing actually needs.

**Tier 1 — in-product, always visible (P3).** A `Telemetry` card on `_app.$organizationId.$projectId.settings._tabs.index.tsx` showing, for the last 24 h and 30 d: lines ingested, bytes ingested, active streams, and the top 10 streams by bytes.

Lines and bytes come from **OpenPanel's own meter** (`TelemetryUsage`, §4.6), not from gigapipe. Active streams and the top-10 breakdown come from `GET /loki/api/v1/index/stats?query=<selector>` and `GET /loki/api/v1/index/volume?query=<selector>&targetLabels=service_name,level` (with I6 validation) — **called once daily by `cron.telemetry-reconcile.ts` and stored on a Postgres snapshot row, never live from the card**. That is a change from the draft, which called them live behind `cacheMiddleware(15)`; since `cacheMiddleware` only *serves* from cache when `NODE_ENV === 'production'` (`packages/trpc/src/trpc.ts:210`), every card render in staging or a non-production self-host would have been an uncached cross-tenant scan. `QueryIndexStats` builds `uniqExact(fingerprint), COUNT(*), SUM(length(string)), uniqExact(fingerprint, day)` over `samples_v3` with only `timestamp_ns` and `type_v2` in the `PREWHERE` (`reader/service/query_range.go:843-860`); with the default sort key that reads every tenant's rows in the window. A stored snapshot is protection that holds everywhere.

**Tier 2 — cardinality warning (P6).** Compare `streams` from the daily reconciliation against `OP_LOG_MAX_SERIES_PER_PROJECT` (50 000). At 60 %, an in-product banner naming the label with the highest `cardinality` from `/detected_labels`; at 100 %, additionally an email to the org owners through the existing notification path. **Nothing is ever demoted** (§3.3 rule 2).

**Tier 3 — volume ceiling (P6).** When `TelemetryUsage` bytes for the rolling 30 days exceed the plan allowance by a configurable multiple, `cron.telemetry-usage.ts` sets `Project.telemetryLogsBlockedAt`, which `isIngestionBlocked(projectId, 'logs')` reads (§4.3). Logs stop; metrics, traces and event tracking keep flowing. The operator sees a red banner and a one-click "resume ingestion" that clears the column and invalidates the 60 s cache. **There is no per-plan telemetry byte allowance field on `Organization` or `Project` today** — the subscription block carries `subscriptionPeriodEventsLimit` / `subscriptionPeriodEventsCount` for events and nothing telemetry-shaped — so Tier 3 includes the schema for it. The draft's Tier 2/3 wording implied the field existed; it does not.

**Promotion-time budget check (P3, since §3.3 rule 2 depends on it).** When a user adds a label key, the mutation reads the Redis HLL for that key (§3.5), or — if the key has never been seen — samples 500 recent lines through the same code path `logs.detectedFields` uses, multiplies by the project's current stream count, and refuses with a specific message if the product exceeds `OP_LOG_MAX_SERIES_PER_PROJECT`.

| Stage | Surface | Message |
|---|---|---|
| Approaching the label budget | Explorer banner + settings card | "`k8s_pod_name` has 14,200 distinct values in 24 h. Promoting it would create ~14,200 new streams." |
| Over the label budget | Promotion mutation | Refused, with the measured number and the budget. |
| Approaching the volume allowance (P6) | Settings card + email at 80 % | "This project has ingested 82 GB of the 100 GB included in your plan this month." |
| Over the volume allowance (P6) | Ingestion blocked | `X-OP-Blocked: telemetry_volume` on the wire; red banner in-product; one-click resume. |
| A single stream dominating | Top-10 by bytes on the settings card | The offending `service_name` / `level` combination is right there, sorted. |

### 9. Live tail (P6) — the designed successor

D5 defers this. It is specified here because two of its mechanisms are not obvious and would otherwise be rediscovered wrongly, and because the draft got one of them wrong in a way that livelocks.

#### 9.1 Transport, and the `useWS` change it requires

A new handler on the existing `liveRouter` (`apps/api/src/routes/live.router.ts:1-31`), which already registers `@fastify/websocket` and four socket routes:

```ts
fastify.get('/logs/:projectId', { websocket: true }, controller.wsProjectLogs);
```

`/live` is already in `corsPaths` (`app.ts:109`). Auth copies `wsProjectEvents`: read `req.session?.userId`, call `getProjectAccess`, `socket.close()` on failure (`apps/api/src/controllers/live.controller.ts:56-99`), and every handler calls `guardSocket(socket, req)` before its first `await` (`live.controller.ts:14-19`) — without an `'error'` listener an ECONNRESET propagates to `uncaughtException` and kills the process.

**Access is re-checked on a cadence, unlike `wsProjectEvents`.** `wsProjectEvents` checks once at open and streams for the life of the socket; with a 15-minute idle timeout, a member removed from a project — or a member of an org that just crossed into `windDownStep = 'blocked'` — would keep receiving live server logs for up to fifteen minutes. That precedent is acceptable for an integer visitor count and is not acceptable here, for exactly the reason §5.3 gives for read-level access being a decision: logs carry auth failures with usernames, stack traces and `attr.user_id`. So the poller re-runs `getProjectAccess` every 30 poll ticks (≤ 60 s) and, on failure, sends an `error` frame and closes with **1008**. State it in the code as a deliberate divergence.

**`useWS` cannot serve this hook and must change.** It calls `useWebSocket(baseUrl, {...})` and returns `void` (`apps/start/src/hooks/use-ws.ts:16-58`), so there is no `sendJsonMessage` for the handshake and no `readyState` to know when to send it. It also hard-codes `shouldReconnect: () => true` with no `onOpen` seam, so after any reconnect (laptop sleep, LB cycle, deploy) the server holds a fresh socket that never receives a query and the tail sits silently empty behind a pulsing dot — the exact failure §9 exists to prevent. Two options, and P6 picks one explicitly rather than discovering it:

- **(a)** extend `useWS` to return `{ sendJsonMessage, readyState }` and accept `onOpen`, and re-verify the four existing callers. It is a shared hook, so this is a blast-radius decision, and the change must be in the P6 budget.
- **(b)** a sibling `hooks/use-ws-duplex.ts` calling `react-use-websocket` directly, leaving `useWS` untouched. Costs one duplicated superjson decode.

Either way **the handshake is sent on every open, including every reconnect** — `shouldReconnect: () => true` makes re-sending mandatory, not optional.

**The handshake carries `{ query: ILogQuery, sinceNs?: string }`.** The server validates with `zLogQuery`, re-checks project access against the socket's session, and compiles. On reconnect the client supplies its last-seen `sinceNs`; the server **clamps it to `now − TAIL_MAX_LAG_MS`** and, if it clamped, emits a counted `dropped` frame with `reason: 'reconnect'` for the clamped interval using the same `countOverTime` as §9.3. The two naive alternatives are both bugs this design rejects: `sinceNs = now` is a silent gap of exactly the kind D5 condemns gigapipe's tail for, and an unclamped `sinceNs` after a laptop sleep replays an unbounded backlog through the 500-line drain.

#### 9.2 The poller, and the second-granular cursor

One poller per socket. State:

```ts
type TailState = {
  compiled: ICompiledLogQL;
  /** INCLUSIVE, second-floored lower bound. See the box below. */
  floorSecNs: bigint;
  /** contentKey -> count already delivered, FOR floorSecNs ONLY. Cleared when it advances. */
  seen: Map<string, number>;
  droppedServer: number;
  droppedClient: number;
};
```

> **The draft's cursor was `sinceNs = <ts of the last row kept> + 1`, described as exclusive and exact. That is false for the endpoint the poller calls, and it livelocks.** `/loki/api/v1/query_range` floors `start` to a whole second before it reaches the planner (`From: time.Unix(fromNs/1000000000, 0)`, `reader/service/query_range.go:550-551`, always via `prepareOutput` at `:415-418`) and the predicate is `Ge(samples.timestamp_ns, from)` (`planner_main_init.go:42-43`) — **inclusive, second-granular**. Every poll therefore re-reads from the *start* of the second containing the cursor. Two consequences: every line already delivered in the current second is re-delivered on the next tick; and with `direction=forward` (`OrderASC`) and `limit = TAIL_LIMIT + 1`, any second holding more than `TAIL_LIMIT = 500` matching lines **livelocks** — tick N returns the oldest 501, the cursor lands inside that second, tick N+1 floors back to the same second start and returns the same oldest 501 forever, `lagMs` grows without bound until the §9.3 jump fires, and at that point everything in that second below the top-N is lost. That is precisely the failure D5 disqualifies gigapipe's own tail for. The spec identified this flooring for pagination and for context expansion; the draft's own §2.3 recorded ns-exactness only for `/tail` (`reader/controller/query_range.go:183-188`), which is the endpoint D5 rejects.

So the cursor is a **pair**: a second-floored inclusive lower bound plus a multiset of the contentKeys already delivered *within that second*.

Every `TAIL_INTERVAL_MS = 2000` (not 1000 — gigapipe's own tail polls every second at `reader/service/query_range.go:26`, one ClickHouse query per second per viewer):

1. If `socket.bufferedAmount > TAIL_BACKPRESSURE_BYTES` (256 KiB), **skip this tick** and return without advancing anything. The cursor not advancing is what makes this safe.
2. Otherwise issue `GET /loki/api/v1/query_range?query=<compiled.query>&start=<floorSecNs>&end=<nowNs>&limit=<TAIL_LIMIT+1>&direction=forward`. Ascending, so with a limit we get the **oldest** N in the window, which is the correct thing to keep when we cannot keep everything.
3. Parse with the same `parseStreamsResponse` the paged reader uses, sort ascending, then **drop every row whose `contentKey` occurrence is already accounted for in `seen`** (the same multiset decrement as §5.4).
4. Send the survivors. For each row in the *current* `floorSecNs`, increment `seen`.
5. Advance:
   ```ts
   const lastKept = rows.at(-1);
   const lastSec  = floorSec(BigInt(lastKept.timestampNs));
   if (lastSec > state.floorSecNs) {
     state.floorSecNs = lastSec;      // a later second: the old `seen` is dead
     state.seen.clear();
     for (const r of rows) if (floorSec(BigInt(r.timestampNs)) === lastSec) bump(state.seen, r.contentKey);
   } else if (rows.length >= TAIL_LIMIT) {
     // The boundary second holds >= TAIL_LIMIT matching lines and we cannot escape
     // it by reading more. FORCE-ADVANCE, exactly as pagination does (F1), and
     // count what we skip so `dropped` stays a real number.
     const nextSec = state.floorSecNs + SEC;
     state.droppedServer += await countOverTime(compiled, state.floorSecNs, nextSec) - delivered;
     state.floorSecNs = nextSec;
     state.seen.clear();
     send({ type: 'dropped', count: …, reason: 'boundary', sinceNs: String(state.floorSecNs) });
   }
   ```

`seen` is bounded by `TAIL_LIMIT + 1` entries, because it only ever holds one second's worth.

#### 9.3 A real `dropped` signal

`TAIL_LIMIT = 500`. Beyond the boundary-second case above, one more real drop: when the backlog grows faster than we drain it. Track `lagMs = nowNs − floorSecNs`. If `lagMs > TAIL_MAX_LAG_MS` (30 s), continuing to drain a growing backlog is worse than being current:

```ts
const skipped = await countOverTime(compiled, state.floorSecNs, jumpToNs); // sum(count_over_time(...))
state.droppedServer += skipped;
state.floorSecNs = floorSec(jumpToNs);                                     // jump to now - 5s
state.seen.clear();
```

`countOverTime` reuses `compiled.countQuery(stepMs)` — the same rollup-shortcut-eligible query the histogram uses, so it is cheap, and its step obeys the 15 s-multiple correctness rule (§6.5).

Frames are the wire contract:

```ts
type ILogTailFrame =
  | { type: 'lines';   lines: IServiceLogLine[] }
  | { type: 'dropped'; count: number; reason: 'lag' | 'client' | 'boundary' | 'reconnect'; sinceNs: string }
  | { type: 'status';  lagMs: number; rate: number; closing?: boolean }
  | { type: 'error';   message: string };
```

The `dropped` frame is what gigapipe's `dropped_entries` claims to be and is not (`query_range.go:793-795` writes an empty array unconditionally). The explorer renders it as an inline red divider in the list — *"12,431 lines not shown — the stream is faster than the tail. Narrow the selector or use the paged view."* — not as a toast, because a toast disappears and the gap does not.

#### 9.4 Backpressure and caps

- **Socket → client.** `socket.bufferedAmount` is the gate. A slow or suspended browser never causes unbounded memory growth in apps/api: we stop polling for that socket. If it stays above the threshold for `TAIL_STALL_MS` (60 s) we emit one `error` frame and close with 1013.
- **Client → gigapipe.** `TAIL_LIMIT` bounds one frame; `TAIL_MAX_LAG_MS` bounds the backlog; every poll carries the read client's `AbortSignal.timeout`.

| Cap | Default | Why |
|---|---|---|
| `OP_LOG_TAIL_MAX_PER_PROJECT` | 5 **per process** | Five viewers is five queries per 2 s. Global bound is `5 × replicas` (§8.1). |
| `OP_LOG_TAIL_MAX_PER_PROCESS` | 100 | Bounds one replica's fan-out to gigapipe. |
| `OP_LOG_TAIL_IDLE_TIMEOUT_MS` | 900 000 (15 min) | A forgotten browser tab is the dominant cost. Emit `status { closing: true }` 60 s before. |

Over a cap, the socket is accepted and immediately sent `{ type: 'error', message: 'Too many live tails for this project' }` and closed with 1013, so the client renders a real message rather than a silent failure. Counts are per-process deliberately: the cap exists to bound *cost*, and cost is per-process; a Redis-backed global counter would add a failure mode (counter leaks on SIGKILL) for no benefit at these numbers.

**UI.** Incoming `lines` frames are prepended to a bounded ring of the newest 2 000 lines, deduped by `contentKey` multiset against the current head; auto-scroll to top only when the user is already within 40 px of the top; a pulsing dot plus "live — 340 lines/min" from the `status` frame; a `dropped` frame renders the inline divider. Turning live off freezes the ring and re-enables paging from the newest line held.

### 10. Saved queries (P6) — the designed successor

D6 defers this. Modelled directly on `Cohort` (`packages/db/prisma/schema.prisma:306-322`).

```prisma
model SavedLogQuery {
  id          String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  name        String
  description String?
  projectId   String
  project     Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
  /// [IPrismaSavedLogQuery]
  query       Json     @default("{}")
  createdBy   String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @default(now()) @updatedAt

  @@index([projectId])
  @@map("saved_log_queries")
}
```

```ts
// Derived from the UNREFINED base (§5.1), so this is Zod-major-agnostic and the
// window rule is re-applied explicitly rather than assumed to survive .omit().
export const zSavedLogQueryDefinition = zLogQueryBase
  .omit({ projectId: true, limit: true, direction: true })
  .superRefine(windowRule);
```

`packages/db/src/types.ts` gains `type IPrismaSavedLogQuery = z.infer<typeof zSavedLogQueryDefinition>` — the persisted object is the *query shape*, not the pagination state, and `projectId` comes from the row so a saved query can never carry a different one.

**Re-validation on read is mandatory, and it is the reason this model needs care.** A saved query is a `Json` column, so a matcher on a label that has since been un-promoted, or a reserved label added to `RESERVED_LOG_LABELS` in a later release, will be sitting in the database. `logs.savedList` parses each row through `zSavedLogQueryDefinition.safeParse` and returns `{ ...row, valid: boolean, issues: string[] }`; the UI renders an invalid saved query greyed out with "this query uses a label that is no longer available" and an **Edit** action rather than a **Run** action. Never pass an unvalidated stored object to `compileLogQuery` — that is the one path by which a stale `op_project_id` matcher could reach the compiler, and I1/I4 are enforced in the schema, not in the compiler alone.

Access: `savedCreate`/`savedUpdate`/`savedDelete` are mutations carrying `projectId` (create) or resolving it from the row (update/delete), so `enforceAccess` demands `write` on create and the handler calls `requireProjectAccess({ level: 'write' })` explicitly for the other two, exactly as `cohortRouter.get` resolves access from the loaded row (`packages/trpc/src/routers/cohort.ts:49-69`).

*Rejected:* storing a compiled LogQL string instead of the structured object. It would freeze the compiler's output at save time, so every compiler fix (the `notMatches` bug, the apostrophe mangling, a future rollup optimisation) would silently not apply to saved queries, and it would put an executable string in a `Json` column, which is exactly the shape D4 exists to avoid.

### 11. Logs ⇄ traces ⇄ sessions

`tid` and `sid` are in the envelope, so every rendered line already knows its trace.

**Log → trace.** `log-detail.tsx` renders a **View trace** button when `line.traceId` is set, linking to `/$organizationId/$projectId/traces/$traceId` (the P4 route). Until P4 lands the button is rendered *disabled with a tooltip*, not omitted — the affordance is the point.

**Trace → logs.** P4's waterfall gets a **Logs for this span** action navigating to the logs route with `ff=[{"field":"tid","operator":"is","value":"<traceId>"}]` and the trace's window ±30 s. That compiles to:

```logql
{op_project_id="…"} |= "<traceId>" | json f0="tid" | f0 = "<traceId>"
```

Note the **redundant line filter**. `|=` is a `like` on `samples.string` inside the same scan (`planner_line_filter.go:106-120`) and prunes the vast majority of rows before any `JSONExtract` runs. The compiler adds it automatically whenever a field filter on `tid` or `sid` uses operator `is`, because a trace id is a substring of the envelope if and only if the field matches. This is the single most important optimisation in the read path and it carries a comment in the compiler saying so.

**Logs ⇄ sessions / profiles.** `session.id` and `profile.id` propagated by an OpenPanel SDK arrive as OTLP attributes and land in `attr` as `session_id` / `profile_id` — never labels (§3.3 rule 3). The detail sheet renders **View session** / **View profile** links to `_app.$organizationId.$projectId.sessions_.$sessionId.tsx` and `_app.$organizationId.$projectId.profiles.$profileId._tabs.index.tsx` when those keys are present; the session detail page gets a "Server logs" tab in P4 filtering on `session_id`.

**UNVERIFIED:** whether OpenPanel's SDKs propagate a session id into an OTLP context at all. Settle by reading `packages/sdks/*` for OTel baggage or `traceparent` handling — those files were not opened, and nothing in `apps/api` sets one today. This blocks the P4 correlation story, not P3: the plumbing works for any customer that sets the attribute itself.

### 12. Self-instrumentation

`packages/logger` gains a third `LOG_EXPORTER` value, `loki`, alongside the existing `stdout` and `otlp` (`packages/logger/index.ts:9-14`): a pino transport batching lines to `POST /telemetry/loki/api/v1/push` with an internal telemetry token, `source="op_self"`. No new container, which keeps the parent plan's "without installing Grafana/Prometheus/Loki/Tempo" premise intact.

**One shipping path per signal.** `packages/logger/index.ts:9` and both `observability.ts` files point at a `logging-capture-plan.md` that does not exist in the working tree and never has. The rule it names must be restated here or logs land twice the moment a second exporter is added: **`LOG_EXPORTER` selects exactly one destination; `loki`, `otlp` and `stdout` are mutually exclusive.** Setting `LOG_EXPORTER=loki` disables the HyperDX pino mixin for logs.

*Rejected:* a collector container (Promtail / Alloy / Vector / Fluent Bit) in the compose template. It is a fourth container, a second config surface and a second set of credentials, to do something a pino transport does in 80 lines against an endpoint we already own.

### 13. Rollback and one-way doors

The draft had phasing and failure modes and no backout plan, while containing several changes that cannot be undone.

| Change | Reversible? | What a revert actually is |
|---|---|---|
| `ClientType.telemetry` enum value | **No, not while any row references it.** Removing a Prisma/Postgres enum value requires recreating the type. | Do not remove it. Revoke the clients (`Client.type` rows) and leave the value. Plan the enum addition as permanent from the first migration. |
| `samples_v3` partition key and sort key | **No, after the first write.** | Offline table rebuild: stop ingest, `CREATE TABLE samples_v3_new`, `INSERT SELECT`, `RENAME`. Hours on a real dataset. This is why §7.1 gates P0. |
| Four deny-list → allow-list conversions (§4.2) | Yes, but they change behaviour for **existing** clients. | A `write`-typed client that today reaches `/export`, `/insights`, `/import` or MCP would already be rejected; the conversion additionally rejects any *future* type. No existing customer breaks, but say so in the release note. Reverting re-opens the privilege grant, so the revert is "revert the whole telemetry migration", never these alone. |
| Explicit CORS deny for `/telemetry` (D11) | Yes, one branch. | Trivially reverted; nothing depends on it. |
| Scoped content-type parser | Yes. | Plugin-scoped: removing `telemetryRouter` removes the parser. Nothing outside `/telemetry/*` is touched. |
| `TelemetryUsage` + `TelemetryPurgeJob` models | Yes (drop tables). | Coordinated with metrics and traces — a revert of `TelemetryUsage` reverts all three signals' billing. Do not revert it alone. |
| Three cron schedulers | **Yes, automatically.** | `boot-cron.ts` removes every scheduler not in its `jobs` array (`boot-cron.ts:138-155`), so reverting the file cleans up on the next worker boot with no manual step. |
| Conditional TTL on `samples_v3` | Yes. | `ALTER … MODIFY TTL` back to gigapipe's single-expression form, or just change `SAMPLES_DAYS` and let gigapipe's rotation overwrite it (F5's failure mode, used deliberately). |
| `Project.telemetry*` columns | Yes (nullable, additive). | Drop columns. |

**Per-phase revert.** After P3.1 (compiler only): delete the package, nothing consumes it. After P3.2 (auth): revert the router and the client-type UI, keep the enum. After P3.3/P3.4 (ingest): unset `GIGAPIPE_WRITE_URL` — the routes 404 (D12) and no data is lost that was not already written. After P3.5+: unset `GIGAPIPE_READ_URL` — `telemetryEnabled` goes false, the tab disappears, ingest 404s, and the ClickHouse rows sit under the conditional TTL until it drops them. **That last one is the operator kill switch and it needs no deploy.**

### 14. gigapipe image upgrade runbook

The test plan calls the docker-compose integration test "the gate for every gigapipe image bump" and the env manifest says the I1–I3 tests are valid only for one exact configuration. Neither is a procedure. This is:

1. **Read the diff.** `git log --oneline <old>..<new> -- ctrl/qryn/sql/ ctrl/qryn/maintenance/ reader/logql/ writer/utils/unmarshal/` in the gigapipe tree. Those four paths are the ones this spec depends on: schema, migration ordering, planner behaviour, ingest mapping.
2. **Schema.** `updateScripts` replays every statement in `log.sql` in file order from the stored `ver` watermark. New DDL therefore runs against our pre-created `samples_v3`. Check specifically for a new `ALTER … MODIFY ORDER BY` on `samples_v3` (which would fail or, worse, succeed and change our key), a new column added **without** `IF NOT EXISTS` (which panics the boot, as `type_v2` would if we pre-created it), and any change to `log_dist.sql`.
3. **Boot the new image against a copy of a real dataset** in staging, with `OMIT_CREATE_TABLES` unset, and confirm the boot assertion (§7.1) is still green afterwards.
4. **Re-assert the TTL.** The image bump restarts gigapipe, and gigapipe's rotation runs on every boot. Run `cron.telemetry-retention.ts`'s assertion step manually and confirm `op_telemetry_ttl_drift == 0`.
5. **Run the CI integration test** against the new image: two projects, cross-tenant isolation, `/labels` unreachable, `notContains` excludes what it says, byte-truncated non-ASCII label round-trips to the fingerprint we computed.
6. **Rollback.** Pin the previous tag and restart. Data written by the newer version is readable by the older one **only if step 2 found no schema change**; if it did, the rollback is not a tag change and must be planned as a restore. State that in the change ticket before the bump, not after.

Bumps are staged: dev → CI → staging with real-shaped data → one Cloud canary → fleet. The pin lives in the P0 env manifest, and this spec's line-number citations are valid only for the pinned tag.

---

## Interfaces

### Consumed

| From | What | Contract |
|---|---|---|
| **P0 (stack)** | The `op-gigapipe` service across every deployment surface, with the env manifest (`SAMPLES_DAYS`, `LOG_DRILLDOWN=true`, `ADVANCED_OMIT_EMPTY_VALUES=false`, `ADVANCED_SAMPLES_ORDERING`, `QRYN_LOGIN`/`QRYN_PASSWORD` at `cmd/gigapipe/main.go:178-179`, no published ports, `QRYN_RULER_ENABLED` unset). | If any value differs, the I1–I3 tests are void. Also states the Cloud `apps/api` replica count, which every per-process cap multiplies by. |
| **P0** | **The bootstrap migration, owned and budgeted by P0**: the `gigapipe` database, the `gigapipe` CH user, grants, the `gigapipe_reader` settings profile (including `max_concurrent_queries_for_user`), and the pre-created **local** `samples_v3` with `PARTITION BY (toStartOfDay(…), type)` and `ORDER BY (fingerprint, timestamp_ns)`, branched on `isClickhouseClustered()`, **without** a `_dist` companion and **without** `type_v2`. | **Gate: gigapipe is not started against any ClickHouse instance until this has run and the boot assertion is green.** Irreversible once data lands. P3 is blocked on the artifact, not on a decision. |
| **P0** | `packages/db/src/gigapipe/client.ts` — shared HTTP client: exact-path allowlist, header hygiene, `step`-in-ms encoding, **abort-signal pass-through**, Basic auth on every call including health checks. | Metrics (P2), logs (P3) and traces (P4) all import it. Open question 7 is where it lives. |
| **P0** | The operator-alert destination and the Prometheus scrape of gigapipe's own `/metrics` (behind Basic auth). | §8.2 emits the signals; P0 owns where they land. |
| **P1 (ingest)** | `ClientType.telemetry`, `validateTelemetryRequest`, `resolveTelemetryClientId`, and the four deny-list → allow-list conversions in §4.2 — **including `insights.router.ts`, which shares `validateExportRequest`**. | Landing the enum without the conversions is a privilege grant. |
| **P1** | `isIngestionBlocked(projectId, signal)` in `apps/api/src/services/ingestion-block.ts`, with `subscription.hook.ts` refactored onto it. | Precedence rules in §4.3, including `telemetry_disabled` → 404. |
| **P2 (metrics)** | The `'yyyy-MM-dd HH:mm:ss'` naive-project-local date invariant and the `IChartSerie` shape. | Logs' histogram emits the same shape so `useRechartDataModel` is reused unchanged. |
| **Billing** | `TelemetryUsage` (**with `granularity` in the unique key**) + `TelemetrySignal` + `TelemetryGranularity`. | Shared with metrics and traces; one migration, coordinated. Reverting it reverts all three signals. |

### Exposed

| Symbol | Location | Consumers |
|---|---|---|
| `zLogQueryBase`, `zLogQuery`, `zLogStreamMatcher`, `zLogLineFilter`, `zLogFieldFilter`, `zLogSeverity`, `zLogCursor`, `zLogLabelsInput`, `zLogLabelValuesInput`, `zLogContextInput`, `RESERVED_LOG_LABELS` | `packages/validation/src/logs.validation.ts` | trpc, api, start, MCP (P6) |
| `ILogSeverity`, `ILogCursor`, `ILogQuery`, `ILogStreamMatcher`, `ILogLineFilter`, `ILogFieldFilter` (inferred types, all exported) | ibid | ibid |
| `compileLogQuery(input, {timezone, retentionDays}) → ICompiledLogQL` | `packages/db/src/gigapipe/logql.ts` | trpc `logs.*`, the P6 tail poller, the P6 MCP `query_logs` tool |
| `buildEnvelope`, `parseEnvelope`, `sanitizeAttrKey`, `truncateLabelValueBytes` | `packages/db/src/gigapipe/envelope.ts` | api ingest; **traces (P4) reuses `sanitizeAttrKey` and the byte truncation for span attributes** |
| `normaliseSeverity(number, text) → ILogSeverity` | `packages/db/src/gigapipe/severity.ts` | api ingest; traces (P4) for span status |
| `pushLogs(projectId, lines) → IPushResult` | `packages/db/src/gigapipe/logs.ingest.ts` | api ingest; the `packages/logger` loki transport |
| `gigapipeTable(name, 'read' \| 'mutate')` | `packages/db/src/gigapipe/table-name.ts` | **every gigapipe-database statement in every work-stream.** `getReplicatedTableName` must never be applied to a gigapipe table. |
| `PLAN_DEFAULT_RETENTION_DAYS`, `effectiveRetentionDays(project)` | `packages/db/src/gigapipe/retention.ts` | logs read path, settings mutation, metrics/traces clamps |
| `parseStreamsResponse`, `contentKey`, `IServiceLogLine`, `ILogPage`, `ILogHistogram` | `packages/db/src/gigapipe/logs.parse.ts` | trpc, start |
| `purgeTelemetry({projectId, reason, olderThanNs, signals, resumeJobId})` + `TelemetryPurgeJob` | `packages/db/src/services/telemetry-delete.service.ts` | worker retention cron **and** `jobDelete`; **metrics and traces must extend its `signals` union rather than writing their own purge** |
| `isTelemetryEnabled()` and the `telemetryEnabled` app-context flag | `apps/api`, `apps/start` | the Logs route, the sidebar, every `logs.*` procedure, the `/telemetry/*` routes |
| `trpc.logs.*` | `packages/trpc/src/routers/logs.ts` | start; P4's trace→logs navigation; P6 MCP |
| `Project.telemetryLabelKeys \| telemetryLogRetention \| telemetryLogsBlockedAt` | `packages/db/prisma/schema.prisma` | api ingest, worker crons, settings UI |
| Routes `/telemetry/v1/logs`, `/telemetry/loki/api/v1/push` (tagged `Telemetry` in the published OpenAPI doc) | `apps/api/src/routes/telemetry.router.ts` | customer agents; `packages/logger` |
| Extended `PureFilterItem` props (`values`, `valuesLoading`, `operatorAllowlist`, optional `eventName`) | `apps/start/src/components/report/sidebar/filters/FilterItem.tsx` | logs selector builder; **metrics (P2) should reuse the same seam rather than adding a third** |
| `op_telemetry_*` Prometheus metrics (§8.2) | `apps/api`, `apps/worker` | P0's operator alerting; metrics and traces should extend the same names with their own `signal` label |
| *P6:* `ILogTailFrame`, `SavedLogQuery`, `zSavedLogQueryDefinition` | as specified in §9, §10 | **not exposed in P3** — do not depend on them before then |

---

## Failure modes

| # | Failure | Detection | What the user sees | Mitigation |
|---|---|---|---|---|
| F1 | **Pagination cannot advance**: the boundary second holds ≥ `limit` matching rows. | Server returns `limit` rows; the client's multiset dedupe yields 0 fresh. | Inline marker: "more than 200 matching lines in this second — paging skipped the rest", clickable to zoom into that second. | Force-advance to `floorSec(oldestNs)`; the marker is the honest UI (§5.4). |
| F2 | **A `notMatches` line filter returns the inverse result set.** | Impossible for us: the operator is not in `zLogLineFilter`. A hand-edited URL is rejected by zod. | Validation error. | Operator removed until gigapipe fixes `planner_line_filter.go:80-93`; upstream bug filed. |
| F3 | **A `contains` search whose value starts or ends with `'` matches the wrong rows.** | `logql.test.ts` pins the emitted SQL; there is no runtime signal. | Silently over-broad results. | Documented in the compiler and in the search box's help text; upstream bug filed against `strings.Trim(enqVal, "'")`. |
| F4 | **gigapipe wins the pre-create race**; `samples_v3` has gigapipe's partition and sort key. | Boot assertion on `system.tables.partition_key` / `sorting_key`; `op_telemetry_bootstrap_ok == 0`. | `telemetryEnabled` false — the Logs tab is absent and ingest 404s, rather than a broken tab. Operator alert. | Loud on day one. Recovery is an offline rebuild (§13); the P0 gate exists to prevent it. |
| F5 | **`SAMPLES_DAYS` is edited**; gigapipe overwrites the conditional TTL on the next boot. | Nightly TTL assertion on `create_table_query`; `op_telemetry_ttl_drift == 1`. | Operator alert; no user-visible symptom until data disappears early. | Re-apply and alert. `SAMPLES_DAYS` documented immutable. |
| F6 | **gigapipe crash-loops** (ClickHouse version mismatch, bad credentials, `ON CLUSTER` against a nonexistent cluster). Its DB init `panic()`s under `restart: always`. | Container restart count; `op_telemetry_read_errors_total{code="ECONNREFUSED"}` rising. | "Logs are temporarily unavailable", with a link to the self-hosting troubleshooting doc. Event analytics unaffected. | Version spike before P0; `CLUSTER_NAME` unset on self-host. |
| F6b | **gigapipe was never installed** — the common state for an existing self-hoster who updates, since the generated compose file is gitignored. | `GIGAPIPE_READ_URL` unset → `telemetryEnabled` false at boot. | **No Logs tab at all**, not a broken one. `/telemetry/*` returns 404, not 500. | D12. Release note points at the compose instructions (open question 9). |
| F7 | **A push succeeds partially and the exporter resends.** | `op_telemetry_push_total{outcome="failed_transport"} > 0`. | Duplicate lines, collapsed within a rendered window by the content-key multiset but present in storage and in the meter. | Documented as at-least-once (§4.5). No storage-side dedupe exists. |
| F7b | **gigapipe is degraded and a transport failure is reported as success.** | Would be invisible — which is why D13 forbids it. | `503` + `Retry-After: 5`; the agent retries. | `partialSuccess` carries *only* permanently-invalid records. A test asserts a simulated gigapipe 500 produces 503, never a 200 with a non-zero rejected count. |
| F8 | **A runaway LogQL query saturates ClickHouse.** | `max_execution_time` / `max_bytes_to_read` throws from the `gigapipe_reader` profile; gigapipe returns 500. | "This query was too expensive. Narrow the time range or the selector." | Three bounds, not one: the settings profile per query, `max_concurrent_queries_for_user` across queries, `rateLimitMiddleware` on `logs.query`/`logs.detectedFields`, plus abort-signal pass-through so a cancelled request cancels the scan. The reader itself sets no limits (I10, verified at `reader/registry/registry.go:69`). |
| F8b | **Log ingest starves event ingest**: a degraded ClickHouse turns each push into a multi-second held connection in the process serving `/track`. | `op_telemetry_inflight_pushes` at the semaphore ceiling; `op_telemetry_breaker_open == 1`; `/track` p99 rising. | Agents get `503` + `Retry-After: 2` and back off; `/track` is unaffected. | The four bounds in §4.5 (sub-batch timeout, request deadline, bounded concurrency, per-process semaphore) plus the circuit breaker. Sized by the §8.1 load test. |
| F9 | **`LOG_DRILLDOWN` is off on a deployed container.** | 404 from `/detected_labels`, `/index/volume`. | The selector builder loses cardinality hints; the settings card loses the top-10. Querying still works. | `PRECONDITION_FAILED` with an operator-facing message. Never used as a feature probe: whether an unmatched path is 404 or 401 depends on gigapipe's basic-auth config. |
| F10 | **A promoted label explodes cardinality anyway** (the promotion-time sample was unrepresentative). | Daily reconciliation compares `/index/stats` streams against the budget. | Banner naming the label; the label is **not** removed. | Warning only. The user un-promotes it, which is a deliberate, announced fork of their streams. |
| F11 | **Redis is down** during ingest. | Cardinality observe and meter both throw; `op_telemetry_usage_flush_lag_hours` climbs. | Nothing — ingestion continues. | Fail-open, matching `subscription.hook.ts`. Metering for that window is lost; the daily reconciliation catches the drift. |
| F12 | **A telemetry token is revoked but keeps working.** | None. | Up to 5 minutes of continued ingestion on nodes other than the one that handled the revocation. | Documented property of the secret-verification cache (`packages/redis/cachable.ts:155-157, 290-294`), stated on the token page. |
| F13 | **A per-project purge mutation never completes.** | `op_telemetry_purge_age_seconds > 86400`, or `system.mutations.latest_fail_reason` non-null. | Settings card shows "purge in progress"; retention SLA missed. | Nightly job alerts. On the deletion path this is a compliance escalation, not a warning. |
| F13b | **`purgeTelemetry` throws and blocks every deletion.** | Journal row in `failed`; `op_telemetry_purge_pending` flat while `Project.deleteAt` rows accumulate. | Nothing — one project's deletion is deferred, everything else proceeds. | Per-project try/catch inside `jobDelete` (§7.4). The draft had none: one throw aborted the entire hourly cron. |
| F13c | **The worker dies between fingerprint resolution and the mutations.** | Journal row stuck in `resolved` with no `mutationIds`. | Nothing. | The journal (§3.6) makes the fingerprint set durable and `purgeTelemetry` resumable; the ordering contract forbids deleting the Postgres row before the journal row is committed. Without it the rows are unreachable forever. |
| F14 | **An empty-value or `.*` matcher reaches gigapipe.** | Impossible via the compiler (I1/I2). If it happened: either a widened `simpleJSONHas(...) = 0` scan, or a planner panic surfaced as a 500 by `tamePanic`. | 500, "something went wrong". | The I1 test is table-driven over matcher **position** (first, middle, last), because only the last position panics rather than widening — a single-case test passes for the wrong reason. |
| F14b | **A `/label/{name}/values` call is made with an empty match list.** | The client throws before the request. | Validation error. | I5. `Values` falls through to a tenant-free `NewValuesPlanner(nil, label, nil)` when `len(match) == 0` (`reader/service/query_abels.go:200-209`) — the same cross-tenant enumeration as I7, by a different door. |
| F15 | **A numeric field filter carries a non-numeric value.** | `zLogFieldFilter`'s `superRefine` rejects it at validation. | Validation error naming the field. | The unquoted numeric form bypasses `q()` escaping, and gigapipe's `NumVal` grammar accepts no sign and no exponent (`logql_parser/model.go:249-254`), so `-1` is a parse failure and arbitrary text is an injected LogQL fragment. Constrained at the schema, not in the compiler. |
| F16 | **A browser exporter reaches `/telemetry/*`.** | Preflight rejected by the explicit CORS deny (D11). | CORS error in the browser console. | The draft claimed omission from `corsPaths` blocked browsers; it does the opposite (`app.ts:116-124`). Router test asserts the preflight fails. |
| F17 | **A histogram step that is not a multiple of 15 s returns wrong counts.** | Impossible: the server rounds up and a test asserts it. | — | The 15 s rollup shortcut fires for **any** range ≥ 15 s (`analyze.go:111`) and re-buckets pre-aggregated 15 s rows with `intDiv(ts, D)*D` (`planner_metrics15s_shortcut.go:40-58`), so an off-multiple step produces unevenly-filled buckets — silently wrong, not slow. |
| F18 | **A gzipped `application/json` push 400s before the controller runs.** | Impossible after the scoped content-type parser; would otherwise be every Promtail, Vector, Alloy, OTel-JSON and `packages/logger` request. | — | apps/api registers no content-type parser today, so the built-in JSON parser would `JSON.parse` gzip bytes. §4.1. |
| F19 | **An agent pushes snappy-framed Loki protobuf before P3.4b.** | `415` with the supported encodings named. | "this endpoint accepts application/json only; configure your agent for JSON push, or use OTLP/HTTP". | Never a silent mis-parse. P3.4b implements block-format snappy + `logproto.proto`. |
| F20 | **A daily `TelemetryUsage` rollup row is overwritten by a late hourly flush.** | Impossible: `granularity` is in the unique key. | — | The draft's key was `(projectId, signal, hour)`, so a catch-up flush of an old hour-00 bucket would overwrite the daily row and destroy 23 hours of billing data (§4.6). |
| F21 | **A purge statement targets a table that does not exist on Cloud.** | `UNKNOWN_TABLE` from ClickHouse; journal row `failed`. | Retention and erasure SLAs missed. | `gigapipeTable()` (§7.2), never `getReplicatedTableName`, which appends OpenPanel's `_replicated` convention that gigapipe's schema does not use. The purge test asserts exact table names, not merely `ON CLUSTER`. |
| F22 | *(P6)* **A tail livelocks inside one second.** | `lagMs` growing while `dropped` stays 0. | Would be a frozen "live" view. | §9.2's `(floorSecNs, seen)` cursor plus the boundary force-advance. The draft's exact-ns exclusive cursor livelocks on any second holding > `TAIL_LIMIT` lines. |
| F23 | *(P6)* **A tail reconnects and never re-sends its query.** | Socket open, zero frames, `status` never arrives. | A pulsing "live" dot and no lines — during a deploy, which is when it is used. | `shouldReconnect: () => true` makes re-sending on every open mandatory; the handshake carries a clamped `sinceNs` and a counted `dropped{reason:'reconnect'}` frame. §9.1. |
| F24 | *(P6)* **A member removed from a project keeps receiving live logs.** | None, without the re-check. | Up to 15 minutes of continued access. | `getProjectAccess` re-checked every ≤ 60 s, close with 1008. A deliberate divergence from `wsProjectEvents`. §9.1. |

---

## Test requirements

Nothing ships until all of these pass.

| Test | File | Asserts |
|---|---|---|
| **compiler invariants** | `packages/db/src/gigapipe/logql.test.ts` | I1–I8, table-driven. `op_project_id` always first and `=`; **empty `projectId` throws, never emits**; `.*` rejected at the schema; an empty `stream` array still compiles to a bound selector; reserved labels rejected; the `targetLabels` validator rejects `a) + sum(...) by (b`; exactly one `match[]`; every `/index/stats` call carries a selector; quoting round-trips through `JSON.parse`. |
| **compiler — I1 by position** | ibid | An empty-value matcher supplied first, middle **and last** is rejected. |
| **compiler — I5 zero-match** | ibid | `labelValues` with an empty compiled match list **throws before any request is built**; the mock client is asserted un-invoked. |
| **compiler — operator mapping** | ibid | The emitted LogQL for every operator in all three filter kinds; `notMatches` absent from both matcher schemas; `matchesPattern` absent (P6); a `contains` value with leading and trailing apostrophes is pinned. |
| **compiler — regex anchoring** | ibid | A stream `matches` value emits `^(?:…)$`; a *line* `matches` value does not; the compiler-emitted `level=~"error\|fatal"` is unanchored. |
| **compiler — numeric operators** | ibid | `gt` with `'-1'`, `'1e3'`, `'abc'` and `'1} \|= "x"'` are **all rejected by the schema before `compileLogQuery` is reached**; `gt` with `'500'` and `'1.5'` emit `\| f0 > 500` unquoted. |
| **compiler — trace shortcut** | ibid | A field filter `tid is <hex>` also emits `\|= "<hex>"`, and `sid` likewise; a `tid` filter with any other operator does not. |
| **compiler — window** | ibid | `range: 'lastYear'` against 30-day retention clamps `startNs` and sets `clampedToRetention`; neither `range` nor `startDate`+`endDate` is a validation error. |
| **schema derivation (Zod major)** | `packages/validation/src/logs.validation.test.ts` | `zLogQueryBase` has no refinement; `zLogQuery` enforces the window rule; the histogram input and `zSavedLogQueryDefinition` are both derived from the base and re-apply it. A type-level check (`expectTypeOf`, plus a `tsc --noEmit` run in CI) over every derived schema, so a Zod major bump breaks loudly rather than at runtime. |
| **compiler — step encoding** | `packages/db/src/gigapipe/client.test.ts` | The emitted query string contains `step=60000ms`, never `step=60000`; the emitted step is always ≥ 15 000 **and a multiple of 15 000**; `{name}` is `encodeURIComponent`-ed; the caller's abort signal aborts the fetch. |
| **envelope** | `packages/db/src/gigapipe/envelope.test.ts` | JSON-body lifting; fixed key order; 64 KiB cap with largest-first attr drop; reserved-key stripping; byte-identical output for identical input; `sanitizeAttrKey('500ms') === '_00ms'` (matching `sanitizeRe`, **not** `SanitizeKey`); a non-ASCII label value truncates to ≤ 100 **bytes** on a codepoint boundary; **a label with an empty value is dropped by the gateway**; **a `v: 2` envelope with unknown keys degrades to the raw-line path without throwing**. |
| **fingerprint parity** | ibid | Our client-side fingerprint of a label set equals gigapipe's for the same set in any key order (`fingerprintLabels` is commutative, `unmarshal.go:250-270`). |
| **severity** | `packages/db/src/gigapipe/severity.test.ts` | All 24 OTLP numbers; `WARNING`/`Warn`/`warn`; unknown → `info`. |
| **stream parse** | `packages/db/src/gigapipe/logs.parse.test.ts` | Merge-sort across streams; `op_project_id` stripped and **`source` retained**; a non-envelope line renders; **five lines sharing one timestamp in one stream all survive with distinct `id`s**. |
| **pagination** | `packages/db/src/gigapipe/logs.cursor.test.ts` | No gap and no duplicate across a second boundary with three streams sharing a timestamp; **five identical lines at one ns are not collapsed by the multiset**; **a boundary second holding `limit` matching rows force-advances and sets `skipBoundarySecond`** rather than looping; the forward direction mirrors it. |
| **histogram shaping** | `packages/db/src/gigapipe/logs.histogram.test.ts` | Output is assignable to `IChartSerie[]`; `NaN`/`+Inf`/`-Inf` strings coerce to 0 before reaching `metrics.sum`; series are dense over the window; `date` is `'yyyy-MM-dd HH:mm:ss'` naive project-local, **not** ISO-with-Z. |
| **table naming** | `packages/db/src/gigapipe/table-name.test.ts` | Under `isClickhouseClustered() === true`, `gigapipeTable('time_series','read') === 'gigapipe.time_series_dist'` and `gigapipeTable('samples_v3','mutate') === "gigapipe.samples_v3 ON CLUSTER '…'"`; **neither ever contains `_replicated`**; both are plain names when non-clustered. |
| **body handling** | `apps/api/src/controllers/telemetry-logs.controller.test.ts` | **A `Content-Type: application/json` + `Content-Encoding: gzip` body is accepted and parsed** (the scoped parser is registered); the parser does **not** leak to `/track` or `/trpc`; a body over 4 MiB returns the per-protocol 413 shape; a body whose *decompressed* size exceeds the limit is rejected; an unknown `Content-Encoding` returns **415 naming the supported list**; `Content-Type: application/x-protobuf` on the Loki route returns 415 until P3.4b. |
| **header hygiene** | ibid | The outbound request carries none of `x-ch-dsn`, `x-scope-meta`, `x-ttl-days`, in either case. |
| **failure semantics** | ibid | A simulated gigapipe 500 produces **503 with `Retry-After`**, never a 200 with a non-zero `rejectedLogRecords`; a record with no body produces `partialSuccess` and a 200; the semaphore ceiling produces 503 + `Retry-After: 2` without a fetch; the breaker opens after N consecutive failures and closes on the first success after the window. |
| **CORS** | `apps/api/src/routes/telemetry.router.test.ts` | `OPTIONS /telemetry/v1/logs` with an arbitrary `Origin` is **rejected**; the same request against `/track` still gets `origin: '*'`. |
| **rate limit** | ibid | The 601st request in a minute from one client id returns 429; a second client id is unaffected; **a request authenticating with `Authorization: Basic` is keyed by client id, not by IP**; `SELF_HOSTED=true` does not limit. |
| **auth** | `apps/api/src/utils/auth.test.ts` (**new file — none exists today**) | A `telemetry` client is rejected by export, **insights**, import, manage and MCP; a `write`/`read` client is rejected by telemetry; `client.projectId == null` is rejected; `ignoreCorsAndSecret` does not bypass; an `Origin` matching `project.cors` does not bypass; `Authorization: Basic` is accepted; the cache key is a hash prefix, not the secret. Note `packages/mcp/src/auth.test.ts:8` mocks `ClientType` as an object literal, so it will *not* catch a missing case for the new value — this file must. |
| **blocking** | `apps/api/src/services/ingestion-block.test.ts` | Wind-down blocks both signals; a telemetry volume block blocks logs and not events; lifting one does not lift the other; `SELF_HOSTED` short-circuits volume and wind-down but **not** `telemetry_disabled`; `telemetry_disabled` returns **404**; each protocol gets its own response shape. |
| **capability gate** | `apps/start` route test + `packages/trpc/src/routers/logs.test.ts` | With `telemetryEnabled === false`: the sidebar has no Logs entry, the route redirects, and every `logs.*` procedure throws `PRECONDITION_FAILED` — not a connection error. |
| **router / access** | `packages/trpc/src/routers/logs.test.ts` | In the style of `packages/trpc/src/routers/share.test.ts` (`createCaller` with a mocked `@openpanel/db`): a caller without project access gets `FORBIDDEN` **before any gigapipe call is made** (assert the client was not invoked); a `logs.query` whose `stream` contains `op_project_id` is rejected; **a `logs.context` whose label map contains `op_project_id` is rejected**; `rateLimitMiddleware` fires on the 61st `logs.query` in a minute. |
| **schema shape at boot** | `packages/db/src/clickhouse/gigapipe-bootstrap.test.ts` | The generated DDL for the **local** `gigapipe.samples_v3` has `type` in the partition key and `fingerprint` first in the sort key, in **both** the clustered and non-clustered branches; the clustered branch emits `ReplicatedMergeTree`; **no `_dist` companion is emitted**; the DDL does **not** create a `type_v2` column. |
| **live TTL** | `apps/worker/src/jobs/cron.telemetry-retention.test.ts` | The assertion step detects a `create_table_query` whose TTL is gigapipe's single-expression form and re-applies the conditional one; `materialize_ttl_after_modify` is set explicitly per direction; the per-night budget stops before exceeding the mutation ceiling. |
| **purge** | `packages/db/src/services/telemetry-delete.service.test.ts` | Fingerprints are resolved **and journalled** before any delete; the retention path touches `samples_v3`/`metrics_15s`/`patterns` only; the deletion path additionally touches `time_series_gin` and `time_series`; **the read step targets `time_series_dist` and every mutate step targets the plain local name with `ON CLUSTER`** under `isClickhouseClustered() === true`, and plain names otherwise; `resumeJobId` skips fingerprint resolution and reuses the stored set. |
| **deletion wiring** | `apps/worker/src/jobs/cron.delete.test.ts` | `jobDelete` calls `purgeTelemetry` for every project id, **before** the Postgres rows are removed and only for projects whose journal row committed; **a throw from one project's purge does not prevent the other projects or any organization from being deleted**; the failing project's row is journalled `failed` and it is retried next run. |
| **usage flush** | `apps/worker/src/jobs/cron.telemetry-usage.test.ts` | A missed hour is caught up on the next run; the current hour is never flushed; re-running is idempotent; the meter increments from `IPushResult.accepted`, not from what was sent; **a catch-up flush of an hour already rolled up does not overwrite the daily row** (the `granularity` collision case); rows older than 30 days roll up to daily. |
| **cron registration** | `apps/worker/src/boot-cron.test.ts` | All three telemetry schedulers are present in `jobsToKeep` and are upserted; removing them from the `jobs` array removes the schedulers on the next boot. |

**Integration, not unit.** Everything above tests *our* code. I1–I3 rest on gigapipe planner behaviours that no upstream test covers, so the suite is completed by a **docker-compose integration test in CI** (`.github/smoke/`) that starts the pinned gigapipe image against the pinned ClickHouse, pushes two projects' logs, and asserts: project A's compiled query returns none of project B's lines; `/loki/api/v1/labels` is unreachable through our client; a `notContains` filter excludes what it says it excludes; a byte-truncated non-ASCII label round-trips to the same fingerprint we computed; and a `/label/{name}/values` with a compiled `match[]` returns only project A's values. **This is the gate for every gigapipe image bump** (§14) — the unit tests cannot detect a planner change.

**Load test, gating P3.3**, with the pass/fail in §8.1: 10 000 lines/s, ≥ 5 000 distinct log shapes, 10 minutes, `/track` running concurrently against the same process.

---

## Open questions

Renumbered; the draft's #14 (I10's evidence) is **closed** — `Settings: nil` at `reader/registry/registry.go:69` is verified, and the settings-profile workstream stands as written.

| # | Question | What would settle it | Blocks |
|---|---|---|---|
| 1 | **Sort key**: is `ORDER BY (fingerprint, timestamp_ns)` a net win over `(timestamp_ns)` for our workload? | Load one day of multi-tenant-shaped data into two tables differing only in `ORDER BY`; compare `read_rows` / `query_duration_ms` from `system.query_log` for (a) a narrow-selector explorer page and (b) a 30-day histogram. **Pass = the fingerprint-leading key reads < 20 % of the rows for (a) with no worse than 2× on (b).** | **P0 bootstrap** — the key is unchangeable afterwards. |
| 2 | **Conditional TTL under `ttl_only_drop_parts = 1`** over type-homogeneous partitions. | Run the multi-clause `ALTER … MODIFY TTL` against the pinned ClickHouse image with two days of mixed-type data; read `system.parts.delete_ttl_info_max` and confirm log parts drop at 30 days while metric parts survive. | **P0 bootstrap** |
| 3 | **gigapipe against the ClickHouse versions OpenPanel actually ships.** gigapipe's DB init `panic()`s on failure, so an incompatibility is a crash loop, not a degraded start. | Boot the pinned image against each ClickHouse version present across the deployment surfaces; confirm schema creation and a round-trip push/query. | **P0 bootstrap**; may force a ClickHouse bump on the Coolify surface. |
| 4 | **Can the Cloud ClickHouse user issue `CREATE USER` / `CREATE SETTINGS PROFILE`?** | Read `access_management` for the openpanel user on the Cloud cluster. If not, the user + grants + profile become a one-time operator runbook step and the migration asserts rather than creates. | **P0 bootstrap** |
| 5 | **ClickHouse profile vs gigapipe's writer settings.** Does a 30 s `max_execution_time` on the shared user break a large insert? | The §8.1 load test, or split into `gigapipe_reader` / `gigapipe_writer` users with two profiles. | P3.3 |
| 6 | **Purge mutation cost.** `ALTER … DELETE … WHERE fingerprint IN (subquery)` against `samples_v3` with a day of production-shaped data. | Run it; read `system.mutations.parts_to_do` over time and `system.query_log` for the merge cost. Sets the per-night budget in §7.4. | P3.10 |
| 7 | **Resource attributes are dropped from `attr`** (§3.2 rule 1). If design partners put non-constant data on the resource, this is data loss. | Ask two design partners for a sample OTLP payload. Ships with resource attrs excluded plus a `telemetryKeepResourceAttrs` project setting if the answer is yes. | P3.4 |
| 8 | **Where does the shared gigapipe HTTP client live?** This spec puts it in `packages/db/src/gigapipe/` because `@openpanel/db` is already a dependency of api, worker and trpc, and it is where the ClickHouse client lives. A separate `packages/telemetry` is arguably cleaner. | P0/P2 owners decide; metrics and traces share it. | P3.5 |
| 9 | **The self-host upgrade path.** The generated `docker-compose.yml` is gitignored and `./update` pulls the `self-hosting` **branch**, not `main`, so a template change reaches no existing install by itself. `apps/public/content/docs/self-hosting/high-volume.mdx:16-70` is the shipped precedent for hand-adding a service (`op-pgbouncer`) with instructions rather than a template edit. | Pick one: a docs page in that style, or a migration script. D12 means the tab is simply absent until the operator acts, so this is not release-blocking — but it decides how many self-hosters ever get logs. | P0 |
| 10 | **Are logs metered by envelope bytes or by body bytes?** §4.6 chose envelope bytes (what we store). A customer whose lines are 90 % attributes will find that surprising. | Billing decides. | P3.10 |
| 11 | **Do OpenPanel's SDKs propagate `session.id` / `profile.id` into an OTLP context?** §11's differentiator assumes they can. | Read `packages/sdks/*` for OTel baggage or `traceparent` handling. Not opened this pass. | P4 correlation, not P3. |
| 12 | **PII redaction in log bodies.** `Project.filters` applies to events only (§4.2); P3 closes the `attr.profile_id` half, but nothing scrubs an IP or a token from a *body*. | Product decision. Out of scope for P3 as specified — stated here, in the ingest docs and in the DPA-facing docs so it is a known gap, not an oversight. Project deletion remains the only erasure path. | — |
| 13 | **Backup/restore of the `gigapipe` database.** The self-hosting export/import scripts enumerate the `openpanel` database only. | Owned by P0; logs inherits whatever it decides. | — |
| 14 | **Cloud `apps/api` replica count.** Every per-process cap in this document (`PUSH_MAX_INFLIGHT_PER_PROCESS`, and P6's tail caps) multiplies by it, so the "bounded cost" claims are not actually bounded until it is written down. | P0's env manifest states it. | P3.3 |

---

## Effort

Engineer-weeks, one engineer, including tests and review. **The P0 bootstrap is no longer counted here** — §7.1 moves it and its four spikes into P0's budget, where the artifact and the gate belong. That is a real 1.5 w removed from P3 and added to P0, not a saving.

| Step | Deliverable | Blocked by | Size |
|---|---|---|---|
| P3.1 | `zLogQueryBase`/`zLogQuery` + `compileLogQuery` + envelope + severity + `gigapipeTable` + `retention.ts` + all compiler/envelope tests | — | **1.75 w** |
| P3.2 | `ClientType.telemetry`, four allow-list conversions, `validateTelemetryRequest` + Basic-auth resolution, `isIngestionBlocked` refactor, capability gate, client router + UI, rate limiter with explicit `keyGenerator`, CORS deny, `auth.test.ts` | **P1** | **1.25 w** |
| P3.3 | `/telemetry/loki/api/v1/push`: scoped content-type parser, gzip + decompressed guard, body limits, `pushLogs` with the four bounds + breaker, metering, load test | P3.1, P3.2; OQ 5, 14 | **1.25 w** |
| P3.4 | `/telemetry/v1/logs`: vendored protos, `protobufjs`, OTLP-JSON normaliser, D13 response semantics | P3.3 | **1.0 w** |
| P3.4b | Loki protobuf+snappy: `logproto.proto`, block-format snappy decode, normaliser, tests | P3.3 | **0.5 w** |
| P3.5 | Read path: gigapipe client (allowlist, abort signal, step encoding), `logs.query`/`logs.histogram`, cursor, parse, histogram shaping, router + access tests | P3.1 | **1.5 w** |
| P3.6 | Explorer: route, virtualised list, boundary marker, detail sheet, selector builder + `PureFilterItem` extension + both adapters, histogram, URL state, follow toggle | P3.5 | **2.5 w** |
| P3.7 | Detected fields, context expansion, column pinning | P3.6 | **0.75 w** |
| P3.8 | `purgeTelemetry` + `TelemetryPurgeJob`, retention cron + TTL assertion, `jobDelete` wiring with error isolation, usage flush + rollup, three cron registrations, Tier-1 settings card | P3.3; OQ 6 | **1.75 w** |
| P3.9 | Pipeline metrics (§8.2), CI integration test against real gigapipe + ClickHouse, image-bump runbook, docs (cardinality rules, at-least-once, agent setup, erasure SLA, filters-do-not-apply) | all | **1.25 w** |
| | | | **≈ 13.5 w** |

**Roughly three months for one engineer.** The draft's "eight weeks for two" is dropped: 15.25/2 rounded up assumes ~100 % parallel efficiency on a stream where P3.1's compiler, the shared gigapipe client (still unowned — OQ 8) and one `TelemetryUsage` migration shared with metrics and traces are all cross-cutting. **Two engineers is realistically 8–10 weeks**, with P3.2–P3.4b (ingest) and P3.5–P3.7 (read + UI) in parallel after P3.1 lands, and the range carries the coordination overhead rather than hiding it.

**The minimum shippable slice, named explicitly**, so a design partner is reached in ~6 weeks rather than ~13: **P3.1 + P3.2 + P3.3 + P3.5 + P3.6** — Loki JSON push, compiler, query, histogram, list, detail, URL state, follow toggle — at **≈ 8.25 w**, or ~6 w with the ingest and read lanes overlapped. OTLP (P3.4) is **not** cut from the MVP despite being a separable week: it is the protocol the OTel Collector and every OTLP SDK speak, and a logs product reachable only by Loki JSON is reachable by almost nobody. Everything after P3.6 is post-MVP by construction.

Deferred to P6: **live tail** (§9, **1.5 w** including the `useWS` decision, up from the draft's 1.25 w because the second-granular cursor and the reconnect handshake are real work); **pattern grouping** (§D8, **0.75 w**); **saved queries** (§10, **1.0 w** — a model, a coordinated migration, a `prisma-json-types.ts` entry, four procedures with two access paths, re-validation-on-read with a `valid:false` state, a combobox, a modal); **Tier-2 and Tier-3 quotas** including the plan-allowance schema that does not exist yet (**1.75 w**); the MCP `query_logs` tool (**0.5 w**); raw LogQL (**not costed — it is a gigapipe fork with an AGPL §13 publication obligation**).

**What could make P3 bigger.**

- **Open question 1 goes the wrong way.** If a fingerprint-leading sort key is a net loss, we either accept the cross-tenant read amplification — and then the ClickHouse profile is the only thing between one user and a saturated cluster — or we need a different physical design, which is a P0 redesign. **+2 w and a reopened P0.**
- **Open question 2 goes the wrong way.** If multi-clause conditional TTL misbehaves under `ttl_only_drop_parts = 1`, per-signal retention needs either `ttl_only_drop_parts = 0` (row-level merges, a real ongoing cost gigapipe deliberately avoided) or a partition-drop job written by us. **+1 w.**
- **Open question 3 goes the wrong way.** A ClickHouse incompatibility means either pinning an older ClickHouse for the whole product or carrying a gigapipe patch — and a patch means publishing the fork under AGPL §13. **+1–3 w and a licence obligation.**
- **The §8.1 load test fails on the clusterer.** gigapipe's ungateable per-line pattern clustering (D8) is the one ingest cost we cannot configure away. If it is the bottleneck at 10 000 lines/s with realistic shape diversity, the options are a lower per-project rate limit, a gigapipe patch (AGPL §13 again), or accepting a lower target. **+0.5 w to measure, +1–3 w to fix.**
- **`PureFilterItem` turns out to be load-bearing** in ways the report editor depends on. The alternative — a purpose-built label matcher in `components/logs/` — is roughly the same size but forks the operator UI. **+0.5 w either way; the risk is discovering it in P3.6 rather than deciding it now.**
- **P3.4b's snappy dependency.** `snappyjs` (pure JS, block format) is the assumption. If throughput forces a native `snappy`, that is a build-from-source risk under pnpm's `allowBuilds: false` posture. **+0.5 w.**

---

## Two upstream bugs this spec routes around

Both should be filed against `metrico/gigapipe` with a reproducing LogQL query, because routing around them is a permanent tax otherwise.

1. **`!~` line filter is compiled as a positive match.** `reader/logql/logql_transpiler/clickhouse_planner/planner_line_filter.go:80-93`: the `"!~"` case falls through to `sql.Eq(&SqlMatch{col: "string", pattern: val}, sql.NewIntVal(1))`, byte-identical to the `"|~"` case at `:66-79`. Only the plain-literal `re2Like()` shortcut takes the `notLike` path. `{…} !~ "foo.*bar"` therefore returns exactly the lines that DO match. The correct form is `NewIntVal(0)`, as the selector planner already does at `planner_stream_select.go:59-61`. No test in the repo covers it.

2. **`doLike` strips all leading and trailing single quotes from the search value.** `planner_line_filter.go:106-118` calls `StringVal.String` — which escapes `'` → `\'` and wraps the result in `'…'` (`reader/utils/sql_select/objects.go:262-275`) — and then `strings.Trim(enqVal, "'")`, which removes *all* quote characters at both ends, not just the wrapping pair it intended. A search for `'quoted'` becomes an over-broad `LIKE` pattern containing a stray escaped `%`. `strings.TrimPrefix`/`TrimSuffix` of a single quote each, or constructing the pattern without the round-trip through `StringVal`, would fix it.

Two lower-severity items worth reporting: **`/loki/api/v1/tail` writes an empty `dropped_entries` array unconditionally** (`reader/service/query_range.go:793-795`) while its poller silently discards everything below its per-tick top-N (`:718-735`, `:783`) — a client cannot distinguish "no data lost" from "everything lost"; and **`/loki/api/v1/label/{name}/values` with no `match[]` enumerates across every tenant** (`reader/service/query_abels.go:200-209`), which is the same shape of hazard as `/labels` and has no opt-out.
