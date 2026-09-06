import { createHash } from 'node:crypto';
import { getCache } from '@openpanel/redis';

const HOUR = 60 * 60;
const DAY = 24 * HOUR;

/**
 * TTLs from SEO.md §10. Keyed by endpoint family so every SEO service reads
 * the same table instead of picking its own number.
 */
export const SEO_CACHE_TTL_SECONDS = {
  /** DataForSEO Labs: keyword_ideas, suggestions, related, overview, ranked_keywords. */
  labs: DAY,
  /** serp/google/organic/live (regular and advanced). */
  serpLive: 6 * HOUR,
  /** backlinks lists and summaries. */
  backlinks: 6 * HOUR,
  /** on_page/lighthouse/live */
  lighthouse: DAY,
  /** appendix/user_data */
  userData: HOUR,
  /** serp/google/locations/{country}; the US payload is ~9.5 MB upstream. */
  serpLocations: 30 * DAY,
  /** ai_optimization/llm_mentions/* (search, aggregated, top pages, cross). */
  aiSearch: DAY,
} as const;

export type SeoCacheTtl = keyof typeof SEO_CACHE_TTL_SECONDS;

type JsonValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * JSON with object keys sorted at every depth, so `{a, b}` and `{b, a}` hash
 * to the same cache entry. `undefined` values are dropped like JSON.stringify
 * does; arrays keep their order because order is meaningful for DFS params.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value as JsonValue));
}

function sortKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === 'object') {
    const sorted: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(value).sort()) {
      const entry = value[key];
      if (entry !== undefined) {
        sorted[key] = sortKeys(entry);
      }
    }
    return sorted;
  }
  return value;
}

/** `seo:{orgId}:{endpoint}:{sha1(canonical-json(params))}` */
export function seoCacheKey(
  organizationId: string,
  endpoint: string,
  params: unknown
): string {
  const hash = createHash('sha1').update(canonicalJson(params)).digest('hex');
  return `seo:${organizationId}:${endpoint}:${hash}`;
}

/**
 * Run `loader` unless Redis already holds the result for these params.
 *
 *   withSeoCache(
 *     { organizationId, endpoint: 'labs/keyword_ideas', params, ttl: 'labs' },
 *     () => client.keywords.ideas(params)
 *   )
 *
 * Only the `data` half of a DFS response should be cached: `billing` belongs
 * to the call that paid for it, and the onCost hook has already recorded it.
 */
export async function withSeoCache<T>(
  {
    organizationId,
    endpoint,
    params,
    ttl,
  }: {
    organizationId: string;
    endpoint: string;
    params: unknown;
    ttl: SeoCacheTtl;
  },
  loader: () => Promise<T>
): Promise<T> {
  return getCache(
    seoCacheKey(organizationId, endpoint, params),
    SEO_CACHE_TTL_SECONDS[ttl],
    loader
  );
}
