/**
 * The two operator actions on a parked backlog.
 *
 * Parked rows never move on their own — that is the design, not an omission —
 * so what is worth asserting is that releasing preserves what makes a stale
 * backlog safe to deliver, and that both actions report the age of what they
 * are about to act on.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMock } = vi.hoisted(() => ({
  dbMock: {
    signalOutbox: {
      count: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock('../prisma-client', () => ({ db: dbMock }));

const { discardPausedSignals, pausedSignals, releasePausedSignals } =
  await import('./signal-outbox.service');

const oldest = new Date('2026-08-28T09:00:00.000Z');
const newest = new Date('2026-09-04T09:00:00.000Z');

function parked(count: number) {
  dbMock.signalOutbox.count.mockResolvedValue(count);
  dbMock.signalOutbox.findFirst
    .mockResolvedValueOnce(count ? { occurredAt: oldest } : null)
    .mockResolvedValueOnce(count ? { occurredAt: newest } : null);
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.signalOutbox.updateMany.mockResolvedValue({ count: 0 });
});

describe('pausedSignals', () => {
  it('reports how much is parked and how old it is', async () => {
    // "Release 400 signals" and "release 400 signals dated last Tuesday" are
    // different operations to be about to perform.
    parked(400);
    expect(await pausedSignals()).toEqual({
      count: 400,
      oldestOccurredAt: oldest,
      newestOccurredAt: newest,
    });
  });

  it('scopes to a project when asked', async () => {
    parked(1);
    await pausedSignals('proj_1');
    expect(dbMock.signalOutbox.count).toHaveBeenCalledWith({
      where: { status: 'paused', projectId: 'proj_1' },
    });
  });
});

describe('releasePausedSignals', () => {
  it('puts parked rows back on the queue, due immediately', async () => {
    parked(3);
    const summary = await releasePausedSignals();

    expect(summary.count).toBe(3);
    const call = dbMock.signalOutbox.updateMany.mock.calls[0]![0];
    expect(call.where).toEqual({ status: 'paused' });
    expect(call.data.status).toBe('pending');
    expect(call.data.nextAttemptAt).toBeInstanceOf(Date);
  });

  it('leaves attempts untouched, because a pause consumed none', async () => {
    parked(3);
    await releasePausedSignals();
    expect(
      dbMock.signalOutbox.updateMany.mock.calls[0]![0].data.attempts
    ).toBeUndefined();
  });

  it('does not touch occurredAt', async () => {
    // The released signals are hours or days old and must say so. gtmsrv stamps
    // the event time from occurred_at, so a play reading recency sees a
    // week-old page view as a week old rather than as a burst of fresh
    // activity.
    parked(3);
    await releasePausedSignals();
    expect(
      dbMock.signalOutbox.updateMany.mock.calls[0]![0].data.occurredAt
    ).toBeUndefined();
  });

  it('reports the age of what it released', async () => {
    parked(3);
    const summary = await releasePausedSignals();
    expect(summary.oldestOccurredAt).toEqual(oldest);
    expect(summary.newestOccurredAt).toEqual(newest);
  });

  it('does nothing when nothing is parked', async () => {
    parked(0);
    expect((await releasePausedSignals()).count).toBe(0);
    expect(dbMock.signalOutbox.updateMany).not.toHaveBeenCalled();
  });
});

describe('discardPausedSignals', () => {
  it('abandons rather than deletes, so the decision stays answerable', async () => {
    parked(5);
    const summary = await discardPausedSignals();

    expect(summary.count).toBe(5);
    const call = dbMock.signalOutbox.updateMany.mock.calls[0]![0];
    expect(call.data.status).toBe('abandoned');
    expect(call.data.lastError).toContain('operator');
  });

  it('records a supplied reason over the 403 that parked them', async () => {
    parked(5);
    await discardPausedSignals(undefined, 'producer was emitting test data');
    expect(dbMock.signalOutbox.updateMany.mock.calls[0]![0].data.lastError).toBe(
      'producer was emitting test data'
    );
  });

  it('does nothing when nothing is parked', async () => {
    parked(0);
    expect((await discardPausedSignals()).count).toBe(0);
    expect(dbMock.signalOutbox.updateMany).not.toHaveBeenCalled();
  });
});
