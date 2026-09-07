import { ExploreResultTable } from '@/components/explore/explore-result-table';
import { ExploreToolbar } from '@/components/explore/explore-toolbar';
import {
  appendQuery,
  exprsToRecord,
  initialQueries,
  panelQueriesParser,
  windowFromChart,
  zodParser,
  zoomOut,
} from '@/components/explore/explore-url-state';
import { QueryHistoryDrawer } from '@/components/explore/query-history-drawer';
import { useExploreVariables } from '@/components/explore/use-explore-variables';
import { useMetricCorrelationItems } from '@/components/telemetry-links/use-metric-correlation-items';
import { FullPageEmptyState } from '@/components/full-page-empty-state';
import { PageContainer } from '@/components/page-container';
import {
  MAX_PANEL_QUERIES,
  createPanelQuery,
  nextRefId,
} from '@/components/promql/panel-query';
import { QueryRows } from '@/components/promql/query-rows';
import { ReportChart } from '@/components/report-chart';
import { Badge } from '@/components/ui/badge';
import { useMetricsPageContext } from '@/hooks/use-page-context-helpers';
import { useTRPC } from '@/integrations/trpc/react';
import type { IChartData } from '@/trpc/client';
import { pushModal } from '@/modals';
import { inferPromqlUnit } from '@openpanel/common';
import type {
  IChartRange,
  IInterval,
  IMetricChartType,
  IPanelQuery,
  IReportInput,
} from '@openpanel/validation';
import {
  METRIC_CHART_TYPES,
  isMetricChartType,
  zRange,
  zTimeInterval,
} from '@openpanel/validation';
import { z } from 'zod';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { createFileRoute, useParams } from '@tanstack/react-router';
import { ActivityIcon, ServerIcon } from 'lucide-react';
import { parseAsInteger, useQueryState } from 'nuqs';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * The parameters, built once.
 *
 * At module scope rather than inside the component because `withDefault`
 * captures the default VALUE: rebuilding these on every render would hand
 * `useQueryState` a new default array each time, and every memo keyed on the
 * query list would recompute for a page nobody had touched.
 */
const QUERIES_PARAM = panelQueriesParser.withDefault(initialQueries());
const RANGE_PARAM = zodParser(zRange).withDefault('last24h' as IChartRange);
const INTERVAL_PARAM = zodParser(zTimeInterval).withDefault('hour' as IInterval);
/**
 * Only the four types the metrics engine can actually draw.
 *
 * `bar` and `pie` route to `executeAggregateChart`, which has no metrics
 * branch, and the funnel/retention/map types have their own events-only
 * services — all of them render a blank panel with no error. The picker never
 * offers them; this is what stops a hand-written `?chart=pie` from reaching
 * one.
 */
const CHART_TYPE_PARAM = zodParser(z.enum(METRIC_CHART_TYPES)).withDefault(
  'linear' as IMetricChartType,
);
const REFRESH_PARAM = parseAsInteger.withDefault(0);

export const Route = createFileRoute('/_app/$organizationId/$projectId/metrics')(
  {
    component: Component,
    head: () => ({ meta: [{ title: 'Metrics' }] }),
  },
);

/**
 * The metrics explorer.
 *
 * Every piece of state that decides what is on screen lives in the URL, because
 * the thing people do with this page is paste it into a channel and say "look
 * at this". A link has to reopen the same queries, the same window and the same
 * chart — see explore-url-state.ts for the encoding and why each field is in it.
 *
 * The page owns its query rather than letting `<ReportChart>` fetch, which is
 * what doc 09 D2's `data` prop is for: `observability.panel` returns the chart
 * AND the engine's notices AND the PromQL that actually ran, and all three are
 * shown here. Letting the renderer fetch would mean running the panel twice.
 *
 * Editing a row does NOT re-run it. Explore is a place to compose a query, and
 * a query that fires on every keystroke sends a dozen half-written expressions
 * to a backend that charges for them; Run and ⌘/Ctrl+Enter are the triggers.
 */
function Component() {
  const { organizationId, projectId } = useParams({
    from: '/_app/$organizationId/$projectId/metrics',
  });
  const trpc = useTRPC();

  const [queries, setQueries] = useQueryState('q', QUERIES_PARAM);
  const [range, setRange] = useQueryState('range', RANGE_PARAM);
  const [startDate, setStartDate] = useQueryState('start');
  const [endDate, setEndDate] = useQueryState('end');
  const [interval, setInterval] = useQueryState('interval', INTERVAL_PARAM);
  const [chartType, setChartType] = useQueryState('chart', CHART_TYPE_PARAM);
  const [refreshMs, setRefreshMs] = useQueryState('refresh', REFRESH_PARAM);

  const variables = useExploreVariables();

  /**
   * The queries that are actually running.
   *
   * Seeded from the URL so a shared link draws its chart on arrival rather than
   * making the recipient press Run to see the thing they were sent, and only
   * replaced by Run after that.
   */
  const [submitted, setSubmitted] = useState<IPanelQuery[]>(() =>
    runnable(queries),
  );
  const [historyOpen, setHistoryOpen] = useState(false);
  const [hiddenSeries, setHiddenSeries] = useState<string[]>([]);

  // What the last Run wrote to the history, so re-running an unchanged panel
  // does not fill the drawer with the same two lines. See `exprsToRecord`.
  //
  // Starts empty and is only written by `run`, which means arriving on someone
  // else's link does not put their queries in your history — the page runs
  // them, but you did not write them.
  const recorded = useRef<string[]>([]);

  useMetricsPageContext({ range, startDate, endDate, interval });

  const enabled = useQuery(trpc.observability.enabled.queryOptions());
  const telemetryOn = enabled.data?.enabled ?? false;

  const metrics = useQuery(
    trpc.observability.metricNames.queryOptions(
      { projectId },
      { enabled: telemetryOn },
    ),
  );

  const panel = useQuery(
    trpc.observability.panel.queryOptions(
      {
        projectId,
        queries: submitted,
        interval,
        range,
        startDate,
        endDate,
        variables,
      },
      {
        enabled: telemetryOn && submitted.length > 0,
        // The chart stays on screen while the next window loads, so refresh
        // does not blink the page every ten seconds.
        placeholderData: keepPreviousData,
        refetchInterval: refreshMs > 0 ? refreshMs : false,
      },
    ),
  );

  const record = useMutation(trpc.observability.recordQuery.mutationOptions());
  const { refetch: refetchPanel } = panel;
  const { mutate: recordQuery } = record;

  const run = useCallback(() => {
    const next = runnable(queries);

    if (next.length === 0) {
      return;
    }

    // React Query dedupes an identical key, so re-running an unchanged panel
    // needs an explicit refetch — which is exactly what someone pressing Run on
    // a query they have not touched is asking for.
    const unchanged = JSON.stringify(next) === JSON.stringify(submitted);
    setSubmitted(next);

    if (unchanged) {
      void refetchPanel();
    } else {
      // A different set of queries means a different set of series ids, and a
      // row toggled off in the last result should not silently hide a series in
      // this one that happens to carry the same labels.
      setHiddenSeries([]);
    }

    const toRecord = exprsToRecord(next, recorded.current);
    recorded.current = next
      .filter((query) => !query.hidden)
      .map((query) => query.expr.trim());

    for (const expr of toRecord) {
      recordQuery({ projectId, expr });
    }
    // `refetchPanel` and `recordQuery` rather than the query and mutation
    // objects: those get a new identity on every render, which would make this
    // callback — and the keydown listener below that depends on it — churn.
  }, [queries, submitted, refetchPanel, recordQuery, projectId]);

  // ⌘/Ctrl+Enter reaches here from inside a CodeMirror editor via QueryRow's
  // onRun; this listener is what makes it work from the builder and from the
  // options row too.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // CodeMirror's own Mod-Enter binding calls preventDefault when it has
      // handled the key. Without this guard the event still bubbles to the
      // window and the panel runs twice — once from the editor, once from here.
      if (event.defaultPrevented) {
        return;
      }

      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        run();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [run]);

  const chart = panel.data?.chart;

  const drawnWindow = useMemo(() => windowFromChart(chart), [chart]);

  const applyWindow = useCallback(
    (next: { startDate: string; endDate: string }) => {
      // An absolute window supersedes the preset, which is what `custom` means
      // to the range picker and to the engine.
      void setRange('custom' as IChartRange);
      void setStartDate(next.startDate);
      void setEndDate(next.endDate);
    },
    [setRange, setStartDate, setEndDate],
  );

  const visibleSeriesIds = useMemo(() => {
    const all = chart?.series.map((serie) => serie.id) ?? [];
    return all.filter((id) => !hiddenSeries.includes(id));
  }, [chart, hiddenSeries]);

  // "View logs / traces for this range" on the click menu. Built from the same
  // helpers the dashboard panels use, so the same spike gives the same window
  // whichever page it was clicked on. No `chart` is passed: the clicked
  // series' labels arrive on the click payload, which is always from the render
  // that was clicked.
  const correlationItems = useMetricCorrelationItems({
    organizationId,
    projectId,
    interval,
    variables,
  });

  const shownChart = useMemo(() => {
    if (!chart) {
      return undefined;
    }

    if (hiddenSeries.length === 0) {
      return chart;
    }

    // Filtered here rather than through the report's `visibleSeries`, which is
    // a saved display field on a Report row — Explore has no report to save it
    // on, and writing it would change what "Add to dashboard" produces.
    return {
      ...chart,
      series: chart.series.filter((serie) => !hiddenSeries.includes(serie.id)),
    };
  }, [chart, hiddenSeries]);

  const report = useMemo(() => {
    const running = runnable(queries);
    const metric = running[0]?.builder?.metric;

    return {
      projectId,
      dataSource: 'metrics' as const,
      metricQueries: running,
      // The event side of a report is empty for a metric report; the engine
      // never looks at it.
      series: [],
      breakdowns: [],
      chartType,
      lineType: 'monotone' as const,
      interval,
      range,
      startDate,
      endDate,
      previous: false,
      metric: 'sum' as const,
      unit: metric ? inferPromqlUnit(metric) : undefined,
      name: metric ?? 'Metrics',
    };
  }, [projectId, queries, chartType, interval, range, startDate, endDate]);

  const canSave = report.metricQueries.length > 0;

  const setQueryExpr = (refId: string, expr: string) => {
    void setQueries((current) =>
      (current ?? []).map((query) =>
        query.refId === refId ? { ...query, expr, mode: 'code' as const } : query,
      ),
    );
  };

  if (enabled.isLoading) {
    return null;
  }

  if (!telemetryOn) {
    return (
      <PageContainer>
        <FullPageEmptyState icon={ServerIcon} title="Telemetry is not configured">
          <p>
            This deployment has no telemetry backend. Set{' '}
            <code>GIGAPIPE_URL</code>, <code>GIGAPIPE_USER</code> and{' '}
            <code>GIGAPIPE_PASSWORD</code> to enable metrics, then restart the
            API.
          </p>
        </FullPageEmptyState>
      </PageContainer>
    );
  }

  const metricCount = metrics.data?.length ?? 0;

  // Nothing has ever been ingested. This is the first-run state, and it should
  // tell the user what to do rather than showing an empty picker.
  if (!metrics.isLoading && metricCount === 0) {
    return (
      <PageContainer>
        <FullPageEmptyState icon={ActivityIcon} title="No metrics yet">
          <p>
            Point an OpenTelemetry collector at{' '}
            <code>{'{API_URL}'}/telemetry/v1/metrics</code> using a telemetry
            client from Settings → Clients, and your metrics will appear here.
          </p>
        </FullPageEmptyState>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="font-medium text-2xl">Metrics</h1>
        <Badge variant="outline">Server telemetry</Badge>
      </div>

      <ExploreToolbar
        canSave={canSave}
        chartType={chartType}
        className="mb-4"
        endDate={endDate}
        interval={interval}
        isRunning={panel.isFetching}
        onChartTypeChange={(next) => {
          // `MetricChartType` is typed to emit any chart type but only offers
          // the four; the guard is what makes that a fact rather than a
          // convention the URL parameter has to trust.
          if (isMetricChartType(next)) {
            void setChartType(next);
          }
        }}
        onEndDateChange={(date) => void setEndDate(date)}
        onIntervalChange={(next) => void setInterval(next)}
        onOpenHistory={() => setHistoryOpen(true)}
        onRangeChange={(next) => {
          void setRange(next);
          // A preset supersedes any custom window that was set before it.
          void setStartDate(null);
          void setEndDate(null);
        }}
        onRefreshChange={(ms) => void setRefreshMs(ms || null)}
        onRun={run}
        onSave={() => pushModal('SaveReport', { report })}
        onStartDateChange={(date) => void setStartDate(date)}
        onZoomOut={
          drawnWindow ? () => applyWindow(zoomOut(drawnWindow)) : undefined
        }
        range={range}
        refreshMs={refreshMs}
        startDate={startDate}
      />

      <QueryRows
        className="mb-4"
        enabled={telemetryOn}
        onAdd={(query) => void setQueries((current) => [...(current ?? []), query])}
        onDuplicate={(refId) =>
          void setQueries((current) => {
            const list = current ?? [];
            const source = list.find((query) => query.refId === refId);

            return source
              ? [...list, { ...source, refId: nextRefId(list) }]
              : list;
          })
        }
        onRemove={(refId) =>
          void setQueries((current) =>
            (current ?? []).filter((query) => query.refId !== refId),
          )
        }
        onRun={run}
        onUpdate={(refId, next) =>
          void setQueries((current) =>
            (current ?? []).map((query) =>
              query.refId === refId ? next : query,
            ),
          )
        }
        projectId={projectId}
        showInstant={chartType === 'metric'}
        value={queries}
      />

      <ExploreResult
        chart={shownChart}
        compiled={panel.data?.compiled}
        error={panel.error}
        isFetching={panel.isFetching}
        isLoading={panel.isLoading}
        notices={panel.data?.notices}
        extraMenuItems={correlationItems}
        onRangeSelect={applyWindow}
        onToggleSeries={(id) =>
          setHiddenSeries((current) =>
            current.includes(id)
              ? current.filter((other) => other !== id)
              : [...current, id],
          )
        }
        rawChart={chart}
        report={report}
        submitted={submitted.length > 0}
        visibleSeriesIds={visibleSeriesIds}
      />

      <QueryHistoryDrawer
        canAdd={queries.length < MAX_PANEL_QUERIES}
        onAdd={(expr) =>
          void setQueries((current) =>
            appendQuery(current ?? [], { expr, mode: 'code' }),
          )
        }
        onOpenChange={setHistoryOpen}
        onUse={(expr) => {
          const target = queries[0]?.refId;

          if (target) {
            setQueryExpr(target, expr);
          } else {
            void setQueries([createPanelQuery('A', { expr, mode: 'code' })]);
          }
        }}
        open={historyOpen}
        projectId={projectId}
      />
    </PageContainer>
  );
}

/** The queries that have something to run. */
function runnable(queries: IPanelQuery[] | null): IPanelQuery[] {
  return (queries ?? []).filter((query) => query.expr.trim() !== '');
}

interface ExploreResultProps {
  /** What the chart draws: the result minus any series toggled off. */
  chart: IChartData | undefined;
  /** Every series the panel returned, for the table. */
  rawChart: IChartData | undefined;
  compiled: { refId: string; promql: string }[] | undefined;
  notices: string[] | undefined;
  error: unknown;
  isLoading: boolean;
  isFetching: boolean;
  /** False before anything has been run, which is a placeholder, not an empty result. */
  submitted: boolean;
  report: IReportInput & { id?: string };
  visibleSeriesIds: string[];
  onToggleSeries: (id: string) => void;
  onRangeSelect: (range: { startDate: string; endDate: string }) => void;
  extraMenuItems: ReturnType<typeof useMetricCorrelationItems>;
}

function ExploreResult({
  chart,
  rawChart,
  compiled,
  notices,
  error,
  isLoading,
  isFetching,
  submitted,
  report,
  visibleSeriesIds,
  onToggleSeries,
  onRangeSelect,
  extraMenuItems,
}: ExploreResultProps) {
  const failed = error !== null && error !== undefined;

  if (!submitted) {
    return (
      <div className="rounded-lg border border-dashed p-12 text-center text-muted-foreground">
        Build a query and press Run.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {failed ? (
        /* In place of the chart, not above it. The upstream message is verbatim
           — gigapipe says things like "query processing would load too many
           samples", which tells the user which lever to pull, and the engine
           prefixes it with the refId so a five-query panel names the one that
           failed. An empty chart beside it would suggest there was also a
           result. */
        <div className="rounded-lg border border-destructive bg-destructive/5 p-4 text-sm">
          <p className="font-medium">This panel did not run</p>
          <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
            {error instanceof Error ? error.message : String(error)}
          </p>
        </div>
      ) : (
        <div className="rounded-lg border bg-card p-4">
          <ReportChart
            data={chart}
            isFetching={isFetching}
            isLoading={isLoading}
            lazy={false}
            options={{ onRangeSelect, extraMenuItems }}
            report={report}
          />
        </div>
      )}

      {/* Under the chart, where they explain what is above them: every notice
          names something the engine DID — coarsened the interval, widened the
          rate window, capped the series — so it reads as a footnote to the
          picture rather than a warning about to happen. */}
      {!failed && notices && notices.length > 0 && (
        <ul className="flex flex-col gap-1 text-muted-foreground text-xs">
          {notices.map((notice, index) => (
            <li key={`${index}-${notice}`}>{notice}</li>
          ))}
        </ul>
      )}

      {compiled && compiled.length > 0 && (
        <details className="rounded-lg border bg-card p-3 text-sm">
          <summary className="cursor-pointer select-none font-medium">
            Query
          </summary>
          <dl className="mt-3 flex flex-col gap-2">
            {compiled.map((entry) => (
              <div className="flex gap-3" key={entry.refId}>
                <dt className="shrink-0 font-mono text-muted-foreground">
                  {entry.refId}
                </dt>
                <dd className="min-w-0 break-all font-mono text-xs leading-5">
                  {entry.promql}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-muted-foreground text-xs">
            This is what ran, after dashboard variables were substituted and the
            project scope was applied.
          </p>
        </details>
      )}

      {!failed && rawChart && (
        <ExploreResultTable
          chart={rawChart}
          onToggle={onToggleSeries}
          visibleSeriesIds={visibleSeriesIds}
        />
      )}
    </div>
  );
}
