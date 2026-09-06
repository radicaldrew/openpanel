import { ChevronRightIcon } from 'lucide-react';
import {
  SEVERITY_CLASS,
  SEVERITY_LABEL,
  type SeoAuditIssueCount,
  type SeoAuditIssueSummary,
  type SeoAuditSeverity,
} from './audit-status';
import { cn } from '@/utils/cn';

const SEVERITIES: SeoAuditSeverity[] = ['critical', 'warning', 'info'];

interface Props {
  summary: SeoAuditIssueSummary;
  selectedIssue: string | null;
  onSelectIssue: (key: string | null) => void;
}

/** Issues grouped by severity; clicking one filters the page table. */
export function AuditIssueList({ summary, selectedIssue, onSelectIssue }: Props) {
  const grouped = new Map<SeoAuditSeverity, SeoAuditIssueCount[]>();
  for (const issue of summary.issues) {
    const bucket = grouped.get(issue.severity) ?? [];
    bucket.push(issue);
    grouped.set(issue.severity, bucket);
  }

  if (summary.issues.length === 0) {
    return (
      <div className="card p-6 text-center text-muted-foreground text-sm">
        No issues detected on the crawled pages.
      </div>
    );
  }

  return (
    <div className="card divide-y overflow-hidden">
      <button
        className={cn(
          'flex w-full items-center justify-between px-4 py-2.5 text-left text-sm hover:bg-muted/40',
          selectedIssue === null && 'bg-muted/60 font-medium'
        )}
        onClick={() => onSelectIssue(null)}
        type="button"
      >
        All pages
      </button>
      {SEVERITIES.map((severity) => {
        const issues = grouped.get(severity);
        if (!issues || issues.length === 0) {
          return null;
        }
        return (
          <div key={severity}>
            <div
              className={cn(
                'flex items-center justify-between px-4 py-2 font-medium text-xs uppercase tracking-wide',
                SEVERITY_CLASS[severity]
              )}
            >
              <span>{SEVERITY_LABEL[severity]}</span>
              <span className="font-mono tabular-nums">
                {summary.totals[severity].toLocaleString()}
              </span>
            </div>
            <ul>
              {issues.map((issue) => {
                const isSelected = selectedIssue === issue.key;
                return (
                  <li key={issue.key}>
                    <button
                      className={cn(
                        'flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted/40',
                        isSelected && 'bg-muted/60'
                      )}
                      onClick={() => onSelectIssue(isSelected ? null : issue.key)}
                      title={issue.description}
                      type="button"
                    >
                      <span className="min-w-0 flex-1 truncate">{issue.label}</span>
                      <span className="font-mono text-muted-foreground text-xs tabular-nums">
                        {issue.count.toLocaleString()}
                      </span>
                      <ChevronRightIcon
                        className={cn(
                          'h-3.5 w-3.5 text-muted-foreground transition-transform',
                          isSelected && 'rotate-90'
                        )}
                      />
                    </button>
                    {isSelected && (
                      <div className="space-y-2 border-t bg-muted/20 px-4 py-3 text-xs">
                        <p className="text-muted-foreground">{issue.description}</p>
                        <p>
                          <span className="font-medium">How to fix: </span>
                          {issue.howToFix}
                        </p>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
