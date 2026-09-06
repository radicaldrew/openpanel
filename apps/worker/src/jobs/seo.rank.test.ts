/**
 * Rank runs against a fake DataForSEO.
 *
 * The transport is the real one from @openpanel/dataforseo with `fetchImpl`
 * replaced, so what is exercised is the request shape DFS would see and the
 * bookkeeping each response class does to the run: batching at 100, the
 * poll backoff, partial failures that still finish the run, the 2h deadline
 * that fails it with data kept, and the spend cap that stops it before any
 * money is spent.
 */

import { createDataforseoTransport } from '@openpanel/dataforseo';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMock, fns, queueMock } = vi.hoisted(() => ({
  dbMock: { seoTrackedKeyword: { findMany: vi.fn() } },
  fns: {
    getRankRun: vi.fn(),
    getSeoProjectConfig: vi.fn(),
    getProjectOrganizationId: vi.fn(),
    isDfsSpendCapReached: vi.fn(),
    getDfsClientForProject: vi.fn(),
    markRankRunRunning: vi.fn(),
    addRankRunProgress: vi.fn(),
    completeRankRun: vi.fn(),
    failRankRun: vi.fn(),
    insertRankSnapshots: vi.fn(),
  },
  queueMock: { add: vi.fn() },
}));

vi.mock('@openpanel/db', () => ({
  db: dbMock,
  SPEND_CAP_ERROR: 'spend cap reached',
  ...fns,
}));
vi.mock('@openpanel/queue', () => ({ seoQueue: queueMock }));
vi.mock('../utils/logger', () => {
  const noop = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger: { ...noop, child: () => noop } };
});

const { pollDelaySeconds, seoRankRunJob, seoRankTaskPollJob } = await import(
  './seo.rank'
);

// ---------------------------------------------------------------------------
// Fake DataForSEO
// ---------------------------------------------------------------------------

interface Recorded {
  path: string;
  body: unknown;
}

function envelope(tasks: unknown[], cost = 0) {
  return { status_code: 20_000, status_message: 'Ok.', cost, tasks };
}

function organic(domain: string, position: number) {
  return {
    type: 'organic',
    rank_group: position,
    rank_absolute: position,
    domain,
    url: `https://${domain}/p${position}`,
  };
}

const SERP_PATH = ['v3', 'serp', 'google', 'organic', 'live', 'advanced'];

function serpResultTask(id: string, items: unknown[], cost = 0.002) {
  return {
    id,
    status_code: 20_000,
    status_message: 'Ok.',
    cost,
    path: SERP_PATH,
    result: [{ items }],
  };
}

/**
 * Routes each DFS path to a handler; records every request so tests can
 * assert on batching and payload shape.
 */
function fakeDfs(
  handlers: Record<string, (body: unknown, calls: Recorded[]) => unknown>
) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const path = new URL(url).pathname;
    const rawBody = init?.body ?? (input instanceof Request ? await input.text() : undefined);
    const body = rawBody ? JSON.parse(String(rawBody)) : undefined;
    calls.push({ path, body });
    const handler = Object.entries(handlers).find(([prefix]) =>
      path.startsWith(prefix)
    )?.[1];
    if (!handler) {
      return new Response(JSON.stringify({ status_code: 40_400 }), { status: 404 });
    }
    return new Response(JSON.stringify(handler(body, calls)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const transport = createDataforseoTransport({ apiKey: 'dGVzdA==', fetchImpl });
  return { calls, client: { transport } };
}

function job<T>(payload: T) {
  return { data: { type: 'x', payload } } as never;
}

const config = {
  domain: 'me.com',
  locationCode: 2840,
  languageCode: 'en',
  devices: 'both',
  serpDepth: 20,
};

function keywords(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `kw_${index + 1}`,
    keyword: `keyword ${index + 1}`,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  fns.getRankRun.mockResolvedValue({
    id: 'run_1',
    projectId: 'p1',
    status: 'pending',
    startedAt: new Date(),
  });
  fns.getSeoProjectConfig.mockResolvedValue(config);
  fns.getProjectOrganizationId.mockResolvedValue('org_1');
  fns.isDfsSpendCapReached.mockResolvedValue(false);
  queueMock.add.mockResolvedValue(undefined);
});

describe('pollDelaySeconds', () => {
  it('backs off 60 → 120 → 300 and then doubles, capped at 30 minutes', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(pollDelaySeconds)).toEqual([
      60, 120, 300, 600, 1200, 1800, 1800,
    ]);
  });
});

describe('seoRankRunJob', () => {
  it('stops before spending anything when the cap is reached', async () => {
    dbMock.seoTrackedKeyword.findMany.mockResolvedValue(keywords(3));
    fns.isDfsSpendCapReached.mockResolvedValue(true);

    await seoRankRunJob(job({ projectId: 'p1', runId: 'run_1' }));

    expect(fns.failRankRun).toHaveBeenCalledWith('run_1', 'spend cap reached');
    expect(fns.getDfsClientForProject).not.toHaveBeenCalled();
    expect(fns.markRankRunRunning).not.toHaveBeenCalled();
  });

  it('does not restart a run that is no longer pending', async () => {
    fns.getRankRun.mockResolvedValue({ id: 'run_1', status: 'running' });

    await seoRankRunJob(job({ projectId: 'p1', runId: 'run_1' }));

    expect(dbMock.seoTrackedKeyword.findMany).not.toHaveBeenCalled();
    expect(fns.failRankRun).not.toHaveBeenCalled();
  });

  it('uses live/advanced for small runs and completes in one go', async () => {
    dbMock.seoTrackedKeyword.findMany.mockResolvedValue(keywords(2));
    const dfs = fakeDfs({
      '/v3/serp/google/organic/live/advanced': (body) => {
        const task = (body as { keyword: string; device: string }[])[0]!;
        // Only "keyword 1" on desktop ranks; everything else is out of range.
        const items =
          task.keyword === 'keyword 1' && task.device === 'desktop'
            ? [organic('rival.com', 1), organic('me.com', 2), organic('x.org', 3)]
            : [organic('rival.com', 1)];
        return envelope([serpResultTask('t', items, 0.002)], 0.002);
      },
    });
    fns.getDfsClientForProject.mockResolvedValue(dfs.client);

    await seoRankRunJob(job({ projectId: 'p1', runId: 'run_1' }));

    // 2 keywords × both devices = 4 checks, all live.
    expect(fns.markRankRunRunning).toHaveBeenCalledWith('run_1', 4);
    expect(dfs.calls).toHaveLength(4);
    expect(dfs.calls.every((c) => c.path.endsWith('/live/advanced'))).toBe(true);

    const snapshots = fns.insertRankSnapshots.mock.calls[0]?.[0];
    expect(snapshots).toHaveLength(4);
    const ranked = snapshots.find(
      (s: { keyword: string; device: string }) =>
        s.keyword === 'keyword 1' && s.device === 'desktop'
    );
    expect(ranked).toMatchObject({
      position: 2,
      url: 'https://me.com/p2',
      runId: 'run_1',
      competitors: [
        { domain: 'rival.com', position: 1 },
        { domain: 'me.com', position: 2 },
        { domain: 'x.org', position: 3 },
      ],
    });
    expect(
      snapshots.filter((s: { position: number | null }) => s.position === null)
    ).toHaveLength(3);

    expect(fns.addRankRunProgress).toHaveBeenCalledWith('run_1', {
      checked: 4,
      costUsd: expect.closeTo(0.008, 6),
    });
    expect(fns.completeRankRun).toHaveBeenCalledWith('run_1', { warning: null });
    expect(queueMock.add).not.toHaveBeenCalled();
  });

  it('keeps going when one live check fails and records it as a warning', async () => {
    dbMock.seoTrackedKeyword.findMany.mockResolvedValue(keywords(1));
    fns.getSeoProjectConfig.mockResolvedValue({ ...config, devices: 'both' });
    let calls = 0;
    const dfs = fakeDfs({
      '/v3/serp/google/organic/live/advanced': () => {
        calls += 1;
        if (calls === 1) {
          return { status_code: 40_000, status_message: 'boom', tasks: [] };
        }
        return envelope([serpResultTask('t', [organic('me.com', 4)])]);
      },
    });
    fns.getDfsClientForProject.mockResolvedValue(dfs.client);

    await seoRankRunJob(job({ projectId: 'p1', runId: 'run_1' }));

    expect(fns.insertRankSnapshots.mock.calls[0]?.[0]).toHaveLength(1);
    expect(fns.addRankRunProgress).toHaveBeenCalledWith(
      'run_1',
      expect.objectContaining({ checked: 2 })
    );
    expect(fns.completeRankRun).toHaveBeenCalledWith('run_1', {
      warning: expect.stringMatching(/^1 check\(s\) failed/),
    });
  });

  it('posts queued tasks in batches of 100 and schedules the first poll at 60s', async () => {
    vi.stubEnv('SEO_RANK_TASK_PRIORITY', '2');
    // 120 keywords × desktop only = 120 checks → 100 + 20.
    dbMock.seoTrackedKeyword.findMany.mockResolvedValue(keywords(120));
    fns.getSeoProjectConfig.mockResolvedValue({ ...config, devices: 'desktop' });
    let taskCounter = 0;
    const dfs = fakeDfs({
      '/v3/serp/google/organic/task_post': (body) => {
        const tasks = body as { tag: string }[];
        return {
          status_code: 20_000,
          cost: 0.0006 * tasks.length,
          tasks: tasks.map((task, index) => {
            taskCounter += 1;
            // Reject one task in the first batch to exercise the bookkeeping.
            const rejected = taskCounter === 1 && index === 0;
            return {
              id: `task_${taskCounter}`,
              status_code: rejected ? 40_501 : 20_100,
              status_message: rejected ? 'Invalid Field' : 'Task Created.',
              cost: 0.0006,
              data: { tag: task.tag },
            };
          }),
        };
      },
    });
    fns.getDfsClientForProject.mockResolvedValue(dfs.client);

    await seoRankRunJob(job({ projectId: 'p1', runId: 'run_1' }));

    expect(dfs.calls.map((c) => (c.body as unknown[]).length)).toEqual([100, 20]);
    expect(dfs.calls[0]?.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          keyword: 'keyword 1',
          device: 'desktop',
          depth: 20,
          priority: 2,
          tag: 'kw_1:desktop',
        }),
      ])
    );
    expect(dfs.calls[0]?.body).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ postback_url: expect.anything() })])
    );

    // The rejected task counts as processed; cost is the sum of both posts.
    expect(fns.addRankRunProgress).toHaveBeenCalledWith('run_1', {
      checked: 1,
      costUsd: expect.closeTo(0.072, 6),
    });
    expect(fns.completeRankRun).not.toHaveBeenCalled();

    const [name, payload, options] = queueMock.add.mock.calls[0]!;
    expect(name).toBe('seoRankTaskPoll');
    expect(payload.payload.taskIds).toHaveLength(119);
    expect(payload.payload.attempt).toBe(0);
    expect(options).toEqual({ delay: 60_000, jobId: 'seoRankTaskPoll:run_1:0' });
  });

  it('fails the run if the client throws after it started', async () => {
    dbMock.seoTrackedKeyword.findMany.mockResolvedValue(keywords(1));
    fns.getDfsClientForProject.mockRejectedValue(new Error('no key'));

    await expect(
      seoRankRunJob(job({ projectId: 'p1', runId: 'run_1' }))
    ).rejects.toThrow('no key');
    expect(fns.failRankRun).toHaveBeenCalledWith('run_1', 'no key');
  });
});

describe('seoRankTaskPollJob', () => {
  const running = {
    id: 'run_1',
    projectId: 'p1',
    status: 'running',
    startedAt: new Date(),
  };

  it('re-enqueues with the next backoff when nothing is ready', async () => {
    fns.getRankRun.mockResolvedValue(running);
    const dfs = fakeDfs({
      '/v3/serp/google/organic/tasks_ready': () =>
        envelope([{ id: 'r', status_code: 20_000, result: [] }]),
    });
    fns.getDfsClientForProject.mockResolvedValue(dfs.client);

    await seoRankTaskPollJob(
      job({ projectId: 'p1', runId: 'run_1', taskIds: ['t1', 't2'], attempt: 1 })
    );

    expect(fns.insertRankSnapshots).not.toHaveBeenCalled();
    expect(queueMock.add).toHaveBeenCalledWith(
      'seoRankTaskPoll',
      expect.objectContaining({
        payload: { projectId: 'p1', runId: 'run_1', taskIds: ['t1', 't2'], attempt: 2 },
      }),
      { delay: 300_000, jobId: 'seoRankTaskPoll:run_1:2' }
    );
  });

  it('collects ready tasks, keeps polling for the rest, then completes', async () => {
    fns.getRankRun.mockResolvedValue(running);
    dbMock.seoTrackedKeyword.findMany.mockResolvedValue([
      { id: 'kw_1', keyword: 'keyword 1' },
      { id: 'kw_2', keyword: 'keyword 2' },
    ]);
    const dfs = fakeDfs({
      '/v3/serp/google/organic/tasks_ready': () =>
        envelope([
          {
            id: 'r',
            status_code: 20_000,
            result: [
              { id: 't1', tag: 'kw_1:desktop' },
              { id: 't2', tag: 'kw_2:mobile' },
              { id: 'someone-elses', tag: 'zz:desktop' },
            ],
          },
        ]),
      '/v3/serp/google/organic/task_get/advanced/t1': () =>
        envelope([serpResultTask('t1', [organic('me.com', 3)], 0.0006)]),
      '/v3/serp/google/organic/task_get/advanced/t2': () =>
        envelope([
          { id: 't2', status_code: 40_102, status_message: 'No Search Results.', result: null },
        ]),
    });
    fns.getDfsClientForProject.mockResolvedValue(dfs.client);

    await seoRankTaskPollJob(
      job({ projectId: 'p1', runId: 'run_1', taskIds: ['t1', 't2', 't3'], attempt: 0 })
    );

    // Only this run's tasks are fetched; the stranger's task is ignored.
    expect(
      dfs.calls.filter((c) => c.path.includes('/task_get/')).map((c) => c.path)
    ).toEqual([
      '/v3/serp/google/organic/task_get/advanced/t1',
      '/v3/serp/google/organic/task_get/advanced/t2',
    ]);
    const snapshots = fns.insertRankSnapshots.mock.calls[0]?.[0];
    expect(snapshots).toEqual([
      expect.objectContaining({ keyword: 'keyword 1', device: 'desktop', position: 3 }),
      // "No Search Results" is a legitimate empty SERP, not a failure.
      expect.objectContaining({ keyword: 'keyword 2', device: 'mobile', position: null }),
    ]);
    expect(fns.addRankRunProgress).toHaveBeenCalledWith('run_1', { checked: 2 });
    expect(fns.completeRankRun).not.toHaveBeenCalled();
    expect(queueMock.add).toHaveBeenCalledWith(
      'seoRankTaskPoll',
      expect.objectContaining({
        payload: expect.objectContaining({ taskIds: ['t3'], attempt: 1 }),
      }),
      { delay: 120_000, jobId: 'seoRankTaskPoll:run_1:1' }
    );

    // Last task arrives: run completes.
    vi.clearAllMocks();
    fns.getRankRun.mockResolvedValue(running);
    dbMock.seoTrackedKeyword.findMany.mockResolvedValue([
      { id: 'kw_3', keyword: 'keyword 3' },
    ]);
    const last = fakeDfs({
      '/v3/serp/google/organic/tasks_ready': () =>
        envelope([{ id: 'r', status_code: 20_000, result: [{ id: 't3', tag: 'kw_3:desktop' }] }]),
      '/v3/serp/google/organic/task_get/advanced/t3': () =>
        envelope([{ id: 't3', status_code: 40_000, status_message: 'Internal error' }]),
    });
    fns.getDfsClientForProject.mockResolvedValue(last.client);

    await seoRankTaskPollJob(
      job({ projectId: 'p1', runId: 'run_1', taskIds: ['t3'], attempt: 1 })
    );

    expect(fns.addRankRunProgress).toHaveBeenCalledWith('run_1', { checked: 1 });
    expect(fns.completeRankRun).toHaveBeenCalledWith('run_1', {
      warning: '1 check(s) failed: keyword 3 (desktop): Internal error',
    });
    expect(queueMock.add).not.toHaveBeenCalled();
  });

  it('fails the run after two hours and keeps what was collected', async () => {
    fns.getRankRun.mockResolvedValue({
      ...running,
      startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000 - 1000),
    });

    await seoRankTaskPollJob(
      job({ projectId: 'p1', runId: 'run_1', taskIds: ['t1'], attempt: 9 })
    );

    expect(fns.failRankRun).toHaveBeenCalledWith(
      'run_1',
      expect.stringMatching(/Timed out after 2h with 1 task\(s\) outstanding/)
    );
    expect(fns.getDfsClientForProject).not.toHaveBeenCalled();
    expect(queueMock.add).not.toHaveBeenCalled();
  });

  it('schedules the next poll instead of stranding the run when DFS throws', async () => {
    fns.getRankRun.mockResolvedValue(running);
    const dfs = fakeDfs({
      '/v3/serp/google/organic/tasks_ready': () => {
        throw new Error('connection reset');
      },
    });
    fns.getDfsClientForProject.mockResolvedValue(dfs.client);

    await expect(
      seoRankTaskPollJob(
        job({ projectId: 'p1', runId: 'run_1', taskIds: ['t1', 't2'], attempt: 0 })
      )
    ).resolves.toBeUndefined();

    expect(fns.failRankRun).not.toHaveBeenCalled();
    expect(fns.completeRankRun).not.toHaveBeenCalled();
    expect(queueMock.add).toHaveBeenCalledWith(
      'seoRankTaskPoll',
      expect.objectContaining({
        payload: { projectId: 'p1', runId: 'run_1', taskIds: ['t1', 't2'], attempt: 1 },
      }),
      { delay: 120_000, jobId: 'seoRankTaskPoll:run_1:1' }
    );
  });

  it('is a no-op once the run is no longer running', async () => {
    fns.getRankRun.mockResolvedValue({ ...running, status: 'failed' });

    await seoRankTaskPollJob(
      job({ projectId: 'p1', runId: 'run_1', taskIds: ['t1'], attempt: 0 })
    );

    expect(fns.getDfsClientForProject).not.toHaveBeenCalled();
    expect(queueMock.add).not.toHaveBeenCalled();
  });
});
