import { FullPageEmptyState } from '@/components/full-page-empty-state';
import { PageContainer } from '@/components/page-container';
import { ReportChart } from '@/components/report-chart';
import { Badge } from '@/components/ui/badge';
import { Combobox } from '@/components/ui/combobox';
import { Label } from '@/components/ui/label';
import { useTRPC } from '@/integrations/trpc/react';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, useParams } from '@tanstack/react-router';
import { ActivityIcon, ServerIcon } from 'lucide-react';
import { useMemo, useState } from 'react';

export const Route = createFileRoute('/_app/$organizationId/$projectId/metrics')(
  {
    component: Component,
    head: () => ({ meta: [{ title: 'Metrics' }] }),
  },
);

const FUNCTIONS = [
  { value: 'rate', label: 'Per-second rate' },
  { value: 'increase', label: 'Increase' },
  { value: 'delta', label: 'Delta' },
  { value: 'raw', label: 'Raw value' },
] as const;

const AGGREGATIONS = [
  { value: 'sum', label: 'Sum' },
  { value: 'avg', label: 'Average' },
  { value: 'min', label: 'Min' },
  { value: 'max', label: 'Max' },
  { value: 'count', label: 'Count' },
  { value: 'p50', label: 'p50 (histogram)' },
  { value: 'p90', label: 'p90 (histogram)' },
  { value: 'p95', label: 'p95 (histogram)' },
  { value: 'p99', label: 'p99 (histogram)' },
] as const;

type Fn = (typeof FUNCTIONS)[number]['value'];
type Aggregation = (typeof AGGREGATIONS)[number]['value'];

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

  const [metric, setMetric] = useState<string | null>(null);
  const [fn, setFn] = useState<Fn>('rate');
  const [aggregation, setAggregation] = useState<Aggregation>('sum');
  const [groupBy, setGroupBy] = useState<string | null>(null);

  const enabled = useQuery(trpc.observability.enabled.queryOptions());
  const telemetryOn = enabled.data?.enabled ?? false;

  const metrics = useQuery(
    trpc.observability.metricNames.queryOptions(
      { projectId },
      { enabled: telemetryOn },
    ),
  );

  // Labels are narrowed to the selected metric: offering every label in the
  // project would suggest group-bys that select nothing on this metric.
  const labels = useQuery(
    trpc.observability.labelKeys.queryOptions(
      { projectId, metric: metric ?? undefined },
      { enabled: telemetryOn && !!metric },
    ),
  );

  const report = useMemo(() => {
    if (!metric) {
      return null;
    }

    return {
      projectId,
      dataSource: 'metrics' as const,
      metricQuery: {
        metric,
        matchers: [],
        fn,
        aggregation,
        groupBy: groupBy ? [groupBy] : [],
      },
      // The event side of a report is empty for a metric report; the engine
      // never looks at it.
      series: [],
      breakdowns: [],
      chartType: 'linear' as const,
      lineType: 'monotone' as const,
      interval: 'hour' as const,
      range: '7d' as const,
      previous: false,
      metric: 'sum' as const,
      name: metric,
    };
  }, [projectId, metric, fn, aggregation, groupBy]);

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

  const metricItems = (metrics.data ?? []).map((name) => ({
    value: name,
    label: name,
  }));

  // Nothing has ever been ingested. This is the first-run state, and it should
  // tell the user what to do rather than showing an empty picker.
  if (!metrics.isLoading && metricItems.length === 0) {
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
      <div className="mb-6 flex items-center gap-3">
        <h1 className="font-medium text-2xl">Metrics</h1>
        <Badge variant="outline">Server telemetry</Badge>
      </div>

      <div className="mb-6 grid gap-4 md:grid-cols-4">
        <div className="flex flex-col gap-2">
          <Label>Metric</Label>
          <Combobox
            placeholder={metrics.isLoading ? 'Loading…' : 'Pick a metric'}
            items={metricItems}
            value={metric}
            onChange={(value) => {
              setMetric(value);
              // The previous group-by almost certainly does not exist on the
              // new metric, and leaving it would silently return nothing.
              setGroupBy(null);
            }}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label>Function</Label>
          <Combobox
            placeholder="Function"
            items={FUNCTIONS.map((f) => ({ value: f.value, label: f.label }))}
            value={fn}
            onChange={(value) => setFn(value as Fn)}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label>Aggregation</Label>
          <Combobox
            placeholder="Aggregation"
            items={AGGREGATIONS.map((a) => ({
              value: a.value,
              label: a.label,
            }))}
            value={aggregation}
            onChange={(value) => setAggregation(value as Aggregation)}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label>Group by</Label>
          <Combobox
            placeholder={metric ? 'None' : 'Pick a metric first'}
            items={[
              { value: '', label: 'None' },
              ...(labels.data ?? []).map((l) => ({ value: l, label: l })),
            ]}
            value={groupBy ?? ''}
            onChange={(value) => setGroupBy(value || null)}
          />
        </div>
      </div>

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
