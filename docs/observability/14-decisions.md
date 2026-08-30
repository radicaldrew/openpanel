# Decision register

The eleven work-stream specs were written in isolation and disagree with each other on
roughly a dozen shared facts (`13-cross-cutting-findings.md`). Those disagreements are
not defects an agent can resolve — each produced several confident, well-argued answers
precisely because nobody owned the call.

This is where the calls are made. **A decision here overrides every spec.** Where a spec
contradicts one below, the spec is wrong and gets patched.

| | Decision | Status |
|---|---|---|
| D1 | Shared ClickHouse, separate databases | **SETTLED** |
| D2 | Cluster mode must be stated explicitly | **SETTLED** |
| D3 | gigapipe gets a constrained ClickHouse user | **SETTLED** |
| D4 | Database name and one naming helper | **SETTLED** |
| D5 | Log ingest is Loki JSON, and moves out of P1 | **SETTLED** |
| D6 | `type = 0` retention | **DEFERRED to P3** |
| D7 | Pre-created tables and `PARTITION BY` | **DEFERRED to P3** |
| D8 | `ADVANCED_OMIT_EMPTY_VALUES=true` | **SETTLED** |
| D9 | `LOG_DRILLDOWN=false` | **SETTLED** |
| D10 | One credential name per side | **SETTLED** |
| D11 | Pin the gigapipe image | **OPEN — operator** |
| D12 | Metrics are stamped per DATA POINT, not per resource | **SETTLED — empirically** |
| D13 | Metric reports are blocked on public share links | **SETTLED** |
| D14 | Traces strip reserved keys at span, event and link level | **SETTLED — empirically** |
| D15 | Per-signal retention REQUIRES `type` in `PARTITION BY` | **SETTLED — empirically** |
| D16 | Correlation attributes are `openpanel.*`, never `op_*` | **SETTLED — empirically** |

---

## D1 — Deployment topology · SETTLED

**gigapipe and OpenPanel share one ClickHouse server, in separate databases.** No second
ClickHouse. gigapipe runs as an internal compose service against `op-ch`.

Consequences, also settled: cluster mode is inherited rather than chosen (D2); resource
isolation becomes a P0 requirement rather than a P2 nicety (D3); backups and storage
policy are decided per-database.

Still to decide, not blocking: whether backup jobs include the telemetry database.
Recommendation is **exclude** and rely on retention — telemetry is regenerable in a way
analytics events are not.

**Built:** `op-gigapipe` service in `docker-compose.yml` and
`self-hosting/docker-compose.template.yml`; `packages/db/code-migrations/22-telemetry-database.ts`.

---

## D2 — Cluster mode must be stated explicitly · SETTLED

OpenPanel answers "is this ClickHouse clustered?" two ways with **opposite defaults**:

| Helper | Used by | Default when nothing is set |
|---|---|---|
| `getIsCluster()` — `code-migrations/helpers.ts:17-24` | migrations | `false` |
| `isClickhouseClustered()` — `clickhouse/client.ts:83-94` | runtime | `true` unless `SELF_HOSTED` |

On a deployment setting neither, migrations build non-clustered while the runtime believes
otherwise — and gigapipe, pointed at the same server with `CLUSTER_NAME` unset, would
create unreplicated local tables on one node of a replicated cluster: lost on node
failure, invisible to reads landing on another replica.

**Decision: refuse to provision telemetry while the two disagree.** Migration 22 compares
them and fails with instructions rather than picking a side. Self-hosted already sets
`SELF_HOSTED=true`, so both read `false` and the guard passes. Cloud must set
`CLICKHOUSE_CLUSTER` explicitly — which is the point.

This does not fix the underlying inconsistency in the two helpers. It refuses to build on
top of it. Reconciling them is worth doing separately and is out of scope here.

---

## D3 — gigapipe gets a constrained ClickHouse user · SETTLED

gigapipe's reader builds its connection with `Settings: nil` — no `max_memory_usage`, no
`max_execution_time`, no `max_rows_to_read` — and exposes no configuration to change that.
Under D1 it shares a server with the analytics product, so limits **must** be enforced
server-side, attached to the user it connects as.

**Built:** `clickhouse-telemetry-profile.xml` (settings profile + hourly `execution_time`
quota) mounted into `users.d` in both stacks; a `gigapipe` ClickHouse user created by
`init-db.sh` with that profile and grants scoped to the telemetry database only.

The numbers in the profile are starting points, not tuned values. Raise them when a
legitimate query is refused; do not raise them to make an expensive dashboard work — clamp
the query instead.

> `init-db.sh` runs only on a **fresh** ClickHouse data directory. Existing installations
> must apply the `CREATE USER` / `GRANT` block by hand. On managed ClickHouse where
> OpenPanel lacks access-management rights, this is an operator task — which is why
> migration 22 creates the database only and never attempts `CREATE USER`.

**Smoke check, and the only detector for the silently-unauthenticated state in D10:**
an unauthenticated request to gigapipe must return `401`.

---

## D4 — Database name and one naming helper · SETTLED

**`openpanel_telemetry`**, overridable via `CLICKHOUSE_TELEMETRY_DB`, configured into
gigapipe through its own `CLICKHOUSE_DB`. It names the purpose rather than the vendor, so
it survives replacing the engine.

The four competing table-naming helpers across four files reading four env vars (findings
C7, C14, C22) collapse to one: `telemetryTable()` in
`packages/db/src/clickhouse/telemetry-client.ts`.

> **Trap, specific to D1.** Do **not** use `getReplicatedTableName`
> (`clickhouse/client.ts:101-106`) on gigapipe's tables. It returns
> `` `<table>_replicated ON CLUSTER '{cluster}'` `` — OpenPanel's convention for
> OpenPanel's tables. Applied to a gigapipe table it silently targets one that does not
> exist. Sharing one server makes reaching for the existing helper feel natural; findings
> C23 and C42 caught a proposed test gate that *mandates* this mistake on the GDPR erasure
> path.

**Built:** `telemetry-client.ts` — lazy client, `telemetryTable()`, `telemetryQuery()`,
`pingTelemetryClickhouse()`, and a scope comment stating it is for metadata and
housekeeping only, never for reading samples.

---

## D5 — Log ingest is Loki JSON, and moves out of P1 · SETTLED

**`apps/api` decodes OTLP itself and pushes Loki JSON to `/loki/api/v1/push`. It never
forwards OTLP logs to gigapipe.** Doc 05's design wins over doc 02's.

Verified against gigapipe source: its OTLP log decoder folds resource, scope **and record**
attributes into one attribute map and appends `trace_id` and `span_id` as stream labels
(`writer/utils/unmarshal/otlplogs.go:22-58`), and the fingerprint is computed over the
whole surviving label set (`unmarshal.go:250-270`). **One trace id is one new series** —
roughly 10k new series/s for a busy customer, with no configuration that disables it. Data
ingested that way is stored under a key that cannot be rewritten in place, only
re-ingested.

**Consequence, and the reason this is a P0 decision rather than a P3 one: log ingest is
removed from P1 entirely.** P1 ships **metrics ingest only**. Logs become one P3 stream
owning the write path and the read path together, as doc 05 already sequences them. This
deletes the OTLP-logs protobuf re-encode leg from P1's estimate.

Specs to patch: `02` §1/§6.2 and its `type ∈ {1,2}` interface guarantee, `01` §3.1/§4.8
and tests T1.5/T1.6, `04` §2.2's logs row, `09` §6.1 (which reads correlation ids off
stream labels that `05` puts inside the envelope instead), `11` E12–E15.

---

## D6 — `type = 0` retention · DEFERRED to P3

Follows D5. `type` is `0 = UNDEF/both`, `1 = LOG`, `2 = METRIC`, and every gigapipe reader
predicate is `type IN (n, 0)`. Only the Loki JSON decoder emits `type = 0` — so under D5
the question arrives with logs, in P3, not before.

`02`'s claim that `type ∈ {1,2}` is guaranteed *because the gateway does not expose Loki
push* is void under D5. When P3 lands, the invariant must be re-derived from OpenPanel's
own envelope writer never emitting the both-valued index, plus a monitored assertion.

Until then: **one retention window for all signals**, via gigapipe's `SAMPLES_DAYS`.

---

## D7 — Pre-created tables and `PARTITION BY` · DEFERRED to P3

**Migration 22 creates the database and nothing else. gigapipe owns every table in it.**

Pre-creating `samples_v3` with `type` in `PARTITION BY` is what makes per-signal
conditional TTL cheap — `type` is in neither the sort key nor the partition key today, so
a conditional TTL on it is a merge-time full scan. But it is a one-way door and a standing
compatibility contract: ClickHouse's `MODIFY ORDER BY` accepts only columns added by an
`ADD COLUMN` in the same `ALTER`, so a pre-created table whose column order differs from
gigapipe's makes `ctrl.Init` panic and crash-loop the container.

**Per-signal retention only matters once logs ship and want a different window from
metrics — which is P3.** Deferring costs nothing now and removes the plan's only
irreversible P0 decision. Decide it in P3 with real data and a spike result.

Related, and unchanged: `SAMPLES_DAYS` is re-asserted as a `MODIFY TTL` across eight
tables on **every** gigapipe boot (`rotate.go:155-210`), so any hand-set TTL needs a
reconciler. That work also belongs to P3.

---

## D8 — `ADVANCED_OMIT_EMPTY_VALUES=true` · SETTLED

When **false**, gigapipe's LogQL planner walks the selector and silently **removes** any
matcher whose op is `=` or `=~` with an empty value, and any `=~".*"` matcher
(`planner_stream_select.go:31-46`). The compiled `op_project_id` matcher is the only thing
separating tenants on that path, so the fail-safe value is `true`.

gigapipe's `boolEnv` maps unset to `false` (`cmd/gigapipe/main.go:54-62`), and no spec had
this in a compose file — so what would have shipped is the stripping behaviour.

**Built:** set explicitly in both compose files. `05`'s two occurrences pinning `false`
need the one-line edit `01` asked for.

---

## D9 — `LOG_DRILLDOWN=false` · SETTLED

With `true`, gigapipe registers four routes carrying **no tenant predicate**, including
`/loki/api/v1/index/volume`, whose `targetLabels` is string-interpolated into a LogQL
expression that is then re-parsed — a cross-tenant injection with a working proof-of-concept
string in `05` I6.

Off in P0. When P3 wants pattern grouping, turn it on **and** exclude those four routes
from the gateway's route allowlist, with a test.

---

## D10 — One credential name per side · SETTLED

The credential had three names on the OpenPanel side and two on the container side across
the doc set. Frozen:

- **OpenPanel side:** `GIGAPIPE_USER` / `GIGAPIPE_PASSWORD`, plus `GIGAPIPE_URL`.
- **Container side:** `QRYN_LOGIN` / `QRYN_PASSWORD` (canonical; `CLOKI_*` are legacy
  aliases).

**Why this is security-relevant, not bookkeeping:** gigapipe installs its auth middleware
only when *both* values are non-empty (`cmd/gigapipe/main.go:321-324`), and Compose
substitutes a missing `.env` key with the empty string plus a warning. The resulting state
is invisible — `apps/api` keeps sending an `Authorization` header, every healthcheck stays
green, and gigapipe serves `/loki/api/v1/push`, the Elastic `POST /_bulk` write routes and
an always-on cleartext gRPC OTLP receiver to anything on the compose network.

**Built:** `${VAR:?…}` guards on all three secrets in the self-hosting compose, so a
missing value fails the stack loudly instead of quietly disabling auth; secrets generated
in `self-hosting/quiz.ts` rather than prompted; fixed non-empty credentials in dev too.

---

## D11 — Pin the gigapipe image · OPEN, operator

Both compose files use `${GIGAPIPE_IMAGE:-ghcr.io/metrico/gigapipe:latest}`. `latest` is a
moving schema contract against a database OpenPanel shares. **Pin a tag before
production.** I could not verify available tags offline, which is why this is left as an
override with a commented example rather than a guessed pin.

---

## D12 — Metrics are stamped per data point, not per resource · SETTLED

**Found by running it, not by reading.** A resource-only stamp is correct for
logs and traces and is *insufficient for metrics*.

gigapipe's OTLP→Prometheus translation does not put resource attributes on the
metric series. It collects them into a separate `target_info` gauge, and only
`service.namespace`/`service.name` (as `job`) and `service.instance.id` (as
`instance`) propagate onto the series themselves. Everything else on a series
comes from the instrumentation scope and from the **data point's** own
attributes.

Observed in ClickHouse after pushing a resource-stamped payload through a live
gigapipe:

```
{"__name__":"target_info",          ... "op_project_id":"e2e-project" ...}
{"__name__":"http_server_requests_total","job":"checkout-api","route":"/checkout", ...}
                                     ^ no op_project_id
```

The metric series carried **no project label at all**. The consequence is a
boundary that is open in both directions: the read-side matcher
`op_project_id="X"` selects nothing for its own project, and a query without the
matcher selects every project's series.

**Decision: stamp the resource AND every data point.** The resource stamp stays
— it is what makes `target_info` carry the project, which is how a services
overview enumerates what is reporting.

The attribute field number differs per data-point type and getting one wrong
corrupts the payload, so each is named explicitly in
`packages/gigapipe/src/otlp/stamp-metrics.ts`: NumberDataPoint 7,
HistogramDataPoint 9, ExponentialHistogramDataPoint 1, SummaryDataPoint 7.

Re-verified after the fix, same live gigapipe:

```
{"__name__":"dp_requests_total", ... "op_project_id":"e2e-datapoints" ...}
{"__name__":"target_info",       ... "op_project_id":"e2e-datapoints" ...}
```

Specs to patch: `01` D3 (stamps resource only) and `04` §2.2 (requires resource
+ scope + record) both describe the metrics rule incorrectly. `02` §4.2 had it
right — "metrics: every data point" — and is the one to follow.

---

## D13 — Metric reports are blocked on public share links · SETTLED

`chartProcedure` accepts a `shareId`, loads the saved report server-side, and
runs it for an anonymous viewer. With `Report.dataSource` wired, that path would
have executed PromQL without anyone signing in.

**This is not a tenancy hole.** The query comes from the database, was authored
by a project member, and the viewer cannot alter it — the same trust model as a
shared event report. The problem is **cost**: an event report resolves to a
bounded ClickHouse aggregate over one project's data, while a metric report
resolves to a PromQL range query against a backend every project shares, with no
per-share rate limit, no per-share sample budget, and no way to revoke one query
without revoking the whole share.

Blocked in `chart.ts` for both the `chart` and `aggregate` procedures until those
controls exist. Members viewing the same dashboard while signed in are
unaffected — they take the authenticated branch.

---

## D14 — Traces strip reserved keys at span, event and link level · SETTLED

**Found by running it, like D12.** A resource-only stamp is enough to make a
trace *queryable* — verified: a resource-level `op_project_id` lands in
`tempo_traces_attrs_gin` once per span, which is exactly the read predicate. It
is not enough to keep the attribute index clean.

A span attribute named `op-project-id` survived and appeared beside ours:

```
op-project-id   FORGED           2
op_project_id   trace-stripped   2
```

Not exploitable as things stand: gigapipe stores trace attribute keys
unsanitized, so `op-project-id` is a different key from `op_project_id` and
cannot satisfy the ownership predicate. It is a near-miss that becomes real the
day anyone adds sanitization to that path, writes a `LIKE 'op%'` predicate, or
renders span attributes in a UI where a reader would take it for ours.

**Decision: strip reserved keys from span attributes, span event attributes and
span link attributes, in addition to stamping the resource.** After the fix the
index contains `op_project_id` and nothing resembling it, with every legitimate
attribute preserved.

---

## What P4 (traces) contains so far

| Item | Where | State |
|---|---|---|
| Trace stamping + span/event/link stripping | `packages/gigapipe/src/otlp/stamp-traces.ts` | done |
| `POST /telemetry/v1/traces` | `apps/api` telemetry router/controller | done |
| Trace search / get / services (direct SQL) | `packages/db/src/services/telemetry-traces.service.ts` | done |
| `observability.traceSearch` / `.trace` / `.traceServices` | `packages/trpc` | done |
| `observability.logsForTrace` (span↔log correlation) | `packages/trpc` | done |
| Trace search UI + span waterfall | `apps/start/src/routes/…$projectId.traces.tsx` | done |

Reads bypass gigapipe's Tempo API entirely, because it applies no tenant
predicate anywhere. Every aggregate is **span-scoped**, joined on
`(trace_id, span_id)` from the caller's own gin rows — a trace id can legitimately
contain another project's spans (a shared gateway, a reused id, a guessed one),
so computing `spanCount` or `rootService` from `trace_id` alone would describe a
co-tenant's spans.

The root span is `argMin(name, timestamp_ns)` rather than `parent_id = ''`:
in a shared trace the true root may belong to another project, and matching on
an empty parent would return nothing at all.

**Verified live, including the isolation case that matters most:**

```
searchTraces('trace-stripped') -> 1 trace, root "POST /checkout", 2 spans
searchTraces('someone-else')   -> []
getTrace('someone-else', <the correct trace id>) -> []
```

Knowing a trace id does not let another project read it.

**Span↔log correlation** is a line filter, not a selector — `trace_id` is
deliberately not a stream label, which is the entire basis of the log
cardinality design. The filter matches the envelope's own field
(`"tid":"<id>"`) rather than the bare id, so a trace id appearing incidentally
in a log message does not masquerade as a correlated line. Verified live: a line
carrying the id in its envelope matched; a line merely mentioning the same id in
its text did not.

**The waterfall lays out from timestamps, not from nesting.** A trace here is
not guaranteed to be a well-formed tree — this project may own only part of it,
so a span's parent can legitimately be missing. A time-based layout degrades
gracefully: an orphan renders in its correct position instead of vanishing or
forcing a fake root. Depth walking has a cycle guard and a depth cap for the
same reason.

**Session propagation (done).** `op.getTelemetryHeaders()` returns the headers
to attach to your own API calls:

```js
fetch('/api/checkout', { headers: { ...op.getTelemetryHeaders() } })
```

It returns `{}` until a session exists, so it is always safe to spread. The
server reads `x-openpanel-session-id` and sets `openpanel.session.id` as a span
attribute; `observability.tracesForSession` then joins a session to the backend
work it caused.

That join is a plain gin lookup, because the session id is a span **attribute** —
indexed like any other — rather than a metric label. It costs one index row per
span and no series at all, which is exactly why the same id is banned from the
log label set (D5). The session predicate is **intersected** with the ownership
predicate, so a session id guessed from another project returns nothing.

**P4 is complete.**

---

## D15 — Per-signal retention requires `type` in `PARTITION BY` · SETTLED

D6 and D7 were deferred to "when logs ship". Logs have shipped, and running the
stack answers both.

**Observed `type` distribution** with metrics and logs flowing through the real
ingest paths:

```
type  rows  with_string  with_value
1     4     4            0           <- logs
2     5     0            5           <- metrics
```

No `type = 0` rows. D6's premise holds: the closed Loki-JSON ingest path never
emits the both-valued index, because OpenPanel writes the envelope itself. The
`type ∈ {1,2}` invariant is real — but it is now guaranteed by *our envelope
writer*, not by a route not existing, and deserves a regression test.

**And the decisive finding for D7.** gigapipe's own TTL on `samples_v3` is:

```
TTL toDateTime(timestamp_ns / 1000000000) + toIntervalDay(30)
SETTINGS ttl_only_drop_parts = 1, merge_with_ttl_timeout = 3600
PARTITION BY toStartOfDay(toDateTime(timestamp_ns / 1000000000))
```

`ttl_only_drop_parts = 1` means ClickHouse drops **whole parts only, never
individual rows** — that is the entire point of the setting, and it is a large
performance win, because dropping a part is a metadata operation while deleting
rows rewrites parts at every merge.

A conditional `TTL … DELETE WHERE type = 1` is therefore **incompatible with the
table as gigapipe creates it**. Per-signal retention has exactly two options:

1. Set `ttl_only_drop_parts = 0` and accept part rewrites on every merge — a
   permanent, unbounded load on the ClickHouse that also serves analytics.
2. Put `type` in `PARTITION BY`, so each signal lands in its own parts and
   whole-part drops work per signal.

**Option 2 is the answer, and it is D7's one-way door.** So the pre-create is not
merely the cheaper path, as the specs assumed — it is the *only* workable one
short of degrading the shared server. Anyone implementing per-signal retention
must pre-create `samples_v3` with `type` in the partition key, honouring the
column-order contract in `08-schema-changes.md` (`type` last, or `ctrl.Init`
panics).

**RESOLVED — both halves tested against a live gigapipe.**

1. gigapipe boots cleanly against a `samples_v3` pre-created with `type` in the
   partition key. No `ctrl.Init` panic, exit 0, and it **preserves** the
   partition key while applying its own TTL on top. The one-way door is safe to
   walk through.
2. ClickHouse accepts the two-clause conditional TTL alongside
   `ttl_only_drop_parts = 1`, because each signal now lives in its own parts:

```
TTL toDateTime(timestamp_ns/1e9) + toIntervalDay(14)  WHERE type = 1,
    toDateTime(timestamp_ns/1e9) + toIntervalDay(395) WHERE type != 1
SETTINGS ttl_only_drop_parts = 1
```

Implemented in `packages/db/code-migrations/23-telemetry-retention.ts`. The
predicate is `type != 1`, not `type = 2`: the column is three-valued, and a row
matched by no clause is kept **forever**, so the metrics clause has to catch the
both-valued 0 as well.

The migration is idempotent and **degrades safely**: on a deployment where
gigapipe already created the table, `CREATE TABLE IF NOT EXISTS` is a no-op, the
partition key is checked, and retention stays a single window with an explicit
warning rather than a TTL that would quietly turn `ttl_only_drop_parts` into a
lie. Both paths were exercised.

Related and unchanged: gigapipe re-asserts this TTL on every boot, so a manual
`MODIFY TTL` is clobbered on restart. A reconciler is required whichever option
is chosen.

---

## D16 — Correlation attributes are `openpanel.*`, never `op_*` · SETTLED

The obvious name for the session-correlation span attribute is
`op_session_id`. It would have been **silently deleted at ingest**.

OpenPanel reserves the entire `op_` prefix and strips anything matching it from
every client-controlled attribute bag — that is what stops a forged tenancy
label (D2, D12, D14). Our own correlation attribute would have been caught by
our own filter, and the session-to-trace join would simply never have worked,
with no error at any layer.

Checked rather than assumed:

```
isReservedAttributeKey('op_session_id')        -> true    <- stripped
isReservedAttributeKey('op.session.id')        -> true    <- stripped
isReservedAttributeKey('openpanel.session.id') -> false   <- survives
```

**Decision: `openpanel.session.id` and `openpanel.profile.id`.** The names are
declared once in `packages/sdks/sdk` (`OpenPanel.SESSION_ATTRIBUTE`) and once in
`telemetry-traces.service.ts` (`SESSION_SPAN_ATTRIBUTE`), each pointing at the
other, because a silent divergence between them has exactly the same symptom as
the bug above: nothing works and nothing complains.

This is a good argument for the prefix reservation being a *prefix* rather than
an exact match — it caught its own author.

---

## What P0 now contains

Because D7 is deferred, **P0 has no irreversible decisions left.**

| Item | Where |
|---|---|
| Telemetry database creation + cluster-ambiguity guard | `packages/db/code-migrations/22-telemetry-database.ts` |
| Second ClickHouse client, scoped | `packages/db/src/clickhouse/telemetry-client.ts` |
| gigapipe service, both stacks | `docker-compose.yml`, `self-hosting/docker-compose.template.yml` |
| Settings profile + quota | `*/clickhouse/clickhouse-telemetry-profile.xml` |
| Constrained user + grants | `*/clickhouse/init-db.sh` |
| Secret generation | `self-hosting/quiz.ts`, `self-hosting/.env.template` |

**Not yet done in P0:** the `401` smoke assertion from D3 as an automated gate, and the
telemetry reachability probe wired into the API healthcheck
(`pingTelemetryClickhouse()` exists and is unused).

## What P1 contains so far

| Item | Where | State |
|---|---|---|
| `ClientType.telemetry` + migration | `schema.prisma`, `20260830120000_add_telemetry_client_type` | done |
| Privilege-escalation fix (allow-lists) | `apps/api/src/utils/auth.ts` | done |
| gigapipe's key sanitizers, transcribed | `packages/gigapipe/src/tenancy/sanitize.ts` | done |
| Project label, reserved-prefix predicate | `.../tenancy/project-label.ts` | done |
| Wire-level protobuf editor | `.../otlp/wire.ts` | done |
| OTLP resource stamping (logs/traces shape) | `.../otlp/stamp.ts` | done |
| OTLP metrics data-point stamping | `.../otlp/stamp-metrics.ts` | done |
| gigapipe HTTP client, route allow-list | `.../src/client.ts` | done |
| Telemetry auth (Bearer, allow-list) | `apps/api/src/utils/telemetry-auth.ts` | done |
| `POST /telemetry/v1/metrics` | `apps/api/src/{routes,controllers}/telemetry.*` | done |
| Per-project ingest metering | `telemetry.controller.ts` | done (Redis only; no rollup job yet) |
| 49 tenancy/stamping tests | `packages/gigapipe` | passing |

**Admission controls (done):** a per-process circuit breaker in front of
gigapipe (so a degraded backend cannot occupy event-loop slots in the process
that also serves `/track`), and a per-project series-cardinality budget backed
by a Redis HyperLogLog. The budget rejects with `429` and names sample offenders
rather than silently dropping the offending label — silent mutation changes the
meaning of a customer's metric invisibly. It fails **open** on a Redis outage,
deliberately the opposite of the tenancy checks: the budget guards slow growth
over days, so a minutes-long outage cannot meaningfully damage anything, whereas
rejecting all telemetry certainly damages the customer.

**Prometheus remote-write (done).** `POST /telemetry/api/v1/write` accepts
snappy-compressed remote-write 1.0, decompresses, stamps, re-compresses and
forwards. `snappy@7.4.2` is a napi-rs module with prebuilt binaries and no
install scripts, so it added no build step — as the dependency verification
predicted.

The labels are **rebuilt in sorted order**, not appended to. The remote-write
spec requires a TimeSeries' labels to be sorted by name, and receivers rely on
it — several compute the series fingerprint by hashing labels in order, so an
out-of-order set silently produces a *different series* rather than an error.
Appending `op_project_id` at the end would have been wrong for every label set
whose names sort after it.

Verified live: forged label stripped, stored as
`{"__name__":"rw_demo_total","op_project_id":"rw-demo","zone":"eu"}`, queryable
by the owning project and empty for any other.

**P1 is complete.**

---

## What P2 contains so far

| Item | Where | State |
|---|---|---|
| PromQL compiler (read-side tenancy boundary) | `packages/gigapipe/src/promql/compile.ts` | done |
| Range-query client | `packages/gigapipe/src/client.ts` | done |
| Matrix → `ConcreteSeries` adapter | `packages/db/src/engine/metrics/adapter.ts` | done |
| Engine entry point → `FinalChart` | `packages/db/src/engine/metrics/index.ts` | done |
| `observability.*` tRPC router | `packages/trpc/src/routers/observability.ts` | done |
| Metric / label / service discovery | `packages/db/src/services/telemetry-metadata.service.ts` | done |
| `Report.dataSource` + `metricQuery` | `schema.prisma`, `20260830130000_report_data_source` | done |
| `ChartEngine.execute` dispatch | `packages/db/src/engine/index.ts` | done |

The compiler is the read half of the boundary and the only function permitted to
emit a `{`. Every selector carries `op_project_id` as a mandatory `=` matcher;
identifiers are validated (PromQL has no escape syntax for one, so anything
outside the shape is refused) while matcher *values* are escaped, backslash
before quote. A caller matcher on the tenancy label is refused outright rather
than ignored. `by (...)` always includes the project label so the response-side
ownership check is not vacuous.

The adapter produces `ConcreteSeries[]`, which the existing `format()` turns into
`FinalChart` — so a metric report is an ordinary report to every renderer,
dashboard, share link and MCP tool downstream.

**Verified against a live stack, not asserted:**

```
sum by (op_project_id, route) (dp_requests_total{op_project_id="e2e-datapoints"})
  -> [{"metric":{"op_project_id":"e2e-datapoints","route":"/checkout"},"value":[...,"42"]}]

sum by (op_project_id, route) (dp_requests_total{op_project_id="someone-else"})
  -> []          <- same series, different project, nothing returned
```

The engine derives the Prometheus step from the report interval and **coarsens
rather than fails** when a range would exceed the point ceiling — a user asking
for 90 days at minute resolution wants the 90-day chart, not an error — and says
so in a notice, so the axis never silently disagrees with the control that
produced it. The rate window is floored at four steps: a `rate()` over a window
narrower than the step samples the gaps between buckets and draws a sawtooth
that reads as real instability in the service.

The router is `protectedProcedure` plus an explicit project-access check, with
**no `shareId` path**. The chart router accepts one so public dashboards render;
extending that to telemetry would let an anonymous link execute PromQL. Public
sharing of metric reports is a separate decision with its own cost controls.

`ChartEngine.execute` now dispatches on `Report.dataSource`, so a saved metric
report flows through the same call path as an event report and lands in the same
dashboards, layouts and widgets. `dataSource` defaults to `events` in the
database, so every existing row is correct without a backfill.

Metric, label, service discovery reads ClickHouse's `time_series_gin` directly —
the one place the plan carves out for direct SQL, because that index's primary
key starts with `key`, making "which fingerprints carry op_project_id=X, and what
else do they carry" a fast lookup that is scoped by construction. Verified live:
a second project sees zero metrics, zero labels, zero services.

Series capping keeps the largest N series by **peak** value, ranked once over
the whole window. Deliberately not PromQL's `topk`: that is evaluated
independently at every step, so a series in the top N at one timestamp and not
the next produces a line that appears and disappears — which reads as missing
data rather than as ranking. Peak rather than mean because a spike is usually
why someone opened the chart. The comparison period is capped to the *same*
series as the current one, not its own top N, or a line would be compared
against a different service's history.

**The explorer UI needs no chart component of its own.** A metric report is an
ordinary `IReportInput` with `dataSource: 'metrics'`, so it renders through the
same `<ReportChart>` every event report uses and the engine dispatch happens
server-side. That is the FinalChart bet paying off in full: zero renderer
changes, and "save to a dashboard" works without any dashboard code knowing
metrics exist.

`dataSource` is `.optional()` rather than `.default('events')` on the report
input. A zod default makes the *output* type required, which would have forced
every one of the dozens of existing callers that build a report object to spell
out a field only metric reports care about.

**P2 is complete.**

---

## What P3 (logs) contains so far

| Item | Where | State |
|---|---|---|
| LogQL compiler (read-side boundary) | `packages/gigapipe/src/logql/compile.ts` | done |
| Closed label allowlist + envelope | `packages/gigapipe/src/logs/envelope.ts` | done |
| OTLP logs decoder | `packages/gigapipe/src/logs/otlp-decode.ts` | done |
| `POST /telemetry/v1/logs` | `apps/api` telemetry router/controller | done |
| `observability.logs` search | `packages/trpc/src/routers/observability.ts` | done |
| Log explorer UI | `apps/start/src/routes/…$projectId.logs.tsx` | done |

D5 in practice: OpenPanel decodes OTLP itself and builds a **five-label** stream
set (`service`, `env`, `level`, `scope`, `source`), each bounded by something
operational rather than by traffic. Correlation ids — `trace_id`, `span_id`,
`session_id`, `profile_id` — are on a deny list and travel inside a versioned
JSON envelope as the log line, where a line filter still finds them but they
cost nothing in cardinality.

The LogQL compiler carries a hazard the PromQL one does not: with
`ADVANCED_OMIT_EMPTY_VALUES=false`, gigapipe's planner **silently removes** any
matcher with an empty value (`planner_stream_select.go:31-46`), and the project
matcher is the only thing separating tenants on that path. Two defences: the
flag is set (D8), *and* the compiler refuses to emit an empty matcher value at
all, so a config regression cannot widen a query.

**Verified live, end to end:**

```
buildLokiPush -> POST /loki/api/v1/push            -> 204
{op_project_id="log-demo",service="checkout-api"}  -> 2 lines, envelopes intact
{op_project_id="someone-else"}                     -> []
```

Decoded from a real OTLP payload produced by the official serializer:
`session.id` and `order_id` stayed **out** of the stream labels and inside the
envelope, exactly as the cardinality argument requires.

Note: gigapipe adds a `service_name` label of its own on the Loki path. Bounded,
same value as `service`, harmless — but the allowlist is not the only source of
labels, and anything reading them should not assume it is.

The explorer virtualises with `rc-virtual-list` (already a dependency, used by
the combobox) rather than adding one. Timestamps are divided as `BigInt` before
becoming a `Date`: a nanosecond timestamp exceeds `Number.MAX_SAFE_INTEGER`, and
`parseInt` would drop the low digits silently. A line filter is only sent at two
characters or more — the compiler rejects an empty one, and a single character
matches so much it is slower than no filter.

Correlation ids show in the row because they live in the envelope, which is
precisely what the closed label set buys: visible and searchable without ever
having cost a stream.

**Follow (live tail)** is a 5-second poll, not a WebSocket. gigapipe does expose
`/loki/api/v1/tail`, but a socket needs its own auth, backpressure and reconnect
handling on a path that is already rate-limited and cached, and doc 05's own MVP
specified a `refetchInterval` Follow toggle. The query window **advances** with
the poll — memoising it on the range alone would re-query a fixed window forever
and no new line could ever appear, which is a Follow button that silently does
nothing.

**Saved searches** store the STRUCTURED query, never a raw LogQL string. A saved
raw query would be a stored string that later gets compiled, which is exactly
the shape the tenancy design exists to avoid. Update and delete are scoped by
`projectId` as well as id — an id alone would let a member of one project modify
another's saved search by guessing a uuid.

**Pattern grouping (done).** D9 resolves cleanly once you read the handlers
rather than the flag: `/loki/api/v1/patterns` takes a `query` parameter
(`reader/controller/volume.go:137`), so it is scoped by the same compiled LogQL
as any other read. The injectable route is a **different** endpoint —
`/loki/api/v1/index/volume`, whose `targetLabels` is string-interpolated into a
LogQL expression and re-parsed.

So `LOG_DRILLDOWN=true` is enabled and only `patterns` is added to the route
allowlist. `index/volume`, `detected_labels` and `detected_fields` are excluded,
with a test in `client.test.ts` asserting they never appear there.

Verified live: patterns returns 200 scoped by project, and `index/volume` also
returns 200 **when called directly on gigapipe** — which proves drilldown is
genuinely on and that the protection is the allowlist, not the flag. gigapipe
publishes no ports, so nothing but `apps/api` can reach it.

**P3 is complete.**

**Next:** P3's explorer UI, then P4 (traces), P5 (alerts), P6 (polish).

## What P5 (alerting) contains so far

| Item | Where | State |
|---|---|---|
| Alert state machine (pure) | `packages/gigapipe/src/alerts/state-machine.ts` | done |
| `zNotificationRuleMetricConfig` | `packages/validation` | done |
| `MetricAlertState` table + migration | `schema.prisma`, `20260830140000_metric_alert_state` | done |
| Evaluation cron (60s) | `apps/worker/src/jobs/cron.metric-alerts.ts` | done |

The state machine is a **pure function** so the rule editor's preview and the
evaluator can call the same code — a preview that disagrees with production is
worse than none, because it is trusted.

Four behaviours it gets right that are easy to get wrong:

- **Missing data does not resolve an alert.** A series that vanishes because the
  service died would otherwise silence itself at the moment it matters most.
- **A long evaluation gap invalidates the pending timer.** A worker down for an
  hour would otherwise return, compute `now - pendingSince > for`, and fire —
  claiming the condition held across an hour nobody observed.
- **A pending alert that never fired sends no resolve.** Nobody was told it was
  pending, so nobody needs telling it stopped.
- **Duplicate delivery does not double-notify.** BullMQ is at-least-once; the
  cooldown absorbs a repeated evaluation.

State is per `(rule, series)`, because one rule's query legitimately returns many
series and each must alert and resolve independently — collapsing them would let
one noisy route suppress every other route's alert. Notifications are capped per
evaluation with a rollup message, so a deploy that breaks every route does not
send hundreds of emails for one incident.

Delivery is unchanged: a transition writes a `Notification` row and the existing
integrations, email and in-app paths take it from there.

> Adding a third variant to `zNotificationRuleConfig` surfaced a latent bug:
> `isFunnelRule` returned `boolean` rather than a type predicate, so `.filter()`
> never narrowed and `rule.config.events` was unchecked — it compiled only while
> every variant happened to have that field. Fixed in the service and in two
> frontend components.

| Metric alert rule editor | `apps/start/src/modals/add-metric-alert-rule.tsx` | done |

The editor is separate from the event/funnel rule modal rather than a fourth
branch inside it: the two share only a name and the delivery settings, and the
event modal's entire body is an event picker with filters that has no meaning
for a metric threshold.

The "alert separately per" control is the group-by, and it says what it does —
each group alerts and resolves on its own, so one noisy route cannot hide the
others. The duration control explains itself too ("a duration stops a single
spike from paging anyone"), because a `for` window is the single setting most
likely to be left at zero by someone who has not been paged at 3am yet.

**P5 is complete.**

---

## What P6 (polish) contains so far

| Item | Where | State |
|---|---|---|
| MCP telemetry tools | `packages/mcp/src/tools/observability/telemetry.ts` | done |

Six tools — `list_metrics`, `list_metric_labels`, `query_metric`,
`list_services`, `search_traces`, `get_trace` — so "why did checkout get slow
last Tuesday?" can be answered against product **and** infrastructure data in one
conversation. `query_metric` returns the generated PromQL alongside the series,
so the model can explain what it actually measured and a human can check it.

Each tool reports clearly when telemetry is unconfigured rather than being
silently absent, so the model can say why it cannot answer instead of guessing.

| Quota enforcement | `apps/api/src/utils/telemetry-quota.ts` | done |
| Raw PromQL rewriter | `packages/gigapipe/src/promql/rewrite.ts` | done |

**Quota** is checked in a `preHandler` shared by every ingest route, after auth
(it needs the project) and before the body is parsed, so an over-quota project
costs a header read rather than a protobuf decode. It returns `429` with
`Retry-After`, which OTLP and remote-write clients back off on — silently
dropping the data would be worse than refusing it. Usage is incremented
**before** the decision, deliberately: the request that tips a project over is
accepted and the next is refused, rather than charging a rejection for bytes we
never stored. Fails open, like the cardinality budget and unlike the tenancy
checks.

**Raw PromQL** goes through `@prometheus-io/lezer-promql` — the grammar
Prometheus itself ships — and injects the tenancy matcher into every
`VectorSelector` node. Every string-level approach fails on a query a user can
easily write, and the tests cover each:

```
up                                    no braces at all to match on
up # {op_project_id="other"}          a comment that looks like a selector
up{job="a"} or up{job="b"}            several selectors, one expression
sum(rate(x[5m] offset 1h))            selectors nested in functions
max_over_time(rate(x[5m])[30m:1m])    a subquery
```

The first line alone defeats "find the `{`". `label_replace` and `label_join`
are **rejected outright**: they cannot read another project's data (the
selection already happened) but they can make a response carry a label claiming
otherwise, and allowing them would mean proving no argument combination
misleads — harder than living without two functions. A query the grammar cannot
parse is refused rather than forwarded, because gigapipe's parser is not this
one and that gap is how a rewriter gets bypassed.

Verified live: `rewrite_probe_total` → `rewrite_probe_total{op_project_id="rewriter-test"}`
returns the series; the same raw query under another project returns `[]`.

| Per-signal retention | `packages/db/code-migrations/23-telemetry-retention.ts` | done |

**P6 is complete.**

---

## Test coverage so far

| Suite | Tests |
|---|---|
| `packages/gigapipe` — tenancy, OTLP stamping (metrics/logs/traces), remote-write, admission, PromQL + LogQL compilers, PromQL rewriter, route allowlist, log envelope, alert state machine | 170 |
| `apps/api` — `/telemetry/v1/metrics` route integration | 12 |
| `packages/db` — adapter, engine, and existing suites still green | 41 |
| **Total** | **223** |
