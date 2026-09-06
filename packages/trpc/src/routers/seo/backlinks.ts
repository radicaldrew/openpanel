import {
  BACKLINK_LIST_DEFAULT_LIMIT,
  canWriteProject,
  BACKLINK_LIST_MAX_LIMIT,
  getBacklinkHistory,
  getBacklinkOverview,
  getBacklinkPages,
  getBacklinkRows,
  getChartStartEndDate,
  getProjectOrganizationId,
  getReferringDomains,
  getSeoProjectConfig,
  getSettingsForProject,
  isDfsSpendCapReached,
} from '@openpanel/db';
import { seoQueue } from '@openpanel/queue';
import { zRange } from '@openpanel/validation';
import { z } from 'zod';
import { requireProjectAccess } from '../../access';
import { createTRPCRouter, protectedProcedure } from '../../trpc';
import { withSeoErrors } from './errors';

const MAX_TARGET_LENGTH = 253;
const MAX_SEARCH_LENGTH = 200;
const MAX_RANK = 1000;

const zProjectId = z.object({ projectId: z.string() });
const zTarget = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(MAX_TARGET_LENGTH)
  .optional();

const zFilters = z
  .object({
    dofollow: z.boolean().optional(),
    status: z.enum(['live', 'new', 'lost', 'all']).optional(),
    minRank: z.number().int().min(0).max(MAX_RANK).optional(),
    search: z.string().trim().max(MAX_SEARCH_LENGTH).optional(),
    hideSpam: z.boolean().optional(),
  })
  .default({});

const zListInput = zProjectId.extend({
  target: zTarget,
  filters: zFilters,
  cursor: z.string().nullish(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(BACKLINK_LIST_MAX_LIMIT)
    .default(BACKLINK_LIST_DEFAULT_LIMIT),
  order: z.enum(['asc', 'desc']).default('desc'),
});

const zDateInput = z.object({
  range: zRange,
  startDate: z.string().nullish(),
  endDate: z.string().nullish(),
});

async function resolveDates(
  projectId: string,
  input: z.infer<typeof zDateInput>
): Promise<{ startDate: string; endDate: string }> {
  const { timezone } = await getSettingsForProject(projectId);
  const { startDate, endDate } = getChartStartEndDate(
    { range: input.range, startDate: input.startDate, endDate: input.endDate },
    timezone
  );
  return { startDate: startDate.slice(0, 10), endDate: endDate.slice(0, 10) };
}

/** One manual snapshot per project may be waiting or running at a time. */
export function backlinkSnapshotJobId(projectId: string): string {
  return `seoBacklinkSnapshot:${projectId}:manual`;
}

const IN_FLIGHT_STATES = new Set(['waiting', 'delayed', 'active', 'prioritized', 'waiting-children']);

/** Whether a manual snapshot job for the project is queued or running. */
export async function isBacklinkSnapshotPending(projectId: string): Promise<boolean> {
  const existing = await seoQueue.getJob(backlinkSnapshotJobId(projectId));
  if (!existing) {
    return false;
  }
  return IN_FLIGHT_STATES.has(await existing.getState());
}

export type SnapshotNowResult =
  | { ok: true }
  | { ok: false; reason: 'already_queued' | 'spend_cap' | 'no_domain' };

export async function enqueueBacklinkSnapshot(
  projectId: string
): Promise<SnapshotNowResult> {
  const config = await getSeoProjectConfig(projectId);
  if (!config?.domain) {
    return { ok: false, reason: 'no_domain' };
  }
  const organizationId = await getProjectOrganizationId(projectId);
  if (await isDfsSpendCapReached(organizationId)) {
    return { ok: false, reason: 'spend_cap' };
  }

  const jobId = backlinkSnapshotJobId(projectId);
  const existing = await seoQueue.getJob(jobId);
  if (existing) {
    if (IN_FLIGHT_STATES.has(await existing.getState())) {
      return { ok: false, reason: 'already_queued' };
    }
    // A finished (or failed) job keeps its id until it is cleaned up, and
    // BullMQ would silently ignore a second add with the same id.
    await existing.remove();
  }
  await seoQueue.add(
    'seoBacklinkSnapshot',
    { type: 'seoBacklinkSnapshot', payload: { projectId } },
    { jobId }
  );
  return { ok: true };
}

export const seoBacklinksRouter = createTRPCRouter({
  /**
   * Cards. The stored snapshot for the own domain, refreshed live when older
   * than 24h — but only for members who may write, since a refresh spends the
   * organization's DataForSEO balance. Competitors are always live (cached).
   */
  summary: protectedProcedure
    .input(zProjectId.extend({ target: zTarget }))
    .query(async ({ input, ctx }) => {
      const access = await requireProjectAccess({
        userId: ctx.session.userId,
        projectId: input.projectId,
        level: 'read',
      });
      return withSeoErrors(async () => {
        const [overview, snapshotPending] = await Promise.all([
          getBacklinkOverview({
            projectId: input.projectId,
            target: input.target,
            allowRefresh: canWriteProject(access),
          }),
          input.target ? Promise.resolve(false) : isBacklinkSnapshotPending(input.projectId),
        ]);
        return { ...overview, snapshotPending };
      });
    }),

  history: protectedProcedure
    .input(zProjectId.merge(zDateInput).extend({ target: zTarget }))
    .query(async ({ input, ctx }) => {
      await requireProjectAccess({
        userId: ctx.session.userId,
        projectId: input.projectId,
        level: 'read',
      });
      const dates = await resolveDates(input.projectId, input);
      return withSeoErrors(() =>
        getBacklinkHistory({
          projectId: input.projectId,
          target: input.target,
          ...dates,
        })
      );
    }),

  list: protectedProcedure
    .input(
      zListInput.extend({
        sort: z.enum(['rank', 'domainRank', 'spamScore', 'firstSeen']).default('rank'),
      })
    )
    .query(async ({ input, ctx }) => {
      await requireProjectAccess({
        userId: ctx.session.userId,
        projectId: input.projectId,
        level: 'read',
      });
      return withSeoErrors(() => getBacklinkRows(input));
    }),

  referringDomains: protectedProcedure
    .input(
      zListInput.extend({
        sort: z
          .enum(['backlinks', 'referringPages', 'rank', 'spamScore', 'firstSeen'])
          .default('backlinks'),
      })
    )
    .query(async ({ input, ctx }) => {
      await requireProjectAccess({
        userId: ctx.session.userId,
        projectId: input.projectId,
        level: 'read',
      });
      return withSeoErrors(() => getReferringDomains(input));
    }),

  pages: protectedProcedure
    .input(
      zListInput.extend({
        sort: z.enum(['backlinks', 'referringDomains', 'rank']).default('backlinks'),
      })
    )
    .query(async ({ input, ctx }) => {
      await requireProjectAccess({
        userId: ctx.session.userId,
        projectId: input.projectId,
        level: 'read',
      });
      return withSeoErrors(() => getBacklinkPages(input));
    }),

  /**
   * "Snapshot now". Returns a discriminated result for the expected refusals
   * (already queued, spend cap, no domain) so the UI can word each one.
   */
  snapshotNow: protectedProcedure
    .input(zProjectId)
    .mutation(async ({ input, ctx }) => {
      await requireProjectAccess({
        userId: ctx.session.userId,
        projectId: input.projectId,
        level: 'write',
      });
      return withSeoErrors(() => enqueueBacklinkSnapshot(input.projectId));
    }),
});
