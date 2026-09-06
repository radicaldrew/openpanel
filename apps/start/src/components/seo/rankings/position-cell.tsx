import { formatPosition, type TrackingDeviceCell } from './use-tracking';
import { DeltaChip } from '@/components/delta-chip';
import { Tooltiper } from '@/components/ui/tooltip';
import { cn } from '@/utils/cn';

interface Props {
  cell: TrackingDeviceCell | null;
  serpDepth: number;
  window: '7d' | '30d';
}

function deltaTooltip(
  window: Props['window'],
  previous: number | null,
  delta: number | null
): string {
  const label = window === '7d' ? '7 days ago' : '30 days ago';
  if (delta === null) {
    return previous === null ? `Not ranked ${label}` : `Was ${formatPosition(previous)} ${label}`;
  }
  if (delta === 0) {
    return `Unchanged since ${label}`;
  }
  return `${delta > 0 ? 'Up' : 'Down'} ${Math.abs(delta)} from ${formatPosition(previous)} ${label}`;
}

/**
 * Position for one device plus the movement since the chosen window. A
 * positive delta is an improvement (the keyword moved up the page), so the
 * chip is green for positive and red for negative.
 */
export function PositionCell({ cell, serpDepth, window }: Props) {
  if (!cell) {
    return <span className="text-muted-foreground">—</span>;
  }

  const delta = window === '7d' ? cell.delta7 : cell.delta30;
  const previous = window === '7d' ? cell.previous7 : cell.previous30;
  const ranked = cell.position !== null;

  return (
    <div className="flex items-center gap-2">
      <Tooltiper
        content={
          ranked
            ? `Checked ${cell.checkedAt}`
            : `Not in the top ${serpDepth} (checked ${cell.checkedAt})`
        }
      >
        <span
          className={cn(
            'font-mono tabular-nums',
            ranked ? 'font-medium' : 'text-muted-foreground'
          )}
        >
          {formatPosition(cell.position)}
        </span>
      </Tooltiper>
      {delta !== null && (
        <Tooltiper content={deltaTooltip(window, previous, delta)}>
          <div>
            <DeltaChip
              size="xs"
              variant={delta > 0 ? 'inc' : delta < 0 ? 'dec' : 'default'}
            >
              {delta === 0 ? '0' : Math.abs(delta)}
            </DeltaChip>
          </div>
        </Tooltiper>
      )}
    </div>
  );
}
