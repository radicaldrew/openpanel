import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts';
import {
  featureLabel,
  formatPosition,
  notableFeatures,
  type RankHistoryPoint,
  type TrackingRow,
} from './use-tracking';
import {
  ChartTooltipHeader,
  ChartTooltipItem,
  createChartTooltip,
} from '@/components/charts/chart-tooltip';
import { OverviewRange } from '@/components/overview/overview-range';
import { useOverviewOptions } from '@/components/overview/useOverviewOptions';
import {
  useYAxisProps,
  X_AXIS_STYLE_PROPS,
} from '@/components/report-chart/common/axis';
import { Skeleton } from '@/components/skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useTRPC } from '@/integrations/trpc/react';
import { getChartColor } from '@/utils/theme';

type Device = 'desktop' | 'mobile';

interface Props {
  projectId: string;
  row: TrackingRow | null;
  devices: 'both' | 'desktop' | 'mobile';
  onClose: () => void;
}

const DFS_COLOR = getChartColor(0);
const GSC_COLOR = getChartColor(2);

const { TooltipProvider, Tooltip } = createChartTooltip<
  RankHistoryPoint,
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
      <ChartTooltipItem color={DFS_COLOR}>
        <div className="flex justify-between gap-8 font-medium font-mono">
          <span>Tracked</span>
          <span>{formatPosition(item.position)}</span>
        </div>
        {item.url && (
          <div className="max-w-[260px] truncate text-muted-foreground text-xs">
            {item.url}
          </div>
        )}
      </ChartTooltipItem>
      <ChartTooltipItem color={GSC_COLOR}>
        <div className="flex justify-between gap-8 font-medium font-mono">
          <span>Search Console avg</span>
          <span>{item.gscPosition === null ? '—' : `#${item.gscPosition.toFixed(1)}`}</span>
        </div>
      </ChartTooltipItem>
    </>
  );
});

function yDomain(points: RankHistoryPoint[]): [number, number] {
  const values = points.flatMap((point) =>
    [point.position, point.gscPosition].filter((value): value is number => value !== null)
  );
  if (values.length === 0) {
    return [1, 20];
  }
  return [
    Math.max(1, Math.floor(Math.min(...values)) - 1),
    Math.ceil(Math.max(...values)) + 1,
  ];
}

function HistoryChart({
  points,
  isLoading,
}: {
  points: RankHistoryPoint[];
  isLoading: boolean;
}) {
  const yAxisProps = useYAxisProps();

  if (isLoading) {
    return <Skeleton className="h-64 w-full" />;
  }
  if (points.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-muted-foreground text-sm">
        No checks in this range yet.
      </div>
    );
  }

  const [min, max] = yDomain(points);
  const hasGsc = points.some((point) => point.gscPosition !== null);

  return (
    <TooltipProvider>
      <ResponsiveContainer height={260} width="100%">
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
            domain={[min, max]}
            reversed
            tickFormatter={(value: number) => `#${value}`}
          />
          <Tooltip />
          <Line
            connectNulls={false}
            dataKey="position"
            dot={{ r: 2 }}
            isAnimationActive={false}
            stroke={DFS_COLOR}
            strokeWidth={2}
            type="monotone"
          />
          {hasGsc && (
            <Line
              connectNulls
              dataKey="gscPosition"
              dot={false}
              isAnimationActive={false}
              stroke={GSC_COLOR}
              strokeDasharray="5 4"
              strokeWidth={1.5}
              type="monotone"
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </TooltipProvider>
  );
}

function defaultDevice(row: TrackingRow, devices: Props['devices']): Device {
  if (devices === 'mobile') {
    return 'mobile';
  }
  if (devices === 'desktop') {
    return 'desktop';
  }
  return row.desktop ? 'desktop' : row.mobile ? 'mobile' : 'desktop';
}

export function RankHistorySheet({ projectId, row, devices, onClose }: Props) {
  const trpc = useTRPC();
  const { range, startDate, endDate } = useOverviewOptions();
  const [device, setDevice] = useState<Device>('desktop');

  useEffect(() => {
    if (row) {
      setDevice(defaultDevice(row, devices));
    }
  }, [row, devices]);

  const historyQuery = useQuery(
    trpc.seo.tracking.history.queryOptions(
      {
        projectId,
        keyword: row?.keyword ?? '',
        device,
        range,
        startDate,
        endDate,
      },
      { enabled: row !== null }
    )
  );

  const cell = row ? (device === 'desktop' ? row.desktop : row.mobile) : null;
  const features = notableFeatures(cell?.serpFeatures ?? []);

  return (
    <Sheet onOpenChange={(open) => !open && onClose()} open={row !== null}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        {row && (
          <>
            <SheetHeader>
              <SheetTitle className="font-mono">{row.keyword}</SheetTitle>
              <SheetDescription>
                Tracked position with the Search Console average position for
                the same query as a dashed overlay.
              </SheetDescription>
            </SheetHeader>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1">
                {devices !== 'mobile' && (
                  <Button
                    onClick={() => setDevice('desktop')}
                    size="sm"
                    variant={device === 'desktop' ? 'secondary' : 'ghost'}
                  >
                    Desktop
                  </Button>
                )}
                {devices !== 'desktop' && (
                  <Button
                    onClick={() => setDevice('mobile')}
                    size="sm"
                    variant={device === 'mobile' ? 'secondary' : 'ghost'}
                  >
                    Mobile
                  </Button>
                )}
              </div>
              <OverviewRange />
            </div>

            <div className="mt-4 grid grid-cols-3 gap-3">
              <div className="card col gap-1 rounded-md p-3">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
                  Current
                </span>
                <span className="font-mono font-semibold text-xl">
                  {formatPosition(cell?.position)}
                </span>
              </div>
              <div className="card col gap-1 rounded-md p-3">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
                  30 days ago
                </span>
                <span className="font-mono font-semibold text-xl">
                  {formatPosition(cell?.previous30)}
                </span>
              </div>
              <div className="card col gap-1 rounded-md p-3">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
                  Volume
                </span>
                <span className="font-mono font-semibold text-xl">
                  {row.searchVolume === null ? '—' : row.searchVolume.toLocaleString()}
                </span>
              </div>
            </div>

            <div className="card mt-4 rounded-md p-4">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="font-medium text-sm">Position over time</h3>
                <div className="flex items-center gap-3 text-muted-foreground text-xs">
                  <span className="flex items-center gap-1">
                    <span className="h-0.5 w-4" style={{ background: DFS_COLOR }} />
                    Tracked
                  </span>
                  <span className="flex items-center gap-1">
                    <span
                      className="h-0 w-4 border-t border-dashed"
                      style={{ borderColor: GSC_COLOR }}
                    />
                    Search Console
                  </span>
                </div>
              </div>
              <HistoryChart
                isLoading={historyQuery.isLoading}
                points={historyQuery.data ?? []}
              />
            </div>

            <div className="col mt-4 gap-2 text-sm">
              {cell?.url && (
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-muted-foreground">Ranking URL</span>
                  <a
                    className="truncate underline-offset-2 hover:underline"
                    href={cell.url}
                    rel="noopener"
                    target="_blank"
                  >
                    {cell.url}
                  </a>
                </div>
              )}
              {features.length > 0 && (
                <div className="flex flex-wrap items-center gap-1">
                  <span className="mr-1 text-muted-foreground">SERP features</span>
                  {features.map((feature) => (
                    <Badge className="font-normal" key={feature} variant="secondary">
                      {featureLabel(feature)}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
