import {
  db,
  getChartStartEndDate,
  getSettingsForProject,
} from '@openpanel/db';
import { zAnnotationInput, zRange } from '@openpanel/validation';
import { z } from 'zod';

import { getProjectAccess, requireProjectAccess } from '../access';
import { TRPCForbiddenError, TRPCNotFoundError } from '../errors';
import { createTRPCRouter, protectedProcedure } from '../trpc';

/**
 * Annotations: points and spans marked on metric charts (a deploy, an
 * incident, a note).
 *
 * `dashboardId: null` means global — the annotation shows on every dashboard
 * in the project. `list` therefore always returns the global ones alongside
 * whatever belongs to the dashboard being viewed, rather than making every
 * caller issue two queries and merge them.
 */
export const annotationRouter = createTRPCRouter({
  list: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        // Pass the dashboard being viewed to get its annotations plus the
        // global ones; omit it for the global ones only.
        dashboardId: z.string().nullish(),
        // The range the way every other read path takes it: the preset plus
        // optional custom dates, resolved here with the project's timezone.
        // Resolving a preset in the browser would put the annotations on a
        // different window from the charts they are drawn over.
        range: zRange.default('30d'),
        startDate: z.string().nullish(),
        endDate: z.string().nullish(),
        tags: z.array(z.string().max(50)).max(20).optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const access = await getProjectAccess({
        userId: ctx.session.userId,
        projectId: input.projectId,
      });

      if (!access) {
        throw new TRPCForbiddenError('You do not have access to this project');
      }

      const { timezone } = await getSettingsForProject(input.projectId);
      const resolved = getChartStartEndDate(
        {
          range: input.range,
          startDate: input.startDate,
          endDate: input.endDate,
        },
        timezone,
      );

      const startDate = new Date(resolved.startDate);
      const endDate = new Date(resolved.endDate);

      const annotations = await db.annotation.findMany({
        where: {
          projectId: input.projectId,
          // Two independent OR groups, so they go in an explicit AND rather
          // than as two `OR` keys on the same object — the second would
          // overwrite the first.
          AND: [
            {
              OR: input.dashboardId
                ? [{ dashboardId: input.dashboardId }, { dashboardId: null }]
                : [{ dashboardId: null }],
            },
            {
              // A span that starts before the window but runs into it is
              // still on screen, so the overlap test is on `timeEnd` when
              // there is one and on `time` otherwise.
              OR: [
                {
                  timeEnd: null,
                  time: { gte: startDate, lte: endDate },
                },
                {
                  timeEnd: { gte: startDate },
                  time: { lte: endDate },
                },
              ],
            },
          ],
          ...(input.tags?.length ? { tags: { hasSome: input.tags } } : {}),
        },
        orderBy: { time: 'asc' },
        take: 500,
      });

      // The resolved window travels back with the rows.
      //
      // The chart layer needs the domain it is drawing over, and it has to be
      // the SAME window the panels resolved — same preset, same timezone, same
      // `getChartStartEndDate`. Re-deriving it in the browser is how a marker
      // ends up one bucket off, so the answer is computed once, here, and
      // returned rather than recomputed.
      return {
        annotations,
        window: {
          startDate: resolved.startDate,
          endDate: resolved.endDate,
        },
      };
    }),
  create: protectedProcedure
    .input(zAnnotationInput)
    .mutation(async ({ input, ctx }) => {
      await requireProjectAccess({
        userId: ctx.session.userId,
        projectId: input.projectId,
        level: 'write',
      });

      // The dashboard has to belong to the project the caller was just
      // authorised for, or a global annotation on a foreign dashboard would
      // surface this project's notes on someone else's board.
      if (input.dashboardId) {
        const dashboard = await db.dashboard.findFirst({
          where: { id: input.dashboardId, projectId: input.projectId },
          select: { id: true },
        });

        if (!dashboard) {
          throw new TRPCNotFoundError('Dashboard not found');
        }
      }

      return db.annotation.create({
        data: {
          projectId: input.projectId,
          dashboardId: input.dashboardId,
          time: new Date(input.time),
          timeEnd: input.timeEnd ? new Date(input.timeEnd) : null,
          text: input.text,
          tags: input.tags,
          createdBy: ctx.session.userId,
          source: 'manual',
        },
      });
    }),
  /**
   * Takes the project rather than looking it up from the id.
   *
   * Reading the row first to find its project would answer a question the
   * caller has no right to ask: a nonexistent id gives NotFound and an id in
   * someone else's project gives Forbidden, so the two are distinguishable and
   * the endpoint confirms which annotation ids exist elsewhere.
   * `observability.trace` avoids the same leak deliberately; this now matches.
   *
   * `deleteMany` with both keys is what makes it safe — a foreign id simply
   * matches nothing, and the count says so without saying why.
   */
  delete: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        projectId: z.string(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await requireProjectAccess({
        userId: ctx.session.userId,
        projectId: input.projectId,
        level: 'write',
      });

      const { count } = await db.annotation.deleteMany({
        where: { id: input.id, projectId: input.projectId },
      });

      return { deleted: count };
    }),
});
