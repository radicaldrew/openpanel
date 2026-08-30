import {
  CircuitBreaker,
  DEFAULT_SERIES_BUDGET,
  type CardinalityCounter,
} from '@openpanel/gigapipe';
import { getRedisCache } from '@openpanel/redis';

/**
 * Admission controls for the telemetry ingest path.
 *
 * Both exist because of the shared-ClickHouse topology
 * (docs/observability/14-decisions.md D1): telemetry that misbehaves does not
 * only damage telemetry, it damages the analytics product sharing the server
 * and the event loop.
 */

/**
 * One breaker per process, shared across projects.
 *
 * Not per-project on purpose. The failure it detects — gigapipe unreachable or
 * timing out — is a property of the backend, not of any tenant, and a per-tenant
 * breaker would need every tenant to independently discover the outage before
 * anything stopped hammering it.
 */
export const gigapipeBreaker = new CircuitBreaker({
  failureThreshold: 5,
  cooldownMs: 10_000,
});

/**
 * Series-cardinality counter backed by a Redis HyperLogLog.
 *
 * HLL rather than a set: a set of a runaway project's series keys is exactly
 * the unbounded memory growth the budget exists to prevent, moved from
 * ClickHouse into Redis. HLL is fixed-size (~12KB) per project per window and
 * its ~0.8% error is irrelevant against a limit in the tens of thousands.
 *
 * The window is a rolling UTC day. A project that trips the budget therefore
 * recovers on its own once the offending series stop arriving, rather than
 * needing an operator to clear state.
 */
export function createCardinalityCounter(): CardinalityCounter {
  return {
    async observe(projectId: string, keys: string[]): Promise<number> {
      const redis = getRedisCache();
      const day = new Date().toISOString().slice(0, 10);
      const key = `telemetry:cardinality:${projectId}:${day}`;

      const [, count] = (await redis
        .multi()
        .pfadd(key, ...keys)
        // Two days, so the current window always outlives its own writes even
        // across a UTC boundary.
        .pfcount(key)
        .expire(key, 60 * 60 * 48)
        .exec()) as [unknown, [Error | null, number]];

      return count?.[1] ?? 0;
    },
  };
}

export const cardinalityCounter = createCardinalityCounter();

/**
 * Per-project series budget.
 *
 * A single number for now. When plans grow a telemetry tier this reads from the
 * organization's subscription instead; the call site does not change.
 */
export function seriesBudgetFor(_projectId: string): number {
  const configured = process.env.TELEMETRY_SERIES_BUDGET;
  if (configured) {
    const parsed = Number.parseInt(configured, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return DEFAULT_SERIES_BUDGET;
}
