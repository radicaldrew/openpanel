import type { ClickHouseClient } from '@clickhouse/client';
import { createClient } from '@clickhouse/client';
import { CLICKHOUSE_OPTIONS } from './client';

/**
 * A second ClickHouse client, bound to the database gigapipe writes telemetry
 * into.
 *
 * gigapipe and OpenPanel share one ClickHouse server and separate databases
 * (docs/observability/14-decisions.md D1). The default `ch` client is bound to
 * the analytics database; this one is bound to the telemetry database.
 *
 * SCOPE — this client is for metadata and housekeeping only:
 *   - enumerating metric names and label values for query-builder autocomplete
 *     (reading time_series_gin directly is far cheaper than gigapipe's label
 *     endpoints for this)
 *   - retention reconciliation and usage rollups
 *   - the GDPR erasure path
 *
 * It is NOT for reading samples. Metric, log and trace reads go through
 * gigapipe so that PromQL/LogQL semantics — rate, increase,
 * histogram_quantile, staleness, label matching — come from the engine that
 * implements them rather than being re-derived in SQL. The one exception the
 * plan makes is traces, which are read by direct SQL because gigapipe's Tempo
 * reader applies no tenant predicate at all; that path lives in its own module
 * and carries its own mandatory project predicate.
 *
 * Constructed lazily so that importing this module never requires
 * CLICKHOUSE_URL to be set — tests and codegen import the db package without a
 * live ClickHouse.
 */

export const TELEMETRY_DATABASE =
  process.env.CLICKHOUSE_TELEMETRY_DB || 'openpanel_telemetry';

/**
 * CLICKHOUSE_URL may be a comma-separated list; the analytics client
 * round-robins across it. This client issues a trickle of small metadata
 * queries, so it takes the first node and skips the round-robin machinery.
 */
function firstClickhouseUrl(): string | undefined {
  const raw = (process.env.CLICKHOUSE_URL ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const first = raw[0];
  if (!first) {
    return undefined;
  }

  // CLICKHOUSE_URL carries the analytics database in its path
  // (http://host:8123/openpanel), and @clickhouse/client lets that path OVERRIDE
  // the `database` option — silently, apart from a warning. Left in place, this
  // client would be bound to the analytics database while claiming to be bound
  // to the telemetry one, and any unqualified query would read the wrong
  // database. Strip the path so the explicit option is the only thing that
  // decides.
  try {
    const url = new URL(first);
    url.pathname = '/';
    url.search = '';
    return url.toString();
  } catch {
    // Not a parseable URL — hand it to the client unchanged and let it report.
    return first;
  }
}

let client: ClickHouseClient | undefined;

export function getTelemetryClickhouse(): ClickHouseClient {
  if (!client) {
    client = createClient({
      ...CLICKHOUSE_OPTIONS,
      url: firstClickhouseUrl(),
      database: TELEMETRY_DATABASE,
    });
  }

  return client;
}

/**
 * Qualify a gigapipe table name with the telemetry database.
 *
 * Use this — never `getReplicatedTableName` from ./client. That helper returns
 * `<table>_replicated ON CLUSTER '{cluster}'`, which is OpenPanel's own naming
 * convention for its own tables. gigapipe names its replicated tables by its
 * own convention, so applying OpenPanel's helper to a gigapipe table silently
 * targets a table that does not exist. Sharing one ClickHouse server makes
 * reaching for the existing helper feel natural, which is exactly why this
 * exists. See docs/observability/14-decisions.md D4.
 */
export function telemetryTable(name: string): string {
  return `${TELEMETRY_DATABASE}.${name}`;
}

export async function telemetryQuery<T>(query: string): Promise<T[]> {
  const res = await getTelemetryClickhouse().query({
    query,
    format: 'JSONEachRow',
  });

  return res.json<T>();
}

/** Used by the API healthcheck to report telemetry storage reachability. */
export async function pingTelemetryClickhouse(): Promise<boolean> {
  try {
    await telemetryQuery('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
