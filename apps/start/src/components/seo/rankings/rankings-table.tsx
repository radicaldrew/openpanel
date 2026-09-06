import { DownloadIcon, ExternalLinkIcon, SearchIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { PositionCell } from './position-cell';
import { downloadRankingsCsv } from './rankings-csv';
import {
  featureLabel,
  notableFeatures,
  type TrackingList,
  type TrackingRow,
} from './use-tracking';
import { Pagination } from '@/components/pagination';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltiper } from '@/components/ui/tooltip';
import { useNumber } from '@/hooks/use-numer-formatter';
import { cn } from '@/utils/cn';

const PAGE_SIZE = 25;
const MAX_VISIBLE_FEATURES = 3;

type SortKey = 'keyword' | 'volume' | 'desktop' | 'mobile' | 'best';

interface Props {
  data: TrackingList;
  search: string;
  onSearchChange: (value: string) => void;
  activeTag: string | null;
  onTagChange: (tag: string | null) => void;
  selectedIds: Set<string>;
  onSelectionChange: (ids: Set<string>) => void;
  onRowClick: (row: TrackingRow) => void;
  deltaWindow: '7d' | '30d';
  onDeltaWindowChange: (window: '7d' | '30d') => void;
}

/** Nulls (unranked) sort last regardless of direction. */
function comparePositions(a: number | null, b: number | null): number {
  if (a === null && b === null) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  return a - b;
}

function sortRows(rows: TrackingRow[], key: SortKey, desc: boolean): TrackingRow[] {
  const sorted = [...rows].sort((a, b) => {
    switch (key) {
      case 'keyword':
        return a.keyword.localeCompare(b.keyword);
      case 'volume':
        return (b.searchVolume ?? -1) - (a.searchVolume ?? -1);
      case 'desktop':
        return comparePositions(a.desktop?.position ?? null, b.desktop?.position ?? null);
      case 'mobile':
        return comparePositions(a.mobile?.position ?? null, b.mobile?.position ?? null);
      default:
        return comparePositions(a.bestPosition, b.bestPosition);
    }
  });
  return desc ? sorted.reverse() : sorted;
}

function SortHeader({
  label,
  sortKey,
  active,
  desc,
  onClick,
  className,
}: {
  label: string;
  sortKey: SortKey;
  active: SortKey;
  desc: boolean;
  onClick: (key: SortKey) => void;
  className?: string;
}) {
  const isActive = active === sortKey;
  return (
    <TableHead className={className}>
      <button
        className={cn(
          'inline-flex items-center gap-1 whitespace-nowrap hover:text-foreground',
          isActive && 'text-foreground'
        )}
        onClick={() => onClick(sortKey)}
        type="button"
      >
        {label}
        {isActive && <span className="text-xs">{desc ? '↓' : '↑'}</span>}
      </button>
    </TableHead>
  );
}

function FeatureBadges({ features }: { features: string[] }) {
  const notable = notableFeatures(features);
  if (notable.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  const visible = notable.slice(0, MAX_VISIBLE_FEATURES);
  const hidden = notable.slice(MAX_VISIBLE_FEATURES);
  return (
    <div className="flex flex-wrap gap-1">
      {visible.map((feature) => (
        <Badge className="font-normal" key={feature} variant="secondary">
          {featureLabel(feature)}
        </Badge>
      ))}
      {hidden.length > 0 && (
        <Tooltiper content={hidden.map(featureLabel).join(', ')}>
          <Badge className="font-normal" variant="outline">
            +{hidden.length}
          </Badge>
        </Tooltiper>
      )}
    </div>
  );
}

function RankingUrl({ row }: { row: TrackingRow }) {
  const url = row.desktop?.url ?? row.mobile?.url ?? null;
  if (!url) {
    return <span className="text-muted-foreground">—</span>;
  }
  let path = url;
  try {
    const parsed = new URL(url);
    path = `${parsed.pathname}${parsed.search}` || '/';
  } catch {
    // Keep the raw value.
  }
  return (
    <Tooltiper content={url}>
      <a
        className="inline-flex max-w-[220px] items-center gap-1 truncate text-muted-foreground hover:text-foreground"
        href={url}
        onClick={(event) => event.stopPropagation()}
        rel="noopener"
        target="_blank"
      >
        <span className="truncate">{path}</span>
        <ExternalLinkIcon className="size-3 shrink-0" />
      </a>
    </Tooltiper>
  );
}

export function RankingsTable({
  data,
  search,
  onSearchChange,
  activeTag,
  onTagChange,
  selectedIds,
  onSelectionChange,
  onRowClick,
  deltaWindow,
  onDeltaWindowChange,
}: Props) {
  const number = useNumber();
  const [sortKey, setSortKey] = useState<SortKey>('best');
  const [sortDesc, setSortDesc] = useState(false);
  const [page, setPage] = useState(0);

  const showDesktop = data.devices !== 'mobile';
  const showMobile = data.devices !== 'desktop';

  const rows = useMemo(
    () => sortRows(data.rows, sortKey, sortDesc),
    [data.rows, sortKey, sortDesc]
  );
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageRows = rows.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  const allOnPageSelected =
    pageRows.length > 0 && pageRows.every((row) => selectedIds.has(row.id));

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDesc((value) => !value);
    } else {
      setSortKey(key);
      setSortDesc(false);
    }
  };

  const togglePage = (checked: boolean) => {
    const next = new Set(selectedIds);
    for (const row of pageRows) {
      if (checked) {
        next.add(row.id);
      } else {
        next.delete(row.id);
      }
    }
    onSelectionChange(next);
  };

  const toggleRow = (id: string, checked: boolean) => {
    const next = new Set(selectedIds);
    if (checked) {
      next.add(id);
    } else {
      next.delete(id);
    }
    onSelectionChange(next);
  };

  return (
    <div className="card overflow-hidden rounded-md">
      <div className="flex flex-wrap items-center gap-2 border-b p-3">
        <div className="relative">
          <SearchIcon className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="w-56 pl-8"
            onChange={(event) => {
              onSearchChange(event.target.value);
              setPage(0);
            }}
            placeholder="Search keywords"
            size="sm"
            value={search}
          />
        </div>
        {data.tags.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            {data.tags.map((tag) => (
              <button
                key={tag}
                onClick={() => {
                  onTagChange(activeTag === tag ? null : tag);
                  setPage(0);
                }}
                type="button"
              >
                <Badge variant={activeTag === tag ? 'default' : 'outline'}>
                  {tag}
                </Badge>
              </button>
            ))}
          </div>
        )}
        <div className="ml-auto flex items-center gap-1 text-xs">
          <Button
            disabled={rows.length === 0}
            onClick={() =>
              downloadRankingsCsv(
                selectedIds.size > 0 ? rows.filter((row) => selectedIds.has(row.id)) : rows,
                activeTag ?? (search ? `search-${search}` : 'all')
              )
            }
            size="sm"
            title={
              selectedIds.size > 0
                ? `Export ${selectedIds.size} selected keyword(s)`
                : 'Export every loaded keyword'
            }
            variant="outline"
          >
            <DownloadIcon className="mr-2 size-3.5" />
            Export CSV
          </Button>
          <span className="ml-2 text-muted-foreground">Change vs</span>
          {(['7d', '30d'] as const).map((window) => (
            <Button
              key={window}
              onClick={() => onDeltaWindowChange(window)}
              size="sm"
              variant={deltaWindow === window ? 'secondary' : 'ghost'}
            >
              {window}
            </Button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  aria-label="Select all on page"
                  checked={allOnPageSelected}
                  onCheckedChange={(checked) => togglePage(checked === true)}
                />
              </TableHead>
              <SortHeader
                active={sortKey}
                desc={sortDesc}
                label="Keyword"
                onClick={toggleSort}
                sortKey="keyword"
              />
              <SortHeader
                active={sortKey}
                className="text-right"
                desc={sortDesc}
                label="Volume"
                onClick={toggleSort}
                sortKey="volume"
              />
              {showDesktop && (
                <SortHeader
                  active={sortKey}
                  desc={sortDesc}
                  label="Desktop"
                  onClick={toggleSort}
                  sortKey="desktop"
                />
              )}
              {showMobile && (
                <SortHeader
                  active={sortKey}
                  desc={sortDesc}
                  label="Mobile"
                  onClick={toggleSort}
                  sortKey="mobile"
                />
              )}
              <TableHead>Ranking URL</TableHead>
              <TableHead>SERP features</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageRows.length === 0 && (
              <TableRow>
                <TableCell className="py-10 text-center text-muted-foreground" colSpan={7}>
                  No keywords match.
                </TableCell>
              </TableRow>
            )}
            {pageRows.map((row) => (
              <TableRow
                className={cn(
                  'cursor-pointer',
                  !row.isActive && 'opacity-60',
                  selectedIds.has(row.id) && 'bg-muted/40'
                )}
                key={row.id}
                onClick={() => onRowClick(row)}
              >
                <TableCell onClick={(event) => event.stopPropagation()}>
                  <Checkbox
                    aria-label={`Select ${row.keyword}`}
                    checked={selectedIds.has(row.id)}
                    onCheckedChange={(checked) => toggleRow(row.id, checked === true)}
                  />
                </TableCell>
                <TableCell>
                  <div className="col gap-1">
                    <span className="font-medium">{row.keyword}</span>
                    <div className="flex flex-wrap items-center gap-1">
                      {!row.isActive && (
                        <Badge className="font-normal" variant="outline">
                          Paused
                        </Badge>
                      )}
                      {row.tags.map((tag) => (
                        <Badge className="font-normal" key={tag} variant="secondary">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  <Tooltiper
                    content={
                      row.difficulty !== null
                        ? `Difficulty ${row.difficulty}${row.cpc !== null ? ` · CPC $${row.cpc.toFixed(2)}` : ''}`
                        : 'Metrics pending'
                    }
                  >
                    <span>
                      {row.searchVolume === null ? '—' : number.short(row.searchVolume)}
                    </span>
                  </Tooltiper>
                </TableCell>
                {showDesktop && (
                  <TableCell>
                    <PositionCell
                      cell={row.desktop}
                      serpDepth={data.serpDepth}
                      window={deltaWindow}
                    />
                  </TableCell>
                )}
                {showMobile && (
                  <TableCell>
                    <PositionCell
                      cell={row.mobile}
                      serpDepth={data.serpDepth}
                      window={deltaWindow}
                    />
                  </TableCell>
                )}
                <TableCell>
                  <RankingUrl row={row} />
                </TableCell>
                <TableCell>
                  <FeatureBadges
                    features={row.desktop?.serpFeatures ?? row.mobile?.serpFeatures ?? []}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {pageCount > 1 && (
        <div className="border-t p-3">
          <Pagination
            canNextPage={currentPage < pageCount - 1}
            canPreviousPage={currentPage > 0}
            firstPage={() => setPage(0)}
            lastPage={() => setPage(pageCount - 1)}
            nextPage={() => setPage((value) => Math.min(pageCount - 1, value + 1))}
            pageIndex={`${currentPage + 1} / ${pageCount}`}
            previousPage={() => setPage((value) => Math.max(0, value - 1))}
          />
        </div>
      )}
    </div>
  );
}
