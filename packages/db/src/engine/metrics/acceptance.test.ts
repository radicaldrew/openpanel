import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryRange } = vi.hoisted(() => ({ queryRange: vi.fn() }));

vi.mock('@openpanel/gigapipe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openpanel/gigapipe')>();
  return { ...actual, queryRange };
});

import { PROJECT_LABEL } from '@openpanel/gigapipe';
import type { IPanelQuery } from '@openpanel/validation';
import { executeMetricPanel } from './panel';

const P = 'proj_123';

function seriesAt(labels: Record<string, string>, value: number) {
  const start = Date.parse('2024-01-01T00:00:00.000Z') / 1000;
  return {
    metric: { [PROJECT_LABEL]: P, ...labels },
    values: Array.from({ length: 25 }, (_, i) => [start + i * 3600, String(value)]) as [number, string][],
  };
}

beforeEach(() => queryRange.mockReset());

/**
 * Plan §8 acceptance item 3, end to end through the engine: one panel,
 * A = request rate by method, B = p95 latency on the right axis.
 */
describe('acceptance: a two-query panel', () => {
  const queries: IPanelQuery[] = [
    {
      refId: 'A',
      expr: 'sum by (method) (rate(http_requests_total[$__rate_interval]))',
      mode: 'builder',
      hidden: false,
      unit: 'ops',
      yAxis: 'left',
      instant: false,
      legendFormat: '{{method}}',
    },
    {
      refId: 'B',
      expr: 'histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[$__rate_interval])))',
      mode: 'builder',
      hidden: false,
      unit: 'seconds',
      yAxis: 'right',
      instant: false,
      legendFormat: 'p95',
    },
  ];

  it('renders both queries with their own unit, axis and legend', async () => {
    queryRange
      .mockResolvedValueOnce({
        status: 'success',
        data: {
          resultType: 'matrix',
          result: [seriesAt({ method: 'GET' }, 12), seriesAt({ method: 'POST' }, 3)],
        },
      })
      .mockResolvedValueOnce({
        status: 'success',
        data: { resultType: 'matrix', result: [seriesAt({}, 0.034)] },
      });

    const result = await executeMetricPanel({
      projectId: P,
      queries,
      interval: 'hour',
      startDate: '2024-01-01T00:00:00.000Z',
      endDate: '2024-01-02T00:00:00.000Z',
    });

    const byRef = new Map(result.chart.series.map((s) => [s.panel?.refId, s]));

    expect(result.chart.series).toHaveLength(3);
    expect(byRef.get('A')?.panel).toEqual({ refId: 'A', unit: 'ops', yAxis: 'left' });
    expect(byRef.get('B')?.panel).toEqual({ refId: 'B', unit: 'seconds', yAxis: 'right' });

    // Legends come from legendFormat, resolved server-side, with the alpha id.
    const names = result.chart.series.map((s) => s.names[0]);
    expect(names).toContain('(A) GET');
    expect(names).toContain('(A) POST');
    expect(names).toContain('(B) p95');

    // Both scoped, both grouped so the response stays provable.
    expect(result.compiled).toHaveLength(2);
    for (const { promql } of result.compiled) {
      expect(promql).toContain(`${PROJECT_LABEL}="${P}"`);
    }
    expect(result.compiled[0]?.promql).toContain(`sum by (method, ${PROJECT_LABEL})`);
    expect(result.compiled[1]?.promql).toContain(`sum by (le, ${PROJECT_LABEL})`);
    // $__rate_interval resolved against the 3600s step.
    expect(result.compiled[0]?.promql).toContain('[4h]');
  });

  it('gives every series a distinct, refetch-stable id', async () => {
    const answer = {
      status: 'success',
      data: {
        resultType: 'matrix',
        result: [seriesAt({ method: 'GET' }, 12), seriesAt({ method: 'POST' }, 3)],
      },
    };
    queryRange.mockResolvedValue(answer);

    const first = await executeMetricPanel({
      projectId: P, queries, interval: 'hour',
      startDate: '2024-01-01T00:00:00.000Z', endDate: '2024-01-02T00:00:00.000Z',
    });

    // Same data, series returned in the opposite order.
    queryRange.mockResolvedValue({
      status: 'success',
      data: { resultType: 'matrix', result: [...answer.data.result].reverse() },
    });

    const second = await executeMetricPanel({
      projectId: P, queries, interval: 'hour',
      startDate: '2024-01-01T00:00:00.000Z', endDate: '2024-01-02T00:00:00.000Z',
    });

    const ids = (r: typeof first) => new Set(r.chart.series.map((s) => s.id));
    expect(ids(first).size).toBe(first.chart.series.length);
    expect(ids(first)).toEqual(ids(second));
  });
});
