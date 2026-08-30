-- Per-series state for metric alert rules.
--
-- One row per (rule, series): a rule's query legitimately returns many series —
-- one per route, per service — and each has to alert and resolve on its own.
-- Collapsing them would let one noisy route suppress every other route's alert.
--
-- `state` is a plain text column rather than an enum. Alert states are read and
-- written almost exclusively by the evaluator, and an enum here would mean a
-- two-step migration every time the state machine grows a state.
CREATE TABLE "metric_alert_states" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ruleId" UUID NOT NULL,
    "seriesKey" TEXT NOT NULL,
    "labels" JSONB NOT NULL,
    "state" TEXT NOT NULL,
    "pendingSince" TIMESTAMP(3),
    "lastNotifiedAt" TIMESTAMP(3),
    "lastEvaluatedAt" TIMESTAMP(3),
    "lastValue" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metric_alert_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "metric_alert_states_ruleId_seriesKey_key"
    ON "metric_alert_states"("ruleId", "seriesKey");

CREATE INDEX "metric_alert_states_ruleId_idx" ON "metric_alert_states"("ruleId");

ALTER TABLE "metric_alert_states"
    ADD CONSTRAINT "metric_alert_states_ruleId_fkey"
    FOREIGN KEY ("ruleId") REFERENCES "notification_rules"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
