import { connect, type JetStreamClient, type NatsConnection } from 'nats';
import { logger as baseLogger } from '@/utils/logger';
import type { EventPlaneConfig, PublishFn } from './cron.event-outbox';

const logger = baseLogger.child({ job: 'eventOutbox' });

/**
 * The NATS side of the event plane: the `publish` that `eventOutboxCronJob`
 * asks its caller for.
 *
 * One connection per worker process, opened on first use and reopened after
 * it closes. The cron runs every few seconds; connecting per run would churn a
 * TCP + auth handshake for every batch, and holding the connection here keeps
 * the drain itself free of lifecycle (which is why it takes `publish` at all).
 *
 * JetStream publish, not core publish: `js.publish` resolves only once the
 * stream has stored the message, so `markSent` never runs for an event the
 * broker did not keep. `msgID` becomes `Nats-Msg-Id`, which the `vero-events`
 * stream's 4h duplicate window uses to collapse a re-publish after a crash
 * between publish and `markSent`.
 */

let current: Promise<{ nc: NatsConnection; js: JetStreamClient }> | null = null;

function connection(config: EventPlaneConfig) {
  current ??= (async () => {
    const nc = await connect({
      servers: config.url,
      user: config.user,
      pass: config.pass,
      name: 'openpanel-worker',
      // Reconnects are handled by the client; a closed connection (after it
      // gives up) is dropped so the next batch opens a fresh one.
      maxReconnectAttempts: 10,
    });
    logger.info({ server: nc.getServer() }, 'Event plane connected');
    nc.closed().then((err) => {
      logger.warn({ error: err?.message }, 'Event plane connection closed');
      current = null;
    });
    return { nc, js: nc.jetstream() };
  })().catch((error) => {
    // Forget a failed connect so the next run tries again rather than
    // re-throwing the same rejection forever.
    current = null;
    throw error;
  });
  return current;
}

const encoder = new TextEncoder();

export function natsPublisher(config: EventPlaneConfig): PublishFn {
  return async (subject, event, msgId) => {
    const { js } = await connection(config);
    await js.publish(subject, encoder.encode(JSON.stringify(event)), { msgID: msgId });
  };
}

/** For shutdown: let in-flight publishes finish, then close. */
export async function closeEventPlane() {
  const c = current;
  current = null;
  if (c) {
    const { nc } = await c.catch(() => ({ nc: null }));
    await nc?.drain().catch(() => {});
  }
}
