import type { KeywordTableRow } from './types';
import { buildCsv, downloadSeoCsv } from '@/components/seo/seo-csv';

const HEADER = [
  'keyword',
  'search_volume',
  'difficulty',
  'cpc',
  'intent',
  'position',
  'url',
  'clicks',
  'impressions',
];

function toCsvRow(row: KeywordTableRow) {
  return [
    row.keyword,
    row.searchVolume,
    row.difficulty,
    row.cpc,
    row.intent,
    row.position ?? row.gscPosition,
    row.url,
    row.clicks,
    row.impressions,
  ];
}

export function keywordsToCsv(rows: KeywordTableRow[]): string {
  return buildCsv(HEADER, rows.map(toCsvRow));
}

export function downloadKeywordsCsv(rows: KeywordTableRow[], name: string) {
  downloadSeoCsv(HEADER, rows.map(toCsvRow), name, 'keywords');
}
