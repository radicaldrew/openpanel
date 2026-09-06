import {
  AUDIT_MAX_PAGES_MAX,
  AUDIT_MAX_PAGES_MIN,
  AUDIT_PAGE_SORTS,
  AUDIT_PRICE_PER_PAGE_JS_USD,
  AUDIT_PRICE_PER_PAGE_USD,
  cancelAudit,
  createAudit,
  estimateAuditCostUsd,
  getAudit,
  getAuditIssueSummary,
  getAuditMaxPagesDefault,
  getAuditPage,
  getLighthouseForUrl,
  listAuditPages,
  listAudits,
  readAuditSummary,
  type SeoAudit,
  type SeoAuditStatus,
} from '@openpanel/db';
import { seoQueue } from '@openpanel/queue';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { requireProjectAccess } from '../../access';
import { TRPCNotFoundError } from '../../errors';
import { createTRPCRouter, protectedProcedure } from '../../trpc';
import { withSeoErrors } from './errors';

const MAX_LIST = 50;
const MAX_URL_LENGTH = 2048;

const zAuditRef = z.object({ projectId: z.string(), auditId: z.string() });

/** Dates as ISO strings and the options pulled out of the summary JSON. */
export function serializeAudit(audit: SeoAudit) {
  const { options } = readAuditSummary(audit);
  return {
    id: audit.id,
    projectId: audit.projectId,
    status: audit.status as SeoAuditStatus,
    maxPages: audit.maxPages,
    pagesCrawled: audit.pagesCrawled,
    score: audit.score,
    costUsd: audit.costUsd,
    error: audit.error,
    enableJavascript: options.enableJavascript,
    startedAt: audit.startedAt.toISOString(),
    completedAt: audit.completedAt?.toISOString() ?? null,
  };
}

/** Loads an audit and refuses one that belongs to another project. */
async function loadAudit(projectId: string, auditId: string): Promise<SeoAudit> {
  const audit = await getAudit(auditId);
  if (!audit || audit.projectId !== projectId) {
    throw new TRPCNotFoundError('Audit not found');
  }
  return audit;
}

export const seoAuditRouter = createTRPCRouter({
  list: protectedProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input, ctx }) => {
      await requireProjectAccess({
        userId: ctx.session.userId,
        projectId: input.projectId,
        level: 'read',
      });
      const audits = await listAudits(input.projectId, MAX_LIST);
      return {
        audits: audits.map(serializeAudit),
        defaults: {
          maxPages: getAuditMaxPagesDefault(),
          minPages: AUDIT_MAX_PAGES_MIN,
          maxPagesLimit: AUDIT_MAX_PAGES_MAX,
          pricePerPageUsd: AUDIT_PRICE_PER_PAGE_USD,
          pricePerPageJsUsd: AUDIT_PRICE_PER_PAGE_JS_USD,
        },
      };
    }),

  get: protectedProcedure.input(zAuditRef).query(async ({ input, ctx }) => {
    await requireProjectAccess({
      userId: ctx.session.userId,
      projectId: input.projectId,
      level: 'read',
    });
    const audit = await loadAudit(input.projectId, input.auditId);
    const issues =
      audit.status === 'completed'
        ? await getAuditIssueSummary({ projectId: input.projectId, auditId: audit.id })
        : { issues: [], totals: { critical: 0, warning: 0, info: 0 } };
    return { audit: serializeAudit(audit), issues };
  }),

  start: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        maxPages: z.number().int().min(AUDIT_MAX_PAGES_MIN).max(AUDIT_MAX_PAGES_MAX),
        enableJavascript: z.boolean().default(false),
      })
    )
    .mutation(async ({ input, ctx }) => {
      await requireProjectAccess({
        userId: ctx.session.userId,
        projectId: input.projectId,
        level: 'write',
      });
      const result = await withSeoErrors(() => createAudit(input));
      if (!result.ok) {
        switch (result.reason) {
          case 'already_running':
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'An audit is already running for this project',
            });
          case 'no_domain':
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'SEO_CONFIG_MISSING: Set a domain for this project first',
            });
          case 'spend_cap':
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'DFS_SPEND_CAP: The monthly DataForSEO spend cap has been reached',
            });
          default:
            throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR' });
        }
      }
      await seoQueue.add(
        'seoAuditStart',
        {
          type: 'seoAuditStart',
          payload: { projectId: input.projectId, auditId: result.audit.id },
        },
        { jobId: `seoAuditStart:${result.audit.id}` }
      );
      return {
        audit: serializeAudit(result.audit),
        estimatedCostUsd: estimateAuditCostUsd(input.maxPages, input.enableJavascript),
      };
    }),

  cancel: protectedProcedure.input(zAuditRef).mutation(async ({ input, ctx }) => {
    await requireProjectAccess({
      userId: ctx.session.userId,
      projectId: input.projectId,
      level: 'write',
    });
    await loadAudit(input.projectId, input.auditId);
    const cancelled = await cancelAudit(input.auditId);
    return { cancelled };
  }),

  issues: protectedProcedure.input(zAuditRef).query(async ({ input, ctx }) => {
    await requireProjectAccess({
      userId: ctx.session.userId,
      projectId: input.projectId,
      level: 'read',
    });
    await loadAudit(input.projectId, input.auditId);
    return getAuditIssueSummary(input);
  }),

  pages: protectedProcedure
    .input(
      zAuditRef.extend({
        issue: z.string().max(100).optional(),
        sort: z
          .enum(Object.keys(AUDIT_PAGE_SORTS) as [keyof typeof AUDIT_PAGE_SORTS])
          .default('score_asc'),
        cursor: z.string().max(100).nullish(),
        limit: z.number().int().min(1).max(200).default(50),
      })
    )
    .query(async ({ input, ctx }) => {
      await requireProjectAccess({
        userId: ctx.session.userId,
        projectId: input.projectId,
        level: 'read',
      });
      await loadAudit(input.projectId, input.auditId);
      return listAuditPages(input);
    }),

  page: protectedProcedure
    .input(zAuditRef.extend({ url: z.string().max(MAX_URL_LENGTH) }))
    .query(async ({ input, ctx }) => {
      await requireProjectAccess({
        userId: ctx.session.userId,
        projectId: input.projectId,
        level: 'read',
      });
      await loadAudit(input.projectId, input.auditId);
      const page = await getAuditPage(input);
      if (!page) {
        throw new TRPCNotFoundError('Page not found in this audit');
      }
      return page;
    }),

  /**
   * Live Lighthouse for one URL, cached 24h per org. A mutation because a
   * cache miss is billed.
   */
  lighthouse: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        url: z.string().url().max(MAX_URL_LENGTH),
        device: z.enum(['mobile', 'desktop']).default('mobile'),
      })
    )
    .mutation(async ({ input, ctx }) => {
      await requireProjectAccess({
        userId: ctx.session.userId,
        projectId: input.projectId,
        level: 'write',
      });
      return withSeoErrors(() =>
        getLighthouseForUrl({
          projectId: input.projectId,
          url: input.url,
          strategy: input.device,
        })
      );
    }),
});
