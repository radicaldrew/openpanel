import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { handleError, useTRPC } from '@/integrations/trpc/react';

type TrackSource = 'manual' | 'gsc' | 'research';

/**
 * "Track selected" / per-row "Track" → seo.tracking.add
 * ({ projectId, keywords, tags?, source? } → { added, existing, keywords }).
 */
export function useTrackKeywords(projectId: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const mutation = useMutation(
    trpc.seo.tracking.add.mutationOptions({
      onError: handleError,
      onSuccess: (result) => {
        const added = result.added.length;
        const existing = result.existing.length;
        toast.success(
          added === 1 ? 'Tracking 1 keyword' : `Tracking ${added} keywords`,
          {
            description:
              existing > 0
                ? `${existing} already tracked`
                : 'Rankings will appear after the next check.',
          }
        );
        queryClient.invalidateQueries(trpc.seo.tracking.pathFilter());
      },
    })
  );

  return {
    track: (keywords: string[], source: TrackSource) =>
      mutation.mutate({ projectId, keywords, source }),
    isPending: mutation.isPending,
  };
}
