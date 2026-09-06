import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  addTrackedKeywords,
  createRankRun,
  getActiveRankRun,
  getLastCompletedRankRun,
  getLatestRankings,
  getRankHistory,
  getSeoProjectConfig,
  type LatestRanking,
  listTrackedKeywords,
  MAX_KEYWORDS_PER_ADD,
  MAX_TRACKED_KEYWORD_LENGTH,
  normalizeTrackedKeyword,
  type SeoDevice,
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
import { keywordMetricsJobId } from './keywords';
import { recentSeries, requireWriteScope, round, withSeoErrorHandling } from './shared';

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 1000;
const MAX_TAGS = 20;
const MAX_IDS = 2000;

/** DataForSEO SERP prices per crawled page of 10 results (SEO.md §6). */
export const RANK_CHECK_LIVE_PRICE_PER_PAGE_USD = 0.002;
export const RANK_CHECK_QUEUED_PRICE_PER_PAGE_USD = 0.0006;
/** Runs up to this many keywords use the live endpoint (worker rule). */
export const RANK_CHECK_LIVE_MAX_KEYWORDS = 10;
const RESULTS_PER_PAGE = 10;

export function estimateRankCheckCostUsd({
  keywords,
  devices,
  serpDepth,
}: {
  keywords: number;
  devices: 'both' | 'desktop' | 'mobile';
  serpDepth: number;
}): number {
  const deviceCount = devices === 'both' ? 2 : 1;
  const pages = Math.max(1, Math.ceil(serpDepth / RESULTS_PER_PAGE));
  const perPage =
    keywords <= RANK_CHECK_LIVE_MAX_KEYWORDS
      ? RANK_CHECK_LIVE_PRICE_PER_PAGE_USD
      : RANK_CHECK_QUEUED_PRICE_PER_PAGE_USD;
  return Math.round(keywords * deviceCount * pages * perPage * 10_000) / 10_000;
}

interface TrackedRow {
  id: string;
  keyword: string;
  tags: string;
  source: string;
  isActive: boolean;
  searchVolume: number | null;
  difficulty: number | null;
  cpc: number | null;
  desktopPosition: number | null;
  desktopDelta7: number | null;
  mobilePosition: number | null;
  mobileDelta7: number | null;
  url: string | null;
  lastChecked: string | null;
}

function delta(previous: number | null, current: number | null): number | null {
  if (previous === null || current === null) {
    return null;
  }
  return previous - current;
}

export function buildTrackedRows(
  keywords: Awaited<ReturnType<typeof listTrackedKeywords>>,
  latest: LatestRanking[]
): TrackedRow[] {
  const byKey = new Map<string, LatestRanking>();
  for (const entry of latest) {
    byKey.set(`${entry.keyword} ${entry.device}`, entry);
  }
  return keywords.map((keyword) => {
    const desktop = byKey.get(`${keyword.keyword} desktop`);
    const mobile = byKey.get(`${keyword.keyword} mobile`);
    const best =
      desktop && (!mobile || (desktop.position ?? Number.POSITIVE_INFINITY) <= (mobile.position ?? Number.POSITIVE_INFINITY))
        ? desktop
        : mobile;
    return {
      id: keyword.id,
      keyword: keyword.keyword,
      tags: keyword.tags.join(', '),
      source: keyword.source,
      isActive: keyword.isActive,
      searchVolume: keyword.searchVolume,
      difficulty: keyword.difficulty,
      cpc: round(keyword.cpc),
      desktopPosition: desktop?.position ?? null,
      desktopDelta7: desktop ? delta(desktop.previous7, desktop.position) : null,
      mobilePosition: mobile?.position ?? null,
      mobileDelta7: mobile ? delta(mobile.previous7, mobile.position) : null,
      url: best?.url ?? null,
      lastChecked: best?.checkedAt ?? null,
    };
  });
}

export function registerSeoTrackingTools(server: McpServer, context: McpAuthContext) {
  server.tool(
    'seo_tracked_keywords',
    'List the keywords this project tracks in Google, with stored search volume / difficulty / CPC and the latest desktop and mobile positions (null = not in the tracked SERP depth) plus the 7-day change (positive = moved up). Also reports the last completed rank check and any run in progress.',
    {
      projectId: projectIdSchema(context),
      tag: z.string().optional().describe('Only keywords carrying this tag'),
      search: z.string().optional().describe('Substring filter on the keyword'),
      includeInactive: z.boolean().optional().describe('Include paused keywords (default false)'),
      limit: zLimit(DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT),
    },
    async ({ projectId: inputProjectId, tag, search, includeInactive, limit }) =>
      withSeoErrorHandling(async () => {
        const projectId = await resolveProjectId(context, inputProjectId);
        const [keywords, latest, lastRun, activeRun, config] = await Promise.all([
          listTrackedKeywords(projectId, { tag, search, includeInactive }),
          getLatestRankings(projectId),
          getLastCompletedRankRun(projectId),
          getActiveRankRun(projectId),
          getSeoProjectConfig(projectId),
        ]);
        const rows = buildTrackedRows(keywords, latest);
        const ranked = rows.filter(
          (row) => row.desktopPosition !== null || row.mobilePosition !== null
        );
        return {
          total: rows.length,
          ranked: ranked.length,
          serpDepth: config?.serpDepth ?? null,
          devices: config?.devices ?? null,
          lastRun: lastRun
            ? {
                completedAt: lastRun.completedAt,
                keywordsChecked: lastRun.keywordsChecked,
                costUsd: lastRun.costUsd,
                error: lastRun.error,
              }
            : null,
          activeRun: activeRun
            ? {
                id: activeRun.id,
                status: activeRun.status,
                keywordsChecked: activeRun.keywordsChecked,
                keywordsTotal: activeRun.keywordsTotal,
              }
            : null,
          ...table(rows, {
            limit: limit ?? DEFAULT_LIST_LIMIT,
            columns: [
              'keyword',
              'desktopPosition',
              'desktopDelta7',
              'mobilePosition',
              'mobileDelta7',
              'searchVolume',
              'difficulty',
              'cpc',
              'tags',
              'url',
              'lastChecked',
              'id',
            ],
            sortedBy: 'creation order',
            unit: 'keywords',
          }),
        };
      })
  );

  server.tool(
    'seo_rank_history',
    "One tracked keyword's Google position over time on one device, with Search Console's average position for the same days as an overlay when GSC is connected. Positions come from stored rank checks; null = checked but not in the tracked depth.",
    {
      projectId: projectIdSchema(context),
      keyword: z.string().trim().min(1).max(MAX_TRACKED_KEYWORD_LENGTH),
      device: z.enum(['desktop', 'mobile']).optional().describe('Default desktop'),
      ...zDateRange,
    },
    async ({ projectId: inputProjectId, keyword, device, startDate: sd, endDate: ed }) =>
      withSeoErrorHandling(async () => {
        const projectId = await resolveProjectId(context, inputProjectId);
        const { startDate, endDate } = resolveDateRange(sd, ed);
        // Snapshots are stored under the normalized spelling (trimmed,
        // lowercased, inner whitespace collapsed).
        const normalized = normalizeTrackedKeyword(keyword);
        const points = await getRankHistory({
          projectId,
          keyword: normalized,
          device: (device ?? 'desktop') as SeoDevice,
          startDate,
          endDate,
        });
        const recent = recentSeries(points);
        return {
          keyword: normalized,
          device: device ?? 'desktop',
          startDate,
          endDate,
          ...(recent.note ? { series_note: recent.note } : {}),
          series: table(recent.points, {
            limit: recent.points.length,
            columns: ['date', 'position', 'gscPosition', 'url'],
            sortedBy: 'date',
            unit: 'days',
          }),
        };
      })
  );

  if (context.clientType !== 'root') {
    return;
  }

  server.tool(
    'seo_track_keywords',
    `Start tracking keywords for this project (WRITE: root client only). Adds up to ${MAX_KEYWORDS_PER_ADD} keywords, re-activating paused ones, and queues a DataForSEO metrics fetch for the new ones. Estimated cost: about $0.01 per 700 new keywords for the metrics fetch now, plus each scheduled rank check thereafter (about $0.0006 per keyword per device per 10 results at the project's SERP depth, daily or weekly per the project schedule). Confirm with the user before adding large lists.`,
    {
      projectId: projectIdSchema(context),
      keywords: z
        .array(z.string().trim().min(1).max(MAX_TRACKED_KEYWORD_LENGTH))
        .min(1)
        .max(MAX_KEYWORDS_PER_ADD)
        .describe('Keywords to track'),
      tags: z
        .array(z.string().trim().min(1).max(50))
        .max(MAX_TAGS)
        .optional()
        .describe('Tags applied to the newly added keywords'),
    },
    async ({ projectId: inputProjectId, keywords, tags }) =>
      withSeoErrorHandling(async () => {
        requireWriteScope(context, 'seo_track_keywords');
        const projectId = await resolveProjectId(context, inputProjectId);
        const result = await addTrackedKeywords({ projectId, keywords, tags, source: 'manual' });
        if (result.added.length > 0) {
          await seoQueue.add(
            'seoKeywordMetrics',
            { type: 'seoKeywordMetrics', payload: { projectId, keywords: result.added } },
            { jobId: keywordMetricsJobId(projectId, result.added) }
          );
        }
        return {
          added: result.added,
          alreadyTracked: result.existing,
          metricsQueued: result.added.length > 0,
        };
      })
  );

  server.tool(
    'seo_run_rank_check',
    `Run a Google rank check now for the project's tracked keywords (WRITE: root client only). Spends the organization's DataForSEO balance: about $0.002 per keyword per device per 10 results when 10 or fewer keywords are checked live, about $0.0006 per keyword per device per 10 results when queued (larger runs, results within a few minutes). A run for 100 keywords on both devices at depth 20 costs about $0.24. The response includes the estimate; confirm with the user first. Refuses when a run is already in progress or the monthly spend cap is reached.`,
    {
      projectId: projectIdSchema(context),
      keywordIds: z
        .array(z.string())
        .min(1)
        .max(MAX_IDS)
        .optional()
        .describe('Restrict to these tracked keyword ids (from seo_tracked_keywords); default all active'),
    },
    async ({ projectId: inputProjectId, keywordIds }) =>
      withSeoErrorHandling(async () => {
        requireWriteScope(context, 'seo_run_rank_check');
        const projectId = await resolveProjectId(context, inputProjectId);
        const result = await createRankRun({ projectId, keywordIds });
        if (!result.ok) {
          const reasons = {
            already_running: 'A rank check is already in progress for this project; wait for it to finish.',
            no_keywords: 'There are no active tracked keywords to check. Add some with seo_track_keywords first.',
            spend_cap: 'The monthly DataForSEO spend cap is reached; raise it under Settings → DataForSEO.',
          } as const;
          return { started: false, reason: result.reason, message: reasons[result.reason] };
        }
        await seoQueue.add(
          'seoRankRun',
          { type: 'seoRankRun', payload: { projectId, runId: result.run.id, keywordIds } },
          { jobId: `seoRankRun:${result.run.id}` }
        );
        const config = await getSeoProjectConfig(projectId);
        const devices = (config?.devices ?? 'both') as 'both' | 'desktop' | 'mobile';
        const serpDepth = config?.serpDepth ?? 20;
        return {
          started: true,
          runId: result.run.id,
          keywords: result.run.keywordsTotal,
          devices,
          serpDepth,
          estimatedCostUsd: estimateRankCheckCostUsd({
            keywords: result.run.keywordsTotal,
            devices,
            serpDepth,
          }),
          note: 'Poll seo_tracked_keywords for activeRun until it clears; positions update as results land.',
        };
      })
  );
}
