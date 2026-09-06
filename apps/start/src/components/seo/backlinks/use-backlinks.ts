import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc/react';
import type { RouterInputs, RouterOutputs } from '@/trpc/client';

export type BacklinkOverview = RouterOutputs['seo']['backlinks']['summary'];
export type BacklinkHistory = RouterOutputs['seo']['backlinks']['history'];
export type BacklinkHistoryPoint = BacklinkHistory['points'][number];
export type BacklinkListPage = RouterOutputs['seo']['backlinks']['list'];
export type BacklinkRow = BacklinkListPage['rows'][number];
export type ReferringDomainsPage = RouterOutputs['seo']['backlinks']['referringDomains'];
export type ReferringDomainRow = ReferringDomainsPage['rows'][number];
export type BacklinkPagesPage = RouterOutputs['seo']['backlinks']['pages'];
export type BacklinkPageRow = BacklinkPagesPage['rows'][number];

export type BacklinkFilters = NonNullable<RouterInputs['seo']['backlinks']['list']['filters']>;
export type BacklinkStatusFilter = NonNullable<BacklinkFilters['status']>;
export type BacklinkRowsSort = NonNullable<RouterInputs['seo']['backlinks']['list']['sort']>;
export type ReferringDomainsSort = NonNullable<
  RouterInputs['seo']['backlinks']['referringDomains']['sort']
>;
export type BacklinkPagesSort = NonNullable<RouterInputs['seo']['backlinks']['pages']['sort']>;
export type BacklinkSortOrder = NonNullable<RouterInputs['seo']['backlinks']['list']['order']>;

/** DFS lists and the stored snapshot rarely change within a session. */
export const BACKLINKS_STALE_TIME_MS = 5 * 60 * 1000;
/** After "Snapshot now" the summary is refetched at this cadence until it lands. */
const SNAPSHOT_POLL_MS = 5000;

export function useBacklinkSummary(projectId: string, target: string | undefined) {
  const trpc = useTRPC();
  return useQuery(
    trpc.seo.backlinks.summary.queryOptions(
      { projectId, target },
      {
        staleTime: BACKLINKS_STALE_TIME_MS,
        refetchInterval: (query) =>
          query.state.data?.snapshotPending ? SNAPSHOT_POLL_MS : false,
      }
    )
  );
}

export function useInvalidateBacklinks() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries(trpc.seo.backlinks.summary.pathFilter());
    queryClient.invalidateQueries(trpc.seo.backlinks.history.pathFilter());
  };
}

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return '—';
  }
  return value.toLocaleString();
}

/** DataForSEO dates arrive as "2026-09-06 10:00:00 +00:00"; keep the day. */
export function formatDfsDate(value: string | null | undefined): string {
  if (!value) {
    return '—';
  }
  return value.slice(0, 10);
}

export function spamScoreClass(score: number | null | undefined): string {
  if (score === null || score === undefined) {
    return 'text-muted-foreground';
  }
  if (score >= 60) {
    return 'text-red-600 dark:text-red-400';
  }
  if (score >= 30) {
    return 'text-amber-600 dark:text-amber-400';
  }
  return 'text-emerald-600 dark:text-emerald-400';
}
