import { vi } from 'vitest';
import { createDataforseoTransport, type DataforseoTransportOptions } from './core';

export const TEST_API_KEY = 'dGVzdDpzZWNyZXQ=';

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** One successful envelope wrapping one task. */
export function okEnvelope(task: Record<string, unknown>, cost?: number) {
  return {
    status_code: 20_000,
    status_message: 'Ok.',
    ...(cost !== undefined ? { cost } : {}),
    tasks: [{ status_code: 20_000, status_message: 'Ok.', ...task }],
  };
}

export function mockFetch(...responses: Response[]) {
  const fetchMock = vi.fn<typeof fetch>();
  for (const response of responses) {
    fetchMock.mockResolvedValueOnce(response);
  }
  return fetchMock;
}

export function makeTransport(
  fetchImpl: typeof fetch,
  options: Partial<DataforseoTransportOptions> = {},
) {
  return createDataforseoTransport({ apiKey: TEST_API_KEY, fetchImpl, ...options });
}

export function requestUrl(call: Parameters<typeof fetch> | undefined): string {
  const url = call?.[0];
  if (url === undefined) {
    throw new Error('fetch was not called');
  }
  return typeof url === 'string' || url instanceof URL ? url.toString() : url.url;
}

export function requestBody(call: Parameters<typeof fetch> | undefined): unknown {
  const body = call?.[1]?.body;
  if (typeof body !== 'string') {
    throw new Error('Expected DataForSEO request body to be a string');
  }
  return JSON.parse(body) as unknown;
}
