/**
 * The SEO schedulers, with no DataForSEO and no queue.
 *
 * The property worth protecting is that a due project is claimed exactly
 * once and its pointer advanced before any work is enqueued — the
 * conditional updateMany is the only thing keeping two overlapping ticks
 * from double-running a project, and the spend cap must stop a scheduled run
 * without stopping the scheduler.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const DAY_MS = 24 * 60 * 60 * 1000;

const { dbMock, queueMock, flushMock, refreshMock, capMock, defaultKeyMock } = vi.hoisted(
  () => ({
    dbMock: {
      seoProjectConfig: { findMany: vi.fn(), updateMany: vi.fn() },
      seoTrackedKeyword: { count: vi.fn(), groupBy: vi.fn(), findMany: vi.fn() },
      seoRankRun: { create: vi.fn() },
      dataForSeoConnection: { findMany: vi.fn(), updateMany: vi.fn() },
      project: { findUnique: vi.fn() },
    },
    queueMock: { add: vi.fn() },
    flushMock: vi.fn(),
    refreshMock: vi.fn(),
    capMock: vi.fn(),
    defaultKeyMock: vi.fn(),
  })
);

vi.mock('@openpanel/db', () => ({
  db: dbMock,
  flushSpendToPostgres: flushMock,
  refreshDfsBalance: refreshMock,
  isDfsSpendCapReached: capMock,
  hasDefaultDfsKey: defaultKeyMock,
  computeNextRunAt: (schedule: string, from: Date) =>
    schedule === 'daily'
      ? new Date(from.getTime() + DAY_MS)
      : schedule === 'weekly'
        ? new Date(from.getTime() + 7 * DAY_MS)
        : null,
}));
vi.mock('@openpanel/queue', () => ({ seoQueue: queueMock }));
vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const {
  isoWeekKey,
  seoBacklinkSchedulerJob,
  seoBalanceRefreshJob,
  seoMetricsRefreshJob,
  seoRankSchedulerJob,
  seoSpendResetJob,
} = await import('./seo.cron');

const dueRank = {
  projectId: 'p1',
  rankSchedule: 'daily',
  project: { organizationId: 'org_1' },
};

beforeEach(() => {
  vi.clearAllMocks();
  flushMock.mockResolvedValue({ flushed: 0, totalUsd: 0 });
  dbMock.seoProjectConfig.updateMany.mockResolvedValue({ count: 1 });
  dbMock.seoTrackedKeyword.count.mockResolvedValue(3);
  capMock.mockResolvedValue(false);
  defaultKeyMock.mockReturnValue(false);
  dbMock.seoRankRun.create.mockResolvedValue({ id: 'run_1' });
  queueMock.add.mockResolvedValue(undefined);
});

describe('seoRankSchedulerJob', () => {
  it('claims the project, creates a pending run and enqueues it', async () => {
    dbMock.seoProjectConfig.findMany.mockResolvedValue([dueRank]);

    const result = await seoRankSchedulerJob();

    expect(result).toEqual({ due: 1, enqueued: 1, skipped: 0 });
    expect(flushMock).toHaveBeenCalledTimes(1);

    const claim = dbMock.seoProjectConfig.updateMany.mock.calls[0]?.[0];
    expect(claim.where.projectId).toBe('p1');
    expect(claim.where.rankSchedule).toEqual({ not: 'manual' });
    const now = claim.where.rankNextRunAt.lte as Date;
    expect(claim.data.rankNextRunAt.getTime() - now.getTime()).toBe(DAY_MS);

    expect(dbMock.seoRankRun.create).toHaveBeenCalledWith({
      data: { projectId: 'p1', status: 'pending', keywordsTotal: 3 },
      select: { id: true },
    });
    expect(queueMock.add).toHaveBeenCalledWith(
      'seoRankRun',
      { type: 'seoRankRun', payload: { projectId: 'p1', runId: 'run_1' } },
      { jobId: 'seoRankRun:run_1' }
    );
  });

  it('does nothing for a project another tick already claimed', async () => {
    dbMock.seoProjectConfig.findMany.mockResolvedValue([dueRank]);
    dbMock.seoProjectConfig.updateMany.mockResolvedValue({ count: 0 });

    const result = await seoRankSchedulerJob();

    expect(result).toEqual({ due: 1, enqueued: 0, skipped: 0 });
    expect(dbMock.seoRankRun.create).not.toHaveBeenCalled();
    expect(queueMock.add).not.toHaveBeenCalled();
  });

  it('advances the pointer but creates no run when there are no keywords', async () => {
    dbMock.seoProjectConfig.findMany.mockResolvedValue([dueRank]);
    dbMock.seoTrackedKeyword.count.mockResolvedValue(0);

    const result = await seoRankSchedulerJob();

    expect(result).toEqual({ due: 1, enqueued: 0, skipped: 1 });
    expect(dbMock.seoProjectConfig.updateMany).toHaveBeenCalledTimes(1);
    expect(dbMock.seoRankRun.create).not.toHaveBeenCalled();
  });

  it('records a failed run instead of enqueueing when the cap is reached', async () => {
    dbMock.seoProjectConfig.findMany.mockResolvedValue([dueRank]);
    // isDfsSpendCapReached includes the unflushed Redis counter, so a cap hit
    // in the last 15 minutes is seen too.
    capMock.mockResolvedValue(true);

    const result = await seoRankSchedulerJob();

    expect(result).toEqual({ due: 1, enqueued: 0, skipped: 1 });
    expect(dbMock.seoRankRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: 'p1',
        status: 'failed',
        error: 'spend cap reached',
      }),
    });
    expect(queueMock.add).not.toHaveBeenCalled();
  });

  it('still schedules when the spend flush fails', async () => {
    flushMock.mockRejectedValue(new Error('redis down'));
    dbMock.seoProjectConfig.findMany.mockResolvedValue([dueRank]);

    const result = await seoRankSchedulerJob();

    expect(result.enqueued).toBe(1);
  });
});

describe('seoBacklinkSchedulerJob', () => {
  const dueBacklink = {
    projectId: 'p1',
    backlinkSchedule: 'weekly',
    domain: 'example.com',
    project: { organizationId: 'org_1' },
  };

  it('advances by a week and enqueues one snapshot per project per day', async () => {
    dbMock.seoProjectConfig.findMany.mockResolvedValue([dueBacklink]);

    const result = await seoBacklinkSchedulerJob();

    expect(result).toEqual({ due: 1, enqueued: 1, skipped: 0 });
    const claim = dbMock.seoProjectConfig.updateMany.mock.calls[0]?.[0];
    const now = claim.where.backlinkNextRunAt.lte as Date;
    expect(claim.data.backlinkNextRunAt.getTime() - now.getTime()).toBe(
      7 * DAY_MS
    );
    expect(queueMock.add).toHaveBeenCalledWith(
      'seoBacklinkSnapshot',
      { type: 'seoBacklinkSnapshot', payload: { projectId: 'p1' } },
      { jobId: `seoBacklinkSnapshot:p1:${now.toISOString().slice(0, 10)}` }
    );
  });

  it('skips a capped org without touching the queue', async () => {
    dbMock.seoProjectConfig.findMany.mockResolvedValue([dueBacklink]);
    capMock.mockResolvedValue(true);

    const result = await seoBacklinkSchedulerJob();

    expect(result).toEqual({ due: 1, enqueued: 0, skipped: 1 });
    expect(queueMock.add).not.toHaveBeenCalled();
  });
});

describe('isoWeekKey', () => {
  it('follows ISO 8601 week numbering across year boundaries', () => {
    expect(isoWeekKey(new Date('2026-09-07T05:00:00Z'))).toBe('2026-W37');
    expect(isoWeekKey(new Date('2026-09-06T23:59:59Z'))).toBe('2026-W36');
    // 1 Jan 2027 is a Friday and belongs to the last week of 2026.
    expect(isoWeekKey(new Date('2027-01-01T00:00:00Z'))).toBe('2026-W53');
    expect(isoWeekKey(new Date('2024-12-30T00:00:00Z'))).toBe('2025-W01');
  });
});

describe('seoMetricsRefreshJob', () => {
  const now = new Date('2026-09-07T05:00:00Z');

  function project(organizationId: string, hasKey: boolean) {
    return {
      organizationId,
      organization: { dataForSeoConnection: hasKey ? { id: 'conn' } : null },
    };
  }

  it('enqueues one batched job per project with a per-week jobId', async () => {
    dbMock.seoTrackedKeyword.groupBy.mockResolvedValue([
      { projectId: 'p1', _count: { _all: 2 } },
      { projectId: 'p2', _count: { _all: 1 } },
    ]);
    dbMock.project.findUnique
      .mockResolvedValueOnce(project('org_1', true))
      .mockResolvedValueOnce(project('org_2', true));
    dbMock.seoTrackedKeyword.findMany
      .mockResolvedValueOnce([{ keyword: 'a' }, { keyword: 'b' }])
      .mockResolvedValueOnce([{ keyword: 'c' }]);

    const result = await seoMetricsRefreshJob(now);

    expect(result).toEqual({ projects: 2, enqueued: 2, skipped: 0, week: '2026-W37' });
    expect(queueMock.add).toHaveBeenCalledWith(
      'seoKeywordMetrics',
      { type: 'seoKeywordMetrics', payload: { projectId: 'p1', keywords: ['a', 'b'] } },
      { jobId: 'seoKeywordMetrics:p1:2026-W37' }
    );
    expect(queueMock.add).toHaveBeenCalledWith(
      'seoKeywordMetrics',
      { type: 'seoKeywordMetrics', payload: { projectId: 'p2', keywords: ['c'] } },
      { jobId: 'seoKeywordMetrics:p2:2026-W37' }
    );
    expect(dbMock.seoTrackedKeyword.groupBy).toHaveBeenCalledWith({
      by: ['projectId'],
      where: { isActive: true },
      _count: { _all: true },
    });
  });

  it('skips projects without a DataForSEO key unless a default key exists', async () => {
    dbMock.seoTrackedKeyword.groupBy.mockResolvedValue([{ projectId: 'p1', _count: { _all: 1 } }]);
    dbMock.project.findUnique.mockResolvedValue(project('org_1', false));

    expect(await seoMetricsRefreshJob(now)).toMatchObject({ enqueued: 0, skipped: 1 });
    expect(queueMock.add).not.toHaveBeenCalled();

    defaultKeyMock.mockReturnValue(true);
    dbMock.seoTrackedKeyword.findMany.mockResolvedValue([{ keyword: 'a' }]);
    expect(await seoMetricsRefreshJob(now)).toMatchObject({ enqueued: 1, skipped: 0 });
  });

  it('skips a capped org without touching the queue', async () => {
    dbMock.seoTrackedKeyword.groupBy.mockResolvedValue([{ projectId: 'p1', _count: { _all: 1 } }]);
    dbMock.project.findUnique.mockResolvedValue(project('org_1', true));
    capMock.mockResolvedValue(true);

    expect(await seoMetricsRefreshJob(now)).toMatchObject({ enqueued: 0, skipped: 1 });
    expect(capMock).toHaveBeenCalledWith('org_1');
    expect(dbMock.seoTrackedKeyword.findMany).not.toHaveBeenCalled();
    expect(queueMock.add).not.toHaveBeenCalled();
  });
});

describe('seoSpendResetJob', () => {
  it('flushes Redis into Postgres before zeroing every counter', async () => {
    const order: string[] = [];
    flushMock.mockImplementation(async () => {
      order.push('flush');
      return { flushed: 2, totalUsd: 3 };
    });
    dbMock.dataForSeoConnection.updateMany.mockImplementation(async () => {
      order.push('reset');
      return { count: 2 };
    });

    expect(await seoSpendResetJob()).toEqual({ reset: 2 });
    expect(order).toEqual(['flush', 'reset']);
    expect(dbMock.dataForSeoConnection.updateMany).toHaveBeenCalledWith({
      where: {},
      data: { monthlySpendUsd: 0 },
    });
  });
});

describe('seoBalanceRefreshJob', () => {
  it('refreshes every org and isolates a failing key', async () => {
    dbMock.dataForSeoConnection.findMany.mockResolvedValue([
      { organizationId: 'org_1' },
      { organizationId: 'org_2' },
    ]);
    refreshMock
      .mockRejectedValueOnce(new Error('401'))
      .mockResolvedValueOnce({ balanceUsd: 9, balanceAt: new Date() });

    expect(await seoBalanceRefreshJob()).toEqual({ refreshed: 1, failed: 1 });
    expect(refreshMock).toHaveBeenCalledWith('org_1');
    expect(refreshMock).toHaveBeenCalledWith('org_2');
  });
});
