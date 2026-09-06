import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { formatDistanceToNow } from 'date-fns';
import { PlayIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { FullPageEmptyState } from '@/components/full-page-empty-state';
import {
  AuditProgress,
  AuditStatusBadge,
  formatUsd,
  isAuditActive,
  type SeoAuditListItem,
  scoreClass,
} from '@/components/seo/audit/audit-status';
import { RunAuditDialog } from '@/components/seo/audit/run-audit-dialog';
import { SeoGate } from '@/components/seo/seo-gate';
import { useSeoStatus } from '@/components/seo/use-seo-status';
import { Skeleton } from '@/components/skeleton';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useAppParams } from '@/hooks/use-app-params';
import { handleError, useTRPC } from '@/integrations/trpc/react';
import { showConfirm } from '@/modals';
import { cn } from '@/utils/cn';

export const Route = createFileRoute(
  '/_app/$organizationId/$projectId/seo/_tabs/audit'
)({
  component: Component,
});

const ACTIVE_POLL_MS = 10_000;

function Component() {
  return (
    <SeoGate requires={['dfs']}>
      <AuditTab />
    </SeoGate>
  );
}

function AuditTab() {
  const { projectId, organizationId } = useAppParams();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const statusQuery = useSeoStatus(projectId);
  const domain = statusQuery.data?.config?.domain ?? '';
  const [dialogOpen, setDialogOpen] = useState(false);

  const listQuery = useQuery(
    trpc.seo.audit.list.queryOptions(
      { projectId },
      {
        refetchInterval: (query) =>
          query.state.data?.audits.some((audit) => isAuditActive(audit.status))
            ? ACTIVE_POLL_MS
            : false,
      }
    )
  );

  const cancel = useMutation(
    trpc.seo.audit.cancel.mutationOptions({
      onError: handleError,
      onSuccess: () => {
        toast.success('Audit cancelled');
        queryClient.invalidateQueries(trpc.seo.audit.list.pathFilter());
      },
    })
  );

  const audits = listQuery.data?.audits ?? [];
  const defaults = listQuery.data?.defaults;
  const active = audits.find((audit) => isAuditActive(audit.status));

  const openAudit = (audit: SeoAuditListItem) =>
    navigate({
      to: '/$organizationId/$projectId/seo/audit/$auditId',
      params: { organizationId, projectId, auditId: audit.id },
    });

  const confirmCancel = (audit: SeoAuditListItem) =>
    showConfirm({
      title: 'Cancel this audit?',
      text: 'The crawl already posted to DataForSEO cannot be refunded; pages crawled so far are discarded.',
      onConfirm: () => cancel.mutate({ projectId, auditId: audit.id }),
    });

  if (listQuery.isError) {
    return (
      <FullPageEmptyState
        className="pt-[10vh]"
        description={listQuery.error.message}
        title="Could not load audits"
      >
        <Button onClick={() => listQuery.refetch()} variant="outline">
          Retry
        </Button>
      </FullPageEmptyState>
    );
  }

  if (listQuery.isLoading || !defaults) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="text-muted-foreground text-sm">
          Technical audits of <span className="font-mono">{domain}</span> via DataForSEO On-Page.
        </p>
        <Button disabled={!!active} onClick={() => setDialogOpen(true)}>
          <PlayIcon className="mr-2 h-4 w-4" />
          Run audit
        </Button>
      </div>

      {audits.length === 0 ? (
        <FullPageEmptyState
          className="pt-[8vh]"
          description="Crawl your site to find broken links, missing titles, duplicate content, slow pages and more. Each audit is a snapshot you can compare over time."
          title="No audits yet"
        >
          <Button onClick={() => setDialogOpen(true)}>
            <PlayIcon className="mr-2 h-4 w-4" />
            Run your first audit
          </Button>
        </FullPageEmptyState>
      ) : (
        <div className="card overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Started</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Pages</TableHead>
                <TableHead className="w-20 text-right">Score</TableHead>
                <TableHead className="w-24 text-right">Cost</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {audits.map((audit) => {
                const isActive = isAuditActive(audit.status);
                const isCompleted = audit.status === 'completed';
                return (
                  <TableRow
                    className={cn(isCompleted && 'cursor-pointer')}
                    key={audit.id}
                    onClick={() => isCompleted && openAudit(audit)}
                  >
                    <TableCell>
                      <div className="text-sm">
                        {formatDistanceToNow(new Date(audit.startedAt), { addSuffix: true })}
                      </div>
                      <div className="text-muted-foreground text-xs">
                        {new Date(audit.startedAt).toLocaleString()}
                        {audit.enableJavascript ? ' · JS rendered' : ''}
                      </div>
                    </TableCell>
                    <TableCell>
                      <AuditStatusBadge audit={audit} />
                      {audit.status === 'failed' && audit.error && audit.error !== 'cancelled' && (
                        <div
                          className="mt-1 max-w-xs truncate font-mono text-muted-foreground text-xs"
                          title={audit.error}
                        >
                          {audit.error}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      {isActive ? (
                        <AuditProgress audit={audit} />
                      ) : (
                        <span className="font-mono text-xs tabular-nums">
                          {audit.pagesCrawled.toLocaleString()}
                        </span>
                      )}
                    </TableCell>
                    <TableCell
                      className={cn(
                        'text-right font-mono font-semibold text-sm tabular-nums',
                        scoreClass(audit.score)
                      )}
                    >
                      {audit.score ?? '–'}
                    </TableCell>
                    <TableCell className="text-right font-mono text-muted-foreground text-xs tabular-nums">
                      {audit.costUsd > 0 ? formatUsd(audit.costUsd) : '–'}
                    </TableCell>
                    <TableCell className="text-right">
                      {isActive && (
                        <Button
                          disabled={cancel.isPending}
                          onClick={(event) => {
                            event.stopPropagation();
                            confirmCancel(audit);
                          }}
                          size="sm"
                          variant="ghost"
                        >
                          <XIcon className="mr-1 h-3.5 w-3.5" />
                          Cancel
                        </Button>
                      )}
                      {isCompleted && (
                        <Button
                          onClick={(event) => {
                            event.stopPropagation();
                            openAudit(audit);
                          }}
                          size="sm"
                          variant="outline"
                        >
                          View
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <RunAuditDialog
        defaults={defaults}
        disabledReason={active ? 'An audit is already running for this project.' : null}
        domain={domain}
        key={defaults.maxPages}
        onOpenChange={setDialogOpen}
        open={dialogOpen}
        projectId={projectId}
      />
    </div>
  );
}
