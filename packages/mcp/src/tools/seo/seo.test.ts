import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

/**
 * Every packages/db SEO service is stubbed; what is exercised is the tool
 * surface: input schemas, which tools exist per client type, write-scope
 * refusal, the shaping into columnar tables, and the error translation that
 * tells an agent where to fix a missing DataForSEO key or project config.
 */
const { dbFns, queueMock, FakeDfsNotConfiguredError, FakeSeoConfigMissingError } = vi.hoisted(() => ({
  FakeDfsNotConfiguredError: class FakeDfsNotConfiguredError extends Error {
    readonly code = 'DFS_NOT_CONFIGURED';
  },
  FakeSeoConfigMissingError: class FakeSeoConfigMissingError extends Error {
    readonly code = 'SEO_CONFIG_MISSING';
  },
  dbFns: {
    getSeoStatus: vi.fn(),
    researchKeywordIdeas: vi.fn(),
    researchKeywordSuggestions: vi.fn(),
    researchRelatedKeywords: vi.fn(),
    getKeywordOverview: vi.fn(),
    getSerpPreview: vi.fn(),
    getGscQueriesWithMetrics: vi.fn(),
    listTrackedKeywords: vi.fn(),
    getLatestRankings: vi.fn(),
    getLastCompletedRankRun: vi.fn(),
    getActiveRankRun: vi.fn(),
    getSeoProjectConfig: vi.fn(),
    getRankHistory: vi.fn(),
    addTrackedKeywords: vi.fn(),
    createRankRun: vi.fn(),
    getBacklinkOverview: vi.fn(),
    getBacklinkHistory: vi.fn(),
    getBacklinkRows: vi.fn(),
    getReferringDomains: vi.fn(),
    listAudits: vi.fn(),
    getAudit: vi.fn(),
    getAuditIssueSummary: vi.fn(),
    listAuditPages: vi.fn(),
    createAudit: vi.fn(),
    getAiMentions: vi.fn(),
    getAiShareOfVoice: vi.fn(),
  },
  queueMock: { add: vi.fn() },
}));

vi.mock('@openpanel/db', () => ({
  ...dbFns,
  resolveClientProjectId: vi.fn(
    ({ clientProjectId, inputProjectId }: { clientProjectId: string | null; inputProjectId?: string }) =>
      Promise.resolve(clientProjectId ?? inputProjectId),
  ),
  isDfsNotConfiguredError: (error: unknown) => error instanceof FakeDfsNotConfiguredError,
  SeoConfigMissingError: FakeSeoConfigMissingError,
  BACKLINK_LIST_MAX_LIMIT: 200,
  MAX_KEYWORDS_PER_ADD: 2000,
  MAX_TRACKED_KEYWORD_LENGTH: 200,
  AUDIT_MAX_PAGES_MIN: 10,
  AUDIT_MAX_PAGES_MAX: 10_000,
  AUDIT_PRICE_PER_PAGE_USD: 0.000_125,
  AUDIT_PRICE_PER_PAGE_JS_USD: 0.0005,
  estimateAuditCostUsd: (pages: number, js: boolean) =>
    Math.round(pages * (js ? 0.0005 : 0.000_125) * 10_000) / 10_000,
  getAuditMaxPagesDefault: () => 500,
  readAuditSummary: (audit: { summary: unknown }) => (audit.summary ?? {}) as object,
  SEO_AUDIT_ISSUES: [{ key: 'no_title', label: 'Missing title', severity: 'critical' }],
  AI_ENGINES: ['chat_gpt', 'google'],
  normalizeTrackedKeyword: (raw: string) => raw.trim().replace(/\s+/g, ' ').toLowerCase(),
}));
vi.mock('@openpanel/queue', () => ({ seoQueue: queueMock }));

import type { McpAuthContext } from '../../auth';
import { registerSeoTools } from './index';
import { describeSeoError } from './shared';
import { estimateRankCheckCostUsd } from './tracking';

type Handler = (input: unknown) => Promise<{ content: [{ text: string }]; isError?: boolean }>;

function makeServer() {
  const handlers = new Map<string, Handler>();
  const schemas = new Map<string, Record<string, z.ZodTypeAny>>();
  return {
    tool: (name: string, _description: string, schema: Record<string, z.ZodTypeAny>, handler: Handler) => {
      handlers.set(name, handler);
      schemas.set(name, schema);
    },
    invoke: async (name: string, input: unknown) => {
      const schema = schemas.get(name);
      if (!schema) {
        throw new Error(`tool ${name} not registered`);
      }
      const parsed = z.object(schema).parse(input);
      const result = await handlers.get(name)!(parsed);
      const text = result.content[0].text;
      return result.isError ? { error: text } : JSON.parse(text);
    },
    names: () => [...schemas.keys()],
  };
}

const READ_CONTEXT: McpAuthContext = {
  projectId: 'project-1',
  organizationId: 'organization-1',
  clientType: 'read',
};
const ROOT_CONTEXT: McpAuthContext = {
  projectId: null,
  organizationId: 'organization-1',
  clientType: 'root',
};

function serverFor(context: McpAuthContext) {
  const server = makeServer();
  registerSeoTools(server as never, context);
  return server;
}

/** Tools that persist or bill on every call; registered for root clients only. */
const MUTATING_TOOLS = [
  'seo_track_keywords',
  'seo_run_rank_check',
  'seo_start_audit',
  'seo_keyword_overview',
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('registration', () => {
  it('registers every read tool for read clients and hides the mutating ones', () => {
    const names = serverFor(READ_CONTEXT).names();
    expect(names).toEqual(
      expect.arrayContaining([
        'seo_status',
        'seo_keyword_ideas',
        'seo_serp_preview',
        'seo_gsc_enriched_queries',
        'seo_tracked_keywords',
        'seo_rank_history',
        'seo_backlinks_summary',
        'seo_backlinks_list',
        'seo_referring_domains',
        'seo_audit_list',
        'seo_audit_issues',
        'seo_audit_pages',
        'seo_ai_mentions',
        'seo_ai_share_of_voice',
      ]),
    );
    for (const tool of MUTATING_TOOLS) {
      expect(names).not.toContain(tool);
    }
  });

  it('registers the four mutating tools for root clients only', () => {
    const names = serverFor(ROOT_CONTEXT).names();
    for (const tool of MUTATING_TOOLS) {
      expect(names).toContain(tool);
    }
    expect(names).toHaveLength(18);
  });
});

describe('write scope', () => {
  it.each(MUTATING_TOOLS)('%s refuses a read client even if invoked directly', async (tool) => {
    // Register with root to get the handler, then run it under a read context
    // by re-registering: the handler closes over the context it was built
    // with, so build one that is root at registration but read at call time.
    const context: McpAuthContext = { ...ROOT_CONTEXT };
    const server = serverFor(context);
    context.clientType = 'read';
    const input =
      tool === 'seo_track_keywords' || tool === 'seo_keyword_overview'
        ? { projectId: 'project-1', keywords: ['a'] }
        : { projectId: 'project-1' };
    const result = await server.invoke(tool, input);
    expect(result.error).toMatch(/requires a root \(write-scoped\) MCP client/);
    expect(dbFns.addTrackedKeywords).not.toHaveBeenCalled();
    expect(dbFns.getKeywordOverview).not.toHaveBeenCalled();
    expect(dbFns.createRankRun).not.toHaveBeenCalled();
    expect(dbFns.createAudit).not.toHaveBeenCalled();
    expect(queueMock.add).not.toHaveBeenCalled();
  });
});

describe('error translation', () => {
  it('tells the agent where to add the DataForSEO key', () => {
    expect(describeSeoError(new FakeDfsNotConfiguredError('x'))).toMatch(/Settings → DataForSEO/);
  });

  it('tells the agent the project config is missing', () => {
    expect(describeSeoError(new FakeSeoConfigMissingError('x'))).toMatch(/domain to track/);
  });

  it('maps DataForSEO billing and auth failures by shape', () => {
    const billing = Object.assign(new Error('Payment Required.'), {
      name: 'DataForSeoError',
      kind: 'billing',
      dfsStatusCode: 40_200,
    });
    expect(describeSeoError(billing)).toMatch(/no remaining balance/);
    const auth = Object.assign(new Error('Unauthorized'), { name: 'DataForSeoError', kind: 'auth' });
    expect(describeSeoError(auth)).toMatch(/rejected the stored login/);
    expect(describeSeoError(new Error('boom'))).toBeNull();
  });

  it('surfaces the translated message through the tool envelope', async () => {
    dbFns.researchKeywordIdeas.mockRejectedValue(new FakeDfsNotConfiguredError('x'));
    const result = await serverFor(READ_CONTEXT).invoke('seo_keyword_ideas', { seed: 'shoes' });
    expect(result.error).toMatch(/^Error: DataForSEO is not connected/);
  });
});

describe('seo_status', () => {
  it('lists what is missing', async () => {
    dbFns.getSeoStatus.mockResolvedValue({
      dfs: {
        configured: false,
        login: null,
        balanceUsd: null,
        balanceAt: null,
        monthlySpendUsd: 0,
        spendCapUsd: null,
        lastError: null,
      },
      gsc: { connected: false, siteUrl: null },
      config: null,
    });
    const result = await serverFor(READ_CONTEXT).invoke('seo_status', {});
    expect(result.ready.keywordResearch).toBe(false);
    expect(result.missing).toHaveLength(3);
    expect(result.missing[0]).toMatch(/DataForSEO key/);
    expect(dbFns.getSeoStatus).toHaveBeenCalledWith('project-1');
  });

  it('reports a reached spend cap', async () => {
    dbFns.getSeoStatus.mockResolvedValue({
      dfs: {
        configured: true,
        login: 'a@b.c',
        balanceUsd: 12,
        balanceAt: null,
        monthlySpendUsd: 20,
        spendCapUsd: 20,
        lastError: null,
      },
      gsc: { connected: true, siteUrl: 'sc-domain:me.com' },
      config: { domain: 'me.com', competitors: [] },
    });
    const result = await serverFor(READ_CONTEXT).invoke('seo_status', {});
    expect(result.ready.backlinks).toBe(true);
    expect(result.missing).toEqual([expect.stringMatching(/spend cap reached/)]);
  });
});

describe('keywords', () => {
  const row = {
    keyword: 'running shoes',
    searchVolume: 1000,
    difficulty: 40,
    cpc: 1.2,
    competition: 0.5,
    intent: 'commercial',
    monthlySearches: [],
  };

  it('routes the mode to the matching service and tabulates', async () => {
    dbFns.researchRelatedKeywords.mockResolvedValue([row]);
    const result = await serverFor(READ_CONTEXT).invoke('seo_keyword_ideas', {
      seed: 'shoes',
      mode: 'related',
      limit: 10,
    });
    expect(dbFns.researchRelatedKeywords).toHaveBeenCalledWith({
      projectId: 'project-1',
      seed: 'shoes',
      limit: 10,
    });
    expect(result.columns).toEqual(['keyword', 'searchVolume', 'difficulty', 'cpc', 'competition', 'intent']);
    expect(result.rows[0]).toEqual(['running shoes', 1000, 40, 1.2, 0.5, 'commercial']);
    expect(result.mode).toBe('related');
  });

  it('reports keywords the overview did not return, matching on the normalized spelling', async () => {
    dbFns.getKeywordOverview.mockResolvedValue([row]);
    const result = await serverFor(ROOT_CONTEXT).invoke('seo_keyword_overview', {
      projectId: 'project-1',
      keywords: ['  Running   Shoes ', 'zzz'],
    });
    expect(result.not_found).toEqual(['zzz']);
    expect(result.rows).toHaveLength(1);
  });

  it('is not offered to read clients: it persists and bills like the tRPC mutation', () => {
    expect(serverFor(READ_CONTEXT).names()).not.toContain('seo_keyword_overview');
  });

  it('translates SEO errors on the enriched GSC queries tool too', async () => {
    dbFns.getGscQueriesWithMetrics.mockRejectedValue(new FakeSeoConfigMissingError('x'));
    const result = await serverFor(READ_CONTEXT).invoke('seo_gsc_enriched_queries', {});
    expect(result.error).toMatch(/no SEO configuration yet/);
  });

  it('shapes the SERP preview', async () => {
    dbFns.getSerpPreview.mockResolvedValue({
      keyword: 'shoes',
      domain: 'me.com',
      ownPosition: 2,
      features: ['people_also_ask'],
      results: [
        { type: 'organic', rank: 1, domain: 'rival.com', url: 'https://rival.com', title: 'R', description: null, isOwnDomain: false },
        { type: 'organic', rank: 2, domain: 'me.com', url: 'https://me.com', title: 'M', description: null, isOwnDomain: true },
      ],
    });
    const result = await serverFor(READ_CONTEXT).invoke('seo_serp_preview', { keyword: 'shoes' });
    expect(result.ownPosition).toBe(2);
    expect(result.results.rows[1]).toEqual([2, 'me.com', 'https://me.com', 'M', true]);
  });

  it('queues missing metrics for root clients only', async () => {
    dbFns.getGscQueriesWithMetrics.mockResolvedValue({
      rows: [
        { query: 'a', clicks: 5, impressions: 50, ctr: 0.1, position: 3, searchVolume: null, difficulty: null, cpc: null, pending: true },
      ],
      missingKeywords: ['a'],
    });
    const read = await serverFor(READ_CONTEXT).invoke('seo_gsc_enriched_queries', {});
    expect(read.pending).toBe(1);
    expect(queueMock.add).not.toHaveBeenCalled();

    const root = await serverFor(ROOT_CONTEXT).invoke('seo_gsc_enriched_queries', { projectId: 'project-1' });
    expect(root.note).toMatch(/queued/);
    expect(queueMock.add).toHaveBeenCalledWith(
      'seoKeywordMetrics',
      { type: 'seoKeywordMetrics', payload: { projectId: 'project-1', keywords: ['a'] } },
      { jobId: expect.stringMatching(/^seoKeywordMetrics:project-1:/) },
    );
  });
});

describe('tracking', () => {
  it('merges tracked keywords with their latest positions', async () => {
    dbFns.listTrackedKeywords.mockResolvedValue([
      { id: 'k1', keyword: 'shoes', tags: ['brand'], source: 'manual', isActive: true, searchVolume: 100, difficulty: 30, cpc: 0.5 },
    ]);
    dbFns.getLatestRankings.mockResolvedValue([
      { keyword: 'shoes', device: 'desktop', position: 4, url: 'https://me.com/shoes', serpFeatures: [], checkedAt: '2026-09-06 10:00:00', previous7: 6, previous30: null, hasPrevious7: true, hasPrevious30: false },
      { keyword: 'shoes', device: 'mobile', position: null, url: null, serpFeatures: [], checkedAt: '2026-09-06 10:00:00', previous7: null, previous30: null, hasPrevious7: false, hasPrevious30: false },
    ]);
    dbFns.getLastCompletedRankRun.mockResolvedValue(null);
    dbFns.getActiveRankRun.mockResolvedValue(null);
    dbFns.getSeoProjectConfig.mockResolvedValue({ serpDepth: 20, devices: 'both' });

    const result = await serverFor(READ_CONTEXT).invoke('seo_tracked_keywords', {});
    expect(result.total).toBe(1);
    expect(result.ranked).toBe(1);
    const row = Object.fromEntries(result.columns.map((column: string, index: number) => [column, result.rows[0][index]]));
    expect(row).toMatchObject({
      keyword: 'shoes',
      desktopPosition: 4,
      desktopDelta7: 2,
      mobilePosition: null,
      tags: 'brand',
      url: 'https://me.com/shoes',
    });
  });

  it('returns a capped history series', async () => {
    const points = Array.from({ length: 200 }, (_, index) => ({
      date: `2026-01-${String((index % 28) + 1).padStart(2, '0')}`,
      position: index,
      url: null,
      gscPosition: null,
    }));
    dbFns.getRankHistory.mockResolvedValue(points);
    const result = await serverFor(READ_CONTEXT).invoke('seo_rank_history', {
      keyword: '  Running   Shoes ',
    });
    expect(dbFns.getRankHistory).toHaveBeenCalledWith(
      expect.objectContaining({ keyword: 'running shoes', device: 'desktop' }),
    );
    expect(result.keyword).toBe('running shoes');
    expect(result.series.rows).toHaveLength(180);
    expect(result.series_note).toMatch(/most recent 180 of 200/);
  });

  it('tracks keywords and queues the metrics fetch', async () => {
    dbFns.addTrackedKeywords.mockResolvedValue({ added: ['shoes'], existing: ['boots'], keywords: [] });
    const result = await serverFor(ROOT_CONTEXT).invoke('seo_track_keywords', {
      projectId: 'project-1',
      keywords: ['shoes', 'boots'],
      tags: ['x'],
    });
    expect(result).toEqual({ added: ['shoes'], alreadyTracked: ['boots'], metricsQueued: true });
    expect(queueMock.add).toHaveBeenCalledWith(
      'seoKeywordMetrics',
      { type: 'seoKeywordMetrics', payload: { projectId: 'project-1', keywords: ['shoes'] } },
      expect.objectContaining({ jobId: expect.any(String) }),
    );
  });

  it('starts a rank check with a cost estimate, and words refusals', async () => {
    dbFns.createRankRun.mockResolvedValue({ ok: true, run: { id: 'run-1', keywordsTotal: 100 } });
    dbFns.getSeoProjectConfig.mockResolvedValue({ serpDepth: 20, devices: 'both' });
    const started = await serverFor(ROOT_CONTEXT).invoke('seo_run_rank_check', { projectId: 'project-1' });
    expect(started).toMatchObject({ started: true, runId: 'run-1', estimatedCostUsd: 0.24 });
    expect(queueMock.add).toHaveBeenCalledWith(
      'seoRankRun',
      { type: 'seoRankRun', payload: { projectId: 'project-1', runId: 'run-1', keywordIds: undefined } },
      { jobId: 'seoRankRun:run-1' },
    );

    dbFns.createRankRun.mockResolvedValue({ ok: false, reason: 'spend_cap', run: {} });
    const refused = await serverFor(ROOT_CONTEXT).invoke('seo_run_rank_check', { projectId: 'project-1' });
    expect(refused).toMatchObject({ started: false, reason: 'spend_cap' });
    expect(refused.message).toMatch(/spend cap/);
  });

  it('estimates live vs queued rank check cost', () => {
    expect(estimateRankCheckCostUsd({ keywords: 5, devices: 'desktop', serpDepth: 10 })).toBe(0.01);
    expect(estimateRankCheckCostUsd({ keywords: 100, devices: 'both', serpDepth: 20 })).toBe(0.24);
  });
});

describe('backlinks', () => {
  const overview = {
    target: 'me.com',
    isOwnDomain: true,
    source: 'snapshot',
    asOf: '2026-09-06T00:00:00.000Z',
    stale: false,
    backlinks: 1200,
    referringDomains: 80,
    referringIps: 70,
    rank: 42,
    spamScore: 12,
    newBacklinks30d: 5,
    lostBacklinks30d: 2,
    newLostDays: 30,
    brokenBacklinks: null,
    referringPages: null,
  };

  it('returns the summary with history and never refreshes for read clients', async () => {
    dbFns.getBacklinkOverview.mockResolvedValue(overview);
    dbFns.getBacklinkHistory.mockResolvedValue({
      target: 'me.com',
      isOwnDomain: true,
      points: [{ date: '2026-09-05', backlinks: 1195, referringDomains: 79, rank: 41, newBacklinks: 4, lostBacklinks: 1 }],
    });
    const result = await serverFor(READ_CONTEXT).invoke('seo_backlinks_summary', {});
    expect(dbFns.getBacklinkOverview).toHaveBeenCalledWith({
      projectId: 'project-1',
      target: undefined,
      allowRefresh: false,
    });
    expect(result.summary).toMatchObject({ backlinks: 1200, domainRank: 42, newBacklinks30d: 5 });
    expect(result.history.rows[0]).toEqual(['2026-09-05', 1195, 79, 41, 4, 1]);
  });

  it('lets root clients refresh and skips history on request', async () => {
    dbFns.getBacklinkOverview.mockResolvedValue(overview);
    const result = await serverFor(ROOT_CONTEXT).invoke('seo_backlinks_summary', {
      projectId: 'project-1',
      target: 'Rival.com',
      includeHistory: false,
    });
    expect(dbFns.getBacklinkOverview).toHaveBeenCalledWith({
      projectId: 'project-1',
      target: 'rival.com',
      allowRefresh: true,
    });
    expect(result.history).toBeUndefined();
    expect(dbFns.getBacklinkHistory).not.toHaveBeenCalled();
  });

  it('passes filters and cursor to the backlinks list and referring domains', async () => {
    dbFns.getBacklinkRows.mockResolvedValue({
      target: 'me.com',
      isOwnDomain: true,
      totalCount: 300,
      nextCursor: '25',
      rows: [
        { urlFrom: 'https://a.com/x', domainFrom: 'a.com', urlTo: 'https://me.com/', anchor: 'me', itemType: 'anchor', dofollow: true, rank: 30, domainFromRank: 50, pageFromRank: 20, spamScore: 5, firstSeen: '2026-01-01 00:00:00 +00:00', lastVisited: null, lostDate: null, isNew: false, isLost: false, isBroken: false },
      ],
    });
    const list = await serverFor(READ_CONTEXT).invoke('seo_backlinks_list', {
      status: 'lost',
      dofollow: true,
      minRank: 10,
      cursor: '0',
    });
    expect(dbFns.getBacklinkRows).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        filters: { status: 'lost', dofollow: true, minRank: 10, search: undefined },
        cursor: '0',
        limit: 25,
      }),
    );
    expect(list.nextCursor).toBe('25');
    expect(list.note).toMatch(/capped query/);

    dbFns.getReferringDomains.mockResolvedValue({
      target: 'me.com',
      isOwnDomain: true,
      totalCount: 1,
      nextCursor: null,
      rows: [{ domain: 'a.com', backlinks: 3, referringPages: 2, rank: 50, spamScore: 5, firstSeen: null, brokenBacklinks: 0 }],
    });
    const domains = await serverFor(READ_CONTEXT).invoke('seo_referring_domains', { sort: 'rank' });
    expect(domains.rows[0]).toEqual(['a.com', 3, 2, 50, 5, null, 0]);
    expect(domains.nextCursor).toBeNull();
  });
});

describe('audit', () => {
  const audit = {
    id: 'audit-1',
    projectId: 'project-1',
    status: 'completed',
    maxPages: 500,
    pagesCrawled: 87,
    score: 91,
    costUsd: 0.01,
    error: null,
    startedAt: new Date('2026-09-01T00:00:00Z'),
    completedAt: new Date('2026-09-01T00:05:00Z'),
    summary: { options: { enableJavascript: false } },
  };

  it('lists audits', async () => {
    dbFns.listAudits.mockResolvedValue([audit]);
    const result = await serverFor(READ_CONTEXT).invoke('seo_audit_list', {});
    expect(result.columns[0]).toBe('id');
    expect(result.rows[0][0]).toBe('audit-1');
    expect(result.rows[0][2]).toBe(91);
  });

  it('defaults issues to the newest completed audit and refuses foreign audits', async () => {
    dbFns.listAudits.mockResolvedValue([{ ...audit, id: 'audit-2', status: 'crawling' }, audit]);
    dbFns.getAuditIssueSummary.mockResolvedValue({
      totals: { critical: 1, warning: 0, info: 0 },
      issues: [{ key: 'no_title', label: 'Missing title', severity: 'critical', description: 'd', howToFix: 'h', count: 4 }],
    });
    const result = await serverFor(READ_CONTEXT).invoke('seo_audit_issues', {});
    expect(dbFns.getAuditIssueSummary).toHaveBeenCalledWith({ projectId: 'project-1', auditId: 'audit-1' });
    expect(result.rows[0]).toEqual(['no_title', 'critical', 'Missing title', 4, 'd', 'h']);

    dbFns.getAudit.mockResolvedValue({ ...audit, projectId: 'someone-else' });
    const foreign = await serverFor(READ_CONTEXT).invoke('seo_audit_issues', { auditId: 'audit-9' });
    expect(foreign.error).toMatch(/not found for this project/);
  });

  it('lists pages with issue keys', async () => {
    dbFns.getAudit.mockResolvedValue(audit);
    dbFns.listAuditPages.mockResolvedValue({
      total: 1,
      nextCursor: null,
      pages: [
        { url: 'https://me.com/', statusCode: 200, onpageScore: 70, title: 'Home', wordCount: 300, loadTimeMs: 400, isIndexable: true, issues: [{ key: 'no_title' }, { key: 'thin' }] },
      ],
    });
    const result = await serverFor(READ_CONTEXT).invoke('seo_audit_pages', { auditId: 'audit-1', issue: 'no_title' });
    expect(dbFns.listAuditPages).toHaveBeenCalledWith(
      expect.objectContaining({ auditId: 'audit-1', issue: 'no_title', limit: 25 }),
    );
    expect(result.rows[0]).toEqual(['https://me.com/', 200, 70, 'Home', 300, 400, true, 'no_title, thin']);
  });

  it('starts an audit with an estimate and enqueues the crawl', async () => {
    dbFns.createAudit.mockResolvedValue({ ok: true, audit: { ...audit, status: 'queued' } });
    const result = await serverFor(ROOT_CONTEXT).invoke('seo_start_audit', {
      projectId: 'project-1',
      maxPages: 200,
    });
    expect(dbFns.createAudit).toHaveBeenCalledWith({ projectId: 'project-1', maxPages: 200, enableJavascript: false });
    expect(result).toMatchObject({ started: true, estimatedCostUsd: 0.025 });
    expect(queueMock.add).toHaveBeenCalledWith(
      'seoAuditStart',
      { type: 'seoAuditStart', payload: { projectId: 'project-1', auditId: 'audit-1' } },
      { jobId: 'seoAuditStart:audit-1' },
    );

    dbFns.createAudit.mockResolvedValue({ ok: false, reason: 'already_running', audit });
    const refused = await serverFor(ROOT_CONTEXT).invoke('seo_start_audit', { projectId: 'project-1' });
    expect(refused).toMatchObject({ started: false, reason: 'already_running' });
  });
});

describe('ai', () => {
  it('shapes mentions with cited domains', async () => {
    dbFns.getAiMentions.mockResolvedValue({
      target: { type: 'domain', value: 'me.com' },
      engines: ['chat_gpt'],
      mentions: [
        {
          engine: 'chat_gpt',
          question: 'best shoes?',
          aiSearchVolume: 50,
          sources: [{ url: 'https://me.com/a', domain: 'me.com', title: null }],
          brandEntities: ['Me'],
          firstResponseAt: null,
          lastResponseAt: '2026-09-01 00:00:00 +00:00',
        },
      ],
      citedDomains: [{ domain: 'me.com', answers: 1, citations: 1, isOwn: true, isCompetitor: false }],
    });
    const result = await serverFor(READ_CONTEXT).invoke('seo_ai_mentions', { prompt: 'best shoes?' });
    expect(dbFns.getAiMentions).toHaveBeenCalledWith({
      projectId: 'project-1',
      target: { type: 'keyword', value: 'best shoes?' },
      engines: undefined,
      limit: 25,
    });
    expect(result.mentions.rows[0]).toEqual(['chat_gpt', 'best shoes?', 50, '2026-09-01', 'Me', 'https://me.com/a']);
    expect(result.citedDomains.rows[0]).toEqual(['me.com', 1, 1, true, false]);
  });

  it('shapes share of voice per engine', async () => {
    dbFns.getAiShareOfVoice.mockResolvedValue({
      engines: ['chat_gpt', 'google'],
      groups: [
        { domain: 'me.com', isOwn: true, mentions: 30, aiSearchVolume: 1000, share: 75, perEngine: { chat_gpt: 20, google: 10 } },
        { domain: 'rival.com', isOwn: false, mentions: 10, aiSearchVolume: 200, share: 25, perEngine: { chat_gpt: 5, google: 5 } },
      ],
    });
    const result = await serverFor(READ_CONTEXT).invoke('seo_ai_share_of_voice', { engines: ['chat_gpt', 'google'] });
    expect(result.columns).toEqual(['domain', 'isOwn', 'mentions', 'sharePct', 'aiSearchVolume', 'mentions_chat_gpt', 'mentions_google']);
    expect(result.rows[0]).toEqual(['me.com', true, 30, 75, 1000, 20, 10]);
  });
});
