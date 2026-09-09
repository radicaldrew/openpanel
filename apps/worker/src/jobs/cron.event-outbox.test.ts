/**
 * The publish contract, against a REAL JetStream where one is reachable.
 *
 * Two layers, deliberately:
 *
 *  - the pure ones (config, backoff, addressing, parking) run everywhere;
 *  - the end-to-end one publishes to the `vero-events` stream and reads the
 *    message back off it, and SKIPS when no NATS is reachable.
 *
 * The end-to-end layer earns its keep because the failure it guards is silent:
 * a wrong subject still publishes, and a malformed envelope is dropped by the
 * consumer with a warning rather than dead-lettered. Asserting the bytes that
 * actually landed on the stream is the only way to know the shape is right.
 *
 * The rows come from a fake repository rather than the real table. That is a
 * real limitation, not a substitute: nothing here proves the drain's SQL. It
 * proves everything between a row and the wire.
 *
 * RUN IT FROM THIS PACKAGE, not the repo root:
 *
 *     cd apps/worker && npx vitest run src/jobs/cron.event-outbox.test.ts
 *
 * A root invocation reports "No test files found" for EVERY test in the repo,
 * not just this one. The root `vitest.config.ts` sets
 * `globalSetup: ['./test/global-setup.ts']`, which connects to
 * `postgres://postgres:postgres@localhost:5432` in the parent process before
 * any worker starts; on a machine where something else holds 5432 that throws
 * and vitest aborts before collecting anything. `vitest.shared.ts`, which the
 * per-package configs use, has no globalSetup — which is why the package
 * directory works.
 */

import { afterAll, describe, expect, it, vi } from 'vitest';

import type { EventOutboxRepo, EventOutboxRow } from './cron.event-outbox';

vi.mock('@openpanel/db', () => ({ db: {} }));
vi.mock('@/utils/logger', () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    }),
  },
}));

const {
  addressRow,
  backoffSeconds,
  EventPlaneConfigError,
  eventOutboxCronJob,
  eventPlaneConfig,
  isEventPlaneEnabled,
} = await import('./cron.event-outbox');

const NATS_URL = process.env.TEST_NATS_URL ?? 'nats://127.0.0.1:14222';

/**
 * A complete config for the drain tests.
 *
 * The credentials are dummies: the LOCAL broker has no auth configured and
 * ignores them. The real broker uses config-file accounts with per-client
 * scoping — the OpenPanel account may publish `vero.events.>` and is REFUSED if
 * it subscribes — so a test that verifies a publish by reading the message back
 * needs the gtmsrv credential, not this one. See the note on the end-to-end
 * block.
 */
const ENV = {
  NATS_URL,
  NATS_USER: process.env.TEST_NATS_USER ?? 'test-publisher',
  NATS_PASSWORD: process.env.TEST_NATS_PASSWORD ?? 'test-publisher',
};

const occurred = new Date('2026-09-09T10:00:00.000Z');

function row(overrides: Partial<EventOutboxRow> = {}): EventOutboxRow {
  return {
    id: 'eo_1',
    projectId: 'proj_1',
    eventId: 'evt_abc',
    eventType: 'repo.connected',
    tenantSlug: 'gitgraph',
    tenantId: '11111111-2222-3333-4444-555555555555',
    occurredAt: occurred,
    data: { profile_id: 'profile_42', session_id: 'sess_1', repo: 'acme/api' },
    attempts: 0,
    ...overrides,
  };
}

/** Records what the drain did, so the assertions are about behaviour not calls. */
function fakeRepo(rows: EventOutboxRow[]) {
  const sent: string[] = [];
  const parked: { id: string; status: string; error: string }[] = [];
  const rescheduled: { id: string; attempts: number; error: string }[] = [];

  const repo: EventOutboxRepo = {
    pending: async () => rows,
    markSent: async (id) => {
      sent.push(id);
    },
    park: async (id, _attempts, status, error) => {
      parked.push({ id, status, error });
    },
    reschedule: async (id, attempts, error) => {
      rescheduled.push({ id, attempts, error });
    },
  };

  return { repo, sent, parked, rescheduled };
}

describe('the drain is off unless it is configured', () => {
  it('is disabled when NATS_URL is unset', () => {
    // Every deployment today is in this state, so it is the only behaviour
    // production has ever run.
    expect(eventPlaneConfig({})).toBeNull();
    expect(isEventPlaneEnabled({})).toBe(false);
  });

  it('takes the url and both halves of the credential', () => {
    expect(
      eventPlaneConfig({
        NATS_URL: 'nats://x:4222',
        NATS_USER: 'openpanel',
        NATS_PASSWORD: 'secret',
      }),
    ).toEqual({ url: 'nats://x:4222', user: 'openpanel', pass: 'secret' });
  });

  it('treats whitespace as unset', () => {
    expect(eventPlaneConfig({ NATS_URL: '   ' })).toBeNull();
  });

  it('refuses to connect unauthenticated, loudly', () => {
    // The failure this prevents: a deployment that asked for the event plane,
    // got the credentials wrong, and quietly behaves as though it were turned
    // off — believing it publishes while publishing nothing.
    const half = { NATS_URL: 'nats://x:4222', NATS_USER: 'openpanel' };

    expect(() => eventPlaneConfig(half)).toThrow(EventPlaneConfigError);
    expect(() => eventPlaneConfig(half)).toThrow(/NATS_PASSWORD is not set/);
    expect(() => eventPlaneConfig({ NATS_URL: 'nats://x:4222' })).toThrow(
      /NATS_USER and NATS_PASSWORD are not set/,
    );
  });

  it('still reports enabled when half-configured, rather than throwing', () => {
    // A predicate that throws is a trap. "Did someone ask for this" and "is it
    // usable" are different questions and only the second one refuses.
    expect(isEventPlaneEnabled({ NATS_URL: 'nats://x:4222' })).toBe(true);
  });

  it('reads no rows and publishes nothing when disabled', async () => {
    const { repo } = fakeRepo([row()]);
    const pending = vi.spyOn(repo, 'pending');

    const result = await eventOutboxCronJob({ env: {}, repo });

    expect(result).toMatchObject({ published: 0, skipped: true });
    // Not merely "published nothing" — it must not even query, or a disabled
    // deployment pays for a table scan every tick.
    expect(pending).not.toHaveBeenCalled();
  });
});

describe('backoff stays inside the stream dedupe window', () => {
  it('climbs and caps at an hour', () => {
    expect(backoffSeconds(1)).toBe(60);
    expect(backoffSeconds(4)).toBe(480);
    expect(backoffSeconds(8)).toBe(3600);
    expect(backoffSeconds(50)).toBe(3600);
  });

  it('exhausts in under the 4-hour duplicate window', () => {
    // The property that makes `Nats-Msg-Id` work across a retry: if the ladder
    // outlasted the window, the last attempt would republish a message the
    // stream had already forgotten and gtmsrv would see it twice.
    const total = Array.from({ length: 8 }, (_, i) => backoffSeconds(i + 1)).reduce(
      (a, b) => a + b,
      0,
    );

    expect(total).toBeLessThan(4 * 60 * 60);
  });
});

describe('a row becomes a subject and an envelope', () => {
  it('addresses it on vero.events.{slug}.{type}', () => {
    const { subject, event } = addressRow(row());

    expect(subject).toBe('vero.events.gitgraph.repo.connected');
    expect(event).toMatchObject({
      schema_version: 1,
      event_type: 'repo.connected',
      tenant_id: '11111111-2222-3333-4444-555555555555',
      source: 'openpanel',
      ts_ms: occurred.getTime(),
    });
  });

  it('carries the tenant slug in the subject and the uuid in the envelope', () => {
    // EVENT-PLANE §5. Getting these the wrong way round is the mistake the
    // slug validator exists to catch.
    const { subject, event } = addressRow(row());

    expect(subject).toContain('gitgraph');
    expect(subject).not.toContain(event.tenant_id);
    expect(event).not.toHaveProperty('tenant_slug');
  });

  it('stamps channel_id and direction into data', () => {
    const { event } = addressRow(row());

    expect(event.data).toMatchObject({
      channel_id: '00000000-0000-0000-0000-000000000000',
      direction: 'internal',
      profile_id: 'profile_42',
      session_id: 'sess_1',
    });
  });

  it('derives the same event_id for the same row every time', () => {
    // What makes a redelivery collapse instead of duplicating.
    expect(addressRow(row()).event.event_id).toBe(addressRow(row()).event.event_id);
    expect(addressRow(row({ eventId: 'evt_other' })).event.event_id).not.toBe(
      addressRow(row()).event.event_id,
    );
  });

  it('refuses an undotted event type', () => {
    // OpenPanel's own names all look like this; the ingest side maps them
    // before they reach a row.
    expect(() => addressRow(row({ eventType: 'repo_connected' }))).toThrow(
      /dotted lowercase/,
    );
  });

  it('refuses a uuid used as a tenant slug', () => {
    expect(() =>
      addressRow(row({ tenantSlug: '11111111-2222-3333-4444-555555555555' })),
    ).toThrow(/that is a UUID/);
  });
});

describe('a poison row does not stall the pipeline', () => {
  it('parks the unaddressable row and publishes the rest', async () => {
    const good = row({ id: 'good' });
    const poison = row({ id: 'poison', eventType: 'repo_connected' });
    const { repo, sent, parked } = fakeRepo([poison, good]);

    const published: string[] = [];
    const result = await eventOutboxCronJob({
      env: ENV,
      repo,
      publish: async (subject) => {
        published.push(subject);
      },
    });

    // The whole point: the poison row is first in the batch and the good one
    // still goes out.
    expect(published).toEqual(['vero.events.gitgraph.repo.connected']);
    expect(sent).toEqual(['good']);
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({ id: 'poison', status: 'invalid' });
    expect(parked[0]?.error).toMatch(/dotted lowercase/);
    expect(result).toMatchObject({ published: 1, invalid: 1, failed: 0 });
  });

  it('reschedules a transient publish failure rather than parking it', async () => {
    const { repo, parked, rescheduled } = fakeRepo([row()]);

    const result = await eventOutboxCronJob({
      env: ENV,
      repo,
      publish: async () => {
        throw new Error('no responders');
      },
    });

    expect(parked).toEqual([]);
    expect(rescheduled).toHaveLength(1);
    expect(rescheduled[0]).toMatchObject({ attempts: 1 });
    expect(result).toMatchObject({ failed: 1, published: 0 });
  });

  it('abandons a row that has exhausted its attempts', async () => {
    const { repo, parked } = fakeRepo([row({ attempts: 7 })]);

    const result = await eventOutboxCronJob({
      env: ENV,
      repo,
      publish: async () => {
        throw new Error('still down');
      },
    });

    expect(parked[0]).toMatchObject({ status: 'abandoned' });
    expect(result).toMatchObject({ abandoned: 1 });
  });
});

/**
 * Credentials for reading messages back.
 *
 * A SECOND account on purpose. The real broker scopes per client: the OpenPanel
 * account may publish `vero.events.>` and is refused if it subscribes, and
 * gtmsrv's may consume and is refused if it publishes. So a test that proves a
 * publish by reading the message back needs both — the publisher's for the
 * drain, a consumer's for the verification. Locally they are the same dummy
 * pair and the unauthenticated broker ignores both.
 *
 * Pointing these at the real broker would make the publish-only account fail
 * the read-back, which is the scoping working rather than a regression.
 */
const CONSUME = {
  user: process.env.TEST_NATS_CONSUME_USER ?? ENV.NATS_USER,
  pass: process.env.TEST_NATS_CONSUME_PASSWORD ?? ENV.NATS_PASSWORD,
};

/** Publisher connection options — what the drain itself would use. */
const publishOpts = () => ({
  servers: ENV.NATS_URL,
  user: ENV.NATS_USER,
  pass: ENV.NATS_PASSWORD,
  timeout: 2000,
});

/** Consumer connection options — what verification uses. */
const consumeOpts = () => ({
  servers: ENV.NATS_URL,
  user: CONSUME.user,
  pass: CONSUME.pass,
  timeout: 2000,
});

/**
 * The end-to-end layer. Skips when no JetStream is reachable, so this cannot
 * turn CI red where there is no NATS.
 */
describe('the message actually lands on the stream', () => {
  /**
   * Subjects this run published, so it can take them back off the stream.
   *
   * The stream is shared — gtmsrv's consumer will read `vero.events.>` — and
   * without this every run leaves messages on it forever. Worse than untidy:
   * the deterministic `event_id` plus the 4-hour duplicate window means a
   * later run's first publish is collapsed against the leftovers and "succeeds"
   * while adding nothing, which is a failure that leaves no trace at either end.
   */
  const publishedSubjects: string[] = [];

  afterAll(async () => {
    if (publishedSubjects.length === 0) {
      return;
    }

    try {
      const { connect } = await import('nats');
      const nc = await connect(consumeOpts());
      const jsm = await nc.jetstreamManager();

      for (const subject of publishedSubjects) {
        // Exact subjects: NATS wildcards match whole tokens, so a `e2e-*`
        // filter matches nothing and would silently purge zero.
        await jsm.streams.purge('vero-events', { filter: subject });
      }

      await nc.drain();
    } catch {
      // Cleanup is best-effort. A broker that went away between the test and
      // here should not turn a passing run red.
    }
  });

  const itNats = (name: string, fn: () => Promise<void>) =>
    it(name, async () => {
      let nc: Awaited<ReturnType<typeof import('nats').connect>> | undefined;
      try {
        const { connect } = await import('nats');
        nc = await connect(publishOpts());
      } catch {
        console.warn(`[event-outbox] skipping: no NATS at ${NATS_URL}`);
        return;
      }
      try {
        await fn();
      } finally {
        await nc.drain();
      }
    });

  itNats('publishes a readable envelope on the right subject', async () => {
    const { connect, headers: natsHeaders } = await import('nats');
    // Two connections, for the reason on `CONSUME`: one publishes, one reads.
    const pub = await connect(publishOpts());
    const sub = await connect(consumeOpts());

    try {
      const js = pub.jetstream();
      const jsm = await sub.jetstreamManager();

      // A subject unique to this run, so the assertion cannot read a message
      // some other run left on the stream.
      // Unique EVENT ID as well as subject. JetStream's `Nats-Msg-Id` dedup is
      // stream-wide, not per-subject, so a fresh subject alone does not isolate
      // a test — a reused event id is collapsed against an earlier run's
      // message and the publish silently succeeds with nothing added.
      const slug = `e2e-${Date.now().toString(36)}`;
      const testRow = row({ tenantSlug: slug, eventId: `evt-${slug}` });

      const { repo, sent } = fakeRepo([testRow]);

      const result = await eventOutboxCronJob({
        env: { ...ENV, NATS_URL },
        repo,
        publish: async (subject, event, msgId) => {
          const h = natsHeaders();
          h.set('Nats-Msg-Id', msgId);
          await js.publish(subject, JSON.stringify(event), { headers: h });
        },
      });

      expect(result).toMatchObject({ published: 1, failed: 0, invalid: 0 });
      expect(sent).toEqual(['eo_1']);

      // Read it back off the stream itself, not from the publish call.
      const expectedSubject = `vero.events.${slug}.repo.connected`;
      publishedSubjects.push(expectedSubject);
      const stored = await jsm.streams.getMessage('vero-events', {
        last_by_subj: expectedSubject,
      });

      expect(stored.subject).toBe(expectedSubject);

      const envelope = JSON.parse(new TextDecoder().decode(stored.data));
      expect(envelope).toMatchObject({
        schema_version: 1,
        event_type: 'repo.connected',
        source: 'openpanel',
        tenant_id: testRow.tenantId,
        ts_ms: occurred.getTime(),
        data: {
          channel_id: '00000000-0000-0000-0000-000000000000',
          direction: 'internal',
          profile_id: 'profile_42',
        },
      });
      // The dedup key the stream was told about has to be the envelope's own.
      expect(stored.header?.get('Nats-Msg-Id')).toBe(envelope.event_id);
    } finally {
      await pub.drain();
      await sub.drain();
    }
  });

  itNats('a redelivery of the same row does not add a second message', async () => {
    const { connect, headers: natsHeaders } = await import('nats');
    const pub = await connect(publishOpts());
    const sub = await connect(consumeOpts());

    try {
      const js = pub.jetstream();
      const jsm = await sub.jetstreamManager();

      const slug = `dedupe-${Date.now().toString(36)}`;
      const testRow = row({ tenantSlug: slug, eventId: `evt-${slug}` });
      const subject = `vero.events.${slug}.repo.connected`;
      publishedSubjects.push(subject);

      const publish = async (
        s: string,
        event: Record<string, unknown>,
        msgId: string,
      ) => {
        const h = natsHeaders();
        h.set('Nats-Msg-Id', msgId);
        await js.publish(s, JSON.stringify(event), { headers: h });
      };

      const before = (await jsm.streams.info('vero-events')).state.messages;

      // The same row drained twice — what a retry after an uncertain publish
      // actually looks like.
      for (let i = 0; i < 2; i += 1) {
        const { repo } = fakeRepo([testRow]);
        await eventOutboxCronJob({
          env: { ...ENV, NATS_URL },
          repo,
          publish: publish as never,
        });
      }

      const after = (await jsm.streams.info('vero-events')).state.messages;

      // One message, not two: the duplicate window collapsed the second.
      expect(after - before).toBe(1);
      expect((await jsm.streams.getMessage('vero-events', { last_by_subj: subject })).subject).toBe(
        subject,
      );
    } finally {
      await pub.drain();
      await sub.drain();
    }
  });
});
