/**
 * Publishes the event outbox to NATS JetStream.
 *
 * The OpenPanel half of the event plane (BRIEF-openpanel-signal-leg v2, step 1).
 * Ingest writes an `EventOutbox` row after the ClickHouse write; this drains
 * those rows onto `vero.events.{tenant_slug}.{event_type}` where gtmsrv's
 * durable consumer picks them up.
 *
 * Split from ingest for the same reason the signal sink is: publishing inline
 * would put NATS's availability on OpenPanel's event ingestion path, so a NATS
 * restart would drop analytics events.
 *
 * Retries are safe. Every message carries `Nats-Msg-Id` set to the envelope's
 * deterministic `event_id`, and the `vero-events` stream has a 4-hour
 * duplicate window — longer than this job's own retry ladder (see BACKOFF),
 * which is the property that makes a redelivery collapse rather than duplicate.
 *
 * THAT COUPLING IS GUARDED IN ONLY ONE DIRECTION. Lengthening the ladder here
 * fails a test that names the window, so it cannot pass unnoticed. Narrowing
 * the window — which lives in the broker's stream config, in another
 * repository, owned by another team — breaks the same invariant and NOTHING
 * anywhere detects it: publishing still succeeds, and a redelivery from late in
 * the ladder quietly becomes a second event downstream. If you are changing
 * `duplicate_window` on `vero-events`, this ladder is what it has to outlast.
 */

import { db } from '@openpanel/db';
import { logger as baseLogger } from '@/utils/logger';

import {
  ZERO_UUID,
  buildAddressedEvent,
  type WrappedEvent,
} from './event-plane-envelope';

const logger = baseLogger.child({ job: 'eventOutbox' });

/** Rows per drain. Bounded so one backlog cannot monopolise the cron worker. */
const BATCH_SIZE = 200;

/**
 * Attempts before a row is abandoned.
 *
 * With the ladder below this is ~3 hours of retrying, deliberately INSIDE the
 * stream's 4-hour duplicate window: a row that is retried to exhaustion never
 * publishes a message the window has already forgotten.
 */
const MAX_ATTEMPTS = 8;

/** `min(60 · 2^(n-1), 3600)` — 1m, 2m, 4m, 8m, 16m, 32m, 1h, 1h ≈ 3h total. */
export function backoffSeconds(attempts: number): number {
  return Math.min(60 * 2 ** Math.max(0, attempts - 1), 3600);
}

/** What OpenPanel calls itself on the bus. Becomes `adapter_type` downstream. */
export const EVENT_SOURCE = 'openpanel';

export interface EventPlaneConfig {
  url: string;
  user: string;
  pass: string;
}

/**
 * A deployment that asked for the event plane but cannot authenticate to it.
 *
 * Its own class so the cron can be sure it is not swallowing a network error:
 * this is never transient and never fixes itself.
 */
export class EventPlaneConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventPlaneConfigError';
  }
}

/**
 * The whole config, or nothing — never half.
 *
 * WHY USER/PASSWORD AND NOT A `.creds` FILE
 *
 * The brief said `NATS_CREDS`, which implies an nsc operator hierarchy. The
 * broker that actually exists uses config-file accounts instead — two clients
 * on a private interface did not justify a JWT chain — so the credential is a
 * username and a password, and the env is `NATS_USER` / `NATS_PASSWORD`.
 *
 * They are deliberately NOT folded into the URL as `nats://user:pass@host`,
 * which NATS accepts: a URL is the thing that ends up in log lines, error
 * messages and process listings, and a password in one leaks by default.
 *
 * WHY A MISSING PASSWORD THROWS RATHER THAN DISABLING
 *
 * Absent `NATS_URL` means nobody asked for this — the normal state of every
 * deployment today, and it returns `null` silently. A URL with no credentials
 * is somebody who DID ask and got it wrong, and treating that as "disabled"
 * gives a deployment that believes it is publishing and is not. The account on
 * the real broker is publish-only and scoped, so an unauthenticated connect
 * would be refused there anyway — the point is that it is refused HERE, before
 * a socket is opened, rather than as a connection error nobody reads.
 *
 * Thrown rather than logged because the cron dispatcher has no catch: the job
 * fails, which shows up in the job dashboard an operator actually looks at. An
 * error log competes with everything else in the stream.
 */
export function eventPlaneConfig(
  env: NodeJS.ProcessEnv = process.env,
): EventPlaneConfig | null {
  const url = env.NATS_URL?.trim();

  if (!url) {
    return null;
  }

  const user = env.NATS_USER?.trim();
  const pass = env.NATS_PASSWORD?.trim();

  if (!user || !pass) {
    const missing = [!user && 'NATS_USER', !pass && 'NATS_PASSWORD']
      .filter(Boolean)
      .join(' and ');

    throw new EventPlaneConfigError(
      `NATS_URL is set but ${missing} ${!user && !pass ? 'are' : 'is'} not set. ` +
        'The event plane will not connect unauthenticated — set the credentials or unset NATS_URL.',
    );
  }

  return { url, user, pass };
}

/**
 * Whether someone has asked for the event plane at all.
 *
 * Deliberately does NOT throw on a half-configured deployment: a predicate that
 * throws is a trap for a caller who only wanted to know whether to bother.
 * `eventPlaneConfig` is where the half-configured case is refused.
 */
export function isEventPlaneEnabled(env: NodeJS.ProcessEnv = process.env) {
  return !!env.NATS_URL?.trim();
}

/** The outbox row, as fixed with the ingest side. */
export interface EventOutboxRow {
  id: string;
  projectId: string;
  eventId: string;
  eventType: string;
  tenantSlug: string;
  tenantId: string;
  occurredAt: Date;
  data: unknown;
  attempts: number;
}

/**
 * How the drain reaches its rows.
 *
 * A port rather than direct Prisma calls, so the publish path can be tested
 * without a database. That matters more than it looks: the failures worth
 * catching here are a wrong subject and a malformed envelope, and neither
 * needs a table to reproduce — but both are invisible without a test that runs.
 */
export interface EventOutboxRepo {
  pending(limit: number, due: Date): Promise<EventOutboxRow[]>;
  markSent(id: string, attempts: number, sentAt: Date): Promise<void>;
  reschedule(
    id: string,
    attempts: number,
    error: string,
    nextAttemptAt: Date,
  ): Promise<void>;
  park(id: string, attempts: number, status: string, error: string): Promise<void>;
}

/** The Prisma-backed repository. */
export const defaultRepo: EventOutboxRepo = {
  pending: (limit, due) =>
    db.eventOutbox.findMany({
      where: { status: 'pending', nextAttemptAt: { lte: due } },
      orderBy: { createdAt: 'asc' },
      take: limit,
    }),
  markSent: async (id, attempts, sentAt) => {
    await db.eventOutbox.update({
      where: { id },
      data: { status: 'sent', attempts, sentAt, lastError: null },
    });
  },
  reschedule: async (id, attempts, error, nextAttemptAt) => {
    await db.eventOutbox.update({
      where: { id },
      // Truncated because `lastError` is unbounded text and a driver stack
      // trace can be kilobytes; the first 500 characters carry the cause.
      data: { attempts, lastError: error.slice(0, 500), nextAttemptAt },
    });
  },
  park: async (id, attempts, status, error) => {
    await db.eventOutbox.update({
      where: { id },
      data: { status, attempts, lastError: error.slice(0, 500) },
    });
  },
};

/**
 * Publishing, injectable so the drain can be tested against a real JetStream
 * without this file owning a connection lifecycle it cannot close in a test.
 */
export type PublishFn = (
  subject: string,
  event: WrappedEvent,
  msgId: string,
) => Promise<void>;

/**
 * Turn one row into a subject and an envelope.
 *
 * Separated and exported because this is the part that can be wrong quietly: a
 * misaddressed subject still publishes, and a malformed envelope is dropped by
 * the consumer with a warning rather than dead-lettered.
 *
 * `event_type` arrives already dotted — the ingest side maps OpenPanel's
 * `repo_connected` to `repo.connected` at write time, in the same place it
 * resolves the tenant, so the drain decides neither. It is still validated
 * here, because the cost of being wrong is silent loss downstream rather than
 * an error anyone sees.
 */
export function addressRow(row: EventOutboxRow) {
  const payload =
    row.data && typeof row.data === 'object'
      ? (row.data as Record<string, unknown>)
      : {};

  return buildAddressedEvent({
    tenantId: row.tenantId,
    tenantSlug: row.tenantSlug,
    // A product event has no channel. `ZERO_UUID` rather than an omission
    // because consumer validators reject an empty `channel_id`.
    channelId: ZERO_UUID,
    eventType: row.eventType,
    // Neither inbound nor outbound: this is not a message. Defaulting to
    // `inbound` would put a lie in the envelope that a consumer may filter on.
    direction: 'internal',
    source: EVENT_SOURCE,
    // The row's own event id, hashed into a stable envelope `event_id`, so a
    // redelivery is the same event rather than a second one.
    externalId: row.eventId,
    occurredAt: row.occurredAt,
    payload,
  });
}

export interface EventOutboxResult {
  published: number;
  failed: number;
  abandoned: number;
  invalid: number;
  skipped: boolean;
}

/**
 * Drain one batch.
 *
 * A row that cannot be turned into a valid envelope is PARKED, never rethrown.
 * One unmappable event — a new event name the ingest mapping does not cover, a
 * tenant slug with a dot in it — must not stall every other event behind it.
 * That is the difference between a poison message and a stopped pipeline.
 */
export async function eventOutboxCronJob({
  env = process.env,
  publish,
  repo = defaultRepo,
  now = () => new Date(),
}: {
  env?: NodeJS.ProcessEnv;
  publish?: PublishFn;
  repo?: EventOutboxRepo;
  now?: () => Date;
} = {}): Promise<EventOutboxResult> {
  const config = eventPlaneConfig(env);

  if (!config) {
    // Not an error. A deployment that does not feed the event plane is a normal
    // deployment — and today it is every deployment.
    logger.debug('Event plane disabled (NATS_URL unset)');
    return { published: 0, failed: 0, abandoned: 0, invalid: 0, skipped: true };
  }

  if (!publish) {
    // The caller owns the connection. Nothing in this repo opens one yet, so
    // rather than half-connect, say so: a drain that silently did nothing while
    // configured would look like an empty outbox.
    throw new Error(
      'eventOutboxCronJob requires a `publish` function; the NATS connection is owned by the caller',
    );
  }

  const rows = await repo.pending(BATCH_SIZE, now());

  if (rows.length === 0) {
    return { published: 0, failed: 0, abandoned: 0, invalid: 0, skipped: false };
  }

  let published = 0;
  let failed = 0;
  let abandoned = 0;
  let invalid = 0;

  for (const row of rows) {
    const attempts = row.attempts + 1;

    let addressed: ReturnType<typeof addressRow>;
    try {
      addressed = addressRow(row);
    } catch (error) {
      // Permanent by construction: the same row will fail the same way forever,
      // and retrying it buries the failures worth retrying. Parked with the
      // reason, so "why did this event never arrive" has an answer in the row.
      const message = error instanceof Error ? error.message : String(error);
      await repo.park(row.id, attempts, 'invalid', message);
      invalid++;
      logger.warn(
        { outboxId: row.id, eventType: row.eventType, error: message },
        'Event cannot be addressed; parked rather than retried',
      );
      continue;
    }

    try {
      await publish(addressed.subject, addressed.event, addressed.event.event_id);
      await repo.markSent(row.id, attempts, now());
      published++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (attempts >= MAX_ATTEMPTS) {
        // Abandoned rather than deleted: an event nobody could publish is a
        // fact worth keeping, and the row carries the error that explains it.
        await repo.park(row.id, attempts, 'abandoned', message);
        abandoned++;
        logger.error(
          { outboxId: row.id, subject: addressed.subject, attempts, error: message },
          'Event abandoned after max attempts',
        );
        continue;
      }

      await repo.reschedule(
        row.id,
        attempts,
        message,
        new Date(now().getTime() + backoffSeconds(attempts) * 1000),
      );
      failed++;
    }
  }

  if (invalid > 0) {
    // Said loudly and every drain it happens: a parked row ages out of nobody's
    // attention otherwise, and an unmappable event name is a code fix.
    logger.warn(
      { invalid },
      'Events parked as unpublishable. They are not being retried; fix the event-type mapping and re-queue them.',
    );
  }

  return { published, failed, abandoned, invalid, skipped: false };
}
