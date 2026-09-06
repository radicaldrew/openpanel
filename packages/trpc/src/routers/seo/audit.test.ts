/**
 * The audit router owns two things worth pinning: `start` maps the
 * one-active-audit rule and the spend cap to client-visible errors and only
 * enqueues on success, and every audit-scoped procedure refuses an audit
 * that belongs to a different project.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fns, requireProjectAccess, queueAdd } = vi.hoisted(() => ({
  fns: {
    createAudit: vi.fn(),
    cancelAudit: vi.fn(),
    getAudit: vi.fn(),
    listAudits: vi.fn(),
    getAuditIssueSummary: vi.fn(),
    listAuditPages: vi.fn(),
    getAuditPage: vi.fn(),
    getLighthouseForUrl: vi.fn(),
  },
  requireProjectAccess: vi.fn(),
  queueAdd: vi.fn(),
}));

vi.mock('@openpanel/db', () => ({
  ...fns,
  AUDIT_MAX_PAGES_MIN: 10,
  AUDIT_MAX_PAGES_MAX: 10_000,
  AUDIT_PAGE_SORTS: { score_asc: 'onpage_score ASC', url_asc: 'url ASC' },
  AUDIT_PRICE_PER_PAGE_USD: 1.25e-4,
  AUDIT_PRICE_PER_PAGE_JS_USD: 5e-4,
  estimateAuditCostUsd: (pages: number, js: boolean) => pages * (js ? 5e-4 : 1.25e-4),
  getAuditMaxPagesDefault: () => 500,
  readAuditSummary: (audit: { summary: unknown }) => ({
    options: {
      enableJavascript:
        (audit.summary as { options?: { enableJavascript?: boolean } } | null)?.options
          ?.enableJavascript === true,
    },
  }),
  DfsNotConfiguredError: class DfsNotConfiguredError extends Error {},
  SeoConfigMissingError: class SeoConfigMissingError extends Error {},
  runWithAlsSession: (_id: unknown, fn: () => unknown) => fn(),
}));
vi.mock('@openpanel/queue', () => ({ seoQueue: { add: queueAdd } }));
vi.mock('@openpanel/dataforseo', () => ({ isDataForSeoError: () => false }));
vi.mock('../../access', () => ({ requireProjectAccess }));

const { seoAuditRouter } = await import('./audit');

const caller = () =>
  seoAuditRouter.createCaller({
    req: { log: { info: vi.fn(), error: vi.fn() } },
    res: {},
    session: { userId: 'user_1' },
    setCookie: vi.fn(),
  } as never);

const audit = (overrides: Record<string, unknown> = {}) => ({
  id: 'audit_1',
  projectId: 'p1',
  status: 'queued',
  maxPages: 500,
  pagesCrawled: 0,
  score: null,
  costUsd: 0,
  error: null,
  summary: { options: { enableJavascript: false } },
  startedAt: new Date('2026-09-06T10:00:00.000Z'),
  completedAt: null,
  dfsTaskId: null,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  requireProjectAccess.mockResolvedValue({ level: 'write' });
});

describe('seo.audit.start', () => {
  it('creates the audit, enqueues seoAuditStart once and returns the estimate', async () => {
    fns.createAudit.mockResolvedValue({ ok: true, audit: audit() });

    const result = await caller().start({ projectId: 'p1', maxPages: 400, enableJavascript: true });

    expect(fns.createAudit).toHaveBeenCalledWith({ projectId: 'p1', maxPages: 400, enableJavascript: true });
    expect(queueAdd).toHaveBeenCalledTimes(1);
    expect(queueAdd).toHaveBeenCalledWith(
      'seoAuditStart',
      { type: 'seoAuditStart', payload: { projectId: 'p1', auditId: 'audit_1' } },
      { jobId: 'seoAuditStart:audit_1' }
    );
    expect(result.estimatedCostUsd).toBeCloseTo(0.2);
    expect(result.audit).toMatchObject({ id: 'audit_1', status: 'queued', enableJavascript: false });
  });

  it('maps the one-active-audit rule to CONFLICT without enqueuing', async () => {
    fns.createAudit.mockResolvedValue({ ok: false, reason: 'already_running', audit: audit({ status: 'crawling' }) });

    await expect(caller().start({ projectId: 'p1', maxPages: 500 })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('maps the spend cap and missing domain to PRECONDITION_FAILED', async () => {
    fns.createAudit.mockResolvedValue({ ok: false, reason: 'spend_cap', audit: audit({ status: 'failed' }) });
    await expect(caller().start({ projectId: 'p1', maxPages: 500 })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('DFS_SPEND_CAP'),
    });

    fns.createAudit.mockResolvedValue({ ok: false, reason: 'no_domain' });
    await expect(caller().start({ projectId: 'p1', maxPages: 500 })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('SEO_CONFIG_MISSING'),
    });
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('rejects page counts outside the allowed range before touching the db', async () => {
    await expect(caller().start({ projectId: 'p1', maxPages: 5 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(fns.createAudit).not.toHaveBeenCalled();
  });
});

describe('audit-scoped procedures', () => {
  it("refuse an audit from another project", async () => {
    fns.getAudit.mockResolvedValue(audit({ projectId: 'p2' }));

    await expect(caller().get({ projectId: 'p1', auditId: 'audit_1' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(caller().cancel({ projectId: 'p1', auditId: 'audit_1' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(fns.cancelAudit).not.toHaveBeenCalled();
    expect(fns.getAuditIssueSummary).not.toHaveBeenCalled();
  });

  it('get returns issue counts only for completed audits', async () => {
    fns.getAudit.mockResolvedValue(audit({ status: 'crawling', pagesCrawled: 12 }));
    const crawling = await caller().get({ projectId: 'p1', auditId: 'audit_1' });
    expect(crawling.issues.totals).toEqual({ critical: 0, warning: 0, info: 0 });
    expect(fns.getAuditIssueSummary).not.toHaveBeenCalled();

    fns.getAudit.mockResolvedValue(audit({ status: 'completed', score: 91 }));
    fns.getAuditIssueSummary.mockResolvedValue({ issues: [], totals: { critical: 1, warning: 2, info: 3 } });
    const done = await caller().get({ projectId: 'p1', auditId: 'audit_1' });
    expect(done.issues.totals).toEqual({ critical: 1, warning: 2, info: 3 });
    expect(done.audit.score).toBe(91);
  });

  it('cancel reports whether anything was cancelled', async () => {
    fns.getAudit.mockResolvedValue(audit({ status: 'crawling' }));
    fns.cancelAudit.mockResolvedValue(true);
    expect(await caller().cancel({ projectId: 'p1', auditId: 'audit_1' })).toEqual({ cancelled: true });
  });
});
