import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock's factory is hoisted above the module body, so the spy has to be
// created inside vi.hoisted rather than as a plain top-level const.
const { queryRange } = vi.hoisted(() => ({ queryRange: vi.fn() }));

vi.mock('@openpanel/gigapipe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openpanel/gigapipe')>();
  return { ...actual, queryRange };
});

import { executeMetricChart } from './index';

const emptyMatrix = { status: 'success', data: { resultType: 'matrix', result: [] } };

const base = {
  projectId: 'proj_123',
  query: { metric: 'http_requests_total', fn: 'rate' as const },
  interval: 'hour' as const,
  startDate: '2024-01-01T00:00:00.000Z',
  endDate: '2024-01-02T00:00:00.000Z',
};

/** The params the engine sent to gigapipe on call `n`. */
const sent = (n = 0) => queryRange.mock.calls[n]?.[0];

beforeEach(() => {
  queryRange.mockReset();
  queryRange.mockResolvedValue(emptyMatrix);
});

/**
 * gigapipe returns an EMPTY result — not a sparse one — for any step wider than
 * roughly twice its 300s fill staleness. The metrics page defaults to an hourly
 * interval, so before this the page listed every metric name and drew nothing.
 */
describe('wide steps are evaluated as subqueries', () => {
  it('wraps the query when the step exceeds what gigapipe answers directly', async () => {
    await executeMetricChart(base);

    expect(sent().step).toBe('3600s');
    expect(sent().promql).toMatch(/^avg_over_time\(\(.*\)\[3600s:300s\]\)$/);
  });

  it('sends the query unwrapped when the step is narrow enough', async () => {
    // 2h at minute resolution = 120 points, so the step stays at 60s.
    await executeMetricChart({
      ...base,
      interval: 'minute',
      startDate: '2024-01-01T00:00:00.000Z',
      endDate: '2024-01-01T02:00:00.000Z',
    });

    expect(sent().step).toBe('60s');
    expect(sent().promql).not.toContain('avg_over_time');
  });

  it('sizes the rate window from the inner step, not the outer one', async () => {
    // Four times the 300s inner step. Sizing it off the 3600s outer step would
    // put a 4h window on an hourly chart and flatten what it exists to show.
    await executeMetricChart(base);

    expect(sent().promql).toContain('[1200s]');
    expect(sent().promql).not.toContain('[14400s]');
  });

  it('reports the query it actually sent, so "show query" is not a fiction', async () => {
    const result = await executeMetricChart(base);

    expect(result.compiled).toBe(sent().promql);
  });
});

describe('step selection', () => {
  it('uses the requested interval when the range fits', async () => {
    // 24h at hourly = 24 points.
    await executeMetricChart(base);
    expect(sent().step).toBe('3600s');
  });

  it('coarsens rather than failing when the range is too long', async () => {
    // 90 days at minute resolution is ~130k points: more than Prometheus will
    // return and more than a screen can draw. The user wants the 90-day chart.
    const result = await executeMetricChart({
      ...base,
      interval: 'minute',
      startDate: '2024-01-01T00:00:00.000Z',
      endDate: '2024-03-31T00:00:00.000Z',
    });

    expect(Number.parseInt(sent().step, 10)).toBeGreaterThan(60);
    expect(result.notices.join(' ')).toMatch(/coarsened/i);
  });

  it('says so when it coarsens, so the axis never silently disagrees with the control', async () => {
    const result = await executeMetricChart({
      ...base,
      interval: 'minute',
      startDate: '2024-01-01T00:00:00.000Z',
      endDate: '2024-03-31T00:00:00.000Z',
    });

    expect(result.notices.length).toBeGreaterThan(0);
  });
});

describe('rate window', () => {
  it('never rates over a window shorter than the evaluation step', async () => {
    // A rate window narrower than the step samples the gaps between buckets and
    // draws a sawtooth that reads as real instability.
    //
    // At an hourly interval the query is evaluated as a subquery, so the step
    // the window has to clear is the INNER one (300s), not the 3600s bucket
    // width. Four times the outer step would put a 4h window on an hourly
    // chart and flatten exactly what the chart exists to show.
    const result = await executeMetricChart({
      ...base,
      query: { metric: 'm', fn: 'rate', window: '1m' },
    });

    expect(sent().promql).toContain('[1200s]'); // 4 x 300s inner step
    expect(result.notices.join(' ')).toMatch(/widened/i);
  });

  it('keeps a window that is already wide enough', async () => {
    const result = await executeMetricChart({
      ...base,
      query: { metric: 'm', fn: 'rate', window: '6h' },
    });

    expect(sent().promql).toContain('[6h]');
    expect(result.notices.join(' ')).not.toMatch(/widened/i);
  });

  it('omits the window entirely for a raw vector', async () => {
    await executeMetricChart({
      ...base,
      query: { metric: 'm', fn: 'raw' },
    });

    // The outer brackets here are the engine's own subquery downsampling, not a
    // rate window, so the assertion is about the expression INSIDE them.
    const inner = sent().promql.replace(
      /^avg_over_time\(\((.*)\)\[\d+s:\d+s\]\)$/,
      '$1',
    );

    expect(inner).not.toContain('[');
  });
});

describe('tenancy', () => {
  it('sends a query scoped to the project', async () => {
    await executeMetricChart(base);
    expect(sent().promql).toContain('op_project_id="proj_123"');
  });
});

describe('previous period', () => {
  it('does not query twice unless asked', async () => {
    await executeMetricChart(base);
    expect(queryRange).toHaveBeenCalledTimes(1);
  });

  it('shifts by the range length, matching the event engine', async () => {
    await executeMetricChart({ ...base, previous: true });

    expect(queryRange).toHaveBeenCalledTimes(2);

    const current = sent(0);
    const previous = sent(1);
    const span = current.end.getTime() - current.start.getTime();

    expect(previous.end.getTime()).toBe(current.start.getTime());
    expect(previous.start.getTime()).toBe(current.start.getTime() - span);
  });

  it('uses the same step for both periods so the series align', async () => {
    await executeMetricChart({ ...base, previous: true });
    expect(sent(1).step).toBe(sent(0).step);
  });
});

describe('output', () => {
  it('returns a FinalChart plus the query that produced it', async () => {
    const result = await executeMetricChart(base);

    expect(result.chart).toHaveProperty('series');
    expect(result.chart).toHaveProperty('metrics');
    expect(result.compiled).toContain('http_requests_total');
  });

  const at = (hour: number) =>
    new Date(`2024-01-01T${String(hour).padStart(2, '0')}:00:00.000Z`).getTime() /
    1000;

  const matrixOf = (values: [number, string][]) => ({
    status: 'success',
    data: {
      resultType: 'matrix',
      result: [{ metric: { op_project_id: 'proj_123' }, values }],
    },
  });

  it('fills a gap INSIDE the data so an omitted step cannot shift the line', async () => {
    // Prometheus omits empty steps. Without filling, the 05:00 point would be
    // drawn in the 01:00 slot and every later point would be misdated.
    queryRange.mockResolvedValue(matrixOf([
      [at(0), '5'],
      [at(5), '9'],
    ]));

    const result = await executeMetricChart(base);
    const series = result.chart.series[0];

    expect(series?.data.map((d) => d.count)).toEqual([5, 0, 0, 0, 0, 9]);
  });

  /**
   * A bucket with no sample renders as zero, not as a gap, so a grid stretched
   * over the whole range draws a cliff to zero on both sides of the data. On a
   * gauge that sat at 1 all day that reads as an outage rather than as the edge
   * of what was measured.
   */
  it('does not invent zeros outside the span the backend covered', async () => {
    queryRange.mockResolvedValue(matrixOf([
      [at(10), '1'],
      [at(11), '1'],
    ]));

    const result = await executeMetricChart(base);
    const series = result.chart.series[0];

    expect(series?.data.map((d) => d.count)).toEqual([1, 1]);
  });

  it('keeps the full grid when a previous period is overlaid', async () => {
    // The two periods are aligned by index, so trimming one and not the other
    // would compare a bucket against the wrong hour.
    queryRange.mockResolvedValue(matrixOf([[at(10), '1']]));

    const result = await executeMetricChart({ ...base, previous: true });
    const series = result.chart.series[0];

    expect(series?.data.length).toBeGreaterThan(20);
  });

  it('rejects an unparseable date rather than querying a NaN range', async () => {
    await expect(
      executeMetricChart({ ...base, startDate: 'not-a-date' }),
    ).rejects.toThrow(/valid start and end date/);

    expect(queryRange).not.toHaveBeenCalled();
  });
});

describe('series capping', () => {
  const manySeries = (n: number) => ({
    status: 'success',
    data: {
      resultType: 'matrix',
      result: Array.from({ length: n }, (_, i) => ({
        metric: { op_project_id: 'proj_123', route: `/r${i}` },
        // Peak scales with i, so the ranking is unambiguous.
        values: [[1704067200, String(i)]],
      })),
    },
  });

  it('renders everything when under the limit', async () => {
    queryRange.mockResolvedValue(manySeries(5));
    const result = await executeMetricChart(base);

    expect(result.chart.series).toHaveLength(5);
    expect(result.notices.join(' ')).not.toMatch(/largest series/);
  });

  it('keeps the largest series and says how many it dropped', async () => {
    queryRange.mockResolvedValue(manySeries(50));
    const result = await executeMetricChart({ ...base, seriesLimit: 10 });

    expect(result.chart.series).toHaveLength(10);
    expect(result.notices.join(' ')).toMatch(/10 largest series of 50/);
  });

  it('ranks by peak, so a spike is never hidden', async () => {
    queryRange.mockResolvedValue(manySeries(30));
    const result = await executeMetricChart({ ...base, seriesLimit: 3 });

    // /r29, /r28, /r27 have the largest values.
    const names = result.chart.series.flatMap((s) => s.names);
    expect(names).toContain('/r29');
    expect(names).not.toContain('/r0');
  });

  it('caps the previous period to the SAME series, not its own top N', async () => {
    // Otherwise the two periods rank independently and a line is compared
    // against a different service's history.
    queryRange.mockResolvedValue(manySeries(30));
    const result = await executeMetricChart({
      ...base,
      previous: true,
      seriesLimit: 3,
    });

    expect(result.chart.series).toHaveLength(3);
  });
});
