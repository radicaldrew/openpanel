import {
  type DataforseoTransport,
  fetchRankCheckSerp,
  fetchRankCheckTaskResult,
  fetchSerpTasksReady,
  MAX_TASKS_PER_POST,
  postRankCheckTasks,
  type RankCheckResult,
} from '@openpanel/dataforseo';
import {
  addRankRunProgress,
  completeRankRun,
  db,
  failRankRun,
  getDfsClientForProject,
  getProjectOrganizationId,
  getRankRun,
  getSeoProjectConfig,
  insertRankSnapshots,
  isDfsSpendCapReached,
  markRankRunRunning,
  type RankSnapshotInput,
  type SeoDevice,
  SPEND_CAP_ERROR,
} from '@openpanel/db';
import {
  type SeoQueuePayloadRankRun,
  type SeoQueuePayloadRankTaskPoll,
  seoQueue,
} from '@openpanel/queue';
import type { Job } from 'bullmq';
import { logger } from '../utils/logger';

/**
 * Rank tracking (SEO.md §6, seo.rank.ts).
 *
 * Two paths. Small manual runs (≤ 10 keywords) call live/advanced and are
 * done when the job returns. Everything else posts standard-priority tasks
 * (about a third of the live price), then a poll job collects results via
 * tasks_ready → task_get with a growing delay until every task is in or
 * the run is two hours old, at which point it fails with whatever was
 * collected. Cost is summed into SeoRankRun.costUsd here; the per-org
 * monthly spend is handled by the client's onCost hook.
 */

export const LIVE_RUN_MAX_KEYWORDS = 10;
export const RUN_DEADLINE_MS = 2 * 60 * 60 * 1000;
const POLL_BACKOFF_SECONDS = [60, 120, 300] as const;
const POLL_MAX_DELAY_SECONDS = 30 * 60;
const HIGH_PRIORITY = 2;

export function pollDelaySeconds(attempt: number): number {
  const fixed = POLL_BACKOFF_SECONDS[attempt];
  if (fixed !== undefined) {
    return fixed;
  }
  const last = POLL_BACKOFF_SECONDS.at(-1) ?? 300;
  const doublings = attempt - (POLL_BACKOFF_SECONDS.length - 1);
  return Math.min(last * 2 ** doublings, POLL_MAX_DELAY_SECONDS);
}

/** SEO_RANK_TASK_PRIORITY=2 doubles the cost for faster turnaround. */
export function rankTaskPriority(): 1 | 2 {
  return process.env.SEO_RANK_TASK_PRIORITY === String(HIGH_PRIORITY) ? 2 : 1;
}

interface RankCheck {
  keywordId: string;
  keyword: string;
  device: SeoDevice;
}

interface RunContext {
  projectId: string;
  runId: string;
  targetDomain: string;
  locationCode: number;
  languageCode: string;
  depth: number;
}

export function toSnapshot(
  ctx: RunContext,
  check: RankCheck,
  result: RankCheckResult,
  checkedAt: Date
): RankSnapshotInput {
  const top = result.topResults ?? [];
  return {
    projectId: ctx.projectId,
    runId: ctx.runId,
    keyword: check.keyword,
    device: check.device,
    checkedAt,
    position: result.position,
    url: result.url,
    serpFeatures: result.serpFeatures,
    competitors: top
      .filter((entry) => entry.position >= 1 && entry.domain)
      .slice(0, 10)
      .map((entry) => ({ domain: entry.domain, position: entry.position })),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function warningFor(failures: string[]): string | null {
  if (failures.length === 0) {
    return null;
  }
  return `${failures.length} check(s) failed: ${failures[0]}`;
}

function devicesFor(setting: string): SeoDevice[] {
  if (setting === 'desktop' || setting === 'mobile') {
    return [setting];
  }
  return ['desktop', 'mobile'];
}

export function buildChecks(
  keywords: { id: string; keyword: string }[],
  devices: SeoDevice[]
): RankCheck[] {
  const checks: RankCheck[] = [];
  for (const keyword of keywords) {
    for (const device of devices) {
      checks.push({ keywordId: keyword.id, keyword: keyword.keyword, device });
    }
  }
  return checks;
}

async function runLive(
  transport: DataforseoTransport,
  ctx: RunContext,
  checks: RankCheck[]
): Promise<void> {
  const snapshots: RankSnapshotInput[] = [];
  const failures: string[] = [];
  let costUsd = 0;

  for (const check of checks) {
    try {
      const { data, billing } = await fetchRankCheckSerp(transport, {
        keyword: check.keyword,
        keywordId: check.keywordId,
        device: check.device,
        locationCode: ctx.locationCode,
        languageCode: ctx.languageCode,
        targetDomain: ctx.targetDomain,
        depth: ctx.depth,
      });
      costUsd += billing.costUsd;
      snapshots.push(toSnapshot(ctx, check, data, new Date()));
    } catch (error) {
      failures.push(`${check.keyword} (${check.device}): ${errorMessage(error)}`);
      logger.warn(
        { err: error, runId: ctx.runId, keyword: check.keyword },
        'seoRankRun: live check failed'
      );
    }
  }

  await insertRankSnapshots(snapshots);
  await addRankRunProgress(ctx.runId, { checked: checks.length, costUsd });
  await completeRankRun(ctx.runId, { warning: warningFor(failures) });
}

async function runQueued(
  transport: DataforseoTransport,
  ctx: RunContext,
  checks: RankCheck[]
): Promise<void> {
  const taskIds: string[] = [];
  let rejected = 0;
  let costUsd = 0;
  const priority = rankTaskPriority();

  for (let i = 0; i < checks.length; i += MAX_TASKS_PER_POST) {
    const batch = checks.slice(i, i + MAX_TASKS_PER_POST);
    const { data: posted, billing } = await postRankCheckTasks(transport, {
      tasks: batch,
      locationCode: ctx.locationCode,
      languageCode: ctx.languageCode,
      depth: ctx.depth,
      targetDomain: ctx.targetDomain,
      priority,
    });
    costUsd += billing.costUsd;
    rejected += batch.length - posted.length;
    for (const task of posted) {
      taskIds.push(task.taskId);
    }
  }

  // Rejected checks count as processed so the run can still finish.
  await addRankRunProgress(ctx.runId, { checked: rejected, costUsd });

  if (taskIds.length === 0) {
    await failRankRun(ctx.runId, 'DataForSEO accepted none of the tasks');
    return;
  }

  logger.info(
    { runId: ctx.runId, posted: taskIds.length, rejected, costUsd },
    'seoRankRun: tasks posted'
  );
  await enqueuePoll(ctx, taskIds, 0);
}

async function enqueuePoll(
  ctx: Pick<RunContext, 'projectId' | 'runId'>,
  taskIds: string[],
  attempt: number
): Promise<void> {
  await seoQueue.add(
    'seoRankTaskPoll',
    {
      type: 'seoRankTaskPoll',
      payload: { projectId: ctx.projectId, runId: ctx.runId, taskIds, attempt },
    },
    {
      delay: pollDelaySeconds(attempt) * 1000,
      jobId: `seoRankTaskPoll:${ctx.runId}:${attempt}`,
    }
  );
}

export async function seoRankRunJob(job: Job<SeoQueuePayloadRankRun>) {
  const { projectId, runId, keywordIds } = job.data.payload;
  const log = logger.child({ projectId, runId });

  const run = await getRankRun(runId);
  if (!run) {
    log.warn('seoRankRun: run not found');
    return;
  }
  if (run.status !== 'pending') {
    log.info({ status: run.status }, 'seoRankRun: run already started, skipping');
    return;
  }

  const config = await getSeoProjectConfig(projectId);
  if (!config?.domain) {
    await failRankRun(runId, 'SEO project config is missing a domain');
    return;
  }

  const keywords = await db.seoTrackedKeyword.findMany({
    where: {
      projectId,
      isActive: true,
      ...(keywordIds?.length ? { id: { in: keywordIds } } : {}),
    },
    select: { id: true, keyword: true },
    orderBy: { keyword: 'asc' },
  });
  if (keywords.length === 0) {
    await failRankRun(runId, 'No active keywords to check');
    return;
  }

  const organizationId = await getProjectOrganizationId(projectId);
  if (await isDfsSpendCapReached(organizationId)) {
    await failRankRun(runId, SPEND_CAP_ERROR);
    log.warn('seoRankRun: spend cap reached');
    return;
  }

  const checks = buildChecks(keywords, devicesFor(config.devices));
  const ctx: RunContext = {
    projectId,
    runId,
    targetDomain: config.domain,
    locationCode: config.locationCode,
    languageCode: config.languageCode,
    depth: config.serpDepth,
  };

  await markRankRunRunning(runId, checks.length);

  try {
    const client = await getDfsClientForProject(projectId);
    if (keywords.length <= LIVE_RUN_MAX_KEYWORDS) {
      await runLive(client.transport, ctx, checks);
    } else {
      await runQueued(client.transport, ctx, checks);
    }
  } catch (error) {
    await failRankRun(runId, errorMessage(error));
    throw error;
  }
}

function parseTag(tag: string | null | undefined): {
  keywordId: string;
  device: SeoDevice;
} | null {
  if (!tag) {
    return null;
  }
  const separator = tag.lastIndexOf(':');
  if (separator <= 0) {
    return null;
  }
  const device = tag.slice(separator + 1);
  if (device !== 'desktop' && device !== 'mobile') {
    return null;
  }
  return { keywordId: tag.slice(0, separator), device };
}

export async function seoRankTaskPollJob(job: Job<SeoQueuePayloadRankTaskPoll>) {
  const { projectId, runId, taskIds } = job.data.payload;
  const attempt = job.data.payload.attempt ?? 0;
  const log = logger.child({ projectId, runId, attempt });

  const run = await getRankRun(runId);
  if (!run || run.status !== 'running') {
    log.info({ status: run?.status ?? 'missing' }, 'seoRankTaskPoll: nothing to do');
    return;
  }

  if (Date.now() - run.startedAt.getTime() > RUN_DEADLINE_MS) {
    await failRankRun(
      runId,
      `Timed out after 2h with ${taskIds.length} task(s) outstanding; partial results kept`
    );
    log.warn({ outstanding: taskIds.length }, 'seoRankTaskPoll: run timed out');
    return;
  }

  const config = await getSeoProjectConfig(projectId);
  if (!config?.domain) {
    await failRankRun(runId, 'SEO project config is missing a domain');
    return;
  }

  // Anything thrown from here on (key revoked, DFS 5xx after retries, a
  // network blip) would otherwise fail this BullMQ job and leave the run in
  // 'running' forever: nothing re-enqueues a poll. Schedule the next attempt
  // instead; the 2h deadline above is what eventually fails a run that never
  // recovers.
  try {
    await collectReadyTasks({ projectId, runId, taskIds, attempt, config });
  } catch (error) {
    log.warn({ err: error }, 'seoRankTaskPoll: poll failed, retrying later');
    await enqueuePoll({ projectId, runId }, taskIds, attempt + 1);
  }
}

async function collectReadyTasks({
  projectId,
  runId,
  taskIds,
  attempt,
  config,
}: {
  projectId: string;
  runId: string;
  taskIds: string[];
  attempt: number;
  config: { domain: string; locationCode: number; languageCode: string; serpDepth: number };
}): Promise<void> {
  const log = logger.child({ projectId, runId, attempt });
  const client = await getDfsClientForProject(projectId);
  const transport = client.transport;
  const outstanding = new Set(taskIds);

  const { data: ready } = await fetchSerpTasksReady(transport);
  const readyForRun = ready.filter((item) => outstanding.has(item.id));

  if (readyForRun.length === 0) {
    log.debug({ outstanding: taskIds.length }, 'seoRankTaskPoll: nothing ready');
    await enqueuePoll({ projectId, runId }, taskIds, attempt + 1);
    return;
  }

  const parsed = readyForRun.map((item) => ({
    taskId: item.id,
    tag: parseTag(item.tag),
  }));
  const keywordIds = [
    ...new Set(parsed.flatMap((item) => (item.tag ? [item.tag.keywordId] : []))),
  ];
  const keywordRows = await db.seoTrackedKeyword.findMany({
    where: { projectId, id: { in: keywordIds } },
    select: { id: true, keyword: true },
  });
  const keywordById = new Map(keywordRows.map((row) => [row.id, row.keyword]));

  const ctx: RunContext = {
    projectId,
    runId,
    targetDomain: config.domain,
    locationCode: config.locationCode,
    languageCode: config.languageCode,
    depth: config.serpDepth,
  };
  const snapshots: RankSnapshotInput[] = [];
  const failures: string[] = [];
  const processed = new Set<string>();

  for (const item of parsed) {
    const keyword = item.tag ? keywordById.get(item.tag.keywordId) : undefined;
    if (!item.tag || keyword === undefined) {
      // Untagged, or the keyword was deleted mid-run: nothing to attribute
      // the result to. Collecting it is free but pointless.
      failures.push(`task ${item.taskId}: keyword no longer tracked`);
      processed.add(item.taskId);
      continue;
    }
    const check: RankCheck = {
      keywordId: item.tag.keywordId,
      keyword,
      device: item.tag.device,
    };
    try {
      const { data } = await fetchRankCheckTaskResult(transport, {
        taskId: item.taskId,
        keywordId: check.keywordId,
        keyword,
        targetDomain: ctx.targetDomain,
      });
      if (data.status === 'pending') {
        continue;
      }
      if (data.status === 'failed') {
        failures.push(`${keyword} (${check.device}): ${data.message}`);
      } else {
        snapshots.push(toSnapshot(ctx, check, data.result, new Date()));
      }
      processed.add(item.taskId);
    } catch (error) {
      failures.push(`${keyword} (${check.device}): ${errorMessage(error)}`);
      processed.add(item.taskId);
      log.warn({ err: error, taskId: item.taskId }, 'seoRankTaskPoll: task_get failed');
    }
  }

  await insertRankSnapshots(snapshots);
  await addRankRunProgress(runId, { checked: processed.size });

  const remaining = taskIds.filter((taskId) => !processed.has(taskId));
  log.info(
    { collected: snapshots.length, failed: failures.length, remaining: remaining.length },
    'seoRankTaskPoll: collected'
  );

  if (remaining.length === 0) {
    await completeRankRun(runId, { warning: warningFor(failures) });
    return;
  }
  await enqueuePoll({ projectId, runId }, remaining, attempt + 1);
}
