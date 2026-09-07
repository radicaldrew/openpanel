import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock's factory is hoisted above the module body, so the spies have to be
// created inside vi.hoisted rather than as plain top-level consts.
const { queryRange, queryInstant } = vi.hoisted(() => ({
  queryRange: vi.fn(),
  queryInstant: vi.fn(),
}));

vi.mock('@openpanel/gigapipe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openpanel/gigapipe')>();
  return { ...actual, queryRange, queryInstant };
});

import { GigapipeError, PROJECT_LABEL } from '@openpanel/gigapipe';
import type { IPanelQuery } from '@openpanel/validation';
import { executeMetricPanel } from './panel';

const P = 'proj_123';

const query = (partial: Partial<IPanelQuery> & { refId: string }): IPanelQuery => ({
  expr: 'rate(http_requests_total[5m])',
  mode: 'code',
  hidden: false,
  unit: 'none',
  yAxis: 'left',
  instant: false,
  ...partial,
});

const base = {
  projectId: P,
  interval: 'hour' as const,
  startDate: '2024-01-01T00:00:00.000Z',
  endDate: '2024-01-02T00:00:00.000Z',
};

/** One matrix series, sampled on the hour across the whole range. */
function series(labels: Record<string, string>, value = 1) {
  const values: [number, string][] = [];
  const start = Date.parse('2024-01-01T00:00:00.000Z') / 1000;

  for (let i = 0; i <= 24; i += 1) {
    values.push([start + i * 3600, String(value)]);
  }

  return { metric: { [PROJECT_LABEL]: P, ...labels }, values };
}

const matrix = (...result: ReturnType<typeof series>[]) => ({
  status: 'success',
  data: { resultType: 'matrix', result },
});

const emptyMatrix = matrix();

/** The params the panel sent to gigapipe on range-query call `n`. */
const sent = (n = 0) => queryRange.mock.calls[n]?.[0];

beforeEach(() => {
  queryRange.mockReset();
  queryInstant.mockReset();
  queryRange.mockResolvedValue(emptyMatrix);
  queryInstant.mockResolvedValue({
    status: 'success',
    data: { resultType: 'vector', result: [] },
  });
});

/**
 * The pipeline order is the security argument: substitute, then scope, then
 * check, then send. Anything that reorders these lets a variable value reach
 * gigapipe through a selector the rewriter never saw.
 */
describe('every query is scoped before it is sent', () => {
  it('injects the project matcher into every selector', async () => {
    await executeMetricPanel({ ...base, queries: [query({ refId: 'A' })] });

    expect(sent().promql).toContain(`http_requests_total{${PROJECT_LABEL}="${P}"`);
  });

  it('scopes each query of a multi-query panel', async () => {
    await executeMetricPanel({
      ...base,
      queries: [
        query({ refId: 'A', expr: 'rate(a_total[5m])' }),
        query({ refId: 'B', expr: 'rate(b_total[5m])' }),
      ],
    });

    expect(queryRange).toHaveBeenCalledTimes(2);
    for (const call of queryRange.mock.calls) {
      expect(call[0].promql).toContain(`${PROJECT_LABEL}="${P}"`);
    }
  });

  it('keeps the project label through an aggregation, so the response is provable', async () => {
    await executeMetricPanel({
      ...base,
      queries: [query({ refId: 'A', expr: 'sum by (method) (rate(x[5m]))' })],
    });

    expect(sent().promql).toContain(`sum by (method, ${PROJECT_LABEL})`);
  });

  it('substitutes variables BEFORE scoping, so the rewriter sees the final string', async () => {
    await executeMetricPanel({
      ...base,
      variables: { service: 'api' },
      queries: [query({ refId: 'A', expr: 'up{job=~"$service"}' })],
    });

    // Wrapped for the wide step, but the selector inside carries both the
    // substituted value and the tenancy matcher.
    expect(sent().promql).toContain(`up{${PROJECT_LABEL}="${P}",job=~"api"}`);
  });

  it('a variable value cannot introduce an unscoped selector', async () => {
    await executeMetricPanel({
      ...base,
      variables: { service: 'a"} or up{b="c' },
      queries: [query({ refId: 'A', expr: 'up{job=~"$service"}' })],
    });

    // Exactly ONE selector went out. The `up{` the value tried to smuggle in
    // is there in the text, but backslash-escaped — `up\{` — so it is data
    // inside a string literal rather than a second, unscoped selection.
    expect(queryRange).toHaveBeenCalledTimes(1);
    expect(sent().promql).toContain(`up{${PROJECT_LABEL}="${P}",job=~"`);
    expect(sent().promql.match(/up\{/g)).toHaveLength(1);
    expect(sent().promql.match(new RegExp(PROJECT_LABEL, 'g'))).toHaveLength(1);
  });

  it('resolves $__rate_interval against the step actually used', async () => {
    // Hourly over a day: a 3600s step, so four steps is 4h.
    await executeMetricPanel({
      ...base,
      queries: [query({ refId: 'A', expr: 'rate(x[$__rate_interval])' })],
    });

    expect(sent().promql).toContain('[4h]');
  });

  it('refuses a query the grammar cannot parse rather than forwarding it', async () => {
    await expect(
      executeMetricPanel({
        ...base,
        queries: [query({ refId: 'B', expr: 'sum by (' })],
      }),
    ).rejects.toThrow(/^Query B: /);

    expect(queryRange).not.toHaveBeenCalled();
  });
});

describe('hidden and empty queries', () => {
  it('does not run a hidden query', async () => {
    await executeMetricPanel({
      ...base,
      queries: [query({ refId: 'A' }), query({ refId: 'B', hidden: true })],
    });

    expect(queryRange).toHaveBeenCalledTimes(1);
  });

  it('does not run an empty expression, which is what a new row is', async () => {
    await executeMetricPanel({
      ...base,
      queries: [query({ refId: 'A', expr: '   ' })],
    });

    expect(queryRange).not.toHaveBeenCalled();
  });

  it('returns an empty chart rather than throwing when nothing is visible', async () => {
    const result = await executeMetricPanel({
      ...base,
      queries: [query({ refId: 'A', hidden: true })],
    });

    expect(result.chart.series).toEqual([]);
    expect(result.compiled).toEqual([]);
  });

  it('hiding a query does not relabel the ones after it', async () => {
    queryRange.mockResolvedValue(matrix(series({ method: 'GET' })));

    const result = await executeMetricPanel({
      ...base,
      queries: [
        query({ refId: 'A', hidden: true }),
        query({ refId: 'B', expr: 'rate(b_total[5m])' }),
        query({ refId: 'C', expr: 'rate(c_total[5m])' }),
      ],
    });

    // B is still (B) and C is still (C): the alpha prefix comes from the
    // query's index in the panel, not from its position among the visible ones.
    const names = result.chart.series.map((s) => s.names[0]);
    expect(names.some((n) => n?.startsWith('(B)'))).toBe(true);
    expect(names.some((n) => n?.startsWith('(C)'))).toBe(true);
    expect(names.some((n) => n?.startsWith('(A)'))).toBe(false);
  });
});

describe('series naming and identity', () => {
  it('names a series from its legendFormat', async () => {
    queryRange.mockResolvedValue(
      matrix(series({ method: 'GET', status: '200' })),
    );

    const result = await executeMetricPanel({
      ...base,
      queries: [query({ refId: 'A', legendFormat: '{{method}} {{status}}' })],
    });

    expect(result.chart.series[0]?.names[0]).toBe('(A) GET 200');
  });

  it('falls back to the label set when there is no legendFormat', async () => {
    queryRange.mockResolvedValue(matrix(series({ method: 'GET' })));

    const result = await executeMetricPanel({
      ...base,
      queries: [
        query({ refId: 'A', expr: 'rate(a[5m])' }),
        query({ refId: 'B', expr: 'rate(b[5m])' }),
      ],
    });

    expect(result.chart.series[0]?.names[0]).toContain('{method="GET"}');
  });

  it('never leaks the project label into a legend', async () => {
    queryRange.mockResolvedValue(matrix(series({ method: 'GET' })));

    const result = await executeMetricPanel({
      ...base,
      queries: [query({ refId: 'A' })],
    });

    for (const s of result.chart.series) {
      expect(s.names.join(' ')).not.toContain(PROJECT_LABEL);
      expect(s.id).not.toContain(PROJECT_LABEL);
    }
  });

  it('gives two queries with identical labels distinct series, not one merged line', async () => {
    queryRange.mockResolvedValue(matrix(series({ method: 'GET' })));

    const result = await executeMetricPanel({
      ...base,
      queries: [
        query({ refId: 'A', expr: 'rate(a[5m])' }),
        query({ refId: 'B', expr: 'rate(b[5m])' }),
      ],
    });

    expect(result.chart.series).toHaveLength(2);
    expect(new Set(result.chart.series.map((s) => s.id)).size).toBe(2);
  });

  it('keeps a series id stable across refetches', async () => {
    queryRange.mockResolvedValue(
      matrix(series({ method: 'GET' }), series({ method: 'POST' })),
    );

    const first = await executeMetricPanel({
      ...base,
      queries: [query({ refId: 'A' })],
    });

    // Same series, returned in the other order.
    queryRange.mockResolvedValue(
      matrix(series({ method: 'POST' }), series({ method: 'GET' })),
    );

    const second = await executeMetricPanel({
      ...base,
      queries: [query({ refId: 'A' })],
    });

    expect(new Set(first.chart.series.map((s) => s.id))).toEqual(
      new Set(second.chart.series.map((s) => s.id)),
    );
  });
});

describe('per-series metadata for the renderer', () => {
  it('carries refId, unit and y-axis onto every series', async () => {
    queryRange.mockResolvedValue(matrix(series({ method: 'GET' })));

    const result = await executeMetricPanel({
      ...base,
      queries: [
        query({ refId: 'A', expr: 'rate(a[5m])', unit: 'ops' }),
        query({
          refId: 'B',
          expr: 'rate(b[5m])',
          unit: 'seconds',
          yAxis: 'right',
        }),
      ],
    });

    const meta = Object.fromEntries(
      result.chart.series.map((s) => [s.panel?.refId, s.panel]),
    );

    expect(meta.A).toEqual({ refId: 'A', unit: 'ops', yAxis: 'left' });
    expect(meta.B).toEqual({ refId: 'B', unit: 'seconds', yAxis: 'right' });
  });
});

describe('failures name the query that caused them', () => {
  it('prefixes the upstream message with the refId', async () => {
    queryRange.mockRejectedValue(
      new GigapipeError('Query is too large — narrow the time range', 413),
    );

    await expect(
      executeMetricPanel({ ...base, queries: [query({ refId: 'B' })] }),
    ).rejects.toThrow('Query B: Query is too large — narrow the time range');
  });

  it('keeps the 413 status, so the UI still says "narrow" rather than retrying', async () => {
    queryRange.mockRejectedValue(new GigapipeError('too big', 413));

    await expect(
      executeMetricPanel({ ...base, queries: [query({ refId: 'A' })] }),
    ).rejects.toMatchObject({ name: 'GigapipeError', status: 413 });
  });

  it('reports the FIRST failing query, not whichever lost the race', async () => {
    // B resolves slowly and A fails immediately; C fails too. The message must
    // name B — the first in query order — on every run.
    queryRange
      .mockResolvedValueOnce(emptyMatrix)
      .mockRejectedValueOnce(new Error('b broke'))
      .mockRejectedValueOnce(new Error('c broke'));

    await expect(
      executeMetricPanel({
        ...base,
        queries: [
          query({ refId: 'A', expr: 'rate(a[5m])' }),
          query({ refId: 'B', expr: 'rate(b[5m])' }),
          query({ refId: 'C', expr: 'rate(c[5m])' }),
        ],
      }),
    ).rejects.toThrow('Query B: b broke');
  });

  it('a failing query fails the whole panel — no half-rendered chart', async () => {
    queryRange
      .mockResolvedValueOnce(matrix(series({ method: 'GET' })))
      .mockRejectedValueOnce(new Error('nope'));

    await expect(
      executeMetricPanel({
        ...base,
        queries: [
          query({ refId: 'A', expr: 'rate(a[5m])' }),
          query({ refId: 'B', expr: 'rate(b[5m])' }),
        ],
      }),
    ).rejects.toThrow(/^Query B/);
  });

  it('refuses a response carrying another project, whatever else is on the panel', async () => {
    queryRange.mockResolvedValue({
      status: 'success',
      data: {
        resultType: 'matrix',
        result: [{ metric: { [PROJECT_LABEL]: 'someone-else' }, values: [] }],
      },
    });

    await expect(
      executeMetricPanel({ ...base, queries: [query({ refId: 'A' })] }),
    ).rejects.toThrow(/different project/);
  });

  it('refuses a response with no project label at all', async () => {
    queryRange.mockResolvedValue({
      status: 'success',
      data: { resultType: 'matrix', result: [{ metric: {}, values: [] }] },
    });

    await expect(
      executeMetricPanel({ ...base, queries: [query({ refId: 'A' })] }),
    ).rejects.toThrow(new RegExp(`no ${PROJECT_LABEL} label`));
  });
});

describe('step and downsampling', () => {
  it('wraps a wide step in a subquery, as the single-query engine does', async () => {
    await executeMetricPanel({ ...base, queries: [query({ refId: 'A' })] });

    expect(sent().step).toBe('3600s');
    expect(sent().promql).toMatch(/^avg_over_time\(\(.*\)\[3600s:300s\]\)$/);
  });

  it('raises the panel step to the widest min step, and says so', async () => {
    const result = await executeMetricPanel({
      ...base,
      interval: 'minute',
      startDate: '2024-01-01T00:00:00.000Z',
      endDate: '2024-01-01T02:00:00.000Z',
      queries: [
        query({ refId: 'A', expr: 'rate(a[5m])' }),
        query({ refId: 'B', expr: 'rate(b[5m])', minStep: '5m' }),
      ],
    });

    // One grid for the panel: a query drawn at a coarser step than its
    // neighbours would leave the buckets between reading as zero.
    expect(sent(0).step).toBe('300s');
    expect(sent(1).step).toBe('300s');
    expect(result.notices.some((n) => n.includes("query B's min step"))).toBe(
      true,
    );
  });

  it('ignores a min step that is not a duration, with a notice', async () => {
    const result = await executeMetricPanel({
      ...base,
      queries: [query({ refId: 'A', minStep: 'five minutes' })],
    });

    expect(sent().step).toBe('3600s');
    expect(result.notices.some((n) => n.includes('is not a Prometheus duration'))).toBe(
      true,
    );
  });

  it('does not lower the step below the interval', async () => {
    await executeMetricPanel({
      ...base,
      queries: [query({ refId: 'A', minStep: '1s' })],
    });

    expect(sent().step).toBe('3600s');
  });
});

describe('instant queries', () => {
  it('goes to the instant endpoint, evaluated at the end of the range', async () => {
    await executeMetricPanel({
      ...base,
      queries: [query({ refId: 'A', instant: true })],
    });

    expect(queryRange).not.toHaveBeenCalled();
    expect(queryInstant).toHaveBeenCalledTimes(1);
    expect(queryInstant.mock.calls[0]?.[0].time.toISOString()).toBe(
      base.endDate,
    );
  });

  it('produces one point per series, at the last bucket', async () => {
    queryInstant.mockResolvedValue({
      status: 'success',
      data: {
        resultType: 'vector',
        result: [
          {
            metric: { [PROJECT_LABEL]: P, method: 'GET' },
            value: [Date.parse('2024-01-02T00:00:00.000Z') / 1000, '42'],
          },
        ],
      },
    });

    const result = await executeMetricPanel({
      ...base,
      queries: [query({ refId: 'A', instant: true })],
    });

    expect(result.chart.series[0]?.data).toHaveLength(1);
    expect(result.chart.series[0]?.data[0]?.count).toBe(42);
    // A single sample: Min and Max are that sample, not a measured range.
    expect(result.chart.series[0]?.metrics.min).toBe(42);
    expect(result.chart.series[0]?.metrics.max).toBe(42);
  });

  it('drops a series whose only sample is NaN rather than drawing a zero', async () => {
    queryInstant.mockResolvedValue({
      status: 'success',
      data: {
        resultType: 'vector',
        result: [
          { metric: { [PROJECT_LABEL]: P }, value: [1_704_153_600, 'NaN'] },
        ],
      },
    });

    const result = await executeMetricPanel({
      ...base,
      queries: [query({ refId: 'A', instant: true })],
    });

    expect(result.chart.series).toEqual([]);
  });

  it('runs range and instant queries side by side on one panel', async () => {
    await executeMetricPanel({
      ...base,
      queries: [
        query({ refId: 'A', expr: 'rate(a[5m])' }),
        query({ refId: 'B', expr: 'b_gauge', instant: true }),
      ],
    });

    expect(queryRange).toHaveBeenCalledTimes(1);
    expect(queryInstant).toHaveBeenCalledTimes(1);
  });
});

describe('the previous period', () => {
  it('runs every visible query again over the preceding window', async () => {
    queryRange.mockResolvedValue(matrix(series({ method: 'GET' })));

    await executeMetricPanel({
      ...base,
      previous: true,
      queries: [
        query({ refId: 'A', expr: 'rate(a[5m])' }),
        query({ refId: 'B', expr: 'rate(b[5m])' }),
      ],
    });

    expect(queryRange).toHaveBeenCalledTimes(4);
    expect(sent(2).start.toISOString()).toBe('2023-12-31T00:00:00.000Z');
    expect(sent(2).end.toISOString()).toBe(base.startDate);
  });

  it('compares a series against its own history, not another one', async () => {
    queryRange.mockResolvedValue(
      matrix(series({ method: 'GET' }, 10), series({ method: 'POST' }, 2)),
    );

    const result = await executeMetricPanel({
      ...base,
      previous: true,
      queries: [query({ refId: 'A' })],
    });

    for (const s of result.chart.series) {
      expect(s.metrics.previous).toBeDefined();
    }
  });
});

describe('the compiled queries it reports back', () => {
  it('returns what actually ran, per visible query', async () => {
    const result = await executeMetricPanel({
      ...base,
      queries: [
        query({ refId: 'A', expr: 'rate(a_total[5m])' }),
        query({ refId: 'B', expr: 'rate(b_total[5m])', hidden: true }),
        query({ refId: 'C', expr: 'rate(c_total[5m])' }),
      ],
    });

    expect(result.compiled.map((c) => c.refId)).toEqual(['A', 'C']);
    expect(result.compiled[0]?.promql).toContain('a_total');
    expect(result.compiled[1]?.promql).toContain('c_total');
    // The scoped, downsampled string — not the expression the user typed.
    expect(result.compiled[0]?.promql).toContain(`${PROJECT_LABEL}="${P}"`);
  });
});

describe('series caps', () => {
  it('caps each query separately, so no query silently disappears', async () => {
    queryRange.mockResolvedValue(
      matrix(
        ...Array.from({ length: 30 }, (_, i) => series({ pod: `p${i}` }, i + 1)),
      ),
    );

    const result = await executeMetricPanel({
      ...base,
      seriesLimit: 5,
      queries: [
        query({ refId: 'A', expr: 'rate(a[5m])' }),
        query({ refId: 'B', expr: 'rate(b[5m])' }),
      ],
    });

    expect(result.chart.series).toHaveLength(10);
    expect(result.notices.some((n) => n.includes('5 largest series'))).toBe(true);
  });
});

/**
 * The per-query cap stops one query starving another; it does not bound the
 * chart. Ten queries at twenty series each is two hundred lines on a palette of
 * about twenty.
 */
describe('the panel-wide cap', () => {
  const manySeries = (n: number, prefix: string) =>
    matrix(...Array.from({ length: n }, (_, i) => series({ pod: `${prefix}${i}` }, i + 1)));

  it('bounds the whole panel, not just each query', async () => {
    queryRange.mockResolvedValue(manySeries(30, 'p'));

    const result = await executeMetricPanel({
      ...base,
      seriesLimit: 10,
      queries: [
        query({ refId: 'A', expr: 'rate(a[5m])' }),
        query({ refId: 'B', expr: 'rate(b[5m])' }),
        query({ refId: 'C', expr: 'rate(c[5m])' }),
      ],
    });

    // Three queries capped at 10 each would be 30; the panel ceiling is 2x.
    expect(result.chart.series).toHaveLength(20);
  });

  it('names the queries that lost series', async () => {
    queryRange.mockResolvedValue(manySeries(30, 'p'));

    const result = await executeMetricPanel({
      ...base,
      seriesLimit: 10,
      queries: [
        query({ refId: 'A', expr: 'rate(a[5m])' }),
        query({ refId: 'B', expr: 'rate(b[5m])' }),
        query({ refId: 'C', expr: 'rate(c[5m])' }),
      ],
    });

    const notice = result.notices.find((n) => n.includes('across the panel'));
    expect(notice).toBeDefined();
    expect(notice).toMatch(/Queries .* were trimmed/);
  });

  it('never drops a query entirely — every query keeps at least one line', async () => {
    // A query returning one line must not be squeezed out by a query returning
    // eighty; that would silently delete the comparison someone added.
    queryRange
      .mockResolvedValueOnce(manySeries(40, 'big'))
      .mockResolvedValueOnce(matrix(series({ pod: 'only' }, 1)));

    const result = await executeMetricPanel({
      ...base,
      seriesLimit: 10,
      queries: [
        query({ refId: 'A', expr: 'rate(a[5m])' }),
        query({ refId: 'B', expr: 'rate(b[5m])' }),
      ],
    });

    const refIds = new Set(result.chart.series.map((s) => s.panel?.refId));
    expect(refIds.has('A')).toBe(true);
    expect(refIds.has('B')).toBe(true);
  });

  it('leaves a panel under the ceiling completely alone', async () => {
    queryRange.mockResolvedValue(matrix(series({ pod: 'a' }), series({ pod: 'b' })));

    const result = await executeMetricPanel({
      ...base,
      queries: [query({ refId: 'A' }), query({ refId: 'B', expr: 'rate(b[5m])' })],
    });

    expect(result.chart.series).toHaveLength(4);
    expect(result.notices.some((n) => n.includes('across the panel'))).toBe(false);
  });
});
