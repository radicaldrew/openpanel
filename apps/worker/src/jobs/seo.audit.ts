import {
  type DataforseoTransport,
  fetchOnPagePages,
  fetchOnPageSummary,
  postOnPageTask,
} from '@openpanel/dataforseo';
import {
  completeAudit,
  failAudit,
  getAudit,
  getDfsClientForProject,
  getProjectOrganizationId,
  getSeoProjectConfig,
  insertAuditPages,
  isDfsSpendCapReached,
  markAuditCrawling,
  readAuditSummary,
  SPEND_CAP_ERROR,
  toAuditPageRow,
  updateAuditProgress,
} from '@openpanel/db';
import {
  type SeoQueuePayloadAuditPoll,
  type SeoQueuePayloadAuditStart,
  seoQueue,
} from '@openpanel/queue';
import type { Job } from 'bullmq';
import { logger } from '../utils/logger';

/**
 * Site audits via DataForSEO On-Page (SEO.md §6, seo.audit.ts).
 *
 * Start posts one on_page task and hands over to a poll job. The poll reads
 * summary/{id} until the crawl is finished, then pages through pages/{id}
 * into seo_audit_pages and marks the audit completed. There is no DFS
 * cancel: a cancelled audit is a `failed` row, and the poll stops the
 * moment it sees the status is no longer `crawling`.
 *
 * DFS bills task_post at post time (max_crawl_pages × per-page price);
 * summary and pages are free. The task cost is summed into
 * SeoAudit.costUsd here, the per-org monthly spend through onCost.
 */

export const AUDIT_DEADLINE_MS = 3 * 60 * 60 * 1000;
export const FIRST_POLL_DELAY_SECONDS = 30;
export const PAGES_BATCH_SIZE = 1000;
/**
 * Hard ceiling on items paged from on_page/pages. The list includes resources
 * (images, scripts) on top of the crawled pages, so it can legitimately exceed
 * maxPages; this only stops a broken total_count from paging forever.
 */
export const MAX_IMPORT_ITEMS = 100_000;
const POLL_MAX_DELAY_SECONDS = 5 * 60;
const MINUTE_MS = 60 * 1000;

/**
 * Backoff keyed on how long the crawl has been running, so the schedule
 * survives a poll job being retried or re-enqueued out of order:
 * 30 s for the first two minutes, then 60 s, 120 s and finally 300 s.
 */
export function auditPollDelaySeconds(elapsedMs: number): number {
  if (elapsedMs < 2 * MINUTE_MS) {
    return FIRST_POLL_DELAY_SECONDS;
  }
  if (elapsedMs < 10 * MINUTE_MS) {
    return 60;
  }
  if (elapsedMs < 30 * MINUTE_MS) {
    return 120;
  }
  return POLL_MAX_DELAY_SECONDS;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function enqueuePoll(
  projectId: string,
  auditId: string,
  delaySeconds: number
): Promise<void> {
  await seoQueue.add(
    'seoAuditPoll',
    { type: 'seoAuditPoll', payload: { projectId, auditId } },
    {
      delay: delaySeconds * 1000,
      // One poll in flight per audit: the delay is part of the id so the
      // next poll can be scheduled while the previous one is still stored.
      jobId: `seoAuditPoll:${auditId}:${Date.now()}`,
    }
  );
}

export async function seoAuditStartJob(job: Job<SeoQueuePayloadAuditStart>) {
  const { projectId, auditId } = job.data.payload;
  const log = logger.child({ projectId, auditId });

  const audit = await getAudit(auditId);
  if (!audit) {
    log.warn('seoAuditStart: audit not found');
    return;
  }
  if (audit.status !== 'queued') {
    log.info({ status: audit.status }, 'seoAuditStart: audit already started, skipping');
    return;
  }

  const config = await getSeoProjectConfig(projectId);
  if (!config?.domain) {
    await failAudit(auditId, 'SEO project config is missing a domain');
    return;
  }

  const organizationId = await getProjectOrganizationId(projectId);
  if (await isDfsSpendCapReached(organizationId)) {
    await failAudit(auditId, SPEND_CAP_ERROR);
    log.warn('seoAuditStart: spend cap reached');
    return;
  }

  const { options } = readAuditSummary(audit);

  try {
    const client = await getDfsClientForProject(projectId);
    const { data, billing } = await postOnPageTask(client.transport, {
      target: config.domain,
      maxCrawlPages: audit.maxPages,
      enableJavascript: options.enableJavascript,
      loadResources: false,
      tag: auditId,
    });
    await markAuditCrawling(auditId, {
      dfsTaskId: data.taskId,
      costUsd: billing.costUsd,
    });
    log.info(
      { taskId: data.taskId, maxPages: audit.maxPages, costUsd: billing.costUsd },
      'seoAuditStart: crawl posted'
    );
    await enqueuePoll(projectId, auditId, FIRST_POLL_DELAY_SECONDS);
  } catch (error) {
    await failAudit(auditId, errorMessage(error));
    throw error;
  }
}

/**
 * Pull every crawled page into seo_audit_pages, 1000 per call. Stops when a
 * page comes back short or the reported total is reached.
 */
export async function importAuditPages(
  transport: DataforseoTransport,
  { projectId, auditId, taskId }: { projectId: string; auditId: string; taskId: string }
): Promise<number> {
  let offset = 0;
  let imported = 0;
  while (offset < MAX_IMPORT_ITEMS) {
    const { data } = await fetchOnPagePages(transport, {
      taskId,
      limit: PAGES_BATCH_SIZE,
      offset,
    });
    const rows = data.items
      .filter((item) => item.is_resource !== true)
      .map((item) => toAuditPageRow(projectId, auditId, item));
    await insertAuditPages(rows);
    imported += rows.length;
    offset += data.items.length;
    const reachedTotal = data.totalCount !== null && offset >= data.totalCount;
    if (data.items.length < PAGES_BATCH_SIZE || reachedTotal) {
      return imported;
    }
  }
  return imported;
}

export async function seoAuditPollJob(job: Job<SeoQueuePayloadAuditPoll>) {
  const { projectId, auditId } = job.data.payload;
  const log = logger.child({ projectId, auditId });

  const audit = await getAudit(auditId);
  if (!audit || audit.status !== 'crawling' || !audit.dfsTaskId) {
    log.info({ status: audit?.status ?? 'missing' }, 'seoAuditPoll: nothing to do');
    return;
  }

  const elapsedMs = Date.now() - audit.startedAt.getTime();
  if (elapsedMs > AUDIT_DEADLINE_MS) {
    await failAudit(
      auditId,
      `Timed out after 3h with ${audit.pagesCrawled} page(s) crawled`
    );
    log.warn('seoAuditPoll: deadline reached');
    return;
  }

  try {
    const client = await getDfsClientForProject(projectId);
    const { data: summary } = await fetchOnPageSummary(client.transport, audit.dfsTaskId);
    const pagesCrawled = summary.crawl_status?.pages_crawled ?? audit.pagesCrawled;

    if (summary.crawl_progress !== 'finished') {
      await updateAuditProgress(auditId, { pagesCrawled });
      const delay = auditPollDelaySeconds(elapsedMs);
      log.info({ pagesCrawled, delay }, 'seoAuditPoll: still crawling');
      await enqueuePoll(projectId, auditId, delay);
      return;
    }

    const imported = await importAuditPages(client.transport, {
      projectId,
      auditId,
      taskId: audit.dfsTaskId,
    });
    const rawScore = summary.page_metrics?.onpage_score;
    await completeAudit(auditId, {
      score: rawScore === null || rawScore === undefined ? null : Math.round(rawScore),
      pagesCrawled: Math.max(pagesCrawled, imported),
      dfsSummary: summary,
    });
    log.info({ imported, score: rawScore }, 'seoAuditPoll: audit completed');
  } catch (error) {
    await failAudit(auditId, errorMessage(error));
    throw error;
  }
}
