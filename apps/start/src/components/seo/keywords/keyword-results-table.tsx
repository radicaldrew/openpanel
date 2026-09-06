import { DownloadIcon, Loader2Icon, PlusIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { KeywordSparkline } from './keyword-sparkline';
import type { KeywordTableRow } from './types';
import { Skeleton } from '@/components/skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/utils/cn';

const SKELETON_ROWS = [1, 2, 3, 4, 5, 6, 7, 8];

type SortKey = 'keyword' | 'searchVolume' | 'difficulty' | 'cpc' | 'position' | 'clicks';

const INTENT_VARIANT: Record<string, 'default' | 'secondary' | 'outline'> = {
  transactional: 'default',
  commercial: 'default',
  informational: 'secondary',
  navigational: 'outline',
};

export function formatVolume(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return '–';
  }
  return value.toLocaleString();
}

export function formatCpc(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return '–';
  }
  return `$${value.toFixed(2)}`;
}

export function difficultyClass(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return 'text-muted-foreground';
  }
  if (value >= 70) {
    return 'text-red-600 dark:text-red-400';
  }
  if (value >= 40) {
    return 'text-amber-600 dark:text-amber-400';
  }
  return 'text-emerald-600 dark:text-emerald-400';
}

interface Props {
  rows: KeywordTableRow[];
  isLoading: boolean;
  emptyMessage: string;
  /** Extra columns shown for this source. */
  showRank?: boolean;
  showGsc?: boolean;
  onRowClick: (keyword: string) => void;
  onTrack: (keywords: string[]) => void;
  isTracking: boolean;
  onExport: (rows: KeywordTableRow[]) => void;
}

export function KeywordResultsTable({
  rows,
  isLoading,
  emptyMessage,
  showRank = false,
  showGsc = false,
  onRowClick,
  onTrack,
  isTracking,
  onExport,
}: Props) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({
    key: showGsc ? 'clicks' : 'searchVolume',
    desc: true,
  });

  const sortedRows = useMemo(() => {
    const valueOf = (row: KeywordTableRow): string | number | null => {
      switch (sort.key) {
        case 'keyword':
          return row.keyword;
        case 'searchVolume':
          return row.searchVolume;
        case 'difficulty':
          return row.difficulty;
        case 'cpc':
          return row.cpc;
        case 'position':
          return row.position ?? row.gscPosition ?? null;
        case 'clicks':
          return row.clicks ?? null;
        default:
          return null;
      }
    };
    return [...rows].sort((a, b) => {
      const av = valueOf(a);
      const bv = valueOf(b);
      if (av === null && bv === null) {
        return 0;
      }
      if (av === null) {
        return 1;
      }
      if (bv === null) {
        return -1;
      }
      const cmp =
        typeof av === 'string' && typeof bv === 'string'
          ? av.localeCompare(bv)
          : Number(av) - Number(bv);
      return sort.desc ? -cmp : cmp;
    });
  }, [rows, sort]);

  const selectedRows = rows.filter((row) => selected.has(row.keyword));
  const allSelected = rows.length > 0 && selectedRows.length === rows.length;

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.keyword)));
  };
  const toggleOne = (keyword: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(keyword)) {
        next.delete(keyword);
      } else {
        next.add(keyword);
      }
      return next;
    });
  };

  const headerButton = (key: SortKey, label: string, align = 'text-right') => (
    <button
      className={cn('w-full font-medium hover:underline', align)}
      onClick={() =>
        setSort((prev) =>
          prev.key === key ? { key, desc: !prev.desc } : { key, desc: true }
        )
      }
      type="button"
    >
      {label}
      {sort.key === key ? (sort.desc ? ' ↓' : ' ↑') : ''}
    </button>
  );

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div className="text-muted-foreground text-sm">
          {isLoading
            ? 'Loading…'
            : selectedRows.length > 0
              ? `${selectedRows.length} of ${rows.length} selected`
              : `${rows.length} keywords`}
        </div>
        <div className="flex items-center gap-2">
          <Button
            disabled={rows.length === 0}
            onClick={() => onExport(selectedRows.length > 0 ? selectedRows : rows)}
            size="sm"
            variant="outline"
          >
            <DownloadIcon className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
          <Button
            disabled={selectedRows.length === 0 || isTracking}
            onClick={() => {
              onTrack(selectedRows.map((row) => row.keyword));
              setSelected(new Set());
            }}
            size="sm"
          >
            {isTracking ? (
              <Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <PlusIcon className="mr-2 h-4 w-4" />
            )}
            Track selected
          </Button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  aria-label="Select all keywords"
                  checked={allSelected}
                  disabled={rows.length === 0}
                  onCheckedChange={toggleAll}
                />
              </TableHead>
              <TableHead>{headerButton('keyword', 'Keyword', 'text-left')}</TableHead>
              {showGsc && (
                <>
                  <TableHead className="w-20">{headerButton('clicks', 'Clicks')}</TableHead>
                  <TableHead className="w-20 text-right">Impr.</TableHead>
                </>
              )}
              {(showRank || showGsc) && (
                <TableHead className="w-16">{headerButton('position', 'Pos.')}</TableHead>
              )}
              <TableHead className="w-24">{headerButton('searchVolume', 'Volume')}</TableHead>
              <TableHead className="w-16">{headerButton('difficulty', 'KD')}</TableHead>
              <TableHead className="w-20">{headerButton('cpc', 'CPC')}</TableHead>
              {!showGsc && <TableHead className="w-28">Intent</TableHead>}
              {!showGsc && <TableHead className="w-24">Trend</TableHead>}
              {showRank && <TableHead>URL</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading &&
              SKELETON_ROWS.map((index) => (
                <TableRow key={index}>
                  <TableCell colSpan={9}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))}
            {!isLoading && rows.length === 0 && (
              <TableRow>
                <TableCell
                  className="py-10 text-center text-muted-foreground text-sm"
                  colSpan={9}
                >
                  {emptyMessage}
                </TableCell>
              </TableRow>
            )}
            {!isLoading &&
              sortedRows.map((row) => (
                <TableRow
                  className={cn(selected.has(row.keyword) && 'bg-muted/40')}
                  key={row.keyword}
                >
                  <TableCell>
                    <Checkbox
                      aria-label={`Select ${row.keyword}`}
                      checked={selected.has(row.keyword)}
                      onCheckedChange={() => toggleOne(row.keyword)}
                    />
                  </TableCell>
                  <TableCell>
                    <button
                      className="max-w-md truncate text-left font-mono text-xs hover:underline"
                      onClick={() => onRowClick(row.keyword)}
                      title="Preview Google results"
                      type="button"
                    >
                      {row.keyword}
                    </button>
                  </TableCell>
                  {showGsc && (
                    <>
                      <TableCell className="text-right font-mono text-xs tabular-nums">
                        {formatVolume(row.clicks)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs tabular-nums">
                        {formatVolume(row.impressions)}
                      </TableCell>
                    </>
                  )}
                  {(showRank || showGsc) && (
                    <TableCell className="text-right font-mono text-xs tabular-nums">
                      {row.position ?? row.gscPosition?.toFixed(1) ?? '–'}
                    </TableCell>
                  )}
                  <TableCell className="text-right font-mono text-xs tabular-nums">
                    {row.pending ? (
                      <PendingCell />
                    ) : (
                      formatVolume(row.searchVolume)
                    )}
                  </TableCell>
                  <TableCell
                    className={cn(
                      'text-right font-mono text-xs tabular-nums',
                      difficultyClass(row.difficulty)
                    )}
                  >
                    {row.pending ? <PendingCell /> : (row.difficulty ?? '–')}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">
                    {row.pending ? <PendingCell /> : formatCpc(row.cpc)}
                  </TableCell>
                  {!showGsc && (
                    <TableCell>
                      {row.intent ? (
                        <Badge
                          className="capitalize"
                          variant={INTENT_VARIANT[row.intent] ?? 'secondary'}
                        >
                          {row.intent}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground text-xs">–</span>
                      )}
                    </TableCell>
                  )}
                  {!showGsc && (
                    <TableCell>
                      <KeywordSparkline data={row.monthlySearches} />
                    </TableCell>
                  )}
                  {showRank && (
                    <TableCell className="max-w-xs truncate font-mono text-muted-foreground text-xs">
                      {row.url ? (
                        <a
                          className="hover:underline"
                          href={row.url}
                          rel="noopener"
                          target="_blank"
                        >
                          {row.url.replace(/^https?:\/\//, '')}
                        </a>
                      ) : (
                        '–'
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/** Shown in metric cells while a seoKeywordMetrics job is fetching them. */
export function PendingCell() {
  return (
    <span
      className="inline-flex items-center gap-1 text-muted-foreground"
      title="Fetching from DataForSEO"
    >
      <Loader2Icon className="h-3 w-3 animate-spin" />
    </span>
  );
}
