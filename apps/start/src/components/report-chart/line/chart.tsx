import { useRechartDataModel } from '@/hooks/use-rechart-data-model';
import { useVisibleSeries } from '@/hooks/use-visible-series';
import { useTRPC } from '@/integrations/trpc/react';
import { pushModal } from '@/modals';
import { useDispatch } from '@/redux';
import type { IChartData } from '@/trpc/client';
import { chartDateToIso, parseChartDate } from '@/utils/chart-dates';
import { cn } from '@/utils/cn';
import { getChartColor } from '@/utils/theme';
import { useQuery } from '@tanstack/react-query';
import { isSameDay, isSameHour, isSameMonth, isSameWeek } from 'date-fns';
import { BookmarkIcon, UsersIcon } from 'lucide-react';
import { last } from 'ramda';
import { useCallback, useMemo } from 'react';
import {
  CartesianGrid,
  ComposedChart,
  Customized,
  Legend,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { changeVisibleSeries } from '@/components/report/reportSlice';
import { useDashedStroke } from '@/hooks/use-dashed-stroke';
import { useXAxisProps, useYAxisProps } from '../common/axis';
import { useRangeSelect } from '../common/use-range-select';
import { serieColorIndex, seriesColorIndexes } from '../common/series-color';
import {
  axisUnit,
  hasRightAxis,
  serieAxis,
  seriesPanels,
} from '../common/series-units';
import {
  ChartClickMenu,
  type ChartClickMenuItem,
} from '../common/chart-click-menu';
import { ReportChartTooltip } from '../common/report-chart-tooltip';
import { ReportTable } from '../common/report-table';
import { SerieIcon } from '../common/serie-icon';
import { SerieName } from '../common/serie-name';
import { useReportChartContext } from '../context';

interface Props {
  data: IChartData;
  /**
   * Markers rendered as DIRECT children of the Recharts chart element.
   *
   * `ReferenceLine` and `ReferenceArea` read the axis scales off Recharts' own
   * context, so they only position correctly when Recharts owns them.
   *
   * An ARRAY, not a `ReactNode`. A fragment renders NOTHING here: the
   * categorical chart resolves its children by type and does not flatten
   * `<>…</>`, so `<>{markers}</>` is silently dropped — an empty plot with no
   * error, indistinguishable from having no annotations. A wrapper component
   * is invisible for the same reason. Typing this as an array makes that a
   * compile error instead of a blank chart. Measured against recharts 2.15.4
   * by rendering, not by reading the source.
   */
  annotations?: React.ReactNode[];
}

export function Chart({ data, annotations }: Props) {
  const {
    report: {
      previous,
      interval,
      projectId,
      startDate,
      endDate,
      range,
      lineType,
      series: reportSeries,
      breakdowns,
      visibleSeries: savedVisibleSeries,
    },
    isEditMode,
    options: { hideXAxis, hideYAxis, maxDomain,
      onRangeSelect,
      onModifierClick,
      extraMenuItems,
    },
  } = useReportChartContext();
  const dispatch = useDispatch();
  const dataLength = data.series[0]?.data?.length || 0;
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

  // Computed over EVERY series, not the visible subset, so toggling a series
  // off in the table does not recolour the ones left on the chart.
  const colorIndexes = useMemo(
    () => seriesColorIndexes(data.series),
    [data.series],
  );
  const panels = useMemo(() => seriesPanels(data.series), [data.series]);

  // Series id to its labels, so a click can be resolved back to the service it
  // belongs to. Built over EVERY series, not the visible subset, because a
  // click resolves an id from the payload regardless of the table's ticks.
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
  const rangeSelect = useRangeSelect(onRangeSelect);
  const showRightAxis = hasRightAxis(series);
  const leftUnit = axisUnit(series, 'left');
  const rightUnit = axisUnit(series, 'right');

  let dotIndex = undefined;
  if (range === 'today') {
    // Find closest index based on times
    dotIndex = rechartData.findIndex((item) => {
      // `item.date` is a bucket string with no zone marker; date-fns parses
      // that form as local time, so without this the "now" dot lands on the
      // wrong bucket by the viewer's offset.
      return isSameHour(parseChartDate(item.date), new Date());
    });
  }

  const lastSerieDataItem = parseChartDate(
    last(series[0]?.data || [])?.date ?? new Date(),
  );
  const useDashedLastLine = (() => {
    if (range === 'today') {
      return true;
    }

    if (interval === 'hour') {
      return isSameHour(lastSerieDataItem, new Date());
    }

    if (interval === 'day') {
      return isSameDay(lastSerieDataItem, new Date());
    }

    if (interval === 'month') {
      return isSameMonth(lastSerieDataItem, new Date());
    }

    if (interval === 'week') {
      return isSameWeek(lastSerieDataItem, new Date());
    }

    return false;
  })();

  const { getStrokeDasharray, calcStrokeDasharray, handleAnimationEnd } =
    useDashedStroke({
      dotIndex,
    });

  const CustomLegend = useCallback(() => {
    return (
      <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs mt-4 -mb-2">
        {series.map((serie) => (
          <div
            className="flex items-center gap-1"
            key={serie.id}
            style={{
              color: getChartColor(serieColorIndex(serie, colorIndexes)),
            }}
          >
            <SerieIcon name={serie.names} />
            <SerieName name={serie.names} className="font-semibold" />
          </div>
        ))}
      </div>
    );
  }, [series]);

  const xAxisProps = useXAxisProps({ interval, hide: hideXAxis });
  const yAxisProps = useYAxisProps({
    hide: hideYAxis,
    unit: leftUnit,
  });
  const rightYAxisProps = useYAxisProps({
    hide: hideYAxis,
    unit: rightUnit,
  });

  const getMenuItems = useCallback(
    (e: any, clickedData: any): ChartClickMenuItem[] => {
      const items: ChartClickMenuItem[] = [];

      // The click that ends a drag-to-zoom sweep is not a click on a point.
      if (rangeSelect.consumeDrag()) {
        return items;
      }

      if (!clickedData?.date) {
        return items;
      }

      // Extract serie ID from the click event if needed
      // activePayload is an array of payload objects
      const validPayload = e.activePayload?.find(
        (p: any) =>
          p.dataKey &&
          p.dataKey !== 'calcStrokeDasharray' &&
          typeof p.dataKey === 'string' &&
          p.dataKey.includes(':count'),
      );
      const serieId = validPayload?.dataKey?.toString().replace(':count', '');

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
                chartType: 'linear',
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
      rangeSelect,
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
      <ChartClickMenu
        getMenuItems={getMenuItems}
        onModifierClick={onModifierClick}
      >
        <div className={cn('h-full w-full', isEditMode && 'card p-4')}>
          <ResponsiveContainer>
            <ComposedChart data={rechartData} {...rangeSelect.chartProps}>
              <Customized component={calcStrokeDasharray} />
              <Line
                yAxisId="left"
                dataKey="calcStrokeDasharray"
                legendType="none"
                animationDuration={0}
                onAnimationEnd={handleAnimationEnd}
              />
              <CartesianGrid
                strokeDasharray="3 3"
                horizontal={true}
                vertical={false}
                className="stroke-border"
              />
              {references.data?.map((ref) => (
                <ReferenceLine
                  key={ref.id}
                  yAxisId="left"
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
              <YAxis
                yAxisId="left"
                {...yAxisProps}
                domain={maxDomain ? [0, maxDomain] : undefined}
              />
              {showRightAxis && (
                <YAxis yAxisId="right" orientation="right" {...rightYAxisProps} />
              )}
              <XAxis {...xAxisProps} />
              {series.length > 1 && <Legend content={<CustomLegend />} />}
              <Tooltip content={<ReportChartTooltip.Tooltip />} />
              {rangeSelect.selection && (
                <ReferenceArea
                  yAxisId="left"
                  x1={rangeSelect.selection.x1}
                  x2={rangeSelect.selection.x2}
                  strokeOpacity={0.3}
                  fillOpacity={0.12}
                />
              )}
              {annotations}

              <defs>
                <filter
                  id="rainbow-line-glow"
                  x="-20%"
                  y="-20%"
                  width="140%"
                  height="140%"
                >
                  <feGaussianBlur stdDeviation="5" result="blur" />
                  <feComponentTransfer in="blur" result="dimmedBlur">
                    <feFuncA type="linear" slope="0.5" />
                  </feComponentTransfer>
                  <feComposite
                    in="SourceGraphic"
                    in2="dimmedBlur"
                    operator="over"
                  />
                </filter>
              </defs>

              {series.map((serie) => {
                const color = getChartColor(
                  serieColorIndex(serie, colorIndexes),
                );
                return (
                  <Line
                    key={serie.id}
                    yAxisId={serieAxis(serie)}
                    dot={dataLength <= 8}
                    type={lineType}
                    name={serie.id}
                    isAnimationActive={false}
                    strokeWidth={2}
                    dataKey={`${serie.id}:count`}
                    stroke={color}
                    strokeDasharray={
                      useDashedLastLine
                        ? getStrokeDasharray(`${serie.id}:count`)
                        : undefined
                    }
                    // Use for legend
                    fill={color}
                    filter={
                      series.length === 1
                        ? 'url(#rainbow-line-glow)'
                        : undefined
                    }
                  />
                );
              })}

              {/* Previous */}
              {previous
                ? series.map((serie) => {
                    const color = getChartColor(
                      serieColorIndex(serie, colorIndexes),
                    );
                    return (
                      <Line
                        key={`${serie.id}:prev`}
                        yAxisId={serieAxis(serie)}
                        type={lineType}
                        name={`${serie.id}:prev`}
                        isAnimationActive
                        dot={false}
                        strokeOpacity={0.3}
                        dataKey={`${serie.id}:prev:count`}
                        stroke={color}
                        // Use for legend
                        fill={color}
                      />
                    );
                  })
                : null}
            </ComposedChart>
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
