/**
 * The alert state machine.
 *
 * A pure function, deliberately. The evaluator calls it and so does the rule
 * editor's preview, which is the only way to guarantee the preview cannot drift
 * from what production will actually do — a preview that disagrees with the
 * alert is worse than no preview, because it is trusted.
 *
 * gigapipe cannot do any of this: its ruler evaluates RECORDING rules only, and
 * alerting rules may be stored but are never evaluated. So OpenPanel owns
 * evaluation. See docs/observability/14-decisions.md.
 */

export type AlertState = 'inactive' | 'pending' | 'firing';

export interface AlertConfig {
  operator: 'gt' | 'gte' | 'lt' | 'lte';
  threshold: number;
  /** How long the condition must hold before firing, in seconds. */
  forSeconds: number;
  /** How long after a notification before another may be sent, in seconds. */
  cooldownSeconds: number;
}

export interface SeriesState {
  state: AlertState;
  /** When the condition first became true, epoch ms. */
  pendingSince?: number;
  /** When this series last sent a notification, epoch ms. */
  lastNotifiedAt?: number;
  /** When the last successful evaluation happened, epoch ms. */
  lastEvaluatedAt?: number;
}

export type AlertTransition =
  | { kind: 'none' }
  | { kind: 'pending' }
  | { kind: 'fire'; value: number }
  | { kind: 'resolve' }
  /** Condition still true and past cooldown — re-notify. */
  | { kind: 'refire'; value: number };

export interface StepResult {
  state: SeriesState;
  transition: AlertTransition;
}

/**
 * A gap longer than this many evaluation periods invalidates the pending timer.
 *
 * Without it, a rule that stopped evaluating for an hour (worker down, backend
 * unreachable) would come back and immediately fire on a `for: 5m` condition,
 * because `now - pendingSince` exceeds the duration — even though nobody
 * observed the condition holding across that hour. The alert would be claiming
 * evidence it does not have.
 */
const STALENESS_PERIODS = 3;

function conditionHolds(value: number, config: AlertConfig): boolean {
  switch (config.operator) {
    case 'gt':
      return value > config.threshold;
    case 'gte':
      return value >= config.threshold;
    case 'lt':
      return value < config.threshold;
    case 'lte':
      return value <= config.threshold;
    default:
      return false;
  }
}

export interface StepInput {
  previous: SeriesState | undefined;
  /**
   * The observed value, or `undefined` when the series returned no data.
   *
   * Absent data is NOT treated as the condition being false. A series that
   * disappears because the service died would otherwise resolve its own alert
   * at exactly the moment it matters most. Absence holds the current state and
   * lets staleness handle it.
   */
  value: number | undefined;
  /** Evaluation time, epoch ms. Passed in so the function stays pure. */
  at: number;
  /** The rule's evaluation period in seconds, for the staleness window. */
  periodSeconds: number;
  config: AlertConfig;
}

export function stepSeries(input: StepInput): StepResult {
  const { previous, value, at, periodSeconds, config } = input;

  const prior: SeriesState = previous ?? { state: 'inactive' };

  // A long gap since the last successful evaluation means we cannot vouch for
  // the condition having held continuously. Drop the pending timer rather than
  // let it mature on unobserved time.
  const gapMs = prior.lastEvaluatedAt ? at - prior.lastEvaluatedAt : 0;
  const stale = gapMs > periodSeconds * STALENESS_PERIODS * 1000;

  if (value === undefined) {
    // No data: hold state, record that we looked. A missing series is not a
    // healthy one.
    return {
      state: { ...prior, lastEvaluatedAt: at },
      transition: { kind: 'none' },
    };
  }

  const holds = conditionHolds(value, config);

  if (!holds) {
    if (prior.state === 'firing') {
      return {
        state: {
          state: 'inactive',
          lastNotifiedAt: prior.lastNotifiedAt,
          lastEvaluatedAt: at,
        },
        transition: { kind: 'resolve' },
      };
    }

    // Pending that never matured, or already inactive — no notification either
    // way. Nobody was told it was pending, so nobody needs telling it stopped.
    return {
      state: {
        state: 'inactive',
        lastNotifiedAt: prior.lastNotifiedAt,
        lastEvaluatedAt: at,
      },
      transition: { kind: 'none' },
    };
  }

  // Condition holds.
  if (prior.state === 'firing') {
    const since = prior.lastNotifiedAt ?? 0;
    if (at - since >= config.cooldownSeconds * 1000) {
      return {
        state: { ...prior, lastNotifiedAt: at, lastEvaluatedAt: at },
        transition: { kind: 'refire', value },
      };
    }

    return {
      state: { ...prior, lastEvaluatedAt: at },
      transition: { kind: 'none' },
    };
  }

  const pendingSince =
    prior.state === 'pending' && prior.pendingSince !== undefined && !stale
      ? prior.pendingSince
      : at;

  if (at - pendingSince >= config.forSeconds * 1000) {
    return {
      state: {
        state: 'firing',
        pendingSince,
        lastNotifiedAt: at,
        lastEvaluatedAt: at,
      },
      transition: { kind: 'fire', value },
    };
  }

  return {
    state: {
      state: 'pending',
      pendingSince,
      lastNotifiedAt: prior.lastNotifiedAt,
      lastEvaluatedAt: at,
    },
    transition: prior.state === 'pending' ? { kind: 'none' } : { kind: 'pending' },
  };
}
