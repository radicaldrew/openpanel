import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@openpanel/db';

// vi.mock is hoisted above the module scope, so the spies have to be too.
const {
  reportCreate,
  reportUpdate,
  reportFindUniqueOrThrow,
  dashboardFindUniqueOrThrow,
  requireProjectAccess,
} = vi.hoisted(() => ({
  reportCreate: vi.fn(),
  reportUpdate: vi.fn(),
  reportFindUniqueOrThrow: vi.fn(),
  dashboardFindUniqueOrThrow: vi.fn(),
  requireProjectAccess: vi.fn(),
}));

// Partial mock: the real `reportWriteData` and the real `Prisma` load, only
// the db handles are stubbed. Hand-stubbing `reportWriteData` would recreate
// the very column-list copy the helper exists to delete — the drift it was
// written to end started exactly that way.
vi.mock('@openpanel/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@openpanel/db')>()),
  db: {
    report: {
      create: reportCreate,
      update: reportUpdate,
      findUniqueOrThrow: reportFindUniqueOrThrow,
    },
    dashboard: { findUniqueOrThrow: dashboardFindUniqueOrThrow },
  },
  getDashboardById: vi.fn(),
  getReportById: vi.fn(),
  getReportsByDashboardId: vi.fn(),
  getProjectById: vi.fn(),
  getProjectAccess: vi.fn(),
  getOrganizationAccess: vi.fn(),
  getClientAccess: vi.fn(),
  canWriteProject: vi.fn(),
  runWithAlsSession: (_id: unknown, fn: () => unknown) => fn(),
}));

vi.mock('../access', () => ({
  requireProjectAccess,
  getProjectAccess: vi.fn(),
  getOrganizationAccess: vi.fn(),
  getClientAccess: vi.fn(),
}));

import { reportRouter } from './report';

const DB_NULL = Prisma.DbNull;

const caller = () =>
  reportRouter.createCaller({
    req: { log: { info: vi.fn(), error: vi.fn() } },
    res: {},
    session: { userId: 'user_1' },
    setCookie: vi.fn(),
    cookies: {},
  } as never);

/** The minimum a report needs to pass zReport. */
const baseReport = {
  name: 'Panel',
  series: [],
  breakdowns: [],
  chartType: 'linear' as const,
  lineType: 'monotone' as const,
  interval: 'hour' as const,
  range: '7d' as const,
  previous: false,
  metric: 'sum' as const,
};

const metricReport = {
  ...baseReport,
  dataSource: 'metrics' as const,
  metricQuery: {
    metric: 'http_requests_total',
    matchers: [],
    fn: 'rate' as const,
    aggregation: 'sum' as const,
    groupBy: [],
  },
};

/** The `data` object handed to Prisma on call `n`. */
const written = (spy: typeof reportCreate, n = 0) => spy.mock.calls[n]?.[0]?.data;

beforeEach(() => {
  vi.clearAllMocks();
  dashboardFindUniqueOrThrow.mockResolvedValue({
    id: 'dash_1',
    projectId: 'proj_1',
  });
  reportFindUniqueOrThrow.mockResolvedValue({
    id: 'rep_1',
    projectId: 'proj_1',
  });
  reportCreate.mockResolvedValue({ id: 'rep_1' });
  reportUpdate.mockResolvedValue({ id: 'rep_1' });
  requireProjectAccess.mockResolvedValue(undefined);
});

/**
 * Both routes write an explicit field list, and `dataSource` and `metricQuery`
 * were missing from it. A metric report therefore saved as an EVENTS report
 * with an empty series: a panel that renders nothing and raises no error, which
 * is why the omission survived a working save button.
 */
describe('a metric report survives being saved', () => {
  it('writes both metric fields on create', async () => {
    await caller().create({ report: metricReport, dashboardId: 'dash_1' });

    expect(written(reportCreate)).toMatchObject({
      dataSource: 'metrics',
      metricQuery: metricReport.metricQuery,
    });
  });

  it('writes both metric fields on update', async () => {
    await caller().update({ reportId: 'rep_1', report: metricReport });

    expect(written(reportUpdate)).toMatchObject({
      dataSource: 'metrics',
      metricQuery: metricReport.metricQuery,
    });
  });

  it('defaults an ordinary report to events with no query', async () => {
    await caller().create({ report: baseReport, dashboardId: 'dash_1' });

    expect(written(reportCreate)?.dataSource).toBe('events');
    expect(written(reportCreate)?.metricQuery).toBe(DB_NULL);
  });

  /**
   * `undefined` on a Json column means "leave this alone", so converting a
   * metric panel back to events would otherwise strand its query on a report
   * that no longer has a data source for it.
   */
  it('clears the query when a report stops being a metric report', async () => {
    await caller().update({ reportId: 'rep_1', report: baseReport });

    expect(written(reportUpdate)?.dataSource).toBe('events');
    expect(written(reportUpdate)?.metricQuery).toBe(DB_NULL);
  });
});

/**
 * Neither half is meaningful alone and neither failure announces itself, so
 * both are rejected at the edge rather than stored and puzzled over later.
 */
describe('update replaces the report rather than patching it', () => {
  it('persists a cleared formula, unit and options', async () => {
    // The editor posts the whole slice, so an absent key means the user
    // REMOVED it. Passing `undefined` straight to Prisma made it mean "leave
    // alone", so clearing a formula in the UI silently did nothing.
    await caller().update({
      reportId: 'rep_1',
      report: {
        ...baseReport,
        formula: undefined,
        unit: undefined,
        options: undefined,
      },
    });

    expect(reportUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          formula: null,
          unit: null,
          options: DB_NULL,
        }),
      }),
    );
  });

  it('still writes a formula that is present', async () => {
    await caller().update({
      reportId: 'rep_1',
      report: { ...baseReport, formula: 'A / B' },
    });

    expect(reportUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ formula: 'A / B' }),
      }),
    );
  });
});

describe('the data source and the query have to agree', () => {
  it('refuses a metrics report with no query', async () => {
    await expect(
      caller().create({
        report: { ...baseReport, dataSource: 'metrics' as const },
        dashboardId: 'dash_1',
      }),
    ).rejects.toThrow(/metricQuery/i);

    expect(reportCreate).not.toHaveBeenCalled();
  });

  it('refuses a query on an events report', async () => {
    await expect(
      caller().create({
        report: { ...baseReport, metricQuery: metricReport.metricQuery },
        dashboardId: 'dash_1',
      }),
    ).rejects.toThrow(/dataSource/i);

    expect(reportCreate).not.toHaveBeenCalled();
  });

  it('refuses a chart type the metrics engine cannot draw', async () => {
    // bar/pie route to the aggregate engine, which has no metrics branch: the
    // row would save happily and the panel would render blank forever.
    await expect(
      caller().create({
        report: { ...metricReport, chartType: 'pie' as const },
        dashboardId: 'dash_1',
      }),
    ).rejects.toThrow(/chartType/i);

    expect(reportCreate).not.toHaveBeenCalled();
  });

  it('allows a chart type the metrics engine can draw', async () => {
    await expect(
      caller().create({
        report: { ...metricReport, chartType: 'area' as const },
        dashboardId: 'dash_1',
      }),
    ).resolves.toBeDefined();

    expect(reportCreate).toHaveBeenCalled();
  });

  it('applies the same rule to update', async () => {
    await expect(
      caller().update({
        reportId: 'rep_1',
        report: { ...baseReport, dataSource: 'metrics' as const },
      }),
    ).rejects.toThrow(/metricQuery/i);

    expect(reportUpdate).not.toHaveBeenCalled();
  });
});
