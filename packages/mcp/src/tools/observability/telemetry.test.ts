import { beforeEach, describe, expect, it, vi } from 'vitest';

const { executeMetricChart, executeMetricPanel } = vi.hoisted(() => ({
  executeMetricChart: vi.fn(),
  executeMetricPanel: vi.fn(),
}));

vi.mock('@openpanel/db', () => ({
  executeMetricChart,
  executeMetricPanel,
  getTelemetryLabelKeys: vi.fn(),
  getTelemetryLabelValues: vi.fn(),
  getTelemetryMetricNames: vi.fn(),
  getTelemetryServices: vi.fn(),
  getTrace: vi.fn(),
  searchTraces: vi.fn(),
}));

vi.mock('@openpanel/gigapipe', () => ({ isGigapipeEnabled: () => true }));

vi.mock('../shared', () => ({
  projectIdSchema: () => ({ optional: () => ({}) }),
  resolveProjectId: async (_ctx: unknown, id: string) => id ?? 'proj_123',
  withErrorHandling: async (fn: () => unknown) => fn(),
}));

import { registerTelemetryTools } from './telemetry';

/** Capture the handler each `server.tool(...)` registers. */
function collectTools() {
  const handlers = new Map<string, (args: any) => Promise<any>>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, handler: any) => {
      handlers.set(name, handler);
    },
  };

  registerTelemetryTools(server as never, { projectId: 'proj_123' } as never);

  return handlers;
}

const emptyChart = { series: [], metrics: {} };

beforeEach(() => {
  executeMetricChart.mockReset();
  executeMetricPanel.mockReset();
  executeMetricChart.mockResolvedValue({
    chart: emptyChart,
    compiled: 'sum by (op_project_id)(rate(x{op_project_id="proj_123"}[5m]))',
    notices: [],
  });
  executeMetricPanel.mockResolvedValue({
    chart: emptyChart,
    compiled: [{ refId: 'A', promql: 'up{op_project_id="proj_123"}' }],
    notices: [],
  });
});

const base = {
  projectId: 'proj_123',
  fn: 'rate' as const,
  aggregation: 'sum' as const,
  groupBy: [],
  matchers: [],
  interval: 'hour' as const,
  startDate: '2024-01-01T00:00:00.000Z',
  endDate: '2024-01-02T00:00:00.000Z',
};

/**
 * The structured path serves the alert cron, this tool and the chat agent, and
 * it has to keep working untouched while the PromQL path is added beside it.
 */
describe('query_metric', () => {
  it('still runs the structured compiler when given a metric', async () => {
    const handler = collectTools().get('query_metric')!;

    await handler({ ...base, metric: 'http_requests_total' });

    expect(executeMetricChart).toHaveBeenCalledTimes(1);
    expect(executeMetricPanel).not.toHaveBeenCalled();
    expect(executeMetricChart.mock.calls[0]?.[0]?.query).toMatchObject({
      metric: 'http_requests_total',
      fn: 'rate',
      aggregation: 'sum',
    });
  });

  it('routes raw PromQL to the panel engine', async () => {
    const handler = collectTools().get('query_metric')!;

    await handler({
      ...base,
      queries: [{ expr: 'up', unit: 'ops', legendFormat: '{{job}}' }],
    });

    expect(executeMetricPanel).toHaveBeenCalledTimes(1);
    expect(executeMetricChart).not.toHaveBeenCalled();

    const sent = executeMetricPanel.mock.calls[0]?.[0];
    expect(sent.queries).toEqual([
      {
        refId: 'A',
        expr: 'up',
        mode: 'code',
        hidden: false,
        unit: 'ops',
        yAxis: 'left',
        instant: false,
        legendFormat: '{{job}}',
      },
    ]);
  });

  it('labels several queries A, B, C so the reply is quotable into a panel', async () => {
    const handler = collectTools().get('query_metric')!;

    await handler({
      ...base,
      queries: [{ expr: 'a' }, { expr: 'b' }, { expr: 'c' }],
    });

    expect(
      executeMetricPanel.mock.calls[0]?.[0]?.queries.map((q: any) => q.refId),
    ).toEqual(['A', 'B', 'C']);
  });

  it('prefers queries when both are sent, rather than running two engines', async () => {
    const handler = collectTools().get('query_metric')!;

    await handler({ ...base, metric: 'http_requests_total', queries: [{ expr: 'up' }] });

    expect(executeMetricPanel).toHaveBeenCalledTimes(1);
    expect(executeMetricChart).not.toHaveBeenCalled();
  });

  it('defaults unit and instant rather than sending undefined', async () => {
    const handler = collectTools().get('query_metric')!;

    await handler({ ...base, queries: [{ expr: 'up' }] });

    expect(executeMetricPanel.mock.calls[0]?.[0]?.queries[0]).toMatchObject({
      unit: 'none',
      instant: false,
      yAxis: 'left',
    });
  });

  it('tells the model what to send when neither is given', async () => {
    const handler = collectTools().get('query_metric')!;

    const result = await handler({ ...base });

    expect(result.error).toMatch(/needs either `metric`.*or `queries`/);
    expect(executeMetricChart).not.toHaveBeenCalled();
    expect(executeMetricPanel).not.toHaveBeenCalled();
  });

  it('returns the compiled PromQL for both paths, so a human can check it', async () => {
    const handler = collectTools().get('query_metric')!;

    const structured = await handler({ ...base, metric: 'x' });
    expect(structured.promql).toContain('op_project_id');

    const raw = await handler({ ...base, queries: [{ expr: 'up' }] });
    expect(raw.promql).toEqual([
      { refId: 'A', promql: 'up{op_project_id="proj_123"}' },
    ]);
  });
});
