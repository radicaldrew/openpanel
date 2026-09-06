import { Loader2Icon } from 'lucide-react';
import { SEVERITY_BADGE, type SeoAuditPageRow, scoreClass } from './audit-status';
import { Skeleton } from '@/components/skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/utils/cn';

export const PAGE_SORTS = [
  { id: 'score_asc', label: 'Lowest score first' },
  { id: 'score_desc', label: 'Highest score first' },
  { id: 'url_asc', label: 'URL' },
  { id: 'status_desc', label: 'Status code' },
  { id: 'words_asc', label: 'Fewest words' },
  { id: 'load_desc', label: 'Slowest first' },
] as const;

export type PageSort = (typeof PAGE_SORTS)[number]['id'];

const SKELETON_ROWS = [1, 2, 3, 4, 5, 6];
const MAX_ISSUE_BADGES = 3;

function statusClass(code: number): string {
  if (code >= 500) {
    return 'text-red-600 dark:text-red-400';
  }
  if (code >= 400) {
    return 'text-amber-600 dark:text-amber-400';
  }
  if (code >= 300) {
    return 'text-sky-600 dark:text-sky-400';
  }
  return 'text-muted-foreground';
}

function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}` || '/';
  } catch {
    return url;
  }
}

interface Props {
  pages: SeoAuditPageRow[];
  total: number;
  isLoading: boolean;
  isFetchingMore: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  sort: PageSort;
  onSortChange: (sort: PageSort) => void;
  filterLabel: string | null;
  onRowClick: (url: string) => void;
}

export function AuditPagesTable({
  pages,
  total,
  isLoading,
  isFetchingMore,
  hasMore,
  onLoadMore,
  sort,
  onSortChange,
  filterLabel,
  onRowClick,
}: Props) {
  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div className="text-muted-foreground text-sm">
          {isLoading
            ? 'Loading pages…'
            : `${total.toLocaleString()} page${total === 1 ? '' : 's'}${
                filterLabel ? ` with “${filterLabel}”` : ''
              }`}
        </div>
        <Select onValueChange={(value) => onSortChange(value as PageSort)} value={sort}>
          <SelectTrigger className="w-48" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAGE_SORTS.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                {entry.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Page</TableHead>
              <TableHead className="w-16 text-right">Score</TableHead>
              <TableHead className="w-16 text-right">Status</TableHead>
              <TableHead className="w-20 text-right">Words</TableHead>
              <TableHead className="w-20 text-right">Load</TableHead>
              <TableHead>Issues</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading &&
              SKELETON_ROWS.map((index) => (
                <TableRow key={index}>
                  <TableCell colSpan={6}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))}
            {!isLoading && pages.length === 0 && (
              <TableRow>
                <TableCell className="py-10 text-center text-muted-foreground text-sm" colSpan={6}>
                  No pages match this filter.
                </TableCell>
              </TableRow>
            )}
            {!isLoading &&
              pages.map((page) => {
                const shown = page.issues.slice(0, MAX_ISSUE_BADGES);
                const hidden = page.issues.length - shown.length;
                return (
                  <TableRow className="cursor-pointer" key={page.url} onClick={() => onRowClick(page.url)}>
                    <TableCell className="max-w-md">
                      <div className="truncate font-mono text-xs" title={page.url}>
                        {pathOf(page.url)}
                      </div>
                      {page.title && (
                        <div className="truncate text-muted-foreground text-xs">{page.title}</div>
                      )}
                    </TableCell>
                    <TableCell className={cn('text-right font-mono text-xs tabular-nums', scoreClass(page.onpageScore))}>
                      {Math.round(page.onpageScore)}
                    </TableCell>
                    <TableCell className={cn('text-right font-mono text-xs tabular-nums', statusClass(page.statusCode))}>
                      {page.statusCode || '–'}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">
                      {page.wordCount.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">
                      {page.loadTimeMs ? `${(page.loadTimeMs / 1000).toFixed(1)}s` : '–'}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {shown.map((issue) => (
                          <Badge className="font-normal" key={issue.key} variant={SEVERITY_BADGE[issue.severity]}>
                            {issue.label}
                          </Badge>
                        ))}
                        {hidden > 0 && (
                          <span className="text-muted-foreground text-xs">+{hidden}</span>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
          </TableBody>
        </Table>
      </div>

      {hasMore && (
        <div className="border-t p-3 text-center">
          <Button disabled={isFetchingMore} onClick={onLoadMore} size="sm" variant="outline">
            {isFetchingMore && <Loader2Icon className="mr-2 h-4 w-4 animate-spin" />}
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
