import { Button } from '@/components/ui/button';
import { handleError } from '@/integrations/trpc/react';
import { pushModal } from '@/modals';
import { useDispatch, useSelector } from '@/redux';
import { SaveIcon } from 'lucide-react';
import { toast } from 'sonner';

import { useTRPC } from '@/integrations/trpc/react';
import {
  useIsFetching,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';

import { useParams } from '@tanstack/react-router';
import { resetDirty } from './reportSlice';

interface ReportSaveButtonProps {
  className?: string;
}
export function ReportSaveButton({ className }: ReportSaveButtonProps) {
  const trpc = useTRPC();
  const fetching = [
    useIsFetching(trpc.chart.chart.pathFilter()),
    useIsFetching(trpc.chart.cohort.pathFilter()),
  ];
  const { reportId } = useParams({ strict: false });
  const dispatch = useDispatch();
  const queryClient = useQueryClient();
  const update = useMutation(
    trpc.report.update.mutationOptions({
      onSuccess(res) {
        dispatch(resetDirty());
        toast('Success', {
          description: 'Report updated.',
        });
        queryClient.invalidateQueries(
          trpc.report.list.queryFilter({
            dashboardId: res.dashboardId,
            projectId: res.projectId,
          }),
        );
      },
      onError: handleError,
    }),
  );
  const report = useSelector((state) => state.report);
  const isLoading = update.isPending || fetching.some((f) => f !== 0);

  // `dirty` alone is not enough to mean saveable. Flipping the source picker to
  // Metrics marks the report dirty immediately while seeding a query row that
  // has no metric in it yet, so a bare `!report.dirty` lights the button up on
  // a config the server will refuse — and it refuses it through `handleError`
  // as an opaque validation toast, right next to the chart slot already saying
  // "Pick a metric to chart it."
  //
  // Keyed on `expr` because that is the field the server validates:
  // `zPanelQuery` requires `expr.min(1)`, so ONE half-built row fails the whole
  // save even when the other rows are fine. The builder compiles to an empty
  // string for as long as the metric is unpicked, which is most of the time a
  // row spends being built.
  //
  // A report saved before multi-query panels has no `metricQueries` at all and
  // renders from the legacy `metricQuery`; renaming one has to stay saveable,
  // so that column satisfies the check on its own.
  //
  // The inverse half of the refinement — metric queries left on an events
  // report — needs no guard here: `changeDataSource` moves them to
  // `stashedMetricQueries` on the way out, so the editor cannot reach that
  // state.
  const metricQueries = report.metricQueries ?? [];
  const metricsSaveable =
    metricQueries.length > 0
      ? metricQueries.every((query) => query.expr.trim() !== '')
      : !!report.metricQuery?.metric;

  const canSave =
    report.dirty && (report.dataSource !== 'metrics' || metricsSaveable);

  if (reportId) {
    return (
      <Button
        className={className}
        disabled={!canSave}
        loading={update.isPending || isLoading}
        onClick={() => {
          update.mutate({
            reportId: reportId,
            report,
          });
        }}
        icon={SaveIcon}
      >
        Update
      </Button>
    );
  }
  return (
    <Button
      className={className}
      disabled={!canSave}
      onClick={() => {
        pushModal('SaveReport', {
          report,
        });
      }}
      icon={SaveIcon}
      loading={isLoading}
    >
      Save
    </Button>
  );
}
