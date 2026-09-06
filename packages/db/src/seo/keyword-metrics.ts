import {
  type DataforseoTransport,
  fetchAdsSearchVolume,
  fetchKeywordMetricsForList,
  fetchKeywordOverview,
  type KeywordMetricRow,
  type KeywordMetricsClient,
} from '@openpanel/dataforseo';
import { originalCh } from '../clickhouse/client';
import { db } from '../prisma-client';
import { getDfsClientForProject } from './client';
import { getSeoProjectConfig } from './config';
import { normalizeTrackedKeyword } from './tracking';

export const SEO_KEYWORD_METRICS_TABLE = 'seo_keyword_metrics';

/** A row of seo_keyword_metrics as the app reads it. */
export interface SeoKeywordMetrics {
  keyword: string;
  locationCode: number;
  languageCode: string;
  searchVolume: number | null;
  difficulty: number | null;
  cpc: number | null;
  competition: number | null;
  /** 12 months of {year, month, searchVolume}, oldest first as DFS sends it. */
  monthly: { year: number; month: number; searchVolume: number }[];
  fetchedAt: string;
}

interface SeoKeywordMetricsRow {
  keyword: string;
  location_code: number;
  language_code: string;
  search_volume: number;
  difficulty: number;
  cpc: number;
  competition: number;
  monthly_json: string;
  fetched_at: string;
}

// The table stores non-nullable numerics, so "DFS returned nothing" needs a
// sentinel that keeps a genuine 0 (no searches) distinct. search_volume is
// UInt32 and difficulty UInt8: a negative sentinel there makes ClickHouse
// reject the whole insert batch, so each column uses the top of its range.
// cpc and competition are Float32 and can carry -1.
const MISSING_UINT32 = 4_294_967_295;
const MISSING_UINT8 = 255;
const MISSING_FLOAT = -1;

function fromStored(value: number, missing: number): number | null {
  return value === missing ? null : value;
}

function parseMonthly(json: string): SeoKeywordMetrics['monthly'] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter(
        (entry): entry is { year: number; month: number; searchVolume: number } =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as { year?: unknown }).year === 'number'
      )
      .map((entry) => ({
        year: entry.year,
        month: entry.month,
        searchVolume: entry.searchVolume,
      }));
  } catch {
    return [];
  }
}

function toStored(row: SeoKeywordMetricsRow): SeoKeywordMetrics {
  return {
    keyword: row.keyword,
    locationCode: row.location_code,
    languageCode: row.language_code,
    searchVolume: fromStored(row.search_volume, MISSING_UINT32),
    difficulty: fromStored(row.difficulty, MISSING_UINT8),
    cpc: fromStored(row.cpc, MISSING_FLOAT),
    competition: fromStored(row.competition, MISSING_FLOAT),
    monthly: parseMonthly(row.monthly_json),
    fetchedAt: row.fetched_at,
  };
}

/**
 * Stored metrics for a set of keywords, newest fetch per keyword. Keywords
 * are normalized the same way tracked keywords are, so the caller can pass
 * whatever the user typed. Missing keywords are simply absent from the map.
 */
export async function getKeywordMetrics(
  projectId: string,
  keywords: string[]
): Promise<Map<string, SeoKeywordMetrics>> {
  const normalized = [...new Set(keywords.map(normalizeTrackedKeyword).filter(Boolean))];
  const result = new Map<string, SeoKeywordMetrics>();
  if (normalized.length === 0) {
    return result;
  }

  const queryResult = await originalCh.query({
    query: `
      SELECT keyword, location_code, language_code, search_volume, difficulty,
        cpc, competition, monthly_json, toString(fetched_at) AS fetched_at
      FROM ${SEO_KEYWORD_METRICS_TABLE} FINAL
      WHERE project_id = {projectId: String}
        AND keyword IN {keywords: Array(String)}
      ORDER BY fetched_at DESC
    `,
    query_params: { projectId, keywords: normalized },
    format: 'JSONEachRow',
  });
  const rows = await queryResult.json<SeoKeywordMetricsRow>();

  for (const row of rows) {
    if (!result.has(row.keyword)) {
      result.set(row.keyword, toStored(row));
    }
  }
  return result;
}

/**
 * The narrow client fetchKeywordMetricsForList needs, built on the raw
 * transport so this works before (and independently of) the bound client
 * methods, and so tests can hand in a fake with two functions.
 */
export function buildKeywordMetricsClient(
  transport: DataforseoTransport
): KeywordMetricsClient {
  return {
    labs: {
      keywordOverview: (input) => fetchKeywordOverview(transport, input),
    },
    keywords: {
      adsSearchVolume: (input) => fetchAdsSearchVolume(transport, input),
    },
  };
}

function toInsertRow(
  projectId: string,
  row: KeywordMetricRow,
  market: { locationCode: number; languageCode: string },
  fetchedAt: string
): Record<string, unknown> {
  return {
    project_id: projectId,
    keyword: normalizeTrackedKeyword(row.keyword),
    location_code: market.locationCode,
    language_code: market.languageCode,
    search_volume: row.searchVolume ?? MISSING_UINT32,
    difficulty: row.keywordDifficulty ?? MISSING_UINT8,
    cpc: row.cpc ?? MISSING_FLOAT,
    competition: row.competition ?? MISSING_FLOAT,
    monthly_json: JSON.stringify(row.monthlySearches),
    fetched_at: fetchedAt,
  };
}

function toClickhouseDateTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Fetch metrics from DataForSEO for the project's market, write them to
 * seo_keyword_metrics and copy volume/difficulty/cpc onto any matching
 * SeoTrackedKeyword rows. Batching (700 per Labs call, Google Ads fallback
 * for markets Labs does not cover) is handled by the package helper.
 *
 * `client` is injectable for the Keywords tab (which already holds one) and
 * for tests; by default it is resolved from the project's organization.
 */
export async function fetchAndStoreKeywordMetrics(
  projectId: string,
  keywords: string[],
  options: { client?: KeywordMetricsClient } = {}
): Promise<SeoKeywordMetrics[]> {
  const normalized = [...new Set(keywords.map(normalizeTrackedKeyword).filter(Boolean))];
  if (normalized.length === 0) {
    return [];
  }

  const config = await getSeoProjectConfig(projectId);
  if (!config) {
    throw new Error(`Project ${projectId} has no SEO config`);
  }
  const market = {
    locationCode: config.locationCode,
    languageCode: config.languageCode,
  };

  const client =
    options.client ??
    buildKeywordMetricsClient((await getDfsClientForProject(projectId)).transport);

  const rows = await fetchKeywordMetricsForList(client, {
    keywords: normalized,
    ...market,
  });
  if (rows.length === 0) {
    return [];
  }

  const now = new Date();
  const fetchedAt = toClickhouseDateTime(now);
  const values = rows.map((row) => toInsertRow(projectId, row, market, fetchedAt));
  await originalCh.insert({
    table: SEO_KEYWORD_METRICS_TABLE,
    values,
    format: 'JSONEachRow',
  });

  // Copy onto tracked keywords so the rankings table needs no CH join.
  await db.$transaction(
    rows.map((row) =>
      db.seoTrackedKeyword.updateMany({
        where: { projectId, keyword: normalizeTrackedKeyword(row.keyword) },
        data: {
          searchVolume: row.searchVolume,
          difficulty: row.keywordDifficulty,
          cpc: row.cpc,
          metricsAt: now,
        },
      })
    )
  );

  return values.map((value) => toStored(value as unknown as SeoKeywordMetricsRow));
}
