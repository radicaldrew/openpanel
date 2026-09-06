/**
 * Site audits against a fake DataForSEO.
 *
 * The transport is the real one with `fetchImpl` swapped, so what is
 * exercised is the on_page request shape and the bookkeeping per response:
 * the task post that starts a crawl, the poll backoff while it runs, the
 * finished → pages/{id} paging at 1000 per call, cancellation stopping the
 * poll, the 3h deadline, and the spend cap that stops it before posting.
 */

import { createDataforseoTransport } from '@openpanel/dataforseo';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fns, queueMock } = vi.hoisted(() => ({
  fns: {
    getAudit: vi.fn(),
    getSeoProjectConfig: vi.fn(),
    getProjectOrganizationId: vi.fn(),
    isDfsSpendCapReached: vi.fn(),
    getDfsClientForProject: vi.fn(),
    markAuditCrawling: vi.fn(),
    updateAuditProgress: vi.fn(),
    completeAudit: vi.fn(),
    failAudit: vi.fn(),
    insertAuditPages: vi.fn(),
  },
  queueMock: { add: vi.fn() },
}));

vi.mock('@openpanel/db', async () => {
  const audit = await import('../../../../packages/db/src/seo/audit');
  return {
    ...fns,
    SPEND_CAP_ERROR: 'spend cap reached',
    readAuditSummary: audit.readAuditSummary,
    toAuditPageRow: audit.toAuditPageRow,
  };
});
vi.mock('../../../../packages/db/src/prisma-client', () => ({ db: {} }));
vi.mock('../../../../packages/db/src/clickhouse/client', () => ({ originalCh: {} }));
vi.mock('@openpanel/queue', () => ({ seoQueue: queueMock }));
vi.mock('../utils/logger', () => {
  const noop = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger: { ...noop, child: () => noop } };
});

const { auditPollDelaySeconds, MAX_IMPORT_ITEMS, PAGES_BATCH_SIZE, seoAuditPollJob, seoAuditStartJob } =
  await import('./seo.audit');

interface Recorded {
  path: string;
  body: unknown;
}

function envelope(tasks: unknown[], cost = 0) {
  return { status_code: 20_000, status_message: 'Ok.', cost, tasks };
}

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
    const handler = Object.entries(handlers).find(([prefix]) => path.startsWith(prefix))?.[1];
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

function pageItem(index: number) {
  return {
    url: `https://example.com/page-${index}`,
    status_code: 200,
    onpage_score: 90 - (index % 10),
    meta: { title: `Page ${index}`, htags: { h1: [`H ${index}`] } },
    checks: { no_title: false, title_too_long: index % 2 === 0 },
  };
}

function summaryTask(progress: 'in_progress' | 'finished', pagesCrawled: number, score = 88.4) {
  return {
    id: 'task_1',
    status_code: 20_000,
    cost: 0,
    result: [
      {
        crawl_progress: progress,
        crawl_status: { max_crawl_pages: 500, pages_in_queue: 0, pages_crawled: pagesCrawled },
        page_metrics: { onpage_score: score, duplicate_title: 2 },
      },
    ],
  };
}

const startedAt = () => new Date();

beforeEach(() => {
  vi.clearAllMocks();
  fns.getSeoProjectConfig.mockResolvedValue({ domain: 'example.com' });
  fns.getProjectOrganizationId.mockResolvedValue('org_1');
  fns.isDfsSpendCapReached.mockResolvedValue(false);
  queueMock.add.mockResolvedValue(undefined);
});

describe('auditPollDelaySeconds', () => {
  it('backs off 30 → 60 → 120 → 300 by crawl age', () => {
    const minute = 60_000;
    expect(auditPollDelaySeconds(0)).toBe(30);
    expect(auditPollDelaySeconds(1.9 * minute)).toBe(30);
    expect(auditPollDelaySeconds(2 * minute)).toBe(60);
    expect(auditPollDelaySeconds(9 * minute)).toBe(60);
    expect(auditPollDelaySeconds(10 * minute)).toBe(120);
    expect(auditPollDelaySeconds(29 * minute)).toBe(120);
    expect(auditPollDelaySeconds(30 * minute)).toBe(300);
    expect(auditPollDelaySeconds(240 * minute)).toBe(300);
  });
});

describe('seoAuditStartJob', () => {
  it('posts the crawl, records the task and cost, and schedules the first poll', async () => {
    fns.getAudit.mockResolvedValue({
      id: 'audit_1',
      status: 'queued',
      maxPages: 250,
      summary: { options: { enableJavascript: true } },
      startedAt: startedAt(),
    });
    const dfs = fakeDfs({
      '/v3/on_page/task_post': () =>
        envelope(
          [
            {
              id: 'task_1',
              status_code: 20_100,
              status_message: 'Task Created.',
              cost: 1 / 32,
              path: ['v3', 'on_page', 'task_post'],
              data: { tag: 'audit_1' },
            },
          ],
          1 / 32
        ),
    });
    fns.getDfsClientForProject.mockResolvedValue(dfs.client);

    await seoAuditStartJob(job({ projectId: 'p1', auditId: 'audit_1' }));

    expect(dfs.calls).toHaveLength(1);
    expect(dfs.calls[0]?.body).toEqual([
      {
        target: 'example.com',
        max_crawl_pages: 250,
        enable_javascript: true,
        load_resources: false,
        tag: 'audit_1',
      },
    ]);
    expect(fns.markAuditCrawling).toHaveBeenCalledWith('audit_1', {
      dfsTaskId: 'task_1',
      costUsd: 1 / 32,
    });
    expect(queueMock.add).toHaveBeenCalledTimes(1);
    const [name, payload, options] = queueMock.add.mock.calls[0]!;
    expect(name).toBe('seoAuditPoll');
    expect(payload).toEqual({ type: 'seoAuditPoll', payload: { projectId: 'p1', auditId: 'audit_1' } });
    expect(options.delay).toBe(30_000);
    expect(fns.failAudit).not.toHaveBeenCalled();
  });

  it('stops before spending anything when the cap is reached', async () => {
    fns.getAudit.mockResolvedValue({ id: 'audit_1', status: 'queued', maxPages: 500, summary: null, startedAt: startedAt() });
    fns.isDfsSpendCapReached.mockResolvedValue(true);

    await seoAuditStartJob(job({ projectId: 'p1', auditId: 'audit_1' }));

    expect(fns.failAudit).toHaveBeenCalledWith('audit_1', 'spend cap reached');
    expect(fns.getDfsClientForProject).not.toHaveBeenCalled();
    expect(queueMock.add).not.toHaveBeenCalled();
  });

  it('does not restart an audit that is no longer queued', async () => {
    fns.getAudit.mockResolvedValue({ id: 'audit_1', status: 'crawling', maxPages: 500, summary: null, startedAt: startedAt() });

    await seoAuditStartJob(job({ projectId: 'p1', auditId: 'audit_1' }));

    expect(fns.getSeoProjectConfig).not.toHaveBeenCalled();
    expect(fns.failAudit).not.toHaveBeenCalled();
  });

  it('fails the audit and rethrows when DFS rejects the post', async () => {
    fns.getAudit.mockResolvedValue({ id: 'audit_1', status: 'queued', maxPages: 500, summary: null, startedAt: startedAt() });
    const dfs = fakeDfs({
      '/v3/on_page/task_post': () =>
        envelope([{ id: 't', status_code: 40_501, status_message: 'Invalid Field: target.', cost: 0 }]),
    });
    fns.getDfsClientForProject.mockResolvedValue(dfs.client);

    await expect(seoAuditStartJob(job({ projectId: 'p1', auditId: 'audit_1' }))).rejects.toThrow();
    expect(fns.failAudit).toHaveBeenCalledWith('audit_1', expect.stringContaining('Invalid Field'));
    expect(queueMock.add).not.toHaveBeenCalled();
  });
});

describe('seoAuditPollJob', () => {
  const crawling = (overrides: Record<string, unknown> = {}) => ({
    id: 'audit_1',
    status: 'crawling',
    dfsTaskId: 'task_1',
    maxPages: 500,
    pagesCrawled: 0,
    summary: { options: { enableJavascript: false } },
    startedAt: startedAt(),
    ...overrides,
  });

  it('updates progress and re-enqueues while the crawl is in progress', async () => {
    fns.getAudit.mockResolvedValue(crawling({ startedAt: new Date(Date.now() - 5 * 60_000) }));
    const dfs = fakeDfs({
      '/v3/on_page/summary/task_1': () => envelope([summaryTask('in_progress', 42)]),
    });
    fns.getDfsClientForProject.mockResolvedValue(dfs.client);

    await seoAuditPollJob(job({ projectId: 'p1', auditId: 'audit_1' }));

    expect(fns.updateAuditProgress).toHaveBeenCalledWith('audit_1', { pagesCrawled: 42 });
    expect(queueMock.add).toHaveBeenCalledTimes(1);
    // Five minutes in → the 60 s rung.
    expect(queueMock.add.mock.calls[0]?.[2].delay).toBe(60_000);
    expect(fns.completeAudit).not.toHaveBeenCalled();
    expect(fns.insertAuditPages).not.toHaveBeenCalled();
  });

  it('pages through pages/{id} at 1000 per call once finished and completes the audit', async () => {
    fns.getAudit.mockResolvedValue(crawling());
    const total = 1234;
    const dfs = fakeDfs({
      '/v3/on_page/summary/task_1': () => envelope([summaryTask('finished', total, 88.4)]),
      '/v3/on_page/pages': (body) => {
        const request = (body as { id: string; limit: number; offset: number }[])[0]!;
        // Item 500 is a resource (image/script); DFS counts it in the list
        // and in total_count, but it must not become an audit page.
        const items = Array.from(
          { length: Math.min(request.limit, total - request.offset) },
          (_, index) => {
            const item = pageItem(request.offset + index);
            return request.offset + index === 500 ? { ...item, is_resource: true } : item;
          }
        );
        return envelope([
          {
            id: 'task_1',
            status_code: 20_000,
            cost: 0,
            result: [{ crawl_progress: 'finished', total_count: total, items }],
          },
        ]);
      },
    });
    fns.getDfsClientForProject.mockResolvedValue(dfs.client);

    await seoAuditPollJob(job({ projectId: 'p1', auditId: 'audit_1' }));

    const pageCalls = dfs.calls.filter((call) => call.path === '/v3/on_page/pages');
    expect(pageCalls.map((call) => (call.body as { offset: number; limit: number }[])[0])).toEqual([
      { id: 'task_1', limit: 1000, offset: 0 },
      { id: 'task_1', limit: 1000, offset: 1000 },
    ]);
    expect(fns.insertAuditPages).toHaveBeenCalledTimes(2);
    const inserted = fns.insertAuditPages.mock.calls.flatMap((call) => call[0]);
    expect(inserted).toHaveLength(total - 1);
    expect(inserted.some((row: { url: string }) => row.url.endsWith('/page-500'))).toBe(false);
    expect(inserted[0]).toMatchObject({
      projectId: 'p1',
      auditId: 'audit_1',
      url: 'https://example.com/page-0',
      title: 'Page 0',
      h1: 'H 0',
      checks: { no_title: false, title_too_long: true },
    });
    expect(fns.completeAudit).toHaveBeenCalledWith('audit_1', {
      score: 88,
      pagesCrawled: total,
      dfsSummary: expect.objectContaining({ crawl_progress: 'finished' }),
    });
    expect(queueMock.add).not.toHaveBeenCalled();
  });

  it('stops paging at the item ceiling if DataForSEO keeps returning full batches', async () => {
    fns.getAudit.mockResolvedValue(crawling({ maxPages: 10_000 }));
    const dfs = fakeDfs({
      '/v3/on_page/summary/task_1': () => envelope([summaryTask('finished', 2500)]),
      '/v3/on_page/pages': (body) => {
        const request = (body as { limit: number; offset: number }[])[0]!;
        // A broken total_count and a full page every time.
        const items = Array.from({ length: request.limit }, (_, index) =>
          pageItem(request.offset + index)
        );
        return envelope([
          {
            id: 'task_1',
            status_code: 20_000,
            cost: 0,
            result: [{ crawl_progress: 'finished', total_count: null, items }],
          },
        ]);
      },
    });
    fns.getDfsClientForProject.mockResolvedValue(dfs.client);

    await seoAuditPollJob(job({ projectId: 'p1', auditId: 'audit_1' }));

    const pageCalls = dfs.calls.filter((call) => call.path === '/v3/on_page/pages');
    expect(pageCalls).toHaveLength(MAX_IMPORT_ITEMS / PAGES_BATCH_SIZE);
    expect((pageCalls.at(-1)?.body as { offset: number }[])[0]?.offset).toBe(
      MAX_IMPORT_ITEMS - PAGES_BATCH_SIZE
    );
    expect(fns.completeAudit).toHaveBeenCalledWith(
      'audit_1',
      expect.objectContaining({ pagesCrawled: MAX_IMPORT_ITEMS })
    );
  }, 60_000);

  it('stops polling once the audit was cancelled', async () => {
    fns.getAudit.mockResolvedValue(crawling({ status: 'failed', error: 'cancelled' }));

    await seoAuditPollJob(job({ projectId: 'p1', auditId: 'audit_1' }));

    expect(fns.getDfsClientForProject).not.toHaveBeenCalled();
    expect(queueMock.add).not.toHaveBeenCalled();
    expect(fns.failAudit).not.toHaveBeenCalled();
  });

  it('fails the audit after three hours without calling DFS again', async () => {
    fns.getAudit.mockResolvedValue(
      crawling({ pagesCrawled: 77, startedAt: new Date(Date.now() - 3 * 60 * 60_000 - 1000) })
    );

    await seoAuditPollJob(job({ projectId: 'p1', auditId: 'audit_1' }));

    expect(fns.failAudit).toHaveBeenCalledWith('audit_1', expect.stringContaining('77 page(s)'));
    expect(fns.getDfsClientForProject).not.toHaveBeenCalled();
    expect(queueMock.add).not.toHaveBeenCalled();
  });
});
