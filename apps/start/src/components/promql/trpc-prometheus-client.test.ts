/**
 * The completion backend's contract with tRPC.
 *
 * What is worth pinning here is the tenancy shape — every read carries the
 * project id, and the label reads carry the metric under the cursor — plus the
 * two methods that answer empty on purpose. A completion source that threw
 * would reject inside CodeMirror where nothing catches it, so the swallowing is
 * asserted rather than assumed.
 *
 * Run with: cd apps/start && NITRO=1 npx vitest run src/components/promql
 */
import type { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import { createTrpcPrometheusClient } from './trpc-prometheus-client';

interface Options {
  procedure: string;
  input: unknown;
}

/**
 * Stands in for the tRPC proxy and React Query's cache. `queryOptions` is only
 * ever handed straight to `fetchQuery`, so recording what it was called with is
 * the whole of what the client does.
 */
function harness(answer: (options: Options) => unknown) {
  const calls: Options[] = [];

  const optionsFor = (procedure: string) => ({
    queryOptions: (input: unknown) => ({ procedure, input }) as Options,
  });

  const trpc = {
    observability: {
      metricNames: optionsFor('metricNames'),
      labelKeys: optionsFor('labelKeys'),
      labelValues: optionsFor('labelValues'),
    },
  };

  const queryClient = {
    fetchQuery: vi.fn((options: Options) => {
      calls.push(options);
      return Promise.resolve(answer(options));
    }),
  };

  return {
    calls,
    client: createTrpcPrometheusClient({
      projectId: 'proj_1',
      trpc: trpc as unknown as Parameters<
        typeof createTrpcPrometheusClient
      >[0]['trpc'],
      queryClient: queryClient as unknown as QueryClient,
    }),
  };
}

describe('createTrpcPrometheusClient', () => {
  it('reads metric names for this project', async () => {
    const { client, calls } = harness(() => ['http_requests_total']);

    await expect(client.metricNames()).resolves.toEqual([
      'http_requests_total',
    ]);
    expect(calls).toEqual([
      { procedure: 'metricNames', input: { projectId: 'proj_1' } },
    ]);
  });

  it('narrows label names to the metric under the cursor', async () => {
    const { client, calls } = harness(() => ['job']);

    await client.labelNames('http_requests_total');

    expect(calls[0]).toEqual({
      procedure: 'labelKeys',
      input: { projectId: 'proj_1', metric: 'http_requests_total' },
    });
  });

  it('asks for every label when there is no metric yet', async () => {
    const { client, calls } = harness(() => []);

    await client.labelNames();
    // Empty string and undefined both mean "no metric", and the procedure's
    // input rejects an empty string.
    await client.labelNames('');

    expect(calls[0]).toEqual({
      procedure: 'labelKeys',
      input: { projectId: 'proj_1', metric: undefined },
    });
    expect(calls[1]?.input).toEqual({ projectId: 'proj_1', metric: undefined });
  });

  it('reads label values for one label of one metric', async () => {
    const { client, calls } = harness(() => ['GET']);

    await expect(
      client.labelValues('method', 'http_requests_total'),
    ).resolves.toEqual(['GET']);
    expect(calls[0]).toEqual({
      procedure: 'labelValues',
      input: {
        projectId: 'proj_1',
        label: 'method',
        metric: 'http_requests_total',
      },
    });
  });

  it('does not ask for the values of no label', async () => {
    const { client, calls } = harness(() => []);

    await expect(client.labelValues('')).resolves.toEqual([]);
    expect(calls).toEqual([]);
  });

  it('degrades to no suggestions when a read fails', async () => {
    const { client } = harness(() => {
      throw new Error('telemetry backend is unavailable');
    });

    // Not a rejection: this runs inside CodeMirror's completion source, where
    // there is nothing to catch it and nothing useful to show a user who is
    // mid-word.
    await expect(client.metricNames()).resolves.toEqual([]);
    await expect(client.labelNames('up')).resolves.toEqual([]);
    await expect(client.labelValues('job', 'up')).resolves.toEqual([]);
  });

  it('answers metadata and series empty without a request', async () => {
    const { client, calls } = harness(() => []);

    await expect(client.metricMetadata()).resolves.toEqual({});
    await expect(client.series('up')).resolves.toEqual([]);
    await expect(client.flags()).resolves.toEqual({});
    expect(calls).toEqual([]);
  });
});
