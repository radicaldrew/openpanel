import { isClickhouseClustered } from '../src/clickhouse/client';
import {
  createDatabase,
  runClickhouseMigrationCommands,
} from '../src/clickhouse/migration';
import { getIsCluster, printBoxMessage } from './helpers';

/**
 * Creates the database gigapipe stores telemetry in.
 *
 * This migration creates the DATABASE and nothing else. gigapipe owns every
 * table inside it: it runs its own DDL from ctrl/qryn/sql/*.sql on each boot
 * and re-asserts TTLs via ctrl.Rotate every time it starts. Pre-creating its
 * tables from here is possible — it is how you would get `type` into
 * samples_v3's PARTITION BY for cheap per-signal retention — but it is a
 * one-way door and a standing compatibility contract with gigapipe's schema:
 * ClickHouse's MODIFY ORDER BY only accepts columns added by an ADD COLUMN in
 * the same ALTER, so a pre-created table whose column order differs from
 * gigapipe's makes ctrl.Init panic and crash-loop the container.
 *
 * We do not need that door open yet. Per-signal retention only matters once
 * logs ship (P3) and logs and metrics want different windows; until then a
 * single SAMPLES_DAYS covers it. See docs/observability/14-decisions.md D7 —
 * the decision is deliberately deferred to P3, when there is real data and a
 * spike result to decide it from.
 *
 * On the cluster guard below: OpenPanel currently answers "is this ClickHouse
 * clustered?" two different ways with two different defaults, and gigapipe
 * inherits whichever is wrong. See D2 in the same document.
 */

export const TELEMETRY_DATABASE =
  process.env.CLICKHOUSE_TELEMETRY_DB || 'openpanel_telemetry';

/**
 * `getIsCluster()` (migrations) defaults to FALSE when nothing is set;
 * `isClickhouseClustered()` (runtime) defaults to TRUE unless SELF_HOSTED.
 * On a deployment that sets neither, the migration path builds non-clustered
 * tables while the runtime believes the opposite — and gigapipe, pointed at
 * the same server, would create unreplicated local tables on one node of a
 * replicated cluster: lost on node failure, invisible to reads that land on
 * another replica.
 *
 * Rather than pick a side silently, refuse to provision telemetry until the
 * deployment has said which it is. Setting CLICKHOUSE_CLUSTER (or SELF_HOSTED)
 * makes both helpers agree, and is a one-line fix.
 */
function assertClusterModeIsUnambiguous() {
  const migrationView = getIsCluster();
  const runtimeView = isClickhouseClustered();

  if (migrationView === runtimeView) {
    return;
  }

  printBoxMessage('❌  Ambiguous ClickHouse cluster mode  ❌', [
    `getIsCluster() (migrations) says:      ${migrationView}`,
    `isClickhouseClustered() (runtime) says: ${runtimeView}`,
    '',
    'These disagree, so gigapipe would be provisioned against a cluster',
    'shape that half of OpenPanel does not believe in.',
    '',
    'Set ONE of these explicitly and re-run:',
    '  CLICKHOUSE_CLUSTER=true   — this ClickHouse is a replicated cluster',
    '  CLICKHOUSE_CLUSTER=false  — single node (also implied by SELF_HOSTED)',
    '',
    'See docs/observability/14-decisions.md D2.',
  ]);

  throw new Error(
    'Refusing to create the telemetry database while cluster mode is ambiguous. ' +
      'Set CLICKHOUSE_CLUSTER explicitly (see docs/observability/14-decisions.md D2).',
  );
}

export async function up() {
  assertClusterModeIsUnambiguous();

  const isClustered = getIsCluster();

  printBoxMessage('📡 Telemetry database', [
    `name:      ${TELEMETRY_DATABASE}`,
    `clustered: ${isClustered}`,
    '',
    'Creating the database only — gigapipe owns the tables inside it.',
  ]);

  await runClickhouseMigrationCommands([
    createDatabase(TELEMETRY_DATABASE, isClustered),
  ]);
}

/**
 * Deliberately not implemented. Dropping this database destroys every metric,
 * log and trace stored in it, and a migration runner is the wrong place for
 * that to be one command away. Drop it by hand if you mean it.
 */
export async function down() {
  throw new Error(
    `Refusing to drop ${TELEMETRY_DATABASE} — it holds all telemetry. Drop it manually if intended.`,
  );
}
