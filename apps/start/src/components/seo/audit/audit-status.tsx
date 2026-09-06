import { Loader2Icon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import type { RouterOutputs } from '@/trpc/client';

export type SeoAuditListItem =
  RouterOutputs['seo']['audit']['list']['audits'][number];
export type SeoAuditIssueSummary = RouterOutputs['seo']['audit']['issues'];
export type SeoAuditIssueCount = SeoAuditIssueSummary['issues'][number];
export type SeoAuditPageRow = RouterOutputs['seo']['audit']['pages']['pages'][number];
export type SeoAuditSeverity = SeoAuditIssueCount['severity'];

export const SEVERITY_LABEL: Record<SeoAuditSeverity, string> = {
  critical: 'Critical',
  warning: 'Warnings',
  info: 'Notices',
};

export const SEVERITY_CLASS: Record<SeoAuditSeverity, string> = {
  critical: 'text-red-600 dark:text-red-400',
  warning: 'text-amber-600 dark:text-amber-400',
  info: 'text-sky-600 dark:text-sky-400',
};

export const SEVERITY_BADGE: Record<
  SeoAuditSeverity,
  'destructive' | 'secondary' | 'outline'
> = {
  critical: 'destructive',
  warning: 'secondary',
  info: 'outline',
};

export function isAuditActive(status: SeoAuditListItem['status']): boolean {
  return status === 'queued' || status === 'crawling';
}

export function formatUsd(value: number): string {
  return value.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

export function AuditStatusBadge({ audit }: { audit: SeoAuditListItem }) {
  switch (audit.status) {
    case 'queued':
      return (
        <Badge variant="secondary">
          <Loader2Icon className="mr-1 h-3 w-3 animate-spin" />
          Queued
        </Badge>
      );
    case 'crawling':
      return (
        <Badge variant="default">
          <Loader2Icon className="mr-1 h-3 w-3 animate-spin" />
          Crawling
        </Badge>
      );
    case 'completed':
      return <Badge variant="success">Completed</Badge>;
    case 'failed':
      return (
        <Badge variant={audit.error === 'cancelled' ? 'secondary' : 'destructive'}>
          {audit.error === 'cancelled' ? 'Cancelled' : 'Failed'}
        </Badge>
      );
    default:
      return null;
  }
}

/** Crawl progress out of maxPages; DFS may stop early on small sites. */
export function AuditProgress({ audit }: { audit: SeoAuditListItem }) {
  const percent =
    audit.maxPages > 0
      ? Math.min(100, Math.round((audit.pagesCrawled / audit.maxPages) * 100))
      : 0;
  return (
    <div className="flex items-center gap-2">
      <Progress className="h-1.5 w-24" value={percent} />
      <span className="font-mono text-muted-foreground text-xs tabular-nums">
        {audit.pagesCrawled.toLocaleString()} / {audit.maxPages.toLocaleString()}
      </span>
    </div>
  );
}

export function scoreClass(score: number | null): string {
  if (score === null) {
    return 'text-muted-foreground';
  }
  if (score >= 80) {
    return 'text-emerald-600 dark:text-emerald-400';
  }
  if (score >= 50) {
    return 'text-amber-600 dark:text-amber-400';
  }
  return 'text-red-600 dark:text-red-400';
}
