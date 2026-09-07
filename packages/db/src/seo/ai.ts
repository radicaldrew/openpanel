import {
  buildLlmTarget,
  CHATGPT_LANGUAGE_CODE,
  CHATGPT_LOCATION_CODE,
  type LlmAggregatedTotal,
  type LlmCrossAggregatedItem,
  type LlmMentionItem,
  type LlmPlatform,
  type LlmTopPagesItem,
} from '@openpanel/dataforseo';
import { resolveKeywordDataLanguage } from '@openpanel/dataforseo';
import sqlstring from 'sqlstring';
import { chQuery, TABLE_NAMES } from '../clickhouse/client';
import { withSeoCache } from './cache';
import { getSeoResearchContext, type SeoResearchContext } from './keywords';

// ---------------------------------------------------------------------------
// Engines. DataForSEO's LLM-mentions endpoints know two platforms: ChatGPT
// and Google (AI Overviews / AI Mode). Everything DFS-side is keyed by these.
// ---------------------------------------------------------------------------

export const AI_ENGINES = ['chat_gpt', 'google'] as const satisfies readonly LlmPlatform[];
export type AiEngine = (typeof AI_ENGINES)[number];

export const AI_ENGINE_LABELS: Record<AiEngine, string> = {
  chat_gpt: 'ChatGPT',
  google: 'Google AI',
};

const DEFAULT_MENTIONS_LIMIT = 50;
const MAX_MENTIONS_LIMIT = 200;
const DEFAULT_TOP_PAGES_LIMIT = 10;
const MAX_CROSS_GROUPS = 10;

/**
 * ChatGPT mention data exists for US/en only; Google follows the project.
 * Like the keyword APIs, LLM-mentions data only exists in a country's own
 * languages (Israel: he/ar), so an unserved SERP language falls back to the
 * country default instead of a charged "Invalid Field: 'language_code'".
 */
function marketFor(engine: AiEngine, ctx: SeoResearchContext) {
  if (engine === 'chat_gpt') {
    return { locationCode: CHATGPT_LOCATION_CODE, languageCode: CHATGPT_LANGUAGE_CODE };
  }
  return {
    locationCode: ctx.locationCode,
    languageCode: resolveKeywordDataLanguage(ctx.locationCode, ctx.languageCode),
  };
}

function normalizeEngines(engines: readonly string[] | undefined): AiEngine[] {
  const wanted = new Set(engines ?? AI_ENGINES);
  return AI_ENGINES.filter((engine) => wanted.has(engine));
}

function normalizeDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '');
}

function domainMatches(candidate: string, domain: string): boolean {
  return candidate === domain || candidate.endsWith(`.${domain}`);
}

/**
 * Only the tracked domain or a configured competitor may be a domain target:
 * the same rule dev3 applies to ranked_keywords, so a research tab cannot be
 * pointed at arbitrary domains on the org's budget. Keyword targets (prompts)
 * are free text.
 */
export function assertAllowedAiDomain(
  ctx: Pick<SeoResearchContext, 'domain' | 'competitors'>,
  domain: string
): string {
  const target = normalizeDomain(domain);
  const allowed = new Set(
    [ctx.domain, ...ctx.competitors].map((value) => normalizeDomain(value))
  );
  if (!allowed.has(target)) {
    throw new Error(
      `Domain ${target} is neither the tracked domain nor a configured competitor`
    );
  }
  return target;
}

function sumGroup(
  elements: { mentions?: number | null; ai_search_volume?: number | null; impressions?: number | null }[] | null | undefined
) {
  let mentions = 0;
  let aiSearchVolume = 0;
  let impressions = 0;
  for (const element of elements ?? []) {
    mentions += element.mentions ?? 0;
    aiSearchVolume += element.ai_search_volume ?? 0;
    impressions += element.impressions ?? 0;
  }
  return { mentions, aiSearchVolume, impressions };
}

// ---------------------------------------------------------------------------
// Mentions (also the prompt explorer: a keyword target is the prompt)
// ---------------------------------------------------------------------------

export type AiMentionTarget =
  | { type: 'domain'; value: string }
  | { type: 'keyword'; value: string };

export interface AiMentionSource {
  url: string | null;
  domain: string | null;
  title: string | null;
}

export interface AiMention {
  engine: AiEngine;
  question: string;
  aiSearchVolume: number | null;
  sources: AiMentionSource[];
  brandEntities: string[];
  firstResponseAt: string | null;
  lastResponseAt: string | null;
}

export interface AiCitedDomain {
  domain: string;
  /** Number of answers citing the domain at least once. */
  answers: number;
  /** Total citations across those answers. */
  citations: number;
  isOwn: boolean;
  isCompetitor: boolean;
}

export interface AiMentionsResult {
  target: AiMentionTarget;
  engines: AiEngine[];
  mentions: AiMention[];
  citedDomains: AiCitedDomain[];
}

export function normalizeMentionItem(engine: AiEngine, item: LlmMentionItem): AiMention {
  return {
    engine,
    question: item.question ?? '',
    aiSearchVolume: item.ai_search_volume ?? null,
    sources: (item.sources ?? []).map((source) => ({
      url: source.url ?? null,
      domain: source.domain ? normalizeDomain(source.domain) : null,
      title: source.title ?? null,
    })),
    brandEntities: (item.brand_entities ?? [])
      .map((entity) => entity.title ?? '')
      .filter((title) => title.length > 0),
    firstResponseAt: item.first_response_at ?? null,
    lastResponseAt: item.last_response_at ?? null,
  };
}

/** Roll citations up by domain, own domain and competitors flagged. */
export function summarizeCitedDomains(
  mentions: AiMention[],
  ctx: Pick<SeoResearchContext, 'domain' | 'competitors'>
): AiCitedDomain[] {
  const own = normalizeDomain(ctx.domain);
  const competitors = ctx.competitors.map((value) => normalizeDomain(value));
  const buckets = new Map<string, { answers: number; citations: number }>();

  for (const mention of mentions) {
    const seenInAnswer = new Set<string>();
    for (const source of mention.sources) {
      if (!source.domain) {
        continue;
      }
      const bucket = buckets.get(source.domain) ?? { answers: 0, citations: 0 };
      bucket.citations += 1;
      if (!seenInAnswer.has(source.domain)) {
        bucket.answers += 1;
        seenInAnswer.add(source.domain);
      }
      buckets.set(source.domain, bucket);
    }
  }

  return [...buckets.entries()]
    .map(([domain, bucket]) => ({
      domain,
      answers: bucket.answers,
      citations: bucket.citations,
      isOwn: domainMatches(domain, own),
      isCompetitor: competitors.some((competitor) => domainMatches(domain, competitor)),
    }))
    .sort((a, b) => b.answers - a.answers || b.citations - a.citations);
}

export async function getAiMentions({
  projectId,
  target,
  engines,
  limit = DEFAULT_MENTIONS_LIMIT,
}: {
  projectId: string;
  target?: AiMentionTarget;
  engines?: readonly string[];
  limit?: number;
}): Promise<AiMentionsResult> {
  const ctx = await getSeoResearchContext(projectId);
  const resolvedTarget: AiMentionTarget =
    target?.type === 'keyword'
      ? { type: 'keyword', value: target.value.trim() }
      : { type: 'domain', value: assertAllowedAiDomain(ctx, target?.value ?? ctx.domain) };
  if (!resolvedTarget.value) {
    throw new Error('A prompt or domain is required');
  }
  const wanted = normalizeEngines(engines);
  const cappedLimit = Math.min(Math.max(1, limit), MAX_MENTIONS_LIMIT);

  const perEngine = await Promise.all(
    wanted.map(async (engine) => {
      const params = {
        target: buildLlmTarget(resolvedTarget),
        platform: engine,
        limit: cappedLimit,
        ...marketFor(engine, ctx),
      };
      const items = await withSeoCache(
        {
          organizationId: ctx.organizationId,
          endpoint: 'ai/llm_mentions/search',
          params,
          ttl: 'aiSearch',
        },
        async () => (await ctx.client.aiSearch.mentionsSearch(params)).data
      );
      return items.map((item) => normalizeMentionItem(engine, item));
    })
  );

  const mentions = perEngine
    .flat()
    .sort((a, b) => (b.aiSearchVolume ?? 0) - (a.aiSearchVolume ?? 0));
  return {
    target: resolvedTarget,
    engines: wanted,
    mentions,
    citedDomains: summarizeCitedDomains(mentions, ctx),
  };
}

// ---------------------------------------------------------------------------
// Aggregate (mention counts per engine)
// ---------------------------------------------------------------------------

export interface AiEngineTotals {
  engine: AiEngine;
  label: string;
  mentions: number;
  aiSearchVolume: number;
  impressions: number;
}

export interface AiAggregateResult {
  domain: string;
  engines: AiEngineTotals[];
  totals: { mentions: number; aiSearchVolume: number; impressions: number };
}

export function normalizeAggregatedTotal(
  engine: AiEngine,
  total: LlmAggregatedTotal
): AiEngineTotals {
  return { engine, label: AI_ENGINE_LABELS[engine], ...sumGroup(total.platform) };
}

async function fetchAggregateForDomain(
  ctx: SeoResearchContext,
  domain: string,
  engines: AiEngine[]
): Promise<AiEngineTotals[]> {
  return Promise.all(
    engines.map(async (engine) => {
      const params = {
        target: buildLlmTarget({ type: 'domain', value: domain }),
        platform: engine,
        ...marketFor(engine, ctx),
      };
      const total = await withSeoCache(
        {
          organizationId: ctx.organizationId,
          endpoint: 'ai/llm_mentions/aggregated_metrics',
          params,
          ttl: 'aiSearch',
        },
        async () => (await ctx.client.aiSearch.aggregatedMetrics(params)).data
      );
      return normalizeAggregatedTotal(engine, total);
    })
  );
}

export async function getAiAggregate({
  projectId,
  engines,
}: {
  projectId: string;
  engines?: readonly string[];
}): Promise<AiAggregateResult> {
  const ctx = await getSeoResearchContext(projectId);
  const domain = normalizeDomain(ctx.domain);
  const rows = await fetchAggregateForDomain(ctx, domain, normalizeEngines(engines));
  return {
    domain,
    engines: rows,
    totals: rows.reduce(
      (acc, row) => ({
        mentions: acc.mentions + row.mentions,
        aiSearchVolume: acc.aiSearchVolume + row.aiSearchVolume,
        impressions: acc.impressions + row.impressions,
      }),
      { mentions: 0, aiSearchVolume: 0, impressions: 0 }
    ),
  };
}

// ---------------------------------------------------------------------------
// Share of voice vs configured competitors
// ---------------------------------------------------------------------------

export interface AiShareOfVoiceGroup {
  domain: string;
  isOwn: boolean;
  mentions: number;
  aiSearchVolume: number;
  /** Percentage of mentions across every group, summed over engines. */
  share: number;
  perEngine: Record<AiEngine, number>;
}

export interface AiShareOfVoiceResult {
  engines: AiEngine[];
  groups: AiShareOfVoiceGroup[];
}

function emptyPerEngine(): Record<AiEngine, number> {
  return { chat_gpt: 0, google: 0 };
}

export function normalizeCrossAggregated(
  domains: string[],
  own: string,
  perEngineItems: { engine: AiEngine; items: LlmCrossAggregatedItem[] }[]
): AiShareOfVoiceGroup[] {
  const groups = new Map<string, AiShareOfVoiceGroup>(
    domains.map((domain) => [
      domain,
      {
        domain,
        isOwn: domain === own,
        mentions: 0,
        aiSearchVolume: 0,
        share: 0,
        perEngine: emptyPerEngine(),
      },
    ])
  );

  for (const { engine, items } of perEngineItems) {
    for (const item of items) {
      const group = item.key ? groups.get(item.key) : undefined;
      if (!group) {
        continue;
      }
      const sums = sumGroup(item.platform);
      group.mentions += sums.mentions;
      group.aiSearchVolume += sums.aiSearchVolume;
      group.perEngine[engine] += sums.mentions;
    }
  }

  const total = [...groups.values()].reduce((sum, group) => sum + group.mentions, 0);
  return [...groups.values()]
    .map((group) => ({
      ...group,
      share: total > 0 ? (group.mentions / total) * 100 : 0,
    }))
    .sort((a, b) => b.mentions - a.mentions);
}

export async function getAiShareOfVoice({
  projectId,
  engines,
}: {
  projectId: string;
  engines?: readonly string[];
}): Promise<AiShareOfVoiceResult> {
  const ctx = await getSeoResearchContext(projectId);
  const wanted = normalizeEngines(engines);
  const own = normalizeDomain(ctx.domain);
  const competitors = [
    ...new Set(ctx.competitors.map((value) => normalizeDomain(value))),
  ]
    .filter((domain) => domain !== own)
    .slice(0, MAX_CROSS_GROUPS - 1);
  const domains = [own, ...competitors];

  // cross_aggregated_metrics needs at least two groups; with no competitors
  // the own domain is simply 100 % of what there is.
  if (competitors.length === 0) {
    const rows = await fetchAggregateForDomain(ctx, own, wanted);
    const perEngine = emptyPerEngine();
    let mentions = 0;
    let aiSearchVolume = 0;
    for (const row of rows) {
      perEngine[row.engine] = row.mentions;
      mentions += row.mentions;
      aiSearchVolume += row.aiSearchVolume;
    }
    return {
      engines: wanted,
      groups: [
        {
          domain: own,
          isOwn: true,
          mentions,
          aiSearchVolume,
          share: mentions > 0 ? 100 : 0,
          perEngine,
        },
      ],
    };
  }

  const perEngineItems = await Promise.all(
    wanted.map(async (engine) => {
      const params = {
        groups: domains.map((domain) => ({
          key: domain,
          target: buildLlmTarget({ type: 'domain', value: domain }),
        })),
        platform: engine,
        ...marketFor(engine, ctx),
      };
      const items = await withSeoCache(
        {
          organizationId: ctx.organizationId,
          endpoint: 'ai/llm_mentions/cross_aggregated_metrics',
          params,
          ttl: 'aiSearch',
        },
        async () => (await ctx.client.aiSearch.crossAggregatedMetrics(params)).data
      );
      return { engine, items };
    })
  );

  return { engines: wanted, groups: normalizeCrossAggregated(domains, own, perEngineItems) };
}

// ---------------------------------------------------------------------------
// Top cited pages
// ---------------------------------------------------------------------------

export interface AiTopPage {
  url: string;
  mentions: number;
  aiSearchVolume: number;
  impressions: number;
  perEngine: Record<AiEngine, number>;
}

export function normalizeTopPages(
  perEngineItems: { engine: AiEngine; items: LlmTopPagesItem[] }[]
): AiTopPage[] {
  const pages = new Map<string, AiTopPage>();
  for (const { engine, items } of perEngineItems) {
    for (const item of items) {
      if (!item.key) {
        continue;
      }
      const sums = sumGroup(item.platform);
      const page = pages.get(item.key) ?? {
        url: item.key,
        mentions: 0,
        aiSearchVolume: 0,
        impressions: 0,
        perEngine: emptyPerEngine(),
      };
      page.mentions += sums.mentions;
      page.aiSearchVolume += sums.aiSearchVolume;
      page.impressions += sums.impressions;
      page.perEngine[engine] += sums.mentions;
      pages.set(item.key, page);
    }
  }
  return [...pages.values()].sort((a, b) => b.mentions - a.mentions);
}

export async function getAiTopPages({
  projectId,
  engines,
  limit = DEFAULT_TOP_PAGES_LIMIT,
}: {
  projectId: string;
  engines?: readonly string[];
  limit?: number;
}): Promise<{ domain: string; pages: AiTopPage[] }> {
  const ctx = await getSeoResearchContext(projectId);
  const own = normalizeDomain(ctx.domain);
  const perEngineItems = await Promise.all(
    normalizeEngines(engines).map(async (engine) => {
      const params = {
        target: buildLlmTarget({ type: 'domain', value: own }),
        platform: engine,
        itemsListLimit: Math.min(Math.max(1, limit), DEFAULT_TOP_PAGES_LIMIT),
        ...marketFor(engine, ctx),
      };
      const items = await withSeoCache(
        {
          organizationId: ctx.organizationId,
          endpoint: 'ai/llm_mentions/top_pages',
          params,
          ttl: 'aiSearch',
        },
        async () => (await ctx.client.aiSearch.topPages(params)).data
      );
      return { engine, items };
    })
  );
  return { domain: own, pages: normalizeTopPages(perEngineItems) };
}

// ---------------------------------------------------------------------------
// Traffic FROM AI engines: OpenPanel's own sessions whose referrer is an AI
// assistant. Search Console has no notion of AI referrals, so this is the
// only source; it follows the referrer-name matching the gsc router already
// uses for its AI engines card.
// ---------------------------------------------------------------------------

export const AI_REFERRER_ENGINES = [
  {
    canonical: 'chatgpt.com',
    label: 'ChatGPT',
    aliases: ['chatgpt', 'chatgpt.com', 'chat.openai.com', 'openai', 'openai.com'],
  },
  {
    canonical: 'claude.ai',
    label: 'Claude',
    aliases: ['claude', 'claude.ai', 'anthropic', 'anthropic.com'],
  },
  {
    canonical: 'perplexity.ai',
    label: 'Perplexity',
    aliases: ['perplexity', 'perplexity.ai'],
  },
  {
    canonical: 'gemini.google.com',
    label: 'Gemini',
    aliases: ['gemini', 'google gemini', 'gemini.google.com', 'bard.google.com'],
  },
  {
    canonical: 'copilot.microsoft.com',
    label: 'Copilot',
    aliases: [
      'copilot',
      'copilot.com',
      'copilot.microsoft.com',
      'microsoft copilot',
      'bing.com/chat',
      'bing chat',
      'copilot.bing.com',
    ],
  },
  { canonical: 'you.com', label: 'You.com', aliases: ['you.com', 'you'] },
  { canonical: 'grok.com', label: 'Grok', aliases: ['grok', 'grok.com'] },
  {
    canonical: 'mistral.ai',
    label: 'Mistral',
    aliases: ['mistral', 'mistral.ai', 'chat.mistral.ai', 'le chat'],
  },
  {
    canonical: 'kagi.com',
    label: 'Kagi',
    aliases: ['kagi', 'kagi.com', 'assistant.kagi.com'],
  },
] as const satisfies ReadonlyArray<{
  canonical: string;
  label: string;
  aliases: readonly string[];
}>;

export type AiReferrerEngine = (typeof AI_REFERRER_ENGINES)[number]['canonical'];

/**
 * Sessions store the same referrer under several spellings: the parsed
 * display name ('ChatGPT'), the bare host ('chatgpt.com') and the full
 * origin ('https://chat.openai.com'). Both the SQL and this JS twin
 * normalise the same way so tests can pin the matcher.
 */
export function normalizeReferrerName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?/, '');
}

export function matchAiReferrer(referrerName: string): AiReferrerEngine | null {
  const normalized = normalizeReferrerName(referrerName);
  for (const engine of AI_REFERRER_ENGINES) {
    if ((engine.aliases as readonly string[]).includes(normalized)) {
      return engine.canonical;
    }
  }
  return null;
}

export function aiReferrerLabel(canonical: string): string {
  return AI_REFERRER_ENGINES.find((engine) => engine.canonical === canonical)?.label ?? canonical;
}

const NORMALIZED_REFERRER_SQL =
  "lower(regexp_replace(referrer_name, '^https?://(www[.])?', ''))";
const quoteList = (values: readonly string[]) => sqlstring.escape([...values]);
const AI_REFERRER_CTE = `WITH ${NORMALIZED_REFERRER_SQL} AS norm`;
const AI_REFERRER_FILTER = `norm IN (${quoteList(
  AI_REFERRER_ENGINES.flatMap((engine) => engine.aliases)
)})`;
const AI_REFERRER_CANONICAL = `multiIf(${AI_REFERRER_ENGINES.map(
  (engine) =>
    `norm IN (${quoteList(engine.aliases)}), ${sqlstring.escape(engine.canonical)}`
).join(', ')}, norm)`;

/** Exposed for tests: the SQL fragments must agree with the JS matcher. */
export const AI_REFERRER_SQL = {
  cte: AI_REFERRER_CTE,
  filter: AI_REFERRER_FILTER,
  canonical: AI_REFERRER_CANONICAL,
} as const;

/**
 * Half-open windows so the last day is included and the previous window
 * ends exactly where the current one starts.
 */
export function comparisonWindows(startDate: string, endDate: string) {
  const start = new Date(`${startDate}T00:00:00Z`);
  const endExclusive = new Date(`${endDate}T00:00:00Z`);
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
  const previousStart = new Date(
    start.getTime() - (endExclusive.getTime() - start.getTime())
  );
  const format = (date: Date) => date.toISOString().slice(0, 19).replace('T', ' ');
  return {
    current: { start: format(start), end: format(endExclusive) },
    previous: { start: format(previousStart), end: format(start) },
  };
}

export interface AiTrafficEngineRow {
  engine: string;
  label: string;
  sessions: number;
  previousSessions: number;
}

export interface AiTrafficResult {
  engines: AiTrafficEngineRow[];
  total: number;
  previousTotal: number;
  /** Sessions per day from any AI engine, for the trend. */
  series: { date: string; sessions: number }[];
}

export async function getAiEngineTraffic({
  projectId,
  startDate,
  endDate,
}: {
  projectId: string;
  startDate: string;
  endDate: string;
}): Promise<AiTrafficResult> {
  const windows = comparisonWindows(startDate, endDate);
  const where = (window: { start: string; end: string }) =>
    `project_id = ${sqlstring.escape(projectId)}
      AND ${AI_REFERRER_FILTER}
      AND created_at >= ${sqlstring.escape(window.start)}
      AND created_at < ${sqlstring.escape(window.end)}`;

  const [current, previous, series] = await Promise.all([
    chQuery<{ engine: string; sessions: number }>(`
      ${AI_REFERRER_CTE}
      SELECT ${AI_REFERRER_CANONICAL} AS engine, count(*) AS sessions
      FROM ${TABLE_NAMES.sessions}
      WHERE ${where(windows.current)}
      GROUP BY engine
      ORDER BY sessions DESC
    `),
    chQuery<{ engine: string; sessions: number }>(`
      ${AI_REFERRER_CTE}
      SELECT ${AI_REFERRER_CANONICAL} AS engine, count(*) AS sessions
      FROM ${TABLE_NAMES.sessions}
      WHERE ${where(windows.previous)}
      GROUP BY engine
    `),
    chQuery<{ date: string; sessions: number }>(`
      ${AI_REFERRER_CTE}
      SELECT toString(toDate(created_at)) AS date, count(*) AS sessions
      FROM ${TABLE_NAMES.sessions}
      WHERE ${where(windows.current)}
      GROUP BY date
      ORDER BY date
    `),
  ]);

  const previousByEngine = new Map(previous.map((row) => [row.engine, row.sessions]));
  const engines: AiTrafficEngineRow[] = current.map((row) => ({
    engine: row.engine,
    label: aiReferrerLabel(row.engine),
    sessions: row.sessions,
    previousSessions: previousByEngine.get(row.engine) ?? 0,
  }));
  // Engines that had traffic last period but none now still belong in the table.
  for (const row of previous) {
    if (!engines.some((engine) => engine.engine === row.engine)) {
      engines.push({
        engine: row.engine,
        label: aiReferrerLabel(row.engine),
        sessions: 0,
        previousSessions: row.sessions,
      });
    }
  }

  return {
    engines,
    total: current.reduce((sum, row) => sum + row.sessions, 0),
    previousTotal: previous.reduce((sum, row) => sum + row.sessions, 0),
    series,
  };
}
