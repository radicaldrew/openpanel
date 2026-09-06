import { describe, expect, it, vi } from 'vitest';
import { createDataforseoClient } from './client';
import { jsonResponse, mockFetch, okEnvelope, requestBody, requestUrl, TEST_API_KEY } from './test-utils';

describe('createDataforseoClient', () => {
  it('binds every section to one authenticated transport and returns { data, billing }', async () => {
    const fetchMock = mockFetch(
      jsonResponse(
        okEnvelope(
          {
            path: ['v3', 'backlinks', 'summary', 'live'],
            cost: 0.02,
            result_count: 1,
            result: [{ target: 'example.com', rank: 42, backlinks: 10 }],
          },
          0.02,
        ),
      ),
    );
    const onCost = vi.fn();
    const client = createDataforseoClient({ apiKey: TEST_API_KEY, fetchImpl: fetchMock, onCost });

    const result = await client.backlinks.summary({ target: 'example.com' });

    expect(result.data).toMatchObject({ rank: 42, backlinks: 10 });
    expect(result.billing).toEqual({ path: ['v3', 'backlinks', 'summary', 'live'], costUsd: 0.02 });
    expect(onCost).toHaveBeenCalledWith('/v3/backlinks/summary/live', 0.02);
    expect(requestUrl(fetchMock.mock.calls[0])).toBe(
      'https://api.dataforseo.com/v3/backlinks/summary/live',
    );
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe(
      `Basic ${TEST_API_KEY}`,
    );
  });

  it('exposes appendix.userData for key validation and balance', async () => {
    const fetchMock = mockFetch(
      jsonResponse(
        okEnvelope(
          {
            path: ['v3', 'appendix', 'user_data'],
            cost: 0,
            result: [{ login: 'alice@example.com', money: { total: 100, balance: 42.5 } }],
          },
          0,
        ),
      ),
    );
    const onCost = vi.fn();
    const client = createDataforseoClient({ apiKey: TEST_API_KEY, fetchImpl: fetchMock, onCost });

    const { data, billing } = await client.appendix.userData();

    expect(data?.login).toBe('alice@example.com');
    expect(data?.money?.balance).toBe(42.5);
    expect(billing).toEqual({ path: ['v3', 'appendix', 'user_data'], costUsd: 0 });
    expect(onCost).toHaveBeenCalledWith('/v3/appendix/user_data', 0);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('GET');
  });

  it('surfaces a wrong key as an auth error from userData', async () => {
    const fetchMock = mockFetch(
      jsonResponse({ status_code: 40_100, status_message: 'Unauthorized.' }, 401),
    );
    const client = createDataforseoClient({ apiKey: 'bad', fetchImpl: fetchMock });
    await expect(client.appendix.userData()).rejects.toMatchObject({ kind: 'auth', status: 401 });
  });

  it('keeps charged failures metered: onCost fires before the error propagates', async () => {
    const fetchMock = mockFetch(
      jsonResponse({
        status_code: 20_000,
        cost: 0.02,
        tasks: [
          {
            status_code: 40_501,
            status_message: "Invalid Field: 'target'.",
            path: ['v3', 'backlinks', 'summary', 'live'],
            cost: 0.02,
            result_count: 0,
            data: { target: 'nope' },
          },
        ],
      }),
    );
    const onCost = vi.fn();
    const client = createDataforseoClient({ apiKey: TEST_API_KEY, fetchImpl: fetchMock, onCost });

    await expect(client.backlinks.summary({ target: 'nope' })).rejects.toMatchObject({
      name: 'DataForSeoChargedTaskError',
      isInvalidField: true,
      billing: { costUsd: 0.02 },
    });
    expect(onCost).toHaveBeenCalledWith('/v3/backlinks/summary/live', 0.02);
  });

  it('exposes the raw transport for unwrapped endpoints', async () => {
    const fetchMock = mockFetch(jsonResponse({ status_code: 20_000, tasks: [] }));
    const client = createDataforseoClient({ apiKey: TEST_API_KEY, fetchImpl: fetchMock });
    await client.transport.post('/v3/custom', [{ a: 1 }]);
    expect(requestBody(fetchMock.mock.calls[0])).toEqual([{ a: 1 }]);
  });
});
