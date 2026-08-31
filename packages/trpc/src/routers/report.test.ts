import { beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('@openpanel/db', () => ({
  db: {
    report: {
      create: reportCreate,
      update: reportUpdate,
      findUniqueOrThrow: reportFindUniqueOrThrow,
    },
    dashboard: { findUniqueOrThrow: dashboardFindUniqueOrThrow },
  },
  // The real value is an object-enum sentinel; identity is all the assertions
  // below need, and it keeps the generated client out of a unit test.
  Prisma: { DbNull: Symbol.for('Prisma.DbNull') },
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

const DB_NULL = Symbol.for('Prisma.DbNull');

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
