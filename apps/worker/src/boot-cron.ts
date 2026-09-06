import type { CronQueuePayload, CronQueueType } from '@openpanel/queue';
import { cronQueue } from '@openpanel/queue';
import { logger } from './utils/logger';

async function removeConflictingJobs(schedulerKey: string) {
  // Remove any existing jobs that might conflict with the scheduler
  // BullMQ scheduler jobs have IDs like "repeat:<key>:<timestamp>"
  const jobStates = ['delayed', 'waiting', 'completed', 'failed'] as const;

  for (const state of jobStates) {
    try {
      const jobs = await cronQueue.getJobs([state]);
      for (const job of jobs) {
        // Check if this job was created by the scheduler we're about to upsert
        if (job.id?.startsWith(`repeat:${schedulerKey}:`)) {
          await job.remove();
          logger.info(
            { jobId: job.id, schedulerKey },
            'Removed conflicting scheduler job'
          );
        }
      }
    } catch (error) {
      // Ignore errors during cleanup
    }
  }
}

export async function bootCron() {
  const jobs: {
    name: string;
    type: CronQueueType;
    pattern: string | number;
  }[] = [
    {
      name: 'salt',
      type: 'salt',
      pattern: '0 0 * * *',
    },
    {
      // The signal outbox. Every 15s rather than every minute: an
      // `upgrade_gate_abandoned` that reaches outreach an hour late has missed
      // the moment it was about. The drain is a single indexed query and a
      // no-op when the table is empty.
      name: 'signalOutbox',
      type: 'signalOutbox',
      pattern: 1000 * 15,
    },
    {
      name: 'delete',
      type: 'delete',
      pattern: '0 * * * *',
    },
    {
      name: 'flush',
      type: 'flushEvents',
      pattern: 1000 * 10,
    },
    {
      name: 'flush',
      type: 'flushProfiles',
      pattern: 1000 * 10,
    },
    {
      name: 'flush',
      type: 'flushSessions',
      pattern: 1000 * 10,
    },
    {
      name: 'flush',
      type: 'flushProfileBackfill',
      pattern: 1000 * 30,
    },
    {
      name: 'flush',
      type: 'flushReplay',
      pattern: 1000 * 10,
    },
    {
      name: 'flush',
      type: 'flushGroups',
      pattern: 1000 * 10,
    },
    {
      // Every 60s. The alert state machine's staleness window is derived from
      // this period, so changing it changes how long a pending timer survives
      // a gap — see packages/gigapipe/src/alerts/state-machine.ts.
      name: 'metricAlerts',
      type: 'metricAlerts',
      pattern: 1000 * 60,
    },
    {
      // Every 15 minutes. This period is the measure evaluator's own cadence:
      // a rule's forSeconds is validated against three of these, and the
      // dedupe key that keeps `mcp_idle` to one signal per episode does not
      // depend on it — see packages/gigapipe/src/measures/episode.ts.
      name: 'measureSignals',
      type: 'measureSignals',
      pattern: 1000 * 60 * 15,
    },
    {
      name: 'insightsDaily',
      type: 'insightsDaily',
      pattern: '0 2 * * *',
    },
    {
      name: 'onboarding',
      type: 'onboarding',
      pattern: '0 * * * *',
    },
    {
      name: 'gscSync',
      type: 'gscSync',
      pattern: '0 3 * * *',
    },
    {
      // SEO (SEO.md §6). The rank scheduler is the cadence at which a due
      // project is picked up, not the rank cadence itself — that lives on
      // SeoProjectConfig.rankNextRunAt.
      name: 'seoRankScheduler',
      type: 'seoRankScheduler',
      pattern: '*/15 * * * *',
    },
    {
      name: 'seoBacklinkScheduler',
      type: 'seoBacklinkScheduler',
      pattern: '30 3 * * *',
    },
    {
      // First of the month: monthlySpendUsd is a calendar-month counter.
      name: 'seoSpendReset',
      type: 'seoSpendReset',
      pattern: '0 0 1 * *',
    },
    {
      name: 'seoBalanceRefresh',
      type: 'seoBalanceRefresh',
      pattern: '0 4 * * *',
    },
    {
      // Monday 05:00, after the nightly GSC/backlink/balance jobs. Refreshes
      // volume/difficulty/cpc for every active tracked keyword, one batched
      // job per project.
      name: 'seoMetricsRefresh',
      type: 'seoMetricsRefresh',
      pattern: '0 5 * * 1',
    },
    {
      name: 'cohortRefresh',
      type: 'cohortRefresh',
      pattern: '*/30 * * * *',
    },
    {
      name: 'sessionReaper',
      type: 'sessionReaper',
      pattern: 1000 * 60 * 5, // every 5 minutes
    },
    {
      name: 'sessionVacuum',
      type: 'sessionVacuum',
      pattern: '0 4 * * *', // daily at 04:00 UTC — backstop for cleanup leaks
    },
    {
      name: 'insightCleanup',
      type: 'insightCleanup',
      pattern: '30 4 * * *', // daily at 04:30 UTC — prune stale insights/events
    },
    {
      name: 'weeklyDigest',
      type: 'weeklyDigest',
      pattern: '0 8 * * 1', // Mondays 08:00 UTC — weekly analytics digest email
    },
    {
      name: 'dataHealth',
      type: 'dataHealth',
      pattern: '30 7 * * *', // Daily 07:30 UTC — no-data / data-stopped rescue emails
    },
    {
      name: 'windDown',
      type: 'windDown',
      pattern: '0 * * * *', // Hourly — expired-trial wind-down emails, block, delete
    },
  ];

  if (process.env.SELF_HOSTED && process.env.NODE_ENV === 'production') {
    jobs.push({
      name: 'ping',
      type: 'ping',
      pattern: '0 0 * * *',
    });
  }

  logger.info('Updating cron jobs');

  const jobsToKeep = new Set(jobs.map((job) => job.type));

  const currentJobSchedulers = await cronQueue
    .getJobSchedulers()
    .catch((error) => {
      logger.error({ err: error }, 'Error getting job schedulers');
      return [];
    });
  for (const jobScheduler of currentJobSchedulers) {
    if (!jobsToKeep.has(jobScheduler.key as CronQueueType)) {
      await cronQueue.removeJobScheduler(jobScheduler.key).catch((error) => {
        logger.error(
          { err: error, jobScheduler: jobScheduler.key },
          'Error removing job scheduler'
        );
      });
    }
  }

  for (const job of jobs) {
    try {
      await cronQueue.upsertJobScheduler(
        job.type,
        typeof job.pattern === 'number'
          ? {
              every: job.pattern,
            }
          : {
              pattern: job.pattern,
            },
        {
          // CronQueuePayload has grown past the 25 members TypeScript will
          // discriminate on assignment; every member here is `payload:
          // undefined`, so the cast only restates what the union says.
          data: {
            type: job.type,
            payload: undefined,
          } as CronQueuePayload,
        }
      );
    } catch (error) {
      // If upsert fails due to conflicting job, try to clean up and retry
      const isConflictError =
        error instanceof Error &&
        error.message.includes('job ID already exists');

      if (isConflictError) {
        logger.warn(
          { job: job.type },
          'Job scheduler conflict detected, attempting cleanup'
        );

        await removeConflictingJobs(job.type);

        // Also try removing the scheduler itself to start fresh
        try {
          await cronQueue.removeJobScheduler(job.type);
        } catch {
          // Ignore - scheduler might not exist
        }

        // Retry the upsert
        try {
          await cronQueue.upsertJobScheduler(
            job.type,
            typeof job.pattern === 'number'
              ? {
                  every: job.pattern,
                }
              : {
                  pattern: job.pattern,
                },
            {
              data: {
                type: job.type,
                payload: undefined,
              } as CronQueuePayload,
            }
          );
          logger.info({ job: job.type }, 'Job scheduler created after cleanup');
        } catch (retryError) {
          logger.error(
            { err: retryError, job: job.type },
            'Error upserting job scheduler after cleanup'
          );
        }
      } else {
        logger.error(
          { err: error, job: job.type },
          'Error upserting job scheduler'
        );
      }
    }
  }
}
