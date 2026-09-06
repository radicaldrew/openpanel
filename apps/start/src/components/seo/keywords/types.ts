import type { RouterOutputs } from '@/trpc/client';

export type KeywordResearchRow =
  RouterOutputs['seo']['keywords']['ideas'][number];
export type RankedKeywordRow =
  RouterOutputs['seo']['keywords']['rankedKeywords']['rows'][number];
export type GscEnrichedRow =
  RouterOutputs['seo']['keywords']['gscEnriched']['rows'][number];
export type SerpPreview = RouterOutputs['seo']['keywords']['serpPreview'];

export type MonthlySearch = KeywordResearchRow['monthlySearches'][number];

/**
 * One row shape for every source so the results table, CSV export and
 * "Track selected" do not care where a keyword came from. Source-specific
 * columns are optional.
 */
export interface KeywordTableRow {
  keyword: string;
  searchVolume: number | null;
  difficulty: number | null;
  cpc: number | null;
  intent: string | null;
  monthlySearches: MonthlySearch[];
  /** Ranked keywords only. */
  position?: number | null;
  url?: string | null;
  /** Search Console only. */
  clicks?: number;
  impressions?: number;
  gscPosition?: number;
  /** Search Console only: metrics are being fetched in the background. */
  pending?: boolean;
}

export const KEYWORD_SOURCES = [
  { id: 'ideas', label: 'Ideas', needsSeed: true },
  { id: 'suggestions', label: 'Suggestions', needsSeed: true },
  { id: 'related', label: 'Related', needsSeed: true },
  { id: 'ranked', label: 'Ranked keywords for domain', needsSeed: false },
  { id: 'gsc', label: 'From Search Console', needsSeed: false },
] as const;

export type KeywordSource = (typeof KEYWORD_SOURCES)[number]['id'];

export function researchRowToTableRow(row: KeywordResearchRow): KeywordTableRow {
  return {
    keyword: row.keyword,
    searchVolume: row.searchVolume,
    difficulty: row.difficulty,
    cpc: row.cpc,
    intent: row.intent,
    monthlySearches: row.monthlySearches,
  };
}

export function rankedRowToTableRow(row: RankedKeywordRow): KeywordTableRow {
  return {
    ...researchRowToTableRow(row),
    position: row.position,
    url: row.url,
  };
}

export function gscRowToTableRow(row: GscEnrichedRow): KeywordTableRow {
  return {
    keyword: row.query,
    searchVolume: row.searchVolume,
    difficulty: row.difficulty,
    cpc: row.cpc,
    intent: null,
    monthlySearches: [],
    clicks: row.clicks,
    impressions: row.impressions,
    gscPosition: row.position,
    pending: row.pending,
  };
}
