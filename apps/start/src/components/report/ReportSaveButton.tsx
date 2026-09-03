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
  // Metrics marks the report dirty immediately while leaving `metricQuery`
  // undefined until a metric is chosen, so a bare `!report.dirty` lights the
  // button up on a config the server will refuse: `refineReportDataSource`
  // rejects `report.create`/`report.update` with "A metrics report needs a
  // metricQuery", which reaches the user through `handleError` as an opaque
  // validation toast — right next to the chart slot already saying "Pick a
  // metric to chart it."
  //
  // Keyed on `.metric` rather than on the query as a whole because the query is
  // reachable in a second unsaveable shape: the Function and Aggregation
  // pickers stay enabled before a metric is picked and write back
  // `emptyMetricQuery` with `metric: ''`, which satisfies the refinement (the
  // query is present) but fails `zMetricQuery`'s `metric.min(1)` even less
  // legibly. One guard covers both.
  //
  // The inverse half of the refinement — a `metricQuery` left on an events
  // report — needs no guard here: `changeDataSource` moves the query to
  // `stashedMetricQuery` on the way out and `changeMetricQuery` forces
  // `dataSource` to 'metrics', so the editor cannot reach that state.
  const canSave =
    report.dirty &&
    !(report.dataSource === 'metrics' && !report.metricQuery?.metric);

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
