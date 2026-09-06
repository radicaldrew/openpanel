import { describe, expect, it, vi } from 'vitest';
import {
  fetchLiveSerp,
  fetchRankCheckSerp,
  fetchRankCheckTaskResult,
  fetchSerpTasksReady,
  postRankCheckTasks,
} from './serp';
import { jsonResponse, makeTransport, mockFetch, requestBody, requestUrl } from './test-utils';

describe('live SERP', () => {
  // 40102 is the documented "No Search Results." code (40501 is "Invalid
  // Field."). isNoResultsTask matches on the status message, not the code, so
  // this stays correct whichever code DataForSEO attaches to the message.
  it("returns an empty result for DataForSEO's no-results task", async () => {
    const transport = makeTransport(
      mockFetch(
        jsonResponse({
          status_code: 20_000,
          tasks: [
            {
              status_code: 40_102,
              status_message: 'No Search Results.',
              path: ['v3', 'serp', 'google', 'organic', 'live', 'advanced'],
              cost: 0.002,
              result_count: 0,
              result: [],
            },
          ],
        }),
      ),
    );

    await expect(
      fetchLiveSerp(transport, { keyword: 'obscure query', locationCode: 2840, languageCode: 'en' }),
    ).resolves.toMatchObject({ data: [], billing: { costUsd: 0.002 } });
  });

  it('clamps depth to 10-100 and defaults to the analysis depth', async () => {
    const fetchMock = mockFetch(
      jsonResponse({
        status_code: 20_000,
        tasks: [{ status_code: 20_000, path: ['v3'], cost: 0.002, result: [{ items: [] }] }],
      }),
      jsonResponse({
        status_code: 20_000,
        tasks: [{ status_code: 20_000, path: ['v3'], cost: 0.002, result: [{ items: [] }] }],
      }),
    );
    const transport = makeTransport(fetchMock);
    await fetchLiveSerp(transport, { keyword: 'a', locationCode: 2840, languageCode: 'en' });
    await fetchLiveSerp(transport, { keyword: 'a', locationCode: 2840, languageCode: 'en', depth: 500 });
    expect(requestBody(fetchMock.mock.calls[0])).toMatchObject([{ depth: 20, device: 'desktop' }]);
    expect(requestBody(fetchMock.mock.calls[1])).toMatchObject([{ depth: 100 }]);
  });

  it('finds the organic position of the target domain including subdomains', async () => {
    const fetchMock = mockFetch(
      jsonResponse({
        status_code: 20_000,
        tasks: [
          {
            status_code: 20_000,
            path: ['v3', 'serp', 'google', 'organic', 'live', 'advanced'],
            cost: 0.002,
            result: [
              {
                items: [
                  { type: 'people_also_ask', rank_absolute: 1 },
                  { type: 'organic', rank_group: 1, rank_absolute: 2, domain: 'other.com', url: 'https://other.com' },
                  { type: 'organic', rank_group: 2, rank_absolute: 3, domain: 'blog.example.com', url: 'https://blog.example.com/p' },
                ],
              },
            ],
          },
        ],
      }),
    );
    const result = await fetchRankCheckSerp(makeTransport(fetchMock), {
      keyword: 'alpha',
      keywordId: 'kw-1',
      locationCode: 2840,
      languageCode: 'en',
      locationName: 'Springfield,Illinois,United States',
      device: 'mobile',
      targetDomain: 'example.com',
      depth: 20,
    });
    expect(result.data).toEqual({
      keywordId: 'kw-1',
      keyword: 'alpha',
      position: 2,
      url: 'https://blog.example.com/p',
      serpFeatures: ['people_also_ask', 'organic'],
      topResults: [
        { position: 1, domain: 'other.com', url: 'https://other.com' },
        { position: 2, domain: 'blog.example.com', url: 'https://blog.example.com/p' },
      ],
    });
    expect(requestBody(fetchMock.mock.calls[0])).toMatchObject([
      {
        location_name: 'Springfield,Illinois,United States',
        device: 'mobile',
        os: 'android',
        find_targets_in: ['organic'],
      },
    ]);
  });
});

describe('rank check task queue', () => {
  it('posts queued tasks, maps ids by tag, and sums cost over all entries', async () => {
    const fetchMock = mockFetch(
      jsonResponse({
        status_code: 20_000,
        tasks: [
          { id: 'task-a', status_code: 20_100, cost: 0.0006, data: { tag: 'kw-1:desktop' } },
          { id: 'task-b', status_code: 20_100, cost: 0.0006, data: { tag: 'kw-1:mobile' } },
          {
            id: 'task-c',
            status_code: 40_006,
            status_message: 'Task Limit Exceeded',
            cost: 0.0006,
            data: { tag: 'kw-2:desktop' },
          },
        ],
      }),
    );

    const result = await postRankCheckTasks(makeTransport(fetchMock), {
      tasks: [
        { keyword: 'alpha', keywordId: 'kw-1', device: 'desktop' },
        { keyword: 'alpha', keywordId: 'kw-1', device: 'mobile' },
        { keyword: 'beta', keywordId: 'kw-2', device: 'desktop' },
      ],
      locationCode: 2840,
      languageCode: 'en',
      depth: 20,
      targetDomain: 'example.com',
    });

    expect(requestUrl(fetchMock.mock.calls[0])).toBe(
      'https://api.dataforseo.com/v3/serp/google/organic/task_post',
    );

    // Every posted task asks DataForSEO to stop crawling at the target's
    // organic listing — that is what cuts the actual crawl cost for ranking
    // domains without false "not ranking" stops on sitelinks/PAA mentions.
    const stopCrawl = {
      stop_crawl_on_match: [{ match_value: 'example.com', match_type: 'with_subdomains' }],
      find_targets_in: ['organic'],
    };
    expect(requestBody(fetchMock.mock.calls[0])).toMatchObject([stopCrawl, stopCrawl, stopCrawl]);
    expect(result.data).toEqual([
      { keyword: 'alpha', keywordId: 'kw-1', device: 'desktop', taskId: 'task-a' },
      { keyword: 'alpha', keywordId: 'kw-1', device: 'mobile', taskId: 'task-b' },
    ]);
    // The rejected entry's cost is still reported: a charge is a charge.
    expect(result.billing.costUsd).toBeCloseTo(0.0018, 10);
    expect(result.billing.path).toEqual(['v3', 'serp', 'google', 'organic', 'task_post']);
  });

  it('passes priority and postback settings through and never retries a 5xx', async () => {
    const fetchMock = mockFetch(new Response('boom', { status: 502 }));
    await expect(
      postRankCheckTasks(makeTransport(fetchMock), {
        tasks: [{ keyword: 'alpha', keywordId: 'kw-1', device: 'desktop' }],
        locationCode: 2840,
        languageCode: 'en',
        depth: 20,
        targetDomain: 'example.com',
        priority: 2,
        postbackUrl: 'https://example.com/hook',
      }),
    ).rejects.toMatchObject({ kind: 'upstream', status: 502 });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(requestBody(fetchMock.mock.calls[0])).toMatchObject([
      { priority: 2, postback_url: 'https://example.com/hook', postback_data: 'advanced' },
    ]);
  });

  it('rejects an empty or oversized batch before dispatch', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const base = { locationCode: 2840, languageCode: 'en', depth: 20, targetDomain: 'example.com' };
    await expect(
      postRankCheckTasks(makeTransport(fetchMock), { ...base, tasks: [] }),
    ).rejects.toMatchObject({ kind: 'validation' });
    await expect(
      postRankCheckTasks(makeTransport(fetchMock), {
        ...base,
        tasks: Array.from({ length: 101 }, (_, i) => ({
          keyword: `k${i}`,
          keywordId: `kw-${i}`,
          device: 'desktop' as const,
        })),
      }),
    ).rejects.toMatchObject({ kind: 'validation' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a queued task still in progress as pending', async () => {
    const fetchMock = mockFetch(
      jsonResponse({ status_code: 20_000, tasks: [{ id: 'task-a', status_code: 40_602 }] }),
    );

    const outcome = await fetchRankCheckTaskResult(makeTransport(fetchMock), {
      taskId: 'task-a',
      keywordId: 'kw-1',
      keyword: 'alpha',
      targetDomain: 'example.com',
    });

    expect(outcome.data).toEqual({ status: 'pending' });
    expect(requestUrl(fetchMock.mock.calls[0])).toBe(
      'https://api.dataforseo.com/v3/serp/google/organic/task_get/advanced/task-a',
    );
  });

  it('parses a completed queued task into a rank check result', async () => {
    const fetchMock = mockFetch(
      jsonResponse({
        status_code: 20_000,
        tasks: [
          {
            id: 'task-a',
            status_code: 20_000,
            cost: 0,
            path: ['v3', 'serp', 'google', 'organic', 'task_get', 'advanced'],
            result: [
              {
                items: [
                  {
                    type: 'organic',
                    rank_group: 3,
                    rank_absolute: 4,
                    domain: 'www.example.com',
                    url: 'https://www.example.com/page',
                  },
                ],
              },
            ],
          },
        ],
      }),
    );

    const outcome = await fetchRankCheckTaskResult(makeTransport(fetchMock), {
      taskId: 'task-a',
      keywordId: 'kw-1',
      keyword: 'alpha',
      targetDomain: 'example.com',
    });

    expect(outcome.data).toEqual({
      status: 'completed',
      result: {
        keywordId: 'kw-1',
        keyword: 'alpha',
        position: 3,
        url: 'https://www.example.com/page',
        serpFeatures: ['organic'],
        topResults: [{ position: 3, domain: 'www.example.com', url: 'https://www.example.com/page' }],
      },
    });
    expect(outcome.billing).toEqual({
      path: ['v3', 'serp', 'google', 'organic', 'task_get', 'advanced'],
      costUsd: 0,
    });
  });

  it('reports a failed queued task with its message', async () => {
    const fetchMock = mockFetch(
      jsonResponse({
        status_code: 20_000,
        tasks: [{ id: 'task-a', status_code: 40_103, status_message: 'Task execution failed' }],
      }),
    );
    const outcome = await fetchRankCheckTaskResult(makeTransport(fetchMock), {
      taskId: 'task-a',
      keywordId: 'kw-1',
      keyword: 'alpha',
      targetDomain: 'example.com',
    });
    expect(outcome.data).toEqual({ status: 'failed', message: 'Task execution failed' });
  });

  it('lists tasks ready for collection', async () => {
    const fetchMock = mockFetch(
      jsonResponse({
        status_code: 20_000,
        tasks: [
          {
            status_code: 20_000,
            path: ['v3', 'serp', 'google', 'organic', 'tasks_ready'],
            cost: 0,
            result: [
              {
                id: 'task-a',
                se: 'google',
                se_type: 'organic',
                tag: 'kw-1:desktop',
                endpoint_advanced: '/v3/serp/google/organic/task_get/advanced/task-a',
              },
            ],
          },
        ],
      }),
    );
    const result = await fetchSerpTasksReady(makeTransport(fetchMock));
    expect(result.data).toEqual([
      expect.objectContaining({ id: 'task-a', tag: 'kw-1:desktop' }),
    ]);
    expect(result.billing.costUsd).toBe(0);
  });
});
