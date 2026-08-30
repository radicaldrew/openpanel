import {
  TELEMETRY_DATABASE,
  getTelemetryClickhouse,
} from '../src/clickhouse/telemetry-client';
import { printBoxMessage } from './helpers';

/**
 * Per-signal retention for telemetry samples.
 *
 * WHY THIS NEEDS A PRE-CREATED TABLE
 *
 * gigapipe stores logs and metrics in one `samples_v3`, discriminated by a
 * `type` column, and creates the table with `ttl_only_drop_parts = 1` — which
 * drops whole PARTS and never individual rows. That setting is a large win
 * (dropping a part is a metadata operation; deleting rows rewrites parts at
 * every merge), and it makes a conditional `TTL … DELETE WHERE type = 1`
 * impossible on the table as gigapipe creates it.
 *
 * The only way to keep both is to put `type` in the PARTITION BY, so each
 * signal's rows live in their own parts and whole-part drops can apply a
 * different window per signal. That requires creating the table before gigapipe
 * does.
 *
 * VERIFIED, NOT ASSUMED
 *
 * Both halves were tested against a live gigapipe before this was written:
 *
 *   1. gigapipe boots cleanly against a `samples_v3` pre-created with `type` in
 *      the partition key — no `ctrl.Init` panic — and PRESERVES the partition
 *      key while applying its own TTL on top.
 *   2. ClickHouse accepts the two-clause conditional TTL alongside
 *      `ttl_only_drop_parts = 1`.
 *
 * THE COLUMN-ORDER CONTRACT
 *
 * `type` must be LAST. gigapipe adds it with `ALTER … ADD COLUMN` and then
 * `MODIFY ORDER BY`, and ClickHouse only permits `MODIFY ORDER BY` to reference
 * columns added by an `ADD COLUMN` in the same `ALTER`. A pre-created table
 * whose column order differs makes `ctrl.Init` panic and crash-loop the
 * container.
 *
 * IDEMPOTENCE
 *
 * `CREATE TABLE IF NOT EXISTS` means this is a no-op on any deployment where
 * gigapipe already created the table. Those keep the single-window retention
 * they have; converting an existing table would require rewriting every part,
 * which is not something a migration should do silently.
 */

/** Days each signal is kept. Metrics are cheap and want months; logs are not. */
const LOG_RETENTION_DAYS = Number.parseInt(
  process.env.TELEMETRY_LOG_RETENTION_DAYS || '14',
  10,
);
const METRIC_RETENTION_DAYS = Number.parseInt(
  process.env.TELEMETRY_METRIC_RETENTION_DAYS || '395',
  10,
);

/**
 * gigapipe's `samples_v3`, reproduced exactly except for the partition key.
 *
 * Column order and codecs match `ctrl/qryn/sql/log.sql`, with `type` last.
 */
const CREATE_SAMPLES = `
CREATE TABLE IF NOT EXISTS ${TELEMETRY_DATABASE}.samples_v3 (
  fingerprint UInt64,
  timestamp_ns Int64 CODEC(DoubleDelta),
  value Float64 CODEC(Gorilla),
  string String,
  type UInt8
) ENGINE = MergeTree
PARTITION BY (toStartOfDay(toDateTime(timestamp_ns / 1000000000)), type)
ORDER BY (timestamp_ns)
SETTINGS ttl_only_drop_parts = 1, merge_with_ttl_timeout = 3600`;

/**
 * `type != 1` rather than `type = 2`.
 *
 * The column is three-valued: 0 = UNDEF/both, 1 = LOG, 2 = METRIC. Writing
 * `type = 2` would leave any type-0 row with no TTL clause at all, and a row
 * matched by no clause is kept forever. OpenPanel's own ingest never emits 0,
 * but a row written by anything else pointed at the same backend would
 * accumulate silently.
 */
export const retentionTtlSql = (logDays: number, metricDays: number) => `
ALTER TABLE ${TELEMETRY_DATABASE}.samples_v3 MODIFY TTL
  toDateTime(timestamp_ns / 1000000000) + INTERVAL ${logDays} DAY DELETE WHERE type = 1,
  toDateTime(timestamp_ns / 1000000000) + INTERVAL ${metricDays} DAY DELETE WHERE type != 1
SETTINGS materialize_ttl_after_modify = 0`;

export async function up() {
  const client = getTelemetryClickhouse();

  printBoxMessage('📡 Telemetry retention', [
    `logs:    ${LOG_RETENTION_DAYS} days`,
    `metrics: ${METRIC_RETENTION_DAYS} days`,
    '',
    'Pre-creates samples_v3 with `type` in PARTITION BY so per-signal',
    'retention can work with ttl_only_drop_parts. No-op if gigapipe',
    'already created the table.',
  ]);

  await client.command({ query: CREATE_SAMPLES });

  // Only assert the conditional TTL when the partition key can support it —
  // on a table gigapipe already made, the two-clause TTL would force row-level
  // deletes and quietly turn ttl_only_drop_parts into a lie.
  const check = await client.query({
    query: `SELECT partition_key FROM system.tables
            WHERE database = '${TELEMETRY_DATABASE}' AND name = 'samples_v3'`,
    format: 'JSONEachRow',
  });

  const [row] = await check.json<{ partition_key: string }>();
  const partitionedByType = (row?.partition_key ?? '').includes('type');

  if (!partitionedByType) {
    printBoxMessage('⚠️  Single-window retention', [
      'samples_v3 is not partitioned by `type` — it already existed when this',
      'migration ran. Per-signal retention needs a partition key it cannot',
      'gain without rewriting every part, so retention stays as one window',
      'for all signals via gigapipe SAMPLES_DAYS.',
      '',
      'See docs/observability/14-decisions.md D15.',
    ]);
    return;
  }

  await client.command({
    query: retentionTtlSql(LOG_RETENTION_DAYS, METRIC_RETENTION_DAYS),
  });
}

export async function down() {
  throw new Error(
    'Refusing to revert telemetry retention — dropping the TTL would silently retain everything forever.',
  );
}
