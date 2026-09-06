import { fetchAndStoreKeywordMetrics } from '@openpanel/db';
import type { SeoQueuePayloadKeywordMetrics } from '@openpanel/queue';
import type { Job } from 'bullmq';
import { logger } from '../utils/logger';

/**
 * Keyword metrics (SEO.md §6, seo.metrics.ts). Enqueued when keywords are
 * added; the heavy lifting (700-per-call batching, Labs vs Google Ads
 * routing, the copy onto SeoTrackedKeyword) lives in @openpanel/db so the
 * Keywords tab can persist the same way.
 */
export async function seoKeywordMetricsJob(
  job: Job<SeoQueuePayloadKeywordMetrics>
) {
  const { projectId, keywords } = job.data.payload;
  if (keywords.length === 0) {
    return { stored: 0 };
  }
  const rows = await fetchAndStoreKeywordMetrics(projectId, keywords);
  logger.info(
    { projectId, requested: keywords.length, stored: rows.length },
    'seoKeywordMetrics: stored'
  );
  return { stored: rows.length };
}
