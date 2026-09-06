import { z } from 'zod';
import type { DataforseoTransport } from './core';
import {
  assertOk,
  buildFreeTaskBilling,
  buildTaskBilling,
  type DataforseoApiResponse,
  type DataforseoTaskLike,
  isRecord,
  parseTaskItems,
  parseTaskTotalCount,
  parseWithSchema,
} from './envelope';
import { DataForSeoError } from './errors';

// DataForSEO On-Page API: a crawl is posted with task_post (charged per page
// crawled, up to max_crawl_pages), then polled through summary/{id} until
// crawl_progress is "finished", after which the per-page endpoints are free to
// page through. @see https://docs.dataforseo.com/v3/on_page/overview/

const TASK_POST_PATH = '/v3/on_page/task_post';
const DUPLICATE_TAGS_PATH = '/v3/on_page/duplicate_tags';
const LINKS_PATH = '/v3/on_page/links';
const NON_INDEXABLE_PATH = '/v3/on_page/non_indexable';
const PAGES_PATH = '/v3/on_page/pages';

/** Hard cap DataForSEO imposes on one list request. */
const MAX_LIST_LIMIT = 1000;

function clampLimit(limit: number | undefined, fallback: number): number {
  return Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(limit ?? fallback)));
}

// ---------------------------------------------------------------------------
// task_post
// ---------------------------------------------------------------------------

export interface OnPageTaskPostInput {
  /** Domain or start URL to crawl, e.g. "example.com". */
  target: string;
  /** Pages to crawl; DataForSEO bills per crawled page. */
  maxCrawlPages: number;
  /** Start from this URL instead of the target's root. */
  startUrl?: string;
  /** Render JS before analysing pages (slower, dearer). Default false. */
  enableJavascript?: boolean;
  /** Fetch and inspect page resources (images, scripts, ...). Default false. */
  loadResources?: boolean;
  /** Also crawl subdomains of the target. Default false. */
  crawlSubdomains?: boolean;
  /** Ignore robots.txt (site owners only). Default false. */
  respectRobotsTxt?: boolean;
  customUserAgent?: string;
  /** Crawl rate limit per minute; 1-3000 per DataForSEO. */
  maxCrawlRate?: number;
  /** Store the raw HTML of crawled pages. Default false. */
  storeRawHtml?: boolean;
  /** Echoed back on every task response for correlation. */
  tag?: string;
  /** Optional postback URL; omit to poll `summary` instead. */
  pingbackUrl?: string;
  /** 1 = normal (default), 2 = high priority (2x cost). */
  priority?: 1 | 2;
}

export interface PostedOnPageTask {
  taskId: string;
  tag: string | null;
  /** Provisional charge at post time (max_crawl_pages x per-page price). */
  costUsd: number;
}

export async function postOnPageTask(
  transport: DataforseoTransport,
  input: OnPageTaskPostInput,
): Promise<DataforseoApiResponse<PostedOnPageTask>> {
  if (!Number.isInteger(input.maxCrawlPages) || input.maxCrawlPages < 1) {
    throw new DataForSeoError('on_page/task_post requires max_crawl_pages >= 1', {
      kind: 'validation',
      path: TASK_POST_PATH,
    });
  }
  // Billed, non-idempotent: never replay on a 5xx.
  const response = await transport.post<DataforseoTaskLike & { data?: Record<string, unknown> }>(
    TASK_POST_PATH,
    [
      {
        target: input.target,
        max_crawl_pages: input.maxCrawlPages,
        ...(input.startUrl ? { start_url: input.startUrl } : {}),
        enable_javascript: input.enableJavascript ?? false,
        load_resources: input.loadResources ?? false,
        ...(input.crawlSubdomains !== undefined
          ? { allow_subdomains: input.crawlSubdomains }
          : {}),
        ...(input.respectRobotsTxt === false ? { respect_robots_txt: false } : {}),
        ...(input.customUserAgent ? { custom_user_agent: input.customUserAgent } : {}),
        ...(input.maxCrawlRate ? { max_crawl_rate: input.maxCrawlRate } : {}),
        ...(input.storeRawHtml ? { store_raw_html: true } : {}),
        ...(input.tag ? { tag: input.tag } : {}),
        ...(input.pingbackUrl ? { pingback_url: input.pingbackUrl } : {}),
        ...(input.priority ? { priority: input.priority } : {}),
      },
    ],
    { maxServerErrorRetries: 0 },
  );
  // task_post entries answer 20100 "Task Created", not 20000.
  const task = assertOk(response, { path: TASK_POST_PATH, okTaskStatusCode: 20_100 });
  if (!task.id) {
    throw new DataForSeoError('DataForSEO on_page/task_post returned no task id', {
      kind: 'invalid_response',
      path: TASK_POST_PATH,
    });
  }
  const billing = buildTaskBilling(task);
  const tag = isRecord(task.data) && typeof task.data.tag === 'string' ? task.data.tag : null;
  return {
    data: { taskId: task.id, tag, costUsd: billing.costUsd },
    billing,
  };
}

// ---------------------------------------------------------------------------
// summary/{id}
// ---------------------------------------------------------------------------

const onPageChecksSchema = z.record(z.string(), z.number().nullable()).nullable().optional();

export const onPageSummarySchema = z
  .object({
    crawl_progress: z.enum(['in_progress', 'finished']).or(z.string()),
    crawl_status: z
      .object({
        max_crawl_pages: z.number().nullable().optional(),
        pages_in_queue: z.number().nullable().optional(),
        pages_crawled: z.number().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    crawl_gateway_address: z.string().nullable().optional(),
    crawl_stop_reason: z.string().nullable().optional(),
    domain_info: z
      .object({
        name: z.string().nullable().optional(),
        cms: z.string().nullable().optional(),
        ip: z.string().nullable().optional(),
        server: z.string().nullable().optional(),
        crawl_start: z.string().nullable().optional(),
        crawl_end: z.string().nullable().optional(),
        total_pages: z.number().nullable().optional(),
        ssl_info: z.record(z.string(), z.unknown()).nullable().optional(),
        checks: onPageChecksSchema,
      })
      .passthrough()
      .nullable()
      .optional(),
    page_metrics: z
      .object({
        links_external: z.number().nullable().optional(),
        links_internal: z.number().nullable().optional(),
        duplicate_title: z.number().nullable().optional(),
        duplicate_description: z.number().nullable().optional(),
        duplicate_content: z.number().nullable().optional(),
        broken_links: z.number().nullable().optional(),
        broken_resources: z.number().nullable().optional(),
        links_relation_conflict: z.number().nullable().optional(),
        redirect_loop: z.number().nullable().optional(),
        onpage_score: z.number().nullable().optional(),
        non_indexable: z.number().nullable().optional(),
        checks: onPageChecksSchema,
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export type OnPageSummary = z.infer<typeof onPageSummarySchema>;

/**
 * Crawl status + site-wide metrics for a posted task (free). Poll until
 * `crawl_progress === 'finished'`; the per-page endpoints below return
 * partial data while the crawl is still running.
 */
export async function fetchOnPageSummary(
  transport: DataforseoTransport,
  taskId: string,
): Promise<DataforseoApiResponse<OnPageSummary>> {
  const path = `/v3/on_page/summary/${encodeURIComponent(taskId)}`;
  const response = await transport.get(path);
  const task = assertOk(response, { path });
  const data = parseWithSchema('on-page-summary', task, task.result?.[0], onPageSummarySchema);
  return { data, billing: buildFreeTaskBilling(task, path) };
}

// ---------------------------------------------------------------------------
// pages/{id}
// ---------------------------------------------------------------------------

export const onPagePageItemSchema = z
  .object({
    resource_type: z.string().nullable().optional(),
    status_code: z.number().nullable().optional(),
    location: z.string().nullable().optional(),
    url: z.string(),
    size: z.number().nullable().optional(),
    encoded_size: z.number().nullable().optional(),
    total_transfer_size: z.number().nullable().optional(),
    fetch_time: z.string().nullable().optional(),
    click_depth: z.number().nullable().optional(),
    onpage_score: z.number().nullable().optional(),
    is_resource: z.boolean().nullable().optional(),
    url_length: z.number().nullable().optional(),
    relative_url_length: z.number().nullable().optional(),
    last_modified: z.record(z.string(), z.unknown()).nullable().optional(),
    meta: z
      .object({
        title: z.string().nullable().optional(),
        charset: z.number().nullable().optional(),
        follow: z.boolean().nullable().optional(),
        generator: z.string().nullable().optional(),
        htags: z.record(z.string(), z.array(z.string())).nullable().optional(),
        description: z.string().nullable().optional(),
        favicon: z.string().nullable().optional(),
        meta_keywords: z.string().nullable().optional(),
        canonical: z.string().nullable().optional(),
        internal_links_count: z.number().nullable().optional(),
        external_links_count: z.number().nullable().optional(),
        inbound_links_count: z.number().nullable().optional(),
        images_count: z.number().nullable().optional(),
        images_size: z.number().nullable().optional(),
        scripts_count: z.number().nullable().optional(),
        scripts_size: z.number().nullable().optional(),
        stylesheets_count: z.number().nullable().optional(),
        stylesheets_size: z.number().nullable().optional(),
        title_length: z.number().nullable().optional(),
        description_length: z.number().nullable().optional(),
        render_blocking_scripts_count: z.number().nullable().optional(),
        render_blocking_stylesheets_count: z.number().nullable().optional(),
        cumulative_layout_shift: z.number().nullable().optional(),
        content: z
          .object({
            plain_text_size: z.number().nullable().optional(),
            plain_text_rate: z.number().nullable().optional(),
            plain_text_word_count: z.number().nullable().optional(),
            automated_readability_index: z.number().nullable().optional(),
            flesch_kincaid_readability_index: z.number().nullable().optional(),
            title_to_content_consistency: z.number().nullable().optional(),
            description_to_content_consistency: z.number().nullable().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
        social_media_tags: z.record(z.string(), z.string().nullable()).nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    page_timing: z
      .object({
        time_to_interactive: z.number().nullable().optional(),
        dom_complete: z.number().nullable().optional(),
        largest_contentful_paint: z.number().nullable().optional(),
        first_input_delay: z.number().nullable().optional(),
        connection_time: z.number().nullable().optional(),
        time_to_secure_connection: z.number().nullable().optional(),
        request_sent_time: z.number().nullable().optional(),
        waiting_time: z.number().nullable().optional(),
        download_time: z.number().nullable().optional(),
        duration_time: z.number().nullable().optional(),
        fetch_start: z.number().nullable().optional(),
        fetch_end: z.number().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    /** Boolean audit checks keyed by check name (e.g. "no_title", "is_https"). */
    checks: z.record(z.string(), z.boolean().nullable()).nullable().optional(),
    content_encoding: z.string().nullable().optional(),
    media_type: z.string().nullable().optional(),
    server: z.string().nullable().optional(),
    cache_control: z.record(z.string(), z.unknown()).nullable().optional(),
    checks_errors: z.array(z.string()).nullable().optional(),
    checks_warnings: z.array(z.string()).nullable().optional(),
    broken_resources: z.boolean().nullable().optional(),
    broken_links: z.boolean().nullable().optional(),
    duplicate_title: z.boolean().nullable().optional(),
    duplicate_description: z.boolean().nullable().optional(),
    duplicate_content: z.boolean().nullable().optional(),
  })
  .passthrough();

export type OnPagePageItem = z.infer<typeof onPagePageItemSchema>;

export interface OnPageListPage<TItem> {
  items: TItem[];
  totalCount: number | null;
  crawlProgress: string | null;
}

export interface OnPagePagesRequest {
  taskId: string;
  /** 1-1000, default 100. */
  limit?: number;
  offset?: number;
  /** DataForSEO filter expression, e.g. [["status_code", ">=", 400]]. */
  filters?: unknown[];
  /** e.g. ["onpage_score,asc"]. */
  orderBy?: string[];
}

function readCrawlProgress(task: DataforseoTaskLike): string | null {
  const first = task.result?.[0];
  return isRecord(first) && typeof first.crawl_progress === 'string'
    ? first.crawl_progress
    : null;
}

/**
 * Crawled pages with their on-page checks and metrics (free; page through with
 * limit/offset up to 1000 per call).
 */
export async function fetchOnPagePages(
  transport: DataforseoTransport,
  input: OnPagePagesRequest,
): Promise<DataforseoApiResponse<OnPageListPage<OnPagePageItem>>> {
  const response = await transport.post(PAGES_PATH, [
    {
      id: input.taskId,
      limit: clampLimit(input.limit, 100),
      offset: input.offset ?? 0,
      ...(input.filters && input.filters.length > 0 ? { filters: input.filters } : {}),
      ...(input.orderBy && input.orderBy.length > 0 ? { order_by: input.orderBy } : {}),
    },
  ]);
  const task = assertOk(response, { path: PAGES_PATH });
  return {
    data: {
      items: parseTaskItems('on-page-pages', task, onPagePageItemSchema),
      totalCount: parseTaskTotalCount(task),
      crawlProgress: readCrawlProgress(task),
    },
    billing: buildFreeTaskBilling(task, PAGES_PATH),
  };
}

// ---------------------------------------------------------------------------
// duplicate_tags
// ---------------------------------------------------------------------------

export const onPageDuplicateTagItemSchema = z
  .object({
    /** The duplicated title or description text. */
    accumulator: z.string().nullable().optional(),
    total_count: z.number().nullable().optional(),
    pages: z.array(z.string()).nullable().optional(),
  })
  .passthrough();

export type OnPageDuplicateTagItem = z.infer<typeof onPageDuplicateTagItemSchema>;

export interface OnPageDuplicateTagsRequest {
  taskId: string;
  type: 'duplicate_title' | 'duplicate_description';
  limit?: number;
  offset?: number;
}

/** Pages sharing the same <title> or meta description (free). */
export async function fetchOnPageDuplicateTags(
  transport: DataforseoTransport,
  input: OnPageDuplicateTagsRequest,
): Promise<DataforseoApiResponse<OnPageListPage<OnPageDuplicateTagItem>>> {
  const response = await transport.post(DUPLICATE_TAGS_PATH, [
    {
      id: input.taskId,
      type: input.type,
      limit: clampLimit(input.limit, 100),
      offset: input.offset ?? 0,
    },
  ]);
  const task = assertOk(response, { path: DUPLICATE_TAGS_PATH });
  return {
    data: {
      items: parseTaskItems('on-page-duplicate-tags', task, onPageDuplicateTagItemSchema),
      totalCount: parseTaskTotalCount(task),
      crawlProgress: readCrawlProgress(task),
    },
    billing: buildFreeTaskBilling(task, DUPLICATE_TAGS_PATH),
  };
}

// ---------------------------------------------------------------------------
// links
// ---------------------------------------------------------------------------

export const onPageLinkItemSchema = z
  .object({
    type: z.string().nullable().optional(),
    domain_from: z.string().nullable().optional(),
    domain_to: z.string().nullable().optional(),
    page_from: z.string().nullable().optional(),
    page_to: z.string().nullable().optional(),
    link_from: z.string().nullable().optional(),
    link_to: z.string().nullable().optional(),
    dofollow: z.boolean().nullable().optional(),
    page_from_scheme: z.string().nullable().optional(),
    page_to_scheme: z.string().nullable().optional(),
    direction: z.enum(['internal', 'external']).or(z.string()).nullable().optional(),
    is_broken: z.boolean().nullable().optional(),
    is_link_relation_conflict: z.boolean().nullable().optional(),
    is_redirect: z.boolean().nullable().optional(),
    link_attribute: z.array(z.string()).nullable().optional(),
    text: z.string().nullable().optional(),
    text_pre: z.string().nullable().optional(),
    text_post: z.string().nullable().optional(),
  })
  .passthrough();

export type OnPageLinkItem = z.infer<typeof onPageLinkItemSchema>;

export interface OnPageLinksRequest {
  taskId: string;
  /** Restrict to links found on this page. */
  pageFrom?: string;
  /** Restrict to links pointing at this page. */
  pageTo?: string;
  limit?: number;
  offset?: number;
  /** e.g. [["is_broken", "=", true]] or [["direction", "=", "external"]]. */
  filters?: unknown[];
}

/** Internal and external links discovered by the crawl (free). */
export async function fetchOnPageLinks(
  transport: DataforseoTransport,
  input: OnPageLinksRequest,
): Promise<DataforseoApiResponse<OnPageListPage<OnPageLinkItem>>> {
  const response = await transport.post(LINKS_PATH, [
    {
      id: input.taskId,
      ...(input.pageFrom ? { page_from: input.pageFrom } : {}),
      ...(input.pageTo ? { page_to: input.pageTo } : {}),
      limit: clampLimit(input.limit, 100),
      offset: input.offset ?? 0,
      ...(input.filters && input.filters.length > 0 ? { filters: input.filters } : {}),
    },
  ]);
  const task = assertOk(response, { path: LINKS_PATH });
  return {
    data: {
      items: parseTaskItems('on-page-links', task, onPageLinkItemSchema),
      totalCount: parseTaskTotalCount(task),
      crawlProgress: readCrawlProgress(task),
    },
    billing: buildFreeTaskBilling(task, LINKS_PATH),
  };
}

// ---------------------------------------------------------------------------
// non_indexable
// ---------------------------------------------------------------------------

export const onPageNonIndexableItemSchema = z
  .object({
    url: z.string(),
    /** e.g. "meta_tag", "robots", "canonical", "http_header", "http_status_code". */
    reason: z.string().nullable().optional(),
    status_code: z.number().nullable().optional(),
    resource_type: z.string().nullable().optional(),
    meta: z.record(z.string(), z.unknown()).nullable().optional(),
    checks: z.record(z.string(), z.boolean().nullable()).nullable().optional(),
  })
  .passthrough();

export type OnPageNonIndexableItem = z.infer<typeof onPageNonIndexableItemSchema>;

export interface OnPageNonIndexableRequest {
  taskId: string;
  limit?: number;
  offset?: number;
  filters?: unknown[];
}

/** Pages search engines cannot index, with the blocking reason (free). */
export async function fetchOnPageNonIndexable(
  transport: DataforseoTransport,
  input: OnPageNonIndexableRequest,
): Promise<DataforseoApiResponse<OnPageListPage<OnPageNonIndexableItem>>> {
  const response = await transport.post(NON_INDEXABLE_PATH, [
    {
      id: input.taskId,
      limit: clampLimit(input.limit, 100),
      offset: input.offset ?? 0,
      ...(input.filters && input.filters.length > 0 ? { filters: input.filters } : {}),
    },
  ]);
  const task = assertOk(response, { path: NON_INDEXABLE_PATH });
  return {
    data: {
      items: parseTaskItems('on-page-non-indexable', task, onPageNonIndexableItemSchema),
      totalCount: parseTaskTotalCount(task),
      crawlProgress: readCrawlProgress(task),
    },
    billing: buildFreeTaskBilling(task, NON_INDEXABLE_PATH),
  };
}
