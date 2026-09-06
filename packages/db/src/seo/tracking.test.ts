/**
 * Tracked keyword normalization and the Search Console seed.
 *
 * The unique index is on the normalized spelling, so what matters is that
 * every path (manual add, GSC import) agrees on it and that a GSC import
 * never re-adds what the project already tracks.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMock, gscMock } = vi.hoisted(() => ({
  dbMock: {
    seoTrackedKeyword: {
      findMany: vi.fn(),
      createMany: vi.fn(),
      updateMany: vi.fn(),
    },
  },
  gscMock: { getGscQueries: vi.fn() },
}));

vi.mock('../prisma-client', () => ({ db: dbMock }));
vi.mock('../gsc', () => gscMock);

const {
  addTrackedKeywords,
  addTrackedKeywordsFromGsc,
  normalizeTrackedKeywords,
} = await import('./tracking');

function row(keyword: string, overrides: Record<string, unknown> = {}) {
  return { id: `id_${keyword}`, keyword, isActive: true, tags: [], ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.seoTrackedKeyword.createMany.mockResolvedValue({ count: 0 });
  dbMock.seoTrackedKeyword.updateMany.mockResolvedValue({ count: 0 });
});

describe('normalizeTrackedKeywords', () => {
  it('trims, lowercases, collapses whitespace and dedupes', () => {
    expect(
      normalizeTrackedKeywords(['  Best   Shoes ', 'best shoes', 'BEST SHOES', '', '  '])
    ).toEqual(['best shoes']);
  });

  it('drops keywords over the length limit', () => {
    expect(normalizeTrackedKeywords(['a'.repeat(201), 'ok'])).toEqual(['ok']);
  });
});

describe('addTrackedKeywords', () => {
  it('creates only the keywords the project does not have yet', async () => {
    dbMock.seoTrackedKeyword.findMany
      .mockResolvedValueOnce([row('best shoes')])
      .mockResolvedValueOnce([row('best shoes'), row('cheap shoes')]);

    const result = await addTrackedKeywords({
      projectId: 'p1',
      keywords: ['Best Shoes', 'cheap shoes'],
      tags: [' brand ', 'brand'],
      source: 'research',
    });

    expect(dbMock.seoTrackedKeyword.createMany).toHaveBeenCalledWith({
      data: [
        { projectId: 'p1', keyword: 'cheap shoes', tags: ['brand'], source: 'research' },
      ],
      skipDuplicates: true,
    });
    expect(result.added).toEqual(['cheap shoes']);
    expect(result.existing).toEqual(['best shoes']);
    expect(result.keywords).toHaveLength(2);
  });

  it('re-activates an inactive keyword that is added again', async () => {
    dbMock.seoTrackedKeyword.findMany
      .mockResolvedValueOnce([row('best shoes', { isActive: false })])
      .mockResolvedValueOnce([row('best shoes')]);

    await addTrackedKeywords({ projectId: 'p1', keywords: ['best shoes'] });

    expect(dbMock.seoTrackedKeyword.createMany).not.toHaveBeenCalled();
    expect(dbMock.seoTrackedKeyword.updateMany).toHaveBeenCalledWith({
      where: { projectId: 'p1', id: { in: ['id_best shoes'] } },
      data: { isActive: true },
    });
  });

  it('returns early for an empty list', async () => {
    expect(await addTrackedKeywords({ projectId: 'p1', keywords: [' '] })).toEqual({
      added: [],
      existing: [],
      keywords: [],
    });
    expect(dbMock.seoTrackedKeyword.findMany).not.toHaveBeenCalled();
  });
});

describe('addTrackedKeywordsFromGsc', () => {
  it('imports top queries above the impressions floor that are not tracked yet', async () => {
    gscMock.getGscQueries.mockResolvedValue([
      { query: 'Best Shoes', clicks: 50, impressions: 900 },
      { query: 'cheap shoes', clicks: 30, impressions: 400 },
      { query: 'rare shoes', clicks: 2, impressions: 5 },
      { query: 'CHEAP SHOES', clicks: 1, impressions: 100 },
      { query: 'red shoes', clicks: 1, impressions: 120 },
      { query: 'blue shoes', clicks: 1, impressions: 110 },
    ]);
    dbMock.seoTrackedKeyword.findMany
      // Already tracked on the project.
      .mockResolvedValueOnce([{ keyword: 'best shoes' }])
      // addTrackedKeywords: existing lookup, then the final read.
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row('cheap shoes'), row('red shoes')]);

    const result = await addTrackedKeywordsFromGsc({
      projectId: 'p1',
      minImpressions: 10,
      limit: 2,
    });

    // Window is the last 28 days ending yesterday, over-fetched 4× the limit.
    const [projectId, startDate, endDate, limit] = gscMock.getGscQueries.mock.calls[0]!;
    expect(projectId).toBe('p1');
    expect(limit).toBe(8);
    const days =
      (new Date(endDate).getTime() - new Date(startDate).getTime()) / 86_400_000;
    expect(days).toBe(27);

    // "best shoes" is skipped (tracked), "rare shoes" (5 impressions) is
    // skipped, the duplicate spelling collapses, and the limit is honoured.
    expect(result.candidates).toBe(2);
    expect(dbMock.seoTrackedKeyword.createMany).toHaveBeenCalledWith({
      data: [
        { projectId: 'p1', keyword: 'cheap shoes', tags: [], source: 'gsc' },
        { projectId: 'p1', keyword: 'red shoes', tags: [], source: 'gsc' },
      ],
      skipDuplicates: true,
    });
    expect(result.added).toEqual(['cheap shoes', 'red shoes']);
  });

  it('adds nothing when every query is already tracked', async () => {
    gscMock.getGscQueries.mockResolvedValue([
      { query: 'best shoes', clicks: 5, impressions: 50 },
    ]);
    dbMock.seoTrackedKeyword.findMany.mockResolvedValueOnce([{ keyword: 'best shoes' }]);

    const result = await addTrackedKeywordsFromGsc({ projectId: 'p1' });

    expect(result).toEqual({ added: [], existing: [], keywords: [], candidates: 0 });
    expect(dbMock.seoTrackedKeyword.createMany).not.toHaveBeenCalled();
  });
});
