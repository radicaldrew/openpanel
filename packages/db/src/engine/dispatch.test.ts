import { beforeEach, describe, expect, it, vi } from 'vitest';

const { normalize, executeMetricPanel, executeMetricChart } = vi.hoisted(() => ({
  normalize: vi.fn(),
  executeMetricPanel: vi.fn(),
  executeMetricChart: vi.fn(),
}));

vi.mock('./normalize', () => ({ normalize }));
vi.mock('./metrics/panel', () => ({ executeMetricPanel }));
vi.mock('./metrics', () => ({ executeMetricChart }));

import type { IReportInput } from '@openpanel/validation';
import { executeChart } from './index';

const emptyChart = {
  series: [],
  metrics: { sum: 0, average: 0, min: 0, max: 0, count: undefined },
};

const base = {
  projectId: 'proj_123',
  dataSource: 'metrics' as const,
  chartType: 'linear' as const,
  interval: 'hour' as const,
  series: [],
  breakdowns: [],
  range: '24h',
  previous: false,
  metric: 'sum' as const,
  metricQueries: [],
} as unknown as IReportInput;

beforeEach(() => {
  normalize.mockReset();
  executeMetricPanel.mockReset();
  executeMetricChart.mockReset();

  normalize.mockResolvedValue({
    interval: 'hour',
    startDate: '2024-01-01T00:00:00.000Z',
    endDate: '2024-01-02T00:00:00.000Z',
  });
  executeMetricPanel.mockResolvedValue({
    chart: emptyChart,
    compiled: [],
    notices: [],
  });
  executeMetricChart.mockResolvedValue({
    chart: emptyChart,
    compiled: '',
    notices: [],
  });
});

/**
 * The fallback IS the feature flag. New writes go to `metricQueries`; a report
 * saved before multi-query panels still carries only `metricQuery` and has to
 * keep rendering through the structured compiler until the migration has run
 * against it. Getting this branch wrong shows up as an empty panel, never as an
 * error, which is exactly how the last silent metrics regression went unnoticed.
 */
describe('executeChart dispatch for metric reports', () => {
  it('takes the panel path when the report has PromQL queries', async () => {
    await executeChart({
      ...base,
      metricQueries: [
        { refId: 'A', expr: 'up', mode: 'code', hidden: false, unit: 'none', yAxis: 'left', instant: false },
      ],
    } as unknown as IReportInput);

    expect(executeMetricPanel).toHaveBeenCalledTimes(1);
    expect(executeMetricChart).not.toHaveBeenCalled();
  });

  it('falls back to the structured compiler for a report saved before panels', async () => {
    await executeChart({
      ...base,
      metricQueries: [],
      metricQuery: { metric: 'http_requests_total', fn: 'rate' },
    } as unknown as IReportInput);

    expect(executeMetricChart).toHaveBeenCalledTimes(1);
    expect(executeMetricPanel).not.toHaveBeenCalled();
  });

  it('prefers the panel path when a migrated report still carries both', async () => {
    await executeChart({
      ...base,
      metricQuery: { metric: 'http_requests_total', fn: 'rate' },
      metricQueries: [
        { refId: 'A', expr: 'up', mode: 'code', hidden: false, unit: 'none', yAxis: 'left', instant: false },
      ],
    } as unknown as IReportInput);

    expect(executeMetricPanel).toHaveBeenCalledTimes(1);
    expect(executeMetricChart).not.toHaveBeenCalled();
  });

  it('treats an absent metricQueries the same as an empty one', async () => {
    const { metricQueries, ...withoutQueries } = base as Record<string, unknown>;

    await executeChart({
      ...withoutQueries,
      metricQuery: { metric: 'http_requests_total', fn: 'rate' },
    } as unknown as IReportInput);

    expect(executeMetricChart).toHaveBeenCalledTimes(1);
  });

  it('still refuses a metrics report with no query at all', async () => {
    await expect(executeChart(base)).rejects.toThrow(/requires a metricQuery/);
  });

  it('passes the dashboard variables through to the panel', async () => {
    await executeChart({
      ...base,
      variables: { service: ['api', 'worker'] },
      metricQueries: [
        { refId: 'A', expr: 'up{job=~"$service"}', mode: 'code', hidden: false, unit: 'none', yAxis: 'left', instant: false },
      ],
    } as unknown as IReportInput);

    expect(executeMetricPanel.mock.calls[0]?.[0]).toMatchObject({
      projectId: 'proj_123',
      variables: { service: ['api', 'worker'] },
      interval: 'hour',
      startDate: '2024-01-01T00:00:00.000Z',
      endDate: '2024-01-02T00:00:00.000Z',
    });
  });

  it('passes the previous-period flag through', async () => {
    await executeChart({
      ...base,
      previous: true,
      metricQueries: [
        { refId: 'A', expr: 'up', mode: 'code', hidden: false, unit: 'none', yAxis: 'left', instant: false },
      ],
    } as unknown as IReportInput);

    expect(executeMetricPanel.mock.calls[0]?.[0]?.previous).toBe(true);
  });
});
