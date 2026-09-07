import { PrismaError } from 'prisma-error-enum';
import { z } from 'zod';

import {
  db,
  getDashboardById,
  getDashboardsByProjectId,
  getId,
  getProjectById,
  updateDashboardVariables,
} from '@openpanel/db';
import type { Prisma } from '@openpanel/db';
import { zDashboardVariable } from '@openpanel/validation';

import { getProjectAccess, requireProjectAccess } from '../access';
import {
  TRPCBadRequestError,
  TRPCForbiddenError,
  TRPCNotFoundError,
} from '../errors';
import { createTRPCRouter, protectedProcedure } from '../trpc';

export const dashboardRouter = createTRPCRouter({
  list: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
      }),
    )
    .query(({ input }) => {
      return getDashboardsByProjectId(input.projectId);
    }),
  byId: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        projectId: z.string(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const access = await getProjectAccess({
        projectId: input.projectId,
        userId: ctx.session.userId,
      });

      if (!access) {
        throw new TRPCForbiddenError('You do not have access to this project');
      }

      const dashboard = await getDashboardById(input.id, input.projectId);

      if (!dashboard) {
        throw new TRPCNotFoundError('Dashboard not found');
      }

      return dashboard;
    }),
  create: protectedProcedure
    .input(
      z.object({
        name: z.string(),
        projectId: z.string(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await requireProjectAccess({
        userId: ctx.session.userId,
        projectId: input.projectId,
        level: 'write',
      });

      const project = await getProjectById(input.projectId);

      if (!project) {
        throw new TRPCNotFoundError('Project not found');
      }

      return db.dashboard.create({
        data: {
          id: await getId('dashboard', input.name),
          projectId: input.projectId,
          organizationId: project.organizationId,
          name: input.name,
        },
      });
    }),
  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const dashboard = await db.dashboard.findUniqueOrThrow({
        where: {
          id: input.id,
        },
      });

      await requireProjectAccess({
        userId: ctx.session.userId,
        projectId: dashboard.projectId,
        level: 'write',
      });

      return db.dashboard.update({
        where: {
          id: input.id,
        },
        data: {
          name: input.name,
        },
      });
    }),
  /**
   * Replaces the dashboard's variable definitions.
   *
   * Separate from `update` because the two have different shapes of caller:
   * `update` is the rename in the sidebar, this is the variable editor modal
   * posting its whole list. Folding them together would make renaming a
   * dashboard from a client that predates variables clear them.
   */
  updateVariables: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        variables: z.array(zDashboardVariable).max(20),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const dashboard = await db.dashboard.findUniqueOrThrow({
        where: {
          id: input.id,
        },
      });

      await requireProjectAccess({
        userId: ctx.session.userId,
        projectId: dashboard.projectId,
        level: 'write',
      });

      // Two variables with the same name means one of them silently never
      // substitutes — `$service` resolves to whichever the lookup finds first.
      const names = input.variables.map((variable) => variable.name);
      const duplicate = names.find(
        (name, index) => names.indexOf(name) !== index,
      );
      if (duplicate) {
        throw new TRPCBadRequestError(
          `Duplicate variable name: $${duplicate}`,
        );
      }

      return updateDashboardVariables(input.id, input.variables);
    }),
  delete: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        forceDelete: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const dashboard = await db.dashboard.findUniqueOrThrow({
        where: {
          id: input.id,
        },
      });

      await requireProjectAccess({
        userId: ctx.session.userId,
        projectId: dashboard.projectId,
        level: 'write',
      });

      try {
        if (input.forceDelete) {
          await db.report.deleteMany({
            where: {
              dashboardId: input.id,
            },
          });
        }
        await db.dashboard.delete({
          where: {
            id: input.id,
          },
        });
      } catch (e) {
        // Below does not work...
        // error instanceof Prisma.PrismaClientKnownRequestError
        if (typeof e === 'object' && e && 'code' in e) {
          const error = e as Prisma.PrismaClientKnownRequestError;
          switch (error.code) {
            case PrismaError.ForeignConstraintViolation:
              throw new Error(
                'Cannot delete dashboard with associated reports',
              );
            default:
              throw new Error('Unknown error deleting dashboard');
          }
        }
      }
    }),
});
