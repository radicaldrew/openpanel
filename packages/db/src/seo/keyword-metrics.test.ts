/**
 * seo_keyword_metrics has unsigned volume/difficulty columns. A keyword DFS
 * knows nothing about must still be storable (otherwise one unknown keyword
 * poisons a 700-keyword batch) and must read back as null, not as a huge
 * number. The read must also bind the caller's keywords as parameters.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { chMock, dbMock, fns } = vi.hoisted(() => ({
  chMock: { insert: vi.fn(), query: vi.fn() },
  dbMock: {
    $transaction: vi.fn(async (ops: unknown[]) => ops),
    seoTrackedKeyword: { updateMany: vi.fn() },
  },
  fns: {
    getSeoProjectConfig: vi.fn(),
    getDfsClientForProject: vi.fn(),
    fetchKeywordMetricsForList: vi.fn(),
  },
}));

vi.mock('../prisma-client', () => ({ db: dbMock }));
vi.mock('../clickhouse/client', () => ({ originalCh: chMock, chQuery: vi.fn() }));
vi.mock('./config', () => ({ getSeoProjectConfig: fns.getSeoProjectConfig }));
vi.mock('./client', () => ({ getDfsClientForProject: fns.getDfsClientForProject }));
vi.mock('@openpanel/dataforseo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openpanel/dataforseo')>();
  return {
    resolveKeywordDataLanguage: actual.resolveKeywordDataLanguage,
    fetchKeywordMetricsForList: fns.fetchKeywordMetricsForList,
    fetchKeywordOverview: vi.fn(),
    fetchAdsSearchVolume: vi.fn(),
  };
});

const { fetchAndStoreKeywordMetrics, getKeywordMetrics } = await import(
  './keyword-metrics'
);

const UINT32_MAX = 4_294_967_295;
const UINT8_MAX = 255;

beforeEach(() => {
  vi.clearAllMocks();
  fns.getSeoProjectConfig.mockResolvedValue({ locationCode: 2840, languageCode: 'en' });
  fns.getDfsClientForProject.mockResolvedValue({ transport: {} });
  dbMock.seoTrackedKeyword.updateMany.mockReturnValue({});
});

describe('fetchAndStoreKeywordMetrics', () => {
  it('stores unsigned-safe sentinels for missing metrics and reads them back as null', async () => {
    fns.fetchKeywordMetricsForList.mockResolvedValue([
      {
        keyword: 'Known Keyword',
        searchVolume: 1200,
        cpc: 1.5,
        competition: 0.4,
        competitionLevel: 'MEDIUM',
        keywordDifficulty: 42,
        intent: 'commercial',
        monthlySearches: [{ year: 2026, month: 8, searchVolume: 1000 }],
      },
      {
        keyword: 'unknown keyword',
        searchVolume: null,
        cpc: null,
        competition: null,
        competitionLevel: null,
        keywordDifficulty: null,
        intent: null,
        monthlySearches: [],
      },
    ]);

    const stored = await fetchAndStoreKeywordMetrics('p1', ['Known Keyword', 'unknown keyword']);

    const insert = chMock.insert.mock.calls[0]?.[0];
    expect(insert.table).toBe('seo_keyword_metrics');
    expect(insert.values[0]).toMatchObject({
      keyword: 'known keyword',
      search_volume: 1200,
      difficulty: 42,
      cpc: 1.5,
      competition: 0.4,
    });
    // Never a negative number in an unsigned column.
    expect(insert.values[1]).toMatchObject({
      keyword: 'unknown keyword',
      search_volume: UINT32_MAX,
      difficulty: UINT8_MAX,
      cpc: -1,
      competition: -1,
    });
    for (const value of insert.values) {
      expect(value.search_volume).toBeGreaterThanOrEqual(0);
      expect(value.difficulty).toBeGreaterThanOrEqual(0);
    }

    expect(stored[1]).toMatchObject({
      keyword: 'unknown keyword',
      searchVolume: null,
      difficulty: null,
      cpc: null,
      competition: null,
    });
    expect(stored[0]).toMatchObject({ searchVolume: 1200, difficulty: 42 });
  });
});

describe('fetchAndStoreKeywordMetrics market', () => {
  it('sends and stores the language the keyword APIs serve for the location', async () => {
    // Israel + English: Labs/Ads only serve ar/he there and reject "en" as a
    // charged "Invalid Field: 'language_code'" failure, so fall back to "he".
    fns.getSeoProjectConfig.mockResolvedValue({ locationCode: 2376, languageCode: 'en' });
    fns.fetchKeywordMetricsForList.mockResolvedValue([
      {
        keyword: 'bots',
        searchVolume: 10,
        cpc: null,
        competition: null,
        competitionLevel: null,
        keywordDifficulty: null,
        intent: null,
        monthlySearches: [],
      },
    ]);

    await fetchAndStoreKeywordMetrics('p1', ['bots']);

    const requestText = JSON.stringify(fns.fetchKeywordMetricsForList.mock.calls[0]);
    expect(requestText).toContain('"languageCode":"he"');
    expect(requestText).not.toContain('"languageCode":"en"');
    const insert = chMock.insert.mock.calls[0]?.[0];
    expect(insert.values[0]).toMatchObject({ location_code: 2376, language_code: 'he' });
  });
});

describe('getKeywordMetrics', () => {
  it('binds the keywords as query parameters and maps sentinels back to null', async () => {
    chMock.query.mockResolvedValue({
      json: async () => [
        {
          keyword: 'a',
          location_code: 2840,
          language_code: 'en',
          search_volume: UINT32_MAX,
          difficulty: UINT8_MAX,
          cpc: -1,
          competition: -1,
          monthly_json: '[]',
          fetched_at: '2026-09-06 00:00:00',
        },
        {
          keyword: 'b',
          location_code: 2840,
          language_code: 'en',
          search_volume: 0,
          difficulty: 0,
          cpc: 0,
          competition: 0,
          monthly_json: 'not json',
          fetched_at: '2026-09-06 00:00:00',
        },
      ],
    });

    const result = await getKeywordMetrics('p1', ["it's a", ' B ', 'a']);

    const call = chMock.query.mock.calls[0]?.[0];
    expect(call.query_params).toEqual({ projectId: 'p1', keywords: ["it's a", 'b', 'a'] });
    expect(call.query).not.toContain("it's a");
    expect(call.query).toContain('{keywords: Array(String)}');

    expect(result.get('a')).toMatchObject({
      searchVolume: null,
      difficulty: null,
      cpc: null,
      competition: null,
    });
    // A genuine zero stays zero.
    expect(result.get('b')).toMatchObject({
      searchVolume: 0,
      difficulty: 0,
      cpc: 0,
      competition: 0,
      monthly: [],
    });
  });

  it('skips ClickHouse entirely for an empty list', async () => {
    expect(await getKeywordMetrics('p1', ['  '])).toEqual(new Map());
    expect(chMock.query).not.toHaveBeenCalled();
  });
});
