import { Combobox } from '@/components/ui/combobox';
import { Label } from '@/components/ui/label';
import { useTRPC } from '@/integrations/trpc/react';
import { cn } from '@/utils/cn';
import { defaultMetricFn, supportsRateFunctions } from '@openpanel/common';
import type { IMetricQuery } from '@openpanel/validation';
import { useQuery } from '@tanstack/react-query';

/**
 * The controls that define a metric query.
 *
 * Lives here rather than in the metrics route because two surfaces need it —
 * the explorer, where a metric chart is built, and the report editor, where a
 * saved metric panel is changed. Two copies of these rules would drift, and the
 * rules are not cosmetic: which functions a metric admits, and what happens to
 * the rest of the query when the metric changes, decide whether the chart draws
 * anything at all.
 */

export const METRIC_FUNCTIONS = [
  { value: 'rate', label: 'Per-second rate' },
  { value: 'increase', label: 'Increase' },
  { value: 'delta', label: 'Delta' },
  { value: 'raw', label: 'Raw value' },
] as const;

export const METRIC_AGGREGATIONS = [
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

export type IMetricFn = IMetricQuery['fn'];
export type IMetricAggregation = IMetricQuery['aggregation'];

/** A query with no metric chosen yet. */
export const emptyMetricQuery: IMetricQuery = {
  metric: '',
  matchers: [],
  fn: 'rate',
  aggregation: 'sum',
  groupBy: [],
};

interface Props {
  projectId: string;
  /** The query being edited; `null` before a metric has been chosen. */
  value: IMetricQuery | null;
  onChange: (next: IMetricQuery) => void;
  className?: string;
  /** Set when telemetry is configured; the pickers query nothing otherwise. */
  enabled?: boolean;
}

export function MetricQueryEditor({
  projectId,
  value,
  onChange,
  className,
  enabled = true,
}: Props) {
  const trpc = useTRPC();
  const query = value ?? emptyMetricQuery;
  const metric = query.metric || null;

  const metrics = useQuery(
    trpc.observability.metricNames.queryOptions({ projectId }, { enabled }),
  );

  // Labels are narrowed to the selected metric: offering every label in the
  // project would suggest group-bys that select nothing on this metric.
  const labels = useQuery(
    trpc.observability.labelKeys.queryOptions(
      { projectId, metric: metric ?? undefined },
      { enabled: enabled && !!metric },
    ),
  );

  const metricItems = (metrics.data ?? []).map((name) => ({
    value: name,
    label: name,
  }));

  // For a gauge, every rate-style function can only ever draw zero, because a
  // gauge's value is not cumulative. An option that cannot produce an answer is
  // worse than no option.
  const functionItems = (
    metric && !supportsRateFunctions(metric)
      ? METRIC_FUNCTIONS.filter((f) => f.value === 'raw')
      : METRIC_FUNCTIONS
  ).map((f) => ({ value: f.value, label: f.label }));

  return (
    <div className={cn('grid gap-4 md:grid-cols-4', className)}>
      <div className="flex flex-col gap-2">
        <Label>Metric</Label>
        <Combobox
          items={metricItems}
          onChange={(next) => {
            onChange({
              ...query,
              metric: next,
              // A counter is meaningless unrated and a gauge is meaningless
              // rated, so the function follows the metric rather than the other
              // way round.
              fn: defaultMetricFn(next),
              // The previous group-by almost certainly does not exist on the
              // new metric, and leaving it would silently return nothing.
              groupBy: [],
            });
          }}
          placeholder={metrics.isLoading ? 'Loading…' : 'Pick a metric'}
          value={metric}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label>Function</Label>
        <Combobox
          items={functionItems}
          onChange={(next) => onChange({ ...query, fn: next as IMetricFn })}
          placeholder="Function"
          value={query.fn}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label>Aggregation</Label>
        <Combobox
          items={METRIC_AGGREGATIONS.map((a) => ({
            value: a.value,
            label: a.label,
          }))}
          onChange={(next) =>
            onChange({ ...query, aggregation: next as IMetricAggregation })
          }
          placeholder="Aggregation"
          value={query.aggregation}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label>Group by</Label>
        <Combobox
          items={[
            { value: '', label: 'None' },
            ...(labels.data ?? []).map((l) => ({ value: l, label: l })),
          ]}
          onChange={(next) =>
            onChange({ ...query, groupBy: next ? [next] : [] })
          }
          placeholder={metric ? 'None' : 'Pick a metric first'}
          value={query.groupBy[0] ?? ''}
        />
      </div>
    </div>
  );
}
