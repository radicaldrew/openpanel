import { createHash } from 'node:crypto';
import type {
  IClickhouseSession,
  IServiceCreateEventPayload,
  IServiceEvent,
  Prisma,
} from '@openpanel/db';
import { createLogger } from '@openpanel/logger';
import { getRedisGroupQueue, getRedisQueue } from '@openpanel/redis';
import { Queue } from 'bullmq';
import { Queue as GroupQueue } from 'groupmq';
import type { ITrackPayload } from '../../validation';

export const EVENTS_GROUP_QUEUES_SHARDS = Number.parseInt(
  process.env.EVENTS_GROUP_QUEUES_SHARDS || '1',
  10
);

export const getQueueName = (name: string) =>
  process.env.QUEUE_CLUSTER ? `{${name}}` : name;

function pickShard(projectId: string) {
  const h = createHash('sha1').update(projectId).digest(); // 20 bytes
  // take first 4 bytes as unsigned int
  const x = h.readUInt32BE(0);
  return x % EVENTS_GROUP_QUEUES_SHARDS; // 0..n-1
}

export const queueLogger = createLogger({ name: 'queue' });

// BullMQ re-emits ioredis connection errors on every Queue instance; with no
// 'error' listener Node throws them as uncaughtException and kills the
// process (the api died ~daily from idle-socket ECONNRESETs, see
// api-crash-econnreset-plan.md). ioredis reconnects on its own — log and
// continue.
const guardQueue = <
  T extends { on(event: 'error', listener: (error: Error) => void): unknown },
>(
  queue: T,
  name: string
): T => {
  queue.on('error', (error) => {
    queueLogger.error({ err: error, queue: name }, 'queue connection error');
  });
  return queue;
};

export interface EventsQueuePayloadIncomingEvent {
  type: 'incomingEvent';
  payload: {
    projectId: string;
    event: ITrackPayload & {
      timestamp: string | number;
      isTimestampFromThePast: boolean;
    };
    uaInfo:
      | {
          readonly isServer: true;
          readonly device: 'server';
          readonly os: '';
          readonly osVersion: '';
          readonly browser: '';
          readonly browserVersion: '';
          readonly brand: '';
          readonly model: '';
        }
      | {
          readonly os: string | undefined;
          readonly osVersion: string | undefined;
          readonly browser: string | undefined;
          readonly browserVersion: string | undefined;
          readonly device: string;
          readonly brand: string | undefined;
          readonly model: string | undefined;
          readonly isServer: false;
        };
    geo: {
      country: string | undefined;
      city: string | undefined;
      region: string | undefined;
      longitude: number | undefined;
      latitude: number | undefined;
    };
    headers: Record<string, string | undefined>;
    deviceId: string;
    sessionId: string;
  };
}
export interface EventsQueuePayloadCreateEvent {
  type: 'createEvent';
  payload: Omit<IServiceEvent, 'id'>;
}

export interface EventsQueuePayloadCreateSessionEnd {
  type: 'createSessionEnd';
  payload: IServiceCreateEventPayload;
  // Snapshot of the session at the moment the close was decided. Used as a
  // fallback when the live Redis blob has expired by the time the job runs,
  // and to detect post-enqueue extensions (so we don't close a session that
  // received more events in the meantime).
  snapshot: IClickhouseSession;
}

// TODO: Rename `EventsQueuePayloadCreateSessionEnd`
export type SessionsQueuePayload = EventsQueuePayloadCreateSessionEnd;

export type EventsQueuePayload =
  | EventsQueuePayloadCreateEvent
  | EventsQueuePayloadCreateSessionEnd
  | EventsQueuePayloadIncomingEvent;

export type CronQueuePayloadMeasureSignals = {
  type: 'measureSignals';
  payload: undefined;
};
export type CronQueuePayloadSalt = {
  type: 'salt';
  payload: undefined;
};
export type CronQueuePayloadFlushEvents = {
  type: 'flushEvents';
  payload: undefined;
};
export type CronQueuePayloadFlushProfiles = {
  type: 'flushProfiles';
  payload: undefined;
};
export type CronQueuePayloadFlushSessions = {
  type: 'flushSessions';
  payload: undefined;
};
export type CronQueuePayloadPing = {
  type: 'ping';
  payload: undefined;
};
export type CronQueuePayloadDelete = {
  type: 'delete';
  payload: undefined;
};
export type CronQueuePayloadInsightsDaily = {
  type: 'insightsDaily';
  payload: undefined;
};
export type CronQueuePayloadOnboarding = {
  type: 'onboarding';
  payload: undefined;
};
export type CronQueuePayloadFlushProfileBackfill = {
  type: 'flushProfileBackfill';
  payload: undefined;
};
export type CronQueuePayloadFlushReplay = {
  type: 'flushReplay';
  payload: undefined;
};
export type CronQueuePayloadGscSync = {
  type: 'gscSync';
  payload: undefined;
};
export type CronQueuePayloadFlushGroups = {
  type: 'flushGroups';
  payload: undefined;
};
export type CronQueuePayloadCohortRefresh = {
  type: 'cohortRefresh';
  payload: undefined;
};
export type CronQueuePayloadSessionReaper = {
  type: 'sessionReaper';
  payload: undefined;
};
export type CronQueuePayloadSessionVacuum = {
  type: 'sessionVacuum';
  payload: undefined;
};
export type CronQueuePayloadInsightCleanup = {
  type: 'insightCleanup';
  payload: undefined;
};
export type CronQueuePayloadWeeklyDigest = {
  type: 'weeklyDigest';
  payload: undefined;
};
export type CronQueuePayloadDataHealth = {
  type: 'dataHealth';
  payload: undefined;
};
export type CronQueuePayloadWindDown = {
  type: 'windDown';
  payload: undefined;
};
export type CronQueuePayloadMetricAlerts = {
  type: 'metricAlerts';
  payload: undefined;
};
export type CronQueuePayloadSignalOutbox = {
  type: 'signalOutbox';
  payload: undefined;
};
export type CronQueuePayloadSeoRankScheduler = {
  type: 'seoRankScheduler';
  payload: undefined;
};
export type CronQueuePayloadSeoBacklinkScheduler = {
  type: 'seoBacklinkScheduler';
  payload: undefined;
};
export type CronQueuePayloadSeoSpendReset = {
  type: 'seoSpendReset';
  payload: undefined;
};
export type CronQueuePayloadSeoBalanceRefresh = {
  type: 'seoBalanceRefresh';
  payload: undefined;
};
export type CronQueuePayloadSeoMetricsRefresh = {
  type: 'seoMetricsRefresh';
  payload: undefined;
};
export type CronQueuePayload =
  | CronQueuePayloadSeoRankScheduler
  | CronQueuePayloadSeoBacklinkScheduler
  | CronQueuePayloadSeoSpendReset
  | CronQueuePayloadSeoBalanceRefresh
  | CronQueuePayloadSeoMetricsRefresh
  | CronQueuePayloadSignalOutbox
  | CronQueuePayloadMeasureSignals
  | CronQueuePayloadMetricAlerts
  | CronQueuePayloadSalt
  | CronQueuePayloadFlushEvents
  | CronQueuePayloadFlushSessions
  | CronQueuePayloadFlushProfiles
  | CronQueuePayloadFlushProfileBackfill
  | CronQueuePayloadFlushReplay
  | CronQueuePayloadFlushGroups
  | CronQueuePayloadPing
  | CronQueuePayloadDelete
  | CronQueuePayloadInsightsDaily
  | CronQueuePayloadOnboarding
  | CronQueuePayloadGscSync
  | CronQueuePayloadCohortRefresh
  | CronQueuePayloadSessionReaper
  | CronQueuePayloadSessionVacuum
  | CronQueuePayloadInsightCleanup
  | CronQueuePayloadWeeklyDigest
  | CronQueuePayloadDataHealth
  | CronQueuePayloadWindDown;

export type CronQueueType = CronQueuePayload['type'];

const orderingDelayMs = Number.parseInt(
  process.env.ORDERING_DELAY_MS || '100',
  10
);

const autoBatchMaxWaitMs = Number.parseInt(
  process.env.AUTO_BATCH_MAX_WAIT_MS || '0',
  10
);
const autoBatchSize = Number.parseInt(process.env.AUTO_BATCH_SIZE || '0', 10);

export const eventsGroupQueues = Array.from({
  length: EVENTS_GROUP_QUEUES_SHARDS,
}).map(
  (_, index, list) =>
    new GroupQueue<EventsQueuePayloadIncomingEvent['payload']>({
      logger: process.env.NODE_ENV === 'production' ? queueLogger : undefined,
      namespace: getQueueName(
        list.length === 1 ? 'group_events' : `group_events_${index}`
      ),
      redis: getRedisGroupQueue(),
      keepCompleted: 1,
      keepFailed: 10_000,
      orderingDelayMs,
      autoBatch:
        autoBatchMaxWaitMs && autoBatchSize
          ? {
              maxWaitMs: autoBatchMaxWaitMs,
              size: autoBatchSize,
            }
          : undefined,
    })
);

export const getEventsGroupQueueShard = (groupId: string) => {
  const shard = pickShard(groupId);
  const queue = eventsGroupQueues[shard];
  if (!queue) {
    throw new Error(`Queue not found for group ${groupId}`);
  }
  return queue;
};

export const sessionsQueue = guardQueue(
  new Queue<SessionsQueuePayload>(getQueueName('sessions'), {
    connection: getRedisQueue(),
    defaultJobOptions: {
      removeOnComplete: true,
    },
  }),
  'sessions'
);

export const cronQueue = guardQueue(
  new Queue<CronQueuePayload>(getQueueName('cron'), {
    connection: getRedisQueue(),
    defaultJobOptions: {
      removeOnComplete: 10,
    },
  }),
  'cron'
);

export type NotificationQueuePayload = {
  type: 'sendNotification';
  payload: {
    notification: Prisma.NotificationUncheckedCreateInput;
  };
};

export const notificationQueue = guardQueue(
  new Queue<NotificationQueuePayload>(getQueueName('notification'), {
    connection: getRedisQueue(),
    defaultJobOptions: {
      removeOnComplete: 10,
    },
  }),
  'notification'
);

export type ImportQueuePayload = {
  type: 'import';
  payload: {
    importId: string;
  };
};

export const importQueue = guardQueue(
  new Queue<ImportQueuePayload>(getQueueName('import'), {
    connection: getRedisQueue(),
    defaultJobOptions: {
      removeOnComplete: 10,
      removeOnFail: 50,
    },
  }),
  'import'
);

export type InsightsQueuePayloadProject = {
  type: 'insightsProject';
  payload: { projectId: string; date: string };
};

export const insightsQueue = guardQueue(
  new Queue<InsightsQueuePayloadProject>(getQueueName('insights'), {
    connection: getRedisQueue(),
    defaultJobOptions: {
      removeOnComplete: 100,
    },
  }),
  'insights'
);

export type GscQueuePayloadSync = {
  type: 'gscProjectSync';
  payload: { projectId: string };
};
export type GscQueuePayloadBackfill = {
  type: 'gscProjectBackfill';
  payload: { projectId: string };
};
export type GscQueuePayload = GscQueuePayloadSync | GscQueuePayloadBackfill;

export const gscQueue = guardQueue(
  new Queue<GscQueuePayload>(getQueueName('gsc'), {
    connection: getRedisQueue(),
    defaultJobOptions: {
      removeOnComplete: 50,
      removeOnFail: 100,
    },
  }),
  'gsc'
);

// SEO (SEO.md §6). One queue for every DataForSEO-backed job family; the
// worker dispatcher in apps/worker/src/jobs/seo.ts fans out per `type`.
export type SeoQueuePayloadRankRun = {
  type: 'seoRankRun';
  payload: { projectId: string; runId: string; keywordIds?: string[] };
};
export type SeoQueuePayloadRankTaskPoll = {
  type: 'seoRankTaskPoll';
  payload: {
    projectId: string;
    runId: string;
    taskIds: string[];
    /** Poll number, drives the re-enqueue backoff. Starts at 0. */
    attempt?: number;
  };
};
export type SeoQueuePayloadBacklinkSnapshot = {
  type: 'seoBacklinkSnapshot';
  payload: { projectId: string };
};
export type SeoQueuePayloadAuditStart = {
  type: 'seoAuditStart';
  payload: { projectId: string; auditId: string };
};
export type SeoQueuePayloadAuditPoll = {
  type: 'seoAuditPoll';
  payload: { projectId: string; auditId: string };
};
export type SeoQueuePayloadKeywordMetrics = {
  type: 'seoKeywordMetrics';
  payload: { projectId: string; keywords: string[] };
};
export type SeoQueuePayload =
  | SeoQueuePayloadRankRun
  | SeoQueuePayloadRankTaskPoll
  | SeoQueuePayloadBacklinkSnapshot
  | SeoQueuePayloadAuditStart
  | SeoQueuePayloadAuditPoll
  | SeoQueuePayloadKeywordMetrics;

export const seoQueue = guardQueue(
  new Queue<SeoQueuePayload>(getQueueName('seo'), {
    connection: getRedisQueue(),
    defaultJobOptions: {
      // Polls re-enqueue themselves with a delay, so a run leaves a trail of
      // short jobs; keep enough of them to debug a stuck run without letting
      // the sets grow without bound.
      removeOnComplete: { age: 3600, count: 200 },
      removeOnFail: { age: 86_400, count: 200 },
    },
  }),
  'seo'
);

export type CohortComputePayload = {
  cohortId: string;
};

export const cohortComputeQueue = guardQueue(
  new Queue<CohortComputePayload>(getQueueName('cohortCompute'), {
    connection: getRedisQueue(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      // `age` alone only trims when another job in this queue finishes, so pair
      // it with a count bound to keep the completed/failed sets from growing
      // unbounded during quiet periods.
      removeOnComplete: { age: 3600, count: 100 },
      removeOnFail: { age: 86_400, count: 100 },
    },
  }),
  'cohortCompute'
);
