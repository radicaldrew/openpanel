import { useQuery } from '@tanstack/react-query';
import { Area, CartesianGrid, ComposedChart, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { percentChange } from './use-ai';
import {
  ChartTooltipHeader,
  ChartTooltipItem,
  createChartTooltip,
} from '@/components/charts/chart-tooltip';
import { DeltaChip } from '@/components/delta-chip';
import { OverviewRange } from '@/components/overview/overview-range';
import { useOverviewOptions } from '@/components/overview/useOverviewOptions';
import {
  useYAxisProps,
  X_AXIS_STYLE_PROPS,
} from '@/components/report-chart/common/axis';
import { Skeleton } from '@/components/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useNumber } from '@/hooks/use-numer-formatter';
import { useTRPC } from '@/integrations/trpc/react';
import { getChartColor } from '@/utils/theme';

interface Point {
  date: string;
  sessions: number;
}

const COLOR = getChartColor(2);

const { TooltipProvider, Tooltip } = createChartTooltip<Point, Record<string, unknown>>(
  ({ data }) => {
    const item = data[0];
    if (!item) {
      return null;
    }
    return (
      <>
        <ChartTooltipHeader>
          <div>{item.date}</div>
        </ChartTooltipHeader>
        <ChartTooltipItem color={COLOR}>
          <div className="flex justify-between gap-8 font-medium font-mono">
            <span>Sessions</span>
            <span>{item.sessions.toLocaleString()}</span>
          </div>
        </ChartTooltipItem>
      </>
    );
  }
);

function Change({ current, previous }: { current: number; previous: number }) {
  const change = percentChange(current, previous);
  if (change === null) {
    return <span className="text-muted-foreground text-xs">—</span>;
  }
  return (
    <DeltaChip size="xs" variant={change > 0 ? 'inc' : change < 0 ? 'dec' : 'default'}>
      {Math.abs(change).toFixed(0)}%
    </DeltaChip>
  );
}

/** Right column: traffic FROM AI answers (OpenPanel sessions by referrer). */
export function AiTrafficPanel({ projectId }: { projectId: string }) {
  const trpc = useTRPC();
  const number = useNumber();
  const yAxisProps = useYAxisProps();
  const { range, startDate, endDate } = useOverviewOptions();

  const query = useQuery(
    trpc.seo.ai.traffic.queryOptions({ projectId, range, startDate, endDate })
  );
  const data = query.data;

  return (
    <div className="col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-medium">Traffic from AI answers</h2>
          <p className="text-muted-foreground text-sm">
            Sessions on your site referred by AI assistants, from your own
            OpenPanel data.
          </p>
        </div>
        <OverviewRange />
      </div>

      {query.isLoading || !data ? (
        <Skeleton className="h-64 w-full" />
      ) : query.isError ? (
        <p className="text-destructive text-sm">{query.error.message}</p>
      ) : (
        <>
          <div className="card rounded-md p-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="col gap-0.5">
                <span className="font-medium text-[10px] text-muted-foreground uppercase tracking-wider">
                  AI-referred sessions
                </span>
                <span className="font-mono font-semibold text-2xl tabular-nums">
                  {number.short(data.total)}
                </span>
              </div>
              <div className="col items-end gap-1 text-xs">
                <Change current={data.total} previous={data.previousTotal} />
                <span className="text-muted-foreground">
                  vs {number.short(data.previousTotal)} previous period
                </span>
              </div>
            </div>
            {data.series.length === 0 ? (
              <div className="flex h-40 items-center justify-center text-muted-foreground text-sm">
                No AI-referred sessions in this range.
              </div>
            ) : (
              <TooltipProvider>
                <ResponsiveContainer height={160} width="100%">
                  <ComposedChart data={data.series}>
                    <defs>
                      <linearGradient id="ai-traffic-fill" x1="0" x2="0" y1="0" y2="1">
                        <stop offset="0%" stopColor={COLOR} stopOpacity={0.35} />
                        <stop offset="100%" stopColor={COLOR} stopOpacity={0} />
                      </linearGradient>
                    </defs>
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
                    <YAxis {...yAxisProps} allowDecimals={false} />
                    <Tooltip />
                    <Area
                      dataKey="sessions"
                      fill="url(#ai-traffic-fill)"
                      isAnimationActive={false}
                      stroke={COLOR}
                      strokeWidth={2}
                      type="monotone"
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </TooltipProvider>
            )}
          </div>

          <div className="card overflow-hidden rounded-md">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Engine</TableHead>
                  <TableHead className="text-right">Sessions</TableHead>
                  <TableHead className="text-right">Previous</TableHead>
                  <TableHead className="text-right">Change</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.engines.length === 0 && (
                  <TableRow>
                    <TableCell className="py-8 text-center text-muted-foreground" colSpan={4}>
                      No AI engine has sent traffic yet.
                    </TableCell>
                  </TableRow>
                )}
                {data.engines.map((engine) => (
                  <TableRow key={engine.engine}>
                    <TableCell>
                      <div className="col">
                        <span className="font-medium">{engine.label}</span>
                        <span className="font-mono text-muted-foreground text-xs">
                          {engine.engine}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {number.format(engine.sessions)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-muted-foreground tabular-nums">
                      {number.format(engine.previousSessions)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end">
                        <Change current={engine.sessions} previous={engine.previousSessions} />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}
