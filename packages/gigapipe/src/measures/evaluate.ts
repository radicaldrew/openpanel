/**
 * The measure evaluator: pure, and therefore testable without gigapipe or
 * gtmsrv.
 *
 * One evaluation of one rule takes the observed series, the state from last
 * time, and the clock, and returns the signals to raise and the state to store.
 * Nothing here performs I/O — the cron job queries, POSTs, and persists, which
 * is what lets "a condition true for ten consecutive evaluations emits exactly
 * one signal" be a test with no network in it.
 */

import type { SeriesState } from '../alerts/state-machine';
import { stepSeries } from '../alerts/state-machine';
import type { EpisodeState } from './episode';
import { stepEpisode } from './episode';
import type { MeasureRule } from './rule';
import {
  fingerprintOf,
  periodSecondsOf,
  reArmSecondsOf,
  strengthOf,
} from './rule';

/** Everything remembered about one series of one rule, between evaluations. */
export interface MeasureSeriesState {
  alert: SeriesState;
  episode?: EpisodeState;
}

/** One series as gigapipe returned it. */
export interface SeriesObservation {
  /** Stable identity within the rule: the sorted label set. */
  seriesKey: string;
  labels: Record<string, string>;
  /** The latest value with data, or undefined when the series returned none. */
  value: number | undefined;
}

/** A signal to POST to gtmsrv. Shaped to that contract, not to ours. */
export interface MeasureEmission {
  ruleId: string;
  seriesKey: string;
  kind: string;
  dedupeKey: string;
  strength: number;
  subject: { kind: string; id: string };
  evidence: Record<string, unknown>;
  /** RFC 3339. The episode's opening, not this evaluation. */
  occurredAt: string;
}

export interface SeriesOutcome {
  seriesKey: string;
  state: MeasureSeriesState;
  emission?: MeasureEmission;
  /** Set when the series produced nothing, with the reason. Never silent. */
  skipped?: string;
}

export interface EvaluateInput {
  rule: MeasureRule;
  observations: SeriesObservation[];
  /** State from the last evaluation, keyed by seriesKey. */
  previous: Map<string, MeasureSeriesState>;
  /** Evaluation time, epoch ms. */
  at: number;
}

export interface EvaluateResult {
  outcomes: SeriesOutcome[];
  /** Convenience view: the outcomes that produced a signal. */
  emissions: MeasureEmission[];
}

export function evaluateRule(input: EvaluateInput): EvaluateResult {
  const { rule, observations, previous, at } = input;

  const fingerprint = fingerprintOf(rule);
  const periodSeconds = periodSecondsOf(rule);
  const reArmSeconds = reArmSecondsOf(rule);

  const outcomes: SeriesOutcome[] = [];

  for (const observation of observations) {
    const prior = previous.get(observation.seriesKey);

    const stepped = stepSeries({
      previous: prior?.alert,
      value: observation.value,
      at,
      periodSeconds,
      config: {
        operator: rule.operator,
        threshold: rule.threshold,
        forSeconds: rule.forSeconds,
        // The alert machine's re-notification is not this evaluator's
        // mechanism: episodes decide what is raised, and a cooldown of zero
        // here would produce a `refire` on every tick that stepEpisode then
        // discards. Effectively infinite keeps the transitions readable.
        cooldownSeconds: Number.MAX_SAFE_INTEGER / 1000,
      },
    });

    // A series that cannot name somebody raises nothing. gtmsrv would accept a
    // subjectless signal and it would open no lead and match no play, so it
    // would be work that looks done and is not.
    const subjectId = observation.labels[rule.subject.fromLabel]?.trim();
    if (!subjectId) {
      outcomes.push({
        seriesKey: observation.seriesKey,
        // The alert state still advances: it is about the metric, not about
        // whether we can address anyone, and letting it go stale here would
        // make the series fire spuriously if the label later appears.
        state: { alert: stepped.state, episode: prior?.episode },
        skipped: `no ${rule.subject.fromLabel} label on this series, so there is nobody to open a lead for`,
      });
      continue;
    }

    const decision = stepEpisode({
      ruleId: rule.id,
      seriesKey: observation.seriesKey,
      fingerprint,
      transition: stepped.transition,
      firing: stepped.state.state === 'firing',
      previous: prior?.episode,
      at,
      reArmSeconds,
    });

    if (decision.kind === 'emit') {
      outcomes.push({
        seriesKey: observation.seriesKey,
        state: { alert: stepped.state, episode: decision.episode },
        emission: {
          ruleId: rule.id,
          seriesKey: observation.seriesKey,
          kind: rule.signalKind,
          dedupeKey: decision.dedupeKey,
          strength: strengthOf(rule),
          subject: { kind: rule.subject.kind, id: subjectId },
          evidence: evidenceFor(rule, observation, decision.openedAt),
          // When the condition became true, not when this tick noticed it. The
          // ingest contract is explicit that a late evaluation must not date a
          // signal late, because SPEC §6's follow-up counts from the event.
          occurredAt: new Date(decision.openedAt).toISOString(),
        },
      });
      continue;
    }

    outcomes.push({
      seriesKey: observation.seriesKey,
      state: { alert: stepped.state, episode: decision.episode },
    });
  }

  return {
    outcomes,
    emissions: outcomes
      .map((o) => o.emission)
      .filter((e): e is MeasureEmission => e !== undefined),
  };
}

/**
 * What the signal carries.
 *
 * Every label goes in, not just the one that resolved the subject: gtmsrv may
 * be able to identify the lead better than we can, and a label dropped here is
 * one it can never see.
 */
function evidenceFor(
  rule: MeasureRule,
  observation: SeriesObservation,
  openedAt: number
): Record<string, unknown> {
  return {
    rule: rule.name,
    rule_id: rule.id,
    measure: rule.promql,
    value: observation.value ?? null,
    threshold: rule.threshold,
    operator: rule.operator,
    for_seconds: rule.forSeconds,
    labels: observation.labels,
    series: observation.seriesKey,
    // Said plainly, because the reader of a lead timeline is a marketer: this
    // is a measure that crossed, not something the customer did.
    condition: `${rule.promql} ${rule.operator} ${rule.threshold} held for ${rule.forSeconds}s`,
    opened_at: new Date(openedAt).toISOString(),
  };
}

/** Stable identity for a series within a rule: its sorted label set. */
export function seriesKeyOf(
  labels: Record<string, string> | undefined
): string {
  if (!labels || Object.keys(labels).length === 0) {
    return '__all__';
  }
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
}
