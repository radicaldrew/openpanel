-- Named log and trace searches: the equivalent of a saved report for signals
-- that do not render as a chart.
--
-- `query` stores the STRUCTURED search, never a raw LogQL string. A saved raw
-- query would be a stored string that later gets compiled, which is precisely
-- the shape the tenancy design exists to avoid.
--
-- `kind` is plain text rather than an enum: a third signal would otherwise need
-- a two-step enum migration for no benefit.
CREATE TABLE "saved_telemetry_searches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "query" JSONB NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_telemetry_searches_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "saved_telemetry_searches_projectId_kind_idx"
    ON "saved_telemetry_searches"("projectId", "kind");

ALTER TABLE "saved_telemetry_searches"
    ADD CONSTRAINT "saved_telemetry_searches_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
