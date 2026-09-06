/**
 * getSeoStatus is the gate the SEO shell renders from, so what matters is
 * that each gate state is reachable and that spend includes the part still
 * sitting in Redis (otherwise the 80 % banner lags the flush).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMock, redisMock } = vi.hoisted(() => ({
  dbMock: { project: { findUnique: vi.fn() } },
  redisMock: { get: vi.fn(), incrbyfloat: vi.fn(), scan: vi.fn(), del: vi.fn() },
}));

vi.mock('../prisma-client', () => ({ db: dbMock }));
vi.mock('@openpanel/redis', () => ({ getRedisCache: () => redisMock }));
vi.mock('@openpanel/dataforseo', () => ({ createDataforseoClient: vi.fn() }));

const { getSeoStatus } = await import('./status');

const balanceAt = new Date('2026-09-06T04:00:00.000Z');

function project(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: 'org_1',
    gscConnection: null,
    seoConfig: null,
    organization: { dataForSeoConnection: null },
    ...overrides,
  };
}

const connection = {
  login: 'me@example.com',
  balanceUsd: 42.5,
  balanceAt,
  monthlySpendUsd: 10,
  spendCapUsd: 100,
  lastError: null,
};

const config = {
  domain: 'example.com',
  locationCode: 2376,
  languageCode: 'he',
  devices: 'mobile',
  serpDepth: 20,
  rankSchedule: 'weekly',
  backlinkSchedule: 'manual',
  competitors: ['a.com'],
};

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.get.mockResolvedValue(null);
  vi.stubEnv('DATAFORSEO_DEFAULT_KEY', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getSeoStatus', () => {
  it('reports nothing configured for a fresh project', async () => {
    dbMock.project.findUnique.mockResolvedValue(project());

    expect(await getSeoStatus('p1')).toEqual({
      dfs: {
        configured: false,
        login: null,
        balanceUsd: null,
        balanceAt: null,
        monthlySpendUsd: 0,
        spendCapUsd: null,
        lastError: null,
      },
      gsc: { connected: false, siteUrl: null },
      config: null,
    });
  });

  it('counts a default env key as configured, without a login', async () => {
    vi.stubEnv('DATAFORSEO_DEFAULT_KEY', 'bG9naW46cGFzcw==');
    dbMock.project.findUnique.mockResolvedValue(project());

    const status = await getSeoStatus('p1');

    expect(status.dfs.configured).toBe(true);
    expect(status.dfs.login).toBeNull();
    expect(redisMock.get).not.toHaveBeenCalled();
  });

  it('returns the full shape once everything is connected', async () => {
    redisMock.get.mockResolvedValue('2.25');
    dbMock.project.findUnique.mockResolvedValue(
      project({
        gscConnection: { siteUrl: 'sc-domain:example.com' },
        seoConfig: config,
        organization: { dataForSeoConnection: connection },
      })
    );

    const status = await getSeoStatus('p1');

    expect(status.dfs).toEqual({
      configured: true,
      login: 'me@example.com',
      balanceUsd: 42.5,
      balanceAt: balanceAt.toISOString(),
      // Postgres total plus what Redis has not flushed yet.
      monthlySpendUsd: 12.25,
      spendCapUsd: 100,
      lastError: null,
    });
    expect(redisMock.get).toHaveBeenCalledWith('seo:spend:org_1');
    expect(status.gsc).toEqual({
      connected: true,
      siteUrl: 'sc-domain:example.com',
    });
    expect(status.config).toEqual(config);
  });

  it('treats an empty GSC siteUrl as not connected', async () => {
    // GscConnection.siteUrl defaults to '' until a site is selected.
    dbMock.project.findUnique.mockResolvedValue(
      project({ gscConnection: { siteUrl: '' } })
    );

    expect((await getSeoStatus('p1')).gsc).toEqual({
      connected: false,
      siteUrl: null,
    });
  });

  it('coerces unknown enum strings to their safe defaults', async () => {
    dbMock.project.findUnique.mockResolvedValue(
      project({
        seoConfig: { ...config, devices: 'tablet', rankSchedule: 'hourly' },
      })
    );

    const status = await getSeoStatus('p1');

    expect(status.config?.devices).toBe('both');
    expect(status.config?.rankSchedule).toBe('manual');
  });

  it('throws for an unknown project', async () => {
    dbMock.project.findUnique.mockResolvedValue(null);

    await expect(getSeoStatus('nope')).rejects.toThrow(/not found/);
  });
});
