import {
  fetchBacklinkSnapshots,
  getDfsClientForProject,
  getProjectOrganizationId,
  getSeoProjectConfig,
  insertBacklinkSnapshots,
  isDfsSpendCapReached,
} from '@openpanel/db';
import type { SeoQueuePayloadBacklinkSnapshot } from '@openpanel/queue';
import type { Job } from 'bullmq';
import { logger } from '../utils/logger';

/**
 * Backlink snapshot (SEO.md §6, seo.backlinks.ts).
 *
 * Two DataForSEO calls for the project's domain — backlinks/summary/live for
 * today's totals and backlinks/history/live for the last 30 days — become one
 * seo_backlink_snapshots row per day (ReplacingMergeTree, so re-running a day
 * just refreshes it). Cost lands in the org's monthly spend through the
 * client's onCost hook; the number returned here is for the log line.
 *
 * Returns a summary instead of throwing for the expected no-ops (no domain,
 * spend cap) so a scheduled job does not go to the failed set for them.
 */
export type BacklinkSnapshotJobResult =
  | { skipped: 'no-config' | 'no-domain' | 'spend-cap' }
  | { rows: number; costUsd: number };

export async function seoBacklinkSnapshotJob(
  job: Job<SeoQueuePayloadBacklinkSnapshot>
): Promise<BacklinkSnapshotJobResult> {
  const { projectId } = job.data.payload;

  const config = await getSeoProjectConfig(projectId);
  if (!config) {
    logger.warn({ projectId }, 'seoBacklinkSnapshot: no SEO config');
    return { skipped: 'no-config' };
  }
  if (!config.domain) {
    logger.warn({ projectId }, 'seoBacklinkSnapshot: no domain');
    return { skipped: 'no-domain' };
  }

  const organizationId = await getProjectOrganizationId(projectId);
  if (await isDfsSpendCapReached(organizationId)) {
    logger.warn(
      { projectId, organizationId },
      'seoBacklinkSnapshot: spend cap reached, skipping'
    );
    return { skipped: 'spend-cap' };
  }

  const client = await getDfsClientForProject(projectId);
  const { rows, costUsd } = await fetchBacklinkSnapshots(client.transport, {
    projectId,
    domain: config.domain,
  });
  await insertBacklinkSnapshots(rows);

  logger.info(
    { projectId, domain: config.domain, rows: rows.length, costUsd },
    'seoBacklinkSnapshot: stored'
  );
  return { rows: rows.length, costUsd };
}
