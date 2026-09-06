import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowLeftIcon } from 'lucide-react';
import { useState } from 'react';
import { FullPageEmptyState } from '@/components/full-page-empty-state';
import { PageContainer } from '@/components/page-container';
import { PageHeader } from '@/components/page-header';
import { AuditIssueList } from '@/components/seo/audit/audit-issue-list';
import { AuditPageSheet } from '@/components/seo/audit/audit-page-sheet';
import { AuditPagesTable, type PageSort } from '@/components/seo/audit/audit-pages-table';
import { AuditScoreGauge } from '@/components/seo/audit/audit-score-gauge';
import {
  AuditProgress,
  AuditStatusBadge,
  formatUsd,
  isAuditActive,
  SEVERITY_CLASS,
  SEVERITY_LABEL,
  type SeoAuditSeverity,
} from '@/components/seo/audit/audit-status';
import { Skeleton } from '@/components/skeleton';
import { Button } from '@/components/ui/button';
import { useTRPC } from '@/integrations/trpc/react';
import { cn } from '@/utils/cn';
import { createProjectTitle } from '@/utils/title';

export const Route = createFileRoute(
  '/_app/$organizationId/$projectId/seo_/audit/$auditId'
)({
  component: AuditDetail,
  head: () => ({ meta: [{ title: createProjectTitle('Site audit') }] }),
});

const SEVERITIES: SeoAuditSeverity[] = ['critical', 'warning', 'info'];
const ACTIVE_POLL_MS = 10_000;
const PAGE_SIZE = 50;

function AuditDetail() {
  const { organizationId, projectId, auditId } = Route.useParams();
  const trpc = useTRPC();
  const [selectedIssue, setSelectedIssue] = useState<string | null>(null);
  const [sort, setSort] = useState<PageSort>('score_asc');
  const [pageUrl, setPageUrl] = useState<string | null>(null);

  const auditQuery = useQuery(
    trpc.seo.audit.get.queryOptions(
      { projectId, auditId },
      {
        refetchInterval: (query) =>
          query.state.data && isAuditActive(query.state.data.audit.status)
            ? ACTIVE_POLL_MS
            : false,
      }
    )
  );
  const audit = auditQuery.data?.audit;
  const issues = auditQuery.data?.issues;
  const isCompleted = audit?.status === 'completed';

  const pagesQuery = useInfiniteQuery(
    trpc.seo.audit.pages.infiniteQueryOptions(
      { projectId, auditId, issue: selectedIssue ?? undefined, sort, limit: PAGE_SIZE },
      {
        enabled: isCompleted,
        initialCursor: null,
        getNextPageParam: (last) => last.nextCursor,
      }
    )
  );
  const pages = pagesQuery.data?.pages.flatMap((page) => page.pages) ?? [];
  const total = pagesQuery.data?.pages[0]?.total ?? 0;
  const filterLabel =
    selectedIssue === null
      ? null
      : (issues?.issues.find((issue) => issue.key === selectedIssue)?.label ?? selectedIssue);

  const backLink = (
    <Button asChild size="sm" variant="ghost">
      <Link params={{ organizationId, projectId }} to="/$organizationId/$projectId/seo/audit">
        <ArrowLeftIcon className="mr-2 h-4 w-4" />
        All audits
      </Link>
    </Button>
  );

  if (auditQuery.isLoading) {
    return (
      <PageContainer>
        {backLink}
        <div className="mt-4 space-y-4">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-96 w-full" />
        </div>
      </PageContainer>
    );
  }

  if (!audit) {
    return (
      <PageContainer>
        {backLink}
        <FullPageEmptyState
          className="pt-[10vh]"
          description={auditQuery.error?.message ?? 'This audit does not exist or belongs to another project.'}
          title="Audit not found"
        />
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      {backLink}
      <PageHeader
        className="mt-2"
        description={`Started ${new Date(audit.startedAt).toLocaleString()} · up to ${audit.maxPages.toLocaleString()} pages${audit.enableJavascript ? ' · JS rendered' : ''}${audit.costUsd > 0 ? ` · ${formatUsd(audit.costUsd)}` : ''}`}
        title="Site audit"
      />

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-[auto_1fr]">
        <div className="card flex items-center gap-6 p-6">
          <AuditScoreGauge score={audit.score} />
          <div className="space-y-2">
            <AuditStatusBadge audit={audit} />
            {isAuditActive(audit.status) ? (
              <AuditProgress audit={audit} />
            ) : (
              <div className="text-muted-foreground text-sm">
                {audit.pagesCrawled.toLocaleString()} pages crawled
              </div>
            )}
            {audit.error && audit.error !== 'cancelled' && (
              <div className="max-w-xs break-words font-mono text-destructive text-xs">
                {audit.error}
              </div>
            )}
          </div>
        </div>
        <div className="grid grid-cols-3 gap-4">
          {SEVERITIES.map((severity) => (
            <div className="card flex flex-col justify-center p-4" key={severity}>
              <div className={cn('font-mono font-semibold text-2xl tabular-nums', SEVERITY_CLASS[severity])}>
                {(issues?.totals[severity] ?? 0).toLocaleString()}
              </div>
              <div className="text-muted-foreground text-xs">{SEVERITY_LABEL[severity]}</div>
            </div>
          ))}
        </div>
      </div>

      {isCompleted && issues ? (
        <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
          <AuditIssueList
            onSelectIssue={setSelectedIssue}
            selectedIssue={selectedIssue}
            summary={issues}
          />
          <AuditPagesTable
            filterLabel={filterLabel}
            hasMore={pagesQuery.hasNextPage}
            isFetchingMore={pagesQuery.isFetchingNextPage}
            isLoading={pagesQuery.isLoading}
            onLoadMore={() => pagesQuery.fetchNextPage()}
            onRowClick={setPageUrl}
            onSortChange={setSort}
            pages={pages}
            sort={sort}
            total={total}
          />
        </div>
      ) : (
        <div className="card mt-6 p-8 text-center text-muted-foreground text-sm">
          {isAuditActive(audit.status)
            ? 'Issues and pages appear here once the crawl finishes. This page refreshes automatically.'
            : 'This audit did not complete, so there are no pages to show.'}
        </div>
      )}

      <AuditPageSheet
        auditId={auditId}
        onClose={() => setPageUrl(null)}
        projectId={projectId}
        url={pageUrl}
      />
    </PageContainer>
  );
}
