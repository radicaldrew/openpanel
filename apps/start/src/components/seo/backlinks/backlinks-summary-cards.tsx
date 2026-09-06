import { CameraIcon, Loader2Icon } from 'lucide-react';
import { type BacklinkOverview, formatCount, spamScoreClass } from './use-backlinks';
import { DeltaChip } from '@/components/delta-chip';
import { Button } from '@/components/ui/button';
import { Tooltiper } from '@/components/ui/tooltip';
import { cn } from '@/utils/cn';
import { timeAgo } from '@/utils/date';

interface Props {
  overview: BacklinkOverview;
  /** Only the own domain is snapshotted; competitors are always live. */
  canSnapshot: boolean;
  onSnapshotNow: () => void;
  isStarting: boolean;
}

function Stat({
  label,
  value,
  hint,
  valueClassName,
  children,
}: {
  label: string;
  value: string;
  hint: string;
  valueClassName?: string;
  children?: React.ReactNode;
}) {
  return (
    <Tooltiper content={hint}>
      <div className="col gap-1 border-border border-r px-4 py-3 last:border-r-0">
        <span className="truncate font-medium text-[10px] text-muted-foreground uppercase tracking-wider">
          {label}
        </span>
        <div className="flex items-center gap-2">
          <span className={cn('font-mono font-semibold text-2xl tabular-nums', valueClassName)}>
            {value}
          </span>
          {children}
        </div>
      </div>
    </Tooltiper>
  );
}

function NewLost({ overview }: { overview: BacklinkOverview }) {
  const { newBacklinks30d, lostBacklinks30d, newLostDays } = overview;
  if (newBacklinks30d === null || lostBacklinks30d === null) {
    return <span className="text-muted-foreground">—</span>;
  }
  const net = newBacklinks30d - lostBacklinks30d;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <DeltaChip size="sm" variant="inc">
        {formatCount(newBacklinks30d)}
      </DeltaChip>
      <DeltaChip size="sm" variant="dec">
        {formatCount(lostBacklinks30d)}
      </DeltaChip>
      <span className="text-muted-foreground text-xs">
        {net >= 0 ? '+' : ''}
        {formatCount(net)} net
        {newLostDays < 30 ? ` · ${newLostDays}d of data` : ''}
      </span>
    </div>
  );
}

function SnapshotStatus({ overview }: { overview: BacklinkOverview }) {
  if (overview.snapshotPending) {
    return (
      <div className="flex items-center gap-2 text-sm">
        <Loader2Icon className="size-3.5 animate-spin" />
        <span>Snapshot queued…</span>
      </div>
    );
  }
  if (overview.backlinks === null) {
    return <span className="text-muted-foreground text-sm">No snapshot yet</span>;
  }
  return (
    <div className="col gap-0.5 text-sm">
      <span>
        {overview.source === 'live' ? 'Refreshed' : 'Snapshot'}{' '}
        {timeAgo(new Date(overview.asOf))}
      </span>
      {overview.stale && (
        <span className="text-muted-foreground text-xs">
          Older than a day; a snapshot refreshes it.
        </span>
      )}
    </div>
  );
}

export function BacklinksSummaryCards({
  overview,
  canSnapshot,
  onSnapshotNow,
  isStarting,
}: Props) {
  const busy = isStarting || overview.snapshotPending;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
      <div className="card col-span-1 grid grid-cols-2 overflow-hidden rounded-md sm:grid-cols-5 lg:col-span-3">
        <Stat
          hint="Live backlinks DataForSEO knows about, subdomains included"
          label="Backlinks"
          value={formatCount(overview.backlinks)}
        />
        <Stat
          hint="Distinct domains linking to the target"
          label="Referring domains"
          value={formatCount(overview.referringDomains)}
        />
        <Stat
          hint="DataForSEO domain rank on a 0–100 scale; higher is stronger"
          label="Domain rank"
          value={overview.rank === null ? '—' : String(overview.rank)}
        />
        <Stat
          hint="Share of backlinks from spammy sources (0–100, lower is better)"
          label="Spam score"
          value={overview.spamScore === null ? '—' : String(overview.spamScore)}
          valueClassName={spamScoreClass(overview.spamScore)}
        />
        <div className="col col-span-2 gap-1 px-4 py-3 sm:col-span-1">
          <span className="truncate font-medium text-[10px] text-muted-foreground uppercase tracking-wider">
            New / lost 30d
          </span>
          <NewLost overview={overview} />
        </div>
      </div>
      <div className="card col justify-between gap-3 rounded-md p-4">
        {canSnapshot ? (
          <>
            <SnapshotStatus overview={overview} />
            <Button className="w-full" disabled={busy} onClick={onSnapshotNow} size="sm">
              {busy ? (
                <Loader2Icon className="mr-2 size-4 animate-spin" />
              ) : (
                <CameraIcon className="mr-2 size-4" />
              )}
              Snapshot now
            </Button>
          </>
        ) : (
          <div className="col gap-1 text-sm">
            <span>Live from DataForSEO</span>
            <span className="text-muted-foreground text-xs">
              Competitor data is fetched on demand and cached for six hours; only your own
              domain is snapshotted.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
