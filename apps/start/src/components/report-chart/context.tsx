import isEqual from 'lodash.isequal';
import type { LucideIcon } from 'lucide-react';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';

import type { IChartData } from '@/trpc/client';
import type { IChartSerie, IReportInput } from '@openpanel/validation';
import type { ChartClickMenuItem } from './common/chart-click-menu';

export type ReportChartContextType = {
  options: Partial<{
    columns: React.ReactNode[];
    hideLegend: boolean;
    hideXAxis: boolean;
    hideYAxis: boolean;
    aspectRatio: number;
    maxHeight: number;
    minHeight: number;
    maxDomain: number;
    onClick: (serie: IChartSerie) => void;
    /**
     * The user swept a range across the x axis of a line or area chart.
     *
     * Lives on `options` rather than at the top level so a dashboard panel —
     * which has no zoom — does not have to pass it. Explore sets an absolute
     * start/end from it and re-runs.
     */
    onRangeSelect: (range: { startDate: string; endDate: string }) => void;
    /**
     * Cmd/Ctrl+click on a point of a line or area chart, instead of the menu.
     * Used to create an annotation at that moment.
     */
    onModifierClick: (payload: {
      date: string;
      metaKey: boolean;
      ctrlKey: boolean;
    }) => void;
    /**
     * Extra entries for the chart's click menu — "View logs for this range",
     * "View traces for this range".
     *
     * A hook rather than items built in the chart: resolving a service name
     * from a series' labels and turning it into a `/logs` URL belongs with the
     * link builders, not with a renderer, and this keeps the chart from
     * importing route knowledge.
     *
     * Deliberately NOT given the interval or the window. The caller knows its
     * own, and passing them would create a second source of truth for
     * something Explore and the dashboard each already hold.
     */
    extraMenuItems: (context: {
      /** The clicked bucket. */
      date: string;
      /** The series under the cursor, when the payload identifies one. */
      serieId?: string;
      /** That series' panel metadata, for a metrics panel. */
      panel?: IChartSerie['panel'];
      /**
       * That series' labels — `method`, `service_name`, `le` …
       *
       * Carried on the payload because the CHART is the only place they are in
       * hand. A dashboard panel fetches its own data inside `ReportChart`, so
       * the route that supplies `extraMenuItems` never sees the series; without
       * this a correlation link from a dashboard could only fall back to the
       * dashboard's `$service` variable, and a panel broken down by service
       * could not filter the logs to the line that was actually clicked.
       */
      labels?: Record<string, string>;
    }) => ChartClickMenuItem[];
    renderSerieName: (names: string[]) => React.ReactNode;
    renderSerieIcon: (serie: IChartSerie) => React.ReactNode;
    dropdownMenuContent: (serie: IChartSerie) => {
      icon: LucideIcon;
      title: string;
      onClick: () => void;
    }[];
  }>;
  report: IReportInput & { id?: string };
  isLazyLoading: boolean;
  isEditMode: boolean;
  shareId?: string;
  reportId?: string;
  /**
   * A chart the CALLER already holds, rendered instead of fetching one.
   *
   * Explore runs `observability.panel` itself — it needs the `notices` and the
   * compiled PromQL from the same response, which `chart.chart` does not
   * return — so without this the page would run the panel twice: once for the
   * data it shows beside the chart, and again inside the renderer.
   *
   * Passing any of `data`, `isLoading`, `isFetching` or `error` hands the
   * renderer's whole fetch lifecycle to the caller. No existing call site
   * passes any of them, so every dashboard panel keeps fetching for itself.
   */
  data?: IChartData;
  isLoading?: boolean;
  isFetching?: boolean;
  error?: unknown;
  /**
   * Markers drawn inside the plot area of a line or area chart — annotations.
   *
   * MUST be an element or an ARRAY of elements, never a fragment and never a
   * wrapper component: Recharts resolves a categorical chart's children by
   * type and drops anything it does not recognise, so `<>{markers}</>` renders
   * an empty plot with no error. See the `annotations` prop on line/chart.tsx.
   *
   * Typed as an ARRAY rather than `ReactNode` on purpose: `ReactNode` accepts
   * a fragment, and the failure is silent. Making the array part of the type
   * turns "empty plot, no error" into a compile error.
   *
   * A top-level field rather than an `options` entry because it is content the
   * panel supplies, not a display flag.
   */
  annotations?: React.ReactNode[];
};

type ReportChartContextProviderProps = ReportChartContextType & {
  children: React.ReactNode;
};

export type ReportChartProps = Partial<ReportChartContextType> & {
  report: IReportInput & { id?: string };
  lazy?: boolean;
};

const context = createContext<ReportChartContextType | null>(null);

export const useReportChartContext = () => {
  const ctx = useContext(context);
  if (!ctx) {
    throw new Error(
      'useReportChartContext must be used within a ReportChartProvider',
    );
  }
  return ctx;
};

/**
 * Returns the report input suitable for chart queries — strips display-only
 * fields that shouldn't affect the query cache key.
 *
 * `name` is one of them, and dropping it matters more than it looks: the whole
 * input is the react-query key, so a panel whose TITLE mentions `$service`
 * refetched every time that variable changed even though none of its queries
 * referenced it. On a dashboard where the titles are templated, changing one
 * variable reloaded every panel.
 *
 * The one exception is the LEGACY structured metrics path, which uses `name`
 * to name its single series (`executeMetricChart`'s `name` argument). A panel
 * with `metricQueries` names its series from each query's `legendFormat`
 * instead and has no use for it.
 */
export const useChartInput = () => {
  const { report } = useReportChartContext();
  return useMemo(() => {
    const { visibleSeries, name, ...input } = report;

    const isLegacyMetricReport =
      report.dataSource === 'metrics' && !report.metricQueries?.length;

    return isLegacyMetricReport ? { ...input, name } : input;
  }, [report]);
};

/**
 * Whether the caller owns the chart's fetch lifecycle.
 *
 * Checked on the four lifecycle fields rather than on `data` alone, so a caller
 * that is still loading — and therefore has no `data` yet — does not fall back
 * to fetching a second copy on the renderer's behalf.
 */
export const useOwnedChartResult = () => {
  const { data, isLoading, isFetching, error } = useReportChartContext();

  const owned =
    data !== undefined ||
    isLoading !== undefined ||
    isFetching !== undefined ||
    error !== undefined;

  return { owned, data, isLoading, isFetching, error };
};

export const ReportChartProvider = ({
  children,
  ...propsToContext
}: ReportChartContextProviderProps) => {
  const [ctx, setContext] = useState(propsToContext);

  useEffect(() => {
    if (!isEqual(ctx, propsToContext)) {
      setContext(propsToContext);
    }
  }, [propsToContext]);

  return <context.Provider value={ctx}>{children}</context.Provider>;
};

export default context;
