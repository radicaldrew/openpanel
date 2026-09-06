/**
 * The Search Console ⋈ seo_keyword_metrics join is what the index tab's
 * Volume/Difficulty columns render from, so the cases that matter are: every
 * query has metrics (nothing pending, nothing to enqueue), some do not
 * (pending rows + one batched keyword list), and lookups survive the
 * whitespace/case differences between GSC queries and stored keywords.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getGscQueries, getKeywordMetrics, fetchAndStoreKeywordMetrics } =
  vi.hoisted(() => ({
    getGscQueries: vi.fn(),
    getKeywordMetrics: vi.fn(),
    fetchAndStoreKeywordMetrics: vi.fn(),
  }));

vi.mock('../gsc', () => ({ getGscQueries }));
vi.mock('./keyword-metrics', () => ({
  getKeywordMetrics,
  fetchAndStoreKeywordMetrics,
}));
vi.mock('./client', () => ({
  getDfsClientForOrganization: vi.fn(),
  getProjectOrganizationId: vi.fn(),
}));
vi.mock('./config', () => ({ getSeoProjectConfig: vi.fn() }));
vi.mock('./cache', () => ({
  SEO_CACHE_TTL_SECONDS: { labs: 24 * 60 * 60 },
  withSeoCache: vi.fn((_opts: unknown, loader: () => unknown) => loader()),
}));

const { getGscQueriesWithMetrics, getKeywordOverview, toKeywordResearchRow, toSerpPreview } =
  await import('./keywords');

const gscRow = (query: string, clicks: number) => ({
  query,
  clicks,
  impressions: clicks * 10,
  ctr: 0.1,
  position: 4.2,
});

const metric = (keyword: string, searchVolume: number) => ({
  keyword,
  locationCode: 2840,
  languageCode: 'en',
  searchVolume,
  difficulty: 33,
  cpc: 1.5,
  competition: 0.4,
  monthly: [],
  fetchedAt: '2026-09-06T00:00:00.000Z',
});

describe('getGscQueriesWithMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks nothing pending when every query already has metrics', async () => {
    getGscQueries.mockResolvedValue([gscRow('running shoes', 50), gscRow('trail shoes', 20)]);
    getKeywordMetrics.mockResolvedValue(
      new Map([
        ['running shoes', metric('running shoes', 1000)],
        ['trail shoes', metric('trail shoes', 300)],
      ])
    );

    const result = await getGscQueriesWithMetrics({
      projectId: 'p1',
      startDate: '2026-08-01',
      endDate: '2026-08-31',
      limit: 50,
    });

    expect(getGscQueries).toHaveBeenCalledWith('p1', '2026-08-01', '2026-08-31', 50);
    expect(getKeywordMetrics).toHaveBeenCalledWith('p1', ['running shoes', 'trail shoes']);
    expect(result.missingKeywords).toEqual([]);
    expect(result.rows).toEqual([
      {
        ...gscRow('running shoes', 50),
        searchVolume: 1000,
        difficulty: 33,
        cpc: 1.5,
        pending: false,
      },
      {
        ...gscRow('trail shoes', 20),
        searchVolume: 300,
        difficulty: 33,
        cpc: 1.5,
        pending: false,
      },
    ]);
  });

  it('returns pending rows and one batched missing list when metrics are absent', async () => {
    getGscQueries.mockResolvedValue([
      gscRow('running shoes', 50),
      gscRow('trail shoes', 20),
      gscRow('barefoot shoes', 5),
    ]);
    getKeywordMetrics.mockResolvedValue(
      new Map([['trail shoes', metric('trail shoes', 300)]])
    );

    const result = await getGscQueriesWithMetrics({
      projectId: 'p1',
      startDate: '2026-08-01',
      endDate: '2026-08-31',
      limit: 50,
    });

    expect(result.missingKeywords).toEqual(['running shoes', 'barefoot shoes']);
    expect(result.rows.map((row) => [row.query, row.pending, row.searchVolume])).toEqual([
      ['running shoes', true, null],
      ['trail shoes', false, 300],
      ['barefoot shoes', true, null],
    ]);
  });

  it('matches metrics through the normalized keyword', async () => {
    getGscQueries.mockResolvedValue([gscRow('  Running   Shoes ', 1)]);
    getKeywordMetrics.mockResolvedValue(
      new Map([['running shoes', metric('running shoes', 1000)]])
    );

    const result = await getGscQueriesWithMetrics({
      projectId: 'p1',
      startDate: '2026-08-01',
      endDate: '2026-08-31',
      limit: 50,
    });

    expect(result.rows[0]?.pending).toBe(false);
    expect(result.rows[0]?.searchVolume).toBe(1000);
    expect(result.missingKeywords).toEqual([]);
  });

  it('skips the metrics lookup when Search Console has no queries', async () => {
    getGscQueries.mockResolvedValue([]);

    const result = await getGscQueriesWithMetrics({
      projectId: 'p1',
      startDate: '2026-08-01',
      endDate: '2026-08-31',
      limit: 50,
    });

    expect(result).toEqual({ rows: [], missingKeywords: [] });
    expect(getKeywordMetrics).not.toHaveBeenCalled();
  });
});

describe('getKeywordOverview', () => {
  const now = new Date('2026-09-06T12:00:00.000Z');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('serves fresh stored metrics without calling DataForSEO', async () => {
    getKeywordMetrics.mockResolvedValue(
      new Map([
        ['running shoes', { ...metric('running shoes', 1000), fetchedAt: '2026-09-06 08:00:00' }],
      ])
    );

    const rows = await getKeywordOverview({
      projectId: 'p1',
      keywords: [' Running  Shoes '],
      now,
    });

    expect(fetchAndStoreKeywordMetrics).not.toHaveBeenCalled();
    expect(rows).toEqual([expect.objectContaining({ keyword: 'running shoes', searchVolume: 1000 })]);
  });

  it('fetches only the keywords that are missing or older than the Labs TTL', async () => {
    getKeywordMetrics.mockResolvedValue(
      new Map([
        ['fresh', { ...metric('fresh', 10), fetchedAt: '2026-09-06 00:00:00' }],
        ['stale', { ...metric('stale', 20), fetchedAt: '2026-09-01 00:00:00' }],
      ])
    );
    fetchAndStoreKeywordMetrics.mockResolvedValue([
      { ...metric('stale', 25), fetchedAt: '2026-09-06 12:00:00' },
      { ...metric('new', 30), fetchedAt: '2026-09-06 12:00:00' },
    ]);

    const rows = await getKeywordOverview({
      projectId: 'p1',
      keywords: ['fresh', 'stale', 'new', 'stale'],
      now,
    });

    expect(fetchAndStoreKeywordMetrics).toHaveBeenCalledWith('p1', ['stale', 'new']);
    // Requested order, refreshed values winning over stale ones.
    expect(rows.map((row) => [row.keyword, row.searchVolume])).toEqual([
      ['fresh', 10],
      ['stale', 25],
      ['new', 30],
    ]);
  });
});

describe('toKeywordResearchRow', () => {
  it('flattens a Labs item and keeps the last 12 months oldest-first', () => {
    const monthly = Array.from({ length: 14 }, (_, index) => ({
      year: 2025 + Math.floor(index / 12),
      month: (index % 12) + 1,
      search_volume: index,
    })).reverse();
    const row = toKeywordResearchRow({
      keyword: ' running shoes ',
      keyword_info: { search_volume: 1000, cpc: 1.2, competition: 0.3, monthly_searches: monthly },
      keyword_properties: { keyword_difficulty: 41 },
      search_intent_info: { main_intent: 'Commercial' },
    });
    expect(row).toMatchObject({
      keyword: 'running shoes',
      searchVolume: 1000,
      difficulty: 41,
      cpc: 1.2,
      competition: 0.3,
      intent: 'commercial',
    });
    expect(row?.monthlySearches).toHaveLength(12);
    expect(row?.monthlySearches[0]).toEqual({ year: 2025, month: 3, searchVolume: 2 });
    expect(row?.monthlySearches[11]).toEqual({ year: 2026, month: 2, searchVolume: 13 });
  });

  it('drops items without a keyword', () => {
    expect(toKeywordResearchRow({ keyword: null })).toBeNull();
  });
});

describe('toSerpPreview', () => {
  it('keeps the organic top 10, flags the own domain and lists features', () => {
    const items = [
      { type: 'featured_snippet', rank_absolute: 1, domain: 'other.com' },
      ...Array.from({ length: 12 }, (_, index) => ({
        type: 'organic',
        rank_absolute: index + 2,
        rank_group: index + 1,
        domain: index === 3 ? 'www.example.com' : `site${index}.com`,
        url: `https://site${index}.com/`,
        title: `Result ${index}`,
      })),
      { type: 'people_also_ask', rank_absolute: 5 },
      { type: 'video', rank_absolute: 9 },
    ];
    const preview = toSerpPreview('running shoes', 'example.com', items);
    expect(preview.results).toHaveLength(10);
    expect(preview.features).toEqual(['featured_snippet', 'people_also_ask', 'video']);
    expect(preview.ownPosition).toBe(5);
    expect(preview.results[3]).toMatchObject({ domain: 'www.example.com', isOwnDomain: true });
  });
});
