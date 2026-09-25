import { connect } from 'nats';
import { afterAll, describe, expect, it } from 'vitest';
import { closeEventPlane, natsPublisher } from './event-plane-nats';

/**
 * Against a real JetStream, because the two properties that matter — the
 * publish is acknowledged by the stream, and a repeated msgID is collapsed —
 * are the broker's behaviour, not ours. Skipped unless NATS_TEST_URL is set:
 *
 *   docker run -d -p 4222:4222 nats:2-alpine -js --user t --pass t
 *   NATS_TEST_URL=nats://localhost:4222 NATS_TEST_USER=t NATS_TEST_PASSWORD=t pnpm vitest run event-plane-nats
 */
const url = process.env.NATS_TEST_URL;

describe.skipIf(!url)('natsPublisher', () => {
  const config = { url: url!, user: process.env.NATS_TEST_USER ?? '', pass: process.env.NATS_TEST_PASSWORD ?? '' };
  const stream = `t_${Date.now()}`;

  afterAll(async () => {
    await closeEventPlane();
  });

  it('publishes through JetStream and collapses a repeated msgID', async () => {
    const nc = await connect({ servers: config.url, user: config.user, pass: config.pass });
    const jsm = await nc.jetstreamManager();
    await jsm.streams.add({ name: stream, subjects: [`${stream}.>`], duplicate_window: 60_000_000_000 });

    const publish = natsPublisher(config);
    const event = { event_id: 'e1', event_type: 'screen.view', ts_ms: 1, tenant_id: 't', source: 'openpanel', data: {} };
    await publish(`${stream}.acme.screen.view`, event as never, 'e1');
    await publish(`${stream}.acme.screen.view`, event as never, 'e1');

    const info = await jsm.streams.info(stream);
    expect(info.state.messages).toBe(1);

    await jsm.streams.delete(stream);
    await nc.close();
  });
});
