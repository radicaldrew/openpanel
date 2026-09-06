/**
 * Delivers the signal outbox to gtmsrv.
 *
 * The other half of the sink. `recordSignalsForEvent` decided a signal is owed
 * and wrote the row; this drains the rows and POSTs them to gtmsrv's
 * `/ingest/signal`. Split in two on purpose: delivering inline would put
 * gtmsrv's availability on OpenPanel's event ingestion path, so a gtmsrv
 * restart would drop analytics events.
 *
 * Retries are safe because every row carries a `dedupeKey` derived from the
 * event's content, and gtmsrv collapses a repeat. That is what lets this
 * re-deliver anything it is unsure about rather than guessing.
 */

import { db } from '@openpanel/db';
import { logger as baseLogger } from '@/utils/logger';

const logger = baseLogger.child({ job: 'signalOutbox' });

/** Rows per drain. Bounded so one backlog cannot monopolise the cron worker. */
const BATCH_SIZE = 100;

/**
 * Attempts before a row is abandoned.
 *
 * Abandoned rather than deleted: a signal nobody could deliver is a fact worth
 * keeping, and the row carries the last error that explains it.
 */
const MAX_ATTEMPTS = 8;

/** One delivery's budget. gtmsrv runs the whole play cascade synchronously. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Statuses where retrying cannot help, so the row is abandoned at once.
 *
 * An allowlist rather than "any 4xx", and the direction matters more than the
 * membership: this fails toward retrying, and retrying is safe precisely
 * because the dedupe key makes redelivery idempotent. The rule it replaced
 * failed toward discarding, which the dedupe key cannot undo.
 *
 * What belongs here is a body gtmsrv will reject again however many times it
 * arrives: a missing dedupe_key, an unparseable occurred_at, a payload over the
 * cap. Those are ours to fix, and retrying them buries the failures worth
 * retrying.
 *
 * 401 is deliberately NOT here — a credential rotation is a genuine transient
 * and nobody has expressed an intent about the queue, so backoff is right.
 * 403 is not here either, and is not retried: see PAUSED_STATUS.
 */
const PERMANENT_STATUSES = new Set([400, 413, 422]);

/**
 * gtmsrv answers 403 when the source is disabled. That is an instruction, not a
 * failure, and it is the one status this job must neither retry nor abandon.
 *
 * Retrying would be the system arguing with the operator who just switched the
 * source off. Abandoning would be the system deciding on their behalf that the
 * backlog was disposable. Both guess at an intent the code cannot know: there
 * are two reasons to disable a source and they want opposite handling — *this
 * producer is emitting nonsense* wants the backlog discarded, because releasing
 * it later delivers the nonsense; *pause while I look at something* wants it
 * kept.
 *
 * So the rows park. They stop being delivered, they keep the reason, and they
 * do NOT consume an attempt — a pause of any length must not use up the retry
 * budget that exists for transient failures. Releasing them and discarding them
 * are both explicit operator actions (releasePausedSignals /
 * discardPausedSignals in @openpanel/db). The operator decided to stop; the
 * operator decides what happens to what stopped.
 */
const PAUSED_STATUS = 403;

/**
 * Names this producer in gtmsrv's logs.
 *
 * Only read when the shared token was used: gtmsrv logs `source_claimed` beside
 * its "issue this producer its own source credential" warning. Sending it turns
 * that warning from "something is on the shared token" into a line naming which
 * producer to issue a credential to. It is not authentication and gtmsrv does
 * not treat it as such — the credential decides identity.
 */
const SOURCE_HEADER = 'OpenPanel signal sink';

export interface SignalSinkConfig {
  url: string;
  token: string;
}

/**
 * Configuration, from the environment and nowhere else.
 *
 * There is deliberately no default host. A default would mean a
 * misconfigured deployment quietly posts real people's behaviour at whatever
 * host happened to be compiled in, and "it silently worked against the wrong
 * gtmsrv" is worse than "it did not start".
 */
export function signalSinkConfig(
  env: NodeJS.ProcessEnv = process.env
): SignalSinkConfig | null {
  const url = env.GTMSRV_URL?.trim();
  const token = env.GTMSRV_INGEST_TOKEN?.trim();
  if (!url || !token) {
    return null;
  }
  return { url: url.replace(/\/+$/, ''), token };
}

export function isSignalSinkEnabled(env: NodeJS.ProcessEnv = process.env) {
  return signalSinkConfig(env) !== null;
}

/** What gtmsrv's api.SignalRequest expects. Kept in step with ingest.go. */
export interface SignalRequestBody {
  kind: string;
  source: string;
  dedupe_key: string;
  strength?: number;
  subject?: { kind: string; id: string };
  evidence?: Record<string, unknown>;
  /**
   * RFC 3339, TOP LEVEL. gtmsrv reads `occurred_at` from the request body, not
   * from evidence — a copy in evidence alone is inert, and the signal then
   * carries receipt time. SPEC §6's "4d after email.sent" would count from when
   * a backlog happened to drain rather than from when the event happened.
   */
  occurred_at: string;
}

type OutboxRow = {
  id: string;
  dedupeKey: string;
  kind: string;
  strength: number;
  source: string;
  subjectKind: string | null;
  subjectId: string | null;
  occurredAt: Date;
  evidence: unknown;
  attempts: number;
};

export function toSignalRequest(row: OutboxRow): SignalRequestBody {
  const body: SignalRequestBody = {
    kind: row.kind,
    source: row.source,
    dedupe_key: row.dedupeKey,
    strength: row.strength,
    occurred_at: row.occurredAt.toISOString(),
    evidence: (row.evidence ?? {}) as Record<string, unknown>,
  };
  // Omitted entirely when the event had no identified profile. gtmsrv opens a
  // lead from a subject, and a guessed one puts a stranger's activity on
  // somebody else's timeline.
  if (row.subjectKind && row.subjectId) {
    body.subject = { kind: row.subjectKind, id: row.subjectId };
  }
  return body;
}

/**
 * Backoff, in seconds: 1m, 2m, 4m … capped at an hour.
 *
 * gtmsrv answers 5xx when it wants a retry, and the dedupe key makes retrying
 * safe, so the only question is how hard to lean on a service that is already
 * struggling.
 */
export function backoffSeconds(attempts: number): number {
  return Math.min(60 * 2 ** Math.max(0, attempts - 1), 3600);
}

export type PostFn = (
  url: string,
  init: { headers: Record<string, string>; body: string; signal: AbortSignal }
) => Promise<{ status: number; text: () => Promise<string> }>;

const defaultPost: PostFn = async (url, init) =>
  fetch(url, { method: 'POST', ...init });

/**
 * Drain one batch.
 *
 * `post` is injectable so the delivery contract can be tested offline with no
 * gtmsrv running — which is the only way this gets tested at all, since the
 * thing it talks to is a different service in a different repository.
 */
export async function signalOutboxCronJob({
  env = process.env,
  post = defaultPost,
  now = () => new Date(),
}: {
  env?: NodeJS.ProcessEnv;
  post?: PostFn;
  now?: () => Date;
} = {}) {
  const config = signalSinkConfig(env);
  if (!config) {
    // Not an error. A deployment that does not feed gtmsrv is a normal
    // deployment; it just says so once per drain rather than never.
    logger.debug('Signal sink disabled (GTMSRV_URL / GTMSRV_INGEST_TOKEN unset)');
    return { delivered: 0, failed: 0, abandoned: 0, paused: 0, skipped: true };
  }

  const rows = await db.signalOutbox.findMany({
    where: { status: 'pending', nextAttemptAt: { lte: now() } },
    orderBy: { createdAt: 'asc' },
    take: BATCH_SIZE,
  });
  if (rows.length === 0) {
    return { delivered: 0, failed: 0, abandoned: 0, paused: 0, skipped: false };
  }

  let delivered = 0;
  let failed = 0;
  let abandoned = 0;
  let paused = 0;

  for (const row of rows) {
    const attempts = row.attempts + 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await post(`${config.url}/ingest/signal`, {
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.token}`,
          'x-gtm-source': SOURCE_HEADER,
        },
        body: JSON.stringify(toSignalRequest(row)),
        signal: controller.signal,
      });

      if (res.status >= 200 && res.status < 300) {
        await db.signalOutbox.update({
          where: { id: row.id },
          data: { status: 'sent', attempts, sentAt: now(), lastError: null },
        });
        delivered++;
        continue;
      }

      const body = (await res.text().catch(() => '')).slice(0, 500);

      // The source is switched off. Park without spending an attempt.
      if (res.status === PAUSED_STATUS) {
        await db.signalOutbox.update({
          where: { id: row.id },
          data: { status: 'paused', lastError: `HTTP 403: ${body}` },
        });
        paused++;
        continue;
      }

      // Only a body gtmsrv will reject again is abandoned outright. Everything
      // else — including 401 and 403, which are an operator mid-rotation or a
      // deliberately paused source — goes back on the queue with backoff.
      if (PERMANENT_STATUSES.has(res.status)) {
        await db.signalOutbox.update({
          where: { id: row.id },
          data: {
            status: 'abandoned',
            attempts,
            lastError: `HTTP ${res.status}: ${body}`,
          },
        });
        abandoned++;
        logger.error(
          { outboxId: row.id, kind: row.kind, status: res.status, body },
          'Signal rejected by gtmsrv; abandoned'
        );
        continue;
      }

      await reschedule(row.id, attempts, `HTTP ${res.status}: ${body}`, now);
      failed++;
    } catch (error) {
      // Network error, timeout, gtmsrv down. Retryable, and safe to retry:
      // if it did arrive, the dedupe key means the repeat is collapsed.
      await reschedule(
        row.id,
        attempts,
        error instanceof Error ? error.message : String(error),
        now
      );
      failed++;
    } finally {
      clearTimeout(timer);
    }
  }

  if (paused) {
    // Said loudly and every drain it happens: a parked backlog is invisible
    // otherwise, and the operator has to know it is accumulating.
    logger.warn(
      { paused },
      'Source is disabled; signals parked. They are not being delivered and will not ' +
        'age out. Re-enable the source and call releasePausedSignals to release them, ' +
        'or discardPausedSignals to drop them.'
    );
  }
  if (delivered || failed || abandoned || paused) {
    logger.info({ delivered, failed, abandoned, paused }, 'Signal outbox drained');
  }
  return { delivered, failed, abandoned, paused, skipped: false };
}

async function reschedule(
  id: string,
  attempts: number,
  error: string,
  now: () => Date
) {
  if (attempts >= MAX_ATTEMPTS) {
    await db.signalOutbox.update({
      where: { id },
      data: { status: 'abandoned', attempts, lastError: error },
    });
    logger.error({ outboxId: id, attempts, error }, 'Signal abandoned after retries');
    return;
  }
  await db.signalOutbox.update({
    where: { id },
    data: {
      attempts,
      lastError: error,
      nextAttemptAt: new Date(now().getTime() + backoffSeconds(attempts) * 1000),
    },
  });
}
