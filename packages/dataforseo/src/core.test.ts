import { describe, expect, it, vi } from 'vitest';
import { DataForSeoError } from './errors';
import {
  jsonResponse,
  makeTransport,
  mockFetch,
  requestUrl,
  TEST_API_KEY,
} from './test-utils';

describe('DataForSEO transport', () => {
  it('retries a transient 5xx on idempotent reads and returns the parsed envelope', async () => {
    const fetchMock = mockFetch(
      new Response('upstream failure', { status: 503 }),
      jsonResponse({ status_code: 20_000, tasks: [] }),
    );
    const transport = makeTransport(fetchMock);

    await expect(transport.post('/v3/backlinks/summary/live', [])).resolves.toEqual({
      status_code: 20_000,
      tasks: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.dataforseo.com/v3/backlinks/summary/live');
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Basic ${TEST_API_KEY}`);
  });

  it('does not retry when maxServerErrorRetries is 0 and classifies the 5xx as upstream', async () => {
    const fetchMock = mockFetch(new Response('upstream failure', { status: 503 }));
    const transport = makeTransport(fetchMock);

    const rejection = transport.post('/v3/on_page/task_post', [], {
      maxServerErrorRetries: 0,
    });
    await expect(rejection).rejects.toBeInstanceOf(DataForSeoError);
    await expect(rejection).rejects.toMatchObject({
      kind: 'upstream',
      status: 503,
      path: '/v3/on_page/task_post',
      retryable: true,
      responseBody: 'upstream failure',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  // Both abort flavours mean "we ran out of time": the shared budget aborts
  // with TimeoutError, a caller's own controller with AbortError. Retrying
  // would replay a call DataForSEO may already have billed.
  it.each(['TimeoutError', 'AbortError'])(
    'maps a %s abort to a timeout error without retrying',
    async (name) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockRejectedValue(new DOMException('aborted', name));
      const transport = makeTransport(fetchMock);

      await expect(
        transport.post('/v3/serp/google/organic/live/advanced', []),
      ).rejects.toMatchObject({
        kind: 'timeout',
        name: 'DataForSeoError',
        path: '/v3/serp/google/organic/live/advanced',
        retryable: true,
      });
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it('classifies HTTP 401 as an auth failure and reads the echoed DFS status code', async () => {
    const fetchMock = mockFetch(
      jsonResponse(
        { version: '0.1', status_code: 40_100, status_message: 'Unauthorized.' },
        401,
      ),
    );
    const transport = makeTransport(fetchMock);

    await expect(transport.get('/v3/appendix/user_data')).rejects.toMatchObject({
      kind: 'auth',
      status: 401,
      dfsStatusCode: 40_100,
      retryable: false,
    });
  });

  it('classifies HTTP 429 as rate limited', async () => {
    const transport = makeTransport(mockFetch(new Response('slow down', { status: 429 })));
    await expect(transport.get('/v3/appendix/user_data')).rejects.toMatchObject({
      kind: 'rate_limited',
      status: 429,
    });
  });

  it('returns null for an empty body and throws invalid_response for non-JSON', async () => {
    const transport = makeTransport(
      mockFetch(new Response('', { status: 200 }), new Response('<html>', { status: 200 })),
    );
    await expect(transport.get('/v3/x')).resolves.toBeNull();
    await expect(transport.get('/v3/x')).rejects.toMatchObject({
      kind: 'invalid_response',
      responseBody: '<html>',
    });
  });

  it('reports the envelope cost through onCost for every parsed envelope', async () => {
    const onCost = vi.fn();
    const fetchMock = mockFetch(
      jsonResponse({ status_code: 20_000, cost: 0.0125, tasks: [{ cost: 0.0125 }] }),
      // No top-level cost: falls back to summing the tasks.
      jsonResponse({ status_code: 20_000, tasks: [{ cost: 0.001 }, { cost: 0.002 }] }),
      // Free endpoint reporting 0.
      jsonResponse({ status_code: 20_000, cost: 0, tasks: [{ cost: 0 }] }),
      // Nothing to report.
      jsonResponse({ status_code: 20_000, tasks: [] }),
    );
    const transport = makeTransport(fetchMock, { onCost });

    await transport.post('/v3/backlinks/summary/live', []);
    await transport.post('/v3/serp/google/organic/task_post', []);
    await transport.get('/v3/appendix/user_data');
    await transport.get('/v3/serp/google/organic/tasks_ready');

    expect(onCost.mock.calls).toEqual([
      ['/v3/backlinks/summary/live', 0.0125],
      ['/v3/serp/google/organic/task_post', 0.003],
      ['/v3/appendix/user_data', 0],
    ]);
  });

  it('awaits an async onCost hook and propagates its rejection', async () => {
    const onCost = vi.fn().mockRejectedValue(new Error('redis down'));
    const transport = makeTransport(
      mockFetch(jsonResponse({ status_code: 20_000, cost: 0.01, tasks: [] })),
      { onCost },
    );
    await expect(transport.post('/v3/backlinks/summary/live', [])).rejects.toThrow('redis down');
    expect(onCost).toHaveBeenCalledWith('/v3/backlinks/summary/live', 0.01);
  });

  it('sends JSON task arrays on POST and no body on GET', async () => {
    const fetchMock = mockFetch(
      jsonResponse({ status_code: 20_000, tasks: [] }),
      jsonResponse({ status_code: 20_000, tasks: [] }),
    );
    const transport = makeTransport(fetchMock);
    await transport.post('/v3/a', [{ keyword: 'x' }]);
    await transport.get('/v3/b');

    const [, postInit] = fetchMock.mock.calls[0] ?? [];
    expect(postInit?.method).toBe('POST');
    expect(postInit?.body).toBe('[{"keyword":"x"}]');
    expect(new Headers(postInit?.headers).get('Content-Type')).toBe('application/json');
    const [, getInit] = fetchMock.mock.calls[1] ?? [];
    expect(getInit?.method).toBe('GET');
    expect(getInit?.body).toBeUndefined();
    expect(requestUrl(fetchMock.mock.calls[1])).toBe('https://api.dataforseo.com/v3/b');
  });
});
