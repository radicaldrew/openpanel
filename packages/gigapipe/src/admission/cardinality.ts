/**
 * Per-project series-cardinality budget.
 *
 * The counting itself is delegated: this package stays dependency-free, and the
 * storage (a Redis HyperLogLog in `apps/api`) is an implementation detail that
 * a test can replace with a Set.
 *
 * WHY IT REJECTS RATHER THAN SAMPLES
 *
 * The tempting alternative — accept the data and drop the offending label — is
 * worse. It silently changes the meaning of a customer's metric, and it does so
 * invisibly, so the first they learn of it is a dashboard that stopped matching
 * their code. A rejection with a named offender is actionable; silent mutation
 * is not.
 *
 * WHY IT FAILS OPEN
 *
 * If the counter is unavailable, telemetry is accepted. The budget protects a
 * shared ClickHouse from slow growth over days; a Redis outage lasting minutes
 * cannot meaningfully damage it, whereas rejecting all telemetry during that
 * outage certainly damages the customer. The asymmetry is deliberate and is the
 * opposite of the tenancy checks, which always fail closed.
 */

export interface CardinalityCounter {
  /**
   * Record `keys` as observed for `projectId` and return the estimated number
   * of distinct series seen in the current window.
   *
   * Implementations may be approximate — a HyperLogLog's ~0.8% error is
   * irrelevant against a budget expressed in tens of thousands.
   */
  observe(projectId: string, keys: string[]): Promise<number>;
}

export interface CardinalityDecision {
  allowed: boolean;
  /** Estimated distinct series for this project in the current window. */
  estimated: number;
  limit: number;
  /**
   * A few offending series keys, for the rejection message and the log. Never
   * all of them — the point is to name the shape of the problem, and a runaway
   * label produces thousands.
   */
  sample: string[];
}

export const DEFAULT_SERIES_BUDGET = 100_000;

/** How many offending keys to surface. Enough to see the pattern. */
const SAMPLE_SIZE = 5;

export async function checkCardinalityBudget(
  projectId: string,
  keys: string[],
  counter: CardinalityCounter,
  limit: number = DEFAULT_SERIES_BUDGET,
): Promise<CardinalityDecision> {
  if (keys.length === 0) {
    return { allowed: true, estimated: 0, limit, sample: [] };
  }

  let estimated: number;
  try {
    estimated = await counter.observe(projectId, keys);
  } catch {
    // Fail open — see the header.
    return { allowed: true, estimated: 0, limit, sample: [] };
  }

  return {
    allowed: estimated <= limit,
    estimated,
    limit,
    sample: keys.slice(0, SAMPLE_SIZE),
  };
}

export class CardinalityBudgetExceededError extends Error {
  constructor(public readonly decision: CardinalityDecision) {
    super(
      `Series cardinality budget exceeded: ~${decision.estimated} distinct series against a limit of ${decision.limit}. ` +
        `Sample: ${decision.sample.join(', ')}`,
    );
    this.name = 'CardinalityBudgetExceededError';
  }
}
