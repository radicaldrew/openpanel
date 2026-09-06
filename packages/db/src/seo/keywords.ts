import type {
  DataforseoClient,
  DomainRankedKeywordItem,
  LabsKeywordDataItem,
  LabsMonthlySearch,
  MonthlySearch,
  SerpLiveItem,
} from '@openpanel/dataforseo';
import { getGscQueries } from '../gsc';
import { SEO_CACHE_TTL_SECONDS, withSeoCache } from './cache';
import { getDfsClientForOrganization, getProjectOrganizationId } from './client';
import { getSeoProjectConfig } from './config';
import {
  fetchAndStoreKeywordMetrics,
  getKeywordMetrics,
  type SeoKeywordMetrics,
} from './keyword-metrics';
import { normalizeTrackedKeyword } from './tracking';

/** Top-10 is what the SERP drawer shows; DFS bills per page of 10. */
const SERP_PREVIEW_DEPTH = 10;
const RANKED_KEYWORDS_DEFAULT_LIMIT = 100;

/**
 * Thrown when a project has no SeoProjectConfig row yet. The gate normally
 * prevents this, but MCP tools and stale tabs can still get here; routers map
 * it to PRECONDITION_FAILED with code SEO_CONFIG_MISSING.
 */
export class SeoConfigMissingError extends Error {
  readonly code = 'SEO_CONFIG_MISSING' as const;
  readonly projectId: string;

  constructor(projectId: string) {
    super(
      `Project ${projectId} has no SEO configuration yet. Set a domain, location and language first.`
    );
    this.name = 'SeoConfigMissingError';
    this.projectId = projectId;
  }
}

export interface SeoResearchContext {
  projectId: string;
  organizationId: string;
  client: DataforseoClient;
  domain: string;
  locationCode: number;
  languageCode: string;
  competitors: string[];
}

/** Everything a research call needs: org key, market and the tracked domain. */
export async function getSeoResearchContext(
  projectId: string
): Promise<SeoResearchContext> {
  const [organizationId, config] = await Promise.all([
    getProjectOrganizationId(projectId),
    getSeoProjectConfig(projectId),
  ]);
  if (!config?.domain) {
    throw new SeoConfigMissingError(projectId);
  }
  const client = await getDfsClientForOrganization(organizationId);
  return {
    projectId,
    organizationId,
    client,
    domain: config.domain,
    locationCode: config.locationCode,
    languageCode: config.languageCode,
    competitors: config.competitors,
  };
}

export type KeywordIntent =
  | 'informational'
  | 'commercial'
  | 'transactional'
  | 'navigational'
  | null;

export interface KeywordResearchRow {
  keyword: string;
  searchVolume: number | null;
  difficulty: number | null;
  cpc: number | null;
  competition: number | null;
  intent: KeywordIntent;
  /** Up to 12 months, oldest first. */
  monthlySearches: MonthlySearch[];
}

const INTENTS = new Set([
  'informational',
  'commercial',
  'transactional',
  'navigational',
]);

function toIntent(value: string | null | undefined): KeywordIntent {
  const normalized = value?.toLowerCase() ?? '';
  return INTENTS.has(normalized) ? (normalized as KeywordIntent) : null;
}

function toMonthlySearches(
  entries: LabsMonthlySearch[] | null | undefined
): MonthlySearch[] {
  const rows = (entries ?? [])
    .filter((entry) => entry.year != null && entry.month != null)
    .map((entry) => ({
      year: entry.year ?? 0,
      month: entry.month ?? 0,
      searchVolume: entry.search_volume ?? 0,
    }));
  rows.sort((a, b) => a.year - b.year || a.month - b.month);
  return rows.slice(-12);
}

/** Normalize a Labs keyword item (ideas, suggestions, overview). */
export function toKeywordResearchRow(
  item: LabsKeywordDataItem
): KeywordResearchRow | null {
  const keyword = item.keyword?.trim();
  if (!keyword) {
    return null;
  }
  const info = item.keyword_info;
  return {
    keyword,
    searchVolume: info?.search_volume ?? null,
    difficulty: item.keyword_properties?.keyword_difficulty ?? null,
    cpc: info?.cpc ?? null,
    competition: info?.competition ?? null,
    intent: toIntent(item.search_intent_info?.main_intent),
    monthlySearches: toMonthlySearches(info?.monthly_searches),
  };
}

function dedupeRows(rows: Array<KeywordResearchRow | null>): KeywordResearchRow[] {
  const seen = new Set<string>();
  const result: KeywordResearchRow[] = [];
  for (const row of rows) {
    if (!row) {
      continue;
    }
    const key = row.keyword.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(row);
  }
  return result;
}

interface SeedInput {
  projectId: string;
  seed: string;
  limit: number;
}

function marketParams(ctx: SeoResearchContext) {
  return { locationCode: ctx.locationCode, languageCode: ctx.languageCode };
}

export async function researchKeywordIdeas({
  projectId,
  seed,
  limit,
}: SeedInput): Promise<KeywordResearchRow[]> {
  const ctx = await getSeoResearchContext(projectId);
  const params = { keyword: seed, limit, ...marketParams(ctx) };
  const items = await withSeoCache(
    {
      organizationId: ctx.organizationId,
      endpoint: 'labs/keyword_ideas',
      params,
      ttl: 'labs',
    },
    async () => (await ctx.client.keywords.ideas(params)).data
  );
  return dedupeRows(items.map(toKeywordResearchRow));
}

export async function researchKeywordSuggestions({
  projectId,
  seed,
  limit,
}: SeedInput): Promise<KeywordResearchRow[]> {
  const ctx = await getSeoResearchContext(projectId);
  const params = { keyword: seed, limit, ...marketParams(ctx) };
  const items = await withSeoCache(
    {
      organizationId: ctx.organizationId,
      endpoint: 'labs/keyword_suggestions',
      params,
      ttl: 'labs',
    },
    async () => (await ctx.client.keywords.suggestions(params)).data
  );
  return dedupeRows(items.map(toKeywordResearchRow));
}

export async function researchRelatedKeywords({
  projectId,
  seed,
  limit,
}: SeedInput): Promise<KeywordResearchRow[]> {
  const ctx = await getSeoResearchContext(projectId);
  const params = { keyword: seed, limit, ...marketParams(ctx) };
  const items = await withSeoCache(
    {
      organizationId: ctx.organizationId,
      endpoint: 'labs/related_keywords',
      params,
      ttl: 'labs',
    },
    async () => (await ctx.client.keywords.related(params)).data
  );
  return dedupeRows(
    items.map((item) =>
      item.keyword_data ? toKeywordResearchRow(item.keyword_data) : null
    )
  );
}

function metricsToRow(metric: SeoKeywordMetrics): KeywordResearchRow {
  return {
    keyword: metric.keyword,
    searchVolume: metric.searchVolume,
    difficulty: metric.difficulty,
    cpc: metric.cpc,
    competition: metric.competition,
    intent: null,
    monthlySearches: metric.monthly,
  };
}

/**
 * labs/keyword_overview for an explicit keyword list. Goes through
 * fetchAndStoreKeywordMetrics so the result also lands in
 * seo_keyword_metrics and on any matching tracked keywords.
 */
export async function getKeywordOverview({
  projectId,
  keywords,
  now = new Date(),
}: {
  projectId: string;
  keywords: string[];
  now?: Date;
}): Promise<KeywordResearchRow[]> {
  const unique = Array.from(
    new Set(keywords.map((keyword) => normalizeTrackedKeyword(keyword)).filter(Boolean))
  );
  if (unique.length === 0) {
    return [];
  }

  // seo_keyword_metrics is the cache for this endpoint: only keywords with no
  // row, or a row older than the Labs TTL, cost a DataForSEO call.
  const stored = await getKeywordMetrics(projectId, unique);
  const freshAfter = now.getTime() - SEO_CACHE_TTL_SECONDS.labs * 1000;
  // fetched_at comes back as 'YYYY-MM-DD HH:MM:SS' (UTC) from ClickHouse.
  const parseFetchedAt = (value: string) =>
    /[zZ]|[+-]\d\d:\d\d$/.test(value)
      ? new Date(value).getTime()
      : new Date(`${value.replace(' ', 'T')}Z`).getTime();
  const isFresh = (metric: SeoKeywordMetrics) =>
    parseFetchedAt(metric.fetchedAt) >= freshAfter;
  const toFetch = unique.filter((keyword) => {
    const metric = stored.get(keyword);
    return !(metric && isFresh(metric));
  });

  const fetched = toFetch.length > 0 ? await fetchAndStoreKeywordMetrics(projectId, toFetch) : [];
  const fetchedByKeyword = new Map(fetched.map((metric) => [metric.keyword, metric]));

  const rows: KeywordResearchRow[] = [];
  for (const keyword of unique) {
    const metric = fetchedByKeyword.get(keyword) ?? stored.get(keyword);
    if (metric) {
      rows.push(metricsToRow(metric));
    }
  }
  return rows;
}

export interface RankedKeywordRow extends KeywordResearchRow {
  position: number | null;
  url: string | null;
  etv: number | null;
}

function toRankedKeywordRow(
  item: DomainRankedKeywordItem
): RankedKeywordRow | null {
  const keywordData = item.keyword_data;
  const keyword = (keywordData?.keyword ?? item.keyword)?.trim();
  if (!keyword) {
    return null;
  }
  const serp = item.ranked_serp_element;
  const serpItem = serp?.serp_item;
  return {
    keyword,
    searchVolume: keywordData?.keyword_info?.search_volume ?? null,
    difficulty:
      keywordData?.keyword_properties?.keyword_difficulty ??
      keywordData?.keyword_info?.keyword_difficulty ??
      null,
    cpc: keywordData?.keyword_info?.cpc ?? null,
    competition: null,
    intent: null,
    monthlySearches: [],
    position: serpItem?.rank_absolute ?? serp?.rank_absolute ?? null,
    url: serpItem?.url ?? serp?.url ?? null,
    etv: serpItem?.etv ?? serp?.etv ?? null,
  };
}

/**
 * labs/ranked_keywords for the project's own domain or one of its configured
 * competitors. Any other target is refused so a research tab cannot be used
 * to spend the org's budget on arbitrary domains.
 */
export async function getRankedKeywords({
  projectId,
  domain,
  limit = RANKED_KEYWORDS_DEFAULT_LIMIT,
  offset = 0,
}: {
  projectId: string;
  domain?: string;
  limit?: number;
  offset?: number;
}): Promise<{ rows: RankedKeywordRow[]; totalCount: number | null; target: string }> {
  const ctx = await getSeoResearchContext(projectId);
  const target = (domain ?? ctx.domain).trim().toLowerCase();
  const allowed = new Set([ctx.domain, ...ctx.competitors].map((d) => d.toLowerCase()));
  if (!allowed.has(target)) {
    throw new Error(
      `Domain ${target} is neither the tracked domain nor a configured competitor`
    );
  }
  const params = {
    target,
    limit,
    offset,
    orderBy: ['ranked_serp_element.serp_item.etv,desc'],
    ...marketParams(ctx),
  };
  const page = await withSeoCache(
    {
      organizationId: ctx.organizationId,
      endpoint: 'labs/ranked_keywords',
      params,
      ttl: 'labs',
    },
    async () => (await ctx.client.domain.rankedKeywords(params)).data
  );
  const seen = new Set<string>();
  const rows: RankedKeywordRow[] = [];
  for (const item of page.items) {
    const row = toRankedKeywordRow(item);
    if (row && !seen.has(row.keyword.toLowerCase())) {
      seen.add(row.keyword.toLowerCase());
      rows.push(row);
    }
  }
  return { rows, totalCount: page.totalCount, target };
}

export interface SerpPreviewItem {
  type: string;
  rank: number | null;
  domain: string | null;
  url: string | null;
  title: string | null;
  description: string | null;
  isOwnDomain: boolean;
}

export interface SerpPreview {
  keyword: string;
  domain: string;
  /** Organic results in rank order, top 10. */
  results: SerpPreviewItem[];
  /** Non-organic element types present on the page (people_also_ask, video, …). */
  features: string[];
  ownPosition: number | null;
}

function hostMatches(host: string | null | undefined, domain: string): boolean {
  if (!host) {
    return false;
  }
  const normalized = host.toLowerCase().replace(/^www\./, '');
  return normalized === domain || normalized.endsWith(`.${domain}`);
}

export function toSerpPreview(
  keyword: string,
  domain: string,
  items: SerpLiveItem[]
): SerpPreview {
  const ownDomain = domain.toLowerCase().replace(/^www\./, '');
  const results: SerpPreviewItem[] = [];
  const features = new Set<string>();
  for (const item of items) {
    if (item.type === 'organic') {
      if (results.length >= SERP_PREVIEW_DEPTH) {
        continue;
      }
      results.push({
        type: item.type,
        rank: item.rank_absolute ?? item.rank_group ?? null,
        domain: item.domain ?? null,
        url: item.url ?? null,
        title: item.title ?? null,
        description: item.description ?? null,
        isOwnDomain: hostMatches(item.domain, ownDomain),
      });
    } else {
      features.add(item.type);
    }
  }
  const own = results.find((result) => result.isOwnDomain);
  return {
    keyword,
    domain,
    results,
    features: Array.from(features).sort(),
    ownPosition: own?.rank ?? null,
  };
}

/** serp/google/organic/live/advanced, top 10, cached 6 h. */
export async function getSerpPreview({
  projectId,
  keyword,
}: {
  projectId: string;
  keyword: string;
}): Promise<SerpPreview> {
  const ctx = await getSeoResearchContext(projectId);
  const params = {
    keyword: keyword.trim(),
    depth: SERP_PREVIEW_DEPTH,
    ...marketParams(ctx),
  };
  const items = await withSeoCache(
    {
      organizationId: ctx.organizationId,
      endpoint: 'serp/google/organic/live/advanced',
      params,
      ttl: 'serpLive',
    },
    async () => (await ctx.client.serp.live(params)).data
  );
  return toSerpPreview(params.keyword, ctx.domain, items);
}

export interface GscEnrichedQueryRow {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  searchVolume: number | null;
  difficulty: number | null;
  cpc: number | null;
  /** True when no metrics exist yet; the caller has queued a fetch. */
  pending: boolean;
}

/**
 * The join from SEO.md §7: top-N Search Console queries left-joined with
 * seo_keyword_metrics. Rows without metrics come back `pending` and are
 * listed in `missingKeywords` so the caller can enqueue one batched
 * seoKeywordMetrics job (the queue dependency stays out of this package).
 */
export async function getGscQueriesWithMetrics({
  projectId,
  startDate,
  endDate,
  limit,
}: {
  projectId: string;
  startDate: string;
  endDate: string;
  limit: number;
}): Promise<{ rows: GscEnrichedQueryRow[]; missingKeywords: string[] }> {
  const queries = await getGscQueries(projectId, startDate, endDate, limit);
  if (queries.length === 0) {
    return { rows: [], missingKeywords: [] };
  }
  const metrics = await getKeywordMetrics(
    projectId,
    queries.map((row) => row.query)
  );
  const missing = new Set<string>();
  const rows = queries.map((row) => {
    const normalized = normalizeTrackedKeyword(row.query);
    const metric = metrics.get(normalized);
    if (!metric && normalized) {
      // Normalized so two spellings of one query become one job keyword.
      missing.add(normalized);
    }
    return {
      ...row,
      searchVolume: metric?.searchVolume ?? null,
      difficulty: metric?.difficulty ?? null,
      cpc: metric?.cpc ?? null,
      pending: !metric,
    };
  });
  return { rows, missingKeywords: Array.from(missing) };
}
