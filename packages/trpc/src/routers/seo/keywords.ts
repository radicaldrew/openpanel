import { createHash } from 'node:crypto';
import {
  getChartStartEndDate,
  getGscQueriesWithMetrics,
  getKeywordOverview,
  getRankedKeywords,
  getSerpPreview,
  getSettingsForProject,
  researchKeywordIdeas,
  researchKeywordSuggestions,
  researchRelatedKeywords,
} from '@openpanel/db';
import { seoQueue } from '@openpanel/queue';
import { zRange } from '@openpanel/validation';
import { z } from 'zod';
import { requireProjectAccess } from '../../access';
import { createTRPCRouter, protectedProcedure } from '../../trpc';
import { withSeoErrors } from './errors';

const DEFAULT_RESEARCH_LIMIT = 100;
const MAX_RESEARCH_LIMIT = 700;
const MAX_OVERVIEW_KEYWORDS = 700;
const MAX_KEYWORD_LENGTH = 200;
const DEFAULT_GSC_LIMIT = 50;
const MAX_GSC_LIMIT = 500;

const zKeyword = z.string().trim().min(1).max(MAX_KEYWORD_LENGTH);

const zSeedInput = z.object({
  projectId: z.string(),
  seed: zKeyword,
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_RESEARCH_LIMIT)
    .default(DEFAULT_RESEARCH_LIMIT),
});

/**
 * Same range → dates resolution as the gsc router, so the "From Search
 * Console" source and the Search Console tab agree on which queries are
 * "top-N for this range".
 */
export async function resolveGscDates(
  projectId: string,
  input: { range: string; startDate?: string | null; endDate?: string | null }
) {
  const { timezone } = await getSettingsForProject(projectId);
  const { startDate, endDate } = getChartStartEndDate(
    {
      range: input.range as Parameters<typeof getChartStartEndDate>[0]['range'],
      startDate: input.startDate,
      endDate: input.endDate,
    },
    timezone
  );
  return { startDate: startDate.slice(0, 10), endDate: endDate.slice(0, 10) };
}

/**
 * Deterministic per keyword set, so reloading the Search Console tab while a
 * fetch is queued does not stack duplicate jobs. BullMQ rejects a second add
 * with the same jobId while the first is still pending or active.
 */
export function keywordMetricsJobId(projectId: string, keywords: string[]): string {
  const hash = createHash('sha1')
    .update([...keywords].sort().join('\n'))
    .digest('hex')
    .slice(0, 16);
  return `seoKeywordMetrics:${projectId}:${hash}`;
}

export async function enqueueKeywordMetrics(
  projectId: string,
  keywords: string[]
): Promise<void> {
  if (keywords.length === 0) {
    return;
  }
  await seoQueue.add(
    'seoKeywordMetrics',
    { type: 'seoKeywordMetrics', payload: { projectId, keywords } },
    { jobId: keywordMetricsJobId(projectId, keywords) }
  );
}

export const seoKeywordsRouter = createTRPCRouter({
  ideas: protectedProcedure.input(zSeedInput).query(async ({ input, ctx }) => {
    await requireProjectAccess({
      userId: ctx.session.userId,
      projectId: input.projectId,
      level: 'read',
    });
    return withSeoErrors(() => researchKeywordIdeas(input));
  }),

  suggestions: protectedProcedure
    .input(zSeedInput)
    .query(async ({ input, ctx }) => {
      await requireProjectAccess({
        userId: ctx.session.userId,
        projectId: input.projectId,
        level: 'read',
      });
      return withSeoErrors(() => researchKeywordSuggestions(input));
    }),

  related: protectedProcedure
    .input(zSeedInput)
    .query(async ({ input, ctx }) => {
      await requireProjectAccess({
        userId: ctx.session.userId,
        projectId: input.projectId,
        level: 'read',
      });
      return withSeoErrors(() => researchRelatedKeywords(input));
    }),

  /**
   * Persists into seo_keyword_metrics as a side effect, which is why it is a
   * mutation and needs write access.
   */
  overview: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        keywords: z.array(zKeyword).min(1).max(MAX_OVERVIEW_KEYWORDS),
      })
    )
    .mutation(async ({ input, ctx }) => {
      await requireProjectAccess({
        userId: ctx.session.userId,
        projectId: input.projectId,
        level: 'write',
      });
      return withSeoErrors(() => getKeywordOverview(input));
    }),

  rankedKeywords: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        /** Own domain when omitted; otherwise must be a configured competitor. */
        domain: z.string().trim().toLowerCase().max(253).optional(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_RESEARCH_LIMIT)
          .default(DEFAULT_RESEARCH_LIMIT),
        offset: z.number().int().min(0).default(0),
      })
    )
    .query(async ({ input, ctx }) => {
      await requireProjectAccess({
        userId: ctx.session.userId,
        projectId: input.projectId,
        level: 'read',
      });
      return withSeoErrors(() => getRankedKeywords(input));
    }),

  serpPreview: protectedProcedure
    .input(z.object({ projectId: z.string(), keyword: zKeyword }))
    .query(async ({ input, ctx }) => {
      await requireProjectAccess({
        userId: ctx.session.userId,
        projectId: input.projectId,
        level: 'read',
      });
      return withSeoErrors(() => getSerpPreview(input));
    }),

  /**
   * Top-N Search Console queries for the range, left-joined with stored
   * keyword metrics. Missing metrics are fetched in the background by one
   * batched seoKeywordMetrics job; those rows come back `pending`.
   *
   * Read-only members still see the rows, but only a writer's request
   * enqueues the fetch: the job spends the organization's DataForSEO budget.
   */
  gscEnriched: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        range: zRange,
        startDate: z.string().nullish(),
        endDate: z.string().nullish(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_GSC_LIMIT)
          .default(DEFAULT_GSC_LIMIT),
      })
    )
    .query(async ({ input, ctx }) => {
      const access = await requireProjectAccess({
        userId: ctx.session.userId,
        projectId: input.projectId,
        level: 'read',
      });
      const { startDate, endDate } = await resolveGscDates(
        input.projectId,
        input
      );
      const { rows, missingKeywords } = await withSeoErrors(() =>
        getGscQueriesWithMetrics({
          projectId: input.projectId,
          startDate,
          endDate,
          limit: input.limit,
        })
      );
      const canSpend = access.level === 'write' || access.level === 'admin';
      if (canSpend) {
        await enqueueKeywordMetrics(input.projectId, missingKeywords);
      }
      return { rows, queued: canSpend ? missingKeywords.length : 0 };
    }),
});
