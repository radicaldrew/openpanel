import { useMutation } from '@tanstack/react-query';
import {
  Loader2Icon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  TagIcon,
  Trash2Icon,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { useSeoStatus } from '../use-seo-status';
import { AddKeywordsDialog, parseTagInput } from './add-keywords-dialog';
import { CompetitorsView } from './competitors-view';
import { RankHistorySheet } from './rank-history-sheet';
import { RankingsEmptyState } from './rankings-empty-state';
import { RankingsSummaryCards } from './rankings-summary-cards';
import { RankingsTable } from './rankings-table';
import {
  type TrackingRow,
  useInvalidateTracking,
  useTrackingList,
} from './use-tracking';
import { Skeleton } from '@/components/skeleton';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAppParams } from '@/hooks/use-app-params';
import { handleError, useTRPC } from '@/integrations/trpc/react';

type View = 'keywords' | 'competitors';

const RUN_REFUSALS: Record<string, string> = {
  already_running: 'A check is already in progress for this project.',
  no_keywords: 'There are no active keywords to check.',
  spend_cap:
    'The monthly DataForSEO spend cap has been reached. Raise it under Settings → DataForSEO.',
};

function BulkActions({
  projectId,
  selectedIds,
  anyPaused,
  onDone,
}: {
  projectId: string;
  selectedIds: Set<string>;
  anyPaused: boolean;
  onDone: () => void;
}) {
  const trpc = useTRPC();
  const invalidate = useInvalidateTracking();
  const [tagsOpen, setTagsOpen] = useState(false);
  const [tagsInput, setTagsInput] = useState('');
  const ids = [...selectedIds];

  const finish = (message: string) => {
    invalidate();
    onDone();
    toast.success(message);
  };

  const remove = useMutation(
    trpc.seo.tracking.remove.mutationOptions({
      onError: handleError,
      onSuccess: (result) => finish(`Removed ${result.removed} keyword(s)`),
    })
  );
  const setActive = useMutation(
    trpc.seo.tracking.setActive.mutationOptions({
      onError: handleError,
      onSuccess: (result, input) =>
        finish(`${input.isActive ? 'Resumed' : 'Paused'} ${result.updated} keyword(s)`),
    })
  );
  const applyTags = useMutation(
    trpc.seo.tracking.setTags.mutationOptions({
      onError: handleError,
      onSuccess: (result) => {
        setTagsOpen(false);
        setTagsInput('');
        finish(`Tagged ${result.updated} keyword(s)`);
      },
    })
  );

  const pending = remove.isPending || setActive.isPending || applyTags.isPending;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-muted-foreground text-sm">{ids.length} selected</span>
      <Button
        disabled={pending}
        onClick={() => setActive.mutate({ projectId, ids, isActive: anyPaused })}
        size="sm"
        variant="outline"
      >
        {anyPaused ? (
          <PlayIcon className="mr-2 size-3.5" />
        ) : (
          <PauseIcon className="mr-2 size-3.5" />
        )}
        {anyPaused ? 'Resume' : 'Pause'}
      </Button>
      <Button disabled={pending} onClick={() => setTagsOpen(true)} size="sm" variant="outline">
        <TagIcon className="mr-2 size-3.5" />
        Set tags
      </Button>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button disabled={pending} size="sm" variant="outline">
            <Trash2Icon className="mr-2 size-3.5" />
            Remove
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop tracking {ids.length} keyword(s)?</AlertDialogTitle>
            <AlertDialogDescription>
              Collected positions are kept; the keywords just stop being
              checked and drop off this list.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => remove.mutate({ projectId, ids })}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog onOpenChange={setTagsOpen} open={tagsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Set tags</DialogTitle>
            <DialogDescription>
              Replaces the tags on the {ids.length} selected keyword(s).
              Comma-separated; leave empty to clear.
            </DialogDescription>
          </DialogHeader>
          <div className="col gap-1.5">
            <Label htmlFor="seo-bulk-tags">Tags</Label>
            <Input
              id="seo-bulk-tags"
              onChange={(event) => setTagsInput(event.target.value)}
              placeholder="brand, blog"
              value={tagsInput}
            />
          </div>
          <DialogFooter>
            <Button onClick={() => setTagsOpen(false)} variant="outline">
              Cancel
            </Button>
            <Button
              disabled={applyTags.isPending}
              onClick={() =>
                applyTags.mutate({ projectId, ids, tags: parseTagInput(tagsInput) })
              }
            >
              {applyTags.isPending && <Loader2Icon className="mr-2 size-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function RankingsTab() {
  const { projectId } = useAppParams();
  const trpc = useTRPC();
  const invalidate = useInvalidateTracking();
  const statusQuery = useSeoStatus(projectId);

  const [view, setView] = useState<View>('keywords');
  const [search, setSearch] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [deltaWindow, setDeltaWindow] = useState<'7d' | '30d'>('7d');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [addOpen, setAddOpen] = useState(false);
  const [historyRow, setHistoryRow] = useState<TrackingRow | null>(null);

  const listQuery = useTrackingList(projectId, {
    search: search || undefined,
    tag: tag ?? undefined,
    includeInactive: true,
  });

  const runNow = useMutation(
    trpc.seo.tracking.runNow.mutationOptions({
      onError: handleError,
      onSuccess: (result) => {
        invalidate();
        if (result.ok) {
          toast.success('Rank check started', {
            description: `Checking ${result.run.keywordsTotal} keyword(s).`,
          });
          return;
        }
        toast('Could not start a check', {
          description: RUN_REFUSALS[result.reason] ?? result.reason,
        });
      },
    })
  );

  const data = listQuery.data;
  const isFiltered = search !== '' || tag !== null;

  if (listQuery.isLoading || !data) {
    if (listQuery.isError) {
      return (
        <div className="text-destructive text-sm">{listQuery.error.message}</div>
      );
    }
    return (
      <div className="space-y-4">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (data.summary.total === 0 && !isFiltered) {
    return (
      <RankingsEmptyState
        gscConnected={statusQuery.data?.gsc.connected ?? false}
        projectId={projectId}
      />
    );
  }

  const selectedRows = data.rows.filter((row) => selectedIds.has(row.id));
  const anyPaused = selectedRows.some((row) => !row.isActive);

  return (
    <div className="col gap-6">
      <RankingsSummaryCards
        isStarting={runNow.isPending}
        onCheckNow={() => runNow.mutate({ projectId })}
        summary={data.summary}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs onValueChange={(value) => setView(value as View)} value={view}>
          <TabsList>
            <TabsTrigger value="keywords">Keywords</TabsTrigger>
            <TabsTrigger value="competitors">Competitors</TabsTrigger>
          </TabsList>
        </Tabs>
        {view === 'keywords' && (
          <div className="flex flex-wrap items-center gap-2">
            {selectedIds.size > 0 && (
              <BulkActions
                anyPaused={anyPaused}
                onDone={() => setSelectedIds(new Set())}
                projectId={projectId}
                selectedIds={selectedIds}
              />
            )}
            <Button onClick={() => setAddOpen(true)} size="sm">
              <PlusIcon className="mr-2 size-4" />
              Add keywords
            </Button>
          </div>
        )}
      </div>

      {view === 'keywords' ? (
        <RankingsTable
          activeTag={tag}
          data={data}
          deltaWindow={deltaWindow}
          onDeltaWindowChange={setDeltaWindow}
          onRowClick={setHistoryRow}
          onSearchChange={setSearch}
          onSelectionChange={setSelectedIds}
          onTagChange={setTag}
          search={search}
          selectedIds={selectedIds}
        />
      ) : (
        <CompetitorsView competitors={statusQuery.data?.config?.competitors ?? []} />
      )}

      <AddKeywordsDialog onOpenChange={setAddOpen} open={addOpen} projectId={projectId} />
      <RankHistorySheet
        devices={data.devices}
        onClose={() => setHistoryRow(null)}
        projectId={projectId}
        row={historyRow}
      />
    </div>
  );
}
