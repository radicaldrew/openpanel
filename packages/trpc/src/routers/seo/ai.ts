import {
  AI_ENGINES,
  getAiAggregate,
  getAiEngineTraffic,
  getAiMentions,
  getAiShareOfVoice,
  getAiTopPages,
  getChartStartEndDate,
  getSettingsForProject,
} from '@openpanel/db';
import { zRange } from '@openpanel/validation';
import { z } from 'zod';
import { requireProjectAccess } from '../../access';
import { createTRPCRouter, protectedProcedure } from '../../trpc';
import { withSeoErrors } from './errors';

const MAX_PROMPT_LENGTH = 300;
const MAX_MENTIONS = 200;
const MAX_TOP_PAGES = 10;

const zProjectId = z.object({ projectId: z.string() });
const zEngines = z.array(z.enum(AI_ENGINES)).min(1).optional();
const zDateInput = z.object({
  range: zRange,
  startDate: z.string().nullish(),
  endDate: z.string().nullish(),
});

const zMentionTarget = z.discriminatedUnion('type', [
  z.object({ type: z.literal('domain'), value: z.string().trim().min(1).max(253) }),
  z.object({
    type: z.literal('keyword'),
    value: z.string().trim().min(1).max(MAX_PROMPT_LENGTH),
  }),
]);

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

/**
 * AI visibility (SEO.md §7 seo.ai). Every DataForSEO procedure is a cached
 * read (24 h), so read access is enough; nothing here persists.
 */
export const seoAiRouter = createTRPCRouter({
  /** Answers mentioning the tracked domain, a competitor, or — for the prompt
   * explorer — a free-text keyword. */
  mentions: protectedProcedure
    .input(
      zProjectId.extend({
        target: zMentionTarget.optional(),
        engines: zEngines,
        limit: z.number().int().min(1).max(MAX_MENTIONS).optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      await requireProjectAccess({
        userId: ctx.session.userId,
        projectId: input.projectId,
        level: 'read',
      });
      return withSeoErrors(() => getAiMentions(input));
    }),

  aggregate: protectedProcedure
    .input(zProjectId.extend({ engines: zEngines }))
    .query(async ({ input, ctx }) => {
      await requireProjectAccess({
        userId: ctx.session.userId,
        projectId: input.projectId,
        level: 'read',
      });
      return withSeoErrors(() => getAiAggregate(input));
    }),

  shareOfVoice: protectedProcedure
    .input(zProjectId.extend({ engines: zEngines }))
    .query(async ({ input, ctx }) => {
      await requireProjectAccess({
        userId: ctx.session.userId,
        projectId: input.projectId,
        level: 'read',
      });
      return withSeoErrors(() => getAiShareOfVoice(input));
    }),

  topPages: protectedProcedure
    .input(
      zProjectId.extend({
        engines: zEngines,
        limit: z.number().int().min(1).max(MAX_TOP_PAGES).optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      await requireProjectAccess({
        userId: ctx.session.userId,
        projectId: input.projectId,
        level: 'read',
      });
      return withSeoErrors(() => getAiTopPages(input));
    }),

  /** Sessions referred by AI assistants, from OpenPanel's own data. */
  traffic: protectedProcedure
    .input(zProjectId.merge(zDateInput))
    .query(async ({ input, ctx }) => {
      await requireProjectAccess({
        userId: ctx.session.userId,
        projectId: input.projectId,
        level: 'read',
      });
      const dates = await resolveDates(input.projectId, input);
      return getAiEngineTraffic({ projectId: input.projectId, ...dates });
    }),
});
