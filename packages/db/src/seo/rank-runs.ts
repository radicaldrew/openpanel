import type { SeoRankRun } from '../generated/prisma/client';
import { db } from '../prisma-client';
import { getProjectOrganizationId, isDfsSpendCapReached } from './client';

export const SPEND_CAP_ERROR = 'spend cap reached';
const ACTIVE_RUN_STATUSES = ['pending', 'running'];

export type SeoRankRunStatus = 'pending' | 'running' | 'completed' | 'failed';

export type CreateRankRunResult =
  | { ok: true; run: SeoRankRun }
  | { ok: false; reason: 'already_running'; run: SeoRankRun }
  | { ok: false; reason: 'no_keywords' }
  | { ok: false; reason: 'spend_cap'; run: SeoRankRun };

export async function getActiveRankRun(
  projectId: string
): Promise<SeoRankRun | null> {
  return db.seoRankRun.findFirst({
    where: { projectId, status: { in: ACTIVE_RUN_STATUSES } },
    orderBy: { startedAt: 'desc' },
  });
}

export async function getRankRun(runId: string): Promise<SeoRankRun | null> {
  return db.seoRankRun.findUnique({ where: { id: runId } });
}

export async function listRankRuns(
  projectId: string,
  limit = 20
): Promise<SeoRankRun[]> {
  return db.seoRankRun.findMany({
    where: { projectId },
    orderBy: { startedAt: 'desc' },
    take: limit,
  });
}

export async function getLastCompletedRankRun(
  projectId: string
): Promise<SeoRankRun | null> {
  return db.seoRankRun.findFirst({
    where: { projectId, status: 'completed' },
    orderBy: { completedAt: 'desc' },
  });
}

/**
 * Create a run for a manual "check now". One active run per project: a
 * second click while the first is still collecting would double the spend
 * for the same snapshot. The spend cap is checked here too (scheduled runs
 * are checked by the cron) and, like the cron, a capped attempt leaves a
 * failed run behind so the UI can say why nothing happened. The caller
 * enqueues the `seoRankRun` job for an `ok` result.
 */
export async function createRankRun({
  projectId,
  keywordIds,
}: {
  projectId: string;
  keywordIds?: string[];
}): Promise<CreateRankRunResult> {
  const active = await getActiveRankRun(projectId);
  if (active) {
    return { ok: false, reason: 'already_running', run: active };
  }

  const keywordsTotal = await db.seoTrackedKeyword.count({
    where: {
      projectId,
      isActive: true,
      ...(keywordIds?.length ? { id: { in: keywordIds } } : {}),
    },
  });
  if (keywordsTotal === 0) {
    return { ok: false, reason: 'no_keywords' };
  }

  const organizationId = await getProjectOrganizationId(projectId);
  if (await isDfsSpendCapReached(organizationId)) {
    const run = await db.seoRankRun.create({
      data: {
        projectId,
        status: 'failed',
        keywordsTotal,
        error: SPEND_CAP_ERROR,
        completedAt: new Date(),
      },
    });
    return { ok: false, reason: 'spend_cap', run };
  }

  const run = await db.seoRankRun.create({
    data: { projectId, status: 'pending', keywordsTotal },
  });

  // Two "check now" clicks can both pass the active-run check above before
  // either row exists. Whoever is not the earliest active run backs out, so
  // at most one run is ever handed to the worker.
  const earliest = await db.seoRankRun.findFirst({
    where: { projectId, status: { in: ACTIVE_RUN_STATUSES } },
    orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
  });
  if (earliest && earliest.id !== run.id) {
    await db.seoRankRun.delete({ where: { id: run.id } });
    return { ok: false, reason: 'already_running', run: earliest };
  }
  return { ok: true, run };
}

// ---------------------------------------------------------------------------
// Worker bookkeeping. keywordsTotal/keywordsChecked count keyword × device
// checks once the run starts, so progress reads correctly for `both`.
// ---------------------------------------------------------------------------

export async function markRankRunRunning(
  runId: string,
  checksTotal: number
): Promise<void> {
  await db.seoRankRun.update({
    where: { id: runId },
    data: { status: 'running', keywordsTotal: checksTotal, error: null },
  });
}

export async function addRankRunProgress(
  runId: string,
  progress: { checked?: number; costUsd?: number }
): Promise<void> {
  const checked = progress.checked ?? 0;
  const costUsd = progress.costUsd ?? 0;
  if (checked === 0 && costUsd === 0) {
    return;
  }
  await db.seoRankRun.update({
    where: { id: runId },
    data: {
      keywordsChecked: { increment: checked },
      costUsd: { increment: costUsd },
    },
  });
}

export async function completeRankRun(
  runId: string,
  options: { warning?: string | null } = {}
): Promise<void> {
  const now = new Date();
  const run = await db.seoRankRun.update({
    where: { id: runId },
    data: {
      status: 'completed',
      completedAt: now,
      error: options.warning ?? null,
    },
    select: { projectId: true },
  });
  await db.seoProjectConfig.updateMany({
    where: { projectId: run.projectId },
    data: { rankLastRunAt: now },
  });
}

/** Partial data written so far is kept; only the status and reason change. */
export async function failRankRun(runId: string, error: string): Promise<void> {
  await db.seoRankRun.update({
    where: { id: runId },
    data: { status: 'failed', completedAt: new Date(), error },
  });
}
