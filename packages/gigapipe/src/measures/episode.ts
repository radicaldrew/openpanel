/**
 * Condition episodes: the state that makes a measure emit once.
 *
 * A threshold rule evaluated every fifteen minutes finds the condition true
 * every fifteen minutes for as long as it holds. The naive evaluator therefore
 * raises `mcp_idle` ninety-six times a day, and because `mcp_idle` routes to
 * Re-engage, that is ninety-six attempts to email one customer.
 *
 * Idempotency downstream does not save you: gtmsrv dedupes on a key the CALLER
 * chooses, so a key derived from the evaluation tick makes every tick a new
 * signal and every one is honoured. The key has to identify the CONDITION
 * INSTANCE — the episode — and stay identical for as long as that episode
 * lasts.
 *
 * So this module owns two facts the state machine in ../alerts does not:
 * when the current episode opened, and whether its signal has actually been
 * accepted downstream. Everything here is pure; the caller does the I/O.
 */

import type { AlertTransition } from '../alerts/state-machine';

export interface EpisodeState {
  /**
   * When this episode opened, epoch ms. This is the anchor the dedupe key is
   * built from, so it must not move for the life of the episode.
   */
  openedAt: number;
  /**
   * When the condition last stopped holding, epoch ms. Set on resolve and kept,
   * because the re-arm window is measured from it. Absent while firing.
   */
  clearedAt?: number;
  /**
   * Whether the signal for this episode has been ACCEPTED by gtmsrv — not
   * merely attempted. A POST that failed leaves this false so the next
   * evaluation retries, and because the dedupe key is the episode's, a retry of
   * a request that actually succeeded is collapsed rather than doubled.
   */
  emitted: boolean;
  /** The rule fingerprint this episode opened under. */
  fingerprint: string;
}

export type EpisodeDecision =
  /** Raise the signal for this episode. */
  | { kind: 'emit'; episode: EpisodeState; dedupeKey: string; openedAt: number }
  /** Nothing to do — the common case, on every tick of a holding condition. */
  | { kind: 'hold'; episode?: EpisodeState }
  /** The condition cleared; the episode stays for the re-arm window. */
  | { kind: 'cleared'; episode: EpisodeState };

export interface EpisodeStepInput {
  ruleId: string;
  seriesKey: string;
  fingerprint: string;
  /** The transition the alert state machine just produced. */
  transition: AlertTransition;
  /**
   * Whether the condition is holding after this step.
   *
   * The transition alone is not enough. A rule edited while already firing
   * produces no transition at all — the machine was firing before and is firing
   * after — yet the episode must restart, because the condition being described
   * changed. The same is true after a state loss: the alert state survives, the
   * episode does not, and only the current state says the condition is live.
   */
  firing: boolean;
  previous: EpisodeState | undefined;
  /** Evaluation time, epoch ms. Passed in so this stays pure. */
  at: number;
  /** How long the condition must stay cleared for a recurrence to be new. */
  reArmSeconds: number;
}

/**
 * Advance the episode for one series.
 *
 * The rules, in the order they matter:
 *
 *  1. A `fire` inside the re-arm window after a clear is the SAME episode. The
 *     metric flapped; nothing new happened to the customer.
 *  2. A `fire` after the re-arm window, or with no prior episode, opens a new
 *     one and raises the signal.
 *  3. A `refire` — the alert machine's "still true, cooldown elapsed" — never
 *     raises anything here. Re-notification is right for an on-call human
 *     watching a dashboard and wrong for a signal that emails a customer.
 *  4. An episode whose signal was never accepted is retried on any tick while
 *     the condition still holds, with the same key.
 *  5. A fingerprint change ends the old episode: the rule now describes a
 *     different condition.
 */
export function stepEpisode(input: EpisodeStepInput): EpisodeDecision {
  const { transition, firing, previous, at, reArmSeconds, fingerprint } = input;

  // A rule edited to describe a different condition cannot continue an episode
  // opened under the old one — rule 5.
  const prior =
    previous && previous.fingerprint === fingerprint ? previous : undefined;

  if (transition.kind === 'resolve') {
    if (!prior) {
      return { kind: 'hold' };
    }
    // Keep openedAt: the re-arm window is what decides whether the next
    // crossing continues this episode or opens another.
    return { kind: 'cleared', episode: { ...prior, clearedAt: at } };
  }

  if (!firing) {
    // Pending, or inactive. Nothing has been claimed about this series yet.
    return { kind: 'hold', episode: prior };
  }

  // The condition is live. Either it belongs to the episode already open, or it
  // is a new one — and `refire` lands here too, which is exactly why it raises
  // nothing extra: re-notification suits an on-call human watching a dashboard
  // and is wrong for a signal that emails a customer.
  if (prior && continuesEpisode(prior, at, reArmSeconds)) {
    const resumed: EpisodeState = { ...prior, clearedAt: undefined };
    // Rule 4: an episode whose signal never landed is retried, with its own key.
    if (!resumed.emitted) {
      return emitFor(input, resumed);
    }
    return { kind: 'hold', episode: resumed };
  }

  return emitFor(input, { openedAt: at, emitted: false, fingerprint });
}

/**
 * Whether a new crossing belongs to the previous episode.
 *
 * An episode that never cleared always continues — the condition has been true
 * throughout, whatever the alert machine did in between.
 */
function continuesEpisode(
  prior: EpisodeState,
  at: number,
  reArmSeconds: number
): boolean {
  if (prior.clearedAt === undefined) {
    return true;
  }
  return at - prior.clearedAt < reArmSeconds * 1000;
}

function emitFor(
  input: EpisodeStepInput,
  episode: EpisodeState
): EpisodeDecision {
  return {
    kind: 'emit',
    episode,
    openedAt: episode.openedAt,
    dedupeKey: dedupeKeyFor(input.ruleId, input.seriesKey, episode.openedAt),
  };
}

/**
 * The dedupe key gtmsrv will collapse on.
 *
 * `<rule>/<series>/<episode opened at>` — the three things that identify one
 * condition instance. Stable for the life of the episode, different for the
 * next one, and identical across a retry of a failed POST.
 *
 * The series component is bounded: a pathological label set would otherwise
 * become an unbounded key in somebody else's database.
 */
export function dedupeKeyFor(
  ruleId: string,
  seriesKey: string,
  openedAt: number
): string {
  return `measure/${ruleId}/${boundSeriesKey(seriesKey)}/${openedAt}`;
}

const MAX_SERIES_KEY_CHARS = 160;

function boundSeriesKey(seriesKey: string): string {
  if (seriesKey.length <= MAX_SERIES_KEY_CHARS) {
    return seriesKey;
  }
  // Truncate, but keep it injective enough to matter: a cheap digest of the
  // whole key distinguishes two series that share a long prefix.
  return `${seriesKey.slice(0, MAX_SERIES_KEY_CHARS)}~${digest(seriesKey)}`;
}

/**
 * A polynomial rolling hash, modulo a large prime.
 *
 * Not a security hash and not trying to be: its only job is to keep two long
 * label sets that share a prefix from collapsing onto the same truncated key.
 */
function digest(value: string): string {
  const MODULUS = 2_147_483_647; // 2^31 - 1
  const BASE = 131;
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * BASE + value.charCodeAt(i)) % MODULUS;
  }
  return hash.toString(16).padStart(8, '0');
}
