import {
  fancyMinutes,
  useNumber,
  useUnitFormat,
} from '@/hooks/use-numer-formatter';
import type { IChartData } from '@/trpc/client';
import { cn } from '@/utils/cn';
import AutoSizer from 'react-virtualized-auto-sizer';
import { Area, AreaChart, Tooltip } from 'recharts';

import type { IChartMetric, IPromqlUnit } from '@openpanel/validation';
import { lastValue } from '../common/series-units';

import {
  ChartTooltipContainer,
  ChartTooltipHeader,
  ChartTooltipItem,
} from '@/components/charts/chart-tooltip';
import { formatDate } from '@/utils/date';
import { getChartColor } from '@/utils/theme';
import {
  PreviousDiffIndicator,
  getDiffIndicator,
} from '../common/previous-diff-indicator';
import { SerieName } from '../common/serie-name';
import { useReportChartContext } from '../context';

interface MetricCardProps {
  serie: IChartData['series'][number];
  color?: string;
  metric: IChartMetric;
  unit?: string;
}

const TooltipContent = (props: {
  payload?: any[];
  unit?: IPromqlUnit;
}) => {
  const number = useNumber();
  const unitFormat = useUnitFormat();
  return (
    <ChartTooltipContainer>
      {props.payload?.map((item) => {
        const { date, count } = item.payload;
        return (
          <div key={item.id} className="col gap-2">
            <ChartTooltipHeader>
              <div>{formatDate(new Date(date))}</div>
            </ChartTooltipHeader>
            <ChartTooltipItem color={getChartColor(0)}>
              <div>
                {props.unit ? unitFormat.full(count, props.unit) : number.format(count)}
              </div>
            </ChartTooltipItem>
          </div>
        );
      })}
    </ChartTooltipContainer>
  );
};

export function MetricCard({
  serie,
  color: _color,
  metric,
  unit,
}: MetricCardProps) {
  const { isEditMode } = useReportChartContext();
  const number = useNumber();
  const unitFormat = useUnitFormat();

  /**
   * A stat card answers "what is it right now".
   *
   * For a metrics panel that is the LAST point, not the report's aggregation:
   * the sum of every p95 sample in a window is not a latency, and an `instant`
   * query returns a single point that is both the last one and the only one.
   * An events report keeps `report.metric` — its cards have always shown the
   * chosen aggregation and nothing about that changes.
   */
  const panelUnit = serie.panel?.unit;
  const value = serie.panel ? lastValue(serie) : serie.metrics[metric];

  const renderValue = (value: number | undefined, unitClassName?: string) => {
    // A genuine 0 is a real value, not a missing one — `min` is 0 whenever the
    // range contains an empty bucket. Only absent metrics render as N/A, which
    // still matters: getAggregateChartSql never selects total_count, so `count`
    // really is undefined for bar/pie series.
    if (value === undefined || value === null) {
      return <div className="text-muted-foreground">N/A</div>;
    }

    // A typed panel unit already carries its own suffix — `34 ms`, `3 GiB` —
    // so it must not also get the legacy free-string appended after it.
    if (panelUnit) {
      return <>{unitFormat.full(value, panelUnit)}</>;
    }

    if (unit === 'min') {
      return <>{fancyMinutes(value)}</>;
    }

    return (
      <>
        {number.short(value)}
        {unit && <span className={unitClassName}>{unit}</span>}
      </>
    );
  };

  const previous = serie.metrics.previous?.[metric];

  const graphColors = getDiffIndicator(
    false,
    previous?.state,
    '#6ee7b7', // green
    '#fda4af', // red
    '#93c5fd', // blue
  );

  return (
    <div
      className={cn(
        'group relative p-4 hover:z-10',
        isEditMode && 'card h-auto',
      )}
      key={serie.id}
    >
      <div
        className={cn(
          'absolute -left-1 -right-1 bottom-0 top-0 z-0 opacity-100 transition-opacity duration-300 group-hover:opacity-100',
        )}
      >
        <AutoSizer>
          {({ width, height }) => (
            <AreaChart
              width={width}
              height={height / 4}
              data={serie.data}
              style={{ marginTop: (height / 4) * 3 }}
            >
              <defs>
                <linearGradient
                  id={`colorUv${serie.id}`}
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop offset="0%" stopColor={graphColors} stopOpacity={0.2} />
                  <stop
                    offset="100%"
                    stopColor={graphColors}
                    stopOpacity={0.05}
                  />
                </linearGradient>
              </defs>
              <Tooltip
                content={(tooltipProps) => (
                  <TooltipContent {...tooltipProps} unit={panelUnit} />
                )}
              />
              <Area
                dataKey="count"
                type="step"
                fill={`url(#colorUv${serie.id})`}
                fillOpacity={1}
                stroke={graphColors}
                strokeWidth={1}
                isAnimationActive={false}
              />
            </AreaChart>
          )}
        </AutoSizer>
      </div>
      <MetricCardNumber
        label={<SerieName name={serie.names} />}
        value={renderValue(value, 'ml-1 font-light text-xl')}
        enhancer={
          <PreviousDiffIndicator
            {...previous}
            className="text-sm text-muted-foreground"
          />
        }
      />
    </div>
  );
}

export function MetricCardNumber({
  label,
  value,
  enhancer,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  enhancer?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-2', className)}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-left">
          <span className="truncate text-muted-foreground">{label}</span>
        </div>
      </div>
      <div className="flex items-end justify-between gap-4">
        <div className="truncate font-mono text-3xl font-bold">{value}</div>
        {enhancer}
      </div>
    </div>
  );
}
