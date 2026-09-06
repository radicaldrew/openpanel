import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc/react';
import type { RouterOutputs } from '@/trpc/client';

export type TrackingList = RouterOutputs['seo']['tracking']['list'];
export type TrackingRow = TrackingList['rows'][number];
export type TrackingDeviceCell = NonNullable<TrackingRow['desktop']>;
export type TrackingSummary = TrackingList['summary'];
export type RankRun = RouterOutputs['seo']['tracking']['runs'][number];
export type RankHistoryPoint =
  RouterOutputs['seo']['tracking']['history'][number];
export type ShareOfVoice = RouterOutputs['seo']['tracking']['competitors'];

export interface TrackingFilters {
  tag?: string;
  search?: string;
  includeInactive?: boolean;
}

/** While a run is in flight the list is refetched at this cadence. */
const ACTIVE_RUN_POLL_MS = 5000;

export function useTrackingList(projectId: string, filters: TrackingFilters) {
  const trpc = useTRPC();
  return useQuery(
    trpc.seo.tracking.list.queryOptions(
      { projectId, ...filters },
      {
        refetchInterval: (query) =>
          query.state.data?.summary.activeRun ? ACTIVE_RUN_POLL_MS : false,
      }
    )
  );
}

export function useInvalidateTracking() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries(trpc.seo.tracking.list.pathFilter());
    queryClient.invalidateQueries(trpc.seo.tracking.runs.pathFilter());
  };
}

export function formatPosition(position: number | null | undefined): string {
  return position === null || position === undefined ? '—' : `#${position}`;
}

/** DFS feature keys read badly raw; map the common ones, prettify the rest. */
const FEATURE_LABELS: Record<string, string> = {
  organic: 'Organic',
  paid: 'Ads',
  featured_snippet: 'Featured snippet',
  people_also_ask: 'People also ask',
  video: 'Video',
  images: 'Images',
  local_pack: 'Local pack',
  knowledge_graph: 'Knowledge panel',
  shopping: 'Shopping',
  top_stories: 'Top stories',
  ai_overview: 'AI overview',
  related_searches: 'Related searches',
  answer_box: 'Answer box',
  carousel: 'Carousel',
  twitter: 'X posts',
  people_also_search: 'People also search',
};

export function featureLabel(feature: string): string {
  return (
    FEATURE_LABELS[feature] ??
    feature.replace(/_/g, ' ').replace(/^\w/, (char) => char.toUpperCase())
  );
}

/** Features that are not the plain organic list, the ones worth showing. */
export function notableFeatures(features: string[]): string[] {
  return features.filter((feature) => feature !== 'organic');
}
