/**
 * gscEnriched is the one procedure that spends money as a side effect of a
 * query, so the cases that matter are: missing metrics enqueue exactly one
 * batched job (never one per keyword), a repeat request reuses the same
 * jobId, read-only members never enqueue, and complete metrics enqueue
 * nothing.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getGscQueriesWithMetrics, requireProjectAccess, queueAdd } = vi.hoisted(
  () => ({
    getGscQueriesWithMetrics: vi.fn(),
    requireProjectAccess: vi.fn(),
    queueAdd: vi.fn(),
  })
);

vi.mock('@openpanel/db', () => ({
  getGscQueriesWithMetrics,
  getKeywordOverview: vi.fn(),
  getRankedKeywords: vi.fn(),
  getSerpPreview: vi.fn(),
  researchKeywordIdeas: vi.fn(),
  researchKeywordSuggestions: vi.fn(),
  researchRelatedKeywords: vi.fn(),
  getSettingsForProject: vi.fn(async () => ({ timezone: 'UTC' })),
  getChartStartEndDate: vi.fn(() => ({
    startDate: '2026-08-01T00:00:00.000Z',
    endDate: '2026-08-31T23:59:59.999Z',
  })),
  DfsNotConfiguredError: class DfsNotConfiguredError extends Error {},
  SeoConfigMissingError: class SeoConfigMissingError extends Error {},
  runWithAlsSession: (_id: unknown, fn: () => unknown) => fn(),
}));
vi.mock('@openpanel/queue', () => ({ seoQueue: { add: queueAdd } }));
vi.mock('@openpanel/dataforseo', () => ({ isDataForSeoError: () => false }));
vi.mock('../../access', () => ({ requireProjectAccess }));

const { keywordMetricsJobId, seoKeywordsRouter } = await import('./keywords');

const caller = () =>
  seoKeywordsRouter.createCaller({
    req: { log: { info: vi.fn(), error: vi.fn() } },
    res: {},
    session: { userId: 'user_1' },
    setCookie: vi.fn(),
  } as never);

const row = (query: string, pending: boolean) => ({
  query,
  clicks: 1,
  impressions: 10,
  ctr: 0.1,
  position: 3,
  searchVolume: pending ? null : 100,
  difficulty: pending ? null : 20,
  cpc: pending ? null : 0.5,
  pending,
});

describe('seo.keywords.gscEnriched', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireProjectAccess.mockResolvedValue({ level: 'write' });
  });

  it('enqueues one batched seoKeywordMetrics job for the missing keywords', async () => {
    getGscQueriesWithMetrics.mockResolvedValue({
      rows: [row('a', true), row('b', false), row('c', true)],
      missingKeywords: ['a', 'c'],
    });

    const result = await caller().gscEnriched({ projectId: 'p1', range: '30d' });

    expect(getGscQueriesWithMetrics).toHaveBeenCalledWith({
      projectId: 'p1',
      startDate: '2026-08-01',
      endDate: '2026-08-31',
      limit: 50,
    });
    expect(queueAdd).toHaveBeenCalledTimes(1);
    expect(queueAdd).toHaveBeenCalledWith(
      'seoKeywordMetrics',
      { type: 'seoKeywordMetrics', payload: { projectId: 'p1', keywords: ['a', 'c'] } },
      { jobId: keywordMetricsJobId('p1', ['a', 'c']) }
    );
    expect(result.queued).toBe(2);
    expect(result.rows.map((r) => r.pending)).toEqual([true, false, true]);
  });

  it('enqueues nothing when every query already has metrics', async () => {
    getGscQueriesWithMetrics.mockResolvedValue({
      rows: [row('a', false)],
      missingKeywords: [],
    });

    const result = await caller().gscEnriched({ projectId: 'p1', range: '30d' });

    expect(queueAdd).not.toHaveBeenCalled();
    expect(result.queued).toBe(0);
  });

  it('never enqueues for read-only members but still returns pending rows', async () => {
    requireProjectAccess.mockResolvedValue({ level: 'read' });
    getGscQueriesWithMetrics.mockResolvedValue({
      rows: [row('a', true)],
      missingKeywords: ['a'],
    });

    const result = await caller().gscEnriched({ projectId: 'p1', range: '30d' });

    expect(queueAdd).not.toHaveBeenCalled();
    expect(result.queued).toBe(0);
    expect(result.rows[0]?.pending).toBe(true);
  });
});

describe('keywordMetricsJobId', () => {
  it('is stable across keyword order and distinct per project', () => {
    expect(keywordMetricsJobId('p1', ['b', 'a'])).toBe(
      keywordMetricsJobId('p1', ['a', 'b'])
    );
    expect(keywordMetricsJobId('p2', ['a', 'b'])).not.toBe(
      keywordMetricsJobId('p1', ['a', 'b'])
    );
  });
});
