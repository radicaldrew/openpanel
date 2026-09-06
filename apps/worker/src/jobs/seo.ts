import type { SeoQueuePayload } from '@openpanel/queue';
import type { Job } from 'bullmq';
import { seoAuditPollJob, seoAuditStartJob } from './seo.audit';
import { seoBacklinkSnapshotJob } from './seo.backlinks';
import { seoKeywordMetricsJob } from './seo.metrics';
import { seoRankRunJob, seoRankTaskPollJob } from './seo.rank';

/**
 * Dispatcher for the `seo` queue (SEO.md §6). One case per payload type,
 * each delegating to its job family's file; nothing DFS-specific lives here.
 * The `never` check makes adding a payload type without a case a type error.
 */
export function seoJob(job: Job<SeoQueuePayload>) {
  const data = job.data;
  switch (data.type) {
    case 'seoRankRun':
      return seoRankRunJob(job as Job<typeof data>);
    case 'seoRankTaskPoll':
      return seoRankTaskPollJob(job as Job<typeof data>);
    case 'seoBacklinkSnapshot':
      return seoBacklinkSnapshotJob(job as Job<typeof data>);
    case 'seoAuditStart':
      return seoAuditStartJob(job as Job<typeof data>);
    case 'seoAuditPoll':
      return seoAuditPollJob(job as Job<typeof data>);
    case 'seoKeywordMetrics':
      return seoKeywordMetricsJob(job as Job<typeof data>);
    default: {
      const unknown: never = data;
      throw new Error(
        `Unknown SEO job type: ${(unknown as { type?: string }).type}`
      );
    }
  }
}
