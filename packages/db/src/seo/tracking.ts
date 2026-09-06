import type { SeoTrackedKeyword } from '../generated/prisma/client';
import { getGscQueries } from '../gsc';
import { db } from '../prisma-client';

export const MAX_TRACKED_KEYWORD_LENGTH = 200;
export const MAX_KEYWORDS_PER_ADD = 2000;
const GSC_SEED_WINDOW_DAYS = 28;

export type SeoTrackedKeywordSource = 'manual' | 'gsc' | 'research';

/**
 * One spelling per keyword: trimmed, lowercased, inner whitespace collapsed.
 * DataForSEO treats "Best Shoes" and "best shoes" as the same query, and the
 * unique index on (projectId, keyword) should agree with it.
 */
export function normalizeTrackedKeyword(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function normalizeTrackedKeywords(raw: string[]): string[] {
  const seen = new Set<string>();
  for (const value of raw) {
    const keyword = normalizeTrackedKeyword(value);
    if (keyword.length > 0 && keyword.length <= MAX_TRACKED_KEYWORD_LENGTH) {
      seen.add(keyword);
    }
  }
  return [...seen];
}

function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags) {
    return [];
  }
  const seen = new Set<string>();
  for (const tag of tags) {
    const value = tag.trim();
    if (value) {
      seen.add(value);
    }
  }
  return [...seen];
}

export async function listTrackedKeywords(
  projectId: string,
  filter: { tag?: string; search?: string; includeInactive?: boolean } = {}
): Promise<SeoTrackedKeyword[]> {
  const search = filter.search?.trim();
  return db.seoTrackedKeyword.findMany({
    where: {
      projectId,
      ...(filter.includeInactive ? {} : { isActive: true }),
      ...(filter.tag ? { tags: { has: filter.tag } } : {}),
      ...(search ? { keyword: { contains: search.toLowerCase() } } : {}),
    },
    orderBy: [{ createdAt: 'asc' }, { keyword: 'asc' }],
  });
}

export interface AddTrackedKeywordsResult {
  /** Keywords created by this call (normalized). */
  added: string[];
  /** Keywords that were already tracked (normalized). */
  existing: string[];
  /** Every requested keyword's row, added or existing. */
  keywords: SeoTrackedKeyword[];
}

/**
 * Track keywords, skipping ones the project already has. Existing rows are
 * left alone (their tags and source stay), except that an inactive one is
 * re-activated: asking to track it again is the clearest signal that it
 * should be. The caller enqueues the metrics fetch for `added`.
 */
export async function addTrackedKeywords({
  projectId,
  keywords,
  tags,
  source = 'manual',
}: {
  projectId: string;
  keywords: string[];
  tags?: string[];
  source?: SeoTrackedKeywordSource;
}): Promise<AddTrackedKeywordsResult> {
  const normalized = normalizeTrackedKeywords(keywords).slice(
    0,
    MAX_KEYWORDS_PER_ADD
  );
  if (normalized.length === 0) {
    return { added: [], existing: [], keywords: [] };
  }

  const existingRows = await db.seoTrackedKeyword.findMany({
    where: { projectId, keyword: { in: normalized } },
  });
  const existingSet = new Set(existingRows.map((row) => row.keyword));
  const toCreate = normalized.filter((keyword) => !existingSet.has(keyword));
  const normalizedTags = normalizeTags(tags);

  if (toCreate.length > 0) {
    await db.seoTrackedKeyword.createMany({
      data: toCreate.map((keyword) => ({
        projectId,
        keyword,
        tags: normalizedTags,
        source,
      })),
      // A concurrent add of the same keyword is not an error.
      skipDuplicates: true,
    });
  }

  const inactiveIds = existingRows
    .filter((row) => !row.isActive)
    .map((row) => row.id);
  if (inactiveIds.length > 0) {
    await db.seoTrackedKeyword.updateMany({
      where: { projectId, id: { in: inactiveIds } },
      data: { isActive: true },
    });
  }

  const rows = await db.seoTrackedKeyword.findMany({
    where: { projectId, keyword: { in: normalized } },
    orderBy: { keyword: 'asc' },
  });

  return { added: toCreate, existing: [...existingSet], keywords: rows };
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Seed tracking from Search Console: the top queries of the last 28 days by
 * clicks, above an impressions floor, minus what is already tracked. Reads
 * more than `limit` from GSC so the dedupe does not eat the whole page.
 */
export async function addTrackedKeywordsFromGsc({
  projectId,
  minImpressions = 10,
  limit = 50,
}: {
  projectId: string;
  minImpressions?: number;
  limit?: number;
}): Promise<AddTrackedKeywordsResult & { candidates: number }> {
  const endDate = new Date();
  endDate.setUTCDate(endDate.getUTCDate() - 1);
  const startDate = new Date(endDate);
  startDate.setUTCDate(startDate.getUTCDate() - GSC_SEED_WINDOW_DAYS + 1);

  const overfetch = Math.min(limit * 4, 1000);
  const queries = await getGscQueries(
    projectId,
    isoDate(startDate),
    isoDate(endDate),
    overfetch
  );

  const tracked = await db.seoTrackedKeyword.findMany({
    where: { projectId },
    select: { keyword: true },
  });
  const trackedSet = new Set(tracked.map((row) => row.keyword));

  const candidates: string[] = [];
  for (const row of queries) {
    if (row.impressions < minImpressions) {
      continue;
    }
    const keyword = normalizeTrackedKeyword(row.query);
    if (!keyword || trackedSet.has(keyword) || candidates.includes(keyword)) {
      continue;
    }
    candidates.push(keyword);
    if (candidates.length >= limit) {
      break;
    }
  }

  const result = await addTrackedKeywords({
    projectId,
    keywords: candidates,
    source: 'gsc',
  });
  return { ...result, candidates: candidates.length };
}

export async function removeTrackedKeywords(
  projectId: string,
  ids: string[]
): Promise<{ removed: number }> {
  if (ids.length === 0) {
    return { removed: 0 };
  }
  const result = await db.seoTrackedKeyword.deleteMany({
    where: { projectId, id: { in: ids } },
  });
  return { removed: result.count };
}

export async function setTrackedKeywordTags(
  projectId: string,
  ids: string[],
  tags: string[]
): Promise<{ updated: number }> {
  if (ids.length === 0) {
    return { updated: 0 };
  }
  const result = await db.seoTrackedKeyword.updateMany({
    where: { projectId, id: { in: ids } },
    data: { tags: normalizeTags(tags) },
  });
  return { updated: result.count };
}

export async function setTrackedKeywordActive(
  projectId: string,
  ids: string[],
  isActive: boolean
): Promise<{ updated: number }> {
  if (ids.length === 0) {
    return { updated: 0 };
  }
  const result = await db.seoTrackedKeyword.updateMany({
    where: { projectId, id: { in: ids } },
    data: { isActive },
  });
  return { updated: result.count };
}

/** Every distinct tag in use on a project, for filter chips. */
export async function listTrackedKeywordTags(projectId: string): Promise<string[]> {
  const rows = await db.seoTrackedKeyword.findMany({
    where: { projectId },
    select: { tags: true },
  });
  const seen = new Set<string>();
  for (const row of rows) {
    for (const tag of row.tags) {
      seen.add(tag);
    }
  }
  return [...seen].sort();
}
