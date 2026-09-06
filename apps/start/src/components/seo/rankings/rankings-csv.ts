import type { TrackingRow } from './use-tracking';
import { buildCsv, downloadSeoCsv, joinCsvList } from '@/components/seo/seo-csv';

const HEADER = [
  'keyword',
  'tags',
  'search_volume',
  'desktop_position',
  'mobile_position',
  'desktop_delta_7d',
  'desktop_delta_30d',
  'mobile_delta_7d',
  'mobile_delta_30d',
  'url',
  'active',
];

/** Positive deltas mean the keyword moved up, matching the table's chips. */
function toCsvRow(row: TrackingRow) {
  return [
    row.keyword,
    joinCsvList(row.tags),
    row.searchVolume,
    row.desktop?.position ?? null,
    row.mobile?.position ?? null,
    row.desktop?.delta7 ?? null,
    row.desktop?.delta30 ?? null,
    row.mobile?.delta7 ?? null,
    row.mobile?.delta30 ?? null,
    row.desktop?.url ?? row.mobile?.url ?? null,
    row.isActive,
  ];
}

export function rankingsToCsv(rows: TrackingRow[]): string {
  return buildCsv(HEADER, rows.map(toCsvRow));
}

export function downloadRankingsCsv(rows: TrackingRow[], name = 'rankings') {
  downloadSeoCsv(HEADER, rows.map(toCsvRow), name, 'rankings');
}
