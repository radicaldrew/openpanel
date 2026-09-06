import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc/react';
import type { RouterOutputs } from '@/trpc/client';

export type SeoStatus = RouterOutputs['seo']['settings']['getStatus'];
export type SeoProjectConfig = NonNullable<SeoStatus['config']>;

/**
 * One shared query for everything SEO-related on the page. Every tab's gate
 * and the settings tab read the same cache entry, keyed by projectId, so the
 * status is fetched once per project rather than once per consumer.
 */
export function useSeoStatus(projectId: string) {
  const trpc = useTRPC();
  return useQuery(
    trpc.seo.settings.getStatus.queryOptions(
      { projectId },
      { staleTime: 30_000 }
    )
  );
}

export function useInvalidateSeoStatus() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries(trpc.seo.settings.getStatus.pathFilter());
}

/**
 * GSC stores properties as `sc-domain:example.com` or `https://example.com/`.
 * Reduce either to the bare host DataForSEO expects.
 */
export function domainFromSiteUrl(siteUrl: string | null | undefined): string {
  if (!siteUrl) {
    return '';
  }
  const withoutPrefix = siteUrl.replace(/^sc-domain:/, '');
  try {
    const url = new URL(
      /^https?:\/\//.test(withoutPrefix)
        ? withoutPrefix
        : `https://${withoutPrefix}`
    );
    return url.hostname.replace(/^www\./, '');
  } catch {
    return withoutPrefix.replace(/^www\./, '').replace(/\/.*$/, '');
  }
}
