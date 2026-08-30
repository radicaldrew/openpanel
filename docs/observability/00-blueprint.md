# Observability in OpenPanel — engineering blueprint

Add metrics, logs and traces to OpenPanel by running **gigapipe** as an internal service
against a second database on the ClickHouse instance OpenPanel already operates, with
`apps/api` in front of it on both the write and the read path. No Grafana, no Prometheus,
no Loki, no Tempo, no new datastore.

This is the master document. Eleven work-stream specifications sit beside it; each was
researched against source, attacked by three adversarial reviewers, and revised. A
verification log records what was checked before any of it was written, and a findings
document records what five cross-cutting critics found when they read all eleven
together.

> **Read this first, then §12 (Status), then the work-stream doc you need.**
> Status matters: the cross-cutting findings in `13-cross-cutting-findings.md` are
> **not yet applied to the specs**. Several are conflicts *between* specs.

---

## 1. What is being built

OpenPanel owns the browser side of a product today — pageviews, sessions, conversions,
profiles, cohorts, funnels, retention. It does not see the server. The goal is one
product where a signup-conversion chart and an API p99 chart sit on the same dashboard,
share the same time axis, and can be broken down by the same user cohort.

Three signals, in dependency order:

| Signal | Ingested as | Stored in | Read via |
|---|---|---|---|
| Metrics | OTLP/HTTP protobuf, Prometheus remote-write 1.0 | `samples_v3`, `time_series`, `metrics_15s` | gigapipe PromQL `query_range` |
| Logs | OTLP/HTTP protobuf, Loki JSON | `samples_v3` (shared with metrics, `type` column) | gigapipe LogQL |
| Traces | OTLP/HTTP protobuf | `tempo_traces`, `tempo_traces_attrs_gin` | **direct ClickHouse SQL** — not gigapipe |

That last row is the plan's largest correction and is explained in §3.

---

## 2. Architecture

```
INGEST                          │ single-tenant beyond this line
                                │
 your services      ┌───────────────────────┐    ┌──────────────────┐
 OTel Collector ───▶│ /telemetry gateway    │───▶│ gigapipe writer  │──┐
 Prom agent         │ apps/api              │    │ OTLP · Loki push │  │
                    │ token → project       │    └──────────────────┘  │
                    │ stamp op_project_id   │                          │
                    │ strip reserved keys   │                          ▼
                    │ meter · admit · break │              ┌────────────────────────┐
                    └───────────────────────┘              │ ClickHouse             │
                                │                          │  openpanel   (events)  │
QUERY                           │                          │  gigapipe    (signals) │
                    ┌───────────────────────┐              └────────────────────────┘
 OpenPanel UI ─────▶│ obs.* tRPC router     │                    ▲          ▲
 dashboards         │ @openpanel/gigapipe   │                    │          │
 explorers          │ compile + force       │    ┌──────────────────┐       │
                    │ op_project_id matcher │───▶│ gigapipe reader  │───────┘
                    │ lease · killswitch    │    │ PromQL · LogQL   │       │
                    └───────────┬───────────┘    └──────────────────┘       │
                                └──── traces: direct SQL ────────────────────┘
```

Both directions cross OpenPanel before reaching storage. That is what makes a
single-tenant engine safe under a multi-project product.

---

## 3. The load-bearing decisions

Each was tested against source. Where verification changed the decision, that is stated.

### D1 — gigapipe is the engine; OpenPanel is the product

It supplies PromQL, LogQL and TraceQL over ClickHouse plus OTLP, remote-write, Loki,
Datadog, Influx and Elastic ingest, in a language we don't maintain. Rejected: writing a
metrics store. Reimplementing `rate`, `increase`, `histogram_quantile` and staleness in
SQL is a multi-quarter project with no product value.

**Operational delta: one image, two compose services** (`op-gigapipe` and a one-shot
`op-gigapipe-init`), no exposed ports. See `10-ops-retention-billing.md`.

### D2 — Isolation by label enforcement, owned by OpenPanel

`op_project_id`, validated `^[a-zA-Z0-9_-]{1,100}$`, stamped per-signal on ingest and
injected as a mandatory `=` matcher on read by three server-side compilers that are the
only functions in the codebase permitted to emit a `{`.

*Verification changed the argument for this decision.* The plan originally said "only the
writer accepts a per-request DSN." That is wrong. gigapipe's `X-CH-DSN` header is not a
DSN and nothing is dialed from it — it is an opaque id compared against a node name fixed
at boot (`writer/service/registry/static.go:55-69`). An unmatched or empty value does not
error; it returns `svcs[rand.Intn(len(svcs))]`. It is **fail-open**, and re-randomized per
getter call, so within one request the `samples` row and the `time_series` row can land on
different nodes — gigapipe's own test comment says this can silently lose `time_series`
rows. It was never usable as an isolation boundary. The reader, separately, ignores its
context entirely (`reader/registry/static.go:33-38`).

Two controls exist that the original plan did not have, both from review:

- **`ProjectIdTombstone`** — `getId` collides only against live rows, so a hard-deleted
  project's slug is reissued to a stranger who would inherit its telemetry.
- **`compileGroupBy` emits `by (op_project_id, …)`** — otherwise the response-side
  ownership check passes vacuously for aggregating queries.

### D3 — Structured query spec, compiled server-side

`zMetricQuery` / `zLogQuery` compile to PromQL / LogQL in `apps/api`. Raw PromQL is a
later phase behind `@prometheus-io/lezer-promql` (**verified to exist**, v0.314.0, zero
runtime deps) rewriting every `VectorSelector` — never string concatenation.

This keeps phase-1 enforcement trivially safe: there is no user string to sanitise,
because the server constructed the selector.

### D4 — The metrics engine feeds the existing chart pipeline

`executeMetricChart(spec, deps)` in `packages/db/src/engine/metrics/` compiles to
PromQL, queries gigapipe, folds the matrix into project-local calendar buckets, and emits
`ConcreteSeries[]` so the **existing `format()` produces the existing `FinalChart`**.

*This bet mostly held, with one honest cost.* Metric reports are ordinary `Report` rows
and land in existing dashboards, layouts, shares and widgets. But it is not free:
`ReportChartProps` must gain `data` / `isLoading` / `error` — a three-line diff in each of
**seven** renderer `index.tsx` files — so the caller can own the query. That single change
also dissolves the first-paint query, the missing home for `compiled` and `notices`, the
duplicate query, and 30 chart round-trips on `/services`. See `09-ui-surfaces.md` D2.

### D5 — Traces bypass gigapipe's reader entirely

**This is a correction, not a refinement.** gigapipe's Tempo reader applies *no tenant
predicate anywhere*, and `X-Scope-OrgID` is read nowhere in its tree. Routing trace reads
through it would defeat D2.

Traces are therefore ingested through the OpenPanel gateway into gigapipe's
`tempo_traces` tables and read back with **direct ClickHouse SQL from `apps/api`**, with a
mandatory `key='op_project_id' AND val=<projectId>` gin predicate — which is the table's
PK prefix, so it is fast — span-scoped in every aggregate, so `rootServiceName`,
`spanCount` and `serviceCount` cannot be computed from a co-tenant's spans in a shared
trace. See `06-traces-and-correlation.md`.

---

## 4. What verification changed

Eighteen claims, each investigated twice by independent routes. **One confirmed, seventeen
partially confirmed, none refuted.** No claim was outright wrong; nearly all were
imprecise in ways that change implementation, and several in ways that change design.
Full record in `12-verification-log.md`. The consequential ones:

| Finding | Consequence |
|---|---|
| `X-CH-DSN` is a fail-open node-name selector, not a DSN | D2's argument rewritten; header is unusable as a boundary |
| gigapipe's Tempo reader applies no tenant predicate | D5 — traces read by direct SQL |
| `SAMPLES_DAYS` re-ALTERs **eight tables across three signals** on every boot (`rotate.go:155-210`), not just `samples_v3` | A hand-set conditional TTL is clobbered on every gigapipe restart → a reconciler must re-assert it |
| `type` has **three** values (0=both, 1=log, 2=metric) and readers match `type IN (n,0)` | Any `type` predicate must include 0 |
| `type` is in neither the sort key nor the partition key of `samples_v3` | Conditional TTL would be a merge-time full scan → `08` pre-creates the table with `type` in `PARTITION BY` |
| `metrics_15s` rolls up **log** rows too | It is shared infrastructure, not a metrics rollup |
| OTLP exemplar trace ids are written into `samples_v3.string` | The "value = metrics, string = logs" split does not hold |
| `@opentelemetry/otlp-transformer` **cannot decode OTLP requests** — it only serializes from SDK objects and deserializes responses | protobufjs against vendored `.proto` is the only route |
| gigapipe accepts OTLP **JSON** on `/v1/metrics` but **not** `/v1/logs` | OTLP JSON support cut entirely (`02` D12); protobuf only |
| `@prometheus-io/lezer-promql` exists and is current; `snappy@7.4.2` is napi-rs with prebuilt binaries and no postinstall | Both safe dependencies |
| ClickHouse `MODIFY ORDER BY` only accepts columns added by an `ADD COLUMN` in the same `ALTER` | Pre-created tables must reproduce gigapipe's column order (`type` **last**) or `ctrl.Init` panics and crash-loops the init container |

---

## 5. Work-streams

| Doc | Owns | Depends on |
|---|---|---|
| `01-tenancy-and-security.md` | the isolation invariant, stamping, matcher injection, the raw-query rewriter | — |
| `02-ingest-gateway.md` | `/telemetry` Fastify plugin, auth, decode/strip/stamp/re-encode, admission, breaker | 01, 08 |
| `03-metrics-engine.md` | `zMetricQuery`, PromQL compilation, matrix → `ConcreteSeries` | 01, 04 |
| `04-read-path.md` | `@openpanel/gigapipe` package, route table, transport, `obs.*` router, leases | 01 |
| `05-logs.md` | log ingest topology, `zLogQuery` → LogQL, explorer | 01, 02, 04 |
| `06-traces-and-correlation.md` | trace SQL, waterfall, session↔trace join, SDK propagation | 01, 02, 08 |
| `07-alerting.md` | rule schema, evaluation cron, state machine, outbox delivery | 03, 04, 08 |
| `08-schema-changes.md` | Prisma migrations, CH migration, the gigapipe compatibility contract | — |
| `09-ui-surfaces.md` | shell, routes, capability gating, metrics explorer, report seams | 03, 05, 06 |
| `10-ops-retention-billing.md` | compose, retention, metering, quota, load | 08 |
| `11-testing-strategy.md` | the adversarial tenancy matrix, tiers, gates per phase | all |

Dependency shape: **01 and 08 block everything.** 04 blocks 03/05/06. 09 and 07 are last.

---

## 6. Phases

Ordered so hard-to-reverse work happens early while it is cheap to change.

| Phase | Ships | Exit criteria |
|---|---|---|
| **P0** Stack | gigapipe running, empty, healthy | `22-telemetry-database.ts` applied; `op-gigapipe-init` exits 0 without `ctrl.Init` panicking; second CH client connects |
| **P1a** Tenancy boundary | data arrives, correctly scoped | the full adversarial strip matrix in `11` passes, including the Unicode-collapse cases |
| **P1b** Admission | gateway survives abuse | breaker, lockout, clamps, metering under load test |
| **P2** Metrics | metric charts on dashboards — *the milestone that makes it a product* | a metric report renders in an existing dashboard, share link and widget |
| **P3** Logs | log explorer | Loki JSON + OTLP push, compiler, histogram, list, detail, URL state |
| **P4** Traces | trace search, waterfall, session join | span-scoped aggregates verified against a shared-trace fixture |
| **P5** Alerts | threshold alerts through existing integrations | firing *and* resolved, surviving worker restart and duplicate delivery |
| **P6** Polish | tail, patterns, saved queries, MCP tools, quotas, raw PromQL | the lezer rewriter's evasion suite passes |

**Smallest useful cut: P0 + P1 + P2.** Server metrics on the same dashboards as product
analytics, with OpenPanel monitoring itself.

> **Effort:** the specs carry per-item estimates and they are larger than the original
> plan's. `02` alone splits P1 into P1a (~3.5–5.5 w) and P1b (~1.5–2 w). Treat the
> original six-week figure for P0–P2 as optimistic; re-derive the number from the specs
> before committing to a date. Three different phase-numbering schemes are in use across
> the eleven docs — see finding set in `13`.

---

## 7. Deliberately deferred

Live tail, log pattern grouping and saved queries (→ P6). Per-plan retention tiering —
fully specified, deferred behind a named trigger, taking 1.5 weeks and a permanent
mutation load off the critical path. Continuous profiling. Synthetic checks and uptime.
Host/infra agents.

---

## 8. Risk register

| Risk | Severity | Mitigation | Owner |
|---|---|---|---|
| Label enforcement bypassed → cross-project telemetry read | critical | structured queries only until P6; computed `isReservedKey` strip (not a table); adversarial matrix gates every phase | `01`, `11` |
| Cardinality explosion from one bad label | high | per-project budget rejected at the gateway, offender surfaced | `02`, `10` |
| gigapipe upgrade breaks the compatibility contract | high | `TelemetrySchemaState` + contract tests; pinned image | `08`, `11` |
| Telemetry ingest starves `/track` | high | plugin-local verify cache, semaphore, breaker; gateway extractable (no tRPC imports) | `02` |
| Log volume degrades the analytics workload on shared ClickHouse | high | separate database from day one; storage policy or separate instance is then config | `10` |
| Retention TTL clobbered by gigapipe boot | medium | reconciler re-asserts unconditionally at `materialize_ttl_after_modify = 0` | `08`, `10` |
| AGPL-3.0 | medium | separate network service is the safe posture; revisit before linking or redistribution. *Not legal advice.* | `10` |

---

## 9. Open questions before P0

- [ ] Reconcile the three phase-numbering schemes across the eleven docs.
- [ ] Settle the remaining `zMetricQuery` divergence (see `13`, critical set).
- [ ] Confirm the pinned gigapipe image tag and re-run the `08` compatibility contract against it.
- [ ] Decide the billing unit is emitted `samples_v3` rows (as `10` proposes) and price it.
- [ ] Confirm `telemetryEnabled` capability gating covers self-hosted defaults.

---

## 10. Reading guide

Start here → `12-verification-log.md` (what is actually true) → `01` (the invariant) →
`08` (what it costs the database) → the stream you are building. `13` is the open-defect
list; read it before trusting any cross-document interface.

---

## 11. Provenance

Produced by a 110-agent workflow: 18 claims × 2 independent verifications; 11 work-streams
each drafted, reviewed through three adversarial lenses, and revised; 5 cross-cutting
critics; then synthesis. 96 agents completed. Every agent was constrained to read-only
investigation and to writing only under `docs/observability/`; `git status` confirms
nothing outside it was touched.

## 12. Status — what is and is not finished

**Finished.** The eleven work-stream specifications, the verification log, and the
cross-cutting findings list.

**Not finished.** The workflow's patch stage — which would have absorbed the cross-cutting
findings into each specification — died on a session limit, twice. Consequently:

- The findings in `13-cross-cutting-findings.md` are **open**. 75 are marked critical.
- Several are **conflicts between specs**, not defects within one. Where two documents
  disagree, `13` names both sides and usually says which is right. Until those are
  applied, no cross-document interface should be treated as settled.
- Every critic independently reported the same headline: *"eleven excellent specs and one
  absent plan."* This document is that missing plan, written by hand afterwards from the
  specs' own summaries, the verification record and the critics' verdicts — **not** by the
  synthesis agent that was supposed to write it, and therefore without that agent's
  full read of all eleven documents end to end.

Applying `13` to the specs is the next unit of work.
