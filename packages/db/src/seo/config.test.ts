/**
 * Domain derivation and the create path of the project config.
 *
 * The GSC property is the one place a domain can come from without a person
 * typing it, and GSC has two property shapes; both must land on the same
 * bare host so the rank tracker and the GSC join in seo_rank_daily agree.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMock } = vi.hoisted(() => ({
  dbMock: {
    seoProjectConfig: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    gscConnection: { findUnique: vi.fn() },
  },
}));

vi.mock('../prisma-client', () => ({ db: dbMock }));

const { deriveDomainFromGscSiteUrl, upsertSeoProjectConfig } = await import(
  './config'
);

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.seoProjectConfig.create.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => data
  );
  dbMock.seoProjectConfig.update.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => data
  );
});

describe('deriveDomainFromGscSiteUrl', () => {
  it.each([
    ['sc-domain:example.com', 'example.com'],
    ['SC-DOMAIN:Example.COM', 'example.com'],
    ['https://example.com/', 'example.com'],
    ['http://www.example.com', 'www.example.com'],
    ['https://example.com/blog/', 'example.com'],
    ['  https://example.co.il/  ', 'example.co.il'],
    ['example.com', 'example.com'],
  ])('%s → %s', (input, expected) => {
    expect(deriveDomainFromGscSiteUrl(input)).toBe(expected);
  });

  it.each([[''], ['   '], ['https://'], [null], [undefined]])(
    'rejects %s',
    (input) => {
      expect(deriveDomainFromGscSiteUrl(input)).toBeNull();
    }
  );
});

describe('upsertSeoProjectConfig (create)', () => {
  it('defaults the domain from the GSC property', async () => {
    dbMock.seoProjectConfig.findUnique.mockResolvedValue(null);
    dbMock.gscConnection.findUnique.mockResolvedValue({
      siteUrl: 'sc-domain:example.com',
    });

    const config = await upsertSeoProjectConfig({ projectId: 'p1' });

    expect(config.domain).toBe('example.com');
    expect(dbMock.seoProjectConfig.create).toHaveBeenCalledTimes(1);
  });

  it('prefers an explicit domain over GSC', async () => {
    dbMock.seoProjectConfig.findUnique.mockResolvedValue(null);
    dbMock.gscConnection.findUnique.mockResolvedValue({
      siteUrl: 'sc-domain:example.com',
    });

    const config = await upsertSeoProjectConfig({
      projectId: 'p1',
      domain: 'https://other.com/',
    });

    expect(config.domain).toBe('other.com');
    expect(dbMock.gscConnection.findUnique).not.toHaveBeenCalled();
  });

  it('refuses to create without any domain', async () => {
    dbMock.seoProjectConfig.findUnique.mockResolvedValue(null);
    dbMock.gscConnection.findUnique.mockResolvedValue(null);

    await expect(upsertSeoProjectConfig({ projectId: 'p1' })).rejects.toThrow(
      /domain is required/
    );
    expect(dbMock.seoProjectConfig.create).not.toHaveBeenCalled();
  });

  it('points scheduled work at now and leaves manual work unscheduled', async () => {
    dbMock.seoProjectConfig.findUnique.mockResolvedValue(null);
    dbMock.gscConnection.findUnique.mockResolvedValue({
      siteUrl: 'https://example.com/',
    });

    const before = Date.now();
    const config = await upsertSeoProjectConfig({
      projectId: 'p1',
      backlinkSchedule: 'manual',
    });

    expect(config.rankSchedule).toBe('daily');
    expect(config.rankNextRunAt?.getTime()).toBeGreaterThanOrEqual(before);
    expect(config.backlinkNextRunAt).toBeNull();
  });

  it('normalizes and dedupes competitors', async () => {
    dbMock.seoProjectConfig.findUnique.mockResolvedValue(null);

    const config = await upsertSeoProjectConfig({
      projectId: 'p1',
      domain: 'example.com',
      competitors: ['https://a.com/', 'A.com', 'sc-domain:b.com'],
    });

    expect(config.competitors).toEqual(['a.com', 'b.com']);
  });
});

describe('upsertSeoProjectConfig (update)', () => {
  const existing = {
    projectId: 'p1',
    domain: 'example.com',
    rankSchedule: 'daily',
    rankNextRunAt: new Date('2026-09-07T03:00:00.000Z'),
    backlinkSchedule: 'weekly',
    backlinkNextRunAt: new Date('2026-09-10T03:00:00.000Z'),
  };

  it('keeps the next-run pointer when the schedule is unchanged', async () => {
    dbMock.seoProjectConfig.findUnique.mockResolvedValue(existing);

    const config = await upsertSeoProjectConfig({
      projectId: 'p1',
      serpDepth: 50,
    });

    expect(config.rankNextRunAt).toEqual(existing.rankNextRunAt);
    expect(config.backlinkNextRunAt).toEqual(existing.backlinkNextRunAt);
    expect(config.domain).toBeUndefined();
  });

  it('clears the pointer on manual and re-arms it on a new cadence', async () => {
    dbMock.seoProjectConfig.findUnique.mockResolvedValue(existing);

    const before = Date.now();
    const config = await upsertSeoProjectConfig({
      projectId: 'p1',
      rankSchedule: 'manual',
      backlinkSchedule: 'daily',
    });

    expect(config.rankNextRunAt).toBeNull();
    expect(config.backlinkNextRunAt?.getTime()).toBeGreaterThanOrEqual(before);
  });
});
