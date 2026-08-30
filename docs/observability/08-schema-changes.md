# Schema changes: Prisma and ClickHouse

**Implementation specification — work-stream: persistence.**

This document specifies every row the observability plan writes, in Postgres and in
ClickHouse: twelve Prisma changes across seven migration files, one numbered ClickHouse
code-migration that pre-creates the two gigapipe tables whose `PARTITION BY` we must own,
a second `@clickhouse/client` bound to gigapipe's database **and the single table-naming
surface every other work-stream imports**, the conditional per-signal TTL statement and the
mechanism by which gigapipe's own startup can overwrite it, the deletion path for a database
with no `project_id` column anywhere in it, and a rollback for each.
It does **not** decide what a metric report means (`03-metrics-engine.md`), how an alert
fires (`07-alerting.md`), or when a byte is metered (`10-ops-retention-billing.md`). The
one irreversible decision here is the partition key of `samples_v3` and `metrics_15s`:
`PARTITION BY` cannot be `ALTER`ed and every gigapipe table statement is
`CREATE TABLE IF NOT EXISTS`, so whichever process creates those two tables first decides,
permanently, whether per-signal retention is possible at all. Everything downstream of
that — the conditional TTL, the drift row, the re-assert loop — is deferrable; the
partition key is not.

---

## Revision note — what changed in this pass, and who has to follow

Five reviewers read all eleven specifications together. This revision absorbs their
cross-document findings. Everything below is a change to a decision **another document
depends on**; each is repeated in its own section with the reasoning, and each has a row in
`Interfaces → Requested of other work-streams`.

| # | Change | This document previously | Who must follow |
|---|---|---|---|
| R1 | **`Report.dataSource` is cut.** No `DataSource` enum, no column, no migration. Dispatch is `getReportDataSource(series)` on the `type: 'metric'` union member | S1 mandated the enum + column | `09-ui-surfaces.md` D8 (retarget the eight-site table at the union member), `04-read-path.md` D4 (re-price) |
| R2 | **One home for the gigapipe table names**: `packages/db/src/clickhouse/telemetry-client.ts`, one env var `GIGAPIPE_DB`, unqualified `TELEMETRY_TABLES` values, one `telemetryTable(key, mode)` | 08 had a third `TELEMETRY_TABLES`; three other files had their own | `04` D12 (`G()`, `TELEMETRY_DB` in `client.ts`), `05` §7.2 (`packages/db/src/gigapipe/table-name.ts`), `06` §5 (`g()`, `getTelemetryMutationTable`, `TELEMETRY_IN`) |
| R3 | **`getReplicatedTableName` is never applied to a gigapipe table**, and no emitted gigapipe statement may contain `_replicated` | already implied by §10; now an exported rule and a CI assertion | `11` I14 and gate 1.9 (which currently *require* the broken construction) |
| R4 | **`TelemetryUsageDaily` takes `10-ops`' field list** and the key `(organizationId, projectId, day)` | a different, smaller field list on `(projectId, day)` | `05` §4.6 (`TelemetryUsage` is deleted), `10` §8.3 (raw-SQL column names, see §4) |
| R5 | **One deletion function**, `deleteTelemetryFromClickhouse`, non-throwing, called inside `deleteFromClickhouse`, with `05`'s resumability folded into `TelemetryErasure`. It ships in **P1** | the ledger was filed under a `10-ops`-local phase number and the resume path did not exist | `05` §7.4 (`purgeTelemetry`, `TelemetryPurgeJob`), `06` §11.6 (`deleteTelemetryForProjects`, `deleteTelemetryForProfile`), `09` §14, `11` I13/I14 |
| R6 | **The telemetry table list is one exported constant** (`TELEMETRY_TABLES`) and the *delete-target* subset is a second one (`TELEMETRY_DELETE_TARGETS`, seven tables, `tempo_traces_kv` excluded) | the list was enumerated inline in §13 and §14 | `02` §17 (seven tables, no `patterns`), `05` §7.4 (five), `11` I13 (eight, including `tempo_traces_kv`) |
| R7 | **§13 no longer rests on "type 0 can never occur."** The `type != 1` / `type = 1` form is total either way; the type-0 residual is disclosed unconditionally, not conditionally | option (c) assumed `02`'s ban on Loki push held | `02` §1 (its `Interfaces → schema` row is false against `05`), `05` D1/§4.1, `10` D10 |
| R8 | **Retention numbers corrected.** The worked example is 30 d metrics / 14 d logs (`10` §6.1), not 90/30, and the tier table this document cited as current is `10` §6.3's **deferred** design | §13 cited `10-ops-retention-billing.md:925-932` as live tiers | `10` (rename the object export to `TELEMETRY_RETENTION`; keep `TELEMETRY_RETENTION_DAYS` for the self-hosted scalar), `04` §3, `06` §6.0 |
| R9 | **Cloud topology adopted from `10` §5.2**, and S9's skip predicate is re-derived: migration 22 skips on **`GIGAPIPE_CLUSTER`**, not on `CLICKHOUSE_CLUSTER`/`getIsCluster()` | S9 skipped whenever the *analytics* cluster flag was set, which shipped nothing to Cloud in any phase | `10` §5.2, `05` §7.1 (its `isClickhouseClustered()` Replicated branch becomes dead) |
| R10 | **`ProjectIdTombstone` is absorbed** into the Postgres inventory, with its migration, backfill, the `getId` guard and the `deleteProjects` write | absent entirely | `01` D5/§3.3 (keeps the design, loses the ownership gap) |
| R11 | **`Organization.telemetryRetentionTier`/`…Since` are cut**, and `Project.telemetryLogRetention` with them: `10` D9 is "one window per signal for everyone" in v1 | seven `Organization` columns | `05` §3.6 |
| R12 | **The ClickHouse `<profiles>` block lands in P0**, attached to whichever user gigapipe connects as; the dedicated `op_gigapipe` **user** stays at `10` D16's P7 | S16 read as "this work-stream touches nothing in `self-hosting/clickhouse/`" | `10` D16/§5.3, `05` §7.5 |
| R13 | **Section headings use master phases P0–P6 only.** `10-ops`' internal P0–P8 vocabulary is not used in this document | §4/§5/§6 headings used `10-ops` numbering and contradicted this document's own Sequencing table | — |

Two things a reviewer asked for that this document **cannot** deliver, recorded rather than
silently dropped:

- **`00-blueprint.md` does not exist on disk.** Four findings ask for a consolidated spike
  sheet and a programme-wide open-question table to live there. Until that file exists, the
  de-duplication mapping is published in this document's `Open questions` table (which
  experiment settles which document's question), and it is the only place it exists.
- **The log-ingest protocol decision is not this work-stream's to make.** §13 has been
  rewritten so that it is *correct under either* answer, which is the most this document can
  do; the decision itself is owed by `02` and `05` and is listed as a P0 blocker.

## Scope

**In scope**

- Every Prisma enum, model and field addition: declaration, default, backfill question,
  generated migration SQL, and the `packages/db/src/types.ts` JSON type declaration where
  one is needed.
- The two Postgres enum constraints the repo already documents, and which of our changes
  each one binds.
- `packages/db/code-migrations/22-telemetry-database.ts`: the database, the two
  pre-created tables, the exact DDL, registration, cluster behaviour, and the operator
  escape hatch.
- The **compatibility contract** between our pre-created tables and gigapipe's own
  DDL — column order, sorting key, `SETTINGS`, and the statements in gigapipe's scripts
  that are *not* `IF NOT EXISTS`.
- A second `@clickhouse/client` bound to gigapipe's database, lazily constructed, **and the
  single table-naming surface** (`TELEMETRY_TABLES`, `telemetryTable()`, `TELEMETRY_IN`) that
  every other work-stream imports instead of writing its own (§11.1).
- ClickHouse users and grants; whether `self-hosting/clickhouse/init-db.sh` and
  `clickhouse-user-config.xml` need editing (`init-db.sh` does not; the user config gains a
  `<profiles>` block in P0 — S16, revised).
- The conditional per-signal TTL statement, the three settings that decide whether it
  works and whether it is free, and gigapipe's clobber.
- `deleteTelemetryFromClickhouse`, its call site, its failure isolation, its resumable
  ledger, and the **one** table list every deletion and retention path imports.
- `ProjectIdTombstone` — the model, the migration, the backfill and the `getId` guard that
  `01-tenancy-and-security.md` D5 designs and no work-stream owned (R10).
- A rollback for every change, and an explicit list of the one-way doors.

**Out of scope (owned elsewhere, referenced here)**

| Concern | Owner |
|---|---|
| `zMetricQuery`, the widened `zChartEventItem`, `getReportDataSource(series)` | `03-metrics-engine.md` §2, §15 |
| `zNotificationRuleMetricConfig`, evaluator semantics, alert-state *behaviour* | `07-alerting.md` §2, §4 |
| The retention cron that *runs* the TTL DDL; unit weights; Redis metering; tier tables | `10-ops-retention-billing.md` §7, §8, §10 |
| The compose service graph, gigapipe env vars, `OMIT_CREATE_TABLES`, `SAMPLES_DAYS` | `10-ops-retention-billing.md` D3/D20 |
| `validateTelemetryRequest`, `op_project_id` stamping | `01-tenancy-and-security.md`, `02-ingest-gateway.md` |
| `GIGAPIPE_URL` and the enabled/disabled state machine | `04-read-path.md` §"config" |

### Naming — settled

The ClickHouse database gigapipe owns is **`gigapipe`**. This closes the draft's Q1 in the
opposite direction to the draft's guess, on a corrected count: excluding the draft itself,
`docs/observability/` contains 75 references to `gigapipe.<table>` (in `04-read-path.md`,
`05-logs.md`, `06-traces-and-correlation.md`, `10-ops-retention-billing.md`,
`11-testing-strategy.md`) against 16 to `openpanel_telemetry`. `10-ops-retention-billing.md`
owns the compose file and already writes the pre-create DDL and every TTL statement
against `gigapipe`. Renaming 75 call sites in five documents to match this one is the
wrong direction.

**The env var that names it is `GIGAPIPE_DB`** — revised (R2). The previous revision of this
document invented `CLICKHOUSE_TELEMETRY_DB`, which made four documents read four different
variables for one value. `04-read-path.md:283-297` declares itself the authority on the
`GIGAPIPE_*` surface and enforces it with a CI grep; `10-ops-retention-billing.md` §3.1 already
ships `GIGAPIPE_DB` in `.env.template` and calls the naming settled; `05-logs.md` §7.2 and
`06-traces-and-correlation.md` §5 both already read it. This document is the outlier and
concedes.

| Name | Read by | Default |
|---|---|---|
| `CLICKHOUSE_DB` | gigapipe (`cmd/gigapipe/main.go:92-94`, default `cloki`) | must be set to `gigapipe` |
| **`GIGAPIPE_DB`** | OpenPanel: migration 22, `telemetry-client.ts`, every read and mutation | `gigapipe` |
| `CLICKHOUSE_TELEMETRY_DB` | **deprecated alias** for `GIGAPIPE_DB`, honoured with a warning | unset |
| `CLICKHOUSE_TELEMETRY_URL` | OpenPanel only; selects the telemetry **host**, falls back to `CLICKHOUSE_URL` | unset |
| `GIGAPIPE_CLUSTER` | gigapipe's own `CLUSTER_NAME`, mirrored to OpenPanel (`04` D12) | unset |

`CLICKHOUSE_TELEMETRY_URL` survives because it names a *host*, which is a genuinely separate
fact from the database name — `10` §5.2's cloud plan puts the `gigapipe` database on a
dedicated node. It no longer *selects* a database: if its path segment names a database that
disagrees with `GIGAPIPE_DB`, `telemetryDatabase()` throws rather than silently picking one
(§11). That closes the same hole the previous revision closed, without a third precedence rule.

`GIGAPIPE_CLUSTER` — not `CLICKHOUSE_CLUSTER`, not `isClickhouseClustered()`, not
`getIsCluster()` — is the **only** predicate any gigapipe-directed statement or migration may
branch on (S9, revised; §11.1). The three OpenPanel predicates describe the *analytics*
cluster and say nothing about gigapipe's topology; `04` D12 states this and is right.

All of `GIGAPIPE_DB`, `CLICKHOUSE_TELEMETRY_URL` and the BYO-ClickHouse grant belong in
`environment-variables.mdx`; that doc edit is in the inventory below.

The enforced resource attribute is `op_project_id`.

---

## Decisions

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| **S1** | **REVERSED (R1). There is no `Report.dataSource` column and no `DataSource` enum.** The data source is *derived* from the series array by one helper, `getReportDataSource(series)` in `packages/db/src/engine/data-source.ts` (`03-metrics-engine.md` §15.1), which returns `'metrics'` when `series.some(s => s.type === 'metric')` | the previous revision of this decision: a new Postgres enum `DataSource { events metrics }` plus a `Report.dataSource` column. (The older alternative — putting the discriminator in `Report.options` — stays rejected, for the reason below) | `03` §15.1 is right on the merits and this document was wrong. The discriminator **has to arrive from the browser regardless**: `ctx.report` is `null` on every non-shared query (`packages/trpc/src/routers/chart.ts`), so `zReportInput.series` carries the `type:'metric'` union member on every execution path whether or not a column exists. Given that, the column buys one filterable index that no query uses (§3 "Index?") and costs an irreversible `CREATE TYPE`, three hand-written write literals, an extra migration and a deploy-ordering hazard on `report.update`. The previous revision's own argument — "the discriminator has to arrive from the browser regardless" — is satisfied without it. **What survives is the whitelist inventory** (§3): it was correct and valuable, and it is retargeted at the union member. *`Report.options` stays rejected as the carrier*: it is `zReportOptions`, a `z.discriminatedUnion('type', …)` keyed on **chart type** (`packages/validation/src/index.ts:198-203`), and a metric report still needs `options.type === 'histogram'` |
| **S2** | The metric query spec lives inside `Report.events` as a third member of `zChartEventItem`, not in a new `metricQuery Json?` column | a dedicated column | `Report.events` is already the series array and already `Json`; `format.ts` and `compute()` iterate `series` positionally against `definitions`. A parallel column would need its own alpha-id alignment with `events` for formulas to keep working. `03-metrics-engine.md` specifies the union member; this document records only that **no second column is needed** |
| **S3** | `ClientType += telemetry` ships in a migration file containing nothing else, in the same PR as **four** allow-list conversions and **two** creation-surface widenings | add the value now, tighten the validators later | The three surviving deny-lists (`apps/api/src/utils/auth.ts:202`, `:237`, `packages/mcp/src/auth.ts:99`) all read `if (client.type === ClientType.write) throw`. The instant `telemetry` exists in the enum, a telemetry token is accepted by `/export`, `/insights` (`apps/api/src/routes/insights.router.ts:50` calls `validateExportRequest`), `/import` and MCP. **The enum value is the privilege grant** |
| **S4** | A `telemetry` client must have a non-null `projectId`, enforced by a Postgres `CHECK` constraint and a zod refine at both creation surfaces | rely on the ingest gateway to check | `Client.projectId` is nullable (`schema.prisma:364`) and `manage.controller.ts:320` writes `projectId: projectId \|\| null`. `op_project_id` — the entire tenancy boundary — is taken from that column. A representable-but-invalid row is a schema problem, so the schema fixes it |
| **S5** | Telemetry metering counters follow the **existing** convention exactly: `Int` on `Organization` (saturating), `BigInt` on `TelemetryUsageDaily`, and `limit = 0` means **zero allowance**, not unlimited | `0` means unlimited; or `BigInt`/`Int` everywhere | `packages/trpc/src/routers/onboarding.ts:21-24` documents the trap and its workaround: "the limit defaults to 0, which trips on the first event", fixed by seeding `TRIAL_EVENTS_LIMIT = 10_000_000`. Two sibling columns on one model where `0` means opposite things is the exact inversion any shared shedding helper gets wrong. `logBytes` at ~2.8e10/day overflows `int4` on row one, so the ledger is `BigInt` |
| **S6** | One new ClickHouse code-migration, `22-telemetry-database.ts`, creates the database and exactly **two** tables: `samples_v3` and `metrics_15s` | let gigapipe create everything | `PARTITION BY` cannot be `ALTER`ed, and per-signal retention is impossible without `type` in the partition key while `rotateTables` forces `ttl_only_drop_parts = 1` (`ctrl/qryn/maintenance/rotate.go:77-79`). Both tables are `CREATE TABLE IF NOT EXISTS` (`ctrl/qryn/sql/log.sql:25`, `:83`), so first writer wins. Everything else in the database is gigapipe's |
| **S7** | The pre-created tables reproduce gigapipe's **column order** (`type` last) and, for `metrics_15s`, gigapipe's **post-ALTER sorting key** `(fingerprint, timestamp_ns, type)`. Only `PARTITION BY` differs | pre-create with `type` first and let gigapipe's `MODIFY ORDER BY` "extend" our key | ClickHouse's `MODIFY ORDER BY` restriction is **not** "must extend"; it is "columns newly added to the sorting key must have been added by an `ADD COLUMN` in the same `ALTER`". gigapipe's `ALTER TABLE metrics_15s ADD COLUMN IF NOT EXISTS type UInt8, MODIFY ORDER BY (fingerprint, timestamp_ns, type)` (`log.sql:126-128`) satisfies that only because it adds the column itself. Against a table where `type` already exists the `ADD COLUMN` is ignored and the `MODIFY ORDER BY` references a pre-existing column. `ctrl.Init` returns that error, `initDB` panics (`cmd/gigapipe/main.go:66-82`), `op-gigapipe-init` crash-loops. Pre-creating with the key already equal makes the diff empty. §9 is the full contract; **U1** is the probe |
| **S8** | `samples_v3` is pre-created with `ORDER BY (fingerprint, timestamp_ns)` — a **deliberate override** of gigapipe's default — and migration 22 honours `ADVANCED_SAMPLES_ORDERING` when it is set | reproduce gigapipe's default `ORDER BY (timestamp_ns)` | gigapipe's template is `ORDER BY ({{.SAMPLES_ORDER_RUL}})` and that token defaults to the single column `timestamp_ns` (`ctrl/qryn/maintenance/update.go:214`). Every samples read is `WHERE fingerprint IN (<subquery>) AND timestamp_ns BETWEEN …`; the time bound is already pruned to a day by our partition key, so a time-only sort key means a full scan of each touched day partition. Cost, stated: ingest arrives in time order, so fingerprint-first parts overlap in key range and merges do more work. Because `CREATE TABLE IF NOT EXISTS` makes this permanent, `ADVANCED_SAMPLES_ORDERING` would otherwise become a dead env var — migration 22 reads it, so it does not |
| **S9** | **REVISED (R9).** The migration no-ops with a warning when **`GIGAPIPE_CLUSTER` is set** — not when `getIsCluster()` is true — is still recorded, and carries an explicit `--force-telemetry` override | throw and fail `migrate:deploy`; or the previous revision's `getIsCluster()` predicate | Two parts. (a) **Not a throw:** `pnpm migrate:deploy` runs inside `op-api`'s startup command (`self-hosting/docker-compose.template.yml:95-101`) and in Cloud's deploy pipeline, so a throw turns "telemetry is not supported on this topology yet" into "the API does not boot". (b) **`GIGAPIPE_CLUSTER`, not `getIsCluster()`:** the thing that decides whether these two tables need `Replicated*` engines is whether *gigapipe's* target is a cluster, which is `CLUSTER_NAME` on the gigapipe container (`cmd/gigapipe/main.go:97-99`, mirrored to OpenPanel as `GIGAPIPE_CLUSTER` by `04` D12). `CLICKHOUSE_CLUSTER=true` describes the **analytics** cluster and says nothing about the dedicated telemetry node `10` §5.2 puts the `gigapipe` database on. Under the previous predicate, Cloud — which sets `CLICKHOUSE_CLUSTER=true` — skipped migration 22 in every phase, so the whole programme delivered nothing to Cloud, ever. Under this one, Cloud's dedicated non-clustered node runs the single-node path and Cloud ships in P0. The override survives for the day `GIGAPIPE_CLUSTER` is legitimately set |
| **S10** | The migration writes raw SQL through the **telemetry client's own URL resolution**, not `createTable()` and not `runClickhouseMigrationCommands` | reuse `packages/db/src/clickhouse/migration.ts`'s helpers and executor | Three independent reasons. (a) The helpers emit OpenPanel's `_replicated` + `Distributed('{cluster}', currentDatabase(), …)` convention (`migration.ts:103-116`); `currentDatabase()` is `openpanel`, so the shard target would be wrong. (b) `chMigrationClient` is bound to `CLICKHOUSE_URL` at module load (`migration.ts:37-38`), which is not necessarily the telemetry server (§11 reason 2) — the DDL would land on the analytics host while gigapipe used another. (c) `runClickhouseMigrationCommands` sets `query_id = sha256(sql)` (`migration.ts:447`), so two `op-api` replicas booting together collide with `QUERY_WITH_SAME_ID_IS_ALREADY_RUNNING` and the loser calls `process.exit(1)` (`migrate.ts:109-115`) |
| **S11** | A second client in `packages/db/src/clickhouse/telemetry-client.ts`, reached only through a memoized `getTelemetryClient()` — never a module-scope `const` | `export const chTelemetry = createClient({ url: telemetryUrl() })` at module scope | `packages/db/index.ts` is a pure barrel of 44 `export *` lines, imported by `apps/api`, `apps/worker`, `apps/start`, `packages/mcp`, `packages/trpc`, the migration runner and every vitest file. A module-scope `throw` from `telemetryUrl()` (unset env, malformed URL) is an unhandled exception at import time, before any logger exists. `chMigrationClient` avoids this by passing `process.env.CLICKHOUSE_URL` through untouched, and `client.ts:272-281` wraps `new URL` in try/catch for the same reason. **`telemetry-client.ts` must not throw or perform I/O at module scope** |
| **S12** | Per-signal retention is a **conditional table TTL**, applied by the retention cron on every run, **unconditionally**, at `materialize_ttl_after_modify = 0` | a migration; or a desired-state gate that skips DDL when a fingerprint is unchanged | A migration runs once and is recorded; the TTL must be re-asserted after every gigapipe init run and must change when a tier changes. And a fingerprint gate has a hole: gigapipe's clobber is guarded by a row in `gigapipe.settings` keyed on `rotateTTLStr` (`rotate.go:73-75`), which changes when `SAMPLES_DAYS` or the TTL policy changes — with **no** change to `gigapipe.ver` and no change to any desired-state fingerprint we compute. Re-asserting unconditionally has no blind spot to reason about. At `materialize_ttl_after_modify = 0` a `MODIFY TTL` is a metadata ALTER; **U4** measures it |
| **S13** | `type != 1` / `type = 1`, never `type IN (2,0)` / `type = 1`; plus a hard invariant `metricDays >= logDays` asserted before the DDL is emitted; plus a **gauge** on the type-0 population — **no longer an assertion that type-0 never occurs** (R7) | equality on both sides; three clauses; or `05` §7.3's `type IN (1,0)` at 30 d / `type = 2` at 395 d | `type` has three values — 0 = UNDEF/both, 1 = LOG, 2 = METRIC (`writer/model/insert_request.go:8-11`) — and 0 is written by live ingest, not only by legacy rows (`writer/utils/unmarshal/unmarshal.go:163-165`, `:225-228`, the `if tp == 3 { tp = 0 }` collapse). Two total clauses cannot leave a row uncovered. But totality is not the whole question: `GetTypes` emits `type IN (<requested>, 0)` (`reader/logql/logql_transpiler/clickhouse_planner/sql_misc.go:213-220`), so a type-0 row is visible to **both** log and metric queries. Putting it on the `!= 1` branch is correct only while `metricDays >= logDays`. **`05-logs.md` §7.3 writes the opposite** — `DELETE WHERE type IN (1, 0)` on the short window — which is exactly the silent-truncation case `10` D10 names: expiring a type-0 row on the log window deletes rows metric queries still return, whereas expiring it on the metric window is a retention-*promise* disclosure, not a correctness bug. `05`'s form is also non-total if a fourth value ever appears. This document owns the statement; §13 states the residual honestly and unconditionally, so it no longer depends on `02`'s ban on Loki push holding |
| **S14** | Drift state is one Postgres row (`TelemetrySchemaState`) carrying `materialized`, `desiredFingerprint`, `lastError` — and **not** `gigapipeSchemaVer` | keep `gigapipeSchemaVer`; or drop the model entirely | `materialized` is genuinely load-bearing: `materialize_ttl_after_modify = 1` must run exactly once, on the first apply against a database that already holds data or on any window that *shortens*, and nothing in ClickHouse records that it happened. `desiredFingerprint` survives only to decide `1` vs `0`, not to gate DDL (S12). `gigapipeSchemaVer` is cut: `max(ver)` advances only when statements are appended to gigapipe's SQL scripts (`update.go:271-286`), which is not the trigger for the clobber, so it detected nothing it was added to detect. **This is a delta against `10-ops-retention-billing.md:691-706`; §14 of that document must adopt it** |
| **S15** | Deleting a project deletes its telemetry through a **fingerprint-resolution** step, in **one** exported function — `deleteTelemetryFromClickhouse` — called from **inside** `deleteFromClickhouse`, guarded on `isTelemetryEnabled()`, wrapped in try/catch, with a **resumable** `TelemetryErasure` ledger row. It ships in **P1** (R5) | extend `deleteFromClickhouse`'s table list; call the new function from `cron.delete.ts`; `05` §7.4's `purgeTelemetry` + `TelemetryPurgeJob` called per-project from `jobDelete` so that only successfully-purged projects proceed to `deleteProjects`; `06` §11.6's `deleteTelemetryForProjects` called *between* `deleteFromClickhouse` and `deleteProjects` | No gigapipe table has a `project_id` column. `op_project_id` is a key inside `time_series.labels` (a JSON string) and inside `tempo_traces_attrs_gin.(key,val)`, so the delete is a resolve-then-delete. Calling from inside `deleteFromClickhouse` covers **both** existing call sites — `apps/worker/src/jobs/cron.delete.ts:46` and `admin/src/commands/delete-organization.ts:191`, the interactive tool a GDPR erasure actually travels through. The try/catch is not defensive style: `cron.delete.ts:45-48` has no error handling (verified — `jobDelete()` contains no `try`), so an unguarded throw stops `deleteProjects` and `deleteOrganization` from ever running again on any deployment. **That is why `05` §7.4's opposite semantics are rejected**: gating `deleteProjects` on a successful purge means one unreachable gigapipe defers every project deletion on the deployment, and `05`'s per-project `try` does not help the `deleteOrganization` loop that follows. **`05`'s resumability is adopted, though** — its durable fingerprint set and `resumeJobId` are genuinely better than re-resolving, and are folded into `TelemetryErasure` (§4, §14). `06` §11.6's per-*profile* erasure becomes a `subject` argument on this one function rather than a second name |
| **S16** | **REVISED (R12).** `self-hosting/clickhouse/init-db.sh` is **not edited**. `clickhouse-user-config.xml` **is** edited, in P0, to add a `<profiles>` block bounding whatever user gigapipe connects as; the *dedicated* `op_gigapipe` user stays at `10` D16's P7 | add `CREATE DATABASE IF NOT EXISTS gigapipe` to `init-db.sh`; or the previous revision's "neither file is touched"; or `05` §7.5's full two-user bootstrap in P0 | `init-db.sh` is unchanged for the reason it always was: `/docker-entrypoint-initdb.d` scripts run **only on a fresh data directory**, so the edit reaches new installs and nobody else — exactly the population migration 22 already covers. The user-config half changed because three documents were arguing past each other about one artefact. `05` I10 verifies from source that gigapipe's reader builds its `clickhouse.Options` with `Settings: nil` (`reader/registry/registry.go:69`) while its *writer* sets `max_execution_time: 60` (`writer/chwrapper/factory.go`), so **every LogQL and PromQL read runs unbounded against the instance that also serves analytics**. `10` D16 correctly identifies that the *user* half needs a generated password in a gitignored file and defers it to P7 — but the *profile* half needs neither: a `<profiles>` block is static, carries no secret, and can be attached to the user gigapipe already connects as. Separating the resource cap (cheap, P0, tracked file) from the schema isolation (needs a password, P7, gitignored file) is what `10` D16 and `05` §7.5 were each half-arguing. §12 owns the block; for managed/BYO ClickHouse the equivalent is a `CREATE SETTINGS PROFILE`, which this document also owns |
| **S17** | Alert state gets three tables (`MetricAlertRuleRuntime`, `MetricAlertState`, `MetricAlertEvent`) as `07-alerting.md:488-608` specifies; this document adds only the enum, the JSON annotation and the migration shape | collapse to one table; or the older `TelemetryAlert` shape | The three have different lifetimes and different cascade rules (`MetricAlertEvent` deliberately has no FK to the rule so history outlives a deleted rule). `07-alerting.md` is the only document that specifies them in full, so its names win. This closes the draft's Q2 |
| **S18** | **One module owns every gigapipe table name**: `packages/db/src/clickhouse/telemetry-client.ts` exports `TELEMETRY_TABLES` (**unqualified** base names), `telemetryTable(key, mode)`, `TELEMETRY_DELETE_TARGETS` and `TELEMETRY_IN`. Nothing else qualifies a gigapipe table (R2, §11.1) | `04` D12's `TELEMETRY_DB`/`TELEMETRY_TABLES`/`G()` in `packages/db/src/clickhouse/client.ts`; `05` §7.2's `packages/db/src/gigapipe/table-name.ts`; `06` §5's second `TELEMETRY_TABLES` with pre-qualified values plus `getTelemetryMutationTable()` | Four helpers existed in four files reading four env vars, and **two of them exported the identical symbol `TELEMETRY_TABLES` with different member names *and* different value semantics** — `04`'s values are unqualified (`samples: 'samples_v3'`), `06`'s are pre-qualified (`traces: 'gigapipe.tempo_traces_dist'`). A caller importing the wrong one double-qualifies or under-qualifies, silently. This file wins the merge on mechanics, not seniority: it is the only one that is lazy, memoised and pins a single node, which the DDL, the TTL re-assert and the mutation poll all require (S10, S11). `06`'s `getTelemetryMutationTable()` and `TELEMETRY_IN` are **adopted** — the local/`_dist` split and `GLOBAL IN` are correct and this document did not have them — as the `mode` argument and a separate export. Values stay unqualified so qualification is the helper's job |
| **S19** | `getReplicatedTableName` (`packages/db/src/clickhouse/client.ts:100-107`) is **never** applied to a gigapipe table, and a CI grep asserts that no emitted gigapipe statement contains the substring `_replicated` (R3) | `11-testing-strategy.md` I14 and gate 1.9, which currently *require* `deleteTelemetryFromClickhouse` to route through it | Verified in the repo: that function returns `` `${tableName}_replicated ON CLUSTER '{cluster}'` `` — an **OpenPanel** naming convention. gigapipe has no `_replicated` variant: its clustered layout is a plain-named local `ReplicatedMergeTree` plus a `_dist` `Distributed` companion (`ctrl/qryn/sql/log_dist.sql`). Following `11` literally emits `ALTER TABLE gigapipe.samples_v3_replicated …`, which does not exist — on Cloud, which is where the paying customers are. `05` §7.2 and `06` §5 both say so and both are right; `11` is repeating a stale draft and must be rewritten. §10 already declined `modifyTTL()` for the same reason |
| **S20** | **`TelemetryUsageDaily` takes `10-ops-retention-billing.md` §8.3's field list verbatim** and is keyed `@@unique([organizationId, projectId, day])`. `05-logs.md` §4.6's `TelemetryUsage` (hourly, `signal`/`granularity` enums) is deleted (R4) | this document's earlier four-counter shape on `(projectId, day)`; or `05`'s hourly grain; or three models | Three incompatible metering models existed, and `10` §8.3's rollup code — the only *code* anyone has written for this — does not compile against any of the other two. `10` owns metering semantics, so its fields win: it needs both `metricSamples` (emitted storage rows, the billed unit) and `metricDatapoints` (accepted data points, the diagnostic), which is D11's fan-out argument and is not expressible in a single counter. The key is `(organizationId, projectId, day)` because that is the compound `10`'s `upsert` already names (`organizationId_projectId_day`); `organizationId` is denormalisation, not a finer grain, since a project belongs to one organization. `05`'s hourly grain is a third design nothing consumes, and its `signal` enum re-models as columns what the other two model as columns |
| **S21** | The **delete-target table list is an exported constant**, `TELEMETRY_DELETE_TARGETS`, with **seven** members; `tempo_traces_kv` is deliberately not among them, and `patterns` is (R6) | each document enumerating its own list | Four documents enumerate four different lists: `02` §17 (seven, no `patterns`), `05` §7.4 (five, logs only), this document's previous §14 (seven, with `patterns`, no `_kv`), `11` I13 (**eight**, including `tempo_traces_kv`). `11`'s gate 1.9 therefore fails by construction, because `06` §11.6 and this document independently establish that `tempo_traces_kv` is a shared value dictionary — `val_id` is `cityHash64(val) % 10000` (`ctrl/qryn/sql/traces.sql:49`) — whose rows belong to no project. `11` I14 already asks for exactly one exported constant; this is it, and it is the same constant the retention sweep and the T2 teardown import |

---

## Design

### 0. Inventory

#### Postgres — `packages/db/prisma/schema.prisma`

Phases below are **master phases only** (P0 stack, P1 ingest, P2 metrics, P3 logs, P4 traces,
P5 alerts, P6 polish). `10-ops-retention-billing.md` uses its own internal P0–P8 vocabulary in
which P3 is the Polar catalogue and P7 is the scoped ClickHouse user; that vocabulary appears
nowhere in this document (R13), and neither does `07-alerting.md`'s habit of writing "P4" when
it means *document* 04.

| # | Change | Phase | Backfill? |
|---|---|---|---|
| P1 | `enum ClientType` gains `telemetry` | P1 ingest | No |
| P1b | `CHECK (type <> 'telemetry' OR "projectId" IS NOT NULL)` on `clients` (S4) | P1 ingest | No — no row can violate it |
| P2 | `model ProjectIdTombstone` (new) + the `getId` guard + the `deleteProjects` write (§2b) | **P0** | **Yes** — one `INSERT … SELECT` from `projects` |
| P3 | `Organization` gains **5** telemetry billing columns | P2 metrics | Yes — one `UPDATE` to seed trial limits (§4) |
| P4 | `model TelemetryUsageDaily` (new), `10` §8.3's field list (S20) | P2 metrics | No |
| P5 | `model TelemetrySchemaState` (new) | P0 | No — one row upserted lazily by the retention cron |
| P6 | `model TelemetryErasure` (new), resumable (S15) | **P1** | No |
| P7 | `enum MetricAlertStateKind { pending firing resolved }` (new) | P5 alerts | No |
| P8 | `model MetricAlertRuleRuntime`, `MetricAlertState`, `MetricAlertEvent` (new) | P5 alerts | No |
| P9 | `Project` gains `telemetryLabelKeys Json @default("[]")` and `telemetryLogsBlockedAt DateTime?` (`05` §3.6) | P3 logs | No |
| P10 | Back-relations on `Project`, `Organization`, `NotificationRule` | P1/P2/P5 | No |

**Cut, and recorded so the cut is a decision rather than an omission:**

| Cut | Was | Why |
|---|---|---|
| `enum DataSource` + `Report.dataSource` | P2 metrics, its own migration file | S1/R1 — derived by `getReportDataSource(series)`, `03` §15.1 |
| `Organization.telemetryRetentionTier`, `…TierSince` | P2 metering | R11 — `10` D9 is "one window per signal for everyone" in v1 and `10` §6.3's tier table is explicitly deferred. A column no code writes is the same mistake as `Report.dataSource`. They land with the tiering trigger, in `10` §6.3's own migration |
| `Project.telemetryLogRetention` (`05` §3.6) | P3 logs | R11 — same reason. `05` should cut it rather than have it silently absent here. Per-project retention is only expressible as `10` §6.3's sweep, which is deferred |
| `model TelemetryUsage` + `enum TelemetrySignal` + `enum TelemetryGranularity` (`05` §4.6) | P3 logs | S20/R4 — the logs stream writes into `TelemetryUsageDaily` |
| `model TelemetryPurgeJob` + `enum TelemetryPurgeReason` + `enum TelemetryPurgeState` (`05` §3.6) | P3 logs | S15/R5 — its resumability is folded into `TelemetryErasure` (§4) |

Twelve changes, **seven** Prisma migration files:

1. `<ts>_project_id_tombstone` — P2 + the backfill (P0; `01` D5)
2. `<ts>_telemetry_schema_state` — P5 (P0)
3. `<ts>_add_telemetry_to_client_type` — P1 alone (Constraint B, §1)
4. `<ts>_telemetry_client_requires_project` — P1b, must be a *later* file than 3 (Constraint B)
5. `<ts>_telemetry_erasure` — P6 + P10-part (P1, with the deletion sweep — see the Sequencing note)
6. `<ts>_telemetry_metering` — P3 + P4 + P10-part, plus the trial-limit backfill
7. `<ts>_project_telemetry_config` — P9
8. `<ts>_metric_alerts` — P7 + P8 + P10-part

(Eight files, of which 5 and 6 could be one if `TelemetryErasure` and the metering ledger ship
together; they do not, because the erasure sweep is a **P1 gate** on enabling telemetry for any
tenant — `02` §17 — and metering is P2. Seven is the count if they merge; the sequencing table
below assumes they do not.)

`<ts>` follows the repo's `YYYYMMDDHHMMSS` convention; the newest existing directory is
`20260828120000_organization_wind_down`.

#### ClickHouse

| # | Change | Database | Owner |
|---|---|---|---|
| C1 | `CREATE DATABASE IF NOT EXISTS gigapipe` | — | migration `22` |
| C2 | `gigapipe.samples_v3` pre-created with `type` in `PARTITION BY` | `gigapipe` | migration `22` |
| C3 | `gigapipe.metrics_15s` pre-created with `type` in `PARTITION BY` | `gigapipe` | migration `22` |
| C4 | ~30 other tables and MVs (`time_series`, `time_series_gin`, both MVs, `patterns`, the `tempo_*` family, the `profiles_*` family, `rules`, `ver`, `settings`) — **and every `_dist` companion**, including `samples_v3_dist` and `metrics_15s_dist` (`ctrl/qryn/sql/log_dist.sql:18-23`) | `gigapipe` | **gigapipe**, via its own `ver`-keyed replay |
| C5 | Conditional TTL on `samples_v3` / `metrics_15s`; flat TTL on 5 more; `patterns` and `profiles_*` explicitly decided (§13) | `gigapipe` | retention cron (`10-ops` §8.2) |
| C6 | Nothing at all | `openpanel` | — |

C2/C3 pre-create the **local** tables only, never their `_dist` companions — `05` §7.1 is
right about that and this document adopts it: gigapipe creates every `Distributed` companion
itself with `IF NOT EXISTS`, the sharding keys differ per table (`fingerprint` for samples,
`rand()` for `time_series_gin`), and pre-creating them would make us own byte-compatibility
with upstream across every image bump for no gain. Only the local table carries the partition
and sort key that matter. Where `05` §7.1 and this document **do** differ — `05` pre-creates
`samples_v3` alone, with `PARTITION BY (toStartOfDay(…), type)`; this document pre-creates
`samples_v3` **and** `metrics_15s`, with `PARTITION BY (type, toStartOfDay(…))` — this
document's DDL wins (R-note in §10), for the reason §9 gives: `metrics_15s_mv` rolls up log
rows too, so `metrics_15s` needs the same signal-homogeneous partitioning or per-signal
retention on the rollup table is permanently impossible, and getting its sorting key wrong
makes `ctrl.Init` panic.

C6 is deliberate: there is **no new table in the `openpanel` database**. The daily usage
rollup is `TelemetryUsageDaily` in Postgres, not a ClickHouse table, because it is one row
per project per day — a few thousand rows a day at most — and it must join to
`Organization` for billing.

#### Non-migration code that must change with the schema

| File | Why |
|---|---|
| `packages/db/src/types.ts` | 1 new `PrismaJson.*` declaration (§7) |
| `packages/db/src/clickhouse/telemetry-client.ts` | new (§11) |
| `packages/db/index.ts` | export the new client module — safe only because it is lazy (S11) |
| `packages/db/src/clickhouse/client.ts` | nothing — `TABLE_NAMES` gains **no** telemetry entry (S11/S18: mixing them is the failure mode), and `04` D12's `TELEMETRY_DB`/`TELEMETRY_TABLES`/`G()` do **not** land here |
| `packages/db/src/services/delete.service.ts` | `deleteTelemetryFromClickhouse` + the guarded call inside `deleteFromClickhouse` (§14) **and** the `ProjectIdTombstone` write inside `deleteProjects` (§2b) |
| `packages/db/src/services/id.service.ts:19-23` | `getId` consults `ProjectIdTombstone` before returning a slug (`01` D5, §2b). **On the project-creation hot path** |
| `packages/db/src/services/reports.service.ts:56-81` (`transformReportEventItem`), `:154-178` (`listReportsCore`) | two hand-written read projections must gain a `metric` arm (§3). The three `report.ts` write literals and the three MCP write surfaces need **no change** once the column is cut — `events: report.series` passes the array whole (`03` §15.1) |
| `packages/mcp/src/tools/dashboard-management.ts:15-19` (`reportSchema`, `.strict()`) | **verify, do not edit.** `zReport = zReportInput.extend({…})`, so widening the series union makes `type:'metric'` immediately expressible through `create_report` and `update_report`. `09` D8 is right that MCP fails *open*, not closed — the fix is a rejection or an explicit accept, not a `dataSource` write |
| `apps/api/src/utils/auth.ts:202`, `:237`; `packages/mcp/src/auth.ts:99` | deny-list → allow-list (S3) |
| `packages/trpc/src/routers/client.ts:58`; `apps/api/src/controllers/manage.controller.ts:37` | the two client-**minting** surfaces; both are `z.enum(['read','write','root'])` and must be widened deliberately, with the S4 refine |
| `self-hosting/clickhouse/clickhouse-user-config.xml` | the `<profiles>` block bounding gigapipe's reads (S16, revised; §12). **P0** |
| `apps/public/content/docs/self-hosting/environment-variables.mdx` | `GIGAPIPE_DB`, `CLICKHOUSE_TELEMETRY_URL`, and the BYO-ClickHouse grant requirement (§12) |

Six of those are field whitelists or literal enums that the compiler does **not** check:
they build object literals, so a missing key is a missing value, never a type error. That
is the single largest source of silent breakage in this work-stream — and cutting
`Report.dataSource` (R1) removed three of them outright, because a derived discriminator has
no write path to forget.

---

### 1. The two Postgres enum rules, and which of our changes each binds

Both are already written down in this repo and they are frequently confused.

**Constraint A — ordering, for `prisma migrate` drift.**
`packages/db/prisma/schema.prisma:415-422`:

```prisma
enum Metric {
  sum
  average
  min
  max
  // Appended last to match what `ALTER TYPE ... ADD VALUE` does in the DB,
  // so `prisma migrate` reports no drift.
  count
}
```

`ALTER TYPE … ADD VALUE 'x'` without `BEFORE`/`AFTER` appends `x` to the end of the
Postgres enum's sort order. `prisma migrate dev` diffs the *ordered* member list between
the schema file and the database. Insert `telemetry` between `write` and `root` in the
`.prisma` file and the next developer running `pnpm migrate` is offered a destructive
"drift detected" reset. **The new member goes last, with a comment saying why.**

**Constraint B — transactions, for `migrate deploy`.**
`packages/db/prisma/migrations/20260818090000_add_count_to_metric_enum/migration.sql`:

```sql
-- This must be its own migration: Postgres refuses to use a new enum value in
-- the same transaction that added it ("unsafe use of new value ... of enum
-- type Metric"). The backfill lives in the next migration.
ALTER TYPE "Metric" ADD VALUE 'count';
```

and the *next* directory, `20260818090100_backfill_metric_reports_to_count/`, contains the
`UPDATE`. Prisma runs each migration file in its own transaction; PostgreSQL (12+; we run
`postgres:14-alpine`, `docker-compose.template.yml:26`) permits `ADD VALUE` inside a
transaction but forbids *using* the value until that transaction commits. Anything that
reads or writes the new label — a backfill `UPDATE`, a `DEFAULT 'telemetry'`, or a
`CHECK` that names it — must live in a later file.

**What that means per change:**

| Change | Constraint A | Constraint B | Files |
|---|---|---|---|
| `ClientType += telemetry` | yes — append last | yes | 1 for the `ADD VALUE`; the S4 `CHECK` names the label, so it is a **second** file |
| ~~`DataSource { events metrics }`~~ | — | — | **cut (R1)** — there is no enum |
| `MetricAlertStateKind` | no | no | one file with the three `CREATE TABLE`s |

Stating the distinction explicitly matters because the reflex after reading the `Metric`
comment is to split *every* enum change into two files, which for a brand-new type is
pure ceremony.

---

### 2. P1 — `ClientType += telemetry`

#### Declaration

`packages/db/prisma/schema.prisma:353-357` becomes:

```prisma
enum ClientType {
  read
  write
  root
  // Appended last to match what `ALTER TYPE ... ADD VALUE` does in the DB,
  // so `prisma migrate` reports no drift. See `Metric` below.
  //
  // A telemetry client authenticates OTLP / Prometheus-remote-write / Loki-push
  // ingest at apps/api and NOTHING else. It is deliberately not a superset of
  // `write`: it must never reach /track, /export, /insights, /import or MCP.
  // Invariant: a telemetry client always has a non-null projectId -- see the
  // CHECK constraint in <ts>_telemetry_client_requires_project.
  telemetry
}
```

#### Migration 1 of 2 — the value

`packages/db/prisma/migrations/<ts>_add_telemetry_to_client_type/migration.sql`:

```sql
-- Telemetry ingest tokens. A new ClientType, not a reuse of `write`, because
-- op_project_id -- the entire tenancy boundary for metrics, logs and traces --
-- is taken from the authenticated client's projectId. `write` is authenticated
-- by validateSdkRequest (apps/api/src/utils/auth.ts:42), which returns a client
-- with NO secret verification on two paths: client.ignoreCorsAndSecret (:133-135)
-- and an Origin match against project.cors (:137-161, including '*'). Client ids
-- ship in web SDK bundles and Origin is settable from curl. That is acceptable
-- for analytics ingest and unusable as the source of truth for a tenancy label.
--
-- Its own migration: Postgres refuses to USE a new enum value in the same
-- transaction that added it. The CHECK constraint that names 'telemetry' is
-- therefore the next migration, not this one.
--
-- THIS STATEMENT IS A PRIVILEGE GRANT. Three validators are deny-lists on
-- `write` (apps/api/src/utils/auth.ts:202 guards BOTH /export and /insights;
-- :237 import; packages/mcp/src/auth.ts:99), so the moment this value exists an
-- unmodified telemetry client is accepted by /export, /insights, /import and
-- MCP. The allow-list conversions ship in the same PR as this migration.
ALTER TYPE "ClientType" ADD VALUE 'telemetry';
```

#### Migration 2 of 2 — the invariant (S4)

`packages/db/prisma/migrations/<ts>_telemetry_client_requires_project/migration.sql`:

```sql
-- op_project_id is taken from clients."projectId". Client."projectId" is
-- nullable (schema.prisma:364) and apps/api/src/controllers/manage.controller.ts:320
-- writes `projectId: projectId || null`, so a telemetry client with no project
-- is representable today. It must not be: the ingest gateway would have no
-- tenancy label to stamp.
--
-- Separate file from the ALTER TYPE above: Postgres cannot reference a new enum
-- label in the transaction that created it.
--
-- Prisma cannot express a CHECK, so `prisma migrate dev` will report this as
-- drift. That is the same tradeoff the repo already accepts for hand-written
-- partial indexes; the constraint is worth it because the alternative is a
-- runtime invariant with no enforcement point.
ALTER TABLE "clients"
  ADD CONSTRAINT "clients_telemetry_requires_project"
  CHECK ("type" <> 'telemetry' OR "projectId" IS NOT NULL);
```

#### Backfill

None. `Client.type` is `@default(write)` (`schema.prisma:363`) and no existing row can be
`telemetry`, so the `CHECK` validates instantly against every row.

#### The six surfaces that must flip in the same PR

**Four consumers**, deny-list → allow-list, so the *next* enum value fails closed:

```ts
// apps/api/src/utils/auth.ts:202 -- guards BOTH /export and /insights, because
// apps/api/src/routes/insights.router.ts:50 calls validateExportRequest in its
// own inline preHandler. The fix must live inside validateExportRequest; there
// is no shared hook to patch.
if (client.type !== ClientType.read && client.type !== ClientType.root) {
  throw new Error('Export: Client is not allowed to export');
}
```

Same shape at `auth.ts:237` (import) and `packages/mcp/src/auth.ts:99`.

**Two minters**, both currently `z.enum(['read', 'write', 'root'])` — already fail-closed,
which is the desired shape, and must be widened deliberately rather than by accident:

```ts
// packages/trpc/src/routers/client.ts:58
type: z.enum(['read', 'write', 'root', 'telemetry']).optional(),
// ... and in the mutation body, since Client.projectId is nullable:
//   if (input.type === 'telemetry' && !input.projectId) throw ...
```

```ts
// apps/api/src/controllers/manage.controller.ts:34-38
export const zCreateClient = z
  .object({
    name: z.string().min(1),
    projectId: z.string().optional(),
    type: z.enum(['read', 'write', 'root', 'telemetry']).optional().default('write'),
  })
  .refine((v) => v.type !== 'telemetry' || !!v.projectId, {
    message: 'A telemetry client requires a projectId',
    path: ['projectId'],
  });
```

Without these two, P1's phase gate is satisfiable while the feature is unreachable: an
enum value no dashboard user and no Manage-API caller can produce.

#### Two things that are *not* changed, recorded so they are decisions

- `validateManageRequest` (`auth.ts:272`) is already `if (client.type !== ClientType.root)`
  — a true allow-list, needs nothing.
- `apps/api/src/controllers/export.controller.ts:26-33` is **not** an allow-list, contrary
  to the draft. It is a deny-list keyed on `read`:
  `request.client?.type === ClientType.read && request.client?.projectId !== projectId`
  → 403. Any type that is not `read` — including `telemetry` — skips the per-project scope
  check and is bounded only by `organizationId`. In the end state this is unreachable
  because `validateExportRequest` rejects `telemetry` in the preHandler first, so it is
  **intentionally left as a second-layer deny-list**; it is listed here because the spec
  elsewhere leans on "the next enum value fails closed" and this line does not.
- `validateSdkRequest` (`auth.ts:42`) never reads `client.type` at all, so `/track` accepts
  a telemetry client today and will keep doing so. Adding a type check there is a
  **behaviour change for existing customers** who ingest with a `read` client. The public
  docs already claim `/track` "requires a `write` or `root` client"
  (`apps/public/content/docs/api/track.mdx:13`) — a statement the code does not enforce.
  Out of scope; recorded so it is a decision and not an oversight.

#### Rollback

`ALTER TYPE … DROP VALUE` does not exist in PostgreSQL. Rolling back the *enum* means
recreating the type:

```sql
-- Only safe while no row holds the value.
BEGIN;
ALTER TABLE "clients" DROP CONSTRAINT "clients_telemetry_requires_project";
ALTER TABLE "clients" ALTER COLUMN "type" DROP DEFAULT;
ALTER TYPE "ClientType" RENAME TO "ClientType_old";
CREATE TYPE "ClientType" AS ENUM ('read', 'write', 'root');
ALTER TABLE "clients"
  ALTER COLUMN "type" TYPE "ClientType" USING "type"::text::"ClientType";
ALTER TABLE "clients" ALTER COLUMN "type" SET DEFAULT 'write';
DROP TYPE "ClientType_old";
COMMIT;
```

The `USING` cast raises `invalid input value for enum` on the first surviving telemetry
row, which is the correct failure. **Practical rollback is not this.** It is: revoke the
tokens (`db.client.deleteMany({ where: { type: 'telemetry' } })`, then
`getClientByIdCached.clear(id)` per row) and leave the enum member in place, unused.

**Revocation SLA, stated because it is the security-relevant number.**
`getClientByIdCached = cacheable(getClientById, 60 * 5)`
(`packages/db/src/services/clients.service.ts:37`). `cachedFn.clear` deletes the local LRU
entry and the Redis key (`packages/redis/cachable.ts:275-279`), but other API replicas keep
serving from their own L1 LRU for up to `CACHEABLE_LRU_TTL_MS`, which is 60 s
(`cachable.ts:156`, consumed at `:232-237`, and the file's own comment says so). So a
revoked telemetry token is honoured by other nodes for **up to 60 seconds**, not 5 minutes.

---

### 2b. P0 — `ProjectIdTombstone`, and the `getId` guard

**New in this revision (R10).** `01-tenancy-and-security.md` D5 designs this and calls the
tombstone "the boundary" for its failure mode F8; §Scope of the previous revision of this
document claimed to own "every Prisma enum, model and field addition" and then did not list it.
Two reviewers flagged the same gap independently. This document owns Prisma, so it owns this.

**The hazard, re-verified against the repo rather than taken on trust:**

1. `project.delete` only sets `deleteAt` (`packages/trpc/src/routers/project.ts:207-231`).
2. `cron.delete` hard-deletes the row through `deleteProjects`
   (`apps/worker/src/jobs/cron.delete.ts:47` → `packages/db/src/services/delete.service.ts:15-37`).
3. `getId` collides only against **live** rows (`id.service.ts:19-23` — verified: one
   `findUnique` on `{ id: newId }`, and a `random(name)` retry on a hit), so once the row is
   gone the slug is free again, **including to a different organisation**.
4. Nothing removes the ClickHouse telemetry under that `op_project_id`.

So "Acme Prod" is deleted, someone else creates a project called "Acme Prod", is issued
`id = 'acme-prod'`, and inherits the deleted project's metrics, logs and traces. An
organisation with no `org:admin` member is hard-deleted with **no `deleteAt` grace at all**
(`cron.delete.ts:17-19`), so the window can be zero.

**Why §14's purge cannot be the boundary**, which is the reason this belongs in Postgres and
not in the deletion sweep: `deleteFromClickhouse` runs with `lightweight_deletes_sync: '0'`
(verified, `delete.service.ts:68`) and `ALTER … DELETE` is asynchronous, so "the rows are
gone" is not true at the moment `deleteProjects` returns. A synchronous Postgres row is the
only control that closes the window at the instant the id becomes reusable. The purge is the
data-protection and cost control; the tombstone is the tenancy boundary. Both are required and
they close different things.

```prisma
/// A project id that has been used and must never be issued again.
/// op_project_id is the telemetry tenancy label; reissuing a slug before (or
/// after) the telemetry purge has completed is a cross-tenant read.
/// See docs/observability/01-tenancy-and-security.md D5.
model ProjectIdTombstone {
  id             String   @id
  organizationId String?
  deletedAt      DateTime @default(now())

  @@map("project_id_tombstones")
}
```

`packages/db/prisma/migrations/<ts>_project_id_tombstone/migration.sql`:

```sql
-- Project ids are slugs (getId -> slug(name)), not UUIDs: the schema default
-- gen_random_uuid() on projects.id (schema.prisma:257) is dead, because every
-- creation path supplies an explicit id. So a deleted project's id is reusable,
-- and it is also the telemetry tenancy label. See 01-tenancy-and-security.md D5.
CREATE TABLE "project_id_tombstones" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "project_id_tombstones_pkey" PRIMARY KEY ("id")
);

-- Backfill every LIVE project too, so a rename can never free an id that is
-- still in use somewhere. ON CONFLICT because the table is keyed on the id.
INSERT INTO "project_id_tombstones" ("id", "organizationId")
SELECT "id", "organizationId" FROM "projects"
ON CONFLICT DO NOTHING;
```

**Two implementation details the design document could not know, because they are in the
code this document owns:**

- **`deleteProjects` is not a transaction.** `delete.service.ts:15-37` is a `findMany`
  followed by a **loop** of `db.project.delete({ where: { id } })` — there is no
  `db.$transaction` anywhere in it (verified). `01` §3.3 says the tombstone is written "inside
  the same transaction as the `project.delete`"; as written there is no such transaction. The
  correction: write the tombstone **before** each `project.delete`, inside the loop, so a
  crash mid-loop leaves a tombstone for a project that still exists — which is harmless
  (the backfill already tombstones live projects) — rather than a deleted project with a free
  id, which is the failure. Wrapping the loop in `$transaction` is the alternative and is a
  behaviour change to a function that today tolerates partial progress; do not make it
  silently.
- **`getId` is on the project-creation hot path** and is shared with `dashboard` and
  `organization` (`id.service.ts:5-7`). The tombstone lookup must be **project-only**:

  ```ts
  // packages/db/src/services/id.service.ts
  if (tableName === 'project') {
    const tombstoned = await db.projectIdTombstone.findUnique({ where: { id: newId } });
    if (tombstoned) return getId(tableName, random(name));
  }
  ```

  One indexed primary-key lookup, on a path that already does one `findUnique`. Dashboards and
  organizations are unaffected because neither is a telemetry tenancy label.

**Rollback:** `DROP TABLE "project_id_tombstones";` — but revert `id.service.ts` first, or
`getId` throws `PrismaClientKnownRequestError` on every project creation. Fully reversible;
the cost of rolling back is that ids become reusable again.

**The P0 audit `01` Q1 leaves ownerless** —
`SELECT id, name FROM projects WHERE id !~ '^[a-zA-Z0-9_-]{1,100}$';` — is requested of
`10-ops-retention-billing.md`'s P0 gate list in Interfaces below. It is an audit of live data,
not a schema change, which is why it is not here.

---

### 3. P2 — the metric series union member (there is **no** `dataSource` column)

#### There is no declaration — that is the decision

`03-metrics-engine.md` §15.1 rejects the column and this document concedes (S1/R1). The
previous revision of this section specified `enum DataSource { events metrics }`, a
`Report.dataSource DataSource @default(events)` column, a `<ts>_report_data_source` migration
and three write-literal edits. **All of it is cut.** `09-ui-surfaces.md` D8 and
`04-read-path.md` D4 are written against the column and must be rewritten; the deltas are in
Interfaces.

The argument that settled it, restated so nobody re-opens it:

- The discriminator **reaches the server from the browser on every execution path anyway**.
  `ctx.report` is `null` on every non-shared chart query (`packages/trpc/src/routers/chart.ts`),
  so `zReportInput.series` is the only carrier that exists at execution time. The previous
  revision's own justification for the column — "the discriminator has to arrive from the
  browser regardless" — is an argument *against* it.
- With the series carrying `type: 'metric'`, the column is derivable, and a derived value
  cannot be forgotten by a write path. Dispatch is one helper,
  `getReportDataSource(series)` in `packages/db/src/engine/data-source.ts` (`03` §15.1):

  ```ts
  export const getReportDataSource = (series: IChartEventItem[]) =>
    series.some((s) => s.type === 'metric') ? 'metrics' : 'events';
  ```

- The column's only unique capability is a cheap filter, and **no query filters reports by
  data source**. `Report` is read by `dashboardId` (`getReportsByDashboardId`,
  `reports.service.ts:118-129`) or by primary key; `listReportsCore` filters only by
  `dashboardId` and re-projects in JS. The previous revision's own "Index? **No.**" subsection
  said exactly this and did not draw the conclusion.
- The costs are real and irreversible in one direction: `CREATE TYPE` plus a column is a
  migration that `DROP TYPE` only reverses while no row holds `'metrics'`, and it adds three
  hand-written `data: {}` literals in `report.ts` plus three MCP write surfaces to an inventory
  that is already the largest silent-breakage surface in this work-stream.

`Report.events` (the series column) carries the metric definition as a third member of
`zChartEventItem` — no new column (S2). `Report.events` is untyped `Json`
(`schema.prisma:433`) and stays that way; §7 explains why annotating it now would be a
regression. **`Report.options` stays untouched too**: it is keyed on chart type, and a metric
report still needs `options.type === 'histogram'` for a stacked histogram.

#### The whitelists the union member must cross — the inventory, retargeted

The previous revision listed nine sites a `dataSource` column would have to cross. That
inventory was correct and is the most valuable thing in this section; only its subject was
wrong. Retargeted at the union member, the list **shrinks to two mandatory edits and four
verifications**, because a value that is derived has no write path:

| # | Site | What changes | Caught by `tsc`? |
|---|---|---|---|
| 1 | `packages/db/src/services/reports.service.ts:56-81` — `transformReportEventItem` | **Mandatory, and it ships first.** A `metric` arm before the event fallthrough: `if (item.type === 'metric') return { ...item, id: item.id ?? alphabetIds[index]! };` | **Yes.** Verified in the repo: after the `formula` early-return the function reads `item.segment`, `item.filters`, `item.name` and `item.property` unconditionally (`:70-78`), none of which exists on the metric member, so both lines fail to compile. This corrects the previous revision's F4, which claimed detection "none" |
| 2 | `packages/db/src/services/reports.service.ts:154-178` — `listReportsCore` | **Mandatory.** A `metric` arm in the `s.type === 'formula' ? … : …` ternary (`:171-175`), else a metric series is listed to MCP and to the agent as an event with `name: undefined` | **Partly.** The else branch narrows to `event \| metric` and reads `s.name`/`s.segment`, so it errors — but the surrounding literal is untyped, so a *wrong* arm that returns `{type:'event', …}` compiles fine. `tsc` tells you to look; it does not tell you what to write |
| 3 | `packages/validation/src/index.ts:233` — `zReportInput` | **Verify only.** `series` is already `zChartSeries`; widening `zChartEventItem` reaches it. Note the cache-key hazard survives the cut: `cacheMiddleware` stringifies `getRawInput()` (`packages/trpc/src/trpc.ts:202-209`), the **pre-validation** payload, so an unknown key changes the Redis key while zod strips it — the symptom is "extra cache misses, identical results" | No |
| 4 | `packages/trpc/src/routers/report.ts:54-75`, `:97-119`, `:225-245` | **No change** — all three write `events: report.series`, passing the array whole (`03` §15.1) | n/a |
| 5 | `packages/db/src/services/reports.service.ts:83-115` — `transformReport` | **No change** — `series` is mapped through `transformReportEventItem` (site 1). Still provably lossy for other fields (`criteria`, `funnelGroup`, `funnelWindow`, `createdAt`, `updatedAt`), which is a pre-existing bug this plan does not fix |
| 6 | `packages/mcp/src/tools/dashboard-management.ts:130-149` (`reportData`), `:488-500` (`duplicate_report`) | **No change to the literals.** Both pass `series` through | n/a |
| 7 | `packages/mcp/src/tools/dashboard-management.ts:15-19` — `reportSchema` | **Verify, and decide.** `.strict()` guards the *outer* object only; `series` flows through `zChartSeries → zChartEventItem`, so widening the union makes `type: 'metric'` **immediately expressible** through `create_report` and `update_report`. `09` D8 is right that MCP fails **open**. The decision is `03`'s and `09`'s: accept metric series in MCP, or reject them with a named error. Either is fine; silence is not | No |

`09-ui-surfaces.md` D8's eight-row table is the same inventory with the same error, and needs
the same retargeting: "the union member must survive the eight projections", which is a
smaller and different change from "eight paths must learn to write a column".

#### Which list of executor dispatch sites is authoritative

Three documents count differently — `09` D6 names four, `03` §15.3 names seven, and the
previous revision of this section named nine. They are counting **different things**: `03` is
counting `ChartEngine.execute` / `AggregateChartEngine.execute` call sites (the *executor*),
this section is counting persistence projections and write literals (the *whitelists*). Both
lists are real and neither subsumes the other.

**`03` §15.3 is authoritative for executor dispatch** — it is the most complete, it is the
only one that verified site 7 (`export.controller.ts:201`, which is a **no-op**: the route
validates against `chartSchemeFull`, whose series shape has no `type` key, so a metric series
is not expressible there at any input), and it owns `executeReport`. This section is
authoritative for the persistence whitelists above. Neither should be re-derived in a third
place; `09` D6 should cite `03` §15.3 rather than carry a fourth count.

#### Deploy ordering

`03` §15.2's two-release sequence applies unchanged and is **not** made cheaper by cutting the
column, which is worth stating because the cut removes a migration and might read as removing
the hazard. It does not: `Report.events` is unversioned and `transformReportEventItem` is
lossy, so an old pod serving `report.get` rewrites a metric item to
`{type:'event', name:'unknown_event'}`, the user saves, and `report.update` persists the
mangled series. Ship site 1 and site 2 (pure pass-throughs, no behaviour change for any
existing report) in release N, soak until every pod that can serve `report.get` carries them,
then ship the union member in N+1 behind a flag. That ordering is the same under both designs;
only the rollback differs, and it is simpler here because there is no column and no type to
drop.

#### Rollback

There is no schema to roll back. Rolling back the **code** means reverting the union member
and the two projection arms, at which point any stored `type: 'metric'` series degrades to an
`unknown_event` event series on the next read — not to an error. So the honest rollback is
still two-step: export or delete reports whose `events` contain a metric item, *then* revert.
`03` §15.2 step 4 states the same thing and is the owner of the runbook line.


---

### 4. P1 (erasure ledger) and P2 (metering) — the two operational tables

**Heading corrected (R13).** The previous revision filed this section under "P4/P5/P7", which
is `10-ops-retention-billing.md`'s internal phase vocabulary (where P4 is email templates and
P7 is the scoped ClickHouse user) and contradicted this document's own Sequencing table two
sections from the bottom. Master phases only, and the two tables in this section are **not in
the same phase**:

- **`TelemetryErasure` is P1**, with `deleteTelemetryFromClickhouse` (R5). `02-ingest-gateway.md`
  §17 makes the deletion sweep the literal precondition on enabling telemetry for any tenant —
  "the sweep must exist and pass a test before `TELEMETRY_ENABLED` is turned on" — and
  `11-testing-strategy.md` makes it gate **1.9**, a P1 gate. A ledger that ships after the
  thing it is the retry ledger *for* is not a ledger.
- **`TelemetryUsageDaily` and the `Organization` columns are P2.**

Metering semantics are `10-ops-retention-billing.md` §8 and §10, and **its field list is
normative** (S20/R4). This section owns the declarations, the types, one arithmetic hazard,
and two conventions that must not be inverted.

#### `Organization`

Appended after the existing `usageWarningSentAt` / `usageExceededSentAt` pair
(`schema.prisma:117-120`), so the telemetry columns sit beside the events columns they
mirror:

```prisma
  // Telemetry metering. Mirrors the subscriptionPeriodEvents* trio above,
  // INCLUDING its conventions -- see the two comments below, both of which
  // encode a trap the events path already hit.
  //
  // Saturating Int, not BigInt. subscriptionPeriodEventsCount is written through
  // Math.min(count, INT4_MAX) at apps/worker/src/jobs/sessions.ts:76-79, and the
  // reason clamping is SAFE there is not the reason given at :56-59 (that comment
  // is attached to project.eventsCount and says it is "never used for billing").
  // The org counter IS used for billing, and it is safe only because the limit
  // comparison at :82-88 uses the UNCLAMPED `organizationEventsCount`, never the
  // stored column. The telemetry shedding check must obey the same invariant:
  //   compare the live value, store the clamped one.
  subscriptionPeriodTelemetryUnits           Int       @default(0)
  // ZERO ALLOWANCE, not unlimited. This matches subscriptionPeriodEventsLimit
  // (schema.prisma:102) exactly, and the repo already documents the consequence:
  // packages/trpc/src/routers/onboarding.ts:21-24 -- "the limit defaults to 0,
  // which trips on the first event" -- and works around it by seeding
  // TRIAL_EVENTS_LIMIT = 10_000_000 at org creation. The telemetry equivalent is
  // seeded the same way (see the backfill in this migration and the createOrganization
  // change in 10-ops-retention-billing.md), NOT by special-casing 0 here. Two
  // sibling columns on one model where 0 means opposite things is the inversion
  // any shared shedding helper gets wrong.
  subscriptionPeriodTelemetryLimit           Int       @default(0)
  subscriptionPeriodTelemetryUnitsExceededAt DateTime?
  telemetryUsageWarningSentAt                DateTime?
  telemetryUsageExceededSentAt               DateTime?
```

**Five columns, not seven (R11).** The previous revision also declared
`telemetryRetentionTier String?` and `telemetryRetentionTierSince DateTime?`. They are **cut**,
for the same reason `Report.dataSource` is cut: nothing writes them in any shipping phase.
`10-ops-retention-billing.md` D9 is explicit that "v1 retention is one window per signal, for
everyone", and §6.3's per-plan tier table is documentation with a named trigger, not a shipping
feature. When that trigger fires, the two columns land in `10` §6.3's own migration, where the
code that reads them lands too. Shipping them now would put a third unwritten column in a
billing table and would make `10` §6.3's eventual migration a *modification* rather than an
addition.

If they are reinstated, reinstate them as plain `String?`/`DateTime?`, not an enum: tiers are a
pricing artefact that changes on a marketing cadence, and every enum change here is a migration
plus §1's ordering rule. The precedent is `Organization.onboarding String?`
(`schema.prisma:86`) and `Organization.windDownStep String?` with
`/// [IPrismaWindDownStep]` (`schema.prisma:129-130`), both closed sets validated in
TypeScript rather than in Postgres. **`05-logs.md` §3.6's `Project.telemetryLogRetention` is
cut for the same reason** and should be removed there rather than silently omitted here —
per-project retention is only expressible as `10` §6.3's deferred sweep.

**Two operational notes that belong with the declaration, not with the cron:**

- **`SELF_HOSTED` bypass.** `apps/worker/src/jobs/sessions.ts:65-70` explicitly skips the
  events limit when `process.env.SELF_HOSTED === 'true'`, and *clears* stale exceeded flags
  "set before this guard existed". The telemetry counters get the **same** bypass, in the
  same shape, in the same PR. A self-hoster shedding telemetry because a default tripped is
  precisely the bug that guard was added to fix.
- **Cache window on deploy.** `Organization` is read through
  `getOrganizationByProjectIdCached = cacheable(getOrganizationByProjectId, 60 * 5)`
  (`packages/db/src/services/organization.service.ts:65-68`) plus the 60 s per-node LRU. For
  up to 5 minutes after the migration, cached payloads serialised before it lack the new
  fields: `org.subscriptionPeriodTelemetryLimit` reads `undefined` and `units > undefined`
  is `false`. That is fail-open, which is benign for shedding — but the same window applies
  to `telemetryRetentionTier`, where `undefined` silently means "plan default". **The
  the retention cron must read `Organization` uncached** (`db.organization.findMany`), never
  through `getOrganizationByProjectIdCached`. Handed to `10-ops` §8.4 as a requirement.
  (With the tier columns cut, the acute case is gone — but the rule still holds for the limit
  columns the shed hook reads, where `undefined > undefined` is `false` and fail-open.)
- The Polar new-cycle handler already resets the events counter and calls
  `clearOrganizationCache` (`apps/api/src/controllers/webhook.controller.ts:485-503`); the
  telemetry counter reset goes inside that **same `db.organization.update`**, not a second
  one, so the cache clear covers both.

#### `model TelemetryUsageDaily`

Placed after `model Import` in the file — the same kind of object, an operational ledger
keyed to a project.

**Field list and key revised (S20/R4).** Three incompatible models existed:
`05-logs.md` §4.6's hourly `TelemetryUsage` keyed `(projectId, signal, granularity, hour)`
with a `TelemetrySignal` enum; the previous revision of this section's four-counter daily row
keyed `(projectId, day)`; and the nine fields `10-ops-retention-billing.md` §8.3's rollup
**actually writes**, upserting on `organizationId_projectId_day`. Only one of the three has
code written against it. `10` owns metering semantics, so its fields and its key win, and this
document — which owns Prisma — declares them. `05`'s `TelemetryUsage` and its two enums are
deleted; the logs stream writes into this table.

```prisma
/// One row per (organization, project, UTC day). Redis is authoritative within
/// the current day (apps/api increments there on the hot path); this is the
/// audit record the daily rollup writes and the billing chart reads.
///
/// Field list is normative from 10-ops-retention-billing.md section 8.3 -- the
/// rollup that writes it. metricSamples and metricDatapoints are BOTH kept and
/// are NOT the same number: `10` D11 establishes that gigapipe expands one
/// histogram data point into len(bucket_counts)+1+(sum?1:0) stored samples
/// (writer/utils/unmarshal/otlp_metrics.go:373-391), so a latency-histogram
/// tenant stores 10-60 rows per accepted data point. Samples are billed;
/// datapoints are the diagnostic that explains the ratio to a customer.
model TelemetryUsageDaily {
  id             String       @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  projectId      String
  project        Project      @relation(fields: [projectId], references: [id], onDelete: Cascade)
  /// UTC calendar day this row aggregates. @db.Date, not a timestamp: the
  /// grain IS the day, and a timestamp invites a timezone bug in the unique key.
  day            DateTime     @db.Date

  /// BigInt on every counter, not Int. logsBytes on a large project is
  /// ~2.8e10/day, which overflows int4 on the first row written.
  requests         BigInt @default(0)
  bytesIngress     BigInt @default(0)
  /// Emitted storage rows -- the billed quantity (10 D11).
  metricSamples    BigInt @default(0)
  /// Accepted OTLP data points -- diagnostic only. NOT the billed quantity.
  metricDatapoints BigInt @default(0)
  metricRejected   BigInt @default(0)
  logsRecords      BigInt @default(0)
  logsBytes        BigInt @default(0)
  tracesSpans      BigInt @default(0)
  /// Denormalised at write time so a later change to the unit weights cannot
  /// silently restate historical invoices. Derivable from the counters above,
  /// stored so the billing page and the quota hook do one cheap SUM.
  billingUnits     BigInt @default(0)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([organizationId, projectId, day])
  @@index([projectId, day])
  @@map("telemetry_usage_daily")
}
```

**Three things settled here, each of which was a conflict:**

- **The key is `(organizationId, projectId, day)`**, which generates the Prisma compound name
  `organizationId_projectId_day` that `10` §8.3's `upsert` already names. `organizationId` is
  denormalisation on a row that carries it anyway, not a finer grain: a project belongs to one
  organization, so `(projectId, day)` is still unique in practice. The `@@index([projectId, day])`
  covers project-scoped reads that do not know the organization. The alternative asked for by
  `10`'s Interfaces — `@@id([organizationId, projectId, day])` with no surrogate — is rejected
  only because every model added to this schema since 2024 carries a `@db.Uuid` surrogate `id`
  (`Client` `:359`, `Report` `:426`, `Cohort`, `Import`) and a composite primary key would be
  the one exception.
- **`finalizedAt` is dropped.** The previous revision used it to make a re-run over a closed day
  a no-op. `10` §8.3's rollup does not write it, and a `WHERE finalizedAt IS NULL` guard on the
  upsert would make `10`'s `update: row` silently no-op. The property it protected is preserved
  by a different mechanism, which `10` §8.3 already has: the rollup enumerates projects from
  `SMEMBERS telemetry:usage:days:{day}`, and those keys expire, so a re-run past the Redis
  window finds nothing and returns rather than writing zeros. Stated here because dropping a
  guard needs the replacement named.
- **The counters are camelCase columns.** Prisma's `@@map` renames the *table*, not the
  columns; without a per-field `@map` the column is `"billingUnits"`, not `billing_units`.
  `10` §8.3's `refreshOrganizationTelemetryUsage` issues raw SQL reading
  `SUM(billing_units) … WHERE organization_id = …`, which will fail at runtime against this
  schema. **Delta handed to `10`:** either quote the camelCase identifiers in that
  `$queryRaw`, or use `db.telemetryUsageDaily.aggregate`. This document does not add `@map`
  directives, because no other model in `schema.prisma` uses them and one exception is worse
  than one corrected query.

The rollup itself is `10` §8.3's and is an **upsert with last-writer-wins on a recomputed
total**, not `createMany({ skipDuplicates: true })`. The previous revision justified the unique
constraint as crash protection — "BullMQ crons configure no `attempts` (`packages/queue/src/queues.ts:264-272`
— verified, `cronQueue` has only `removeOnComplete: 10`), so a crashed run re-runs over the
same days" — and that reasoning inverts the consequence: with `skipDuplicates`, a re-run over a
day that already holds a **partial** row writes nothing, so the partial row is what bills.
"Duplicate rows" would become "silently under-counted revenue", which is worse. The constraint
is the upsert target, not crash protection.


#### `model TelemetryErasure`

`10-ops-retention-billing.md` §8.6 step 5 mandates this row; this document owns its
declaration. It is also the retry ledger for §14: once `deleteProjects` runs, the project
id is gone from Postgres and nothing else remembers that telemetry was left behind.

**`05-logs.md` §7.4's `TelemetryPurgeJob` is deleted, and its two genuinely better ideas are
folded in here (R5).** `05` is right that the *fingerprint set* must be durable, not the
attempt: `purgeTelemetry` resolves fingerprints from ClickHouse before the Postgres `Project`
row is gone, because the projectId is the only handle, so a worker that dies between the
resolve and the mutations leaves rows that nothing can ever address again. Re-resolving on
retry is impossible once the project row is deleted. So `TelemetryErasure` carries the
resolved set and the submitted mutation ids, and `deleteTelemetryFromClickhouse` takes a
`resumeId`. What is **not** adopted is `05`'s state machine gating `deleteProjects` — see S15.

```prisma
/// One row per telemetry-erasure attempt. Written BEFORE the deletes are issued
/// (so a crash leaves a pending row) and completed after the mutation poll.
/// projectIds is a plain String[] because the projects it names are deleted
/// microseconds later -- an FK would cascade the evidence away.
model TelemetryErasure {
  id          String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  projectIds  String[]
  /// What is being erased. 'project' is the whole tenant; 'subject' is the
  /// per-profile case 06-traces-and-correlation.md section 11.6 describes, which
  /// is an ARGUMENT on the one function rather than a second function.
  subject     String?
  /// Which signals this attempt covers. NULL = all of them.
  signals     String[]  @default([])
  /// The resolved fingerprint set, as UInt64 decimal strings, committed BEFORE
  /// the first mutation is issued (05 section 7.4's durability requirement).
  /// Once the project row is deleted this is the only handle that exists, so a
  /// retry MUST reuse it rather than re-resolving against a project that is gone.
  /// [IPrismaTelemetryFingerprints]
  fingerprints Json     @default("[]")
  /// ClickHouse mutation ids, one per issued statement, so the poll survives a
  /// process restart.
  mutationIds String[]  @default([])
  requestedAt DateTime  @default(now())
  resolvedAt  DateTime?
  completedAt DateTime?
  /// Set when a step failed. The erasure cron re-drains rows where
  /// completedAt IS NULL, oldest first, so a swallowed failure is retried
  /// rather than lost.
  lastError   String?
  attempts    Int       @default(0)

  @@index([completedAt, requestedAt])
  @@map("telemetry_erasures")
}
```

`fingerprints` is `Json`, not `String[]`, deliberately: a pathological project resolves to
10^5–10^6 fingerprints (§14), and a Postgres `text[]` of a million elements is a worse
toast-table citizen than one JSON document. It gets a `/// [IPrismaTelemetryFingerprints]`
annotation and a `type IPrismaTelemetryFingerprints = string[]` declaration in
`packages/db/src/types.ts` — a **second** new declaration, so §7's "that is the only new
declaration" is corrected to two.

#### The `BigInt` hazard

Prisma maps `BigInt` to JS `bigint`, not `number`. Four consequences:

1. `bigint + number` is a runtime `TypeError`. Summing `billingUnits` across rows must be
   `rows.reduce((a, r) => a + r.billingUnits, 0n)`.
2. `JSON.stringify` throws on `bigint`, but the tRPC boundary is safe: `trpc.ts:57` sets
   `transformer: superjson`, which serialises `bigint` natively. Anything that bypasses
   tRPC — a Fastify route in `apps/api`, a log line, a webhook body — still throws.
3. `Math.min(units, INT4_MAX)` when saturating into
   `Organization.subscriptionPeriodTelemetryUnits` needs a conversion first. Write it as
   `Number(units > BigInt(INT4_MAX) ? BigInt(INT4_MAX) : units)`, and keep the *unclamped*
   value for the limit comparison (the invariant in the column comment above). Note that
   `10` §8.3's `refreshOrganizationTelemetryUsage` does `Number(agg?.units ?? 0n)` **before**
   the clamp and then compares the clamped column — the unclamped `units` local is the one the
   threshold evaluator must receive, and it does.
4. Recharts and the chart pipeline take `number`. Convert once, at the tRPC boundary.

A fifth, added because the column set changed: **`Organization` must never gain a `BigInt`
column.** `10` D12 verifies that `getOrganizationByProjectIdCached` serialises with a bare
`JSON.stringify(result)` (`packages/redis/cachable.ts:265`), which throws `TypeError` on a
`bigint`, so every cache miss through `subscriptionHook` would reject. That is why the
`Organization` counters are saturating `Int` while the ledger is `BigInt` (S5), and it is a
harder constraint than "matching the events convention".

**Alternative considered and rejected: store KiB instead of bytes.** `logsBytes` at
2.8e10/day overflows `int4` only because the unit is bytes; KiB would put the `int4` ceiling
at ~2 TB/day/project and delete this whole subsection plus F11. Rejected because `int8`
costs nothing in Postgres, the four hazards above are one-time boundary conversions, and a
KiB column makes every displayed number a conversion away from the quantity actually
metered — the Redis hot-path counter is in bytes, and a unit mismatch between the live
counter and the ledger is a subtler bug than a `bigint` `TypeError` that fails loudly.

#### Migration

`packages/db/prisma/migrations/<ts>_telemetry_metering/migration.sql`:

```sql
-- Telemetry metering. Volume is metered separately from events because the
-- ratio is not close: a comparable workload emits ~3000x the bytes.
--
-- The Organization columns mirror the subscriptionPeriodEvents* trio, INCLUDING
-- its conventions: the counter saturates at INT4_MAX (the limit comparison uses
-- the unclamped value -- apps/worker/src/jobs/sessions.ts:76-89) and the limit
-- defaults to 0 meaning ZERO ALLOWANCE. The backfill below seeds the same
-- generous trial allowance onboarding.ts:21-24 uses for events, which is the
-- repo's established answer to "0 trips on the first unit".
--
-- telemetry_usage_daily uses int8 on every counter: logsBytes on a large
-- project is ~2.8e10/day. `organizations` must NOT: it travels through
-- cacheable()'s bare JSON.stringify, which throws on a bigint (10 D12).
--
-- FIVE columns, not seven. telemetryRetentionTier / ...Since are deliberately
-- NOT here: 10-ops D9 is "one window per signal for everyone" in v1 and its
-- per-plan tier table is deferred, so nothing would write them. They land with
-- 10 section 6.3's own migration when its trigger fires.
ALTER TABLE "organizations"
  ADD COLUMN "subscriptionPeriodTelemetryUnits" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "subscriptionPeriodTelemetryLimit" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "subscriptionPeriodTelemetryUnitsExceededAt" TIMESTAMP(3),
  ADD COLUMN "telemetryUsageWarningSentAt" TIMESTAMP(3),
  ADD COLUMN "telemetryUsageExceededSentAt" TIMESTAMP(3);

-- Backfill: every existing organization gets the trial allowance rather than 0,
-- so enabling telemetry cannot shed an org that never opted into a limit.
-- 10_000_000 units matches TRIAL_EVENTS_LIMIT's order of magnitude; the exact
-- number is 10-ops-retention-billing.md's to set.
UPDATE "organizations" SET "subscriptionPeriodTelemetryLimit" = 10000000;

-- Column names are camelCase and QUOTED. Prisma's @@map renames the table, not
-- the columns, and no model in this schema uses per-field @map. Any raw SQL
-- against this table must quote them; 10-ops section 8.3's
-- refreshOrganizationTelemetryUsage currently reads billing_units /
-- organization_id and will fail until it is corrected.
CREATE TABLE "telemetry_usage_daily" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "requests" BIGINT NOT NULL DEFAULT 0,
    "bytesIngress" BIGINT NOT NULL DEFAULT 0,
    "metricSamples" BIGINT NOT NULL DEFAULT 0,
    "metricDatapoints" BIGINT NOT NULL DEFAULT 0,
    "metricRejected" BIGINT NOT NULL DEFAULT 0,
    "logsRecords" BIGINT NOT NULL DEFAULT 0,
    "logsBytes" BIGINT NOT NULL DEFAULT 0,
    "tracesSpans" BIGINT NOT NULL DEFAULT 0,
    "billingUnits" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "telemetry_usage_daily_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "telemetry_usage_daily_organizationId_projectId_day_key"
  ON "telemetry_usage_daily"("organizationId", "projectId", "day");
CREATE INDEX "telemetry_usage_daily_projectId_day_idx"
  ON "telemetry_usage_daily"("projectId", "day");

ALTER TABLE "telemetry_usage_daily" ADD CONSTRAINT "telemetry_usage_daily_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "telemetry_usage_daily" ADD CONSTRAINT "telemetry_usage_daily_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

```

`telemetry_erasures` is **not** in this file — it ships in P1, with the deletion sweep
(R5), as `<ts>_telemetry_erasure/migration.sql`:

```sql
-- The retry ledger for deleteTelemetryFromClickhouse. Ships in P1 with the
-- sweep, not in P2 with metering: 02-ingest-gateway.md section 17 makes the
-- sweep the precondition on enabling telemetry for any tenant, and
-- 11-testing-strategy.md makes it gate 1.9.
--
-- `fingerprints` is jsonb, not text[]: a pathological project resolves to
-- 10^5-10^6 fingerprints and a million-element text[] is a worse toast citizen
-- than one document. It is committed BEFORE the first mutation is issued,
-- because once deleteProjects has run the project id is gone and the set cannot
-- be re-resolved (05-logs.md section 7.4's durability requirement, adopted).
CREATE TABLE "telemetry_erasures" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "projectIds" TEXT[] NOT NULL,
    "subject" TEXT,
    "signals" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "fingerprints" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "mutationIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "telemetry_erasures_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "telemetry_erasures_completedAt_requestedAt_idx"
  ON "telemetry_erasures"("completedAt", "requestedAt");
```

`id` is `@db.Uuid` on all three new models, matching the convention every model added since
2024 uses (`Client` `schema.prisma:359`, `Report` `:426`, `Cohort`, `Import`). `projectId`
stays `TEXT` because it must match `projects.id`, which is bare `TEXT` (`schema.prisma:256`) —
as is `organizations.id` (`:38`). (The draft listed `Report` among the bare-`TEXT` models; it
is not.) This closes the draft's Q9. `ProjectIdTombstone.id` is also bare `TEXT`, because it
*is* a project id.

**Q3 is promoted to a P0 decision (R-note).** `TelemetryUsageDaily`'s FK to `projects` is
`onDelete: Cascade`, so deleting a project destroys its in-period billing audit trail.
Changing `Cascade` → `SetNull` after rows exist is a data-losing migration on a billing table,
so the choice costs nothing now and is expensive later. It is a **finance call, not a schema
call**: named owner is whoever owns billing in `10-ops-retention-billing.md`, answer due
before the P2 migration is written, recorded in the Sequencing row for
`<ts>_telemetry_metering`. `10-ops` carries no corresponding question today and should.

#### Rollback

```sql
DROP TABLE "telemetry_erasures";
DROP TABLE "telemetry_usage_daily";
ALTER TABLE "organizations"
  DROP COLUMN "subscriptionPeriodTelemetryUnits",
  DROP COLUMN "subscriptionPeriodTelemetryLimit",
  DROP COLUMN "subscriptionPeriodTelemetryUnitsExceededAt",
  DROP COLUMN "telemetryUsageWarningSentAt",
  DROP COLUMN "telemetryUsageExceededSentAt",
  DROP COLUMN "telemetryRetentionTier",
  DROP COLUMN "telemetryRetentionTierSince";
```

Fully reversible; loses the usage ledger and the erasure evidence. **Ordering: roll back the
code first, then the schema, for every change in this document.** The Polar webhook
(`webhook.controller.ts:485-503`) writes these columns on every billing-cycle event;
dropping them under running code 500s the whole webhook handler and takes subscription sync
down with it.

---

### 5. P6 — `TelemetrySchemaState`

The retention cron re-asserts the TTL on **every** run (S12), so this row is not a gate.
It exists for one thing the DDL cannot record and ClickHouse cannot be asked:
`materialize_ttl_after_modify = 1` must run exactly once — on the first apply against a
database that already holds data, or on any change that *shortens* a window — and nothing
in ClickHouse tells you whether it already did.

```prisma
/// Desired ClickHouse state for the telemetry database, as last successfully
/// applied. ClickHouse is WRITE-ONLY for this: we never read a normalised TTL
/// expression back and compare strings. Exactly one row, id = the telemetry
/// database name, so a split deployment can hold several.
model TelemetrySchemaState {
  id                 String    @id
  /// sha256 over the canonical JSON of { ttl: {...}, codecs: {...} } the cron
  /// last applied successfully. NOT a gate -- the cron re-asserts every run
  /// regardless. Its only job is to decide materialize_ttl_after_modify:
  /// unchanged or lengthening => 0; shortening => 1, once.
  desiredFingerprint String
  /// True once a TTL has been applied with materialize_ttl_after_modify = 1.
  materialized       Boolean   @default(false)
  lastError          String?
  lastErrorAt        DateTime?
  appliedAt          DateTime  @updatedAt

  @@map("telemetry_schema_state")
}
```

**Why `gigapipeSchemaVer` is not here**, against `10-ops-retention-billing.md:696-699`,
which declares it. `max(ver)` from `gigapipe.ver` advances only when a *new statement is
appended to gigapipe's SQL scripts* (`ctrl/qryn/maintenance/update.go:271-286`: the loop
runs `scripts[ver..len-1]` and inserts one `ver` row per statement). The event it was added
to detect is the clobber in `rotateTables`, and that is guarded by a row in
`gigapipe.settings` compared against `rotateTTLStr` (`rotate.go:73-75`) — a string built
from `SAMPLES_DAYS` and the `TTLPolicy` list. Change `SAMPLES_DAYS` and gigapipe re-stamps
its own TTL over ours with **no** change to `ver` and no change to any fingerprint we
compute. A desired-state key that misses its own trigger is worse than no key, because it
reports "applied, nothing to do".

Two ways to close it, and the cheap one wins:

- *Rejected:* add the six `gigapipe.settings` guard rows (`v3_samples_days`,
  `v3_time_series_days`, `v1_traces_days`, `tempo_attrs_v1`, `metrics_15s`, `patterns`) to
  the desired-state key. It works, but it couples our cron to gigapipe's internal setting
  names and to the DJB-hash key format in `putSetting` (`rotate.go:40-46`), neither of which
  carries a compatibility promise.
- *Adopted:* re-assert unconditionally at `materialize_ttl_after_modify = 0`. There is no
  blind spot to reason about because there is no condition. **U4** measures the cost.

Migration `<ts>_telemetry_schema_state/migration.sql`:

```sql
-- Desired-state record for the telemetry retention cron. Postgres is the source
-- of truth for "have we materialized a TTL yet"; ClickHouse is never read back
-- for it, because it normalises TTL expressions and a string comparison against
-- system.tables.engine_full can never match.
CREATE TABLE "telemetry_schema_state" (
    "id" TEXT NOT NULL,
    "desiredFingerprint" TEXT NOT NULL,
    "materialized" BOOLEAN NOT NULL DEFAULT false,
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "telemetry_schema_state_pkey" PRIMARY KEY ("id")
);
```

No default row. The cron `upsert`s on first run; an absent row means "nothing has ever been
applied", which is exactly the state a fresh install is in.

**A boolean probe is permitted.** S12's "never read back from ClickHouse" is scoped to
*string equality on a normalised TTL expression*, which genuinely cannot work. A cheap
presence probe — `SELECT engine_full FROM system.tables WHERE database = ? AND name = ?`,
then `engine_full.includes('DELETE WHERE')` — is allowed and is the gauge behind F6. It
asserts a property, not an expression.

**Rollback:** `DROP TABLE "telemetry_schema_state";`. The ClickHouse-side TTL survives; a
re-created table starts with `materialized = false`, costing one redundant materialization
on the next shortening.

---

### 6. P8/P9 — the metric alert tables

`07-alerting.md:488-608` specifies `MetricAlertRuleRuntime`, `MetricAlertState` and
`MetricAlertEvent` in full, including every index and the reasoning for three tables rather
than one. Those names are settled (S17); the earlier `TelemetryAlert` shape is retired.
What this document owns:

#### The enum

```prisma
/// New type -- CREATE TYPE, so the ALTER TYPE ... ADD VALUE ordering rule
/// documented on `Metric` does not apply and members may be written in any
/// order. Ordered here by lifecycle.
enum MetricAlertStateKind {
  pending
  firing
  resolved
}
```

`MetricAlertEvent.kind` is deliberately **not** this enum. It carries ten values (`firing`,
`resolved`, `suppressed`, `unsuppressed`, `pending`, `skipped`, `error`,
`cardinality_exceeded`, `budget_exceeded`, `rule_changed`) and is an append-only log whose
vocabulary grows with the evaluator. A `String` there saves an `ALTER TYPE … ADD VALUE`
migration per transition kind, every one of which would then be subject to §1's ordering
rule. Same reasoning as `telemetryRetentionTier`.

#### JSON annotation

`MetricAlertState.labels` and `MetricAlertEvent.labels` both hold `Record<string, string>` —
the series' label set with `op_project_id` stripped. Both get
`/// [IPrismaMetricAlertLabels]` (§7).

#### Migration shape

One file, `<ts>_metric_alerts/migration.sql`: `CREATE TYPE "MetricAlertStateKind"`, the
three `CREATE TABLE`s, indexes, foreign keys. One transaction, and that is fine (§1:
`CREATE TYPE`, not `ADD VALUE`). Two details Prisma gets right that a reviewer should still
check:

- `@@index([notificationRuleId, createdAt(sort: Desc)])` renders as
  `CREATE INDEX … ON "metric_alert_events"("notificationRuleId", "createdAt" DESC)`.
- `@@index([notifiedAt, createdAt])` is *not* a partial index. Prisma cannot express
  `WHERE "notifiedAt" IS NULL`. A btree stores NULLs, so `WHERE "notifiedAt" IS NULL ORDER
  BY "createdAt"` is still an index scan — over a bigger index than a partial one. If the
  outbox becomes hot, the follow-up is a hand-written `CREATE INDEX … WHERE "notifiedAt" IS
  NULL` in a later file, which Prisma tolerates and reports as drift (same tradeoff as the
  S4 `CHECK`). Not worth it in P5.

#### Back-relations

`NotificationRule` gains `metricAlertStates MetricAlertState[]` and
`metricAlertRuntime MetricAlertRuleRuntime?`; `Project` gains `metricAlertStates`,
`metricAlertEvents` and `metricAlertRuntimes`; `Project` and `Organization` gain
`telemetryUsageDaily TelemetryUsageDaily[]`. These produce **no SQL**, but omitting them is
a `prisma validate` failure.

#### The union widening that is not a migration

`zNotificationRuleConfig` gains a third member (`07-alerting.md` §2). That widens
`INotificationRuleConfig`, which widens `PrismaJson.IPrismaNotificationRuleConfig`
(`packages/db/src/types.ts:21`), the declared type of `NotificationRule.config` globally.
**No migration, no `prisma generate` re-run needed for correctness** — the generated client
references the namespace member by name. Its cost is entirely in the type errors it
produces at every site that assumes `config.events` exists; `07-alerting.md:274-296`
enumerates them.

#### Rollback

```sql
DROP TABLE "metric_alert_events";
DROP TABLE "metric_alert_states";
DROP TABLE "metric_alert_rule_runtime";
DROP TYPE "MetricAlertStateKind";
```

Drop order matters (`metric_alert_events.alertStateId` references `metric_alert_states.id`).

**Surviving `NotificationRule` rows with `config.type === 'metric'` are inert, not
dangerous** — correcting the draft, which prescribed deleting customer notification rules
during rollback. `checkNotificationRulesForEvent` (`notification.service.ts:319`) tests
`config.type === 'events'` inline. `checkNotificationRulesForSessionEnd` iterates
`getFunnelRules(rules)` (`:384-386`), which filters through
`isFunnelRule = (rule) => rule.config.type === 'funnel'` (`:377-378`), so a metric config
never reaches the `rule.config.events` indexing at `:410`, `:413`, `:420`. What
`07-alerting.md:274-286` actually records is a **compile-time** consequence: `isFunnelRule`
is a plain boolean, not a type predicate, so `getFunnelRules` returns the unnarrowed union
and the third member breaks the build until it is turned into a type guard. That is a
build-time fix, not a runtime crash, and **no `DELETE FROM notification_rules` belongs in
the rollback path.**

---

### 7. Prisma JSON type declarations

#### How the mechanism actually works

The `prisma-json-types-generator` block in `schema.prisma:12-14` is **commented out**. Typed
JSON columns are produced by a bespoke regex post-processor,
`packages/db/prisma/prisma-json-types.ts`, run as the second half of
`"codegen": "pnpm with-env prisma generate && jiti prisma/prisma-json-types.ts"`
(`packages/db/package.json:7`). It:

1. Scans `schema.prisma` line by line for a `/// [Name]` comment on the line **immediately**
   preceding a line matching `/(\w+)\s+Json/`.
2. Rewrites `runtime.JsonValue` / `runtime.InputJsonValue` occurrences in
   `src/generated/prisma/{client,commonInputTypes,enums,models}.ts` and in
   `src/generated/prisma/models/<Model>.ts` to `PrismaJson.<Name>`.

`src/generated/prisma` is gitignored, so the output is not inspectable in a clean checkout.

**Two hazards, both real, neither documented in the repo:**

- **Patterns 4 and 5 are not field-scoped, and the FIRST mapping wins.** The rewrite runs
  `for (const mapping of mappings)` and applies patterns 1-6 for each mapping in turn
  (`prisma-json-types.ts:104-180`). Patterns 4 (`:148-156`) and 5 (`:158-166`) match bare
  `Prisma.JsonNullValueInput | runtime.InputJsonValue` and `| runtime.InputJsonValue`
  anywhere in the file — no field name. On the **first** mapping's iteration they rewrite
  every remaining such occurrence to that mapping's type, leaving nothing for later
  mappings to claim. Mapping order is `schema.prisma` line order, and the first annotated
  Json field in the file is `ChatMessage.parts` / `/// [IPrismaUIMessageParts]`
  (`schema.prisma:60-61`, `type IPrismaUIMessageParts = unknown[]`).
  **This inverts the draft's risk statement:** appending a `/// [IPrismaMetricAlertLabels]`
  annotation near the bottom of the file cannot change the outcome at all. What *would*
  change global behaviour is inserting an annotated Json column **above** `ChatMessage.parts`.
  Per-model files (`models/<Model>.ts`) are filtered to one model's mappings and are safe.
  The practical rule is unchanged either way: after adding an annotation, run
  `pnpm codegen && pnpm typecheck` in `packages/db` and read the diff of
  `src/generated/prisma/client.ts` before believing the change was inert.
- **A `/// [Name]` with no matching declaration produces `PrismaJson.Name`, which does not
  exist.** There is exactly one `namespace PrismaJson` in the repo
  (`packages/db/src/types.ts:19`, verified by repo-wide grep), and `schema.prisma:444`
  annotates `Report.options` with `/// [IReportOptions]` — a name that is **not** in that
  namespace (every other annotation uses the `IPrisma…` prefix and every `IPrisma…` is
  declared). So either `Report.options` currently produces a type error in `packages/db`, or
  the replacement silently does not fire for it. **UNVERIFIED** (**U6**) — settling it needs
  `pnpm install && pnpm --filter @openpanel/db codegen && pnpm --filter @openpanel/db typecheck`,
  which this analysis was not permitted to run. Either way the rule for new work is
  unambiguous: **annotate only with a name declared in `packages/db/src/types.ts`, and use
  the `IPrisma…` prefix.**

#### What this work-stream adds

```ts
// packages/db/src/types.ts, inside declare global > namespace PrismaJson
    // Label set of one alerting series: the PromQL result's labels with
    // `op_project_id` removed (it is implied by the rule's projectId and must
    // never be shown to a user). Values are Prometheus label values, so both
    // sides are plain strings. `{}` for the reserved pseudo-series rows
    // (`__cardinality__`, `__budget__`).
    type IPrismaMetricAlertLabels = Record<string, string>;
```

and the annotations on `MetricAlertState.labels` and `MetricAlertEvent.labels`.

That is **the only new declaration**. Specifically:

- `NotificationRule.config` — already annotated `/// [IPrismaNotificationRuleConfig]`
  (`schema.prisma:589`). Widening `zNotificationRuleConfig` widens it automatically.
- `Notification.payload` — already annotated `/// [IPrismaNotificationPayload]`
  (`schema.prisma:614`), which resolves to the hand-written union in
  `packages/db/src/services/notification.service.ts:29-37`. A metric alert **must** emit a
  non-null payload or it silently no-ops on webhook/Discord/Slack delivery
  (`apps/worker/src/jobs/notification.ts:79-81` gates on `isValidJson(payload)`), so that
  union gains a member — in `notification.service.ts`, not in `types.ts`.
- `Report.events` — **do not annotate.** It is untyped `Json` today and every read site casts
  (`transformReport`: `report.events as IChartEventItem[]`, `reports.service.ts:99`).
  Annotating it now types the column as the *widened* three-member union while all those
  casts remain, converting a cast into a lie rather than removing it. Typing `Report.events`
  is a worthwhile separate PR; it is not this plan's.
- `TelemetryUsageDaily`, `TelemetrySchemaState`, `TelemetryErasure` — no JSON columns by
  design. `TelemetryErasure.projectIds` is `String[]`, a native Postgres array, not JSON.

---

### 8. ClickHouse: what gigapipe owns, and what a version bump does

#### gigapipe owns its schema, and it is not negotiable

Boot path: `cmd/gigapipe/main.go:306-312` → `initDB(cfg)` (`:66-82`) → `ctrl.Init(cfg,
"qryn")` (`ctrl/ctrl.go:23-38`) → per database `maintenance.InitDB` then
`maintenance.UpgradeAll`, then `ctrl.Rotate`. **`initDB` panics on either error**
(`main.go:74-81`). `InitDB` connects with no database selected so it can run
`CREATE DATABASE IF NOT EXISTS <name>` (`ctrl/maintenance/shared.go:47-61`).

`updateScripts` (`ctrl/qryn/maintenance/update.go:201-287`) is a replay ledger:

- It creates `{{.DB}}.ver (k UInt64, ver UInt64) ENGINE=ReplacingMergeTree(ver) ORDER BY k`.
- Per script family `k` (1 = `log.sql`, 2 = `traces.sql`, 5 = `profiles.sql`,
  10 = `rules.sql`; 3/4/6/11 the `_dist` variants; 7/8/9 the cross-cluster read variants —
  `update.go:33-90`) it reads `max(ver) WHERE k = <k>` and executes `scripts[ver..len-1]`,
  inserting a `ver` row after each statement.
- Scripts are split on `";\n\n"`, so **the index of a statement in the file is its version
  number**. This is why `log.sql:4` says `APPEND ONLY!!!!!`.

Two hard consequences:

1. **We never write to `gigapipe.ver`, and never insert or reorder statements in gigapipe's
   scripts.** If OpenPanel's migration runner managed these tables, our DDL and gigapipe's
   replay would be two independent ledgers over one schema; the drift is undetectable and
   the failure is a `MODIFY ORDER BY` against a table someone else already altered.
2. **`CREATE TABLE IF NOT EXISTS` means the first writer wins, forever.** Every table
   statement in `log.sql` is `IF NOT EXISTS`, so a table we create before gigapipe's first
   boot survives the replay untouched — gigapipe's version of the statement no-ops and the
   `ver` counter advances past it regardless. That is the entire mechanism behind C2/C3.

#### What OpenPanel's runner *can* do

`chMigrationClient` is bound to the `CLICKHOUSE_URL` path database at module load
(`packages/db/src/clickhouse/migration.ts:37-38`), but **fully qualified `db.table` names
work through it and are already used in production**: `packages/db/code-migrations/4-add-sessions.ts:123-127`
runs `INSERT INTO openpanel.sessions … FROM openpanel.events`. So `CREATE DATABASE gigapipe`
and `CREATE TABLE gigapipe.samples_v3 (…)` are runnable from a numbered migration.

What is *not* usable is `getExistingTables()` (`migration.ts:174-187`), which hardcodes
`WHERE database = 'openpanel'`. Migration 22 queries `system.tables` explicitly, the way
migrations 18 and 19 already do.

> Aside worth filing separately: that hardcoded `'openpanel'` is a live bug for any
> self-hoster who pointed `CLICKHOUSE_URL` at a differently named database — which the setup
> quiz explicitly invites (`self-hosting/quiz.ts:239`, `"format: http://user:pw@host:port/db"`).
> They get an empty `existingTables` and migration 3 silently takes its fresh-install branch.
> Not this plan's PR.

Also unusable: `modifyTTL({ tableName, isClustered, ttl })` (`migration.ts:118-132`), which
exists and emits exactly the statement shape §13 hand-writes. It is not adopted for two
reasons — its clustered branch rewrites the name to `${tableName}_replicated`, which does
not exist in gigapipe's schema, and it returns a bare string with no way to attach
`materialize_ttl_after_modify`, which is the setting that decides whether the statement is
free or a full-table rewrite. Recorded so a reader does not think it was missed.

#### What happens when the gigapipe image is bumped

The image tag is pinned (`10-ops-retention-billing.md` D1: `ghcr.io/metrico/gigapipe:v5.4.1`).
On a bump:

1. The one-shot `op-gigapipe-init` container (`MODE=init_only`, `OMIT_CREATE_TABLES` **unset**)
   runs `initDB`, which is `ctrl.Init` **and then** `ctrl.Rotate`. Both `panic(err)`.
2. `ctrl.Init` replays any `log.sql` / `traces.sql` / `profiles.sql` statements appended
   since the version recorded in `gigapipe.ver`. New statements may `ALTER` `samples_v3`.
3. `ctrl.Rotate` recomputes `rotateTTLStr` for each of six guarded groups and, for any group
   whose guard row in `gigapipe.settings` differs, issues
   `ALTER TABLE <t> MODIFY SETTING ttl_only_drop_parts = 1, merge_with_ttl_timeout = 3600,
   index_granularity = 8192` then `ALTER TABLE <t> MODIFY TTL <its own string>`
   (`ctrl/qryn/maintenance/rotate.go:73-94`). **This is the clobber.** See §13.
4. Long-running gigapipe nodes then start with `OMIT_CREATE_TABLES=true`, which makes
   `initDB` return at `main.go:67-72` before touching anything.

`MODE=init_only` (`main.go:306-312`) runs `initDB` and returns **before** `mux.NewRouter()`,
so it registers no routes and binds no listener. That is the intended schema-bootstrap
entry point and is why the init container is one-shot.

---

### 9. The compatibility contract

This is the section the draft was missing, and it is where its two crash-class bugs lived.
Four properties of our pre-created tables must agree with gigapipe's own DDL, and exactly
one must differ.

| Property | Must match gigapipe? | Why |
|---|---|---|
| **Column order** | **Yes** — `type` LAST | `metrics_15s` is the `TO` target of `metrics_15s_mv` (`log.sql:146-158`), whose SELECT is `fingerprint, timestamp_ns, last, max, min, count, sum, bytes, type`. Whether ClickHouse matches a `TO`-table MV's SELECT to its target by name or by position is **UNVERIFIED (U2)**; making our layout byte-identical to gigapipe's post-ALTER layout makes the question moot instead of load-bearing. gigapipe's own `CREATE` has 8 columns and `ADD COLUMN` appends `type`, so `type` is last in its schema. The writer is safe either way — its INSERTs are named-column (`writer/service/insert/samples.go:60`, `metrics.go:57`) — so the exposure is specific to the MV target |
| **`metrics_15s` sorting key** | **Yes** — `(fingerprint, timestamp_ns, type)` | See below. This is a crash, not a degradation |
| **`samples_v3` sorting key** | **No** — deliberate override (S8) | gigapipe never `MODIFY ORDER BY`s `samples_v3` (`log.sql:119-120` is `ADD COLUMN` only), so there is no ALTER for us to break. The override is a read-performance decision with a stated insert cost |
| **`SETTINGS` / storage policy** | **No, and it cannot** | gigapipe's create statements end in `{{.CREATE_SETTINGS}}`, which expands to `SETTINGS storage_policy = '<STORAGE_POLICY>'` when that env var is set (`update.go:213`, `:217-219`). Our tables carry no such clause and `IF NOT EXISTS` means ours wins, so **on a deployment with `STORAGE_POLICY` set, both pre-created tables land on the default disk.** `storagePolicyUpdate` (`rotate.go:124-138`) partially repairs this later — for `samples_v3` under the `v3_storage_policy` guard, and for `metrics_15s` only through the guard row that ping-pongs (§13). **Migration 22 assumes `STORAGE_POLICY` is unset**, which is `10-ops` D20's recommendation anyway |
| **`PARTITION BY`** | **No — this is the whole point** | `type` first, so every part is signal-homogeneous |

#### The `MODIFY ORDER BY` rule, precisely

gigapipe runs, in one statement (`log.sql:126-128`):

```sql
ALTER TABLE {{.DB}}.metrics_15s
    ADD COLUMN IF NOT EXISTS type UInt8,
    MODIFY ORDER BY (fingerprint, timestamp_ns, type);
```

ClickHouse's restriction on `MODIFY ORDER BY` is **not** "the new key must extend the old
one". It is: *any column newly appearing in the sorting key must have been added by an
`ADD COLUMN` in the same `ALTER` query.* The error is
`Existing column <c> is used in the expression that was added to the sorting key. You can
add expressions that use only the newly added columns`. gigapipe combines the two commands
precisely to satisfy that rule — the identical shape appears at `log.sql:115-117`
(`time_series`) and `:122-124` (`time_series_gin`).

Against a table where `type` **already exists**, `ADD COLUMN IF NOT EXISTS` is ignored and
only the `MODIFY ORDER BY` survives, naming a pre-existing column. So the draft's plan —
pre-create with `type` present and `ORDER BY (fingerprint, timestamp_ns)`, and let
gigapipe's ALTER "extend" it — is the construction most likely to **fail**, and its failure
path is `updateScripts` → `ctrl.Init` → `panic` → `op-gigapipe-init` crash-loops under
`restart: always` and gigapipe never starts.

Pre-creating with the sorting key **already equal** to gigapipe's target leaves an empty
diff: no column is newly added to the sorting key, so there is nothing for the check to
reject, and the `ADD COLUMN IF NOT EXISTS` no-ops. That is the construction specified.

Both constructions are **U1**, a blocking P0 probe of the same rank as the TTL probe. Until
it runs, "the empty diff succeeds" is reasoned, not measured.

#### Statements in `log.sql` that are NOT `IF NOT EXISTS`

These are the ones a wrong pre-create collides with. All verified in the pinned tree:

```
log.sql:115-128   ALTER TABLE <t> ADD COLUMN IF NOT EXISTS type UInt8, MODIFY ORDER BY (...)   -- x4 (samples_v3 has no MODIFY)
log.sql:130       RENAME TABLE time_series_gin_view TO time_series_gin_view_bak
log.sql:144       RENAME TABLE metrics_15s_mv TO metrics_15s_mv_bak
log.sql:163-173   ALTER TABLE <t> ADD COLUMN `type_v2` UInt8 ALIAS type                        -- x4
```

Therefore migration 22 pre-creates the two tables **with `type UInt8` last and without
`type_v2`**, and pre-creates **no materialized views at all**. A `type_v2` column added by
us makes gigapipe's `ADD COLUMN` fail; a `metrics_15s_mv` created by us makes its `RENAME`
fail. Both panic.

`traces.sql` is under the same `APPEND ONLY` replay contract (`k = 2`) and creates
`tempo_traces`, `tempo_traces_attrs_gin`, `tempo_traces_kv` — tables §13 sets TTLs on. It is
in the per-bump diff checklist (test 11) for the same reason `log.sql` is.

---

### 10. C1/C2/C3 — the code-migration

#### Registration

The runner (`packages/db/code-migrations/migrate.ts:21-34`) enumerates `code-migrations/*.ts`
whose filename prefix before the first `-` parses as an integer, sorts numerically, and
skips any whose **filename** already appears in the `__code_migrations` table. Registration
is therefore: **drop the file in the directory with a numeric prefix.** No index, no import
list.

The prefix must be **22**. `20` and `21` are each used twice already
(`20-cohort-summary-mv-sort-key.ts` / `20-invite-project-access-levels.ts`,
`21-backfill-cohort-summary-mvs.ts` / `21-wind-down-onboarding-pointer.ts`); the comparator
returns 0 for a tie and order then falls to `readdirSync` order, deterministic per
filesystem but unspecified by the code. Do not add a third collision.

It runs in production via `op-api`'s startup command, `CI=true pnpm -r run migrate:deploy`
(`self-hosting/docker-compose.template.yml:95-101`), which is
`prisma migrate deploy && jiti ./code-migrations/migrate.ts` (`packages/db/package.json:9-11`).
It also runs in CI on every PR: `.github/workflows/docker-build.yml:109-115` runs
`pnpm migrate:deploy` against `clickhouse/clickhouse-server:26.1.3.52` with
`CLICKHOUSE_CLUSTER` unset, so `getIsCluster()` is false and the single-node path executes.

Four runner behaviours to design around:

- **`--dry` is not a dry run for ClickHouse.** `getIsDry()` is consumed at `migrate.ts:66`
  (skip the 10-second countdown) and `:96` (skip recording), and inside two Postgres-only
  migrations. A `--dry` run of migration 22 still executes the DDL unless the migration
  honours the flag itself — and it does, because printing the exact SQL is the review
  surface.
- **`down()` is never called.** `migrate.ts:94-95` calls only `up()`. Five migrations export
  a `down()` (13, 14, 15, 18, 19) and none is reachable. Migration 22 exports one anyway,
  matching 18/19, with a comment saying it must be invoked by hand.
- **The runner takes no lock**, unlike `prisma migrate deploy` (which uses a Postgres
  advisory lock). Two `op-api` replicas starting together both enter `runMigration`. This is
  why migration 22 does **not** use `runClickhouseMigrationCommands`: that helper sets
  `query_id = crypto.createHash('sha256').update(sql).digest('hex')` (`migration.ts:447`),
  so byte-identical DDL from two replicas collides with
  `QUERY_WITH_SAME_ID_IS_ALREADY_RUNNING`, `runMigration` catches it and calls
  `process.exit(1)` (`migrate.ts:109-115`), and that replica's container dies. Issuing
  `CREATE … IF NOT EXISTS` without a `query_id` is naturally idempotent under concurrency.
- **The named-migration form takes a bare filename**, joined to `migrationsDir` at `:94`:
  `jiti ./code-migrations/migrate.ts 22-telemetry-database.ts`. Importing the migration file
  directly executes nothing — it only exports `up`/`down` — and exits 0. The draft's
  documented escape hatch was that no-op.

#### Source

`packages/db/code-migrations/22-telemetry-database.ts`:

```ts
import {
  getTelemetryClient,
  telemetryDatabase,
} from '../src/clickhouse/telemetry-client';
import { getIsCluster, getIsDry, printBoxMessage } from './helpers';

/**
 * The observability database, and the two gigapipe tables whose PARTITION BY we
 * have to own.
 *
 * gigapipe owns this database's schema. It creates the database itself
 * (ctrl/ctrl.go:23-38 -> ctrl/maintenance/shared.go:53) and replays its own
 * append-only script against a `ver` ledger (ctrl/qryn/maintenance/update.go:201-287).
 * We do not duplicate that, and we never write to `ver`. This migration exists
 * for exactly one reason: PARTITION BY cannot be ALTERed, and every table
 * statement in ctrl/qryn/sql/log.sql is CREATE TABLE IF NOT EXISTS, so whatever
 * exists at gigapipe's first boot is what gigapipe uses forever.
 *
 * Why the partition key matters: logs and metrics share `samples_v3`,
 * discriminated by a `type` UInt8 column (0 = both/undefined, 1 = log,
 * 2 = metric -- writer/model/insert_request.go:8-11). Per-signal retention is a
 * conditional TTL (`... DELETE WHERE type != 1, ... DELETE WHERE type = 1`), and
 * gigapipe's rotation unconditionally forces `ttl_only_drop_parts = 1`
 * (ctrl/qryn/maintenance/rotate.go:77-79), under which ClickHouse drops whole
 * parts rather than deleting rows. A part containing both signals therefore
 * survives until the LONGER of the two windows, silently collapsing per-signal
 * retention to max(logDays, metricDays). Putting `type` first in the partition
 * key makes every part signal-homogeneous, which makes part-level TTL exact.
 *
 * COMPATIBILITY CONTRACT -- see docs/observability/08-schema-changes.md section 9:
 *  - `type` is declared LAST in both tables, matching the layout gigapipe's own
 *    CREATE + `ALTER ... ADD COLUMN` sequence produces. metrics_15s is the TO
 *    target of metrics_15s_mv (log.sql:146-158), whose SELECT ends in `type`.
 *  - metrics_15s is created with ORDER BY (fingerprint, timestamp_ns, type),
 *    already equal to gigapipe's `MODIFY ORDER BY` target (log.sql:126-128).
 *    ClickHouse only allows columns ADDED IN THE SAME ALTER to enter a sorting
 *    key; against a table where `type` already exists, `ADD COLUMN IF NOT EXISTS`
 *    is ignored and the MODIFY ORDER BY would reference a pre-existing column and
 *    fail. An empty diff has nothing to reject.
 *  - samples_v3's ORDER BY deliberately DIVERGES from gigapipe's default of
 *    `timestamp_ns` (update.go:214). See S8. ADVANCED_SAMPLES_ORDERING is honoured
 *    here so it does not become a dead env var.
 *  - No SETTINGS clause. gigapipe's `{{.CREATE_SETTINGS}}` carries
 *    `SETTINGS storage_policy = '...'` when STORAGE_POLICY is set (update.go:217-219);
 *    ours wins, so this migration assumes STORAGE_POLICY is UNSET (10-ops D20).
 *
 * NOT created here, deliberately:
 *  - `type_v2`. log.sql:163-173 runs `ALTER TABLE <t> ADD COLUMN type_v2 UInt8
 *    ALIAS type` with NO `IF NOT EXISTS`. Pre-creating it makes gigapipe's own
 *    upgrade fail, and initDB panics on that (cmd/gigapipe/main.go:74-81).
 *  - metrics_15s_mv. log.sql:144 RENAMEs it, also without IF EXISTS.
 *  - any TTL. Retention is re-asserted by apps/worker's retention cron, because
 *    gigapipe re-stamps table TTLs whenever its own guard row changes.
 *
 * Uses the telemetry client's URL resolution, NOT chMigrationClient, so the DDL
 * cannot land on the analytics server while gigapipe uses another
 * (CLICKHOUSE_TELEMETRY_URL). It also avoids runClickhouseMigrationCommands'
 * sha256 query_id, which two concurrent op-api replicas would collide on.
 *
 * Verify after gigapipe's first boot:
 *   SELECT name, partition_key, sorting_key FROM system.tables
 *   WHERE database = '<db>' AND name IN ('samples_v3','metrics_15s');
 */

// gigapipe renders MergeTree / AggregatingMergeTree unreplicated whenever
// `Cloud` is false, which it is whenever CLUSTER_NAME is unset -- and it is
// unset on every OpenPanel surface (there is no <remote_servers> anywhere in
// self-hosting/clickhouse/). See update.go:236-244.
const samplesOrderBy =
  process.env.ADVANCED_SAMPLES_ORDERING?.trim() || 'fingerprint, timestamp_ns';

const SAMPLES_V3 = (db: string) => `
CREATE TABLE IF NOT EXISTS ${db}.samples_v3 (
  \`fingerprint\`  UInt64,
  \`timestamp_ns\` Int64   CODEC(DoubleDelta),
  \`value\`        Float64 CODEC(Gorilla),
  \`string\`       String  CODEC(ZSTD(3)),
  \`type\`         UInt8
)
ENGINE = MergeTree
PARTITION BY (type, toStartOfDay(toDateTime(timestamp_ns / 1000000000)))
ORDER BY (${samplesOrderBy})
SETTINGS index_granularity = 8192`;

const METRICS_15S = (db: string) => `
CREATE TABLE IF NOT EXISTS ${db}.metrics_15s (
  \`fingerprint\`  UInt64,
  \`timestamp_ns\` Int64 CODEC(DoubleDelta),
  \`last\`  AggregateFunction(argMax, Float64, Int64),
  \`max\`   SimpleAggregateFunction(max, Float64) CODEC(ZSTD(3)),
  \`min\`   SimpleAggregateFunction(min, Float64) CODEC(ZSTD(3)),
  \`count\` AggregateFunction(count),
  \`sum\`   SimpleAggregateFunction(sum, Float64) CODEC(ZSTD(3)),
  \`bytes\` SimpleAggregateFunction(sum, Float64) CODEC(ZSTD(3)),
  \`type\`  UInt8
)
ENGINE = AggregatingMergeTree
PARTITION BY (type, toDate(toDateTime(intDiv(timestamp_ns, 1000000000))))
ORDER BY (fingerprint, timestamp_ns, type)
SETTINGS index_granularity = 8192`;

/** `--force-telemetry` overrides the clustered skip (S9). */
const isForced = () => process.argv.includes('--force-telemetry');

async function describe(db: string, table: string) {
  const ch = getTelemetryClient({ database: 'system' });
  const res = await ch.query({
    query: `SELECT name, partition_key, sorting_key FROM system.tables
            WHERE database = {db:String} AND name = {t:String}`,
    query_params: { db, t: table },
    format: 'JSONEachRow',
  });
  const [row] = await res.json<{
    name: string;
    partition_key: string;
    sorting_key: string;
  }>();
  return row;
}

export async function up() {
  const db = telemetryDatabase();
  const isDry = getIsDry();

  if (getIsCluster() && !isForced()) {
    // Not a throw. `pnpm migrate:deploy` runs inside op-api's startup command
    // and in Cloud's deploy pipeline; failing here would turn "telemetry is not
    // supported on this topology yet" into "the API does not boot". Clustered
    // telemetry needs Replicated* engines ON CLUSTER plus gigapipe's own
    // log_dist.sql tables and CLUSTER_NAME set (10-ops U7) -- separate work.
    //
    // To run it by hand once that work lands (note --force-telemetry: without
    // it this branch skips again, because CLICKHOUSE_CLUSTER is still true on
    // the deployment where the skip happened):
    //   cd packages/db && pnpm with-env jiti ./code-migrations/migrate.ts \
    //     22-telemetry-database.ts --force-telemetry
    // Do NOT pass --no-record: runMigration upserts (migrate.ts:97-107), so
    // re-recording an already-recorded migration is a no-op.
    printBoxMessage('SKIPPED: clustered deployment', [
      'Telemetry storage is single-node only for now.',
      'The database and tables were NOT created.',
      'Re-run with --force-telemetry once clustered support lands.',
    ]);
    return;
  }

  const existing = await describe(db, 'samples_v3');
  if (existing && !existing.partition_key.includes('type')) {
    // gigapipe got here first -- someone booted it before upgrading OpenPanel,
    // or against a database created by an older OpenPanel. PARTITION BY cannot
    // be ALTERed, so this is not repairable in place. Do not throw: the stack
    // works, it just cannot do per-signal retention until the table is rebuilt.
    printBoxMessage('WARNING: samples_v3 already exists with the wrong partition key', [
      `partition_key: ${existing.partition_key}`,
      'Per-signal retention will collapse to max(logDays, metricDays).',
      'Recovery requires a rebuild; see docs/observability/08-schema-changes.md F4.',
    ]);
    return;
  }

  const sqls = [
    `CREATE DATABASE IF NOT EXISTS ${db}`,
    SAMPLES_V3(db),
    METRICS_15S(db),
  ];

  printBoxMessage('Plan', sqls);

  if (isDry) {
    // The runner's --dry does NOT stop ClickHouse DDL (migrate.ts:66,96 only
    // skip the countdown and the ledger write), so honour it here.
    printBoxMessage('Dry run - nothing executed', []);
    return;
  }

  // No query_id: the runner holds no lock and two op-api replicas can run this
  // concurrently. CREATE ... IF NOT EXISTS is idempotent; a sha256 query_id is not.
  const server = getTelemetryClient({ database: 'default' });
  for (const query of sqls) {
    await server.command({ query });
  }
}

/**
 * Never called by the runner (migrate.ts:94-95 invokes only up()). Present for
 * the same reason migrations 18 and 19 carry one: it documents the undo, and it
 * can be imported and invoked by hand.
 *
 * Destructive. Only safe before gigapipe has ever written to this database.
 */
export async function down() {
  if (getIsCluster() && !isForced()) return;
  const server = getTelemetryClient({ database: 'default' });
  await server.command({
    query: `DROP DATABASE IF EXISTS ${telemetryDatabase()}`,
  });
}
```

#### Cluster vs single-node, precisely

`getIsCluster()` (`code-migrations/helpers.ts:17-24`) is
`--cluster || CLICKHOUSE_CLUSTER in {'true','1'}` — **false by default**.
`isClickhouseClustered()` (`src/clickhouse/client.ts:83-94`) is the same check but defaults
to **true** unless `SELF_HOSTED` is set. They disagree for a Cloud deployment with neither
variable set. Commit `bcfb4f25` deliberately decoupled `getIsCluster()` from
`getIsSelfHosting()` and did not propagate that to `client.ts`.

Migration 22 uses `getIsCluster()`, matching every other code-migration. So a Cloud
deployment with `CLICKHOUSE_CLUSTER=true` skips it, and one with neither variable set runs
the single-node path — and is simultaneously "clustered" to every runtime consumer.

**That divergence is why every consumer reads one predicate, not `getIsCluster()`:**

```ts
// packages/db/src/clickhouse/telemetry-client.ts
/**
 * The single "is telemetry provisioned" predicate. Every consumer -- the
 * retention cron, deleteTelemetryFromClickhouse, the stack-health gauges, the
 * ingest gateway, the UI empty state -- reads THIS, never getIsCluster() and
 * never a bare env check of its own.
 *
 * GIGAPIPE_URL is the doc set's canonical off switch (04-read-path.md): unset
 * means observability is simply off, which is a first-class state, not an error.
 * If gigapipe is not deployed, no gigapipe table exists, and every telemetry
 * query would be UNKNOWN_TABLE.
 */
export function isTelemetryEnabled(): boolean {
  return !!process.env.GIGAPIPE_URL;
}
```

**What OpenPanel Cloud does in P0:** `CLICKHOUSE_CLUSTER=true` and `GIGAPIPE_URL` unset.
Migration 22 skips, `isTelemetryEnabled()` is false, and every consumer is inert. Telemetry
ships on single-node self-hosting first; clustered support is `10-ops` U7's work and
unblocks Cloud.

On a single-node deployment that never enables observability, migration 22 still runs —
creating an empty database and two empty tables. That is **inert, not wrong**: nothing
reads them, and `isTelemetryEnabled()` keeps every consumer away from them.

#### Ordering: this migration must run before gigapipe's first boot

The whole point of C2/C3 is to lose a race gigapipe would otherwise win:

```
op-ch (healthy)
  └─> op-api           runs `prisma migrate deploy && code-migrations/migrate.ts`  <- 22 runs here
        └─> op-gigapipe-init   MODE=init_only, OMIT_CREATE_TABLES unset            <- gigapipe's DDL
              └─> op-gigapipe  MODE=all, OMIT_CREATE_TABLES=true
```

**The compose `depends_on` orders *start*, not *migration success*, and the draft
overstated it.** `op-api`'s command is a newline-separated `sh -c` block, not `&&`
(`docker-compose.template.yml:95-101`): `CI=true pnpm -r run migrate:deploy` on one line,
`pnpm start` on the next, with no `set -e`. `migrate.ts` exits 1 on failure, the shell
continues to `pnpm start`, the healthcheck at `:102-106` passes, and `op-gigapipe-init` is
released. F4 then occurs with no signal.

Three mechanisms, in order of preference. **The first is required; the compose edge alone
is not sufficient.**

1. **A pre-flight in `op-gigapipe-init`.** Before `MODE=init_only` runs, assert the
   partition key is ours and exit non-zero otherwise. Owned by `10-ops` (it is a compose
   change); requested here as an interface, with the statement given:
   `SELECT partition_key FROM system.tables WHERE database = '<db>' AND name = 'samples_v3'`
   must be non-empty and contain `type`. A missing table is also a fail: it means migration
   22 did not run.
2. **`depends_on: { op-api: { condition: service_healthy } }`** on `op-gigapipe-init`. Keep
   it — it is necessary, cheap, and safe in this direction only. `10-ops` D7 forbids
   `op-api` or `op-worker` depending on a gigapipe service, because a failed probe on an
   optional observability container must never take analytics down. gigapipe waiting on the
   API has no such effect.
3. **Migration 22's own detection** (`describe('samples_v3')`) and the F4 alarm, as the
   last line of defence when 1 and 2 were both bypassed (an operator running
   `docker compose up op-gigapipe` by hand, or an upgrade of an install that already ran
   gigapipe).

**Not adopted:** changing `op-api`'s command to `&&`. It would make the ordering real, but
it changes `op-api`'s failure behaviour for **every** migration, not just this one — today a
failed migration still starts the API. That is a deliberate-looking property of the current
compose file and flipping it is not this work-stream's call to make silently. If `10-ops`
wants it, it is a one-character change and a paragraph of release notes.

**Rejected alternative:** a dedicated `op-gigapipe-provision` one-shot container running the
same DDL. It removes the `op-api → op-gigapipe-init` edge but duplicates the migration's
logic in a second place with its own image and its own way of being skipped, and it does not
run at all on a managed deployment where there is no compose file.

**Recovery when the order is violated anyway.** `samples_v3` exists with
`PARTITION BY toStartOfDay(...)` and no `type`. Stop gigapipe, then:

```sql
-- Documented as an operator runbook, not automated: it is a full copy of the
-- largest table in the deployment. Do it inside the retention window only.
CREATE TABLE gigapipe.samples_v3_new AS gigapipe.samples_v3
  ENGINE = MergeTree
  PARTITION BY (type, toStartOfDay(toDateTime(timestamp_ns / 1000000000)))
  ORDER BY (fingerprint, timestamp_ns);
INSERT INTO gigapipe.samples_v3_new SELECT * FROM gigapipe.samples_v3;
RENAME TABLE gigapipe.samples_v3     TO gigapipe.samples_v3_old,
             gigapipe.samples_v3_new TO gigapipe.samples_v3;
-- verify, then DROP TABLE gigapipe.samples_v3_old
```

`metrics_15s` is rebuilt the same way, and both `type_v2` aliases must be re-added by hand
because `CREATE TABLE ... AS` does not copy ALIAS columns — or, more simply, delete the
`k = 1` rows from `gigapipe.ver` below the `type_v2` statements and let gigapipe replay
them. **Do not delete the whole `ver` row set**: the `RENAME TABLE` statements at
`log.sql:130` and `:144` would replay against tables that no longer have their `_bak`
counterparts and panic.

---

### 11. The second ClickHouse client

New file `packages/db/src/clickhouse/telemetry-client.ts`, exported from
`packages/db/index.ts` on the line after `export * from './src/clickhouse/client';`.

**Why it exists — three mechanical reasons:**

1. `runClickhouseMigrationCommands` calls `chMigrationClient.command({ query, query_id,
   abort_signal })` (`migration.ts:456-461`) with **no settings parameter**. The TTL
   statements must carry `materialize_ttl_after_modify` explicitly (§13), and there is
   nowhere to put it.
2. The database and host must be configurable independently of `CLICKHOUSE_URL`. A managed
   deployment may put telemetry on a different ClickHouse entirely; a self-host will not.
3. **Name collision.** `TABLE_NAMES.profiles === 'profiles'` (`client.ts:52`) and gigapipe's
   profile table is also `profiles` (`ctrl/qryn/sql/profiles.sql:19`). A qualified-name
   convention on the shared `ch` client is one forgotten prefix away from
   `ALTER TABLE profiles MODIFY TTL` against OpenPanel's own profiles. A separate client
   bound to a separate database turns that from data loss into "table not found".

**And why it is lazy (S11):** `packages/db/index.ts` is a pure barrel of 44 `export *`
lines. A module-scope `createClient({ url: telemetryUrl() })` runs `telemetryUrl()` on every
import of `@openpanel/db` — in `apps/api`, `apps/worker`, `apps/start`, `packages/mcp`,
`packages/trpc`, the migration runner, and every vitest file that mocks the package. A
`throw` from that function (unset env, malformed URL) is an unhandled exception at import
time, before any logger exists, and it takes the API and the worker down. `chMigrationClient`
does not have this property because it passes `process.env.CLICKHOUSE_URL` straight through
without validating (`migration.ts:37-38`), and `client.ts:272-281` wraps `new URL` in
try/catch for exactly this reason.

```ts
import { type ClickHouseClient, createClient } from '@clickhouse/client';
import { createLogger } from '@openpanel/logger';

const logger = createLogger({ name: 'clickhouse:telemetry' });

/**
 * The ClickHouse database gigapipe owns. gigapipe takes its own copy from
 * CLICKHOUSE_DB (cmd/gigapipe/main.go:92-94, defaulting to "cloki" -- we always
 * set it explicitly). These two must be equal in every compose surface, and
 * assertGigapipeWroteHere() below verifies it at runtime rather than trusting it.
 *
 * Resolution order, deliberately: the path segment of CLICKHOUSE_TELEMETRY_URL
 * wins when there is one, then CLICKHOUSE_TELEMETRY_DB, then the constant. The
 * draft of this spec overwrote the URL's path unconditionally, which made
 * CLICKHOUSE_TELEMETRY_URL unable to select a database at all -- an operator who
 * set one had it silently discarded.
 */
const DEFAULT_TELEMETRY_DATABASE = 'gigapipe';

function resolveUrl(): URL {
  const raw =
    process.env.CLICKHOUSE_TELEMETRY_URL ?? process.env.CLICKHOUSE_URL ?? '';
  // ONE node, not a comma list. gigapipe with CLUSTER_NAME unset creates its
  // tables on exactly the node its own connection reached, so round-robining DDL
  // or reads across the list in CLICKHOUSE_URL would hit nodes where the tables
  // do not exist. This is also why the shared `ch` proxy (which round-robins,
  // client.ts:305-323) is the wrong client for telemetry.
  const first = raw.split(',')[0]?.trim() ?? '';
  if (!first) {
    throw new Error(
      'CLICKHOUSE_TELEMETRY_URL or CLICKHOUSE_URL must be set to use the telemetry client',
    );
  }
  try {
    return new URL(first);
  } catch {
    const which = process.env.CLICKHOUSE_TELEMETRY_URL
      ? 'CLICKHOUSE_TELEMETRY_URL'
      : 'CLICKHOUSE_URL';
    throw new Error(`${which} is not a valid URL: ${first}`);
  }
}

/** Resolved lazily. Do NOT read process.env at module scope. */
export function telemetryDatabase(): string {
  const fromPath = resolveUrl().pathname.replace(/^\//, '').trim();
  return (
    fromPath ||
    process.env.CLICKHOUSE_TELEMETRY_DB?.trim() ||
    DEFAULT_TELEMETRY_DATABASE
  );
}

/**
 * The single "is telemetry provisioned" predicate. Every consumer reads THIS.
 * GIGAPIPE_URL unset => observability is off (04-read-path.md), no gigapipe
 * table exists, and every telemetry statement would be UNKNOWN_TABLE.
 */
export function isTelemetryEnabled(): boolean {
  return !!process.env.GIGAPIPE_URL;
}

/**
 * gigapipe's table names, so nothing hand-writes them. Deliberately NOT merged
 * into TABLE_NAMES: `profiles` exists in both sets and means different things.
 */
export const TELEMETRY_TABLES = {
  samples: 'samples_v3',
  timeSeries: 'time_series',
  timeSeriesGin: 'time_series_gin',
  metrics15s: 'metrics_15s',
  patterns: 'patterns',
  traces: 'tempo_traces',
  tracesAttrsGin: 'tempo_traces_attrs_gin',
  tracesKv: 'tempo_traces_kv',
  ver: 'ver',
  settings: 'settings',
} as const;

const clients = new Map<string, ClickHouseClient>();

/**
 * Memoized per target database. `database` is passed explicitly rather than
 * baked into the URL path, so migration 22 can reach `default`/`system` before
 * the telemetry database exists.
 *
 * Long request timeout: MODIFY TTL with materialization and lightweight deletes
 * are slow. materialize_ttl_after_modify defaults to 0 here, matching what
 * gigapipe pins on its own maintenance connection (ctrl/maintenance/shared.go:32-35);
 * callers that need 1 pass it per statement.
 */
export function getTelemetryClient(opts?: { database?: string }): ClickHouseClient {
  const database = opts?.database ?? telemetryDatabase();
  const cached = clients.get(database);
  if (cached) return cached;

  const url = resolveUrl();
  url.pathname = '/';

  const client = createClient({
    url: url.toString(),
    database,
    request_timeout: 3_600_000,
    keep_alive: { enabled: true },
    clickhouse_settings: {
      wait_end_of_query: 1,
      send_progress_in_http_headers: 1,
      http_headers_progress_interval_ms: '50000',
      materialize_ttl_after_modify: 0,
    },
  });
  clients.set(database, client);
  return client;
}

/**
 * Call once before the first statement of any job that uses this client.
 *
 * Two failures it guards, both silent and both destructive:
 *
 * 1. Mis-binding. If the resolved database is empty the client falls back to
 *    `default`, where gigapipe's table names collide with OpenPanel's -- a
 *    mis-bound `ALTER TABLE profiles MODIFY TTL` is not a no-op.
 * 2. Divergence. Three independent sources decide this database name: our two
 *    env vars, and gigapipe's own CLICKHOUSE_DB. If they disagree, EVERY check
 *    in this spec still reports success -- migration 22 pre-creates correctly
 *    partitioned tables in database A, describe() finds them, the binding
 *    assertion passes -- while gigapipe creates its own unpartitioned samples_v3
 *    in database B and writes every byte there. The retention cron then applies a
 *    conditional TTL to an empty table and records a clean run. The symptom
 *    surfaces months later as an unbounded disk. So we assert POSITIVELY that
 *    gigapipe wrote where we think it did: `ver` and `settings` exist only
 *    because gigapipe's own replay created them (update.go:207-260,
 *    log.sql:34-40), and the partition key must still carry `type`.
 */
export async function assertTelemetryDatabase(): Promise<void> {
  const expected = telemetryDatabase();
  const ch = getTelemetryClient();

  const bound = await ch
    .query({ query: 'SELECT currentDatabase() AS db', format: 'JSONEachRow' })
    .then((r) => r.json<{ db: string }>());
  if (bound[0]?.db !== expected) {
    throw new Error(
      `telemetry client is bound to "${bound[0]?.db}", expected "${expected}". Refusing to run telemetry DDL.`,
    );
  }

  const rows = await ch
    .query({
      query: `SELECT name, partition_key FROM system.tables
              WHERE database = {db:String}
                AND name IN ('ver','settings','samples_v3','metrics_15s')`,
      query_params: { db: expected },
      format: 'JSONEachRow',
    })
    .then((r) => r.json<{ name: string; partition_key: string }>());

  const byName = new Map(rows.map((r) => [r.name, r]));
  for (const t of ['ver', 'settings'] as const) {
    if (!byName.has(t)) {
      throw new Error(
        `"${expected}.${t}" is missing. gigapipe has never initialised this database - CLICKHOUSE_DB on the gigapipe service does not match ${expected}.`,
      );
    }
  }
  for (const t of ['samples_v3', 'metrics_15s'] as const) {
    const pk = byName.get(t)?.partition_key ?? '';
    if (!pk.includes('type')) {
      throw new Error(
        `"${expected}.${t}" has partition_key "${pk}" - per-signal retention is not possible. See docs/observability/08-schema-changes.md F4.`,
      );
    }
  }
  logger.info({ database: expected }, 'telemetry client bound and verified');
}
```

**Every statement this client issues is also fully qualified** (`gigapipe.samples_v3`). The
binding assertion and the qualification are belt and braces and both are free.

`assertTelemetryDatabase()` is a **cron invariant, not only a test**: the retention cron
calls it before its first statement, and a failure is a loud operational alert, not a log
line. It is the only thing standing between "three env vars disagreed" and "we applied a
TTL to an empty table for six months".

**Note on `{ url, database }` vs a URL path.** The client is constructed with an explicit
`database` option and `pathname = '/'`, which sidesteps the question the draft raised as its
Q6 (whether `@clickhouse/client`'s config merge gives a URL-derived database priority over
the explicit option). With no path segment there is nothing to merge. `node_modules` was not
installed for this analysis, so `loadConfigOptionsFromURL`'s precedence remains
**UNVERIFIED (U5)**; the construction above does not depend on the answer, and
`assertTelemetryDatabase()` makes a wrong answer loud rather than silent.

**Who uses it:** the retention cron, the telemetry-deletion path (§14), migration 22, and
the stack-health gauges. **Not** the metrics/logs/traces read path — that goes through
gigapipe's HTTP API via `apps/api`, never SQL (`04-read-path.md`).

---

### 12. ClickHouse users, grants and the init files

#### Self-hosted: no file in `self-hosting/clickhouse/` is edited

`docker-compose.template.yml:67-90` runs `clickhouse/clickhouse-server:25.10.2.65` with
`CLICKHOUSE_SKIP_USER_SETUP=1` and mounts three files:

- `clickhouse/clickhouse-config.xml` — logging, `listen_host`, and a `<macros>` block whose
  own comment says "Not used anymore". **No `<remote_servers>` anywhere in the repo**, which
  is why `CLUSTER_NAME` must stay unset on gigapipe (setting it flips `Cloud = true` and
  makes every DDL `ON CLUSTER` against a cluster that does not exist) and why migration 22
  skips the clustered path.
- `clickhouse/clickhouse-user-config.xml` — a `<profiles><default>` block with
  `log_queries` / `log_query_threads` off. **No `<users>` block, no `<readonly>`, no
  `<default_database>`, no `<allow_databases>`.**
- `clickhouse/init-db.sh` — `CREATE DATABASE IF NOT EXISTS openpanel;`.

With `CLICKHOUSE_SKIP_USER_SETUP=1` the `default` user is password-less and has no database
restriction, so a second database needs no grant, no user and no config edit. `CLICKHOUSE_AUTH`
on gigapipe is therefore **optional**, not required: gigapipe's own integration compose
(`/Users/drew/projects/gigapipe/test/integration/docker-compose.yml:13-27`) runs against a
stock ClickHouse with no `CLICKHOUSE_AUTH`, and `portCHEnv` leaves `User`/`Password` empty
(`cmd/gigapipe/main.go:116-122`).

**`init-db.sh` is deliberately not edited** (S16): `/docker-entrypoint-initdb.d` scripts run
only when the data directory is empty, so the edit would reach new installs only — and new
installs get the database from migration 22 anyway. Editing it creates a second, divergent
definition of "which databases exist" with no mechanism to keep them in step.

(`10-ops` D16 *does* add a `<gigapipe>` `<profile>` to `clickhouse-user-config.xml` for
memory and thread limits. That is a resource concern in a different PR; "we did not touch
the user config" here must not be read as "nothing should ever touch it".)

#### Which port and protocol

Two different clients reach the same server two different ways, and neither doc stated it:

| Client | Protocol | Port | Set by |
|---|---|---|---|
| OpenPanel (`getTelemetryClient()`, `ch`, `chMigrationClient`) | HTTP | 8123 | the `CLICKHOUSE_URL` / `CLICKHOUSE_TELEMETRY_URL` scheme |
| gigapipe | native TCP by default | **9000** | `CLICKHOUSE_PORT`, default 9000 (`cmd/gigapipe/main.go:107-115`); `CLICKHOUSE_PROTO` selects http/https/tls (`:127-137`) |

gigapipe's own `docs/configuration.md:23` says the default protocol is http; the code
defaults to native TCP. **Set `CLICKHOUSE_PORT` and `CLICKHOUSE_PROTO` explicitly on the
gigapipe service** rather than relying on either document. That belongs in `10-ops`'s compose
block; it is stated here because §12's grants assume one shared server and the grant
statements below are protocol-independent.

#### Managed / bring-your-own ClickHouse

Where `default` is not available, the operator provisions:

```sql
-- The OpenPanel role already exists and reads/writes `openpanel`. It needs
-- read + DDL on the telemetry database for migration 22, the retention cron and
-- project deletion. It does NOT need INSERT: nothing in OpenPanel writes rows
-- into gigapipe's tables.
GRANT CREATE DATABASE ON gigapipe.*                            TO openpanel;
GRANT CREATE TABLE, SELECT, ALTER, ALTER DELETE ON gigapipe.*  TO openpanel;
GRANT SELECT ON system.tables    TO openpanel;
GRANT SELECT ON system.mutations TO openpanel;
GRANT SELECT ON system.parts     TO openpanel;

-- gigapipe's own role. It creates and upgrades the schema and writes every row.
CREATE USER gigapipe IDENTIFIED WITH sha256_password BY '...';
GRANT CREATE DATABASE ON gigapipe.* TO gigapipe;
GRANT CREATE TABLE, CREATE VIEW, DROP TABLE, ALTER, SELECT, INSERT
  ON gigapipe.* TO gigapipe;
GRANT SELECT ON system.tables TO gigapipe;   -- update.go's `SHOW TABLES`
```

`CREATE DATABASE` on gigapipe's role is granted even though migration 22 already created the
database, because `InitDB` (`ctrl/maintenance/shared.go:47-61`) issues
`CREATE DATABASE IF NOT EXISTS` unconditionally on every init run.
**UNVERIFIED (U7)**: whether ClickHouse checks the privilege before or after the
`IF NOT EXISTS` short-circuit. If it short-circuits first the grant is unnecessary; if it
checks first, omitting it makes gigapipe `panic` at boot. Granting it costs nothing.

`GRANT SELECT ON system.parts` is for the stack-health gauges and the retention cron's
"how much did that drop" reporting. `system.query_log` is **not** available on a self-host:
`clickhouse-config.xml:11` removes it (`<query_log remove="remove"/>`), along with
`part_log`, `trace_log` and `metric_log`. `system.mutations` and `system.parts` survive —
which matters because §14's completion criterion polls `system.mutations`.

The reverse direction must be documented too: **a BYO-ClickHouse operator must grant their
OpenPanel user `SELECT` and `ALTER` on `gigapipe.*`.** Without it the retention cron logs a
ClickHouse `ACCESS_DENIED` and no retention happens. That line belongs in
`environment-variables.mdx` next to `CLICKHOUSE_URL`.

#### Co-locating on the analytics instance — the exposure this creates

The plan puts a second, higher-volume database on the ClickHouse instance that already serves
analytics. That is a schema-level decision with operational consequences that are not
schema-level, and they should be named here rather than discovered:

- **Shared disk.** A telemetry ingest spike fills the same volume `openpanel.events` writes
  to. ClickHouse's behaviour when the disk fills is to fail inserts on *every* table, so a
  telemetry incident becomes an analytics outage. Mitigation is `10-ops` D16's quota plus a
  disk-free alert, and — for any deployment that can afford it — a separate volume via a
  storage policy, which §9 notes conflicts with the pre-create and must therefore be set
  **before first boot** or not at all.
- **Shared background merge pool.** `samples_v3` under fingerprint-first ordering (S8)
  produces overlapping parts and therefore more merge work; those merges compete with
  `events` merges for `background_pool_size`.
- **Shared memory limits.** One unbounded LogQL scan can `MEMORY_LIMIT_EXCEEDED` an analytics
  query running beside it. This is precisely what the `<gigapipe>` profile in `10-ops` D16 is
  for, and it is why that profile is not optional on a shared instance.

None of these change the schema. All of them are why the schema is worth reviewing next to
`10-ops` D16 rather than in isolation.

---

### 13. Per-signal retention: the conditional TTL

#### What the tables look like after migration 22 and gigapipe's first boot

`gigapipe.samples_v3`:

| element | source |
|---|---|
| `fingerprint UInt64`, `timestamp_ns Int64 CODEC(DoubleDelta)`, `value Float64 CODEC(Gorilla)`, `string String` | gigapipe's own column list (`log.sql:25-32`), reproduced |
| `CODEC(ZSTD(3))` on `string` | **ours.** gigapipe leaves it on the server default (LZ4); log bodies are the largest column in the dataset and OpenPanel's own text columns use ZSTD(3) |
| `type UInt8`, declared **last** | ours, hoisted from gigapipe's `ALTER … ADD COLUMN IF NOT EXISTS type` (`log.sql:119-120`) so it can be used in the partition key. gigapipe's ALTER then no-ops |
| `type_v2 UInt8 ALIAS type` | gigapipe (`log.sql:169-170`) |
| `PARTITION BY (type, toStartOfDay(toDateTime(timestamp_ns / 1000000000)))` | **ours — the whole reason this migration exists** |
| `ORDER BY (fingerprint, timestamp_ns)` | **ours, and a deliberate divergence.** gigapipe's template is `ORDER BY ({{.SAMPLES_ORDER_RUL}})`, defaulting to the single column `timestamp_ns` (`update.go:214`). See S8 for the read/write tradeoff. `ADVANCED_SAMPLES_ORDERING` still works because migration 22 reads it — but only at CREATE time, so it is a **fresh-install-only** knob, exactly as it is for gigapipe |
| `SETTINGS index_granularity = 8192` | ours; gigapipe sets it later via `MODIFY SETTING` in `rotateTables` anyway |

`gigapipe.metrics_15s` is the same story except that gigapipe **does** run
`ALTER TABLE metrics_15s ADD COLUMN IF NOT EXISTS type UInt8, MODIFY ORDER BY (fingerprint,
timestamp_ns, type)` (`log.sql:126-128`), so our sorting key is created **already equal** to
that target (§9). Its column order is `fingerprint, timestamp_ns, last, max, min, count, sum,
bytes, type` — byte-identical to gigapipe's post-ALTER layout, which is what
`metrics_15s_mv`'s nine-column SELECT expects.

#### The statement

```sql
-- Layer 1: whole-part expiry, per signal. Issued by the retention cron, every
-- run, unconditionally (S12), at materialize_ttl_after_modify = 0.
--
-- `type != 1` / `type = 1` rather than `type IN (2,0)` / `type = 1`: the column
-- has THREE values (0 = undefined/both, 1 = log, 2 = metric --
-- writer/model/insert_request.go:8-11) and 0 is written by live ingest, not only
-- by legacy rows (writer/utils/unmarshal/unmarshal.go:163-165, :225-228, the
-- `if tp == 3 { tp = 0 }` collapse). Two TOTAL clauses cannot leave a row
-- uncovered; two equality clauses can.
--
-- PRECONDITION, asserted before this DDL is emitted: metricDays >= logDays.
-- See "Where type 0 goes" below.
ALTER TABLE gigapipe.samples_v3
MODIFY TTL
  toDateTime(timestamp_ns / 1000000000) + toIntervalDay(90) DELETE WHERE type != 1,
  toDateTime(timestamp_ns / 1000000000) + toIntervalDay(30) DELETE WHERE type  = 1;

ALTER TABLE gigapipe.metrics_15s
MODIFY TTL
  toDateTime(timestamp_ns / 1000000000) + toIntervalDay(90) DELETE WHERE type != 1,
  toDateTime(timestamp_ns / 1000000000) + toIntervalDay(30) DELETE WHERE type  = 1;

-- Traces are their own tables; no discriminator, so a flat TTL.
ALTER TABLE gigapipe.tempo_traces           MODIFY TTL toDateTime(timestamp_ns / 1000000000) + toIntervalDay(30);
ALTER TABLE gigapipe.tempo_traces_attrs_gin MODIFY TTL date + toIntervalDay(30);
ALTER TABLE gigapipe.tempo_traces_kv        MODIFY TTL date + toIntervalDay(30);

-- Labels: the MAXIMUM of every signal that reads them. time_series and
-- time_series_gin resolve fingerprints for logs, for metrics, and for the
-- op_project_id lookups the deletion path uses. Per-signal treatment is possible
-- -- both carry `type` in their sort key (log.sql:115-117, :122-124) -- and is
-- deliberately not attempted: they are a rounding error next to samples_v3.
-- Consequence, stated: label cardinality (hostnames, pod names) is retained at
-- the METRIC window even for log-only streams. F12 prices that.
ALTER TABLE gigapipe.time_series     MODIFY TTL date + toIntervalDay(90);
ALTER TABLE gigapipe.time_series_gin MODIFY TTL date + toIntervalDay(90);

-- `patterns` is one of gigapipe's six rotate guard groups and the draft omitted
-- it entirely, which would have left it on gigapipe's SAMPLES_DAYS window while
-- every other table moved. It only ever holds rows when LOG_DRILLDOWN is enabled;
-- either way, give it the LOG window explicitly, because everything in it is
-- derived from log bodies.
ALTER TABLE gigapipe.patterns MODIFY TTL toDateTime(timestamp_10m * 600) + toIntervalDay(30);
```

**`metrics_15s` gets the same treatment as `samples_v3`, not a shorter one**, because
`metrics_15s_mv` has no `WHERE` and groups by `(fingerprint, timestamp_ns, type)`
(`log.sql:146-158`) — so it rolls up log rows too, and LogQL `rate()` / `count_over_time()`
read it for log streams with no fallback to `samples_v3`. Expiring log rows there returns
**zeros**, not an error.

**Deleting rows from `samples_v3` does not retract the corresponding `metrics_15s`
aggregates.** A ClickHouse materialized view is insert-triggered only. That is why
`metrics_15s` needs its own TTL and its own sweep, rather than inheriting either.

#### The `profiles_*` family

`ctrl/qryn/sql/profiles.sql` creates `profiles_input`, `profiles`, `profiles_series`,
`profiles_series_gin`, `profiles_series_keys` and four MVs, unconditionally (`k = 5`,
`update.go:64-70`). **gigapipe's `Rotate` never touches any of them** — they appear in none
of the six `rotateTables` calls (`rotate.go:155-210`) and in no `storagePolicyUpdate` call.
They have no TTL at all, from anyone.

Decision: **OpenPanel does not ingest Pyroscope profiles in any phase of this plan**, so the
tables exist and stay empty. No TTL is applied. A stack-health gauge counts
`gigapipe.profiles` rows; a non-zero value means something is writing profiles through a
path this plan did not authorise, and it is unbounded. If profiling is ever ingested, it
needs its own TTL written here first, because nothing upstream will apply one.

#### Where type 0 goes, and what that costs

`GetTypes` (`reader/logql/logql_transpiler/clickhouse_planner/sql_misc.go:213-220`) emits
`type IN (<requested>, 0)`, mapping `SAMPLES_TYPE_BOTH` to LOGS first. So a **type-0 row is
visible to log queries and to metric queries**. Putting it on the `!= 1` branch has two
consequences and both must be stated:

1. **A hard invariant: `metricDays >= logDays`.** If a tier ever set logs longer than
   metrics, type-0 rows would vanish from log results at the metric window with no error
   anywhere. The retention cron **asserts this before emitting DDL** and refuses to run
   otherwise:
   ```ts
   if (retention.metrics < retention.logs) {
     throw new Error(
       `telemetry retention: metrics (${retention.metrics}d) must be >= logs (${retention.logs}d); ` +
       `type-0 rows are readable by both engines and are expired on the metric window`,
     );
   }
   ```
   `TELEMETRY_RETENTION` (`10-ops-retention-billing.md:925-932`) satisfies it in all four
   tiers today — trial 7/3, starter 15/7, growth 30/14, scale 90/30 — and **this document
   hands `10-ops` the invariant as a constraint on that table**, so a future tier cannot
   quietly break it.
2. **The converse, which is a retention *promise* problem, not a correctness one.** Because
   log queries are also `type IN (1, 0)`, any row written as type 0 stays readable through
   LogQL for the full **metric** window. A deployment selling "logs: 14 days" would return
   log bodies at day 89. Three options were considered; the third is adopted:
   - *(a) Accept and disclose* — the product surface and any DPA say "log lines that also
     carry a numeric value are retained on the metric window". Honest but ugly.
   - *(b) Expire type 0 on the log window* — makes the promise true and truncates metric
     results for dual-typed rows. Trades a disclosure problem for a correctness one.
   - *(c) Adopted: guarantee type 0 is never written, and monitor it.* Type is assigned
     per ingest protocol, and only the **Loki-JSON both-fields** case produces 0
     (`unmarshal.go:163-165`, `:225-228`); OTLP, Prometheus remote-write, and Loki push
     protobuf all assign 1 or 2 unconditionally. `02-ingest-gateway.md` restricts ingest to
     exactly those protocols, so type 0 should never occur. That is an **enforced gateway
     invariant plus a monitored assertion**, not an assumption:
     ```sql
     -- stack-health gauge, evaluated with the retention cron
     SELECT count() FROM gigapipe.samples_v3 WHERE type = 0
     ```
     Non-zero means an unauthorised ingest path exists. The `type != 1` clause stays as the
     defensive default for rows that should not exist, and its residual is disclosed in
     (a)'s language only if the gauge ever goes non-zero.

The P0 TTL probe (below) inserts dual-typed rows and asserts which queries still see them,
so option (c)'s residual is measured rather than argued.

#### Three settings that decide whether this works

1. **`ttl_only_drop_parts`.** `rotateTables` sets it to `1` unconditionally
   (`rotate.go:78-79`). Under `1`, ClickHouse drops a whole part when the part expires and
   does **not** do row-level deletion. With `type` in the partition key every part is
   signal-homogeneous, so exactly one clause applies to every row in the part and part-level
   expiry is exact. **This is the dependency C2/C3 buy.**
   *Fallback if the semantics do not hold:* `ALTER TABLE gigapipe.samples_v3 MODIFY SETTING
   ttl_only_drop_parts = 0` and accept row-level TTL merges. The cost, honestly: with
   `merge_with_ttl_timeout = 3600` (set in the same gigapipe statement) ClickHouse rewrites
   tail parts hourly, which on a busy project is a continuous background rewrite of several
   GB/day — the exact cost gigapipe set the flag to avoid. And gigapipe re-sets it to `1` on
   every guard-row change, so the fallback must be re-asserted alongside the TTL.
2. **`materialize_ttl_after_modify`.** ClickHouse's default is `1`; gigapipe pins it to `"0"`
   on its maintenance connection (`ctrl/maintenance/shared.go:32-35`). The **same statement**
   is therefore free when gigapipe issues it and a full-table materialization when ours does.
   Rule: `1` exactly once — on the first apply against a database that already holds data, or
   on any change that **shortens** a window — recorded in `TelemetrySchemaState.materialized`;
   `0` on every re-assert and on any change that lengthens. The client defaults to `0` (§11)
   so the expensive case is always an explicit per-statement opt-in.
3. **`MODIFY TTL` at `materialize_ttl_after_modify = 0` does not touch existing parts.** It
   changes table metadata; new merges apply it. So "the TTL is applied" and "old data is
   gone" are two different events and the second may lag by a merge cycle. The retention cron
   must not report success as "data deleted".

#### UNVERIFIED (U3): the syntax itself

`TTL <expr> DELETE WHERE <cond>, <expr2> DELETE WHERE <cond2>` — a **comma-separated list of
DELETE clauses each with its own WHERE** — is the single load-bearing premise of this section
and it could not be verified from anything on disk. Neither repository vendors ClickHouse
source, docs or a grammar; `/opt/homebrew/bin/clickhouse` is a dangling symlink (its Caskroom
directory is empty); nothing is listening on 8123 or 9000. Single-clause
`TTL expr DELETE WHERE cond` is not in doubt. What is in doubt is combining several in one
`MODIFY TTL`, and whether `ttl_only_drop_parts = 1` honours per-clause `WHERE` when computing
part expiry.

**Settle it in P0, before any of this is built**, against `clickhouse/clickhouse-server:25.10.2.65`
*and* `26.1.3.52` (they differ, and dev is the one developers test against):

```sql
CREATE TABLE ttl_probe (type UInt8, ts DateTime, v Float64, s String)
ENGINE = MergeTree PARTITION BY (type, toDate(ts)) ORDER BY ts
SETTINGS ttl_only_drop_parts = 1;

ALTER TABLE ttl_probe MODIFY TTL
  ts + toIntervalDay(90) DELETE WHERE type != 1,
  ts + toIntervalDay(30) DELETE WHERE type  = 1;

SELECT engine_full FROM system.tables WHERE name = 'ttl_probe';
-- insert rows at type 0/1/2 on both sides of both windows, OPTIMIZE TABLE ttl_probe FINAL,
-- then SELECT type, count() FROM ttl_probe GROUP BY type and assert per-type survival.

-- U4, same session: re-issue the identical MODIFY TTL ten times against a table
-- holding data, with materialize_ttl_after_modify = 0, and assert each returns in
-- well under a second and that system.mutations gains no row. That is what makes
-- the unconditional nightly re-assert (S12) free.
```

If multi-clause `DELETE WHERE` does not parse, the fallback is **two mechanisms**: one flat
table TTL at the longest tier (`+ toIntervalDay(90)`, no `WHERE`), plus a nightly
partition-scoped `ALTER TABLE … DELETE WHERE type = 1 AND timestamp_ns < …` sweep for the
shorter tier — which the plan already carries as layer 2 (`10-ops` D8) and which
`packages/db/src/services/delete.service.ts:58-61` shows is already an idiom here. The sweep
is a mutation and costs a part rewrite; it is a fallback, not a preference.

#### The clobber, precisely

`rotateTables` (`rotate.go:48-95`) does, per group:

```go
val, err := getSetting(db, distributed, "rotate", settingName)
if err != nil || val == rotateTTLStr { return err }     // <- the guard
for _, table := range tables {
    ALTER TABLE <t> MODIFY SETTING ttl_only_drop_parts = 1, merge_with_ttl_timeout = 3600, index_granularity = 8192
    ALTER TABLE <t> MODIFY TTL <rotateTTLStr>
}
putSetting(db, "rotate", settingName, rotateTTLStr)
```

`rotateTTLStr` is built from `SAMPLES_DAYS` (`TTLDays`, default 7,
`cmd/gigapipe/main.go:146-152`) and the `TTLPolicy` tiering list; with no policy it is
exactly `"toDateTime(timestamp_ns / 1000000000) + toIntervalDay(<N>)"`. The guard row lives
in `gigapipe.settings`, keyed by a DJB hash of `{"type":"rotate", "name":"<settingName>"`
(unterminated JSON, deliberately — `rotate.go:40-46`).

**Six guard rows**, one per `rotateTables` call:

| settingName | tables |
|---|---|
| `v3_samples_days` | `samples_v3` |
| `v3_time_series_days` | `time_series`, `time_series_gin` |
| `v1_traces_days` | `tempo_traces` |
| `tempo_attrs_v1` | `tempo_traces_attrs_gin`, `tempo_traces_kv` |
| `metrics_15s` | `metrics_15s` |
| `patterns` | `patterns` |

So: **as long as `SAMPLES_DAYS` and `STORAGE_POLICY` never change, gigapipe stamps each
group exactly once, at first boot, and our TTL — applied afterwards — survives every
restart.** Pin `SAMPLES_DAYS` in the compose (`10-ops` pins it to
`TELEMETRY_RETENTION_MAX_DAYS`) and treat changing it as a schema event. Note also that
`SAMPLES_DAYS=0` is not a rotation opt-out: `maintain.go:28-29` returns
`ttl_days should be set for node#…` and `main.go:74-81` panics.

**One exception, and it is a genuine bug in gigapipe.** The setting name `metrics_15s` is
used by *both* `storagePolicyUpdate` (`rotate.go:135`) and `rotateTables` (`rotate.go:192-200`).
They write different values into the same guard row, so whenever `STORAGE_POLICY` is
non-empty the two ping-pong: on every boot `storagePolicyUpdate` sees the TTL string and
re-applies the policy, then `rotateTables` sees the policy string and re-applies the TTL —
including `MODIFY SETTING ttl_only_drop_parts = 1` — **on every gigapipe start**. So the
claim "our TTL survives gigapipe restarts" is true for `samples_v3` and **false for
`metrics_15s` whenever `STORAGE_POLICY` is set.** Mitigation, in order:

1. **Leave `STORAGE_POLICY` unset.** Then `storagePolicyUpdate` returns at `rotate.go:104`
   (`storagePolicy == ""`) without writing and the ping-pong does not exist. This is the
   recommendation, and it is the same recommendation §9 reaches from the `CREATE_SETTINGS`
   direction — two independent reasons for one setting.
2. If a storage policy is ever required, S12's unconditional nightly re-assert already covers
   it: `metrics_15s` is re-stamped every run regardless, at `materialize_ttl_after_modify = 0`.
   This is a second reason the unconditional design is the right one.

**Rejected alternative: pre-seed the guard rows ourselves.** We could compute the DJB hash and
`INSERT INTO gigapipe.settings (fingerprint, type, name, value, inserted_at)` the exact string
gigapipe would compute, making `rotateTables` short-circuit before it touches a table. It
works, it is ~15 lines, and it removes the clobber entirely. Rejected because it writes into a
table gigapipe owns, using a hash function we would re-implement from `ctrl/qryn/helputils`,
keyed on a string format with a missing closing brace that is an implementation detail with no
compatibility promise. A version bump that changes either silently re-enables the clobber, and
the symptom is "retention quietly became 7 days". Re-asserting after the fact is observable;
suppressing in advance is not.

#### Retention is not expressible per project

Say it plainly in the product surface. There is no tenant column on any samples table
(`grep -n oid ctrl/qryn/sql/log.sql` returns nothing); the `oid` column that exists on the
trace family is never written (`writer/service/insert/tempo.go:86-93` lists nine columns and
`oid` is not among them, so it is always `'0'` — and it is the leading component of
`tempo_traces`'s `ORDER BY` and `PARTITION BY`, so it is degenerate); and `X-Ttl-Days` /
`x-ttl-days` / `__ttl_days__` are parsed, propagated onto `MTTLDays`, and read by **no insert
service** — no `ttl_days` column exists in any file under `ctrl/qryn/sql/`. Retention is per
**deployment** and per **signal**. A per-organization tier is implementable only as a sweep
(`10-ops` §8.3), which is a mutation per tier per night.

---

### 14. Deletion, cascades and erasure

This is a schema consequence, not a feature: the Prisma cascades already in place delete the
Postgres rows that are the *only* pointer to ClickHouse data nothing else will ever remove.

`Client.projectId` is `onDelete: Cascade` (`schema.prisma:365`), so deleting a project deletes
its telemetry ingest tokens. `deleteFromClickhouse` (`packages/db/src/services/delete.service.ts:39-72`)
then removes the project's rows from 14 tables in the `openpanel` database — all of which have
a literal `project_id` column, so the predicate is `project_id IN (…)`.

**Not one gigapipe table has a `project_id` column.** `op_project_id` is a key inside
`time_series.labels` (a JSON *string*) and inside `tempo_traces_attrs_gin.(key,val)`. So the
telemetry delete is a resolve-then-delete and lives in a new exported function.

#### Where it is called from, and why that is the load-bearing part

Adopting `10-ops-retention-billing.md` §8.6: **called from inside `deleteFromClickhouse`**, so
there is one place to forget rather than two. `deleteFromClickhouse` has exactly two call
sites and both matter:

- `apps/worker/src/jobs/cron.delete.ts:46` — the scheduled path: `Project.deleteAt`,
  `Organization.deleteAt`, the ownerless-org reaper, and the terminal step of the wind-down
  lifecycle.
- `admin/src/commands/delete-organization.ts:191` — the interactive support tool with the
  "This action CANNOT be undone" banner, which is the path a GDPR erasure request actually
  travels.

**And it must never throw.** `cron.delete.ts:45-48` is:

```ts
if (projectIds.length > 0) {
  await deleteFromClickhouse(projectIds);
  await deleteProjects(projectIds);
}
for (const organization of deletableOrganizations) {
  await deleteOrganization(organization.id);
}
```

There is no `try`/`catch` anywhere in `jobDelete()`. An unguarded throw from the telemetry
delete — the database does not exist because migration 22 skipped on a clustered deployment;
gigapipe was never deployed so `time_series_gin` does not exist (`UNKNOWN_TABLE`);
`CLICKHOUSE_TELEMETRY_URL` unset; `assertTelemetryDatabase()` failing; a mutation timeout on a
large project — aborts the cron **before `deleteProjects` runs**. The blast radius is not
telemetry: **no project and no organization is ever deleted again, on every deployment,
silently.** That is the GDPR erasure path, the scheduled delete path, and the wind-down
terminus.

Four requirements follow, and they are requirements, not style:

1. It is a **no-op** when `isTelemetryEnabled()` is false, checked before any query.
2. Its failure is **caught and logged**, never propagated. The analytics deletion and the
   Postgres deletion must complete regardless.
3. Because a swallowed failure means orphaned telemetry — and after `deleteProjects` the
   project id is gone from Postgres and nothing would ever retry — it writes a
   **`TelemetryErasure` row before it starts** and completes it at the end. A pending row is
   the retry ledger, drained by the same cron.
4. It is **idempotent** and safe against a project id that no longer exists anywhere.

#### The function

```ts
// packages/db/src/services/delete.service.ts
import {
  TELEMETRY_TABLES,
  assertTelemetryDatabase,
  getTelemetryClient,
  isTelemetryEnabled,
  telemetryDatabase,
} from '../clickhouse/telemetry-client';

/** One statement per chunk. 10k UInt64 literals is ~200 KB of query text, under
 *  ClickHouse's 256 KiB max_query_size default with room for the rest of the SQL. */
const FP_CHUNK = 10_000;
/** Above this, a project's label cardinality is pathological; alert rather than
 *  silently issue hundreds of statements. */
const FP_CAP = 2_000_000;

export async function deleteTelemetryFromClickhouse(projectIds: string[]) {
  if (!isTelemetryEnabled() || projectIds.length === 0) return;

  const db = telemetryDatabase();
  const ch = getTelemetryClient();

  // The database exists on every single-node install (migration 22 runs
  // unconditionally and is inert), but gigapipe's tables do NOT exist until
  // gigapipe has booted. Cheap existence check rather than an UNKNOWN_TABLE.
  const present = await ch
    .query({
      query: `SELECT count() AS n FROM system.tables
              WHERE database = {db:String} AND name = 'time_series_gin'`,
      query_params: { db },
      format: 'JSONEachRow',
    })
    .then((r) => r.json<{ n: string }>());
  if (Number(present[0]?.n ?? 0) === 0) return;

  await assertTelemetryDatabase();

  const ledger = await db_.telemetryErasure.create({
    data: { projectIds },
    select: { id: true },
  });

  try {
    const inList = projectIds.map((id) => sqlstring.escape(id)).join(',');

    // 1. Resolve. Materialised in Node rather than chained as a subquery: the
    //    alternative runs the same GIN scan once per target table, and a
    //    materialised list is loggable and reviewable before it deletes.
    const fps = await ch
      .query({
        query: `SELECT DISTINCT fingerprint FROM ${db}.time_series_gin
                WHERE key = 'op_project_id' AND val IN (${inList})`,
        format: 'JSONEachRow',
      })
      .then((r) => r.json<{ fingerprint: string }>())
      .then((rows) => rows.map((r) => r.fingerprint));

    if (fps.length > FP_CAP) {
      throw new Error(
        `telemetry erasure: ${fps.length} fingerprints for ${projectIds.length} project(s), above FP_CAP`,
      );
    }

    const traceKeys = await ch
      .query({
        query: `SELECT DISTINCT trace_id, span_id FROM ${db}.tempo_traces_attrs_gin
                WHERE key = 'op_project_id' AND val IN (${inList})`,
        format: 'JSONEachRow',
      })
      .then((r) => r.json<{ trace_id: string; span_id: string }>());

    // 2. Delete the bulk tables first. ORDERING IS A REQUIREMENT: the samples
    //    predicate was resolved through time_series_gin, and time_series_gin is
    //    itself a target. ClickHouse mutations are async and unordered, so
    //    deleting the index first would orphan the samples permanently with the
    //    only thing that could find them gone.
    const mutations: string[] = [];
    for (const table of [
      TELEMETRY_TABLES.samples,
      TELEMETRY_TABLES.metrics15s,
    ] as const) {
      for (const chunk of chunked(fps, FP_CHUNK)) {
        mutations.push(
          await issue(ch, `DELETE FROM ${db}.${table} WHERE fingerprint IN (${chunk.join(',')})`),
        );
      }
    }
    for (const chunk of chunked(traceKeys, FP_CHUNK)) {
      const pairs = chunk
        .map((t) => `(${sqlstring.escape(t.trace_id)},${sqlstring.escape(t.span_id)})`)
        .join(',');
      for (const table of [TELEMETRY_TABLES.traces, TELEMETRY_TABLES.tracesAttrsGin] as const) {
        mutations.push(
          await issue(ch, `DELETE FROM ${db}.${table} WHERE (trace_id, span_id) IN (${pairs})`),
        );
      }
    }

    // 3. Wait. "Deleted" is not observable at return time otherwise.
    await waitForMutations(ch, mutations, { timeoutMs: 30 * 60_000 });

    // 4. Only now the index and label tables.
    for (const table of [
      TELEMETRY_TABLES.timeSeries,
      TELEMETRY_TABLES.timeSeriesGin,
      TELEMETRY_TABLES.patterns,
    ] as const) {
      for (const chunk of chunked(fps, FP_CHUNK)) {
        await issue(ch, `DELETE FROM ${db}.${table} WHERE fingerprint IN (${chunk.join(',')})`);
      }
    }

    await db_.telemetryErasure.update({
      where: { id: ledger.id },
      data: { completedAt: new Date(), attempts: { increment: 1 } },
    });
  } catch (error) {
    // NEVER propagate: cron.delete.ts has no try/catch and a throw here stops
    // every project and organization deletion on the deployment.
    logger.error({ error, projectIds }, 'telemetry erasure failed; ledger row left pending');
    await db_.telemetryErasure.update({
      where: { id: ledger.id },
      data: { lastError: String(error), attempts: { increment: 1 } },
    });
  }
}
```

`issue()` runs `ch.command({ query, clickhouse_settings: { lightweight_deletes_sync: '0' } })`
and returns a mutation identifier resolved from `system.mutations`. `lightweight_deletes_sync:
'0'` matches the existing path exactly (`delete.service.ts:66-70`) and is the reason step 3
exists: erasure needs rows unreadable *now*, and disk reclamation follows on the next merge.

`db_` is the Prisma client already imported in that file; the alias is only to avoid shadowing
the local `db` string.

Four things the implementer must know, and one open decision:

- **The fingerprint set is not "thousands".** A fingerprint is one distinct label set
  (`fingerprintLabels`, `writer/utils/unmarshal/unmarshal.go:250-270`, hashes label key/value
  pairs), so for one project over a 90-day `time_series_gin` window it is
  series-names × pods × containers × instances × every label the customer sends — routinely
  10^5–10^6. A million UInt64 literals is ~20 MB of query text, far past `max_query_size`
  (256 KiB default), and it fails for exactly the large projects that most need deleting.
  Hence `FP_CHUNK` and `FP_CAP`. The draft asserted "thousands" with no basis and interpolated
  the whole list into one statement.
- **`DELETE FROM` on `metrics_15s` (AggregatingMergeTree) is UNVERIFIED (U8).** This repo's own
  deletion path branches for aggregate targets: `delete.service.ts:57-59` uses `ALTER TABLE …
  DELETE` for `_mv` tables "since DELETE is not supported", and those targets are
  AggregatingMergeTree created via `createMaterializedView` (`13-cohorts.ts:92-113`). Whether
  the distinction is "view vs table" or "engine" is not established anywhere. Probe it with one
  statement against both pinned images; fall back to `ALTER TABLE … DELETE WHERE` for
  `metrics_15s` unconditionally, matching the existing idiom, if the answer is unfavourable.
- **`tempo_traces_kv` is not deleted, deliberately.** It is a shared value dictionary —
  `val_id` is `cityHash64(val) % 10000` (`ctrl/qryn/sql/traces.sql:49`) — so a project's rows
  are bucket entries other projects still use. Bounded by 10 000 `val_id`s per
  `(oid, date, key)` and expires on its own TTL.
- **`fingerprint` is project-exclusive only because the gateway makes it so.** Two series with
  an identical label set collide on one fingerprint. Because the gateway stamps `op_project_id`
  into every series (`01-tenancy-and-security.md`), two *different* projects can never share
  one. That property is load-bearing for this delete and belongs in the ingest tests as an
  assertion, not here as an assumption.
- **Open decision (Q3):** whether project deletion also deletes `TelemetryUsageDaily` rows. The
  FK says yes (`onDelete: Cascade`), which loses the billing audit trail for a deleted project
  *within the current period*. If finance needs the trail, the FK must be `SetNull` plus a
  nullable `projectId` — decide before P2 ships, because changing it later is a data-losing
  migration.

#### Per-subject (GDPR) erasure — stated position

The plan's differentiator is correlating logs and traces back to OpenPanel sessions and
profiles via propagated `session.id` / `profile.id` attributes, which puts personal identifiers
into gigapipe's tables. Everything above is **project-scoped** erasure. Per-*subject* erasure —
"delete everything about this data subject" — is **out of scope for P0–P5**, and this is the
statement of that rather than an omission:

- A fingerprint is per-label-set, so a per-profile delete is a different and much worse shape:
  `time_series_gin WHERE key = 'profile.id' AND val = <id>` resolves fingerprints that are
  **not** project-exclusive by construction (nothing forces `profile.id` into every series the
  way the gateway forces `op_project_id`), so the resolve returns only the series that happen
  to carry the attribute. Rows that mention a subject inside a **log body** (`samples_v3.string`)
  are not reachable through any index at all; deleting them is a full scan with a `LIKE`.
- The interim answer, which must be written into the DPA rather than implied: telemetry
  containing personal identifiers is bounded by the **retention window**, and the erasure
  guarantee OpenPanel offers over telemetry is project-level plus expiry.
- If a per-subject guarantee is ever required, the cheapest path is at ingest —
  `02-ingest-gateway.md` drops or hashes subject identifiers before they reach gigapipe — not
  at delete time. That is a gateway decision, priced there, and it is the recommendation.

#### Backup, restore and disaster recovery

`gigapipe` lives on the same ClickHouse instance as `openpanel` but is outside **both** ledgers
Prisma and `__code_migrations` maintain, and its table shapes are half ours (C2/C3) and half
gigapipe's replay state. Three rules an operator needs:

1. **Back up `gigapipe.ver` and `gigapipe.settings` with the data.** They are gigapipe's own
   migration ledger and rotation guard. A restore that loses `settings` makes gigapipe
   re-stamp its own TTL over ours on the next boot (§13's clobber, unguarded); a restore that
   loses `ver` makes gigapipe replay `log.sql` from statement 0, which hits the two
   non-`IF EXISTS` `RENAME TABLE`s at `log.sql:130` and `:144` against tables whose `_bak`
   counterparts no longer exist — and panics.
2. **Restore order:** `openpanel` first, then `gigapipe`, then start `op-gigapipe-init`. The
   telemetry database is derivable-ish (it can be re-created empty); the analytics database is
   not.
3. **After any partial restore, run `assertTelemetryDatabase()` before starting the retention
   cron.** It checks precisely the two things a partial restore breaks: that `ver`/`settings`
   exist, and that the partition keys still carry `type`.

An acceptable, cheaper posture for self-hosting is: **do not back up `gigapipe` at all.**
Telemetry is bounded-retention operational data, and its loss is an outage of observability,
not of the product. Say which posture the deployment has chosen; do not leave it implicit.

---

### 15. One-way doors

Everything else in this document is reversible. These are not, and the list is short so it can
be read before P0 ships rather than after:

| Door | Why it closes | What re-opening costs |
|---|---|---|
| `samples_v3` / `metrics_15s` `PARTITION BY` | `PARTITION BY` cannot be `ALTER`ed; `CREATE TABLE IF NOT EXISTS` means first writer wins | A `CREATE … INSERT SELECT … RENAME` rebuild of the largest table in the deployment, with gigapipe stopped (§10) |
| `samples_v3` `ORDER BY` | same mechanism; `MODIFY ORDER BY` can only add columns added in the same ALTER (§9) | the same rebuild |
| Column order and the `type_v2`/MV omissions | gigapipe's non-`IF NOT EXISTS` statements are one-shot, replayed from a `ver` watermark | the same rebuild, plus surgery on `gigapipe.ver` |
| `STORAGE_POLICY` at CREATE time | `{{.CREATE_SETTINGS}}` only reaches gigapipe's own `CREATE` | a `MODIFY SETTING storage_policy` ALTER plus a data move; do not set it after the fact casually |
| `ClientType += telemetry` | `ALTER TYPE … DROP VALUE` does not exist | a type recreation under a live table (§2), or leave the member unused, which is what to do |
| `TelemetryUsageDaily`'s FK cascade (Q3) | changing `Cascade` → `SetNull` after rows exist is a data-losing migration | decide before P2 ships |

**"We shipped P0, then changed our mind about the partition or sorting key" has exactly one
answer: the rebuild in §10.** It is a full data copy, it must run with gigapipe stopped, and it
is bounded by the retention window (so it is cheapest immediately after a window shortens).
There is no in-place path and none will appear. That asymmetry is the reason C2/C3 ship in P0
while everything downstream of them — the conditional TTL, `TelemetrySchemaState`, the
re-assert loop, the tier sweeps — is deferrable to the phase that actually sells per-signal
retention.

---

### 16. Rollback, per change

| Change | Rollback | Reversible? | Notes |
|---|---|---|---|
| `ClientType += telemetry` + the `CHECK` | Recreate the type (§2), or leave it | **No** (`DROP VALUE` does not exist) | Practical rollback is revoking tokens and leaving the member unused. Reverting the allow-list conversions **re-opens** `/export`, `/insights`, `/import` and MCP to any surviving telemetry token — revert them only together with the token deletion. Revocation is honoured by other nodes for up to 60 s (`CACHEABLE_LRU_TTL_MS`) |
| `DataSource` + `Report.dataSource` | `ALTER TABLE reports DROP COLUMN "dataSource"; DROP TYPE "DataSource";` | Yes | Only after deleting or exporting reports whose `events` hold `type: 'metric'` items; otherwise they degrade to `unknown_event` series against the events engine |
| `Organization` telemetry columns | `DROP COLUMN` ×7 | Yes | **Roll back the code first.** The Polar webhook (`webhook.controller.ts:485-503`) writes them on every billing-cycle event; dropping them under running code 500s the whole handler |
| `TelemetryUsageDaily`, `TelemetryErasure` | `DROP TABLE` | Yes | Loses the usage ledger and the pending-erasure evidence. Redis still holds the current period |
| `TelemetrySchemaState` | `DROP TABLE` | Yes | The ClickHouse TTL survives. A re-created table starts with `materialized = false`, costing one redundant materialization on the next shortening |
| `MetricAlertStateKind` + 3 tables | `DROP TABLE` ×3 (events → states → runtime), `DROP TYPE` | Yes | Surviving `NotificationRule` rows with `config.type === 'metric'` are **inert**, not crashing (§6). Do **not** delete customer notification rules |
| `IPrismaMetricAlertLabels` | Delete the declaration and the two `///` annotations | Yes | Pure type change, no SQL, but re-run `pnpm codegen` and diff `src/generated/prisma/client.ts` (§7) |
| C1 `CREATE DATABASE gigapipe` | `DROP DATABASE gigapipe` | Yes, destructively | Deletes **all** telemetry. Also `DELETE FROM "__code_migrations" WHERE name = '22-telemetry-database.ts';` so the migration re-runs |
| C2/C3 pre-created tables | `DROP TABLE` — but only before gigapipe's first boot | **Effectively no** | After gigapipe has written, dropping loses data and the next init recreates them with gigapipe's own partition key, permanently losing per-signal retention. §15 |
| C5 conditional TTL | `ALTER TABLE … REMOVE TTL`, or `MODIFY TTL` back to gigapipe's own string | Yes | `REMOVE TTL` keeps data forever; the honest revert is `MODIFY TTL toDateTime(timestamp_ns/1000000000) + toIntervalDay(<SAMPLES_DAYS>)`, which is what gigapipe would have applied. Clear the guard row and restart the init container if you want gigapipe to own it again |

**The whole-plan rollback** — "we are not shipping observability" — is: stop the gigapipe
containers, unset `GIGAPIPE_URL` (which makes `isTelemetryEnabled()` false and every consumer
inert with no code change), `DROP DATABASE gigapipe`, delete the `22-telemetry-database.ts`
row from `__code_migrations`, revert the code, and leave every Postgres column in place. Seven
unused defaulted columns, three unused tables and two unused enum members cost nothing and
keep every rollback out of the "recreate a type under a live table" class.

---

## Sequencing

| Order | Migration | Ships with | Gate |
|---|---|---|---|
| 1 | `<ts>_telemetry_schema_state` | P0 | none |
| 1 | `22-telemetry-database.ts` (code) | P0 | must precede `op-gigapipe-init`'s first run, enforced by the init pre-flight (§10), **not** by `depends_on` alone |
| 2 | `<ts>_add_telemetry_to_client_type` | P1 | **same PR as four allow-list conversions and two minter widenings** (S3) |
| 2b | `<ts>_telemetry_client_requires_project` | P1 | strictly after 2 (Constraint B); same PR |
| 3 | `<ts>_report_data_source` | P2 | same PR as `zReportInput.dataSource` + **nine** whitelist sites (§3), or metric reports silently persist as events reports |
| 4 | `<ts>_telemetry_metering` | P2 | code before schema on rollback; `SELF_HOSTED` bypass in the same PR |
| 5 | `<ts>_metric_alerts` | P5 | same PR as the widened `zNotificationRuleConfig`, the `INotificationPayload` union member, and the `isFunnelRule` type guard |

The only hard cross-migration ordering is 1-before-gigapipe and 2-before-2b. Everything else can
land in any order relative to the others; the gates above are *intra-PR* couplings, and each is
a case where shipping the migration alone is worse than not shipping it.

---

## Interfaces

### Exposed by this work-stream

| Symbol | Location | Consumer |
|---|---|---|
| `getTelemetryClient({ database? })` | `packages/db/src/clickhouse/telemetry-client.ts` | retention cron, deletion, migration 22, stack-health gauges |
| `telemetryDatabase()`, `TELEMETRY_TABLES` | same | same |
| `isTelemetryEnabled()` | same | **every** consumer — cron, deletion, gauges, ingest gateway, UI empty state. Nobody writes their own env check |
| `assertTelemetryDatabase()` | same | every job before its first statement; a cron invariant, not only a test |
| `deleteTelemetryFromClickhouse(projectIds)` | `packages/db/src/services/delete.service.ts`, called **from inside** `deleteFromClickhouse` | covers both `cron.delete.ts:46` and `admin/src/commands/delete-organization.ts:191` |
| `db.telemetrySchemaState` | Prisma | retention cron (`10-ops` §7) |
| `db.telemetryUsageDaily` | Prisma | metering rollup, billing chart (`10-ops` §10) |
| `db.telemetryErasure` | Prisma | erasure retry drain (`10-ops` §8.6) |
| `db.metricAlertState` / `…Event` / `…RuleRuntime`, `MetricAlertStateKind` | Prisma | evaluator (`07-alerting.md` §4) |
| `Report.dataSource`, `DataSource` | Prisma | `executeReport` dispatch (`03-metrics-engine.md` §4) |
| `ClientType.telemetry` + the non-null-projectId `CHECK` | Prisma | `validateTelemetryRequest` (`02-ingest-gateway.md`) |

### Consumed from other work-streams

| Need | From |
|---|---|
| `zMetricQuery` shape, so `transformReportEventItem` can normalise it | `03-metrics-engine.md` §2 |
| `zNotificationRuleMetricConfig`, so the widened union is well-typed | `07-alerting.md` §2 |
| Retention tier → days mapping, so the cron can build the TTL string | `10-ops-retention-billing.md` §8.4 |
| `GIGAPIPE_URL` as the canonical off switch | `04-read-path.md` |
| Whether `op_project_id` is on every series in `time_series_gin` | `01-tenancy-and-security.md` — load-bearing for §14 |
| That no ingest path can produce a `type = 0` row | `02-ingest-gateway.md` — load-bearing for §13's retention promise |

### Requested **of** other work-streams (deltas this document creates)

| Ask | Owner | Why |
|---|---|---|
| Drop `gigapipeSchemaVer` from `TelemetrySchemaState` (`10-ops:696-699`); re-assert the TTL unconditionally each run instead of gating on a fingerprint | `10-ops` §7, §8.5 step 3 | S14 — the field cannot detect the clobber it was added to detect |
| Add a pre-flight to `op-gigapipe-init` asserting `system.tables.partition_key` for `samples_v3` contains `type`, exiting non-zero otherwise | `10-ops` §2 | §10 — `depends_on` orders start, not migration success |
| Constrain `TELEMETRY_RETENTION` so every tier has `metrics >= logs`, and add the assertion to the cron | `10-ops` §8.4 | S13 — type-0 rows are readable by both engines |
| Set `CLICKHOUSE_PORT` and `CLICKHOUSE_PROTO` explicitly on the gigapipe service; leave `CLUSTER_NAME` and `STORAGE_POLICY` unset | `10-ops` §2 | §9, §12 — gigapipe's docs and code disagree on the protocol default, and `STORAGE_POLICY` breaks two things at once |
| Read `Organization` **uncached** in the retention cron | `10-ops` §8.4 | §4 — a 5-minute cache window makes `telemetryRetentionTier` read `undefined` after deploy |
| Seed a generous telemetry limit at organization creation, the way `onboarding.ts:21-24` does for events | `10-ops` §10 | S5 — `limit = 0` means zero allowance |
| Document `CLICKHOUSE_TELEMETRY_URL`, `CLICKHOUSE_TELEMETRY_DB`, and the BYO-ClickHouse `GRANT` in `environment-variables.mdx` | docs | §11, §12 |

### Explicitly not this work-stream's responsibility

The compose file, gigapipe's env vars, `OMIT_CREATE_TABLES`, `SAMPLES_DAYS`, the retention
cron's schedule and its Redis metering, the ClickHouse resource profile, and every zod schema.
This work-stream states what the DDL must be; it does not run it on a timer.

`ADVANCED_SAMPLES_ORDERING` is a **half** exception, and the draft got it wrong in both
directions. It is gigapipe's env var, but because migration 22 wins the `CREATE TABLE` race it
would be permanently inert unless migration 22 reads it — so migration 22 reads it (S8). It is
therefore a fresh-install-only knob for OpenPanel exactly as it is for gigapipe, and setting it
after migration 22 has run does nothing on either side.

---

## Failure modes

| # | Failure | Detection | What the user sees |
|---|---|---|---|
| **F1** | `telemetry` added to `ClientType` without the four allow-list flips | none — it is a successful request | A telemetry token reads every project in the org through `/export` and `/insights`, and imports arbitrary `IClickhouseEvent` rows through `/import`. **Security.** Mitigation: same PR (S3) plus a negative test per validator |
| **F2** | A telemetry client is minted with a null `projectId` | the `CHECK` rejects the `INSERT` | 400 at the minting surface, which is the correct failure. Without the `CHECK`: the ingest gateway has no tenancy label to stamp and either drops the batch or — worse, if a default is invented — cross-tenants it. **Security.** Mitigation: S4 |
| **F3** | `dataSource` added to Prisma but not to `zReportInput` | none — zod strips it and the cache key still changes | Metric reports save as events reports. Detection: a round-trip test asserting `dataSource === 'metrics'` after create → read |
| **F4** | `transformReportEventItem` / `reportData()` have no `metric` branch | none | Every stored metric series becomes `{type:'event', name:'unknown_event'}` on every share, dashboard load and MCP read |
| **F5** | gigapipe boots before migration 22 | the `op-gigapipe-init` pre-flight (§10) exits non-zero; migration 22's `describe()` warns; the F6 gauge | Per-signal retention collapses to `max(logDays, metricDays)` forever. Recovery is the §10 rebuild. **This is the failure the whole migration exists to prevent** |
| **F6** | Migration 22 pre-creates `metrics_15s` with the wrong column order or sorting key | `op-gigapipe-init` panics and crash-loops under `restart: always` | gigapipe never starts. **Loud, immediate, cheap** — and preferable to F5, which is silent. This is why §9 is a contract and U1 is a blocking probe |
| **F7** | `SAMPLES_DAYS` or `STORAGE_POLICY` changed after first boot | our TTL is replaced by gigapipe's on the next init run | Retention drops to `SAMPLES_DAYS` for every signal. Mitigation: the cron re-asserts unconditionally every run (S12), so the window is at most one day. Gauge: `engine_full` for each table contains `DELETE WHERE` |
| **F8** | `materialize_ttl_after_modify` left at ClickHouse's default of `1` on a re-assert | ClickHouse CPU; a row per run in `system.mutations` | A full-table materialization of `samples_v3` every night. Mitigation: the client pins `0` (§11) and `1` is a per-statement opt-in recorded in `TelemetrySchemaState.materialized` |
| **F9** | Multi-clause `DELETE WHERE` does not parse on a pinned image | the `ALTER` errors, loudly, on the first cron run | Falls back to flat TTL + nightly sweep. **Settle in P0** (U3) |
| **F10** | The three database names disagree (`CLICKHOUSE_DB` ≠ `CLICKHOUSE_TELEMETRY_DB` ≠ the URL path) | `assertTelemetryDatabase()`'s positive check for `ver`/`settings` | Without the check: everything reports success while gigapipe writes to a second, unpartitioned, un-TTL'd database. Surfaces months later as an unbounded disk |
| **F11** | `telemetry-client.ts` throws at module scope | `apps/api` and `apps/worker` fail at import, before any logger | Total outage from an unset env var. Mitigation: lazy construction (S11) |
| **F12** | `deleteTelemetryFromClickhouse` throws | none, today — `jobDelete()` has no try/catch | **No project and no organization is ever deleted again, silently, on every deployment.** GDPR erasure, scheduled deletes and the wind-down terminus all stop. Mitigation: §14's guard + catch + `TelemetryErasure` ledger |
| **F13** | A deleted project's fingerprint list exceeds `max_query_size` | `Max query size exceeded` — caught by F12's handler, ledger row left pending | Telemetry for the largest projects is never erased. **Privacy.** Mitigation: `FP_CHUNK` chunking; `FP_CAP` alerts rather than silently issuing hundreds of statements |
| **F14** | A deleted project's hostnames / pod names survive in `time_series.labels` | none | Those tables are on the **metric** window (90 d) even for log-only streams, and §14 does delete from them — but only in step 4, after the mutation poll. If step 3 times out, step 4 never runs and the labels persist until TTL. **Privacy, bounded by retention.** The ledger row is the retry |
| **F15** | Two `op-api` replicas run migration 22 concurrently | the loser's container dies with `process.exit(1)` | Prevented: migration 22 issues `CREATE … IF NOT EXISTS` without a `query_id`, so there is no sha256 collision (§10). If a future edit routes it back through `runClickhouseMigrationCommands`, this returns |
| **F16** | A new `/// [IPrismaX]` annotation is inserted **above** `ChatMessage.parts` | `pnpm typecheck` in `packages/db`, or a diff of generated `client.ts` | Patterns 4/5 in `prisma-json-types.ts:148-166` are not field-scoped and the first mapping wins (§7). Appending an annotation, which is what this plan does, is safe |
| **F17** | `BigInt` from `TelemetryUsageDaily` reaches a non-tRPC `JSON.stringify` | runtime `TypeError` | A 500 on a REST route or a crash in a log line. tRPC itself is safe (`trpc.ts:57` uses superjson) |
| **F18** | Self-hosted deployment sheds telemetry because the default limit tripped | user report | Ingest silently 202s. Mitigation: the `SELF_HOSTED` bypass mirrored from `sessions.ts:65-70`, in the same PR as the columns |
| **F19** | A `type = 0` row is written by an unauthorised ingest path | the `count() WHERE type = 0` gauge | Log bodies readable through LogQL for the metric window rather than the log window — a retention-promise breach, not a correctness one (§13) |
| **F20** | `profiles_*` tables accumulate rows | the `count() FROM gigapipe.profiles` gauge | Unbounded growth: gigapipe's `Rotate` never touches that family, so nothing expires them. Mitigation: nobody ingests profiles; the gauge is the tripwire |

---

## Test requirements

There is **no existing test coverage** for anything this work-stream touches. No test file
references `FinalChart`, `ChartEngine`, `transformReport` (except as an identity mock — see
below), `chMigrationClient`, or `validateSdkRequest`; `apps/api/src/utils/` contains only
`ids.test.ts` and `image-proxy.test.ts`; `packages/db/src/services/reports.service.test.ts`
covers only `mergeGlobalFilters`. Everything below is new.

**Postgres, unit (vitest) — near-zero marginal cost, the harness exists:**

1. `packages/db/src/services/reports.service.test.ts` — `transformReport` round-trips
   `dataSource`; `transformReportEventItem` preserves a `type: 'metric'` item and fills its
   defaults (zod defaults do **not** run on DB read paths — every read site is a cast).
2. `packages/trpc/src/routers/report.test.ts` — `create` → `get` → `duplicate` → `update`,
   asserting `dataSource` survives all four. Model it on `packages/trpc/src/routers/share.test.ts`,
   which already uses `router.createCaller` with a mocked `@openpanel/db`. **Trap:** that file
   mocks `transformReport: (report: unknown) => report` at `share.test.ts:20` — an identity
   function that will hide a missing `dataSource` in exactly this test. The new test must
   exercise the real `transformReport`.
3. `packages/mcp/src/tools/dashboard-management.test.ts` (exists) — `create_report`,
   `update_report` and `duplicate_report` round-trip `dataSource`. `reportSchema` is
   `.strict()`, so this also catches the parse-behaviour change.
4. `apps/api/src/utils/auth.test.ts` (new file) — a `telemetry` client is rejected by
   `validateExportRequest` (which guards `/export` **and** `/insights`), `validateImportRequest`,
   and `packages/mcp/src/auth.ts`. **Trap:** `packages/mcp/src/auth.test.ts:8` mocks `ClientType`
   as a plain object literal, so it cannot catch a missing case; the new tests must import the
   real enum.
5. Both client-minting surfaces reject `type: 'telemetry'` without a `projectId`, and the
   Postgres `CHECK` rejects it at the DB level too.

**Migrations, integration — CI already has the services:**

`.github/workflows/docker-build.yml` runs `postgres:16-alpine`, `redis:7-alpine`,
`clickhouse/clickhouse-server:26.1.3.52` and `pnpm migrate:deploy` on every PR. Tests 6–8 ride
that at near-zero cost; the spec should not pretend otherwise, and the effort table below does
not.

6. `prisma migrate deploy` from an empty database, then `prisma migrate dev --create-only`
   produces **no** new migration — the drift check that proves §1's ordering rule was honoured.
   It will flag the two hand-written objects (`clients_telemetry_requires_project`) as drift;
   assert the diff contains **only** that.
7. Migration 22 against the CI ClickHouse: run twice (idempotent), then assert `partition_key`
   on both tables contains `type` and `sorting_key` on `metrics_15s` is
   `fingerprint, timestamp_ns, type`.
8. Migration 22 with `CLICKHOUSE_CLUSTER=true`: creates nothing, exits 0, records itself. Then
   with `--force-telemetry`: creates everything.
9. Concurrency: two `migrate.ts` processes started together both complete, neither exits 1.

**ClickHouse and gigapipe, against the pinned images — this needs a new harness:**

10. **U1, blocking for P0.** Against `25.10.2.65` **and** `26.1.3.52`, both constructions:
    (a) create `metrics_15s` with `type` present and `ORDER BY (fingerprint, timestamp_ns)`,
    then run gigapipe's exact `ALTER TABLE … ADD COLUMN IF NOT EXISTS type UInt8, MODIFY ORDER
    BY (fingerprint, timestamp_ns, type)`; (b) the same but pre-created with the key already
    equal. Record which succeeds. The spec asserts (b); until this runs, that is reasoned, not
    measured.
11. **U3 + U4, blocking for P0.** The TTL probe of §13, on both images, including dual-typed
    (`type = 0`) rows and the "is a repeated `MODIFY TTL` at `materialize_ttl_after_modify = 0`
    free" measurement.
12. **U8.** One `DELETE FROM … WHERE fingerprint IN (…)` against an AggregatingMergeTree on both
    images.
13. **The first-boot collision test.** Boot the pinned gigapipe image against a database
    pre-created by migration 22 and assert it reaches a healthy state — i.e. that no
    non-`IF NOT EXISTS` statement in `log.sql` **or `traces.sql`** collides with our tables.
    This is the regression test for F6 and it must be re-run on every gigapipe version bump.
14. After that boot: `partition_key` still contains `type` (proving `IF NOT EXISTS` no-opped
    rather than the table being recreated); `sorting_key` on `metrics_15s` is unchanged;
    `system.columns` ordinal position of `type` is **last** on both tables; and
    **`metrics_15s_mv` exists and is inserting** — insert into `samples_v3` and assert
    `metrics_15s` gained a row with the right `type`. The draft's test only checked
    `sorting_key`, which would have passed while the MV was broken.
15. Apply the conditional TTL, insert rows on both sides of both windows, `OPTIMIZE TABLE …
    FINAL`, and assert per-`type` counts — the end-to-end proof that `ttl_only_drop_parts = 1`
    plus a signal-homogeneous partition key yields exact per-signal expiry.
16. `deleteTelemetryFromClickhouse`: a project with two fingerprints is fully erased; a project
    with `FP_CHUNK + 1` fingerprints is erased in two statements per table; the function is a
    no-op with `GIGAPIPE_URL` unset; the function is a no-op when `time_series_gin` does not
    exist; and — the important one — **`jobDelete()` still deletes projects and organizations
    when the telemetry delete throws.**

**Cross-repo, on every gigapipe bump (named owner: whoever raises the version-bump PR; make it
a scripted diff, not a checklist item):**

17. Diff `ctrl/qryn/sql/log.sql` **and `ctrl/qryn/sql/traces.sql`** for new statements that are
    not `IF NOT EXISTS` and touch `samples_v3` or `metrics_15s`; diff
    `ctrl/qryn/maintenance/rotate.go` for changes to the six guard names or the TTL string
    format; diff `ctrl/qryn/maintenance/update.go` for changes to `SAMPLES_ORDER_RUL` or
    `CREATE_SETTINGS`. Then run test 13 against the new image. A script that greps for
    `^ALTER TABLE|^RENAME TABLE` in those two `.sql` files and diffs the result against a
    checked-in snapshot is ~20 lines and turns this into a CI failure instead of a memory.

**A note on the citations in this document.** Every file path and line range was opened and
read against the trees on disk at the time of writing (`openpanel@247744a8`, gigapipe at
`v5.4.1`). Line numbers in `cmd/gigapipe/main.go`, `ctrl/qryn/sql/log.sql` and `schema.prisma`
are the ones most likely to drift on a bump; prefer the symbol names (`initDB`, `portCHEnv`,
`rotateTables`, `updateScripts`) when re-verifying.

---

## Open questions

| # | Question | What would settle it | Blocking? |
|---|---|---|---|
| **U1** | Does ClickHouse accept `MODIFY ORDER BY` whose target is byte-identical to the current sorting key, and does it reject one that names a pre-existing column when the paired `ADD COLUMN IF NOT EXISTS` no-ops? | Test 10, both pinned images. If (b) fails too, the fallback is to pre-create **neither** table's `type` column — which forfeits the partition key and therefore the whole plan — or to fork gigapipe, which `10-ops` §14 rules out on AGPL §13 grounds. It will not fail; measure it anyway | **Yes, P0** |
| **U2** | Does ClickHouse match a `TO`-table materialized view's SELECT to its target by name or by position? | Test 14's "the MV is inserting" assertion. **Not load-bearing** now that our column order is byte-identical to gigapipe's (§9) — recorded so nobody "tidies" the column order later | No |
| **U3** | Does `TTL expr DELETE WHERE c1, expr2 DELETE WHERE c2` parse, and does `ttl_only_drop_parts = 1` honour per-clause `WHERE` when computing part expiry? | Test 11, both pinned images. Fallback: flat TTL at the longest tier + nightly sweep, already carried as layer 2 | **Yes, P0** |
| **U4** | Is a repeated `MODIFY TTL` at `materialize_ttl_after_modify = 0` genuinely metadata-only (sub-second, no `system.mutations` row) against a large table? | Test 11's second half. If it is not, S12's unconditional re-assert reverts to a gated one — and then the gate must include gigapipe's six `settings` guard rows, not `ver` | **Yes, P0** — it decides S12 |
| **U5** | Does `@clickhouse/client` let a URL path segment override an explicit `database` option? | Install and read `@clickhouse/client-common`'s `loadConfigOptionsFromURL`. **Not load-bearing** — §11 sets `pathname = '/'` and passes `database` explicitly, so there is nothing to merge, and `assertTelemetryDatabase()` makes a wrong answer loud | No |
| **U6** | Is `schema.prisma:444`'s `/// [IReportOptions]` currently producing a `PrismaJson.IReportOptions` that does not exist in `packages/db/src/types.ts`? | `pnpm install && pnpm --filter @openpanel/db codegen && pnpm --filter @openpanel/db typecheck`. Either it is a live typecheck failure or the replacement does not fire; both are worth knowing before adding annotations | No — the rule for new work (`IPrisma…` prefix, declared name) is unambiguous either way |
| **U7** | Does ClickHouse check the `CREATE DATABASE` privilege before or after `IF NOT EXISTS` short-circuits? | One statement as an unprivileged role. The spec grants it either way, so this only decides whether a BYO-ClickHouse doc line is necessary | No |
| **U8** | Does lightweight `DELETE FROM` work on an `AggregatingMergeTree` table (`metrics_15s`)? | Test 12. Fallback is `ALTER TABLE … DELETE WHERE` unconditionally, matching `delete.service.ts:57-59`'s existing idiom | No — the fallback is one line |
| **Q3** | Does project deletion also delete `TelemetryUsageDaily` rows, losing the in-period billing trail? | A product/finance call. `Cascade` today; `SetNull` + nullable `projectId` is the alternative. **Decide before P2 ships** — changing it after rows exist is a data-losing migration | Before P2 |
| **Q10** | Which backup posture does the deployment have: back up `gigapipe` with `ver`/`settings`, or do not back it up at all? | An ops decision, stated once in the self-hosting docs (§14). Both are defensible; leaving it implicit is not | Before GA |

Two questions the draft carried are now closed and are recorded so they are not re-opened:
**Q1** (database name) is settled as `gigapipe` on a corrected count of the doc set. **Q2**
(alert model naming) is settled as `07-alerting.md`'s three models; the older `TelemetryAlert`
shape is retired. **Q9** (`@db.Uuid` on new `id` columns) is settled as yes, matching every
model added since 2024.

---

## Effort

| Piece | Days | Notes |
|---|---|---|
| `ClientType += telemetry` + `CHECK` migration + four allow-list conversions + two minter widenings + five negative tests | 1 | Two migration files, not one. The minters were missing from the draft entirely |
| `DataSource` + `Report.dataSource` + **nine** whitelist sites + round-trip tests (tRPC **and** MCP) | 2 | Three of the nine are in `packages/mcp/src/tools/dashboard-management.ts` and were unlisted; MCP is the surface decision 4 of the overall plan leans on |
| Telemetry metering columns + `TelemetryUsageDaily` + `TelemetryErasure` + upsert rollup + BigInt boundary + `SELF_HOSTED` bypass | 1 | The upsert (not `createMany({skipDuplicates})`) and the bypass are new scope |
| `TelemetrySchemaState` | 0.25 | Two fewer columns than the draft |
| Metric alert enum + JSON annotation + migration (models specified in `07-alerting.md`) | 0.5 | |
| Migration `22-telemetry-database.ts` | 1 | Down from the draft's 1.5 because tests 6–9 ride existing CI |
| `telemetry-client.ts` — lazy factory, `isTelemetryEnabled`, `assertTelemetryDatabase` with the positive gigapipe-wrote-here check | 0.75 | |
| Conditional-TTL DDL + the `metricDays >= logDays` assertion + `patterns`/`profiles` decisions + the clobber analysis written into the cron | 1 | |
| `deleteTelemetryFromClickhouse` — chunking, ordering, mutation poll, ledger, failure isolation, and the `jobDelete` regression test | 2 | Up from the draft's 1, which budgeted a signature with a commented-out body |
| **The gigapipe + ClickHouse CI harness** — a gigapipe service container, a second ClickHouse pinned at `25.10.2.65`, and the scripted per-bump `log.sql`/`traces.sql` diff (tests 10–17) | 2 | **New line item.** CI today has one ClickHouse (`26.1.3.52`) and no gigapipe. Test 13 is the regression test for F6, i.e. the thing between a bad pre-create and a crash-looping container |
| Grants + env-var documentation for BYO ClickHouse | 0.25 | |
| **Total** | **~11.75 days** | of which ~1.5 is blocked on U1/U3/U4 |

**What could make it bigger:**

- **U3 fails** (multi-clause `DELETE WHERE` does not parse): +1–2 days for the sweep-based
  fallback, and a mutation cost the plan currently prices at zero.
- **U4 fails** (a repeated `MODIFY TTL` is not free): +0.5 days to re-gate the cron, and the
  gate must then read gigapipe's six `settings` guard rows — coupling to an internal key format
  with no compatibility promise.
- **U1 fails on construction (b)**: the plan has no cheap answer. Pre-creating without `type`
  forfeits the partition key and therefore per-signal retention; patching gigapipe is a fork
  with an AGPL §13 publication obligation (`10-ops` §14). Probe it first.
- **Clustered support is pulled into P0** rather than deferred: `Replicated*` engines
  `ON CLUSTER`, gigapipe's `log_dist.sql`/`traces_dist.sql` families, `CLUSTER_NAME` set, and a
  `<remote_servers>` block that does not exist in this repo today. That is `10-ops` U7's
  estimate, not this document's, but it is the single largest scope risk because it is what
  OpenPanel Cloud needs.
- **Q3 answered as `SetNull`** after P2 has shipped: a data-losing migration on a billing table.

**What could make it smaller:** shipping only C2/C3 in P0 and deferring everything downstream
of the partition key (the conditional TTL, `TelemetrySchemaState`, the re-assert loop, U3/U4)
to the phase that actually sells per-signal retention. That removes ~2 days and both blocking
unknowns from the P0 critical path while keeping the one irreversible decision. The partition
key is the only piece that is genuinely time-locked.
