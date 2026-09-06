-- The signal sink: analytics events become gtmsrv signals.
--
-- Two tables, and the split matters. `signal_rules` is configuration a marketer
-- edits; `signal_outbox` is the durable record of a signal we owe gtmsrv. They
-- are separate because the rule can be deleted, edited or disabled long after
-- the signals it produced have been delivered, and losing the delivery record
-- with the rule would make "did we ever tell gtmsrv about this?" unanswerable.

-- ---------------------------------------------------------------------------
-- signal_rules
-- ---------------------------------------------------------------------------
--
-- Rows rather than code, because SPEC §2.3 promises "point your SDK at us and
-- map events to signals" — which is only true if adding a mapping is an INSERT.
--
-- `filters` is the same JSON shape the notification rules and charts already
-- use, so matching goes through OpenPanel's existing matchEvent() and there is
-- one filter semantics in the product instead of two.
CREATE TABLE "signal_rules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "filters" JSONB NOT NULL DEFAULT '[]',
    "signalKind" TEXT NOT NULL,
    "strength" INTEGER NOT NULL DEFAULT 50,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signal_rules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "signal_rules_projectId_enabled_idx"
    ON "signal_rules"("projectId", "enabled");

ALTER TABLE "signal_rules" ADD CONSTRAINT "signal_rules_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- signal_outbox
-- ---------------------------------------------------------------------------
--
-- The unique index on dedupeKey is the load-bearing constraint. It makes the
-- INSERT the idempotency point: a replayed worker job derives the identical key
-- from the same event, the insert conflicts, and the signal is not queued
-- twice. The same key is sent to gtmsrv, whose own unique index then agrees
-- with this one about what "the same event" means — so a delivery retried after
-- an ambiguous failure is safe rather than a second signal.
--
-- Without it, a retry on the outreach path is a second email to a real person.
CREATE TABLE "signal_outbox" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "projectId" TEXT NOT NULL,
    "ruleId" UUID,
    "ruleName" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "strength" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "subjectKind" TEXT,
    "subjectId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signal_outbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "signal_outbox_dedupeKey_key" ON "signal_outbox"("dedupeKey");

-- The drain's only query: pending work that is due.
CREATE INDEX "signal_outbox_status_nextAttemptAt_idx"
    ON "signal_outbox"("status", "nextAttemptAt");

CREATE INDEX "signal_outbox_projectId_createdAt_idx"
    ON "signal_outbox"("projectId", "createdAt");

-- ruleId is intentionally NOT a foreign key. A rule may be deleted; the record
-- that we already sent the signals it produced must outlive it.
