import { getRedisCache } from '@openpanel/redis';

/**
 * Per-project telemetry quota.
 *
 * Separate from the cardinality budget, which guards ClickHouse's *shape* (how
 * many distinct series exist). This guards its *volume* — how many bytes a
 * project may push in a billing period.
 *
 * Both fail open, and for the same reason: they protect against slow growth
 * over days, so a Redis outage lasting minutes cannot meaningfully damage
 * anything, while rejecting a customer's telemetry certainly damages them. The
 * tenancy checks are the opposite and always fail closed.
 */

/** Counter period. Calendar month, matching how billing periods are described. */
function currentPeriod(now: Date): string {
  return now.toISOString().slice(0, 7); // YYYY-MM
}

function usageKey(projectId: string, period: string): string {
  return `telemetry:quota:${projectId}:${period}`;
}

export interface QuotaDecision {
  allowed: boolean;
  usedBytes: number;
  limitBytes: number | null;
  /** Fraction of the limit consumed, or null when unlimited. */
  ratio: number | null;
}

/**
 * Resolve a project's byte limit.
 *
 * A single env-configured number for now. When plans grow a telemetry tier this
 * reads the organization's subscription instead; the call site does not change.
 * `null` means unlimited, which is the correct default for self-hosted — an
 * operator running their own ClickHouse does not need OpenPanel rationing it.
 */
export function telemetryLimitBytes(): number | null {
  const configured = process.env.TELEMETRY_QUOTA_BYTES;
  if (!configured) {
    return null;
  }

  const parsed = Number.parseInt(configured, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Record usage and decide whether the project may continue.
 *
 * The increment happens BEFORE the decision, deliberately: a request that tips
 * a project over its limit is still accepted, and the next one is refused. The
 * alternative — checking first, then incrementing — refuses a request whose
 * size pushed it over, which means the customer is charged the rejection for
 * bytes we never stored.
 */
export async function checkTelemetryQuota(
  projectId: string,
  bytes: number,
  now: Date = new Date(),
): Promise<QuotaDecision> {
  const limitBytes = telemetryLimitBytes();

  if (limitBytes === null) {
    return { allowed: true, usedBytes: 0, limitBytes: null, ratio: null };
  }

  try {
    const redis = getRedisCache();
    const period = currentPeriod(now);
    const key = usageKey(projectId, period);

    const usedBytes = await redis.incrby(key, bytes);
    // Two periods of slack, so the current month always outlives its own writes.
    await redis.expire(key, 60 * 60 * 24 * 62);

    return {
      allowed: usedBytes <= limitBytes,
      usedBytes,
      limitBytes,
      ratio: usedBytes / limitBytes,
    };
  } catch {
    // Fail open — see the header.
    return { allowed: true, usedBytes: 0, limitBytes, ratio: null };
  }
}

/** Read usage without recording any, for the billing page. */
export async function getTelemetryUsage(
  projectId: string,
  now: Date = new Date(),
): Promise<{ usedBytes: number; limitBytes: number | null }> {
  const limitBytes = telemetryLimitBytes();

  try {
    const redis = getRedisCache();
    const raw = await redis.get(usageKey(projectId, currentPeriod(now)));
    return { usedBytes: raw ? Number.parseInt(raw, 10) : 0, limitBytes };
  } catch {
    return { usedBytes: 0, limitBytes };
  }
}
