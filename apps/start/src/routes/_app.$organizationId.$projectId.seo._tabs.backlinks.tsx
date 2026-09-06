import { useMutation, useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { OverviewRange } from '@/components/overview/overview-range';
import { useOverviewOptions } from '@/components/overview/useOverviewOptions';
import { BacklinksHistoryChart } from '@/components/seo/backlinks/backlinks-history-chart';
import { BacklinksSummaryCards } from '@/components/seo/backlinks/backlinks-summary-cards';
import { BacklinksTables } from '@/components/seo/backlinks/backlinks-tables';
import {
  BACKLINKS_STALE_TIME_MS,
  useBacklinkSummary,
  useInvalidateBacklinks,
} from '@/components/seo/backlinks/use-backlinks';
import { SeoGate } from '@/components/seo/seo-gate';
import { useSeoStatus } from '@/components/seo/use-seo-status';
import { Skeleton } from '@/components/skeleton';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAppParams } from '@/hooks/use-app-params';
import { handleError, useTRPC } from '@/integrations/trpc/react';

export const Route = createFileRoute(
  '/_app/$organizationId/$projectId/seo/_tabs/backlinks'
)({
  component: Component,
});

function Component() {
  return (
    <SeoGate requires={['dfs']}>
      <BacklinksTab />
    </SeoGate>
  );
}

const SNAPSHOT_REFUSALS: Record<'already_queued' | 'spend_cap' | 'no_domain', string> = {
  already_queued: 'A snapshot is already queued for this project.',
  spend_cap: 'The monthly DataForSEO spend cap is reached. Raise it under Settings → DataForSEO.',
  no_domain: 'Set a domain for this project first.',
};

function BacklinksTab() {
  const { projectId } = useAppParams();
  const trpc = useTRPC();
  const statusQuery = useSeoStatus(projectId);
  const ownDomain = statusQuery.data?.config?.domain ?? '';
  const domains = useMemo(
    () => [ownDomain, ...(statusQuery.data?.config?.competitors ?? [])].filter(Boolean),
    [ownDomain, statusQuery.data?.config?.competitors]
  );

  const [selected, setSelected] = useState<string>('');
  const targetDomain = selected || ownDomain;
  const isOwnDomain = targetDomain === ownDomain;
  // The server treats "no target" as the own domain; only send competitors.
  const target = isOwnDomain ? undefined : targetDomain;

  const { range, startDate, endDate } = useOverviewOptions();

  const summaryQuery = useBacklinkSummary(projectId, target);
  const historyQuery = useQuery(
    trpc.seo.backlinks.history.queryOptions(
      { projectId, target, range, startDate, endDate },
      { staleTime: BACKLINKS_STALE_TIME_MS }
    )
  );

  const invalidate = useInvalidateBacklinks();
  const snapshotNow = useMutation(
    trpc.seo.backlinks.snapshotNow.mutationOptions({
      onError: handleError,
      onSuccess: (result) => {
        if (result.ok) {
          toast.success('Snapshot queued', {
            description: 'Cards and chart update when it lands, usually within a minute.',
          });
        } else {
          toast(SNAPSHOT_REFUSALS[result.reason]);
        }
        invalidate();
      },
    })
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <p className="text-muted-foreground text-sm">Backlinks for</p>
          {domains.length > 1 ? (
            <Select onValueChange={setSelected} value={targetDomain}>
              <SelectTrigger className="w-[260px]">
                <SelectValue placeholder="Domain" />
              </SelectTrigger>
              <SelectContent>
                {domains.map((domain, index) => (
                  <SelectItem key={domain} value={domain}>
                    {domain}
                    {index === 0 ? ' (you)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <span className="font-mono text-sm">{ownDomain}</span>
          )}
        </div>
        <OverviewRange />
      </div>

      {summaryQuery.data ? (
        <BacklinksSummaryCards
          canSnapshot={isOwnDomain}
          isStarting={snapshotNow.isPending}
          onSnapshotNow={() => snapshotNow.mutate({ projectId })}
          overview={summaryQuery.data}
        />
      ) : summaryQuery.isError ? (
        <div className="card flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="col gap-1">
            <span className="font-medium text-sm">Could not load backlink summary</span>
            <span className="text-muted-foreground text-sm">{summaryQuery.error.message}</span>
          </div>
          <Button onClick={() => summaryQuery.refetch()} size="sm" variant="outline">
            Retry
          </Button>
        </div>
      ) : (
        <Skeleton className="h-24 w-full" />
      )}

      <BacklinksHistoryChart
        isLoading={historyQuery.isLoading}
        isOwnDomain={isOwnDomain}
        points={historyQuery.data?.points ?? []}
      />

      <BacklinksTables projectId={projectId} target={target} targetDomain={targetDomain} />
    </div>
  );
}
