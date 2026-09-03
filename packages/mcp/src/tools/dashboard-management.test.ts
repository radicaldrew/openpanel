import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const mockDb = vi.hoisted(() => ({
  $transaction: vi.fn(),
  dashboard: {
    create: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  report: {
    create: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  },
  reportLayout: {
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
}));

const mockGetDashboardById = vi.hoisted(() => vi.fn());
const mockGetProjectById = vi.hoisted(() => vi.fn());
const mockGetId = vi.hoisted(() => vi.fn());

// A PARTIAL mock: everything that talks to a database is replaced, everything
// that is pure is the real thing.
//
// `reportWriteData` is the single definition of the report column list that
// create_report and update_report now share. Hand-stubbing it here would
// recreate the very fourth copy that helper exists to delete — the stub could
// drift from the real column list and these tests would keep passing while the
// server wrote the wrong columns. So it comes from the real module.
//
// `Prisma` comes from the real module for the same reason. `reportWriteData`
// closes over the real `Prisma.DbNull`, so a fake one here would only reach
// duplicate_report, leaving two different spellings of SQL NULL in one suite.
vi.mock('@openpanel/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@openpanel/db')>()),
  db: mockDb,
  getDashboardById: mockGetDashboardById,
  getProjectById: mockGetProjectById,
  getId: mockGetId,
  resolveClientProjectId: vi.fn(
    ({
      clientProjectId,
      inputProjectId,
    }: {
      clientProjectId: string | null;
      inputProjectId?: string;
    }) => Promise.resolve(clientProjectId ?? inputProjectId),
  ),
}));

import type { McpAuthContext } from '../auth';
import { registerDashboardManagementTools } from './dashboard-management';

type Handler = (input: any) => Promise<any>;

function makeServer() {
  const handlers = new Map<string, Handler>();
  const schemas = new Map<string, any>();
  return {
    tool: (
      name: string,
      _description: string,
      schema: any,
      handler: Handler,
    ) => {
      handlers.set(name, handler);
      schemas.set(name, schema);
    },
    invoke: async (name: string, input: any) => {
      const schema = schemas.get(name);
      const parsed = z.object(schema).parse(input);
      const result = await handlers.get(name)!(parsed);
      const text = result.content[0].text;
      return result.isError ? { error: text } : JSON.parse(text);
    },
    schema(name: string) {
      return schemas.get(name);
    },
    names() {
      return [...schemas.keys()];
    },
  };
}

const READ_CONTEXT = {
  projectId: 'project-1',
  organizationId: 'organization-1',
  clientType: 'read' as const,
};

const ROOT_CONTEXT = {
  projectId: null,
  organizationId: 'organization-1',
  clientType: 'root' as const,
};

const DASHBOARD = {
  id: 'dashboard-1',
  projectId: 'project-1',
  organizationId: 'organization-1',
  name: 'Product',
  project: { id: 'project-1' },
};

const REPORT = {
  id: '11111111-1111-4111-8111-111111111111',
  projectId: 'project-1',
  dashboardId: 'dashboard-1',
  name: 'Signups',
  dataSource: 'events',
  metricQuery: null,
  events: [],
  globalFilters: [],
  interval: 'day',
  breakdowns: [],
  chartType: 'linear',
  lineType: 'monotone',
  range: '30d',
  formula: null,
  previous: false,
  unit: null,
  metric: 'sum',
  options: null,
  visibleSeries: [],
  startDate: null,
  endDate: null,
  layout: null,
};

/**
 * A stored METRIC row. The bug these fixtures defend against is a metric report
 * silently becoming an events report with an empty series — a panel that draws
 * nothing and reports no error — so every path that copies report columns needs
 * a row where `dataSource`/`metricQuery` are actually set to something.
 */
const METRIC_QUERY = {
  metric: 'http_request_duration_seconds',
  matchers: [],
  fn: 'rate' as const,
  aggregation: 'p95' as const,
  groupBy: ['route'],
};

const METRIC_REPORT = {
  ...REPORT,
  dataSource: 'metrics',
  metricQuery: METRIC_QUERY,
};

const EVENT_WITH_TYPED_COHORT_FILTER = {
  type: 'event',
  name: 'signup',
  segment: 'event',
  filters: [
    {
      id: 'A',
      name: 'plan',
      operator: 'is',
      value: ['pro'],
      type: 'string',
      cohortId: 'legacy-cohort',
      cohortIds: ['cohort-1', 'cohort-2'],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetDashboardById.mockResolvedValue(DASHBOARD);
  mockGetProjectById.mockResolvedValue({
    id: 'project-1',
    organizationId: 'organization-1',
  });
  mockGetId.mockResolvedValue('dashboard-2');
  mockDb.dashboard.create.mockResolvedValue({ ...DASHBOARD, id: 'dashboard-2' });
  mockDb.dashboard.findFirst.mockResolvedValue(DASHBOARD);
  mockDb.dashboard.update.mockResolvedValue({ ...DASHBOARD, name: 'Renamed' });
  mockDb.report.findFirst.mockResolvedValue(REPORT);
  mockDb.report.findMany.mockResolvedValue([]);
  mockDb.report.create.mockResolvedValue(REPORT);
  mockDb.report.update.mockResolvedValue(REPORT);
  mockDb.report.delete.mockResolvedValue(REPORT);
  mockDb.report.deleteMany.mockResolvedValue({ count: 1 });
  mockDb.reportLayout.upsert.mockResolvedValue({ reportId: REPORT.id, x: 1 });
  mockDb.reportLayout.deleteMany.mockResolvedValue({ count: 1 });
  mockDb.$transaction.mockImplementation(async (callback) => callback(mockDb));
});

function register(context: McpAuthContext = ROOT_CONTEXT) {
  const server = makeServer();
  registerDashboardManagementTools(server as any, context);
  return server;
}

function validReport(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Signups',
    series: [],
    ...overrides,
  };
}

describe('dashboard management registration', () => {
  it('registers only get_dashboard for read credentials', () => {
    expect(register(READ_CONTEXT).names()).toEqual(['get_dashboard']);
  });

  it('registers all management tools for root credentials', () => {
    expect(register().names()).toEqual([
      'get_dashboard',
      'create_dashboard',
      'update_dashboard',
      'delete_dashboard',
      'create_report',
      'update_report',
      'delete_report',
      'duplicate_report',
      'update_report_layout',
      'reset_dashboard_layout',
    ]);
  });

  it('uses a strict persistable report schema with defaults', () => {
    const server = register();
    const reportSchema = server.schema('create_report').report;

    expect(reportSchema.parse(validReport())).toMatchObject({
      chartType: 'linear',
      interval: 'day',
      range: '30d',
      previous: false,
      metric: 'sum',
      lineType: 'monotone',
    });
    expect(reportSchema.safeParse({ name: 'Missing series' }).success).toBe(false);
    expect(
      reportSchema.safeParse(validReport({ limit: 10 })).success,
    ).toBe(false);
    expect(
      reportSchema.safeParse(validReport({ offset: 10 })).success,
    ).toBe(false);
  });

  it('requires valid ordered dates for custom ranges', () => {
    const reportSchema = register().schema('create_report').report;

    expect(
      reportSchema.safeParse(validReport({ range: 'custom' })).success,
    ).toBe(false);
    expect(
      reportSchema.safeParse(
        validReport({
          range: 'custom',
          startDate: '2026-02-30',
          endDate: '2026-03-01',
        }),
      ).success,
    ).toBe(false);
    expect(
      reportSchema.safeParse(
        validReport({
          range: 'custom',
          startDate: '2026-03-02',
          endDate: '2026-03-01',
        }),
      ).success,
    ).toBe(false);
  });
});

describe('dashboard management project binding', () => {
  it('binds dashboard reads to the resolved project', async () => {
    const server = register(READ_CONTEXT);

    await server.invoke('get_dashboard', {
      projectId: 'another-project',
      dashboardId: 'dashboard-1',
    });

    expect(mockGetDashboardById).toHaveBeenCalledWith('dashboard-1', 'project-1');
    expect(mockDb.report.findMany).toHaveBeenCalledWith({
      where: { dashboardId: 'dashboard-1', projectId: 'project-1' },
      include: { layout: true },
    });
  });

  it('rejects a report id that is not a uuid before touching the database', async () => {
    const server = register();

    await expect(
      server.invoke('delete_report', {
        projectId: 'project-1',
        reportId: 'dashboard-1',
      }),
    ).rejects.toThrow();
    expect(mockDb.report.findFirst).not.toHaveBeenCalled();
  });

  it('does not mutate a report from another project', async () => {
    mockDb.report.findFirst.mockResolvedValue(null);
    const server = register();

    const result = await server.invoke('delete_report', {
      projectId: 'project-1',
      reportId: '22222222-2222-4222-8222-222222222222',
    });

    expect(result.error).toContain('Report not found');
    expect(mockDb.report.delete).not.toHaveBeenCalled();
    expect(mockDb.report.findFirst).toHaveBeenCalledWith({
      where: { id: '22222222-2222-4222-8222-222222222222', projectId: 'project-1' },
    });
  });
});

describe('dashboard management behavior', () => {
  it('persists custom dates and router defaults after schema parsing', async () => {
    const server = register();

    await server.invoke('create_report', {
      projectId: 'project-1',
      dashboardId: 'dashboard-1',
      report: validReport({
        range: 'custom',
        startDate: '2026-01-01',
        endDate: '2026-01-31',
      }),
    });

    expect(mockDb.report.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: 'project-1',
        dashboardId: 'dashboard-1',
        globalFilters: [],
        visibleSeries: [],
        startDate: '2026-01-01',
        endDate: '2026-01-31',
      }),
    });
  });

  it('clears optional persisted report values on full replacement', async () => {
    const server = register();

    await server.invoke('update_report', {
      projectId: 'project-1',
      reportId: '11111111-1111-4111-8111-111111111111',
      report: validReport(),
    });

    expect(mockDb.report.update).toHaveBeenCalledWith({
      where: { id: '11111111-1111-4111-8111-111111111111' },
      data: expect.objectContaining({
        formula: null,
        unit: null,
        options: expect.anything(),
        startDate: null,
        endDate: null,
      }),
    });
  });

  it('returns a lossless report configuration for get→update round trips', async () => {
    const report = {
      ...REPORT,
      events: [EVENT_WITH_TYPED_COHORT_FILTER],
      globalFilters: [
        {
          name: 'country',
          operator: 'is',
          value: ['SE'],
          type: 'string',
          cohortIds: ['cohort-global'],
        },
      ],
    };
    mockDb.report.findMany.mockResolvedValue([report]);
    const readServer = register(READ_CONTEXT);
    const dashboard = await readServer.invoke('get_dashboard', {
      dashboardId: 'dashboard-1',
    });
    const configuration = dashboard.reports[0].report;

    expect(configuration.series).toEqual(report.events);
    expect(configuration.globalFilters).toEqual(report.globalFilters);

    const rootServer = register();
    await rootServer.invoke('update_report', {
      projectId: 'project-1',
      reportId: '11111111-1111-4111-8111-111111111111',
      report: configuration,
    });

    expect(mockDb.report.update).toHaveBeenCalledWith({
      where: { id: '11111111-1111-4111-8111-111111111111' },
      data: expect.objectContaining({
        events: report.events,
        globalFilters: report.globalFilters,
      }),
    });
  });

  it('rejects a non-empty dashboard atomically without force', async () => {
    mockDb.report.findMany.mockResolvedValue([
      { id: '11111111-1111-4111-8111-111111111111', projectId: 'project-1' },
    ]);
    const server = register();

    const result = await server.invoke('delete_dashboard', {
      projectId: 'project-1',
      dashboardId: 'dashboard-1',
    });

    expect(result.error).toContain('Cannot delete dashboard with associated reports');
    expect(mockDb.$transaction).toHaveBeenCalled();
    expect(mockDb.dashboard.delete).not.toHaveBeenCalled();
  });

  it('force deletes reports and their layouts in one transaction', async () => {
    mockDb.report.findMany.mockResolvedValue([
      { id: '11111111-1111-4111-8111-111111111111', projectId: 'project-1' },
    ]);
    const server = register();

    await server.invoke('delete_dashboard', {
      projectId: 'project-1',
      dashboardId: 'dashboard-1',
      forceDelete: true,
    });

    expect(mockDb.report.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['11111111-1111-4111-8111-111111111111'] } },
    });
    expect(mockDb.reportLayout.deleteMany).toHaveBeenCalledWith({
      where: { reportId: { in: ['11111111-1111-4111-8111-111111111111'] } },
    });
    expect(
      mockDb.reportLayout.deleteMany.mock.invocationCallOrder[0]!,
    ).toBeLessThan(mockDb.report.deleteMany.mock.invocationCallOrder[0]!);
    expect(mockDb.dashboard.delete).toHaveBeenCalledWith({
      where: { id: 'dashboard-1' },
    });
  });

  it('duplicates a bound report without losing custom dates', async () => {
    mockDb.report.findFirst.mockResolvedValue({
      ...REPORT,
      events: [EVENT_WITH_TYPED_COHORT_FILTER],
      range: 'custom',
      startDate: '2026-01-01',
      endDate: '2026-01-31',
    });
    const server = register();

    await server.invoke('duplicate_report', {
      projectId: 'project-1',
      reportId: '11111111-1111-4111-8111-111111111111',
    });

    expect(mockDb.report.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: 'Copy of Signups',
        startDate: '2026-01-01',
        endDate: '2026-01-31',
        events: [EVENT_WITH_TYPED_COHORT_FILTER],
      }),
    });
  });

  it('writes dataSource and metricQuery when creating a metric report', async () => {
    const server = register();

    await server.invoke('create_report', {
      projectId: 'project-1',
      dashboardId: 'dashboard-1',
      report: validReport({
        dataSource: 'metrics',
        metricQuery: METRIC_QUERY,
      }),
    });

    expect(mockDb.report.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        dataSource: 'metrics',
        metricQuery: expect.objectContaining({
          metric: 'http_request_duration_seconds',
          aggregation: 'p95',
        }),
      }),
    });
  });

  // Both halves of the pairing rule are rejected by the SCHEMA, so like the
  // other schema-level cases in this file they throw out of `invoke` before a
  // handler runs, rather than coming back as a tool error.
  it('rejects a metrics report with no metricQuery', async () => {
    const server = register();

    await expect(
      server.invoke('create_report', {
        projectId: 'project-1',
        dashboardId: 'dashboard-1',
        report: validReport({ dataSource: 'metrics' }),
      }),
    ).rejects.toThrow('A metrics report needs a metricQuery');

    expect(mockDb.report.create).not.toHaveBeenCalled();
  });

  it('rejects a metricQuery on an events report', async () => {
    const server = register();

    await expect(
      server.invoke('create_report', {
        projectId: 'project-1',
        dashboardId: 'dashboard-1',
        report: validReport({
          dataSource: 'events',
          metricQuery: METRIC_QUERY,
        }),
      }),
    ).rejects.toThrow('A metricQuery is only meaningful');

    expect(mockDb.report.create).not.toHaveBeenCalled();
  });

  it('duplicates a metric report as a metric report', async () => {
    mockDb.report.findFirst.mockResolvedValue(METRIC_REPORT);
    const server = register();

    await server.invoke('duplicate_report', {
      projectId: 'project-1',
      reportId: '11111111-1111-4111-8111-111111111111',
    });

    expect(mockDb.report.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        dataSource: 'metrics',
        metricQuery: METRIC_QUERY,
      }),
    });
  });

  it('round trips a metric report from get_dashboard back through update_report', async () => {
    // The read side entered the same way: a metric row rendered back WITHOUT
    // these two fields reads as an events report, and handing that config
    // straight to update_report stores it as one.
    mockDb.report.findMany.mockResolvedValue([METRIC_REPORT]);
    const readServer = register(READ_CONTEXT);
    const dashboard = await readServer.invoke('get_dashboard', {
      dashboardId: 'dashboard-1',
    });
    const configuration = dashboard.reports[0].report;

    expect(configuration.dataSource).toBe('metrics');
    expect(configuration.metricQuery).toEqual(METRIC_QUERY);

    const rootServer = register();
    await rootServer.invoke('update_report', {
      projectId: 'project-1',
      reportId: '11111111-1111-4111-8111-111111111111',
      report: configuration,
    });

    expect(mockDb.report.update).toHaveBeenCalledWith({
      where: { id: '11111111-1111-4111-8111-111111111111' },
      data: expect.objectContaining({
        dataSource: 'metrics',
        metricQuery: expect.objectContaining({ aggregation: 'p95' }),
      }),
    });
  });

  it('scopes reset layout deletion to the resolved project dashboard', async () => {
    const server = register();

    await server.invoke('reset_dashboard_layout', {
      projectId: 'project-1',
      dashboardId: 'dashboard-1',
    });

    expect(mockDb.reportLayout.deleteMany).toHaveBeenCalledWith({
      where: {
        report: { dashboardId: 'dashboard-1', projectId: 'project-1' },
      },
    });
  });

  it('rejects invalid layouts before the handler executes and persists valid ones', async () => {
    const server = register();

    await expect(
      server.invoke('update_report_layout', {
        projectId: 'project-1',
        reportId: '11111111-1111-4111-8111-111111111111',
        layout: { x: -1, y: 0, w: 4, h: 3 },
      }),
    ).rejects.toThrow();
    expect(mockDb.reportLayout.upsert).not.toHaveBeenCalled();

    await server.invoke('update_report_layout', {
      projectId: 'project-1',
      reportId: '11111111-1111-4111-8111-111111111111',
      layout: { x: 1, y: 2, w: 4, h: 3, minW: 2, minH: 2, maxW: 8, maxH: 8 },
    });
    expect(mockDb.reportLayout.upsert).toHaveBeenCalledWith({
      where: { reportId: '11111111-1111-4111-8111-111111111111' },
      create: {
        reportId: '11111111-1111-4111-8111-111111111111',
        x: 1,
        y: 2,
        w: 4,
        h: 3,
        minW: 2,
        minH: 2,
        maxW: 8,
        maxH: 8,
      },
      update: { x: 1, y: 2, w: 4, h: 3, minW: 2, minH: 2, maxW: 8, maxH: 8 },
    });
  });
});
