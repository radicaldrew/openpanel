import type { IServiceReport } from '@openpanel/db';
import { useQuery } from '@tanstack/react-query';
import { GanttChartSquareIcon, ShareIcon } from 'lucide-react';
import { useEffect } from 'react';
import EditReportName from '../report/edit-report-name';
import { MetricQueryEditor } from '@/components/report/metric-query-editor';
import { ReportChartType } from '@/components/report/ReportChartType';
import { ReportInterval } from '@/components/report/ReportInterval';
import { ReportLineType } from '@/components/report/ReportLineType';
import { ReportSaveButton } from '@/components/report/ReportSaveButton';
import {
  MetricChartType,
  ReportDataSource,
} from '@/components/report/report-data-source';
import {
  changeChartType,
  changeDataSource,
  changeDateRanges,
  changeEndDate,
  changeInterval,
  changeMetricQuery,
  changeStartDate,
  ready,
  reset,
  setReport,
} from '@/components/report/reportSlice';
import { ReportSidebar } from '@/components/report/sidebar/ReportSidebar';
import { ReportChart } from '@/components/report-chart';
import { TimeWindowPicker } from '@/components/time-window-picker';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { useAppParams } from '@/hooks/use-app-params';
import { useTRPC } from '@/integrations/trpc/react';
import { pushModal } from '@/modals';
import { useDispatch, useSelector } from '@/redux';

interface ReportEditorProps {
  report: IServiceReport | null;
}

export default function ReportEditor({
  report: initialReport,
}: ReportEditorProps) {
  const { projectId } = useAppParams();
  const dispatch = useDispatch();
  const trpc = useTRPC();
  const report = useSelector((state) => state.report);

  // A metric report is driven by a PromQL query, not by event series, so the
  // event picker below would offer controls that cannot change what it draws.
  // Everything else in this editor — range, interval, name — is source-agnostic
  // and works on both; chart type is shared but narrower, see MetricChartType.
  const isMetricReport = report.dataSource === 'metrics';

  // Whether this deployment has a telemetry backend at all. Without one there
  // is no second source to offer, and the metric pickers would query a project
  // that has never written a metric.
  const telemetry = useQuery(trpc.observability.enabled.queryOptions());
  const telemetryEnabled = telemetry.data?.enabled ?? false;

  // Set report if reportId exists
  useEffect(() => {
    if (initialReport) {
      dispatch(setReport(initialReport));
    } else {
      dispatch(ready());
    }

    return () => {
      dispatch(reset());
    };
  }, [initialReport, dispatch]);

  return (
    <Sheet>
      <div>
        <div className="flex items-center justify-between p-4">
          <EditReportName />
          {initialReport?.id && (
            <Button
              icon={ShareIcon}
              onClick={() =>
                pushModal('ShareReportModal', { reportId: initialReport.id })
              }
              variant="outline"
            >
              Share
            </Button>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2 p-4 pt-0 md:grid-cols-6">
          {/* Source first, then whatever that source is configured with: the
              event picker here, or the metric query on its own row below —
              four controls do not fit in a cell sized for one button. */}
          <div className="flex flex-col gap-2 self-start">
            <ReportDataSource
              onChange={(next) => dispatch(changeDataSource(next))}
              telemetryEnabled={telemetryEnabled}
              value={report.dataSource ?? 'events'}
            />
            {!isMetricReport && (
              <SheetTrigger asChild>
                <Button icon={GanttChartSquareIcon} variant="cta">
                  Pick events
                </Button>
              </SheetTrigger>
            )}
          </div>
          <div className="col-span-4 grid grid-cols-2 gap-2 md:grid-cols-4">
            {isMetricReport ? (
              <MetricChartType
                className="min-w-0 flex-1"
                onChange={(type) => {
                  dispatch(changeChartType(type));
                }}
                value={report.chartType}
              />
            ) : (
              <ReportChartType
                className="min-w-0 flex-1"
                onChange={(type) => {
                  dispatch(changeChartType(type));
                }}
                value={report.chartType}
              />
            )}
            <TimeWindowPicker
              className="min-w-0 flex-1"
              endDate={report.endDate}
              onChange={(value) => {
                dispatch(changeDateRanges(value));
              }}
              onEndDateChange={(date) => dispatch(changeEndDate(date))}
              onIntervalChange={(interval) =>
                dispatch(changeInterval(interval))
              }
              onStartDateChange={(date) => dispatch(changeStartDate(date))}
              startDate={report.startDate}
              value={report.range}
            />
            <ReportInterval
              chartType={report.chartType}
              className="min-w-0 flex-1"
              endDate={report.endDate}
              interval={report.interval}
              onChange={(newInterval) => dispatch(changeInterval(newInterval))}
              range={report.range}
              startDate={report.startDate}
            />
            <ReportLineType className="min-w-0 flex-1" />
          </div>
          <div className="col-start-2 row-start-1 text-right md:col-start-6">
            <ReportSaveButton />
          </div>
        </div>
        {isMetricReport && (
          <div className="px-4 pb-2">
            <MetricQueryEditor
              enabled={telemetryEnabled}
              onChange={(next) => dispatch(changeMetricQuery(next))}
              projectId={projectId}
              value={report.metricQuery ?? null}
            />
          </div>
        )}
        <div className="flex flex-col gap-4 p-4" id="report-editor">
          {report.ready &&
            (isMetricReport && !report.metricQuery?.metric ? (
              // A metrics report with no query throws in the engine rather than
              // drawing an empty chart, so a report that has just been switched
              // over has to be held back until a metric is chosen. Same wording
              // as the metrics explorer's own placeholder.
              <div className="rounded-lg border border-dashed p-12 text-center text-muted-foreground">
                Pick a metric to chart it.
              </div>
            ) : (
              <ReportChart isEditMode report={{ ...report, projectId }} />
            ))}
        </div>
      </div>
      <SheetContent className="!max-w-lg" side="left">
        <ReportSidebar />
      </SheetContent>
    </Sheet>
  );
}
