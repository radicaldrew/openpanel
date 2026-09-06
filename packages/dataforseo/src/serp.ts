import { z } from 'zod';
import type { DataforseoTransport } from './core';
import {
  assertOk,
  buildFreeTaskBilling,
  buildTaskBilling,
  type DataforseoApiResponse,
  type DataforseoItemsTask,
  type DataforseoTaskLike,
  isNoResultsTask,
  isTaskInProgress,
  parseTaskItems,
} from './envelope';
import { DataForSeoError } from './errors';
import { MAX_TASKS_PER_POST } from './shared';

// Default depth for keyword SERP analysis. DataForSEO crawls (and bills) one
// Google page of 10 results at a time, and the crawls are sequential, so depth
// is the single lever on both latency and cost here: every 10 results is
// another page fetch against the shared 60s request budget. Keep this low —
// callers that need to see deeper ranks pass an explicit depth. There is no
// offset/cursor: a deeper request re-crawls pages 1..N/10 from the top, so it
// replaces the shallow snapshot rather than extending it.
export const SERP_ANALYSIS_DEPTH = 20;

const LIVE_ADVANCED_PATH = '/v3/serp/google/organic/live/advanced';
const TASK_POST_PATH = '/v3/serp/google/organic/task_post';
const TASKS_READY_PATH = '/v3/serp/google/organic/tasks_ready';

/** DataForSEO bills SERPs in pages of 10; depth outside 10-100 is rejected. */
function clampSerpDepth(depth: number): number {
  return Math.min(100, Math.max(10, depth));
}

/**
 * Stop crawling SERP pages once the target domain is found — DataForSEO only
 * bills the pages crawled, so a page-1 ranking at depth 20 costs one page
 * instead of two. Matching is restricted to organic results and uses
 * with_subdomains, mirroring buildRankCheckResult exactly: without
 * find_targets_in, a sitelink or PAA mention could stop the crawl before the
 * domain's organic listing and record a false "not ranking".
 */
function stopCrawlOnTarget(targetDomain: string) {
  return {
    stop_crawl_on_match: [{ match_value: targetDomain, match_type: 'with_subdomains' }],
    find_targets_in: ['organic'],
  };
}

const serpSnapshotItemSchema = z
  .object({
    type: z.string(),
    rank_group: z.number().nullable().optional(),
    rank_absolute: z.number().nullable().optional(),
    domain: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    breadcrumb: z.string().nullable().optional(),
    etv: z.number().nullable().optional(),
    estimated_paid_traffic_cost: z.number().nullable().optional(),
    backlinks_info: z
      .object({
        referring_domains: z.number().nullable().optional(),
        backlinks: z.number().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    rank_changes: z
      .object({
        previous_rank_absolute: z.number().nullable().optional(),
        is_new: z.boolean().nullable().optional(),
        is_up: z.boolean().nullable().optional(),
        is_down: z.boolean().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export type SerpLiveItem = z.infer<typeof serpSnapshotItemSchema>;

export async function fetchLiveSerp(
  transport: DataforseoTransport,
  input: {
    keyword: string;
    locationCode: number;
    languageCode: string;
    depth?: number;
  },
): Promise<DataforseoApiResponse<SerpLiveItem[]>> {
  const response = await transport.post(LIVE_ADVANCED_PATH, [
    {
      keyword: input.keyword,
      location_code: input.locationCode,
      language_code: input.languageCode,
      device: 'desktop',
      os: 'windows',
      depth: clampSerpDepth(input.depth ?? SERP_ANALYSIS_DEPTH),
    },
  ]);
  // DataForSEO uses a task error for a valid empty SERP. Keep the charged
  // response in the normal billing path and return an empty item list.
  const task = assertOk(response, {
    path: LIVE_ADVANCED_PATH,
    treatNoResultsAsEmpty: true,
  });
  return {
    data: parseTaskItems('google-organic-live-advanced', task, serpSnapshotItemSchema),
    billing: buildTaskBilling(task),
  };
}

export interface RankCheckTopResult {
  /** Organic position (rank_group). */
  position: number;
  domain: string;
  url: string | null;
}

export interface RankCheckResult {
  keywordId: string;
  keyword: string;
  position: number | null;
  url: string | null;
  serpFeatures: string[];
  /** Top organic results (first RANK_CHECK_TOP_RESULTS), for competitor overlays. */
  topResults: RankCheckTopResult[];
}

/** How many organic results a rank check keeps for competitor overlays. */
export const RANK_CHECK_TOP_RESULTS = 10;

function buildTopResults(items: SerpLiveItem[]): RankCheckTopResult[] {
  const top: RankCheckTopResult[] = [];
  for (const item of items) {
    if (item.type !== 'organic' || !item.domain) {
      continue;
    }
    const position = item.rank_group ?? item.rank_absolute;
    if (position == null) {
      continue;
    }
    top.push({ position, domain: item.domain.toLowerCase(), url: item.url ?? null });
    if (top.length >= RANK_CHECK_TOP_RESULTS) {
      break;
    }
  }
  return top;
}

function buildRankCheckResult(
  input: { keywordId: string; keyword: string; targetDomain: string },
  items: SerpLiveItem[],
): RankCheckResult {
  const target = input.targetDomain.toLowerCase();
  const organicMatch = items.find((item) => {
    if (item.type !== 'organic' || item.domain == null) {
      return false;
    }
    const domain = item.domain.toLowerCase();
    return domain === target || domain.endsWith(`.${target}`);
  });

  return {
    keywordId: input.keywordId,
    keyword: input.keyword,
    // rank_group = position among organic results only (what users count as
    // "my ranking"). rank_absolute would also count SERP features (local
    // pack, PAA, AI overviews) and reads as worse than what users see.
    position: organicMatch
      ? (organicMatch.rank_group ?? organicMatch.rank_absolute ?? null)
      : null,
    url: organicMatch?.url ?? null,
    serpFeatures: [...new Set(items.map((item) => item.type).filter(Boolean))],
    topResults: buildTopResults(items),
  };
}

export async function fetchRankCheckSerp(
  transport: DataforseoTransport,
  input: {
    keyword: string;
    keywordId: string;
    locationCode: number;
    languageCode: string;
    locationName?: string;
    device: 'desktop' | 'mobile';
    targetDomain: string;
    depth: number;
  },
): Promise<DataforseoApiResponse<RankCheckResult>> {
  const depth = clampSerpDepth(input.depth);
  const locationParams = input.locationName
    ? { location_name: input.locationName }
    : { location_code: input.locationCode };
  const response = await transport.post(LIVE_ADVANCED_PATH, [
    {
      keyword: input.keyword,
      ...locationParams,
      language_code: input.languageCode,
      device: input.device,
      os: input.device === 'desktop' ? 'windows' : 'android',
      depth,
      ...stopCrawlOnTarget(input.targetDomain),
    },
  ]);

  // "No Search Results" is valid for obscure/new keywords — treat as an empty
  // result set rather than failing the whole rank-tracking run.
  const task = assertOk(response, {
    path: LIVE_ADVANCED_PATH,
    treatNoResultsAsEmpty: true,
  });
  const items = parseTaskItems(
    'google-organic-live-advanced',
    task,
    serpSnapshotItemSchema,
  );

  return {
    data: buildRankCheckResult(input, items),
    billing: buildTaskBilling(task),
  };
}

// ---------------------------------------------------------------------------
// Task-queue rank checks (scheduled runs). DataForSEO's standard queue costs
// ~30% of the live endpoint; tasks complete in ~5 minutes on average. The flow
// is task_post (charged) -> poll tasks_ready / task_get (free) -> live
// fallback for stragglers, orchestrated by the caller's job.
// ---------------------------------------------------------------------------

export interface RankCheckTaskInput {
  keyword: string;
  keywordId: string;
  device: 'desktop' | 'mobile';
}

export interface PostedRankCheckTask extends RankCheckTaskInput {
  taskId: string;
}

export async function postRankCheckTasks(
  transport: DataforseoTransport,
  input: {
    tasks: RankCheckTaskInput[];
    locationCode: number;
    languageCode: string;
    locationName?: string;
    depth: number;
    targetDomain: string;
    /** 1 = normal (default), 2 = high priority (2x cost). */
    priority?: 1 | 2;
    /** Optional postback URL; omit to poll tasks_ready instead. */
    postbackUrl?: string;
  },
): Promise<DataforseoApiResponse<PostedRankCheckTask[]>> {
  if (input.tasks.length === 0 || input.tasks.length > MAX_TASKS_PER_POST) {
    throw new DataForSeoError(
      `task_post accepts 1-${MAX_TASKS_PER_POST} tasks, got ${input.tasks.length}`,
      { kind: 'validation', path: TASK_POST_PATH },
    );
  }
  const depth = clampSerpDepth(input.depth);
  const locationParams = input.locationName
    ? { location_name: input.locationName }
    : { location_code: input.locationCode };
  // Billed, non-idempotent: never replay on a 5xx.
  const response = await transport.post<
    DataforseoTaskLike & { data?: Record<string, unknown> }
  >(
    TASK_POST_PATH,
    input.tasks.map((task) => ({
      keyword: task.keyword,
      ...locationParams,
      language_code: input.languageCode,
      device: task.device,
      os: task.device === 'desktop' ? 'windows' : 'android',
      depth,
      // Queued tasks are billed provisionally at full depth at post time;
      // task_get later reports the reduced actual cost when the crawl
      // stopped early.
      ...stopCrawlOnTarget(input.targetDomain),
      ...(input.priority ? { priority: input.priority } : {}),
      ...(input.postbackUrl
        ? { postback_url: input.postbackUrl, postback_data: 'advanced' }
        : {}),
      // Echoed back on the response entry and task_get; used to map a
      // DataForSEO task id back to our keyword without relying on order.
      tag: `${task.keywordId}:${task.device}`,
    })),
    { maxServerErrorRetries: 0 },
  );

  if (!response || response.status_code !== 20_000) {
    throw new DataForSeoError(
      response?.status_message || 'DataForSEO task_post failed',
      { kind: 'task', path: TASK_POST_PATH, dfsStatusCode: response?.status_code },
    );
  }

  // One response entry per submitted task; accepted entries have status 20100
  // "Task Created" and their own cost (charged at post time). Cost is summed
  // over every entry — accepted or not — so anything DataForSEO charged is
  // reported. Rejected entries get no posted task; the caller falls back to
  // the live endpoint for any keyword/device pair missing from the result.
  const byTag = new Map(
    input.tasks.map((task) => [`${task.keywordId}:${task.device}`, task]),
  );
  const posted: PostedRankCheckTask[] = [];
  let costUsd = 0;
  for (const entry of response.tasks ?? []) {
    costUsd += entry.cost ?? 0;
    const tag: unknown = entry.data?.tag;
    const task = typeof tag === 'string' ? byTag.get(tag) : undefined;
    if (entry.status_code !== 20_100 || !entry.id || !task) {
      continue;
    }
    posted.push({ ...task, taskId: entry.id });
  }

  return {
    data: posted,
    billing: {
      path: ['v3', 'serp', 'google', 'organic', 'task_post'],
      costUsd,
    },
  };
}

export type RankCheckTaskOutcome =
  | { status: 'pending' }
  | { status: 'failed'; message: string }
  | { status: 'completed'; result: RankCheckResult };

/**
 * Collect one queued task's result. Collection is free (the task was charged
 * at task_post); the task_get response carries the task's settled cost
 * (reduced when stop_crawl_on_match ended the crawl early), which is what the
 * returned billing reports — do not add it to the post-time charge.
 */
export async function fetchRankCheckTaskResult(
  transport: DataforseoTransport,
  input: {
    taskId: string;
    keywordId: string;
    keyword: string;
    targetDomain: string;
  },
): Promise<DataforseoApiResponse<RankCheckTaskOutcome>> {
  const path = `/v3/serp/google/organic/task_get/advanced/${encodeURIComponent(input.taskId)}`;
  const response = await transport.get(path);
  const task = response?.tasks?.[0];
  if (!response || response.status_code !== 20_000 || !task) {
    throw new DataForSeoError(
      response?.status_message || 'DataForSEO task_get failed',
      { kind: 'task', path, dfsStatusCode: response?.status_code },
    );
  }
  const billing = buildFreeTaskBilling(task, path);

  if (isTaskInProgress(task)) {
    return { data: { status: 'pending' }, billing };
  }

  if (task.status_code !== 20_000) {
    // "No Search Results" is valid for obscure/new keywords — same treatment
    // as the live path's treatNoResultsAsEmpty.
    if (!isNoResultsTask(task)) {
      return {
        data: {
          status: 'failed',
          message:
            task.status_message || `DataForSEO task failed (${task.status_code})`,
        },
        billing,
      };
    }
    return {
      data: { status: 'completed', result: buildRankCheckResult(input, []) },
      billing,
    };
  }

  const items = parseTaskItems(
    'google-organic-task-get-advanced',
    task,
    serpSnapshotItemSchema,
  );
  return {
    data: { status: 'completed', result: buildRankCheckResult(input, items) },
    billing,
  };
}

export interface SerpTaskReadyItem {
  id: string;
  se?: string | null;
  se_type?: string | null;
  date_posted?: string | null;
  tag?: string | null;
  endpoint_advanced?: string | null;
  endpoint_regular?: string | null;
  endpoint_html?: string | null;
  [key: string]: unknown;
}

const tasksReadyItemSchema = z
  .object({
    id: z.string(),
    se: z.string().nullable().optional(),
    se_type: z.string().nullable().optional(),
    date_posted: z.string().nullable().optional(),
    tag: z.string().nullable().optional(),
    endpoint_advanced: z.string().nullable().optional(),
    endpoint_regular: z.string().nullable().optional(),
    endpoint_html: z.string().nullable().optional(),
  })
  .passthrough();

/**
 * Lists queued organic tasks whose results are ready to collect (free). Only
 * tasks posted without a postback/pingback URL show up here, and each task is
 * listed until it is collected via task_get.
 */
export async function fetchSerpTasksReady(
  transport: DataforseoTransport,
): Promise<DataforseoApiResponse<SerpTaskReadyItem[]>> {
  const response = await transport.get<DataforseoTaskLike & { result?: unknown[] }>(
    TASKS_READY_PATH,
  );
  const task = assertOk(response, { path: TASKS_READY_PATH });
  const parsed = z.array(tasksReadyItemSchema).safeParse(task.result ?? []);
  if (!parsed.success) {
    throw new DataForSeoError(
      'DataForSEO tasks_ready returned an invalid response shape',
      { kind: 'invalid_response', path: TASKS_READY_PATH },
    );
  }
  return {
    data: parsed.data,
    billing: buildFreeTaskBilling(task, TASKS_READY_PATH),
  };
}

export async function fetchLocalSerp(
  transport: DataforseoTransport,
  input: {
    keyword: string;
    locationCoordinate?: string;
    languageCode: string;
    searchType: 'maps' | 'local_finder';
    device: 'desktop' | 'mobile';
    depth: number;
    searchPlaces?: boolean;
  },
): Promise<DataforseoApiResponse<Record<string, unknown>[]>> {
  const os = input.device === 'desktop' ? 'windows' : 'android';

  if (input.searchType === 'maps') {
    const path = '/v3/serp/google/maps/live/advanced';
    const response = await transport.post<DataforseoItemsTask<Record<string, unknown>>>(
      path,
      [
        {
          keyword: input.keyword,
          location_coordinate: input.locationCoordinate,
          language_code: input.languageCode,
          device: input.device,
          os,
          depth: input.depth,
          search_places: input.searchPlaces,
        },
      ],
    );
    // A billed empty SERP is returned for some coordinate-only Maps and Local
    // Finder queries (both paths opt in).
    const task = assertOk(response, { path, treatNoResultsAsEmpty: true });
    return {
      data: task.result?.[0]?.items ?? [],
      billing: buildTaskBilling(task),
    };
  }

  const path = '/v3/serp/google/local_finder/live/advanced';
  const response = await transport.post<DataforseoItemsTask<Record<string, unknown>>>(
    path,
    [
      {
        keyword: input.keyword,
        location_coordinate: input.locationCoordinate,
        language_code: input.languageCode,
        device: input.device,
        os,
        depth: input.depth,
      },
    ],
  );
  const task = assertOk(response, { path, treatNoResultsAsEmpty: true });
  return {
    data: task.result?.[0]?.items ?? [],
    billing: buildTaskBilling(task),
  };
}
