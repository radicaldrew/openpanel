import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  getGscQueriesWithMetrics,
  getKeywordOverview,
  getSerpPreview,
  normalizeTrackedKeyword,
  researchKeywordIdeas,
  researchKeywordSuggestions,
  researchRelatedKeywords,
} from '@openpanel/db';
import { seoQueue } from '@openpanel/queue';
import { z } from 'zod';
import type { McpAuthContext } from '../../auth';
import {
  projectIdSchema,
  resolveDateRange,
  resolveProjectId,
  table,
  zDateRange,
  zLimit,
} from '../shared';
import { requireWriteScope, withSeoErrorHandling } from './shared';

const DEFAULT_IDEAS_LIMIT = 25;
const MAX_IDEAS_LIMIT = 200;
const MAX_KEYWORD_LENGTH = 200;
const MAX_OVERVIEW_KEYWORDS = 200;
const DEFAULT_GSC_LIMIT = 25;
const MAX_GSC_LIMIT = 200;

const KEYWORD_COLUMNS = [
  'keyword',
  'searchVolume',
  'difficulty',
  'cpc',
  'competition',
  'intent',
] as const;

const zKeyword = z.string().trim().min(1).max(MAX_KEYWORD_LENGTH);

/** Deterministic per keyword set, so a repeated call does not stack jobs. */
export function keywordMetricsJobId(projectId: string, keywords: string[]): string {
  const hash = createHash('sha1')
    .update([...keywords].sort().join('\n'))
    .digest('hex')
    .slice(0, 16);
  return `seoKeywordMetrics:${projectId}:${hash}`;
}

export function registerSeoKeywordTools(server: McpServer, context: McpAuthContext) {
  server.tool(
    'seo_keyword_ideas',
    `Research keywords around a seed term with DataForSEO Labs, in the project's configured country and language: \`ideas\` (keywords sharing words with the seed, by volume), \`suggestions\` (long-tail phrases containing the seed) or \`related\` (what people also search for). Returns volume, difficulty (0–100), CPC, competition and intent. Cached 24h; a fresh call costs about $0.01–0.05 of the organization's DataForSEO balance.`,
    {
      projectId: projectIdSchema(context),
      seed: zKeyword.describe('Seed keyword, e.g. "running shoes"'),
      mode: z
        .enum(['ideas', 'suggestions', 'related'])
        .optional()
        .describe('Research mode (default ideas)'),
      limit: zLimit(DEFAULT_IDEAS_LIMIT, MAX_IDEAS_LIMIT),
    },
    async ({ projectId: inputProjectId, seed, mode, limit }) =>
      withSeoErrorHandling(async () => {
        const projectId = await resolveProjectId(context, inputProjectId);
        const take = limit ?? DEFAULT_IDEAS_LIMIT;
        const input = { projectId, seed, limit: take };
        const rows =
          mode === 'suggestions'
            ? await researchKeywordSuggestions(input)
            : mode === 'related'
              ? await researchRelatedKeywords(input)
              : await researchKeywordIdeas(input);
        return {
          seed,
          mode: mode ?? 'ideas',
          ...table(rows, {
            limit: take,
            columns: KEYWORD_COLUMNS,
            sortedBy: 'searchVolume',
            unit: 'keywords',
            moreAvailable: rows.length >= take,
          }),
        };
      })
  );

  server.tool(
    'seo_serp_preview',
    "Show the live Google top 10 for a keyword in the project's market: organic results with the project's own domain flagged, plus the SERP features present (people also ask, featured snippet, video, …). Cached 6h; a fresh call costs about $0.002 of the organization's DataForSEO balance.",
    {
      projectId: projectIdSchema(context),
      keyword: zKeyword.describe('Keyword to preview'),
    },
    async ({ projectId: inputProjectId, keyword }) =>
      withSeoErrorHandling(async () => {
        const projectId = await resolveProjectId(context, inputProjectId);
        const preview = await getSerpPreview({ projectId, keyword });
        return {
          keyword: preview.keyword,
          domain: preview.domain,
          ownPosition: preview.ownPosition,
          features: preview.features,
          results: table(preview.results, {
            limit: preview.results.length,
            columns: ['rank', 'domain', 'url', 'title', 'isOwnDomain'],
            sortedBy: 'rank',
            unit: 'results',
          }),
        };
      })
  );

  server.tool(
    'seo_gsc_enriched_queries',
    'Top Google Search Console queries for the range (clicks, impressions, CTR, position) joined with DataForSEO search volume, difficulty and CPC. Rows whose metrics are not stored yet come back `pending: true`; a root client queues the metrics fetch so a later call fills them in. Requires Search Console; metrics require DataForSEO.',
    {
      projectId: projectIdSchema(context),
      ...zDateRange,
      limit: zLimit(DEFAULT_GSC_LIMIT, MAX_GSC_LIMIT),
    },
    async ({ projectId: inputProjectId, startDate: sd, endDate: ed, limit }) =>
      withSeoErrorHandling(async () => {
        const projectId = await resolveProjectId(context, inputProjectId);
        const { startDate, endDate } = resolveDateRange(sd, ed);
        const take = limit ?? DEFAULT_GSC_LIMIT;
        const { rows, missingKeywords } = await getGscQueriesWithMetrics({
          projectId,
          startDate,
          endDate,
          limit: take,
        });

        let queued = 0;
        if (missingKeywords.length > 0 && context.clientType === 'root') {
          await seoQueue.add(
            'seoKeywordMetrics',
            { type: 'seoKeywordMetrics', payload: { projectId, keywords: missingKeywords } },
            { jobId: keywordMetricsJobId(projectId, missingKeywords) }
          );
          queued = missingKeywords.length;
        }

        return {
          startDate,
          endDate,
          pending: missingKeywords.length,
          ...(queued > 0
            ? { note: `${queued} keywords without stored metrics were queued; call again in a minute for volume/difficulty.` }
            : missingKeywords.length > 0
              ? { note: `${missingKeywords.length} keywords have no stored metrics yet; a root client (or opening the Search Console tab) queues the fetch.` }
              : {}),
          ...table(rows, {
            limit: take,
            columns: [
              'query',
              'clicks',
              'impressions',
              'ctr',
              'position',
              'searchVolume',
              'difficulty',
              'cpc',
              'pending',
            ],
            sum: ['clicks', 'impressions'],
            sortedBy: 'clicks',
            unit: 'queries',
            moreAvailable: rows.length >= take,
          }),
        };
      })
  );

  // keyword_overview persists into seo_keyword_metrics and bills every cache
  // miss, so like the tRPC `overview` mutation it needs write scope.
  if (context.clientType !== 'root') {
    return;
  }

  server.tool(
    'seo_keyword_overview',
    `Get search volume, difficulty, CPC, competition and intent for an explicit list of up to ${MAX_OVERVIEW_KEYWORDS} keywords (DataForSEO Labs keyword_overview, project market; WRITE: root client only). Results are stored so tracked keywords pick up the metrics too. Keywords fetched within the last 24h are served from storage; the rest cost about $0.01 per call of the organization's DataForSEO balance. Confirm with the user before large lists.`,
    {
      projectId: projectIdSchema(context),
      keywords: z
        .array(zKeyword)
        .min(1)
        .max(MAX_OVERVIEW_KEYWORDS)
        .describe('Keywords to look up'),
    },
    async ({ projectId: inputProjectId, keywords }) =>
      withSeoErrorHandling(async () => {
        requireWriteScope(context, 'seo_keyword_overview');
        const projectId = await resolveProjectId(context, inputProjectId);
        const rows = await getKeywordOverview({ projectId, keywords });
        const found = new Set(rows.map((row) => normalizeTrackedKeyword(row.keyword)));
        const notFound = keywords.filter(
          (keyword) => !found.has(normalizeTrackedKeyword(keyword))
        );
        return {
          ...table(rows, {
            limit: MAX_OVERVIEW_KEYWORDS,
            columns: KEYWORD_COLUMNS,
            sortedBy: 'searchVolume',
            unit: 'keywords',
          }),
          ...(notFound.length > 0 ? { not_found: notFound } : {}),
        };
      })
  );
}
