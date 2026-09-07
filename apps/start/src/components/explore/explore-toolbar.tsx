import { ReportInterval } from '@/components/report/ReportInterval';
import { MetricChartType } from '@/components/report/report-data-source';
import { TimeWindowPicker } from '@/components/time-window-picker';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Tooltiper } from '@/components/ui/tooltip';
import { cn } from '@/utils/cn';
import type { IChartRange, IChartType, IInterval } from '@openpanel/validation';
import {
  HistoryIcon,
  PlayIcon,
  SaveIcon,
  ZoomOutIcon,
} from 'lucide-react';

/**
 * Explore's time and run controls.
 *
 * The interval picker stays beside the range picker (plan decision 5) rather
 * than being replaced by a step field: the interval drives the bucket grid, the
 * table and the x-axis for both data sources, and it is resolved in the
 * project's timezone server-side. A per-query `minStep` is a floor on top of
 * it, and it lives on the query row where the query it applies to is.
 */

/** Off, plus the three intervals worth having on a page you leave open. */
export const REFRESH_INTERVALS = [
  { value: '0', label: 'Off' },
  { value: '10000', label: '10s' },
  { value: '30000', label: '30s' },
  { value: '60000', label: '1m' },
] as const;

interface ExploreToolbarProps {
  range: IChartRange;
  startDate: string | null;
  endDate: string | null;
  interval: IInterval;
  chartType: IChartType;
  refreshMs: number;
  onRangeChange: (range: IChartRange) => void;
  onStartDateChange: (date: string) => void;
  onEndDateChange: (date: string) => void;
  onIntervalChange: (interval: IInterval) => void;
  onChartTypeChange: (chartType: IChartType) => void;
  onRefreshChange: (ms: number) => void;
  /**
   * Undefined until there is a result to zoom out OF. The window comes from the
   * drawn buckets, not from the picker — see `windowFromChart`.
   */
  onZoomOut?: () => void;
  onRun: () => void;
  isRunning: boolean;
  onOpenHistory: () => void;
  onSave: () => void;
  /** False while no query has an expression the server would accept. */
  canSave: boolean;
  className?: string;
}

export function ExploreToolbar({
  range,
  startDate,
  endDate,
  interval,
  chartType,
  refreshMs,
  onRangeChange,
  onStartDateChange,
  onEndDateChange,
  onIntervalChange,
  onChartTypeChange,
  onRefreshChange,
  onZoomOut,
  onRun,
  isRunning,
  onOpenHistory,
  onSave,
  canSave,
  className,
}: ExploreToolbarProps) {
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <MetricChartType onChange={onChartTypeChange} value={chartType} />

      <TimeWindowPicker
        endDate={endDate}
        onChange={onRangeChange}
        onEndDateChange={onEndDateChange}
        onIntervalChange={onIntervalChange}
        onStartDateChange={onStartDateChange}
        startDate={startDate}
        value={range}
      />

      <ReportInterval
        chartType={chartType}
        endDate={endDate}
        interval={interval}
        onChange={onIntervalChange}
        range={range}
        startDate={startDate}
      />

      <Tooltiper
        asChild
        content="Show twice as long a window around what is on screen"
        disabled={!onZoomOut}
      >
        <span>
          <Button
            aria-label="Zoom out"
            disabled={!onZoomOut}
            icon={ZoomOutIcon}
            onClick={onZoomOut}
            variant="outline"
          />
        </span>
      </Tooltiper>

      <Combobox
        className="w-28"
        items={REFRESH_INTERVALS.map((option) => ({
          value: option.value,
          label: option.value === '0' ? 'No refresh' : `Every ${option.label}`,
        }))}
        onChange={(next) => onRefreshChange(Number(next))}
        placeholder="No refresh"
        value={String(refreshMs)}
      />

      <div className="ml-auto flex items-center gap-2">
        <Tooltiper asChild content="Recent queries">
          <Button
            aria-label="Query history"
            icon={HistoryIcon}
            onClick={onOpenHistory}
            variant="outline"
          />
        </Tooltiper>

        <Tooltiper asChild content="Run — or press ⌘/Ctrl + Enter in a query">
          <Button
            icon={PlayIcon}
            loading={isRunning}
            onClick={onRun}
            variant="cta"
          >
            Run
          </Button>
        </Tooltiper>

        <Button
          disabled={!canSave}
          icon={SaveIcon}
          onClick={onSave}
          variant="outline"
        >
          Add to dashboard
        </Button>
      </div>
    </div>
  );
}
