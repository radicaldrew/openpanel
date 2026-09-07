import {
  seriesColorIndexes,
  serieColorIndex,
} from '@/components/report-chart/common/series-color';
import { lastValue } from '@/components/report-chart/common/series-units';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/utils/cn';
import { getChartColor } from '@/utils/theme';
import { formatValue } from '@openpanel/common';
import type { FinalChart } from '@openpanel/validation';
import { useMemo } from 'react';

/**
 * Every series the panel returned, with its labels and its latest value.
 *
 * The chart draws a handful of series legibly and then stops; a query that
 * matched forty is exactly the query whose result you need to read. So the
 * table lists all of them and clicking a row toggles whether it is drawn,
 * which makes the chart a view onto this rather than the other way round.
 *
 * Colours come from the same functions the chart uses, keyed on the series id,
 * so a row's swatch is the line's colour whether or not the line is currently
 * drawn.
 */

interface ExploreResultTableProps {
  chart: FinalChart;
  visibleSeriesIds: string[];
  onToggle: (id: string) => void;
  className?: string;
}

export function ExploreResultTable({
  chart,
  visibleSeriesIds,
  onToggle,
  className,
}: ExploreResultTableProps) {
  const colorIndexes = useMemo(
    () => seriesColorIndexes(chart.series),
    [chart.series],
  );

  const visible = useMemo(
    () => new Set(visibleSeriesIds),
    [visibleSeriesIds],
  );

  if (chart.series.length === 0) {
    return null;
  }

  return (
    <div className={cn('overflow-x-auto rounded-lg border', className)}>
      <table className="w-full text-sm">
        <caption className="sr-only">
          Series returned by this panel. Select a row to show or hide it on the
          chart.
        </caption>
        <thead>
          <tr className="border-b text-left text-muted-foreground text-xs">
            <th className="px-3 py-2 font-medium" scope="col">
              Series
            </th>
            <th className="px-3 py-2 font-medium" scope="col">
              Labels
            </th>
            <th className="px-3 py-2 text-right font-medium" scope="col">
              Last
            </th>
          </tr>
        </thead>
        <tbody>
          {chart.series.map((serie, index) => {
            const shown = visible.has(serie.id);
            const color = getChartColor(
              serieColorIndex({ id: serie.id, index }, colorIndexes),
            );
            const value = lastValue(serie);
            const labels = Object.entries(serie.event.breakdowns ?? {});

            return (
              <tr
                className={cn(
                  'cursor-pointer border-b last:border-b-0 hover:bg-def-200',
                  !shown && 'opacity-50',
                )}
                key={serie.id}
                onClick={() => onToggle(serie.id)}
              >
                <td className="px-3 py-2">
                  {/* The row is the control. A checkbox inside a clickable row
                      is two controls doing one job, and the second one is the
                      one screen readers announce. */}
                  <button
                    aria-pressed={shown}
                    className="flex min-w-0 items-center gap-2 text-left"
                    onClick={(event) => {
                      event.stopPropagation();
                      onToggle(serie.id);
                    }}
                    type="button"
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'size-2.5 shrink-0 rounded-full',
                        !shown && 'opacity-40',
                      )}
                      style={{ backgroundColor: color }}
                    />
                    {serie.panel?.refId && (
                      <Badge className="font-mono" variant="outline">
                        {serie.panel.refId}
                      </Badge>
                    )}
                    <span className="truncate">{serie.names.join(' · ')}</span>
                  </button>
                </td>
                <td className="px-3 py-2 font-mono text-muted-foreground text-xs">
                  {labels.length === 0 ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    labels
                      .map(([key, labelValue]) => `${key}="${labelValue}"`)
                      .join(', ')
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right font-mono">
                  {value === undefined
                    ? '—'
                    : formatValue(value, serie.panel?.unit ?? 'none')}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
