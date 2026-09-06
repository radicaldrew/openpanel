/**
 * Operator actions on a parked signal backlog.
 *
 * When gtmsrv reports a source disabled (403), the delivery job parks the rows
 * rather than retrying or abandoning them — see PAUSED_STATUS in
 * apps/worker/src/jobs/cron.signal-outbox.ts for why. Parked rows never move on
 * their own. These are the two ways they move, and both are somebody deciding.
 */

import { db } from '../prisma-client';

export interface PausedSummary {
  count: number;
  /** Oldest and newest event times in the parked set. Null when empty. */
  oldestOccurredAt: Date | null;
  newestOccurredAt: Date | null;
}

/**
 * What is parked, and how old it is.
 *
 * The age range is the point, not decoration. Releasing a backlog that has been
 * parked for a week means delivering signals dated last week, and "release 400
 * signals" and "release 400 signals, oldest dated last Tuesday" are different
 * operations to be about to perform. Whoever is about to press the button
 * should see which one it is.
 */
export async function pausedSignals(projectId?: string): Promise<PausedSummary> {
  const where = { status: 'paused', ...(projectId ? { projectId } : {}) };
  const [count, oldest, newest] = await Promise.all([
    db.signalOutbox.count({ where }),
    db.signalOutbox.findFirst({ where, orderBy: { occurredAt: 'asc' }, select: { occurredAt: true } }),
    db.signalOutbox.findFirst({ where, orderBy: { occurredAt: 'desc' }, select: { occurredAt: true } }),
  ]);
  return {
    count,
    oldestOccurredAt: oldest?.occurredAt ?? null,
    newestOccurredAt: newest?.occurredAt ?? null,
  };
}

/**
 * Put parked signals back on the delivery queue.
 *
 * Call after re-enabling the source in gtmsrv. Nothing observes that enable and
 * nothing should, so do not wire this to fire on it.
 *
 * The reason is not the dependency direction, though that is also true — it is
 * that re-enabling a source means "accept new signals", which is NOT the same
 * as "deliver everything queued while it was off". The two differ in exactly
 * the case parking exists for: somebody disables a producer because it is
 * emitting nonsense, fixes it, and re-enables it. An automatic release would
 * deliver the nonsense. That would be the code making the same guess parking
 * refused to make, one step later.
 *
 * So the release is the operator saying which of the two situations it was, at
 * the moment they actually know.
 *
 * `attempts` is left alone. A pause consumed none, so a row released after a
 * week has the same retry budget it had before, and a genuine delivery failure
 * afterwards still gets its full run of backoff.
 *
 * Released signals carry their original `occurred_at`, so gtmsrv stamps each
 * one with when the event happened rather than when it was released. A play
 * reading recency sees the truth — that a week-old page view is a week old —
 * instead of a burst of apparently-fresh activity.
 *
 * Returns what was released, and how old it was.
 */
export async function releasePausedSignals(projectId?: string): Promise<PausedSummary> {
  // Summarised before the update, because afterwards there is nothing parked
  // left to describe.
  const summary = await pausedSignals(projectId);
  if (summary.count === 0) {
    return summary;
  }
  await db.signalOutbox.updateMany({
    where: { status: 'paused', ...(projectId ? { projectId } : {}) },
    data: { status: 'pending', nextAttemptAt: new Date(), lastError: null },
  });
  return summary;
}

/**
 * Drop parked signals without delivering them.
 *
 * The other intent behind disabling a source: the producer was emitting
 * nonsense, and releasing the backlog later would deliver the nonsense.
 *
 * Marked abandoned rather than deleted, so "what did we decide not to send, and
 * why" stays answerable. The reason is recorded over the 403 that parked them,
 * because a human discarding a backlog is a better explanation than the status
 * code that stopped it.
 */
export async function discardPausedSignals(
  projectId?: string,
  reason = 'discarded by an operator while the source was disabled'
): Promise<PausedSummary> {
  const summary = await pausedSignals(projectId);
  if (summary.count === 0) {
    return summary;
  }
  await db.signalOutbox.updateMany({
    where: { status: 'paused', ...(projectId ? { projectId } : {}) },
    data: { status: 'abandoned', lastError: reason },
  });
  return summary;
}
