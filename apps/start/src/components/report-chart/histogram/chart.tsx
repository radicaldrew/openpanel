import { useRechartDataModel } from '@/hooks/use-rechart-data-model';
import { useTheme } from '@/hooks/use-theme';
import { useVisibleSeries } from '@/hooks/use-visible-series';
import { useTRPC } from '@/integrations/trpc/react';
import { pushModal } from '@/modals';
import { useDispatch } from '@/redux';
import type { IChartData } from '@/trpc/client';
import { chartDateToIso } from '@/utils/chart-dates';
import { cn } from '@/utils/cn';
import { getChartColor } from '@/utils/theme';
import { useQuery } from '@tanstack/react-query';
import { BookmarkIcon, UsersIcon } from 'lucide-react';
import React, { useCallback, useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { changeVisibleSeries } from '@/components/report/reportSlice';
import { useXAxisProps, useYAxisProps } from '../common/axis';
import { serieColorIndex, seriesColorIndexes } from '../common/series-color';
import { axisUnit, seriesPanels } from '../common/series-units';
import {
  ChartClickMenu,
  type ChartClickMenuItem,
} from '../common/chart-click-menu';
import { ReportChartTooltip } from '../common/report-chart-tooltip';
import { ReportTable } from '../common/report-table';
import { useReportChartContext } from '../context';

interface Props {
  data: IChartData;
}

function BarHover({ x, y, width, height, top, left, right, bottom }: any) {
  const themeMode = useTheme();
  const styles = getComputedStyle(document.documentElement);
  const def100 = styles.getPropertyValue('--def-100');
  const def300 = styles.getPropertyValue('--def-300');
  const bg = themeMode?.theme === 'dark' ? def100 : def300;
  return (
    <rect
      {...{ x, y, width, height, top, left, right, bottom }}
      rx="3"
      fill={bg}
      fillOpacity={0.5}
    />
  );
}

export function Chart({ data }: Props) {
  const {
    isEditMode,
    report: {
      previous,
      interval,
      projectId,
      startDate,
      endDate,
      range,
      series: reportSeries,
      breakdowns,
      options: reportOptions,
      visibleSeries: savedVisibleSeries,
    },
    options: { hideXAxis, hideYAxis, extraMenuItems },
  } = useReportChartContext();
  const dispatch = useDispatch();

  const histogramOptions =
    reportOptions?.type === 'histogram' ? reportOptions : undefined;
  const isStacked = histogramOptions?.stacked ?? false;
  const trpc = useTRPC();
  const references = useQuery(
    trpc.reference.getChartReferences.queryOptions({
      projectId,
      startDate,
      endDate,
      range,
    }),
  );
  const { series, setVisibleSeries } = useVisibleSeries(data, {
    savedVisibleSeries,
    onVisibleSeriesChange: isEditMode
      ? (ids) => dispatch(changeVisibleSeries(ids))
      : undefined,
  });
  const rechartData = useRechartDataModel(series);

  const colorIndexes = useMemo(
    () => seriesColorIndexes(data.series),
    [data.series],
  );
  const panels = useMemo(() => seriesPanels(data.series), [data.series]);

  // Series id to its labels, so a click can be resolved back to the service it
  // belongs to — see the same map on the line chart.
  const labelsById = useMemo(
    () =>
      new Map(
        data.series.map((serie) => [serie.id, serie.event.breakdowns ?? {}]),
      ),
    [data.series],
  );

  // Resolved here, where both the identity map and each series' index are in
  // hand, so the tooltip's swatch cannot drift from the line it describes.
  const seriesColors = useMemo(
    () =>
      new Map(
        series.map((serie) => [
          serie.id,
          getChartColor(serieColorIndex(serie, colorIndexes)),
        ]),
      ),
    [series, colorIndexes],
  );

  // Bars share ONE axis. A right-hand axis would have to rescale half the bars
  // against a different baseline, and two bars of the same height meaning
  // different quantities is worse than one axis that a series does not suit —
  // so `yAxis: 'right'` is honoured on the line and area charts only. The unit
  // still applies: the ticks read `34 ms` whichever axis the query asked for.
  const yAxisProps = useYAxisProps({
    hide: hideYAxis,
    unit: axisUnit(series, 'left') ?? axisUnit(series, 'right'),
  });
  const xAxisProps = useXAxisProps({
    hide: hideXAxis,
    interval,
  });

  const getMenuItems = useCallback(
    (e: any, clickedData: any): ChartClickMenuItem[] => {
      const items: ChartClickMenuItem[] = [];

      if (!clickedData?.date) {
        return items;
      }

      // Which bar was under the cursor. `activePayload` carries one entry per
      // series at that x, and the data keys are `${serieId}:count`.
      const serieId = e.activePayload
        ?.find(
          (p: any) =>
            typeof p?.dataKey === 'string' && p.dataKey.includes(':count'),
        )
        ?.dataKey?.toString()
        .replace(':count', '');

      // View Users - only show if we have projectId
      if (projectId) {
        items.push({
          label: 'View Users',
          icon: <UsersIcon size={16} />,
          onClick: () => {
            pushModal('ViewChartUsers', {
              type: 'chart',
              chartData: data,
              report: {
                projectId,
                series: reportSeries,
                breakdowns: breakdowns || [],
                interval,
                startDate,
                endDate,
                range,
                previous,
                chartType: 'histogram',
                metric: 'sum',
              },
              date: clickedData.date,
            });
          },
        });
      }

      // Add Reference - always show
      items.push({
        label: 'Add Reference',
        icon: <BookmarkIcon size={16} />,
        onClick: () => {
          pushModal('AddReference', {
            // Through the shared reader: `clickedData.date` is a bucket
            // string with no zone marker, and `new Date()` reads it as LOCAL
            // time. This value is PERSISTED, so the shift does not just move
            // the view — it writes the reference to the wrong instant, and it
            // stays wrong afterwards for everyone, including viewers in UTC
            // who could never have produced it.
            datetime: chartDateToIso(clickedData.date),
          });
        },
      });

      // Appended LAST so the entries people already reach for do not move
      // under the cursor when a panel gains correlation links.
      items.push(
        ...(extraMenuItems?.({
          date: clickedData.date,
          serieId,
          panel: serieId ? panels.get(serieId) : undefined,
          labels: serieId ? labelsById.get(serieId) : undefined,
        }) ?? []),
      );

      return items;
    },
    [
      projectId,
      data,
      reportSeries,
      breakdowns,
      interval,
      startDate,
      endDate,
      range,
      previous,
      extraMenuItems,
      panels,
      labelsById,
    ],
  );

  return (
    <ReportChartTooltip.TooltipProvider
      references={references.data}
      panels={panels}
      seriesColors={seriesColors}
    >
      <ChartClickMenu getMenuItems={getMenuItems}>
        <div className={cn('h-full w-full', isEditMode && 'card p-4')}>
          <ResponsiveContainer>
            <BarChart data={rechartData}>
              <CartesianGrid
                strokeDasharray="3 3"
                vertical={false}
                className="stroke-def-200"
              />
              <Tooltip
                content={<ReportChartTooltip.Tooltip />}
                cursor={<BarHover />}
              />
              <YAxis {...yAxisProps} />
              <XAxis {...xAxisProps} scale={'auto'} type="category" />
              {previous
                ? series.map((serie) => {
                    return (
                      <Bar
                        key={`${serie.id}:prev`}
                        name={`${serie.id}:prev`}
                        dataKey={`${serie.id}:prev:count`}
                        fill={getChartColor(serieColorIndex(serie, colorIndexes))}
                        fillOpacity={0.3}
                        radius={5}
                        stackId={isStacked ? 'prev' : undefined}
                      />
                    );
                  })
                : null}
              {series.map((serie) => {
                return (
                  <Bar
                    key={serie.id}
                    name={serie.id}
                    dataKey={`${serie.id}:count`}
                    fill={getChartColor(serieColorIndex(serie, colorIndexes))}
                    radius={isStacked ? 0 : 4}
                    fillOpacity={1}
                    stackId={isStacked ? 'current' : undefined}
                  />
                );
              })}
              {references.data?.map((ref) => (
                <ReferenceLine
                  key={ref.id}
                  x={ref.date.getTime()}
                  stroke={'oklch(from var(--foreground) l c h / 0.1)'}
                  strokeDasharray={'3 3'}
                  label={{
                    value: ref.title,
                    position: 'centerTop',
                    fill: '#334155',
                    fontSize: 12,
                  }}
                  fontSize={10}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
        {isEditMode && (
          <ReportTable
            data={data}
            visibleSeries={series}
            setVisibleSeries={setVisibleSeries}
          />
        )}
      </ChartClickMenu>
    </ReportChartTooltip.TooltipProvider>
  );
}
