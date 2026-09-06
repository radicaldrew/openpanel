import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AI_ENGINES, getAiMentions, getAiShareOfVoice } from '@openpanel/db';
import { z } from 'zod';
import type { McpAuthContext } from '../../auth';
import { projectIdSchema, resolveProjectId, table, zLimit } from '../shared';
import { round, withSeoErrorHandling } from './shared';

const DEFAULT_MENTIONS_LIMIT = 25;
const MAX_MENTIONS_LIMIT = 200;
const MAX_PROMPT_LENGTH = 500;
const MAX_SOURCES_PER_MENTION = 5;

const zEngines = z
  .array(z.enum(AI_ENGINES))
  .min(1)
  .optional()
  .describe('AI engines to query (default all): chat_gpt, google (AI Overviews / AI Mode)');

export function registerSeoAiTools(server: McpServer, context: McpAuthContext) {
  server.tool(
    'seo_ai_mentions',
    "AI answers that cite a domain or answer a prompt (DataForSEO LLM Mentions): the questions people ask ChatGPT / Google AI, their AI search volume and which pages get cited, plus a leaderboard of cited domains with the project's own domain and competitors flagged. Target the project's domain (default), a configured competitor, or a free-text prompt to explore who gets cited for it. Cached 24h; a fresh call costs about $0.01 per engine.",
    {
      projectId: projectIdSchema(context),
      domain: z
        .string()
        .trim()
        .min(1)
        .max(253)
        .optional()
        .describe("Own domain (default) or a configured competitor; ignored when `prompt` is set"),
      prompt: z
        .string()
        .trim()
        .min(1)
        .max(MAX_PROMPT_LENGTH)
        .optional()
        .describe('A question or keyword to explore instead of a domain'),
      engines: zEngines,
      limit: zLimit(DEFAULT_MENTIONS_LIMIT, MAX_MENTIONS_LIMIT),
    },
    async ({ projectId: inputProjectId, domain, prompt, engines, limit }) =>
      withSeoErrorHandling(async () => {
        const projectId = await resolveProjectId(context, inputProjectId);
        const take = limit ?? DEFAULT_MENTIONS_LIMIT;
        const result = await getAiMentions({
          projectId,
          target: prompt
            ? { type: 'keyword', value: prompt }
            : domain
              ? { type: 'domain', value: domain }
              : undefined,
          engines,
          limit: take,
        });
        const mentions = result.mentions.map((mention) => ({
          engine: mention.engine,
          question: mention.question,
          aiSearchVolume: mention.aiSearchVolume,
          lastSeen: mention.lastResponseAt?.slice(0, 10) ?? null,
          brands: mention.brandEntities.join(', '),
          sources: mention.sources
            .slice(0, MAX_SOURCES_PER_MENTION)
            .map((source) => source.url ?? source.domain ?? '')
            .filter(Boolean)
            .join(' '),
        }));
        return {
          target: result.target,
          engines: result.engines,
          citedDomains: table(result.citedDomains, {
            limit: take,
            columns: ['domain', 'answers', 'citations', 'isOwn', 'isCompetitor'],
            sum: ['answers', 'citations'],
            sortedBy: 'answers',
            unit: 'domains',
          }),
          mentions: table(mentions, {
            limit: take,
            columns: ['engine', 'question', 'aiSearchVolume', 'lastSeen', 'brands', 'sources'],
            sortedBy: 'aiSearchVolume',
            unit: 'answers',
          }),
        };
      })
  );

  server.tool(
    'seo_ai_share_of_voice',
    "How often AI engines mention the project's domain versus its configured competitors (DataForSEO LLM Mentions cross-aggregated metrics): mentions, AI search volume and share of all mentions, per engine. Needs at least one competitor in the project SEO config. Cached 24h; a fresh call costs about $0.01 per engine.",
    {
      projectId: projectIdSchema(context),
      engines: zEngines,
    },
    async ({ projectId: inputProjectId, engines }) =>
      withSeoErrorHandling(async () => {
        const projectId = await resolveProjectId(context, inputProjectId);
        const result = await getAiShareOfVoice({ projectId, engines });
        const rows = result.groups.map((group) => ({
          domain: group.domain,
          isOwn: group.isOwn,
          mentions: group.mentions,
          sharePct: round(group.share, 1),
          aiSearchVolume: group.aiSearchVolume,
          ...Object.fromEntries(
            result.engines.map((engine) => [`mentions_${engine}`, group.perEngine[engine]])
          ),
        }));
        return {
          engines: result.engines,
          ...table(rows, {
            limit: rows.length,
            sortedBy: 'mentions',
            unit: 'domains',
          }),
        };
      })
  );
}
