/**
 * createAudit is where the one-active-audit rule and the spend cap live;
 * toAuditPageRow is the only place DFS page items are flattened, so its
 * merging of the out-of-`checks` booleans is what the issue counts rely on.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMock, fns } = vi.hoisted(() => ({
  dbMock: {
    seoAudit: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
  fns: {
    getSeoProjectConfig: vi.fn(),
    getProjectOrganizationId: vi.fn(),
    isDfsSpendCapReached: vi.fn(),
    getDfsClientForOrganization: vi.fn(),
  },
}));

vi.mock('../prisma-client', () => ({ db: dbMock }));
vi.mock('../clickhouse/client', () => ({ originalCh: { query: vi.fn(), insert: vi.fn() } }));
vi.mock('./config', () => ({ getSeoProjectConfig: fns.getSeoProjectConfig }));
vi.mock('./client', () => ({
  getProjectOrganizationId: fns.getProjectOrganizationId,
  isDfsSpendCapReached: fns.isDfsSpendCapReached,
  getDfsClientForOrganization: fns.getDfsClientForOrganization,
}));
vi.mock('./cache', () => ({
  withSeoCache: vi.fn((_opts: unknown, loader: () => unknown) => loader()),
}));

const {
  assertLighthouseUrlAllowed,
  cancelAudit,
  createAudit,
  decodePageCursor,
  encodePageCursor,
  estimateAuditCostUsd,
  getAuditMaxPagesDefault,
  getLighthouseForUrl,
  readAuditSummary,
  toAuditPageRow,
} = await import('./audit');

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  fns.getSeoProjectConfig.mockResolvedValue({ domain: 'example.com' });
  fns.getProjectOrganizationId.mockResolvedValue('org_1');
  fns.isDfsSpendCapReached.mockResolvedValue(false);
  dbMock.seoAudit.create.mockImplementation(async ({ data }: { data: object }) => ({
    id: 'audit_new',
    ...data,
  }));
});

describe('createAudit', () => {
  it('refuses a second audit while one is queued or crawling', async () => {
    dbMock.seoAudit.findFirst.mockResolvedValue({ id: 'audit_1', status: 'crawling' });

    const result = await createAudit({ projectId: 'p1', maxPages: 500, enableJavascript: false });

    expect(result).toEqual({
      ok: false,
      reason: 'already_running',
      audit: { id: 'audit_1', status: 'crawling' },
    });
    expect(dbMock.seoAudit.findFirst).toHaveBeenCalledWith({
      where: { projectId: 'p1', status: { in: ['queued', 'crawling'] } },
      orderBy: { startedAt: 'desc' },
    });
    expect(dbMock.seoAudit.create).not.toHaveBeenCalled();
  });

  it('creates a queued audit with the options in summary', async () => {
    dbMock.seoAudit.findFirst.mockResolvedValue(null);

    const result = await createAudit({ projectId: 'p1', maxPages: 250, enableJavascript: true });

    expect(result.ok).toBe(true);
    expect(dbMock.seoAudit.create).toHaveBeenCalledWith({
      data: {
        projectId: 'p1',
        status: 'queued',
        maxPages: 250,
        summary: { options: { enableJavascript: true } },
      },
    });
  });

  it('backs out when a concurrent click created an earlier audit', async () => {
    const theirs = { id: 'audit_theirs', status: 'queued', startedAt: new Date('2026-09-07T10:00:00.000Z') };
    dbMock.seoAudit.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(theirs);
    dbMock.seoAudit.create.mockResolvedValue({
      id: 'audit_mine',
      status: 'queued',
      startedAt: new Date('2026-09-07T10:00:00.040Z'),
    });

    const result = await createAudit({ projectId: 'p1', maxPages: 500, enableJavascript: false });

    expect(dbMock.seoAudit.delete).toHaveBeenCalledWith({ where: { id: 'audit_mine' } });
    expect(result).toEqual({ ok: false, reason: 'already_running', audit: theirs });
  });

  it('keeps the audit when it is the earliest active one', async () => {
    const mine = { id: 'audit_mine', status: 'queued', startedAt: new Date() };
    dbMock.seoAudit.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(mine);
    dbMock.seoAudit.create.mockResolvedValue(mine);

    const result = await createAudit({ projectId: 'p1', maxPages: 500, enableJavascript: false });

    expect(result).toEqual({ ok: true, audit: mine });
    expect(dbMock.seoAudit.delete).not.toHaveBeenCalled();
  });

  it('leaves a failed row behind when the spend cap is reached', async () => {
    dbMock.seoAudit.findFirst.mockResolvedValue(null);
    fns.isDfsSpendCapReached.mockResolvedValue(true);

    const result = await createAudit({ projectId: 'p1', maxPages: 500, enableJavascript: false });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: 'spend_cap' });
    expect(dbMock.seoAudit.create.mock.calls[0]?.[0].data).toMatchObject({
      status: 'failed',
      error: 'spend cap reached',
    });
  });

  it('needs a configured domain', async () => {
    dbMock.seoAudit.findFirst.mockResolvedValue(null);
    fns.getSeoProjectConfig.mockResolvedValue(null);

    expect(await createAudit({ projectId: 'p1', maxPages: 500, enableJavascript: false })).toEqual({
      ok: false,
      reason: 'no_domain',
    });
  });
});

describe('getLighthouseForUrl', () => {
  it('only accepts pages on the tracked domain or its subdomains', () => {
    expect(assertLighthouseUrlAllowed('https://www.example.com/a', 'example.com')).toBe(
      'https://www.example.com/a'
    );
    expect(assertLighthouseUrlAllowed('https://blog.example.com/', 'www.Example.com')).toBe(
      'https://blog.example.com/'
    );
    expect(() => assertLighthouseUrlAllowed('https://stranger.com/', 'example.com')).toThrow(
      /only run against pages on example.com/
    );
    expect(() => assertLighthouseUrlAllowed('https://notexample.com/', 'example.com')).toThrow();
    expect(() => assertLighthouseUrlAllowed('not a url', 'example.com')).toThrow(/valid URL/);
  });

  it('refuses a foreign URL before touching DataForSEO', async () => {
    const live = vi.fn();
    fns.getDfsClientForOrganization.mockResolvedValue({ lighthouse: { live } });

    await expect(
      getLighthouseForUrl({ projectId: 'p1', url: 'https://stranger.com/', strategy: 'mobile' })
    ).rejects.toThrow(/only run against/);
    expect(live).not.toHaveBeenCalled();

    live.mockResolvedValue({ data: { score: 1 } });
    await expect(
      getLighthouseForUrl({ projectId: 'p1', url: 'https://example.com/x', strategy: 'mobile' })
    ).resolves.toEqual({ score: 1 });
    expect(live).toHaveBeenCalledWith({ url: 'https://example.com/x', strategy: 'mobile' });
  });
});

describe('cancelAudit', () => {
  it('only flips active audits and reports whether it did', async () => {
    dbMock.seoAudit.updateMany.mockResolvedValue({ count: 1 });
    expect(await cancelAudit('audit_1')).toBe(true);
    expect(dbMock.seoAudit.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: 'audit_1', status: { in: ['queued', 'crawling'] } },
      data: { status: 'failed', error: 'cancelled' },
    });

    dbMock.seoAudit.updateMany.mockResolvedValue({ count: 0 });
    expect(await cancelAudit('audit_done')).toBe(false);
  });
});

describe('toAuditPageRow', () => {
  it('flattens a DFS page item and merges the out-of-checks booleans', () => {
    const row = toAuditPageRow('p1', 'audit_1', {
      url: 'https://example.com/a',
      status_code: 200,
      onpage_score: 87.5,
      size: 12_345,
      meta: {
        title: 'A page',
        description: 'About A',
        canonical: 'https://example.com/a',
        htags: { h1: ['Heading A', 'Second'] },
        internal_links_count: 12,
        external_links_count: 3,
        content: { plain_text_word_count: 640 },
      },
      page_timing: { duration_time: 812.6 },
      checks: { no_title: false, title_too_long: true, is_https: true },
      broken_links: true,
      duplicate_title: false,
      duplicate_content: null,
    });

    expect(row).toEqual({
      projectId: 'p1',
      auditId: 'audit_1',
      url: 'https://example.com/a',
      statusCode: 200,
      onpageScore: 87.5,
      title: 'A page',
      metaDescription: 'About A',
      h1: 'Heading A',
      wordCount: 640,
      loadTimeMs: 813,
      sizeBytes: 12_345,
      internalLinks: 12,
      externalLinks: 3,
      isIndexable: true,
      canonical: 'https://example.com/a',
      checks: {
        no_title: false,
        title_too_long: true,
        is_https: true,
        broken_links: true,
        duplicate_title: false,
      },
    });
  });

  it('marks redirects and errors as not indexable and tolerates missing meta', () => {
    const redirect = toAuditPageRow('p1', 'a', { url: 'https://x/r', status_code: 301, checks: { is_redirect: true } });
    const error = toAuditPageRow('p1', 'a', { url: 'https://x/e', status_code: 404 });
    expect(redirect.isIndexable).toBe(false);
    expect(error.isIndexable).toBe(false);
    expect(error.title).toBe('');
    expect(error.checks).toEqual({});
  });
});

describe('helpers', () => {
  it('reads options from summary JSON defensively', () => {
    expect(readAuditSummary({ summary: null })).toEqual({ options: { enableJavascript: false } });
    expect(readAuditSummary({ summary: { options: { enableJavascript: true }, dfs: { a: 1 } } })).toEqual({
      options: { enableJavascript: true },
      dfs: { a: 1 },
    });
  });

  it('round-trips page cursors and ignores garbage', () => {
    expect(decodePageCursor(encodePageCursor(150))).toBe(150);
    expect(decodePageCursor(null)).toBe(0);
    expect(decodePageCursor('!!!')).toBe(0);
  });

  it('estimates cost and reads the max-pages default from the env', () => {
    expect(estimateAuditCostUsd(1000, false)).toBe(0.125);
    expect(estimateAuditCostUsd(1000, true)).toBe(0.5);
    expect(getAuditMaxPagesDefault()).toBe(500);
    vi.stubEnv('SEO_AUDIT_MAX_PAGES_DEFAULT', '200');
    expect(getAuditMaxPagesDefault()).toBe(200);
    vi.stubEnv('SEO_AUDIT_MAX_PAGES_DEFAULT', '999999');
    expect(getAuditMaxPagesDefault()).toBe(10_000);
  });
});
