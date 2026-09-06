# The signal sink — analytics events to gtmsrv signals

This fork feeds gtmsrv. A rule says "when this event arrives, raise this
signal"; an outbox delivers it. Both live here; gtmsrv is a separate service in
a separate repository and only ever sees the HTTP POST.

Nothing runs unless `GTMSRV_URL` and `GTMSRV_INGEST_TOKEN` are both set. There
is no default host — a compiled-in one would mean a misconfigured deployment
quietly posts real people's behaviour at whatever host happened to be built in.

### Moving to a source credential

gtmsrv can issue this sink its own credential instead of the shared ingest
token, so its signals are attributed to a named source that can be listed and
switched off. **This needs no code change here**: gtmsrv tries a source
credential before the shared token, so migrating is one-sided — have gtmsrv
issue a credential for this producer and set `GTMSRV_INGEST_TOKEN` to that
secret. Same header, same variable, different value.

Until then every request is accepted on the shared token and logged on gtmsrv's
side as needing its own credential. This sink sends
`X-GTM-Source: OpenPanel signal sink` so that warning names which producer to
issue one to.

## Adding a rule

A rule is a row. That is the point: SPEC §2.3 promises "point your SDK at us and
map events to signals", which is only true if adding a mapping is an `INSERT`
rather than a deploy.

```sql
INSERT INTO signal_rules
  ("projectId", name, "eventName", filters, "signalKind", strength)
VALUES (
  'proj_abc',
  'Pricing page visit',        -- shown when explaining why a signal fired
  'pricing_page_view',         -- the OpenPanel event name, or '*' for all
  '[]'::jsonb,                 -- property filters, ANDed
  'pricing_page_visit',        -- the gtmsrv signal kind
  60                           -- 0-100, this source's confidence
);
```

With a filter — only the paid plans, and only from the upgrade screen:

```sql
INSERT INTO signal_rules
  ("projectId", name, "eventName", filters, "signalKind", strength)
VALUES (
  'proj_abc',
  'Upgrade gate abandoned',
  'upgrade_gate_view',
  '[{"name": "properties.plan", "operator": "isNot", "value": ["free"]},
    {"name": "path", "operator": "startsWith", "value": ["/upgrade"]}]'::jsonb,
  'upgrade_gate_abandoned',
  80
);
```

`filters` is the same shape charts and notification rules already use, and
matching goes through the same `matchEvent()`. One filter semantics in the
product, not two — so a filter you can build in a chart works here.

| field | meaning |
|---|---|
| `eventName` | OpenPanel event name, or `*` for every event |
| `filters` | `[{name, operator, value[]}]`, ANDed. `name` may be `properties.x`, or a top-level field like `path`. Operators: `is`, `isNot`, `contains`, `doesNotContain`, `startsWith`, `endsWith`, `regex` |
| `signalKind` | the signal kind gtmsrv receives, e.g. `upgrade_gate_abandoned` |
| `strength` | 0-100, passed through as the signal's strength |
| `enabled` | `false` retires a rule without deleting why it existed |

Rules are cached per project for five minutes, so a new rule takes effect within
that window rather than instantly.

Every matching rule fires. Two rules on one event produce two signals, with
different dedupe keys, on purpose.

## How it runs

1. `recordSignalsForEvent` runs on every event, beside the notification-rule
   check (`apps/worker/src/jobs/events.incoming-event.ts`). It matches rules and
   writes a `signal_outbox` row per match.
2. `signalOutbox` cron drains the table every 15s and POSTs each row to
   `${GTMSRV_URL}/ingest/signal` with `Authorization: Bearer $GTMSRV_INGEST_TOKEN`.

Deciding and recording are one write, so a crash between them loses nothing —
the row is already there and the next drain finds it. Delivery is separate
because doing it inline would put gtmsrv's availability on the event-ingestion
path: a gtmsrv restart would start dropping analytics.

Failures retry with backoff (1m, 2m, 4m … capped at an hour) for eight attempts,
roughly three hours end to end.

Only a body gtmsrv will reject again is abandoned outright — `400`, `413`,
`422`. Everything else retries, including `401`: a credential rotation is a
genuine transient, and the dedupe key makes redelivery safe. The rule is an
allowlist rather than "any 4xx" so that it fails *toward* retrying — retrying is
recoverable, and discarding is not.

`403` is neither retried nor abandoned. See below.

Abandoned rows are kept, with the error that explains them:

```sql
SELECT "ruleName", kind, attempts, "lastError"
FROM signal_outbox WHERE status = 'abandoned' ORDER BY "createdAt" DESC;
```

## When the source is disabled — parked, not retried, not discarded

gtmsrv answers `403` when the source is switched off. That is an instruction,
not a failure, and the delivery job neither retries it nor abandons it: the rows
are marked `paused`, keep the reason, and **do not consume a retry attempt**. A
pause of any length must not eat the budget that exists for transient failures.

Nothing releases them automatically, and that is the design. There are two
reasons to disable a source and they want opposite handling:

- *this producer is emitting nonsense* — the backlog should be discarded,
  because releasing it later delivers the nonsense;
- *pause while I look at something* — the backlog should be kept.

Nothing here can tell which, so nothing here chooses. The operator decided to
stop; the operator decides what happens to what stopped.

Release is deliberately not wired to the source being re-enabled, and should not
be. Re-enabling a source means "accept new signals", which is not the same as
"deliver everything queued while it was off" — and the two differ in exactly the
case parking exists for. A producer disabled for emitting nonsense, fixed, and
re-enabled would have its nonsense delivered by an automatic release. That is
the same guess parking refused to make, one step later.

```ts
import {
  pausedSignals,
  releasePausedSignals,
  discardPausedSignals,
} from '@openpanel/db';

await pausedSignals();          // what is parked, and how old
await releasePausedSignals();   // after re-enabling the source in gtmsrv
await discardPausedSignals();   // drop it, with a reason
```

All three take an optional `projectId`. `releasePausedSignals` and
`discardPausedSignals` return the count **and the oldest and newest event
times**, deliberately: "release 400 signals" and "release 400 signals, oldest
dated last Tuesday" are different operations to be about to perform, and you
should see which one you are doing before you do it.

### Releasing a stale backlog

Released signals carry their **original `occurred_at`**, untouched. That is what
makes releasing a week-old backlog survivable: gtmsrv stamps each signal with
when the event happened, not when it was released, so a play reading recency
sees a week-old page view as a week old rather than as a sudden burst of fresh
activity. Without it, releasing a parked backlog would look to every downstream
play like a spike of live traffic.

Check what you are about to release first:

```sql
SELECT count(*), min("occurredAt"), max("occurredAt")
FROM signal_outbox WHERE status = 'paused';
```

A parked backlog is also logged as a warning on every drain, so it does not
accumulate invisibly.

## The dedupe key — read this before changing it

gtmsrv rejects a signal without a dedupe key and collapses two that share one.
The key therefore decides whether a retry is safe. SPEC §6 routes
`upgrade_gate_abandoned` straight to outreach, so a key that varies across a
retry is a second email to a real person.

It is a SHA-256 over the event's content: rule id, project, event name, profile,
device, session, the event's own timestamp, and its properties with keys sorted.
Deterministic, so a replayed worker job derives the identical key.

**Not OpenPanel's event id**, though that is the obvious choice and it does not
work: `createEvent` mints that id with `uuid()` at insert time, and
`IServiceCreateEventPayload` omits `id` entirely — so there is no id in
existence when a rule matches, and a replayed job would mint a different one for
the same event. Borrowing it would produce exactly the duplicate the key exists
to prevent.

Never a timestamp of our own, never a random value. Both change on replay, which
is the one thing a dedupe key may not do.

The trade: two events identical in project, rule, name, profile, device,
session, millisecond *and* every property collapse into one signal. They are
indistinguishable in the data — OpenPanel would store two rows differing only by
a random uuid — so "this happened" is equally true of one signal or two.

The unique index on `signal_outbox.dedupeKey` makes the insert itself the
idempotency point: a replayed job's `createMany` is a no-op rather than a second
row. gtmsrv's own dedupe index then agrees with this one about what "the same
event" means.

## What gets sent

```json
{
  "kind": "upgrade_gate_abandoned",
  "source": "OpenPanel",
  "dedupe_key": "op_3f9a…",
  "strength": 80,
  "subject": { "kind": "person", "id": "profile_42" },
  "occurred_at": "2026-09-04T11:30:00.000Z",
  "evidence": {
    "event": "upgrade_gate_view",
    "project_id": "proj_abc",
    "rule": "Upgrade gate abandoned",
    "profile_id": "profile_42",
    "session_id": "session_7",
    "path": "/upgrade",
    "origin": "https://acme.com",
    "referrer": "https://google.com",
    "properties": { "plan": "pro" }
  }
}
```

`occurred_at` is **top level**, not only in evidence. gtmsrv reads it from the
body; a copy in evidence alone is inert and the signal silently carries receipt
time instead — which would make SPEC §6's "4d after email.sent" count from when
a backlog happened to drain rather than from when the thing happened.

`subject` is **omitted entirely** when the event has no identified profile.
OpenPanel sets `profileId` to `deviceId` for anonymous traffic, so a non-empty
`profileId` is not the same thing as a known person. gtmsrv opens a lead from a
subject, and a guessed one attaches a stranger's browsing to somebody else's
timeline — a lead is a real person somebody will email. No subject means the
signal is recorded without opening a lead, which is the honest outcome. The
profile id is in `evidence` either way, so a lead can always be traced back.

There is no `tenant_id`: gtmsrv derives the tenant from the bearer token, and a
body-stated one would let a token issued for one tenant write into another.

## Tests

Both halves test offline, with no gtmsrv and no database:

```
pnpm --filter @openpanel/db test src/services/signal-rule.service.test.ts
pnpm --filter @openpanel/worker test src/jobs/cron.signal-outbox.test.ts
```

The POST is injectable (`signalOutboxCronJob({ post })`) so the delivery
contract can be asserted without the other service running.
