import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import type { ShareOfVoice } from './use-tracking';
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
import { Button } from '@/components/ui/button';
import { useAppParams } from '@/hooks/use-app-params';
import { useTRPC } from '@/integrations/trpc/react';
import { getChartColor } from '@/utils/theme';

const OTHER = 'other';
const OTHER_COLOR = 'var(--muted-foreground)';

type SeriesPoint = ShareOfVoice['series'][number];

function colorFor(domain: string, index: number): string {
  return domain === OTHER ? OTHER_COLOR : getChartColor(index);
}

const { TooltipProvider, Tooltip } = createChartTooltip<
  SeriesPoint,
  { domains: string[] }
>(({ data, context }) => {
  const item = data[0];
  if (!item) {
    return null;
  }
  return (
    <>
      <ChartTooltipHeader>
        <div>{item.date}</div>
      </ChartTooltipHeader>
      {context.domains.map((domain, index) => (
        <ChartTooltipItem color={colorFor(domain, index)} key={domain}>
          <div className="flex justify-between gap-8 font-medium font-mono">
            <span>{domain}</span>
            <span>{(item.values[domain] ?? 0).toFixed(1)}%</span>
          </div>
        </ChartTooltipItem>
      ))}
    </>
  );
});

/** Recharts wants flat keys; lift `values` onto the point. */
function flatten(series: ShareOfVoice['series']) {
  return series.map((point) => ({ ...point, ...point.values }));
}

export function CompetitorsView({ competitors }: { competitors: string[] }) {
  const { organizationId, projectId } = useAppParams();
  const navigate = useNavigate();
  const trpc = useTRPC();
  const yAxisProps = useYAxisProps();
  const { range, startDate, endDate } = useOverviewOptions();

  const query = useQuery(
    trpc.seo.tracking.competitors.queryOptions({
      projectId,
      range,
      startDate,
      endDate,
    })
  );

  const data = query.data;
  const domains = data?.domains ?? [];

  return (
    <div className="col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">
          Share of voice: CTR-weighted presence in the top 10 across every
          tracked keyword, by day.
        </p>
        <OverviewRange />
      </div>

      {competitors.length === 0 && (
        <div className="card flex flex-wrap items-center justify-between gap-3 rounded-md p-4 text-sm">
          <span>
            No competitors configured. Add competitor domains to compare against
            them; until then everything except your own domain counts as
            "other".
          </span>
          <Button
            onClick={() =>
              navigate({
                to: '/$organizationId/$projectId/settings/dataforseo',
                params: { organizationId, projectId },
              })
            }
            size="sm"
            variant="outline"
          >
            Configure competitors
          </Button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        <div className="card rounded-md p-4 lg:col-span-3">
          {query.isLoading || !data ? (
            <Skeleton className="h-72 w-full" />
          ) : data.series.length === 0 ? (
            <div className="flex h-72 items-center justify-center text-muted-foreground text-sm">
              No rank checks in this range yet.
            </div>
          ) : (
            <TooltipProvider domains={domains}>
              <ResponsiveContainer height={288} width="100%">
                <BarChart data={flatten(data.series)}>
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
                    domain={[0, 100]}
                    tickFormatter={(value: number) => `${value}%`}
                  />
                  <Tooltip />
                  {domains.map((domain, index) => (
                    <Bar
                      dataKey={domain}
                      fill={colorFor(domain, index)}
                      isAnimationActive={false}
                      key={domain}
                      stackId="sov"
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </TooltipProvider>
          )}
        </div>

        <div className="card col gap-3 rounded-md p-4">
          <h3 className="font-medium text-sm">Whole range</h3>
          {query.isLoading || !data ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <ul className="col gap-2">
              {domains.map((domain, index) => {
                const share = data.totals[domain] ?? 0;
                return (
                  <li className="col gap-1" key={domain}>
                    <div className="flex items-center justify-between gap-2 text-sm">
                      <span className="flex min-w-0 items-center gap-2">
                        <span
                          className="size-2.5 shrink-0 rounded-sm"
                          style={{ background: colorFor(domain, index) }}
                        />
                        <span className="truncate font-mono">{domain}</span>
                      </span>
                      <span className="font-mono tabular-nums">{share.toFixed(1)}%</span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${Math.min(100, share)}%`,
                          background: colorFor(domain, index),
                        }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
