import { z } from 'zod';

import {
  Prisma,
  db,
  getDashboardById,
  getReportById,
  getReportsByDashboardId,
  reportWriteData,
} from '@openpanel/db';
import {
  refineMetricChartType,
  refineReportDataSource,
  zReport,
} from '@openpanel/validation';

import { getProjectAccess, requireProjectAccess } from '../access';
import {
  TRPCBadRequestError,
  TRPCForbiddenError,
  TRPCNotFoundError,
} from '../errors';
import { createTRPCRouter, protectedProcedure } from '../trpc';

export const reportRouter = createTRPCRouter({
  list: protectedProcedure
    .input(
      z.object({
        dashboardId: z.string(),
        projectId: z.string(),
      }),
    )
    .query(async ({ input: { dashboardId, projectId } }) => {
      const dashboard = await getDashboardById(dashboardId, projectId);
      if (!dashboard) {
        throw new TRPCNotFoundError('Dashboard not found');
      }
      return getReportsByDashboardId(dashboardId);
    }),
  create: protectedProcedure
    .input(
      z.object({
        report: zReport
          .omit({ projectId: true })
          .superRefine(refineReportDataSource)
          .superRefine(refineMetricChartType),
        dashboardId: z.string(),
      }),
    )
    .mutation(async ({ input: { report, dashboardId }, ctx }) => {
      const dashboard = await db.dashboard.findUniqueOrThrow({
        where: {
          id: dashboardId,
        },
      });

      await requireProjectAccess({
        userId: ctx.session.userId,
        projectId: dashboard.projectId,
        level: 'write',
      });

      return db.report.create({
        data: {
          projectId: dashboard.projectId,
          dashboardId,
          ...reportWriteData(report),
        },
      });
    }),
  update: protectedProcedure
    .input(
      z.object({
        reportId: z.string(),
        report: zReport
          .omit({ projectId: true })
          .superRefine(refineReportDataSource)
          .superRefine(refineMetricChartType),
      }),
    )
    .mutation(async ({ input: { report, reportId }, ctx }) => {
      const dbReport = await db.report.findUniqueOrThrow({
        where: {
          id: reportId,
        },
      });

      await requireProjectAccess({
        userId: ctx.session.userId,
        projectId: dbReport.projectId,
        level: 'write',
      });

      return db.report.update({
        where: {
          id: reportId,
        },
        // The editor always sends a whole report — `ReportSaveButton` posts the
        // entire slice — so this is a replace, not a patch. That distinction is
        // load-bearing: passing `formula`/`unit`/`options` through as
        // possibly-`undefined` made Prisma read them as "leave alone", so
        // CLEARING a formula in the editor did not persist. `reportWriteData`
        // coerces them to null/DbNull, which is what replace semantics mean.
        data: reportWriteData(report),
      });
    }),
  move: protectedProcedure
    .input(
      z.object({
        reportId: z.string(),
        dashboardId: z.string(),
      }),
    )
    .mutation(async ({ input: { reportId, dashboardId }, ctx }) => {
      const report = await db.report.findUniqueOrThrow({
        where: {
          id: reportId,
        },
      });

      await requireProjectAccess({
        userId: ctx.session.userId,
        projectId: report.projectId,
        level: 'write',
      });

      if (report.dashboardId === dashboardId) {
        throw new TRPCBadRequestError('Report is already on this dashboard');
      }

      const dashboard = await db.dashboard.findUniqueOrThrow({
        where: {
          id: dashboardId,
        },
      });

      // A report keeps its own projectId and that is what powers the chart
      // queries, public shares included. Moving it to a dashboard in another
      // project would expose the source project through the target project.
      if (dashboard.projectId !== report.projectId) {
        throw new TRPCBadRequestError(
          'You can only move a report to a dashboard in the same project',
        );
      }

      const [, moved] = await db.$transaction([
        // The layout belongs to the report, not the dashboard. Keeping it would
        // drop the report on top of whatever already sits at those coordinates
        // in the target dashboard.
        db.reportLayout.deleteMany({
          where: {
            reportId,
          },
        }),
        db.report.update({
          where: {
            id: reportId,
          },
          data: {
            dashboardId,
          },
        }),
      ]);

      return moved;
    }),
  delete: protectedProcedure
    .input(
      z.object({
        reportId: z.string(),
      }),
    )
    .mutation(async ({ input: { reportId }, ctx }) => {
      const report = await db.report.findUniqueOrThrow({
        where: {
          id: reportId,
        },
      });

      await requireProjectAccess({
        userId: ctx.session.userId,
        projectId: report.projectId,
        level: 'write',
      });

      return db.report.delete({
        where: {
          id: reportId,
        },
      });
    }),
  duplicate: protectedProcedure
    .input(
      z.object({
        reportId: z.string(),
      }),
    )
    .mutation(async ({ input: { reportId }, ctx }) => {
      const report = await db.report.findUniqueOrThrow({
        where: {
          id: reportId,
        },
      });

      await requireProjectAccess({
        userId: ctx.session.userId,
        projectId: report.projectId,
        level: 'write',
      });

      return db.report.create({
        data: {
          projectId: report.projectId,
          dashboardId: report.dashboardId,
          name: `Copy of ${report.name}`,
          // Hand-maintained rather than `reportWriteData`, which takes a
          // validated config (`series`) and not a stored row (`events`). That
          // makes this list something a new Report column has to be added to
          // by hand, and it has already been missed once: `dataSource` and
          // `metricQuery` were absent, so duplicating a metric panel produced
          // an events report with an empty series — a chart that renders
          // nothing and reports no error. `create` and `update` above carry
          // both; this is the third copy and it had drifted from them.
          dataSource: report.dataSource,
          // The row holds `null` for a report with no query, and Prisma will
          // not take a bare `null` for a Json column: it reserves that for a
          // JSON null literal and wants `DbNull` for a SQL NULL.
          metricQuery: report.metricQuery ?? Prisma.DbNull,
          events: report.events!,
          globalFilters: report.globalFilters ?? [],
          interval: report.interval,
          breakdowns: report.breakdowns!,
          chartType: report.chartType,
          lineType: report.lineType,
          range: report.range,
          formula: report.formula,
          previous: report.previous,
          unit: report.unit,
          metric: report.metric,
          options: report.options,
          visibleSeries: report.visibleSeries,
          startDate: report.startDate,
          endDate: report.endDate,
        },
      });
    }),
  get: protectedProcedure
    .input(
      z.object({
        reportId: z.string(),
      }),
    )
    .query(async ({ input: { reportId }, ctx }) => {
      const report = await getReportById(reportId);
      if (!report) {
        throw new TRPCNotFoundError('Report not found');
      }
      const access = await getProjectAccess({
        userId: ctx.session.userId,
        projectId: report.projectId,
      });
      if (!access) {
        throw new TRPCForbiddenError('You do not have access to this project');
      }
      return report;
    }),
  updateLayout: protectedProcedure
    .input(
      z.object({
        reportId: z.string(),
        layout: z.object({
          x: z.number(),
          y: z.number(),
          w: z.number(),
          h: z.number(),
          minW: z.number().optional(),
          minH: z.number().optional(),
          maxW: z.number().optional(),
          maxH: z.number().optional(),
        }),
      }),
    )
    .mutation(async ({ input: { reportId, layout }, ctx }) => {
      const report = await db.report.findUniqueOrThrow({
        where: {
          id: reportId,
        },
      });

      await requireProjectAccess({
        userId: ctx.session.userId,
        projectId: report.projectId,
        level: 'write',
      });

      // Upsert the layout (create if doesn't exist, update if it does)
      return db.reportLayout.upsert({
        where: {
          reportId,
        },
        create: {
          reportId,
          x: layout.x,
          y: layout.y,
          w: layout.w,
          h: layout.h,
          minW: layout.minW,
          minH: layout.minH,
          maxW: layout.maxW,
          maxH: layout.maxH,
        },
        update: {
          x: layout.x,
          y: layout.y,
          w: layout.w,
          h: layout.h,
          minW: layout.minW,
          minH: layout.minH,
          maxW: layout.maxW,
          maxH: layout.maxH,
        },
      });
    }),
  getLayouts: protectedProcedure
    .input(
      z.object({
        dashboardId: z.string(),
        projectId: z.string(),
      }),
    )
    .query(async ({ input: { dashboardId, projectId }, ctx }) => {
      const access = await getProjectAccess({
        userId: ctx.session.userId,
        projectId: projectId,
      });

      if (!access) {
        throw new TRPCForbiddenError('You do not have access to this project');
      }

      // The access check above only proves the caller owns `projectId`. Bind
      // the caller-supplied `dashboardId` to that project as well, otherwise a
      // dashboard from another organization can be read through this handler.
      const dashboard = await getDashboardById(dashboardId, projectId);
      if (!dashboard) {
        throw new TRPCNotFoundError('Dashboard not found');
      }

      return db.reportLayout.findMany({
        where: {
          report: {
            dashboardId: dashboardId,
            projectId,
          },
        },
        include: {
          report: true,
        },
      });
    }),
  resetLayout: protectedProcedure
    .input(
      z.object({
        dashboardId: z.string(),
        projectId: z.string(),
      }),
    )
    .mutation(async ({ input: { dashboardId, projectId }, ctx }) => {
      await requireProjectAccess({
        userId: ctx.session.userId,
        projectId: projectId,
        level: 'write',
      });

      // Same as `getLayouts`: bind the dashboard to the access-checked project
      // before deleting anything, so a foreign dashboard cannot be wiped.
      const dashboard = await getDashboardById(dashboardId, projectId);
      if (!dashboard) {
        throw new TRPCNotFoundError('Dashboard not found');
      }

      // Delete all layout data for reports in this dashboard
      return db.reportLayout.deleteMany({
        where: {
          report: {
            dashboardId: dashboardId,
            projectId,
          },
        },
      });
    }),
});
