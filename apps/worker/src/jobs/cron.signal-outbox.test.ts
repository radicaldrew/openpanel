/**
 * The delivery contract, tested with no gtmsrv running.
 *
 * The thing this talks to is a different service in a different repository, so
 * the POST is stubbed and what is asserted is the shape of the request and what
 * each response class does to the row. The two properties worth protecting are
 * that `occurred_at` is top level and that a retry carries the same dedupe key —
 * both are silent failures otherwise: the signal still arrives, just dated
 * wrong or duplicated.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMock } = vi.hoisted(() => ({
  dbMock: {
    signalOutbox: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('@openpanel/db', () => ({ db: dbMock }));
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
  backoffSeconds,
  isSignalSinkEnabled,
  signalOutboxCronJob,
  signalSinkConfig,
  toSignalRequest,
} = await import('./cron.signal-outbox');

const env = { GTMSRV_URL: 'https://gtm.example.com', GTMSRV_INGEST_TOKEN: 'tok' };

const now = new Date('2026-09-04T12:00:00.000Z');
const occurred = new Date('2026-09-04T11:30:00.000Z');

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ob_1',
    dedupeKey: 'op_abc123',
    kind: 'pricing_page_visit',
    strength: 60,
    source: 'OpenPanel',
    subjectKind: 'person',
    subjectId: 'profile_42',
    occurredAt: occurred,
    evidence: { event: 'pricing_page_view', profile_id: 'profile_42' },
    attempts: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.signalOutbox.update.mockResolvedValue({});
});

describe('configuration', () => {
  it('has no default host', () => {
    // A compiled-in default would mean a misconfigured deployment quietly posts
    // real people's behaviour somewhere nobody chose.
    expect(signalSinkConfig({})).toBeNull();
    expect(signalSinkConfig({ GTMSRV_URL: 'https://x' })).toBeNull();
    expect(signalSinkConfig({ GTMSRV_INGEST_TOKEN: 'tok' })).toBeNull();
    expect(isSignalSinkEnabled({})).toBe(false);
  });

  it('trims a trailing slash so the path is not doubled', () => {
    expect(signalSinkConfig({ ...env, GTMSRV_URL: 'https://gtm.example.com/' }))
      .toEqual({ url: 'https://gtm.example.com', token: 'tok' });
  });

  it('does nothing at all when unconfigured', async () => {
    const post = vi.fn();
    const res = await signalOutboxCronJob({ env: {}, post, now: () => now });
    expect(res.skipped).toBe(true);
    expect(post).not.toHaveBeenCalled();
    expect(dbMock.signalOutbox.findMany).not.toHaveBeenCalled();
  });
});

describe('the request body', () => {
  it('puts occurred_at at the top level, in RFC 3339', () => {
    // gtmsrv reads occurred_at from the body, not from evidence. A copy in
    // evidence alone is inert and the signal silently carries receipt time —
    // which makes SPEC §6's "4d after" count from when a backlog drained.
    const body = toSignalRequest(row());
    expect(body.occurred_at).toBe('2026-09-04T11:30:00.000Z');
    expect(new Date(body.occurred_at).toISOString()).toBe(body.occurred_at);
  });

  it('sends the dedupe key gtmsrv requires', () => {
    expect(toSignalRequest(row()).dedupe_key).toBe('op_abc123');
  });

  it('maps an identified profile to a person subject', () => {
    expect(toSignalRequest(row()).subject).toEqual({
      kind: 'person',
      id: 'profile_42',
    });
  });

  it('omits subject entirely when nobody was identified', () => {
    // Not a blank subject: gtmsrv opens a lead from one, and an invented ref
    // attaches a stranger's browsing to somebody else's timeline.
    const body = toSignalRequest(row({ subjectKind: null, subjectId: null }));
    expect(body.subject).toBeUndefined();
    expect(Object.hasOwn(body, 'subject')).toBe(false);
  });

  it('keeps the profile id in evidence so a lead can be traced back', () => {
    expect(toSignalRequest(row()).evidence).toMatchObject({
      profile_id: 'profile_42',
    });
  });
});

describe('delivery', () => {
  it('marks a row sent on 2xx and authenticates as a bearer', async () => {
    dbMock.signalOutbox.findMany.mockResolvedValue([row()]);
    const post = vi.fn().mockResolvedValue({ status: 200, text: async () => 'ok' });

    const res = await signalOutboxCronJob({ env, post, now: () => now });

    expect(res.delivered).toBe(1);
    const [url, init] = post.mock.calls[0]!;
    expect(url).toBe('https://gtm.example.com/ingest/signal');
    expect(init.headers.authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body).kind).toBe('pricing_page_visit');
    expect(dbMock.signalOutbox.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ob_1' },
        data: expect.objectContaining({ status: 'sent', sentAt: now }),
      })
    );
  });

  it('reschedules with backoff on 5xx and keeps the row pending', async () => {
    dbMock.signalOutbox.findMany.mockResolvedValue([row()]);
    const post = vi.fn().mockResolvedValue({ status: 503, text: async () => 'down' });

    const res = await signalOutboxCronJob({ env, post, now: () => now });

    expect(res.failed).toBe(1);
    const data = dbMock.signalOutbox.update.mock.calls[0]![0].data;
    expect(data.status).toBeUndefined(); // still pending
    expect(data.attempts).toBe(1);
    expect(data.nextAttemptAt.getTime()).toBe(now.getTime() + 60_000);
  });

  it('retries a network failure rather than dropping the signal', async () => {
    dbMock.signalOutbox.findMany.mockResolvedValue([row()]);
    const post = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await signalOutboxCronJob({ env, post, now: () => now });

    expect(res.failed).toBe(1);
    expect(dbMock.signalOutbox.update.mock.calls[0]![0].data.lastError).toContain(
      'ECONNREFUSED'
    );
  });

  it('re-sends the identical dedupe key on a retry', async () => {
    // The whole safety argument for retrying: gtmsrv collapses the repeat. A
    // key that varied per attempt would make every retry a second signal — and
    // on the outreach path, a second email.
    dbMock.signalOutbox.findMany.mockResolvedValue([row({ attempts: 2 })]);
    const post = vi.fn().mockResolvedValue({ status: 200, text: async () => '' });

    await signalOutboxCronJob({ env, post, now: () => now });

    expect(JSON.parse(post.mock.calls[0]![1].body).dedupe_key).toBe('op_abc123');
  });

  it('abandons a bad body immediately instead of retrying forever', async () => {
    // A missing dedupe_key will be missing again on every retry. Retrying it
    // buries the failures that are worth retrying.
    dbMock.signalOutbox.findMany.mockResolvedValue([row()]);
    const post = vi
      .fn()
      .mockResolvedValue({ status: 400, text: async () => 'dedupe_key is required' });

    const res = await signalOutboxCronJob({ env, post, now: () => now });

    expect(res.abandoned).toBe(1);
    expect(dbMock.signalOutbox.update.mock.calls[0]![0].data).toMatchObject({
      status: 'abandoned',
    });
  });

  it('treats 429 as later, not never', async () => {
    dbMock.signalOutbox.findMany.mockResolvedValue([row()]);
    const post = vi.fn().mockResolvedValue({ status: 429, text: async () => '' });

    const res = await signalOutboxCronJob({ env, post, now: () => now });

    expect(res.abandoned).toBe(0);
    expect(res.failed).toBe(1);
  });

  it('parks a disabled source rather than retrying or abandoning it', async () => {
    // 403 means the operator switched the source off. Retrying would be
    // arguing with them; abandoning would be deciding for them that the backlog
    // was disposable. Both guess at an intent the code cannot know, so the rows
    // stop and wait for a person.
    dbMock.signalOutbox.findMany.mockResolvedValue([row()]);
    const post = vi.fn().mockResolvedValue({
      status: 403,
      text: async () => 'source "OpenPanel" is disabled; its signals are not being accepted.',
    });

    const res = await signalOutboxCronJob({ env, post, now: () => now });

    expect(res.paused).toBe(1);
    expect(res.abandoned).toBe(0);
    expect(res.failed).toBe(0);
    expect(dbMock.signalOutbox.update.mock.calls[0]![0].data).toMatchObject({
      status: 'paused',
    });
  });

  it('does not spend a retry attempt on a pause', async () => {
    // A pause of any length must not eat the retry budget that exists for
    // transient failures — otherwise a long pause silently exhausts it and the
    // first real failure after release is the last one.
    dbMock.signalOutbox.findMany.mockResolvedValue([row({ attempts: 3 })]);
    const post = vi.fn().mockResolvedValue({ status: 403, text: async () => 'disabled' });

    await signalOutboxCronJob({ env, post, now: () => now });

    const data = dbMock.signalOutbox.update.mock.calls[0]![0].data;
    expect(data.attempts).toBeUndefined();
    expect(data.nextAttemptAt).toBeUndefined();
  });

  it('never picks a parked row back up on its own', async () => {
    // The drain asks only for pending work. Parked rows move when a person
    // moves them, which is the whole point.
    dbMock.signalOutbox.findMany.mockResolvedValue([]);
    await signalOutboxCronJob({ env, post: vi.fn(), now: () => now });

    expect(dbMock.signalOutbox.findMany.mock.calls[0]![0].where.status).toBe('pending');
  });

  it('retries a 401 so a credential rotation does not lose the queue', async () => {
    dbMock.signalOutbox.findMany.mockResolvedValue([row()]);
    const post = vi.fn().mockResolvedValue({ status: 401, text: async () => 'unauthorized' });

    const res = await signalOutboxCronJob({ env, post, now: () => now });

    expect(res.abandoned).toBe(0);
    expect(res.failed).toBe(1);
  });

  it('names this producer so gtmsrv can say who is on the shared token', async () => {
    // gtmsrv logs `source_claimed` from this header beside its "issue this
    // producer its own source credential" warning. Without it the warning says
    // something is on the shared token but not what.
    dbMock.signalOutbox.findMany.mockResolvedValue([row()]);
    const post = vi.fn().mockResolvedValue({ status: 200, text: async () => '' });

    await signalOutboxCronJob({ env, post, now: () => now });

    expect(post.mock.calls[0]![1].headers['x-gtm-source']).toBe('OpenPanel signal sink');
  });

  it('abandons after the attempt ceiling', async () => {
    dbMock.signalOutbox.findMany.mockResolvedValue([row({ attempts: 7 })]);
    const post = vi.fn().mockResolvedValue({ status: 500, text: async () => '' });

    await signalOutboxCronJob({ env, post, now: () => now });

    expect(dbMock.signalOutbox.update.mock.calls[0]![0].data).toMatchObject({
      status: 'abandoned',
      attempts: 8,
    });
  });

  it('only claims rows that are pending and due', async () => {
    dbMock.signalOutbox.findMany.mockResolvedValue([]);
    await signalOutboxCronJob({ env, post: vi.fn(), now: () => now });

    expect(dbMock.signalOutbox.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'pending', nextAttemptAt: { lte: now } },
      })
    );
  });

  it('keeps going after one row fails', async () => {
    dbMock.signalOutbox.findMany.mockResolvedValue([
      row({ id: 'ob_1' }),
      row({ id: 'ob_2', dedupeKey: 'op_def456' }),
    ]);
    const post = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ status: 200, text: async () => '' });

    const res = await signalOutboxCronJob({ env, post, now: () => now });

    expect(res.failed).toBe(1);
    expect(res.delivered).toBe(1);
  });
});

describe('backoff', () => {
  it('grows and then caps at an hour', () => {
    expect(backoffSeconds(1)).toBe(60);
    expect(backoffSeconds(2)).toBe(120);
    expect(backoffSeconds(3)).toBe(240);
    expect(backoffSeconds(20)).toBe(3600);
  });
});
