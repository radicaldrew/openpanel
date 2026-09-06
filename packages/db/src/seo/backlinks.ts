import {
  type BacklinksHistoryItem,
  type BacklinksItem,
  type BacklinksSummaryItem,
  type DataforseoTransport,
  type DomainPageSummaryItem,
  fetchBacklinksHistory,
  fetchBacklinksRows,
  fetchBacklinksSummary,
  fetchDomainPagesSummary,
  fetchReferringDomains,
  type ReferringDomainItem,
} from '@openpanel/dataforseo';
import sqlstring from 'sqlstring';
import { chQuery, originalCh } from '../clickhouse/client';
import { withSeoCache } from './cache';
import { getSeoResearchContext, type SeoResearchContext } from './keywords';

export const SEO_BACKLINK_SNAPSHOTS_TABLE = 'seo_backlink_snapshots';

/** How far back one snapshot job fills the series from backlinks/history. */
export const BACKLINK_HISTORY_DAYS = 30;
/** A snapshot older than this triggers a live refresh from the summary tab. */
export const BACKLINK_SNAPSHOT_STALE_HOURS = 24;
/** Window for the "new / lost" card, matching the history fill. */
export const BACKLINK_NEW_LOST_WINDOW_DAYS = 30;
/** Both DataForSEO list endpoints and the UI page in steps up to this. */
export const BACKLINK_LIST_MAX_LIMIT = 200;
export const BACKLINK_LIST_DEFAULT_LIMIT = 50;

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const DATE_LENGTH = 10;

function toDateString(date: Date): string {
  return date.toISOString().slice(0, DATE_LENGTH);
}

function daysAgo(date: Date, days: number): Date {
  return new Date(date.getTime() - days * MS_PER_DAY);
}

function toClickhouseDateTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function nonNegativeInt(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.round(value));
}

// ---------------------------------------------------------------------------
// Snapshot rows (seo_backlink_snapshots)
// ---------------------------------------------------------------------------

export interface BacklinkSnapshot {
  projectId: string;
  /** YYYY-MM-DD */
  date: string;
  backlinks: number;
  referringDomains: number;
  referringIps: number;
  /** Domain rank on DataForSEO's 0-100 scale. */
  rank: number;
  spamScore: number;
  newBacklinks: number;
  lostBacklinks: number;
  syncedAt: Date;
}

/** The live summary as of now becomes today's row. */
export function summaryToSnapshot(
  projectId: string,
  summary: BacklinksSummaryItem,
  now: Date
): BacklinkSnapshot {
  return {
    projectId,
    date: toDateString(now),
    backlinks: nonNegativeInt(summary.backlinks),
    referringDomains: nonNegativeInt(summary.referring_domains),
    referringIps: nonNegativeInt(summary.referring_ips),
    rank: nonNegativeInt(summary.rank),
    spamScore: nonNegativeInt(summary.backlinks_spam_score),
    newBacklinks: nonNegativeInt(summary.new_backlinks),
    lostBacklinks: nonNegativeInt(summary.lost_backlinks),
    syncedAt: now,
  };
}

/** One backlinks/history item is one day. Items without a date are skipped. */
export function historyToSnapshot(
  projectId: string,
  item: BacklinksHistoryItem,
  now: Date
): BacklinkSnapshot | null {
  if (!item.date) {
    return null;
  }
  return {
    projectId,
    date: item.date.slice(0, DATE_LENGTH),
    backlinks: nonNegativeInt(item.backlinks),
    referringDomains: nonNegativeInt(item.referring_domains),
    referringIps: nonNegativeInt(item.referring_ips),
    rank: nonNegativeInt(item.rank),
    spamScore: nonNegativeInt(item.backlinks_spam_score),
    newBacklinks: nonNegativeInt(item.new_backlinks),
    lostBacklinks: nonNegativeInt(item.lost_backlinks),
    syncedAt: now,
  };
}

/**
 * Merge a live summary with the history series into one row per day. The
 * summary is the freshest number for today, so it wins over a history item
 * for the same date. Sorted oldest first.
 */
export function buildBacklinkSnapshots({
  projectId,
  summary,
  history,
  now,
}: {
  projectId: string;
  summary: BacklinksSummaryItem | null;
  history: BacklinksHistoryItem[];
  now: Date;
}): BacklinkSnapshot[] {
  const byDate = new Map<string, BacklinkSnapshot>();
  for (const item of history) {
    const row = historyToSnapshot(projectId, item, now);
    if (row) {
      byDate.set(row.date, row);
    }
  }
  if (summary) {
    const row = summaryToSnapshot(projectId, summary, now);
    byDate.set(row.date, row);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export interface BacklinkSnapshotFetch {
  rows: BacklinkSnapshot[];
  /** Live summary item, for callers that want fields the row does not keep. */
  summary: BacklinksSummaryItem | null;
  costUsd: number;
}

/**
 * The two DataForSEO calls behind a snapshot: backlinks/summary/live for
 * today's totals and backlinks/history/live for the last `historyDays`.
 * Pure with respect to storage so the worker and the summary refresh share
 * it; the caller persists with insertBacklinkSnapshots. Cost is also reported
 * through the transport's onCost hook, this copy is for the caller's log line.
 */
export async function fetchBacklinkSnapshots(
  transport: DataforseoTransport,
  {
    projectId,
    domain,
    historyDays = BACKLINK_HISTORY_DAYS,
    now = new Date(),
  }: {
    projectId: string;
    domain: string;
    historyDays?: number;
    now?: Date;
  }
): Promise<BacklinkSnapshotFetch> {
  const [summary, history] = await Promise.all([
    fetchBacklinksSummary(transport, { target: domain, includeSubdomains: true }),
    fetchBacklinksHistory(transport, {
      target: domain,
      dateFrom: toDateString(daysAgo(now, historyDays)),
      dateTo: toDateString(now),
    }),
  ]);
  const summaryItem =
    Object.keys(summary.data).length > 0 ? summary.data : null;
  return {
    rows: buildBacklinkSnapshots({
      projectId,
      summary: summaryItem,
      history: history.data,
      now,
    }),
    summary: summaryItem,
    costUsd: summary.billing.costUsd + history.billing.costUsd,
  };
}

export async function insertBacklinkSnapshots(
  rows: BacklinkSnapshot[]
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  await originalCh.insert({
    table: SEO_BACKLINK_SNAPSHOTS_TABLE,
    values: rows.map((row) => ({
      project_id: row.projectId,
      date: row.date,
      backlinks: row.backlinks,
      referring_domains: row.referringDomains,
      referring_ips: row.referringIps,
      rank: row.rank,
      spam_score: row.spamScore,
      new_backlinks: row.newBacklinks,
      lost_backlinks: row.lostBacklinks,
      synced_at: toClickhouseDateTime(row.syncedAt),
    })),
    format: 'JSONEachRow',
  });
}

interface SnapshotRow {
  project_id: string;
  date: string;
  backlinks: number;
  referring_domains: number;
  referring_ips: number;
  rank: number;
  spam_score: number;
  new_backlinks: number;
  lost_backlinks: number;
  synced_at: string;
}

function fromRow(row: SnapshotRow): BacklinkSnapshot {
  return {
    projectId: row.project_id,
    date: row.date,
    backlinks: row.backlinks,
    referringDomains: row.referring_domains,
    referringIps: row.referring_ips,
    rank: row.rank,
    spamScore: row.spam_score,
    newBacklinks: row.new_backlinks,
    lostBacklinks: row.lost_backlinks,
    syncedAt: new Date(`${row.synced_at.replace(' ', 'T')}Z`),
  };
}

const SNAPSHOT_COLUMNS = `
  project_id,
  toString(date) AS date,
  backlinks,
  referring_domains,
  referring_ips,
  rank,
  spam_score,
  new_backlinks,
  lost_backlinks,
  toString(synced_at) AS synced_at`;

export async function getLatestBacklinkSnapshot(
  projectId: string
): Promise<BacklinkSnapshot | null> {
  const rows = await chQuery<SnapshotRow>(`
    SELECT ${SNAPSHOT_COLUMNS}
    FROM ${SEO_BACKLINK_SNAPSHOTS_TABLE} FINAL
    WHERE project_id = ${sqlstring.escape(projectId)}
    ORDER BY date DESC
    LIMIT 1
  `);
  const row = rows[0];
  return row ? fromRow(row) : null;
}

export async function getBacklinkSnapshotHistory({
  projectId,
  startDate,
  endDate,
}: {
  projectId: string;
  /** YYYY-MM-DD, inclusive. */
  startDate: string;
  endDate: string;
}): Promise<BacklinkSnapshot[]> {
  const rows = await chQuery<SnapshotRow>(`
    SELECT ${SNAPSHOT_COLUMNS}
    FROM ${SEO_BACKLINK_SNAPSHOTS_TABLE} FINAL
    WHERE project_id = ${sqlstring.escape(projectId)}
      AND date >= ${sqlstring.escape(startDate)}
      AND date <= ${sqlstring.escape(endDate)}
    ORDER BY date
  `);
  return rows.map(fromRow);
}

export function isBacklinkSnapshotStale(
  snapshot: BacklinkSnapshot | null,
  now: Date = new Date()
): boolean {
  if (!snapshot) {
    return true;
  }
  return now.getTime() - snapshot.syncedAt.getTime() > BACKLINK_SNAPSHOT_STALE_HOURS * MS_PER_HOUR;
}

/** Σ new / lost over the trailing window, from whatever rows exist. */
export function sumNewLost(
  rows: BacklinkSnapshot[],
  now: Date,
  windowDays: number = BACKLINK_NEW_LOST_WINDOW_DAYS
): { newBacklinks: number; lostBacklinks: number; days: number } {
  const since = toDateString(daysAgo(now, windowDays));
  let newBacklinks = 0;
  let lostBacklinks = 0;
  let days = 0;
  for (const row of rows) {
    if (row.date < since) {
      continue;
    }
    newBacklinks += row.newBacklinks;
    lostBacklinks += row.lostBacklinks;
    days += 1;
  }
  return { newBacklinks, lostBacklinks, days };
}

// ---------------------------------------------------------------------------
// Targets: own domain or a configured competitor
// ---------------------------------------------------------------------------

export interface BacklinkTarget {
  ctx: SeoResearchContext;
  /** Lowercased domain the DFS calls are made for. */
  target: string;
  isOwnDomain: boolean;
}

/**
 * Backlink lookups are allowed for the tracked domain and its configured
 * competitors only, so one project cannot spend the org's budget researching
 * arbitrary sites.
 */
export async function resolveBacklinkTarget(
  projectId: string,
  target?: string | null
): Promise<BacklinkTarget> {
  const ctx = await getSeoResearchContext(projectId);
  const wanted = (target ?? ctx.domain).trim().toLowerCase();
  const own = ctx.domain.toLowerCase();
  if (wanted === own) {
    return { ctx, target: own, isOwnDomain: true };
  }
  const competitor = ctx.competitors.find(
    (domain) => domain.toLowerCase() === wanted
  );
  if (!competitor) {
    throw new Error(
      `Domain ${wanted} is neither the tracked domain nor a configured competitor`
    );
  }
  return { ctx, target: competitor.toLowerCase(), isOwnDomain: false };
}

// ---------------------------------------------------------------------------
// Overview (cards)
// ---------------------------------------------------------------------------

export interface BacklinkOverview {
  target: string;
  isOwnDomain: boolean;
  /** 'snapshot' rows come from ClickHouse, 'live' from a fresh summary call. */
  source: 'snapshot' | 'live';
  asOf: string;
  stale: boolean;
  backlinks: number | null;
  referringDomains: number | null;
  referringIps: number | null;
  rank: number | null;
  spamScore: number | null;
  /** Σ over the last BACKLINK_NEW_LOST_WINDOW_DAYS days of history. */
  newBacklinks30d: number | null;
  lostBacklinks30d: number | null;
  /** Days of history behind the 30d sums, so the UI can caption a short series. */
  newLostDays: number;
  brokenBacklinks: number | null;
  referringPages: number | null;
}

function overviewFromSnapshot(
  resolved: BacklinkTarget,
  latest: BacklinkSnapshot,
  history: BacklinkSnapshot[],
  now: Date,
  source: BacklinkOverview['source'],
  extra: { brokenBacklinks: number | null; referringPages: number | null }
): BacklinkOverview {
  const newLost = sumNewLost(history, now);
  return {
    target: resolved.target,
    isOwnDomain: resolved.isOwnDomain,
    source,
    asOf: latest.syncedAt.toISOString(),
    stale: isBacklinkSnapshotStale(latest, now),
    backlinks: latest.backlinks,
    referringDomains: latest.referringDomains,
    referringIps: latest.referringIps,
    rank: latest.rank,
    spamScore: latest.spamScore,
    newBacklinks30d: newLost.days > 0 ? newLost.newBacklinks : null,
    lostBacklinks30d: newLost.days > 0 ? newLost.lostBacklinks : null,
    newLostDays: newLost.days,
    ...extra,
  };
}

/**
 * Refresh the own-domain snapshot from DataForSEO and persist it. Cached per
 * project and calendar day for the backlinks TTL so two tabs opening at once
 * (or a refetch racing the insert) pay for one refresh, not two.
 */
export async function refreshBacklinkSnapshot(
  resolved: BacklinkTarget,
  now: Date = new Date()
): Promise<BacklinkSnapshotFetch> {
  const fetched = await withSeoCache(
    {
      organizationId: resolved.ctx.organizationId,
      endpoint: 'backlinks/snapshot',
      params: { projectId: resolved.ctx.projectId, day: toDateString(now) },
      ttl: 'backlinks',
    },
    async () => {
      const result = await fetchBacklinkSnapshots(resolved.ctx.client.transport, {
        projectId: resolved.ctx.projectId,
        domain: resolved.target,
        now,
      });
      await insertBacklinkSnapshots(result.rows);
      return result;
    }
  );
  // Redis round-trips Dates as strings.
  return {
    ...fetched,
    rows: fetched.rows.map((row) => ({
      ...row,
      syncedAt: new Date(row.syncedAt),
    })),
  };
}

/**
 * Cards for the Backlinks tab. Own domain: latest ClickHouse snapshot, and
 * when it is missing or older than 24h — and the caller may spend — a live
 * refresh that is persisted. Competitors: a live summary (+ history for the
 * 30d card), cached 6h, never persisted.
 */
export async function getBacklinkOverview({
  projectId,
  target,
  allowRefresh,
  now = new Date(),
}: {
  projectId: string;
  target?: string | null;
  /** False for read-only members: they see the stored snapshot, stale or not. */
  allowRefresh: boolean;
  now?: Date;
}): Promise<BacklinkOverview> {
  const resolved = await resolveBacklinkTarget(projectId, target);

  if (resolved.isOwnDomain) {
    const latest = await getLatestBacklinkSnapshot(projectId);
    if (latest && !(allowRefresh && isBacklinkSnapshotStale(latest, now))) {
      const history = await getBacklinkSnapshotHistory({
        projectId,
        startDate: toDateString(daysAgo(now, BACKLINK_NEW_LOST_WINDOW_DAYS)),
        endDate: toDateString(now),
      });
      return overviewFromSnapshot(resolved, latest, history, now, 'snapshot', {
        brokenBacklinks: null,
        referringPages: null,
      });
    }
    if (!allowRefresh) {
      return emptyOverview(resolved, now);
    }
    const fetched = await refreshBacklinkSnapshot(resolved, now);
    const today = fetched.rows.at(-1);
    if (!today) {
      return emptyOverview(resolved, now);
    }
    return overviewFromSnapshot(resolved, today, fetched.rows, now, 'live', {
      brokenBacklinks: fetched.summary?.broken_backlinks ?? null,
      referringPages: fetched.summary?.referring_pages ?? null,
    });
  }

  // Competitor: live, cached, not persisted.
  const fetched = await withSeoCache(
    {
      organizationId: resolved.ctx.organizationId,
      endpoint: 'backlinks/overview',
      params: { target: resolved.target, day: toDateString(now) },
      ttl: 'backlinks',
    },
    () =>
      fetchBacklinkSnapshots(resolved.ctx.client.transport, {
        projectId,
        domain: resolved.target,
        now,
      })
  );
  const rows = fetched.rows.map((row) => ({
    ...row,
    syncedAt: new Date(row.syncedAt),
  }));
  const today = rows.at(-1);
  if (!today) {
    return emptyOverview(resolved, now);
  }
  return overviewFromSnapshot(resolved, today, rows, now, 'live', {
    brokenBacklinks: fetched.summary?.broken_backlinks ?? null,
    referringPages: fetched.summary?.referring_pages ?? null,
  });
}

function emptyOverview(resolved: BacklinkTarget, now: Date): BacklinkOverview {
  return {
    target: resolved.target,
    isOwnDomain: resolved.isOwnDomain,
    source: 'snapshot',
    asOf: now.toISOString(),
    stale: true,
    backlinks: null,
    referringDomains: null,
    referringIps: null,
    rank: null,
    spamScore: null,
    newBacklinks30d: null,
    lostBacklinks30d: null,
    newLostDays: 0,
    brokenBacklinks: null,
    referringPages: null,
  };
}

// ---------------------------------------------------------------------------
// History series (chart)
// ---------------------------------------------------------------------------

export interface BacklinkHistoryPoint {
  date: string;
  backlinks: number;
  referringDomains: number;
  rank: number;
  newBacklinks: number;
  lostBacklinks: number;
}

function toHistoryPoint(row: BacklinkSnapshot): BacklinkHistoryPoint {
  return {
    date: row.date,
    backlinks: row.backlinks,
    referringDomains: row.referringDomains,
    rank: row.rank,
    newBacklinks: row.newBacklinks,
    lostBacklinks: row.lostBacklinks,
  };
}

/**
 * Own domain reads the persisted snapshots. A competitor has none, so its
 * series comes straight from backlinks/history (cached 6h) for the range.
 */
export async function getBacklinkHistory({
  projectId,
  target,
  startDate,
  endDate,
}: {
  projectId: string;
  target?: string | null;
  startDate: string;
  endDate: string;
}): Promise<{ target: string; isOwnDomain: boolean; points: BacklinkHistoryPoint[] }> {
  const resolved = await resolveBacklinkTarget(projectId, target);
  if (resolved.isOwnDomain) {
    const rows = await getBacklinkSnapshotHistory({ projectId, startDate, endDate });
    return {
      target: resolved.target,
      isOwnDomain: true,
      points: rows.map(toHistoryPoint),
    };
  }
  const params = { target: resolved.target, dateFrom: startDate, dateTo: endDate };
  const items = await withSeoCache(
    {
      organizationId: resolved.ctx.organizationId,
      endpoint: 'backlinks/history',
      params,
      ttl: 'backlinks',
    },
    async () => (await fetchBacklinksHistory(resolved.ctx.client.transport, params)).data
  );
  const now = new Date();
  const points = items
    .map((item) => historyToSnapshot(projectId, item, now))
    .filter((row): row is BacklinkSnapshot => row !== null)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(toHistoryPoint);
  return { target: resolved.target, isOwnDomain: false, points };
}

// ---------------------------------------------------------------------------
// Lists: backlinks / referring domains / top pages
// ---------------------------------------------------------------------------

export type BacklinkStatusFilter = 'live' | 'new' | 'lost' | 'all';

export interface BacklinkListFilters {
  /** Only dofollow (true) or only nofollow (false); omit for both. */
  dofollow?: boolean;
  /** `live` (default) hides lost links; `new` / `lost` narrow further. */
  status?: BacklinkStatusFilter;
  /** Minimum rank of the linking page / domain / target page. */
  minRank?: number;
  /** Case-insensitive substring on the linking domain (or page URL). */
  search?: string;
  /** Hide links whose spam score is above 40. Off by default for an audit. */
  hideSpam?: boolean;
}

export type BacklinkSortOrder = 'asc' | 'desc';
export type BacklinkRowsSort = 'rank' | 'domainRank' | 'spamScore' | 'firstSeen';
export type ReferringDomainsSort =
  | 'backlinks'
  | 'referringPages'
  | 'rank'
  | 'spamScore'
  | 'firstSeen';
export type BacklinkPagesSort = 'backlinks' | 'referringDomains' | 'rank';

const ROWS_SORT_FIELDS: Record<BacklinkRowsSort, string> = {
  rank: 'rank',
  domainRank: 'domain_from_rank',
  spamScore: 'backlink_spam_score',
  firstSeen: 'first_seen',
};
const DOMAINS_SORT_FIELDS: Record<ReferringDomainsSort, string> = {
  backlinks: 'backlinks',
  referringPages: 'referring_pages',
  rank: 'rank',
  spamScore: 'backlinks_spam_score',
  firstSeen: 'first_seen',
};
const PAGES_SORT_FIELDS: Record<BacklinkPagesSort, string> = {
  backlinks: 'backlinks',
  referringDomains: 'referring_domains',
  rank: 'rank',
};

const LIKE_SPECIALS = /[\\%_]/g;

function likeTerm(term: string): string {
  return `%${term.trim().toLowerCase().replace(LIKE_SPECIALS, (match) => `\\${match}`)}%`;
}

function joinAnd(conditions: unknown[][]): unknown[] | undefined {
  if (conditions.length === 0) {
    return undefined;
  }
  const joined: unknown[] = [];
  for (const condition of conditions) {
    if (joined.length > 0) {
      joined.push('and');
    }
    joined.push(condition);
  }
  return joined;
}

/** DataForSEO filter expression for the backlinks list. */
export function buildBacklinkRowFilters(filters: BacklinkListFilters): unknown[] | undefined {
  const conditions: unknown[][] = [];
  if (filters.dofollow !== undefined) {
    conditions.push(['dofollow', '=', filters.dofollow]);
  }
  if (filters.status === 'new') {
    conditions.push(['is_new', '=', true]);
  }
  if (filters.status === 'lost') {
    conditions.push(['is_lost', '=', true]);
  }
  if (filters.minRank !== undefined && filters.minRank > 0) {
    conditions.push(['rank', '>=', filters.minRank]);
  }
  if (filters.search?.trim()) {
    conditions.push(['domain_from', 'ilike', likeTerm(filters.search)]);
  }
  return joinAnd(conditions);
}

function buildDomainFilters(
  filters: BacklinkListFilters,
  searchField: string
): unknown[] | undefined {
  const conditions: unknown[][] = [];
  if (filters.minRank !== undefined && filters.minRank > 0) {
    conditions.push(['rank', '>=', filters.minRank]);
  }
  if (filters.search?.trim()) {
    conditions.push([searchField, 'ilike', likeTerm(filters.search)]);
  }
  return joinAnd(conditions);
}

/** The `lost` view needs DataForSEO to include lost links at all. */
function statusTypeFor(status: BacklinkStatusFilter | undefined): 'live' | 'lost' | 'all' {
  if (status === 'lost') {
    return 'lost';
  }
  if (status === 'all') {
    return 'all';
  }
  return 'live';
}

export interface BacklinkPage<TRow> {
  target: string;
  isOwnDomain: boolean;
  rows: TRow[];
  totalCount: number | null;
  /** Pass back as `cursor` for the next page; null when this is the last. */
  nextCursor: string | null;
}

function pageOf<TRow>(
  resolved: BacklinkTarget,
  rows: TRow[],
  totalCount: number | null,
  offset: number,
  limit: number
): BacklinkPage<TRow> {
  const next = offset + rows.length;
  const hasMore =
    rows.length >= limit && (totalCount === null || next < totalCount);
  return {
    target: resolved.target,
    isOwnDomain: resolved.isOwnDomain,
    rows,
    totalCount,
    nextCursor: hasMore ? String(next) : null,
  };
}

export function parseBacklinkCursor(cursor: string | null | undefined): number {
  if (!cursor) {
    return 0;
  }
  const offset = Number.parseInt(cursor, 10);
  return Number.isFinite(offset) && offset > 0 ? offset : 0;
}

export interface BacklinkRow {
  urlFrom: string;
  domainFrom: string;
  urlTo: string;
  anchor: string | null;
  itemType: string | null;
  dofollow: boolean;
  rank: number | null;
  domainFromRank: number | null;
  pageFromRank: number | null;
  spamScore: number | null;
  firstSeen: string | null;
  lastVisited: string | null;
  lostDate: string | null;
  isNew: boolean;
  isLost: boolean;
  isBroken: boolean;
}

export function toBacklinkRow(item: BacklinksItem): BacklinkRow {
  return {
    urlFrom: item.url_from ?? '',
    domainFrom: item.domain_from ?? '',
    urlTo: item.url_to ?? '',
    anchor: item.anchor ?? null,
    itemType: item.item_type ?? null,
    dofollow: item.dofollow ?? false,
    rank: item.rank ?? null,
    domainFromRank: item.domain_from_rank ?? null,
    pageFromRank: item.page_from_rank ?? null,
    spamScore: item.backlink_spam_score ?? item.backlinks_spam_score ?? null,
    firstSeen: item.first_seen ?? null,
    lastVisited: item.last_visited ?? null,
    lostDate: item.lost_date ?? null,
    isNew: item.is_new ?? false,
    isLost: item.is_lost ?? false,
    isBroken: item.is_broken ?? false,
  };
}

export interface ReferringDomainRow {
  domain: string;
  backlinks: number;
  referringPages: number | null;
  rank: number | null;
  spamScore: number | null;
  firstSeen: string | null;
  brokenBacklinks: number | null;
}

export function toReferringDomainRow(item: ReferringDomainItem): ReferringDomainRow {
  return {
    domain: item.domain ?? '',
    backlinks: item.backlinks ?? 0,
    referringPages: item.referring_pages ?? null,
    rank: item.rank ?? null,
    spamScore: item.backlinks_spam_score ?? null,
    firstSeen: item.first_seen ?? null,
    brokenBacklinks: item.broken_backlinks ?? null,
  };
}

export interface BacklinkPageRow {
  url: string;
  backlinks: number;
  referringDomains: number | null;
  rank: number | null;
  brokenBacklinks: number | null;
}

export function toBacklinkPageRow(item: DomainPageSummaryItem): BacklinkPageRow {
  return {
    url: item.url ?? item.page ?? '',
    backlinks: item.backlinks ?? 0,
    referringDomains: item.referring_domains ?? null,
    rank: item.rank ?? null,
    brokenBacklinks: item.broken_backlinks ?? null,
  };
}

interface ListInput {
  projectId: string;
  target?: string | null;
  filters?: BacklinkListFilters;
  cursor?: string | null;
  limit?: number;
  order?: BacklinkSortOrder;
}

function limitOf(limit: number | undefined): number {
  return Math.min(BACKLINK_LIST_MAX_LIMIT, Math.max(1, limit ?? BACKLINK_LIST_DEFAULT_LIMIT));
}

export async function getBacklinkRows({
  projectId,
  target,
  filters = {},
  cursor,
  limit,
  sort = 'rank',
  order = 'desc',
}: ListInput & { sort?: BacklinkRowsSort }): Promise<BacklinkPage<BacklinkRow>> {
  const resolved = await resolveBacklinkTarget(projectId, target);
  const offset = parseBacklinkCursor(cursor);
  const take = limitOf(limit);
  const params = {
    target: resolved.target,
    includeSubdomains: true,
    statusType: statusTypeFor(filters.status),
    limit: take,
    offset,
    orderBy: [`${ROWS_SORT_FIELDS[sort]},${order}`],
    filters: buildBacklinkRowFilters(filters),
    mode: 'as_is',
    hideSpam: filters.hideSpam ?? false,
  };
  const page = await withSeoCache(
    {
      organizationId: resolved.ctx.organizationId,
      endpoint: 'backlinks/backlinks',
      params,
      ttl: 'backlinks',
    },
    async () => (await fetchBacklinksRows(resolved.ctx.client.transport, params)).data
  );
  return pageOf(resolved, page.items.map(toBacklinkRow), page.totalCount, offset, take);
}

export async function getReferringDomains({
  projectId,
  target,
  filters = {},
  cursor,
  limit,
  sort = 'backlinks',
  order = 'desc',
}: ListInput & { sort?: ReferringDomainsSort }): Promise<BacklinkPage<ReferringDomainRow>> {
  const resolved = await resolveBacklinkTarget(projectId, target);
  const offset = parseBacklinkCursor(cursor);
  const take = limitOf(limit);
  const params = {
    target: resolved.target,
    includeSubdomains: true,
    statusType: statusTypeFor(filters.status),
    limit: take,
    offset,
    orderBy: [`${DOMAINS_SORT_FIELDS[sort]},${order}`],
    filters: buildDomainFilters(filters, 'domain'),
    hideSpam: filters.hideSpam ?? false,
  };
  const page = await withSeoCache(
    {
      organizationId: resolved.ctx.organizationId,
      endpoint: 'backlinks/referring_domains',
      params,
      ttl: 'backlinks',
    },
    async () => (await fetchReferringDomains(resolved.ctx.client.transport, params)).data
  );
  return pageOf(
    resolved,
    page.items.map(toReferringDomainRow),
    page.totalCount,
    offset,
    take
  );
}

export async function getBacklinkPages({
  projectId,
  target,
  filters = {},
  cursor,
  limit,
  sort = 'backlinks',
  order = 'desc',
}: ListInput & { sort?: BacklinkPagesSort }): Promise<BacklinkPage<BacklinkPageRow>> {
  const resolved = await resolveBacklinkTarget(projectId, target);
  const offset = parseBacklinkCursor(cursor);
  const take = limitOf(limit);
  const params = {
    target: resolved.target,
    includeSubdomains: true,
    statusType: statusTypeFor(filters.status),
    limit: take,
    offset,
    orderBy: [`${PAGES_SORT_FIELDS[sort]},${order}`],
    filters: buildDomainFilters(filters, 'url'),
  };
  const page = await withSeoCache(
    {
      organizationId: resolved.ctx.organizationId,
      endpoint: 'backlinks/domain_pages_summary',
      params,
      ttl: 'backlinks',
    },
    async () => (await fetchDomainPagesSummary(resolved.ctx.client.transport, params)).data
  );
  return pageOf(resolved, page.items.map(toBacklinkPageRow), page.totalCount, offset, take);
}
