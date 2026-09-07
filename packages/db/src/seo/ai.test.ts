/**
 * AI visibility services against fixture envelopes.
 *
 * DataForSEO's LLM-mentions payloads are nested group arrays; what matters
 * is that they collapse into the flat numbers the tab shows, that a domain
 * target can only be the tracked domain or a configured competitor, and
 * that the referrer matcher in JS agrees with the SQL it mirrors.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { aiSearch, chQueryMock, ctx } = vi.hoisted(() => {
  const aiSearch = {
    mentionsSearch: vi.fn(),
    aggregatedMetrics: vi.fn(),
    topPages: vi.fn(),
    crossAggregatedMetrics: vi.fn(),
  };
  return {
    aiSearch,
    chQueryMock: vi.fn(),
    ctx: {
      projectId: 'p1',
      organizationId: 'org_1',
      client: { aiSearch },
      domain: 'me.com',
      locationCode: 2376,
      languageCode: 'he',
      competitors: ['Rival.com', 'other.io'],
    },
  };
});

vi.mock('./keywords', () => ({ getSeoResearchContext: vi.fn(async () => ctx) }));
vi.mock('./cache', () => ({
  withSeoCache: (_: unknown, loader: () => Promise<unknown>) => loader(),
}));
vi.mock('../clickhouse/client', () => ({
  chQuery: chQueryMock,
  TABLE_NAMES: { sessions: 'sessions' },
}));

const {
  AI_REFERRER_SQL,
  assertAllowedAiDomain,
  comparisonWindows,
  getAiEngineTraffic,
  getAiMentions,
  getAiShareOfVoice,
  getAiTopPages,
  matchAiReferrer,
  normalizeTopPages,
  summarizeCitedDomains,
} = await import('./ai');

const mention = (question: string, domains: string[], volume = 100) => ({
  question,
  ai_search_volume: volume,
  sources: domains.map((domain) => ({
    url: `https://${domain}/page`,
    domain,
    title: domain,
  })),
  brand_entities: [{ title: 'Me' }, { title: null }],
  first_response_at: '2026-08-01',
  last_response_at: '2026-09-01',
});

const group = (mentions: number, volume = 0, impressions = 0) => ({
  type: 'platform',
  key: 'x',
  mentions,
  ai_search_volume: volume,
  impressions,
});

beforeEach(() => {
  vi.clearAllMocks();
  aiSearch.mentionsSearch.mockResolvedValue({ data: [] });
  aiSearch.aggregatedMetrics.mockResolvedValue({ data: { platform: [] } });
  aiSearch.topPages.mockResolvedValue({ data: [] });
  aiSearch.crossAggregatedMetrics.mockResolvedValue({ data: [] });
});

describe('assertAllowedAiDomain', () => {
  it('accepts the tracked domain and configured competitors in any spelling', () => {
    expect(assertAllowedAiDomain(ctx, 'https://www.Rival.com/')).toBe('rival.com');
    expect(assertAllowedAiDomain(ctx, 'ME.com')).toBe('me.com');
  });

  it('refuses any other domain', () => {
    expect(() => assertAllowedAiDomain(ctx, 'stranger.com')).toThrow(
      /neither the tracked domain nor a configured competitor/
    );
  });
});

describe('getAiMentions', () => {
  it('defaults to the tracked domain and uses the right market per engine', async () => {
    aiSearch.mentionsSearch
      .mockResolvedValueOnce({ data: [mention('best shoes?', ['me.com', 'rival.com', 'me.com'], 500)] })
      .mockResolvedValueOnce({ data: [mention('shoes in israel', ['blog.rival.com'], 50)] });

    const result = await getAiMentions({ projectId: 'p1' });

    expect(result.target).toEqual({ type: 'domain', value: 'me.com' });
    expect(result.engines).toEqual(['chat_gpt', 'google']);
    // ChatGPT data only exists for US/en; Google follows the project market.
    expect(aiSearch.mentionsSearch.mock.calls[0]?.[0]).toMatchObject({
      platform: 'chat_gpt',
      locationCode: 2840,
      languageCode: 'en',
      target: { domain: 'me.com', include_subdomains: true },
    });
    expect(aiSearch.mentionsSearch.mock.calls[1]?.[0]).toMatchObject({
      platform: 'google',
      locationCode: 2376,
      languageCode: 'he',
    });

    expect(result.mentions).toHaveLength(2);
    expect(result.mentions[0]).toMatchObject({
      engine: 'chat_gpt',
      question: 'best shoes?',
      aiSearchVolume: 500,
      brandEntities: ['Me'],
    });
    expect(result.mentions[0]?.sources.map((s) => s.domain)).toEqual([
      'me.com',
      'rival.com',
      'me.com',
    ]);
    expect(result.citedDomains).toEqual([
      // me.com: cited twice in one answer → 1 answer, 2 citations.
      { domain: 'me.com', answers: 1, citations: 2, isOwn: true, isCompetitor: false },
      { domain: 'rival.com', answers: 1, citations: 1, isOwn: false, isCompetitor: true },
      // Subdomains count toward the competitor.
      { domain: 'blog.rival.com', answers: 1, citations: 1, isOwn: false, isCompetitor: true },
    ]);
  });

  it('falls back to a language the location serves for the Google engine', async () => {
    // Israel + English: LLM-mentions data only exists in he/ar there; "en"
    // is rejected as a charged "Invalid Field: 'language_code'".
    const original = ctx.languageCode;
    ctx.languageCode = 'en';
    try {
      await getAiMentions({ projectId: 'p1', engines: ['google'] });
    } finally {
      ctx.languageCode = original;
    }

    expect(aiSearch.mentionsSearch.mock.calls[0]?.[0]).toMatchObject({
      platform: 'google',
      locationCode: 2376,
      languageCode: 'he',
    });
  });

  it('lets the prompt explorer search any keyword but not any domain', async () => {
    await getAiMentions({
      projectId: 'p1',
      target: { type: 'keyword', value: '  best running shoes ' },
      engines: ['google'],
    });
    expect(aiSearch.mentionsSearch).toHaveBeenCalledTimes(1);
    expect(aiSearch.mentionsSearch.mock.calls[0]?.[0]).toMatchObject({
      platform: 'google',
      target: { keyword: 'best running shoes' },
    });

    await expect(
      getAiMentions({ projectId: 'p1', target: { type: 'domain', value: 'stranger.com' } })
    ).rejects.toThrow(/configured competitor/);
  });

  it('ignores unknown engines and caps the limit', async () => {
    await getAiMentions({ projectId: 'p1', engines: ['google', 'bing'], limit: 9999 });
    expect(aiSearch.mentionsSearch).toHaveBeenCalledTimes(1);
    expect(aiSearch.mentionsSearch.mock.calls[0]?.[0]).toMatchObject({
      platform: 'google',
      limit: 200,
    });
  });
});

describe('summarizeCitedDomains', () => {
  it('sorts by answers then citations', () => {
    const mentions = [
      { sources: [{ domain: 'a.com' }, { domain: 'b.com' }] },
      { sources: [{ domain: 'b.com' }, { domain: 'b.com' }] },
    ].map((m) => ({
      engine: 'google' as const,
      question: '',
      aiSearchVolume: null,
      sources: m.sources.map((s) => ({ ...s, url: null, title: null })),
      brandEntities: [],
      firstResponseAt: null,
      lastResponseAt: null,
    }));
    expect(summarizeCitedDomains(mentions, ctx).map((d) => d.domain)).toEqual(['b.com', 'a.com']);
  });
});

describe('getAiShareOfVoice', () => {
  it('compares the tracked domain with its competitors in one call per engine', async () => {
    aiSearch.crossAggregatedMetrics
      .mockResolvedValueOnce({
        data: [
          { key: 'me.com', platform: [group(30, 1000)] },
          { key: 'rival.com', platform: [group(60)] },
          { key: 'other.io', platform: [group(10)] },
          { key: 'ignored.com', platform: [group(999)] },
        ],
      })
      .mockResolvedValueOnce({
        data: [
          { key: 'me.com', platform: [group(20)] },
          { key: 'rival.com', platform: [group(0)] },
        ],
      });

    const result = await getAiShareOfVoice({ projectId: 'p1' });

    expect(aiSearch.crossAggregatedMetrics.mock.calls[0]?.[0]).toMatchObject({
      platform: 'chat_gpt',
      groups: [
        { key: 'me.com', target: { domain: 'me.com' } },
        { key: 'rival.com' },
        { key: 'other.io' },
      ],
    });
    expect(result.groups).toEqual([
      {
        domain: 'rival.com',
        isOwn: false,
        mentions: 60,
        aiSearchVolume: 0,
        share: 50,
        perEngine: { chat_gpt: 60, google: 0 },
      },
      {
        domain: 'me.com',
        isOwn: true,
        mentions: 50,
        aiSearchVolume: 1000,
        share: expect.closeTo(41.67, 1),
        perEngine: { chat_gpt: 30, google: 20 },
      },
      {
        domain: 'other.io',
        isOwn: false,
        mentions: 10,
        aiSearchVolume: 0,
        share: expect.closeTo(8.33, 1),
        perEngine: { chat_gpt: 10, google: 0 },
      },
    ]);
  });

  it('falls back to the aggregate endpoint when no competitors are configured', async () => {
    const { getSeoResearchContext } = await import('./keywords');
    vi.mocked(getSeoResearchContext).mockResolvedValueOnce({
      ...ctx,
      competitors: [],
    } as never);
    aiSearch.aggregatedMetrics
      .mockResolvedValueOnce({ data: { platform: [group(7)] } })
      .mockResolvedValueOnce({ data: { platform: [group(3)] } });

    const result = await getAiShareOfVoice({ projectId: 'p1' });

    expect(aiSearch.crossAggregatedMetrics).not.toHaveBeenCalled();
    expect(result.groups).toEqual([
      {
        domain: 'me.com',
        isOwn: true,
        mentions: 10,
        aiSearchVolume: 0,
        share: 100,
        perEngine: { chat_gpt: 7, google: 3 },
      },
    ]);
  });
});

describe('top pages', () => {
  it('merges the same URL across engines and sorts by mentions', async () => {
    aiSearch.topPages
      .mockResolvedValueOnce({
        data: [
          { key: 'https://me.com/a', platform: [group(5, 100, 1000)] },
          { key: 'https://me.com/b', platform: [group(1)] },
          { key: null, platform: [group(50)] },
        ],
      })
      .mockResolvedValueOnce({ data: [{ key: 'https://me.com/b', platform: [group(9)] }] });

    const result = await getAiTopPages({ projectId: 'p1', limit: 5 });

    expect(aiSearch.topPages.mock.calls[0]?.[0]).toMatchObject({ itemsListLimit: 5 });
    expect(result.pages).toEqual([
      {
        url: 'https://me.com/b',
        mentions: 10,
        aiSearchVolume: 0,
        impressions: 0,
        perEngine: { chat_gpt: 1, google: 9 },
      },
      {
        url: 'https://me.com/a',
        mentions: 5,
        aiSearchVolume: 100,
        impressions: 1000,
        perEngine: { chat_gpt: 5, google: 0 },
      },
    ]);
    expect(normalizeTopPages([])).toEqual([]);
  });
});

describe('AI referrer matching', () => {
  it.each([
    ['ChatGPT', 'chatgpt.com'],
    ['https://chat.openai.com', 'chatgpt.com'],
    ['https://www.perplexity.ai', 'perplexity.ai'],
    ['Google Gemini', 'gemini.google.com'],
    ['copilot.microsoft.com', 'copilot.microsoft.com'],
    ['bing.com/chat', 'copilot.microsoft.com'],
    ['you.com', 'you.com'],
    ['claude.ai', 'claude.ai'],
  ])('%s → %s', (input, expected) => {
    expect(matchAiReferrer(input)).toBe(expected);
  });

  it.each([['google.com'], ['bing.com'], [''], ['facebook']])(
    'does not match %s',
    (input) => {
      expect(matchAiReferrer(input)).toBeNull();
    }
  );

  it('uses the same alias list in SQL', () => {
    expect(AI_REFERRER_SQL.filter).toContain("'chat.openai.com'");
    expect(AI_REFERRER_SQL.filter).toContain("'bing.com/chat'");
    expect(AI_REFERRER_SQL.filter).not.toContain("'bing.com'");
    expect(AI_REFERRER_SQL.canonical).toContain("'copilot.microsoft.com'");
    expect(AI_REFERRER_SQL.cte).toContain('regexp_replace(referrer_name');
  });
});

describe('getAiEngineTraffic', () => {
  it('pairs current and previous sessions per engine with a daily series', async () => {
    chQueryMock
      .mockResolvedValueOnce([
        { engine: 'chatgpt.com', sessions: 40 },
        { engine: 'perplexity.ai', sessions: 5 },
      ])
      .mockResolvedValueOnce([
        { engine: 'chatgpt.com', sessions: 30 },
        { engine: 'claude.ai', sessions: 2 },
      ])
      .mockResolvedValueOnce([
        { date: '2026-09-01', sessions: 20 },
        { date: '2026-09-02', sessions: 25 },
      ]);

    const result = await getAiEngineTraffic({
      projectId: 'p1',
      startDate: '2026-09-01',
      endDate: '2026-09-02',
    });

    expect(result).toEqual({
      engines: [
        { engine: 'chatgpt.com', label: 'ChatGPT', sessions: 40, previousSessions: 30 },
        { engine: 'perplexity.ai', label: 'Perplexity', sessions: 5, previousSessions: 0 },
        { engine: 'claude.ai', label: 'Claude', sessions: 0, previousSessions: 2 },
      ],
      total: 45,
      previousTotal: 32,
      series: [
        { date: '2026-09-01', sessions: 20 },
        { date: '2026-09-02', sessions: 25 },
      ],
    });

    const sql = chQueryMock.mock.calls[0]?.[0] as string;
    expect(sql).toContain("project_id = 'p1'");
    expect(sql).toContain("created_at >= '2026-09-01 00:00:00'");
    expect(sql).toContain("created_at < '2026-09-03 00:00:00'");
  });

  it('builds half-open comparison windows of equal length', () => {
    expect(comparisonWindows('2026-09-01', '2026-09-07')).toEqual({
      current: { start: '2026-09-01 00:00:00', end: '2026-09-08 00:00:00' },
      previous: { start: '2026-08-25 00:00:00', end: '2026-09-01 00:00:00' },
    });
  });
});
