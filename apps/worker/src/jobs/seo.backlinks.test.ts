/**
 * Backlink snapshots against a fake DataForSEO.
 *
 * The transport is the real one from @openpanel/dataforseo with `fetchImpl`
 * replaced, and the row builder is the real one from @openpanel/db, so what
 * is exercised is the request DFS would see (summary + 30-day history for the
 * configured domain), how the two responses fold into one row per day, and
 * the guards that keep the job from spending: no domain, spend cap.
 */

import { createDataforseoTransport } from '@openpanel/dataforseo';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fns } = vi.hoisted(() => ({
  fns: {
    getSeoProjectConfig: vi.fn(),
    getProjectOrganizationId: vi.fn(),
    isDfsSpendCapReached: vi.fn(),
    getDfsClientForProject: vi.fn(),
    insertBacklinkSnapshots: vi.fn(),
  },
}));

vi.mock('@openpanel/db', async () => {
  // Real DFS → row mapping; only storage and lookups are stubbed.
  const backlinks = await import('../../../../packages/db/src/seo/backlinks');
  return {
    ...fns,
    fetchBacklinkSnapshots: backlinks.fetchBacklinkSnapshots,
    buildBacklinkSnapshots: backlinks.buildBacklinkSnapshots,
  };
});
vi.mock('../utils/logger', () => {
  const noop = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger: { ...noop, child: () => noop } };
});

const { seoBacklinkSnapshotJob } = await import('./seo.backlinks');

interface Recorded {
  path: string;
  body: unknown;
}

function envelope(tasks: unknown[], cost = 0) {
  return { status_code: 20_000, status_message: 'Ok.', cost, tasks };
}

function okTask(path: string[], result: unknown[], cost: number) {
  return { status_code: 20_000, status_message: 'Ok.', path, cost, result };
}

function fakeDfs(handlers: Record<string, (body: unknown) => unknown>) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    const handler = handlers[path];
    if (!handler) {
      return new Response(JSON.stringify({ status_code: 40_400 }), { status: 404 });
    }
    return new Response(JSON.stringify(handler(body)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const transport = createDataforseoTransport({ apiKey: 'dGVzdA==', fetchImpl });
  return { calls, client: { transport } };
}

function job(payload: { projectId: string }) {
  return { data: { type: 'seoBacklinkSnapshot', payload } } as never;
}

const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

const summaryItem = {
  target: 'me.com',
  rank: 42,
  backlinks: 1200,
  referring_domains: 80,
  referring_ips: 70,
  referring_pages: 900,
  broken_backlinks: 3,
  new_backlinks: 5,
  lost_backlinks: 2,
  backlinks_spam_score: 12,
};

const historyItems = [
  {
    date: `${yesterday} 00:00:00 +00:00`,
    rank: 41,
    backlinks: 1195,
    referring_domains: 79,
    referring_ips: 69,
    new_backlinks: 4,
    lost_backlinks: 1,
    backlinks_spam_score: 12,
  },
  // Same day as the live summary: the summary must win.
  {
    date: `${today} 00:00:00 +00:00`,
    rank: 40,
    backlinks: 1000,
    referring_domains: 70,
    new_backlinks: 0,
    lost_backlinks: 0,
  },
  // No date: dropped.
  { rank: 1, backlinks: 1 },
];

beforeEach(() => {
  vi.clearAllMocks();
  fns.getSeoProjectConfig.mockResolvedValue({ domain: 'me.com' });
  fns.getProjectOrganizationId.mockResolvedValue('org_1');
  fns.isDfsSpendCapReached.mockResolvedValue(false);
  fns.insertBacklinkSnapshots.mockResolvedValue(undefined);
});

describe('seoBacklinkSnapshotJob', () => {
  it('fetches summary + 30-day history and stores one row per day', async () => {
    const dfs = fakeDfs({
      '/v3/backlinks/summary/live': () =>
        envelope([okTask(['v3', 'backlinks', 'summary', 'live'], [summaryItem], 0.02)], 0.02),
      '/v3/backlinks/history/live': () =>
        envelope([okTask(['v3', 'backlinks', 'history', 'live'], [{ items: historyItems }], 0.03)], 0.03),
    });
    fns.getDfsClientForProject.mockResolvedValue(dfs.client);

    const result = await seoBacklinkSnapshotJob(job({ projectId: 'p1' }));

    expect(result).toEqual({ rows: 2, costUsd: 0.05 });
    expect(dfs.calls.map((call) => call.path).sort()).toEqual([
      '/v3/backlinks/history/live',
      '/v3/backlinks/summary/live',
    ]);

    const summaryCall = dfs.calls.find((call) => call.path.endsWith('/summary/live'));
    expect(summaryCall?.body).toMatchObject([
      { target: 'me.com', include_subdomains: true, rank_scale: 'one_hundred' },
    ]);
    const historyCall = dfs.calls.find((call) => call.path.endsWith('/history/live'));
    const historyBody = (
      historyCall?.body as { target: string; date_from: string; date_to: string }[]
    )[0]!;
    expect(historyBody.target).toBe('me.com');
    expect(historyBody.date_to).toBe(today);
    const spanDays =
      (Date.parse(historyBody.date_to) - Date.parse(historyBody.date_from)) / 86_400_000;
    expect(spanDays).toBe(30);

    const rows = fns.insertBacklinkSnapshots.mock.calls[0]?.[0];
    expect(rows).toEqual([
      expect.objectContaining({
        projectId: 'p1',
        date: yesterday,
        backlinks: 1195,
        referringDomains: 79,
        referringIps: 69,
        rank: 41,
        spamScore: 12,
        newBacklinks: 4,
        lostBacklinks: 1,
      }),
      expect.objectContaining({
        projectId: 'p1',
        date: today,
        // From the live summary, not the same-day history item.
        backlinks: 1200,
        referringDomains: 80,
        referringIps: 70,
        rank: 42,
        spamScore: 12,
        newBacklinks: 5,
        lostBacklinks: 2,
      }),
    ]);
  });

  it('still stores the history when DataForSEO knows nothing about the target', async () => {
    const dfs = fakeDfs({
      // An unknown domain comes back as a null result, not a failed task.
      '/v3/backlinks/summary/live': () =>
        envelope([okTask(['v3', 'backlinks', 'summary', 'live'], [null], 0.02)], 0.02),
      '/v3/backlinks/history/live': () =>
        envelope([okTask(['v3', 'backlinks', 'history', 'live'], [{ items: [historyItems[0]] }], 0.03)], 0.03),
    });
    fns.getDfsClientForProject.mockResolvedValue(dfs.client);

    const result = await seoBacklinkSnapshotJob(job({ projectId: 'p1' }));

    expect(result).toEqual({ rows: 1, costUsd: 0.05 });
    expect(fns.insertBacklinkSnapshots.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ date: yesterday, backlinks: 1195 }),
    ]);
  });

  it('stops before spending anything when the cap is reached', async () => {
    fns.isDfsSpendCapReached.mockResolvedValue(true);

    const result = await seoBacklinkSnapshotJob(job({ projectId: 'p1' }));

    expect(result).toEqual({ skipped: 'spend-cap' });
    expect(fns.getDfsClientForProject).not.toHaveBeenCalled();
    expect(fns.insertBacklinkSnapshots).not.toHaveBeenCalled();
  });

  it('skips projects without a configured domain', async () => {
    fns.getSeoProjectConfig.mockResolvedValue({ domain: '' });

    await expect(seoBacklinkSnapshotJob(job({ projectId: 'p1' }))).resolves.toEqual({
      skipped: 'no-domain',
    });
    fns.getSeoProjectConfig.mockResolvedValue(null);
    await expect(seoBacklinkSnapshotJob(job({ projectId: 'p1' }))).resolves.toEqual({
      skipped: 'no-config',
    });
    expect(fns.getDfsClientForProject).not.toHaveBeenCalled();
  });

  it('propagates a DataForSEO failure so BullMQ retries the job', async () => {
    const dfs = fakeDfs({
      '/v3/backlinks/summary/live': () => ({
        status_code: 40_200,
        status_message: 'Payment Required.',
        tasks: [],
      }),
      '/v3/backlinks/history/live': () =>
        envelope([okTask(['v3', 'backlinks', 'history', 'live'], [{ items: [] }], 0.03)], 0.03),
    });
    fns.getDfsClientForProject.mockResolvedValue(dfs.client);

    await expect(seoBacklinkSnapshotJob(job({ projectId: 'p1' }))).rejects.toMatchObject({
      kind: 'billing',
      dfsStatusCode: 40_200,
    });
    expect(fns.insertBacklinkSnapshots).not.toHaveBeenCalled();
  });
});
