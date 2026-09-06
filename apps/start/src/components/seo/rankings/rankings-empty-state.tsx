import { useMutation } from '@tanstack/react-query';
import { DownloadIcon, Loader2Icon, PlusIcon, TrendingUpIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { AddKeywordsDialog } from './add-keywords-dialog';
import { useInvalidateTracking } from './use-tracking';
import { FullPageEmptyState } from '@/components/full-page-empty-state';
import { Button } from '@/components/ui/button';
import { Tooltiper } from '@/components/ui/tooltip';
import { handleError, useTRPC } from '@/integrations/trpc/react';

interface Props {
  projectId: string;
  gscConnected: boolean;
}

export function RankingsEmptyState({ projectId, gscConnected }: Props) {
  const trpc = useTRPC();
  const invalidate = useInvalidateTracking();
  const [addOpen, setAddOpen] = useState(false);

  const importFromGsc = useMutation(
    trpc.seo.tracking.addFromGsc.mutationOptions({
      onError: handleError,
      onSuccess: (result) => {
        invalidate();
        if (result.added.length === 0) {
          toast('Nothing to import', {
            description:
              'No Search Console queries with enough impressions in the last 28 days.',
          });
          return;
        }
        toast.success(`Imported ${result.added.length} queries from Search Console`);
      },
    })
  );

  return (
    <>
      <FullPageEmptyState
        className="pt-[10vh]"
        description="Track where your site ranks for the searches that matter. Add keywords by hand or seed the list from your top Search Console queries."
        icon={TrendingUpIcon}
        title="No keywords tracked yet"
      >
        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={() => setAddOpen(true)}>
            <PlusIcon className="mr-2 size-4" />
            Add keywords
          </Button>
          <Tooltiper
            content="Connect Google Search Console to import your top queries"
            disabled={gscConnected}
          >
            <Button
              disabled={!gscConnected || importFromGsc.isPending}
              onClick={() => importFromGsc.mutate({ projectId, limit: 50 })}
              variant="outline"
            >
              {importFromGsc.isPending ? (
                <Loader2Icon className="mr-2 size-4 animate-spin" />
              ) : (
                <DownloadIcon className="mr-2 size-4" />
              )}
              Import top queries from Search Console
            </Button>
          </Tooltiper>
        </div>
      </FullPageEmptyState>
      <AddKeywordsDialog
        onOpenChange={setAddOpen}
        open={addOpen}
        projectId={projectId}
      />
    </>
  );
}
