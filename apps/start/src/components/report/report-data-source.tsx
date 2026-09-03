import { chartTypes } from '@openpanel/constants';
import type {
  IChartType,
  IMetricChartType,
  IReportDataSource,
} from '@openpanel/validation';
import { METRIC_CHART_TYPES } from '@openpanel/validation';
import {
  ActivityIcon,
  AreaChartIcon,
  ChartColumnIncreasingIcon,
  GaugeIcon,
  LineChartIcon,
  type LucideIcon,
  ServerIcon,
} from 'lucide-react';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/utils/cn';

/**
 * The two pickers a report needs once it can be driven by either data source.
 *
 * They live together because they are one decision: choosing metrics narrows
 * which chart types the report can draw, and the narrowing is not cosmetic —
 * see METRIC_CHART_TYPES in @openpanel/validation for what a disallowed type
 * does.
 */

const DATA_SOURCES: {
  value: IReportDataSource;
  label: string;
  hint: string;
  icon: LucideIcon;
}[] = [
  {
    value: 'events',
    label: 'Events',
    hint: 'What people did',
    icon: ActivityIcon,
  },
  {
    value: 'metrics',
    label: 'Metrics',
    hint: 'What your servers reported',
    icon: ServerIcon,
  },
];

interface ReportDataSourceProps {
  className?: string;
  value: IReportDataSource;
  onChange: (dataSource: IReportDataSource) => void;
  /** Whether this deployment has a telemetry backend configured. */
  telemetryEnabled: boolean;
}

export function ReportDataSource({
  className,
  value,
  onChange,
  telemetryEnabled,
}: ReportDataSourceProps) {
  // On a deployment with no telemetry backend there is nothing to switch to,
  // and the metric pickers would query a project that has never written a
  // metric. Render nothing rather than a one-option menu, so an events-only
  // install sees exactly the editor it saw before. An already-saved metric
  // report still gets the picker — it needs a way back out.
  if (!telemetryEnabled && value !== 'metrics') {
    return null;
  }

  const active = DATA_SOURCES.find((item) => item.value === value);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className={cn('justify-start text-sm', className)}
          icon={active?.icon ?? ActivityIcon}
          variant="outline"
        >
          {active?.label ?? 'Events'}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64">
        <DropdownMenuLabel>Data source</DropdownMenuLabel>
        <DropdownMenuSeparator />

        <DropdownMenuGroup>
          {DATA_SOURCES.map((item) => {
            const Icon = item.icon;
            return (
              <DropdownMenuItem
                className="group"
                disabled={item.value === 'metrics' && !telemetryEnabled}
                key={item.value}
                onClick={() => onChange(item.value)}
              >
                <div className="flex flex-col">
                  <span>{item.label}</span>
                  <span className="text-muted-foreground text-xs">
                    {item.hint}
                  </span>
                </div>
                <DropdownMenuShortcut>
                  <Icon className="size-4 transition-all group-hover:rotate-12 group-hover:scale-125 group-hover:text-blue-500" />
                </DropdownMenuShortcut>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const METRIC_CHART_ICONS: Record<IMetricChartType, LucideIcon> = {
  linear: LineChartIcon,
  area: AreaChartIcon,
  histogram: ChartColumnIncreasingIcon,
  metric: GaugeIcon,
};

interface MetricChartTypeProps {
  className?: string;
  value: IChartType;
  onChange: (type: IChartType) => void;
}

/**
 * ReportChartType, offering only the chart types a metric report can draw.
 *
 * A separate component rather than a prop on ReportChartType because the
 * alternative — offering all eleven and correcting the choice in the reducer —
 * snaps the button back to Linear with no explanation. Worth folding back into
 * ReportChartType as a `types` prop once both live in the same change.
 */
export function MetricChartType({
  className,
  value,
  onChange,
}: MetricChartTypeProps) {
  // Falls back rather than rendering an empty button: a report saved before a
  // type left the list still has to show what it is set to.
  const ActiveIcon =
    METRIC_CHART_ICONS[value as IMetricChartType] ?? LineChartIcon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className={cn('justify-start', className)}
          icon={ActiveIcon}
          variant="outline"
        >
          {chartTypes[value]}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56">
        <DropdownMenuLabel>Available charts</DropdownMenuLabel>
        <DropdownMenuSeparator />

        <DropdownMenuGroup>
          {METRIC_CHART_TYPES.map((type) => {
            const Icon = METRIC_CHART_ICONS[type];
            return (
              <DropdownMenuItem
                className="group"
                key={type}
                onClick={() => onChange(type)}
              >
                {chartTypes[type]}
                <DropdownMenuShortcut>
                  <Icon className="size-4 transition-all group-hover:rotate-12 group-hover:scale-125 group-hover:text-blue-500" />
                </DropdownMenuShortcut>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
