# Deployment, retention, quota and billing

gigapipe runs as **two** compose services — one `MODE=init_only` one-shot that owns
gigapipe's own schema migration, and one long-running `MODE=all` node with
`OMIT_CREATE_TABLES=true` so it never issues DDL — against a second ClickHouse database
(`gigapipe`) on the instance OpenPanel already operates, with no published port and no
`depends_on` edge pointing *at* it from `op-api` or `op-worker`. The two tables whose
`PARTITION BY` we must own are pre-created by `packages/db/code-migrations/22-telemetry-database.ts`,
which `08-schema-changes.md` owns and which already runs inside `op-api`'s startup command;
this document only adds the compose edge that guarantees it runs *before* gigapipe's
migrator. Retention in v1 is **one window per signal for everyone** — metrics 30 d, logs
14 d, traces 7 d on cloud; a single operator-set `TELEMETRY_RETENTION_DAYS` on self-hosted
— enforced by a conditional table TTL that the retention cron re-asserts unconditionally,
with no mutations, no `ALTER … DELETE` sweep and no per-project join; per-plan tiering is
fully designed here and deliberately deferred behind a named trigger. Telemetry is metered
at the gateway in **emitted storage rows**, not accepted OTLP data points — the difference
is 10–60× for any histogram workload — converted to billing units at read time, rolled
into `telemetry_usage_daily` nightly, warned on the live counter and hard-shed at 120 % of
a seeded limit. Everything here is optional at runtime: an unset `GIGAPIPE_URL` disables
the ingest routes, the crons and the quota hook, and the stack starts and serves analytics
with gigapipe absent, crash-looping or unreachable.

Every path and line number below was read on disk in this session. Where something could
not be confirmed it is marked `UNVERIFIED:` with the specific experiment that settles it.
The AGPL section is a factual reading of files on disk and is **not legal advice**.

---

## Revision note — cross-document settlements absorbed in this pass

Five reviewers read all eleven specifications together. This document owns the compose file,
the environment surface, retention, metering and the operator runbook, so most of what they
found lands here as a **decision other documents must adopt**, not as a note. Every conflict
that touches ops is settled below in the direction the evidence supports. **Where a row says
"changes X", that document has not yet been edited — this is the ask.** `05-logs.md` and
`09-ui-surfaces.md` have already been revised in this round and several rows below record
agreements already reached there.

| # | Conflict | Settled as | What must change elsewhere |
|---|---|---|---|
| R1 | Five names for gigapipe's base URL, three for its credentials, three for the database, three for the cluster flag. `10` §3.1 claimed the matter settled and named `04` as the authority — but the names it attributed to `04` are not the names `04` uses (`04:703-704` is `GIGAPIPE_USERNAME`, `:757` is `GIGAPIPE_CLUSTER_NAME`, `:758` is `TELEMETRY_CLICKHOUSE_DATABASE`, `:718` is `GIGAPIPE_RETENTION_DAYS`) | **This document is the manifest** (D25, §3.1). `GIGAPIPE_URL`, `GIGAPIPE_USER`, `GIGAPIPE_PASSWORD`, `GIGAPIPE_DB`, `GIGAPIPE_CLUSTER` on the OpenPanel side; `CLOKI_LOGIN`/`CLOKI_PASSWORD` on the container; `CLICKHOUSE_TELEMETRY_URL` survives because it names a *ClickHouse endpoint*, not a gigapipe one. `GIGAPIPE_INTERNAL_URL`, `GIGAPIPE_READ_URL`, `GIGAPIPE_WRITE_URL`, `GIGAPIPE_LOGIN`, `GIGAPIPE_USERNAME`, `GIGAPIPE_CLUSTER_NAME`, `GIGAPIPE_CLUSTERED`, `CLICKHOUSE_CLUSTER_NAME`, `CLICKHOUSE_TELEMETRY_DB` and `TELEMETRY_CLICKHOUSE_DATABASE` are deleted | `02` §15; `03`:1816,2100; `04` §3's whole table **and** its CI grep list; `06` §5 and :358-359; `08`'s "Naming — settled" (`CLICKHOUSE_TELEMETRY_DB` → `GIGAPIPE_DB`); `11` gate 1.7 (`GIGAPIPE_INTERNAL_URL` → `GIGAPIPE_URL`). `05` row 14 already agrees |
| R2 | `ADVANCED_OMIT_EMPTY_VALUES` pinned `true` by `01` §3.1 and `false` by `05`; the env manifest that both cite — §3 here — contained neither | **`true`, and it is now in the table and in both compose services** (§2, §3). Verified this pass: `boolEnv` (`cmd/gigapipe/main.go:54-62`) maps unset to `false`, and at `false` the LogQL planner *deletes* any `=`/`=~` matcher with an empty value and any `=~".*"` matcher (`reader/logql/logql_transpiler/clickhouse_planner/planner_stream_select.go:31-46`). Unset shipped the fail-open | none — `01` §3.1 already decided it and `05` row 11 already made the edit. `11` W7 gains a source-level assertion on both compose files |
| R3 | `LOG_DRILLDOWN` required `true` by `05` D8, `false` here, and its four routes blocked outright by `01` D9 and `04` D3 | **`false`**, and §3's row now carries the reason rather than "cost with no consumer": with it on, gigapipe registers `/loki/api/v1/index/volume`, whose `targetLabels` is string-interpolated into a LogQL expression and re-parsed | none — `05` row 12 already rewrote D8 and moved label discovery onto `04` §9's direct-ClickHouse metadata service |
| R4 | Four helpers for naming gigapipe tables in four files, two exporting `TELEMETRY_TABLES` with different value shapes, reading four different env vars | **One home: `packages/db/src/clickhouse/telemetry-client.ts`** (`08` S10/S11), exporting `chTelemetry`, `telemetryDatabase()`, `TELEMETRY_TABLES` (**unqualified** values) and `telemetryTable(name, 'read' \| 'mutate')`. D26 | `04` D12 drops `G()`/`TELEMETRY_DB`; `06` §5 drops `g()`/`getTelemetryMutationTable()`/`TELEMETRY_IN` in favour of the shared ones; `05` already deleted `packages/db/src/gigapipe/table-name.ts` (its row 6) |
| R5 | `04` D12/`06` §5 route telemetry reads through `chQuery`; `08` S11 and `10` D19 forbid it | **D19 stands and is strengthened** (§5.2): on cloud the gigapipe database lives on a node named by `CLICKHOUSE_TELEMETRY_URL`, which `ch`/`chQuery` **cannot reach at all** — they resolve `CLICKHOUSE_URL`. This is not a preference about statistics logging; it is reachability. A read wrapper with `chQueryWithMeta`'s coercion and logging is added on the telemetry client | `04` §9's three catalogue queries and `06`'s seven trace queries move onto the telemetry client. `04` F21's round-robin coin-flip then stops being a live caveat |
| R6 | Two log-ingest architectures, and the `type ∈ {1,2}` invariant that `08` §13 and `10` D10 rest on | **`05` D1 wins** (its cardinality evidence was re-verified here: `writer/utils/unmarshal/otlplogs.go:24-60` folds resource, scope **and** record attributes plus `trace_id`/`span_id` into the label set) **and the invariant survives**, because type 0 requires a Loki value tuple with a *numeric third element* (`unmarshal.go:127-165` — `case 1` sets `LOG`, `case 2` sets `METRIC`, only both give `tp == 3 → 0`) and `pushLogs` emits exactly two. D10 is amended to say so | `02` §1 and its Interfaces row: the enforced constraint is "never forward a three-element Loki value tuple", not "never expose a Loki-shaped OpenPanel route" |
| R7 | The conditional TTL written two ways, with type 0 on opposite windows and different day counts | **`08` S12/S13's statement is authoritative and §6.1 now reproduces it byte-identically** — `toIntervalDay(n)`, `type != 1` / `type = 1`, plus the `patterns` clause §6.1 previously omitted. The windows are this document's (metrics 30 / logs 14 / traces 7 / labels 30) | `05` row 3 already deleted its own DDL. `08` §13's worked example must move off 90/30 and off its citation of a tier table this document defers (R8) |
| R8 | Five retention numbers, and one name used for both a scalar env var and a record | **`TELEMETRY_RETENTION = { metrics: 30, logs: 14, traces: 7, labels: 30 }`** is the cloud constant; **`TELEMETRY_RETENTION_DAYS`** stays the *self-hosted scalar env var* and nothing else (D9, §7.4) | `04` replaces `GIGAPIPE_RETENTION_DAYS` and its single `oldestQueryableAt` with per-signal values; `06`'s `TRACE_SEARCH_MAX_WINDOW_H` reads `TELEMETRY_RETENTION.traces * 24`; `08` §13 corrects its worked example and its `10-ops-retention-billing.md:925-932` citation — that range is the **deferred** tier table (§6.3), not current |
| R9 | `SAMPLES_DAYS` set from `TELEMETRY_RETENTION_DAYS` while §6.1 called it "the ceiling" | **`SAMPLES_DAYS = max(window)` on every surface** (D29). On cloud that is 30; self-hosted the single operator number *is* the max by construction. The old form could have deleted cloud metrics sixteen days early — the opposite of the stated bias | none; a test gate is added |
| R10 | Five kill-switch mechanisms in three namespaces with two polarities | **One namespace, two axes, one table** (D28, §10.3): `telemetry:disabled:*` / `telemetry:disabled:{projectId}` for ingest, `telemetry:reads:disabled:*` / `telemetry:reads:disabled:{projectId}` for reads. Presence means disabled. Ingest keys carry a **mandatory** TTL; read keys may be TTL-less because a disabled read surface is visible to every user | `04` D15 renames `op:gp:off*` into the read-side keys; `01` §11 and `06` §15 delete their variants (`05` row 15 already agrees) |
| R11 | Four HTTP statuses for a blocked telemetry ingest | **Three conditions, three statuses, one table** (§9.2): wind-down **403** (`02` §4, D15 — permanent, an unpaid org is not coming back this hour), quota shed **429 + `Retry-After`** (§9.3 — transient, clears on upgrade or period roll), operator kill switch **503 + `Retry-After`** (`02` §4, §10.3). The conflation is what produced four answers | `11` A15 asserts 429 for the *wind-down* case and must move to 403, keeping 429 as the quota-shed assertion; `06` §4.1 step 0's 202-and-drop must become 403 (`05` row 16 already agrees) |
| R12 | `10`'s retention cron would not compile against `08`'s schema | **`08`'s names win**: `TelemetrySchemaState.id` (not `key`), `telemetryDatabase()` (not `telemetryDb`). §6.2 is corrected | none |
| R13 | Three telemetry-metering Prisma models, and §8.3's rollup upserting on a key `08` does not declare | **`08`'s `TelemetryUsageDaily` is the model; this document's field list and this document's key.** `@@unique([projectId, day])`, `organizationId` denormalised and required, the nine counters of §8.3, plus `08`'s `finalizedAt` guard. §8.3's upsert now targets `projectId_day` | `08` replaces the model's field list (`metricDataPoints`/`logBytes`/`spans`/`units` → §8.3's nine) and keeps its own key. `05` already deleted `model TelemetryUsage` (its row 9) |
| R14 | `TelemetryUsageDaily`'s FK cascade (`08` Q3) flagged as a one-way door with no owner | **Decided here, because this stream owns billing semantics** (D30): `organization` is `onDelete: Cascade`, `project` is **`onDelete: SetNull` with `projectId String?`**. A project deleted mid-period must not restate an invoice | `08` Q3 closes; its migration 4 row records the answer |
| R15 | Two pre-create DDLs for the one irreversible table, disagreeing on which tables and on partition-key column order | **`08` S6/S7 own it**: both `samples_v3` **and** `metrics_15s`, `PARTITION BY (type, toStartOfDay(…))` — `type` first. D4 already pointed here and now says the column order out loud | none — `05` row 4 already deleted its DDL and its `gigapipe-bootstrap.test.ts` rows |
| R16 | `04` §11 states as a principle that this work-stream "does not create, migrate or ALTER anything in `TELEMETRY_DB`", which is an argument against the plan's one irreversible decision | **The pre-create stands** (D4). `04`'s drift concern is answered by `08` S7's column-order contract and the per-bump `log.sql` diff, not by declining to pre-create | `04` §11 becomes "this work-stream does not create or ALTER the gigapipe database; `08` migration 22 owns the two pre-created tables" |
| R17 | The ClickHouse settings profile phased three ways (`05` I10: P0 gate; `08` §12: "not optional"; `10` D16: P7) | **Split, and both halves keep a phase** (D16, §5.3): the `<profiles>` block lands in the tracked `clickhouse-user-config.xml` at **P0**, applied to the user gigapipe actually connects as (`default` in v1); the dedicated `op_gigapipe` user with a generated password and scoped grants stays in polish. Verified premise: the reader's `clickhouse.Options` is built with `Settings: nil` (`reader/registry/registry.go:69`) while the writer sets `max_execution_time` | `05` §7.4 and `08` §12 point at this decision instead of restating it (`05` row 25 already agrees) |
| R18 | Three Cloud stories for the one irreversible decision | **§5.2's answer is the decision**: one non-clustered gigapipe against a dedicated ClickHouse node named by `CLICKHOUSE_TELEMETRY_URL`. Cloud is unblocked at **P0**, not deferred | `08` S9 must re-derive its skip: `getIsCluster()` describes the *analytics* cluster and says nothing about a dedicated telemetry node. The gate is `GIGAPIPE_CLUSTER`, and `--force-telemetry` is the re-run |
| R19 | `QRYN_RULER_ENABLED` set `false` explicitly here, asserted **absent** by `11` W7 | **Set it explicitly** (D23) — gigapipe's own `Makefile:5` defaults it to `true` | `11` W7 asserts the *value*, not the absence, in both the shipped and the test compose |
| R20 | `11` D10/§2.3 build the P0 test harness on `self-hosting/clickhouse/gigapipe-provision.sql`, which D3 here explicitly refuses to ship | **It is not shipped.** Migration 22 inside `op-api`'s startup is the production mechanism and the test stack must exercise *that* | `11` replaces `tg-provision` with a container running migration 22 (a `jiti` invocation against `tg-ch`), rewrites W7 to assert the migration ran, and drops the file from its "needs from others" table |
| R21 | `apps/api`'s `/metrics` is reachable unauthenticated on a default self-host and `01` §Detection(e) calls fixing it a P0 prerequisite owned by somebody | **This document owns it** (§4.6) and it is a P0 line item. Verified: `self-hosting/caddy/Caddyfile.template:4` is `handle_path /api* { reverse_proxy op-api:3000 }` with no auth, and `apps/api/src/app.ts:372` registers `fastify-metrics` at `/metrics`, so `https://$DOMAIN/api/metrics` serves the dump. The worker's `/metrics` is already behind `basic_auth` on the `worker.` vhost (`:11-19`) | `01` §Detection(e) drops the claim that this is already owned; it is owned here now |
| R22 | Three phase vocabularies; this document used its own P0–P8 where the master scheme is P0–P6 | **Master P0–P6 only**, with a mapping table (§0) so existing citations of "10 D16's P7" still resolve | `08`'s six section headings use its own Postgres change ids P1–P10, which is legitimate but reads as phases; a one-word clarification there would end the confusion. `07` should name sibling streams by filename, never by number |
| R23 | Five specs add crons to the same three files, two using the same job name for different jobs, and `boot-cron.ts` unschedules anything absent from its array | **One inventory, published in §6.2** until `00-blueprint.md` exists to hold it. `05`'s per-project purge is renamed `telemetryPurge`; `telemetryRetention` is this document's TTL re-assert | `11` §7.2's exhaustive registration test asserts against the inventory; `05` §4.7, `06` §11.7, `07` D7 and `01` §Detection(b) each add their row |
| R24 | Nobody owns the deletion sweep, which `02` §17 names as the gate on enabling telemetry at all | **`08` owns the code; this document makes it a release gate** (§9.0): no tenant gets telemetry enabled until `11` gate 1.9 is green *and* the P1b volume ceiling exists | `08` files `deleteTelemetryFromClickhouse`, its call site and the `TelemetryErasure` ledger under P1 rather than under its "P4/P5/P7" heading |
| R25 | No volume or cardinality ceiling for four phases after the flag can be turned on | **A crude per-project bytes/day and series/day ceiling lands in P1b** (§9.0), enforced from the metering counters P1b already writes. The full quota machinery keeps its ordering | `02` D8's "not in P1" list loses the bytes-per-day ceiling |
| R26 | Stream and series metadata outlives log bodies by the metrics window, and nothing customer-facing says so | **§6.5 is a per-table effective-retention table**, including the metadata tables and the two families nothing expires, and it is the source for the customer-facing statement. Log-line retention and log-label retention differ, in writing | `01` §12's data-handling deliverable gets the named owner and phase gate in §4.7 |
| R27 | No documentation, legal or comms work-stream; `dpa.mdx` and `privacy.mdx` are named as required by three documents and owned by none | **§4.7 names the deliverables and the owner** and takes the ones adjacent to this surface (self-hosting page, sizing, retention statement, the four wind-down email templates, the changelog entry). The product-docs section and the legal edits are handed on explicitly rather than silently | `01` §12, `02` §16 and `05` P3.9 point at §4.7's manifest |
| R28 | Self-hosters have no scraper for the twelve gauges the plan defines | **Documented, not shipped** (D32, §10.6): gauges are on `op-worker`'s already-authenticated `/metrics`, a rule file ships beside the docs page, and an optional `op-prometheus` compose profile is a polish item. Cloud scrapes with its existing Prometheus | `05`'s Effort row that assigns "the operator-alert destination" to P0 is answered here |
| R29 | Self-instrumentation routed to by name from two documents, specified by none | **§10.5** names the owner, the internal org/project row, which signal goes where, and the `graceful-shutdown` flush gap | `06` Q7 and `01`'s Interfaces line point at §10.5 |
| R30 | Version skew: `./update` is a `git pull` on a branch, the compose file is gitignored, `get_latest_images` does not manage the gigapipe tag, and gigapipe's version endpoint is empty | **§11.2 gains `GIGAPIPE_SUPPORTED_VERSIONS` and a boot-time *schema-shape* probe** rather than a version probe, surfaced on `observability.status` as a degraded state with a named remedy | `04` adds the `degraded: 'schema_mismatch'` variant to `observability.status` |
| R31 | Two shipped deployment paths (community Helm chart, Dokploy template) get no answer | **Unsupported in v1, stated on both pages** (§4.5) with the service block and the env list for anyone who wants to add it | none |
| R32 | The published minimum spec ("At least 2GB RAM") becomes wrong with telemetry on | **§7.7** owns a sizing floor, the corrected line on both deploy pages, and a disk-headroom precondition in the connect flow | `09` D24's Settings tab refuses — or warns loudly — when `op_ch_disk_free_ratio` is below threshold |
| R33 | Support tooling is raw SQL and hand-composed Redis keys with mandatory TTLs | **`admin/src/commands/telemetry.ts`** (§9.6), modelled on `lookup-org.ts` | none |
| R34 | ~110 open questions and 61 `UNVERIFIED` markers across eleven documents, with colliding ids and duplicate experiments | This document's P0 gate list is **relabelled as the programme spike sheet** (§0.1) with the sibling ids each spike settles, so it can be lifted into `00-blueprint.md` unchanged when that document exists | every document replaces its duplicate question with a citation of a spike row |

Three findings are **rejected** rather than absorbed; each is argued at the end, under
"Findings rejected": shipping `op-prometheus` in v1, collapsing the read/ingest kill-switch
split into one key, and pulling per-plan retention tiering into v1 to satisfy `08`'s citation.

---

## 0. Phase vocabulary, and the spike sheet

### 0.1 Phases

This document previously used its own P0–P8. It now uses the **master scheme only**, and
every phase word below means the same thing it means in the other ten documents:

| Master phase | Content | What this document contributes |
|---|---|---|
| **P0** | the stack | compose services, env manifest, `quiz.ts`, `get_latest_images` fix, Caddyfile, the ClickHouse `<profiles>` block, the spike sheet, the docs page |
| **P1** | ingest | the unit weights, `metricDataPointSamples`, the Redis metering contract, the usage rollup, the TTL reconciler, and (P1b) the crude volume ceiling |
| **P2** | metrics | nothing new here beyond the billing widget's data source existing |
| **P3** | logs | nothing new here |
| **P4** | traces and correlation | nothing new here |
| **P5** | alerts | nothing new here |
| **P6** | polish | Polar catalogue, billing UI, threshold emails, the quota shed hook, the stack-health cron and disk guard, Coolify, the scoped `op_gigapipe` user, gigapipe `/metrics` republication, the optional `op-prometheus` profile |
| *(post-v1)* | trigger-gated | per-plan retention tiering (§6.3) |

**Mapping from this document's old numbering**, because `05` §7.5, `08` S16 and `11` cite it:
old P0 → P0; old P1 (metering) → P1; old P2 (TTL reconciler) → **P1**, moved forward
deliberately: retention must be enforced from the moment the first row lands, not two phases
later; old P3 (Polar/billing UI), P4 (emails), P5 (shed hook), P6 (stack health), P7 (Coolify,
scoped CH user) → **P6**, in that internal order, which is preserved and must not be
reordered (D13); old P8 (tiering) → post-v1, trigger-gated.

Within P6 the ordering is a hard constraint, not a preference: catalogue and billing UI, then
emails and thresholds, then the shed hook. A shed with no preceding warning is a support
incident (D13).

### 0.2 The spike sheet

The "P0 gates" list under Test requirements is written to be lifted into `00-blueprint.md`
verbatim when that document exists — it does not exist today, and nothing owns the
programme-wide pre-flight list. Each row there now names the sibling questions it settles, so
the de-duplication is done even while the sheet lives here:

| Spike | Also settles | Owner |
|---|---|---|
| `TTL … DELETE WHERE` multi-clause parse | `08` U3, `11` Q3/Q7, `05` OQ2 | ops |
| `metrics_15s MODIFY ORDER BY` no-op | `08` U1 | ops |
| `SHOW GRANTS` / `CREATE DATABASE` | `04` Q6, `06` Q1, `05` OQ4 | ops |
| `fastify-metrics` register handling | `01` Q4, `02` Q5, `04` Q7 | ops |
| gigapipe defaults from a booted container (`--help` / `GET /config`) | `03` §5's `ADVANCED_PROMETHEUS_MAX_SAMPLES` requirement | ops |

Two spikes this document does **not** own but which gate its P1: snappy prebuilds and framing
(`02` Q2/Q3) and Prisma's behaviour when an older client reads a `Client` row carrying the new
`telemetry` enum value during a rolling deploy (`11` Q11) — the latter is asked in exactly one
document and gates P1's first migration.

---

## Decisions

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| **D1** | Pin and reference `ghcr.io/metrico/gigapipe:v5.4.1`; never build or publish an OpenPanel-branded gigapipe image | build our own | Publishing a derived image is *conveying* under AGPL §6. Referencing upstream keeps §6 out of play entirely, exactly as `caddy:2-alpine` (`self-hosting/docker-compose.template.yml:5`), `postgres:14-alpine` (`:26`) and `redis:7.2.5-alpine` (`:48`) already are. See "AGPL posture" |
| **D2** | No `ports:` on any surface except the dev compose | publish 3100 behind Caddy basic auth | `MODE=all` mounts Elasticsearch write routes (`POST /_bulk`, `PUT /{target}/_doc/{id}` — `writer/router/elastic.go:9-14`), Influx, Datadog and an always-on cleartext-HTTP/2 gRPC OTLP receiver on the same port (`writer/grpc/mux.go`, `docs/otlp-grpc.md:8-21`). Basic auth *does* cover all of them once `CLOKI_LOGIN`/`CLOKI_PASSWORD` are both non-empty (`cmd/gigapipe/main.go:321-324`) — but it installs **only** when both are non-empty, and Compose substitutes a missing `.env` key with the empty string plus a warning. Network isolation is the layer that cannot be silently disabled by a typo |
| **D3** | Schema lifecycle is **two** gigapipe services: `op-gigapipe-init` (`MODE=init_only`) → `op-gigapipe` (`MODE=all`, `OMIT_CREATE_TABLES=true`). Our own pre-create DDL is **migration 22**, not a third container, and `op-gigapipe-init` gets `depends_on: op-api: service_healthy` to order it after `pnpm -r run migrate:deploy` | a third `op-gigapipe-provision` container mounting `gigapipe-provision.sql` | `initDB` runs for `all`, `writer` **and** `init_only` (`cmd/gigapipe/main.go:305-308`) and both `ctrl.Init` and `ctrl.Rotate` `panic(err)` (`ctrl/ctrl.go:31-33`, `:47-49`), so a long-running DDL-owning node crash-loops under `restart: always`. But a *third* service duplicates DDL that `08-schema-changes.md` S6 already owns, requires a mounted `.sql` (which `coolify.yml` would have to inline as a `content:` block), and adds a second one-shot to `docker compose up --wait`. `op-api` already runs `migrate:deploy` before it reports healthy (`docker-compose.template.yml:95-101`), so one `depends_on` edge does the ordering for free |
| **D4** | `samples_v3` and `metrics_15s` carry `type` in the `PARTITION BY`, created before gigapipe's first boot. This document does **not** write that DDL — `08-schema-changes.md` S6/S7/S8 does | let gigapipe create them | `PARTITION BY` cannot be `ALTER`ed and `rotateTables` unconditionally sets `ttl_only_drop_parts = 1` (`ctrl/qryn/maintenance/rotate.go:73-79`), under which a part survives until its *longest* TTL — so per-signal retention silently collapses to `max(logs, metrics)` unless partitions are signal-homogeneous. Both tables are `CREATE TABLE IF NOT EXISTS` (`ctrl/qryn/sql/log.sql:25`, `:83`), so whatever exists first wins. This is the one irreversible choice in the whole work-stream. **Column order is `(type, toStartOfDay(…))` — `type` first** — because two documents previously handed an implementer two strings for one un-`ALTER`able decision (R15). `04` §11's principle that this programme "does not create, migrate or ALTER anything in `TELEMETRY_DB`" is an argument against this decision and is answered in R16, not adopted |
| **D5** | `ADVANCED_SAMPLES_ORDERING="fingerprint, timestamp_ns"` set on both gigapipe services | gigapipe's default `timestamp_ns` (`ctrl/qryn/maintenance/update.go:214`) | With a time-only sort key adjacent rows belong to *different series*, so `CODEC(Gorilla)` on `value` and `CODEC(DoubleDelta)` on `timestamp_ns` (`log.sql:27-28`) XOR and delta unrelated numbers. On the pre-created surfaces the env var is **belt-and-braces**: migration 22 writes the sort key and gigapipe's `CREATE TABLE IF NOT EXISTS` is a no-op. It is the *sole* mechanism only where migration 22 has not run (a dev database created by hand). `08` S8 has migration 22 read the same env var so the two can never disagree. The redundancy is deliberate; do not "simplify" it away |
| **D6** | `BULK_MAX_AGE_MS=2000`, not the 100 ms default (`cmd/gigapipe/main.go:221-229`) | the default | ~10 inserts/s per signal into the ClickHouse instance that also serves analytics, and with `type` in the partition key each flush touches up to three partitions |
| **D7** | **No `depends_on` edge from `op-api` or `op-worker` to any gigapipe service.** The edge runs the other way: `op-gigapipe-init` depends on `op-api` | `condition: service_healthy` on op-api → gigapipe | `op-dashboard:122-126` and `op-worker:142-146` both depend on `op-api: service_healthy`. Making analytics wait on an optional observability container converts a telemetry outage into a product outage. The reverse edge is safe because both gigapipe services are removable |
| **D8** | gigapipe is **not** added to `apps/api`'s `/healthcheck` | add it alongside redis/db/ch | That endpoint is the container healthcheck and the compose dependency gate. A gigapipe blip would take `op-api` out of rotation and, transitively, the dashboard and every worker replica. `02-ingest-gateway.md` D10 makes the same call independently |
| **D9** | **v1 retention is one window per signal, for everyone**, enforced by a conditional table TTL that the retention cron re-asserts unconditionally. Per-plan tiering (and the `ALTER … DELETE` sweep it needs) is designed in "Retention — the deferred tiering design" and ships only when a named trigger fires. The windows are one exported record, **`TELEMETRY_RETENTION`**; **`TELEMETRY_RETENTION_DAYS` is the self-hosted scalar env var and nothing else** (R8) | ship per-plan, per-signal tiering in v1 | Tiering is nine windows, a per-project publication table, a nightly join through `time_series_gin`, mutation backpressure, a sweep watermark and a `system.mutations` monitor — ~1.5 weeks and a permanent mutation load on the ClickHouse that serves the analytics product — for a feature with zero telemetry customers. The conditional table TTL delivers working per-signal retention with zero mutations, zero cron state and zero new tables. Cost control in v1 is the unit quota, not the retention tier |
| **D10** | `type = 0` is treated as **metric** by the TTL, by metering and by deletion; every predicate is written as a **total** partition (`type != 1` / `type = 1`), never equality on 1 and 2 | equality; or treating type-0 as a log | `type` has three values — `0` = UNDEF/both, `1` = LOG, `2` = METRIC (`writer/model/insert_request.go:8-12`) — and 0 is written by *live* ingest, not only legacy rows (`writer/utils/unmarshal/unmarshal.go:163-165`, `:225-228`, the `if tp == 3 { tp = 0 }` collapse). Reader predicates are `type IN (n, 0)` (`reader/logql/logql_transpiler/clickhouse_planner/sql_misc.go:213-220`), so a type-0 row is visible to *both* signals; putting it on the log window would silently delete rows metric queries still return. Correct only while `metricDays >= logDays`, which is asserted before the DDL is emitted (`08` S13). **Amended (R6):** type 0 is not merely rare, it is *unreachable* from customer traffic — it requires a Loki value tuple with a numeric **third** element (`unmarshal.go:127-165`: `case 1` sets `LOG`, `case 2` sets `METRIC`, only both give `tp == 3 → 0`), and `pushLogs` (`05` D1) emits exactly two elements. So `08` §13 option (c) survives `05`'s Loki-JSON gateway. The totality of the predicate is now belt-and-braces rather than the only control, and the `SELECT count() … WHERE type = 0` gauge is what proves it |
| **D11** | The billing unit is derived from **emitted storage rows**, not accepted OTLP data points. `1 metric sample = 1`, `1 KiB of log body = 10`, `1 span = 20` | bill `metrics.datapoints` (accepted data points), as the draft did | gigapipe expands one histogram data point into `len(bucket_counts) + 1 + (sum?1:0)` samples (`writer/utils/unmarshal/otlp_metrics.go:373,379,385-387,391`), one summary into `len(quantile_values) + 2` (`:471-483`), and one `target_info` sample per resource per export (`:489-503`). A tenant sending latency histograms — i.e. any real OTel workload — would store 10–60 rows per billed unit while a gauge sender stores one. The fan-out is arithmetic over the payload the gateway already walks, not a copy of gigapipe's decoder, and it is pinned by a CI reconciliation test |
| **D12** | `subscriptionPeriodTelemetryLimit` is `Int` on `Organization`, `0` means **zero allowance**, and onboarding seeds `TELEMETRY_TRIAL_UNITS_LIMIT` exactly as it seeds `TRIAL_EVENTS_LIMIT` | `BigInt` columns and `limit <= 0` meaning unlimited (the draft's position) | Two reasons, both hard. (a) `getOrganizationByProjectIdCached` is `cacheable(…, 60*5)` (`packages/db/src/services/organization.service.ts:65-68`) and `cacheable` serialises with a bare `JSON.stringify(result)` (`packages/redis/cachable.ts:265`), which **throws `TypeError` on a BigInt**. `schema.prisma` contains no BigInt today; adding one to `Organization` would make every cache miss through `subscriptionHook` and `getOrganizationSubscriptionChartEndDate` reject. (b) Two sibling columns on one model where `0` means opposite things is the exact inversion a shared shedding helper gets wrong; `packages/trpc/src/routers/onboarding.ts:22-24` already documents the trap and its fix. Matches `08-schema-changes.md` S5 |
| **D13** | The shed hook ships in **P6, after the two email templates, which ship after the Polar catalogue**. One ordering, stated once. (This was "P5 after P4" in this document's own numbering; §0.1 maps it) | the draft's three different answers (P2 / P5 / "02 says P6") | A shed with no preceding warning is a support incident, and the column the hook compares against does not exist before P1. The *ordering* is the constraint; the whole block may be pulled forward together but never reordered. A crude volume ceiling exists from P1b (§9.0) so the gap is not unbounded |
| **D14** | 80 % and 100 % thresholds are evaluated **on the same live number the shed uses**, inside the quota hook, claim-guarded — not on the nightly rollup | evaluate thresholds in `telemetryUsageRollup` | The threat model that justifies shedding at all ("one `logger.debug` in a hot loop is 100× overnight") crosses 80 %, 100 % and 120 % inside a single night. A nightly warning arrives hours *after* the shed, so the grace band the design exists to provide never exists in the case it was designed for. The rollup keeps the thresholds as a backstop for orgs whose usage stops before a crossing |
| **D15** | Telemetry ingest is gated by the same `windDownStep ∈ {blocked, final_warning}` check as events, but answers **403**, not `202` | leave it ungated; or reuse the 202 | `subscription.hook.ts:19-23` explains that 202 exists because OpenPanel's own SDKs retry everything but 401/2xx. An OTLP exporter reads 2xx as "delivered, drop it". `02-ingest-gateway.md` §4 owns the status choice; this stream owns the reason it is gated at all: telemetry is ~10³× the bytes of a comparable analytics workload. **Three refusals, three statuses, one table (§9.2, R11):** wind-down 403, quota shed 429, operator kill switch 503. Conflating them is what produced four answers across the set; `11` A15 asserts 429 for the wind-down case and must move |
| **D16** | **Split, and both halves keep a phase (R17).** The `<profiles>`/`<quotas>` block lands in the tracked `self-hosting/clickhouse/clickhouse-user-config.xml` at **P0**, applied to the user gigapipe actually connects as — `default` in v1. The dedicated `op_gigapipe` **user** with a generated password and scoped grants is a **P6** follow-up whose blocker is resolved, not open | ship the whole thing in P0; or defer the whole thing | `self-hosting/clickhouse/clickhouse-user-config.xml` is git-tracked and mounted `:ro`, so writing a generated password into it dirties the tree and breaks `./update`'s `git pull`. The resolution is a *second*, gitignored file written by `quiz.ts` exactly as `writeCaddyfile` (`quiz.ts:37-58`) already writes a gitignored `caddy/Caddyfile`. That is a real PR, not a mystery — it is deferred on risk budget, not on knowledge. But the *user* is the only half that needs it: a settings profile can be attached to `default` in the tracked file with no generated secret and no gitignored companion, which is why the resource cap is P0. That matters because `05` I10 verified the reader's `clickhouse.Options` is built with `Settings: nil` (`reader/registry/registry.go:69`) while the writer sets `max_execution_time` — so **every** LogQL and PromQL read runs unbounded against the instance that serves analytics until the profile exists. `08-schema-changes.md` S16 and `05` §7.4 point at this decision |
| **D17** | Stack-health gauges are **written to Redis by the cron and read at scrape time by `collect()`** | set gauge values directly from the cron | `op-worker` runs `replicas: $OP_WORKER_REPLICAS` (`docker-compose.template.yml:154-157`), BullMQ delivers a scheduled job to exactly one replica, and the scrape hits whichever replica the proxy picks. Direct writes leave (N−1)/N of scrapes reading an unset gauge. The `async collect()`-over-Redis pattern already exists at `apps/worker/src/metrics.ts:40-70` |
| **D18** | The TTL is re-applied **unconditionally on every reconciler run** at `materialize_ttl_after_modify = 0`; drift state exists only to decide when `1` is needed. This adopts `08-schema-changes.md` S12/S14 and **replaces** the draft's `engine_full`-hash `TelemetryDdlState` | a desired/observed hash gate over `system.tables.engine_full` | Three things. (a) At `materialize_ttl_after_modify = 0` a `MODIFY TTL` is a metadata-only ALTER, so the thing the gate was avoiding is nearly free. (b) The gate has a blind spot: gigapipe's clobber is guarded by a row in `gigapipe.settings` keyed on the TTL string (`rotate.go:73-76`) which changes with `SAMPLES_DAYS`, with **no** change to any fingerprint we could compute. (c) The `engine_full` read and the ALTER would each be dispatched to an independently-picked node by `chQuery`/`ch` (`packages/db/src/clickhouse/client.ts:191-212`, `:263`), so the observed hash flaps on any multi-node deployment and the reconciler re-ALTERs forever — precisely the failure the mechanism existed to prevent |
| **D19** | Every OpenPanel-owned read, DDL and mutation against the `gigapipe` database goes through **`chTelemetry` / `getTelemetryClient()`** (`08` S10/S11), never through `ch`, `chQuery` or `chMigrationClient`. **This now covers ordinary catalogue and trace reads too** (`04` §9, `06`'s seven queries), which is a change those documents must reflect (R5) | reuse `chQuery` for reads and pin only DDL | `chQuery(query, clickhouseSettings)` takes ClickHouse *settings* as its second argument, not query parameters (`client.ts:373-378`) — there is no `query_params` path — and `ch`/`chQuery` round-robin across every entry in a comma-separated `CLICKHOUSE_URL` with failover. DDL that must be repeatable and readable-back needs one pinned node. `chInsert`, `chCommand` and `getIsTelemetryEnabled` **do not exist** in the repo; the real APIs are `ch.insert(...)` / `ch.command({query, clickhouse_settings})` (`client.ts:305-316`, used at `delete.service.ts:65-70`). The decisive argument for reads is not statistics logging but **reachability**: on cloud the gigapipe database lives on the node named by `CLICKHOUSE_TELEMETRY_URL` (§5.2), which `ch`/`chQuery` never dial. To keep what `chQueryWithMeta` gives (`Int` coercion, statistics logging — `06` T14 depends on it), the telemetry client exports a read wrapper with the same behaviour rather than a second convention |
| **D20** | `CLUSTER_NAME` unset on every self-host surface; the clustered story is cloud-only and needs `CLICKHOUSE_READ_CLUSTER` handled separately | set it, because `<macros><cluster>` exists | `self-hosting/clickhouse/clickhouse-config.xml:23-28` declares the macro and comments it "Not used anymore"; there is no `<remote_servers>` anywhere in the repo. `CLUSTER_NAME` flips `Cloud = true` (`cmd/gigapipe/main.go:97-99`) and makes every DDL `ON CLUSTER`, which fails, which panics, which crash-loops. `08` S9 makes migration 22 no-op on the clustered path for the same reason |
| **D21** | The gateway meters **after** a successful forward to gigapipe | meter on accept | Otherwise a gigapipe outage bills customers for data that was never stored. The consequence — at-least-once metering, so a client retry of an accepted batch double-counts — is honest, because the duplicate rows really are stored (`samples_v3` is a plain `MergeTree` and deduplicates nothing, `02` D15) |
| **D22** | Telemetry is explicitly **out of scope for backup and point-in-time restore**. `gigapipe.ver` and `gigapipe.settings` are in the backup set unconditionally | back it up like analytics | Retention is 7–30 days, a restore from outside the window hands back data the customer is not entitled to, and a large tenant's telemetry (~2 TB) would dominate the backup budget for the product that actually is the product. `ver` is unconditional because losing it is now known to be **fatal**, not conditionally fatal — see "Failure modes" F7 |
| **D23** | `QRYN_RULER_ENABLED=false`, explicitly | leave it unset | gigapipe's own `Makefile:5` and `scripts/test/e2e/docker-compose.yml:23` default it to `true`. Its rule routes carry no auth of their own beyond the global basic auth, and it accepts, stores and re-serves alerting rules it will never evaluate (`07-alerting.md` D1). `11` W7 currently asserts the variable is **absent** from the test compose, which this decision breaks the moment it lands — W7 must assert the value instead (R19) |
| **D24** | `STORAGE_POLICY` left **unset** | set a hot/cold policy | `storagePolicyUpdate(…, "metrics_15s", "metrics_15s")` (`rotate.go:135`) and `rotateTables(…, "metrics_15s", logger, "metrics_15s")` (`rotate.go:192-197`) share the bookkeeping setting name `metrics_15s`. With a policy set they overwrite each other's `settings` row and **both re-run their ALTERs on every init**, including `MODIFY SETTING ttl_only_drop_parts = 1` and `MODIFY TTL`. With it unset, `storagePolicyUpdate` returns before `putSetting` (`rotate.go:103-105`) and the collision cannot happen |
| **D25** | **§3 is the environment manifest and it is normative.** One name per thing, published here, adopted by every other document rather than the reverse | let `04-read-path.md` be the authority, as this document previously claimed | `04` §3 is a *consumer* table; these names are the ones written into `.env.template`, `coolify.yml`, `quiz.ts` and both compose files, which is where a name becomes real. The claim that the matter was already settled was itself stale — the names attributed to `04` are not the names `04` uses (R1). The failure mode is not cosmetic: `cmd/gigapipe/main.go:321-324` installs basic auth only when *both* credential values are non-empty, and Compose substitutes a missing `.env` key with the empty string plus a warning, so a name mismatch between the compose file and the boot assertion yields a **silently unauthenticated gigapipe** with every healthcheck green (F2) |
| **D26** | **One file names gigapipe's tables: `packages/db/src/clickhouse/telemetry-client.ts`.** It exports `chTelemetry`, `telemetryDatabase()`, `TELEMETRY_TABLES` with **unqualified** values (`samples: 'samples_v3'`) and `telemetryTable(name, 'read' \| 'mutate')` | four helpers in four files, two of them exporting the same symbol with different value semantics | Qualification is the helper's job, so a caller cannot double-qualify; the read form appends `_dist` when `GIGAPIPE_CLUSTER` is set and the mutate form never does; the cluster predicate is `GIGAPIPE_CLUSTER`, **never** `isClickhouseClustered()` (`client.ts:83-95`, true unless `SELF_HOSTED`, which says nothing about gigapipe) and never `getIsCluster()` (`helpers.ts:17-25`, false by default — the two disagree on cloud with neither variable set). `08` S10/S11 is the home because it is the only one that is lazy, memoised and pinned to a single node, which DDL and mutations both require. R4 |
| **D27** | **Log ingest is `05` D1's shape — `apps/api` decodes OTLP and pushes Loki JSON — and the `type ∈ {1,2}` invariant survives it** | forward OTLP to gigapipe's `/v1/logs` per `02` §1, on the grounds that the Loki path is the one that emits type 0 | Both halves are verified. gigapipe's OTLP-logs decoder folds resource, scope and record attributes plus `trace_id`/`span_id` into the *stream label set* with no allow-list and no configuration (`writer/utils/unmarshal/otlplogs.go:24-60`), which is one new fingerprint per trace-correlated line. And type 0 needs a Loki value tuple with a **numeric third element** (`unmarshal.go:127-165`); `pushLogs` emits two. So the constraint `02` must enforce is "never forward a three-element value tuple", not "never expose a Loki-shaped OpenPanel route". D10, R6 |
| **D28** | **One kill-switch namespace, presence-means-disabled, split by axis:** `telemetry:disabled:*` / `telemetry:disabled:{projectId}` for ingest, `telemetry:reads:disabled:*` / `telemetry:reads:disabled:{projectId}` for reads. Ingest keys carry a mandatory TTL; read keys need not | five mechanisms in three namespaces with two polarities; or one key for both axes | `04` D15 is right that a read-enforcement incident must not stop correctly-stamped ingest — telemetry that is refused is *lost*, telemetry that is stored but unreadable is not. `02` §4 is right that an ingest block must expire, because a forgotten ingest block is silent data loss. A forgotten *read* block is not silent: every user sees the banner. So the TTL rule differs by axis, deliberately, and a gauge pages if a read block outlives 24 h. §10.3, R10 |
| **D29** | **`SAMPLES_DAYS` is `max()` over the per-signal windows on every surface**, not `TELEMETRY_RETENTION_DAYS` | set it from the same variable the compose already interpolates | `ctrl.Rotate` stamps one unconditional TTL from it, and an F5 clobber must **over**-retain, never delete. With cloud metrics at 30 d and `SAMPLES_DAYS` at 14, a clobber deleted metrics sixteen days early — the exact opposite of the stated bias. On self-hosted the operator's single number *is* the max by construction, so the compose interpolation is unchanged there and only the cloud manifest and the comment move. R9 |
| **D30** | `TelemetryUsageDaily` is keyed **`@@unique([projectId, day])`** with `organizationId` denormalised and required; the `organization` relation is `onDelete: Cascade` and the `project` relation is **`onDelete: SetNull` with `projectId String?`** | `@@id([organizationId, projectId, day])` (this document's own earlier ask); or `Cascade` on both | Three models with three keys were in flight (R13). One key, written once, and `08` owns the declaration. The cascade is the half nobody owned (`08` Q3, flagged there as a data-losing migration if changed after rows exist): a project deleted mid-period must not silently restate that period's invoice, and `telemetry_usage_daily` holds counters only — no personal data — so retaining the row after project deletion creates no erasure obligation. Decided now because the cost is entirely in *when* it is decided |
| **D31** | This document uses the **master P0–P6 vocabulary** and publishes a mapping from its own former P0–P8 | keep local phase numbers | Three numbering schemes were in simultaneous use and a scheduler reading two documents would sequence alerting behind traces. §0.1 |
| **D32** | **Self-hosted operators get the gauges and a rule file, not a Prometheus.** Cloud scrapes with the Prometheus it already runs | ship an `op-prometheus` service in the compose template in v1 | The gauges are on `op-worker`'s HTTP app (`apps/worker/src/index.ts:73`), which the template already puts behind `basic_auth` on the `worker.` vhost (`Caddyfile.template:11-19`) — so the destination exists and is already authenticated. What is missing is a *statement* and a rule file, not a container. Adding a scraper adds a service, a volume, a retention policy and an upgrade path to a product whose pitch is that you do not need one; an optional compose profile is a polish item, and §10.6 says which one Cloud uses |
| **D33** | **This stream owns the operator-facing documentation and the customer-facing retention statement; it does not own the product docs section or the legal edits, and it names them rather than assuming them** | leave `dpa.mdx`, `privacy.mdx` and the product docs unowned, as the eleven documents collectively did | A per-subject erasure position that contradicts the published privacy policy is ship-blocking for a paid EU product, and no document listed either file. §4.7 is the manifest and the handoff |

---

## Design

### 1. The ownership boundary with `08-schema-changes.md`

`08-schema-changes.md` is finalised and owns more of this area than the draft assumed.
Reading it first avoids duplicating — or contradicting — settled decisions.

| Thing | Owner | Handle |
|---|---|---|
| `CREATE DATABASE gigapipe`, `samples_v3` and `metrics_15s` pre-create DDL, cluster no-op, `--force-telemetry` | **08** | `packages/db/code-migrations/22-telemetry-database.ts` (S6–S9) |
| The ClickHouse client bound to the telemetry database | **08** | `packages/db/src/clickhouse/telemetry-client.ts`, `getTelemetryClient()` (S10, S11) |
| The conditional TTL **statement** and the three settings that make it work | **08** | S12, S13. §6.1 reproduces it byte-identically, including `toIntervalDay(n)` and the `patterns` clause |
| Drift state model | **08** | `TelemetrySchemaState { id, desiredFingerprint, materialized, lastError, lastErrorAt, appliedAt }` (S14). **The primary key is `id`, not `key`** — this document's §6.2 said `key` and would not have compiled (R12) |
| The table-name helper, `TELEMETRY_TABLES`, `telemetryDatabase()`, `telemetryTable()` | **08** | `telemetry-client.ts` (S10/S11), extended per D26. `04`'s `G()`, `06`'s `g()`/`TELEMETRY_IN` and `05`'s `packages/db/src/gigapipe/table-name.ts` all collapse into it |
| Telemetry deletion on project / org / account delete | **08** | `deleteTelemetryFromClickhouse`, called *inside* `deleteFromClickhouse`, `TelemetryErasure` ledger (S15) |
| `ClientType += telemetry`, `TelemetryUsageDaily`, `Organization` counter columns | **08** | S3, S4, S5 |
| The cron that **runs** the TTL DDL, the cadence, the failure handling | **this document** | §6 |
| The retention **windows** and the exported `TELEMETRY_RETENTION` record | **this document** | §6.1, §7.4. `04`'s `GIGAPIPE_RETENTION_DAYS` and `05`'s `PLAN_DEFAULT_RETENTION_DAYS` are deleted in favour of it |
| Every environment variable name on both sides, and the compose interpolation | **this document** | §3, D25 |
| The kill-switch namespace, its polarity and its TTL policy | **this document** | §10.3, D28 |
| The telemetry cron inventory | **this document**, until `00-blueprint.md` exists | §6.2 |
| Unit weights, Redis metering contract, rollup, quota, emails, billing UI | **this document** | §7–§8 |
| Compose service graph, gigapipe env vars, `OMIT_CREATE_TABLES`, `SAMPLES_DAYS` | **this document** | §2–§3 |
| ClickHouse profile/quota for gigapipe | **this document** | D16, §5.3. The `<profiles>` half is **P0** |
| `Caddyfile.template` and the `/api/metrics` exposure | **this document** | §4.6 |
| The operator-facing docs page, the sizing floor and the retention statement | **this document** | §4.5, §4.7, §6.5, §7.7 |

Two deltas this document formally adopts, so `08` and `10` agree:

- **`08` S14 replaces the draft's `TelemetryDdlState`.** The `engine_full`-hash desired/observed
  protocol is cut. See D18.
- **`08` S5 replaces the draft's `limit <= 0 = unlimited`.** See D12.

One delta this document asks `08` to absorb, listed again under "Interfaces":
`getTelemetryClient()`'s fallback to `CLICKHOUSE_URL` must resolve to a **single** node when
`CLICKHOUSE_URL` is a comma-separated list — take the first entry deterministically — because
DDL that is applied and then read back must hit the same server.

### 2. Compose services

Added to `self-hosting/docker-compose.template.yml` after `op-api` (`:92-119`), because
`op-gigapipe-init` now depends on it.

```yaml
  # ---------------------------------------------------------------------------
  # Observability (gigapipe). Never exposed: apps/api is the only client.
  # Full design: docs/observability/. Remove both services to disable, and
  # blank GIGAPIPE_URL in .env (the wizard does both).
  # ---------------------------------------------------------------------------

  # 1/2 - gigapipe's own schema bootstrap. MODE=init_only runs ctrl.Init +
  # ctrl.Rotate and returns before mux.NewRouter() is called
  # (cmd/gigapipe/main.go:305-308): zero routes, no listener, exit 0.
  #
  # depends_on op-api is ORDERING, not health coupling: op-api's command runs
  # `pnpm -r run migrate:deploy` before `pnpm start` (see op-api above), and
  # migration 22 pre-creates samples_v3 / metrics_15s with `type` in the
  # PARTITION BY. If gigapipe's migrator got there first the partition key
  # would be gigapipe's, permanently -- PARTITION BY cannot be ALTERed.
  #
  # SAMPLES_DAYS is max() over the per-signal windows, because ctrl.Rotate
  # stamps one unconditional TTL from it and an F5 clobber must OVER-retain,
  # never delete (D29). On self-hosted TELEMETRY_RETENTION_DAYS is one window
  # for all three signals, so it IS the max; on cloud the manifest sets 30,
  # which is TELEMETRY_RETENTION.metrics, and the retention cron then replaces
  # the stamped TTL with the conditional two-clause one.
  op-gigapipe-init:
    image: ghcr.io/metrico/gigapipe:v5.4.1
    restart: "no"
    depends_on:
      op-api:
        condition: service_healthy
    environment:
      - MODE=init_only
      - CLICKHOUSE_SERVER=op-ch
      - CLICKHOUSE_PORT=9000
      - CLICKHOUSE_DB=gigapipe
      - SAMPLES_DAYS=${TELEMETRY_RETENTION_DAYS:-14}
      - ADVANCED_SAMPLES_ORDERING=fingerprint, timestamp_ns
      # Set on init too, so the two blocks stay copy-safe and one source-level
      # assertion covers both. init_only never boots a reader, so it is inert
      # here -- it is load-bearing on the node below. See the runtime block.
      - ADVANCED_OMIT_EMPTY_VALUES=true
      - LOG_LEVEL=info
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"

  # 2/2 - the long-running node. OMIT_CREATE_TABLES makes initDB return at
  # main.go:65-72, so this container never issues DDL and never re-stamps our
  # TTL. No ports: see D2.
  op-gigapipe:
    image: ghcr.io/metrico/gigapipe:v5.4.1
    restart: always
    depends_on:
      op-gigapipe-init:
        condition: service_completed_successfully
    environment:
      - MODE=all
      - OMIT_CREATE_TABLES=true
      - CLICKHOUSE_SERVER=op-ch
      - CLICKHOUSE_PORT=9000
      - CLICKHOUSE_DB=gigapipe
      - SAMPLES_DAYS=${TELEMETRY_RETENTION_DAYS:-14}
      - ADVANCED_SAMPLES_ORDERING=fingerprint, timestamp_ns
      - BULK_MAX_AGE_MS=2000
      - ADVANCED_PROMETHEUS_MAX_SAMPLES=50000000
      - QRYN_RULER_ENABLED=false
      - LOG_DRILLDOWN=false
      # SECURITY, not tuning. boolEnv maps unset to false (main.go:54-62), and
      # at false the LogQL planner silently DELETES any `=`/`=~` matcher whose
      # value is empty and any `=~".*"` matcher
      # (clickhouse_planner/planner_stream_select.go:31-46) -- including the
      # op_project_id matcher that is the only thing separating tenants. At
      # true it breaks out of that loop and keeps every matcher, so an empty
      # id matches nothing. 01-tenancy-and-security.md 3.1 decides this.
      - ADVANCED_OMIT_EMPTY_VALUES=true
      - LOG_LEVEL=warn
      - CLOKI_LOGIN=${GIGAPIPE_USER:?GIGAPIPE_USER must be set}
      - CLOKI_PASSWORD=${GIGAPIPE_PASSWORD:?GIGAPIPE_PASSWORD must be set}
    healthcheck:
      # The image is alpine:3.21 with a single static binary (Dockerfile:11-16).
      # There is no curl. busybox wget supports --header but not --user, and
      # /ready is behind the same global basic-auth middleware as every other
      # route (cmd/gigapipe/main.go:321-324 applies app.Use over the whole
      # table, commonroutes included), so an unauthenticated probe 401s.
      test:
        - CMD-SHELL
        - >-
          wget -q -O- --header="Authorization: Basic $$GIGAPIPE_BASIC_B64"
          http://127.0.0.1:3100/ready | grep -q OK
      interval: 15s
      timeout: 5s
      retries: 5
      start_period: 30s
    env_file:
      - .env
    deploy:
      resources:
        limits:
          memory: 2G
    logging:
      driver: "json-file"
      options:
        max-size: "30m"
        max-file: "3"
```

Three mechanics worth stating, because each one has a failure mode that looks green:

1. **`${GIGAPIPE_USER:?…}` is deliberate.** gigapipe installs its auth middleware only when
   *both* values are non-empty (`cmd/gigapipe/main.go:321-324`). Compose substitutes a missing
   `.env` key with the **empty string plus a warning**, so a plain `$GIGAPIPE_USER` would
   silently produce an unauthenticated gigapipe on a network where every other container —
   and anything an operator later attaches — can reach `POST /loki/api/v1/push` and `/_bulk`.
   `:?` makes Compose refuse to start instead. The primary delivery path for existing installs
   is a docs page telling people to paste service blocks into a hand-edited compose (§4.5),
   which is exactly how the five `.env` keys get forgotten.
2. **`GIGAPIPE_BASIC_B64` comes from `env_file`, not `environment:`**, and is used only by the
   healthcheck's `$$`-escaped shell. `apps/api` computes its own header from
   `GIGAPIPE_USER`/`GIGAPIPE_PASSWORD` and must not read it.
3. **`start_period: 30s` is required.** `MODE=all` boots writer → reader → ruler → view
   (`main.go:340-356`) and the reader opens its pool during `reader.Init`.

No new named volume: gigapipe is stateless, all state is in `op-ch`.

#### 2.1 The `/ready` trap, and why the runtime node is `MODE=all`

`/ready` calls `watchdog.Check()` (`shared/commonroutes/controller.go:12`), which returns nil
only if `lastSuccessfulCheck` is within 30 s (`reader/watchdog/watchdog.go:53-58`).
`lastSuccessfulCheck` is refreshed by a 5 s ticker started in `watchdog.Init`, and
`watchdog.Init` is called from exactly one place: `reader/reader.go:104` — i.e. **only when the
reader boots**.

So on `MODE=writer` the package-level `lastSuccessfulCheck = time.Now()` is never refreshed and
`/ready` returns 200 for the first 30 s of process life and 500 forever after. A writer-only
node with a `/ready` healthcheck restart-loops on a 30 s cycle. This is a second, independent
reason the runtime node is `MODE=all`, and it is recorded for any future split-mode deployment.

On `MODE=all`, `/ready` is a genuine ClickHouse-liveness probe, which is what we want. The
watchdog also `panic`s after 6 consecutive failures (`watchdog.go:41-43`), so ~30 s of
ClickHouse being down kills the process; `restart: always` handles it, and because nothing
depends on `op-gigapipe` (D7) it is inert.

#### 2.2 Resources

| Service | Limit | Reasoning |
|---|---|---|
| `op-gigapipe` | `memory: 2G` | The writer holds one in-flight column buffer per insert service (`writer/plugin/qryn_writer_db.go` builds seven), each sized by `MaxQueueSize` × channel count. **UNVERIFIED:** both defaults live in `cloki-config` v0.0.96, which is not in this machine's module cache and is not vendored. 2 GiB is a placeholder to be replaced by the measured RSS ceiling from the load test in Test requirements |
| `op-gigapipe` CPU | unset | Protobuf decode is in the gateway (`apps/api`), not here |
| `op-ch` | unchanged | The template sets no memory limit on ClickHouse today. Telemetry roughly doubles the insert rate and adds three merge trees; §10 monitors merge backlog and free disk rather than pre-emptively capping |

Do **not** add `mem_limit` and `deploy.resources.limits.memory` together — Compose V2 honours
both and the interaction is version-dependent. The template already uses the `deploy:` form
(`docker-compose.template.yml:154-157`), so match it.

### 3. Every environment variable, and why

**This table is the manifest (D25).** Read off `cmd/gigapipe/main.go`. Anything not listed is
left at its default deliberately, and a variable that appears in another document but not here
does not exist.

#### 3.0 The gigapipe container's variables

| Var | Value | Source line | Why this value |
|---|---|---|---|
| `MODE` | `init_only` / `all` | `:207-210`, `:305-308` | `all` is the only mode that mounts both paths *and* initialises `reader/watchdog` (§2.1) |
| `OMIT_CREATE_TABLES` | `true` (runtime only) | `:65-72` | Parsed by `boolEnv` (`:55-64`), which accepts **only lowercase** `true/1/yes/y` and panics otherwise. `True` crash-loops the container |
| `CLICKHOUSE_SERVER` | `op-ch` | `:100-104` | Compose service name; there is no `networks:` block so this resolves |
| `CLICKHOUSE_PORT` | `9000` | `:106-113` | Native TCP. Already the default; setting it documents intent |
| `CLICKHOUSE_PROTO` | **unset** | `:126-134` | The switch only has cases for `http`/`https`. `gigapipe/docs/configuration.md:24` claims the default is http; the code disagrees. Do not rely on either — set the port |
| `CLICKHOUSE_DB` | `gigapipe` | `:91-96` | `InitDB` early-returns for `""` and `"default"` (`maintain.go:41-43`), so a real name is mandatory. Must equal OpenPanel's `GIGAPIPE_DB` (§3.1); a boot assertion checks it |
| `CLICKHOUSE_AUTH` | **unset** | `:115-121` | `CLICKHOUSE_SKIP_USER_SETUP=1` on `op-ch` (`docker-compose.template.yml:76`) keeps `default` password-less, and gigapipe's own integration stack runs the same way (`gigapipe/test/integration/docker-compose.yml:13-27`). D16 |
| `CLUSTER_NAME` | **unset** | `:97-99` | D20 |
| `SAMPLES_DAYS` | `max()` of the windows — `${TELEMETRY_RETENTION_DAYS:-14}` self-hosted, `30` on cloud | `:146-153` | D29. | `TTLDays = 7` is set unconditionally at `:146` *before* the env is read, so unset means 7, not 0. `0` **is** a hard boot failure (`maintain.go:28-29` → `panic` at `main.go:76-79`), which is why there is no "disable rotation" value |
| `STORAGE_POLICY` | **unset** | `:155-157` | D24 |
| `ADVANCED_SAMPLES_ORDERING` | `fingerprint, timestamp_ns` | `:123-125` | D5. Interpolated only into `CREATE TABLE` (`update.go:214,221-223` → `{{.SAMPLES_ORDER_RUL}}` at `log.sql:32`), so it is fresh-install-only *and* inert wherever migration 22 already created the table |
| `BULK_MAX_AGE_MS` | `2000` | `:221-229` | D6 |
| `BULK_MAX_SIZE_BYTES` | **unset** | `:213-219` | UNVERIFIED: default lives in `cloki-config`. Settle with `docker run --rm ghcr.io/metrico/gigapipe:v5.4.1 --help` and by watching RSS under §9 |
| `ADVANCED_PROMETHEUS_MAX_SAMPLES` | `50000000` | `:201-207` | The PromQL engine's `MaxSamples`. `03` §5 requires it to be set *explicitly* because `MetricsMaxSamples` has no in-tree default and is global across every tenant. **Stated plainly, so all three documents stop implying otherwise: at 50 M this pin is documentation of intent, not a bound.** 50 M is also Prometheus's own upstream default, and gigapipe's own default comes from `cloki-config`, which is absent from this machine. The spike sheet (§0.2) settles the real default from a booted container; until it does, the only *actual* ceiling on a runaway metric query is gigapipe's fixed, non-configurable 30 s engine timeout plus the ClickHouse settings profile D16 lands at P0. When the default is known, set a value deliberately below it (Q6) |
| `QRYN_RULER_ENABLED` | `false` | `ruler/router/init.go:30-36` | D23. Note the ruler uses a *different, more lenient* bool parser than `boolEnv` — it also accepts `on` |
| `ADVANCED_OMIT_EMPTY_VALUES` | **`true`** | `:159` (→ `ClokiReader.OmitEmptyValues`) | **Security, not tuning.** `boolEnv` maps unset to `false` (`:54-62`), and at `false` the LogQL stream planner walks the selector and silently *removes* every `=`/`=~` matcher with an empty value and every `=~".*"` matcher (`reader/logql/logql_transpiler/clickhouse_planner/planner_stream_select.go:31-46`); at `true` it `break`s out of that loop and keeps them all. The compiled `op_project_id` matcher is the only thing separating tenants on the LogQL read path, so an empty or malformed id must match **nothing**, not *everything unlabelled*. `01-tenancy-and-security.md` §3.1 decides this and lists it in F7 as one of four controls; `05` has made the matching edit. Set on both services (§2) |
| `LOG_DRILLDOWN` | `false` | `:231-237` | Gates `/loki/api/v1/patterns`, `detected_labels`, `detected_fields`, `index/volume` and the `patterns` table's write path. **Not "cost with no consumer" — a removed attack surface.** `01` D9 blocks all four routes from the allowlist and `04` D3 removes them from `GIGAPIPE_ROUTES`, because `QueryVolume` string-interpolates `targetLabels` into a LogQL expression and re-parses it, which `05` I6 demonstrates as a working cross-tenant injection. `05` D8 previously required `true` everywhere; that is resolved against it (R3) and label discovery now comes from `04` §9's direct-ClickHouse metadata service |
| `QRYN_SYSTEM_SETTINGS_OTLP_MAX_MESSAGE_SIZE` | *(see note)* | not read by any in-tree `os.Getenv` | `01`'s Interfaces asks for this to be set explicitly so the gateway's body caps derive from a known number rather than the 64 MiB default. **UNVERIFIED:** no `os.Getenv` for it exists in `cmd/gigapipe/main.go`; if it is settable at all it is through `cloki-config`'s own env convention, which is not vendored. Same spike as the other `cloki-config` defaults (§0.2). Until it resolves, `02` §15's caps are enforced in the gateway and the 64 MiB ceiling at `writer/controller/otlp_metrics.go:25-42` is the backstop |
| `TZ` | `UTC` | container env | `06` F9 asks for it explicitly, together with an explicit UTC ClickHouse `timezone`. Timestamp arithmetic crosses three processes; none of them should infer a zone |
| `LOG_LEVEL` | `warn` / `info` | `:270-272` | UNVERIFIED: accepted values are consumed by `cloki-config`, not by any in-tree `os.Getenv` switch. Confirm against a booted container |
| `CLOKI_LOGIN` / `CLOKI_PASSWORD` | generated | `:172-183` | Applied by `app.Use` at `:321-324`, covering **every** route including `/ready`, `/config` and `/metrics`, and mirrored onto the gRPC receiver as interceptors (`writer/grpc/server.go:101-103`). `CLOKI_*` is assigned after `QRYN_*` in `portEnv`, so it wins if both are set — use `CLOKI_*` |
| `PORT` / `HOST` | **unset** | `:193-200`, `:301-303` | Defaults 3100 / 0.0.0.0. The published image also sets `ENV PORT 3100` (`Dockerfile:13`) |
| `X-CH-DSN` / `X-Ttl-Days` / `X-Scope-Meta` | n/a | `writer/controller/middleware.go:165-174` | Not env vars, but the gateway **must strip these from every customer request**. `writer/chwrapper/factory.go:246-268` contains caller-supplied-DSN dialing primitives that are unwired today but one line from being wired. `X-Ttl-Days` is parsed and materialised onto `MTTLDays` (`writer/model/insert_request.go:116,162,178`) and then **no insert service writes a TTL column** — do not plan around it |

**Never mount a `-config` YAML.** `portCHEnv` early-returns at `main.go:84-86` when
`DATABASE_DATA` is already populated, which silences *every* ClickHouse env var above
including `SAMPLES_DAYS` — and `maintain.go:28-29` then hard-errors at boot when `ttl_days`
is 0. Env-only configuration is a requirement, not a preference.

#### 3.1 New `.env` keys

Added to `self-hosting/.env.template`. Every existing key in that file is a `$TOKEN`;
these follow the convention, which is what makes the off-switch work (§4.1).

```bash
# Observability (optional). A blank GIGAPIPE_URL disables every telemetry route,
# both crons and the quota hook; the stack starts and serves analytics with
# gigapipe absent, crash-looping or unreachable.
GIGAPIPE_URL="$GIGAPIPE_URL"
GIGAPIPE_USER="$GIGAPIPE_USER"
GIGAPIPE_PASSWORD="$GIGAPIPE_PASSWORD"
GIGAPIPE_BASIC_B64="$GIGAPIPE_BASIC_B64"
GIGAPIPE_DB="$GIGAPIPE_DB"
TELEMETRY_RETENTION_DAYS="$TELEMETRY_RETENTION_DAYS"
```

**Naming — decided here, not elsewhere (D25).** The previous version of this paragraph
claimed the matter was settled and named `04-read-path.md:283-297` as the authority. That was
stale in both directions: `04`'s table uses `GIGAPIPE_USERNAME` (`:703-704`, `:751`),
`GIGAPIPE_CLUSTER_NAME` (`:757`), `TELEMETRY_CLICKHOUSE_DATABASE` (`:758`, `:1899`) and
`GIGAPIPE_RETENTION_DAYS` (`:718`, `:756`) — none of which is what this document writes into
`.env.template`, `coolify.yml`, `quiz.ts` and two compose files. Since those files are where a
name becomes real, this document is the manifest and `04` §3's table is a consumer of it.

**The complete OpenPanel-side surface. Nothing else exists.**

| Name | Owner | Default | What it is |
|---|---|---|---|
| `GIGAPIPE_URL` | this doc | *(unset)* | Origin of the gigapipe node, e.g. `http://op-gigapipe:3100`. A path is refused (`04`'s `bad_base_url`). **Unset is the single capability flag**: `isTelemetryEnabled()` is `!!process.env.GIGAPIPE_URL`, and it gates the ingest routes, both crons, the quota hook and every read procedure |
| `GIGAPIPE_USER` | this doc | *(unset)* | Basic-auth user. Must equal the container's `CLOKI_LOGIN` |
| `GIGAPIPE_PASSWORD` | this doc | *(unset)* | Must equal the container's `CLOKI_PASSWORD`. Set with a set URL and empty credentials ⇒ `degraded: 'insecure'` (`04` F18) |
| `GIGAPIPE_BASIC_B64` | this doc | *(unset)* | `base64(user:password)`, redundant by construction, written by `quiz.ts` and read **only** by the compose healthcheck's busybox `wget`. `apps/api` computes its own header |
| `GIGAPIPE_DB` | this doc | `gigapipe` | The ClickHouse database gigapipe owns. Must equal the container's `CLICKHOUSE_DB` |
| `GIGAPIPE_CLUSTER` | this doc | *(unset)* | **Set if and only if the container's `CLUSTER_NAME` is set, and to the same value.** The sole cluster predicate for anything touching the gigapipe database: it drives the `_dist` suffix in `telemetryTable(name,'read')` and the `ON CLUSTER` clause in DDL (D26) |
| `TELEMETRY_RETENTION_DAYS` | this doc | `14` | **Self-hosted only.** One window for all three signals, fed to `SAMPLES_DAYS`. On cloud it is unset and `TELEMETRY_RETENTION` (§7.4) is the source |
| `CLICKHOUSE_TELEMETRY_URL` | `08` | *(unset, falls back to `CLICKHOUSE_URL`)* | The ClickHouse **endpoint** holding the gigapipe database. Survives the consolidation because it names a ClickHouse server, not a gigapipe one, and on cloud it is a different node from the analytics `CLICKHOUSE_URL` (§5.2). Its path segment, when it has one, wins over `GIGAPIPE_DB` (`08` §11) |
| `GIGAPIPE_TIMEOUT_MS`, `GIGAPIPE_MAX_CONCURRENCY`, `GIGAPIPE_FANOUT_CONCURRENCY`, `GIGAPIPE_MAX_RESPONSE_BYTES` | `04` | see `04` §3 | Read-path tuning. Listed so the CI grep's allow-list is complete |

**Deleted, with the document that must stop using each.** A CI grep — `04` already proposes
one and it now enforces *this* list — fails the build on any of them:

| Deleted name | Used by | Replacement |
|---|---|---|
| `GIGAPIPE_INTERNAL_URL` | `02` §15, `02:61`, `11` gate 1.7 | `GIGAPIPE_URL` |
| `GIGAPIPE_READ_URL`, `GIGAPIPE_WRITE_URL` | `05:1014-1015` (already withdrawn in `05`'s revision) | `GIGAPIPE_URL`. The split had no consumer in any other document: nothing in the plan points the reader and the writer at different nodes |
| `GIGAPIPE_LOGIN` | `02` §15, `02:1860` | `GIGAPIPE_USER` |
| `GIGAPIPE_USERNAME` | `04:703`, `04:751`, `03:1816`, `03:2100` | `GIGAPIPE_USER` |
| `GIGAPIPE_CLUSTER_NAME` | `04:757`, `04:1923`, `04` T18a/F21 | `GIGAPIPE_CLUSTER` |
| `GIGAPIPE_CLUSTERED` | `06:358-359` | `GIGAPIPE_CLUSTER` |
| `CLICKHOUSE_CLUSTER_NAME` | `05:1421` | `GIGAPIPE_CLUSTER` |
| `TELEMETRY_CLICKHOUSE_DATABASE` | `04:758`, `04:1899` | `GIGAPIPE_DB` |
| `CLICKHOUSE_TELEMETRY_DB` | `08` "Naming — settled" | `GIGAPIPE_DB` |
| `GIGAPIPE_RETENTION_DAYS` | `04:718`, `04:756`, `04` D14 | `TELEMETRY_RETENTION` (per signal, §7.4) |

**On the container side there are two names and `CLOKI_*` wins.** `portEnv` assigns
`QRYN_LOGIN`/`QRYN_PASSWORD` first and `CLOKI_LOGIN`/`CLOKI_PASSWORD` second
(`cmd/gigapipe/main.go:172-183`), so `CLOKI_*` overrides. Both are read, so nothing breaks at
runtime — but `04:751`'s contract ("`GIGAPIPE_USERNAME`/`GIGAPIPE_PASSWORD` must match
`QRYN_LOGIN`/`QRYN_PASSWORD` on the container") is *false* for an operator who sets only
`CLOKI_*`, which is what this document's compose does. **Use `CLOKI_*` everywhere**, and edit
`02:1860`, `02:2131`, `04:751`, `05`'s manifest row and `11`'s test compose to match.

Why this is worth a table rather than a sentence: `cmd/gigapipe/main.go:321-324` installs the
auth middleware **only when both values are non-empty**, and Compose substitutes a missing
`.env` key with the empty string plus a warning. A disagreement between the name the compose
file sets and the name a boot assertion checks therefore produces a gigapipe that serves
`/loki/api/v1/push`, the Elastic `POST /_bulk` write routes and the always-on cleartext-HTTP/2
gRPC OTLP receiver to anything on the network, with every healthcheck green and `apps/api`
still sending an `Authorization` header. `${GIGAPIPE_USER:?…}` (§2) only guards the name this
document happens to use, which is exactly why the names must be one list. `11` must add a gate
that the compose-set name and the asserted name are the same string, and **the smoke
assertion that an unauthenticated `GET /ready` returns 401 must be promoted from a smoke check
to a blocking P0 gate in `11`** — it is the only detector for the empty-credential state.

`GIGAPIPE_DB`, gigapipe's `CLICKHOUSE_DB` and the database segment of
`CLICKHOUSE_TELEMETRY_URL` must all be `gigapipe`; a boot assertion in `apps/api` that they
agree is cheap and is listed in Test requirements.

### 4. The `self-hosting` scripts

All line numbers below were read from the current files in this session.

#### 4.1 `quiz.ts` — six changes, including the one the draft missed

`writeEnvFile` (`:141-166`) is **not** a generic substituter and does **not** close over the
module-level `envs`. It takes an `EnvVars` argument, and the single call site at `:377-387`
constructs an explicitly enumerated object literal listing seven fields by hand. Adding keys
to the `envs` declaration alone puts `undefined` into `.env`. All six changes:

1. **`envs` (`:8-16`)** gains the credentials, alongside `COOKIE_SECRET` (`:13`):

```ts
let envs = {
  // …existing…
  COOKIE_SECRET: generatePassword(32),
  RESEND_API_KEY: '',
  EMAIL_SENDER: '',
  GIGAPIPE_URL: '',
  GIGAPIPE_USER: '',
  GIGAPIPE_PASSWORD: '',
  GIGAPIPE_DB: '',
  TELEMETRY_RETENTION_DAYS: '',
};
```

   All five default to `''`, so **declining is the default state** and needs no removal step.

2. **`writeEnvFile` (`:146-155`)** gains six `.replace` calls. `GIGAPIPE_BASIC_B64` is
   computed here rather than stored:

```ts
    .replace('$GIGAPIPE_URL', envs.GIGAPIPE_URL)
    .replace('$GIGAPIPE_USER', envs.GIGAPIPE_USER)
    .replace('$GIGAPIPE_PASSWORD', envs.GIGAPIPE_PASSWORD)
    .replace('$GIGAPIPE_DB', envs.GIGAPIPE_DB)
    .replace('$TELEMETRY_RETENTION_DAYS', envs.TELEMETRY_RETENTION_DAYS)
    .replace(
      '$GIGAPIPE_BASIC_B64',
      envs.GIGAPIPE_USER && envs.GIGAPIPE_PASSWORD
        ? Buffer.from(`${envs.GIGAPIPE_USER}:${envs.GIGAPIPE_PASSWORD}`).toString('base64')
        : '',
    )
```

   The `=""` filter at `:161-163` then drops all six lines when observability is declined.
   **That filter is the off-switch**, and it only works because every value is a `$TOKEN`.
   The draft's plan — a literal `GIGAPIPE_URL="http://op-gigapipe:3100"` in the template —
   would have left the feature switched on in `.env` for every operator who declined, so
   `boot-cron.ts`'s `if (process.env.GIGAPIPE_URL)` guard would register both crons against a
   database that was never provisioned, forever.

3. **The `writeEnvFile(...)` call site (`:377-387`)** must list the new fields, or TypeScript
   fails the build (which is the desired outcome — it is the compiler catching change 1):

```ts
  writeEnvFile({
    // …existing seven…
    GIGAPIPE_URL: envs.GIGAPIPE_URL,
    GIGAPIPE_USER: envs.GIGAPIPE_USER,
    GIGAPIPE_PASSWORD: envs.GIGAPIPE_PASSWORD,
    GIGAPIPE_DB: envs.GIGAPIPE_DB,
    TELEMETRY_RETENTION_DAYS: envs.TELEMETRY_RETENTION_DAYS,
  });
```

4. **A prompt**, after the dependencies checkbox (`:222-231`) and *before* the
   bring-your-own-ClickHouse branch:

```ts
const observability = await inquirer.prompt([
  {
    type: 'confirm',
    name: 'enabled',
    message:
      'Enable server observability (metrics, logs and traces)? Adds 2 containers and stores telemetry in ClickHouse alongside your analytics.',
    default: false,
    prefix: '📈',
  },
]);

if (observability.enabled && !envs.CLICKHOUSE_URL) {
  const retention = await inquirer.prompt([
    {
      type: 'number',
      name: 'days',
      message: 'How many days of telemetry should be kept? (all three signals)',
      default: 14,
    },
  ]);
  addEnvs({
    GIGAPIPE_URL: 'http://op-gigapipe:3100',
    GIGAPIPE_USER: 'openpanel',
    GIGAPIPE_PASSWORD: generatePassword(32),
    GIGAPIPE_DB: 'gigapipe',
    TELEMETRY_RETENTION_DAYS: String(Math.max(1, retention.days)),
  });
}
```

   Default `false`. Telemetry is the highest-volume thing OpenPanel would store (§7) and a
   self-hoster who did not ask for it should not get it. `!envs.CLICKHOUSE_URL` is the
   bring-your-own-ClickHouse guard: it is evaluated after the dependency prompt sets
   `CLICKHOUSE_URL` (`:233-250`), so the two paths cannot both fire.

5. **Service removal**, next to the existing removals at `:395-405`:

```ts
  if (!envs.GIGAPIPE_URL) {
    removeServiceFromDockerCompose('op-gigapipe');
    removeServiceFromDockerCompose('op-gigapipe-init');
  }
```

   One condition covers both the decline path and the bring-your-own-ClickHouse path, because
   the prompt in change 4 leaves `GIGAPIPE_URL` empty in both. `removeServiceFromDockerCompose`
   already tolerates a name that is not present (`:89-102`) and cleans `depends_on` in both
   array and object form (`:105-121`).

6. **A comment warning.** `removeServiceFromDockerCompose` round-trips the file through
   `yaml.load`/`yaml.dump` (`:94`, `:135`), which **deletes every comment**. The explanatory
   comments in §2 survive only for operators who trigger no removal at all — a minority.
   Anything load-bearing must live in the docs page (§4.5), not in a compose comment.

**Rejected: translate the operator's `CLICKHOUSE_URL` into gigapipe's five variables.**
`CLICKHOUSE_URL` is an HTTP URL with an embedded database path
(`http://user:pw@host:8123/openpanel`); gigapipe wants host, port, database, auth and protocol
separately, and a managed ClickHouse — the reason someone brings their own — is usually TLS-only
on 8443 with a user that may not hold `CREATE DATABASE`. Guessing that translation and then
panicking inside `InitDBTry` is worse than not offering the feature in the wizard. It is a
documented manual path (§4.5).

#### 4.2 `get_latest_images` has a bug that would clobber the gigapipe image

`self-hosting/get_latest_images:7` is `COMPONENTS=("worker" "api" "dashboard")` and `:272-280`
runs, per component:

```bash
if grep -q "image:.*${component}" "$DOCKER_COMPOSE_FILE"; then
    sed -i "s|image:.*${component}.*|image: ${new_image}|g" "$DOCKER_COMPOSE_FILE"
```

`gigapipe` contains the substring `api` (gig**api**pe). Verified by replay: a line
`image: ghcr.io/metrico/gigapipe:v5.4.1` is rewritten to the OpenPanel API image, twice, and
the next `./start` boots two API containers with gigapipe's env.

The draft's proposed anchor — `image:.*openpanel-${component}.*` — is **also wrong**, and
worse: the image this script *writes* is
`docker.openpanel.dev/openpanel-dev/${component}:main-${short_sha}` (`:268`), which contains
`openpanel-dev/api`, not `openpanel-api`. The anchor matches the template's
`lindesvard/openpanel-api:2` only until the first `apply`; after that the `grep -q` guard
fails and the script reports "No matching image line found" and updates nothing, silently,
forever, on exactly the installs that have used it before.

The required fix, verified by replaying `sed` against **both** image forms and against
`ghcr.io/metrico/gigapipe:v5.4.1`, `clickhouse/clickhouse-server:25.10.2.65` and the
`worker`/`dashboard` lines:

```bash
-        if grep -q "image:.*${component}" "$DOCKER_COMPOSE_FILE"; then
+        pattern="image:[[:space:]]*[^[:space:]]*openpanel[-/](dev/)?${component}:[^[:space:]]*"
+        if grep -Eq "$pattern" "$DOCKER_COMPOSE_FILE"; then
             if [[ "$OSTYPE" == "darwin"* ]]; then
-                sed -i '' "s|image:.*${component}.*|image: ${new_image}|g" "$DOCKER_COMPOSE_FILE"
+                sed -i '' -E "s|${pattern}|image: ${new_image}|g" "$DOCKER_COMPOSE_FILE"
             else
-                sed -i "s|image:.*${component}.*|image: ${new_image}|g" "$DOCKER_COMPOSE_FILE"
+                sed -i -E "s|${pattern}|image: ${new_image}|g" "$DOCKER_COMPOSE_FILE"
             fi
```

Replay result, for `component=api`:

```
    image: lindesvard/openpanel-api:2                           -> rewritten
    image: docker.openpanel.dev/openpanel-dev/api:main-abcd     -> rewritten
    image: ghcr.io/metrico/gigapipe:v5.4.1                      -> untouched
    image: lindesvard/openpanel-worker:2                        -> untouched
    image: clickhouse/clickhouse-server:25.10.2.65              -> untouched
```

This must land **before or with** the compose change. It is not optional and it is not this
work-stream's feature — it is a prerequisite bug fix.

`get_latest_images` deliberately does **not** manage the gigapipe tag. See §11.2 for the
upgrade procedure.

#### 4.3 `update`, `start`, `setup`, `danger_wipe_everything`

No script changes. Two behaviours to document:

- `./update` runs `docker compose up -d --pull always`, which re-runs `op-gigapipe-init` on
  every update. That is intentional and required — a gigapipe version bump ships schema
  migrations through `updateScripts` (`ctrl/qryn/maintenance/update.go:272-285`) — and it is
  why the TTL reconciler must re-assert unconditionally (§6.2).
- `./danger_wipe_everything` runs `docker compose down --volumes`, taking `op-ch-data` and the
  `gigapipe` database with it.

#### 4.4 Dev, smoke and Coolify

**Dev (`docker-compose.yml`, repo root).** One service, ports published, gigapipe owns its own
DDL *only if* `pnpm migrate` has not been run — which it always has, because migration 22 lives
in the normal migration path. Document the order in the service comment rather than adding a
one-shot:

```yaml
  op-gigapipe:
    image: ghcr.io/metrico/gigapipe:v5.4.1
    restart: always
    depends_on:
      - op-ch
    # Run `pnpm migrate` BEFORE first starting this service. Migration 22
    # pre-creates samples_v3 / metrics_15s with `type` in the PARTITION BY,
    # which is the shape the retention TTL depends on and which cannot be
    # ALTERed afterwards. If you start gigapipe first, drop the `gigapipe`
    # database and re-run.
    environment:
      MODE: all
      CLICKHOUSE_SERVER: op-ch
      CLICKHOUSE_PORT: "9000"
      CLICKHOUSE_DB: gigapipe
      SAMPLES_DAYS: "3"
      ADVANCED_SAMPLES_ORDERING: "fingerprint, timestamp_ns"
      BULK_MAX_AGE_MS: "1000"
      QRYN_RULER_ENABLED: "false"
    ports:
      - "3100:3100"   # dev only. Never on the self-hosting or coolify surface.
```

`SAMPLES_DAYS: 3` keeps a developer's disk small. No basic auth, so `curl localhost:3100/ready`
works and an `otel-collector` can be pointed straight at it while debugging the gateway.

The dev compose pins ClickHouse `26.1.3.52`, the template pins `25.10.2.65` and coolify pins
`24.3.2-alpine`. The conditional-TTL syntax (§6.1) must be verified on **all three**.

Add to `.env.example`:

```bash
# OBSERVABILITY (optional). Blank disables every telemetry surface.
# GIGAPIPE_URL="http://localhost:3100"
# GIGAPIPE_DB="gigapipe"
# TELEMETRY_RETENTION_DAYS="3"
```

**Smoke (`.github/smoke/docker-compose.yml`, `.github/smoke/smoke.sh`).** This is what CI
actually boots, and a gigapipe service that never starts in CI gets zero regression coverage —
while the failure mode the stack exists to catch (an image that builds green and serves 500s)
is exactly the failure mode a two-service boot dance has. Add both services, inline (the smoke
stack has no `.env` — `.github/smoke/docker-compose.yml:10-11`).

`smoke.sh` defines exactly four helpers — `fail` (`:27`), `wait_for` (`:41`),
`assert_ssr_route` (`:57`), `assert_no_server_errors` (`:84`). There is no `assert_status`, so
it ships as part of this change, in the same style:

```bash
# Assert an HTTP status without following redirects or needing a body.
assert_status() {
  local want="$1" url="$2"; shift 2
  local got
  got=$(curl -s -o /dev/null -w '%{http_code}' "$@" "$url" || echo "000")
  [ "$got" = "$want" ] || fail "expected $want from $url, got $got"
  echo "  $url -> $got"
}

# Telemetry ingest is reachable and rejects an unauthenticated request.
# Deliberately NOT a gigapipe assertion: gigapipe publishes no port, so the
# only thing CI can see is that apps/api's route exists and is gated.
assert_status 401 "$API/telemetry/v1/metrics" -X POST

# The one-shot completed. Use `docker inspect`, not `docker compose ps --format
# json`: the JSON shape (array vs NDJSON) varies by Compose version.
code=$(docker inspect -f '{{.State.ExitCode}}' "$(docker compose ps -aq op-gigapipe-init)")
[ "$code" = "0" ] || fail "op-gigapipe-init exited $code"

# gigapipe is authenticated. An unauthenticated /ready must 401, not 200 --
# empty CLOKI_LOGIN/CLOKI_PASSWORD silently disables the middleware entirely
# (cmd/gigapipe/main.go:321-324) and every other health signal stays green.
docker compose exec -T op-gigapipe \
  wget -q -S -O /dev/null http://127.0.0.1:3100/ready 2>&1 \
  | grep -q '401' || fail "op-gigapipe /ready is not authenticated"
```

> **UNVERIFIED:** `smoke.sh:98` boots with `docker compose up -d --wait --wait-timeout 420`.
> Compose's handling of a `restart: "no"` service that exits 0 under `--wait` has varied by
> version. **The experiment:** add the two services locally, run `docker compose up -d --wait`,
> and check the exit code. If `--wait` refuses to treat a completed one-shot as ready, the fix
> is to exclude `op-gigapipe-init` from the `--wait` set by starting it separately.

**Coolify (`self-hosting/coolify.yml`).** Deferred to P7. The file inlines every config file
as `content:` blocks, pins ClickHouse **24.3.2-alpine** (three majors behind the template) and
has already drifted (`opch` vs `op-ch`). Adding a boot dance to a surface CI cannot test
doubles the P0 review surface. With provisioning now in migration 22 the port is genuinely
mechanical — two services, `opch` instead of `op-ch`, no inlined SQL — but confirm the
conditional TTL parses on 24.3 first, because it is the oldest ClickHouse in the repo.

#### 4.5 Delivery to existing installs

The file operators run is `self-hosting/docker-compose.yml`, which is **gitignored**
(`self-hosting/.gitignore:2`) and generated by `quiz.ts`. A template change reaches nobody who
has already run the wizard. And `./update` runs `git pull` against the branch the operator
cloned, which `apps/public/content/docs/self-hosting/deploy-docker-compose.mdx:32` says is
`self-hosting`, not `main`. Two independent delivery gaps, neither fixed by editing the
template.

**Decision: ship a docs page, modelled exactly on
`apps/public/content/docs/self-hosting/high-volume.mdx:16-70`.** That file is the shipped,
first-party precedent for "paste this service block into your generated compose", complete
with the `depends_on: {condition: service_healthy}` shape and no `networks:` key. New page:
`apps/public/content/docs/self-hosting/observability.mdx`, registered in `meta.json`. It
contains the two service blocks, the six `.env` keys **with a bold warning that empty
credentials disable gigapipe's auth entirely**, the `get_latest_images` caveat, the
retention/sizing table from §7, the gigapipe upgrade procedure (§11.2), and an explicit
"telemetry is not backed up" section.

**Rejected:** a migration that rewrites the operator's generated compose. It is a gitignored
file we did not write, it may have been hand-edited (the pgbouncer page tells people to do
exactly that), and a failed rewrite bricks their stack.

### 5. Cloud, clustering, and the ClickHouse identity

#### 5.1 The two cluster flags do not talk to each other

OpenPanel has two clustering predicates with **opposite defaults**:
`getIsCluster()` (`packages/db/code-migrations/helpers.ts:17-24`) is `false` by default;
`isClickhouseClustered()` (`packages/db/src/clickhouse/client.ts:83-90`) is `true` by default
because it returns `!(SELF_HOSTED)`. gigapipe decides clustering from `CLUSTER_NAME` alone
(`cmd/gigapipe/main.go:97-99`), which sets both `ClusterName` **and** `Cloud = true`. Nothing
wires the two systems together, and `04-read-path.md` deliberately drives its `_dist` suffix
from `GIGAPIPE_CLUSTER` rather than from `isClickhouseClustered()` for exactly that reason.

#### 5.2 The cloud plan

**Cloud runs gigapipe in the same topology as self-hosting — one non-clustered gigapipe against
one ClickHouse database — until the observability read path has real load behind it.**

1. The `gigapipe` database lives on **one** ClickHouse node/cluster of OpenPanel's choosing,
   named by `CLICKHOUSE_TELEMETRY_URL` (`08` S11), not sharded across the analytics cluster.
2. `CLUSTER_NAME` is set **only if** that node is itself a replicated cluster, and only after
   `<remote_servers>` exists — which it does not in this repo on any surface.
3. If and when it is set, `CLICKHOUSE_READ_CLUSTER` and `CLICKHOUSE_READ_DIST_SUFFIX`
   (`ctrl/qryn/maintenance/maintain.go:30-34`) must be set consistently, `GIGAPIPE_CLUSTER`
   must be set to the same value, and `08`'s migration 22 must be re-run with
   `--force-telemetry` (S9).

**Rejected: run gigapipe distributed across the analytics ClickHouse cluster.** The reader
picks a database from its boot pool **at random on every call** (`reader/registry/static.go:33-38`)
and `GetDB` is called ~5 times inside one `query_range` (`reader/service/query_range.go:225,302,533,675,808`),
so a multi-entry `DATABASE_DATA` is a replica pool, not a shard map: the writer would route
correctly by node name while the reader served a uniformly random node several times within one
query. A half-working config that silently cross-reads is worse than no isolation, and it is the
strongest available argument for the plan's label-enforcement decision.

**Rejected: one gigapipe reader process per project.** This is the only in-tree route to
database-per-project (`reader/config` holds a single package-global `Cloki`, and services and
controllers are constructed once at route-registration time). It does not scale past a handful
of tenants.

#### 5.3 The ClickHouse identity that runs OpenPanel's telemetry DDL

**v1: `default`, the same user `op-api` uses**, reached through `chTelemetry` (D19). The
residual risk is real — one unbounded LogQL scan on a shared instance can hurt analytics — and
it is mitigated *upstream* rather than in ClickHouse: gigapipe's PromQL engine has a hardcoded,
non-configurable 30 s timeout, the read path caps range and step server-side before a query is
issued (`04-read-path.md`), and gigapipe is unreachable except through `apps/api`.

Every statement the retention cron issues carries explicit settings, because it runs against the
database that also serves the analytics product:

```ts
const TELEMETRY_DDL_SETTINGS = {
  // Metadata-only for MODIFY TTL at materialize_ttl_after_modify = 0.
  // 60s is generous; anything slower is a symptom, not a slow ALTER.
  max_execution_time: 60,
  // Do not block the job on a mutation; the next run observes progress
  // through system.mutations.
  mutations_sync: '0',
  // Fail fast rather than queue behind a long merge holding the table lock.
  lock_acquire_timeout: 10,
} as const;
```

**P7 follow-up, with its blocker resolved.** Add a *second* mounted file,
`self-hosting/clickhouse/clickhouse-gigapipe-user.xml`, gitignored and written by `quiz.ts`
alongside `caddy/Caddyfile` (which `writeCaddyfile` at `quiz.ts:37-58` already generates from a
`.template` and which `self-hosting/.gitignore:3` already excludes — the exact precedent). The
`<profiles>` half is static and can land in the tracked
`self-hosting/clickhouse/clickhouse-user-config.xml` (`08` S16 points here for it):

```xml
<clickhouse>
  <profiles>
    <op_gigapipe>
      <max_memory_usage>4000000000</max_memory_usage>
      <max_execution_time>60</max_execution_time>
      <max_threads>4</max_threads>
      <max_concurrent_queries_for_user>16</max_concurrent_queries_for_user>
    </op_gigapipe>
  </profiles>
  <quotas>
    <op_gigapipe>
      <interval><duration>3600</duration><read_rows>1000000000000</read_rows></interval>
    </op_gigapipe>
  </quotas>
  <users>
    <op_gigapipe>
      <password_sha256_hex>$GIGAPIPE_CH_PASSWORD_SHA256</password_sha256_hex>
      <profile>op_gigapipe</profile>
      <quota>op_gigapipe</quota>
      <networks><ip>::/0</ip></networks>
      <access_management>0</access_management>
    </op_gigapipe>
  </users>
</clickhouse>
```

and `CLICKHOUSE_AUTH=op_gigapipe:<password>` on both gigapipe services.

> **UNVERIFIED:** whether an XML-defined user can carry a `<grants>` block scoping it to
> `gigapipe.*` on ClickHouse 24.3 / 25.10 / 26.1, or whether that requires SQL RBAC (and
> therefore `<access_management>1</access_management>` on `default`, which is set nowhere in
> the repo). **The experiment:** `CREATE USER … ; GRANT ALL ON gigapipe.* TO …; SHOW GRANTS FOR …`
> against each pinned image. Until then the follow-up buys resource capping but not schema
> isolation — which is still the half that protects analytics.

> **UNVERIFIED:** whether OpenPanel's production ClickHouse user holds `CREATE DATABASE`.
> gigapipe's `InitDB` issues `CREATE DATABASE IF NOT EXISTS` itself
> (`ctrl/maintenance/shared.go:47-53`) and `ctrl.Init` `panic`s on failure, and migration 22
> issues the same statement. **The experiment:** `SHOW GRANTS` as that user before P0. If it
> does not hold the grant, an admin creates the database out of band and both statements then
> succeed trivially.

### 6. Retention

#### 6.0 What gigapipe gives us, and what it does not

`ctrl.Rotate` (`ctrl/qryn/maintenance/rotate.go:122-212`) derives **one** drop interval from
**one** `SAMPLES_DAYS` and applies it to eight tables across three signals: `samples_v3`,
`time_series`, `time_series_gin`, `tempo_traces`, `tempo_traces_attrs_gin`, `tempo_traces_kv`,
`metrics_15s`, `patterns`. The tiering list (`days []RotatePolicy`) is likewise one global
setting, applied unchanged to every call. `profiles*` is rotated not at all.

Everything that looks like a per-signal or per-tenant knob is a dead end:

- **`X-Ttl-Days` / `x-ttl-days` / the `__ttl_days__` label** are parsed
  (`writer/controller/middleware.go:167-174`, `writer/grpc/tenant.go:49-58`,
  `writer/utils/unmarshal/builder.go:326-333`) and materialised onto `MTTLDays` — and then
  **no insert service writes a TTL column**. `grep ttl_days ctrl/qryn/sql/*.sql` is empty.
  Only a closed-source insert-service plugin could consume it.
- **`oid`** exists only on the traces family and is never populated: the writer's INSERT column
  list (`writer/service/insert/tempo.go:86-93`) does not include it, so every span lands with
  the schema `DEFAULT '0'`. There is no `oid` on logs, metrics or profiles at all. **There is
  no tenant column anywhere.**
- **The ruler's recording rules** could write per-project rollups, but the write-back path is
  hardcoded tenant-less (`writer/controller/recording_writeback.go:30,34` pass `""`) and rule
  labels can overwrite a sample's `op_project_id` (`ruler/writeback.go:26`).

So per-signal retention is entirely ours to build, and it is built on the `type` column and the
partition key `08` S6/S7 pre-creates.

#### 6.1 The v1 windows and the conditional TTL

**Cloud: one window per signal, for every organization.**

| Signal | Window | Where it is enforced |
|---|---|---|
| Metrics (`samples_v3`/`metrics_15s`, `type != 1`) | **30 d** | conditional table TTL |
| Logs (`samples_v3`/`metrics_15s`, `type = 1`) | **14 d** | conditional table TTL |
| Label tables (`time_series`, `time_series_gin`) | **30 d** | unconditional TTL at the longest window |
| Traces (`tempo_traces*`) | **7 d** | unconditional TTL |
| gigapipe's own `SAMPLES_DAYS` | **30** | the ceiling, so a clobber over-retains rather than deletes |

**Self-hosted: one window for all three signals**, `TELEMETRY_RETENTION_DAYS` (default 14),
fed straight into gigapipe's `SAMPLES_DAYS`. See §6.4 — the reconciler does not run there.

The label tables get the *longest* window unconditionally and deliberately: they are
`PARTITION BY date` with no `type` in the partition key, and a fingerprint whose `time_series`
row was dropped while samples remain is a query that returns rows it cannot name. The cost is
that log label cardinality is retained for 30 days.

The DDL (`08` S12/S13 own the statement; reproduced here because §6.2 is the code that runs it):

```sql
-- samples_v3: logs and metrics share the table, discriminated by `type`.
-- `type` has THREE values: 0 = UNDEF/both, 1 = LOG, 2 = METRIC
-- (writer/model/insert_request.go:8-12), and reader predicates are
-- `type IN (n, 0)` (sql_misc.go:213-220), so a type-0 row is visible to BOTH
-- signals. Clauses are therefore written `type != 1` / `type = 1` -- total,
-- never equality -- which assigns type-0 to the LONGER (metric) window.
-- Correct only while metricDays >= logDays, which is asserted before emit.
ALTER TABLE gigapipe.samples_v3 MODIFY TTL
  toDateTime(timestamp_ns / 1000000000) + INTERVAL 30 DAY DELETE WHERE type != 1,
  toDateTime(timestamp_ns / 1000000000) + INTERVAL 14 DAY DELETE WHERE type =  1;

ALTER TABLE gigapipe.metrics_15s MODIFY TTL
  toDateTime(timestamp_ns / 1000000000) + INTERVAL 30 DAY DELETE WHERE type != 1,
  toDateTime(timestamp_ns / 1000000000) + INTERVAL 14 DAY DELETE WHERE type =  1;

ALTER TABLE gigapipe.time_series     MODIFY TTL date + INTERVAL 30 DAY;
ALTER TABLE gigapipe.time_series_gin MODIFY TTL date + INTERVAL 30 DAY;

ALTER TABLE gigapipe.tempo_traces           MODIFY TTL toDateTime(timestamp_ns / 1000000000) + INTERVAL 7 DAY;
ALTER TABLE gigapipe.tempo_traces_attrs_gin MODIFY TTL date + INTERVAL 7 DAY;
ALTER TABLE gigapipe.tempo_traces_kv        MODIFY TTL date + INTERVAL 7 DAY;
```

`metrics_15s` needs its own clauses and cannot inherit anything: it is an
`AggregatingMergeTree` fed by an insert-triggered MV (`log.sql:141-158`), so deleting rows out
of `samples_v3` does **not** retract the corresponding aggregates. It is also not a cold
optimisation — `bucket_producer.go:52-56` reads it directly on the PromQL path and
`planner_metrics15s_shortcut.go:57,71` reads it on the LogQL `rate()`/`count_over_time()` path.

> **UNVERIFIED, and the single load-bearing unverified premise in this document.** Whether
> `TTL <expr> DELETE WHERE <cond>, <expr> DELETE WHERE <cond>` parses on
> `clickhouse/clickhouse-server:25.10.2.65` (template), `26.1.3.52` (dev) and
> `24.3.2-alpine` (coolify). No ClickHouse source, docs or grammar is vendored in either repo,
> `/opt/homebrew/bin/clickhouse` on this machine is a dangling symlink (its Caskroom directory
> is empty and the binary fails to exec), and nothing is listening on 8123 or 9000, so no parse
> test was possible.
>
> **The experiment (P0 gate, five minutes, run together with U1 below):** boot each image, run
> migration 22's DDL, run the two `samples_v3` statements, then `SHOW CREATE TABLE
> gigapipe.samples_v3` and confirm both clauses survive.
>
> **Fallback if it does not parse:** one unconditional TTL at 30 d on `samples_v3` and
> `metrics_15s`. Logs then over-retain by 16 days, which is a cost regression, not a
> correctness one, and the tiering design in §6.3 becomes the route to per-signal windows.

> **P0 gate, and the reason `metrics_15s` is pre-created with gigapipe's *post-ALTER* sort key**
> (`08` S7, `U1` there): on a fresh install `ver` is 0, so `updateScripts` replays every
> statement in `log.sql` from index 0 (`ctrl/qryn/maintenance/update.go:272-285`), including
> `ALTER TABLE {{.DB}}.metrics_15s ADD COLUMN IF NOT EXISTS type UInt8, MODIFY ORDER BY
> (fingerprint, timestamp_ns, type)` (`log.sql:126-128`) against the table migration 22 just
> created. `ctrl.Init` panics on any error (`ctrl/ctrl.go:31-33`), `op-gigapipe-init` exits
> non-zero, and `op-gigapipe` never starts because of its `service_completed_successfully`
> gate — on **every** install, in CI and on every self-hoster, not only after a disaster. This
> is a first-boot question, not a DR question; the draft filed it as the latter.
>
> **The experiment:** run migration 22's DDL against each pinned image, then run gigapipe with
> `MODE=init_only` against it and confirm exit 0. That single test settles both this and the
> TTL syntax. `samples_v3` is unaffected — `log.sql:119-120` is `ADD COLUMN IF NOT EXISTS`
> with no `MODIFY ORDER BY`.

#### 6.2 The reconciler cron

`apps/worker/src/jobs/cron.telemetry-retention.ts`. One job, one purpose: assert the TTL.
No mutations, no per-project join, no `op_project_retention`, no watermark, no backpressure —
those all belong to §6.3 and do not ship in v1.

```ts
import {
  getTelemetryClient,          // 08 S11 — lazily constructed, single pinned node
  isTelemetryEnabled,          // 08 — `!!process.env.GIGAPIPE_URL`
  telemetryDb,                 // 08 — the validated database identifier
  db,
} from '@openpanel/db';
import { TELEMETRY_RETENTION_DAYS } from '@openpanel/constants';
import { getRedisCache } from '@openpanel/redis';
import { logger } from '@/utils/logger';

const TELEMETRY_DDL_SETTINGS = {
  max_execution_time: 60,
  mutations_sync: '0',
  lock_acquire_timeout: 10,
} as const;

/**
 * Re-assert the per-signal TTL on gigapipe's tables.
 *
 * Runs unconditionally on every tick (08 S12). At
 * `materialize_ttl_after_modify = 0` a MODIFY TTL is a metadata ALTER, so
 * re-asserting is cheap and has no blind spot to reason about. The one
 * expensive case -- materialising over existing parts -- is decided by
 * TelemetrySchemaState.materialized, which flips to true after the first
 * successful materialising apply and is reset by hand when a window SHORTENS.
 *
 * Self-hosted does nothing here: TELEMETRY_RETENTION_DAYS feeds gigapipe's own
 * SAMPLES_DAYS and ctrl.Rotate is the enforcement mechanism (section 6.4).
 */
export async function telemetryRetentionCronJob() {
  if (!isTelemetryEnabled() || process.env.SELF_HOSTED === 'true') {
    return;
  }

  const ch = getTelemetryClient();
  const state = await db.telemetrySchemaState.findUnique({ where: { key: 'ttl' } });
  const desired = buildTtlStatements(TELEMETRY_RETENTION_DAYS, telemetryDb());
  const fingerprint = sha256(desired.join('\n'));

  // materialize_ttl_after_modify rewrites every existing part. gigapipe pins it
  // to "0" on its own maintenance connection (ctrl/maintenance/shared.go:34),
  // so gigapipe's own rotation is always free. We need `1` exactly once: the
  // first apply against a database that already holds data, or any apply where
  // a window got SHORTER. `desiredFingerprint` exists only to decide that.
  const materialize =
    !state?.materialized || (!!state && state.desiredFingerprint !== fingerprint);

  for (const query of desired) {
    await ch.command({
      query,
      clickhouse_settings: {
        ...TELEMETRY_DDL_SETTINGS,
        materialize_ttl_after_modify: materialize ? '1' : '0',
      },
    });
  }

  await db.telemetrySchemaState.upsert({
    where: { key: 'ttl' },
    create: { key: 'ttl', desiredFingerprint: fingerprint, materialized: true },
    update: { desiredFingerprint: fingerprint, materialized: true, lastError: null },
  });

  await publishRetentionHealth(ch);
}
```

**Cadence: `'10 */6 * * *'`, four times a day.** The draft justified this with a premise that is
**false**, and the correct premise still supports the cadence:

- **The draft said:** `op-gigapipe-init` re-runs on every `./update` and `ctrl.Rotate` stamps
  its own unconditional TTL over ours every time. It does not. `rotateTables` reads its
  bookkeeping row first and returns before issuing any ALTER when the stored value equals the
  TTL string it would write — `val, err := getSetting(db, distributed, "rotate", settingName);
  if err != nil || val == rotateTTLStr { return err }` (`rotate.go:73-76`). Our `MODIFY TTL`
  does not touch `gigapipe.settings`, so gigapipe still believes its own TTL is applied and
  re-stamps nothing.
- **The real drift sources are:** (a) a change to `SAMPLES_DAYS` or to the tiering list, which
  changes `rotateTTLStr` and makes gigapipe clobber on the next init; (b) a gigapipe version
  bump whose `updateScripts` change the TTL expression or the table; (c) a human with a
  ClickHouse client. (a) and (b) both happen at deploy time, and a deploy is exactly when the
  window between "gigapipe clobbered the TTL" and "we re-asserted it" must be short. Six hours
  bounds it; a nightly cadence would leave logs on the 30-day metrics TTL for up to a day after
  every update.

**Cost when nothing has changed:** one Postgres read, seven metadata ALTERs and one
`system.parts` read. Measured before P2 ships (U4 in `08`).

`materialize_ttl_after_modify: '1'` is genuinely expensive — it rewrites every part of
`samples_v3` — so the `materialized` flag must never be set optimistically. When a window is
**shortened** by a code change, the deploy checklist is: set
`TelemetrySchemaState.materialized = false` for `key = 'ttl'`, let the next reconciler tick
apply it once, and confirm `materialized = true` afterwards. That is a one-line SQL statement
in the release notes, not a mechanism.

**Cron registration.** `packages/queue/src/queues.ts:188-207` — two payload types added to the
`CronQueuePayload` union:

```ts
export type CronQueuePayloadTelemetryRetention = {
  type: 'telemetryRetention';
  payload: undefined;
};
export type CronQueuePayloadTelemetryUsageRollup = {
  type: 'telemetryUsageRollup';
  payload: undefined;
};
```

`apps/worker/src/boot-cron.ts` — appended to the `jobs` array, guarded exactly the way the
`ping` job is guarded (`:128-134`):

```ts
if (process.env.GIGAPIPE_URL) {
  jobs.push(
    {
      name: 'telemetryRetention',
      type: 'telemetryRetention',
      pattern: '10 */6 * * *', // TTL re-assert + retention health gauges
    },
    {
      name: 'telemetryUsageRollup',
      type: 'telemetryUsageRollup',
      pattern: '20 1 * * *', // yesterday's Redis counters -> Postgres
    },
  );
}
```

`boot-cron.ts:138-160` **removes any scheduler not in `jobsToKeep`**, so blanking
`GIGAPIPE_URL` and restarting the worker de-registers both crons. That is the intended
off-switch and it is free. Two cases in `apps/worker/src/jobs/cron.ts`'s `switch` (`:28-83`).

Existing cron slots, so the new ones do not collide: `0 2` insightsDaily, `0 3` gscSync,
`0 4` sessionVacuum, `30 4` insightCleanup, `30 7` dataHealth, `0 8` Mon weeklyDigest, hourly
`0 *` delete/onboarding/windDown. `20 1` and `10 */6` are free, and `10 */6` deliberately
avoids the `:00` hourly cluster.

#### 6.3 The deferred tiering design, and the trigger that ships it

Per-plan retention is designed, not built. **The trigger is either of:** a customer contract
that requires longer-than-default retention, or a month in which telemetry storage on the
shared ClickHouse exceeds a named cost line. Until then this section is documentation.

**Windows, when it ships:**

| Plan | Metrics | Logs | Traces |
|---|---|---|---|
| Trial / no subscription | 7 d | 3 d | 3 d |
| Paid, ≤ 1 M events | 30 d | 14 d | 7 d |
| Paid, ≥ 2.5 M events | 90 d | 30 d | 14 d |

**Layer 1** stays the conditional table TTL, raised to the *ceiling* (90/30/14), with
`SAMPLES_DAYS=90`. **Layer 2** is a nightly partition-scoped `ALTER … DELETE` sweep for every
tier shorter than the ceiling, driven by a cron-owned publication table so the join happens
server-side rather than as a multi-million-element `IN` list from Node.

The cron creates its own auxiliary tables idempotently on every run (migration 22 owns only the
two gigapipe-shared tables, `08` S6):

```sql
CREATE TABLE IF NOT EXISTS gigapipe.op_project_retention (
    project_id   String,
    metrics_days UInt16,
    logs_days    UInt16,
    traces_days  UInt16,
    updated_at   DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(updated_at)
ORDER BY project_id;

-- Per (table, signal, tier) high-water mark. Without this the sweep is not
-- idempotent and a missed night is never caught up: a single-day window
-- targets the day that just aged out and tomorrow targets the next one.
CREATE TABLE IF NOT EXISTS gigapipe.op_retention_sweep (
    target      String,   -- 'samples_v3:log:3'
    swept_thru  Date,
    updated_at  DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(updated_at)
ORDER BY target;
```

On a replicated ClickHouse both must be `ReplicatedReplacingMergeTree ... ON CLUSTER`, driven
by the same explicit `GIGAPIPE_CLUSTER` flag `04-read-path.md` uses — a plain
`ReplacingMergeTree` created on one replica makes the sweep's join return zero rows on any
other, which is indistinguishable from "nothing to delete".

**Four properties the sweep must have, each answering a way the naive version leaks:**

1. **Watermark-driven, not day-of-the-week driven.** Each run sweeps every unswept day from
   `swept_thru + 1` up to `today - tierDays`, capped at `SWEEP_MAX_DAYS_PER_RUN` (start at 7),
   and advances the watermark only after `system.mutations.is_done`. Without this, a night
   skipped by the worker being down or by mutation backpressure strands that day until the
   ceiling TTL — up to 30× the purchased retention, silently, with `is_done` true and nothing
   alerting.
2. **A tier *shortening* enqueues a backfill.** When the nightly publication sees a project
   move to a shorter tier — a lapsed subscription, an expiring trial, a downgrade, a wind-down
   — every day between the new tier and the old one has already passed its aged-out night.
   The reconciler rewinds that project's watermark to `today - oldTierDays` so the ordinary
   catch-up loop covers the gap. **A tier *lengthening* restores nothing**: data already
   deleted is gone, and the upgrade takes effect forward only. That sentence belongs in the
   plan picker copy.
3. **The fingerprint subquery is bounded on `date`.** `time_series_gin` is `PARTITION BY date`
   (`log.sql:62-69`), so `AND g.date BETWEEN {day-1:Date} AND {day+1:Date}` prunes to two
   partitions instead of scanning every partition in the retention window. Unbounded, the
   materialised fingerprint set for a large tenant is tens of millions of `UInt64`s held per
   part, on the instance serving analytics.
4. **Backpressure is a throttle, not a silent stop.** The job refuses to enqueue while more
   than `SWEEP_MAX_OUTSTANDING` (start at 4) mutations are unfinished, and because the
   watermark only advances on completion, a throttled run is caught up rather than skipped.
   A mutation with a non-null `latest_fail_reason` is surfaced as `gigapipe_sweep_failed` and
   pages; the recovery is `KILL MUTATION WHERE mutation_id = …` followed by a watermark rewind.

```sql
-- Example: logs, trial tier (3 days). Bounded four ways so ClickHouse rewrites
-- exactly one part-set: `type = 1` prunes to the log partitions (type is the
-- leading partition-key component), the timestamp range prunes to one day
-- partition, the gin date range prunes the subquery to two partitions, and the
-- fingerprint set is a server-side join, never a literal list.
ALTER TABLE gigapipe.samples_v3
DELETE WHERE
      type = 1
  AND timestamp_ns >= {dayStartNs:Int64}
  AND timestamp_ns <  {dayEndNs:Int64}
  AND fingerprint IN (
        SELECT g.fingerprint
        FROM gigapipe.time_series_gin AS g
        INNER JOIN gigapipe.op_project_retention AS r FINAL
                ON r.project_id = g.val
        WHERE g.key = 'op_project_id'
          AND g.date BETWEEN {dayMinus1:Date} AND {dayPlus1:Date}
          AND r.logs_days = {tierDays:UInt16}
      );
```

> **UNVERIFIED, and a P0-equivalent gate for the tiering phase — the same five minutes and the
> same three images as the TTL experiment.** A mutation whose predicate reads other tables is
> non-deterministic, and ClickHouse gates that behind `allow_nondeterministic_mutations` for
> replicated tables. **The experiment:** run the statement above against each pinned image, on
> a plain `MergeTree` and on a `ReplicatedMergeTree`, and record whether the setting is
> required. If it is required on the cloud topology, the fallback is to resolve the fingerprint
> set in the worker and ship it as a chunked literal `IN` — which then needs a stated
> cardinality cap, and above that cap the design needs a materialised
> `fingerprint → project_id` table maintained by the gateway rather than a join through the gin
> index.

Volume, when it ships: 2 metric tiers + 2 log tiers + 2 trace tiers, times the tables each
touches, = **12 mutations per night** against a shared ClickHouse. That number is the reason
the sweep runs **once a day** (`'40 2 * * *'`, a separate `telemetrySweep` cron) while the TTL
reconciler runs four times: ClickHouse does not de-duplicate mutations, so re-issuing an
identical `ALTER … DELETE` creates a new `system.mutations` entry that must be applied to every
part in the matched partition even when it deletes zero rows. Four runs a day would be 48
part-rewriting mutations, 36 of them pure work, and the backpressure guard would then never
drain below its threshold.

**Rejected: encode the retention tier as a label at ingest** so the TTL could branch on it.
A plan change would require rewriting the label on every existing series, and a label change
produces a **new fingerprint** — series continuity breaks and cardinality doubles at every
upgrade.

**Rejected: `DELETE FROM` (lightweight delete) instead of `ALTER … DELETE`.**
`delete.service.ts:59-65` already shows the codebase choosing `ALTER … DELETE` for MVs.
Lightweight deletes leave rows on disk behind a mask until the next merge, so they do not
reclaim the space this exists to reclaim, and they do not interact predictably with
`ttl_only_drop_parts`.

#### 6.4 Self-hosted retention

**`TELEMETRY_RETENTION_DAYS`, one value for all three signals, default 14, enforced by
gigapipe's own `ctrl.Rotate`.** No OpenPanel TTL DDL, no reconciler, no sweep. Concretely:

- `quiz.ts` prompts for it and writes it to `.env` (§4.1).
- Both compose services read `SAMPLES_DAYS=${TELEMETRY_RETENTION_DAYS:-14}` (§2).
- `ctrl.Rotate` runs inside `op-gigapipe-init` and stamps one unconditional TTL from it across
  all eight rotated tables.
- `telemetryRetentionCronJob` returns immediately when `SELF_HOSTED === 'true'`.
- Changing the value means editing `.env` and running `./restart`; `op-gigapipe-init` re-runs,
  `rotateTTLStr` differs from the stored `gigapipe.settings` row, and gigapipe re-stamps
  (`rotate.go:73-76`). That is the *only* configuration where gigapipe's guarded re-stamp is
  the mechanism rather than the hazard.

This is a deliberate simplification over the draft, which promised
`TELEMETRY_RETENTION_DAYS` in a table cell and then shipped a hardcoded `SAMPLES_DAYS=90`
everywhere — a 6× silent over-retention on the largest table in the system, on the
self-hoster's own disk.

`SAMPLES_DAYS=0` is not an opt-out: `maintain.go:28-29` returns
`ttl_days should be set for node#…` and `cmd/gigapipe/main.go:76-79` panics. The opt-out is
removing the services.

### 7. Storage sizing

Every number here is a **model**, derived from column types, codecs and sort keys read out of
`ctrl/qryn/sql/log.sql` and `traces.sql`. None of it is measured. §7.5 is the query that
replaces the model with facts.

#### 7.1 Metrics

One **emitted metric sample** becomes one `samples_v3` row and one `metrics_15s` row. (One
accepted OTLP *data point* becomes one or many emitted samples — see §8.1, which is why the
billing unit is the sample, not the data point.)

`samples_v3` per metric row (`log.sql:25-32` plus the `type` column):

| Column | Raw | With `ORDER BY (fingerprint, timestamp_ns)` | With gigapipe's default `ORDER BY (timestamp_ns)` |
|---|---|---|---|
| `fingerprint UInt64` | 8 B | ~0.2 B (long runs of one value) | ~8 B (random per row) |
| `timestamp_ns Int64 CODEC(DoubleDelta)` | 8 B | ~0.2 B (regular scrape interval within a series) | ~2 B (deltas across interleaved series) |
| `value Float64 CODEC(Gorilla)` | 8 B | ~1.5 B counter / ~4 B noisy gauge | ~7 B (XOR against an unrelated series) |
| `string String` | 1 B | ~0.05 B | ~0.05 B |
| `type UInt8` | 1 B | ~0.02 B | ~0.02 B |
| **total** | 26 B | **~2–4 B** | **~10–17 B** |

That ~4× is D5's entire justification, and it can only be chosen before the table exists.

`metrics_15s` (`log.sql:83-94`) is the surprise. Its bucket is
`intDiv(timestamp_ns, 15e9) * 15e9`, so at any scrape interval **≥ 15 s each raw sample lands in
its own bucket and nothing aggregates.** The rollup is 1:1 with the raw table and its row is
*bigger*:

| Column | Raw state | Compressed |
|---|---|---|
| `fingerprint` + `timestamp_ns` | 16 B | ~0.4 B |
| `last AggregateFunction(argMax, Float64, Int64)` | ~17 B | ~6 B |
| `max` / `min` / `sum` `SimpleAggregateFunction(…, Float64)` | 24 B | ~5 B |
| `count AggregateFunction(count)` | ~8 B | ~0.5 B |
| `bytes SimpleAggregateFunction(sum, Float64)` | 8 B | ~0.3 B |
| `type` | 1 B | ~0.02 B |
| **total** | ~74 B | **~10–14 B** |

**So `metrics_15s` is ~3–4× the cost of the raw samples it summarises**, and it cannot be
dropped or filtered. `metrics_15s_mv` has **no `WHERE`** and groups by
`(fingerprint, timestamp_ns, type)` (`log.sql:143-158`), so it rolls logs up too; recreating it
with `WHERE type != 1` to spare logs the rollup tax would make LogQL `rate()` and
`count_over_time()` return **zeros, not an error**.

Label storage, per unique series per day:

- `time_series` (`log.sql:16-23`, one row per fingerprint per day): `labels` is a JSON object —
  for a typical Prometheus series with ~12 labels plus `op_project_id`, ~250 B raw, ~80 B after
  LZ4 against neighbouring similar series, plus `metadata`, `updated_at_ns`, `name`.
  **~120 B/series/day.**
- `time_series_gin` (`log.sql:62-69`, one row per `(key, val)` pair per series per day):
  ~13 rows × ~12 B. **~160 B/series/day.**

**~280 B per active series per day** of label overhead — negligible next to samples for a
healthy series, dominant for a churning one. Cardinality, not volume, is the thing to watch.

**Model: 15 B per emitted metric sample** (~3 B raw + ~12 B rollup, midpoints of the two ranges
above), plus 280 B per active series per day. The draft's 24 B did not follow from these tables
and is corrected here; the difference propagates into §7.4 and §8.

#### 7.2 Logs

One log record → one `samples_v3` row with `type = 1`, `value = 0`, `string` = the body, plus
one `metrics_15s` row per (stream, 15 s bucket).

| Column | Compressed, 200 B line |
|---|---|
| `string` (LZ4 over structured text, ~0.3 ratio) | ~60 B |
| `fingerprint` | ~0.2 B |
| `timestamp_ns` (irregular, DoubleDelta helps less) | ~3 B |
| `value` (constant 0) | ~0.1 B |
| **total** | **~64 B** |

The rollup cost inverts with rate: a stream emitting 100 lines/s produces one rollup row per
15 s (negligible); one emitting a line per minute produces one rollup row per line (~12 B, a
19 % surcharge). Model it as **+5 %**.

**Model: `0.32 × body bytes + 5 B`** — ~69 B for a 200 B line, ~85 B for a 250 B line,
**~345 B per KiB of body.**

#### 7.3 Traces

The intuitive number is wrong by an order of magnitude, and the reason is
`tempo_traces_attrs_gin`. `writer/utils/unmarshal/otlp.go:81` does
`span.Attributes = append(span.Attributes, res.Resource.Attributes...)` — **every resource
attribute is copied onto every span** before anything is written. Then:

- `tempo_traces` gets one row whose `payload` is `proto.Marshal` of that resource-inflated
  span, plus `name`, `service_name`, `parent_id`, ids and timestamps. A span with 20 own
  attributes and 10 resource attributes marshals to ~600–900 B; LZ4 across similar spans gets
  it to **~220 B**.
- `tempo_traces_attrs_gin` gets **one row per attribute key** — ~33 rows for that span. Each row
  carries `date`, `key`, `val`, `trace_id FixedString(16)`, `span_id FixedString(8)`,
  `timestamp_ns`, `duration` — 42 B of fixed columns before `key`/`val`. `ORDER BY (oid, date,
  key, val, timestamp_ns, trace_id, span_id)` (`traces.sql:32`) compresses `key`/`val` to near
  nothing but leaves the 24 B of random ids essentially incompressible.
  **~28 B/row × 33 = ~925 B.**
- `tempo_traces_kv` (`traces.sql:34-51`) is keyed `(oid, date, key, val_id)` with
  `val_id = cityHash64(val) % 10000` — bounded at 10 000 rows per `(key, date)`. Negligible on
  disk, but its MV processes every `attrs_gin` insert, so it is CPU.

**Model: ~1.15 KB per span, of which ~80 % is the attribute index.**

Two consequences for other work-streams: reducing resource-attribute count is the single
cheapest lever a customer has, and the docs should say so; and because `oid` is a constant
`'0'`, the leading component of both `tempo_traces`' sort key and its partition key is
degenerate, so a project-scoped trace lookup cannot use the primary index and must go through
`tempo_traces_attrs_gin` on `key = 'op_project_id'` — which is at least the table sorted for it.

#### 7.4 Billing-unit weights, derived

A billing unit should track *cost*, and cost is bytes × how long we keep them. All three rows
use the **default cloud windows** from §6.1.

| Signal | Bytes on disk | Retention | B·days | Ratio | **Weight** |
|---|---|---|---|---|---|
| 1 emitted metric sample | 15 B | 30 d | 450 | 1.0 | **1** |
| 1 KiB of log body | 345 B | 14 d | 4 830 | 10.7 | **10** |
| 1 span | 1 150 B | 7 d | 8 050 | 17.9 | **20** |

At these weights the cost per unit is 450 / 483 / 402 B·days — within ±10 % of parity, which is
the property that makes one axis defensible. The remaining spread is chosen, not accidental:
logs are rounded *down* (10 against 10.7) and spans *up* (20 against 17.9), because logs are the
signal customers most need to be able to afford and traces are the signal that most needs a
brake. Say that on the pricing page rather than pretending the arithmetic produced round
numbers.

**What this does not price.** Units price *ingest at the default windows*. When per-plan
tiering ships (§6.3), the top tier keeps metrics 3× and logs and traces 2× longer for the same
unit. The correction is on the **allowance**, not the unit: a plan whose retention multiplier
is *m* gets its included allowance divided by the storage-weighted *m*, so units-per-euro stays
proportional to cost. That is one number per plan in Polar metadata, not a second billing axis.

```ts
// packages/constants/index.ts
export const TELEMETRY_UNIT_WEIGHTS = {
  /** One sample as STORED: after gigapipe's histogram/summary fan-out. */
  metricSample: 1,
  /** Per KiB of log record body, computed from the org-day byte total. */
  logKib: 10,
  /** One accepted span. */
  span: 20,
} as const;

/** Cloud default windows, in days. Self-hosted uses TELEMETRY_RETENTION_DAYS. */
export const TELEMETRY_RETENTION_DAYS = {
  metrics: 30,
  logs: 14,
  traces: 7,
  /** Label tables, unconditional at the longest window. */
  labels: 30,
} as const;

export function telemetryBillingUnits(raw: {
  metricSamples: number;
  logsBytes: number;
  tracesSpans: number;
}): number {
  return (
    raw.metricSamples * TELEMETRY_UNIT_WEIGHTS.metricSample +
    Math.ceil(raw.logsBytes / 1024) * TELEMETRY_UNIT_WEIGHTS.logKib +
    raw.tracesSpans * TELEMETRY_UNIT_WEIGHTS.span
  );
}
```

`Math.ceil` is applied to the **aggregate** byte total for an org-day, not per request. A
per-request ceiling inflates a chatty client sending 1 000 × 100 B batches by ~10×, and that
inflated number would be the enforcement signal.

#### 7.5 Worked examples

Assumptions, stated so they can be argued with: 30 s scrape for small/medium, 15 s for large;
log lines average 200 B (small) and 250 B (medium/large); default cloud windows. "Series ×
scrapes" is already in **emitted samples**, so these tables are unaffected by the D11 change of
billing basis — only the *unit definition* moved.

**Small** — one service, two replicas.

| | Volume/day | Model | Bytes/day | Steady state |
|---|---|---|---|---|
| Metrics | 2 000 series × 2 880 = 5.76 M samples | 15 B | 86 MB | 30 d → **2.6 GB** |
| Series labels | 2 000 series | 280 B | 0.6 MB | 30 d → 17 MB |
| Logs | 500 k lines × 200 B | 69 B | 35 MB | 14 d → **0.5 GB** |
| Traces | 200 k spans | 1.15 KB | 230 MB | 7 d → **1.6 GB** |
| | | | **~350 MB/day** | **~4.7 GB** |

**Medium** — 10 services, 5 replicas each.

| | Volume/day | Bytes/day | Steady state |
|---|---|---|---|
| Metrics | 40 000 × 2 880 = 115 M samples | 1.73 GB | 30 d → **52 GB** |
| Series labels | 40 000 series | 11 MB | 30 d → 336 MB |
| Logs | 20 M lines × 250 B | 1.7 GB | 14 d → **24 GB** |
| Traces | 5 M spans | 5.75 GB | 7 d → **40 GB** |
| | | **~9.2 GB/day** | **~116 GB** |

**Large** — 100 services; the customer who would otherwise run a Grafana stack.

| | Volume/day | Bytes/day | Steady state |
|---|---|---|---|
| Metrics | 500 000 × 5 760 (15 s) = 2.88 B samples | 43 GB | 30 d → **1.3 TB** |
| Series labels | 500 000 series | 140 MB | 30 d → 4.2 GB |
| Logs | 300 M lines × 250 B | 25.5 GB | 14 d → **357 GB** |
| Traces | 50 M spans | 57.5 GB | 7 d → **402 GB** |
| | | **~126 GB/day** | **~2.06 TB** |

In billing units, computed from these tables and the §7.4 weights:

| | Metrics | Logs | Traces | **Units/day** | **Units/month** |
|---|---|---|---|---|---|
| Small | 5.76 M | 0.98 M | 4.0 M | 10.7 M | **~320 M** |
| Medium | 115 M | 48.8 M | 100 M | 264 M | **~7.9 B** |
| Large | 2.88 B | 732 M | 1.0 B | 4.61 B | **~138 B** |

Read the large row twice. **A single large telemetry tenant stores more than most of
OpenPanel's analytics business**, on the same ClickHouse instance, at ~126 GB/day of writes.
Three things follow, and they are the operational spine of this work-stream: retention is the
cost model, not a nicety (§6); the quota must hard-shed, not soft-warn (D12, §9); and cloud
must be able to say no, which the plan allowances (§9.1) make a product decision rather than an
incident.

#### 7.6 What settles this

Run once real telemetry exists. With `type` in the partition key the `partition` column
separates logs from metrics for free, which is how `bytes_per_row` becomes per-signal without a
second query:

```sql
SELECT
  table,
  partition,
  sum(rows)                                        AS rows,
  formatReadableSize(sum(data_compressed_bytes))   AS compressed,
  formatReadableSize(sum(data_uncompressed_bytes)) AS uncompressed,
  round(sum(data_uncompressed_bytes) / sum(data_compressed_bytes), 2) AS ratio,
  round(sum(data_compressed_bytes) / sum(rows), 2) AS bytes_per_row
FROM system.parts
WHERE database = 'gigapipe' AND active
GROUP BY table, partition
ORDER BY sum(data_compressed_bytes) DESC;
```

```sql
SELECT column,
       formatReadableSize(sum(column_data_compressed_bytes)) AS compressed,
       round(sum(column_data_compressed_bytes) / sum(rows), 3) AS bytes_per_row
FROM system.parts_columns
WHERE database = 'gigapipe' AND table = 'samples_v3' AND active
GROUP BY column ORDER BY sum(column_data_compressed_bytes) DESC;
```

**UNVERIFIED and worth settling before the pricing table is published:** the compressed cost of
`metrics_15s` relative to `samples_v3`. If the model is right it is the largest single line item
in the system; if it is wrong the weights move, which is exactly why §8 stores raw counters and
derives units from them.

### 8. Metering

#### 8.1 The unit is an emitted sample, not an accepted data point

This is the correction that matters most in the billing half of the document.

`02-ingest-gateway.md` D3 already has the gateway walk **every metric data point** to stamp
`op_project_id` — stamping only the resource attribute is a no-op for metrics
(`writer/utils/unmarshal/otlp_metrics.go:236-267` never reads resource attributes into a
series). While it is in that walk it knows the data point's type and, for the two fan-out
types, the array lengths. The number of rows that data point will become in `samples_v3` is
therefore one arithmetic expression over data already in hand:

```ts
// apps/api/src/telemetry/meter.ts
//
// How many samples_v3 rows one OTLP metric data point becomes. Derived from
// gigapipe's decoder, which implements the standard OTLP -> Prometheus
// translation (a histogram becomes _bucket x N + _sum + _count):
//
//   number  (Gauge, Sum)     -> 1                       otlp_metrics.go:190-202
//   histogram               -> len(bucket_counts) + 1 + (sum? 1 : 0)
//                                                       otlp_metrics.go:373,379,385-387,391
//   exponential histogram   -> buckets + 1 + (sum? 1 : 0) + 1
//                                                       otlp_metrics.go:427,442,446-448,452
//   summary                 -> len(quantile_values) + 2 otlp_metrics.go:471-483
//   plus one target_info sample per resource per export otlp_metrics.go:489-503
//
// This is the OTLP specification's fan-out, not a gigapipe private detail, so
// it is stable across a gigapipe bump. It is nonetheless pinned by a CI
// reconciliation test (Test requirements #9): post a fixed payload, then
// `SELECT count() FROM gigapipe.samples_v3` and assert equality.
export function metricDataPointSamples(dp: DecodedDataPoint): number {
  switch (dp.kind) {
    case 'number':
      return 1;
    case 'histogram':
      return dp.bucketCounts.length + 1 + (dp.sum === undefined ? 0 : 1);
    case 'exponentialHistogram':
      return dp.bucketCount + 2 + (dp.sum === undefined ? 0 : 1);
    case 'summary':
      return dp.quantileValues.length + 2;
  }
}
```

Prometheus remote-write needs no expansion: one `prompb.Sample` is one row.

**Why the draft's basis was wrong, concretely.** A service exporting
`http.server.request.duration` as an explicit-bucket histogram with the OTel SDK's default
11 boundaries emits `11 + 1 + 1 + 1 = 14` rows per data point. Billing accepted data points
charges that tenant 1 unit for 14 rows of storage, while a tenant sending gauges is charged
1 unit for 1 row. The quota then sheds on a number uncorrelated with cost, and §7.5's
allowances are wrong by the same factor.

**Rejected: a fixed per-signal expansion factor.** It is a constant that would be right for
one workload shape and wrong for every other, and nothing would tell you which.

**Rejected: `SELECT count() FROM gigapipe.samples_v3 GROUP BY op_project_id` as the
authoritative meter** (the ingest draft's position). `samples_v3` has no project column; the
attribution is a join through `time_series_gin`, which is the expensive query §6.3 defers, and
it cannot attribute log *bytes* at all. It survives as the **reconciliation** query in the CI
test above and in the monthly audit, not as the meter.

#### 8.2 The Redis contract

Written by the gateway, pipelined, **after** a 2xx from gigapipe (D21), fire-and-forget in a
`try/catch` — losing a counter is a billing annoyance, losing telemetry is an outage.

```
telemetry:usage:{projectId}:{YYYY-MM-DD}          HASH   TTL 3456000 (40 d)
  requests               accepted requests
  ingress_bytes          decompressed body bytes
  metric_samples         BILLED. emitted samples_v3 rows (section 8.1)
  metric_points          diagnostic. accepted OTLP data points
  metric_rejected        diagnostic. dropped points (structural limits, timestamp window)
  log_records            diagnostic
  log_bytes              BILLED. sum(len(body))
  spans                  BILLED
  spans_rejected         diagnostic

telemetry:usage:days:{YYYY-MM-DD}                 SET of projectId   TTL 3456000
telemetry:usage:org:{organizationId}:{YYYY-MM-DD} HASH   TTL 3456000
  metric_samples / log_bytes / spans   -- the three billed fields only
```

Three requirements on the gateway, all cheap, all listed again under "Interfaces":

1. **`SADD telemetry:usage:days:{day} {projectId}` + `EXPIRE … NX`** in the same pipeline.
   Without it the rollup has to `SCAN MATCH` the whole Redis keyspace — which is O(keyspace)
   on an instance that also holds every buffer, every queue and the session store.
2. **The org-level mirror hash**, three `HINCRBY`s. It exists so the quota hook is one
   `HGETALL` rather than "resolve the org's projects, then N reads". It carries only the three
   billed fields, and it holds **raw counters**, not units, so `Math.ceil(bytes/1024)` is
   applied once to the aggregate rather than per request (§7.4).
3. **`metric_samples` is the billed metric field.** `metric_points` stays for diagnostics and
   for the fan-out ratio gauge in §10; it must not be summed into `billingUnits`.

`metric_rejected` and `spans_rejected` are recorded and **not billed**: a rejected data point
produced no row, and billing it charges for a client bug.

#### 8.3 The daily rollup

`apps/worker/src/jobs/cron.telemetry-usage.ts`. It does **not** query ClickHouse:
`samples_v3` has no project column, so the gateway is the only place the attribution exists.

```ts
import { db, getProjectByIdCached } from '@openpanel/db';
import { getRedisCache } from '@openpanel/redis';
import { telemetryBillingUnits } from '@openpanel/constants';
import { format, subDays } from 'date-fns';
import { logger } from '@/utils/logger';

/** Roll yesterday's gateway counters into telemetry_usage_daily. Idempotent. */
export async function telemetryUsageRollupCronJob() {
  const redis = getRedisCache();
  const dayKey = format(subDays(new Date(), 1), 'yyyy-MM-dd');
  // `day` is DateTime @db.Date on TelemetryUsageDaily, so the composite unique
  // needs a Date, not the yyyy-MM-dd string. Build it in UTC explicitly.
  const day = new Date(`${dayKey}T00:00:00.000Z`);

  const projectIds = await redis.smembers(`telemetry:usage:days:${dayKey}`);
  if (projectIds.length === 0) {
    return;
  }

  const touchedOrganizations = new Set<string>();

  for (const projectId of projectIds) {
    const hash = await redis.hgetall(`telemetry:usage:${projectId}:${dayKey}`);
    if (!hash || Object.keys(hash).length === 0) {
      continue;
    }
    const project = await getProjectByIdCached(projectId);
    if (!project?.organizationId) {
      // Project deleted between ingest and rollup. The bytes were stored, but
      // there is nobody to bill and the erasure path (08 S15) has removed them.
      continue;
    }

    const n = (k: string) => Number.parseInt(hash[k] ?? '0', 10) || 0;
    const raw = {
      metricSamples: n('metric_samples'),
      logsBytes: n('log_bytes'),
      tracesSpans: n('spans'),
    };
    const row = {
      requests: BigInt(n('requests')),
      bytesIngress: BigInt(n('ingress_bytes')),
      metricSamples: BigInt(raw.metricSamples),
      metricDatapoints: BigInt(n('metric_points')),
      metricRejected: BigInt(n('metric_rejected')),
      logsRecords: BigInt(n('log_records')),
      logsBytes: BigInt(raw.logsBytes),
      tracesSpans: BigInt(raw.tracesSpans),
      billingUnits: BigInt(telemetryBillingUnits(raw)),
    };

    await db.telemetryUsageDaily.upsert({
      where: {
        organizationId_projectId_day: {
          organizationId: project.organizationId,
          projectId,
          day,
        },
      },
      create: { organizationId: project.organizationId, projectId, day, ...row },
      update: row,
    });
    touchedOrganizations.add(project.organizationId);
  }

  // The write side the draft omitted: refresh the Organization cache column
  // the quota hook and the billing page read.
  for (const organizationId of touchedOrganizations) {
    await refreshOrganizationTelemetryUsage(organizationId);
  }

  await getRedisCache().hset('telemetry:stack:health', {
    gigapipe_rollup_completed_at: String(Date.now()),
  });
}
```

```ts
/**
 * Recompute `Organization.subscriptionPeriodTelemetryUnits` from
 * telemetry_usage_daily over the org's CURRENT billing window, then evaluate
 * the 80%/100% thresholds as a backstop (the hook is the primary evaluator,
 * D14).
 *
 * Saturates at INT4_MAX because the column is `Int`, matching the events
 * counter's convention (08 S5). A large tenant reaches ~4.6e9 units/day, so
 * saturation is real and the hook must treat a saturated value as "at limit".
 */
const INT4_MAX = 2_147_483_647;

export async function refreshOrganizationTelemetryUsage(organizationId: string) {
  const organization = await db.organization.findUnique({
    where: { id: organizationId },
  });
  if (!organization) return;

  const { startDate, endDate } = getTelemetryUsageWindow(organization);
  const [agg] = await db.$queryRaw<{ units: bigint | null }[]>`
    SELECT COALESCE(SUM(billing_units), 0)::bigint AS units
    FROM telemetry_usage_daily
    WHERE organization_id = ${organizationId}
      AND day >= ${startDate}::date
      AND day <= ${endDate}::date
  `;
  const units = Number(agg?.units ?? 0n);

  await db.organization.update({
    where: { id: organizationId },
    data: {
      subscriptionPeriodTelemetryUnits: Math.min(units, INT4_MAX),
    },
  });
  await clearOrganizationCache(organizationId);

  await evaluateTelemetryThresholds(organization, units); // backstop; see 9.4
}
```

**`getTelemetryUsageWindow` is defined once**, in
`packages/db/src/services/organization.service.ts`, and mirrors exactly one source function —
`getOrganizationBillingEventsCount` (`organization.service.ts:222-247`), **not**
`subscription.usage` (`packages/trpc/src/routers/subscription.ts:143-173`). The draft cited
both, and they are different windows: the former falls back to `createdAt → subscriptionEndsAt`
for a trialing org, the latter falls back to the last 30 days. Using different windows for the
enforced number and the displayed number means the quota hook and the billing page disagree for
every trial.

```ts
/**
 * The billing window telemetry usage is summed over. Mirrors
 * getOrganizationBillingEventsCount (:225-234) exactly: trials have no Polar
 * cycle, and subscriptionStatus stays 'trialing' even once expired.
 *
 * Day attribution: a UTC day belongs whole to the period containing its start.
 * A period boundary mid-day therefore counts that day in the NEW period. The
 * error is bounded by one day of usage, once per period, and the alternative
 * (hour-resolution counters) multiplies the Redis key count by 24.
 */
export function getTelemetryUsageWindow(
  organization: Pick<
    Organization,
    | 'subscriptionStatus'
    | 'subscriptionCurrentPeriodStart'
    | 'subscriptionCurrentPeriodEnd'
    | 'createdAt'
    | 'subscriptionEndsAt'
  >,
): { startDate: Date; endDate: Date } | null {
  const isTrialStatus = organization.subscriptionStatus === 'trialing';
  const startDate =
    organization.subscriptionCurrentPeriodStart ??
    (isTrialStatus ? organization.createdAt : null);
  const endDate =
    organization.subscriptionCurrentPeriodEnd ??
    (isTrialStatus ? organization.subscriptionEndsAt : null);
  if (!(startDate && endDate)) return null;
  return { startDate, endDate };
}
```

**The nightly blind window, and its fix.** The rollup runs at `20 1 * * *` for *yesterday*, so
between 00:00 and 01:20 UTC yesterday's usage is in neither the `Organization` cache nor
"today's live hash". The quota hook therefore reads **both** day hashes — today's and
yesterday's — and drops yesterday's once
`Organization.updatedAt > startOfDay(now)` proves the rollup has landed. That is one extra
`HGETALL` inside a 60-second cache, and it closes an 80-minute undercount that would otherwise
recur nightly.

**Three properties, stated rather than hidden:**

- **`billingUnits` is stored *and* derivable.** It is written so the billing page and the quota
  hook do one cheap `SUM`, and the raw counters are kept so the weights (§7.4) can be re-derived
  and every historical row recomputed if the measurements move.
- **The meter is at-least-once.** A client retry of a batch gigapipe already accepted
  double-counts *and* writes duplicate rows into `samples_v3` — which is honest, because the
  duplicate rows really are stored (`02` D15). Metering *before* forwarding would over-count on
  every upstream failure, and failures are correlated while retries are not.
- **Billing survives a total loss of the telemetry ClickHouse.** `telemetry_usage_daily` lives
  in Postgres, which is in the analytics backup set. That is a direct consequence of metering at
  the gateway rather than by querying ClickHouse.

#### 8.4 Where it surfaces on the billing page

`apps/start/src/components/organization/billing.tsx` renders `<BillingUsage>` today. Telemetry
gets a **sibling widget, not extra rows in the events one** — the two axes have different units,
different limits and different consequences, and `billing-usage.tsx`'s `domain` calculation and
both tooltips are built around a single `count`.

New: `apps/start/src/components/organization/billing-telemetry-usage.tsx`, structurally a copy
of `billing-usage.tsx` with three differences:

1. Four `<Card>`s: `Period`, `Telemetry units used`, `Included`, `Left to use` — same `Card`
   helper, same `useNumber()` formatting.
2. A **stacked** `BarChart` with three series (metrics / logs / traces, in units), because the
   actionable question is always "which signal is eating my allowance".
3. It renders **nothing at all** when the org has never sent telemetry, and the whole widget is
   behind `observability.status.enabled` (`04-read-path.md` §6.4) — an org on a deployment with
   `GIGAPIPE_URL` unset must not see a usage widget for a feature that does not exist.

New tRPC procedure beside `subscription.usage`:

```ts
  telemetryUsage: protectedProcedure
    .input(z.object({ organizationId: z.string() }))
    .query(async ({ input }) => {
      const organization = await db.organization.findUniqueOrThrow({
        where: { id: input.organizationId },
      });
      const window = getTelemetryUsageWindow(organization);
      if (!window) return [];
      return getTelemetryUsageSerieCached(input.organizationId, window);
    }),
```

`getTelemetryUsageSerie` is one grouped read of `telemetry_usage_daily` — **not** a ClickHouse
query, unlike its events counterpart — wrapped in `cacheable(…, 60 * 10)` to match
`getOrganizationBillingEventsCountSerieCached` (`organization.service.ts:316-319`):

```sql
SELECT day,
       SUM(metric_samples)                        AS metrics_units,
       SUM(CEIL(logs_bytes / 1024.0)) * 10        AS logs_units,
       SUM(traces_spans) * 20                     AS traces_units,
       SUM(billing_units)                         AS total_units
FROM telemetry_usage_daily
WHERE organization_id = $1 AND day BETWEEN $2 AND $3
GROUP BY day
ORDER BY day;
```

The **plan picker** (`billing-plan-picker.tsx`, driven by `subscription.products`) gains a
second line per tier — included telemetry units — read from
`product.metadata.telemetryUnitsLimit` alongside the existing `product.metadata.eventsLimit`.

#### 8.5 The Polar catalogue work, which is not free

`product.metadata.telemetryUnitsLimit` does not exist. Making it exist is live-catalogue work
against a payment provider, across three files, and the draft's inventory listed none of them:

- **`packages/payments/src/prices.ts:9-40`** — `IPrice` has `price`, `events`, `discount`,
  `popular` and no telemetry field. Thirteen tiers gain a `telemetryUnits` number.
- **`packages/payments/scripts/create-products.ts`** — writes `eventsLimit: price.events` into
  Polar metadata at `:98` and `:123`, and **matches on `p.metadata?.eventsLimit`** at `:78`,
  `:130` and `:136` when deciding whether a product already exists. Adding a metadata key to
  thirteen existing live products is a migration, not a create: the script must be extended to
  *update* metadata on a matched product rather than skip it, and the change must be rehearsed
  against the sandbox organization first.
- **`apps/api/src/controllers/webhook.controller.ts:293-311`** — the `eventsLimit`
  parse/fallback block inside `syncSubscriptionToOrg` (`:238`). It gains an identical block for
  `telemetryUnitsLimit`, with the same "preserve the existing organization limit and warn" fallback.

This is its own line item with its own risk note, phased separately from the UI (§13).

### 9. Quota enforcement

#### 9.1 Limits

`subscriptionPeriodTelemetryLimit` is `Int`, `0` means **zero allowance** (D12), and it is set
from Polar product metadata by `syncSubscriptionToOrg`. Two consequences:

- **Onboarding must seed it**, exactly as it seeds the events limit. `packages/trpc/src/routers/onboarding.ts:21-24`
  already documents the trap in a comment ("the limit defaults to 0, which trips on the first
  event") and fixes it with `TRIAL_EVENTS_LIMIT = 10_000_000` at `:40`. Add
  `TELEMETRY_TRIAL_UNITS_LIMIT = 100_000_000` beside it and set
  `subscriptionPeriodTelemetryUnitsLimit` in the same `organization.create`.
- **A one-shot backfill** sets the column for every existing organization in the same migration
  that adds it, or every existing paying customer sheds on their first data point.

Proposed starting allowances, anchored to the §7.5 worked examples:

| Events tier | Included telemetry units/month | Roughly |
|---|---|---|
| Trial / no subscription | 100 M | ~9 days of the **small** example |
| 5 k – 100 k events | 500 M | **small** (≈320 M/mo) with 1.5× headroom |
| 250 k – 1 M events | 2 B | a quarter of **medium** (≈7.9 B/mo) |
| 2.5 M – 10 M events | 10 B | **medium**, with headroom |
| 20 M – 50 M events | 50 B | ~a third of **large** (≈138 B/mo) |
| above | negotiated, set on the org record | |

**These numbers are a product decision, not an engineering one.** What this document commits to
is the *mechanism*: one axis, one `Int` column, defaults carried in Polar metadata, a seeded
trial value, and a documented cost basis so they can be argued with rather than guessed at
again. At the §7.4 weights and §7.5 sizing, **1 B units ≈ 15 GB of steady-state disk if it is
all metrics, ≈ 34 GB if it is all logs, ≈ 58 GB if it is all traces** — the spread is the
retention difference, and that is the sentence the pricing conversation needs.

#### 9.2 What the user experiences

| Usage | Ingest | Reads | Notification | Marker |
|---|---|---|---|---|
| **< 80 %** | accepted | normal | none | — |
| **≥ 80 %** | accepted | normal | one email to org admins (`telemetry-usage-near-limit`) + an amber banner on the billing page and every observability surface | `telemetryUsageWarningSentAt` |
| **≥ 100 %** | **still accepted** — this is the grace band | normal | one email (`telemetry-usage-limit-exceeded`), red banner naming the shed threshold and the projected date | `telemetryUsageExceededSentAt`, `subscriptionPeriodTelemetryExceededAt` |
| **≥ 120 %** | **shed**: `429` + jittered `Retry-After ≤ 300 s` on every telemetry ingest route | **normal — reads are never blocked** | banner states shedding is active and shows the last accepted timestamp | `telemetryUsageShedStartedAt` |
| new billing period, or a mid-period upgrade | accepted | normal | markers cleared | — |

Four deliberate choices, each with its rejected alternative:

**Reads keep working at every level.** Events clamp charts when the limit is exceeded
(`subscriptionChartEndDate`, `packages/db/src/prisma-client.ts:71-97`). Telemetry does not.
Rejected, because clamping reads does not reduce storage cost — the data is already written —
and it hides the exact data the customer needs to find the runaway logger.

**Writes shed, which events never do.** Event volume is bounded by the customer's *traffic*
while telemetry volume is bounded by their *configuration*: turning on debug logging in one hot
path is 100× overnight with no natural ceiling. Without a shed, the 120 % case is unbounded
liability on a shared ClickHouse.

**The shed threshold is 120 %, not 100 %.** The 100→120 band is the grace period that makes the
100 % email actionable. That argument only holds if the warning genuinely arrives first, which
is why the thresholds are evaluated on the live number (D14, §9.4) rather than on the nightly
rollup — a warning delivered the morning *after* the shed is the incident the grace band exists
to prevent.

**Self-hosted is exempt at every level** (`process.env.SELF_HOSTED === 'true'`), matching
`subscriptionHook` (`apps/api/src/hooks/subscription.hook.ts:33-35`) and `updateEventsCount`.

#### 9.3 The hook

`apps/api/src/telemetry/quota.ts`. Registered as an `onRequest` hook on the telemetry plugin,
after the auth hook (so `req.client.projectId` exists) and after the wind-down hook. It is the
same hook `02-ingest-gateway.md` §4 puts the per-project kill switch in, so the Redis read is
shared.

```ts
const SHED_RATIO = 120n; // percent

export async function telemetryQuotaHook(req: FastifyRequest, reply: FastifyReply) {
  if (process.env.SELF_HOSTED === 'true') {
    return;
  }
  const projectId = req.client?.projectId;
  if (!projectId) {
    return;
  }

  try {
    const organization = await getOrganizationByProjectIdCached(projectId);
    if (!organization) {
      // getOrganizationByProjectId explicitly returns null when the project has
      // no organization (organization.service.ts:48-63). subscriptionHook takes
      // the same early return at :37-39.
      return;
    }

    const limit = organization.subscriptionPeriodTelemetryLimit;
    if (limit <= 0) {
      // 0 is ZERO allowance, not unlimited (D12, 08 S5). Onboarding seeds
      // TELEMETRY_TRIAL_UNITS_LIMIT and the migration backfills existing orgs,
      // so a 0 here means telemetry was never granted to this organization.
      return shed(req, reply, organization, 0n, 0n, 'not_entitled');
    }

    // Cached period total + today's live counter (+ yesterday's until the
    // rollup lands -- section 8.3). The live half is what stops a runaway
    // client burning a month's allowance between two rollups.
    const used =
      BigInt(organization.subscriptionPeriodTelemetryUnits) +
      (await getLiveTelemetryUnitsCached(organization.id));

    const pct = (used * 100n) / BigInt(limit);

    // Evaluate the warning thresholds on the SAME number the shed uses (D14).
    // Fire-and-forget: never let a notification failure affect admission.
    if (pct >= 80n) {
      void enqueueTelemetryThresholdNotification(organization.id, Number(pct));
    }

    if (pct < SHED_RATIO) {
      return;
    }

    return shed(req, reply, organization, used, BigInt(limit), 'over_quota');
  } catch (error) {
    // Fail open, exactly as subscriptionHook does (:66-73). Dropping a paying
    // customer's telemetry because Redis hiccuped is worse than letting an
    // over-quota org through for a tick.
    req.log.error({ err: error, projectId }, 'Telemetry quota check failed, allowing ingest');
  }
}

async function shed(
  req: FastifyRequest,
  reply: FastifyReply,
  organization: { id: string },
  used: bigint,
  limit: bigint,
  reason: 'over_quota' | 'not_entitled',
) {
  // Claim-guarded, so the marker is stamped exactly once per period no matter
  // how many replicas hit the threshold in the same second. Same updateMany
  // pattern as sendUsageAlerts (apps/worker/src/jobs/sessions.ts:127-146).
  void db.organization.updateMany({
    where: { id: organization.id, telemetryUsageShedStartedAt: null },
    data: { telemetryUsageShedStartedAt: new Date() },
  });

  // Jittered so a fleet of collectors does not retry in lockstep.
  reply.header('Retry-After', String(60 + Math.floor(Math.random() * 240)));
  req.log.warn(
    { organizationId: organization.id, used: used.toString(), limit: limit.toString(), reason },
    'Telemetry ingest shed',
  );
  return reply.status(429).send({
    error: 'telemetry_quota_exceeded',
    message:
      'Telemetry ingest is paused because this organization is over its monthly limit. Upgrade or wait for the next billing period.',
  });
}
```

`getLiveTelemetryUnitsCached` is `cacheable(…, 60)` around one or two `HGETALL`s of the
org-level mirror hash plus `telemetryBillingUnits`. Sixty seconds of staleness against a 20 %
grace band is fine.

**Why 429 and not 202.** `subscriptionHook` answers `202` because OpenPanel's own SDKs treat
everything but 401 and 2xx as retryable and would multiply the traffic (the comment at
`subscription.hook.ts:19-23` says so). Telemetry clients are the opposite: the OTel SDK and the
Prometheus remote-write client both understand `429 + Retry-After` as backpressure and back
off, and Prometheus with `retry_on_http_429: false` **drops** the batch — which is what we
want. Answering `202` would make an OTel exporter believe its data was stored.

#### 9.4 Marker lifecycle — the four columns and who writes them

The draft's columns were read by the hook and the banners and written by nobody. All four
writers, named:

| Column | Written by | Cleared by |
|---|---|---|
| `subscriptionPeriodTelemetryUnits` | `refreshOrganizationTelemetryUsage` (§8.3), per touched org, per rollup | `order.updated` cycle reset; `syncSubscriptionToOrg` on upgrade |
| `telemetryUsageWarningSentAt` | `enqueueTelemetryThresholdNotification` → the notification job's `updateMany` claim | both, below |
| `telemetryUsageExceededSentAt` | same | both, below |
| `subscriptionPeriodTelemetryExceededAt` | the notification job, stamped with the exceeded marker | both, below |
| `telemetryUsageShedStartedAt` | `shed()` (§9.3), `updateMany`-claimed on null | both, below |

**Threshold evaluation is claim-before-send**, reusing `sendUsageAlerts`' pattern verbatim
(`apps/worker/src/jobs/sessions.ts:127-146`): an `updateMany` guarded on the marker being null,
`count === 0` means someone else claimed it, and a per-recipient `try/catch` so one bad address
does not roll back the claim for recipients that succeeded. Crossing both thresholds in one jump
stamps *both* markers together, exactly as the events path does at `:139-141`, so a redundant
warning is not queued afterwards.

**Two clearing paths, not one.** The draft had only the first:

1. **New billing period.** `apps/api/src/controllers/webhook.controller.ts:485-501`
   (`order.updated`, `subscription_cycle`) already resets the events counter and both sent-at
   markers. Four fields are added to the same `update`:

```ts
            subscriptionPeriodTelemetryUnits: 0,
            subscriptionPeriodTelemetryExceededAt: null,
            telemetryUsageWarningSentAt: null,
            telemetryUsageExceededSentAt: null,
            telemetryUsageShedStartedAt: null,
```

2. **A mid-period upgrade.** The events axis already handles this and the draft did not mirror
   it: `syncSubscriptionToOrg` nulls `subscriptionPeriodEventsCountExceededAt` and both sent-at
   markers when the new limit exceeds the old (`webhook.controller.ts:345-357`), precisely so an
   upgrade re-arms the alerts. Without the mirror, a customer who upgrades **to escape a shed**
   keeps the red "shedding is active" banner and `telemetryUsageShedStartedAt` until the next
   cycle, and the 80 %/100 % emails never fire again for the new headroom. Add, with the same
   `organization.subscriptionPeriodTelemetryLimit < newLimit` guard:

```ts
    subscriptionPeriodTelemetryLimit,
    ...(typeof subscriptionPeriodTelemetryLimit === 'number' &&
    typeof organization.subscriptionPeriodTelemetryLimit === 'number' &&
    organization.subscriptionPeriodTelemetryLimit < subscriptionPeriodTelemetryLimit
      ? {
          subscriptionPeriodTelemetryExceededAt: null,
          telemetryUsageWarningSentAt: null,
          telemetryUsageExceededSentAt: null,
          telemetryUsageShedStartedAt: null,
        }
      : {}),
```

   and add `'subscriptionPeriodTelemetryLimit'` to `TRACKED_SUBSCRIPTION_FIELDS`
   (`webhook.controller.ts:140-155`) so the transition is logged like every other subscription
   column.

#### 9.5 The emails

Two new templates, registered in `packages/email/src/emails/index.tsx` alongside
`usage-near-limit` (`:130-135`) and `usage-limit-exceeded` (`:137-141`), both
`category: 'product_alerts'` so the existing unsubscribe machinery applies:

- **`telemetry-usage-near-limit`** — subject
  `` `You've used ${percent}% of your telemetry allowance` ``. The body names the **top signal
  by units** ("most of it is logs from `api-prod`") and links to the usage widget, because "you
  are at 80 %" without "of what" is not actionable.
- **`telemetry-usage-limit-exceeded`** — subject
  `Telemetry limit reached — ingest pauses at 120%`. States the grace band explicitly, gives the
  projected shed date at the current rate, and says reads keep working.

**Rejected: reuse `usage-near-limit`.** Its zod schema is `{ eventsCount, eventsLimit }` and its
copy says "we keep collecting every event — nothing is lost", which is the exact opposite of
what happens to telemetry at 120 %.

#### 9.6 Support runbook for a shed organization

| Need | Action |
|---|---|
| See why | `SELECT day, metric_samples, logs_bytes, traces_spans, billing_units FROM telemetry_usage_daily WHERE organization_id = $1 ORDER BY day DESC LIMIT 30` — the shape of the spike names the signal |
| Lift the shed now | Raise `subscriptionPeriodTelemetryLimit` on the org row, then `clearOrganizationCache(orgId)`. The hook's read is `cacheable(…, 60*5)`, so without the clear it takes up to five minutes |
| Grant "unlimited" | There is no unlimited sentinel (D12). Set a deliberately large number and record why in the org's notes |
| Stop one noisy project without touching billing | `SET telemetry:disabled:{projectId} 1 EX 3600` — `02-ingest-gateway.md` §4's per-project kill switch, mandatory TTL, max 24 h |
| Stop all telemetry ingest fleet-wide, now | `SET telemetry:disabled:* 1 EX 3600`. No redeploy, no restart. §10.3 |
| Re-arm the alerts after raising a limit | Nothing: `syncSubscriptionToOrg` does it on the Polar path (§9.4), and a manual limit change should be followed by nulling the four markers by hand |

### 10. Monitoring, capacity and the kill switch

The stack that watches everything else needs someone to watch it, and it cannot be itself: if
gigapipe is down, gigapipe cannot tell you.

#### 10.1 Gauges

Exported through OpenPanel's existing prom-client registry in `apps/worker`, using the
`async collect()`-over-Redis pattern already established at `apps/worker/src/metrics.ts:40-70`
(D17). The retention cron writes the hash; `collect()` reads it.

```ts
// apps/worker/src/metrics.ts
const TELEMETRY_HEALTH_KEY = 'telemetry:stack:health';

for (const [name, help] of [
  ['gigapipe_up', 'gigapipe /ready returned 200 on the last probe'],
  ['gigapipe_probe_latency_ms', 'Latency of the last /ready probe'],
  ['gigapipe_ttl_applied_age_seconds', 'Seconds since the TTL was last successfully asserted'],
  ['gigapipe_ttl_last_error_at', 'Unix ms of the last TTL apply failure, 0 if none'],
  ['gigapipe_rollup_age_seconds', 'Seconds since the usage rollup last completed'],
  ['gigapipe_active_series', 'Rows in time_series for today'],
  ['gigapipe_oldest_partition_age_days', 'Age of the oldest active partition, per signal'],
  ['gigapipe_metric_fanout_ratio', 'metric_samples / metric_points over the last day'],
  ['op_ch_disk_free_ratio', 'Free bytes / total bytes on the ClickHouse data disk'],
  ['op_ch_disk_free_bytes', 'Free bytes on the ClickHouse data disk'],
  ['gigapipe_db_bytes', 'Compressed bytes in the gigapipe database'],
  ['telemetry_ingest_disabled', '1 when the fleet-wide kill switch is set'],
] as const) {
  register.registerMetric(
    new client.Gauge({
      name,
      help,
      async collect() {
        try {
          const v = await getRedisCache().hget(TELEMETRY_HEALTH_KEY, name);
          if (v !== null) this.set(Number.parseFloat(v));
        } catch {
          // ignore -- the scrape continues
        }
      },
    }),
  );
}
```

Plus two labelled gauges written the same way, from a single `system.parts` read:
`gigapipe_table_bytes{table=…}` and `gigapipe_table_rows{table=…}`.

The reads that populate them, issued by the retention cron through `chTelemetry`:

```sql
-- Capacity. The reason this is on the page list: telemetry shares op-ch-data
-- with the analytics product, and when the volume fills, ClickHouse rejects
-- inserts for BOTH databases -- /track fails, the event buffer backs up in
-- Redis, and op-kv runs --maxmemory-policy noeviction
-- (self-hosting/docker-compose.template.yml:51), so Redis OOMs rather than
-- sheds. A telemetry overage would otherwise become a total analytics outage
-- with no intermediate degradation.
SELECT name, free_space, total_space FROM system.disks;

-- Retention actually happened. Nothing else asserts that rows older than a
-- window are gone; a silent TTL failure is the cost leak that survives months.
SELECT
  splitByChar('-', partition)[1]                       AS type,
  dateDiff('day', max(toDate(min_time)), today())      AS oldest_age_days
FROM system.parts
WHERE database = 'gigapipe' AND table = 'samples_v3' AND active
GROUP BY type;

SELECT count() AS active_series FROM gigapipe.time_series WHERE date = today();

SELECT formatReadableSize(sum(data_compressed_bytes)) AS bytes
FROM system.parts WHERE database = 'gigapipe' AND active;
```

#### 10.2 What raises a page

| Condition | Meaning |
|---|---|
| `op_ch_disk_free_ratio < 0.20` | **Page.** The shared volume is filling. Analytics is at risk before telemetry is |
| `op_ch_disk_free_ratio < 0.10` | **Page, and the cron sets the fleet-wide kill switch automatically** (§10.3) |
| `gigapipe_up == 0` for 5 min | Ingest is 503ing. Customers' agents are retrying and backing off |
| `gigapipe_ttl_applied_age_seconds > 43200` (2 cycles) or `gigapipe_ttl_last_error_at` recent | Retention is not being enforced. This is the cost-control failure and it is otherwise silent |
| `gigapipe_oldest_partition_age_days > window + 3` for any signal | The TTL is declared but not *executing*. Distinct from the above: the ALTER succeeded, the merges did not |
| `gigapipe_rollup_age_seconds > 172800` | Two missed rollups. Billing and the quota hook are both reading a stale number |
| `gigapipe_active_series` up > 3× week-over-week | A cardinality explosion. Costs land on `time_series_gin` before they land on `samples_v3` |
| `gigapipe_metric_fanout_ratio` moves > 25 % week-over-week | Either a customer's histogram shape changed, or gigapipe's fan-out arithmetic changed under a version bump and §8.1's meter is now wrong |

#### 10.3 The kill switch, and why it is not `GIGAPIPE_URL`

`GIGAPIPE_URL` is a *deployment* switch: unsetting it needs an `.env` edit and a restart of
`op-api` and every `op-worker` replica. That is right for "this install does not want
observability" and wrong for "stop the bleeding in thirty seconds".

The runtime switch already exists and this document does not invent a second one:
`02-ingest-gateway.md` §4 specifies `telemetry:disabled:{projectId}` and `telemetry:disabled:*`
as plain Redis keys with a **mandatory TTL** (1 h default, 24 h max), read by the same hook that
does the quota check, answering `503 + Retry-After: 900`. This work-stream adds exactly two
things to it:

1. **A writer.** The retention cron sets `telemetry:disabled:*` with a 1 h TTL when
   `op_ch_disk_free_ratio < 0.10`, logs at `error`, and publishes
   `telemetry_ingest_disabled = 1`. It never *clears* the key — expiry does that, and a human
   decides whether to let it lapse.
2. **An ordering statement.** The disk guard is checked in the **telemetry** hook and never in
   `subscriptionHook`. Telemetry sheds before analytics, always. `/track` must keep working while
   telemetry is being refused, and there must be no code path in which a disk-pressure check can
   reject an event.

Three properties worth stating: 503 rather than 403 because it must be recoverable and exporters
must back off rather than drop; the TTL is mandatory so an emergency block expires rather than
being forgotten; and reads are unaffected, so a customer whose ingest is disabled can still see
what filled the disk.

#### 10.4 gigapipe's own `/metrics`

It exists — `promhttp` over `prometheus.DefaultGatherer`, `shared/commonroutes/routes.go:12-19`
— and nobody scrapes it. In P6, the health cron GETs it **with basic auth** (it is behind the
same global middleware) and republishes an allow-list of counters through the same Redis hash.
Not in P0: it means parsing Prometheus text format in the worker for signals we do not yet know
we need.

**Rejected: point OpenPanel's own OTLP self-telemetry at gigapipe to monitor gigapipe.**
Circular — the signal that tells you gigapipe is down travels through gigapipe. Separately,
`apps/api/src/utils/observability.ts:9-10` states the current architectural position in as many
words ("Metrics stay on prom-client/Grafana"), and changing that is a different work-stream's
decision, not a side effect of this one.

> **UNVERIFIED, and load-bearing for anyone adding a counter on the API side:** whether a bare
> `new client.Counter(...)` in `apps/api` is picked up by `fastify-metrics`. `apps/api/package.json`
> declares `fastify-metrics` and **no `prom-client`**, and `node_modules` is not installed in
> this checkout. **The experiment:** read `fastify-metrics@12`'s register handling. If it uses
> its own registry rather than `prom-client`'s global default, an API-side counter must go
> through the plugin's exposed register. **Every gauge above is deliberately on the worker side,
> which sidesteps the question entirely.**

### 11. Backup, disaster recovery, upgrade and rollback

#### 11.1 Telemetry data is not backed up

**D22, stated plainly so it can be argued with.** Three reasons: retention is 7–30 days, so a
backup taken outside the window restores data the customer is no longer entitled to see and one
inside it is worth days; telemetry's value decays to near zero within hours, and nobody restores
a 24-hour-old backup to debug a live incident; and a single large tenant is ~2 TB steady-state
with ~126 GB/day of churn (§7.5), which would dominate the backup budget for the data that
genuinely cannot be regenerated.

This must be **stated to the customer** — in the docs page (§4.5) and on the observability UI's
empty state, not left as an assumption:

> *"Telemetry is retained for your plan's window and is not backed up. Metrics, logs and traces
> are operational data; if the observability database is lost, telemetry history is lost with it
> and collection resumes immediately."*

**Two tiny tables that must be in whatever backup set covers `op-ch`:**

- `gigapipe.ver` (`ctrl/qryn/maintenance/update.go:246-256`) — the per-file watermark that tells
  gigapipe's migrator where to resume.
- `gigapipe.settings` (`log.sql:34-41`) — the `rotate` bookkeeping rows and the `update` markers.

**Losing `ver` is fatal, not conditionally fatal.** The draft marked this UNVERIFIED; it is
verifiable from files already cited and the answer is the bad one. `updateScripts` replays every
statement from index 0 when `ver` is 0 (`update.go:272-285`), and `log.sql` contains **four bare
`ADD COLUMN` statements with no `IF NOT EXISTS`** — `ALTER TABLE time_series / time_series_gin /
samples_v3 / metrics_15s ADD COLUMN \`type_v2\` UInt8 ALIAS type` at `log.sql:163, 166, 169, 172`
— plus four more in `log_dist.sql`. Replayed against tables that already have `type_v2`,
ClickHouse errors, `ctrl.Init` panics, and gigapipe cannot boot. So `ver` is in the backup set
unconditionally, and there are exactly two recoveries: restore `ver`, or hand-insert the correct
watermark rows (`INSERT INTO gigapipe.ver (k, ver) VALUES (…)`, one row per script index) rather
than replaying.

Backing them up is two `SELECT * … FORMAT Native` dumps into the same artefact as anything else
— they are a few hundred rows.

#### 11.2 Upgrading gigapipe

The image tag is pinned in two services, in a file that is gitignored and hand-edited by
operators, and `get_latest_images` deliberately does not manage it (§4.2). The procedure:

1. **Read the schema diff first.** `git diff v5.4.1..vNEXT -- ctrl/qryn/sql/` in the gigapipe
   repo. The statements that matter are any touching `samples_v3` or `metrics_15s`, and in
   particular any `MODIFY ORDER BY` or bare `ADD COLUMN` — those run against tables whose shape
   migration 22 owns (`08` S6/S7), and `ctrl.Init` panics on error.
2. **Bump both service tags together.** `op-gigapipe-init` and `op-gigapipe` must never run
   different versions: the init container's migrator advances `gigapipe.ver` and the runtime
   node reads the resulting schema.
3. **Run the init container alone first**, on a copy or in a maintenance window:
   `docker compose up --no-deps --force-recreate op-gigapipe-init` and confirm exit 0 before
   starting `op-gigapipe`.
4. **Re-run the retention reconciler afterwards.** A version bump is one of the three real drift
   sources (§6.2): if the new `updateScripts` changed the TTL expression or `SAMPLES_DAYS`,
   `ctrl.Rotate` will have clobbered ours.
5. **Re-check the fan-out arithmetic.** If the diff touches
   `writer/utils/unmarshal/otlp_metrics.go`, re-run the §8.1 reconciliation test before billing
   another cycle.

**There is no downgrade.** `gigapipe.ver` is forward-only and `log.sql`/`traces.sql` are
append-only by contract, so once the migrator has run there is no documented path from v5.5 back
to v5.4. The recovery from a bad upgrade is §11.3 — drop and re-provision, losing the telemetry
window — which is acceptable precisely because D22 already says telemetry is not durable. State
that in the docs page so nobody discovers it during an incident.

#### 11.3 Restore, and rollback of P0

Recovery for a lost or corrupted `gigapipe` database is not a restore, it is a re-provision:

```bash
# 1. Confirm the database really is gone / unrecoverable.
docker compose exec op-ch clickhouse-client \
  --query "SELECT name FROM system.tables WHERE database = 'gigapipe'"

# 2. Drop what is left, so the pre-create in step 3 actually takes effect.
#    Skipping this is the classic mistake: a half-surviving samples_v3 keeps
#    its old PARTITION BY forever.
docker compose exec op-ch clickhouse-client --query "DROP DATABASE IF EXISTS gigapipe"

# 3. Re-run migration 22 (it is idempotent and re-recorded with --force-telemetry
#    if the ledger already has it), then the init one-shot, then the node.
docker compose exec op-api sh -c "CI=true pnpm -r run migrate:deploy"
docker compose up -d --force-recreate op-gigapipe-init op-gigapipe

# 4. Force the reconciler rather than waiting up to 6h for the TTL. Idempotent.
docker compose exec op-worker node -e \
  "require('./dist/jobs/cron.telemetry-retention').telemetryRetentionCronJob()"
```

**Rolling back P0 entirely**, which the draft did not cover:

```bash
# 1. Stop ingest immediately, without a redeploy.
docker compose exec op-kv redis-cli SET 'telemetry:disabled:*' 1 EX 86400

# 2. Blank GIGAPIPE_URL in .env and restart api + worker. This de-registers
#    both crons (boot-cron.ts:138-160 removes any scheduler not in jobsToKeep)
#    and unmounts the telemetry routes.
docker compose restart op-api op-worker

# 3. Remove the two services and reclaim the disk.
docker compose rm -sf op-gigapipe op-gigapipe-init
docker compose exec op-ch clickhouse-client --query "DROP DATABASE IF EXISTS gigapipe"
```

Three things do **not** roll back, and the doc must say so:

- **The Postgres columns and tables** (`08`'s inventory). They are additive, nullable or
  defaulted, and cost nothing when unused. Dropping them is a separate migration nobody should
  need.
- **`ClientType.telemetry`.** Postgres enum values cannot be removed; existing telemetry clients
  should be deleted, not the enum value.
- **The `PARTITION BY` on `samples_v3` and `metrics_15s`**, if the database is kept. It is the
  one-way door. Dropping the database is the only way back, which is why step 3 above drops it.

Recovery objectives, stated honestly:

- **RTO ≈ 2 minutes.** Ingest resumes as soon as `op-gigapipe` is healthy.
- **RPO for telemetry data: total loss.** There is no recovery point. That is the design.
- **RPO for usage and billing data: the last nightly rollup, ≤ 24 h.**
  `telemetry_usage_daily` lives in Postgres, which *is* in the analytics backup set, so billing
  survives a total ClickHouse loss (§8.3).
- **The 40-day Redis TTL on the usage hashes** is the only other exposure: a Redis loss between
  two rollups loses at most one day of unrolled usage. Redis is not backed up today either.

#### 11.4 Pre-existing gap, noted not fixed

There is **no backup script, no backup docs page and no restore runbook anywhere in this
repository** for OpenPanel's own analytics data. `self-hosting/` contains `export-for-cloud.sh`,
`import-to-cloud.mjs` and `danger_wipe_everything`, and
`apps/public/content/docs/self-hosting/` has no backup page.

This work-stream does not fix that. But §11.3 is the first restore runbook in the repo and the
observability docs page will be the first place a self-hoster reads the word "backup", so it
must not imply the rest of the stack is backed up. One sentence: *"OpenPanel does not currently
ship a backup tool for your analytics data either; see your platform's volume-snapshot
documentation for `op-db-data` and `op-ch-data`."*

### 12. AGPL posture

**A factual reading of files on disk. This is not legal advice.**

**The facts.** gigapipe is AGPL-3.0: `/Users/drew/projects/gigapipe/LICENSE` is 661 lines of the
verbatim FSF AGPL v3, `nfpm.yaml:16` says `AGPLv3`, `README.md:251-255` heads a `#### License`
section naming HEPVEST BV. OpenPanel is also AGPL-3.0 and the two `LICENSE` files are
**byte-identical** (`md5 4ae09d45eac4aa08d013b5f2e01c67f6` both ways). We are not taking on a
licence we do not already carry. Third-party subtrees inside gigapipe are AGPL-compatible
one-way: `reader/prof/profile.pb.go:1-13` and `reader/prof/google/v1/profile.pb.go:1-13` are
Apache-2.0 (Google's pprof `profile.proto`); `reader/utils/cityhash102/cityhash.go:1-10` and
`writer/utils/helputils/cityhash102/cityhash.go` are MIT.

**The published image is not pure gigapipe source.**
`.github/workflows/build_release.yml:190-192` runs `./.github/actions/get-view` before the
container build, and that action downloads `dist.zip` from the separate `metrico/qryn-view`
repository into `view/dist`; the image is then built with `VIEW=1` (`:207-209`), which
`Dockerfile:5-8` turns into `go build -tags view`, activating the `//go:embed dist` in
`view/static.go`. So `ghcr.io/metrico/gigapipe:v5.4.1` ships a prebuilt frontend bundle from a
**different repository** whose licence is not represented anywhere in the gigapipe tree.

**The three rules this work-stream follows:**

1. **Reference, never rebuild.** We pull `ghcr.io/metrico/gigapipe:v5.4.1` exactly as the
   template already pulls `caddy:2-alpine` (`:5`), `postgres:14-alpine` (`:26`) and
   `redis:7.2.5-alpine` (`:48`). Building and pushing an OpenPanel-branded gigapipe image would
   be *conveying* under §6 and would attach source-provision obligations to the artefact. D1.
2. **Never expose gigapipe's UI.** D2 gives it no published port, which also means the embedded
   qryn-view bundle is never served to anyone. Unverified third-party frontend surface, zero
   benefit.
3. **Never patch gigapipe.** Everything here is achieved by configuration and by
   OpenPanel-owned ClickHouse DDL. Per-signal retention is our own `MODIFY TTL` (§6); alert
   evaluation is in OpenPanel's worker (`07-alerting.md` D1); the ruler is disabled rather than
   modified (D23).

| Situation | What engages |
|---|---|
| We patch gigapipe's Go source and run the patched build as a network service | §13 (Remote Network Interaction). The modified source would have to be offered to users of that service |
| We build **and publish** any gigapipe-derived image or binary | §6 (Conveying). Corresponding Source obligations attach to the artefact |
| We ship configuration, compose files and SQL that drive an unmodified upstream image | Neither §6 nor §13 engages on the gigapipe side. This is what §2–§6 specify |
| We vendor gigapipe source into this repository | §5. Both projects are already AGPL-3.0, so this is housekeeping, not a conflict |

**Nothing specified in this document requires a gigapipe patch.** The one path in the wider plan
that would trip §13 is raw LogQL/PromQL passthrough, which would need a fork to inject the
`op_project_id` matcher server-side; `05-logs.md:68-70` and `01-tenancy-and-security.md` already
price that and defer it. Do **not** re-open "should we fork gigapipe for per-signal TTL or for
the ruler" on licence grounds — both are answered by configuration.

**Unrelated housekeeping found while checking, for somebody else:** `package.json:6` declares
`"license": "MIT"`, `self-hosting/package.json:10` declares `"ISC"` and
`tooling/publish/package.json:5` declares `"MIT"`, while `LICENSE.md` is AGPL-3.0 and
`README.md` contains no licence statement at all. `self-hosting/` is where the gigapipe service
definition lands.

---

## Interfaces

### Consumed from `08-schema-changes.md` (schema)

| Symbol | Shape this document relies on |
|---|---|
| `packages/db/code-migrations/22-telemetry-database.ts` | Creates `gigapipe`, `samples_v3` and `metrics_15s` with `type` in `PARTITION BY`, `metrics_15s` with `ORDER BY (fingerprint, timestamp_ns, type)`. **Must have completed before `op-gigapipe-init` runs**; the compose edge `op-gigapipe-init depends_on op-api: service_healthy` is how |
| `getTelemetryClient()` / `chTelemetry` | Single **pinned** node. **Request:** when it falls back to `CLICKHOUSE_URL` and that value is a comma-separated list, it must take the first entry deterministically, because DDL that is applied and read back must hit one server (`client.ts:191-212`) |
| `telemetryDb()` | Validated ClickHouse identifier for the database name |
| `isTelemetryEnabled()` | `!!process.env.GIGAPIPE_URL`. Both crons and the quota hook gate on it. `getIsTelemetryEnabled` — the name in the draft — does not exist |
| `TelemetrySchemaState { key, desiredFingerprint, materialized, lastError }` | Written by the retention cron (§6.2). Replaces the draft's `TelemetryDdlState` |
| `TelemetryUsageDaily` | `BigInt` counters, `@@id([organizationId, projectId, day])`, `day DateTime @db.Date`. **Request:** the field list in §8.3 — `metricSamples` **and** `metricDatapoints`, not one of them |
| `Organization.subscriptionPeriodTelemetryUnits / …Limit` | `Int`, saturating, `0` = zero allowance (S5). Never `BigInt`: `Organization` travels through `cacheable`'s `JSON.stringify` (`packages/redis/cachable.ts:265`) |
| `deleteTelemetryFromClickhouse` + `TelemetryErasure` | Called inside `deleteFromClickhouse` (S15), covering `cron.delete.ts:46` and the admin tool. **This document owns only the operational half:** the ledger is monitored, and the customer-facing promise is "deleted within one delete-cron tick after the 24 h grace, bounded by mutation completion, not by the TTL ceiling" |

### Consumed from `02-ingest-gateway.md` (ingest)

| Thing | Contract |
|---|---|
| `metric_samples` counter | The gateway computes `metricDataPointSamples(dp)` (§8.1) during the rewrite walk it already performs, and increments `metric_samples`. `metric_points` (accepted data points) stays as a diagnostic. **This is a change to the ingest spec's §11.1 table**, which currently counts data points and explicitly declines to count rows |
| `SADD telemetry:usage:days:{day} {projectId}` + `EXPIRE … NX` | One extra pipelined command. Without it the rollup must `SCAN MATCH` the whole Redis keyspace |
| `telemetry:usage:org:{organizationId}:{day}` mirror hash | Three `HINCRBY`s (`metric_samples`, `log_bytes`, `spans`). Raw counters, never units |
| `telemetryQuotaHook` | Lives in `apps/api/src/telemetry/quota.ts`, registered as an `onRequest` hook after auth and wind-down, sharing its Redis read with the kill-switch check. **Ships in P5** — one phase number, superseding every other statement |
| `telemetry:disabled:*` / `telemetry:disabled:{projectId}` | Already specified in `02` §4. This document adds a *writer* (the disk guard, §10.3) and the ordering rule that telemetry sheds before analytics |
| Header stripping | `X-CH-DSN`, `x-ch-dsn`, `X-Ttl-Days`, `x-ttl-days`, `X-Scope-Meta` must be stripped from every customer request |

### Exposed to every other work-stream

| Symbol | Where | Contract |
|---|---|---|
| `TELEMETRY_RETENTION_DAYS` | `packages/constants` | `{ metrics: 30, logs: 14, traces: 7, labels: 30 }` on cloud. **`04-read-path.md`'s `observability.status.retentionDays` and its `GIGAPIPE_RETENTION_DAYS` env var must read this constant instead**, per signal — there is no single retention number any more |
| `TELEMETRY_UNIT_WEIGHTS`, `telemetryBillingUnits()` | `packages/constants` | §7.4 |
| `getTelemetryUsageWindow(organization)` | `packages/db` | Defined once, mirrors `getOrganizationBillingEventsCount` (`organization.service.ts:225-234`) |
| `gigapipe.op_project_retention` | ClickHouse, cron-owned | **Deferred with the tiering design (§6.3).** It does *not* exist in v1, so `02`'s deletion path must not depend on it — `08` S15's fingerprint resolution is the deletion mechanism |
| The two compose services and the six `.env` keys | `self-hosting/` | §2, §3.1 |
| Reads are **never** blocked by quota, at any usage level | §9.2 | `09-ui-surfaces.md` must not build a "reads disabled" state, and every observability surface must keep working for an org being shed |

### Cross-document edits this stream requires

| Document | Edit |
|---|---|
| `03-metrics-engine.md:1816, 2100` | `GIGAPIPE_USERNAME` → `GIGAPIPE_USER`, matching `04-read-path.md:283-297`, which enforces its env list with a CI grep |
| `06-traces-and-correlation.md:358-359` | `GIGAPIPE_CLUSTERED` → `GIGAPIPE_CLUSTER`, same reason |
| `04-read-path.md:297` | `GIGAPIPE_RETENTION_DAYS="7"` → per-signal, from `TELEMETRY_RETENTION_DAYS` |
| `02-ingest-gateway.md` §11 (draft) | Meter `metric_samples`, add the day-index `SADD` and the org mirror hash |
| `08-schema-changes.md` | `getTelemetryClient()`'s single-node fallback rule; `TelemetryUsageDaily.metricSamples` |

### Boundary this stream does **not** own

Protocol handling and the rewrite (`02`), the query surfaces (`03`–`06`), alert evaluation
(`07`), Prisma declarations and the ClickHouse migration (`08`), UI composition (`09`).

---

## Failure modes

| # | Failure | Detection | What the user sees | Mitigation |
|---|---|---|---|---|
| **F1** | `op-gigapipe-init` exits non-zero (`ctrl.Init` panics on a DDL error) | `op-gigapipe` never starts (`service_completed_successfully`); the smoke stack's exit-code assertion; init container logs | Telemetry ingest 503s; the observability UI shows the disabled/degraded state from `observability.status`. **Analytics is unaffected** (D7) | The most likely cause is the `MODIFY ORDER BY` case in §6.1; the P0 gate exists to catch it before anyone deploys |
| **F2** | Empty `CLOKI_LOGIN`/`CLOKI_PASSWORD` silently disable gigapipe's auth entirely (`cmd/gigapipe/main.go:321-324`) | **Nothing else catches it** — the healthcheck passes either way. The smoke assertion that an unauthenticated `/ready` returns 401 is the detector | Nothing. Every container on the default bridge could write to `/loki/api/v1/push`, `/_bulk` and the OTLP gRPC receiver | `${GIGAPIPE_USER:?…}` in the compose (§2) makes Compose refuse to start; the smoke assertion covers CI; the docs page states it in bold |
| **F3** | `get_latest_images apply` rewrites the gigapipe image to the OpenPanel API image | Two API containers boot with gigapipe's env; `docker compose ps` | Telemetry down, and two confused API replicas | The anchor fix in §4.2, which must land before or with the compose change |
| **F4** | The TTL is declared but not executing (merges starved, `ttl_only_drop_parts` interaction) | `gigapipe_oldest_partition_age_days > window + 3` | Nothing, until the disk fills | This is why the gauge exists. A declared-but-unexecuted TTL is otherwise indistinguishable from a working one |
| **F5** | gigapipe clobbers our TTL after a `SAMPLES_DAYS` change or a version bump | `gigapipe_ttl_applied_age_seconds`; the next reconciler tick fixes it | Up to 6 h of logs on the 30-day metrics window — over-retention, never data loss | The reconciler re-asserts unconditionally (§6.2). Deliberately biased: the failure direction is cost, not loss |
| **F6** | `op-ch-data` fills | `op_ch_disk_free_ratio`, paged at 0.20 | Without the guard: ClickHouse rejects inserts for **both** databases, `/track` fails, the event buffer backs up in Redis, and `op-kv` runs `--maxmemory-policy noeviction` so Redis OOMs rather than sheds — a telemetry overage becomes a total analytics outage | The disk guard sets `telemetry:disabled:*` at 0.10 (§10.3). Telemetry sheds before analytics, always |
| **F7** | `gigapipe.ver` lost | gigapipe cannot boot; `op-gigapipe-init` panics on a bare `ADD COLUMN type_v2` (`log.sql:163,166,169,172`) | Telemetry down until fixed | `ver` is in the backup set unconditionally (D22). Recovery is restore-`ver` or hand-insert the watermark rows, **never** replay (§11.1) |
| **F8** | gigapipe down, `apps/api` up — the most likely production incident this stack will have | `gigapipe_up == 0`; the gateway's circuit breaker (`02`) | Ingest: **503 + `Retry-After`**, never 202 and never 200 — an OTLP exporter must retry, not drop. Reads: `observability.status` returns degraded and the surfaces show an error state, not an empty one, so nobody reads "no data" as "no problem". Analytics: **unaffected** | D7, D8, and `02` D10 all exist for this. There is no buffering: the gateway does not hold telemetry it could not forward |
| **F9** | The quota hook's Redis or Postgres read fails | `req.log.error` from the hook's catch | Ingest is **accepted** | Fail open, matching `subscriptionHook:66-73`. Dropping a paying customer's telemetry because Redis hiccuped is worse than letting an over-quota org through for a tick |
| **F10** | An org is shed but never warned | `telemetryUsageShedStartedAt` set while `telemetryUsageWarningSentAt` is null — a query worth running weekly | A 429 with no email. This is the incident D14 exists to prevent | Thresholds are evaluated in the hook on the same live number as the shed (§9.3) |
| **F11** | A mid-period upgrade leaves the shed banner and markers stale | Support ticket: "I upgraded and it still says I'm blocked" | Red banner and no further alerts until the next cycle | The `syncSubscriptionToOrg` re-arm in §9.4, mirroring the events path at `webhook.controller.ts:345-357` |
| **F12** | The rollup misses a night | `gigapipe_rollup_age_seconds > 172800` | The quota hook undercounts by up to a day and the billing chart has a hole | The job is idempotent per `(org, project, day)` and the Redis hashes have a 40-day TTL, so a manual re-run backfills. The nightly 00:00–01:20 blind window is closed by reading yesterday's hash too (§8.3) |
| **F13** | Project deleted; telemetry survives | `TelemetryErasure` ledger rows without a completion | A GDPR/erasure promise the product does not keep | `08` S15 owns the mechanism. This stream owns the ledger alarm and the stated latency bound |
| **F14** | gigapipe's fan-out arithmetic changes under a version bump, so §8.1's meter is wrong | `gigapipe_metric_fanout_ratio` moves > 25 % week-over-week; the CI reconciliation test fails first | Silently wrong bills, in either direction | The reconciliation test (Test requirements #9) and step 5 of §11.2 |

---

## Test requirements

### P0 gates — run these before anything else in this document is built

1. **The two ClickHouse experiments, together, on all three pinned images**
   (`25.10.2.65` template, `26.1.3.52` dev, `24.3.2-alpine` coolify). Against each: run
   migration 22's DDL, then (a) apply §6.1's two-clause `samples_v3` TTL and confirm both
   clauses survive `SHOW CREATE TABLE`; (b) run gigapipe `MODE=init_only` against the same
   database and confirm **exit 0**, which settles the `metrics_15s`
   `MODIFY ORDER BY (fingerprint, timestamp_ns, type)` question. Both fallbacks are written
   down (§6.1); neither is a dead end, but both change the design.
2. **`SHOW GRANTS`** for the ClickHouse user gigapipe and migration 22 connect as, on cloud —
   `CREATE DATABASE` or an out-of-band provisioning step (§5.3).
3. **`get_latest_images` replay** against a compose file containing
   `lindesvard/openpanel-api:2`, `docker.openpanel.dev/openpanel-dev/api:main-abcd`,
   `ghcr.io/metrico/gigapipe:v5.4.1` and `clickhouse/clickhouse-server:25.10.2.65`, for all
   three components, **twice in a row** — the second run is the one the current fix proposals
   break.
4. **`docker compose up -d --wait`** with the one-shot present, on the Compose version CI pins
   (§4.4).

### Must pass before P0 ships

5. **Wizard matrix.** For each of {observability yes, observability no, bring-your-own-ClickHouse}:
   assert the generated `docker-compose.yml` contains or omits both gigapipe services, and assert
   the generated `.env` contains **all six or none of** the `GIGAPIPE_*`/`TELEMETRY_*` keys. The
   "none" case is the one the draft got wrong.
6. **Unauthenticated `GET /ready` against `op-gigapipe` returns 401**, in the smoke stack. One
   line, catches the entire empty-credentials class (F2).
7. **`assert_status 401 "$API/telemetry/v1/metrics" -X POST`** and the `op-gigapipe-init`
   exit-code assertion, using the helpers written out in §4.4.
8. **Env-name agreement boot assertion:** `GIGAPIPE_DB`, `CLICKHOUSE_TELEMETRY_DB` and
   gigapipe's `CLICKHOUSE_DB` all resolve to the same string, asserted at `apps/api` boot when
   telemetry is enabled.

### Must pass before P1/P2 ship

9. **Fan-out reconciliation (the billing correctness test).** Post a fixed OTLP payload
   containing one gauge, one histogram with 11 boundaries, one exponential histogram and one
   summary with 3 quantiles, from one resource. Assert `metric_samples` in Redis equals
   `SELECT count() FROM gigapipe.samples_v3 WHERE type != 1` for that window. Expected:
   `1 + (11+1+1) + (n+2+1) + (3+2) + 1 target_info`. This is the test that makes D11 safe across
   a gigapipe bump.
10. **TTL idempotency and cost.** Run the reconciler twice with nothing changed; assert the
    second run issues its ALTERs at `materialize_ttl_after_modify = 0`, completes in the same
    order of magnitude as the first, and leaves `TelemetrySchemaState` unchanged apart from
    timestamps. Measure the wall time — it is the number that justifies the 6-hour cadence.
11. **TTL materialisation happens exactly once on a shortening.** Set `materialized = false`,
    run, assert one apply at `'1'`, run again, assert `'0'`.
12. **Type-0 rows land on the metric window.** Insert rows with `type` 0, 1 and 2 dated past both
    windows; assert only `type = 1` is dropped at the log window.
13. **Rollup idempotency and the blind window.** Run the rollup twice for the same day and assert
    identical rows. Then, with the clock at 00:30 UTC, assert the quota hook's `used` includes
    yesterday's un-rolled hash.
14. **`getTelemetryUsageWindow` parity.** For a trialing org, a paying org and an org with no
    subscription, assert the window the hook enforces against equals the window
    `subscription.telemetryUsage` displays.
15. **`limit = 0` sheds and onboarding seeds.** Assert a brand-new organization created through
    `onboarding` has a non-zero `subscriptionPeriodTelemetryLimit`, and that an org with `0`
    is refused with `reason: 'not_entitled'`.
16. **Marker lifecycle.** Assert the four markers are cleared by both the `order.updated` cycle
    reset **and** by a `syncSubscriptionToOrg` limit increase, and that a limit *decrease*
    clears nothing.
17. **`Organization` round-trips through `cacheable`.** A regression test that
    `getOrganizationByProjectIdCached` succeeds on a cache miss after the new columns exist.
    Trivial today, load-bearing the moment somebody proposes a `BigInt` column again (D12).
18. **Cron de-registration.** With `GIGAPIPE_URL` blank, assert `bootCron` registers neither
    `telemetryRetention` nor `telemetryUsageRollup`, and removes them if they were present.

### Load test — schedule it before P2's ClickHouse work lands

Its purpose is not to find gigapipe's ceiling. It is to find the point at which telemetry ingest
starts hurting **analytics**, because they share one Fastify process, one Node event loop and
one ClickHouse. Two generators run concurrently, always: a telemetry generator (OTLP/HTTP
**protobuf**, not JSON — `/v1/logs` and `/v1/traces` accept only binary protobuf, only
`/v1/metrics` has a protojson branch at `writer/controller/otlp_metrics.go:48-60`) and a steady
500 events/s to `POST /track`, which is the control.

| # | Scenario | Ramp | What it isolates |
|---|---|---|---|
| L1 | OTLP metrics only | 1 k → 200 k data points/s over 20 min | protobuf decode plus per-data-point `op_project_id` stamping and fan-out counting |
| L2 | Loki push only | 1 k → 100 k lines/s | the largest `string` column writes |
| L3 | OTLP traces only | 100 → 20 k spans/s | the `attrs_gin` fan-out (§7.3), the highest rows-per-request signal |
| L4 | Remote-write only | 1 k → 200 k samples/s | snappy decode; also proves the 10 MiB decompressed cap (`writer/controller/middleware.go:117-129`) |
| L5 | Mixed 40/40/20 | 30 % of each knee, held 2 h | steady state; the only scenario producing meaningful merge behaviour |
| L6 | Adversarial batch | 100 × 60 MiB OTLP requests | single-request decode latency; gigapipe's 64 MiB ceiling (`writer/controller/otlp_metrics.go:25-42`) |

Record on `apps/api`: `/track` p50/p95/p99 **with and without** the telemetry generator (this
delta is the headline number), event-loop lag p99, CPU and RSS. On gigapipe: its own `/metrics`
scraped with basic auth, and RSS against the 2 GiB limit — this is what replaces the UNVERIFIED
buffer sizing in §2.2. On ClickHouse: `system.parts` count and max level per table,
`system.merges`, and the analytics-side event buffer depth
(`buffer_event_count`, `apps/worker/src/metrics.ts`).

Pass criteria: at L5 held 2 h, `/track` p95 rises **< 10 ms** versus the control; no
`too many parts`; gigapipe RSS stable below its limit; event buffer depth returns to baseline
within 60 s of the generator stopping; L6 takes nothing down and oversize requests are rejected
by the gateway *before* reaching gigapipe.

**Triggers to extract the gateway into its own deployment.** The gateway lives inside `apps/api`
because that is where auth, the `Client` machinery and the wind-down hook already are.
**These six numbers are initial guesses, to be re-set from the measured baseline above, and no
single trigger firing once is a decision** — they exist so the conversation has a shape, not so
it has an answer.

| # | Trigger | Why roughly this number |
|---|---|---|
| T1 | Telemetry sustains > 25 % of `apps/api` CPU (p50 over 1 h) | Above a quarter, a telemetry spike is an analytics availability event |
| T2 | `/track` p95 rises > 20 ms at 50 % of the L5 rate | The customer-visible symptom, at half the tested load |
| T3 | Event-loop lag p99 > 100 ms attributable to protobuf decode | Decode is synchronous CPU on the main thread and cannot be yielded from |
| T4 | Telemetry exceeds 15 % of `apps/api` req/s | Routing, hooks and logging scale with request count regardless of body size |
| T5 | Any single decode exceeds 250 ms | One large batch stalls every other request on that process for that long |
| T6 | `apps/api` must be scaled for telemetry alone | The scaling units have diverged; that is the definition of a separate service |

The extraction is small if it is planned for: `apps/api/src/telemetry/**` plus the `Client` auth
helpers, talking to Redis, Postgres and gigapipe. Keeping it in one directory with **no imports
from the tRPC or chart layers** is what makes T1–T6 a week rather than a quarter — a constraint
that belongs in `02`'s file layout, not only here (`02` D9 already states it).

---

## Open questions

| # | Question | What would settle it | Blocking |
|---|---|---|---|
| **Q1** | Does `TTL <expr> DELETE WHERE <cond>, …` parse on CH 24.3 / 25.10 / 26.1? | Test requirement #1a. Five minutes | **§6 entirely.** Do it first |
| **Q2** | Is `ALTER TABLE metrics_15s … MODIFY ORDER BY` a clean no-op when the key already equals the target? | Test requirement #1b, the same five minutes | **All of P0.** If it errors, `op-gigapipe-init` fails on every install; the fallback is to pre-create `metrics_15s` with gigapipe's unextended key and own only the `PARTITION BY` |
| **Q3** | Does OpenPanel's production ClickHouse user hold `CREATE DATABASE`? | `SHOW GRANTS` (#2) | P0 for cloud |
| **Q4** | The included-telemetry-units table (§9.1) | Product and pricing. §7.4/§7.5 give the cost basis and the "1 B units ≈ 15/34/58 GB" sentence | P3 |
| **Q5** | Should trials get telemetry at all, or only paid plans? This document assumes yes, with a seeded 100 M allowance | Product. The argument for "no" is that telemetry is the most expensive thing a non-paying org can do | P3 |
| **Q6** | `BULK_MAX_SIZE_BYTES`, `ChannelsSample` and `ADVANCED_PROMETHEUS_MAX_SAMPLES` defaults — and therefore whether the value we set is a no-op and what gigapipe's real memory ceiling is | `docker run --rm ghcr.io/metrico/gigapipe:v5.4.1 --help`, or read `cloki-config` v0.0.96 (absent from this machine's module cache and not vendored), plus the load test | P6; the 2 GiB limit is a placeholder until then |
| **Q7** | Is `allow_nondeterministic_mutations` required for the sweep's join-through-`time_series_gin` predicate, on a replicated table? | The experiment in §6.3, same three images | Only when tiering ships. It is a P0-equivalent gate *for that phase* |
| **Q8** | Can an XML-defined ClickHouse user carry scoped `<grants>`, or does that need SQL RBAC? | `CREATE USER … ; GRANT ALL ON gigapipe.* …; SHOW GRANTS FOR …` per image (§5.3) | P7 |
| **Q9** | Does a bare `new client.Counter()` in `apps/api` reach `fastify-metrics`' register? | Read `fastify-metrics@12` | Only if anyone adds an API-side counter; §10 avoids it entirely |
| **Q10** | Coolify: port now, or declare unsupported? | Ops. §4.4 chooses "later"; the port is mechanical now that provisioning is in migration 22 | P7 |
| **Q11** | Re-running `packages/payments/scripts/create-products.ts` against 13 live Polar products to add `telemetryUnitsLimit` metadata — update-in-place or recreate? | Rehearse against the Polar sandbox organization. `:78,130,136` currently *match* on `eventsLimit` and skip, so the script must be extended to update rather than skip | P3, and it is live-catalogue work, not a code change |

---

## Effort

One engineer, assuming `02` (ingest) and `08` (schema) land in parallel.

| Phase | Work | Est. |
|---|---|---|
| **P0** | The two ClickHouse experiments (§6.1) — *first, they gate everything*. `get_latest_images` fix (§4.2). Two compose services (§2). `.env.template` + `quiz.ts`'s six changes (§4.1). Dev compose (§4.4). Smoke stack + four assertions (§4.4). Docs page (§4.5) | **1 w** |
| **P1** | `TELEMETRY_UNIT_WEIGHTS` / `TELEMETRY_RETENTION_DAYS` constants. `metricDataPointSamples` in the gateway + the fan-out reconciliation test (§8.1). Redis contract additions (§8.2). `telemetryUsageRollup` cron + `refreshOrganizationTelemetryUsage` + `getTelemetryUsageWindow` (§8.3) | **1 w** |
| **P2** | The TTL reconciler cron (§6.2), cron registration, `TelemetrySchemaState` wiring, the retention-health gauges | **0.5 w** |
| **P3** | Polar catalogue migration (§8.5) — `prices.ts`, `create-products.ts` update-in-place, `syncSubscriptionToOrg`. Billing widget + `subscription.telemetryUsage` + plan-picker line (§8.4) | **1.5 w** |
| **P4** | Two email templates, threshold evaluation and claim-guarded markers (§9.4, §9.5), banners | **0.5 w** |
| **P5** | `telemetryQuotaHook` + `getLiveTelemetryUnitsCached` + the support runbook (§9.3, §9.6). Ships **after** P4, deliberately | **0.5 w** |
| **P6** | Stack-health cron, disk guard and kill-switch writer (§10). The load test — schedule it before P2's ClickHouse work lands, since its results move `BULK_MAX_AGE_MS` and the memory limit | **1 w** |
| **P7** | Coolify port (§4.4). Scoped ClickHouse user + profile (§5.3). gigapipe `/metrics` republication | **1 w** |
| **P8** | *Only when the tiering trigger fires:* `op_project_retention`, `op_retention_sweep`, the watermark sweep, backfill on shortening, mutation backpressure, `system.mutations` monitoring (§6.3) | **1.5 w** |

**≈ 7 weeks to P7, ≈ 8.5 with tiering.** The draft's 8 weeks included tiering in the critical
path; moving it behind a trigger is the single biggest schedule and risk change in this
document.

### Minimum viable P0, if the time is not there

The two compose services, the `get_latest_images` fix, the six `.env` keys and the docs page —
plus, non-negotiably, the two ClickHouse experiments and the `PARTITION BY` in migration 22.
Everything else in this document can be added later; the partition key cannot.

### What would make this bigger

- **The TTL syntax does not parse (Q1).** Logs over-retain by 16 days until tiering ships, or
  P8 is pulled forward. **+1.5 w**, and the sweep's own unverified premise (Q7) comes with it.
- **`MODIFY ORDER BY` errors (Q2).** `metrics_15s` cannot carry `type` in its partition key, so
  metric and log rollup rows share parts and the rollup table's retention collapses to
  `max(logs, metrics)`. Not fatal — `samples_v3` still splits — but it means the rollup is
  retained at 30 days regardless. **+0.5 w** and a permanent cost line.
- **The Polar catalogue migration goes wrong.** Thirteen live products, matched on metadata the
  script is about to change. Rehearse in the sandbox. **+1 w** if it has to be redone by hand.
- **The load test finds `/track` p95 moving.** Then T1–T6 stop being hypothetical and the
  gateway extraction lands inside this plan rather than after it. **+3–4 w.**
- **A customer buys 90-day metrics before P8.** The tiering trigger fires early and P8 becomes
  P2.5, with Q7 as a new blocking gate.

---

## Findings rejected

Three review findings are not adopted, with the source that settles each.

**1. "Add a `deleted_at`/tombstone column to `op_project_retention` so retired projects stay
sweepable, and have the nightly reconcile mark-not-drop."** Rejected because it solves a problem
inside a mechanism that no longer ships in v1 (§6.3) *and* because it is the wrong mechanism even
then: telemetry deletion is `08` S15's fingerprint resolution called from inside
`deleteFromClickhouse`, which covers both existing call sites (`cron.delete.ts:46` and the admin
tool) and does not consult the retention table at all. The underlying finding — that telemetry
was never deleted on project delete — is real, and is addressed by pointing at `08` S15 and by
owning the ledger alarm and the stated latency bound (Interfaces, F13).

**2. "Store the last-applied DDL record next to `op_project_retention` in ClickHouse rather than
adding a Postgres model."** The *first* half of that finding is adopted in full: the draft's
`TelemetryDdlState` with its `sha256(engine_full)` desired/observed protocol is cut, for the
three reasons in D18. The storage-location half is rejected: `08` S14 has already settled it as
one Postgres row, `TelemetrySchemaState`, and `materialized` is genuinely load-bearing — it must
survive a `DROP DATABASE gigapipe`, which is exactly the event that would erase a ClickHouse-side
record, and it is the flag that decides whether the next apply rewrites every part of
`samples_v3`.

**3. "`limit <= 0` should mean unlimited"** — this document's own draft position, rejected
against `08` S5. Two sibling columns on one model where `0` means opposite things is the exact
inversion any shared shedding helper gets wrong, and the codebase already documents the fix for
the events axis (`packages/trpc/src/routers/onboarding.ts:21-24`, `:40`): seed the trial limit.
The consequence is a required one-shot backfill for existing organizations, listed in §9.1 — a
migration is cheaper than a permanently ambiguous sentinel.

---

## Appendix A — files this work-stream touches

Nothing below is modified by this document; it is the change inventory.

**New:**

```
apps/worker/src/jobs/cron.telemetry-retention.ts
apps/worker/src/jobs/cron.telemetry-usage.ts
apps/api/src/telemetry/quota.ts                       # shared with 02
apps/api/src/telemetry/meter.ts                       # metricDataPointSamples, shared with 02
packages/email/src/emails/telemetry-usage-near-limit.tsx
packages/email/src/emails/telemetry-usage-limit-exceeded.tsx
apps/start/src/components/organization/billing-telemetry-usage.tsx
apps/public/content/docs/self-hosting/observability.mdx
```

**Modified:**

```
self-hosting/docker-compose.template.yml              # + 2 services after :119
self-hosting/.env.template                            # + 6 keys, all $TOKEN
self-hosting/quiz.ts                                  # :8-16, :146-155, :222-231, :377-387, :395-405
self-hosting/get_latest_images                        # :272-280  (prerequisite bug fix)
self-hosting/clickhouse/clickhouse-user-config.xml    # + <profiles>/<quotas> op_gigapipe   (P7)
docker-compose.yml                                    # + 1 service (dev)
.env.example                                          # + 3 commented keys
.github/smoke/docker-compose.yml                      # + 2 services
.github/smoke/smoke.sh                                # + assert_status helper, + 3 assertions
packages/constants/index.ts                           # TELEMETRY_UNIT_WEIGHTS, TELEMETRY_RETENTION_DAYS,
                                                      #   telemetryBillingUnits
packages/queue/src/queues.ts                          # :188-207 union + 2 payload types
apps/worker/src/boot-cron.ts                          # guarded push, next to the `ping` guard at :128-134
apps/worker/src/jobs/cron.ts                          # :28-83 switch, 2 cases
apps/worker/src/metrics.ts                            # + stack-health, capacity and retention gauges
apps/api/src/controllers/webhook.controller.ts        # :140-155 tracked fields, :293-311 telemetryUnitsLimit
                                                      #   parse, :345-357 upgrade re-arm, :485-501 cycle reset
packages/payments/src/prices.ts                       # IPrice.telemetryUnits on 13 tiers
packages/payments/scripts/create-products.ts          # :78,:98,:123,:130,:136 metadata write + update-in-place
packages/trpc/src/routers/onboarding.ts               # :21-24,:40 seed TELEMETRY_TRIAL_UNITS_LIMIT
packages/trpc/src/routers/subscription.ts             # + telemetryUsage, products metadata line
packages/db/src/services/organization.service.ts      # + getTelemetryUsageWindow, getTelemetryUsageSerie,
                                                      #   refreshOrganizationTelemetryUsage
packages/email/src/emails/index.tsx                   # :130-141 registry + 2 imports
apps/start/src/components/organization/billing.tsx    # render the sibling widget
apps/public/content/docs/self-hosting/environment-variables.mdx  # 6 new entries
apps/public/content/docs/self-hosting/meta.json       # register the new page
docs/observability/03-metrics-engine.md               # GIGAPIPE_USERNAME -> GIGAPIPE_USER
docs/observability/04-read-path.md                    # GIGAPIPE_RETENTION_DAYS -> per-signal constant
docs/observability/06-traces-and-correlation.md       # GIGAPIPE_CLUSTERED -> GIGAPIPE_CLUSTER
```

**Owned by `08-schema-changes.md`, not by this document:** `packages/db/prisma/schema.prisma`,
`packages/db/prisma/migrations/**`, `packages/db/src/clickhouse/telemetry-client.ts`,
`packages/db/code-migrations/22-telemetry-database.ts`,
`packages/db/src/services/delete.service.ts`.

**Explicitly not modified:** `self-hosting/clickhouse/clickhouse-config.xml`,
`self-hosting/clickhouse/init-db.sh` (`/docker-entrypoint-initdb.d` runs only on a fresh data
directory, and migration 22 creates the database anyway — `08` S16),
`self-hosting/setup` / `start` / `stop` / `update` / `danger_wipe_everything`,
`packages/db/src/clickhouse/migration.ts` (its helpers cannot target a second database:
`getExistingTables()` hardcodes `WHERE database = 'openpanel'` at `:174-186`, `createTable`'s
clustered branch emits `Distributed('{cluster}', currentDatabase(), …)`, and
`createMaterializedView`'s placeholder rewrite is `/\{(\w+)\}/g` where `\w` does not match `.`),
`self-hosting/coolify.yml` (§4.4, deferred to P7), and any file in
`/Users/drew/projects/gigapipe` (§12).
