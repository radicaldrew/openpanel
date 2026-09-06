import { type CsvCell, downloadSeoCsv } from '../seo-csv';
import type { BacklinkPageRow, BacklinkRow, ReferringDomainRow } from './use-backlinks';

export type BacklinksCsvKind = 'backlinks' | 'referring-domains' | 'top-pages';

const BACKLINKS_HEADER = [
  'domain_from',
  'url_from',
  'url_to',
  'anchor',
  'dofollow',
  'rank',
  'domain_from_rank',
  'page_from_rank',
  'spam_score',
  'first_seen',
  'last_visited',
  'lost_date',
  'is_new',
  'is_lost',
  'is_broken',
  'item_type',
];

const REFERRING_DOMAINS_HEADER = [
  'domain',
  'backlinks',
  'referring_pages',
  'rank',
  'spam_score',
  'first_seen',
  'broken_backlinks',
];

const TOP_PAGES_HEADER = ['url', 'backlinks', 'referring_domains', 'rank', 'broken_backlinks'];

export function backlinkRowsToCsvRows(rows: BacklinkRow[]): CsvCell[][] {
  return rows.map((row) => [
    row.domainFrom,
    row.urlFrom,
    row.urlTo,
    row.anchor,
    row.dofollow,
    row.rank,
    row.domainFromRank,
    row.pageFromRank,
    row.spamScore,
    row.firstSeen,
    row.lastVisited,
    row.lostDate,
    row.isNew,
    row.isLost,
    row.isBroken,
    row.itemType,
  ]);
}

export function referringDomainsToCsvRows(rows: ReferringDomainRow[]): CsvCell[][] {
  return rows.map((row) => [
    row.domain,
    row.backlinks,
    row.referringPages,
    row.rank,
    row.spamScore,
    row.firstSeen,
    row.brokenBacklinks,
  ]);
}

export function backlinkPagesToCsvRows(rows: BacklinkPageRow[]): CsvCell[][] {
  return rows.map((row) => [
    row.url,
    row.backlinks,
    row.referringDomains,
    row.rank,
    row.brokenBacklinks,
  ]);
}

/** Client-side export of the rows currently loaded in one of the three tables. */
export function downloadBacklinksCsv(kind: BacklinksCsvKind, rows: CsvCell[][], target: string): void {
  const header =
    kind === 'backlinks'
      ? BACKLINKS_HEADER
      : kind === 'referring-domains'
        ? REFERRING_DOMAINS_HEADER
        : TOP_PAGES_HEADER;
  downloadSeoCsv(header, rows, `${kind}-${target}`);
}
