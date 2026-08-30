# Alerting

OpenPanel evaluates metric alert rules in its own worker, because gigapipe's ruler is
recording-only by construction (`ruler/manager.go:212-216` — `m.evaluator.Evaluate` has
exactly one non-test call site, behind an `if rule.IsRecording()` gate) and cannot be
finished by configuration. A 60 s cron enqueues one dispatch job; the dispatcher selects
rules whose stored `nextEvaluationAt` has passed, skips organizations blocked by the
wind-down lifecycle, and fans out one evaluation job per rule onto a dedicated `alerts`
queue. Each evaluation takes an atomic Postgres claim, issues **one instant PromQL query
at wall-clock now** through the P2 metrics compiler (which injects the mandatory
`op_project_id` matcher and carries it through every aggregation's `by (…)`, so the label
survives into the result vector and is re-verified), runs a pure, level-triggered state
machine over the union of returned series and stored series, and writes every transition
into an append-only log that doubles as a delivery outbox. Delivery reuses
`createNotification` → `notificationQueue` → in-app/email/webhook/Discord/Slack; that path
is unchanged, but it is **not observable end-to-end** — `postWebhook` swallows every
transport error and `notificationJob` never inspects the result — so this spec defines
"delivered" as "enqueued", says so in the guarantees, and files the fix as a cross-stream
ask. This document supersedes `_drafts/alerts.md`.

Read at OpenPanel `247744a8` and gigapipe `d4b91b1`. Every line number below was opened at
those commits. Scope is **metric** alerting only; log- and trace-based alerting are out of
scope and revisited under *Open questions*.

---

## Revision R1 — what this pass changed, and who has to follow

This revision absorbs a cross-document review of all eleven specifications. Nothing about the
evaluator, the state machine, the outbox or the delivery path changed. What changed is the
set of *external* facts this document asserted, several of which were stale or wrong, plus one
open question that is now a decision. **Six items below are changes another document must
reflect**; they are repeated in *Interfaces* with the exact edit.

| # | Was | Is now | Who else must change |
|---|---|---|---|
| R1.1 | **Q1 open**: "two incompatible `zMetricQuery` definitions, the tenancy and metrics owners must reconcile" | **Decided: `03-metrics-engine.md` §2 (≈`:457-637`) is canonical**, in `packages/validation/src/telemetry.validation.ts`. Q1 is closed | `01-tenancy-and-security.md` §7.2 replaces its schema block with a pointer; `09-ui-surfaces.md` D3 was written against a *third* shape that exists nowhere and must be re-derived (its revision in flight, S-A, already agrees); `11-testing-strategy.md` §3.4 Q1 says `zMetricMatcher`, which does not exist — it is `zMetricLabelFilter` |
| R1.2 | D4 described the metrics engine's Phase A as a `topk(...)` instant query | Corrected: `03-metrics-engine.md` §8.1 (≈`:1096-1145`) issues the **identical expression minus `topk`** as a coarse `query_range` and ranks in **JS**. `topk` appears in no query the metrics engine emits. D4's conclusion is unchanged; its target was misdescribed | none — this document was the one that was wrong |
| R1.3 | D4 / Interfaces cited `04-read-path.md:1389` for the `topk` wrap | Stale citation. The sentence lives in `04-read-path.md` **§8.2 "Cardinality and query size"** and was **still there** when this revision was written. The `maxSeries`-exceeded `GigapipeUpstreamError` that `03-metrics-engine.md` amendment 5 also asks to delete is already gone: `maxSeries` now occurs in `04` only in that one §8.2 bullet | `04-read-path.md` §8.2 must delete the `topk` wrap (its in-flight revision already lists this as amendment 5, "Deleted"); `09-ui-surfaces.md` D4 justified its `limit` argument by that wrap and must be rewritten with it (its in-flight revision already has) |
| R1.4 | D15 / Q2: "`04-read-path.md:1447-1449` says one lease per evaluation *sweep*, which is unimplementable" | **Resolved in our favour and no longer a conflict.** `04-read-path.md` §8.4 (the `LEASE_TTL_SECONDS` doc comment) and its Interfaces row for `withProjectLease` now both read "one lease per rule evaluation, never one per batch". The only remaining ask is the optional `{ bucket, max }` argument | `04-read-path.md` records the bucket argument; nothing to retract |
| R1.5 | Interfaces cited `compileAggregation` and `verifyResponseLabels` as exposed by `01-tenancy-and-security.md` | **Neither symbol exists in `01`.** Its "Exposed by this work-stream" table lists `compileSelector(q, projectId)` and `compileGroupBy(q): string`, and `compileGroupBy`'s body (`01` §7.2) returns a bare `` `by (${[TELEMETRY_PROJECT_LABEL, ...q.groupBy].join(', ')})` `` **fragment**, not a function that wraps an expression. Three specs (`03` §4.1, `04` §4.4, this one) import a wrapper that has no owner, and this document additionally mis-quoted its body | `01-tenancy-and-security.md` must add `compileAggregation(q, inner): string` and `verifyResponseLabels(series, projectId): void` to its exposed table and delete `compileGroupBy`, or all three consumers rewrite against `compileGroupBy` |
| R1.6 | Tests A1–A44 costed here **and** `11-testing-strategy.md` §7.1 costed the same suites at 3.5 d | **This document owns its own unit suites.** `11` owns the harness, the workspace and CI wiring, the sanitizer goldens and the cross-stream matrices | `11-testing-strategy.md` strikes its §7.1 row (3.5 d) — which is in any case written against the superseded design (`incidentId`, `lastEvaluatedTick`, `cooldownSeconds`) |

**A note on citations into sibling specifications.** Every one of the eleven documents is
under revision at the same time as this one, so a line number inside another `docs/observability/*.md`
file is a moving target. Citations into **source code** and into **gigapipe** stay as
`path:line` and were opened at the commits named above. Citations into a **sibling
specification** are given as *section anchors first*, with a line range only as a reading aid,
marked "≈". If a range no longer matches, trust the section.

**Phase vocabulary.** This document now uses the master scheme and **only** the master scheme:
P0 stack, P1 ingest, P2 metrics, P3 logs, P4 traces, P5 alerts, P6 polish. Alerting is **P5**.
Sibling work-streams are referred to **by filename**, never by document number, because
`04-read-path.md` is document 04 but ships in phase P2, and the previous text's
"P4's transport" read as "the traces phase" to anyone scheduling the work. Where a phase
letter appears below it is a phase, not a document.

---

## Decisions

### D1. The evaluator lives in `apps/worker`, not in gigapipe's ruler

gigapipe cannot evaluate an alerting rule. That is a property of its source, not a flag:

| Fact | Evidence |
|---|---|
| The package doc says so | `ruler/ruler.go:1-6` — "single-tenant and recording-only: alerting rules are stored but never evaluated" |
| `IsRecording()` is `Record != ""` | `ruler/model.go:19-21` |
| Only recording rules are evaluated | `ruler/manager.go:212-216` |
| `m.evaluator.Evaluate` has exactly one non-test call site | `ruler/manager.go:226`, inside `evaluateRecordingRule`, reachable only through that gate |
| Alerting rules are invisible over the Prometheus API | `ruler/manager.go:268-271` skips every non-recording rule; `:291` drops the whole group if none survived |
| `Rule.For` is never read at evaluation | declared `ruler/model.go:12`; its only other use is the `"0s"`/`"0"` → `""` normalisation at `ruler/service.go:44-48` |
| There is no alerting API, notifier, or silence handling | `ruler/router/router.go:1-3`; repo-wide grep for `alertmanager\|/api/v1/alerts\|notifier\|silence` over `*.go` returns nothing |

**Rejected: patch gigapipe's ruler.** It forks an AGPL-3.0 dependency (§14 of
`10-ops-retention-billing.md`) to rebuild a delivery path OpenPanel already has and that is
entirely signal-agnostic.

**Rejected: proxy gigapipe's ruler CRUD.** `RulerService.SetRuleGroup`
(`ruler/service.go:43-60`) does **no** validation of `Alert`; `Controller.GetRuleGroup`
returns the stored YAML verbatim (`ruler/controller/controller.go:58-111`). A user — or
Grafana's Loki ruler UI — can POST an alerting rule, `GET` it back, see it listed, and
reasonably conclude it is armed. It will silently never fire. `QRYN_RULER_ENABLED` stays
unset in every compose surface (`10-ops-retention-billing.md:198-200`), and if ruler CRUD is
ever surfaced, OpenPanel must reject a non-empty `alert` at its own gateway.

**Do not probe an HTTP status to detect whether the ruler is on.** With a plain `go build`
an unregistered `/api/v1/rules` 404s before middleware; the published image is built with
`-tags view`, where a catch-all file server matches first and the request traverses
`BasicAuthMiddleware`, answering **401** (`10-ops-retention-billing.md:1698`). Ruler state
comes from OpenPanel's own config, never from a status code.

### D2. The comparison happens in TypeScript, not in the PromQL

The evaluator sends `sum by (service_name, op_project_id) (rate(…))` and compares each
returned sample against the threshold in JS. It does **not** send `… > 5`.

1. **A below-threshold series and a missing series must be distinguishable.** PromQL's `>`
   is a filter: a series under the threshold vanishes from the result vector. Filtering
   server-side would make "recovered" and "the exporter died" arrive as the same empty
   vector, and a rule could not choose different behaviour for the two. `missingSeries`
   exists precisely because we keep the distinction.
2. **The compiler stays the only thing that emits PromQL, and it emits a closed grammar.**
   The totality argument in `01-tenancy-and-security.md` §4.2 holds only while the grammar
   stays closed. A binary comparison node widens it for no gain.
3. **The UI needs the current value of a non-firing series.** "Armed, currently 2.1 against
   a threshold of 5" is the most useful thing the rule card can show, and it is free when
   the vector is unfiltered.

**Rejected: emit the comparator.** It buys a smaller response body, at the cost of (1).

### D3. Every series in a rule's result vector alerts independently

One rule whose query returns `{service_name="api"}` and `{service_name="worker"}` produces
two independent alert instances: two `for` timers, two lifecycles, two notifications.

- The two series are two different failures; they recover at different times. A rule-level
  "fire if any series breaches" would name an arbitrary series, then stay firing while the
  *offending* series rotates underneath it.
- `for` is per-series by construction. A rule-level timer over "at least one series is
  breaching" is satisfied by a series that breaches for 30 s, recovers, and is replaced by
  a different series that breaches for 30 s — no series was ever bad for a minute.
- Grafana, Prometheus and Datadog all do per-series. The notification body
  (`service_name=api`) is the first thing an on-call reader looks for.

The cost is a notification burst when many series fire at once. That is bounded two ways,
both specified: `maxSeries` fails the rule rather than truncating it (D9), and delivery per
evaluation is serialised and capped with a rollup message (D10).

### D4. Alert queries use neither ranked series selection nor `topk`

**Corrected in R1.2 — the previous text described a mechanism the metrics engine does not
have.** The metrics engine's chart path bounds cardinality in **two phases, neither of which
emits `topk`** (`03-metrics-engine.md` D8, ≈`:261-296`, and §8.1, ≈`:1096-1145`):

- **Phase A** issues the *identical compiled expression, minus nothing*, as a `query_range` at
  a coarse `rankStepSec` of at most `RANK_POINTS = 24` points, then **ranks the returned label
  sets in JavaScript** by the sum of absolute sample values, keeps the top `cfg.maxSeries`, and
  reports an **exact** `series_capped { seen, kept }`. It throws `GigapipeQueryTooLargeError`
  past `cfg.maxRankSeries` (1000).
- **Phase B** re-queries at the chart step **pinned** to exactly those label sets (`03` §8.2), which is a cross-product of matchers and therefore over-inclusive, so
  `matchesPin()` filters again in the shaper.

Alerting must reuse **neither** phase, and the reason survives the correction intact. Ranking
keeps the **K largest** values. For a `gt` rule that is coincidentally the right K; for an `lt`
rule — "free disk below 10 %", "successful checkouts below 5/min", "replicas below 3" — it
keeps the *healthiest* series and discards exactly the ones that should fire. The rule would
never alert, forever, with no error anywhere. Phase B pinning has the same defect one level
down: a series that only becomes interesting *because* it dropped is not in the pinned set.
The literal `topk` operator is worse still and the metrics engine already refuses it for four
independent reasons (`03-metrics-engine.md:264-278`): gigapipe does not accelerate it
(`optimizer/vector_agg.go:12-25`), so per-step stock semantics apply, the response holds the
**union** of every step's top-K, each series is **ragged**, and zero-fill then paints a healthy
series diving to zero.

Alerting therefore calls a sibling entry point, `compileAlertQuery` (see *Design* §3), which
reuses the metrics engine's §4.2 compilation table verbatim (`03-metrics-engine.md:803-830`),
at a caller-supplied window, with no grid, no ranking phase, no pinning and no comparison
operator. Cardinality is bounded on the **response** instead (D9).

**A `topk` wrapper is still on disk in the read-path spec and must be deleted (R1.3).**
`04-read-path.md` **§8.2 "Cardinality and query size"** still says `maxSeries` "is passed to the
tenancy compiler, which wraps any query carrying a `groupBy` in `topk(maxSeries, ...)` —
**server-side, in PromQL**". (The previous revision of this document cited `04-read-path.md:1389`
for it; that line number is stale, the sentence is not.) `03-metrics-engine.md` D8 rejects it
outright and its amendment 1, in "Six amendments this spec requires of `04-read-path.md`",
already asks for the deletion. D4 rejects it a second time,
on independent evidence: even if it *were* a cap, for an `lt` rule it keeps the healthiest
series and the rule never fires. **Two specs, two independent arguments, one owner: the
metrics spec wins and `04` §8.2's `topk` sentence is deleted.**

Two things worth recording while the correction is being applied:

- The other half of `03`'s amendment 5 — "a response with more than `maxSeries` series … the
  resolver raises `GigapipeUpstreamError`" — is **already gone** from `04`. A grep of
  `04-read-path.md` for `maxSeries` returns only the two lines of the §8.2 `topk` bullet. Only
  the `topk` sentence remains, and `04`'s own in-flight amendment ledger already marks it
  "Deleted"; this revision records the ask so it cannot be lost if that revision is dropped.
- `09-ui-surfaces.md` D4 argues against a persisted `Report.limit` column *because*
  "`compileMetricQuery` takes a required `maxSeries` and wraps breakdowns in `topk` … so the cap
  is enforced in PromQL before the data leaves gigapipe". That justification dies with the wrap.
  The conclusion (no `limit` column) may well survive on the ranking pass instead, but the
  paragraph has to be rewritten, and `09`'s `seriesLimit` field does not exist either (R1.1).

Alerting's own cap is `zNotificationRuleMetricConfig.maxSeries` (§1), a **rule-level** field
that is unrelated to `cfg.maxSeries`. It never truncates (D9).

### D5. Alert state lives in Postgres, in three tables

`MetricAlertRuleRuntime` (one row per metric rule — schedule, enablement, health),
`MetricAlertSeriesState` (one row per rule × series — the state machine), and
`MetricAlertEvent` (append-only transition log, which doubles as the delivery outbox).
Names are used consistently from here down; `MetricAlertState` is the **enum**
(`inactive | pending | firing`) and never a model, because Prisma cannot have both.

Why not Redis:

- **Durability.** OpenPanel's Redis runs `--maxmemory-policy noeviction` with a volume and
  **no `--appendonly`** (`self-hosting/docker-compose.template.yml:48-52`, identically in
  `docker-compose.yml:20` and `self-hosting/coolify.yml:28`). RDB-only persistence means an
  ungraceful restart rolls state back to the last snapshot: every already-notified alert
  re-fires and every `for` timer silently restarts.
- **The UI and the debugging story are queries.** "Which series are firing in this project"
  is `WHERE "projectId" = ? AND state = 'firing'`. Over Redis it is a `SCAN` per rule.
- **The transition log has to be durable, ordered, and joinable.**

**Honest write budget — corrected.** The draft claimed writes happen "only for series that
changed", sized 1 000 rules at ~1 000 rows/min. That contradicts the state machine, which
refreshes `value`/`lastSeenAt` on every present series so the rule card can render a
non-firing series' current value. The real worst case is `rules × maxSeries` UPDATEs per
minute — 20 000/min at 1 000 rules and `maxSeries: 20`, each also bumping `updatedAt`. That
is still an order of magnitude under the event pipeline, but it is a real autovacuum
consideration, and it is why the state machine writes `value`/`lastSeenAt` **only when the
state changed, the value moved by more than 0.5 %, or `lastSeenAt` is older than
`everySeconds × 5`** (see *Design* §5.4). Under that rule steady state is close to the
draft's number and the pathological case is bounded.

**Rejected: Redis hashes keyed `alert:{ruleId}:{seriesKey}` with a TTL.** Cheaper writes, no
migration — but durability alone is disqualifying.

**Rejected: columns on `NotificationRule`.** Eight nullable columns that are NULL for every
event and funnel rule, plus one fatal side effect: `NotificationRule.updatedAt` is
`@updatedAt` (`packages/db/prisma/schema.prisma:593`), so bumping `lastEvaluationAt` every
minute would permanently overwrite "when was this rule last edited". The runtime row also
gives the dispatcher an index over a table containing *only* metric rules.

**`MetricAlertEvent` deliberately has no foreign key to `NotificationRule`.**
`11-testing-strategy.md:1101-1108` requires that deleting a rule not destroy incident
history, and reviewer feedback independently reached the same place: with a cascading FK the
only remedy for a noisy rule (deletion) also erases the audit trail that explains why it was
noisy. So `MetricAlertEvent.notificationRuleId` is a plain indexed column with no relation,
while `projectId` **is** a cascading relation so `deleteProjects` (which uses
`db.project.delete`, `packages/db/src/services/delete.service.ts:15-35`) still reaps it. The
two live tables keep cascading FKs to the rule; they are worthless without it.

### D6. Scheduling is level-triggered from a stored due-time

Each metric rule carries `MetricAlertRuleRuntime.nextEvaluationAt`. The dispatcher selects
`nextEvaluationAt <= now()` and advances it. It does not compute dueness from the tick.

`bootCron` registers sub-hour jobs as `{ every: <ms> }` (`apps/worker/src/boot-cron.ts:157-174`)
and BullMQ does not backfill missed repeat occurrences. Any `(tick − offset) % everySeconds === 0`
scheme therefore skips a rule's entire period whenever a tick is missed — a redeploy, a Redis
blip, or one cron tick overrunning 60 s on a worker whose `cron` concurrency defaults to 1
(`apps/worker/src/boot-workers.ts:218-227`). At `everySeconds: 3600` that is an hour of
blindness with nothing recorded.

Stored dueness self-heals after any gap and makes "this rule has not evaluated in N periods"
a one-line query for the health badge.

**Rejected: a wall-clock cron pattern instead of `every: 60_000`.** Once dueness is stored
the tick source need not be phase-exact. (The draft justified this with "every other
sub-hour cron in this repo uses a numeric interval". That is **false** — `cohortRefresh` is
registered with `pattern: '*/30 * * * *'` at `boot-cron.ts:91-95`. The flush jobs
(`:46-75`) and `sessionReaper` (`:96-100`) use numeric intervals; the decision stands on its
own reasoning, not on that claim.)

**Jitter is explicit, not emergent.** The draft asserted jitter "falls out of naturally
staggered first runs". It does not: a bulk import, a restored backup, a first deploy, or a
customer adding 40 rules in one sitting all produce rules sharing a due second forever.
Runtime rows are therefore created with `nextEvaluationAt = now + random(0, everySeconds)`
(*Design* §4.3).

### D7. The cron body is one `queue.add`; the real work runs on a new `alerts` queue

`cronQueue` is consumed by one worker at `getConcurrencyFor('cron')`, default **1**
(`boot-workers.ts:218-227`), and that same worker runs `flushEvents`, `flushSessions`,
`flushProfiles`, `flushReplay` and `flushGroups` every 10 s (`boot-cron.ts:46-75`) — the
ClickHouse write half of the event ingest hot path. A dispatcher that scans rules and issues
N `queue.add` calls head-of-line-blocks event ingest for as long as it takes. And evaluation
must be parallel: one instant query is 50–500 ms, so 500 rules evaluated serially do not fit
in a 60 s period.

So `case 'metricAlerts'` in the cron switch is a single `alertsQueue.add(...)`, and
everything else happens on a dedicated `alerts` queue with `ALERTS_CONCURRENCY` (default 5,
matching `insights` and `gsc` — `boot-workers.ts:252, :263`).

### D8. Notification on transition only, by default

A metric alert notifies when a series enters `firing` and when it leaves `firing`. It does
not re-notify while firing unless `renotifySeconds` is set.

OpenPanel has no silence, no acknowledge, and no snooze. A repeat-notify default in a system
with no mute control is how a Slack channel gets muted permanently, which is strictly worse
than no alerting. `renotifySeconds` is opt-in with a 300 s floor.

**Rejected: a repeat interval defaulting to 1 h** (Alertmanager's `repeat_interval`).
Alertmanager has silences; we do not — but see D11, which gives us the off switch that makes
this default survivable.

### D9. Cardinality: fail the rule, never truncate it

If the response carries more than `config.maxSeries` series, the evaluation marks the rule
unhealthy, transitions nothing, and **leaves existing state exactly as it is** — a series
that was firing before the explosion stays firing and stays visible.

**Rejected: truncate to `maxSeries`.** An alert rule that silently stops watching part of
its own scope is a rule that lies, and with no `topk` (D4) the truncation would be over the
response's arbitrary order.
**Rejected: fire a "too many series" notification per evaluation.** That is one notification
a minute for as long as the label explosion lasts — exactly the flood the cap prevents. It
surfaces as a badge and a counter instead.

### D10. Delivery is serialised and capped per evaluation

`renotifySeconds`' 300 s floor exists because the delivery path has no rate limiter:
`apps/worker/src/jobs/notification.ts` issues one webhook POST per notification with no
batching. That argument applies with equal force to the initial fire burst — 20 series ×
3 targets landing in one `Promise.all` is 60 POSTs in a second against an incoming webhook
that rate-limits at roughly one per second, and (per D12) those 429s are invisible.

So: the `createNotification` calls for one evaluation run **sequentially**, in `seriesKey`
order, and are capped at `min(config.maxSeries, ALERT_MAX_NOTIFICATIONS_PER_EVAL)` (default
10). When the cap bites, one extra rollup notification says "and N more series", and the
remaining event rows are written with `suppressed = true, suppressedReason = 'burst_cap'`
so `alertHistory` still shows every transition.

**Rejected: leave it unthrottled and defer grouping to P6.** Grouping is a bigger feature;
a cap plus a rollup line is an afternoon and removes the failure mode.

### D11. A metric rule can be paused, and pausing is not deletion

`NotificationRule` has no `enabled` column (`schema.prisma:581-597`) and this spec does not
add one — that would drag four hand-written whitelists (`report`-style create/update
literals in `packages/trpc/src/routers/notification.ts:100-116` and `:120-138`) and the
shared event/funnel surfaces into P5. Instead `MetricAlertRuleRuntime` carries
`enabled Boolean @default(true)` and `mutedUntil DateTime?`, and the dispatcher's `where`
excludes both. A pause writes one `MetricAlertEvent` per firing series with
`reason = 'rule_disabled'`, `suppressed = true`, and drops those rows to `inactive`; an
unpause clears `pendingSince`/`clearedSince` and sets `nextEvaluationAt = now`.

This is what makes `'rule_disabled'` a reachable reason rather than dead vocabulary, and it
is what makes D8's transition-only default safe: the 3 a.m. remedy for a misconfigured rule
is now a toggle, not `deleteRule` — which cascades away the runtime row and every series
state row and sends no resolve for series that were firing.

**Rejected: ship without an off switch and document deletion as the only control.** With
per-series fan-out up to `maxSeries` messages per transition, "delete it or live with it" is
not an acceptable first release.

### D12. "Notified" means "enqueued". Delivery beyond that is currently unobservable

This is a correction, not a design choice, and it is load-bearing for every debugging claim
in this document.

`postWebhook` catches **every** error and returns `{ ok: false, status: 0 }`
(`packages/integrations/src/fetcher.ts:39-52`). `sendSlackNotification` and
`sendDiscordNotification` both just `return postWebhook(...)`
(`packages/integrations/src/discord.ts:23-29`). `notificationJob` does
`return postWebhook(...)` / `return sendSlackNotification(...)` without inspecting `.ok`
(`apps/worker/src/jobs/notification.ts:112-138`). So a Slack 429, a webhook 500, a DNS
failure and an SSRF rejection by `safeWebhookFetcher` all mark the BullMQ job **completed**.
`notificationQueue` sets `removeOnComplete: 10`, no `attempts` and no `removeOnFail`
(`packages/queue/src/queues.ts:281-289`), so within ten notifications the record is gone.

It matters more for alerts than for event rules, because D8 makes notification
transition-only: a dropped fire notification is never re-sent.

P5 therefore ships the honest version: `MetricAlertEvent.enqueuedAt` (not `notifiedAt`) is
stamped when the queue accepted the job, `alertHistory` labels it "enqueued", and the
guarantee is stated as *at least once **enqueued** per transition*. The real fix — have
`notificationJob` throw on `!result.ok` and give `notificationQueue` `attempts`/`backoff` —
is a change to shared delivery code used by every event and funnel rule in production, so it
is filed as a cross-stream ask (see *Interfaces*) rather than smuggled into P5.

### D13. Every evaluation queries at wall-clock now; `dueAt` is only the claim key

The draft passed `evaluatedAt: due` into the evaluation and issued
`time: Math.floor(evaluatedAt.getTime()/1000)`. `due` is the stored `nextEvaluationAt`,
which after any backlog is arbitrarily stale. The first evaluation after a 43-minute outage
would have queried gigapipe for a 43-minute-old instant and stamped `lastSeenAt`,
`pendingSince`, `firingSince`, `clearedSince` and the event row's `at` at that stale
timestamp — firing on a condition that already recovered, and (worse) making
`now − lastSeenAt` exceed `missingGraceSeconds` on the very next tick, so every
not-yet-reappeared series would be judged missing and, under the `resolve` default, emit a
spurious "the series stopped reporting" resolve. A routine deploy would become a burst.

So: `due` stays the idempotency key for the `updateMany` claim; the query time and every
state timestamp are a single `new Date()` taken at the top of the evaluation.

**Rejected: take the claim but skip the evaluation when `now − due > everySeconds`.** A
deployment with a persistent backlog would then never evaluate anything, and the freshest
available read is always more useful than none.

### D14. Timers do not survive an evaluation gap

`forSeconds` is a *continuity* requirement. Nothing in the draft invalidated it across a
gap: after a two-hour outage, a `pendingSince` from two hours ago plus one breaching
evaluation satisfies `now − pendingSince ≥ forSeconds` immediately, and the rule fires on a
single sample while claiming it has been bad for two hours. Symmetrically, a stale
`clearedSince` resolves a firing series on the first evaluation after the outage regardless
of `keepFiringForSeconds`.

So each evaluation first computes `staleGap = lastSuccessAt === null ||
now − lastSuccessAt > ALERT_GAP_FACTOR × everySeconds` (`ALERT_GAP_FACTOR` = 3). On a stale
gap, before any comparison: `pendingSince` and `clearedSince` are cleared, `lastSeenAt` is
set to `now` on every stored row (so `missingGraceSeconds` is measured from the resumption,
not from before the outage), `state` is **held** — a firing series is never auto-resolved by
our own outage — and one `MetricAlertEvent` with `reason = 'evaluation_gap'`,
`suppressed = true` is written so the history explains the discontinuity.

### D15. Alerting takes its own per-project gigapipe lease bucket

**Half of this decision is now settled (R1.4).** The previous revision argued against a
contract at `04-read-path.md:1447-1449` reading "the P5 alert worker takes one lease per
evaluation *sweep*, not per rule", on the grounds that under D7 there is no sweep — the
dispatcher fans out one job per rule and the jobs run on independent workers and replicas.
**That contract is no longer on disk.** The `LEASE_TTL_SECONDS` doc comment in
`04-read-path.md` §8.4 now reads "P5 alert evaluation takes one lease per rule evaluation,
never one per batch", and its Interfaces row for `withProjectLease` repeats it with a stated
120 s max hold. The two documents agree; nothing has to
be retracted on either side. What follows is therefore the *remaining* half of D15.

Alerting takes one lease **per evaluation**, from a **separate bucket**:
`withProjectLease(projectId, fn, { bucket: 'alerts', max: GIGAPIPE_ALERT_CONCURRENCY_PER_PROJECT })`,
default 2. Two properties follow, both of which the sweep formulation was reaching for:
alert evaluation can never consume the interactive dashboard budget, and one project with
hundreds of rules cannot starve another project's alerts. `GigapipeBusyError` is a transient
failure: no transition, retry next period.

This is the one open request on `04-read-path.md` — an optional `{ bucket, max }` argument on
`withProjectLease` (`packages/gigapipe/src/lease.ts`, `04-read-path.md` §8.4), one extra key
segment. It is listed in *Interfaces*. The 120 s `LEASE_TTL_SECONDS` in the same section is
comfortably above an alert evaluation's 50–500 ms instant query, so no TTL change is asked for.

### D16. The outbox stays, but it needed a claim, an attempt bound and a dead letter

The strongest objection to the outbox is that notify-first-then-commit gives the same
at-least-once guarantee with none of the machinery. It does not, for two reasons the draft
never stated:

1. **A failing state write becomes an unbounded notification loop.** With notify-first, if
   the transaction fails (constraint violation, connection reset, a poison label value), the
   notification has already gone out and the next tick re-detects the same transition and
   notifies again — forever, with no state advance. Write-first fails to *silence* plus a
   recoverable stranded row, which is the correct direction for an alerting system.
2. **A partial `Promise.all` failure re-notifies already-delivered targets.** With D10's
   serialised, capped delivery this matters more, not less.

The `MetricAlertEvent` row is needed for `alertHistory` regardless, so the marginal cost of
the outbox is three columns and a sweep — not a table.

What the draft got wrong, and is fixed here: the sweep had **no per-row claim, no attempt
bound and no dead letter**, and there is a poison row reachable on day one.
`createNotification` strips NUL characters from `payload` only —
`payload: stripNullChars(notification.payload) || undefined`
(`packages/db/src/services/notification.service.ts:139-147`) — while `title` and `message`
pass through raw. Notification bodies render label *values*, which are unvalidated OTLP
attribute strings. A label value containing U+0000 makes `db.notification.create` throw for
the `sendToApp` target, the row is never stamped, and an `at ASC`, unbounded-attempt sweep
retries it on every tick forever while re-notifying every row ahead of it — a permanent
stall plus a notification storm, in the component whose job is to stop notification storms.

Fixed three ways: `SELECT … FOR UPDATE SKIP LOCKED` with a `leasedAt` lease,
`deliveryAttempts` bounded at 5 then `deadLetteredAt`, and a `sanitizeLabelText` applied to
every label value before it reaches a title, a message or a payload (*Design* §7.3).

**Rejected: drop the partial index.** `@@index([enqueuedAt, at])` is declared in the Prisma
schema instead. The draft's hand-written `CREATE INDEX … WHERE "notifiedAt" IS NULL` asserted
that "`prisma migrate diff` will not try to drop it" with no support, and there is **no
precedent** — `grep 'CREATE INDEX' packages/db/prisma/migrations/*/migration.sql | grep -i where`
returns nothing. An object present in the shadow database and absent from `schema.prisma` is
a standing drift candidate. The sweep is `LIMIT 500` and the predicate matches zero rows in
steady state; an ordinary two-column index is enough.

---

## Design

### 0. Where the code goes

```
packages/validation/src/index.ts                     # zNotificationRuleMetricConfig (§1)
packages/db/src/services/notification.service.ts     # INotificationPayload + notificationTemplateMetric (§2, §8)
packages/db/src/services/metric-alert.service.ts     # NEW — persistence, outbox, queries (§5-§7)
packages/db/src/services/metric-alert.machine.ts     # NEW — the PURE state machine (§5.2)
packages/db/src/engine/metrics/compile.ts            # + compileAlertQuery (§3)          [P2 file]
packages/db/prisma/schema.prisma                     # 3 models + 1 enum (§4.1)
packages/db/prisma/migrations/2026…_metric_alerts/   # (§4.2)
packages/queue/src/queues.ts                         # alertsQueue + CronQueuePayloadMetricAlerts
apps/worker/src/boot-cron.ts                         # + metricAlerts, every 60 s
apps/worker/src/boot-workers.ts                      # + 'alerts' in the default list, worker, drain
apps/worker/src/index.ts                             # + BullMQAdapter(alertsQueue) in bull-board (:55-62)
apps/worker/src/metrics.ts                           # + queue in the gauge loop (:18) + 5 metrics (§10.3)
apps/worker/src/jobs/cron.ts                         # + case 'metricAlerts'
apps/worker/src/jobs/cron.metric-alerts.ts           # NEW — the three-line cron body
apps/worker/src/jobs/alerts.ts                       # NEW — the alerts queue job router
packages/trpc/src/routers/notification.ts            # + 4 procedures, + runtime-row maintenance (§9)
apps/start/src/modals/add-notification-rule.tsx      # type-aware form (§9.2)
apps/start/src/components/notifications/rule-card.tsx# compile fix + metric branch + badges (§9.1)
apps/start/src/components/notifications/metric-rule-preview.tsx   # NEW (§9.4)
apps/public/content/docs/self-hosting/environment-variables.mdx   # ENABLED_QUEUES list + new vars
```

Nothing under `packages/gigapipe/` is written here; it is consumed.

### 0.1 What this reuses unchanged, and what it does not

Verified by reading each file. "None" means literally zero lines change.

| File | What it does | Change |
|---|---|---|
| `apps/worker/src/jobs/notification.ts:24-33` | in-app: `publishEvent('notification','created', …)` | **none** |
| `apps/worker/src/jobs/notification.ts:34-65` | email fan-out to every org member via `sendEmail('notification-rule', …)` | **none** |
| `apps/worker/src/jobs/notification.ts:83-139` | webhook / Discord / Slack via `safeWebhookFetcher` | **none** (but see D12) |
| `packages/db/src/services/notification.service.ts:139-157` | `createNotification` — writes a `notifications` row only when `sendToApp`, then enqueues | **none** |
| `packages/db/src/services/notification.service.ts:159-168` | `triggerNotification` | **none** |
| `packages/db/src/services/notification.service.ts:92-115` | `getIntegration` — maps the two pseudo-integration ids | **none** |
| `packages/db/src/services/notification.service.ts:121-137` | `stripNullChars` — recurses objects and arrays | **none** |
| `packages/email/src/emails/notification-rule.tsx:8-13` | props are `{title, message, projectName?, dashboardUrl?}` — already signal-agnostic | **none** |
| `apps/worker/src/boot-workers.ts:229-239` | the notification worker | **none** |
| `apps/start/src/components/notifications/notification-provider.tsx:18-23` | in-app toast | **none** |
| `apps/start/src/components/notifications/table/columns.tsx:12-20` | `getEventFromPayload` returns `null` for an unknown payload type, so derived cells render empty | **none** |
| `packages/trpc/src/routers/notification.ts:18-42` | `notification.list` | **none** |

**Not free** — corrected and completed. The draft's table omitted the funnel path, which is
the one that does not compile:

| Thing | Why | Where |
|---|---|---|
| `zNotificationRuleConfig` gains a third member | discriminated union | §1 |
| `INotificationPayload` gains **two** members | the metric payload and the project-level notice | §2 |
| **`notification.service.ts:377-386` — `isFunnelRule` / `getFunnelRules`** | `isFunnelRule` returns `boolean`, **not** a type predicate, so `rules.filter(isFunnelRule)` returns `INotificationRuleCached[]` with `config` still the full union. `checkNotificationRulesForSessionEnd` then reads `rule.config.events` at `:410`, `:413` and `:420`. A third member without `events` **breaks the build of `packages/db`**, and therefore of every downstream package | §0.2 |
| `apps/start/.../rule-card.tsx:19-21` | `NotificationRule['config']['events'][number]` stops compiling. (`:68` and `:79` are inside `switch (rule.config.type)` and **do** narrow — they need no change) | §9.1 |
| `apps/start/src/modals/add-notification-rule.tsx:53-62, 87-90, 92-98, 127-136` | `defaultValues.config`, an unconditional `useFieldArray({ name: 'config.events' })`, the submit guard `data.config.events[0]?.name`, and a hardcoded two-option type picker | §9.2 |
| Delivery **content** | default-mode webhooks, Discord and Slack send only `{title, message}` (`notification.ts:102-138`); the email template carries only `title/message/projectName/dashboardUrl` | §8.3 |
| `notificationTemplateEvent`'s placeholder loop | `if (value)` at `notification.service.ts:272` skips falsy values, so `{{value}}` renders literally when the value is `0` | §8.2 |
| `apps/worker/src/index.ts:55-62`, `apps/worker/src/metrics.ts:18` | bull-board queue array and the per-queue depth gauge loop are both explicit lists | §0, §10.3 |
| `environment-variables.mdx:619-633` | documents `ENABLED_QUEUES`' available names; `alerts` must be added, plus `ALERTS_CONCURRENCY` / `ALERTS_DISPATCH_BATCH` | §11 |

#### 0.2 The funnel-path fix

```ts
// packages/db/src/services/notification.service.ts:377
// A type predicate, not a boolean. Without `rule is …`, getFunnelRules returns
// the un-narrowed union and every `rule.config.events` read below is an error
// the moment a config member without `events` exists.
const isFunnelRule = (
  rule: INotificationRuleCached,
): rule is INotificationRuleCached & { config: INotificationRuleFunnelConfig } =>
  rule.config.type === 'funnel';
```

`getHasFunnelRules` and `getFunnelRules` are unchanged textually and both narrow correctly
afterwards. `checkNotificationRulesForEvent` already narrows explicitly
(`rule.config.type === 'events'` at `:319`) and needs no edit, so the event ingest hot path
is genuinely untouched — but the funnel path is not, and the draft said it was.

One consequence worth stating: `getNotificationRulesByProjectId` — a `cacheable` with a
1 440 s TTL (`notification.service.ts:71-90`) — now returns metric rules to callers that
will never use them. Harmless; not worth a second cache key. The evaluator does **not** read
that cache (it reads `MetricAlertRuleRuntime` directly), which is why metric rule edits take
effect on the next tick rather than after 24 minutes.

### 1. `zNotificationRuleMetricConfig`

**NEW**, in `packages/validation/src/index.ts`, after `zNotificationRuleFunnelConfig`
(`:517-524`) and before the union at `:526-529`. zod v4.

> **R1.1 — the schema question is decided, not open.** `config.query` embeds
> **`zMetricQuery` exactly as `03-metrics-engine.md` §2 defines it today**, from
> `packages/validation/src/telemetry.validation.ts`. That is: `type`, `id?`, `metric`,
> `metricType` (`counter|gauge|histogram|**summary**`), `filters: zMetricLabelFilter[]`
> (`{ name, operator: 'eq'|'neq'|'re'|'nre', value }`), an **eleven-member** `fn`
> (`none, rate, increase, delta, avg_over_time, min_over_time, max_over_time, sum_over_time,
> count_over_time, last_over_time, histogram_quantile`), `window` (**eleven** members
> including `auto`, default `auto`), `aggregation?` (`sum|avg|min|max|count`, required whenever
> `groupBy` is non-empty), `groupBy`, `quantile?`, `scale` (default 1), `displayName?`,
> `hideSeries?`, plus `refineMetricQuery`'s cross-field rules (`REDUCER_TABLE` totality and the
> summary-quantile rule). There is **no** `matchers`, **no** `op`, **no** `fill`, **no**
> `seriesLimit` and **no** `k`.
>
> Three other documents describe something else and are wrong. `01-tenancy-and-security.md`
> §7.2 still carries a second, older body (`irate`/`deriv` in `fn`, `topk`/`bottomk`/`quantile`
> in `aggregation`, a `k` field) — that block becomes a **pointer** at `03` §2, keeping only the
> reserved-prefix refinements, which is the part `01` genuinely owns. `09-ui-surfaces.md` D3
> claims to consume `03` "verbatim" and then describes a **fourth** shape that appears in no
> document (`metricType` limited to three values, a five-member `fn` including `'value'`,
> `matchers` with PromQL glyph operators, `fill`, `seriesLimit` 1–200) — verified by grep:
> `seriesLimit` occurs **zero** times in `03` and `'value'` is not an `fn`.
> `11-testing-strategy.md` §3.4 tests `zMetricMatcher`, which exists only in `09`'s invented
> shape; it is `zMetricLabelFilter`.
>
> The reason `03`'s version wins is not seniority. It is the only one whose `fn` set is
> *proved* to be a subset of gigapipe's accelerated `rangeFns`/`aggFns` (`03` §0 and its test
> T-C6), it is the object the chart builder persists — so "alert on this chart" only works if
> alerting embeds the same object — and it has already removed `topk`/`bottomk`, which D4 and
> `03` D8 both independently require.
>
> **One thing to check when this lands.** `zMetricQuery` is `zMetricQueryBase.superRefine(...)`,
> not a bare `ZodObject`, and it is being embedded as a **field** of a member of a
> `z.discriminatedUnion('type', …)`. As an object *field* that is unremarkable in any zod
> version; the discriminated union only constrains its own members, and
> `zNotificationRuleMetricConfig` is the member. `03` §2's note on zod 4 refinement carrying is
> marked **UNVERIFIED** there and is not load-bearing here — but if `packages/validation` ever
> `.extend()`s or `.omit()`s `zNotificationRuleConfig`, re-read it.

```ts
export const zMetricAlertComparator = z.enum(['gt', 'gte', 'lt', 'lte']);
export type IMetricAlertComparator = z.infer<typeof zMetricAlertComparator>;

/**
 * What to do with a series that was pending or firing and is no longer in the
 * result vector at all.
 *
 *  - 'resolve': after missingGraceSeconds, treat it as recovered. Correct for
 *    saturation alerts, where a workload that scaled to zero genuinely has no
 *    error rate any more.
 *  - 'keep': hold the state indefinitely. Correct when silence IS the failure.
 *
 * Neither value can synthesise an alert for a series that never appeared;
 * absence alerting is a different rule shape and is deferred.
 */
export const zMetricAlertMissingSeries = z.enum(['resolve', 'keep']);

export const zNotificationRuleMetricConfig = z
  .object({
    type: z.literal('metric'),

    /**
     * The metrics engine's schema, imported from
     * packages/validation/src/telemetry.validation.ts and defined by
     * 03-metrics-engine.md section 2. Reused VERBATIM: the alerting form and
     * the chart builder must produce the same object or "alert on this chart"
     * is impossible. See the R1.1 box above -- this is a decision now, not an
     * open question.
     *
     * Raw PromQL is NOT accepted here and will not be in P6 either.
     */
    query: zMetricQuery,

    comparator: zMetricAlertComparator,

    /** A finite double. The evaluator separately rejects non-finite SAMPLES. */
    threshold: z.number().finite(),

    /**
     * The series must breach CONTINUOUSLY for this long before it fires. 0
     * fires on the first breaching evaluation.
     *
     * Capped at 24 h because the timer is anchored on pendingSince, which any
     * single non-breaching evaluation resets — a multi-day `for` is essentially
     * never satisfied and reads to the user as "my alert is broken".
     */
    forSeconds: z.number().int().min(0).max(86_400).default(0),

    /**
     * Evaluation cadence. Values below 60 are REJECTED, not coerced: the cron
     * tick that drives the dispatcher is 60 s, so a smaller value cannot be
     * honoured and silently rounding it would be a lie in the rule editor.
     * Values need not divide 60 — dueness is stored, not computed (D6).
     */
    everySeconds: z.number().int().min(60).max(86_400).default(60),

    /**
     * Prometheus 2.42's keep_firing_for. After the condition clears, stay
     * firing for this long; a re-breach inside the window emits neither a
     * resolve nor a second fire. The flap damper.
     */
    keepFiringForSeconds: z.number().int().min(0).max(86_400).default(0),

    notifyOnResolve: z.boolean().default(true),

    /**
     * Re-notify a still-firing series at most this often. null = transitions
     * only (D8). The 300 s floor exists because the delivery path has no rate
     * limiter of its own (D10, D12).
     */
    renotifySeconds: z.number().int().min(300).max(86_400).nullable().default(null),

    missingSeries: zMetricAlertMissingSeries.default('resolve'),

    /**
     * How long a series must be absent before missingSeries applies.
     *
     * The default is deliberately larger than gigapipe's PromQL lookback. The
     * reader builds its engine with LookbackDelta: 0
     * (reader/router/prometheus_query_range.go:34), which the Prometheus engine
     * reads as "use the default" — 5 minutes — so a series that stopped
     * reporting keeps returning its last sample for ~5 min before it leaves the
     * vector at all. A grace shorter than that measures nothing.
     *
     * UNVERIFIED that LookbackDelta: 0 resolves to exactly 5 m; see Q3.
     */
    missingGraceSeconds: z.number().int().min(60).max(86_400).default(900),

    /**
     * Hard cap on the result vector's cardinality. Exceeding it makes the rule
     * unhealthy and transitions nothing (D9) -- it never truncates.
     *
     * This is a RULE-level field and is unrelated to the metrics engine's
     * cfg.maxSeries (default 20, GIGAPIPE_MAX_SERIES, 03-metrics-engine.md
     * section 5), which is a display cap applied after JS ranking on the chart
     * path. Alerting does no ranking (D4). The ceiling is 100 because 100
     * firing series is already 100 Slack messages. (The previous revision
     * justified it against "zMetricQuery's 200-series display limit"; there is
     * no such field -- see R1.1.)
     */
    maxSeries: z.number().int().min(1).max(100).default(20),
  })
  // Belt and braces. Under the canonical schema (R1.1) zMetricAggregation is
  // exactly {sum, avg, min, max, count} (03-metrics-engine.md section 2), so
  // this refine CANNOT fire and zod rejects topk/bottomk one level earlier.
  // It is kept for one reason: it is the only place in the codebase that
  // states WHY topk is forbidden in an alert, and if the enum is ever widened
  // back -- for a raw-PromQL surface, or for a chart feature -- the alert path
  // must not silently inherit it. Test A39 asserts the compiled string, which
  // is the real boundary; this is the readable half of the same guarantee.
  .refine((c) => !['topk', 'bottomk'].includes((c.query as { aggregation?: string }).aggregation ?? ''), {
    message:
      'topk/bottomk cannot be used in an alert: for an `lt` rule they keep the healthiest ' +
      'series and discard exactly the ones that should fire (D4).',
    path: ['query', 'aggregation'],
  });

export type INotificationRuleMetricConfig = z.infer<typeof zNotificationRuleMetricConfig>;
```

and the union at `:526-529` becomes a three-member `z.discriminatedUnion('type', […])`.
`zCreateNotificationRule` (`:533-542`) needs **no** change — it references the union.

**Per-project rule quota, interim.** `createOrUpdateRule` rejects a create that would take
the project past `ALERT_MAX_RULES_PER_PROJECT` (default **50**). Nothing limits rule count
today, and 500 rules on one project is 500 gigapipe instant queries a minute from one
tenant; the per-project lease (D15) bounds concurrency but not total work. One `count` and
one `throw` until the P6 quota system lands.

### 2. The payload union

`packages/db/src/services/notification.service.ts:29-37` becomes:

```ts
export type INotificationMetricPayload = {
  type: 'metric';
  state: 'firing' | 'resolved';
  /** Why the transition happened. Drives the wording in §8.1. */
  reason: 'threshold' | 'missing' | 'keep_firing_expired' | 'renotify';
  ruleId: string;
  /** sha1 of the sorted label set; stable across evaluations. §5.1 */
  seriesKey: string;
  /** The offending series' labels, op_project_id stripped, sanitised (§7.3). */
  labels: Record<string, string>;
  /** null only when reason === 'missing'. */
  value: number | null;
  threshold: number;
  comparator: IMetricAlertComparator;
  metric: string;
  /** ISO. firingSince — for a resolve, i.e. how long it was bad. */
  since: string;
  evaluatedAt: string;
  /** Deep link to the rule, series pre-selected. */
  url: string;
};

/**
 * Project-level operational notice. Deliberately NOT an INotificationMetricPayload:
 * that type requires ruleId, seriesKey, threshold, comparator, metric, since and
 * url, none of which exist for a notice that covers every rule in a project.
 */
export type INotificationMetricAlertingBlindPayload = {
  type: 'metric_alerting_blind';
  projectId: string;
  failingRuleCount: number;
  /** ISO — when the oldest of those failures started. */
  since: string;
  url: string;
};

export type INotificationPayload =
  | { type: 'event'; event: IServiceCreateEventPayload }
  | { type: 'funnel'; funnel: IServiceEvent[] }
  | INotificationMetricPayload
  | INotificationMetricAlertingBlindPayload;
```

`packages/db/src/types.ts:23` (`IPrismaNotificationPayload = INotificationPayload`) picks
this up unchanged. No migration: `Notification.payload` is `Json?` (`schema.prisma:616-617`).
The mapping is applied by the bespoke regex post-processor
`packages/db/prisma/prisma-json-types.ts` (the second half of `codegen`), not by a generator
that needs a migration — so this is a pure type change.

**Two hard gates the payload must satisfy**, both verified:

1. **`payload` must be non-null.** `apps/worker/src/jobs/notification.ts:79-81` is
   `if (!isValidJson(payload)) { return new Error('Invalid payload'); }` — a `return`, not a
   `throw`. The BullMQ job **completes successfully**, nothing is delivered, and nothing is
   logged. Every metric notification therefore carries a payload, and a test pins it.
   (Note the email branch returns at `:64`, before that gate, so `sendToEmail` never reads
   `payload` — which is why the project-level notice below can be email-only if the fourth
   union member is ever contested.)
2. **`INotificationPayload` is a compile-time gate.** `ICreateNotification` is
   `Pick<Notification, … 'payload' …>` (`:19-27`).

Downstream consumers, checked: `notification.ts:87-100` applies the JS template only when
`payload.type === 'event'`, so a metric payload falls to `body = payload` and is POSTed raw
in `javascript` mode; in default mode the body is `{title, message}` and the payload never
reaches the wire. `columns.tsx:12-20` returns `null` for an unknown type and compiles as-is.

### 3. The compiler seam — `compileAlertQuery`

**This is an ask on the metrics work-stream (`03-metrics-engine.md`), and it is not the ask
the draft made.**
The draft composed `compileAggregation(q, applyFn(compileSelector(q, projectId), q))` and
described `applyFn` as "the existing private helper inside `compile.ts`". No such symbol
exists anywhere: `grep -rn "applyFn" docs/observability/` returns nothing, and
`packages/db/src/engine/metrics/compile.ts` is not in the repo. Worse, that composition
emits the wrong PromQL for histograms — it produces
`sum by (service_name, op_project_id) (histogram_quantile(0.95, rate(m[5m])))`, i.e.
`histogram_quantile` over a vector carrying no `le` label, which Prometheus answers with an
empty/NaN vector. The rule would never fire, forever, with no error: exactly the failure
class D4 exists to prevent.

The correct shape is the metrics engine's own, and it is already specified.
`03-metrics-engine.md` **§4.2 "The complete (metricType, fn) table"** (≈`:803-830`) gives the
compilation table; the histogram row reads, verbatim:

```
histogram_quantile(p, sum by (G, le) (rate(M_bucket[W])))
```

with the note "`A` is **forced** to `sum` and `le` force-added to `by`; the user's
`aggregation` is ignored". **Correction to the previous revision of this document:** it said
`le` is forced *ahead of* the user's `groupBy`. It is **appended after** it — `03` §4.3 passes
`compileAggregation` a shallow clone with `groupBy: [...q.groupBy, 'le']`. Order matters here
only because A40 asserts on the emitted string, so A40 is written for `by (G, le)` and not for
`by (le, G)`. (`op_project_id`'s position is a separate question and is settled in §7.1.)

The two consequences the draft missed both stand: the draft's sentence "a `histogram_quantile`
rule needs `q.groupBy` to include `le`" is wrong (the compiler forces it), and the alert form
must **hide the aggregation control when `fn === 'histogram_quantile'`**, because the setting is
silently ignored.

The ask, precisely:

```ts
// packages/db/src/engine/metrics/compile.ts   [metrics work-stream]

/**
 * Compile one zMetricQuery for ALERT evaluation: an instant query at a
 * caller-supplied range-vector window, with no time grid.
 *
 * This is compile()'s §4.2 emission table applied at `windowMs`, and MUST be
 * the same code path — a second table would drift, and the histogram shape is
 * exactly where drift is invisible (an le-less histogram_quantile returns an
 * empty vector, not an error).
 *
 * Differences from compile(), each load-bearing:
 *   - no MetricGrid: an instant query has one timestamp and no bucket grid, so
 *     deriveWindowMs()'s foldFn/subStep rules do not apply. The window comes
 *     from query.window (required for alert rules) or ALERT_DEFAULT_WINDOW.
 *   - no Phase A ranking and no Phase B pinning: ranking keeps the K LARGEST
 *     values, which for an `lt` rule is precisely the set that must not alert,
 *     and pinning to a ranked set hides a series that only became interesting
 *     because it dropped (D4). Cardinality is bounded on the response instead.
 *     There is no `topk` on either path: the metrics engine does not emit it
 *     either (03 D8). See D4 as revised in R1.2.
 *   - no valueScale / scaledUnit application: the threshold is authored in the
 *     rule's own units. `scale` is returned so the UI can label it, and is NOT
 *     applied to the sample before comparison.
 *   - returns the query string plus the fragments, so the caller can run the
 *     same D10 project-matcher assertion compile() runs.
 */
export function compileAlertQuery(
  query: IMetricQuery,
  ctx: { projectId: string; windowMs?: number },
): {
  promql: string;
  windowMs: number;
  groupBy: string[];          // labels the response is expected to carry, in order
  fragments: SelectorFragment[];
  valueScale: number;
  scaledUnit?: string;
  notices: MetricNotice[];    // e.g. window_clamped
};
```

**Rejected: alerting owns its own compiler.** `01-tenancy-and-security.md`'s auditability
argument and `04-read-path.md`'s layer split both rest on there being exactly one function in
the system that emits a `{` — `01` states it as "`compileSelector()` — the ONLY function in the
codebase that emits `{`". A second one breaks the security argument to save a few lines.

**Estimate impact.** The draft budgeted this at 0.5 d "assuming `applyFn` exists". It does
not exist and neither does the factoring. This is a **hard dependency on `03-metrics-engine.md`
factoring its emission table into a grid-free entry point**, sized in *Effort* accordingly.

**Compiled example.** For the rule in §12, one of:

```promql
sum by (op_project_id, service_name) (rate(http_server_requests_total{op_project_id="proj_abc",http_response_status_code=~"5.."}[5m]))
sum by (service_name, op_project_id) (rate(http_server_requests_total{op_project_id="proj_abc",http_response_status_code=~"5.."}[5m]))
```

Both are correct and A39 passes on either — see the correction below on why the position is
not pinned.

`op_project_id` in the `by (…)` clause is not decoration: the tenancy layer puts it in the
grouping set and never emits `without`, specifically so the tenancy label survives aggregation
and the response check has something to check on **every** response. The evaluator strips it
after verification and before the series key is computed.

**Correction (R1.5).** The previous revision attributed to `compileAggregation` the body
`[...new Set([...q.groupBy, TELEMETRY_PROJECT_LABEL])]`, citing `01-tenancy-and-security.md`.
Two things are wrong with that. First, `compileAggregation` **is not in `01` at all**. What
`01` exposes is `compileGroupBy(q): string`, whose entire body is
`` return `by (${[TELEMETRY_PROJECT_LABEL, ...q.groupBy].join(', ')})`; `` — a *fragment*, with
the tenancy label **first**, not appended last, and with no `Set` de-duplication (it needs
none: `groupBy` refuses names starting with the reserved `op_` prefix, and `01`'s own test
T1.13 asserts `op_project_id` is first for every spec, `groupBy: []` included). Second, whether
the label comes first or last is invisible to PromQL semantics but **visible to a golden
test**, so A39 asserts *presence inside `by (…)`*, never a position. The wrapping form this
document needs — `compileAggregation(q, inner): string` — has to be added to `01`'s exposed
table; see *Interfaces*.

### 4. Persistence

#### 4.0 What the existing schema does not give us

`NotificationRule` (`schema.prisma:581-597`) has `id, name, projectId, integrations,
sendToApp, sendToEmail, config, template, createdAt, updatedAt, notifications`.
`Notification` (`:599-620`) has `title, message, isReadAt, sendToApp, sendToEmail,
integrationId, notificationRuleId, payload`. There is **no** state, severity, for-duration,
cooldown, `resolvedAt`, `lastEvaluatedAt`, `enabled` or per-series dimension anywhere.

The closest precedent, `cron.data-health.ts`, dedupes with one-shot timestamps on the
`Project` entity and deliberately bypasses `NotificationRule`, calling `sendEmail` directly.
So there is no periodic → `NotificationRule` bridge in this repo to copy. P5 builds it.

Alert history cannot live in `notifications`: a row is written **only when `sendToApp`**
(`notification.service.ts:150-154`), and `Notification.integration` is `onDelete: Cascade`
(`schema.prisma:610-611`), so deleting a Slack integration deletes its notification history.

#### 4.1 New models

```prisma
enum MetricAlertState {
  inactive
  pending
  firing
}

/// One row per metric NotificationRule: the dispatcher's work queue, the
/// enable/mute switch (D11), and the rule's health record. Separate from
/// NotificationRule because NotificationRule.updatedAt is @updatedAt and must
/// keep meaning "when a human last edited this rule" (D5).
model MetricAlertRuleRuntime {
  id                 String           @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  notificationRuleId String           @unique @db.Uuid
  notificationRule   NotificationRule @relation(fields: [notificationRuleId], references: [id], onDelete: Cascade)
  projectId          String
  project            Project          @relation(fields: [projectId], references: [id], onDelete: Cascade)

  /// D11. The dispatcher's WHERE excludes disabled and currently-muted rules.
  enabled            Boolean          @default(true)
  mutedUntil         DateTime?

  /// Level-triggered dueness (D6). Seeded to now + random(0, everySeconds).
  nextEvaluationAt   DateTime
  /// Advanced by the claim (§6.3); also the idempotency key for a redelivered job.
  lastEvaluationAt   DateTime?
  /// Scheduled instants the rule was due for and did not run. RESET TO 0 on
  /// every successful evaluation, so the badge answers "since the last success"
  /// rather than latching forever after one restart.
  skippedPeriods     Int              @default(0)

  lastError          String?
  /// Machine-readable classifier. Closed vocabulary, §10.2.
  lastErrorCode      String?
  consecutiveFailures Int             @default(0)
  lastSuccessAt      DateTime?
  /// How many series in the last successful evaluation returned NaN/±Inf.
  /// Backs the badge; a single string column cannot carry a count.
  nonFiniteSeries    Int              @default(0)

  createdAt          DateTime         @default(now())
  updatedAt          DateTime         @default(now()) @updatedAt

  @@index([nextEvaluationAt])
  @@index([projectId])
  @@map("metric_alert_rule_runtimes")
}

/// One row per (rule, series). The state machine (§5).
model MetricAlertSeriesState {
  id                 String           @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  notificationRuleId String           @db.Uuid
  notificationRule   NotificationRule @relation(fields: [notificationRuleId], references: [id], onDelete: Cascade)
  projectId          String
  project            Project          @relation(fields: [projectId], references: [id], onDelete: Cascade)

  /// sha1 hex of the canonicalised label set (§5.1).
  seriesKey          String
  /// The label set itself, op_project_id stripped, sanitised (§7.3).
  /// [IPrismaMetricAlertLabels]
  labels             Json

  state              MetricAlertState @default(inactive)
  /// Last observed sample. Null while the series is absent.
  value              Float?
  /// Set on the first breaching evaluation; cleared by any non-breaching one,
  /// and by a stale evaluation gap (D14).
  pendingSince       DateTime?
  firingSince        DateTime?
  /// Set while firing and no longer breaching; drives keepFiringForSeconds.
  clearedSince       DateTime?
  /// Last evaluation in which this series appeared. Drives missingSeries.
  lastSeenAt         DateTime
  /// Last time a notification was ENQUEUED for this series. Drives
  /// renotifySeconds. Written in the same transaction as the event row (§7.4).
  lastNotifiedAt     DateTime?

  createdAt          DateTime         @default(now())
  updatedAt          DateTime         @default(now()) @updatedAt

  @@unique([notificationRuleId, seriesKey])
  @@index([projectId, state])
  @@index([notificationRuleId, state])
  @@map("metric_alert_series_states")
}

/// Append-only transition log. Two jobs: the answer to "why didn't my alert
/// fire", and the delivery outbox (D16).
///
/// notificationRuleId is a plain column with NO relation, deliberately: a
/// cascading FK would make deleteRule erase the incident history that explains
/// why the rule was deleted (11-testing-strategy.md:1101-1108). projectId IS a
/// cascading relation, so deleteProjects still reaps these rows.
model MetricAlertEvent {
  id                 String           @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  notificationRuleId String           @db.Uuid
  projectId          String
  project            Project          @relation(fields: [projectId], references: [id], onDelete: Cascade)

  seriesKey          String
  /// [IPrismaMetricAlertLabels]
  labels             Json

  fromState          MetricAlertState
  toState            MetricAlertState
  /// 'threshold' | 'missing' | 'keep_firing_expired' | 'renotify'
  /// | 'rule_disabled' | 'evaluation_gap'
  reason             String
  value              Float?
  threshold          Float
  at                 DateTime

  /// Outbox. Set when the notifications for this transition were ACCEPTED BY
  /// THE QUEUE. NOT a delivery receipt — see D12.
  enqueuedAt         DateTime?
  /// Sweep lease + attempt bound (D16). A row is claimed by stamping leasedAt,
  /// and is dead-lettered after ALERT_OUTBOX_MAX_ATTEMPTS.
  leasedAt           DateTime?
  deliveryAttempts   Int              @default(0)
  deadLetteredAt     DateTime?
  lastDeliveryError  String?

  /// True when the transition deliberately produced no notification.
  suppressed         Boolean          @default(false)
  /// 'not_fired' | 'notify_on_resolve_off' | 'burst_cap' | 'no_targets'
  /// | 'rule_disabled' | 'evaluation_gap'
  suppressedReason   String?

  createdAt          DateTime         @default(now())

  @@index([notificationRuleId, at])
  @@index([projectId, at])
  /// Outbox sweep. Ordinary two-column index rather than the draft's partial
  /// index: Prisma cannot express a WHERE clause, there is no partial-index
  /// precedent anywhere in packages/db/prisma/migrations, and an object present
  /// in the shadow DB but absent from schema.prisma is standing migrate drift.
  /// The sweep is LIMIT 500 and matches zero rows in steady state.
  @@index([enqueuedAt, at])
  @@map("metric_alert_events")
}
```

`NotificationRule` gains two back-relations (`metricAlertRuntime`, `metricAlertStates`) and
`Project` gains three. Both are relation-only edits with no column change.
`packages/db/src/types.ts` gains one line next to `IPrismaNotificationRuleConfig`:

```ts
type IPrismaMetricAlertLabels = Record<string, string>;
```

#### 4.2 Migration

`packages/db/prisma/migrations/20260901120000_metric_alerts/migration.sql`, following the
convention of `20260828120000_organization_wind_down` (a leading comment block explaining
*why*). This is a **Postgres** migration under `packages/db/prisma/migrations`, unrelated to
the ClickHouse code-migrations under `packages/db/code-migrations` (which need a unique
numeric prefix ≥ 22 and are the gigapipe TTL work in `10-ops-retention-billing.md`).

```sql
-- Metric alerting state. gigapipe's ruler evaluates recording rules only
-- (ruler/manager.go:212-216), so OpenPanel's worker owns alert evaluation and
-- therefore owns alert state.
--
-- Three tables, not columns on notification_rules, because:
--   * notification_rules."updatedAt" is @updatedAt and must keep meaning "when a
--     human last edited this rule" — a per-minute bump would destroy it;
--   * the dispatcher wants an index over ONLY metric rules, and config->>'type'
--     is a JSON predicate over every notification rule in the deployment;
--   * event and funnel rules would carry a dozen permanently-NULL columns.
--
-- metric_alert_events is append-only and doubles as the delivery outbox: a row
-- with "enqueuedAt" IS NULL is a transition whose notifications were not handed
-- to the queue, and the dispatcher re-sweeps it. It carries NO foreign key to
-- notification_rules on purpose, so deleting a rule keeps its incident history.

CREATE TYPE "MetricAlertState" AS ENUM ('inactive', 'pending', 'firing');

CREATE TABLE "metric_alert_rule_runtimes" ( … );
CREATE TABLE "metric_alert_series_states" ( … );
CREATE TABLE "metric_alert_events" ( … );

CREATE UNIQUE INDEX "metric_alert_rule_runtimes_notificationRuleId_key"
  ON "metric_alert_rule_runtimes"("notificationRuleId");
CREATE INDEX "metric_alert_rule_runtimes_nextEvaluationAt_idx"
  ON "metric_alert_rule_runtimes"("nextEvaluationAt");
CREATE INDEX "metric_alert_rule_runtimes_projectId_idx"
  ON "metric_alert_rule_runtimes"("projectId");

CREATE UNIQUE INDEX "metric_alert_series_states_notificationRuleId_seriesKey_key"
  ON "metric_alert_series_states"("notificationRuleId", "seriesKey");
CREATE INDEX "metric_alert_series_states_projectId_state_idx"
  ON "metric_alert_series_states"("projectId", "state");
CREATE INDEX "metric_alert_series_states_notificationRuleId_state_idx"
  ON "metric_alert_series_states"("notificationRuleId", "state");

CREATE INDEX "metric_alert_events_notificationRuleId_at_idx"
  ON "metric_alert_events"("notificationRuleId", "at");
CREATE INDEX "metric_alert_events_projectId_at_idx"
  ON "metric_alert_events"("projectId", "at");
CREATE INDEX "metric_alert_events_enqueuedAt_at_idx"
  ON "metric_alert_events"("enqueuedAt", "at");
```

No backfill: there are no metric rules yet. Additive and reversible by `DROP`.

#### 4.3 Row lifecycle

**Runtime rows are written by the mutation, not by a reconciler.** The draft called
`reconcileMetricAlertRuntimes()` on every 60 s tick, and its own migration comment gives the
reason not to: finding metric rules requires `config->>'type' = 'metric'`, the exact JSON
predicate over every notification rule in the deployment that the runtime table exists to
avoid — run forever, in every deployment, including ones with zero metric rules. It is also
the wrong mechanism: a rule created at 12:00:30 would wait up to a minute for a reconciler
to notice it, when the mutation that created it can write the row in the same transaction.

So `createOrUpdateRule` and `deleteRule` maintain it (§9.3), and an **hourly**
`runEvery`-guarded backstop next to the prune heals drift (a rule whose type changed outside
the mutation, a row orphaned by a failed deploy).

| Row | Created | Deleted |
|---|---|---|
| `MetricAlertRuleRuntime` | in the `createOrUpdateRule` transaction, `nextEvaluationAt = now + random(0, everySeconds)` (D6) | cascade on rule delete; hourly backstop when `config.type` is no longer `metric` |
| `MetricAlertSeriesState` | on first sight of a series | cascade on rule delete; hourly sweep of `state = 'inactive' AND "lastSeenAt" < now() - interval '7 days'`; **and** in the `createOrUpdateRule` transaction when `query.metric`, `query.groupBy` or `projectId` changed (§9.3) |
| `MetricAlertEvent` | on every transition | hourly prune of rows older than `ALERT_EVENT_RETENTION_DAYS` (default 90), batched 10 000; `projectId` cascade on project delete |

The 7-day state-row sweep runs **only** in the hourly block, never in the evaluation pass.
The draft specified it in both places; the evaluation pass only sees series in its own result
vector plus its own stored rows, and a `DELETE` per evaluation is wasted write volume.

`runEvery` (`packages/redis/run-every.ts:3-20`) `return fn()`s, so the work lands in the
caller's `await`, and its key has no lock semantics beyond `SET … EX`, so two replicas racing
the same second can both run it. Both are fine inside the dispatcher job — its own queue, and
a duplicated `deleteMany` is idempotent. Neither would be fine inside `cronJob`, which is why
the prune is not there.

### 5. The state machine

#### 5.1 The series key

```ts
const TENANCY = TELEMETRY_PROJECT_LABEL;  // 'op_project_id'

/**
 * Canonical, order-independent identity for a series.
 *
 * Sorting is mandatory, not tidiness: gigapipe's writeVector iterates
 * `s.Metric.Map()` (reader/controller/prom_query_range.go:329), a Go map, whose
 * iteration order is randomised per call. An unsorted key changes between two
 * evaluations of the same unchanged series, which reads as "the old series
 * vanished and a new one appeared" — a resolve notification and a fresh `for`
 * timer, every minute, forever.
 *
 * op_project_id is excluded because it is constant within a rule and must never
 * reach a notification body or a deep link.
 */
export function seriesKeyOf(metric: Record<string, string>): {
  key: string;
  labels: Record<string, string>;
} {
  const entries = Object.entries(metric)
    .filter(([k]) => k !== TENANCY)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const labels = Object.fromEntries(entries);
  const key = createHash('sha1').update(JSON.stringify(entries)).digest('hex');
  return { key, labels };
}
```

An aggregated query with an empty `groupBy` yields one series whose stripped label set is
`{}` — `seriesKeyOf({})` is the sha1 of `"[]"`, a stable constant. That is correct: a
fully-aggregated rule has exactly one alert instance. (Note this is the case
`packages/common/src/group-by-labels.ts:62` **drops** on the chart path. Alerting must not
copy that behaviour; a test pins it.)

#### 5.2 One pure function, two callers

The draft specified the state machine twice — once as an imperative pass over Prisma rows
(the evaluator) and once as "replay the state machine over the returned matrix" in the
preview. That is two implementations with different data sources and no shared contract,
and drift there means the preview lies about what the rule will do, which the preview's own
honesty section argues is worse than having no preview.

So the core is one pure, side-effect-free function in
`packages/db/src/services/metric-alert.machine.ts`:

```ts
export type SeriesSnapshot = {
  state: MetricAlertState;
  value: number | null;
  pendingSince: Date | null;
  firingSince: Date | null;
  clearedSince: Date | null;
  lastSeenAt: Date;
  lastNotifiedAt: Date | null;
};

export type Transition = {
  fromState: MetricAlertState;
  toState: MetricAlertState;
  reason: 'threshold' | 'missing' | 'keep_firing_expired' | 'renotify';
  value: number | null;
  at: Date;
  /** false when the transition is logged but must not notify. */
  notify: boolean;
  suppressedReason?: string;
};

/**
 * Advance ONE series by ONE evaluation. No I/O, no clock — `at` is injected,
 * per 11-testing-strategy.md:139 ("Inject now: Date into the alert evaluator").
 *
 * `sample` is null when the series was absent from the response OR when its
 * value was non-finite (§7.2): the two are indistinguishable to the machine and
 * must be, because a rate() over a counter that just reset legitimately yields
 * NaN for one evaluation and that is not a recovery.
 */
export function stepSeries(
  prev: SeriesSnapshot | null,
  sample: number | null,
  at: Date,
  config: INotificationRuleMetricConfig,
): { next: SeriesSnapshot; transition: Transition | null; deleteRow?: boolean };
```

The evaluator supplies stored rows and persists the result; the preview supplies a matrix
column and renders it. Tests A1–A8 target `stepSeries` directly, so both callers are covered
by construction.

#### 5.3 The rules

```
                       breaching                      breaching && for elapsed
        ┌──────────┐  ─────────────▶  ┌─────────┐  ─────────────────────────▶  ┌────────┐
        │ inactive │                  │ pending │                              │ firing │
        └──────────┘  ◀─────────────  └─────────┘                              └────────┘
             ▲          !breaching                                                  │
             └──────────────────────────────────────────────────────────────────────┘
                 !breaching  &&  now − clearedSince ≥ keepFiringForSeconds
```

**Three stored states, not four.** `resolved` is a *transition*, not a state. Storing a
fourth `resolved` state would need its own exit rule ("when does a resolved series become
inactive?") carrying no information — a series that recovered and one that was never bad are
indistinguishable on the next evaluation, and treating them differently is how you get a
second resolve notification the following minute. "Firing for 34 m" comes from `firingSince`
on the event row, not from a resting state.

Per series, given `sample` (possibly null), `at`, and the stored snapshot (default
`inactive`):

```
present := sample !== null
breach  := present && compare(sample, config.comparator, config.threshold)

if !present:
    lastSeenAt is NOT updated
    if at − lastSeenAt < missingGraceSeconds:  hold state, no transition
    else if config.missingSeries === 'keep':   hold state, no transition, forever
    else /* 'resolve' */:
        firing  -> inactive   reason='missing'  notify = notifyOnResolve
        pending -> inactive   reason='missing'  notify = false (it never fired)
        inactive-> no transition; the hourly sweep deletes it after 7 d

else if breach:
    lastSeenAt = at; value = sample; clearedSince = null
    inactive -> pending   pendingSince = at
                          if forSeconds === 0, fall through to firing in the SAME pass
    pending  -> pending   until at − pendingSince ≥ forSeconds, then
                -> firing  firingSince = at, reason='threshold', notify = true
    firing   -> firing    if renotifySeconds && at − lastNotifiedAt ≥ renotifySeconds:
                          transition reason='renotify', notify = true (state unchanged)

else /* present and not breaching */:
    lastSeenAt = at; value = sample
    inactive -> inactive  (snapshot refreshed; this is what the rule card shows)
    pending  -> inactive   pendingSince = null; notify = false, suppressedReason='not_fired'
    firing   -> firing     clearedSince ??= at
                if at − clearedSince ≥ keepFiringForSeconds:
                -> inactive  reason = keepFiringForSeconds > 0 ? 'keep_firing_expired' : 'threshold'
                             notify = notifyOnResolve
```

`compare` is exhaustive over the four comparators, with a `never`-checked default so adding
a fifth is a compile error.

Three consequences worth stating plainly:

- **`for` is a continuity requirement, not a total.** A single non-breaching evaluation sends
  the series back to `inactive` and clears `pendingSince`. That is Prometheus' semantics and
  the reason "the series flapped inside the `for` window" is a first-class explanation in the
  debugging ladder.
- **A `pending → inactive` transition is logged but never notified**, with
  `suppressed = true, suppressedReason = 'not_fired'`, precisely so the history can show
  "this nearly fired six times today" — the single most useful signal for tuning `forSeconds`.
- **`missingGraceSeconds` is measured from `lastSeenAt`**, not from the transition. A series
  absent for three evaluations does not reset its own clock. And per D14, a stale evaluation
  gap resets `lastSeenAt` to the resumption instant so our own outage cannot manufacture a
  missing-series burst.

**First evaluation of an already-breaching series.** `forSeconds` is anchored on
`pendingSince`, so a rule created against an already-broken service fires `forSeconds` after
creation, not immediately. That is correct — we have no evidence it was breaching before we
looked — but users read it as the alert being broken, so the rule editor says so next to the
`forSeconds` field and the rule card shows "pending — will fire at HH:MM if still breaching".

#### 5.4 Write reduction

Per D5, a present, non-transitioning series writes only when at least one holds:

```ts
const valueMoved =
  prev.value === null ||
  sample === null ||
  Math.abs(sample - prev.value) > Math.abs(prev.value) * 0.005;
const seenStale = at.getTime() - prev.lastSeenAt.getTime() > config.everySeconds * 5000;
const mustWrite = transition !== null || valueMoved || seenStale;
```

`seenStale` is what keeps `missingGraceSeconds` honest for a perfectly flat series: without
it, a series whose value never moves would never refresh `lastSeenAt` and would eventually be
judged missing while sitting right there in the response.

### 6. Scheduling and the worker

#### 6.1 The cron entry and the queue

`packages/queue/src/queues.ts`, after `CronQueuePayloadWindDown` (`:184-187`):

```ts
export type CronQueuePayloadMetricAlerts = { type: 'metricAlerts'; payload: undefined };

export type AlertsQueuePayload =
  | { type: 'dispatchMetricAlerts'; payload: undefined }
  | { type: 'evaluateMetricRule'; payload: { ruleId: string; dueAt: number } };

export const alertsQueue = guardQueue(
  new Queue<AlertsQueuePayload>(getQueueName('alerts'), {
    connection: getRedisQueue(),
    defaultJobOptions: {
      // One attempt. A failed evaluation is not retried inside its period: the
      // rule is level-triggered and the next period IS the retry (§6.3). A
      // BullMQ retry would re-run against a claim it can no longer win and burn
      // a gigapipe request for nothing.
      attempts: 1,
      // `age` alone only trims when another job finishes, so pair it with a
      // count bound — same reasoning as cohortComputeQueue (queues.ts:355-359).
      removeOnComplete: { age: 3600, count: 500 },
      removeOnFail: { age: 86_400, count: 500 },
    },
  }),
  'alerts',
);
```

`CronQueuePayloadMetricAlerts` joins the `CronQueuePayload` union (`:188-207`).
`apps/worker/src/boot-cron.ts`, in the `jobs` array after `windDown` (`:121-125`):

```ts
{ name: 'metricAlerts', type: 'metricAlerts', pattern: 1000 * 60 },
```

`boot-cron.ts:138-155` **removes every job scheduler whose key is not in that in-code list**,
so a partial landing silently unschedules the job with no error. The registration triple —
the union member, the `cron.ts` switch case, and this array entry — is pinned by a test
(`11-testing-strategy.md:1075-1082`).

`apps/worker/src/jobs/cron.metric-alerts.ts` (**NEW**) is deliberately three lines:

```ts
import { alertsQueue } from '@openpanel/queue';

/**
 * Hand off immediately. The cron worker runs at concurrency 1 by default
 * (boot-workers.ts:218-227) and is the same worker that flushes events to
 * ClickHouse every 10 s (boot-cron.ts:46-75). Nothing that touches the network
 * or scans a table may run here.
 */
export async function metricAlertsCronJob() {
  await alertsQueue.add(
    'dispatchMetricAlerts',
    { type: 'dispatchMetricAlerts', payload: undefined },
    { deduplication: { id: 'metric-alerts-dispatch' } },
  );
}
```

The `deduplication` id follows `enqueueCohortCompute`
(`packages/db/src/services/cohort.service.ts:705-724`, and note its comment on why a fixed
`jobId` deadlocks against `removeOnComplete: { age }`). It is belt-and-braces: the Postgres
claim in §6.3 already makes a double dispatch a no-op.

**UNVERIFIED:** whether BullMQ 5.63 honours a per-job `opts.deduplication` passed through
`addBulk`. `enqueueCohortCompute` — the only precedent in the repo — uses `queue.add`, not
`addBulk`. Settled by one integration test against the pinned bullmq. The fallback needs no
code change: the claim already makes a duplicate dispatch a no-op.

`apps/worker/src/boot-workers.ts`: add `'alerts'` to the default queue list (`:56-75`) and a
worker block after `cohortCompute` (`:272-285`), with `getConcurrencyFor('alerts', 5)`
reading `ALERTS_CONCURRENCY` (`:94-106`).

Three ops surfaces the draft missed and that must land in the same PR:
`apps/worker/src/index.ts:55-62` builds bull-board from an explicit array (add
`new BullMQAdapter(alertsQueue)`); `apps/worker/src/metrics.ts:18` builds the
active/delayed/failed/completed/waiting gauges from
`const queues = [sessionsQueue, cronQueue, ...eventsGroupQueues]` (add `alertsQueue`, which
also gives the backlog story its queue-depth half for free); and
`environment-variables.mdx:619-633` enumerates the available `ENABLED_QUEUES` names.

#### 6.2 `dispatchMetricAlerts`

```ts
const DISPATCH_BATCH = Number.parseInt(process.env.ALERTS_DISPATCH_BATCH || '2000', 10);
const BLOCKED_WIND_DOWN_STEPS = ['blocked', 'final_warning'];

export async function dispatchMetricAlerts() {
  const now = new Date();

  // 1. Outbox sweep and retention run FIRST, and ABOVE the gigapipe gate.
  //    The draft returned early on !isGigapipeEnabled() before both. Unsetting
  //    GIGAPIPE_URL — a rollback, a misapplied config, or an operator disabling
  //    gigapipe during the very incident that stranded the rows — would then
  //    permanently strand every un-enqueued transition and silently stop
  //    metric_alert_events retention. Only rule SELECTION and dispatch belong
  //    below the gate.
  await flushMetricAlertOutbox({ olderThan: subSeconds(now, 30), limit: 500 });

  await runEvery({
    interval: 3600,
    key: 'metric-alert-housekeeping',
    fn: () => metricAlertHousekeeping(now),   // prune, 7-day state sweep, runtime backstop
  });

  if (!isGigapipeEnabled()) {
    return { skipped: 'gigapipe-disabled', swept: true };
  }

  // 2. Selection. Claim-free: the evaluation job re-checks dueness atomically
  //    (§6.3), so an overlapping dispatch enqueues jobs that no-op.
  //
  //    The organization join is not optional. cron.wind-down.ts sets
  //    windDownStep to 'blocked' on day 21 and apps/api/src/hooks/
  //    subscription.hook.ts:26,48-65 then rejects that org's ingestion. Every
  //    series in every one of that org's projects goes absent — and with the
  //    missingSeries:'resolve' default plus notifyOnResolve:true, we would
  //    email and Slack a burst of "the series stopped reporting and was
  //    resolved automatically" to a customer whose data WE just cut off. We
  //    would also keep issuing one gigapipe query per rule per minute for the
  //    remaining ~30 days until deleteAt fires.
  const orgFilter =
    process.env.SELF_HOSTED === 'true'
      ? {}
      : {
          project: {
            organization: {
              OR: [
                { windDownStep: null },
                { windDownStep: { notIn: BLOCKED_WIND_DOWN_STEPS } },
              ],
            },
          },
        };

  const due = await db.metricAlertRuleRuntime.findMany({
    where: {
      enabled: true,
      OR: [{ mutedUntil: null }, { mutedUntil: { lt: now } }],
      nextEvaluationAt: { lte: now },
      ...orgFilter,
    },
    orderBy: { nextEvaluationAt: 'asc' },   // most overdue first
    take: DISPATCH_BATCH,
    select: { notificationRuleId: true, nextEvaluationAt: true },
  });

  await alertsQueue.addBulk(
    due.map((r) => ({
      name: 'evaluateMetricRule',
      data: {
        type: 'evaluateMetricRule' as const,
        payload: { ruleId: r.notificationRuleId, dueAt: r.nextEvaluationAt.getTime() },
      },
      opts: {
        deduplication: {
          id: `alert:${r.notificationRuleId}:${r.nextEvaluationAt.getTime()}`,
        },
      },
    })),
  );

  // 3. Park blocked rules so they neither evaluate nor spin, and so their badge
  //    says the true thing (§10.1) rather than "gigapipe unreachable".
  await parkBlockedMetricAlertRules(now);

  metricAlertDispatchBacklog.set(
    Math.max(0, (await db.metricAlertRuleRuntime.count({
      where: { enabled: true, nextEvaluationAt: { lte: now }, ...orgFilter },
    })) - due.length),
  );

  return { dispatched: due.length };
}
```

`parkBlockedMetricAlertRules` is one `updateMany` over runtime rows whose org is in
`BLOCKED_WIND_DOWN_STEPS`, setting `lastErrorCode = 'org_blocked'`, a human `lastError`
("Alerting is paused because this organization's trial expired.") and
`nextEvaluationAt = now + 1 h`. It writes no transitions and sends no notifications.

**On recovery**, `windDownCronJob` clears `windDownStartedAt/windDownStep/deleteAt`
(`cron.wind-down.ts:294-299`). The same batch there re-arms alerting for those orgs' rules:
`nextEvaluationAt = now`, `lastErrorCode = null`, `consecutiveFailures = 0`, and
`pendingSince = null, clearedSince = null` on their series rows. (The D14 gap rule would do
that anyway on the first evaluation; doing it here makes the badge correct immediately.)
Both `windDownCronJob` and `subscriptionHook` return early when `SELF_HOSTED === 'true'`, so
this whole branch is a no-op for self-hosted deployments.

**Clock source.** Every dueness comparison and every state timestamp uses the **app process
clock** (`new Date()`), not Postgres `now()`. That is stated because `createdAt`/`updatedAt`
use `now()` and the two can differ: with `replicas: $OP_WORKER_REPLICAS`
(`self-hosting/docker-compose.template.yml:155-157`) and skewed container clocks, a fast
replica claims early and a slow one records periods it did not really miss. One clock,
consistently, keeps `skippedPeriods` meaningful; container clock skew is an operator concern,
not something this design can paper over.

#### 6.3 `evaluateMetricRule` — the claim

```ts
export async function evaluateMetricRule({ ruleId, dueAt }: { ruleId: string; dueAt: number }) {
  const rule = await db.notificationRule.findUnique({
    where: { id: ruleId },
    include: { integrations: { select: { id: true } }, metricAlertRuntime: true },
  });
  if (!rule || rule.config.type !== 'metric') return { skipped: 'not-a-metric-rule' };

  const config = rule.config;          // narrowed by the discriminated union
  const due = new Date(dueAt);
  const now = new Date();              // D13: the ONLY timestamp that reaches state
  const next = computeNextEvaluationAt(due, config.everySeconds, now);

  // THE CLAIM. One statement, one row, atomic. Postgres serialises concurrent
  // updates of the same row, so exactly one caller sees count === 1 for a given
  // dueAt — across BullMQ redelivery, a duplicated dispatch, and worker replicas.
  const claim = await db.metricAlertRuleRuntime.updateMany({
    where: {
      notificationRuleId: ruleId,
      OR: [{ lastEvaluationAt: null }, { lastEvaluationAt: { lt: due } }],
    },
    data: {
      lastEvaluationAt: due,
      nextEvaluationAt: next.at,
      skippedPeriods: { increment: next.skipped },
    },
  });
  if (claim.count === 0) return { skipped: 'already-evaluated' };

  // `due` has now done its only job. Everything downstream uses `now`.
  return runMetricAlertEvaluation({ rule, config, at: now });
}
```

```ts
/**
 * Preserve phase normally; self-heal after a gap.
 *
 * INVARIANT: `skipped` counts every scheduled instant strictly after the one
 * being evaluated that is already in the past at `now`. With due=12:00,
 * every=60, now=12:43 those are 12:01…12:43 — 43 of them. (The draft's version
 * computed 42 while its own badge copy and its own test A10 asserted 43.)
 *
 * One period of lateness is normal — the dispatcher runs on a 60 s tick and the
 * queue adds latency — so the phase-preserving branch is deliberately generous.
 * Beyond that, jumping by `every` repeatedly would re-dispatch the rule once per
 * missed period as fast as the queue drains: an evaluation storm against
 * gigapipe on every worker restart. Clamp instead, and record the loss.
 */
export function computeNextEvaluationAt(due: Date, everySeconds: number, now: Date) {
  const everyMs = everySeconds * 1000;
  const naive = new Date(due.getTime() + everyMs);
  if (naive.getTime() > now.getTime() - everyMs) {
    return { at: naive, skipped: 0 };
  }
  return {
    at: new Date(now.getTime() + everyMs),
    skipped: Math.floor((now.getTime() - due.getTime()) / everyMs),
  };
}
```

**The claim is taken before the query runs**, so a rule whose gigapipe call fails burns its
period and retries at the next one. That is deliberate: a level-triggered evaluator has
nothing to gain from an in-period retry (the next evaluation sees the same world), and an
in-period retry against a gigapipe that is down turns one failure into `attempts` failures
per rule per period. For a rule with `forSeconds >= 2 x everySeconds` the cost is nothing.

**Idempotency summary.**

| Duplication source | Defence |
|---|---|
| BullMQ redelivers after a worker crash | the claim: `lastEvaluationAt >= due`, `count === 0` |
| Two dispatchers enqueue the same rule | BullMQ `deduplication.id`, then the claim |
| Two worker replicas pick up two copies | the claim (one Postgres row, one winner) |
| Death **after** the state write, **before** `queue.add` | the outbox: `enqueuedAt IS NULL` is re-swept |
| Death **after** `queue.add`, **before** stamping `enqueuedAt` | duplicate notification. Accepted: at-least-once |

#### 6.4 Sharding and scale

The unit of parallelism is **one rule**. Alerts have no ordering requirement between rules,
so the GroupMQ machinery the event pipeline uses buys nothing here.

| Pressure | Knob |
|---|---|
| More rules than one worker can evaluate in a period | `ALERTS_CONCURRENCY`, then more replicas (the claim makes replicas safe) |
| One project's rules starving another's | the alerts lease bucket (D15), `GIGAPIPE_ALERT_CONCURRENCY_PER_PROJECT` default 2 |
| One project creating unbounded rules | `ALERT_MAX_RULES_PER_PROJECT` (default 50) at create time |
| gigapipe saturated | the transport's circuit breaker (`04-read-path.md:820-836`, ships P3); until then `GIGAPIPE_TIMEOUT_MS` and bounded concurrency |
| Dispatch falling behind | `ALERTS_DISPATCH_BATCH` plus the `metric_alert_dispatch_backlog` gauge |

At `ALERTS_CONCURRENCY=5` and a 200 ms mean evaluation, one replica sustains ~1 500
rules/minute. Beyond that, add replicas.

### 7. The evaluation

`packages/db/src/services/metric-alert.service.ts` (**NEW**).

#### 7.1 The query

```ts
const compiled = compileAlertQuery(config.query, { projectId: rule.projectId });

const res = await withProjectLease(
  rule.projectId,
  () => prometheus.queryInstant({
    query: compiled.promql,
    time: Math.floor(at.getTime() / 1000),   // D13: wall-clock now, never dueAt
    projectId: rule.projectId,
  }),
  { bucket: 'alerts', max: cfg.alertConcurrencyPerProject },   // D15
);

verifyResponseLabels(res.data.result, rule.projectId);
```

`verifyResponseLabels` throws `TenancyError` if any series' `op_project_id` is not exactly this
project's id. **Its home needs settling (R1.5):** `01-tenancy-and-security.md` specifies the
*behaviour* in prose, under § Detection (a) "Response-side verification", but does **not** list
the symbol in its "Exposed by this work-stream" table. Three specs import it as a hard
dependency with three different citations — this one, `03-metrics-engine.md` §9.0 (which pins
the `): void` return type and the statement-not-expression call form) and `04-read-path.md` §4.4
(which pins the argument shape to `Array<{ metric: Record<string, string> }>` and states there
is **no stub**, so `src/read/*.ts` does not compile without it). The three descriptions agree;
only the ownership record is missing. *Interfaces* files the ask. The evaluator does **not** catch it
into a per-series drop: it aborts the whole evaluation, records `lastErrorCode: 'scope'`,
transitions nothing, and lets the error propagate so the transport's counter and the page
fire. Dropping the offending series instead would turn a compiler regression into "no alert
ever fires again" with no signal.

**Absence of the label is also a violation, not a drop** — but the invariant is narrower than
the draft claimed. The draft wrote "`compileAggregation` always writes `op_project_id` into
`by (...)`". It does not: when `aggregation` is absent the wrapper is a **no-op** and returns
`inner` unchanged (`03-metrics-engine.md` §4.2, "When `A` is absent, step 3 is a no-op"), and
`aggregation` is `.optional()` in the canonical schema (`03-metrics-engine.md` §2 — it is
*required* only when `groupBy` is non-empty, enforced by `refineMetricQuery`). The correct
statement, which holds in both cases:

> Either the selector carries `op_project_id` directly (no aggregation, so the raw series
> label set is returned) or `compileAggregation` carries it through `by (...)`. The compiler
> never emits `without`. Therefore every sample in every response carries the label, and
> `undefined !== 'proj_abc'` throwing is correct behaviour, not an accident.

If the metrics engine ever adds a path that aggregates without carrying the label, this check
starts rejecting 100 % of samples from grouped rules and every metric alert silently stops
firing — so test A39 asserts it on the **compiler's output string** for both the aggregated and
the un-aggregated case, not on a comment. (The previous revision called this "test A19" here
and "A19" again in *Interfaces*; A19 is the outage/resolve-suppression case. The
compiled-output assertion is **A39**, and both references are corrected.)

Two gigapipe details that are easy to get wrong on this exact call:

- `parseQueryInstantProps` decodes a POST body **only** when
  `r.Header.Get("Content-Type") == "application/x-www-form-urlencoded"` — an exact string
  equality, not a prefix match (`reader/controller/prom_query_instant.go:67`). A charset
  parameter makes the body invisible; the handler falls back to URL query params, finds
  none, and returns `400 query is undefined` (`:88-91`). The transport must send the bare
  content type.
- The instant path does **not** floor `time` to a 15 s boundary. `query_range` does
  (`prom_query_range.go:55-56`); `QueryInstant` passes `ParseTimeSecOrRFC` straight through
  (`prom_query_instant.go:85`).

#### 7.2 Reading a sample value

```ts
/**
 * gigapipe encodes sample values with strconv.FormatFloat(v,'f',-1,64)
 * (reader/controller/prom_query_range.go:344), so non-finite values arrive as
 * the JSON strings "NaN", "+Inf", "-Inf". Number() maps all three to NaN, and
 * every comparison against NaN is false — so a naive parse turns "this metric
 * went to infinity" into "everything is fine", silently.
 */
function parseSample(raw: string): number | null {
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
```

A `null` sample is **not** a breach and **not** a recovery; `stepSeries` treats it exactly
like a missing series. The count of such series is written to
`MetricAlertRuleRuntime.nonFiniteSeries` so the badge can say "3 of 8 series returned a
non-finite value"; health is unaffected, because a `rate()` over a counter that just reset
legitimately produces `NaN` for one evaluation and that must not fail the rule.

`writeVector` also writes only `s.F` (`prom_query_range.go:344`) — there is no
native-histogram branch, so a rule over a native histogram would return `0`, not an error.
`zMetricQuery` has no native-histogram function, so this is unreachable today; it is noted so
nobody adds one casually.

#### 7.3 Label hygiene

Label values are unvalidated OTLP attribute strings that end up in a Postgres `text` column,
in a notification title, and in a third-party webhook body.

```ts
// C0 controls and DEL, including U+0000.
const CONTROL = /[\u0000-\u001f\u007f]/g;

/**
 * createNotification strips NUL from `payload` ONLY —
 * `payload: stripNullChars(notification.payload) || undefined`
 * (notification.service.ts:139-147) — while `title` and `message` pass through
 * raw. A label value containing U+0000 therefore makes db.notification.create
 * throw for the sendToApp target (Postgres text cannot store NUL), which strands
 * the outbox row and, before D16's attempt bound, stalled the sweep forever
 * while re-notifying every row ahead of it on every tick.
 */
export function sanitizeLabelText(value: string, max = 200): string {
  const clean = value.replace(CONTROL, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
```

Applied to every label value at the moment the response is parsed, so the sanitised form is
what reaches `seriesKeyOf`, the stored `labels` JSON, the payload, the title and the message.
The rendered `title` is bounded at 200 characters and `message` at 1 000, after templating.

**PII posture.** These label values are persisted to Postgres for
`ALERT_EVENT_RETENTION_DAYS` (default 90) and POSTed to user-configured webhooks. They are
customer-authored telemetry attributes and can contain anything the customer put in them.
That is the same posture as event properties, but it is worth stating because neither the
ingest gateway nor this work-stream scrubs attribute values.

#### 7.4 The pass, and the transaction boundary

```ts
export async function runMetricAlertEvaluation({ rule, config, at }) {
  const started = performance.now();
  const compiled = compileAlertQuery(config.query, { projectId: rule.projectId });
  const runtime = rule.metricAlertRuntime!;

  let res;
  try {
    res = await queryWithLease(compiled, rule, at);       // §7.1
    verifyResponseLabels(res.data.result, rule.projectId);
  } catch (err) {
    await recordEvaluationFailure(rule.id, err);          // §10.2 — touches NO state row
    metricAlertEvaluations.inc({ result: classifyAlertError(err) });
    throw err;                                            // let the transport's counters see it
  }

  if (res.data.result.length > config.maxSeries) {
    await markRuleUnhealthy(rule.id, { code: 'too_many_series', message: '…' });   // D9
    return { skipped: 'too_many_series' };
  }

  // D14: invalidate timers across an evaluation gap, BEFORE comparing anything.
  const gapMs = ALERT_GAP_FACTOR * config.everySeconds * 1000;
  if (runtime.lastSuccessAt && at.getTime() - runtime.lastSuccessAt.getTime() > gapMs) {
    // clears pendingSince/clearedSince, sets lastSeenAt = at, HOLDS state,
    // writes one suppressed reason='evaluation_gap' event row for the rule.
    await invalidateTimersAfterGap(rule.id, at);
  }

  const stored = await db.metricAlertSeriesState.findMany({
    where: { notificationRuleId: rule.id },
  });
  const samples = parseVector(res, config);      // seriesKey -> { sample, labels }, sanitised
  const keys = [
    ...new Set([...samples.keys(), ...stored.map((s) => s.seriesKey)]),
  ].sort();

  const results = keys.map((key) =>
    stepSeries(snapshotOf(stored, key), samples.get(key)?.sample ?? null, at, config),
  );

  // 1. Persist state + event rows in ONE transaction, per rule.
  const events = await db.$transaction(async (tx) => {
    /* upsert each changed MetricAlertSeriesState (§5.4), createMany the transitions */
  });

  // 2. Deliver, serialised and capped (D10). Stamps enqueuedAt + lastNotifiedAt.
  await deliverTransitions({ rule, config, events, at });

  // 3. Mark the rule healthy.
  await db.metricAlertRuleRuntime.update({
    where: { notificationRuleId: rule.id },
    data: {
      lastSuccessAt: at,
      consecutiveFailures: 0,
      lastError: null,
      lastErrorCode: null,
      skippedPeriods: 0,
      nonFiniteSeries: countNonFinite(res),
    },
  });
  metricAlertEvaluationDuration.observe(performance.now() - started);
}
```

`lastNotifiedAt` is written in **step 2**, in the same statement that stamps `enqueuedAt` on
the event row, and only for transitions that actually notified. A re-sent outbox row does
**not** bump it: `lastNotifiedAt` gates `renotifySeconds`, and a redelivery is not a new
notification decision.

### 8. Delivery

#### 8.1 The hand-off

One `createNotification` call per delivery target, mirroring
`checkNotificationRulesForEvent` (`notification.service.ts:341-367`) exactly — including
that `sendToApp` and `sendToEmail` are separate calls with the two pseudo-integration ids,
because `notificationJob` returns after the first matching branch
(`apps/worker/src/jobs/notification.ts:29-65`) so a single notification can only ever reach
one channel.

```ts
const MAX_NOTIFY_PER_EVAL = Number.parseInt(
  process.env.ALERT_MAX_NOTIFICATIONS_PER_EVAL || '10', 10,
);

async function deliverTransitions({ rule, config, events, at }) {
  const targets = [
    ...rule.integrations.map((i) => i.id),
    ...(rule.sendToApp ? [APP_NOTIFICATION_INTEGRATION_ID] : []),
    ...(rule.sendToEmail ? [EMAIL_NOTIFICATION_INTEGRATION_ID] : []),
  ];

  // A rule can end up with nowhere to send: Integration is org-scoped and can
  // be deleted independently of the rules referencing it (many-to-many via
  // NotificationRule.integrations), and sendToApp/sendToEmail can both be
  // false. Without this branch the rule keeps evaluating, keeps transitioning,
  // and stamps enqueuedAt as though it had delivered — reading as armed and
  // healthy in the UI forever. Mark it instead (§10.1) and suppress honestly.
  if (targets.length === 0) {
    await markRuleUnhealthy(rule.id, { code: 'no_targets', message: '…' });
    await suppressAll(events, 'no_targets');
    return;
  }

  const notifiable = events.filter((e) => e.notify);
  const cap = Math.min(config.maxSeries, MAX_NOTIFY_PER_EVAL);
  const send = notifiable.slice(0, cap);
  const overflow = notifiable.slice(cap);

  // SERIALISED, in seriesKey order (D10). The delivery path has no rate limiter
  // and issues one webhook POST per notification with no batching; 20 series x
  // 3 targets in one Promise.all is 60 POSTs in a second against an incoming
  // webhook that rate-limits at roughly one per second — and per D12 those 429s
  // are invisible.
  for (const event of send) {
    const { title, message } = renderMetricNotification({ rule, config, event });
    const payload = buildMetricPayload({ rule, config, event, at });   // never null
    for (const integrationId of targets) {
      await createNotification({
        title, message, payload,
        projectId: rule.projectId,
        notificationRuleId: rule.id,
        integrationId,
      });
    }
    await stampEnqueued(event.id, event.seriesKey, at);   // enqueuedAt + lastNotifiedAt
  }

  if (overflow.length > 0) {
    await sendBurstRollup({ rule, targets, count: overflow.length, at });
    await suppressAll(overflow, 'burst_cap');
  }
}
```

Nothing downstream changes. `createNotification` writes a `notifications` row only for the
app target (`notification.service.ts:150-154`) and enqueues in every case (`:156`);
`notificationJob` fans email out to org members (`notification.ts:34-65`, with the
per-recipient `product_alerts` unsubscribe handled inside `sendEmail`) and posts to
webhook/Discord/Slack (`:83-139`).

#### 8.2 The outbox

Per evaluation, in order:

1. Write the `MetricAlertEvent` rows with `enqueuedAt: null` **and** update the
   `MetricAlertSeriesState` rows, in one `db.$transaction`.
2. `deliverTransitions` (§8.1).
3. Per delivered transition, `UPDATE metric_alert_events SET "enqueuedAt" = …` and
   `MetricAlertSeriesState.lastNotifiedAt = at`.

If the process dies between 1 and 2, or between 2 and 3, the row is left with
`enqueuedAt IS NULL` and the next dispatch's sweep picks it up. The sweep claims rows before
sending, bounds attempts, and dead-letters — the three things the draft's version lacked
(D16):

```sql
-- flushMetricAlertOutbox, step 1: claim.
UPDATE metric_alert_events e
SET "leasedAt" = now(), "deliveryAttempts" = e."deliveryAttempts" + 1
WHERE e.id IN (
  SELECT id FROM metric_alert_events
  WHERE "enqueuedAt"      IS NULL
    AND "deadLetteredAt"  IS NULL
    AND suppressed        =  false
    AND "at"              <= $1                        -- now - 30 s
    AND ("leasedAt" IS NULL OR "leasedAt" < now() - interval '5 minutes')
    AND "deliveryAttempts" < $2                        -- ALERT_OUTBOX_MAX_ATTEMPTS, default 5
  ORDER BY "at" ASC
  LIMIT $3                                             -- 500
  FOR UPDATE SKIP LOCKED
)
RETURNING e.*;

-- flushMetricAlertOutbox, step 3: dead-letter whatever exhausted its attempts.
UPDATE metric_alert_events
SET "deadLetteredAt" = now()
WHERE "enqueuedAt" IS NULL AND "deadLetteredAt" IS NULL
  AND suppressed = false AND "deliveryAttempts" >= $2;
```

`FOR UPDATE SKIP LOCKED` plus the `leasedAt` window is what makes the sweep safe with
multiple worker replicas; the attempt bound plus `deadLetteredAt` is what stops one poison
row (§7.3) from stalling the queue forever while re-notifying every row ahead of it on every
tick. Dead-lettered rows are surfaced in `alertHistory` and counted by
`metric_alert_outbox_dead_lettered_total`.

The `olderThan: now - 30 s` bound keeps the sweep from racing an evaluation still in step 2.
A row whose rule has since been deleted is marked `suppressed = true`,
`suppressedReason = 'rule_disabled'` rather than retried — the rule is gone, there is nothing
to notify about, and the event row survives as history because it has no FK to the rule (D5).

**Known duplicate window.** A death between 2 and 3 re-sends. This is at-least-once and is
the correct trade against the alternative (stamp first, then send), which loses notifications
instead. Users see a duplicate Slack message after a worker crash; they do not see silence.

#### 8.3 What the channels actually show

Checked, and the honest answer is "less than you would hope":

| Channel | What arrives | Source |
|---|---|---|
| In-app toast | `title` + `message` | `notification.ts:29-33` → `notification-provider.tsx:18-23` |
| Notification list | `title`, `message`, integration name, rule name, `createdAt`; the country/OS/browser/profile columns render empty | `columns.tsx:22-180` |
| Email | `title`, `message`, `projectName`, `dashboardUrl` (project root) | `notification.ts:34-65`, `notification-rule.tsx:17-44` |
| Webhook, default mode | `{ title, message }` only | `notification.ts:101-106` |
| Webhook, javascript mode | the **whole payload object**, raw — the JS template is applied only when `payload.type === 'event'` | `notification.ts:87-100` |
| Discord | `"🔔 **" + title + "**\n" + message` | `notification.ts:119-128` |
| Slack | `"🔔 *" + title + "*\n" + message` | `notification.ts:130-138` |

So the metric payload's structured fields reach exactly one destination today: a
javascript-mode webhook. Everything else is title + message, which is why §8.4 puts the
value, the threshold and the series into `message` rather than relying on the payload.

Three follow-ups, none a P5 blocker, all cheap, all changes to **shared** delivery code:

1. `dashboardUrl` in the email should be `payload.url` (the rule, series pre-selected) rather
   than the project root — two lines at `notification.ts:60`, guarded on
   `payload?.type === 'metric'`.
2. The javascript-mode guard should become `payload.type === 'event' || payload.type === 'metric'`
   (`notification.ts:90-91`). `execute` takes an arbitrary object, so nothing else changes.
3. Discord and Slack could carry the labels as a code block.

#### 8.4 The notification body

Defaults, when the rule has no template:

```
firing,   reason='threshold':
  title:   "API 5xx rate: service_name=api"
  message: "sum rate(http_server_requests_total) is 8 (above 5) for service_name=api — firing for 10m"

firing,   reason='renotify':
  title:   "Still firing — API 5xx rate: service_name=api"

resolved, reason='threshold' | 'keep_firing_expired':
  title:   "Resolved — API 5xx rate: service_name=api"
  message: "Back to 3.1 (below 5) after 34m"

resolved, reason='missing':
  title:   "Resolved — API 5xx rate: service_name=api"
  message: "The series stopped reporting 15m ago and was resolved automatically. Set
            'When a series disappears' to 'keep the alert firing' if silence should count
            as a failure."

burst rollup (D10):
  title:   "API 5xx rate: 14 more series are firing"
  message: "Only the first 10 series were sent individually. Open the rule to see all 24."
```

The `missing` resolve matters most: it is the one case where "resolved" might not mean
"fixed", and the body has to say so rather than let a user infer recovery from silence. When
the series has no labels at all (a fully-aggregated rule), the `service_name=api` suffix is
dropped rather than rendered as an empty pair.

#### 8.5 Templating

`rule.template` is rendered by a new `notificationTemplateMetric` in
`packages/db/src/services/notification.service.ts`.

**Correction to the draft.** It said the placeholder engine would be extracted "so there is
one placeholder implementation rather than three". There is exactly **one** today:
`notificationTemplateEvent` (`:251-281`) has the `{{…}}` loop; `notificationTemplateFunnel`
(`:283-296`) does `$EVENT_NAME`/`$RULE_NAME` only and has **no** placeholder loop. Routing
funnel through an extracted renderer would therefore be a second, unadvertised behaviour
change — funnel templates that emit `{{foo}}` literally today would start substituting. So:
extract the loop, use it from `notificationTemplateEvent` and `notificationTemplateMetric`,
and **leave `notificationTemplateFunnel` alone**.

```ts
/**
 * Extracted from notificationTemplateEvent's placeholder loop
 * (notification.service.ts:266-278) with ONE behavioural fix.
 *
 * The original is `const value = pathOr('', path.split('.'), payload)` followed
 * by `if (value)`, so a falsy value — 0, '', false — leaves the braces in the
 * rendered notification. For events that is a cosmetic edge case. For metrics it
 * is a correctness bug in the most common alert there is: `{{value}}` on a
 * "requests dropped to zero" alert renders as the literal string `{{value}}`.
 *
 * The fix changes the sentinel to undefined and the guard to an explicit
 * null/undefined check. This CHANGES event-rule behaviour: a template
 * referencing a present-but-empty property now renders "" instead of leaving
 * the braces. That is the better behaviour, and a regression test pins every
 * case notificationTemplateEvent handles today.
 */
function renderPlaceholders(template: string, context: unknown): string {
  const matches = template.match(/{{[^}]+}}/g) || [];
  let out = template;
  for (const match of matches) {
    const value = pathOr(undefined, match.slice(2, -2).split('.'), context);
    if (value !== undefined && value !== null) {
      out = out.replaceAll(
        match,
        typeof value === 'object' ? JSON.stringify(value) : String(value),
      );
    }
  }
  return out;
}
```

The metric context object, chosen so `pathOr` with a dotted path does all the work:

```ts
{
  rule_name:  'API 5xx rate',
  state:      'firing',              // 'firing' | 'resolved'
  reason:     'threshold',
  metric:     'http_server_requests_total',
  value:      8,                     // number; null when reason === 'missing'
  threshold:  5,
  comparator: 'gt',
  labels:     { service_name: 'api' },
  series:     'service_name=api',    // pre-formatted, sorted, comma-joined
  duration:   '10m',                 // humanised at − firingSince
  project:    'acme-prod',
  url:        'https://dashboard…/notifications/rules/f1e2…?series=3a9c…',
}
```

`$RULE_NAME` is kept as an alias for symmetry with the other two templates (`:262`, `:295`).

**A label name that is not a valid dotted path.** Prometheus label names match
`[a-zA-Z_][a-zA-Z0-9_]*` and are validated by `zMetricQuery` before they can reach a query,
so `{{labels.<name>}}` is always a two-segment path and `pathOr` never mis-splits. No
escaping is needed. (Contrast the event path, where `properties.a.b` is genuinely ambiguous.)

#### 8.6 Shutdown

`boot-workers.ts:369-371` drains only `cronQueue` before closing workers. The `alerts` queue
should be added:

```ts
if (enabledQueues.includes('cron'))   await waitForQueueToEmpty(cronQueue);
if (enabledQueues.includes('alerts')) await waitForQueueToEmpty(alertsQueue);
```

with one caveat worth writing down: `waitForQueueToEmpty`'s own timeout defaults to 60 s
(`boot-workers.ts:428`) but `exitHandler` arms a force-exit at `SHUTDOWN_FORCE_EXIT_MS`,
default **20 000 ms** (`boot-workers.ts:350-363`). The effective drain budget is ~20 s minus
whatever the cron drain used. The outbox is what actually makes shutdown safe; the drain just
makes stranded rows rarer.

### 9. UI and tRPC

#### 9.1 `rule-card.tsx`

`apps/start/src/components/notifications/rule-card.tsx:19-21` is the hard compile break:

```ts
function EventBadge({ event }: { event: NotificationRule['config']['events'][number] }) {
```

`NotificationRule['config']` is the union; adding a member without `events` makes
`['events']` an error. Fix by naming the member:

```ts
import type { INotificationRuleEventConfig } from '@openpanel/validation';
function EventBadge({ event }: { event: INotificationRuleEventConfig['events'][number] }) {
```

`INotificationRuleEventConfig` is already exported (`validation/src/index.ts:513-515`) and
`zNotificationRuleFunnelConfig` uses the same element type, so both existing branches keep
type-checking. The two `rule.config.events` reads inside `renderConfig` (`:68`, `:79`) are
already inside `switch (rule.config.type)` and narrow correctly — they need no change.

Then a third arm in `renderConfig` (`:62-92`), rendering the human sentence, the **live
state**, and the health badge:

```
Alert when  [sum rate(http_server_requests_total{status=~"5.."}) by service_name]
            is above 5 for 10m                                    [Pause]  [Edit]  [Delete]

  ● api      8.0    firing for 10m
  ○ worker   0.2    ok
  ⚠ this rule failed its last 3 evaluations — gigapipe unreachable
```

fed by `notification.alertState`. Firing rows use the existing `PingBadge` (imported at
`:14`). The `Pause` control is D11's toggle and is the point of the whole decision: the
3 a.m. remedy for a misconfigured rule must not be `deleteRule`.

#### 9.2 `add-notification-rule.tsx`

| Line | What | Change |
|---|---|---|
| `:87-90` | `useFieldArray({ control, name: 'config.events' })` — a hook, so it cannot be conditional | move the events form into an `<EventRuleFields>` subcomponent that owns the hook; the metric form is a sibling `<MetricRuleFields>` |
| `:92-98` | `onSubmit` guards `data.config.events[0]?.name` | branch on `data.config.type` |
| `:127-136` | the type `Combobox` has two hardcoded items | add `{ label: 'Metric', value: 'metric' }`, gated on `isGigapipeEnabled` from `observability.status` so a deployment with no `GIGAPIPE_URL` is not offered a rule type that can never evaluate |
| `:53-62` | `defaultValues.config` | switching the type picker must swap in a whole valid default config for that member, not merge — the union is discriminated and a half-swapped object fails `zodResolver` with an unreadable error |

The metric form: a metric picker (`observability.metrics.names`), label matchers, `fn` +
`window`, `aggregation` + `groupBy`, then comparator + threshold, then a collapsed
"Advanced" block for `forSeconds`, `everySeconds`, `keepFiringForSeconds`,
`renotifySeconds`, `missingSeries`, `missingGraceSeconds`, `maxSeries`.

Two form rules that are not cosmetic:

- **The aggregation control is hidden when `fn === 'histogram_quantile'`**, because the
  compiler always forces `sum` for the inner aggregation regardless of the field
  (`03-metrics-engine.md:736-742`). Showing a control whose value is silently ignored is
  worse than not showing it.
- **The matcher rows are purpose-built, not `PureFilterItem`.** The draft proposed reusing
  `PureFilterItem` "with the operator set mapped `is→eq / isNot→neq / regex→re`". The
  impedance mismatch is larger than that mapping admits: `zChartEventFilter.value` is
  `z.array(string|number|boolean|null)` (`packages/validation/src/index.ts:31-46`) while a
  metric matcher's `value` is a single `z.string()`; `operators` has fifteen members
  (`packages/constants/index.ts:92-108`) of which three map; and `!~` (negative regex) has no
  OpenPanel operator to map *from*. A four-operator row with a single string input is less
  code than the adapter and does not lie about what is supported.

The template help block (`:171-217`) needs a metric variant listing `{{value}}`,
`{{threshold}}`, `{{series}}`, `{{labels.<name>}}`, `{{duration}}`, `{{state}}`,
`{{rule_name}}`.

#### 9.3 tRPC

Four procedures on the existing `notificationRouter`, plus runtime-row maintenance inside
the two existing mutations.

```ts
/** Current state of every series for every metric rule in the project. */
alertState: protectedProcedure
  .input(z.object({ projectId: z.string() }))
  .query(…)

/** Transition history for one rule. */
alertHistory: protectedProcedure
  .input(z.object({ ruleId: z.string(), take: z.number().int().max(200).default(50) }))
  .query(…)   // explicit requireProjectAccess: this input carries no projectId

/** D11: pause / resume / mute. */
setMetricRuleEnabled: protectedProcedure
  .input(z.object({ projectId: z.string(), ruleId: z.string(), enabled: z.boolean(),
                    mutedUntil: z.date().nullable().optional() }))
  .mutation(…)

/** Replay the state machine over a historical window. §9.4. */
previewMetricRule: protectedProcedure
  .use(rateLimitMiddleware({ /* per-IP, per-path */ }))
  .input(z.object({
    projectId: z.string(),
    config: zNotificationRuleMetricConfig,
    range: z.enum(['6h', '24h', '7d']).default('6h'),
  }))
  .query(…)
```

`protectedProcedure` already includes `enforceAccess` (`packages/trpc/src/trpc.ts:176-180`),
which requires **read** access for any query and **write** for any mutation carrying a
top-level `projectId` (`trpc.ts:100-111`). So `alertState`, `setMetricRuleEnabled` and
`previewMetricRule` are covered by the middleware; only **`alertHistory`** needs an explicit
`requireProjectAccess`, because its input carries a `ruleId` rather than a `projectId`. (The
draft said "the two that take a `ruleId`"; only one does.)

Two consequences of that access model, stated rather than discovered:

- `previewMetricRule` is a `.query`, so `needsWrite` is false and **any project member,
  including read-only ones, can run it**. That is intended — it reads the same metrics a
  read-only member can already chart — but it is why it must also take the alerts lease
  (D15) and `rateLimitMiddleware`. A form that re-previews on every keystroke is otherwise a
  repeated `query_range` against the shared gigapipe with no throttle.
- `previewMetricRule` must be a `.query` and not a `.mutation` for exactly that reason; if it
  ever becomes a mutation it silently requires write access.

**`createOrUpdateRule` and `deleteRule` also maintain the runtime row**, in the same
transaction as the rule write (§4.3). Specifically:

| Change | Action, in the same `db.$transaction` |
|---|---|
| create with `config.type === 'metric'` | insert the runtime row, `nextEvaluationAt = now + random(0, everySeconds)` |
| update, type changed **to** `metric` | insert the runtime row as above |
| update, type changed **away from** `metric` | delete the runtime row **and** the rule's `MetricAlertSeriesState` rows. Leaving state rows to age out is the tempting shortcut and it is wrong: a row still marked `firing` emits a spurious resolve if the rule flips back within the week |
| `config.query.metric` or `config.query.groupBy` changed | delete the rule's `MetricAlertSeriesState` rows — every series key is invalidated, and without this each old series emits a `missing` resolve after `missingGraceSeconds`, a burst of confusing notifications right after an edit |
| **`projectId` changed** | delete the `MetricAlertSeriesState` rows **and** update `MetricAlertRuleRuntime.projectId`. `createOrUpdateRule` writes `projectId: input.projectId` at `packages/trpc/src/routers/notification.ts:102` while `requireProjectAccess` checks only `existing.projectId` at `:90-94` (the `enforceAccess` middleware does cover the new id, so this is not a privilege escalation) — but the rule's project genuinely changes, and without this the runtime and state rows keep pointing at the old project, so `alertState` renders project B's label values inside project A's UI and carries stale firing state across |
| anything else, including `threshold` | **nothing.** Editing a rule does not reset state: silently clearing state on save would let a user "fix" an alert by editing it and the resolve notification would never arrive |
| delete | cascade removes runtime + state rows; `MetricAlertEvent` rows survive by design (D5) |

`MetricAlertEvent` history is **not** re-projected on a project move; the rows record what
happened while the rule belonged to the old project, and `alertHistory` filters by `ruleId`.

**A pre-existing hazard this sits next to.** `createOrUpdateRule` clears the rule cache at
`notification.ts:81` — **before** the `update` at `:96` or the `create` at `:120`. Any event
evaluated in that window repopulates `getNotificationRulesByProjectId`'s cache with the
pre-edit rule set, which then persists for the full 1 440 s TTL. `deleteRule` (`:140-160`)
never clears the cache at all. Metric rules are unaffected (the evaluator does not read that
cache), but this function is about to get longer and nobody will want to touch it again, so
moving the `.clear()` after the write and adding the missing one to `deleteRule` should ride
along.

#### 9.4 The preview

The single most valuable thing in the editor.

1. `POST /api/v1/query_range` with `compileAlertQuery(config.query, { projectId })`,
   `start = now − range`, `end = now`, `step = config.everySeconds`.
2. Replay `stepSeries` (§5.2) over the returned matrix — the **same function** the evaluator
   uses, one pass per series, with `at` walking the step grid. The preview and the evaluator
   differ only in their data source and in whether they persist.
3. Return `{ chart: FinalChart, transitions: Transition[], summary }` where the summary is
   *"would have fired 3 times, totalling 41 minutes; 2 series"*, and the chart is P2's
   `shapeMatrixToFinalChart` output so it renders in the existing chart components with a
   threshold reference line.

Three honesty requirements, because a preview that overstates its fidelity is worse than none:

- **It is an approximation.** Live evaluation issues an *instant* query with the engine's
  ~5 minute lookback; the preview resamples on the step grid. Points where the two disagree
  are exactly the gaps in the underlying data — which is where "missing series" behaviour
  lives. Label it "approximate replay".
- **Point budget.** gigapipe caps a range query at 11 000 points per series and floors/ceils
  the window to 15 s (`prom_query_range.go:55-56`). `7d / 60s` is 10 080 — inside the cap but
  close — so the preview computes `range / everySeconds` and refuses before issuing rather
  than letting gigapipe answer a 500 that classifies as `GigapipeQueryTooLargeError`.
- **`maxSeries` applies.** If the window contains more than `config.maxSeries` distinct
  series, say so loudly: that rule would be permanently unhealthy in production (D9) and the
  editor is the only place a user finds out before saving.

The preview takes the same alerts lease bucket as an evaluation (D15).

### 10. Operations

#### 10.1 Rule health badges

Computed by `alertState` from Postgres. The first row is the one the draft did not have, and
it is the row that matters:

| Condition | Badge |
|---|---|
| `nextEvaluationAt < now() − 2 × everySeconds` | **"this rule is overdue and has not been evaluated"** — destructive styling |
| `lastSuccessAt IS NULL AND createdAt < now() − 3 × everySeconds` | **"this rule has never been evaluated"** |
| `lastErrorCode = 'org_blocked'` | "alerting is paused because this organization's trial expired" |
| `enabled = false` or `mutedUntil > now()` | "paused" |
| `consecutiveFailures >= 1` | "last evaluation failed: `<lastError>`" |
| `consecutiveFailures >= 5` | "not evaluating — `<lastErrorCode>`", destructive styling |
| `lastErrorCode = 'auth'` | "gigapipe rejected our credentials — this needs an operator, it will not self-heal" |
| `skippedPeriods > 0` | "missed N evaluations since the last success" |
| `lastErrorCode = 'too_many_series'` | "returns too many series — narrow the query or raise the limit" |
| `lastErrorCode = 'no_targets'` | "this rule has nowhere to send" |
| `nonFiniteSeries > 0` | "N series returned NaN or Inf" |
| otherwise | `ok` (no badge) |

Four corrections behind that table:

- **The overdue and never-evaluated rows need no evaluator.** Every badge in the draft keyed
  off `consecutiveFailures`, `skippedPeriods` or `lastSuccessAt`, all written only by the
  evaluator — so a deployment where the alerts worker never starts renders every rule as
  healthy. That is not hypothetical: `getEnabledQueues` returns the default list **only when
  `ENABLED_QUEUES` is unset** (`boot-workers.ts:57-88`), and the self-hosting docs actively
  recommend pinning it (`environment-variables.mdx:629, :633`). Both rows are computed
  straight from `nextEvaluationAt`/`createdAt`, so they fire with no evaluator at all.
- `health` is **cut**: it was fully derivable from `consecutiveFailures > 0`.
- `lastDurationMs` is **cut**: the histogram (§10.3) carries the distribution, and no badge
  in this table used the column.
- `skippedPeriods` is reset to 0 on every successful evaluation, so "in the last hour" — a
  windowed question a monotonic counter cannot answer — becomes "since the last success",
  which it can.

On startup, `bootWorkers` logs a warning when `ENABLED_QUEUES` is set, does not include
`alerts`, and at least one `MetricAlertRuleRuntime` row exists.

#### 10.2 Error taxonomy

`04-read-path.md:667-680` defines **thirteen** `GigapipeError` subclasses. The draft handled
five. The full mapping, with an explicit default so an implementer never has to invent one:

| Error | `lastErrorCode` | Behaviour |
|---|---|---|
| `GigapipeDisabledError` | — | dispatcher returned early; never reached |
| `GigapipeUnavailableError`, `GigapipeTimeoutError`, `GigapipeUpstreamError`, `GigapipePartialResponseError` | `unavailable` / `timeout` / `upstream` / `upstream` | **hold all state.** `consecutiveFailures++` |
| `GigapipeBusyError` (lease full) | `busy` | hold state, `consecutiveFailures` **not** incremented — this is backpressure, not a fault |
| `GigapipeAuthError` (401/403) | `auth` | hold state; **never retried and never self-heals** — a distinct badge, because it means the basic-auth credentials for gigapipe are wrong and only an operator can fix it |
| `GigapipeBadQueryError` (400 / parse) | `bad_query` | hold state. A compiler bug or a metric that no longer exists |
| `GigapipeQueryTooLargeError` | `query_too_large` | hold state. On an instant query this means the selector is enormous; narrow it |
| `GigapipeResponseTooLargeError` | `response_too_large` | hold state. Almost always the same cause as `too_many_series`, caught one layer lower |
| `GigapipeSchemaNotReadyError` | `schema_not_ready` | hold state. gigapipe's database or tables are absent — a P0 provisioning problem |
| `GigapipeScopeError` / `TenancyError` | `scope` | hold state, **and re-throw** so the transport's counter fires and the page goes out |
| local cardinality cap | `too_many_series` | hold state (D9) |
| no delivery targets | `no_targets` | state advances normally; only delivery is suppressed |
| org blocked by wind-down | `org_blocked` | not evaluated at all (§6.2) |
| **anything else** | `upstream` | **hold all state**, `consecutiveFailures++`, log with the error class name |

"Hold state" means: **touch no state row**. A firing alert stays firing. A pending timer
keeps its `pendingSince`. No series is judged missing, because no response arrived to judge
it against. The failure mode of an alerting system whose data source is down must be *stale*,
never *resolved*.

#### 10.3 Telling the user their alerts are blind

Per-rule notifications would be a flood — a project with 40 metric rules would get 40
messages the moment gigapipe restarts. Instead:

1. `metric_alert_evaluations_total{result="unavailable"}` and `metric_alert_stale_rules` for
   the operator (§10.4).
2. The per-rule badge (§10.1) for anyone on the rules page.
3. **One** notification per project per 6 h when every metric rule in the project has been
   failing for more than 15 minutes.

Three fixes to (3) relative to the draft, all of which made it non-functional as written:

- It hardcoded `integrationId: EMAIL_NOTIFICATION_INTEGRATION_ID`, and `getIntegration('email')`
  returns `sendToApp: false` (`notification.service.ts:100-110`), so `createNotification`'s
  `if (data.sendToApp)` guard (`:150-154`) writes **no** `notifications` row — the notice
  would be invisible in the in-app list and in `notification.list`. It now issues **two**
  calls, app and email.
- Its payload was described as "a 'metric' payload with `state:'firing'`", which cannot be
  typed: `INotificationMetricPayload` requires `ruleId`, `seriesKey`, `threshold`,
  `comparator`, `metric`, `since` and `url`, none of which exist for a project-level notice.
  It uses the fourth union member, `INotificationMetricAlertingBlindPayload` (§2).
- It was emitted **from the dispatcher**, which cannot fire when the dispatcher is what is
  not running, and which does not group by project anywhere. It moves to a small
  `cron`-queue job (`metricAlertHealthCronJob`, hourly) that runs one grouped query:

```sql
SELECT r."projectId",
       count(*)                        AS total,
       count(*) FILTER (
         WHERE r."consecutiveFailures" >= 1
           AND (r."lastSuccessAt" IS NULL OR r."lastSuccessAt" < now() - interval '15 minutes')
       )                               AS failing,
       min(r."lastSuccessAt")          AS since
FROM metric_alert_rule_runtimes r
WHERE r.enabled = true
GROUP BY r."projectId"
HAVING count(*) > 0 AND count(*) = count(*) FILTER (
         WHERE r."consecutiveFailures" >= 1
           AND (r."lastSuccessAt" IS NULL OR r."lastSuccessAt" < now() - interval '15 minutes')
       );
```

guarded per project by `runEvery({ interval: 6*3600, key: 'metric-alert-blind:'+projectId })`.
`Notification.notificationRuleId` is nullable (`schema.prisma:614`), so a rule-less
notification is representable today.

#### 10.4 Metrics

Added to `apps/worker/src/metrics.ts`. **Every metric is explicitly registered on that
module's own `register`** — the file builds `export const register = new Registry()` at
`:14-16` and `apps/worker/src/index.ts:74-83` serves only that registry, so a metric
constructed with `new client.Counter(...)` and no `registers` option lands in prom-client's
**global default** registry and never appears on `/metrics`. The draft's snippet did exactly
that for three of its five metrics. Names carry **no** `openpanel_` prefix, matching every
existing metric in the file (`job_duration_ms`, `kafka_events_reprocessed_total`); the draft
used both conventions in adjacent sections.

```ts
export const metricAlertEvaluations = new client.Counter({
  name: 'metric_alert_evaluations_total',
  help: 'Metric alert rule evaluations',
  // ok | unavailable | timeout | auth | bad_query | too_many_series | scope
  // | busy | upstream | skipped
  labelNames: ['result'],
});
register.registerMetric(metricAlertEvaluations);

export const metricAlertEvaluationDuration = new client.Histogram({
  name: 'metric_alert_evaluation_duration_ms',
  help: 'Wall-clock duration of one metric alert rule evaluation',
  buckets: [25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000],
});
register.registerMetric(metricAlertEvaluationDuration);

export const metricAlertTransitions = new client.Counter({
  name: 'metric_alert_transitions_total',
  help: 'Metric alert state transitions',
  labelNames: ['to', 'reason'],
});
register.registerMetric(metricAlertTransitions);

export const metricAlertOutboxDeadLettered = new client.Counter({
  name: 'metric_alert_outbox_dead_lettered_total',
  help: 'Transitions abandoned after ALERT_OUTBOX_MAX_ATTEMPTS delivery attempts',
});
register.registerMetric(metricAlertOutboxDeadLettered);

// Bound to an exported const so dispatchMetricAlerts can call .set() on it —
// the draft passed an anonymous gauge into registerMetric and then referenced a
// name that was never declared.
export const metricAlertDispatchBacklog = new client.Gauge({
  name: 'metric_alert_dispatch_backlog',
  help: 'Rules past their nextEvaluationAt that this tick could not dispatch',
});
register.registerMetric(metricAlertDispatchBacklog);

// Gauges that query Postgres at SCRAPE time, exactly like the existing per-queue
// gauges query Redis (metrics.ts:40-99). Keep them indexed and trivial; a scrape
// must not become a table scan.
register.registerMetric(new client.Gauge({
  name: 'metric_alert_stale_rules',
  help: 'Enabled metric alert rules whose last successful evaluation is older than 3 periods',
  async collect() { this.set(await countStaleMetricAlertRules()); },
}));
```

`apps/worker` runs at `replicas: $OP_WORKER_REPLICAS` behind a round-robin Caddy vhost, so a
gauge answers for whichever replica the scrape hit. `metric_alert_stale_rules` is a global
count from Postgres and is replica-independent; `metric_alert_dispatch_backlog` is set by
whichever replica ran the dispatch and should be read as a max across replicas, not a sum.
That is the same pre-existing property the queue gauges have.

Adding `alertsQueue` to `metrics.ts:18`'s `queues` array also produces
`alerts_active_count` / `_waiting_count` / `_failed_count` / `_delayed_count` /
`_completed_count` for free.

### 11. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ALERTS_CONCURRENCY` | 5 | alerts worker concurrency (`getConcurrencyFor`) |
| `ALERTS_DISPATCH_BATCH` | 2000 | rules dispatched per tick |
| `ALERT_MAX_NOTIFICATIONS_PER_EVAL` | 10 | D10 burst cap |
| `ALERT_MAX_RULES_PER_PROJECT` | 50 | interim quota, enforced in `createOrUpdateRule` |
| `ALERT_OUTBOX_MAX_ATTEMPTS` | 5 | before `deadLetteredAt` |
| `ALERT_EVENT_RETENTION_DAYS` | 90 | `metric_alert_events` prune |
| `ALERT_GAP_FACTOR` | 3 | D14 staleness multiple of `everySeconds` |
| `ALERT_NOTIFY_DISABLED` | unset | **staged rollout.** When `true`, evaluate and record every transition but suppress all delivery (`suppressedReason = 'notify_disabled'`). One week of this on a real deployment surfaces a mis-tuned `forSeconds` or a cardinality problem without paging anyone. Cheap, and the alternative is that rules go from not existing to delivering to Slack in one step |
| `GIGAPIPE_ALERT_CONCURRENCY_PER_PROJECT` | 2 | D15 lease bucket |

`ENABLED_QUEUES` gains `alerts` in both the code default (`boot-workers.ts:56-75`) and
`environment-variables.mdx:619-633`. This is a behaviour change on upgrade for every existing
self-hosted deployment and belongs in the release notes; deployments that **pin**
`ENABLED_QUEUES` get no alerts worker at all, which is why §10.1's first two badge rows exist
and why `bootWorkers` logs a warning.

### 12. Worked example, end to end

**Rule.** "Tell me when a service's 5xx rate goes above 5 requests/second for ten minutes."

```jsonc
{
  "id": "f1e2…",
  "name": "API 5xx rate",
  "projectId": "proj_abc",
  "sendToApp": true,
  "sendToEmail": false,
  "integrations": [{ "id": "…slack…" }],
  "template": "{{rule_name}}: {{labels.service_name}} at {{value}} req/s (threshold {{threshold}})",
  "config": {
    "type": "metric",
    "query": {
      "type": "metric",
      "metric": "http_server_requests_total",
      "metricType": "counter",          // REQUIRED by P2's zMetricQuery; no default, no 'auto'
      "matchers": [
        { "name": "http_response_status_code", "op": "=~", "value": "5.." }
      ],
      "fn": "rate",
      "window": "5m",
      "aggregation": "sum",
      "groupBy": ["service_name"]
    },
    "comparator": "gt",
    "threshold": 5,
    "forSeconds": 600,
    "everySeconds": 60,
    "keepFiringForSeconds": 300,
    "notifyOnResolve": true,
    "missingSeries": "resolve",
    "missingGraceSeconds": 900,
    "maxSeries": 20,
    "renotifySeconds": null
  }
}
```

The `metricType` and `matchers`/`op` fields are P2's schema, not the tenancy spec's
`filters`/`operator`. Q1 is the blocker on which of the two this line is written against; the
example is shown in P2's shape because P2 owns `zMetricQuery`
(`03-metrics-engine.md:3`, `:331-450`).

**Compiled query** (§3) and **response** (`writeVector`, `prom_query_range.go:312-352`):

```json
{"status":"success","data":{"resultType":"vector","result":[
  {"metric":{"service_name":"api","op_project_id":"proj_abc"},"value":[1772400000,"7.3333333333333"]},
  {"metric":{"service_name":"worker","op_project_id":"proj_abc"},"value":[1772400000,"0.2"]}
]}}
```

Three properties of that encoder the evaluator must respect: **label key order is Go map
order** (`:329` iterates `s.Metric.Map()`), so the series key sorts before hashing (§5.1);
**values are `strconv.FormatFloat(s.F,'f',-1,64)`** (`:344`), so non-finite values arrive as
`"NaN"`/`"+Inf"`/`"-Inf"` and `NaN > 5` is `false` — a silent non-alert unless §7.2 rejects
them; and **only `s.F` is written**, so there is no native-histogram branch.

**Timeline**, `everySeconds: 60`, `forSeconds: 600`, `keepFiringForSeconds: 300`:

| Tick | `service_name="api"` | Comparison | State after | Notification |
|---|---|---|---|---|
| 12:00 | 2.1 | false | `inactive` | — |
| 12:01 | 7.3 | true | `pending` (`pendingSince=12:01`) | — |
| 12:02 … 12:10 | 6–9 | true | `pending` | — |
| 12:11 | 8.0 | true, `at − pendingSince = 600 s ≥ for` | `firing` (`firingSince=12:11`) | **fire** |
| 12:12 … 12:30 | 6–9 | true | `firing` | — (D8) |
| 12:31 | 4.1 | false | `firing`, `clearedSince=12:31` | — (`keepFiringFor`) |
| 12:33 | 7.9 | true | `firing`, `clearedSince=null` | — (**flap absorbed**) |
| 12:40 | 3.0 | false | `firing`, `clearedSince=12:40` | — |
| 12:45 | 3.1 | false, `at − clearedSince = 300 s ≥ keepFiringFor` | `inactive` | **resolve** |

Meanwhile `service_name="worker"` sat at 0.2 the whole time and stayed `inactive` with a row
recording its last value — which is what the rule card renders.

**The 12:11 notification.** One `createNotification` per delivery target (Slack, then
`sendToApp`), serialised (D10):

```ts
{
  title: 'API 5xx rate: api at 8 req/s (threshold 5)',   // rendered from rule.template
  message: 'Project: acme-prod · firing for 10m · service_name=api',
  projectId: 'proj_abc',
  notificationRuleId: 'f1e2…',
  integrationId: '…slack…',            // then APP_NOTIFICATION_INTEGRATION_ID
  payload: {
    type: 'metric', state: 'firing', reason: 'threshold',
    ruleId: 'f1e2…', seriesKey: '3a9c…',
    labels: { service_name: 'api' },
    value: 8, threshold: 5, comparator: 'gt',
    metric: 'http_server_requests_total',
    since: '2026-08-29T12:11:00.000Z',
    evaluatedAt: '2026-08-29T12:11:00.000Z',
    url: 'https://dashboard.openpanel.dev/org_x/proj_abc/notifications/rules/f1e2…?series=3a9c…',
  },
}
```

### 13. gigapipe recording rules stay off

`QRYN_RULER_ENABLED` (`ruler/router/init.go:29-36`, accepting `1|true|yes|on`) starts two
`RuleManager`s — one LogQL, one PromQL (`init.go:84-113`). Each polls storage every
`QRYN_RULER_POLL_INTERVAL` (default 30 s), evaluates every **recording** rule in every group
(`manager.go:199-219`), and writes the result vector back **in-process** through the writer's
metrics pipeline (`ruler/writeback.go:54-58` → `writer/controller/recording_writeback.go`).
Rule groups live in `{{.DB}}.rules`, created unconditionally whether or not the ruler is on,
whose own comment says `org_id is intentionally omitted: gigapipe is single-tenant`.

Five facts decide it:

1. **Recording-rule output bypasses our ingest gateway entirely.** `writeback.go:58` calls
   `PushPromWriteRequest` in-process — no HTTP, no snappy, no auth, no proxy. It is
   therefore not label-enforced and **not metered**. Every recorded series is telemetry
   volume that OpenPanel's billing counters never see. That alone rules recording rules out
   of any cloud deployment until a metering story exists.
2. **Tenancy survives only if the rule expression says so.** `vectorToWriteRequest`
   (`writeback.go:20-40`) copies the sample's labels, then `maps.Copy(merged, ruleLabels)` —
   **rule labels win**. A rule whose `labels:` map *sets* `op_project_id` writes that value
   over the sample's: a cross-tenant leak with no guard anywhere. `op_project_id` must never
   appear in a recording rule's `labels:` map.
3. **Storage and evaluation are global.** `GetAllRuleGroups` has no tenant filter and
   `evaluateInterval` re-reads *every* group on *every* tick (`manager.go:200`). One rule
   group per project does not scale.
4. **The CRUD routes have no auth of their own** beyond gigapipe's global basic auth, and
   gigapipe's own `Makefile:5` and e2e compose default `QRYN_RULER_ENABLED` to **true**.
   OpenPanel's compose template must set it explicitly and must not be derived from
   gigapipe's (`10-ops-retention-billing.md:198-200`).
5. **A stored alerting rule is accepted, re-served, and never evaluated** (D1).

**Verdict for P5: do not enable.** Fact 1 is a billing and tenancy hole, and the thing
recording rules would most obviously accelerate — alert evaluation itself — is already cheap,
because an alert issues one *instant* query per rule per minute, not a range query. gigapipe
also already gives most of the win for free: `metrics_15s` is an `AggregatingMergeTree` fed
by `metrics_15s_mv` (`ctrl/qryn/sql/log.sql:83, :146-158`) and the PromQL read path selects
from it, so the 15-second pre-aggregation a recording rule would hand-build for a `rate()` is
largely already there. Revisit in P6 with a measured query, deployment-wide, and put the
decision in `10-ops-retention-billing.md` — it is a storage and cost decision, not an
alerting one.

---

## Interfaces

### Consumed from the tenancy work-stream (`01-tenancy-and-security.md`)

| Symbol | Location | Contract this work-stream relies on | Status in `01` |
|---|---|---|---|
| `TELEMETRY_PROJECT_LABEL` | `@openpanel/constants` | the literal `op_project_id` | **exposed** |
| `compileSelector(q, projectId, extraMatchers?)` | `packages/gigapipe/src/query/promql.ts` | tenancy matcher first, always `=`, never a regex | **exposed**, but only as `(q, projectId)`; the third parameter is `03-metrics-engine.md`'s request for pinning and is **not yet accepted in `01`**. Alerting does not use it (D4) and does not block on it |
| `compileAggregation(q, inner): string` | same | wraps `inner`, carries `op_project_id` through `by (…)`, **never emits `without`**, returns `inner` unchanged when `q.aggregation` is absent | **NOT EXPOSED — R1.5.** `01` exposes `compileGroupBy(q): string`, a bare `by (…)` fragment |
| `verifyResponseLabels(series, projectId): void` | `packages/gigapipe/src/query/verify.ts` | throws `TenancyError` when any series' `op_project_id` is absent or different; called as a **statement**, on the raw wire array, before any stripping | **NOT EXPOSED — R1.5.** The behaviour is specified in `01` § Detection (a); the symbol is in no table |
| `assertProjectLabelValue` / `TenancyError` | `packages/gigapipe/src/labels.ts` | — | **exposed** |

**Ask on `01-tenancy-and-security.md` — new, and it is the one that stops three specs from
compiling (R1.5).**

`01`'s "Exposed by this work-stream" table must gain the last two rows above, with exact
signatures, or the three consumers must be rewritten against `compileGroupBy`. **Recommend
adding `compileAggregation(q, inner): string` and deleting `compileGroupBy`**, for three
reasons:

1. `03-metrics-engine.md` §4.1's emission order needs the **wrapping** form —
   `aggd := compileAggregation(qWithLe, ranged)` wraps a range-function expression, which a
   `by (…)` fragment cannot do without the caller doing the string concatenation. Moving the
   concatenation into the caller is exactly the "second function that emits PromQL" that `01`'s
   own auditability argument forbids.
2. Putting the wrap in the tenancy layer is what keeps `op_project_id` in `by (…)` **by
   construction** rather than by convention, which is the whole basis of `01`'s
   non-vacuous-response-check argument.
3. `04-read-path.md` §4.4 states there is **no stub** for `verifyResponseLabels` — if the
   tenancy layer ships later, `src/read/*.ts` does not compile. An interface three specs import
   and no spec owns is a build break, not a documentation gap.

Two consequential details to settle in the same edit:

- **`compileAggregation`'s body must drop the `quantile` / `topk` / `bottomk` branches and the
  `q.k` reads.** `03-metrics-engine.md` § Interfaces already asks for this and is right: those
  branches exist only against `01` §7.2's schema, which R1.1 replaces. `q.k` no longer exists,
  so leaving them is a compile error, not dead code. This document has no opinion on the
  branches beyond wanting them gone (D4, §1's `.refine`).
- **Label position is not pinned.** `compileGroupBy` puts `op_project_id` first;
  `compileAggregation` may put it last. Both satisfy every check in this document, and A39 is
  written to assert membership rather than position (§3). `01`'s test T1.13 asserts "first" —
  if the wrapping form appends instead, T1.13 must be relaxed to membership too, or `01` must
  keep prepending. Either is fine; picking silently is not.

**Also correct in `01`'s own suite:** the compiled-output assertion belongs in `01`'s tests as
much as in ours, because if the wrapper ever stops carrying the label,
`verifyResponseLabels` starts rejecting 100 % of samples from every grouped alert rule and
metric alerting silently stops project-wide with no error visible to a user. That assertion is
**A39** here — the previous revision of this document called it "A19" in this paragraph, which
is the outage/resolve-suppression case. Corrected.

### Consumed from the metrics work-stream (`03-metrics-engine.md`)

| Symbol | Location | Contract |
|---|---|---|
| `zMetricQuery` / `IMetricQuery` | `@openpanel/validation`, file `packages/validation/src/telemetry.validation.ts` | **owned by `03-metrics-engine.md` §2 and canonical as of R1.1**; embedded verbatim in `zNotificationRuleMetricConfig.query`. `filters` / `operator`, not `matchers` / `op`; no `seriesLimit`, no `fill`, no `k` |
| `zMetricLabelFilter` | same | the matcher row type the rule form renders (§9.2). **Not** `zMetricMatcher`, which exists in no document's schema |
| `shapeMatrixToFinalChart(input)` | `packages/db/src/engine/metrics/shape.ts` | preview chart |
| `observability.metrics.names` | `packages/trpc/src/routers/observability.ts` | metric picker in the rule form |
| **`compileAlertQuery(query, ctx)`** | `packages/db/src/engine/metrics/compile.ts` | **NEW, requested by this spec** |

**Three asks on `03-metrics-engine.md`, the first two blocking:**

1. **Factor the §4.2 emission table into a grid-free entry point** and export
   `compileAlertQuery(query, { projectId, windowMs? })` with the signature in *Design* §3. It
   must be the same code path as `compileMetricQuery()`, not a parallel table: the histogram row
   is exactly where a second implementation drifts invisibly, because
   `histogram_quantile` over a vector with no `le` returns an empty vector rather than an
   error, and the rule then never fires, forever, with no signal.
2. **No ranking and no pinning on the alert path** (D4). `03-metrics-engine.md` D8 already keeps
   `topk` out of every query it emits; the alert path additionally skips Phase A ranking and
   Phase B pinning entirely, because ranking discards precisely the series an `lt` rule must
   fire on.
3. **Acknowledge `compileAlertQuery` in `03`'s own Interfaces table.** It is currently a request
   in this document with no acceptance on the other side, and it is a hard dependency of the
   very first file this work-stream writes. Symmetrically, this document hereby **accepts** the
   whole of `03` §2 as the schema (R1.1) — that acceptance was missing too.

**Corrections `03` and `04` should absorb (R1.3):** `04-read-path.md` §8.2 still says
`compileMetricQuery` "wraps any query carrying a `groupBy` in `topk(maxSeries, ...)`", which
`03-metrics-engine.md` D8 explicitly rejects and which D4 rejects again on independent grounds.
`03`'s six amendments to `04` should be applied as a set: delete the `topk` wrap; the
`maxSeries`-exceeded `GigapipeUpstreamError` in the same section (already gone from `04`); fix
or retire `clampStep`; raise `cfg.maxPoints` to 3000; add `cfg.maxRankSeries`,
`cfg.metricFanoutConcurrency` and `cfg.metricDeadlineMs`. And `09-ui-surfaces.md` D4's `limit`
paragraph, which is justified *by* the `topk` wrap, has to be rewritten with it.

### Consumed from the read-path work-stream (`04-read-path.md`)

| Symbol | Location | Contract |
|---|---|---|
| `prometheus.queryInstant({ query, time, projectId })` | `packages/gigapipe/src/read/prometheus.ts` | `POST /api/v1/query`, bare `application/x-www-form-urlencoded` content type, no 15 s flooring of `time` |
| `isGigapipeEnabled()` | `packages/gigapipe/src/config.ts` | gates rule dispatch, **not** the outbox sweep |
| the `GigapipeError` hierarchy | `packages/gigapipe/src/errors.ts` | all thirteen classes; see *Design* §10.2 for the alert-side mapping and the default |
| `withProjectLease(projectId, fn, opts?)` | `packages/gigapipe/src/lease.ts` | **amended** — see below |
| `observability.status` | `packages/trpc/src/routers/observability.ts` | gates the "Metric" option in the rule-type picker |

**Ask on the read-path work-stream — one item, down from two (R1.4):** `withProjectLease`
gains an optional `{ bucket?: string; max?: number }` — one extra key segment,
`obs:lease:${bucket ?? 'query'}:${projectId}`.

The *other* half of this ask is **withdrawn as already satisfied**. The previous revision
argued against a contract at `04-read-path.md:1447-1449` reading "the P5 alert worker takes one
lease per evaluation *sweep*, not per rule", on the grounds that under D7 there is no sweep.
`04` §8.4 and its `withProjectLease` Interfaces row now both say "one lease per rule evaluation,
never one per batch", with a 120 s max hold. The documents agree; nothing has to be retracted on
either side, and this document's D15 has been rewritten accordingly. The separate bucket is
still worth having on its own merits: alert evaluation can never consume the interactive
dashboard budget, in either direction.

**Also honour the kill switch.** `04-read-path.md`'s Interfaces row for `isObservabilityDisabled`
says "P5 alert evaluation should also honour the kill switch". Accepted: the dispatcher checks
it alongside `isGigapipeEnabled()`, on the same terms — it gates **dispatch**, never the outbox
sweep, because an operator flipping the kill switch must not strand an already-committed
transition (D16, A25).

### Consumed from the billing / wind-down lifecycle

| Symbol | Location | Contract |
|---|---|---|
| `Organization.windDownStep` | `packages/db/prisma/schema.prisma:128-129` | `'blocked'` / `'final_warning'` mean ingestion is rejected (`apps/api/src/hooks/subscription.hook.ts:26`), so alerting must be paused, not left to resolve every series |
| `windDownCronJob`'s recovery branch | `apps/worker/src/jobs/cron.wind-down.ts:294-299` | must also re-arm `MetricAlertRuleRuntime` (*Design* §6.2) |

**Open product question (Q4):** whether alerts should also respect
`getOrganizationSubscriptionChartEndDate`, the clamp `executeChart` applies to event charts.

### The shared cron inventory — five specs, three files, one name collision

**This section exists because the review found no owner for it.** Five of the eleven
specifications add crons to the same three files with no shared inventory, and two of them
register the **same scheduler key** for different jobs. A31 already calls a silently
unscheduled `metricAlerts` "the worst failure an alerting system has"; the collision below is
that failure arriving for a *different* job by accident. The proposed home for this table is a
`00-blueprint.md`. **There is no `00-blueprint.md` on disk** (verified: `ls docs/observability/`
returns `01`–`11` plus `_drafts/`), so it lives here until one exists, and it should move
verbatim when one does.

The mechanism, read off the file rather than assumed
(`apps/worker/src/boot-cron.ts:30-215`): `jobs` is a local array of `{ name, type, pattern }`;
`jobsToKeep` is `new Set(jobs.map(j => j.type))` (`:138`); every existing scheduler whose key is
not in that set is removed (`:147-148`); each surviving job is registered with
`upsertJobScheduler(job.type, …)` (`:159`). **The scheduler key is `type`, not `name`.** Two
consequences that decide the collision: two entries sharing a `type` are one scheduler, and the
later `upsertJobScheduler` call wins the pattern; and a `CronQueuePayload` union with the same
`type` declared twice does not compile.

| Job (`type`) | Kind | Schedule | Owning document | Files touched |
|---|---|---|---|---|
| `metricAlerts` | new `alerts`-queue kicker | `every: 60_000` | **this document**, D7 | `queues.ts`, `cron.ts`, `boot-cron.ts`, `cron.metric-alerts.ts` |
| `telemetryUsage` | per-project usage flush, Redis → Postgres | `'5 * * * *'` | `05-logs.md` §4.7 | same three |
| `telemetryRetention` **(A)** | per-project purge | `'15 3 * * *'` | `05-logs.md` §4.7 | same three |
| `telemetryReconcile` | metering reconciliation | `'45 3 * * *'` | `05-logs.md` §4.7 | same three |
| `telemetryRetention` **(B)** | ClickHouse TTL re-assert + retention health gauges | `'10 */6 * * *'` | `10-ops-retention-billing.md` §6.2 | same three |
| `telemetryUsageRollup` | yesterday's Redis counters → Postgres | `'20 1 * * *'` | `10-ops-retention-billing.md` §6.2 | same three |
| tenancy canary probe | ingest→query isolation probe | every 15 minutes | `01-tenancy-and-security.md` § Detection (b) | `cron.telemetry-tenancy-probe.ts`; **no `type` name is given in `01`** — UNVERIFIED, it must be added to this table when named |
| trace orphan sweep | count gin rows with no `op_project_id` sibling | weekly | `06-traces-and-correlation.md` §11.7 | **no `type`, no schedule expression and no `boot-cron.ts` entry are specified** — UNVERIFIED |

**Resolve the collision by renaming `05`'s.** `10`'s `telemetryRetention` is the TTL re-assert
and it owns the retention machinery; `05`'s is the per-project purge. Rename `05`'s to
**`telemetryPurge`**. Rationale, not preference: `10` §6.2 is the only place in the whole set
where an inventory of *existing* cron slots is written down, so it is already acting as the
registry, and `10`'s job is the one `08-schema-changes.md` cross-references for
`TelemetrySchemaState` materialisation.

**Schedule slots, checked against the real file.** Occupied today: `0 0` salt (and `ping`),
`0 *` delete / onboarding / windDown, `0 2` insightsDaily, `0 3` gscSync, `0 4` sessionVacuum,
`30 4` insightCleanup, `30 7` dataHealth, `0 8 * * 1` weeklyDigest, `*/30 * * * *`
cohortRefresh, plus five 10 s flushes, a 30 s profile-backfill flush and a 5-minute
`sessionReaper` on numeric intervals. Of the proposed additions, `'5 * * * *'`, `'15 3 * * *'`,
`'45 3 * * *'`, `'10 */6 * * *'` and `'20 1 * * *'` are all free. `'10 */6'` deliberately avoids
the `:00` hourly cluster; `'15 3'` and `'45 3'` sit either side of `gscSync` at `0 3`, which is
fine — they are separate schedulers, and the cron **worker's** default concurrency of 1
(`boot-workers.ts:218-227`) is the real serialisation, which is exactly why D7 keeps this
document's real work off `cronQueue` entirely.

**Make the inventory testable.** `11-testing-strategy.md` §7.2's registration test asserts the
triple (`CronQueuePayload` member ↔ `cron.ts` switch case ↔ `boot-cron.ts` entry) by iterating
`CronQueueType`, which is the right shape and already catches a dropped registration. It should
additionally assert **schedule uniqueness** — no two entries sharing a `type` — because that is
the failure this section exists to prevent and the existing assertion cannot see it. That is one
extra line in a test this document already depends on (A31).

### Exposed to other work-streams

| Symbol | Location | For |
|---|---|---|
| `zNotificationRuleMetricConfig` / `INotificationRuleMetricConfig` | `@openpanel/validation` | the rule editor (`09-ui-surfaces.md`), the P6 MCP surface (below) |
| `INotificationMetricPayload`, `INotificationMetricAlertingBlindPayload` | `@openpanel/db` | anything reading `Notification.payload` |
| `stepSeries(prev, sample, at, config)` | `packages/db/src/services/metric-alert.machine.ts` | the evaluator, the preview, and the test suite — one implementation, per `11-testing-strategy.md`'s **properties** P1–P4 (those are property numbers in that document, not phases) |
| `seriesKeyOf(metric)` | same package | must agree with the metrics engine's series-id sorting rule (`11-testing-strategy.md` §5.4) |
| `notification.alertState` / `alertHistory` | `packages/trpc/src/routers/notification.ts` | the rule card, and the read model the P6 MCP `what_is_firing` tool consumes (below) |

### Cross-stream asks that are changes to shared code

1. **`notificationJob` should throw on a failed send, and `notificationQueue` needs
   `attempts`.** `postWebhook` returns `{ ok: false, status: 0 }` on any error
   (`packages/integrations/src/fetcher.ts:39-52`); `notificationJob` returns it without
   inspecting `.ok` (`apps/worker/src/jobs/notification.ts:112-138`), so every delivery
   failure marks the job **completed**, and `removeOnComplete: 10` with no `attempts` and no
   `removeOnFail` (`packages/queue/src/queues.ts:281-289`) erases the evidence within ten
   notifications. Every notification producer in the product inherits this. **P5 does not fix
   it** — it is shared code on the event and funnel paths — but P5 is the work-stream that
   makes it matter, because D8 means a dropped fire notification is never re-sent.
2. **`notificationJob` returns an `Error` object instead of throwing when `payload` is null**
   (`notification.ts:79-81`). The job completes, nothing is delivered, nothing is logged. A
   one-word fix (`throw`) surfaces it.
3. **`isFunnelRule` must become a type predicate** (*Design* §0.2). Whoever lands the third
   union member lands this, or `packages/db` stops compiling.
4. **`rule-card.tsx:21` is a compile break** the moment the config union gains a member
   without `events`. `09-ui-surfaces.md:1319` already tracks both this and the modal.
5. **`createOrUpdateRule` clears the rule cache before it writes, and `deleteRule` never
   clears it** (*Design* §9.3). Event and funnel rule edits can be up to 24 minutes stale.
6. **`11-testing-strategy.md` §10 describes an older alerts design** — `MetricAlertState` as
   a *model* with `incidentId`/`lastEvaluatedTick`/`fireCount`, `cooldownSeconds`, a
   `getLock`-guarded dispatcher, relation-less state tables. This spec supersedes it:
   `MetricAlertState` is the **enum**, dedup is the `lastEvaluationAt` claim rather than a
   `lastEvaluatedTick` CAS, flap suppression is `keepFiringForSeconds` rather than
   `cooldownSeconds`, and the two live tables **do** carry cascading relations (only
   `MetricAlertEvent` is relation-less to the rule, which is what preserves the incident
   history that document was protecting). Its properties P1–P4 and its 21-row matrix all
   still hold and are folded into *Test requirements*.

---

## Failure modes

### Guarantees, stated plainly

| Property | Guarantee |
|---|---|
| Evaluation | **At most once per (rule, dueAt)**, enforced by the Postgres claim |
| Evaluation freshness | Always at wall-clock now. After an outage, the missed periods are **counted, not replayed**, and the timers they would have advanced are **invalidated** (D14) |
| State transition | Exactly once per evaluation, in one transaction with the event rows |
| Notification | **At least once *enqueued* per transition.** A crash between `queue.add` and stamping `enqueuedAt` duplicates |
| Notification **delivery** | **Best-effort and currently unobservable** (D12). A non-2xx from Slack/Discord/a webhook, a DNS failure, or an SSRF rejection all mark the BullMQ job completed. Until the cross-stream ask lands, "the alert fired but nothing arrived" is diagnosable only from the third-party's side |
| Ordering | Per-rule, per-evaluation, sorted by `seriesKey`, serialised. No ordering across rules |
| Rule edits | Live on the next tick — the dispatcher reads Postgres, not the 24-minute rule cache |
| Pausing | Takes effect on the next dispatch; firing series are dropped to `inactive` with a suppressed `rule_disabled` event, and no resolve is sent |

### What breaks, how it is detected, what the user sees

| Failure | Detection | User-visible |
|---|---|---|
| gigapipe down / timing out | `consecutiveFailures`, `metric_alert_evaluations_total{result="unavailable"}` | Rule-card badge "last evaluation failed"; after 15 min of total project failure, one notification per project per 6 h. **A firing alert stays firing. Nothing resolves.** |
| gigapipe basic-auth misconfigured | `lastErrorCode = 'auth'` | A distinct badge saying it needs an operator — this is the one failure that never self-heals |
| The alerts worker is not running (`ENABLED_QUEUES` pinned) | `nextEvaluationAt` falls behind with no evaluator writes | "this rule is overdue and has not been evaluated" / "has never been evaluated", computed from Postgres with no evaluator involved. Plus a boot warning |
| Label cardinality explodes | `lastErrorCode = 'too_many_series'` | "returns too many series — narrow the query or raise the limit". Existing firing state is preserved |
| A series stops reporting | `lastSeenAt` ages past `missingGraceSeconds` | Depends on `missingSeries`. On `resolve`, the body says explicitly that the series stopped reporting and points at the `keep` setting |
| The org is blocked by wind-down | `lastErrorCode = 'org_blocked'` | "alerting is paused because this organization's trial expired". **No transitions, no notifications** — the alternative was emailing "your infrastructure recovered" to a customer whose ingestion we had just cut off |
| A rule has no delivery targets | `lastErrorCode = 'no_targets'` | "this rule has nowhere to send". Event rows are `suppressed`, not falsely stamped as enqueued |
| A label value contains NUL or is 4 KB long | `sanitizeLabelText` at parse time; `deliveryAttempts` + `deadLetteredAt` as the backstop | Nothing. Before both, this stalled the outbox permanently and re-notified every row ahead of it on every tick |
| A worker dies mid-evaluation | `enqueuedAt IS NULL` rows swept on the next dispatch | Possibly a duplicate Slack message. Never silence |
| Two replicas evaluate the same rule | the claim returns `count === 0` for the loser | Nothing |
| A 43-minute worker outage | `skippedPeriods = 43` on the next evaluation | "missed 43 evaluations since the last success". The first evaluation reads **current** data, and no `for` timer is satisfied by the gap (D14) |
| A rule is edited to point at another project | handled in the mutation's transaction | Series state is cleared; project B's UI never renders project A's label values |
| An alert is noisy at 3 a.m. | — | **Pause** on the rule card (D11), which preserves the history that explains why it was noisy. Not `deleteRule` |

### Debugging an alert that did not fire

1. **Is the rule evaluating at all?** Rule-card badge. Rules out: worker not running the
   `alerts` queue, `GIGAPIPE_URL` unset, gigapipe down, bad credentials, a bad query,
   `too_many_series`, org blocked, rule paused.
2. **Did the series appear?** `alertState` shows one row per series with its last value and
   `lastSeenAt`. A rule with *zero* rows has never matched anything — almost always a matcher
   that matches nothing. The specific trap: **gigapipe truncates stored label values to 100
   characters plus `"..."` at ingest**, so an `=` matcher on a longer value matches nothing,
   forever, with no error (`03-metrics-engine.md:364-372`). URL paths and k8s resource names
   routinely exceed 100 characters; `compile()` is specified to reject it at authoring time.
3. **Did it breach?** `alertState.value` against the threshold. If the value looks wrong, the
   query is wrong, and the preview is the tool.
4. **Did it breach *continuously*?** `alertHistory` shows every `inactive ↔ pending`
   transition. A run of `pending → inactive` rows with `suppressedReason: 'not_fired'` is the
   signature of a `forSeconds` too long for how the metric actually behaves.
5. **Did it transition but not get enqueued?** `alertHistory` shows `enqueuedAt`,
   `deliveryAttempts`, `deadLetteredAt` and `suppressedReason`. A dead-lettered row is a
   `createNotification` that failed five times — almost always a poison title or message.
6. **Did it get enqueued but not arrive?** This is where the trail currently ends (D12), and
   the honest list of causes is: the payload was null (impossible for metric alerts, and
   pinned by a test); the recipient has a `product_alerts` unsubscribe, handled inside
   `sendEmail`; or the webhook/Discord/Slack POST failed and **was silently swallowed** —
   `postWebhook` returns `{ ok: false }` and `notificationJob` neither checks it nor throws,
   so the job shows as completed and `removeOnComplete: 10` erases it within ten
   notifications. Check the third party's own delivery log. This is the cross-stream ask.
7. **Was it a duplicate rather than a miss?** `metric_alert_events` is the source of truth;
   `notifications` may have more rows than transitions (one per delivery target) and, after a
   crash, more still.

A "Why didn't this fire?" link on the rule card that opens `alertHistory` filtered to one
series turns steps 2–5 into one screen.

---

## Test requirements

Modelled on `apps/worker/src/jobs/cron.wind-down.test.ts` (module-level `vi.hoisted` mocks
for `@openpanel/db` / `@openpanel/email`, then import the job) and
`packages/trpc/src/routers/share.test.ts` (`router.createCaller` with a mocked
`@openpanel/db`) — the two patterns this repo already uses. `now: Date` is **injected** into
`stepSeries` and the evaluator rather than faked globally, per
`11-testing-strategy.md:139`.

There is essentially **no** existing coverage to extend. `events.incoming-events.test.ts:21`
mocks `checkNotificationRulesForEvent` away; `events.create-session-end.test.ts:30-36` mocks
`getNotificationRulesByProjectId` and `getHasFunnelRules` — the **funnel** path, which is
exactly the path *Design* §0.2 has to fix. (The draft said both mock
`checkNotificationRulesForEvent`; only the first does.) Nothing exercises `createNotification`
or `notificationJob` at all.

### State machine — `metric-alert.machine.test.ts`, all against `stepSeries`

| # | Assertion |
|---|---|
| A1 | The §12 timeline, tick by tick, table-driven |
| A2 | `forSeconds` is a **continuity** requirement: a single non-breaching evaluation clears `pendingSince` and a flapping series never fires |
| A3 | `forSeconds: 0` fires on the first breaching evaluation, in one pass |
| A4 | `keepFiringForSeconds` absorbs a clear-then-rebreach and emits **no** transition |
| A5 | Missing series: `resolve` after grace; `keep` holds `firing` indefinitely; grace measured from `lastSeenAt`, and three consecutive absences do not reset the clock |
| A6 | `pending → inactive` yields a transition with `notify: false`, `suppressedReason: 'not_fired'` |
| A7 | `renotifySeconds` emits a `renotify` transition without changing state, and only after the interval has elapsed since `lastNotifiedAt` |
| A8 | `compare` is exhaustive: all four comparators, plus a `never` check |

### Gap and scheduling — `alerts.evaluate.test.ts`

| # | Assertion |
|---|---|
| A9 | **The claim**: a second call with the same `dueAt` returns `already-evaluated` and issues **no** gigapipe request |
| A10 | `computeNextEvaluationAt` preserves phase when one period late, and clamps + reports `skipped === 43` after a 43-period gap (the invariant, not a magic number) |
| A11 | **A job dispatched with a `dueAt` 40 minutes old queries gigapipe at `now`**, and every timestamp it writes is `now` — D13 |
| A12 | **A 43-period gap does not let a one-sample breach satisfy a 10-minute `for`**: `pendingSince` and `clearedSince` are cleared, `lastSeenAt` is set to `now`, `state` is held, one suppressed `evaluation_gap` event is written — D14 |
| A13 | A firing series is **not** resolved by the gap, regardless of `keepFiringForSeconds` |
| A14 | `GigapipeUnavailableError` touches **no** state row, increments `consecutiveFailures`, sets `lastErrorCode` |
| A15 | An unlisted `GigapipeError` subclass falls to the default: holds state, `lastErrorCode = 'upstream'`. Covers all thirteen classes by construction |
| A16 | `GigapipeAuthError` sets `lastErrorCode = 'auth'` and is never retried |
| A17 | `verifyResponseLabels` throwing aborts the evaluation, transitions nothing, and **re-throws** |
| A18 | `result.length > maxSeries` marks unhealthy, transitions nothing, and leaves a firing series firing |
| A19 | Outage → three failed evaluations → recovery emits **zero** resolve notifications across the whole sequence |

### Series identity and values

| # | Assertion |
|---|---|
| A20 | `seriesKeyOf` is invariant under key-order permutation of the same label set (the Go-map-order hazard) |
| A21 | `seriesKeyOf({})` is stable; a fully-aggregated rule yields exactly **one** alert instance — explicitly *not* the drop that `group-by-labels.ts:62` does on the chart path |
| A22 | `"NaN"`, `"+Inf"`, `"-Inf"` parse to `null`, are treated as absent (not as non-breaching), and increment `nonFiniteSeries` without failing the rule |
| A23 | `sanitizeLabelText` strips U+0000 and other C0 controls and truncates at 200; a 4 KB label value and a NUL-bearing label value both survive a full evaluation → notification round trip |

### Dispatch and outbox — `alerts.dispatch.test.ts`

| # | Assertion |
|---|---|
| A24 | An `enqueuedAt: null` row older than 30 s is re-notified and stamped; a 5 s old row is not |
| A25 | `isGigapipeEnabled() === false` dispatches nothing **but still flushes the outbox and runs the prune** |
| A26 | A row that fails `ALERT_OUTBOX_MAX_ATTEMPTS` times is dead-lettered, stops being retried, and appears in `alertHistory`; rows behind it are still delivered |
| A27 | Two concurrent sweeps do not both claim the same row (`FOR UPDATE SKIP LOCKED` + `leasedAt`) |
| A28 | An org at `windDownStep` `blocked` / `final_warning` is **skipped**: no query, no transition, no notification, `lastErrorCode = 'org_blocked'` |
| A29 | Recovery re-arms: `nextEvaluationAt = now`, `lastErrorCode` cleared, `pendingSince`/`clearedSince` cleared |
| A30 | A disabled or muted rule is not dispatched; disabling a rule with a firing series writes a suppressed `rule_disabled` event, drops it to `inactive`, and sends nothing |
| A31 | **The registration triple**: `metricAlerts` is in `CronQueuePayload`, in the `cron.ts` switch, and in `boot-cron.ts`'s job list. `boot-cron.ts:138-155` removes any scheduler whose key is absent, so a partial landing silently unschedules the job — and "alerts silently stopped firing" is the worst failure an alerting system has |

### Delivery and templating

| # | Assertion |
|---|---|
| A32 | A metric notification's `payload` is non-null, so `isValidJson` (`notification.ts:79-81`) passes and the job does not silently return an `Error` |
| A33 | Delivery is **serialised** and capped: 24 firing series with `ALERT_MAX_NOTIFICATIONS_PER_EVAL=10` produce 10 individual notifications plus one rollup, and 14 events marked `suppressedReason: 'burst_cap'` |
| A34 | A rule whose only integration was deleted, with `sendToApp`/`sendToEmail` false, marks `no_targets` and writes `suppressed` events rather than stamping `enqueuedAt` |
| A35 | `{{value}}` renders `0` — the `if (value)` fix |
| A36 | **Regression on the event path**: the extracted `renderPlaceholders` still renders every case `notificationTemplateEvent` handles today, including the newly-changed present-but-empty case |
| A37 | **Regression on the funnel path**: `notificationTemplateFunnel` still does `$EVENT_NAME`/`$RULE_NAME` only and does **not** substitute `{{…}}` |
| A38 | `checkNotificationRulesForSessionEnd` compiles and behaves correctly with a metric rule present in the project's rule set — the type-predicate fix (*Design* §0.2) |

### Compiler and access control

| # | Assertion |
|---|---|
| A39 | `compileAlertQuery` output contains `op_project_id="…"` inside the selector **and** inside `by (…)` for an aggregated query, and inside the selector for an un-aggregated one; contains no `topk`, no `bottomk`, and no `>`/`<`. **This is the security-boundary test** and must assert on the string, not on a comment. Assert **membership** of the `by (…)` set, not the label's position: `01`'s `compileGroupBy` puts it first, the wrapping `compileAggregation` this spec asks for may put it last, and both are correct (§3) |
| A40 | `compileAlertQuery` for `fn: 'histogram_quantile'` emits `histogram_quantile(p, sum by (<groupBy…>, le) (rate(<name>_bucket{…}[w])))` — `le` present and **appended after** the user's `groupBy` (`03-metrics-engine.md` §4.2/§4.3), `sum` forced, the user's `aggregation` ignored |
| A41 | `alertHistory` for a rule in another project is rejected by `requireProjectAccess` |
| A42 | `previewMetricRule` is a `.query`, so a read-only member can run it, and it is rate-limited and lease-bounded |
| A43 | `createOrUpdateRule` past `ALERT_MAX_RULES_PER_PROJECT` is rejected |
| A44 | Changing `projectId`, `query.metric` or `query.groupBy` deletes the rule's series-state rows in the same transaction; changing `threshold` does not |

### Not covered, deliberately

Real gigapipe. Every test above runs against the fake gigapipe server
(`packages/gigapipe/src/__test__/fake-gigapipe.ts`, shared with the read-path and ingest
streams). The pinned-image integration tests that settle Q3 live in `11-testing-strategy.md`.

---

## Open questions

| # | Question | What would settle it |
|---|---|---|
| **Q1** | **Which `zMetricQuery` does `config.query` embed?** Two incompatible definitions are on disk. `01-tenancy-and-security.md:1027-1051` puts it in `packages/validation/src/telemetry.validation.ts` as `{metric, filters[{name,operator:eq\|neq\|re\|nre,value}], fn(11 values), window(enum), aggregation?(incl. topk/bottomk/quantile), groupBy, quantile?, k?}`. `03-metrics-engine.md:386-450` puts it in `packages/validation/src/index.ts` as `{type:'metric', metric, metricType(REQUIRED), fn(5 values), aggregation(default sum, only sum/avg/min/max), matchers[{name,op:=\|!=\|=~\|!~,value}], groupBy, quantile, window?, fill?, seriesLimit, displayName?, hideSeries?}`. **This blocks §1, §3, §9.2 and §12.** | A decision between P1 and P2 owners. My position: **P2's**, because `03-metrics-engine.md:3` claims ownership explicitly, because it is the object the chart builder persists (so "alert on this chart" only works if alerting embeds the same one), and because it is the version that has already removed `topk`/`bottomk` from `aggregation`. If P1's wins instead, the `.refine()` in §1 becomes load-bearing rather than defensive, and `metricType` disappears from §12 |
| **Q2** | Does the read-path work-stream accept the `withProjectLease({ bucket, max })` amendment (D15), replacing `04-read-path.md:1447-1449`'s "one lease per sweep"? | A conversation with that owner. There is no sweep to hang a lease on, so the current contract cannot be implemented as written; the only question is whether the bucket lives in `lease.ts` or alerting gets its own key |
| **Q3** | Does `LookbackDelta: 0` (`reader/router/prometheus_query_range.go:34`) really resolve to Prometheus' 5-minute default? `missingGraceSeconds`' 900 s default is chosen from it | Write a series into the pinned gigapipe image, stop writing, poll `POST /api/v1/query` and time how long the last sample keeps coming back. Ten minutes of work |
| **Q4** | Should a metric alert respect `getOrganizationSubscriptionChartEndDate`, the clamp `executeChart` applies to event charts (`packages/db/src/engine/index.ts:31-37`)? A lapsed org sees frozen charts but would still get live alerts | Product call. My position: **no clamp on alerting** — alerts are an operational safety function and silently disarming them on a billing state change is dangerous. Note this is *separate* from the wind-down pause (§6.2), which is not a clamp but a hard block on ingestion, so there is genuinely nothing to alert on. But it must be a decision, not an omission |
| **Q5** | Does BullMQ 5.63 honour a per-job `opts.deduplication` passed through `addBulk`? | One integration test. No code change either way — the Postgres claim already makes a duplicate dispatch a no-op |
| **Q6** | Is 90 days the right `metric_alert_events` retention, and should it be per-plan? | Ops call. 90 days is a guess sized to "the last quarter's incidents"; it is one constant |
| **Q7** | Should the cross-stream ask (`notificationJob` throwing on `!result.ok`, `notificationQueue` gaining `attempts`) ship **with** P5 rather than after it? | An owner for `packages/queue` + `apps/worker/src/jobs/notification.ts`. It converts silently-dropped notifications into visibly-failed jobs for **every** event and funnel rule in production, which is the right trade but is not this work-stream's to make unilaterally. Until it lands, D12's honest wording stands |
| **Q8** | Log-based alerting: the state machine is signal-agnostic and a LogQL metric query through `loki.queryInstant` would drop straight in. Worth doing in P6? | After P3 ships the logs explorer. It needs a log-query builder in the rule editor and a different preview, not a different evaluator |

Explicitly **out of scope**, with the reason:

| Thing | Why |
|---|---|
| **Absence alerts** ("this series should exist and does not") | The machine keys on series *returned by the query*, so it can never alert on a series it has never seen. Needs a separate rule shape carrying the expected label sets. P6 |
| **Raw PromQL in a rule** | P1 gates raw PromQL behind a lezer-based rewriter and `04-read-path.md:800-801` puts it at P6+. Alerting must not be the first surface to accept it |
| **Severity, routing by severity, silences, acknowledge, escalation** | Each is a product decision and `NotificationRule` has none of the columns. D11's pause is the stopgap; D8's transition-only default is the other half |
| **Grouping several firing series into one message** | Alertmanager's `group_by`. D10's cap + rollup is the interim; do the real thing once the cap is regularly hit |
| **Alerting on event-analytics metrics through this path** | The event engine is edge-triggered from `checkNotificationRulesForEvent`, not polled. Unifying them is bigger than P5 |
| **gigapipe recording rules** | *Design* §13. `QRYN_RULER_ENABLED` stays unset |

---

## Effort

A range, not a point, because two line items are gated on decisions this work-stream does not
own.

| Item | Days |
|---|---|
| `zNotificationRuleMetricConfig`, the two payload members, `IPrismaMetricAlertLabels`, the `isFunnelRule` type-predicate fix | 0.5 |
| Prisma models + migration + runtime-row maintenance in `createOrUpdateRule`/`deleteRule` + the hourly backstop | 1.0 |
| `alerts` queue, worker, cron entry, dispatcher (incl. the wind-down join and `parkBlockedMetricAlertRules`), the claim, `computeNextEvaluationAt` | 1.5 |
| `stepSeries` + `seriesKeyOf` + `parseSample` + `sanitizeLabelText` + the persistence pass + the D14 gap rule | 2.5 |
| Outbox: claim SQL, attempt bound, dead letter, shutdown drain, prune, 7-day state sweep | 1.0 |
| `compileAlertQuery` — **the ask on P2** | 0.5–2.0 |
| Templating extraction + `notificationTemplateMetric` + default bodies + the burst rollup | 1.0 |
| Rule editor: type-aware form + metric fields + the discriminated-union default swap | 2.0–3.0 |
| Rule card: compile fix, metric branch, live state, health badges, pause control | 1.5 |
| Preview (query, replay via `stepSeries`, chart, point budget, honesty labels) | 1.5 |
| tRPC: `alertState`, `alertHistory`, `setMetricRuleEnabled`, `previewMetricRule` | 1.0 |
| Metrics, bull-board + gauge registration, the blind-project cron job, env-var docs | 1.0 |
| Tests A1–A44 | 3.0 |
| **Total** | **18–21 days** |

Excludes the §8.3 delivery-content follow-ups (~0.5 d) and the §9.3 cache-ordering fix
(~0.1 d), both of which should ride along.

**What makes it bigger:**

- **Q1 lands on P1's `zMetricQuery` rather than P2's.** Then `metricType` disappears,
  `matchers` becomes `filters`, the `fn` set triples, `aggregation` becomes optional and
  `topk`/`bottomk`/`quantile` become reachable — so §1's `.refine()` becomes load-bearing,
  the form grows a `k` field and a `quantile` field, and every worked example is re-derived.
  **+1.5 d** across §1, §3, §9.2 and the tests.
- **P2 does not factor its emission table.** The `compileAlertQuery` line item is 0.5 d if P2
  exposes a grid-free entry point and 2 d if this work-stream has to do the factoring inside
  P2's file and get it reviewed by P2's owner. It is the difference between an ask and a
  fork, and it is why the item is a range. **The estimate assumes the ask is accepted.**
- **The rule editor.** Type-switching a discriminated-union `react-hook-form` is the classic
  underestimate: `useFieldArray` at `:87` is unconditional so the events form must move into
  a subcomponent, `defaultValues.config` at `:53-62` must whole-swap between union members
  rather than merge, and `zodResolver`'s errors on a half-swapped discriminated union are
  notoriously opaque. 2 d is the good case.
- **Q7 ships with P5.** Adding `attempts`/`backoff` to `notificationQueue` and making
  `notificationJob` throw changes behaviour for every event and funnel rule in production and
  needs its own test pass and release note. **+1 d**, and it is worth it.

**Hard dependencies.** P1's `compileSelector` / `compileAggregation` /
`verifyResponseLabels` / `assertProjectLabelValue`; P4's `packages/gigapipe` transport,
`prometheus.queryInstant`, `isGigapipeEnabled`, the error hierarchy and `withProjectLease`;
P2's `zMetricQuery`, `compileAlertQuery`, `shapeMatrixToFinalChart` and
`observability.metrics.names`. Nothing here can start before P1's transport exists, and the
schema question (Q1) blocks the very first file.
