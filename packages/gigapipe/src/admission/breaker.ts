/**
 * A circuit breaker in front of gigapipe.
 *
 * Under the shared-ClickHouse topology (docs/observability/14-decisions.md D1),
 * a degraded telemetry backend is not just a telemetry problem: every in-flight
 * forward holds an event-loop slot and a socket in the same `apps/api` process
 * that serves `/track`. Without a breaker, a slow gigapipe converts into slow
 * analytics ingestion — the failure crosses from a feature nobody has adopted
 * yet into the product's hot path.
 *
 * So the breaker's job is not to protect gigapipe. It is to fail telemetry
 * FAST when gigapipe is unhealthy, so the process stops queueing work it cannot
 * finish.
 *
 * States:
 *   closed    — forwarding normally.
 *   open      — recent failures crossed the threshold; reject immediately
 *               without a network call, until the cooldown elapses.
 *   half_open — cooldown elapsed; allow ONE probe through. Success closes the
 *               breaker, failure re-opens it for another cooldown.
 *
 * Deliberately per-process and in-memory. A shared breaker in Redis would add a
 * round trip to the path whose whole purpose is to avoid waiting on the
 * network, and each API process observes its own connectivity anyway.
 */

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface BreakerOptions {
  /** Consecutive failures before opening. */
  failureThreshold?: number;
  /** How long to stay open before allowing a probe, in ms. */
  cooldownMs?: number;
  /** Injectable clock — tests must not sleep, and `Date.now` is not stubbable here. */
  now?: () => number;
}

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_COOLDOWN_MS = 10_000;

export class CircuitOpenError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super('Telemetry backend circuit is open');
    this.name = 'CircuitOpenError';
  }
}

export class CircuitBreaker {
  private consecutiveFailures = 0;
  private openedAt: number | undefined;
  private probeInFlight = false;

  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(options: BreakerOptions = {}) {
    this.failureThreshold =
      options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.now = options.now ?? (() => Date.now());
  }

  get state(): BreakerState {
    if (this.openedAt === undefined) {
      return 'closed';
    }

    if (this.now() - this.openedAt >= this.cooldownMs) {
      return 'half_open';
    }

    return 'open';
  }

  /** ms until the next probe is allowed; 0 when a call may proceed now. */
  retryAfterMs(): number {
    if (this.openedAt === undefined) {
      return 0;
    }

    return Math.max(0, this.cooldownMs - (this.now() - this.openedAt));
  }

  /**
   * Run `fn` through the breaker.
   *
   * In `half_open`, exactly one call is admitted; concurrent callers are
   * rejected rather than queued. Queueing them would rebuild the pile-up the
   * breaker exists to prevent, right at the moment the backend is least able to
   * absorb it.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.state;

    if (state === 'open') {
      throw new CircuitOpenError(this.retryAfterMs());
    }

    if (state === 'half_open') {
      if (this.probeInFlight) {
        throw new CircuitOpenError(this.retryAfterMs());
      }
      this.probeInFlight = true;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    } finally {
      this.probeInFlight = false;
    }
  }

  private onSuccess(): void {
    this.consecutiveFailures = 0;
    this.openedAt = undefined;
  }

  private onFailure(): void {
    this.consecutiveFailures += 1;

    if (this.consecutiveFailures >= this.failureThreshold) {
      // Re-stamp on every failure at or past the threshold, so a failing probe
      // in half_open restarts the cooldown instead of leaving the breaker
      // permanently probe-able.
      this.openedAt = this.now();
    }
  }

  /** Test and diagnostic aid. */
  reset(): void {
    this.consecutiveFailures = 0;
    this.openedAt = undefined;
    this.probeInFlight = false;
  }
}
