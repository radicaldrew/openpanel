import { useQuery } from '@tanstack/react-query';
import { DownloadIcon, ExternalLinkIcon, SearchIcon } from 'lucide-react';
import { useState } from 'react';
import {
  backlinkPagesToCsvRows,
  backlinkRowsToCsvRows,
  downloadBacklinksCsv,
  referringDomainsToCsvRows,
} from './backlinks-csv';
import {
  type BacklinkFilters,
  type BacklinkPageRow,
  type BacklinkPagesSort,
  type BacklinkRow,
  type BacklinkRowsSort,
  type BacklinkSortOrder,
  type BacklinkStatusFilter,
  BACKLINKS_STALE_TIME_MS,
  formatCount,
  formatDfsDate,
  type ReferringDomainRow,
  type ReferringDomainsSort,
  spamScoreClass,
} from './use-backlinks';
import { Pagination } from '@/components/pagination';
import { Skeleton } from '@/components/skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTRPC } from '@/integrations/trpc/react';
import { cn } from '@/utils/cn';

const PAGE_SIZE = 50;
const SKELETON_ROWS = [1, 2, 3, 4, 5, 6, 7, 8];

type TableTab = 'backlinks' | 'domains' | 'pages';
type LinkTypeFilter = 'all' | 'dofollow' | 'nofollow';

const TABS: { id: TableTab; label: string }[] = [
  { id: 'backlinks', label: 'Backlinks' },
  { id: 'domains', label: 'Referring domains' },
  { id: 'pages', label: 'Top pages' },
];

const STATUS_LABELS: Record<BacklinkStatusFilter, string> = {
  live: 'Live links',
  new: 'New links',
  lost: 'Lost links',
  all: 'Live and lost',
};

const LINK_TYPE_LABELS: Record<LinkTypeFilter, string> = {
  all: 'Follow and nofollow',
  dofollow: 'Dofollow only',
  nofollow: 'Nofollow only',
};

/** What the user has applied; the queries key off this, not the live inputs. */
interface AppliedFilters {
  linkType: LinkTypeFilter;
  status: BacklinkStatusFilter;
  minRank: string;
  search: string;
}

const DEFAULT_FILTERS: AppliedFilters = {
  linkType: 'all',
  status: 'live',
  minRank: '',
  search: '',
};

function toApiFilters(applied: AppliedFilters): BacklinkFilters {
  const minRank = Number.parseInt(applied.minRank, 10);
  return {
    dofollow:
      applied.linkType === 'all' ? undefined : applied.linkType === 'dofollow',
    status: applied.status,
    minRank: Number.isFinite(minRank) && minRank > 0 ? minRank : undefined,
    search: applied.search.trim() || undefined,
  };
}

interface SortState<TSort extends string> {
  sort: TSort;
  order: BacklinkSortOrder;
}

/** Offset cursors; keeping the trail lets "previous" work without a count. */
function useCursorTrail() {
  const [trail, setTrail] = useState<(string | null)[]>([null]);
  return {
    cursor: trail.at(-1) ?? null,
    pageIndex: trail.length,
    canPrevious: trail.length > 1,
    next: (cursor: string) => setTrail((prev) => [...prev, cursor]),
    previous: () => setTrail((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev)),
    reset: () => setTrail([null]),
  };
}

interface Props {
  projectId: string;
  target: string | undefined;
  /** Domain the rows belong to, for the export file name. */
  targetDomain: string;
}

export function BacklinksTables({ projectId, target, targetDomain }: Props) {
  const [tab, setTab] = useState<TableTab>('backlinks');
  const [draft, setDraft] = useState<AppliedFilters>(DEFAULT_FILTERS);
  const [applied, setApplied] = useState<AppliedFilters>(DEFAULT_FILTERS);
  const [rowsSort, setRowsSort] = useState<SortState<BacklinkRowsSort>>({
    sort: 'rank',
    order: 'desc',
  });
  const [domainsSort, setDomainsSort] = useState<SortState<ReferringDomainsSort>>({
    sort: 'backlinks',
    order: 'desc',
  });
  const [pagesSort, setPagesSort] = useState<SortState<BacklinkPagesSort>>({
    sort: 'backlinks',
    order: 'desc',
  });
  const trail = useCursorTrail();

  const filters = toApiFilters(applied);
  // Every list query shares the target/filter/cursor part of its key, so a
  // change to any of them restarts pagination.
  const [pageKey, setPageKey] = useState(() => JSON.stringify({ target, filters }));
  const nextPageKey = JSON.stringify({ target, filters, tab });
  if (nextPageKey !== pageKey) {
    setPageKey(nextPageKey);
    trail.reset();
  }

  const applyFilters = () => setApplied(draft);
  const resetFilters = () => {
    setDraft(DEFAULT_FILTERS);
    setApplied(DEFAULT_FILTERS);
  };

  const commonInput = {
    projectId,
    target,
    filters,
    cursor: trail.cursor,
    limit: PAGE_SIZE,
  };

  const trpc = useTRPC();
  const listOptions = { staleTime: BACKLINKS_STALE_TIME_MS };
  const rowsQuery = useQuery(
    trpc.seo.backlinks.list.queryOptions(
      { ...commonInput, ...rowsSort },
      { ...listOptions, enabled: tab === 'backlinks' }
    )
  );
  const domainsQuery = useQuery(
    trpc.seo.backlinks.referringDomains.queryOptions(
      { ...commonInput, ...domainsSort },
      { ...listOptions, enabled: tab === 'domains' }
    )
  );
  const pagesQuery = useQuery(
    trpc.seo.backlinks.pages.queryOptions(
      { ...commonInput, ...pagesSort },
      { ...listOptions, enabled: tab === 'pages' }
    )
  );

  const active =
    tab === 'backlinks' ? rowsQuery : tab === 'domains' ? domainsQuery : pagesQuery;
  const nextCursor = active.data?.nextCursor ?? null;
  const totalCount = active.data?.totalCount ?? null;
  const rowCount = active.data?.rows.length ?? 0;

  // Exports what is on screen: the current page of the active tab, after
  // filters and sort, not the full remote set.
  const exportCsv = () => {
    if (tab === 'backlinks' && rowsQuery.data) {
      downloadBacklinksCsv('backlinks', backlinkRowsToCsvRows(rowsQuery.data.rows), targetDomain);
    } else if (tab === 'domains' && domainsQuery.data) {
      downloadBacklinksCsv(
        'referring-domains',
        referringDomainsToCsvRows(domainsQuery.data.rows),
        targetDomain
      );
    } else if (tab === 'pages' && pagesQuery.data) {
      downloadBacklinksCsv('top-pages', backlinkPagesToCsvRows(pagesQuery.data.rows), targetDomain);
    }
  };

  const toggleSort = <TSort extends string>(
    state: SortState<TSort>,
    set: (next: SortState<TSort>) => void,
    key: TSort
  ) => {
    set(
      state.sort === key
        ? { sort: key, order: state.order === 'desc' ? 'asc' : 'desc' }
        : { sort: key, order: 'desc' }
    );
    trail.reset();
  };

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <Tabs onValueChange={(value) => setTab(value as TableTab)} value={tab}>
          <TabsList>
            {TABS.map((entry) => (
              <TabsTrigger key={entry.id} value={entry.id}>
                {entry.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground text-sm">
            {active.isLoading
              ? 'Loading…'
              : totalCount !== null
                ? `${formatCount(totalCount)} total`
                : `${rowCount} shown`}
          </span>
          <Button
            disabled={rowCount === 0 || active.isLoading}
            onClick={exportCsv}
            size="sm"
            variant="outline"
          >
            <DownloadIcon className="mr-2 size-4" />
            Export CSV
          </Button>
        </div>
      </div>

      <form
        className="flex flex-wrap items-end gap-2 border-b px-4 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          applyFilters();
        }}
      >
        {tab === 'backlinks' && (
          <Select
            onValueChange={(value) =>
              setDraft((prev) => ({ ...prev, linkType: value as LinkTypeFilter }))
            }
            value={draft.linkType}
          >
            <SelectTrigger className="w-[190px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(LINK_TYPE_LABELS) as LinkTypeFilter[]).map((key) => (
                <SelectItem key={key} value={key}>
                  {LINK_TYPE_LABELS[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Select
          onValueChange={(value) =>
            setDraft((prev) => ({ ...prev, status: value as BacklinkStatusFilter }))
          }
          value={draft.status}
        >
          <SelectTrigger className="w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(STATUS_LABELS) as BacklinkStatusFilter[]).map((key) => (
              <SelectItem
                // "new" only exists per backlink; domains and pages know live/lost.
                disabled={tab !== 'backlinks' && key === 'new'}
                key={key}
                value={key}
              >
                {STATUS_LABELS[key]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          aria-label="Minimum rank"
          className="w-[120px]"
          inputMode="numeric"
          min={0}
          onChange={(event) => setDraft((prev) => ({ ...prev, minRank: event.target.value }))}
          placeholder="Min rank"
          type="number"
          value={draft.minRank}
        />
        <div className="relative">
          <SearchIcon className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label={tab === 'pages' ? 'Search URLs' : 'Search domains'}
            className="w-[220px] pl-8"
            onChange={(event) => setDraft((prev) => ({ ...prev, search: event.target.value }))}
            placeholder={tab === 'pages' ? 'Search URLs' : 'Search domains'}
            value={draft.search}
          />
        </div>
        <Button size="sm" type="submit" variant="outline">
          Apply
        </Button>
        {(applied !== DEFAULT_FILTERS || draft !== DEFAULT_FILTERS) && (
          <Button onClick={resetFilters} size="sm" type="button" variant="ghost">
            Reset
          </Button>
        )}
      </form>

      <div className="overflow-x-auto">
        {tab === 'backlinks' && (
          <BacklinkRowsTable
            isLoading={rowsQuery.isLoading}
            onSort={(key) => toggleSort(rowsSort, setRowsSort, key)}
            rows={rowsQuery.data?.rows ?? []}
            sort={rowsSort}
          />
        )}
        {tab === 'domains' && (
          <ReferringDomainsTable
            isLoading={domainsQuery.isLoading}
            onSort={(key) => toggleSort(domainsSort, setDomainsSort, key)}
            rows={domainsQuery.data?.rows ?? []}
            sort={domainsSort}
          />
        )}
        {tab === 'pages' && (
          <TopPagesTable
            isLoading={pagesQuery.isLoading}
            onSort={(key) => toggleSort(pagesSort, setPagesSort, key)}
            rows={pagesQuery.data?.rows ?? []}
            sort={pagesSort}
          />
        )}
        {active.isError && (
          <p className="px-4 py-6 text-center text-destructive text-sm">
            {active.error.message}
          </p>
        )}
        {!(active.isLoading || active.isError) && rowCount === 0 && (
          <p className="px-4 py-10 text-center text-muted-foreground text-sm">
            Nothing matches these filters.
          </p>
        )}
      </div>

      <div className="flex items-center justify-between border-t px-4 py-3">
        <span className="text-muted-foreground text-xs">
          {rowCount > 0 ? `${PAGE_SIZE} per page` : ''}
        </span>
        <Pagination
          canNextPage={nextCursor !== null}
          canPreviousPage={trail.canPrevious}
          nextPage={() => {
            if (nextCursor !== null) {
              trail.next(nextCursor);
            }
          }}
          pageIndex={trail.pageIndex}
          previousPage={trail.previous}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared cells
// ---------------------------------------------------------------------------

function SortableHead<TSort extends string>({
  label,
  sortKey,
  state,
  onSort,
  align = 'right',
}: {
  label: string;
  sortKey: TSort;
  state: SortState<TSort>;
  onSort: (key: TSort) => void;
  align?: 'left' | 'right';
}) {
  const isActive = state.sort === sortKey;
  return (
    <TableHead className={align === 'right' ? 'text-right' : undefined}>
      <button
        className={cn(
          'w-full font-medium hover:underline',
          align === 'right' ? 'text-right' : 'text-left',
          isActive && 'text-foreground'
        )}
        onClick={() => onSort(sortKey)}
        type="button"
      >
        {label}
        {isActive ? (state.order === 'desc' ? ' ↓' : ' ↑') : ''}
      </button>
    </TableHead>
  );
}

function ExternalUrl({ href, label }: { href: string; label?: string }) {
  if (!href) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <a
      className="inline-flex max-w-[360px] items-center gap-1 truncate hover:underline"
      href={href}
      rel="noopener noreferrer"
      target="_blank"
      title={href}
    >
      <span className="truncate">{label ?? href.replace(/^https?:\/\//, '')}</span>
      <ExternalLinkIcon className="size-3 shrink-0 text-muted-foreground" />
    </a>
  );
}

function SkeletonRows({ columns }: { columns: number }) {
  return (
    <>
      {SKELETON_ROWS.map((row) => (
        <TableRow key={row}>
          {Array.from({ length: columns }, (_, index) => `c${index}`).map((cell) => (
            <TableCell key={cell}>
              <Skeleton className="h-4 w-full" />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}

function NumberCell({
  value,
  className,
}: {
  value: number | null | undefined;
  className?: string;
}) {
  return (
    <TableCell className={cn('text-right font-mono tabular-nums', className)}>
      {formatCount(value)}
    </TableCell>
  );
}

// ---------------------------------------------------------------------------
// Backlinks
// ---------------------------------------------------------------------------

function BacklinkRowsTable({
  rows,
  isLoading,
  sort,
  onSort,
}: {
  rows: BacklinkRow[];
  isLoading: boolean;
  sort: SortState<BacklinkRowsSort>;
  onSort: (key: BacklinkRowsSort) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Source</TableHead>
          <TableHead>Target page</TableHead>
          <TableHead>Type</TableHead>
          <SortableHead label="Rank" onSort={onSort} sortKey="rank" state={sort} />
          <SortableHead label="Domain rank" onSort={onSort} sortKey="domainRank" state={sort} />
          <SortableHead label="Spam" onSort={onSort} sortKey="spamScore" state={sort} />
          <SortableHead label="First seen" onSort={onSort} sortKey="firstSeen" state={sort} />
        </TableRow>
      </TableHeader>
      <TableBody>
        {isLoading ? (
          <SkeletonRows columns={7} />
        ) : (
          rows.map((row) => (
            <TableRow key={`${row.urlFrom}→${row.urlTo}`}>
              <TableCell>
                <div className="col gap-0.5">
                  <span className="font-medium">{row.domainFrom || '—'}</span>
                  <ExternalUrl href={row.urlFrom} />
                  {row.anchor && (
                    <span className="truncate text-muted-foreground text-xs" title={row.anchor}>
                      “{row.anchor}”
                    </span>
                  )}
                </div>
              </TableCell>
              <TableCell>
                <ExternalUrl href={row.urlTo} />
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  <Badge variant={row.dofollow ? 'default' : 'outline'}>
                    {row.dofollow ? 'dofollow' : 'nofollow'}
                  </Badge>
                  {row.isNew && <Badge variant="secondary">new</Badge>}
                  {row.isLost && <Badge variant="destructive">lost</Badge>}
                  {row.isBroken && <Badge variant="destructive">broken</Badge>}
                  {row.itemType && row.itemType !== 'anchor' && (
                    <Badge variant="outline">{row.itemType}</Badge>
                  )}
                </div>
              </TableCell>
              <NumberCell value={row.rank} />
              <NumberCell value={row.domainFromRank} />
              <NumberCell className={spamScoreClass(row.spamScore)} value={row.spamScore} />
              <TableCell className="text-right font-mono text-xs tabular-nums">
                {formatDfsDate(row.firstSeen)}
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}

// ---------------------------------------------------------------------------
// Referring domains
// ---------------------------------------------------------------------------

function ReferringDomainsTable({
  rows,
  isLoading,
  sort,
  onSort,
}: {
  rows: ReferringDomainRow[];
  isLoading: boolean;
  sort: SortState<ReferringDomainsSort>;
  onSort: (key: ReferringDomainsSort) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Domain</TableHead>
          <SortableHead label="Backlinks" onSort={onSort} sortKey="backlinks" state={sort} />
          <SortableHead
            label="Referring pages"
            onSort={onSort}
            sortKey="referringPages"
            state={sort}
          />
          <SortableHead label="Rank" onSort={onSort} sortKey="rank" state={sort} />
          <SortableHead label="Spam" onSort={onSort} sortKey="spamScore" state={sort} />
          <SortableHead label="First seen" onSort={onSort} sortKey="firstSeen" state={sort} />
          <TableHead className="text-right">Broken</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {isLoading ? (
          <SkeletonRows columns={7} />
        ) : (
          rows.map((row) => (
            <TableRow key={row.domain}>
              <TableCell className="font-medium">
                <ExternalUrl href={row.domain ? `https://${row.domain}` : ''} label={row.domain} />
              </TableCell>
              <NumberCell value={row.backlinks} />
              <NumberCell value={row.referringPages} />
              <NumberCell value={row.rank} />
              <NumberCell className={spamScoreClass(row.spamScore)} value={row.spamScore} />
              <TableCell className="text-right font-mono text-xs tabular-nums">
                {formatDfsDate(row.firstSeen)}
              </TableCell>
              <NumberCell value={row.brokenBacklinks} />
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}

// ---------------------------------------------------------------------------
// Top pages
// ---------------------------------------------------------------------------

function TopPagesTable({
  rows,
  isLoading,
  sort,
  onSort,
}: {
  rows: BacklinkPageRow[];
  isLoading: boolean;
  sort: SortState<BacklinkPagesSort>;
  onSort: (key: BacklinkPagesSort) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Page</TableHead>
          <SortableHead label="Backlinks" onSort={onSort} sortKey="backlinks" state={sort} />
          <SortableHead
            label="Referring domains"
            onSort={onSort}
            sortKey="referringDomains"
            state={sort}
          />
          <SortableHead label="Rank" onSort={onSort} sortKey="rank" state={sort} />
          <TableHead className="text-right">Broken</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {isLoading ? (
          <SkeletonRows columns={5} />
        ) : (
          rows.map((row) => (
            <TableRow key={row.url}>
              <TableCell>
                <ExternalUrl href={row.url} />
              </TableCell>
              <NumberCell value={row.backlinks} />
              <NumberCell value={row.referringDomains} />
              <NumberCell value={row.rank} />
              <NumberCell value={row.brokenBacklinks} />
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}
