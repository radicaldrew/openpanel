import { ReportItem } from '@/components/report/report-item';
import { useMetricCorrelationItems } from '@/components/telemetry-links/use-metric-correlation-items';
import type { IChartRange, IInterval, IVariableValues } from '@openpanel/validation';
import type { ReactNode } from 'react';

/**
 * One panel on a dashboard.
 *
 * Exists so the correlation menu items can be built PER PANEL. The hook needs
 * the panel's own interval — it decides how wide "this range" is — and the
 * dashboard's global interval only overrides a panel's when one is set, so a
 * single hook call at the route would use the wrong width for every panel
 * still on its own interval. Hooks cannot be called inside a `.map`, hence a
 * component.
 */
export function DashboardPanel({
  report,
  organizationId,
  projectId,
  range,
  startDate,
  endDate,
  interval,
  variables,
  annotations,
  onModifierClick,
  onDelete,
  onDuplicate,
  onMove,
}: {
  report: any;
  organizationId: string;
  projectId: string;
  range: IChartRange | null;
  startDate: string | null;
  endDate: string | null;
  interval: IInterval | null;
  /** The dashboard's current variable values, as a fallback for the service. */
  variables?: IVariableValues;
  annotations?: ReactNode[];
  onModifierClick?: (payload: {
    date: string;
    metaKey: boolean;
    ctrlKey: boolean;
  }) => void;
  onDelete: (reportId: string) => void;
  onDuplicate: (reportId: string) => void;
  onMove?: (reportId: string) => void;
}) {
  // The same override ReportItem applies when it renders the chart, so the
  // window the menu items build matches the buckets that were clicked.
  const effectiveInterval = (interval ?? report.interval) as IInterval;

  const correlationItems = useMetricCorrelationItems({
    organizationId,
    projectId,
    interval: effectiveInterval,
    // No `chart`, deliberately. The clicked series' labels arrive on the click
    // payload itself, which is both what a dashboard route can supply (it
    // never sees per-panel data — each panel fetches inside `ReportChart`) and
    // the more correct source: a payload is by construction from the render
    // that was clicked, where a chart prop is whatever the last render left.
    // `variables` remains the last resort, for a click that resolves no series
    // at all — between lines, or on a previous-period line.
    variables,
  });

  // Metrics only. An events panel has no telemetry behind it, so "View logs
  // for this range" would open a log search for a project that may not send
  // logs at all — an entry that always disappoints is worse than no entry.
  const isMetrics = report.dataSource === 'metrics';

  return (
    <ReportItem
      report={report}
      organizationId={organizationId}
      projectId={projectId}
      range={range}
      startDate={startDate}
      endDate={endDate}
      interval={interval}
      annotations={annotations}
      onModifierClick={onModifierClick}
      extraMenuItems={isMetrics ? correlationItems : undefined}
      onDelete={onDelete}
      onDuplicate={onDuplicate}
      onMove={onMove}
    />
  );
}
