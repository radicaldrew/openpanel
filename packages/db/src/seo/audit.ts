import type {
  LighthouseStrategy,
  OnPagePageItem,
  StoredLighthousePayload,
} from '@openpanel/dataforseo';
import { originalCh } from '../clickhouse/client';
import type { SeoAudit } from '../generated/prisma/client';
import { db } from '../prisma-client';
import {
  getSeoAuditIssue,
  issuesForChecks,
  type SeoAuditIssue,
  type SeoAuditIssueSummary,
  summarizeIssueCounts,
} from './audit-issues';
import { withSeoCache } from './cache';
import {
  getDfsClientForOrganization,
  getProjectOrganizationId,
  isDfsSpendCapReached,
} from './client';
import { getSeoProjectConfig } from './config';
import { SPEND_CAP_ERROR } from './rank-runs';

export const SEO_AUDIT_PAGES_TABLE = 'seo_audit_pages';

export type SeoAuditStatus = 'queued' | 'crawling' | 'completed' | 'failed';
const ACTIVE_AUDIT_STATUSES: SeoAuditStatus[] = ['queued', 'crawling'];

export const AUDIT_CANCELLED_ERROR = 'cancelled';
export const AUDIT_MAX_PAGES_MIN = 10;
export const AUDIT_MAX_PAGES_MAX = 10_000;
const AUDIT_MAX_PAGES_FALLBACK = 500;

/**
 * Estimated DataForSEO On-Page prices per crawled page, used only for the
 * cost line in the "Run audit" dialog. Task cost is what DFS actually bills.
 */
export const AUDIT_PRICE_PER_PAGE_USD = 0.000_125;
export const AUDIT_PRICE_PER_PAGE_JS_USD = AUDIT_PRICE_PER_PAGE_USD * 4;

/** SEO_AUDIT_MAX_PAGES_DEFAULT env, clamped to the allowed range. */
export function getAuditMaxPagesDefault(): number {
  const raw = Number.parseInt(process.env.SEO_AUDIT_MAX_PAGES_DEFAULT ?? '', 10);
  if (!Number.isFinite(raw)) {
    return AUDIT_MAX_PAGES_FALLBACK;
  }
  return Math.min(AUDIT_MAX_PAGES_MAX, Math.max(AUDIT_MAX_PAGES_MIN, raw));
}

export function estimateAuditCostUsd(
  maxPages: number,
  enableJavascript: boolean
): number {
  const perPage = enableJavascript
    ? AUDIT_PRICE_PER_PAGE_JS_USD
    : AUDIT_PRICE_PER_PAGE_USD;
  return Math.round(maxPages * perPage * 10_000) / 10_000;
}

// ---------------------------------------------------------------------------
// SeoAudit rows
// ---------------------------------------------------------------------------

/**
 * Everything not on the model lives in `summary`: the options the audit was
 * started with, and the DFS on_page/summary result once it finishes.
 */
export interface SeoAuditSummaryJson {
  options: { enableJavascript: boolean };
  dfs?: unknown;
}

export function readAuditSummary(audit: Pick<SeoAudit, 'summary'>): SeoAuditSummaryJson {
  const raw = audit.summary;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    const options = record.options;
    return {
      options: {
        enableJavascript:
          !!options &&
          typeof options === 'object' &&
          (options as Record<string, unknown>).enableJavascript === true,
      },
      dfs: record.dfs,
    };
  }
  return { options: { enableJavascript: false } };
}

export type CreateAuditResult =
  | { ok: true; audit: SeoAudit }
  | { ok: false; reason: 'already_running'; audit: SeoAudit }
  | { ok: false; reason: 'no_domain' }
  | { ok: false; reason: 'spend_cap'; audit: SeoAudit };

export async function getActiveAudit(projectId: string): Promise<SeoAudit | null> {
  return db.seoAudit.findFirst({
    where: { projectId, status: { in: ACTIVE_AUDIT_STATUSES } },
    orderBy: { startedAt: 'desc' },
  });
}

export async function getAudit(auditId: string): Promise<SeoAudit | null> {
  return db.seoAudit.findUnique({ where: { id: auditId } });
}

export async function listAudits(projectId: string, limit = 20): Promise<SeoAudit[]> {
  return db.seoAudit.findMany({
    where: { projectId },
    orderBy: { startedAt: 'desc' },
    take: limit,
  });
}

/**
 * One active audit per project: a second crawl of the same site while the
 * first is still running doubles the spend for the same answer. A capped
 * attempt leaves a failed row behind so the list can say why nothing ran.
 * The caller enqueues `seoAuditStart` for an `ok` result.
 */
export async function createAudit({
  projectId,
  maxPages,
  enableJavascript,
}: {
  projectId: string;
  maxPages: number;
  enableJavascript: boolean;
}): Promise<CreateAuditResult> {
  const active = await getActiveAudit(projectId);
  if (active) {
    return { ok: false, reason: 'already_running', audit: active };
  }
  const config = await getSeoProjectConfig(projectId);
  if (!config?.domain) {
    return { ok: false, reason: 'no_domain' };
  }
  const summary: SeoAuditSummaryJson = { options: { enableJavascript } };
  const organizationId = await getProjectOrganizationId(projectId);
  if (await isDfsSpendCapReached(organizationId)) {
    const audit = await db.seoAudit.create({
      data: {
        projectId,
        status: 'failed',
        maxPages,
        error: SPEND_CAP_ERROR,
        summary: summary as object,
        completedAt: new Date(),
      },
    });
    return { ok: false, reason: 'spend_cap', audit };
  }
  const audit = await db.seoAudit.create({
    data: { projectId, status: 'queued', maxPages, summary: summary as object },
  });

  // Two "Run audit" clicks can both pass the active-audit check above before
  // either row exists. Whoever is not the earliest active audit backs out,
  // so at most one crawl is ever posted to DataForSEO.
  const earliest = await db.seoAudit.findFirst({
    where: { projectId, status: { in: ACTIVE_AUDIT_STATUSES } },
    orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
  });
  if (earliest && earliest.id !== audit.id) {
    await db.seoAudit.delete({ where: { id: audit.id } });
    return { ok: false, reason: 'already_running', audit: earliest };
  }
  return { ok: true, audit };
}

export async function markAuditCrawling(
  auditId: string,
  { dfsTaskId, costUsd }: { dfsTaskId: string; costUsd: number }
): Promise<void> {
  await db.seoAudit.update({
    where: { id: auditId },
    data: { status: 'crawling', dfsTaskId, costUsd: { increment: costUsd } },
  });
}

export async function updateAuditProgress(
  auditId: string,
  { pagesCrawled, costUsd = 0 }: { pagesCrawled: number; costUsd?: number }
): Promise<void> {
  await db.seoAudit.update({
    where: { id: auditId },
    data: { pagesCrawled, costUsd: { increment: costUsd } },
  });
}

export async function completeAudit(
  auditId: string,
  {
    score,
    pagesCrawled,
    dfsSummary,
    costUsd = 0,
  }: {
    score: number | null;
    pagesCrawled: number;
    dfsSummary: unknown;
    costUsd?: number;
  }
): Promise<void> {
  const existing = await getAudit(auditId);
  const summary: SeoAuditSummaryJson = {
    ...(existing ? readAuditSummary(existing) : { options: { enableJavascript: false } }),
    dfs: dfsSummary,
  };
  await db.seoAudit.update({
    where: { id: auditId },
    data: {
      status: 'completed',
      score,
      pagesCrawled,
      summary: summary as object,
      costUsd: { increment: costUsd },
      completedAt: new Date(),
    },
  });
}

export async function failAudit(auditId: string, error: string): Promise<void> {
  await db.seoAudit.update({
    where: { id: auditId },
    data: { status: 'failed', error, completedAt: new Date() },
  });
}

/**
 * There is no DFS cancel for on_page tasks; the crawl finishes on its own
 * and the poll job sees the failed status and stops. Returns false when the
 * audit was not active.
 */
export async function cancelAudit(auditId: string): Promise<boolean> {
  const result = await db.seoAudit.updateMany({
    where: { id: auditId, status: { in: ACTIVE_AUDIT_STATUSES } },
    data: { status: 'failed', error: AUDIT_CANCELLED_ERROR, completedAt: new Date() },
  });
  return result.count > 0;
}

// ---------------------------------------------------------------------------
// seo_audit_pages
// ---------------------------------------------------------------------------

export interface SeoAuditPageInput {
  projectId: string;
  auditId: string;
  url: string;
  statusCode: number;
  onpageScore: number;
  title: string;
  metaDescription: string;
  h1: string;
  wordCount: number;
  loadTimeMs: number;
  sizeBytes: number;
  internalLinks: number;
  externalLinks: number;
  isIndexable: boolean;
  canonical: string;
  checks: Record<string, boolean | null>;
}

const REDIRECT_MIN = 300;
const REDIRECT_MAX = 399;
const OK_MIN = 200;
const OK_MAX = 299;

/**
 * Flatten a DFS page item into a seo_audit_pages row. The page-level
 * booleans DFS keeps outside `checks` are merged into the checks map so the
 * issue catalogue and the ClickHouse GROUP BY see one uniform object.
 */
export function toAuditPageRow(
  projectId: string,
  auditId: string,
  item: OnPagePageItem
): SeoAuditPageInput {
  const meta = item.meta ?? null;
  const checks: Record<string, boolean | null> = { ...(item.checks ?? {}) };
  const extras: [string, boolean | null | undefined][] = [
    ['broken_links', item.broken_links],
    ['broken_resources', item.broken_resources],
    ['duplicate_title', item.duplicate_title],
    ['duplicate_description', item.duplicate_description],
    ['duplicate_content', item.duplicate_content],
  ];
  for (const [key, value] of extras) {
    if (value !== undefined && value !== null) {
      checks[key] = value;
    }
  }
  const statusCode = item.status_code ?? 0;
  const isRedirect =
    checks.is_redirect === true || (statusCode >= REDIRECT_MIN && statusCode <= REDIRECT_MAX);
  const noindex = checks.no_index === true || checks.is_noindex === true;
  const isIndexable =
    statusCode >= OK_MIN && statusCode <= OK_MAX && !isRedirect && !noindex;
  const h1 = meta?.htags?.h1?.[0] ?? '';

  return {
    projectId,
    auditId,
    url: item.url,
    statusCode,
    onpageScore: item.onpage_score ?? 0,
    title: meta?.title ?? '',
    metaDescription: meta?.description ?? '',
    h1,
    wordCount: meta?.content?.plain_text_word_count ?? 0,
    loadTimeMs: Math.round(item.page_timing?.duration_time ?? 0),
    sizeBytes: item.size ?? 0,
    internalLinks: meta?.internal_links_count ?? 0,
    externalLinks: meta?.external_links_count ?? 0,
    isIndexable,
    canonical: meta?.canonical ?? '',
    checks,
  };
}

export async function insertAuditPages(rows: SeoAuditPageInput[]): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  await originalCh.insert({
    table: SEO_AUDIT_PAGES_TABLE,
    values: rows.map((row) => ({
      project_id: row.projectId,
      audit_id: row.auditId,
      url: row.url,
      status_code: row.statusCode,
      onpage_score: row.onpageScore,
      title: row.title,
      meta_description: row.metaDescription,
      h1: row.h1,
      word_count: row.wordCount,
      load_time_ms: row.loadTimeMs,
      size_bytes: row.sizeBytes,
      internal_links: row.internalLinks,
      external_links: row.externalLinks,
      is_indexable: row.isIndexable ? 1 : 0,
      canonical: row.canonical,
      checks_json: JSON.stringify(row.checks),
    })),
    format: 'JSONEachRow',
  });
}

interface AuditPageRow {
  url: string;
  status_code: number;
  onpage_score: number;
  title: string;
  meta_description: string;
  h1: string;
  word_count: number;
  load_time_ms: number;
  size_bytes: number;
  internal_links: number;
  external_links: number;
  is_indexable: number;
  canonical: string;
  checks_json: string;
}

export interface SeoAuditPage {
  url: string;
  statusCode: number;
  onpageScore: number;
  title: string;
  metaDescription: string;
  h1: string;
  wordCount: number;
  loadTimeMs: number;
  sizeBytes: number;
  internalLinks: number;
  externalLinks: number;
  isIndexable: boolean;
  canonical: string;
  checks: Record<string, boolean | null>;
  issues: SeoAuditIssue[];
}

function parseChecks(json: string): Record<string, boolean | null> {
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, boolean | null>;
    }
  } catch {
    // A row with unparsable checks still has its other columns.
  }
  return {};
}

function toAuditPage(row: AuditPageRow): SeoAuditPage {
  const checks = parseChecks(row.checks_json);
  return {
    url: row.url,
    statusCode: Number(row.status_code),
    onpageScore: Number(row.onpage_score),
    title: row.title,
    metaDescription: row.meta_description,
    h1: row.h1,
    wordCount: Number(row.word_count),
    loadTimeMs: Number(row.load_time_ms),
    sizeBytes: Number(row.size_bytes),
    internalLinks: Number(row.internal_links),
    externalLinks: Number(row.external_links),
    isIndexable: Number(row.is_indexable) === 1,
    canonical: row.canonical,
    checks,
    issues: issuesForChecks(checks),
  };
}

const PAGE_COLUMNS =
  'url, status_code, onpage_score, title, meta_description, h1, word_count, load_time_ms, size_bytes, internal_links, external_links, is_indexable, canonical, checks_json';

export const AUDIT_PAGE_SORTS = {
  score_asc: 'onpage_score ASC, url ASC',
  score_desc: 'onpage_score DESC, url ASC',
  url_asc: 'url ASC',
  status_desc: 'status_code DESC, url ASC',
  words_asc: 'word_count ASC, url ASC',
  load_desc: 'load_time_ms DESC, url ASC',
} as const;

export type SeoAuditPageSort = keyof typeof AUDIT_PAGE_SORTS;

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

/** Offset cursors are enough: an audit's pages never change after completion. */
export function encodePageCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

export function decodePageCursor(cursor: string | null | undefined): number {
  if (!cursor) {
    return 0;
  }
  const parsed = Number.parseInt(Buffer.from(cursor, 'base64url').toString('utf8'), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function issueFilterSql(issue: string | undefined): string {
  if (!issue) {
    return '';
  }
  const definition = getSeoAuditIssue(issue);
  if (!definition) {
    // Unknown key: match nothing rather than everything.
    return 'AND 0';
  }
  const expected = definition.invert ? 0 : 1;
  return `AND JSONHas(checks_json, {issue: String}) AND JSONExtractBool(checks_json, {issue: String}) = ${expected}`;
}

export async function listAuditPages({
  projectId,
  auditId,
  issue,
  sort = 'score_asc',
  cursor,
  limit = DEFAULT_PAGE_LIMIT,
}: {
  projectId: string;
  auditId: string;
  issue?: string;
  sort?: SeoAuditPageSort;
  cursor?: string | null;
  limit?: number;
}): Promise<{ pages: SeoAuditPage[]; nextCursor: string | null; total: number }> {
  const offset = decodePageCursor(cursor);
  const take = Math.min(MAX_PAGE_LIMIT, Math.max(1, limit));
  const orderBy = AUDIT_PAGE_SORTS[sort] ?? AUDIT_PAGE_SORTS.score_asc;
  const filter = issueFilterSql(issue);
  const params = { projectId, auditId, issue: issue ?? '', limit: take + 1, offset };

  const [rowsResult, totalResult] = await Promise.all([
    originalCh.query({
      query: `
        SELECT ${PAGE_COLUMNS}
        FROM ${SEO_AUDIT_PAGES_TABLE}
        WHERE project_id = {projectId: String}
          AND audit_id = {auditId: String}
          ${filter}
        ORDER BY ${orderBy}
        LIMIT {limit: UInt32} OFFSET {offset: UInt32}
      `,
      query_params: params,
      format: 'JSONEachRow',
    }),
    originalCh.query({
      query: `
        SELECT count() AS total
        FROM ${SEO_AUDIT_PAGES_TABLE}
        WHERE project_id = {projectId: String}
          AND audit_id = {auditId: String}
          ${filter}
      `,
      query_params: params,
      format: 'JSONEachRow',
    }),
  ]);
  const rows = await rowsResult.json<AuditPageRow>();
  const totals = await totalResult.json<{ total: number | string }>();
  const hasMore = rows.length > take;
  const pageRows = hasMore ? rows.slice(0, take) : rows;
  return {
    pages: pageRows.map(toAuditPage),
    nextCursor: hasMore ? encodePageCursor(offset + take) : null,
    total: Number(totals[0]?.total ?? 0),
  };
}

export async function getAuditPage({
  projectId,
  auditId,
  url,
}: {
  projectId: string;
  auditId: string;
  url: string;
}): Promise<SeoAuditPage | null> {
  const result = await originalCh.query({
    query: `
      SELECT ${PAGE_COLUMNS}
      FROM ${SEO_AUDIT_PAGES_TABLE}
      WHERE project_id = {projectId: String}
        AND audit_id = {auditId: String}
        AND url = {url: String}
      LIMIT 1
    `,
    query_params: { projectId, auditId, url },
    format: 'JSONEachRow',
  });
  const rows = await result.json<AuditPageRow>();
  const row = rows[0];
  return row ? toAuditPage(row) : null;
}

/**
 * One GROUP BY over every (key, value) pair in checks_json. Grouping happens
 * in ClickHouse so a 10k-page audit never streams its checks to the app.
 */
export async function getAuditIssueSummary({
  projectId,
  auditId,
}: {
  projectId: string;
  auditId: string;
}): Promise<SeoAuditIssueSummary> {
  const result = await originalCh.query({
    query: `
      SELECT pair.1 AS key, pair.2 AS value, count() AS count
      FROM ${SEO_AUDIT_PAGES_TABLE}
      ARRAY JOIN JSONExtractKeysAndValues(checks_json, 'Bool') AS pair
      WHERE project_id = {projectId: String}
        AND audit_id = {auditId: String}
      GROUP BY key, value
    `,
    query_params: { projectId, auditId },
    format: 'JSONEachRow',
  });
  const rows = await result.json<{ key: string; value: boolean | number; count: number | string }>();
  return summarizeIssueCounts(
    rows.map((row) => ({
      key: row.key,
      value: row.value === true || row.value === 1,
      count: Number(row.count),
    }))
  );
}

// ---------------------------------------------------------------------------
// Lighthouse (per page, on demand)
// ---------------------------------------------------------------------------

/**
 * Lighthouse is billed per call and takes any URL, so without this a project
 * member could spend the org's balance auditing arbitrary sites. Only pages
 * on the tracked domain (or a subdomain of it) are allowed; audit pages
 * always qualify because the crawl was scoped to that domain.
 */
export function assertLighthouseUrlAllowed(url: string, domain: string): string {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    throw new Error(`"${url}" is not a valid URL`);
  }
  const own = domain.trim().toLowerCase().replace(/^www\./, '');
  const candidate = host.replace(/^www\./, '');
  if (candidate !== own && !candidate.endsWith(`.${own}`)) {
    throw new Error(`Lighthouse can only run against pages on ${own}`);
  }
  return url;
}

export async function getLighthouseForUrl({
  projectId,
  url,
  strategy,
}: {
  projectId: string;
  url: string;
  strategy: LighthouseStrategy;
}): Promise<StoredLighthousePayload> {
  const config = await getSeoProjectConfig(projectId);
  if (!config?.domain) {
    throw new Error(`Project ${projectId} has no SEO domain configured`);
  }
  assertLighthouseUrlAllowed(url, config.domain);
  const organizationId = await getProjectOrganizationId(projectId);
  const params = { url, strategy };
  return withSeoCache(
    {
      organizationId,
      endpoint: 'on_page/lighthouse/live/json',
      params,
      ttl: 'lighthouse',
    },
    async () => {
      const client = await getDfsClientForOrganization(organizationId);
      return (await client.lighthouse.live(params)).data;
    }
  );
}
