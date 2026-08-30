# Tenancy and the isolation boundary

gigapipe is single-tenant and has **no request-scoped tenant input on the read side at
all** — `X-Scope-OrgID`, the header every Loki-compatible client would reach for, appears
in the compiled Go tree exactly once, in a comment saying it is not read
(`ruler/controller/controller.go:3`). OpenPanel is multi-tenant. This document specifies
the only mechanism the software leaves available: **one label, `op_project_id`,
unconditionally stamped on every telemetry write and unconditionally injected as an
equality matcher on every telemetry read**, plus the eleven things that must be true
around that label for it to be a boundary rather than a convention — a validated,
non-reusable label value; per-signal stamping rules that differ for metrics, logs and
traces; strip-then-append rather than append-alone; an exact-path outbound allowlist
instead of a proxy; a project id that is *derived* from the session or share and never
received; a response-side check that keeps the label through aggregation; and a purge and
tombstone story so a deleted project's slug can never be handed to a new one. There is no
second line of defence behind it: `samples_v3`, `time_series`, `time_series_gin`,
`metrics_15s` and every `profiles*` table have no tenant column of any kind, and the one
tenant-shaped column that does exist (`oid`, on the three `tempo_*` tables) is never
written by the OSS insert service.

**Status:** spec · tenancy work-stream · replaces `_drafts/tenancy.md`
**Depends on:** P0 (stack, `10-ops-retention-billing.md`), P1 (ingest, `02-ingest-gateway.md`)
**Blocks:** P2 (metrics), P3 (logs), P4 (traces), P5 (alerts), P6 (raw PromQL)

**Commits this was written against.** `openpanel` `247744a835fcaf37e4a98304d6b77fd3d35e0633`;
`gigapipe` `d4b91b1a9dff4e05dc310c2629114c42beeb61a4` (`v5.4.1-1-gd4b91b1`, vendoring
`github.com/prometheus/prometheus v0.314.0`, `go.mod:44`). Every `path:line` below was
opened in this session at those commits. When either repo is bumped, re-run the citation
pass against the diff rather than the date. Claims that could not be settled from disk are
marked **UNVERIFIED** with the command that settles them.

---

## Decisions

### D1. Label enforcement, not a database per project

**Chosen:** one ClickHouse database (`gigapipe`) shared by all projects; isolation by a
mandatory label.
**Rejected:** one gigapipe database per project.

The usual justification — "the reader binds one database at boot" — is the *weaker*
argument and slightly wrong. The precise facts:

- The reader builds one process-global registry at boot from every entry in
  `config.Cloki.Setting.DATABASE_DATA` (`reader/registry/registry.go:53`), and the only
  implementation of `GetDB(ctx)` **ignores its `ctx` entirely** and returns
  `s.databases[s.rand.Intn(len(s.databases))]` (`reader/registry/static.go:33-37`).
  Multiple entries are a replica pool, not tenants.
- `GetDB` is called roughly five times inside a single `query_range`
  (`reader/service/query_range.go`), so with N per-project entries one query would read
  from a *uniformly random* project's database on each call. The result is not "no
  isolation"; it is **nondeterministic cross-tenant reads inside one response**.
- Meanwhile the writer's `X-CH-DSN` **would** route correctly: it is matched against
  `svc.GetNodeName()` in `writer/service/registry/static.go:55-68`. So a per-project
  `DATABASE_DATA` config writes to the right place and reads from the wrong one. A
  half-working config that silently cross-reads is worse than no isolation at all.
- The reader's services and controllers are singletons constructed at route-registration
  time with the registry already embedded (`reader/router/select_labels.go:10-21` and its
  six siblings), and `reader/config` holds a single package-global `Cloki`. Even a fork
  that made `GetDB` ctx-aware would still have one config and one route table per process.
  Database-per-project therefore means **one gigapipe process per project**.
- The dormant `plugins.RegisterDatabaseRegistryPlugin` hook (`reader/plugins/plugins.go`)
  is **out of scope**: it is discarded by `Init()` even when registered, has no registrant
  anywhere in the tree, and the neighbouring writer TODO (`writer/plugin/qryn_writer.go:65`)
  confirms dynamic registries are unimplemented upstream. Using it means forking an
  AGPL-3.0 dependency.

Write it in the plan as: *impossible on the read path **and** unsafe to half-attempt.*

`X-CH-DSN` is **not** a DSN on the request path. It is an opaque node selector matched
against boot-configured node names, with a **fail-open random fallback** when nothing
matches (`static.go:65-68`), re-randomised per getter call. Never describe it as a tenancy
boundary. (§ "Header hygiene" says why the gateway must still strip it.)

### D2. The canonical label is `op_project_id`; the reserved prefix is `op_`

**Chosen:** `op_project_id`, with the whole `op_` prefix reserved and stripped on ingest.
**Rejected:** `__tenant__`, `project_id`, `org_id`. Also **rejected: `openpanel_` and an
exact-name reserved set**, which a reviewer proposed on the grounds that `op_name`,
`op_code`, `op_id` and `op_type` are real instrumentation conventions and stripping them is
customer-visible data loss.

That objection is correct on its facts and I am accepting the cost rather than the rename,
for one asymmetric reason: **widening a reserved namespace later is free, narrowing it
later is a breaking change.** The strip happens at ingest and is never stored, so going
from `{op_project_id, op_org_id}` to `op_*` costs nothing technically — but by then
customers are shipping `op_code` and we would be deleting attributes that worked
yesterday. Reserving wide first and never narrowing is the only direction that has no
migration in it. `02-ingest-gateway.md:768-776` is already written against
`RESERVED_PREFIX = 'op_'`, and the three-form `isReserved` there removes the "which
sanitizer applies" reasoning from the boundary entirely.

The cost is therefore **documented and accepted, not overlooked**: an ingest payload's
`op_*` attributes are removed, the OTLP `partial_success` message names them, and
`openpanel_telemetry_ingest_stripped_total` carries the sanitized key so support can see
it. This is reversible in exactly one direction; Q6 is now **decided** rather than measured.

#### D2a. The one exception: a closed set the *gateway* re-attaches

**Added in this revision.** The reserved namespace is stripped from **client-supplied**
attributes. It is not a namespace OpenPanel refuses to write. A reviewer reading D2 and D7
together with `02-ingest-gateway.md` §6.0's unconditional `scrubAttrs` would conclude that
every `op_*` attribute dies at the gateway on every signal — and if that ships as written,
**every trace loses its session and profile correlation**, silently, which is the one
capability the plan claims no Grafana stack can offer.

So the rule is stated here, once, in the document that owns the namespace:

> **Strip is for input. A named, closed set is re-attached by the gateway, from a snapshot
> taken before the strip.** The set is exactly:
>
> | key | re-attached at | bound |
> |---|---|---|
> | `op_project_id` | resource (all signals) + every metric data point (§4.1) | one pair, from the authenticated token |
> | `op_session_id` | **spans only**, and only a span with empty `ParentSpanId` or one that arrived carrying `op_root="1"` | ≤ 64 bytes; ≤ `TELEMETRY_MAX_CORRELATED_SPANS_PER_TRACE` (4) spans per trace per request (`06-traces-and-correlation.md` T17) |
> | `op_profile_id` | same | ≤ 256 bytes; same cap |
> | `op_exception_type` / `op_exception_message` | **spans only**, lifted by the gateway from the first `exception` span event (`06-traces-and-correlation.md` §4.1 step 4) | 256 chars each |
> | `op_root` | **never persisted** — a transport marker, read in step 2 and dropped | — |
>
> Everything else beginning `op_`, on every signal and at every level, is removed with no
> restore. In particular `op_session_id` and `op_profile_id` on a **metric data point**, a
> **metric resource** or a **log record** are removed and *not* restored
> (`06-traces-and-correlation.md` T11): on metrics and logs the label set *is* the
> `time_series` fingerprint, so one series per session is a cardinality bomb; on traces the
> attribute is a GIN row on a table that is already per-span.

The ordering is load-bearing and is specified in `06-traces-and-correlation.md` §4.1 steps
1–2: **snapshot → strip → stamp → restore-bounded.** `02-ingest-gateway.md` §6.0's
`scrubAttrs` must take the snapshot before it strips, and must carry this list; today it
carries neither. That is an edit this document is asking for, recorded in Interfaces.

### D3. The reserved-key predicate is unconditional — raw key **and** both sanitized forms

**Changed in this revision.** The draft of this decision was `isReservedKey(name, protocol)`:
apply the transform gigapipe will apply on *that* path, then test the `op_` prefix. That is
now withdrawn. `02-ingest-gateway.md` §6.0 argues the per-protocol form is wrong and it is
right, on the one path that matters:

> the traces path has no sanitizer, so under a literal reading a span attribute
> `op.project.id` would *not* be stripped — it starts with `op.`, not `op_` — and would land
> in the trace tag index under the raw name and inside the `proto.Marshal`ed `payload`, which
> is exactly the lie the traces strip exists to prevent.

**Chosen:** `isReservedKey(key)` — one parameter, testing the raw key and both sanitized
forms, on every signal. Over-stripping costs two regex passes per attribute and removes the
entire "which sanitizer applies here" question from the boundary.
**Rejected:** the per-protocol form, and any alias table (`11-testing-strategy.md` E5b
asserts the source contains no alias array — the predicate is computed, never enumerated).

The transforms still have to be reproduced faithfully, because they are what makes the
prefix test meaningful. `SanitizeKey` (`writer/utils/unmarshal/otlplogs.go:107-117`) maps
every rune outside `[a-zA-Z0-9_]` to `_`; `sanitizeLabels`
(`writer/utils/unmarshal/unmarshal.go:274-282`) applies `(^[^a-zA-Z_]|[^a-zA-Z0-9_])` → `_`
to label names. So `op.project.id`, `op-project-id` and `op project id` all become
`op_project_id` in storage on the metrics and logs paths — and on traces they stay verbatim,
which is precisely why the raw key is tested too.

**Consequences another document must reflect:** `01`'s own T1.2 asserted
`isReservedKey('op.project.id','otlp-traces') === false`. That row is **wrong** and is fixed
below. The predicate's name is `isReservedKey` (per `11-testing-strategy.md`) and its home is
`packages/gigapipe/src/labels.ts` (per D11); `02-ingest-gateway.md` §6.0 currently declares
`isReserved` in `apps/api/src/telemetry/labels.ts`, which is a fourth location for one
function — see D11.

### D4. The label value is a validated project id — `^[a-zA-Z0-9_-]{1,100}$`

**Chosen:** `op_project_id = Project.id`, gated by `^[a-zA-Z0-9_-]{1,100}$` at every stamp
and every compile, failing **closed** and **loudly**.
**Rejected:** a hash of the project id; a new `Project.telemetryId` column.
**Changed from the draft:** the draft specified `^[a-z0-9][a-z0-9_-]{0,62}$`. Both sibling
specs had already coded against `^[a-zA-Z0-9_-]{1,100}$`
(`02-ingest-gateway.md` D13, `04-read-path.md:2099`), and 100 is the bound that actually
matters — `sanitizeLabels` truncates a value *longer* than 100 to `value[:100] + "..."`
(`unmarshal.go:277-279`), so exactly 100 is safe. The draft's extra 37 characters of
margin and its lowercase restriction bought nothing and would have failed closed on a
legitimate 70-character slug. **Converge on `^[a-zA-Z0-9_-]{1,100}$`.** It is still
metacharacter-free, which is the property the compilers depend on.

`Project.id` is **not** a UUID in practice. Every creation path supplies an explicit id
from `getId('project', name)` (`packages/trpc/src/routers/project.ts:176`,
`packages/trpc/src/routers/onboarding.ts:114`,
`apps/api/src/controllers/manage.controller.ts:110`), which is `slug(name)` —
`slugify(name, { lower: true, strict: true, trim: true })`
(`packages/db/src/services/id.service.ts:9`, `packages/common/src/slug.ts:3-19`). The
schema default `gen_random_uuid()` (`packages/db/prisma/schema.prisma:257`) is dead.

**Rejected: hash the project id.** It removes the malformed-value hazards, but every log
line, span attribute and metric series in ClickHouse then carries an opaque token nobody
can read during an incident, and `WHERE op_project_id = ?` from a support session stops
being possible without a lookup. `deleteTelemetryFromClickhouse`
(`10-ops-retention-billing.md:1078`) reads the same value. Validation closes the hazards
anyway.

**Rejected: a new `Project.telemetryId` column.** A second identity for the same object,
a migration, a backfill and a lookup on the ingest hot path, to solve what a regex plus
D5 solve.

### D5. Project ids are made **non-reusable**, because the label value is a reusable slug

**Chosen:** a `ProjectIdTombstone` row written at hard-delete time, consulted by `getId`.
**Rejected:** relying on purge-on-delete alone.

This is the largest correction a reviewer found and it is a real cross-tenant read produced
by the design, not by a bug:

1. `project.delete` only sets `deleteAt` (`packages/trpc/src/routers/project.ts:207-231`).
2. `cron.delete` hard-deletes the Postgres row via `deleteProjects`
   (`apps/worker/src/jobs/cron.delete.ts:47` → `packages/db/src/services/delete.service.ts:15-37`).
3. `getId` collides only against **live** rows (`id.service.ts:19-23`), so once the row is
   gone the slug is free again — including to a *different organisation*.
4. Nothing deletes the ClickHouse telemetry under that `op_project_id` today.

So "Acme Prod" is deleted, someone else creates a project called "Acme Prod", gets
`id = 'acme-prod'`, and inherits the deleted project's metrics, logs and traces. An
organisation with no `org:admin` member is hard-deleted with **no `deleteAt` grace at all**
(`cron.delete.ts:17-19`), so the window can be zero.

Two independent fixes, and both are required, because they close different things:

- **The tombstone is the boundary.** It is a synchronous Postgres constraint. It does not
  depend on an asynchronous ClickHouse mutation having completed.
- **The purge is the data-protection and cost control.** It is specified and owned by the
  ops stream as `deleteTelemetryFromClickhouse(projectIds)`, called from *inside*
  `deleteFromClickhouse` so both call sites — `cron.delete.ts:46` and the admin CLI
  `admin/src/commands/delete-organization.ts:191`, which is the GDPR-erasure path — get it
  (`10-ops-retention-billing.md:1078-1095`).

Purge alone is not sufficient: `deleteFromClickhouse` runs with
`lightweight_deletes_sync: '0'` (`delete.service.ts:68`), i.e. fire-and-forget, and
`ALTER … DELETE` on the gigapipe tables is an asynchronous mutation. A boundary that
depends on a mutation finishing before an unrelated user picks a project name is not a
boundary.

**Ownership gap, flagged in this revision and still open.** `08-schema-changes.md` §0's
Postgres inventory runs P1–P10 across six migration files and claims to own "Every Prisma
enum, model and field addition". `ProjectIdTombstone` is **not in it**, and neither
`packages/db/src/services/id.service.ts` nor `deleteProjects`' tombstone write appears in
that document's "non-migration code that must change with the schema" table. This document
cannot add rows to another document, so the ask is recorded explicitly: **`08` must absorb
`ProjectIdTombstone` as P11, with its own migration file, the §3.3 backfill, the two
non-migration call sites, and a row in §16's rollback table** — or D5 must be re-owned and
this document told where it went. Until one of those happens, F8 has a control that no
schema work-stream is scheduled to build. Sequencing note: the tombstone gates P1, not P2 —
a slug reissued before the model exists is unrepairable after the fact.

### D6. Per-signal stamping levels, because gigapipe's attribute precedence is not uniform

**Chosen:** metrics stamp **every data point *and* the resource**; logs stamp **resource**
and strip resource + scope + record; traces stamp **resource** and strip span.
**Rejected:** "stamp the resource attribute" as a single rule — on metrics a resource
attribute never becomes a series label at all.
**Changed from the draft:** the draft said metrics stamp *only* data points and strip at
resource. That is wrong, and the reviewer who caught it is right that it would have made
a Tier-1 gate unpassable. See the Design section, "OTLP metrics: `target_info`".

### D7. Strip-then-append, never append-alone

**Chosen:** remove every occurrence of a reserved key, then append exactly one
authoritative pair.
**Rejected:** appending alone. gigapipe *keeps* duplicate labels on remote-write and Loki
push, and *concatenates* duplicate OTLP attribute keys with `";"`
(`writer/utils/unmarshal/otlp_metrics.go:98-116`).

**Where D2a fits.** "Append exactly one authoritative pair" is the tenancy pair. On the
trace path the gateway appends up to four more, from the D2a set, *after* the strip and from
a snapshot taken *before* it — so the invariant D7 actually guarantees is: **for every
reserved key, the value that reaches gigapipe is one the gateway chose.** Never a
client-supplied one, never two of them. That is the sentence a test should assert against,
not "every `op_*` attribute is absent".

### D8. The gateway constructs every outbound request; nothing is proxied

**Chosen:** an exact-path allowlist (`packages/gigapipe/src/routes.ts`) and a from-scratch
outbound request — no client headers, no client query string, no client path.
**Rejected:** a reverse proxy with a path prefix. gigapipe registers read and write routes
on one root `*mux.Router` with no prefix, and in `MODE=all` that includes the Elastic
wildcard **write** routes `POST /{target}/_doc`, `PUT /{target}/_doc/{id}`, `POST /_bulk`
(`writer/router/elastic.go:9-14`). It also registers remote-write on **five** aliases
(`writer/router/prom.go:9-13`: `/v1/prom/remote/write`, `/api/v1/prom/remote/write`,
`/prom/remote/write`, `/api/prom/remote/write`, `/api/prom/push`). There is no prefix that
separates read from write.

### D9. Structurally unscopable endpoints are blocked, not "used carefully"

`/api/v1/metadata`, `/api/v1/query_exemplars`, `/loki/api/v1/label`, `/loki/api/v1/labels`,
`/loki/api/v1/tail`, `/loki/api/v1/index/stats`, the four `LOG_DRILLDOWN` routes,
`/tempo/api/search/tags` + `/api/search/tags`, `/tempo/api/search/tag/{tag}/values` +
`/api/search/tag/{tag}/values`, `/api/metrics/query_range` + `/api/metrics/query`,
`/api/traces/{traceId}/json`, `/tempo/api/echo` + `/api/echo`, and all `/pyroscope/*` and
`/querier.v1.QuerierService/*` routes. This list is **not** an exhaustive inventory of
gigapipe's route table — the allowlist makes everything unlisted unreachable by
construction, which is the actual control. It enumerates the routes an implementer would
plausibly be tempted to proxy.

**Cross-stream conflict, resolved here in this document's favour.** `05-logs.md` D8 requires
`LOG_DRILLDOWN=true` "in every deployment" and maps its `logs.labels` procedure onto
`GET /loki/api/v1/detected_labels`. That route is on this list and `04-read-path.md` D3
removes it from `GIGAPIPE_ROUTES`, so as written `logs.labels` is unreachable under both the
env manifest and the allowlist — a procedure with no transport. The tenancy position holds:
`QueryVolume` string-interpolates the caller's `targetLabels` list into a
`sum(bytes_over_time(…)) by (…)` expression and **re-parses the result**, which is a query
*construction* surface, not a parameter; `05-logs.md` I6 independently derives a working
cross-tenant injection string for it. A route that re-parses text we assembled from client
input is exactly the class D8 exists to keep outside the boundary.

**Therefore:** `LOG_DRILLDOWN=false` (`10-ops-retention-billing.md` §3 already sets this,
and is right), the four routes stay blocked, and **`05-logs.md` must derive label and
cardinality metadata from the direct-ClickHouse metadata service `04-read-path.md` §9 already
builds** — which is where every other label/series/values read in the plan already comes
from, so it is a re-target, not new work. `05-logs.md` D8's first paragraph and §5.3's
`logs.labels` mapping need the corresponding edit; recorded in Interfaces. If a future phase
genuinely wants the drilldown routes, the price is: amend D9 here **and** `04-read-path.md`
D3, and promote `05-logs.md` I6's validator from an observation to a hard requirement with
its own test row.

### D10. Trace-by-id is guarded by a direct ClickHouse ownership read, not by TraceQL

gigapipe's TraceQL dialect has **no trace-id intrinsic** — `getTerm`
(`reader/traceql/traceql_transpiler/clickhouse_transpiler/attr_condition.go:151-221`)
handles `duration`, `name`, `status`, `kind`, `statusMessage`, `rootServiceName`,
`rootName`, `nestedSet*` and prefixed attributes, and everything else falls to
`return nil, fmt.Errorf("unsupported attribute %s", key)` at `:221`. A scoped TraceQL
pre-check is not expressible.

### D11. `packages/gigapipe` is one package, split by **layer**, not by file

**Chosen:** the split `04-read-path.md` D1 proposes, adopted verbatim. Tenancy owns
`src/labels.ts`, `src/query/*.ts`, and the **ingest keys** of `src/routes.ts`; the
read-path work-stream owns `src/config.ts`, `src/transport.ts`, `src/errors.ts`,
`src/types.ts`, `src/lease.ts`, `src/read/*.ts`, `index.ts`, and the **read keys** of
`src/routes.ts`.
**Rejected:** the draft's `src/client.ts`, which is deleted. Its two responsibilities split
cleanly — the allowlist is data (`src/routes.ts`), the request execution is
`src/transport.ts`.
**Rejected:** two packages, and read-path owning the compilers. The security argument in
"Why structured-spec-first is enough" only holds if exactly one function emits a `{`.

**One home per symbol, settled here.** `isReservedKey`, `sanitizeOtlpKey`,
`sanitizeLabelName`, `enforceLabelPairs` and `assertProjectLabelValue` live in
`packages/gigapipe/src/labels.ts` and nowhere else. `02-ingest-gateway.md` §6.0 declares the
same predicate in `apps/api/src/telemetry/labels.ts` under the name `isReserved`, and
`02-ingest-gateway.md` §6's attribute walk imports it from there; that is a second
implementation of the strip predicate, in the one place where two implementations are
guaranteed to drift. `apps/api/src/telemetry/labels.ts` may exist as a **re-export** of
`@openpanel/gigapipe` (which is how `02`'s `./deps` shim already works for `ClientType` and
`getClientByIdCached`), never as a second definition. Recorded in Interfaces as an edit
`02-ingest-gateway.md` owes.

### D12. On the read path the project id **and, on any share path, the query spec** are derived, never received

`04-read-path.md`'s `observabilityProcedure` (`04-read-path.md` §6.1) is the single
tenancy-bearing middleware **on the `observability.*` router**. In P2 it **rejects `shareId`
outright**, because no `Report` row can carry a metric series yet. When the share path is
enabled it must satisfy the rule below — the draft got this wrong and the failure was severe
enough to be worth naming explicitly.

**Scope correction made in this revision, and it is the important half.** "Telemetry is never
share-reachable" is *not* a property of `observabilityProcedure`, because
`observabilityProcedure` only guards one router. `09-ui-surfaces.md` D5 routes **saved**
metric reports through `chart.chart` — i.e. `chartProcedure`, a `publicProcedure` that serves
anonymous viewers whenever `shareId` is present — and `03-metrics-engine.md` §15 makes that
the plan of record for P2.5. The moment `Report.dataSource` ships, a public share link is a
telemetry read path that this document's middleware never sees.

That is not a hypothetical: `packages/trpc/src/trpc.ts:198-211` keys the 60 s response cache
on `` `trpc:${path}:` `` plus `JSON.stringify(rawInput)` with **no user, session or share
component** (verified), and `09-ui-surfaces.md` §6 confirms `chart.chart` merges
caller-supplied `range`/`startDate`/`endDate`/`interval` over `ctx.report`. So one share link
hands an unauthenticated caller window control, cache-key control, and an unmetered,
unrate-limited query generator pointed at a single Go process whose PromQL engine has a
hardcoded non-configurable 30 s timeout and one global `MaxSamples` budget shared across every
tenant (`reader/router/prometheus_query_range.go:31-32`). Cross-tenant denial of service, no
credential required.

**The tenancy requirement on whichever document owns `Report.dataSource` on the share path**
— and one must be named before it lands, because today none is:

1. §7.1's four-field window allow-list (`range`, `startDate`, `endDate`, `interval`), with an
   explicit `isMetricReport(ctx.report)` check and **no** fallback to `input.series`.
2. `rateLimitMiddleware` keyed on `shareId` + trusted IP on **every** share-served chart
   procedure, not only the metric one — `03-metrics-engine.md` §12.5 already calls this "a
   hard prerequisite"; `09-ui-surfaces.md` §6 does not list it.
3. A separate `withProjectLease` bucket for share traffic, as `07-alerting.md` D15 does for
   alert evaluation, so anonymous readers cannot consume the authenticated budget.
4. A Tier-1 test that a share link cannot vary `series`, `filters` or `breakdowns`.

Until all four exist, `Report.dataSource = 'metric'` must not be reachable through a share.
Tracked as F12 and Q9.

### D13. `op_project_id` is invisible in the product, but survives aggregation internally

Stripped from every response label set before it reaches `FinalChart`; excluded from label
pickers, breakdown options and autocomplete. **But the compiler keeps it in the `by (…)`
list of every aggregation**, so the response-side check has something to assert on. See
"Response-side verification".

### D14. Rejected: an internal OpenTelemetry Collector between `apps/api` and gigapipe

A reviewer is right that this deserves a stated rejection rather than silence — OTel is
not foreign here (`@hyperdx/node-opentelemetry` is already a dependency of `apps/api:28`,
`apps/worker:16` and `packages/logger:10`), and a `transform` processor stamping at
`datapoint`/`resource`/`log` context plus an `attributes` processor deleting `op_*` would
delete most of the ingest rewrite work.

It loses on two things. **Auth:** the tenancy label is derived from a per-project secret
verified against Postgres with argon2. The Collector has no authenticator extension that
can do that, so it would need a custom Go extension — which is a Go service to build,
ship and secure, i.e. the work we avoided, plus a new deployment surface. **Protocol
coverage:** two of the five ingest legs are not OTLP. Prometheus remote-write and Loki
push have no Collector receiver→processor path that preserves their label model, so they
would need the in-process rewrite anyway and we would maintain two enforcement
implementations — which is exactly the condition D11 rejects.

---

## Decisions added in this revision

These five settle conflicts that only became visible when the eleven specifications were read
together. Each changes something another document currently states; the required edits are in
Interfaces.

### D15. Logs are **decoded and rebuilt**, not forwarded — `05-logs.md` D1 wins

**Chosen:** `apps/api` decodes OTLP-logs (and Loki push) itself, discards gigapipe's OTLP
label model entirely, constructs a closed allowlisted stream-label set plus a JSON envelope,
and pushes **Loki JSON** to `POST /loki/api/v1/push`.
**Rejected:** `02-ingest-gateway.md` D3/§6.2's rewrite-the-protobuf-in-place-and-forward-to-
`/v1/logs` design, which this document's §4.4 and §4.8 were written against.

Two mutually exclusive log-ingest architectures were on disk for the same route, with
different tenancy-enforcement surfaces and no shared owner. `05-logs.md` D1 is right and the
mechanism is verified from source in this session:

- `otlpLogDec.Decode` (`writer/utils/unmarshal/otlplogs.go:22-58`) folds resource, scope
  **and record** attributes into one `attrsMap` and then adds `trace_id` and `span_id` on top
  (`:52-57`). Every one becomes a stream label.
- The fingerprint is computed over the whole surviving label set (`builder.go:351`,
  `fingerprintLabels` at `unmarshal.go:250-271`). So **one trace id is one new fingerprint** —
  one `time_series` row and one `time_series_gin` row *per label* per stream per day. At 10k
  lines/s with trace context that is ~10k new series/s, for every tenant on the shared
  instance. There is no configuration that disables it.
- The OTLP log path never calls `sanitizeLabels`, so it has no 100-byte value truncation: a
  4 KB attribute becomes a 4 KB label value.

**What this changes in *this* document.** §4.4's analysis of record-attribute precedence stays
— it is now the *justification* for not forwarding OTLP logs, rather than a rule about a body
we forward. §4.8's OTLP-logs row is retargeted to the constructed-stream model. T1.5 and T1.6
are re-derived against the envelope builder rather than a forwarded protobuf. The tests that
matter on the log path are now `sanitizeAttrKey`, the envelope's reserved-key deletion, and
the label allowlist — none of which has a test row anywhere today, which is itself a finding.

**Two consequences other documents must absorb.**

- `02-ingest-gateway.md` §1's "not exposed" table, §6.2, and its Interfaces guarantee to the
  schema stream all rest on "this gateway does not expose `/loki/api/v1/push`". `05-logs.md`
  §4.1 *does* expose `POST /telemetry/loki/api/v1/push` to customers. The `type ∈ {1,2}`
  invariant that `08-schema-changes.md` S13 and `10-ops-retention-billing.md` D10 build the
  per-signal TTL totality argument on therefore needs **re-deriving from a different
  premise**, and it survives: type 0 is produced only by the `tp == 3` collapse, which needs a
  Loki value tuple carrying **both** a string at index 1 and a number at index 2
  (`writer/utils/unmarshal/unmarshal.go:146-165`, `:218-228` — both verified). OpenPanel's
  envelope writer emits two-element tuples `["<ns>", "<envelope>"]` and nothing else, so
  `tp == 1` always. **The invariant is now enforced by our own writer never emitting value
  index 2, not by a route not existing** — which needs a regression test on `pushLogs`, and is
  a strictly better control because it does not depend on what we expose.
- P1's route table should open `/telemetry/v1/metrics` and `/telemetry/api/v1/write` **only**.
  The logs and traces routes are opened by the phases that own their shaping: the per-signal
  rewrite rules for logs (this decision, plus `06-traces-and-correlation.md` T11/T12) and for
  traces (T11/T12/T17, the `LogRecord.SpanId` zeroing, the correlation cap) are costed inside
  P3 and P4 and appear **zero times** in `02-ingest-gateway.md`. Accepting spans and log
  records in P1 under P1's rules writes rows that P3/P4 cannot repair — a mis-stamped series
  "is not repairable, only deletable" (Effort), and `06-traces-and-correlation.md` T21 says a
  span written without the project label is "permanently invisible to every read **and**
  permanently undeletable". Deferring two routes costs nothing; opening them early cannot be
  undone.

### D16. `/telemetry` is CORS-**denied** by a third branch — `02-ingest-gateway.md` D16 is factually wrong

**Chosen:** `05-logs.md` D11 verbatim — a `corsDeniedPaths = ['/telemetry']` list, evaluated
**before** the `corsPaths` check, returning `{ origin: false }`.
**Rejected:** `02-ingest-gateway.md` D16's "`/telemetry` is added to `corsPaths` so a browser
cannot reach it cross-origin", which this document's §6 previously cited as a settled control.

Verified at `apps/api/src/app.ts:109-125` in this session. Membership in `corsPaths` is the
**restricted** branch: `const isPrivatePath = corsPaths.some(...)`, and if true the origin is
pinned to `dashboardOrigins` **with `credentials: true`**. Everything else falls through to
`return callback(null, { origin: '*', maxAge: 86_400 * 7 })`. So:

- adding `/telemetry` to `corsPaths` makes the dashboard origin an *allowed* credentialed
  cross-origin caller — the opposite of a block;
- omitting it leaves `/telemetry` reachable from every origin on the internet, exactly like
  `/track`.

Under either reading of D16 there is no browser backstop at all. That matters here more than
on any other route: the telemetry secret is the sole input to `op_project_id`, and the stated
purpose of the control is to stop a customer pasting one into front-end JavaScript.
`02-ingest-gateway.md` D16 must be rewritten to say membership in `corsPaths` is
*permissive-for-the-dashboard*, and the third branch adopted. `05-logs.md`'s router test —
`OPTIONS /telemetry/v1/logs` with an arbitrary `Origin` is rejected while `/track` still gets
`origin: '*'` — is the enforcement and is kept.

### D17. One name per thing, and `10-ops-retention-billing.md` §3 is the register

**Chosen:** the OpenPanel-side env surface is `GIGAPIPE_URL`, `GIGAPIPE_USER`,
`GIGAPIPE_PASSWORD`, `GIGAPIPE_DB`, `GIGAPIPE_CLUSTER`, mapped onto the gigapipe service's own
`CLOKI_LOGIN` / `CLOKI_PASSWORD` in the compose block **and nowhere else**. `GIGAPIPE_URL` is
also the single capability flag: `isTelemetryEnabled() = !!process.env.GIGAPIPE_URL`.
**Rejected and to be deleted wherever they appear:** `GIGAPIPE_INTERNAL_URL`,
`GIGAPIPE_READ_URL`, `GIGAPIPE_WRITE_URL`, `GIGAPIPE_LOGIN`, `GIGAPIPE_USERNAME`,
`GIGAPIPE_CLUSTER_NAME`, `GIGAPIPE_CLUSTERED`, `CLICKHOUSE_CLUSTER_NAME`,
`TELEMETRY_CLICKHOUSE_DATABASE`, and `05-logs.md` D12's derivation of the capability flag from
`GIGAPIPE_READ_URL` (no other document consumes a read/write URL split).

Five naming schemes for one base URL is not a style problem here. `cmd/gigapipe/main.go:172-183`
reads both `QRYN_*` and `CLOKI_*` with `CLOKI_*` winning, and basic auth installs **only when
both** username and password are non-empty (`:321-324`); `10-ops-retention-billing.md` D2
records that Compose substitutes a missing `.env` key with the empty string plus a warning. So
a mismatch between the name the compose service sets and the name the boot assertion checks
yields a **silently unauthenticated gigapipe** — which is the exact failure D2 says network
isolation exists to backstop, now unbackstopped.

`10-ops-retention-billing.md` owns `.env.template`, `coolify.yml` and `quiz.ts`, so its names
are the ones that become real and its §3 table is normative. Its §3.1 currently claims
`04-read-path.md` §3 is the authority and lists names that document does not use — that
cross-document edit list is stale and should be inverted: publish the list in `10`, and make
`04` §3's table match it. `11-testing-strategy.md` gate 1.7 must test `GIGAPIPE_URL`, not
`GIGAPIPE_INTERNAL_URL`.

### D18. One kill-switch namespace, one polarity: `telemetry:disabled:*`

**Chosen:** presence of a Redis key means **disabled**, in the `telemetry:disabled:` namespace
`02-ingest-gateway.md` §4 defines and `10-ops-retention-billing.md` §10.3 already writes,
extended with a read-side pair so the two signals can be stopped independently.

| key | stops | TTL |
|---|---|---|
| `telemetry:disabled:*` | all ingest, all projects | mandatory when written by automation (`10`'s disk guard sets 1 h); optional for a human incident block, which then needs a ticket |
| `telemetry:disabled:{projectId}` | ingest, one project | **mandatory**, 1 h default, 24 h max |
| `telemetry:disabled:read:*` | every `observability.*` read + saved-metric-report reads, all projects | as above |
| `telemetry:disabled:read:{projectId}` | reads, one project | **mandatory** |

The `read:` segment cannot collide with a project id: `:` is outside
`^[a-zA-Z0-9_-]{1,100}$`, so `telemetry:disabled:read:{projectId}` is unreachable from the
per-project ingest form. The one ambiguous key, bare `telemetry:disabled:read`, is never
written (a project literally named `read` would produce it).

**Deleted by this decision:** §11's own `telemetry:ingest:enabled` / `telemetry:read:enabled`
(positive polarity — an operator who deletes the key to "turn it off" turns it *on*);
`04-read-path.md` D15's `op:gp:off` / `op:gp:off:<projectId>` (renamed onto the rows above,
its read/ingest split kept because its reasoning is right: a read-path enforcement bug must
not stop correctly-stamped ingest); `06-traces-and-correlation.md` §15's
`GIGAPIPE_TRACES_READ_ENABLED` / `GIGAPIPE_TRACES_INGEST_ENABLED` env vars (an env var is not
a kill switch — it needs a deploy); and `05-logs.md` D12's "unset `GIGAPIPE_READ_URL`" as a
kill switch (it is a deployment switch, per D17).

Ingest refusal is **503 + `Retry-After: 900`**, per `02-ingest-gateway.md` §4 — recoverable,
and exporters back off rather than drop. Read refusal is `TRPCTooManyRequestsError` and the UI
renders "telemetry temporarily unavailable", never an empty chart. The operator table lives in
`10-ops-retention-billing.md` §10.3, which is the document an on-call engineer opens; all four
rows must appear there, not two.

### D19. `zMetricQuery` is defined **once**, in `03-metrics-engine.md` §2

**Chosen:** `03-metrics-engine.md` §2's schema body is canonical. This document's §7.2 keeps
only the two reserved-prefix refinements it owns and points at `03` for the rest.
**Rejected:** this document's own earlier definition, and the third shape `09-ui-surfaces.md`
D3 describes while claiming to consume `03` "verbatim".

Three incompatible definitions were on disk and a fourth was implied by the tests. `03`'s wins
on merits, not seniority: it is the only one whose `fn` set is proved to be a subset of
gigapipe's accelerated `rangeFns`/`aggFns`; it is the object the chart builder persists; and it
is the only one that removed `topk`/`bottomk` from `aggregation`, which `03` D4/D8 depend on.
Its `fn` enum has **eleven** members including `last_over_time` and excluding `irate`/`deriv`;
`aggregation` is `sum|avg|min|max|count`; `metricType` is required and has **four** values
including `summary`; it carries `type`, `id`, `scale`, `displayName` and `hideSeries`; and its
filter type is **`zMetricLabelFilter`** with `operator: 'eq'|'neq'|'re'|'nre'`.

**There is no `zMetricMatcher` and no `seriesLimit` anywhere in the plan.**
`09-ui-surfaces.md` D3 (`metricType` with three values, `fn` from a five-member set including
`'value'`, `matchers: zMetricMatcher[]` with `op` in `{=, !=, =~, !~}`, `fill`, `seriesLimit`),
its §4.2 nuqs key table (`mt`, `max`), its §4.3 picker defaults and its D9 operator adapter are
all written against a schema that does not exist, and `11-testing-strategy.md` §3.4 Q1–Q3 test
`zMetricMatcher`, which exists only in `09`'s version. Those are edits `09` and `11` owe.
`07-alerting.md` Q1 flags two of the three and can be closed in the same PR; its own stated
position ("P2's, because 03 claims ownership explicitly") is correct, and the answer is the
**current** `03` §2 body, not the one Q1 quotes.

This also settles a sequencing hazard `07` names: the schema must be adopted in **P0**, before
this document writes a line of compiler, or P1 builds the enum that P2 deletes.

---

## Design

### 1. The declaration

One declaration, in `packages/constants/index.ts`, next to `intervals` and `chartTypes`:

```ts
/**
 * The tenancy label. Stamped on every telemetry write and injected as a
 * mandatory equality matcher on every telemetry read. gigapipe is
 * single-tenant; this label is the entire project-isolation boundary.
 *
 * Never change this value. It is baked into every stored series in ClickHouse
 * and into every fingerprint; a rename orphans all historical telemetry and
 * the only repair is the purge in "Rollback and remediation".
 */
export const TELEMETRY_PROJECT_LABEL = 'op_project_id' as const;

/**
 * Reserved label/attribute prefix. Anything a client sends whose key SANITIZES
 * to this prefix (see packages/gigapipe/src/labels.ts) is stripped at the
 * ingest gateway before the payload reaches gigapipe. See D2: this namespace is
 * deliberately wider than the one name, because widening later is free and
 * narrowing later is a breaking change.
 */
export const TELEMETRY_RESERVED_LABEL_PREFIX = 'op_' as const;
```

`11-testing-strategy.md:1411` calls this symbol `OP_PROJECT_LABEL`. That is drift; the name
is `TELEMETRY_PROJECT_LABEL`, which is what `04-read-path.md:2097` consumes.

### 2. Why this name

The name has to be expressible, unescaped and identically, on six surfaces:

| surface | form | binding constraint |
|---|---|---|
| Prometheus label name | `op_project_id` | `[a-zA-Z_][a-zA-Z0-9_]*` |
| PromQL matcher | `op_project_id="…"` | lezer `LabelName { (std.asciiLetter \| "_") (std.asciiLetter \| std.digit \| "_")* }` (`promql.grammar:359`) |
| LogQL stream matcher | `{op_project_id="…"}` | participle `Label_name: [a-zA-Z_][a-zA-Z0-9_]*` (`reader/logql/logql_parser/lexer_rules.go:41`) |
| TraceQL attribute | `resource.op_project_id="…"` | `Label_name: (\.[a-zA-Z_][.:a-zA-Z0-9_-]*\|[a-zA-Z_][.:a-zA-Z0-9_-]*)` (`reader/traceql/traceql_parser/lexer_rules v2.go:36`) |
| OTLP attribute key | `op_project_id` | survives `SanitizeKey` unchanged (`otlplogs.go:107-117`) |
| Loki / remote-write label | `op_project_id` | survives `sanitizeLabels` unchanged (`unmarshal.go:274-282`) |

Rejected alternatives:

- **`__tenant__` / `__op_project_id__`.** Prometheus reserves `__`. Decisively, gigapipe's
  LogQL lexer lists `Macros_function: _[a-zA-Z0-9_]+` **before** `Label_name`
  (`lexer_rules.go:40-41`), so a leading `_` lexes into a different token class. gigapipe
  also already special-cases four `__x__` names at write time (`__ttl_days__` plus three
  `__metric_*__` metadata labels, `writer/utils/unmarshal/builder.go:326-347`), so the
  `__` namespace is not ours.
- **`project_id`.** Collides with a plausible customer attribute and carves out no
  namespace.
- **`tenant` / `org_id`.** The boundary the product enforces everywhere else is the
  *project* (`getProjectAccess`, `packages/db/src/services/access.service.ts:31`), and
  both `client.create` and the ingest path require a non-null `projectId`. An org-level
  scope would be a strictly wider grant than the dashboard can express. Q5 if that changes.

### 3. The value, and the two things that go wrong with a raw slug

**VERIFIED BY EXECUTION** (`slugify@1.6.9` from the local npm cache, run with the exact
options `packages/common/src/slug.ts:4-14` passes):

```
"My Project"       -> "my-project"
"Ünïcødé Prõject"  -> "unicode-project"
"привет"           -> "privet"
"日本語"             -> ""            <-- empty
"!!!"              -> ""            <-- empty, and passes z.string().min(3)
"A"x120            -> "a"x120       <-- 120 chars
"2024"             -> "2024"
```

**(a) Over-length ids are silently unreadable.** `sanitizeLabels` truncates a label *value*
longer than 100 characters to `value[:100] + "..."` (`unmarshal.go:274-282`), on the Loki
push, Loki protobuf, Prometheus remote-write and Influx paths. A 120-character project id
would be stored truncated while the compiler injects the full id — written, never readable.
Fail-closed, but a silent data-loss bug that takes a week to diagnose.

**(b) An empty id is a fail-OPEN primitive on *every* read path.** This is the single
mechanism the whole document is built to defend against, and the draft understated its
reach twice. Read `StreamSelectPlanner.Process`, in full, including line 33 which the
draft elided:

```go
// reader/logql/logql_transpiler/clickhouse_planner/planner_stream_select.go:30-46
var emptyLabels []string
for i := len(s.LabelNames) - 1; i >= 0; i-- {
    if config.Cloki.Setting.ClokiReader.OmitEmptyValues {   // :33  <-- the gate
        break
    }
    if (s.Ops[i] == "=" || s.Ops[i] == "=~") && s.Values[i] == "" {
        emptyLabels = append(emptyLabels, s.LabelNames[i])
        // ...matcher removed from the conjunction...
    }
    if s.Ops[i] == "=~" && s.Values[i] == ".*" {
        // ...matcher deleted with no replacement...
    }
}
```

`processEmptyLabels` (`:84-116`) then turns the collected names into
`simpleJSONHas(labels, 'op_project_id') = 0` — **match every series that does not carry the
tenancy label at all.** An empty project id does not select nothing; it selects the
complement. (When at least one non-empty matcher survives, `processEmptyLabels` AND-joins
the complement against those fingerprints via a `fp_pre_req` CTE, so the leak is narrowed
but still cross-tenant. When *every* matcher is empty, it is unbounded.)

Two corrections to how the draft described this:

1. **It is not LogQL-only.** gigapipe's PromQL optimiser constructs
   `planner.StreamSelectPlanner` — which is a bare embed of the LogQL type
   (`reader/promql/promql_transpiler/planner/stream_select.go:7-9`) — directly from the
   `VectorSelector`'s `LabelMatchers`, in both the range path
   (`optimizer/vector_range.go:87-101`) and the instant/aggregate path
   (`optimizer/vector_agg.go:72-82`). The same branch runs for metrics.
2. **It is config-gated, and the gate is a free second line of defence.**
   `ADVANCED_OMIT_EMPTY_VALUES` (read at `cmd/gigapipe/main.go:159`) sets
   `ClokiReader.OmitEmptyValues`, and when it is true the loop `break`s before either
   rewrite runs. `{op_project_id=""}` then compiles to an ordinary `key='op_project_id'
   AND val=''` clause and matches nothing — **fail closed**.

#### 3.1 Cross-stream decision: `ADVANCED_OMIT_EMPTY_VALUES=true`

The logs work-stream found the same flag and pinned it to the **opposite** value:
`05-logs.md:323` and `:1619` set `ADVANCED_OMIT_EMPTY_VALUES: "false"` so that its
invariant I2's *evidence* (the `=~".*"` deletion behaviour) remains observable. Two
work-streams silently disagreeing about a security-relevant flag is precisely the failure
this document exists to prevent, so it is decided here:

**Set `ADVANCED_OMIT_EMPTY_VALUES=true` in the P0 env manifest.** Reasoning, checked
against source rather than asserted:

- It deletes the empty-value fail-open on both the LogQL and PromQL paths, for one line of
  compose config. `assertProjectLabelValue` remains the primary control; this makes it
  defence in depth rather than the only thing standing between a malformed id and a
  cross-tenant read.
- The cost to `05-logs.md` is bounded to I2's *justification*, not to I2 itself. I2 is a
  compiler rule ("never emit `=~ '.*'`") and it survives, because the hazard it defends
  against is `analyzeStreamSelect`
  (`reader/logql/logql_transpiler/clickhouse_planner/analyze.go:74-88`): if **every**
  matcher is a `.*` regex it sets `noStreamSelect = true`, `StreamSelectPlanner.Process`
  returns `nil, nil` (`planner_stream_select.go:22-24`), and the fingerprint filter
  vanishes — a full cross-tenant scan. That function does not read `OmitEmptyValues` at
  all. I3 is therefore untouched, and I2's rule is re-justified by I3 rather than deleted.
- The semantic cost is that a legitimate raw-LogQL `{foo=""}` or `{foo=~".*"}` changes
  meaning. The structured compilers cannot emit either form, and raw LogQL is out of scope
  in every phase (§ "Raw queries"), so nothing shipped is affected. If raw LogQL is ever
  exposed, this flag must be re-examined in that PR.

**The manifest is where this becomes real, and it is currently empty.** Verified in this
session: `ADVANCED_OMIT_EMPTY_VALUES` appears **zero times** in
`10-ops-retention-billing.md` — neither in §2's compose service definitions nor in §3's
"Every environment variable, and why" table, which is the document that owns both. And
`boolEnv` (`cmd/gigapipe/main.go:54-62`) maps unset to `false`. So what ships today is
`05-logs.md`'s value by default, and this section's defence is absent. Two edits, not one:

1. `05-logs.md:323` and `:1619` change `"false"` → `"true"`, and I2 re-justifies itself from
   I3's `analyzeStreamSelect` path.
2. **`10-ops-retention-billing.md` §3 adds the variable with the value `true`** and a citation
   to `planner_stream_select.go:31-46`, and §2 sets it on **both** gigapipe services.
   `11-testing-strategy.md`'s `test/telemetry/docker-compose.yml` sets it too, and its W7
   source-level compose assertions gain a row for it.

Without (2), (1) changes nothing. Recorded in Interfaces against both documents.

#### 3.2 The guard

```ts
// packages/gigapipe/src/labels.ts
/**
 * Project ids are slugs, not UUIDs (packages/db/src/services/id.service.ts:9 ->
 * packages/common/src/slug.ts:17). slugify(strict) can return "" for a name with
 * no Latin characters, and imposes no length bound.
 *
 * Both matter to gigapipe:
 *  - a value over 100 chars is truncated to value[:100]+"..." by sanitizeLabels
 *    (writer/utils/unmarshal/unmarshal.go:274-282) -> written but never readable;
 *  - an EMPTY value makes the stream planner emit
 *    simpleJSONHas(labels,'op_project_id') = 0 -- every series WITHOUT the label
 *    (clickhouse_planner/planner_stream_select.go:36-40, :84-116). That planner
 *    is reused verbatim by the PromQL optimiser
 *    (promql_transpiler/planner/stream_select.go:7-9, optimizer/vector_range.go:87),
 *    so this is not a LogQL-only hazard.
 *
 * The charset also excludes ", \, newline and every other metacharacter, which
 * is what lets the value be inlined into a PromQL, LogQL or TraceQL
 * double-quoted string with NO escaping in three separate compilers.
 *
 * 100 is the bound because that is gigapipe's truncation point. Matches
 * 02-ingest-gateway.md D13 and 04-read-path.md's Interfaces table exactly.
 */
const PROJECT_LABEL_VALUE_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/;

export class TenancyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenancyError';
  }
}

/** Fail-closed guard. Every stamp and every compile goes through this. */
export function assertProjectLabelValue(projectId: string): string {
  if (!PROJECT_LABEL_VALUE_PATTERN.test(projectId)) {
    throw new TenancyError('Project id is not usable as a telemetry label value');
  }
  return projectId;
}
```

#### 3.3 The three creation paths, and why the guard belongs in `getId`

A reviewer correctly caught that patching `zOnboardingProject` covers two of the three
project-creation paths. The third is the public Manage API, whose body schema is
`zCreateProject` with `name: z.string().min(1)`
(`apps/api/src/controllers/manage.controller.ts:16`, bound at
`apps/api/src/routes/manage.router.ts:85`) — no maximum, and a *lower* minimum. `min(1)` is
strictly worse than `min(3)` for the empty case: a one-character non-Latin name slugs to
`""`.

So the guard goes **into `getId` itself**, where every present and future creation path is
covered by construction, and the zod changes are demoted to input hygiene:

```ts
// packages/db/src/services/id.service.ts   (owned by the ingest/P1 stream)
import { slug } from '@openpanel/common';
import { db } from '../prisma-client';

/**
 * Ids minted here become the op_project_id telemetry label value
 * (docs/observability/01-tenancy-and-security.md D4/D5). Two constraints
 * that are NOT cosmetic:
 *   - the id must match ^[a-zA-Z0-9_-]{1,100}$ or telemetry ingest and read
 *     both refuse the project with a 403;
 *   - a project id must never be REUSED after a project is hard-deleted, or
 *     the new project inherits the old one's telemetry (D5).
 */
const TELEMETRY_SAFE_ID = /^[a-zA-Z0-9_-]{1,100}$/;

export async function getId(
  tableName: 'project' | 'dashboard' | 'organization',
  name: string,
): Promise<string> {
  const newId = slug(name);

  if (tableName === 'project') {
    // Empty and over-length slugs are both reachable from a valid name.
    if (!TELEMETRY_SAFE_ID.test(newId)) {
      return getId(tableName, `${name}-${Math.floor(1000 + Math.random() * 9000)}`);
    }
    // Never hand back a slug any project has ever held. Postgres, synchronous:
    // the telemetry purge is an async ClickHouse mutation and cannot be the
    // boundary.
    const tombstoned = await db.projectIdTombstone.findUnique({ where: { id: newId } });
    if (tombstoned) {
      return getId(tableName, random(name));
    }
  }
  // ...existing live-row collision check and `random(name)` retry, unchanged...
}
```

The suffix retry on a malformed slug is deliberate: `slug('日本語')` is `''` but
`slug('日本語-1234')` is `'1234'`, which is valid — so a non-Latin project name still gets a
usable id instead of a 400 the user cannot act on. Over-length names retry into the same
loop and will keep failing, which is correct: the fix there is `.max(50)` on the input.

The accompanying changes, all owned by other streams and all listed in Interfaces:

1. `zOnboardingProject.project` (`packages/validation/src/index.ts:386`) gains `.max(50)`.
2. `zCreateProject.name` and `zUpdateProject.name`
   (`apps/api/src/controllers/manage.controller.ts:16,27`) gain `.min(3).max(50)` — this is
   a behaviour change on a public API and needs a changelog line.
3. New Prisma model, one migration:

```prisma
/// A project id that has been used and must never be issued again.
/// op_project_id is the telemetry tenancy label; reissuing a slug after the
/// telemetry purge has not yet completed is a cross-tenant read.
/// See docs/observability/01-tenancy-and-security.md D5.
model ProjectIdTombstone {
  id             String   @id
  organizationId String?
  deletedAt      DateTime @default(now())

  @@map("project_id_tombstones")
}
```

`deleteProjects` (`packages/db/src/services/delete.service.ts:15-37`) writes one row per
project inside the same transaction as the `project.delete`. Backfill on migration:
`INSERT INTO project_id_tombstones (id, organization_id) SELECT id, organization_id FROM projects ON CONFLICT DO NOTHING;`
so live projects can never be shadowed by a rename either.

4. A P0 audit, before any telemetry ships:
   `SELECT id, name FROM projects WHERE id !~ '^[a-zA-Z0-9_-]{1,100}$';` Any hit needs a
   product decision (rename, or a per-project opt-out). Tracked as Q1 — and Q1 was previously
   ownerless, which is why the audit query is now also requested as a row on
   `10-ops-retention-billing.md`'s **P0 gate list**, since that document owns the P0 checklist
   and has production access in its scope. A query nobody is scheduled to run is not a gate.

Items 3 and 4 are the ones `08-schema-changes.md` has to take: see D5's ownership note. The
migration is not optional and it is not P2 — a reissued slug before the model exists produces
exactly the cross-tenant read the model prevents, and no later migration repairs it.

### 4. What gigapipe actually does with attributes

There is no single enforcement rule, because gigapipe's five ingest decoders do five
different things. All read in `writer/utils/unmarshal/`.

#### 4.1 OTLP metrics: a resource attribute never becomes a series label — *but it does become `target_info`*

`otlp_metrics.go:122-147` splits resource attributes into exactly two buckets:
`service.name` / `service.namespace` / `service.instance.id` become the `job` and
`instance` labels; **everything else goes into `rs.targetAttrs`** via
`mergeSanitizedAttrs(rs.targetAttrs, "", extraAttrs)` at `:142`.

The stored series' label set is assembled by `seriesLabels` (`:239-268`): scope labels,
then **data-point attributes** (`mergeSanitizedAttrs(merged, "", pointAttrs)` at `:245`),
then `__name__` / `job` / `instance`, then extras (`le`, `quantile`), then the
`__metric_*__` metadata labels. It never reads `targetAttrs` — confirmed by reading the
whole function.

`targetAttrs` has exactly one consumer: `emitTargetInfo` (`:495-517`), which emits a
separate `target_info` gauge whose label set is `targetAttrs` plus `job`, `instance` and
`__metric_type__`.

The draft concluded from the first half that metrics must be stamped **only** at data-point
level, and stripped at resource. That is wrong in a way a reviewer caught precisely:

- Every real OTel SDK sends `telemetry.sdk.*`, `host.*` and `process.*` as **resource**
  attributes, so `emitTargetInfo`'s `len(rs.targetAttrs) == 0` early-return (`:496`) is
  almost never taken. `target_info` is emitted for essentially every client.
- Under the draft's rule that series would carry **no `op_project_id`** — a continuously
  self-generated population of unstamped series, which is exactly the population the
  empty-value fail-open selects, and which makes a Tier-1 gate
  (`count() … WHERE NOT simpleJSONHas(labels,'op_project_id')` = 0) permanently unpassable.
- `target_info` is also the only place a customer's `deployment.environment`, `k8s.*` and
  `cloud.*` are stored. Under the draft's rule it would be permanently unqueryable by its
  owner — a silently broken product feature.

**Corrected rule (D6): stamp at BOTH resource and every data point, strip at all three
levels.** The fix is free and carries no double-label risk, because the two consumers are
disjoint: the resource stamp reaches `targetAttrs` → `target_info` only, and the data-point
stamp reaches `seriesLabels` only. `02-ingest-gateway.md` D3 already says this; the draft
of this document was the outlier.

One consequence to note for the metrics and billing streams: because the stamp guarantees
`targetAttrs` is non-empty, `target_info` is now emitted for resources that would
previously have emitted none. That is one extra series per target per project, which is
what a Prometheus scrape produces anyway — but it is a real, if small, cardinality delta
and it should not surprise anyone reading a series count.

#### 4.2 OTLP metrics: duplicate keys are *concatenated*, not overwritten

`mergeSanitizedAttrs` (`otlp_metrics.go:98-116`) groups by sanitized key and, when two
source keys collapse onto one label name, joins their values with `";"` in lexicographic
order of the original keys. Two attributes named `op_project_id` on one data point produce
`"attacker;real"` — a value that matches neither project. Strip-then-append (D7);
appending alone *corrupts* the label instead of overriding it.

#### 4.3 OTLP metrics: scope attributes are prefixed, so they are not a forgery vector

`otlp_metrics.go:158-169` calls `mergeSanitizedAttrs(scopeAttrs, "otel_scope_", …)`. A
client scope attribute `op_project_id` becomes the label `otel_scope_op_project_id`, not
`op_project_id`. Stripping at scope level is **namespace hygiene**, not a boundary
requirement — the test stays, with that reason recorded.

#### 4.4 OTLP logs: a record attribute *overrides* the resource attribute — which is why we do not forward this body at all

`otlplogs.go:26-45` builds `attrsMap` in order: resource attributes (`:28`), then scope
(`:33`), then **log-record attributes last** (`:45`). Later writes win. `level`, `trace_id`
and `span_id` are then forced from first-class fields (`:49-56`), so those three cannot be
forged — nothing else is protected. A client-supplied record attribute silently picks its own
tenant.

**Re-framed by D15.** In the draft this was "the single highest-risk ingest behaviour in this
document", and the mitigation was strip-at-three-levels on a body we forward. Under D15 we do
not forward this body: `apps/api` decodes it and constructs the Loki stream itself, so the
precedence rule above is no longer a control surface — it is the *evidence* that forwarding
was the wrong topology. The same function is also the cardinality argument: **every** entry of
`attrsMap`, resource, scope and record alike, becomes a stream label, and `trace_id` /
`span_id` are appended on top (`:49-57`), so one trace id is one new fingerprint
(`builder.go:351`, `unmarshal.go:250-271`). No configuration disables it.

What replaces the strip as the boundary on the log path: the stream label set is **constructed
by OpenPanel from a closed allowlist** (`05-logs.md` D3 — seven fixed keys plus at most five
project-promoted ones), `op_project_id` is stamped into it from the authenticated token, and
the envelope builder deletes reserved keys from the JSON body before serialising. A client
attribute cannot become a label unless the allowlist names it, so tenancy on this signal is
enforced by **construction rather than by subtraction** — a stronger property, but only if the
allowlist and the envelope's reserved-key deletion are tested, which today they are not
anywhere in the plan. See Test requirements.

#### 4.5 OTLP traces: the resource attribute wins, and keys are **not** sanitized

`otlp.go:81` does `span.Attributes = append(span.Attributes, res.Resource.Attributes...)`
— resource appended *after* span — and `initAttributesMap` folds them into a map in slice
order, so resource wins. `writeAttrValue` (`:135-151`) stores `prefix+key` **verbatim**: no
`SanitizeKey`, no `sanitizeLabels`. Nested `KvlistValue`/`ArrayValue` attributes flatten to
dotted keys (`prefix+key+"."`), which only ever *appends* to the top-level key — so testing
the top-level key's `op_` prefix is complete for traces.

Two scope notes the draft did not make:

- **Scope attributes are not read at all** on the trace path. `Decode` (`otlp.go:76-84`)
  iterates `res.ScopeSpans` purely to reach `scope.Spans`; `scope.Scope.Attributes` is
  never touched. `02-ingest-gateway.md` D3 lists scope stripping for traces; that is
  hygiene, not a boundary requirement, and this document is the one that says so.
- **Span event and span link attributes are not indexed, but they are stored.** The whole
  span is `proto.Marshal`'d into the `payload` column (`otlp.go:85`), so an `op_*`
  attribute on an event or link is never a label and can never forge tenancy, but it *is*
  visible in the trace-detail view. Strip it for hygiene; do not describe it as a
  boundary control.

#### 4.6 Prometheus remote-write and Loki push: duplicate labels are kept

`promMetricsProtoDec.Decode` (`metrics_protobuf.go:24-32`) copies every `prompb.Label` into
a slice and calls `sanitizeLabels`, which rewrites *names* and truncates *values* but never
de-duplicates.

Loki's `decodeStream` (`unmarshal.go:71-88`) dispatches on the key: the object form
`"stream"` → `decodeStreamStream` (`:90-105`), the string form `"labels"` →
`decodeStreamLabels` (`:108-119`). **Both append into the same `p.Labels` slice**, so a
payload carrying both merges them. (The draft cited `:163-192` for this in three places —
that range is `decodeStreamEntries`/`decodeStreamEntry`, about 90 lines away. Corrected
here and in the `enforceLokiPush` docblock.)

The slice is serialised by `encodeLabels` (`unmarshal.go:242-249`) with `strconv.Quote`,
producing literal `{"op_project_id":"attacker","op_project_id":"real"}`, and
`time_series_gin_view` fans that out with
`ARRAY JOIN JSONExtractKeysAndValues(time_series.labels, 'String')`
(`ctrl/qryn/sql/log.sql:131-140`). If both pairs survive that, one stored series carries
two `op_project_id` gin rows and answers **both** projects' queries — a cross-tenant
*write* primitive. Strip-then-append makes it unreachable; Q2 tracks the ClickHouse
behaviour, which the design does not depend on.

#### 4.7 Two things gigapipe does that the design must tolerate

- `discoverServiceName` (`builder.go:300-316`) appends `service_name` to the label set when
  none is present. The stored label set is not byte-identical to what the gateway sent, so
  response-side verification must assert on the *presence and value* of `op_project_id`,
  never on set equality.
- The fingerprint is computed from the *filtered* label slice (`builder.go:351`,
  `fingerprintLabels` at `unmarshal.go:250-271`) and hashes only key/value pairs — no type,
  no tenant. Because our label set always contains `op_project_id`, two projects can never
  collide on a fingerprint, and a log stream can never collide with a metric series across
  projects. That is a second, quieter reason the label must be on *every* series.

  The write-dedup cache that sits in front of the `time_series` insert is keyed per node
  (`writer/controller/middleware.go:227-232`), not per label set, so adding a
  per-project label does not change its *shape* — but it does multiply the distinct
  fingerprint population by the number of active projects, which is the number that sizes
  it. **UNVERIFIED:** the cache's eviction policy and size bound under a
  many-small-projects workload. Settled by reading `writer/plugin/qryn_writer_db.go`'s
  cache construction against a load test; routed to `02-ingest-gateway.md` as a P1b
  observation item, not a P1 blocker.

#### 4.8 Summary table

Two protocols are **rewritten and forwarded**; one is **decoded and rebuilt** (D15). The
column that matters is the last one: what the client can influence about the stored label set.

| inbound route | outbound gigapipe route | mode | strip reserved keys from | stamp at | why |
|---|---|---|---|---|---|
| `POST /telemetry/v1/metrics` | `POST /v1/metrics` | rewrite + forward | resource, scope, **every data point** | **resource *and* every data point's attributes** | resource → `target_info` only (§4.1); duplicates concatenate (§4.2); scope is prefixed (§4.3) |
| `POST /telemetry/v1/traces` | `POST /v1/traces` | rewrite + forward | span attrs (boundary), scope + event + link attrs (hygiene); then **restore the D2a set, bounded** | resource attributes | resource wins; keys stored raw (§4.5) |
| `POST /telemetry/api/v1/write` | `POST /api/v1/prom/remote/write` | rewrite + forward | every `TimeSeries.labels` entry | every `TimeSeries.labels` | flat labels, duplicates kept (§4.6) |
| `POST /telemetry/v1/logs` | `POST /loki/api/v1/push` | **decode + rebuild** (D15) | n/a — the label set is constructed, not filtered; the envelope deletes reserved keys from the body | the constructed stream label set | forwarding `/v1/logs` is a fingerprint bomb (§4.4) |
| `POST /telemetry/loki/api/v1/push` | `POST /loki/api/v1/push` | **decode + rebuild** (D15) | same | same | same |

Every gigapipe route confirmed registered at exactly that path:
`writer/router/insert.go:9,14,15`, `writer/router/prom.go:10`, `writer/router/tempo.go:12`.

**Two invariants on the rebuilt rows**, both of which are now enforced by our writer rather
than by a route not existing:

- The Loki value tuple is always **two elements**, `["<ns>", "<envelope>"]`. Index 2 sets
  `SAMPLE_TYPE_METRIC`, and a tuple carrying both a string and a number collapses to
  `tp = 0` (`unmarshal.go:146-165` and `:218-228` — the `if tp == 3 { tp = 0 }` branch, in
  both decoders). A type-0 row is visible to **both** log and metric queries
  (`GetTypes` emits `type IN (<requested>, 0)`, `sql_misc.go:213-220`), which is what
  `08-schema-changes.md` S13's per-signal TTL totality argument turns on. Never emit index 2.
- No client-supplied key reaches the stream label map. The allowlist is the boundary.

**Phasing (D15).** P1 opens the metrics and remote-write rows only. The logs rows open with
P3 and the traces row with P4, because the per-signal shaping each needs — the D2a restore,
`LogRecord.SpanId` zeroing, the correlation cap — is specified and costed in those phases and
appears nowhere in `02-ingest-gateway.md`.

### 5. The primitives

```ts
// packages/gigapipe/src/labels.ts
import {
  TELEMETRY_PROJECT_LABEL,
  TELEMETRY_RESERVED_LABEL_PREFIX,
} from '@openpanel/constants';

/** writer/utils/unmarshal/otlplogs.go:107-117 — OTLP logs + OTLP metrics. */
export function sanitizeOtlpKey(key: string): string {
  const s = key.replace(/[^a-zA-Z0-9_]/g, '_');
  if (s.length === 0 || (s[0] >= '0' && s[0] <= '9')) return `_${s}`;
  return s;
}

/** writer/utils/unmarshal/unmarshal.go:274-282 — Loki push, remote-write, Influx. */
export function sanitizeLabelName(name: string): string {
  return name.replace(/(^[^a-zA-Z_]|[^a-zA-Z0-9_])/g, '_');
}

export type TelemetryProtocol =
  | 'otlp-metrics' | 'otlp-logs' | 'otlp-traces'
  | 'prom-remote-write' | 'loki-push';

/**
 * True when a client-supplied key lands in OpenPanel's reserved namespace, in
 * ANY of the three forms gigapipe might store it under.
 *
 * D3: unconditional, no `protocol` parameter, no alias table. The OTLP traces
 * path applies NO transform at all (writer/utils/unmarshal/otlp.go:135-151), so
 * a per-protocol predicate would let `op.project.id` through on exactly the
 * signal where the raw key is what gets indexed and proto.Marshal'd into
 * `payload`. Over-stripping costs two regex passes per attribute and deletes
 * the whole "which sanitizer applies here" question from the boundary.
 *
 * Nested kvlist/array attributes only ever APPEND a dotted suffix to the
 * top-level key, so testing the top-level key is complete.
 */
export function isReservedKey(key: string): boolean {
  return (
    key.startsWith(TELEMETRY_RESERVED_LABEL_PREFIX) ||
    sanitizeOtlpKey(key).startsWith(TELEMETRY_RESERVED_LABEL_PREFIX) ||
    sanitizeLabelName(key).startsWith(TELEMETRY_RESERVED_LABEL_PREFIX)
  );
}

export type LabelPair = { name: string; value: string };

/**
 * Keys the GATEWAY may re-attach after the strip, from a snapshot taken before
 * it (D2a). Nothing outside this set survives, and nothing in it is ever taken
 * from the payload as-found -- the values come from the snapshot, the caps and
 * the level rules in 06-traces-and-correlation.md §4.1 steps 1-2 and T17.
 *
 * op_root is deliberately ABSENT: it is a transport marker, read to decide the
 * restore and then dropped, never persisted.
 */
export const TELEMETRY_RESTORABLE_KEYS = [
  'op_session_id',
  'op_profile_id',
  'op_exception_type',
  'op_exception_message',
] as const;

/**
 * Remove every reserved key from a flat label list, then append exactly one
 * authoritative pair.
 *
 * Strip-then-append, never append-alone: gigapipe keeps duplicate labels on
 * remote-write and Loki push (unmarshal.go:274-282 never de-duplicates) and
 * CONCATENATES duplicate OTLP attribute keys with ";" (otlp_metrics.go:98-116).
 * Appending alone corrupts the label instead of overriding it.
 *
 * `protocol` is retained ONLY for the strip counter's `signal` dimension. It no
 * longer selects a predicate (D3).
 *
 * This function is the METRIC/LOG/REMOTE-WRITE shape: strip everything reserved,
 * append the tenancy pair, restore nothing. The span shape is a different
 * function -- see enforceSpanAttributes below -- because on spans a bounded
 * subset is restored and the bound is per-trace, not per-list.
 */
export function enforceLabelPairs(
  labels: LabelPair[],
  projectId: string,
  protocol: TelemetryProtocol,
  onStripped?: (name: string) => void,
): LabelPair[] {
  const kept: LabelPair[] = [];
  for (const l of labels) {
    if (isReservedKey(l.name)) {
      onStripped?.(l.name);
      continue;
    }
    kept.push(l);
  }
  kept.push({ name: TELEMETRY_PROJECT_LABEL, value: projectId });
  return kept;
}
```

Callers pass a `projectId` that has already been through `assertProjectLabelValue`.

**The span shape, and why it is a second function.** `enforceLabelPairs` is total on its
input: strip, append one, done. A span cannot use it, because D2a's restore depends on state
the list does not carry — `ParentSpanId`, the arriving `op_root`, and a counter that is scoped
to the whole `trace_id` across the whole request. Folding that into `enforceLabelPairs` with
an options bag is how the restore rule ends up applied to a log record by accident, which is
the exact failure D2a exists to prevent. So:

```ts
/**
 * Trace-path enforcement. Owned here; the sequencing, the caps and the counter
 * names are 06-traces-and-correlation.md §4.1 steps 1-2 and T17.
 *
 *   1. snapshot  { op_session_id?, op_profile_id?, op_root? } per span
 *   2. strip     every isReservedKey() attribute, resource AND span level
 *   3. stamp     op_project_id on the RESOURCE (resource wins, §4.5)
 *   4. restore   op_session_id / op_profile_id onto this span IFF
 *                  len(span.ParentSpanId) === 0 || snapshot.op_root === '1'
 *                AND budget.remaining(traceId) > 0
 *   5. lift      op_exception_type / op_exception_message from the first
 *                `exception` span event (never from a client attribute)
 *
 * Steps 4 and 5 are the ONLY writers of a reserved key other than step 3.
 */
export function enforceSpanAttributes(
  span: ISpan,
  projectId: string,
  budget: PerTraceCorrelationBudget,   // TELEMETRY_MAX_CORRELATED_SPANS_PER_TRACE = 4
  onStripped?: (name: string, level: 'resource' | 'span') => void,
): void;
```

If `02-ingest-gateway.md` §6.0's `scrubAttrs` ships as currently written — an unconditional
drop of every `isReserved` key on every signal, with no snapshot and no restore hook — then
every trace loses `op_session_id` and `op_profile_id`, silently, and the plan's stated
differentiator does not exist. That is the single most consequential edit this revision is
asking another document for.

### 6. Ingest: what this stream owns and what it hands over

`02-ingest-gateway.md` owns the gateway — the Fastify plugin, the protobuf codegen, the
decompression caps, the circuit breaker, the admission limits, the error semantics and the
rate limiter. This document owns the **enforcement contract** it must satisfy: §4.8's table,
the primitives in §5, and the authentication rule below.

Reviewers were right that the draft's "the bodies are mechanical" was hiding the largest
piece of engineering in the plan — a full protobuf decode → mutate → re-encode of every
payload, in-process, on the same event loop as `/track`. It is not mechanical and it is not
this stream's to hand-wave. It is `02-ingest-gateway.md` §5 ("The payload rewrite"), and it
is already specified there in detail, including:

- the oneof walk across gauge/sum/histogram/exponential-histogram/summary (D3, §5);
- `protobufjs` static-module codegen over **vendored** `opentelemetry-proto` and upstream
  `prometheus/prompb`, with `protobufjs`, `long` and `snappy` as **direct** deps of
  `apps/api` and in `tsdown`'s `external` array (D4) — the draft's own rule about pnpm's
  isolated `node_modules`, applied;
- OTLP/JSON rejected 415 on all three routes in P1 (D12), so there is exactly one rewrite
  implementation inside the boundary;
- 503 + `Retry-After` on upstream failure, never 200-with-`partial_success` (D7);
- its own `setErrorHandler` and its own `@fastify/rate-limit`, because the app-level
  handler logs `request.headers` — including `openpanel-client-secret` — at `warn` on 4xx
  (D11);
- `/telemetry` CORS-**denied** by an explicit third branch (**D16 above**, adopting
  `05-logs.md` D11). The draft of this line said "added to `corsPaths` (`02-ingest-gateway.md`
  D16)", which is backwards: `apps/api/src/app.ts:109-125` treats `corsPaths` membership as
  the *permissive-for-the-dashboard* branch. Corrected here because this document was the one
  citing it as a settled control;
- `subscriptionHook` wired onto the telemetry routes with a per-protocol block response
  (`02-ingest-gateway.md:378-394`), not the bare `202 {blocked:true}` that
  `apps/api/src/hooks/subscription.hook.ts:65` returns for events. An OTLP exporter treats
  any 2xx as a successful export, so a bare 202 with a JSON body is silent data loss.

**One correction this stream owes that stream.** `protobufjs` discards unknown fields on
decode, so decode → re-encode is a **lossy projection**: any field added by a newer OTLP
release, or any vendor extension, is silently deleted by our gateway before gigapipe sees
it. The symptom is "an attribute my collector sends just does not appear", with no error
and no counter. `02-ingest-gateway.md` D4 pins and vendors the protos, which bounds the
problem, but the loss itself is not stated there. It must be: record the vendored
`opentelemetry-proto` version next to the gigapipe image digest, add a CI check that the
pin tracks the OTLP release the plan supports, and add a test that decodes and re-encodes a
payload containing a field unknown to the vendored schema and asserts the *documented*
outcome (dropped, counted) rather than discovering it in production.
**UNVERIFIED:** whether `protobufjs`'s static-module output can be configured to preserve
unknown fields. `node_modules` is not installed in this checkout. Settled by
`pnpm add protobufjs && node -e "…"` against a message with an unknown tag.

#### 6.1 Authentication, and the authoritative project id

`validateSdkRequest` **must not** be reused. It has two pre-secret escape hatches that are
correct for a browser SDK and catastrophic for a tenancy credential:
`client.ignoreCorsAndSecret` returns the client on the public client id alone
(`apps/api/src/utils/auth.ts:133-135`), and an `Origin` matching `project.cors` — including
the `'*'` case — returns it with no secret check at all (`:137-161`). Client ids ship in
web SDK bundles and `Origin` is one curl flag. Since `op_project_id` is derived entirely
from the authenticated client, that would make the whole boundary bypassable with a public
value.

```ts
// apps/api/src/telemetry/auth.ts   (02-ingest-gateway.md D9 owns the location)
import { createHash } from 'node:crypto';
import { verifyPassword } from '@openpanel/common/server';
import { ClientType, getClientByIdCached } from '@openpanel/db';
import { deleteCache, getCache } from '@openpanel/redis';

const CLIENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Telemetry ingest auth. Header-only, secret always required.
 *
 * Deliberately NOT validateSdkRequest: that function returns an authenticated
 * client with no secret check when client.ignoreCorsAndSecret is set
 * (apps/api/src/utils/auth.ts:133-135) or when Origin matches project.cors
 * (:137-161). Both are fine for a browser SDK and unusable for the credential
 * that decides op_project_id.
 *
 * Credentials are never read from the body: auth.ts:52-56 pulls clientId and
 * clientSecret out of req.body via ramda `path`, which is meaningless for an
 * OTLP protobuf body and would be a second, unauthenticated code path here.
 */
export async function validateTelemetryRequest(headers: Record<string, unknown>) {
  const clientId = headers['openpanel-client-id'] as string;
  const clientSecret = (headers['openpanel-client-secret'] as string) || '';

  if (!CLIENT_ID_PATTERN.test(clientId)) throw new Error('Telemetry: Client ID must be a valid UUIDv4');

  const client = await getClientByIdCached(clientId);
  if (!client) throw new Error('Telemetry: Invalid client id');
  if (client.type !== ClientType.telemetry) throw new Error('Telemetry: Client is not a telemetry client');
  if (!client.project) throw new Error('Telemetry: Client has no project');
  if (!client.secret) throw new Error('Telemetry: Client has no secret');

  // Key on the client id ALONE, never on a digest of the presented secret, and
  // put both the stored hash and the verified digest in the VALUE. Keying on
  // the presented secret (as packages/mcp/src/auth.ts:106-108 does, and as the
  // draft of this document did) makes the entry unaddressable at rotation
  // time: no code path can reconstruct the key without the old plaintext, so
  // nothing can clear it. Storing the plaintext in the key at all (auth.ts:165
  // base64s it) puts an ingest secret in the Redis keyspace. See "Revocation
  // SLA" for the numbers.
  const presented = createHash('sha256').update(clientSecret).digest('hex');
  const key = `telemetry:auth:${clientId}`;

  // A throw inside `fn` propagates and is NOT cached, so a wrong secret never
  // poisons the entry.
  const entry = await getCache<{ hash: string; digest: string }>(
    key,
    60,
    async () => {
      if (!(await verifyPassword(clientSecret, client.secret!))) {
        throw new Error('Telemetry: Invalid client secret');
      }
      return { hash: client.secret!, digest: presented };
    },
    true,
  );

  // Cache hit, but for a different stored hash (rotated) or a different
  // presented secret (wrong credential reusing a warm entry): fall through to
  // a full argon2 verify and drop the stale entry.
  if (entry.hash !== client.secret || entry.digest !== presented) {
    if (!(await verifyPassword(clientSecret, client.secret!))) {
      throw new Error('Telemetry: Invalid client secret');
    }
    await deleteCache(key);
  }

  return client;
}

/** Called by every path that rotates or deletes a client secret. */
export function clearTelemetryAuth(clientId: string) {
  return deleteCache(`telemetry:auth:${clientId}`);  // packages/redis/cachable.ts:6
}
```

**The authoritative project id is `req.client.projectId`.** Never a body field, never a
header, never a query parameter. That is the single most important sentence in this
section.

##### Revocation SLA — two numbers, not one

The draft said "~60 s" and was off by 5x for its own code. The honest statement, read from
`packages/redis/cachable.ts`:

| event | propagation bound | why |
|---|---|---|
| client **deleted or disabled** | **≤ 60 s** cross-node | `getClientByIdCached` is `cacheable(getClientById, 60*5)` (`packages/db/src/services/clients.service.ts:37`); `cachedFn.clear()` (`cachable.ts:275-279`) deletes the local LRU entry and the Redis key, but other replicas' L1 LRU has `CACHEABLE_LRU_TTL_MS = 60 * 1000` (`cachable.ts:156`). The file's own comment says so. |
| **secret rotated** | **≤ 60 s**, with the fix above | The draft's `getCache('telemetry:auth:${clientId}:${digest}', 60*5, …, true)` put the *old secret's* digest in the key, and `getCache` sets the LRU entry with `ttl: expireInSec * 1000` (`cachable.ts:37-39, 50-52`) — 300 s, on every replica, with **no code path able to construct the key to clear it**. Keying on the client id, putting the hash in the value, dropping the TTL to 60 s, and calling `clearTelemetryAuth` from `manage.controller.ts:327,368,394` reduces this to the same 60 s bound as deletion. |
| **project access revoked** (read path) | **≤ 5 min** | `getProjectAccess` is `cacheable('getProjectAccessV2', …, 60*5)` (`access.service.ts:31,79`) and nothing clears it on a `ProjectAccess` mutation. This is inherited from the event path, not introduced here, but it is the read-side revocation SLA and it belongs in the same paragraph as the ingest one. |
| **client deleted from the dashboard** | **≤ 360 s today; ≤ 60 s after a one-line fix** | **Absorbed from `02-ingest-gateway.md`, which found it.** Verified: `packages/trpc/src/routers/client.ts:86-114` (`client.remove`) calls `db.client.delete` and **never** `getClientByIdCached.clear()`. `apps/api/src/controllers/manage.controller.ts:327,368,394` does clear it, so the public Manage API is fine and the dashboard is not — 300 s Redis TTL plus up to 60 s of other replicas' L1 LRU. |

##### One number, in one place

**The telemetry credential revocation SLA is 60 seconds**, for deletion and for rotation
alike, once the two fixes above land. That is the number `05-logs.md` §4.2 (which publishes
5 minutes), `08`, and `11-testing-strategy.md` A18 should cite rather than restate. A18 is
right that today there are two SLAs; the point of §6.1's design is that after the fixes there
is one.

**P1a deliverable, with an owner, because it is one line and it is currently nobody's.**
`client.remove` gains `await getClientByIdCached.clear(input.id)` before returning, and
`clearTelemetryAuth(input.id)` beside it. **Owner: the ingest work-stream**, in the same PR
that widens `client.ts:58`'s `type: z.enum(['read','write','root'])` to include `telemetry` —
the two changes are three lines apart in the same file and the second is already a P1a
requirement (below). Test: T1.32.

##### Rejected: keying the cache on the presented secret

Three designs for one cache are on disk and two of them are the shape §6.1 rejects.
`02-ingest-gateway.md` §2.2 keys `` `telemetry:auth:${clientId}:${secretHash(clientSecret)}` ``
at 300 s and on a hit does `if (verifyCache.get(key)) return client` with **no comparison
against `client.secret`**; `05-logs.md` §4.2 uses "SHA-256 prefix of the secret as the cache
key" at 5 minutes. `02`'s stated justification — "a rotated secret misses it" — is inverted:
the *new* secret misses, and the *old* one hits **its own entry** and is granted for the full
300 s Redis TTL plus the 5-minute process LRU. That is a rotated credential still working for
five minutes, which is the opposite of a rotation.

The design above is the single specification: **key on the client id alone; put the stored
hash and the presented digest in the value; re-verify with argon2 on every hit where either
differs; TTL 60 s; export `clearTelemetryAuth(clientId)` and call it from
`manage.controller.ts` and from tRPC `client.remove`.** The code samples in
`02-ingest-gateway.md` §2.2 and `05-logs.md` §4.2 should be deleted rather than reconciled —
two implementations of one credential check is the condition D11 rejects.

`packages/mcp/src/auth.ts:106-108` has the same digest-in-the-key shape, and
`apps/api/src/utils/auth.ts:165` is worse: it builds
`` `client:auth:${clientId}:${Buffer.from(clientSecret).toString('base64')}` `` — a
**reversible plaintext ingest credential in the Redis keyspace**, visible in `SCAN`, the
slowlog and any RDB dump. `11-testing-strategy.md` A17 requires migrating that to a
`client:authv2:` prefix and calls it "a prerequisite, not a test", assigning it to "the ingest
work-stream" — but `02-ingest-gateway.md` never touches `validateSdkRequest`, so it is
currently assigned to nobody. **This document's position:** the telemetry path does not depend
on it (telemetry has its own cache, by design), so it is not a P1 blocker for telemetry — but
it is a real, existing, unowned exposure and it needs an owner named outside this plan rather
than an owner assumed inside it. Q10.

##### `ClientType.telemetry` is a grant, not a restriction

Adding a member to `ClientType` (`packages/db/prisma/schema.prisma:353-357`) widens three
**deny-lists** — not four, as the draft said:

| site | shape | effect of a new member |
|---|---|---|
| `apps/api/src/utils/auth.ts:202` (`validateExportRequest`) | `if (client.type === ClientType.write) throw` | **passes**, and this function also guards **`/insights`** (`apps/api/src/routes/insights.router.ts:52`), the richest read surface in the product |
| `apps/api/src/utils/auth.ts:237` (`validateImportRequest`) | same | **passes** — a telemetry client could insert hand-crafted `IClickhouseEvent` rows into its own project, bypassing the track pipeline |
| `packages/mcp/src/auth.ts:99` | same | **passes** |
| `apps/api/src/utils/auth.ts:272` (`validateManageRequest`) | `if (client.type !== ClientType.root) throw` | **already safe** — allow-list shape, fails closed |

Two further type-sensitive sites the draft missed:

- `apps/api/src/controllers/export.controller.ts:28` does a *positive*
  `request.client?.type === ClientType.read` check to enforce the per-project scope; a
  telemetry client skips it and falls through to the org-scoped `findUnique`. Fixed by the
  allow-list retrofit above, but list it so nobody "fixes" only the three throws.
- `packages/trpc/src/routers/client.ts:58` pins
  `type: z.enum(['read', 'write', 'root'])`, so **no dashboard path can mint a telemetry
  client at all**. The ingest boundary depends on such a client existing. This must be
  widened in the same PR.

**Invert all three deny-lists to allow-lists** (`if (client.type !== read && client.type !== root) throw`)
so the *next* enum value fails closed. Note that `apps/api/src/utils/auth.ts` has **no test
file** (only `ids.test.ts` and `image-proxy.test.ts` exist in that directory) and
`packages/mcp/src/auth.test.ts:8` mocks `ClientType` as a plain object literal, so it
cannot catch a missing case — each retrofit needs a new negative test.

#### 6.2 Header hygiene

gigapipe's writer middleware reads four attacker-controllable headers on every ingest path
— `X-CH-DSN`, `X-Scope-Meta`, `X-Ttl-Days`, `X-Async-Insert`
(`writer/controller/middleware.go:165-173`, `getAsyncMode` at `:151-160`) — and the gRPC
receiver reads the lowercase forms (`writer/grpc/tenant.go:42,49,53`). The gateway
constructs the outbound request from scratch and copies **no** client headers.

- `X-CH-DSN` is inert under the env-var bootstrap (`portCHEnv` never sets `.Node`), but
  `writer/chwrapper` contains *working, unwired* caller-supplied-DSN dialers —
  `NewSmartDatabaseAdapterWithXDSN` / `NewSmartDatabaseAdapterWithDSN`
  (`writer/chwrapper/factory.go:246-268`), dispatched at `adapter.go:34-53`, whose only
  callers are `chwrapper/unit_test.go` and `e2e_test.go.bak`. Upstream could wire that to
  `utils.ContextKeyDSN` in one line. Strip the header rather than relying on it being
  harmless, and re-audit `chwrapper` on every gigapipe version bump.
- `X-Scope-Meta` lands in the `time_series.metadata` column (`builder.go:158-162`), a
  per-series client-controlled write. Strip it.
- `X-Ttl-Days` and the `__ttl_days__` special label are a **documented no-op** in OSS: they
  are parsed (`middleware.go:167-174`), mirrored on gRPC (`tenant.go:49-58`) and
  materialised into `MTTLDays` (`builder.go:357,388`), but no insert service writes a
  `ttl_days` column and no `.sql` file declares one. Do not build quota or retention on
  them; `10-ops-retention-billing.md` D8 owns the conditional-TTL design instead.

#### 6.3 Rejection, not silent dropping — per signal

The draft stated `partial_success` as the OTLP contract generally. It is **metrics-only**,
which changes what the gateway has to build:

| route | gigapipe's response | what the gateway does |
|---|---|---|
| `/v1/metrics` | 200 with an `ExportMetricsServiceResponse`; `partial_success` set when data points were rejected (`writer/controller/otlp_metrics.go:43-61`) | decode it, **merge** our own `rejected_data_points` and reserved-key message into its `partial_success`, re-encode |
| `/v1/logs` | **204 No Content, body `"Ok"`** (`writer/controller/insert.go:142-153`) | there is nothing to merge; the gateway **constructs** the `ExportLogsServiceResponse` and its `partial_success` from its own strip counts alone |
| `/v1/traces` | 200 with an **empty** `ExportTraceServiceResponse` (`writer/controller/tempo.go:56-59`, `ptraceotlp.NewExportResponse()`) | same — construct it |

gigapipe's own metrics rejections must be propagated, not swallowed: it rejects DELTA and
unspecified aggregation temporality outright (`otlp_metrics.go:227-234`), plus exponential
histograms with negative buckets, bucket/bounds length mismatches and zero timestamps — all
as `partial_success` inside an HTTP 200. Swallowing that body makes metrics vanish with no
error anywhere.

Wire-encoding facts the gateway must respect:

- `/v1/metrics` dispatches on `strings.HasPrefix(contentType, k)`
  (`writer/controller/builder.go:130-137`) and has **no `"*"` fallback**, so a POST with no
  `Content-Type` is a hard `400 Content-Type not supported`. Always set it.
- `/v1/logs` and `/v1/traces` register a **single** `withSimpleParser("*", …)` resolving to
  `proto.Unmarshal`. **Binary protobuf only.** Protobuf *encode* is on the critical path
  for P3 and P4, not just decode for P1.
- Remote-write accepts an *uncompressed* `prompb.WriteRequest`: `withUnsnappyRequest`
  restores the original body when snappy decode fails
  (`writer/controller/middleware.go:111-143`). The 10 MiB decompressed-body cap
  (`middleware.go:122-124`) lives **inside** the snappy branch, so forwarding uncompressed
  removes gigapipe's only remote-write body limit.
- OTLP payloads are capped at 64 MiB across both transports
  (`writer/controller/otlp_metrics.go:24-42`, `QRYN_SYSTEM_SETTINGS_OTLP_MAX_MESSAGE_SIZE`);
  oversize HTTP bodies get 413. `apps/api`'s global `bodyLimit` is `1_048_576 * 500`
  (`apps/api/src/app.ts:88`), ~8x larger, so **per-route `bodyLimit`s are mandatory**: 10
  MiB on `/telemetry/api/v1/write`, ≤ 64 MiB on the three OTLP routes. Routed to
  `02-ingest-gateway.md` §6/§7.
- gigapipe decodes the bare data messages (`metricsv1.MetricsData`, `otlplogs.LogsData`,
  `tracev1.TracesData`), not the `Export*ServiceRequest` collector messages an OTel SDK
  sends. They are wire-compatible — each is a single repeated field 1 — but the vendored
  schema must be validated against that specifically.

### 7. Query enforcement

#### 7.1 The project id is derived, never received — and so is the query spec

The tenancy middleware is `observabilityProcedure` in
`packages/trpc/src/routers/observability.ts`. **Its construction is specified by
`04-read-path.md` §6.1 and D13, not here.** This document owns the two *rules* it enforces;
`04` owns the middleware.

**Changed in this revision.** The draft of this section carried a `publicProcedure` sample
that hand-rolled the session check and `getProjectAccess`. `04-read-path.md` D13 rebuilds it
as `protectedProcedure.use(rejectShareId)` and is right. Verified at
`packages/trpc/src/trpc.ts:90-112`: `enforceAccess` already does the `projectId` read-access
check, **and** carries three things the hand-rolled version dropped —

- the demo-mode mutation guard (`if (type === 'mutation' && process.env.DEMO_USER_ID) throw`),
- the `organizationId` branch,
- the fail-closed `needsWrite` rule, whose own comment says it covers "any procedure that
  takes a top-level `projectId` … including ones added later" (`trpc.ts:100-103`).

Since this is the tenancy document, its code sample is the one an implementer copies — and
copying it would opt the one router the plan calls a security boundary out of the repo's
central access middleware **permanently**, including out of every future change to it. The
sample is therefore deleted rather than corrected. `04-read-path.md` D13 also corrects this
document's stated justification: at `level: 'read'`, `requireProjectAccess` *is* the truthiness
test — the `canWriteProject` branch only exists at `level: 'write'`
(`packages/trpc/src/access.ts:39-61`). Using the named helper is about not diverging from
`enforceAccess`, not about closing a hole. Accepted.

Kept as enforcement, from `04-read-path.md`: its `NO_PROJECT_ID` fail-closed allow-list (for
procedures like `traces.forSession` whose project is not a top-level input key, which
`enforceAccess` cannot see) and its T25a/T25b/T25c iterate-the-router tests.

**The two rules this document owns:**

1. **The project id is derived, never received.** `ctx.scopedProjectId` is the only project id
   any resolver in this router may use. Telemetry **reads are level-agnostic** — any non-null
   `getProjectAccess` grants them (`{ level }` ∈ `read | write | admin`,
   `packages/db/prisma/schema.prisma:324-328`). Telemetry **token CRUD** is a mutation, so
   `enforceAccess`'s `needsWrite` rule applies by construction; `access.service.ts:18-27`
   carries a GHSA reference for exactly the omission where a mutating procedure checks only
   for non-null, which is why not re-deriving the middleware matters.
2. **On any share path, the query spec is derived too** — the share rule, below.

**Ordering is still load-bearing and still this document's assertion.** The tenancy middleware
must be registered *before* `cacher`. `packages/trpc/src/trpc.ts:198-211` keys the response
cache on `` `trpc:${path}:` `` plus `JSON.stringify(rawInput)` with **no** user, session or
project component (verified in this session), so the composition is safe only because (a) auth
runs first, so an unauthorised caller never reaches the cache, and (b) the derived project id
is a pure function of the raw input. Never `.use(cacher).use(tenancy)`. The repo's existing
composition (`chartProcedure.use(cacher)`, `chart.ts:456, 589, 613, 637`) already gives the
right order, so the risk is a future refactor, not the initial write — asserted behaviourally
by T1.24, not by inspecting middleware order.

##### The share rule

The draft's `metricsProcedure` copied `chartProcedure`'s *authentication* and dropped its
*authorisation of the query itself*. That is a critical bug and it is worth writing down
why, because the same mistake is available every time this middleware is extended.

`chartProcedure` loads the stored report and puts it on `ctx.report`
(`packages/trpc/src/routers/chart.ts:112-121`), and every resolver then builds its input as
`ctx.report ? { ...ctx.report, range: input.range ?? …, startDate, endDate, interval } : input`
(`chart.ts:466-475`, `:598-607`, `:612-634`). On a share the client-supplied spec is
**discarded**; only four window fields survive. The draft returned
`next({ ctx: { telemetryProjectId: shareValidation.projectId } })` and nothing else, over a
client-supplied `zMetricQuery`. The consequence: an anonymous holder of any public,
non-password share link for a project could run arbitrary structured metric queries against
that project's entire telemetry estate — any metric, any filters, any groupBy, any window.
Sharing one CPU chart hands out the whole observability estate. A test asserting "the
share's projectId wins" does not catch it.

**The rule, for whenever the share path is enabled:** *on the share path both the project id
and the query spec are derived, never received.* Concretely, and this reproduces
`04-read-path.md:1256-1284`:

- Load the stored report; reject it explicitly if it is not a metric report
  (`if (!isMetricReport(report)) throw new TRPCForbiddenError(...)`). Never a silent
  fallback to `input.series`.
- Window overrides only — the same **four**-field allow-list `chart.ts:598-607` uses:
  `range`, `startDate`, `endDate`, `interval`. `series`, `filters` and `breakdowns` come
  from the report.
- No metadata enumeration, no raw log lines, no live tail on any share path, ever.
- `rateLimitMiddleware` keyed on `shareId` + trusted IP, and a share-specific
  `withProjectLease` bucket. See D12: on the share path the caller is anonymous, the cache key
  is caller-controlled, and the backend is one Go process with a fixed 30 s timeout and a
  single global `MaxSamples` budget.

**And the rule applies to `chart.chart`, not only to `observability.*`.** This is the half the
draft missed and D12 now states: `09-ui-surfaces.md` D5 routes saved metric reports through
`chartProcedure`, which this middleware never touches. Rejecting `shareId` in
`observabilityProcedure` does not make telemetry share-unreachable; it makes *one router*
share-unreachable. Whoever lands `Report.dataSource` owns D12's four requirements.

**Note for `09-ui-surfaces.md` D14/T9.** D14's rule — "`compiled` is populated only when
`ctx.report === null`" — is correct and cheap, and should be kept. But T9, a must-row guarding
F12, cannot be written as stated: it asserts on a request shape the router refuses before the
resolver runs, because `observabilityProcedure` hard-rejects `shareId` (D12 here,
`04-read-path.md` D4/D6) and `03-metrics-engine.md` D1 confirms no stored report can hold a
metric series in P2. **T9 should assert the rejection instead** — any `observability.*` call
carrying a `shareId` is `FORBIDDEN`, which is already `11-testing-strategy.md` Q27 and T1.22
here — and `09` should record that until the share path is enabled, F12 is *unreachable*
rather than *mitigated*. Revisit D14 as written when `Report.dataSource` lands.

##### All four public-read surfaces, named

`validateShareAccess` handles **two** of the product's four public-read surfaces
(`packages/db/src/services/share.service.ts:120-214`: `shareDashboard`, then `shareReport`).
The draft implied it covered them all.

| surface | model | validator | telemetry in scope? |
|---|---|---|---|
| shared report | `ShareReport` | `validateShareAccess` (`share.service.ts:173-213`) | **not yet** — the share rule above, when a Report can hold a metric series |
| shared dashboard | `ShareDashboard` | `validateShareAccess` (`share.service.ts:128-171`) | **not yet**, same |
| shared overview | `ShareOverview` | `validateOverviewShareAccess` (`share.service.ts:216-…`), used by `overviewProcedure` (`packages/trpc/src/routers/overview.ts:57`) | **never in any phase.** Telemetry has no place on the project overview. |
| embed widget | `ShareWidget` | none — a bare `widget.public` check inside `publicProcedure`s (`packages/trpc/src/routers/widget.ts:118-160`) | **never in any phase.** |

A Tier-1 test asserts a metrics query cannot be reached through `overviewProcedure` or the
widget router, so "we forgot" and "we decided" stay distinguishable.

##### Errors on the share path

`validateShareAccess` does **not** return `{ isValid: false }` for a missing or non-public
share — it throws plain `Error`: `'Share not found or not public'`
(`share.service.ts:148`, `:186`), `'Share not found'` (`:214`),
`'Report ID mismatch'` (`:114`). Through tRPC those become `INTERNAL_SERVER_ERROR`, not
`FORBIDDEN`, and the refusal counter never sees them. `chartProcedure` has the same gap, so
this is inherited — but this is a new boundary with an enumerated hostile-caller suite, so:
wrap the call, map every throw to `TRPCForbiddenError`, and count it as an enforcement
refusal.

#### 7.2 PromQL — the structured spec

The dashboard never sends PromQL. It sends a spec; the server builds the string.

**The schema is defined in `03-metrics-engine.md` §2 and nowhere else (D19).** The draft of
this section carried a second, incompatible definition — 11 `fn` values including `irate` and
`deriv`, `aggregation` including `quantile`/`topk`/`bottomk`, a `k` field, no `metricType`.
That definition is **withdrawn**. It is the version `03` explicitly replaces ("`zMetricQuery`
is rewritten, not extended"), and keeping it here would mean P1 building the enum P2 deletes,
which is what `07-alerting.md` Q1 is blocked on.

What this document still owns about the schema, and the only part that should be restated
anywhere:

| rule | why it is tenancy's |
|---|---|
| `zMetricLabelFilter.name` and every `groupBy` entry are refused when they start with `TELEMETRY_RESERVED_LABEL_PREFIX` | a filter or breakdown naming `op_project_id` is a forgery attempt; it must die at zod, before any compiler sees it (`11-testing-strategy.md` §3.4 Q1's assertion — which must be re-pointed at `zMetricLabelFilter`, since `zMetricMatcher` does not exist) |
| `PROM_LABEL_NAME` = `^[a-zA-Z_][a-zA-Z0-9_]*$` and `PROM_METRIC_NAME` = `^[a-zA-Z_:][a-zA-Z0-9_:]*$`, both anchored | these two regexes are what make §7.2's five-statement safety argument checkable; they are not formatting |
| the file is `packages/validation/src/telemetry.validation.ts` | the file lives with the compilers' contract, and `03` §2 already writes it there |

Everything else — `metricType`, the eleven-member `fn` enum, `zMetricWindow`'s `auto`,
`aggregation: sum\|avg\|min\|max\|count`, `scale`, `displayName`, `hideSeries`,
`REDUCER_TABLE`, `refineMetricQuery` — is `03` §2's, verbatim, and is not reproduced here.
`IMetricQuery` below is `z.infer<typeof zMetricQueryBase>` from that file.

```ts
// packages/gigapipe/src/query/promql.ts
const OP_TO_PROMQL = { eq: '=', neq: '!=', re: '=~', nre: '!~' } as const;

/** PromQL string literals are Go-style: escape backslash and double quote. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Build the mandatory selector. The tenancy matcher is written FIRST and is
 * always an equality matcher on a non-empty literal.
 *
 * It must never be a regex and never empty: gigapipe's stream planner drops a
 * `=~".*"` matcher outright and moves a `=""` matcher into a branch that
 * matches every series WITHOUT the label
 * (clickhouse_planner/planner_stream_select.go:36-45, :84-116) -- and the
 * PromQL optimiser reuses that exact planner
 * (promql_transpiler/planner/stream_select.go:7-9,
 *  optimizer/vector_range.go:87-101, optimizer/vector_agg.go:72-82), so this
 * applies to metrics, not only to logs. assertProjectLabelValue guarantees
 * non-empty; this function guarantees `=`.
 */
export function compileSelector(
  q: IMetricQuery,
  projectId: string,
  extraMatchers?: readonly PromMatcher[],
): string {
  assertProjectLabelValue(projectId);
  const matchers = [
    `${TELEMETRY_PROJECT_LABEL}=${quote(projectId)}`,
    ...q.filters.map((f) => `${f.name}${OP_TO_PROMQL[f.operator]}${quote(f.value)}`),
    // Third parameter, requested by 03-metrics-engine.md §8.2 and ACCEPTED here.
    // Series pinning needs matchers whose VALUES came off a previous response,
    // i.e. untrusted text that never passed through zMetricLabelFilter. Same
    // two constraints as a filter, enforced here rather than at the call site:
    //   - the NAME must match PROM_LABEL_NAME and must not be reserved;
    //   - the VALUE goes through quote(), like every other value.
    ...(extraMatchers ?? []).map((m) => {
      if (!PROM_LABEL_NAME.test(m.name) || m.name.startsWith(TELEMETRY_RESERVED_LABEL_PREFIX)) {
        throw new TenancyError('Pin matcher names a reserved or malformed label');
      }
      return `${m.name}${OP_TO_PROMQL[m.operator]}${quote(m.value)}`;
    }),
  ];
  return `${q.metric}{${matchers.join(',')}}`;
}

/**
 * Wrap an expression in its cross-series aggregation, ALWAYS retaining the
 * tenancy label first in the `by` list.
 *
 * Signature and emission order are 03-metrics-engine.md §4.1 step 3: this
 * function receives the already-ranged inner expression and wraps it, so the
 * aggregation sits OUTSIDE the range function -- the only correct order for
 * `sum(rate(...))` and the only order gigapipe accelerates
 * (optimizer/vector_agg.go:33-43).
 *
 * Putting the wrap in the tenancy layer rather than returning a bare `by (...)`
 * fragment is what keeps op_project_id in the `by` list BY CONSTRUCTION: there
 * is no way for a caller to assemble an aggregation without it.
 *
 * Returns `inner` unchanged when q.aggregation is falsy.
 *
 * The label is single-valued by construction, so it adds no series and no
 * cardinality -- `sum by (op_project_id, job)(...)` returns exactly what
 * `sum by (job)(...)` would, with one extra label. That is what makes the
 * response-side check non-vacuous for aggregating queries. D13 strips it before
 * FinalChart.
 */
export function compileAggregation(q: IMetricQuery, inner: string): string {
  if (!q.aggregation) return inner;
  const by = [TELEMETRY_PROJECT_LABEL, ...q.groupBy].join(', ');
  return `${q.aggregation} by (${by}) (${inner})`;
}
```

**Both signatures changed in this revision, and both were already being consumed.**
`compileGroupBy(q): string` — which returned only a `by (…)` fragment — is **deleted**. Three
documents (`03-metrics-engine.md` §4.1 and § Interfaces, `04-read-path.md` §6.2 and its
Interfaces table, `07-alerting.md` §3 and § Interfaces) import `compileAggregation(q, inner)`
from this document, citing it; this document exposed no such function, so those three specs
were written against a symbol that did not exist. The wrapping form is the right one and it is
adopted. `03`'s further request — delete the `quantile` / `topk` / `bottomk` branches and the
`q.k` reads — is satisfied by construction: those branches only ever existed in the withdrawn
schema (D19), so the body above never had them.

`compileAlertQuery` (`07-alerting.md` §3) is **not** a tenancy export and is not added here.
It lives in `packages/db/src/engine/metrics/compile.ts` — `03`'s file — and composes
`compileSelector` + `compileAggregation` for the alert evaluator. `07`'s Interfaces should cite
`03` for it, not this document. Recorded so the request has an answer rather than sitting open.

Why this is safe, as five statements a reviewer checks by reading one function:

1. `q.metric` matched `^[a-zA-Z_:][a-zA-Z0-9_:]*$`, so it cannot contain `{`, `}`, `"`,
   `,`, whitespace, `#` or `@`. It can neither terminate the selector nor open a comment.
2. Every filter name matched `^[a-zA-Z_][a-zA-Z0-9_]*$` and is not `op_*`.
3. Every filter value passes through `quote()`.
4. `projectId` passed `^[a-zA-Z0-9_-]{1,100}$` — it needs no escaping at all.
5. The tenancy matcher is emitted by the same function that emits the braces. There is no
   return path that omits it.

**Why a hostile filter cannot subtract the matcher.** gigapipe compiles each matcher into
`key = 'name' AND <val predicate>`, ORs them, groups by fingerprint, and requires *all*
bits (`planner_stream_select.go:48-79`):

```sql
SELECT fingerprint FROM time_series_gin
WHERE date >= ... AND type IN (2,0)
  AND ( (key='op_project_id' AND val='acme-prod')
     OR (key='job'           AND val='api') )
GROUP BY fingerprint
HAVING groupBitOr(bitShiftLeft(c_0,0) + bitShiftLeft(c_1,1)) = 3
```

A filter can only *add* a bit that must also be satisfied. `foo!="bar"` cannot remove the
tenancy clause from the mask. A smuggled second tenancy matcher requires one fingerprint to
have gin rows for both values — impossible for a single series — so the result is empty.
Fail closed.

**One structural note for P2.** `CLokiQuerier.Select` silently drops a matcher named
`__ignore_usage__` with an empty value (`reader/service/prom_queryable.go:216-222`), and
`transpileLabelMatchers` (`:174-185`) short-circuits the entire matcher set when a
`__name__` matcher's value is a key in `expr.Substitutes`. Both are internal: substitute
names are `fmt.Sprintf("__metric_subst__%d", rand.Int63())` in a per-request map
(`optimizer/vector_range.go:106`), and the substitute's planner was built from the
*already-stamped* selector's matchers (`vector_range.go:87-101`, `vector_agg.go:72-82`), so
the tenancy matcher propagates. Not exploitable today; named here because "a user-supplied
`__name__` value causes every other matcher on that selector to be ignored" is exactly the
class of thing a raw-PromQL review must re-check on each gigapipe bump.

#### 7.3 LogQL

The LogQL stream selector is a comma-separated list only —
`StrSelector { "{" @@? ("," @@)* "}" }` (`reader/logql/logql_parser/model.go:74-77`), with
no `||` inside the braces — so prepending is unambiguous.

```ts
// packages/gigapipe/src/query/logql.ts
export function compileStreamSelector(
  filters: ILogStreamFilter[],
  projectId: string,
): string {
  assertProjectLabelValue(projectId);
  const matchers = [
    `${TELEMETRY_PROJECT_LABEL}="${projectId}"`,
    ...filters.map((f) => `${f.name}${OP_TO_LOGQL[f.operator]}${quote(f.value)}`),
  ];
  return `{${matchers.join(',')}}`;
}

/**
 * Prefix assertion, requested by 04-read-path.md D3. Not a parser: it asserts
 * that a string produced by compileStreamSelector still opens with the tenancy
 * matcher, so the transport's enforcement gate has one uniform shape across
 * all three dialects. Safe to call on already-compiled output.
 */
export function assertLogqlScoped(expr: string, projectId: string): void {
  const expected = `{${TELEMETRY_PROJECT_LABEL}="${projectId}"`;
  if (!expr.startsWith(expected)) throw new TenancyError('LogQL query is not project-scoped');
}
```

Two LogQL-specific hazards:

- **Never emit `{}`.** The grammar accepts it (`@@?` is optional), and `planner.check()`
  rejects only macros, so an empty selector would reach `sql.Or()` over zero clauses with
  `HAVING groupBitOr(…) = 0`. The compiler always emits at least the tenancy matcher; a
  regression test asserts it. Q2 tracks what gigapipe actually does with `{}`; the design
  does not depend on the answer.
- **Every stream selector needs stamping, not just the head.** `LogQLScript` is
  `Head AtomExpr` plus `BinOps []BinOpPart`, and `AtomExpr` can itself be a parenthesised
  `LogQLScript` (`logql_parser/model.go:11-14, 37-47`), so a binary expression contains
  several independent selectors. In phase 1 the compiler emits exactly one selector per
  spec and there is nowhere a second can come from — but that is the invariant a raw-LogQL
  phase would have to re-establish, and it has no JS grammar to do it with.

#### 7.4 TraceQL

**(a) Attributes are stored flat and the transpiler strips prefixes.** A bare
`op_project_id="x"` reaches the `default:` branch of `getTerm` and errors with
`unsupported attribute op_project_id` (`attr_condition.go:221`). The prefix is mandatory.
`span.`, `resource.` and `.` are all stripped to the same key
(`attr_condition.go:158-166`), so the choice is cosmetic; use `resource.` because that is
where the gateway stamps it.

**(b) The associativity claim in the draft was backwards.** `AttrSelectorExp` is
`Head | BoolLiteral | "(" ComplexHead ")"`, then `AndOr`, then `Tail`
(`reader/traceql/traceql_parser/model_v2.go:79-85`) — **right**-recursive — and
`simpleExpressionPlanner.analyzeCond` folds it right-associatively:

```go
// reader/traceql/traceql_transpiler/clickhouse_transpiler/expression_planner_simple.go:190-196
if exp.Tail != nil {
    res = &condition{
        simpleIdx: -1,
        op:        exp.AndOr,
        complex:   []*condition{res, p.analyzeCond(exp.Tail)},
    }
}
```

So `{resource.op_project_id="x" && a="1" || b="2"}` evaluates as `op AND (a OR b)`, not
`(op AND a) OR b` as the draft asserted. **The parenthesisation rule survives; its
justification changes.** Keep the parentheses, justified as *do not depend on associativity
we do not control* — the grammar is one participle struct away from a change, and the
parenthesised form is correct under both readings.

**(c) A structural chain contains several selectors.** `TraceQLScript` is
`ParenExpr | Head` then `Op (Descendant|NotDescendant|Ancestor|NotAncestor|Sibling|And|Or)`
then `Tail` (`model_v2.go:9-18`), so `{A} &>> {B}` and `{A} || {B}` both contain two
independent `Selector`s — and `Selector.AttrSelector` is optional (`"{" @@? "}"`), so `{}`
is valid TraceQL. Phase 1 compiles a single selector; if a spanset chain is ever exposed,
the compiler emits the tenancy condition per selector and never emits `{}`.

```ts
// packages/gigapipe/src/query/traceql.ts
export function compileTraceQL(spec: ITraceQuery, projectId: string): string {
  assertProjectLabelValue(projectId);
  const tenancy = `resource.${TELEMETRY_PROJECT_LABEL}="${projectId}"`;
  const user = spec.conditions.map(renderCondition).join(' && ');
  return user ? `{${tenancy} && (${user})}` : `{${tenancy}}`;
}

/** Prefix assertion, requested by 04-read-path.md D3. */
export function assertTraceqlScoped(expr: string, projectId: string): void {
  const expected = `{resource.${TELEMETRY_PROJECT_LABEL}="${projectId}"`;
  if (!expr.startsWith(expected)) throw new TenancyError('TraceQL query is not project-scoped');
}
```

#### 7.5 Trace-by-id has no query language at all

`TempoService.GetQueryRequest` (`reader/service/tempo.go:52-102`) filters on `trace_id` and
an optional time window and nothing else. There is no parameter that could add a predicate,
and D10 establishes there is no trace-id intrinsic in TraceQL to pre-check with.

**Changed in this revision: the route is gone, and so is the pre-check's reason to exist
here.** `04-read-path.md` D11 removes every Tempo route from `GIGAPIPE_ROUTES` — including
`GET /api/traces/{traceId}`, on the ground that `TempoService.GetQueryRequest`
(`reader/service/tempo.go:52-102`) applies no project predicate at all, so "given a trace id it
returns another project's spans" — and `06-traces-and-correlation.md` T1/T2 confirms and reads
the trace directly from ClickHouse instead. This document's §7.7 previously kept
`tempoTraceById` in the allowlist, guarded by the pre-check below. **That is withdrawn:** the
gated route is strictly worse than no route, because the gate's only home has been deleted by
the document that owns the read keys, and this document's table is the one an implementer
would copy.

The SQL survives — it is still the right ownership query — but its **home moves to
`06-traces-and-correlation.md` §6.3**, beside the direct-SQL by-id read it now guards. It is
kept here for the analysis, and because the three requirements after it are tenancy rules that
apply wherever the query lands.

**The check itself, wherever it runs:**

```sql
-- Ownership pre-check for GET /api/traces/{traceId}. gigapipe's own by-id
-- handler (reader/service/tempo.go:52-102) takes no attribute predicate, and
-- its TraceQL dialect has no trace-id intrinsic (attr_condition.go:151-221),
-- so this cannot be expressed through gigapipe at all.
--
-- tempo_traces_attrs_gin holds one row per (attribute key, value, span).
-- `oid` is degenerate on all three tempo tables but the VALUE DIFFERS:
--   tempo_traces          oid String DEFAULT '0'   (traces.sql:8)   -> '0'
--   tempo_traces_attrs_gin oid String              (traces.sql:22)  -> ''
--   tempo_traces_kv        oid String              (traces.sql:35)  -> ''
-- because neither INSERT column list names oid
-- (writer/service/insert/tempo.go:86-93, :185-190). Do not filter on it in
-- either form.
SELECT 1
FROM gigapipe.tempo_traces_attrs_gin
WHERE key = {key: String}
  AND val = {projectId: String}
  AND trace_id = unhex({traceId: String})
  AND date >= {fromDate: Date}
LIMIT 1
```

Three requirements on this query that the draft did not state:

1. **It fails closed.** A ClickHouse error, a timeout, or zero rows all deny. A `try/catch`
   that returns "allow" on error turns the one direct-SQL control in this document into a
   fail-open one.
2. **It must go through the same table-naming helper the rest of `packages/db` uses.** On a
   clustered deployment (`isClickhouseClustered()` is true unless `SELF_HOSTED`,
   `packages/db/src/clickhouse/client.ts:83-93`) a bare local-table read can miss rows
   written on another node and deny a legitimate user at random — indistinguishable from a
   tenancy bug. See Q3.
3. The `(traceId → projectId)` decision is cached in Redis for 5 minutes.

Because `tempo_traces` is `ORDER BY (oid, trace_id, timestamp_ns)` with `oid` constant, the
leading sort-key column is degenerate and project-scoped trace lookups fall to the GIN
sidecar — which is what this query targets deliberately.

**Rejected: an OpenPanel-side `TelemetryTrace(traceId, projectId, firstSeenAt)` table**
written on ingest. Correct and fast, but a second copy of a high-cardinality fact with its
own retention problem, and it fails **open** for any trace ingested before the table
existed.

#### 7.6 Label, series and metadata endpoints — where the dangerous defaults live

This section is the reason for D8.

**`match[]` is optional, and its absence means unscoped.** `QueryLabelsService.Values` with
an empty `match` plans `clickhouse_planner.NewValuesPlanner(nil, label, nil)`
(`reader/service/query_abels.go:204-207`), which is
`SELECT DISTINCT val FROM time_series_gin WHERE date BETWEEN … AND key = ? AND type IN (n,0)`
with **no fingerprint restriction at all** (`planner_values.go:33-53`). Every label value in
the database, for every tenant.

**Multiple `match[]` values are ORed, not ANDed.** `getMultiMatchValuesPlanner`
(`query_abels.go:242-262`) builds one fingerprint planner per element and combines them with
`MultiStreamSelectPlanner`, which renders as `UNION ALL`
(`planner_multi_stream_select.go:11-27`). `Labels` does the same via `PlanLabels`.

> **Appending a tenancy `match[]` to a user-supplied list WIDENS the result set.** It must
> be injected into every element, or the gateway must emit exactly one element it
> constructed itself. We do the latter.

**Parameters arrive from more places than you expect.**

- `getPromSeriesParamsV2` (`reader/controller/prom_query_labels.go:150-165`) reads `match[]`
  from the **form body and the URL query string** and appends both.
- `ParseLogSeriesParamsV2` (`reader/controller/query_labels.go:108-131`) reads `match[]`
  from form and query string **and** appends the `query` parameter as an extra match
  element (`:124-127`). So `?query=…&match[]=…` unions two selectors.
- `getLabelsParams` (`prom_query_labels.go:179-207`) treats the request as form-encoded only
  when `Content-Type` is **exactly** `application/x-www-form-urlencoded` — a `charset`
  parameter falls through to query-string-only parsing. And on the GET path **both** `start`
  and `end` default to `now-6h` (`:202-203`), an empty window. Always send explicit bounds.
- The Loki-side equivalent has a hardcoded `Limit: 10000` in the planner context
  (`query_abels.go:220`, and again at `:292`): a project with more than 10k distinct metric
  names gets a silently truncated picker. Not a tenancy issue; flagged for the UI stream.

**Endpoints that cannot be scoped and are therefore blocked (D9):**

| endpoint | why it cannot be scoped |
|---|---|
| `GET /api/v1/metadata` | `MetadataService.Metadata` selects `JSONExtractString(labels,'__name__')` and `metadata` from `time_series` filtered only on `metadata != ''` plus an optional exact metric name. No fingerprint restriction, no parameter that could add one. Registered **twice**: `reader/router/misc.go:14` and `reader/router/prometheus_labels.go:22`. |
| `GET /api/v1/query_exemplars` | Aliased to the same `Metadata` handler (`prometheus_labels.go:23`). Same leak, different name. |
| `GET/POST /loki/api/v1/label`, `/loki/api/v1/labels` | The controller passes `nil` for matches unconditionally (`reader/controller/query_labels.go:40-41`). Structurally unscopable — unlike the Prometheus `/api/v1/labels`, which does forward `params.match`. |
| `GET /loki/api/v1/index/stats` | `QueryIndexStats` applies the fingerprint filter only when a stream selector is present; otherwise it aggregates the whole `samples_v3` under `PREWHERE type_v2 IN (0,1)` with no tenant bound. |
| `/loki/api/v1/index/volume`, `/detected_labels`, `/detected_fields`, `/patterns` | Registered only when `DRILLDOWN_SETTINGS.LogDrilldown` is set (`reader/router/query_range.go:25-33`). `QueryVolume` string-interpolates the target-label list into a `sum(bytes_over_time(…)) by (…)` and re-parses it — a `targetLabels` element is a query-injection vector. `05-logs.md` I6/I7 own the scoped forms; the tenancy position is that the unscoped forms are never proxied. |
| `GET /tempo/api/search/tags`, `/api/search/tags` | `GetTagsRequest` is an unfiltered `SELECT DISTINCT key FROM tempo_traces_kv` (`reader/service/tempo.go:161-172`). |
| `GET /tempo/api/search/tag/{tag}/values`, `/api/search/tag/{tag}/values` | `GetValuesRequest` is an unfiltered `SELECT DISTINCT val FROM tempo_traces_kv WHERE key = ?` (`tempo.go:299-311`). |
| `GET /api/metrics/query_range`, `/api/metrics/query` (+ `/tempo/…` aliases) | TraceQL-metrics handlers (`reader/router/tempo.go:31-34`), not Prometheus. Not scoped in P4's design and not needed. |
| `GET /api/traces/{traceId}/json`, `/tempo/api/echo`, `/api/echo` | `reader/router/tempo.go:20-22`. The `/json` alias bypasses §7.5's ownership gate if proxied. |
| `GET /loki/api/v1/tail` | WebSocket (`reader/router/query_range.go:22`); out of scope, not proxied. |
| `/pyroscope/*`, `/querier.v1.QuerierService/*` | Profiles are out of scope entirely, and the `profiles*` tables have no tenant column and are not even in the reader's table registry. |

Their scopable replacements: `/api/v2/search/tags` and `/api/v2/search/tag/{tag}/values`,
both of which accept a TraceQL `query` (`tempo.go:203-292`) — **and both of which fall back
to unscoped when `query == ""`** (`if query != ""` at `:209` and `:257`), so the gateway must
always send one. For metric-name discovery, `/api/v1/label/__name__/values` with an injected
`match[]` (§9). For metric type/help/unit, synthesise from a scoped `/api/v1/series`
response rather than reaching for `/api/v1/metadata`.

**One trap in the scopable path.** `Prom2LogqlMatch` (`query_abels.go:161-184`) converts a
Prometheus `match[]` to a LogQL selector by walking the parsed expression and flattening
**every** `VectorSelector`'s matchers into a single `{…}`. It also `panic(err)`s on an
unparseable match (recovered by `tamePanic`). Both are further reasons the gateway must send
a single, self-constructed selector rather than anything a client typed.

#### 7.7 The allowlist, and the method table

`GIGAPIPE_ROUTES` lives in `packages/gigapipe/src/routes.ts` (D11). Tenancy owns the ingest
keys; `04-read-path.md` owns the read keys. One `as const` object, one owner per key.

```ts
// packages/gigapipe/src/routes.ts
/**
 * Exact paths this gateway may reach on gigapipe. Anything not listed is
 * unreachable by construction. gigapipe mounts read and write routes on one
 * router with no prefix -- writer/router/elastic.go:9-14 puts wildcard Elastic
 * WRITE routes (POST /{target}/_doc, PUT /{target}/_doc/{id}, POST /_bulk) on
 * the same port as every read route, and writer/router/prom.go:9-13 registers
 * remote-write on five separate aliases -- so a prefix pass-through is not a
 * control.
 */
export const GIGAPIPE_ROUTES = {
  // ---- write (tenancy work-stream) ----
  otlpMetrics:     { method: 'POST', path: '/v1/metrics' },
  otlpLogs:        { method: 'POST', path: '/v1/logs' },
  otlpTraces:      { method: 'POST', path: '/v1/traces' },
  promRemoteWrite: { method: 'POST', path: '/api/v1/prom/remote/write' },
  lokiPush:        { method: 'POST', path: '/loki/api/v1/push' },
  // ---- read (read-path work-stream) ----
  promQueryRange:  { method: 'POST', path: '/api/v1/query_range' },
  promQuery:       { method: 'POST', path: '/api/v1/query' },
  promSeries:      { method: 'POST', path: '/api/v1/series' },
  promLabels:      { method: 'POST', path: '/api/v1/labels' },
  promLabelValues: { method: 'GET',  path: '/api/v1/label/:name/values' },
  lokiQueryRange:  { method: 'GET',  path: '/loki/api/v1/query_range' },
  lokiQuery:       { method: 'GET',  path: '/loki/api/v1/query' },
  lokiLabelValues: { method: 'POST', path: '/loki/api/v1/label/:name/values' },
  lokiSeries:      { method: 'POST', path: '/loki/api/v1/series' },
  tempoSearch:     { method: 'GET',  path: '/api/search' },
  tempoTagsV2:     { method: 'GET',  path: '/api/v2/search/tags' },
  tempoValuesV2:   { method: 'GET',  path: '/api/v2/search/tag/:tag/values' },
  tempoTraceById:  { method: 'GET',  path: '/api/traces/:traceId' }, // gated by §7.5
} as const;
```

**Method correction.** The draft said "the whole Loki read family is GET only" and derived
guidance from it that would have made the logs team truncate queries for no reason. The
truth is split across two files:

- **GET-only** (`reader/router/query_range.go:20-23`): `/loki/api/v1/query_range`,
  `/loki/api/v1/query`, `/loki/api/v1/tail`, `/loki/api/v1/index/stats`.
- **`Methods("GET","POST","OPTIONS")`** (`reader/router/select_labels.go:17-20`):
  `/loki/api/v1/label`, `/loki/api/v1/labels`, `/loki/api/v1/label/{name}/values`,
  `/loki/api/v1/series`.

`ParseLogSeriesParamsV2` (`reader/controller/query_labels.go:115-123`) reads `match[]` from
`r.Form` when `Content-Type` is **exactly** `application/x-www-form-urlencoded` (no
`charset` parameter), so the form POST is a real, supported path. The allowlist above uses
POST for `lokiSeries` and `lokiLabelValues` precisely so a long compiled selector is never
squeezed into a URL. **The "if the query does not fit, shorten the query, not use a POST
body" directive is deleted.** It only ever applied to `query_range`/`query`, where it is
still true and where a compiled LogQL query is short by construction.

gorilla/mux answers a method mismatch with **405**, not 404, and *cleans the path with a 301
before any route matches* — a doubled slash silently drops a POST body. Emit canonical
paths, and never probe for a 404 to decide whether a route exists: the status is a function
of build tags and auth config, not of route state.

### 8. Why structured-spec-first makes phase-1 enforcement trivially safe

In phase 1 **there is no untrusted query text anywhere in the system.** The chain is:

```
zMetricQuery            closed enums + two regexes, reserved prefix refused
   |
compileSelector()       the ONLY function in the codebase that emits `{`
   |
one string we built  ->  one allowlisted path  ->  one request we constructed
```

The security argument is a **totality** argument over one function, not a **soundness**
argument over a rewriter. To audit it, a reviewer reads `compileSelector` and answers one
question: *does every return path emit the tenancy matcher?* There is no parser to trust, no
grammar version to track, no evasion class to enumerate, and no "what if the user writes X"
case analysis — because the user cannot write anything.

Compare the raw mode, where the claim becomes: *for every syntactically valid PromQL
expression accepted by Prometheus v0.314.0's parser, the rewriter visits every node that can
cause a series read and inserts the matcher into each.* That is universally quantified over a
grammar, and it is only as true as the grammar-version match. Strictly harder to review,
which is why it is P6.

Phase 1 is also what makes D13 and the response check cheap: the gateway knows structurally
which metric and which labels it asked for, so it can attribute every returned series without
trusting the response, and it can strip `op_project_id` from the label sets before they reach
`FinalChart` without guessing.

### 9. Metric-name enumeration must be scoped, and it can be

Metric-name enumeration across tenants leaks a technology and vendor inventory
(`pg_stat_*`, `rabbitmq_*`, `stripe_webhook_*`, `openai_tokens_total`), service and endpoint
topology (OTel metric names are routinely `<service>_<operation>_duration_seconds`, and
`service.name` becomes `job`), business facts (`signups_total{plan="enterprise"}`,
`churn_risk_score`, `invoice_failed_total`), and deployment shape via `instance`, `job` and
`target_info`'s resource attributes — which, per §4.1, is where every non-identity resource
attribute a customer sets ends up, including `deployment.environment`, `k8s.*` and `cloud.*`.
There is no version of "it's only metadata" that survives contact with a customer.

`__name__` is a label like any other in gigapipe's storage: a key in the `time_series.labels`
JSON, therefore a `(key='__name__', val=…)` row in `time_series_gin`
(`ctrl/qryn/sql/log.sql:131-140`). So `GET /api/v1/label/__name__/values` runs the *same*
code path as any other label (`query_abels.go:187-241` → `planner_values.go`), and injecting
the tenancy `match[]` genuinely scopes it:

```sql
WITH fp_sel AS (
  SELECT fingerprint FROM time_series_gin
  WHERE date >= '2026-08-22' AND type IN (2,0)
    AND (key = 'op_project_id' AND val = 'acme-prod')
  GROUP BY fingerprint
  HAVING groupBitOr(bitShiftLeft(c_0,0)) = 1
)
SELECT DISTINCT val FROM time_series_gin
WHERE date >= '2026-08-22' AND date <= '2026-08-29'
  AND key = '__name__' AND type IN (2,0)
  AND fingerprint IN (SELECT * FROM fp_sel)
LIMIT 10000
```

Without a `match[]` it is completely unscoped (§7.6), which is exactly why D8's rule — the
gateway constructs the whole request and always emits exactly one tenancy-carrying `match[]`
— is not a nicety.

**One structural leak scoping does not close.** Fingerprints hash the label set only
(`unmarshal.go:250-271`) — no type, no tenant. Because our label set always contains
`op_project_id`, two *projects* can never collide. But a series written **without** the label
becomes permanently invisible to every tenant (the benign failure), while a series written
with *someone else's* value is the malign one, and only the ingest gateway prevents that. The
population of unstamped series is therefore something to keep at zero, which is what T1.22
gates on.

### 10. Raw PromQL (P6) — position and contract only

Roughly a third of the draft specified P6 in full implementation detail: a prototyped
rewriter, a 20-row evasion matrix, 26 worked input/output pairs and 45 mandatory tests, ahead
of the argument the team actually has to sign off now. That material is real — it was
produced by running the parser — and it belongs in the P6 implementation PR, not in the
document a reviewer reads to approve P1–P4. What survives here is the position, the parser
choice, the contract and the evasion classes, because they justify D8.

**Position.** Raw PromQL is a **rewriting** problem, not a **validating** problem. We parse,
compute byte-range edits against the original source, apply them right-to-left, then
**re-parse the result and verify**. Regex matching, substring blocklists and "look for the
`{`" are all defeated by a comment or by the quoted-metric-name syntax.

**Parser.** `@prometheus-io/lezer-promql`, pinned to the same version as the Prometheus the
gigapipe image vendors — today both `0.314.0` (`gigapipe/go.mod:44`; the npm package is
published from `prometheus/prometheus`'s `web/ui/module/lezer-promql`). That version-lock by
construction is the argument for this approach: the JS grammar and the Go query engine come
out of the same tree. Confirmed from the 0.314.0 tarball: Apache-2.0, **zero runtime
dependencies**, peers `@lezer/lr ^1.2.3` and `@lezer/highlight ^1.1.2` declared as
`peerDependencies` — so `packages/gigapipe` needs **three** new direct dependencies, not one.

**Version skew is a tenancy bug, not a compatibility bug.** If the JS grammar fails to
recognise a selector form the Go executor accepts, the rewriter silently omits the matcher and
the query runs unscoped. Three controls: the version gate (T2.4), the verify pass, and the
differential test against a live gigapipe (T2.5).

**Contract.** Three exported functions, in `packages/gigapipe/src/query/promql-rewrite.ts`:

```ts
/**
 * Rewrite a user-supplied PromQL expression so EVERY vector selector carries
 * op_project_id="<projectId>". Edits are byte-range splices against the
 * ORIGINAL source, applied right-to-left. We never re-serialise the AST: lezer
 * is a parser, not a printer.
 *
 * Fails closed on: any error node (lezer error-RECOVERS by design and will
 * happily hand back a tree for `up{`); length > MAX_RAW_QUERY_BYTES (8192);
 * any matcher naming the reserved namespace; label_replace/label_join whose
 * destination argument is op_*, __name__, or is not a string literal.
 */
export function enforcePromQL(expr: string, projectId: string): string;

/**
 * The verify pass -- double entry, and the single highest-value control here.
 * Re-parses `expr` and asserts (1) no error node; (2) the VectorSelector count
 * is unchanged; (3) EVERY VectorSelector has exactly ONE matcher -- quoted or
 * unquoted -- named op_project_id, whose MatchOp is `=` (never =~, !=, !~) and
 * whose decoded string literal equals projectId.
 *
 * Safe to call on already-compiled output, not just on rewritten raw input --
 * requested by 04-read-path.md D3, which calls it on every PromQL request.
 * The one accommodation that requires: an expression with ZERO vector
 * selectors (`1 + 2`, `time()`) passes and is counted, rather than throwing.
 */
export function assertEnforced(expr: string, projectId: string): void;

/**
 * Decode a PromQL string literal. All THREE quote forms exist in the grammar
 * (promql.grammar:341-345): "..." and '...' with Go escapes, and `...` raw.
 *
 * Getting the escape set wrong is a live evasion, not a theoretical one:
 * verified by running the algorithm against the real 0.314.0 parser with a
 * decoder handling only \\ \" \n \t \r, the input up{"op\x5fproject_id"="v"}
 * is NOT refused -- it rewrites to a query carrying two conjunctive matchers,
 * which is fail-CLOSED (empty result) but silently so, and invisible to the
 * verify pass because the verifier mis-decodes identically.
 *
 * Therefore: implement Go's FULL escape set for the two quoted forms --
 * \a \b \f \n \r \t \v \\ \' \" plus \xHH, \uHHHH, \UHHHHHHHH and \OOO octal
 * -- with backticks raw.
 */
function decodeStringLiteral(literal: string): string;
```

**Grammar shapes that the algorithm depends on**, verified by running `parser.parse()` from
the extracted 0.314.0 package and dumping node names and byte ranges:

1. The child of a bare `VectorSelector` is `Identifier`, not `MetricIdentifier`. `MetricName`
   exists in the term list but is a *second top-level entry point*
   (`@top MetricName { Identifier }`, `src/promql.grammar:15`), used for completion.
2. `offset` and `@` are **ancestors** of `VectorSelector`, not children. `OffsetExpr`,
   `StepInvariantExpr` and `MatrixSelector` are `expr`-wrapping productions
   (`promql.grammar:239-250, 290`), so the bare-identifier insertion point is simply
   `VectorSelector.to` — no reasoning about modifier ordering.
3. `{}` parses **without error** in lezer even though Prometheus's Go parser rejects it. Our
   rewrite turns it into `{op_project_id="p"}` — valid, and a whole-project scan. A cost
   problem, not a tenancy one.
4. A trailing comma is accepted (`("," …)* ","?`, `promql.grammar:268`).

**Evasion classes the AST rewriter survives** (each with a Tier-2 fixture; the worked
input/output corpus ships with the P6 PR):

| class | example | why it survives |
|---|---|---|
| comments | `up # {op_project_id="victim"}` | `LineComment` is a sibling in `@skip` (`promql.grammar:331,335`); no edit lands inside it. A regex approach fails here. |
| comment before/inside the brace | `up{ # c\n job="a"}` | the `{` position comes from `LabelMatchers.from`, never `indexOf('{')` |
| subqueries | `max_over_time(rate(up[5m])[1h:5m])` | full pre-order walk; `NoStepSubqueryIntervalFn` is set (`reader/router/prometheus_query_range.go:36-41`) so subqueries do execute |
| `@` modifier | `up @ end()` | `EnableAtModifier: true` (`prometheus_query_range.go:42`); `StepInvariantExpr` wraps the selector |
| `offset` | `up offset 1w` | same wrapping. `EnableNegativeOffset` is **false** (`:43`), so gigapipe rejects a negative offset the lezer grammar accepts — fail closed, and the compiler must never emit one |
| binary op joining two selectors | `a / on(instance) group_left b` | **the one that bites.** `group_left` copies labels from the right side; an unstamped `b` joins another tenant's series in. Every selector is stamped; there is no "the first one is enough" |
| `__name__` as a matcher | `{__name__=~"up\|down"}` | still a `VectorSelector` with a `LabelMatchers` child; identical insertion point |
| UTF-8 quoted metric name | `{"my.metric", job="a"}` | `QuotedLabelName` is a first-class child of `LabelMatchers`; inserting before it re-parses cleanly |
| quoted label matcher | `up{"op_project_id"="victim"}` | a `QuotedLabelMatcher` names the label through a `StringLiteral`; a check walking only `UnquotedLabelMatcher` never sees it. Refused explicitly |
| escaped reserved name | `up{"op\x5fproject_id"="v"}` | **only survivable with the full Go escape set** — see `decodeStringLiteral` above |
| backtick raw string | `` label_replace(up, `op_project_id`, …) `` | same decoder |
| `label_replace` forging the label | `label_replace(up, "op_project_id", "victim", "", "")` | not a confidentiality leak (`label_replace` relabels the result, it does not re-select) but an integrity one: the chart claims to be another project's. Refused |
| `__name__` rewriting | `label_replace(x, "__name__", …)` | same refusal — it defeats result attribution and D13's response check |

**What the rewriter does not do.** It does not constrain the range window, the step, the
function set, cardinality, or the `{}`-selects-everything case. Those are cost controls, and
conflating them makes the tenancy review harder. They belong in a `zRawQueryLimits` layer,
which must exist before P6 ships, because `{op_project_id="p"}` is a legal whole-project scan
and gigapipe's query timeout is a fixed, non-configurable 30 s
(`reader/router/prometheus_query_range.go:32`).

**Raw LogQL and raw TraceQL are out of scope in every phase.** Neither has a maintained JS
grammar: gigapipe's LogQL and TraceQL parsers are `participle` grammars written in-repo
(`reader/logql/logql_parser/model.go`, `reader/traceql/traceql_parser/model_v2.go`) with no
npm equivalent, so a JS rewriter would be re-implementing a dialect from Go source rather than
sharing one — a much worse risk profile than PromQL's. If either is ever wanted, assume it
needs the gigapipe-fork approach and price the AGPL §13 publication obligation with it
(`10-ops-retention-billing.md:1801-1840`).

### 11. Rollback, kill switch and remediation

The draft had none of this, and §1's own docblock says a rename orphans all historical
telemetry — so every fail-open mode below can produce a permanently mis-stamped population
with no stated way to repair it. That is the gap this section closes.

**Kill switch — no deploy required.** Two independent flags, read per request from Redis with
a 10 s cache, defaulting to *enabled* only when `GIGAPIPE_URL` is set:

| flag | effect | who flips it |
|---|---|---|
| `telemetry:ingest:enabled` | the five ingest routes return `503` + `Retry-After: 300` with a well-formed per-protocol response envelope (§6.3). OTLP clients retry; nothing is lost that the client would not have lost anyway | on-call, during an enforcement incident |
| `telemetry:read:enabled` | every `observability.*` procedure throws `TRPCTooManyRequestsError`, and the UI renders "telemetry temporarily unavailable" rather than an empty chart | on-call, when the response check is firing |

They are independent on purpose: a suspected read-path enforcement bug must not stop ingest
(the data is still correctly stamped and you want it), and a suspected ingest bug must not
blind the operator to what is already stored.

**`GIGAPIPE_URL` unset.** This is the state of every existing self-hosted install after an
upgrade, so it is the *normal* path, not an error path. `isGigapipeEnabled()`
(`04-read-path.md` §4.1) returns false; the ingest routes are **not registered at all**
(a 404, so an OTel exporter's error is honest); the observability UI surfaces are hidden;
`deleteTelemetryFromClickhouse` short-circuits (`10-ops-retention-billing.md:1079` already
guards on it). No migration, no `gigapipe` database, no ClickHouse grant needed.

**Remediation runbook.** Three repair cases, all of which need `ALTER TABLE … DELETE` on the
gigapipe tables in whatever cluster-aware form `10-ops-retention-billing.md` §"Deletion"
defines. `getReplicatedTableName` (`packages/db/src/services/delete.service.ts:1`) and the
`lightweight_deletes_sync: '0'` setting (`:68`) are the two reusable pieces; note that
`delete.service.ts:61` is a line inside a hardcoded `for` loop over OpenPanel's own tables,
**not** a parameterised helper, so the gigapipe purge job is new code owned by the ops stream.

| case | detection | repair |
|---|---|---|
| series stamped with the **wrong** project id | `openpanel_telemetry_response_label_mismatch_total > 0`, or the canary | resolve the affected fingerprints from `time_series` by `simpleJSONExtractString(labels,'op_project_id')`, delete them from `samples_v3`/`metrics_15s` by fingerprint, then from `time_series`/`time_series_gin`. **The data is not recoverable**; the ingesting client must re-send. Say so in the incident note. |
| series stamped with a **truncated** id | `SELECT DISTINCT simpleJSONExtractString(labels,'op_project_id') AS p FROM gigapipe.time_series WHERE length(p) = 103 AND endsWith(p, '...')` | same delete; then fix the project id (Q1) before re-ingesting |
| series written with **no** label | `SELECT count() FROM gigapipe.time_series WHERE NOT simpleJSONHas(labels,'op_project_id')` | unattributable by definition — there is no way to know whose they were. Delete them. This is why T1.22 gates on that count being zero and why `ADVANCED_OMIT_EMPTY_VALUES=true` matters: an unstamped population is exactly what the empty-value fail-open selects. |

**There is no pre-enforcement data.** The `gigapipe` database does not exist until P0 creates
it and nothing writes to it until P1. Written down once so nobody designs a backfill: the
"series written before enforcement existed" hazard named in §3 and §9 is a *future* hazard
created by a bug, never a migration problem.

**If the label name itself has to change**, the answer is: it does not, and the mitigation is
"get it right the first time" plus the purge above. A rename orphans every stored series and
every fingerprint. That is the whole plan; there is no dual-write path that would make it
cheap, because the fingerprint is computed from the label set (`builder.go:351`).

### 12. PII, correlation data, and per-subject erasure

The plan's differentiator — propagating `session.id` and `profile.id` into telemetry so a log
line or a span links back to an OpenPanel session — makes gigapipe a **second store of user
identifiers**, and the tenancy document is where that has to be named even though the erasure
flow does not exist yet.

Three facts that make it harder than the events path:

1. There is no per-subject delete. `samples_v3` has no profile column; a profile id is a
   *value inside a label or a log line*, so erasing one subject is a full-scan
   `ALTER … DELETE WHERE` over the retention window, not a keyed delete.
2. Retention is one global `SAMPLES_DAYS` applied to eight tables
   (`ctrl/qryn/maintenance/rotate.go:122-208`), so "log lines age out in 7 days" is a
   *configuration* claim, not a per-subject guarantee.
3. Log **bodies** are free text. Any per-subject erasure claim over telemetry is
   unenforceable if customers log identifiers into message bodies, which they will.

The tenancy position: **project-scoped deletion is supported and specified (D5); per-subject
erasure inside telemetry is not offered.** That must be stated in the product's data-handling
documentation before telemetry is generally available, not discovered in a DPA review. The
correlation work-stream (`06-traces-and-correlation.md`) owns whether `profile.id` propagation
is opt-in per project; this document's requirement is only that the answer is written down.

### 13. Deployment topology

`10-ops-retention-billing.md` D20 leaves `CLUSTER_NAME` unset on **every self-host surface**,
correctly: `self-hosting/clickhouse/clickhouse-config.xml:24-28` declares a `cluster` macro
but there is no `<remote_servers>` anywhere in the repo, so `CLUSTER_NAME` would make gigapipe
emit `CREATE DATABASE … ON CLUSTER`, which fails, which panics, which crash-loops.

Cloud is a different question and it is **open** (Q3). OpenPanel's ClickHouse is clustered by
default on anything that is not self-hosted — `isClickhouseClustered()` returns true unless
`SELF_HOSTED` is set (`packages/db/src/clickhouse/client.ts:83-93`) and mutations go to
`${table}_replicated ON CLUSTER '{cluster}'` (`:101-106`). With `CLUSTER_NAME` unset gigapipe
creates plain non-replicated `MergeTree` tables (`cmd/gigapipe/main.go:97-98` is the only
place it is read), so on a multi-node ClickHouse a write lands wherever the connection went
and a read may not see it — nondeterministic missing telemetry, indistinguishable from a
tenancy bug, and it would break §7.5's ownership read in the fail-closed direction (deny a
legitimate user at random). The tenancy requirement is narrow and does not depend on how Q3 is
answered: **§7.5's query goes through the same table-naming helper as the rest of
`packages/db`, and denies on error.**

---

## Interfaces

### Exposed by this work-stream

| Symbol | Location | Contract |
|---|---|---|
| `TELEMETRY_PROJECT_LABEL` | `@openpanel/constants` | the literal `op_project_id`. `11-testing-strategy.md:1411` calls it `OP_PROJECT_LABEL`; that is drift, rename it there |
| `TELEMETRY_RESERVED_LABEL_PREFIX` | `@openpanel/constants` | `'op_'`. Nothing under it may be user-supplied (D2) |
| `assertProjectLabelValue(projectId): string` | `packages/gigapipe/src/labels.ts` | throws `TenancyError` unless `^[a-zA-Z0-9_-]{1,100}$`. **Matches `02-ingest-gateway.md` D13 and `04-read-path.md:2099` exactly** — the draft's `^[a-z0-9][a-z0-9_-]{0,62}$` is withdrawn |
| `TenancyError` | `packages/gigapipe/src/labels.ts` | mapped by the transport to `GigapipeScopeError` |
| `isReservedKey(key, protocol): boolean` | `packages/gigapipe/src/labels.ts` | compares the **sanitized** key (D3) |
| `enforceLabelPairs(labels, projectId, protocol, onStripped?)` | `packages/gigapipe/src/labels.ts` | strip-then-append (D7) |
| `sanitizeOtlpKey` / `sanitizeLabelName` | `packages/gigapipe/src/labels.ts` | gigapipe's two key transforms, reproduced |
| `compileSelector(q, projectId): string` | `src/query/promql.ts` | tenancy matcher first, always `=` |
| `compileGroupBy(q): string` | `src/query/promql.ts` | **new** — emits `by (op_project_id, …)`; required for a non-vacuous response check |
| `compileStreamSelector(filters, projectId): string` | `src/query/logql.ts` | emits `{op_project_id="<pid>",…}`, never `{}` |
| `compileLineFilter(search): string` | `src/query/logql.ts` | Go-style quoted literal; escapes `\` and `"` |
| `compileTraceQL(spec, projectId): string` | `src/query/traceql.ts` | emits `{resource.op_project_id="<pid>" && (…)}` |
| `assertLogqlScoped` / `assertTraceqlScoped` | `src/query/{logql,traceql}.ts` | **requested by `04-read-path.md` D3 — accepted.** Prefix assertions, safe on compiled output |
| `assertEnforced(expr, projectId): void` | `src/query/promql-rewrite.ts` | **`04-read-path.md`'s second request — accepted**, with one accommodation: a zero-selector expression passes and is counted rather than throwing, so it is safe to call on every PromQL request |
| `GIGAPIPE_ROUTES` (ingest keys) | `src/routes.ts` | the five write paths; read keys owned by `04-read-path.md` |

### Consumed from other work-streams

| From | What |
|---|---|
| **P0 stack** (`10-ops-retention-billing.md`) | `CLOKI_LOGIN`/`CLOKI_PASSWORD`; no published port; env-only config (a `-config` YAML supplying `database_data` makes `cmd/gigapipe/main.go:85-87` silently ignore every `CLICKHOUSE_*` env var); `CLUSTER_NAME` unset on self-host (D20); **`QRYN_RULER_ENABLED` unset or `false`** (F6); **`ADVANCED_OMIT_EMPTY_VALUES=true`** (§3.1); `QRYN_SYSTEM_SETTINGS_OTLP_MAX_MESSAGE_SIZE` set explicitly so the gateway's body caps are derived from a known number, not the 64 MiB default; `LOG_DRILLDOWN` only if `05-logs.md` needs it, knowing it registers four extra unscoped routes (`reader/router/query_range.go:25-33`); image pinned by digest; the vendored Prometheus version recorded in a checked-in constant for T2.4; auth on both `/metrics` endpoints before the counters land; the §3.3 project-id audit run here |
| **P1 ingest** (`02-ingest-gateway.md`) | the whole gateway. This document supplies §4.8's stamping table, §5's primitives, §6.1's auth rule and §6.3's per-signal response shapes. **Three additions this stream is asking for:** (a) the metrics stamp is resource **and** data point, not data point only (§4.1) — D3 there already says this, the draft here was the outlier; (b) the `protobufjs` unknown-field loss must be stated, pinned and tested (§6); (c) `getId` gains the tombstone + charset guard (§3.3) |
| **P2 read path** (`04-read-path.md`) | `observabilityProcedure`, the transport, the enforcement gate, `isGigapipeEnabled()`, and the read keys of `src/routes.ts`. D1's layer split and D6's share rejection are **adopted verbatim**; the two requested exports are **accepted** |
| **P3 logs** (`05-logs.md`) | **one edit required**: `05-logs.md:323` and `:1619` pin `ADVANCED_OMIT_EMPTY_VALUES: "false"`; §3.1 decides `true`, and re-justifies I2 from I3's `analyzeStreamSelect` path instead. Also: `/loki/api/v1/series` and `/loki/api/v1/label/{name}/values` **accept a form POST**, so the "shorten the query rather than use a POST body" guidance is withdrawn |
| **P4 traces** (`06-traces-and-correlation.md`) | trace-by-id must go through §7.5's ownership read — budget for it. The v1 tags/values routes stay unproxied; the v2 forms must never be called with an empty `query`. `oid` is degenerate on all three tempo tables but holds `'0'` on `tempo_traces` and `''` on the two sidecars; do not filter on either |
| **P5 alerts** (`07-alerting.md`) | the ruler stays off (F6). The evaluator calls **these** compilers with the derived project id; it must not get its own query path. If rule authoring is ever surfaced, rule text is untrusted input and alerting rules must be rejected at the OpenPanel gateway — gigapipe accepts, stores and re-serves them while never evaluating them |
| **Ops / deletion** (`10-ops-retention-billing.md:1078-1095`) | `deleteTelemetryFromClickhouse(projectIds)`, called from inside `deleteFromClickhouse` so both call sites get it. This stream additionally requires the `ProjectIdTombstone` model (§3.3), because the purge is asynchronous and cannot be the boundary |
| **Testing** (`11-testing-strategy.md`) | the live-gigapipe integration harness for T1.19–T1.22, and the fixture corpus |
| **Self-instrumentation** | OpenPanel's own telemetry is a tenant like any other. Give it a real `Project` row on an internal organisation rather than a reserved literal — `op_project_id="__openpanel__"` violates the charset anyway, and a special case here is precisely where the first bypass gets written |

---

## Failure modes

| # | failure | mechanism | direction | control |
|---|---|---|---|---|
| **F1** | A read path forgets the matcher | a new endpoint proxied without going through a compiler; a `match[]`-less label call | **fail open** — full cross-tenant read | the exact-path allowlist (§7.7) + `04-read-path.md` D2's structural gate (a request declaring `dialect: null` does not open a socket) + the response check |
| **F2** | `match[]` appended rather than injected per element | `UNION ALL` (§7.6) | **fail open** | the gateway constructs the whole request; T1.14 asserts exactly one `match[]` |
| **F3** | Raw-PromQL rewriter misses a selector | grammar skew, new syntax, recovered parse tree, quoted matcher form, mis-decoded escape | **fail open** | `assertEnforced` (§10) + the differential test (T2.5) |
| **F4** | Ingest appends without stripping | duplicate label (remote-write / Loki) or `";"`-joined value (OTLP metrics) | remote-write/Loki: **fail open on read**; OTLP metrics: fail closed | strip-then-append (§5), one duplicate test per protocol |
| **F5** | Ingest stamps the wrong level | resource-only on metrics → invisible series **and** an unstamped `target_info` population; resource-only on logs when the client sets a record attribute | metrics: fail closed *and* it manufactures F7's fuel. logs: **fail open** — the client picks its tenant | §4.8's per-signal strip sets; T1.5 (logs record level) and T1.3 (metrics both levels) are not optional |
| **F6** | A gigapipe recording rule forges or drops the label | rule storage is global (`ruler/service.go:145-149`, no filter), evaluation is untenanted, the write target is boot-configured, and a rule's static `labels:` block can OVERWRITE a sample's `op_project_id` at writeback | **fail open (write side)** | **the ruler stays disabled.** A P0 compose item, because gigapipe's own `Makefile:5` and `scripts/test/e2e/docker-compose.yml:23` default `QRYN_RULER_ENABLED` to `true` and its rule routes carry no auth of their own |
| **F7** | Project id malformed | `''` → `simpleJSONHas(labels,'op_project_id') = 0` on **both** the LogQL and PromQL paths; `>100 chars` → truncated on write | `''`: **fail open**. over-length: fail closed | `assertProjectLabelValue` at both ends, the `getId` guard (§3.3), the P0 audit, **and** `ADVANCED_OMIT_EMPTY_VALUES=true`, which removes the primitive at the engine |
| **F8** | Project id **reused** after deletion | `getId` collides only against live rows; the row is hard-deleted; ClickHouse telemetry is not | **fail open** — the new project inherits the old one's telemetry, possibly across organisations | `ProjectIdTombstone` (D5) — synchronous, in Postgres. The purge is the second control, not the first |
| **F9** | `X-CH-DSN` forwarded after upstream wires the dormant dialer | §6.2 | fail open, catastrophically | construct outbound requests from scratch; re-audit `writer/chwrapper` on every version bump |
| **F10** | Share path derives the project id but not the query spec | the draft's own bug: `next({ ctx: { telemetryProjectId } })` over a client-supplied spec | **fail open** — any public share link becomes a read of the project's whole telemetry estate | `shareId` is rejected outright in P2; when enabled, the four-field window allow-list (§7.1) |
| **F11** | Response-side check disabled, sampled away, or vacuous | §"Response-side verification" | silent — removes the detector, not the boundary | the check is on by default and `compileGroupBy` keeps the label through aggregation so there is no vacuous mode |

### What the user sees

| situation | response |
|---|---|
| ingest with a client `op_*` attribute | request succeeds; the OTLP `partial_success` message names the stripped keys; nothing in the UI |
| ingest for a project whose id fails the charset | `403` naming the project and saying the fix is to rename it — because that *is* the fix |
| ingest while `windDownStep ∈ {blocked, final_warning}` | the per-protocol block response `02-ingest-gateway.md:378-394` defines. **Never a bare 202 with a JSON body**: an OTLP exporter treats any 2xx as delivered |
| ingest while gigapipe is down | `503` + `Retry-After`; OTLP clients retry. Never 200-with-`partial_success` (`02-ingest-gateway.md` D7) |
| read of another project | `FORBIDDEN`, from `observabilityProcedure`, before any gigapipe call |
| read with a nonexistent or non-public `shareId` | `FORBIDDEN` — after the try/catch in §7.1 maps `validateShareAccess`'s plain `Error` throws, which are `INTERNAL_SERVER_ERROR` today |
| a compiler throws `TenancyError` | `500` with a generic message; the refusal counter increments with a `reason` label; the original input is logged at `warn`. Never an empty chart |
| the response check fires | the response is dropped and the query errors. An empty chart would hide a breach |

### Detection

**(a) Response-side verification.** For every response shape carrying label sets, assert that
every returned series carries `op_project_id === <derived project id>`. Drop the response and
raise on mismatch. This catches F1, F2 and F3 at read time regardless of cause.

The draft was honest that an aggregating query drops the label, and then specified a
`mode: 'aggregated'` that "still asserts that no series carries a *different* project id" —
which for an aggregated result is **vacuously true for every series**, because the label is
absent from all of them. The control table credited that mode for F1/F2/F3. A reviewer is
right that this overstated coverage exactly where the analysis said it was weakest.

**The fix is in the compiler, not the checker.** `compileGroupBy` (§7.2) emits
`by (op_project_id, …)`. The label is single-valued by construction, so it adds no series and
no cardinality; `sum by (op_project_id, job)(…)` returns exactly what `sum by (job)(…)` would,
with one extra label. Strict mode therefore applies to **every** response and `'aggregated'`
mode is deleted. D13 strips the label in the same pass, before `FinalChart`.

Note §4.7: gigapipe adds `service_name` on its own, so this must never be a set-equality
check.

**(b) A tenancy canary.** `apps/worker/src/jobs/cron.telemetry-tenancy-probe.ts`, in the
existing `cron.*.ts` family. For two synthetic probe projects A and B it writes a series
`op_tenancy_canary` **through the real ingest gateway**, then issues a scoped read as A and
asserts B's canary is absent, and vice versa. Every 15 minutes. This is the only control that
exercises ingest → storage → query end to end, including the ClickHouse-level behaviours
marked UNVERIFIED, and that is worth its cost.

The draft specified the mechanism and none of the operational surface. Concretely:

- **Ownership.** A dedicated internal organisation (the same one self-instrumentation uses),
  with `deleteAt` never set and both projects created by the P0 provisioning step, not by
  hand. They appear in that organisation's project list and nowhere else.
- **Credentials.** Two `ClientType.telemetry` clients, secrets in the worker's existing
  secret surface (`TELEMETRY_CANARY_A_SECRET` / `_B_SECRET`). The worker already holds
  service credentials; this adds two, not a new mechanism.
- **Metering.** Canary volume is **excluded** from per-project metering by project id, in the
  same place the billing stream excludes any other internal project. Two series every 15
  minutes is negligible in cost and non-negligible in a customer-facing invoice.
- **Retention.** The canary projects get the shortest configured tier; nothing needs to be
  kept beyond the last few probes.
- **Failure delivery.** The repo has exactly one alerting path —
  `NotificationRule → Notification → integration delivery` — and it has no periodic producer
  today (`apps/worker/src/jobs/cron.data-health.ts` deliberately bypasses it and calls
  `sendEmail` directly). Rather than build the first cron→NotificationRule bridge inside a
  security control, **the canary logs at `error` with a stable message and increments
  `openpanel_telemetry_response_label_mismatch_total`; the page is configured out-of-band on
  that counter**, alongside every other infrastructure alert. If `07-alerting.md` later builds
  the bridge, this moves onto it.

**(c) Counters.** Four, in `apps/api`:

```
openpanel_telemetry_enforcement_refusals_total{reason="parse_error"|"verify_failed"|"reserved_label"|"invalid_project_id"|"label_forgery"|"share_denied"}
openpanel_telemetry_ingest_stripped_total{signal=...,level="resource"|"scope"|"record"|"datapoint"|"series"}
openpanel_telemetry_query_no_selector_total
openpanel_telemetry_response_label_mismatch_total
```

`ingest_stripped_total > 0` means real clients are sending `op_*` attributes. Benign causes
exist (D2 accepts them), so it is a dashboard signal, not a page — but a sudden rate from one
client is worth a look, and it is the measurement Q6 turns on.
`response_label_mismatch_total > 0` **is** a page: enforcement was bypassed and the detector
caught it. Never put the project id in a metric label — that is unbounded cardinality on our
own `/metrics`.

**A dependency the draft missed.** `new client.Counter(...)` in `apps/api` **will not
resolve**. `apps/api/package.json:49` declares `fastify-metrics: ^12.1.0` and no
`prom-client`; `pnpm-lock.yaml:33504-33508` shows `prom-client@15.1.3` reachable only as
`fastify-metrics`'s dependency; and there is no `.npmrc` at the repo root, so pnpm's isolated
`node_modules` layout makes the import a hard `MODULE_NOT_FOUND`. This is the same rule
`02-ingest-gateway.md` D4 applies to `protobufjs` and `long`. **Add `prom-client` (pinned to
`15.1.3`, the version `fastify-metrics` resolves) as a direct dependency of `apps/api`.**
That settles the dependency half of the question without installing anything; Q4 is what
remains.

**(d) Structured logging.** Every compiled query logged at debug with
`{ projectId, endpoint, compiledQuery }` through the existing pino logger; every refusal
logged at warn with the *original* input.

**(e) A prerequisite.** `self-hosting/caddy/Caddyfile.template:4` uses `handle_path /api*`,
which strips the prefix, so `https://$DOMAIN/api/metrics` currently serves the API's
prom-client dump unauthenticated (`apps/api/src/app.ts:372` registers `metricsPlugin` at
`/metrics`). Adding tenancy counters makes an existing exposure slightly more interesting.
Putting auth on both `/metrics` endpoints is a P0 prerequisite, not a P6 nicety.

---

## Test requirements

Two tiers. **Tier 1 must exist before any telemetry ships.** **Tier 2 must exist before raw
PromQL is enabled**, and "enabled" means the feature flag flips, not that the PR merged.

Conventions follow the repo: colocated `*.test.ts` under vitest.
`packages/trpc/src/routers/share.test.ts` is the model — a hostile-caller regression suite
written after a real share-access CVE (GHSA-7gv7-c464-9wh8), which is exactly the genre needed
here. Note that `apps/api/src/utils/auth.ts` has **no test file at all** today, and
`packages/mcp/src/auth.test.ts:8` mocks `ClientType` as a plain object literal, so it cannot
catch a missing case for a new enum value.

### Tier 1 — gating

**`packages/gigapipe/src/labels.test.ts`**

| # | assertion |
|---|---|
| T1.1 | `assertProjectLabelValue` rejects `''`, a 101-char value, `a"b`, `a\b`, `a b`, `a.b`, and a value containing a newline; accepts `acme-prod`, `2024`, a 36-char UUID, `a`, and a 100-char value |
| T1.2 | `isReservedKey` returns true for `op_project_id`, `op.project.id`, `op-project-id`, `op project id`, `op_anything` under all four sanitizing protocols; `isReservedKey('op.project.id','otlp-traces')` is **false** (keys stored verbatim) while `isReservedKey('op_project_id','otlp-traces')` is true |
| T1.3 | `enforceLabelPairs` on inputs with zero, one and three pre-existing reserved pairs returns exactly one, with our value, calls `onStripped` per removal, and preserves the order and identity of every non-reserved label |

**Ingest enforcers** (`packages/gigapipe/src/ingest/*.test.ts`)

| # | assertion |
|---|---|
| T1.4 | metrics: the tenancy attribute appears on **every** data point of gauge, sum, histogram, exponential histogram and summary — **and** on the `ResourceMetrics` resource, so the emitted `target_info` carries it. Assert both, in one test, against a decoded fixture. This is the §4.1 regression |
| T1.5 | logs: a **record**-level `op_project_id` is removed and does not override the stamped resource value (§4.4). The highest-risk test in the suite |
| T1.6 | logs: scope- and resource-level values are removed; the stamp survives when the record also sets `level`, `trace_id`, `span_id` |
| T1.7 | metrics: a client `op_project_id` at resource, scope and data-point level is each removed, and the output data point carries exactly one — guarding the `";"` concat of §4.2 |
| T1.8 | traces: a **span**-level `op_project_id` is removed even though resource wins today; the resource stamp is on every `ResourceSpans`; a kvlist attribute whose top-level key is `op_project_id` is removed |
| T1.9 | remote-write: a `WriteRequest` already containing `op_project_id` yields exactly **one**; every `TimeSeries` is stamped, not just the first; `op-project-id` is removed |
| T1.10 | Loki push: a payload carrying **both** `stream` and `labels` on one entry yields exactly one tenancy label (`unmarshal.go:71-119`); every stream in a multi-stream push is stamped |
| T1.11 | any `op_*`-aliasing attribute at any level of any protocol is removed **and counted** on the strip counter |

**Compilers** (`packages/gigapipe/src/query/*.test.ts`)

| # | assertion |
|---|---|
| T1.12 | `compileSelector` always begins the matcher list with `op_project_id="<pid>"`; the matcher is never `=~` and never on an empty value; a filter value containing `"`, `\`, `}`, `,`, newline and `#` round-trips through `quote()` and re-parses error-free under `@prometheus-io/lezer-promql`; every `fn` × `aggregation` combination parses and contains exactly one tenancy equality matcher |
| T1.13 | `compileGroupBy` emits `op_project_id` first in the `by` list for every spec, including `groupBy: []` |
| T1.14 | LogQL: never emits `{}`; the tenancy matcher is first; same escaping matrix. TraceQL: uses the `resource.` prefix (a bare name errors at `attr_condition.go:221`); user conditions containing `\|\|` are wrapped in parentheses (assert the exact string); zero conditions yields `{resource.op_project_id="<pid>"}` with no dangling `&&` and never `{}` |
| T1.15 | `assertLogqlScoped` / `assertTraceqlScoped` accept every `compile*` output for the right project id and reject it for a different one |

**The outbound client** (`packages/gigapipe/src/routes.test.ts` + transport tests owned by `04-read-path.md`)

| # | assertion |
|---|---|
| T1.16 | no client header reaches the outbound request; specifically `X-CH-DSN`, `x-ch-dsn`, `X-Scope-Meta`, `X-Ttl-Days`, `X-Async-Insert` are absent |
| T1.17 | a path not in `GIGAPIPE_ROUTES` throws rather than being proxied |
| T1.18 | `/api/v1/metadata`, `/api/v1/query_exemplars`, `/loki/api/v1/label`, `/loki/api/v1/labels`, `/loki/api/v1/index/stats`, `/loki/api/v1/index/volume`, `/tempo/api/search/tags`, `/api/search/tag/{tag}/values`, `/api/metrics/query_range`, `/api/traces/{id}/json`, `/loki/api/v1/tail` are all unreachable through the client |
| T1.19 | label endpoints emit exactly **one** `match[]` (the §7.6 `UNION ALL` regression), always send explicit `start` and `end`, and never call `/api/v2/search/tag*` with an empty `query` |
| T1.20 | every outbound path is canonical (no `//`, no `.`/`..` segments) — gorilla 301s and drops POST bodies; `/v1/metrics` always carries an explicit `Content-Type` |

**The read boundary** (`packages/trpc/src/routers/observability.test.ts`, modelled on `share.test.ts`)

| # | assertion |
|---|---|
| T1.21 | anonymous caller with no `shareId` → rejected; valid session without `getProjectAccess` for the requested project → rejected; any non-null access level → allowed |
| T1.22 | **any** `shareId` is rejected with `FORBIDDEN` in P2 — including a valid one, a nonexistent one, and a non-public one (the last two exercise the try/catch that maps `validateShareAccess`'s plain `Error` throws) |
| T1.23 | a metrics query cannot be reached through `overviewProcedure` (`routers/overview.ts:57`) or the widget router (`routers/widget.ts:118-160`), so "we forgot" and "we decided" stay distinguishable |
| T1.24 | **behavioural cache-order test**, replacing the draft's "assert on the procedure's middleware order": two callers with different sessions and identical raw input do not share a cache entry, and a cache *hit* still runs the access check. `@trpc/server ^11.17.0` does not expose middleware order in its public API (`procedure._def.middlewares` is internal and unstable across minors), so the ordering invariant has to be asserted through behaviour. The repo's existing `procedure.use(cacher)` composition already gives the right order, so the risk this guards is a future refactor |
| T1.25 | `getId('project', …)` refuses a tombstoned slug, refuses a slug failing `^[a-zA-Z0-9_-]{1,100}$`, and retries into a valid one; `deleteProjects` writes a tombstone row in the same transaction as the delete |

**Integration — needs a live gigapipe** (owned jointly with `11-testing-strategy.md`)

| # | assertion |
|---|---|
| T1.26 | ingest one metric, one log line and one span as project A and as project B; every read surface as A returns A's data and none of B's: `/api/v1/query_range`, `/api/v1/series`, `/api/v1/label/__name__/values`, `/loki/api/v1/query_range`, `/api/search` |
| T1.27 | as A, `/api/v1/label/__name__/values` does not contain B's metric name (§9) |
| T1.28 | ingest as A with a client-supplied `op_project_id: B` at **every level of every protocol**; read as B; assert nothing appears |
| T1.29 | trace-by-id for a trace owned by B, requested as A, is refused before any gigapipe call (§7.5); and a ClickHouse error on the ownership query also refuses |
| T1.30 | `SELECT count() FROM gigapipe.time_series WHERE NOT simpleJSONHas(labels, 'op_project_id')` is **0** after the suite. This is the gate the draft's metrics rule would have made unpassable (§4.1) |
| T1.31 | after `deleteFromClickhouse([A])`, a scoped read for A returns nothing **and** the underlying gigapipe rows are gone; and `getId('project', A.name)` does not return A's old id |

### Tier 2 — the gate on raw PromQL

| # | assertion |
|---|---|
| T2.1 | the worked-output corpus (≥26 expressions, shipped with the P6 PR) produces exact output strings and every one passes `assertEnforced` |
| T2.2 | every evasion class in §10's table is a fixture. Explicitly including: `up{"op_project_id"="v"}`, `` label_replace(up, `op_project_id`, …) ``, `label_replace(up, 'op_project_id', …)`, `label_replace(up, up, …)` (non-literal destination), and — new, and the reason `decodeStringLiteral`'s contract is spelled out — `up{"op\x5fproject_id"="v"}`, `up{"op_project_id"="v"}` and `label_replace(up, "op\x5fproject_id", …)`, each asserting **REFUSED** |
| T2.3 | `assertEnforced` throws on: a hand-mangled output missing one matcher; a `=~` matcher; a different project id; **two** tenancy matchers on one selector (the count is `=== 1`, not `>= 1`). And it **passes** on a zero-selector expression (`1 + 2`), incrementing `query_no_selector_total` — the accommodation that makes it safe for `04-read-path.md` to call on every request |
| T2.4 | the resolved `@prometheus-io/lezer-promql` **major.minor** equals the Prometheus major.minor vendored by the pinned gigapipe image, read from a checked-in constant. **Not exact equality**: the npm package publishes patch releases with no Go counterpart (the registry shows 0.313.0, 0.313.1, 0.313.2 then 0.314.0, while `prometheus/prometheus` has no v0.313.1 or v0.313.2), and a gate that fires on a benign patch bump is a gate that gets marked `skip`. The exact resolved version is still recorded for the audit trail |
| T2.5 | **differential**: for a corpus of ≥200 expressions (every Tier-2 fixture plus Prometheus's own `promql/parser` testdata), the rewritten query submitted to a live gigapipe returns HTTP 200 or a *semantic* error — never a parse error. A Go-side parse error on a JS-rewritten query **is** the skew signal. With two projects' data loaded, every response contains only the querying project's series |
| T2.6 | negative-offset expressions (`up offset -5m`) are refused *somewhere* and never silently succeed — lezer accepts them, `EnableNegativeOffset: false` rejects them |
| T2.7 | the tenancy canary has been green for 24 h before the flag flips |

---

## Open questions

| # | question | how to settle it |
|---|---|---|
| **Q1** | Do any existing `Project` rows violate `^[a-zA-Z0-9_-]{1,100}$`? Empty and over-length ids are both reachable (§3, verified by execution). | `SELECT id, name FROM projects WHERE id !~ '^[a-zA-Z0-9_-]{1,100}$';` against a production replica. Any hit is a product decision (rename, or per-project telemetry opt-out) before P1. Blocker: needs production DB access. |
| **Q2** | **UNVERIFIED:** does ClickHouse's `JSONExtractKeysAndValues` return both pairs for a duplicate JSON key? Decides whether F4 on remote-write/Loki is fail-open or fail-closed. | `SELECT JSONExtractKeysAndValues('{"a":"1","a":"2"}','String')` against `clickhouse/clickhouse-server` at the pinned tag. The design is safe either way; this only changes how F4 is described. |
| **Q3** | On **cloud** (clustered ClickHouse), what does gigapipe's DDL produce with `CLUSTER_NAME` unset, and is OpenPanel's Distributed-table convention compatible? `10-ops-retention-billing.md` D20 answers only the self-host case. | Owned by the ops stream. Stand up gigapipe against a two-node ClickHouse, ingest, and read from the other node. Until answered, §7.5's ownership read must use the shared naming helper and deny on error — which it does regardless. |
| **Q4** | **UNVERIFIED:** does `fastify-metrics@^12` gather `prom-client`'s *default* registry, or a private one? Decides whether §"Counters" registers a plain `new client.Counter()` or goes through the plugin's registry. | The dependency half is settled (add `prom-client@15.1.3` as a direct dep of `apps/api`; `pnpm-lock.yaml:33504-33508`). What remains: `pnpm i && node -e "const c=require('prom-client'); …"` plus one line of `fastify-metrics/dist/index.js`. Blocker: `node_modules` is not installed in this checkout. |
| **Q5** | Do telemetry tokens need to be **org**-scoped as well as project-scoped? `client.create` requires a non-null `projectId`, so an org-level collector token (one agent shipping for many projects, choosing per request) is not reachable today. | Product decision, and far cheaper now than after data exists: if yes the label becomes a **pair** (`op_org_id` + `op_project_id`) and every compiler emits both. D2's reserved prefix already makes adding the second label a non-migration. |
| **Q6** | Should the reserved namespace narrow from `op_` to an exact set? D2 accepts the cost of stripping a customer's `op_code`/`op_name`; the reviewer who raised it is right that the collision is real. | Measure `openpanel_telemetry_ingest_stripped_total` by sanitized key over the first 60 days of real traffic. If benign `op_*` keys dominate, narrow **before GA** — after GA it is a breaking change in the wrong direction (§D2). |
| **Q7** | Is `profile.id` / `session.id` propagation into telemetry opt-in per project? §12 states that per-subject erasure inside telemetry is not offered; whether that is acceptable depends on whether the identifiers are there by default. | Owned by `06-traces-and-correlation.md` plus a data-handling review. This document's requirement is only that the answer is written down before GA. |
| **Q8** | If gigapipe is ever forked, does enforcement move into the Go transpiler? There is a literal `case *parser.VectorSelector: // No-op` at `reader/promql/promql_transpiler/transpiler_v2.go:84`, inside a `Walk` that already traverses every node, two lines downstream of `promql_parser.Parse`, with a mutable `LabelMatchers` slice. Enforcement inside the engine that executes the query is strictly safer than a transformation upstream of it. | Depends on the P0 fork decision, which is also the AGPL §13 publication trigger (`10-ops-retention-billing.md:1801-1840`). It would *still* need a per-request tenant, which the reader has no mechanism to carry (D1), so this is only worth revisiting if a fork is taken for other reasons. Currently: **not taken.** |

---

## Effort

Honest sizing, in engineer-weeks, for one engineer who has read gigapipe. The draft had none
of this and a reviewer was right to call the "Tier 1 must exist before any telemetry ships"
gate unbounded without it.

| Work | Weeks | Notes |
|---|---|---|
| `packages/constants` declaration, `labels.ts` primitives + `labels.test.ts` (T1.1–T1.3) | **0.4** | Small and fully specified. The gigapipe sanitizer reproductions are the only subtlety |
| `getId` guard + `ProjectIdTombstone` model, migration, backfill, `deleteProjects` write, tests (T1.25) | **0.5** | Touches a shared function on the project-creation hot path; needs care and a review from whoever owns onboarding |
| The three query compilers + `compileGroupBy` + the two prefix assertions + tests (T1.12–T1.15) | **0.8** | The compilers are short; the escaping matrix and the `fn × aggregation` cross-product are most of it |
| `routes.ts` ingest keys + allowlist tests (T1.16–T1.20) | **0.3** | Shared file with the read-path stream; coordinate before writing |
| `validateTelemetryRequest` + `clearTelemetryAuth` + the three deny-list inversions + `client.ts` enum widening + negative tests | **0.6** | `apps/api/src/utils/auth.ts` has no test file, so this creates one from scratch. Four files, four PRs' worth of review attention |
| Response-side verification + the four counters + `prom-client` dependency | **0.4** | Blocked on Q4 for the registry question only |
| The tenancy canary, end to end (provisioning, credentials, metering exclusion, the cron job) | **0.6** | The provisioning and metering-exclusion halves are where the time goes, not the probe |
| Kill switch + `GIGAPIPE_URL`-unset path + the remediation runbook rehearsed once against a live stack | **0.5** | The rehearsal is the point; an unrehearsed runbook is a document |
| Integration suite T1.26–T1.31 against a live gigapipe | **0.8** | See below |
| **Tier 1 total** | **≈ 4.9** | ~5 engineer-weeks, plus review |
| P6: `promql-rewrite.ts` (prototyped already), `decodeStringLiteral` with the full Go escape set, `assertEnforced`, `zRawQueryLimits`, Tier 2 | **2.5–3.5** | The rewriter exists as a prototype; the escape set, the verify pass and the differential harness are the real work |

**What would make it bigger.**

- **The live-gigapipe CI job (T1.26–T1.31, T2.5) is the largest single risk.** It needs a
  ClickHouse and a gigapipe in CI, the `gigapipe` database provisioned, two projects and two
  telemetry clients seeded, and an ingest→visible-in-query settle time that is inherently racy
  (`BULK_MAX_AGE_MS=2000` per `10-ops-retention-billing.md` D6). Budget **0.5–1.0 weeks to
  stand up** on top of the 0.8 above, and expect ongoing flake maintenance. `.github/smoke`
  already boots a stack, which is the cheapest place to hang it. If this is not funded, T1.26–
  T1.31 will be run manually before P1 ships and then rot — say that out loud rather than
  discovering it.
- **Q1 coming back non-empty.** A production project with an empty or over-length id turns a
  regex into a product conversation and a data migration.
- **Q5 answered "yes".** An org-level label doubles every compiler's matcher list and, if
  decided *after* data exists, requires a re-ingest. It is the cheapest question on the list to
  answer early and the most expensive to answer late.
- **`protobufjs` not preserving unknown fields** (§6, UNVERIFIED). If the answer is "cannot be
  configured", the OTLP proto pin becomes a recurring maintenance item with a customer-visible
  failure mode, and someone has to own the bump cadence.

**Which Tier-1 rows genuinely gate, and which can land alongside the feature.**

- **Gate P1 (ingest) absolutely:** T1.1–T1.11 (the primitives and every ingest enforcer),
  T1.25 (the tombstone), T1.28 and T1.30 (cross-protocol forgery, and zero unstamped series).
  These are the write side; a mis-stamped series is not repairable, only deletable.
- **Gate P2 (first read surface):** T1.12–T1.24, T1.26, T1.27.
- **May land in the same PR series as the feature:** T1.29 with P4, T1.31 with the ops
  deletion work, T1.23 with whichever phase first adds an observability UI surface.
- **Gate the P6 flag, not the P6 merge:** all of Tier 2.
