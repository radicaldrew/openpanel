import { z } from 'zod';
import type { DataforseoTransport } from './core';
import {
  assertOk,
  buildTaskBilling,
  type DataforseoApiResponse,
  parseTaskItems,
  parseTaskTotalCount,
  parseWithSchema,
} from './envelope';
import { DataForSeoError } from './errors';
import { parseResearchTarget, type ResearchScope } from './research-scope';
import {
  type BacklinksScopeWithLegacy,
  type BacklinksSpamFilterOptions,
  normalizeBacklinksSpamFilterOptions,
  resolveBacklinksScope,
} from './types/backlinks';

export interface BacklinksRequest {
  target: string;
  /**
   * Whether the target's subdomains count. Defaults to DataForSEO's `true`.
   * The API ignores it for page targets; `backlinks/history/live` has no such
   * field, so a domain-scoped history is always subdomain-inclusive.
   */
  includeSubdomains?: boolean;
  /**
   * Which links to return: `live` (default) only links seen on the last crawl,
   * `lost` only links that disappeared, `all` both. Needed for a "lost links"
   * view, since the default silently drops them.
   */
  statusType?: 'live' | 'lost' | 'all';
}
export type BacklinksListRequest = BacklinksRequest &
  BacklinksSpamFilterOptions & {
    limit?: number;
    offset?: number;
    /** DataForSEO order_by entries, e.g. ["rank,desc"]. */
    orderBy?: string[];
    /** Pre-built DataForSEO filter expressions, already joined with and/or. */
    filters?: unknown[];
    /** Result grouping (backlinks list only): "one_per_domain" | "as_is". */
    mode?: string;
  };
export interface BacklinksTimeseriesRequest {
  target: string;
  dateFrom: string;
  dateTo: string;
}

// DataForSEO ships both the misspelled (`*_reffering_*`) and corrected keys; we
// accept both via passthrough so callers can read whichever is present.
export const backlinksSummaryItemSchema = z
  .object({
    target: z.string().optional(),
    rank: z.number().nullable().optional(),
    backlinks: z.number().nullable().optional(),
    referring_pages: z.number().nullable().optional(),
    referring_domains: z.number().nullable().optional(),
    referring_main_domains: z.number().nullable().optional(),
    referring_ips: z.number().nullable().optional(),
    referring_subnets: z.number().nullable().optional(),
    broken_backlinks: z.number().nullable().optional(),
    broken_pages: z.number().nullable().optional(),
    new_backlinks: z.number().nullable().optional(),
    lost_backlinks: z.number().nullable().optional(),
    new_reffering_domains: z.number().nullable().optional(),
    lost_reffering_domains: z.number().nullable().optional(),
    new_referring_domains: z.number().nullable().optional(),
    lost_referring_domains: z.number().nullable().optional(),
    backlinks_spam_score: z.number().nullable().optional(),
    info: z
      .object({ target_spam_score: z.number().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export const backlinksItemSchema = z
  .object({
    domain_from: z.string().nullable().optional(),
    url_from: z.string().nullable().optional(),
    url_to: z.string().nullable().optional(),
    anchor: z.string().nullable().optional(),
    item_type: z.string().nullable().optional(),
    dofollow: z.boolean().nullable().optional(),
    rank: z.number().nullable().optional(),
    domain_from_rank: z.number().nullable().optional(),
    page_from_rank: z.number().nullable().optional(),
    backlinks_spam_score: z.number().nullable().optional(),
    backlink_spam_score: z.number().nullable().optional(),
    first_seen: z.string().nullable().optional(),
    last_visited: z.string().nullable().optional(),
    lost_date: z.string().nullable().optional(),
    is_new: z.boolean().nullable().optional(),
    is_lost: z.boolean().nullable().optional(),
    is_broken: z.boolean().nullable().optional(),
    links_count: z.number().nullable().optional(),
    rel_attributes: z.array(z.string()).nullable().optional(),
    attributes: z.array(z.string()).nullable().optional(),
  })
  .passthrough();

export const referringDomainItemSchema = z
  .object({
    domain: z.string().nullable().optional(),
    backlinks: z.number().nullable().optional(),
    referring_pages: z.number().nullable().optional(),
    rank: z.number().nullable().optional(),
    first_seen: z.string().nullable().optional(),
    broken_backlinks: z.number().nullable().optional(),
    broken_pages: z.number().nullable().optional(),
    backlinks_spam_score: z.number().nullable().optional(),
    target_spam_score: z.number().nullable().optional(),
  })
  .passthrough();

export const domainPageSummaryItemSchema = z
  .object({
    page: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    backlinks: z.number().nullable().optional(),
    referring_domains: z.number().nullable().optional(),
    referring_pages: z.number().nullable().optional(),
    rank: z.number().nullable().optional(),
    broken_backlinks: z.number().nullable().optional(),
    first_seen: z.string().nullable().optional(),
  })
  .passthrough();

export const backlinksHistoryItemSchema = z
  .object({
    date: z.string().nullable().optional(),
    rank: z.number().nullable().optional(),
    backlinks: z.number().nullable().optional(),
    referring_domains: z.number().nullable().optional(),
    referring_main_domains: z.number().nullable().optional(),
    referring_ips: z.number().nullable().optional(),
    referring_pages: z.number().nullable().optional(),
    broken_backlinks: z.number().nullable().optional(),
    backlinks_spam_score: z.number().nullable().optional(),
    new_backlinks: z.number().nullable().optional(),
    lost_backlinks: z.number().nullable().optional(),
    new_reffering_domains: z.number().nullable().optional(),
    lost_reffering_domains: z.number().nullable().optional(),
    new_referring_domains: z.number().nullable().optional(),
    lost_referring_domains: z.number().nullable().optional(),
  })
  .passthrough();

export type BacklinksSummaryItem = z.infer<typeof backlinksSummaryItemSchema>;
export type BacklinksItem = z.infer<typeof backlinksItemSchema>;
export type ReferringDomainItem = z.infer<typeof referringDomainItemSchema>;
export type DomainPageSummaryItem = z.infer<typeof domainPageSummaryItemSchema>;
export type BacklinksHistoryItem = z.infer<typeof backlinksHistoryItemSchema>;

function buildCommonPayload(input: BacklinksRequest) {
  return {
    target: input.target,
    include_subdomains: input.includeSubdomains ?? true,
    include_indirect_links: true,
    exclude_internal_backlinks: true,
    backlinks_status_type: input.statusType ?? 'live',
    rank_scale: 'one_hundred',
  };
}

/**
 * Joins caller-provided filter expressions with the spam-score condition.
 * `userFilters` arrives already and/or-joined, so the spam condition is
 * appended with a single top-level "and".
 */
function combineFilters(
  userFilters: unknown[] | undefined,
  spamCondition: unknown[] | undefined,
): unknown[] | undefined {
  const merged: unknown[] = [];
  if (userFilters && userFilters.length > 0) {
    merged.push(...userFilters);
  }
  if (spamCondition) {
    if (merged.length > 0) {
      merged.push('and');
    }
    merged.push(spamCondition);
  }
  return merged.length > 0 ? merged : undefined;
}

export async function fetchBacklinksSummary(
  transport: DataforseoTransport,
  input: BacklinksRequest,
): Promise<DataforseoApiResponse<BacklinksSummaryItem>> {
  const path = '/v3/backlinks/summary/live';
  const response = await transport.post(path, [buildCommonPayload(input)]);
  const task = assertOk(response, { path });

  const firstResult = task.result?.[0];
  if (firstResult) {
    const data = parseWithSchema(
      'backlinks-summary-live',
      task,
      firstResult,
      backlinksSummaryItemSchema,
    );
    return { data, billing: buildTaskBilling(task) };
  }

  // A null / empty result is DataForSEO's "we know nothing about this target".
  return { data: {}, billing: buildTaskBilling(task) };
}

export async function fetchBacklinksRows(
  transport: DataforseoTransport,
  input: BacklinksListRequest,
): Promise<DataforseoApiResponse<{ items: BacklinksItem[]; totalCount: number | null }>> {
  const path = '/v3/backlinks/backlinks/live';
  const spamFilterOptions = normalizeBacklinksSpamFilterOptions(input);
  const filters = combineFilters(
    input.filters,
    spamFilterOptions.hideSpam
      ? ['backlink_spam_score', '<=', spamFilterOptions.spamThreshold]
      : undefined,
  );
  const response = await transport.post(path, [
    {
      ...buildCommonPayload(input),
      limit: input.limit ?? 100,
      offset: input.offset,
      order_by: input.orderBy ?? ['rank,desc'],
      mode: input.mode,
      ...(filters ? { filters } : {}),
    },
  ]);
  const task = assertOk(response, { path });
  return {
    data: {
      items: parseTaskItems('backlinks-live', task, backlinksItemSchema),
      totalCount: parseTaskTotalCount(task),
    },
    billing: buildTaskBilling(task),
  };
}

export async function fetchReferringDomains(
  transport: DataforseoTransport,
  input: BacklinksListRequest,
): Promise<
  DataforseoApiResponse<{ items: ReferringDomainItem[]; totalCount: number | null }>
> {
  const path = '/v3/backlinks/referring_domains/live';
  const spamFilterOptions = normalizeBacklinksSpamFilterOptions(input);
  const filters = combineFilters(
    input.filters,
    spamFilterOptions.hideSpam
      ? ['backlinks_spam_score', '<=', spamFilterOptions.spamThreshold]
      : undefined,
  );
  const response = await transport.post(path, [
    {
      ...buildCommonPayload(input),
      limit: input.limit ?? 100,
      offset: input.offset,
      order_by: input.orderBy ?? ['backlinks,desc'],
      ...(filters ? { filters } : {}),
    },
  ]);
  const task = assertOk(response, { path });
  return {
    data: {
      items: parseTaskItems('referring-domains-live', task, referringDomainItemSchema),
      totalCount: parseTaskTotalCount(task),
    },
    billing: buildTaskBilling(task),
  };
}

export async function fetchDomainPagesSummary(
  transport: DataforseoTransport,
  input: BacklinksListRequest,
): Promise<
  DataforseoApiResponse<{ items: DomainPageSummaryItem[]; totalCount: number | null }>
> {
  const path = '/v3/backlinks/domain_pages_summary/live';
  const filters = input.filters && input.filters.length > 0 ? input.filters : undefined;
  const response = await transport.post(path, [
    {
      ...buildCommonPayload(input),
      limit: input.limit ?? 100,
      offset: input.offset,
      order_by: input.orderBy ?? ['backlinks,desc'],
      ...(filters ? { filters } : {}),
    },
  ]);
  const task = assertOk(response, { path });
  return {
    data: {
      items: parseTaskItems('domain-pages-summary-live', task, domainPageSummaryItemSchema),
      totalCount: parseTaskTotalCount(task),
    },
    billing: buildTaskBilling(task),
  };
}

export async function fetchBacklinksHistory(
  transport: DataforseoTransport,
  input: BacklinksTimeseriesRequest,
): Promise<DataforseoApiResponse<BacklinksHistoryItem[]>> {
  const path = '/v3/backlinks/history/live';
  const response = await transport.post(path, [
    {
      target: input.target,
      date_from: input.dateFrom,
      date_to: input.dateTo,
      rank_scale: 'one_hundred',
    },
  ]);
  const task = assertOk(response, { path });
  return {
    data: parseTaskItems('backlinks-history-live', task, backlinksHistoryItemSchema),
    billing: buildTaskBilling(task),
  };
}

// ---------------------------------------------------------------------------
// Target normalization
// ---------------------------------------------------------------------------

export interface NormalizedBacklinkTarget {
  apiTarget: string;
  displayTarget: string;
  scope: ResearchScope;
  /** DataForSEO `include_subdomains`; ignored by the API for page targets. */
  includeSubdomains: boolean;
  /**
   * Subfolder scope only: the normalized path driving the url_to/url prefix
   * filters (the API itself has no prefix targeting). `""` for other scopes.
   */
  path: string;
}

const QUERY_OR_FRAGMENT_RE = /[?#]/;
const HTTP_SCHEME_RE = /^http:\/\//i;

/**
 * Backlinks-flavored wrapper over the shared research-target parser. The
 * backlinks-specific rules: an exact-URL target is sent as an absolute URL
 * (preserving an explicit http:// scheme, since url matching is exact) and
 * rejects query strings/fragments instead of silently stripping them.
 */
export function normalizeBacklinksTarget(
  input: string,
  options: { scope?: BacklinksScopeWithLegacy } = {},
): NormalizedBacklinkTarget {
  const trimmed = input.trim();
  const requestedScope = options.scope ? resolveBacklinksScope(options.scope) : undefined;

  const parsed = parseResearchTarget(trimmed, requestedScope);
  if (!parsed.ok) {
    throw new DataForSeoError(parsed.message, { kind: 'validation', path: '' });
  }
  const target = parsed.target;

  if (target.scope !== 'exact_url') {
    return {
      apiTarget: target.hostname,
      displayTarget: target.scope === 'subfolder' ? target.display : target.hostname,
      scope: target.scope,
      includeSubdomains: target.scope === 'subdomains',
      path: target.scope === 'subfolder' ? target.path : '',
    };
  }

  // Query strings and fragments would target a different page than the one
  // the user sees, so a page lookup rejects them rather than dropping them.
  if (QUERY_OR_FRAGMENT_RE.test(trimmed)) {
    throw new DataForSeoError('Page URLs with query strings or fragments are not supported', {
      kind: 'validation',
      path: '',
    });
  }

  const protocol = HTTP_SCHEME_RE.test(trimmed) ? 'http' : 'https';
  const pageUrl = `${protocol}://${target.urlHostname}${target.path || '/'}`;
  return {
    apiTarget: pageUrl,
    displayTarget: pageUrl,
    scope: 'exact_url',
    // Irrelevant for a page target; kept true so the payload is unchanged.
    includeSubdomains: true,
    path: '',
  };
}
