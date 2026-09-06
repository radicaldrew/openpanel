import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  AUDIT_MAX_PAGES_MAX,
  AUDIT_MAX_PAGES_MIN,
  AUDIT_PRICE_PER_PAGE_JS_USD,
  AUDIT_PRICE_PER_PAGE_USD,
  createAudit,
  estimateAuditCostUsd,
  getAudit,
  getAuditIssueSummary,
  getAuditMaxPagesDefault,
  listAuditPages,
  listAudits,
  readAuditSummary,
  type SeoAudit,
  SEO_AUDIT_ISSUES,
} from '@openpanel/db';
import { seoQueue } from '@openpanel/queue';
import { z } from 'zod';
import type { McpAuthContext } from '../../auth';
import { projectIdSchema, resolveProjectId, table, zLimit } from '../shared';
import { requireWriteScope, withSeoErrorHandling } from './shared';

const DEFAULT_AUDIT_LIMIT = 10;
const MAX_AUDIT_LIMIT = 50;
const DEFAULT_PAGE_LIMIT = 25;
const MAX_PAGE_LIMIT = 200;
const ISSUE_KEYS = SEO_AUDIT_ISSUES.map((issue) => issue.key);

function serializeAudit(audit: SeoAudit) {
  const summary = readAuditSummary(audit);
  return {
    id: audit.id,
    status: audit.status,
    maxPages: audit.maxPages,
    pagesCrawled: audit.pagesCrawled,
    score: audit.score,
    costUsd: audit.costUsd,
    error: audit.error,
    startedAt: audit.startedAt,
    completedAt: audit.completedAt,
    enableJavascript: summary.options?.enableJavascript ?? false,
  };
}

/** The audit named, or the newest completed one; always checked against the project. */
async function resolveAudit(projectId: string, auditId: string | undefined): Promise<SeoAudit> {
  if (auditId) {
    const audit = await getAudit(auditId);
    if (!audit || audit.projectId !== projectId) {
      throw new Error(`Audit ${auditId} was not found for this project.`);
    }
    return audit;
  }
  const audits = await listAudits(projectId, MAX_AUDIT_LIMIT);
  const completed = audits.find((audit) => audit.status === 'completed') ?? audits[0];
  if (!completed) {
    throw new Error('No site audit has run for this project yet. Start one with seo_start_audit.');
  }
  return completed;
}

export function registerSeoAuditTools(server: McpServer, context: McpAuthContext) {
  server.tool(
    'seo_audit_list',
    'List site audits (DataForSEO On-Page crawls) for the project, newest first: status (queued, crawling, completed, failed), pages crawled, on-page score (0–100), cost and timing. Use an `id` from here with seo_audit_issues and seo_audit_pages.',
    {
      projectId: projectIdSchema(context),
      limit: zLimit(DEFAULT_AUDIT_LIMIT, MAX_AUDIT_LIMIT),
    },
    async ({ projectId: inputProjectId, limit }) =>
      withSeoErrorHandling(async () => {
        const projectId = await resolveProjectId(context, inputProjectId);
        const take = limit ?? DEFAULT_AUDIT_LIMIT;
        const audits = await listAudits(projectId, take);
        return table(audits.map(serializeAudit), {
          limit: take,
          columns: ['id', 'status', 'score', 'pagesCrawled', 'maxPages', 'costUsd', 'startedAt', 'completedAt', 'error'],
          sortedBy: 'startedAt',
          unit: 'audits',
          moreAvailable: audits.length >= take,
        });
      })
  );

  server.tool(
    'seo_audit_issues',
    'Issues found by a site audit, grouped by severity (critical, warning, info) with the number of affected pages, a description and how to fix each. Defaults to the newest completed audit. Pass an issue `key` to seo_audit_pages to list the pages affected.',
    {
      projectId: projectIdSchema(context),
      auditId: z.string().optional().describe('Audit id (default: newest completed audit)'),
    },
    async ({ projectId: inputProjectId, auditId }) =>
      withSeoErrorHandling(async () => {
        const projectId = await resolveProjectId(context, inputProjectId);
        const audit = await resolveAudit(projectId, auditId);
        const summary = await getAuditIssueSummary({ projectId, auditId: audit.id });
        return {
          audit: serializeAudit(audit),
          totals: summary.totals,
          ...table(summary.issues, {
            limit: summary.issues.length,
            columns: ['key', 'severity', 'label', 'count', 'description', 'howToFix'],
            sortedBy: 'severity',
            unit: 'issues',
          }),
        };
      })
  );

  server.tool(
    'seo_audit_pages',
    'Pages crawled by a site audit with status code, on-page score, title, word count, indexability and the issue keys each page has. Filter by an issue `key` from seo_audit_issues to see only affected pages; sort by worst score first (default), status code, word count, load time or URL. Use `cursor` to page.',
    {
      projectId: projectIdSchema(context),
      auditId: z.string().optional().describe('Audit id (default: newest completed audit)'),
      issue: z
        .string()
        .optional()
        .describe(`Only pages with this issue key, e.g. ${ISSUE_KEYS.slice(0, 4).join(', ')}`),
      sort: z
        .enum(['score_asc', 'score_desc', 'status_desc', 'words_asc', 'load_desc', 'url_asc'])
        .optional()
        .describe('Default score_asc (worst first); status_desc = error codes first, words_asc = thinnest content first, load_desc = slowest first'),
      cursor: z.string().optional().describe('Opaque cursor from a previous response'),
      limit: zLimit(DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT),
    },
    async ({ projectId: inputProjectId, auditId, issue, sort, cursor, limit }) =>
      withSeoErrorHandling(async () => {
        const projectId = await resolveProjectId(context, inputProjectId);
        const audit = await resolveAudit(projectId, auditId);
        const take = limit ?? DEFAULT_PAGE_LIMIT;
        const result = await listAuditPages({
          projectId,
          auditId: audit.id,
          issue,
          sort,
          cursor,
          limit: take,
        });
        const rows = result.pages.map((page) => ({
          url: page.url,
          statusCode: page.statusCode,
          score: page.onpageScore,
          title: page.title,
          wordCount: page.wordCount,
          loadTimeMs: page.loadTimeMs,
          isIndexable: page.isIndexable,
          issues: page.issues.map((entry) => entry.key).join(', '),
        }));
        return {
          auditId: audit.id,
          total: result.total,
          nextCursor: result.nextCursor,
          ...table(rows, {
            limit: take,
            columns: ['url', 'statusCode', 'score', 'title', 'wordCount', 'loadTimeMs', 'isIndexable', 'issues'],
            sortedBy: sort ?? 'score_asc',
            unit: 'pages',
            moreAvailable: result.nextCursor !== null,
          }),
        };
      })
  );

  if (context.clientType !== 'root') {
    return;
  }

  server.tool(
    'seo_start_audit',
    `Start a site audit: a DataForSEO On-Page crawl of the project's domain (WRITE: root client only). Spends the organization's DataForSEO balance: about $${AUDIT_PRICE_PER_PAGE_USD} per crawled page, or $${AUDIT_PRICE_PER_PAGE_JS_USD} per page with JavaScript rendering — 500 pages ≈ $${estimateAuditCostUsd(500, false)} (≈ $${estimateAuditCostUsd(500, true)} with JS). The response returns the estimate; confirm the page budget with the user first. Results arrive in a few minutes; poll seo_audit_list. Refuses when an audit is already running or the monthly spend cap is reached.`,
    {
      projectId: projectIdSchema(context),
      maxPages: z
        .number()
        .int()
        .min(AUDIT_MAX_PAGES_MIN)
        .max(AUDIT_MAX_PAGES_MAX)
        .optional()
        .describe(`Page budget for the crawl (default ${getAuditMaxPagesDefault()})`),
      enableJavascript: z
        .boolean()
        .optional()
        .describe('Render JavaScript before analysing pages (4x the price; default false)'),
    },
    async ({ projectId: inputProjectId, maxPages, enableJavascript }) =>
      withSeoErrorHandling(async () => {
        requireWriteScope(context, 'seo_start_audit');
        const projectId = await resolveProjectId(context, inputProjectId);
        const pages = maxPages ?? getAuditMaxPagesDefault();
        const js = enableJavascript ?? false;
        const result = await createAudit({ projectId, maxPages: pages, enableJavascript: js });
        if (!result.ok) {
          const reasons = {
            already_running: 'An audit is already running for this project; wait for it to finish (seo_audit_list).',
            no_domain: 'Set a domain for this project first under Settings → DataForSEO.',
            spend_cap: 'The monthly DataForSEO spend cap is reached; raise it under Settings → DataForSEO.',
          } as const;
          return { started: false, reason: result.reason, message: reasons[result.reason] };
        }
        await seoQueue.add(
          'seoAuditStart',
          { type: 'seoAuditStart', payload: { projectId, auditId: result.audit.id } },
          { jobId: `seoAuditStart:${result.audit.id}` }
        );
        return {
          started: true,
          audit: serializeAudit(result.audit),
          estimatedCostUsd: estimateAuditCostUsd(pages, js),
        };
      })
  );
}
