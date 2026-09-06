import {
  computeNextRunAt,
  db,
  flushSpendToPostgres,
  hasDefaultDfsKey,
  isDfsSpendCapReached,
  refreshDfsBalance,
} from '@openpanel/db';
import { seoQueue } from '@openpanel/queue';
import { logger } from '../utils/logger';

/**
 * The four SEO cron jobs (SEO.md §6). The schedulers own the cadence: they
 * find configs whose next-run pointer is due, advance it, and enqueue the
 * real work on the `seo` queue. Advancing the pointer with a conditional
 * updateMany is the concurrency guard — two overlapping ticks cannot both
 * claim the same project, because only one update matches `lte: now`.
 */

const SPEND_CAP_ERROR = 'spend cap reached';

interface DueRankConfig {
  projectId: string;
  rankSchedule: string;
  project: { organizationId: string };
}

interface DueBacklinkConfig {
  projectId: string;
  backlinkSchedule: string;
  domain: string;
  project: { organizationId: string };
}

async function claimRankConfig(
  config: DueRankConfig,
  now: Date
): Promise<boolean> {
  const claimed = await db.seoProjectConfig.updateMany({
    where: {
      projectId: config.projectId,
      rankNextRunAt: { lte: now },
      rankSchedule: { not: 'manual' },
    },
    data: { rankNextRunAt: computeNextRunAt(config.rankSchedule, now) },
  });
  return claimed.count > 0;
}

export async function seoRankSchedulerJob() {
  const now = new Date();

  // Flush first so the cap check below sees spend from the last 15 minutes.
  try {
    await flushSpendToPostgres();
  } catch (error) {
    logger.error({ err: error }, 'seoRankScheduler: spend flush failed');
  }

  const due: DueRankConfig[] = await db.seoProjectConfig.findMany({
    where: { rankSchedule: { not: 'manual' }, rankNextRunAt: { lte: now } },
    select: {
      projectId: true,
      rankSchedule: true,
      project: { select: { organizationId: true } },
    },
  });

  let enqueued = 0;
  let skipped = 0;
  for (const config of due) {
    if (!(await claimRankConfig(config, now))) {
      continue;
    }
    const { projectId } = config;

    const keywordsTotal = await db.seoTrackedKeyword.count({
      where: { projectId, isActive: true },
    });
    if (keywordsTotal === 0) {
      skipped += 1;
      logger.debug({ projectId }, 'seoRankScheduler: no active keywords');
      continue;
    }

    if (await isDfsSpendCapReached(config.project.organizationId)) {
      // A failed run is the visible record; a silently skipped one would
      // look like the scheduler stopped.
      await db.seoRankRun.create({
        data: {
          projectId,
          status: 'failed',
          keywordsTotal,
          error: SPEND_CAP_ERROR,
          completedAt: now,
        },
      });
      skipped += 1;
      logger.warn({ projectId }, 'seoRankScheduler: spend cap reached');
      continue;
    }

    const run = await db.seoRankRun.create({
      data: { projectId, status: 'pending', keywordsTotal },
      select: { id: true },
    });
    await seoQueue.add(
      'seoRankRun',
      { type: 'seoRankRun', payload: { projectId, runId: run.id } },
      { jobId: `seoRankRun:${run.id}` }
    );
    enqueued += 1;
  }

  logger.info(
    { due: due.length, enqueued, skipped },
    'seoRankScheduler: done'
  );
  return { due: due.length, enqueued, skipped };
}

async function claimBacklinkConfig(
  config: DueBacklinkConfig,
  now: Date
): Promise<boolean> {
  const claimed = await db.seoProjectConfig.updateMany({
    where: {
      projectId: config.projectId,
      backlinkNextRunAt: { lte: now },
      backlinkSchedule: { not: 'manual' },
    },
    data: {
      backlinkNextRunAt: computeNextRunAt(config.backlinkSchedule, now),
    },
  });
  return claimed.count > 0;
}

export async function seoBacklinkSchedulerJob() {
  const now = new Date();
  const due: DueBacklinkConfig[] = await db.seoProjectConfig.findMany({
    where: {
      backlinkSchedule: { not: 'manual' },
      backlinkNextRunAt: { lte: now },
    },
    select: {
      projectId: true,
      backlinkSchedule: true,
      domain: true,
      project: { select: { organizationId: true } },
    },
  });

  let enqueued = 0;
  let skipped = 0;
  for (const config of due) {
    if (!(await claimBacklinkConfig(config, now))) {
      continue;
    }
    const { projectId } = config;
    if (!config.domain) {
      skipped += 1;
      logger.debug({ projectId }, 'seoBacklinkScheduler: no domain');
      continue;
    }
    if (await isDfsSpendCapReached(config.project.organizationId)) {
      skipped += 1;
      logger.warn({ projectId }, 'seoBacklinkScheduler: spend cap reached');
      continue;
    }
    await seoQueue.add(
      'seoBacklinkSnapshot',
      { type: 'seoBacklinkSnapshot', payload: { projectId } },
      { jobId: `seoBacklinkSnapshot:${projectId}:${now.toISOString().slice(0, 10)}` }
    );
    enqueued += 1;
  }

  logger.info(
    { due: due.length, enqueued, skipped },
    'seoBacklinkScheduler: done'
  );
  return { due: due.length, enqueued, skipped };
}

/** First of the month: fold in what Redis still holds, then start over. */
export async function seoSpendResetJob() {
  const flushed = await flushSpendToPostgres();
  const reset = await db.dataForSeoConnection.updateMany({
    where: {},
    data: { monthlySpendUsd: 0 },
  });
  logger.info(
    { flushedOrganizations: flushed.flushed, reset: reset.count },
    'seoSpendReset: done'
  );
  return { reset: reset.count };
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** `2026-W36`: the ISO 8601 week the date falls in, Monday-based. */
export function isoWeekKey(date: Date): string {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // ISO weeks belong to the year of their Thursday.
  const weekday = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(utc.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((utc.getTime() - yearStart) / MS_PER_DAY + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Weekly: refresh volume/difficulty/cpc for every active tracked keyword.
 * One seoKeywordMetrics job per project (the job batches at 700), with a
 * jobId per project and ISO week so a re-run of the cron in the same week
 * enqueues nothing new. Projects whose org has no DataForSEO key, or whose
 * cap is reached, are skipped; the tracked keywords keep last week's numbers.
 */
export async function seoMetricsRefreshJob(now: Date = new Date()) {
  const week = isoWeekKey(now);
  const grouped = await db.seoTrackedKeyword.groupBy({
    by: ['projectId'],
    where: { isActive: true },
    _count: { _all: true },
  });

  let enqueued = 0;
  let skipped = 0;
  for (const group of grouped) {
    const { projectId } = group;
    const project = await db.project.findUnique({
      where: { id: projectId },
      select: {
        organizationId: true,
        organization: { select: { dataForSeoConnection: { select: { id: true } } } },
      },
    });
    if (!project) {
      skipped += 1;
      continue;
    }
    const hasKey = project.organization.dataForSeoConnection !== null || hasDefaultDfsKey();
    if (!hasKey) {
      skipped += 1;
      logger.debug({ projectId }, 'seoMetricsRefresh: no DataForSEO key');
      continue;
    }
    if (await isDfsSpendCapReached(project.organizationId)) {
      skipped += 1;
      logger.warn({ projectId }, 'seoMetricsRefresh: spend cap reached');
      continue;
    }

    const keywords = await db.seoTrackedKeyword.findMany({
      where: { projectId, isActive: true },
      select: { keyword: true },
      orderBy: { keyword: 'asc' },
    });
    if (keywords.length === 0) {
      skipped += 1;
      continue;
    }
    await seoQueue.add(
      'seoKeywordMetrics',
      {
        type: 'seoKeywordMetrics',
        payload: { projectId, keywords: keywords.map((row) => row.keyword) },
      },
      { jobId: `seoKeywordMetrics:${projectId}:${week}` }
    );
    enqueued += 1;
  }

  logger.info(
    { projects: grouped.length, enqueued, skipped, week },
    'seoMetricsRefresh: done'
  );
  return { projects: grouped.length, enqueued, skipped, week };
}

/** Daily: appendix/user_data per org → balanceUsd. A bad key is logged and recorded on the row, never fatal for the others. */
export async function seoBalanceRefreshJob() {
  const connections = await db.dataForSeoConnection.findMany({
    select: { organizationId: true },
  });

  let refreshed = 0;
  let failed = 0;
  for (const { organizationId } of connections) {
    try {
      await refreshDfsBalance(organizationId);
      refreshed += 1;
    } catch (error) {
      failed += 1;
      logger.warn(
        { err: error, organizationId },
        'seoBalanceRefresh: refresh failed'
      );
    }
  }

  logger.info({ refreshed, failed }, 'seoBalanceRefresh: done');
  return { refreshed, failed };
}
