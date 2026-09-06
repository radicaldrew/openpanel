/**
 * Measure rules: the half of SPEC §1.1 that turns a continuous metric into a
 * discrete signal.
 *
 * A measure never routes to a play. `mcp_calls == 0` is true at every instant
 * for as long as it is true, and a play is a thing that runs once. The rule is
 * what converts "this has been true for fourteen days" into one event that a
 * play can act on — which is why a measure rule is a threshold, a duration, and
 * the signal kind to raise, and why the hard part is emitting it exactly once.
 */

export type MeasureOperator = 'gt' | 'gte' | 'lt' | 'lte';

/**
 * How a metric series becomes somebody.
 *
 * A series is not a person. `mcp_calls{customer="acme"}` is a time series; the
 * signal it raises has to name a subject or it opens no lead and reaches no
 * play. So a rule must say which label carries the identity and what kind of
 * thing it identifies — and a series whose label is missing raises nothing.
 */
export interface SubjectMapping {
  kind: 'person' | 'company' | 'repo';
  /** The series label holding the id, e.g. `customer_id`. */
  fromLabel: string;
}

export interface MeasureRule {
  id: string;
  name: string;
  /** Scopes the query. gigapipe is multi-tenant by project label. */
  projectId: string;
  /** The PromQL to evaluate. */
  promql: string;

  operator: MeasureOperator;
  threshold: number;
  /**
   * How long the OBSERVED condition must hold before it counts, in seconds.
   *
   * This is not where a long window goes. SPEC §1.1's example reads
   * `mcp_calls == 0 for 14d`, and the fourteen days belong in the query —
   * `increase(mcp_calls_total[14d]) <= 0` — not here. The metric already
   * carries that history; the evaluator does not.
   *
   * The distinction is load-bearing. The alert state machine invalidates a
   * pending timer after three missed evaluation periods, because it will not
   * claim a condition held across time nobody watched. So a `forSeconds` of
   * fourteen days would require fourteen days of uninterrupted evaluation, and
   * one deploy, restart or backend blip would silently reset it to zero — a
   * rule that never fires and never says why. assertUsableRule refuses that
   * shape rather than letting it be discovered as silence.
   *
   * Set this to about one evaluation period: enough to shrug off a single bad
   * scrape, short enough to mature.
   */
  forSeconds: number;

  /** The signal raised when the condition first holds, e.g. `mcp_idle`. */
  signalKind: string;
  /** 0-100. Defaults to 100: a rule that fired is certain about itself. */
  strength?: number;

  subject: SubjectMapping;

  /** Evaluation cadence, seconds. Defaults to DEFAULT_PERIOD_SECONDS. */
  periodSeconds?: number;
  /**
   * How long the condition must STAY cleared before a recurrence counts as a
   * new episode. Defaults to defaultReArmSeconds(forSeconds).
   */
  reArmSeconds?: number;
  enabled?: boolean;
}

/** Fifteen minutes: the cadence the design problem was posed at. */
export const DEFAULT_PERIOD_SECONDS = 900;

/**
 * The floor on the re-arm window, and the number this whole design turns on.
 *
 * The question is "how long after the condition clears does a recurrence count
 * as new?", and it is a question about EPISODE IDENTITY, not about contact
 * frequency. How often a person may be contacted is gtmsrv's outreach cap; if
 * this tried to be that too, the two would disagree and the stricter one would
 * be a mystery.
 *
 * Both directions are real failures:
 *
 *   - Too short: a metric that flaps across the threshold opens a new episode
 *     on each crossing, each with its own dedupe key, each a fresh `mcp_idle`.
 *     Re-engage then emails a customer once a day for as long as they hover.
 *   - Too long: a customer who came back and genuinely went quiet again is
 *     inside the old episode, raises nothing, and is never picked up. That
 *     failure is silent, which makes it the worse one to debug.
 *
 * Twenty-four hours is the floor because a rule that raises a customer-facing
 * signal more than once a day is describing flapping rather than a new
 * condition. Rules with a longer `for` get their own duration instead: an
 * operator who said "fourteen days of silence means idle" has already stated
 * what a meaningful span is for that metric, and a shorter re-arm than their own
 * `for` would contradict them.
 */
export const MIN_RE_ARM_SECONDS = 24 * 60 * 60;

export function defaultReArmSeconds(forSeconds: number): number {
  return Math.max(forSeconds, MIN_RE_ARM_SECONDS);
}

export function periodSecondsOf(rule: MeasureRule): number {
  return rule.periodSeconds ?? DEFAULT_PERIOD_SECONDS;
}

export function reArmSecondsOf(rule: MeasureRule): number {
  return rule.reArmSeconds ?? defaultReArmSeconds(rule.forSeconds);
}

export function strengthOf(rule: MeasureRule): number {
  return rule.strength ?? 100;
}

/**
 * A fingerprint of what the rule actually asserts.
 *
 * Editing a threshold changes which condition is being described, so the
 * episode that was open under the old one is not the same episode. Without this
 * a rule loosened from `> 100` to `> 10` would stay inside its previous episode
 * and never raise the signal the edit was made to raise.
 */
export function fingerprintOf(rule: MeasureRule): string {
  return [
    rule.promql,
    rule.operator,
    String(rule.threshold),
    String(rule.forSeconds),
    rule.signalKind,
  ].join('|');
}

export class MeasureRuleError extends Error {}

/** Rejects a rule that could not raise a usable signal. */
export function assertUsableRule(rule: MeasureRule): void {
  if (!rule.promql.trim()) {
    throw new MeasureRuleError(`rule ${rule.id}: promql is required`);
  }
  if (!rule.signalKind.trim()) {
    throw new MeasureRuleError(`rule ${rule.id}: signalKind is required`);
  }
  if (!rule.subject?.fromLabel?.trim()) {
    // A rule with no subject mapping can only produce signals that open no
    // lead and reach no play. Refusing at configuration time beats discovering
    // it as silence.
    throw new MeasureRuleError(
      `rule ${rule.id}: subject.fromLabel is required — a signal with no subject opens no lead`
    );
  }
  if (rule.forSeconds < 0) {
    throw new MeasureRuleError(
      `rule ${rule.id}: forSeconds must not be negative`
    );
  }

  // The staleness guard in the alert state machine drops a pending timer after
  // three missed periods. A forSeconds beyond that can only mature if every
  // single evaluation in the span happened, so in practice it never fires —
  // and it fails by being silent, which is the hardest kind to notice.
  const maxFor = periodSecondsOf(rule) * STALENESS_PERIODS;
  if (rule.forSeconds > maxFor) {
    throw new MeasureRuleError(
      `rule ${rule.id}: forSeconds ${rule.forSeconds}s exceeds ${maxFor}s (${STALENESS_PERIODS} evaluation periods), ` +
        'so a single missed evaluation resets it and the rule would never fire. ' +
        `Put the window in the query instead — e.g. increase(metric[${humanDuration(rule.forSeconds)}]) — and set forSeconds to about one period.`
    );
  }
}

/**
 * Mirrors STALENESS_PERIODS in ../alerts/state-machine, which is private to
 * that module. Kept here as the number this validation is derived from; if the
 * machine's guard changes, this check has to change with it.
 */
const STALENESS_PERIODS = 3;

function humanDuration(seconds: number): string {
  if (seconds % 86_400 === 0) {
    return `${seconds / 86_400}d`;
  }
  if (seconds % 3600 === 0) {
    return `${seconds / 3600}h`;
  }
  if (seconds % 60 === 0) {
    return `${seconds / 60}m`;
  }
  return `${seconds}s`;
}
