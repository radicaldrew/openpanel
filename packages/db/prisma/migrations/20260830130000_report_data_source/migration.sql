-- A report can now be backed by server telemetry instead of analytics events.
--
-- `dataSource` defaults to 'events', so every existing row is correct as written
-- and no backfill runs. `metricQuery` is null for event reports.
--
-- Unlike the ClientType change, a brand-new enum type can be created and used in
-- the same transaction — the "unsafe use of new value" restriction applies only
-- to values added to an EXISTING type.
CREATE TYPE "ReportDataSource" AS ENUM ('events', 'metrics');

ALTER TABLE "reports"
  ADD COLUMN "dataSource" "ReportDataSource" NOT NULL DEFAULT 'events',
  ADD COLUMN "metricQuery" JSONB;
