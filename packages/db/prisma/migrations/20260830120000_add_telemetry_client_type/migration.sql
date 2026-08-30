-- Telemetry ingest credentials (OTLP metrics, Prometheus remote-write) reuse
-- the existing Client model rather than introducing a parallel token table, so
-- they inherit the settings UI, the Redis-cached lookup and secret hashing.
--
-- This must be its own migration: Postgres refuses to USE a new enum value in
-- the same transaction that added it ("unsafe use of new value ... of enum
-- type ClientType"). Nothing here writes the value.
ALTER TYPE "ClientType" ADD VALUE 'telemetry';
