import { FullPageEmptyState } from '@/components/full-page-empty-state';
import { PageContainer } from '@/components/page-container';
import { ReportChart } from '@/components/report-chart';
import { MetricQueryEditor } from '@/components/report/metric-query-editor';
import { ReportInterval } from '@/components/report/ReportInterval';
import { TimeWindowPicker } from '@/components/time-window-picker';
import { Badge } from '@/components/ui/badge';
import { useTRPC } from '@/integrations/trpc/react';
import { Button } from '@/components/ui/button';
import { pushModal } from '@/modals';
import { getDefaultIntervalByDates } from '@openpanel/constants';
import { inferMetricUnit } from '@openpanel/common';
import type {
  IChartRange,
  IInterval,
  IMetricQuery,
} from '@openpanel/validation';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, useParams } from '@tanstack/react-router';
import { ActivityIcon, SaveIcon, ServerIcon } from 'lucide-react';
import { useMemo, useState } from 'react';

export const Route = createFileRoute('/_app/$organizationId/$projectId/metrics')(
  {
    component: Component,
    head: () => ({ meta: [{ title: 'Metrics' }] }),
  },
);

/**
 * The metrics explorer.
 *
 * There is no chart component here, and that is the point: a metric report is
 * an ordinary `IReportInput` with `dataSource: 'metrics'`, so it renders through
 * the same `<ReportChart>` every event report uses. The engine dispatch happens
 * server-side, which is what makes "save this to a dashboard" work without any
 * of the dashboard code knowing metrics exist.
 */
function Component() {
  const { projectId } = useParams({
    from: '/_app/$organizationId/$projectId/metrics',
  });
  const trpc = useTRPC();

  const [metricQuery, setMetricQuery] = useState<IMetricQuery | null>(null);
  const metric = metricQuery?.metric || null;

  // Time controls, mirroring the report editor's: a range with presets and a
  // custom picker, plus an explicit resolution. `startDate`/`endDate` stay null
  // until a custom range is chosen, at which point they take over from `range`.
  const [range, setRange] = useState<IChartRange>('7d');
  const [startDate, setStartDate] = useState<string | null>(null);
  const [endDate, setEndDate] = useState<string | null>(null);
  const [interval, setInterval] = useState<IInterval>('hour');

  const enabled = useQuery(trpc.observability.enabled.queryOptions());
  const telemetryOn = enabled.data?.enabled ?? false;

  const metrics = useQuery(
    trpc.observability.metricNames.queryOptions(
      { projectId },
      { enabled: telemetryOn },
    ),
  );

  const report = useMemo(() => {
    // Guard on the query rather than on `metric`, so it narrows to non-null for
    // the object below.
    if (!metricQuery?.metric) {
      return null;
    }

    return {
      projectId,
      dataSource: 'metrics' as const,
      metricQuery,
      // The event side of a report is empty for a metric report; the engine
      // never looks at it.
      series: [],
      breakdowns: [],
      chartType: 'linear' as const,
      lineType: 'monotone' as const,
      interval,
      range,
      startDate,
      endDate,
      previous: false,
      metric: 'sum' as const,
      // Only where the name states one; the chart appends it to the axis.
      unit: inferMetricUnit(metricQuery.metric),
      name: metricQuery.metric,
    };
  }, [projectId, metricQuery, interval, range, startDate, endDate]);

  if (enabled.isLoading) {
    return null;
  }

  if (!telemetryOn) {
    return (
      <PageContainer>
        <FullPageEmptyState title="Telemetry is not configured" icon={ServerIcon}>
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
        <FullPageEmptyState title="No metrics yet" icon={ActivityIcon}>
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
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="font-medium text-2xl">Metrics</h1>
        <Badge variant="outline">Server telemetry</Badge>

        {/* Pushed right so the time controls sit where a dashboard user looks
            for them, and wrap onto their own line on a narrow screen. */}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <TimeWindowPicker
            endDate={endDate}
            onChange={(value) => {
              setRange(value);
              // A preset supersedes any custom window that was set before it.
              setStartDate(null);
              setEndDate(null);
            }}
            onEndDateChange={setEndDate}
            onIntervalChange={setInterval}
            onStartDateChange={setStartDate}
            startDate={startDate}
            value={range}
          />
          <ReportInterval
            chartType="linear"
            endDate={endDate}
            interval={interval}
            onChange={setInterval}
            range={range}
            startDate={startDate}
          />
          {/* A metric report persists like any other — dataSource and
              metricQuery are columns on the report — so a chart built here can
              become a dashboard panel rather than something to rebuild by hand
              every time someone wants to look at it. */}
          <Button
            disabled={!report}
            onClick={() => {
              if (report) {
                pushModal('SaveReport', { report });
              }
            }}
            size="sm"
            variant="outline"
          >
            <SaveIcon className="mr-2 size-4" />
            Save to dashboard
          </Button>
        </div>
      </div>

      <MetricQueryEditor
        className="mb-6"
        enabled={telemetryOn}
        onChange={setMetricQuery}
        projectId={projectId}
        value={metricQuery}
      />

      {report ? (
        <div className="rounded-lg border bg-card p-4">
          <ReportChart report={report} lazy={false} />
        </div>
      ) : (
        <div className="rounded-lg border border-dashed p-12 text-center text-muted-foreground">
          Pick a metric to chart it.
        </div>
      )}
    </PageContainer>
  );
}
