import { Loader2Icon, PlayIcon } from 'lucide-react';
import type { TrackingSummary } from './use-tracking';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Tooltiper } from '@/components/ui/tooltip';
import { timeAgo } from '@/utils/date';

interface Props {
  summary: TrackingSummary;
  onCheckNow: () => void;
  isStarting: boolean;
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <Tooltiper content={hint}>
      <div className="col gap-1 border-border border-r px-4 py-3 last:border-r-0">
        <span className="truncate font-medium text-[10px] text-muted-foreground uppercase tracking-wider">
          {label}
        </span>
        <span className="font-mono font-semibold text-2xl tabular-nums">
          {value}
        </span>
      </div>
    </Tooltiper>
  );
}

function RunStatus({ summary }: { summary: TrackingSummary }) {
  const { activeRun, lastRun } = summary;

  if (activeRun) {
    const total = Math.max(activeRun.keywordsTotal, 1);
    const percent = Math.min(100, (activeRun.keywordsChecked / total) * 100);
    return (
      <div className="col gap-1.5">
        <div className="flex items-center gap-2 text-sm">
          <Loader2Icon className="size-3.5 animate-spin" />
          <span>
            {activeRun.status === 'pending'
              ? 'Queued'
              : `Checking ${activeRun.keywordsChecked} / ${activeRun.keywordsTotal}`}
          </span>
        </div>
        <Progress className="h-1.5" value={percent} />
      </div>
    );
  }

  if (lastRun?.completedAt) {
    return (
      <div className="col gap-0.5 text-sm">
        <span>
          Last check {timeAgo(lastRun.completedAt)}
          {lastRun.costUsd > 0 && (
            <span className="text-muted-foreground">
              {' '}
              · ${lastRun.costUsd.toFixed(3)}
            </span>
          )}
        </span>
        {lastRun.error && (
          <span className="text-muted-foreground text-xs">{lastRun.error}</span>
        )}
      </div>
    );
  }

  return <span className="text-muted-foreground text-sm">No checks yet</span>;
}

export function RankingsSummaryCards({ summary, onCheckNow, isStarting }: Props) {
  const busy = isStarting || summary.activeRun !== null;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
      <div className="card col-span-1 grid grid-cols-2 overflow-hidden rounded-md sm:grid-cols-5 lg:col-span-3">
        <Stat
          hint="Mean of the best position across devices, ranked keywords only"
          label="Avg position"
          value={
            summary.avgPosition === null ? '—' : `#${summary.avgPosition.toFixed(1)}`
          }
        />
        <Stat
          hint="Keywords ranking in the top 3"
          label="Top 3"
          value={String(summary.top3)}
        />
        <Stat
          hint="Keywords ranking in the top 10"
          label="Top 10"
          value={String(summary.top10)}
        />
        <Stat
          hint="Keywords ranking in the top 20"
          label="Top 20"
          value={String(summary.top20)}
        />
        <Stat
          hint="Search-volume-weighted click-through of your positions. 100 = every keyword at #1."
          label="Visibility"
          value={
            summary.visibility === null ? '—' : `${summary.visibility.toFixed(1)}%`
          }
        />
      </div>
      <div className="card col justify-between gap-3 rounded-md p-4">
        <RunStatus summary={summary} />
        <Button
          className="w-full"
          disabled={busy || summary.total === 0}
          onClick={onCheckNow}
          size="sm"
        >
          {busy ? (
            <Loader2Icon className="mr-2 size-4 animate-spin" />
          ) : (
            <PlayIcon className="mr-2 size-4" />
          )}
          Check now
        </Button>
      </div>
    </div>
  );
}
