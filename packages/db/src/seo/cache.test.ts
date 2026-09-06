import { describe, expect, it, vi } from 'vitest';

vi.mock('@openpanel/redis', () => ({
  getCache: vi.fn(
    async (_key: string, _ttl: number, fn: () => Promise<unknown>) => fn()
  ),
}));

const { canonicalJson, seoCacheKey, SEO_CACHE_TTL_SECONDS, withSeoCache } =
  await import('./cache');
const { getCache } = await import('@openpanel/redis');

describe('seoCacheKey', () => {
  it('is stable across object key order at every depth', () => {
    const a = seoCacheKey('org_1', 'labs/keyword_ideas', {
      keyword: 'shoes',
      locationCode: 2840,
      nested: { languageCode: 'en', limit: 100 },
    });
    const b = seoCacheKey('org_1', 'labs/keyword_ideas', {
      nested: { limit: 100, languageCode: 'en' },
      locationCode: 2840,
      keyword: 'shoes',
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^seo:org_1:labs\/keyword_ideas:[0-9a-f]{40}$/);
  });

  it('separates organizations, endpoints and params', () => {
    const base = seoCacheKey('org_1', 'labs/keyword_ideas', { keyword: 'a' });
    expect(seoCacheKey('org_2', 'labs/keyword_ideas', { keyword: 'a' })).not.toBe(
      base
    );
    expect(seoCacheKey('org_1', 'labs/related', { keyword: 'a' })).not.toBe(
      base
    );
    expect(seoCacheKey('org_1', 'labs/keyword_ideas', { keyword: 'b' })).not.toBe(
      base
    );
  });

  it('keeps array order significant and drops undefined values', () => {
    expect(canonicalJson({ keywords: ['a', 'b'] })).not.toBe(
      canonicalJson({ keywords: ['b', 'a'] })
    );
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });
});

describe('withSeoCache', () => {
  it('passes the spec key and TTL to getCache', async () => {
    const loader = vi.fn(async () => ({ ok: true }));
    const result = await withSeoCache(
      {
        organizationId: 'org_1',
        endpoint: 'serp/google/organic/live/advanced',
        params: { keyword: 'shoes' },
        ttl: 'serpLive',
      },
      loader
    );
    expect(result).toEqual({ ok: true });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(getCache).toHaveBeenCalledWith(
      seoCacheKey('org_1', 'serp/google/organic/live/advanced', {
        keyword: 'shoes',
      }),
      SEO_CACHE_TTL_SECONDS.serpLive,
      loader
    );
  });
});
