/**
 * createRankRun guards the spend: at most one active run per project. The
 * pre-check alone loses the race when two "check now" clicks land together,
 * so the row that is not the earliest active run has to back itself out.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMock, fns } = vi.hoisted(() => ({
  dbMock: {
    seoRankRun: {
      findFirst: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    seoTrackedKeyword: { count: vi.fn() },
  },
  fns: {
    getProjectOrganizationId: vi.fn(),
    isDfsSpendCapReached: vi.fn(),
  },
}));

vi.mock('../prisma-client', () => ({ db: dbMock }));
vi.mock('./client', () => fns);

const { createRankRun } = await import('./rank-runs');

const run = (id: string, startedAt: string) => ({
  id,
  projectId: 'p1',
  status: 'pending',
  startedAt: new Date(startedAt),
});

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.seoTrackedKeyword.count.mockResolvedValue(5);
  fns.getProjectOrganizationId.mockResolvedValue('org_1');
  fns.isDfsSpendCapReached.mockResolvedValue(false);
});

describe('createRankRun', () => {
  it('refuses when a run is already active before creating anything', async () => {
    dbMock.seoRankRun.findFirst.mockResolvedValue(run('run_a', '2026-09-06T10:00:00Z'));

    const result = await createRankRun({ projectId: 'p1' });

    expect(result).toMatchObject({ ok: false, reason: 'already_running' });
    expect(dbMock.seoRankRun.create).not.toHaveBeenCalled();
  });

  it('keeps the run when it is the earliest active one', async () => {
    const mine = run('run_mine', '2026-09-06T10:00:00Z');
    dbMock.seoRankRun.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(mine);
    dbMock.seoRankRun.create.mockResolvedValue(mine);

    const result = await createRankRun({ projectId: 'p1' });

    expect(result).toEqual({ ok: true, run: mine });
    expect(dbMock.seoRankRun.delete).not.toHaveBeenCalled();
  });

  it('backs out when a concurrent click created an earlier run', async () => {
    const theirs = run('run_theirs', '2026-09-06T10:00:00.000Z');
    const mine = run('run_mine', '2026-09-06T10:00:00.050Z');
    dbMock.seoRankRun.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(theirs);
    dbMock.seoRankRun.create.mockResolvedValue(mine);

    const result = await createRankRun({ projectId: 'p1' });

    expect(dbMock.seoRankRun.delete).toHaveBeenCalledWith({ where: { id: 'run_mine' } });
    expect(result).toEqual({ ok: false, reason: 'already_running', run: theirs });
  });

  it('records a failed run instead of spending when the cap is reached', async () => {
    dbMock.seoRankRun.findFirst.mockResolvedValue(null);
    fns.isDfsSpendCapReached.mockResolvedValue(true);
    dbMock.seoRankRun.create.mockImplementation(async ({ data }: { data: object }) => ({
      id: 'run_capped',
      ...data,
    }));

    const result = await createRankRun({ projectId: 'p1' });

    expect(result).toMatchObject({ ok: false, reason: 'spend_cap' });
    expect(dbMock.seoRankRun.create.mock.calls[0]?.[0].data).toMatchObject({
      status: 'failed',
      error: 'spend cap reached',
    });
  });
});
