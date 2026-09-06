import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  BACKLINK_LIST_MAX_LIMIT,
  getBacklinkHistory,
  getBacklinkOverview,
  getBacklinkRows,
  getReferringDomains,
} from '@openpanel/db';
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
import { recentSeries, withSeoErrorHandling } from './shared';

const DEFAULT_LIST_LIMIT = 25;

const zTarget = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(253)
  .optional()
  .describe(
    "Domain to inspect: the project's own domain (default) or one of its configured competitors. Other domains are refused."
  );

const zStatus = z
  .enum(['live', 'new', 'lost', 'all'])
  .optional()
  .describe('live (default) = currently seen links; new / lost narrow to recent changes; all = live and lost');

export function registerSeoBacklinkTools(server: McpServer, context: McpAuthContext) {
  server.tool(
    'seo_backlinks_summary',
    "Backlink profile of the project's domain or a configured competitor: total backlinks, referring domains and IPs, DataForSEO domain rank (0–100), spam score, new and lost backlinks over the last 30 days, plus the daily history for the range. Own-domain numbers come from stored snapshots (refreshed live by a root client when older than a day, about $0.05); competitors are fetched live and cached 6h.",
    {
      projectId: projectIdSchema(context),
      target: zTarget,
      ...zDateRange,
      includeHistory: z
        .boolean()
        .optional()
        .describe('Set false to skip the daily series (default true)'),
    },
    async ({ projectId: inputProjectId, target, startDate: sd, endDate: ed, includeHistory }) =>
      withSeoErrorHandling(async () => {
        const projectId = await resolveProjectId(context, inputProjectId);
        const overview = await getBacklinkOverview({
          projectId,
          target,
          allowRefresh: context.clientType === 'root',
        });
        const summary = {
          target: overview.target,
          isOwnDomain: overview.isOwnDomain,
          asOf: overview.asOf,
          source: overview.source,
          stale: overview.stale,
          backlinks: overview.backlinks,
          referringDomains: overview.referringDomains,
          referringIps: overview.referringIps,
          domainRank: overview.rank,
          spamScore: overview.spamScore,
          newBacklinks30d: overview.newBacklinks30d,
          lostBacklinks30d: overview.lostBacklinks30d,
          brokenBacklinks: overview.brokenBacklinks,
          referringPages: overview.referringPages,
        };
        if (includeHistory === false) {
          return { summary };
        }
        const { startDate, endDate } = resolveDateRange(sd, ed);
        const history = await getBacklinkHistory({ projectId, target, startDate, endDate });
        const recent = recentSeries(history.points);
        return {
          summary,
          startDate,
          endDate,
          ...(recent.note ? { series_note: recent.note } : {}),
          history: table(recent.points, {
            limit: recent.points.length,
            columns: ['date', 'backlinks', 'referringDomains', 'rank', 'newBacklinks', 'lostBacklinks'],
            sortedBy: 'date',
            unit: 'days',
          }),
        };
      })
  );

  server.tool(
    'seo_backlinks_list',
    "Individual backlinks pointing at the project's domain or a configured competitor: linking page, target page, anchor, dofollow, link rank, linking domain rank, spam score, first seen, and new/lost/broken flags. Sorted by link rank by default. Use `cursor` from the response to page. Cached 6h; a fresh page costs about $0.02 of the organization's DataForSEO balance.",
    {
      projectId: projectIdSchema(context),
      target: zTarget,
      status: zStatus,
      dofollow: z.boolean().optional().describe('true = dofollow only, false = nofollow only'),
      minRank: z.number().int().min(0).max(1000).optional().describe('Minimum link rank'),
      search: z.string().trim().max(200).optional().describe('Substring match on the linking domain'),
      sort: z.enum(['rank', 'domainRank', 'spamScore', 'firstSeen']).optional(),
      order: z.enum(['asc', 'desc']).optional(),
      cursor: z.string().optional().describe('Opaque cursor from a previous response'),
      limit: zLimit(DEFAULT_LIST_LIMIT, BACKLINK_LIST_MAX_LIMIT),
    },
    async ({ projectId: inputProjectId, target, status, dofollow, minRank, search, sort, order, cursor, limit }) =>
      withSeoErrorHandling(async () => {
        const projectId = await resolveProjectId(context, inputProjectId);
        const take = limit ?? DEFAULT_LIST_LIMIT;
        const page = await getBacklinkRows({
          projectId,
          target,
          filters: { status, dofollow, minRank, search },
          sort,
          order,
          cursor,
          limit: take,
        });
        return {
          target: page.target,
          isOwnDomain: page.isOwnDomain,
          totalCount: page.totalCount,
          nextCursor: page.nextCursor,
          ...table(page.rows, {
            limit: take,
            columns: [
              'domainFrom',
              'urlFrom',
              'urlTo',
              'anchor',
              'dofollow',
              'rank',
              'domainFromRank',
              'spamScore',
              'firstSeen',
              'isNew',
              'isLost',
              'isBroken',
            ],
            sortedBy: sort ?? 'rank',
            unit: 'backlinks',
            moreAvailable: page.nextCursor !== null,
          }),
        };
      })
  );

  server.tool(
    'seo_referring_domains',
    "Domains linking to the project's domain or a configured competitor, with backlink count, referring pages, DataForSEO domain rank, spam score, first seen and broken links. Sorted by backlinks by default. Use `cursor` to page. Cached 6h; a fresh page costs about $0.02 of the organization's DataForSEO balance.",
    {
      projectId: projectIdSchema(context),
      target: zTarget,
      status: zStatus,
      minRank: z.number().int().min(0).max(1000).optional().describe('Minimum domain rank'),
      search: z.string().trim().max(200).optional().describe('Substring match on the domain'),
      sort: z.enum(['backlinks', 'referringPages', 'rank', 'spamScore', 'firstSeen']).optional(),
      order: z.enum(['asc', 'desc']).optional(),
      cursor: z.string().optional().describe('Opaque cursor from a previous response'),
      limit: zLimit(DEFAULT_LIST_LIMIT, BACKLINK_LIST_MAX_LIMIT),
    },
    async ({ projectId: inputProjectId, target, status, minRank, search, sort, order, cursor, limit }) =>
      withSeoErrorHandling(async () => {
        const projectId = await resolveProjectId(context, inputProjectId);
        const take = limit ?? DEFAULT_LIST_LIMIT;
        const page = await getReferringDomains({
          projectId,
          target,
          filters: { status, minRank, search },
          sort,
          order,
          cursor,
          limit: take,
        });
        return {
          target: page.target,
          isOwnDomain: page.isOwnDomain,
          totalCount: page.totalCount,
          nextCursor: page.nextCursor,
          ...table(page.rows, {
            limit: take,
            columns: ['domain', 'backlinks', 'referringPages', 'rank', 'spamScore', 'firstSeen', 'brokenBacklinks'],
            sum: ['backlinks'],
            sortedBy: sort ?? 'backlinks',
            unit: 'domains',
            moreAvailable: page.nextCursor !== null,
          }),
        };
      })
  );
}
