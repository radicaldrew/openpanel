import {
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts';
import type { BacklinkHistoryPoint } from './use-backlinks';
import {
  ChartTooltipHeader,
  ChartTooltipItem,
  createChartTooltip,
} from '@/components/charts/chart-tooltip';
import {
  useYAxisProps,
  X_AXIS_STYLE_PROPS,
} from '@/components/report-chart/common/axis';
import { Skeleton } from '@/components/skeleton';
import { getChartColor } from '@/utils/theme';

const BACKLINKS_COLOR = getChartColor(0);
const DOMAINS_COLOR = getChartColor(1);
const CHART_HEIGHT = 200;

const { TooltipProvider, Tooltip } = createChartTooltip<
  BacklinkHistoryPoint,
  Record<string, unknown>
>(({ data }) => {
  const item = data[0];
  if (!item) {
    return null;
  }
  return (
    <>
      <ChartTooltipHeader>
        <div>{item.date}</div>
      </ChartTooltipHeader>
      <ChartTooltipItem color={BACKLINKS_COLOR}>
        <div className="flex justify-between gap-8 font-medium font-mono">
          <span>Backlinks</span>
          <span>{item.backlinks.toLocaleString()}</span>
        </div>
      </ChartTooltipItem>
      <ChartTooltipItem color={DOMAINS_COLOR}>
        <div className="flex justify-between gap-8 font-medium font-mono">
          <span>Referring domains</span>
          <span>{item.referringDomains.toLocaleString()}</span>
        </div>
      </ChartTooltipItem>
      <div className="mt-1 flex justify-between gap-8 text-muted-foreground text-xs">
        <span>New / lost</span>
        <span className="font-mono">
          +{item.newBacklinks} / −{item.lostBacklinks}
        </span>
      </div>
      <div className="flex justify-between gap-8 text-muted-foreground text-xs">
        <span>Domain rank</span>
        <span className="font-mono">{item.rank}</span>
      </div>
    </>
  );
});

interface Props {
  points: BacklinkHistoryPoint[];
  isLoading: boolean;
  isOwnDomain: boolean;
}

export function BacklinksHistoryChart({ points, isLoading, isOwnDomain }: Props) {
  const yAxisProps = useYAxisProps();

  return (
    <div className="card p-4">
      <div className="mb-4 flex items-center justify-between gap-4">
        <h3 className="font-medium text-sm">Backlinks over time</h3>
        <div className="flex items-center gap-4 text-muted-foreground text-xs">
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block size-2 rounded-full"
              style={{ backgroundColor: BACKLINKS_COLOR }}
            />
            Backlinks
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block size-2 rounded-full"
              style={{ backgroundColor: DOMAINS_COLOR }}
            />
            Referring domains
          </span>
        </div>
      </div>
      {isLoading ? (
        <Skeleton className="h-[200px] w-full" />
      ) : points.length === 0 ? (
        <div
          className="flex items-center justify-center text-muted-foreground text-sm"
          style={{ height: CHART_HEIGHT }}
        >
          {isOwnDomain
            ? 'No snapshots in this range yet. Take one to start the series.'
            : 'DataForSEO has no history for this domain in the range.'}
        </div>
      ) : (
        <TooltipProvider>
          <ResponsiveContainer height={CHART_HEIGHT} width="100%">
            <ComposedChart data={points}>
              <CartesianGrid
                className="stroke-border"
                horizontal
                strokeDasharray="3 3"
                vertical={false}
              />
              <XAxis
                {...X_AXIS_STYLE_PROPS}
                dataKey="date"
                tickFormatter={(value: string) => value.slice(5)}
                type="category"
              />
              <YAxis
                {...yAxisProps}
                tickFormatter={(value: number) => value.toLocaleString()}
                yAxisId="backlinks"
              />
              <YAxis
                {...yAxisProps}
                orientation="right"
                tickFormatter={(value: number) => value.toLocaleString()}
                yAxisId="domains"
              />
              <Tooltip />
              <Line
                dataKey="backlinks"
                dot={false}
                isAnimationActive={false}
                stroke={BACKLINKS_COLOR}
                strokeWidth={2}
                type="monotone"
                yAxisId="backlinks"
              />
              <Line
                dataKey="referringDomains"
                dot={false}
                isAnimationActive={false}
                stroke={DOMAINS_COLOR}
                strokeWidth={2}
                type="monotone"
                yAxisId="domains"
              />
            </ComposedChart>
          </ResponsiveContainer>
        </TooltipProvider>
      )}
    </div>
  );
}
