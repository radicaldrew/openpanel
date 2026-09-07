import { FullPageEmptyState } from '@/components/full-page-empty-state';
import { useOverviewOptions } from '@/components/overview/useOverviewOptions';
import { Button, LinkButton } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { createProjectTitle } from '@/utils/title';
import {
  CompassIcon,
  LayoutPanelTopIcon,
  MoreHorizontal,
  PlusIcon,
  RotateCcw,
  SearchIcon,
  ShareIcon,
  TrashIcon,
  VariableIcon,
} from 'lucide-react';
import { toast } from 'sonner';

import { useDashboardVariables } from '@/components/dashboard/variables/use-dashboard-variables';
import { AnnotationsToolbar } from '@/components/annotations/annotations-toolbar';
import type { IAnnotation } from '@/components/annotations/annotation-utils';
import { annotationLabel } from '@/components/annotations/annotation-utils';
import { renderAnnotations } from '@/components/annotations/annotations-layer';
import { parseChartDate } from '@/utils/chart-dates';
import { useDashboardAnnotations } from '@/components/annotations/use-dashboard-annotations';
import { applyVariablesToReport } from '@/components/dashboard/variables/variable-values';
import { VariablesBar } from '@/components/dashboard/variables/variables-bar';
import FullPageLoadingState from '@/components/full-page-loading-state';
import {
  GrafanaGrid,
  type Layout,
  useReportLayouts,
} from '@/components/grafana-grid';
import { OverviewInterval } from '@/components/overview/overview-interval';
import { OverviewRange } from '@/components/overview/overview-range';
import { PageContainer } from '@/components/page-container';
import { PageHeader } from '@/components/page-header';
import { DashboardPanel } from '@/components/dashboard/dashboard-panel';
import { ReportItemSkeleton } from '@/components/report/report-item';
import { Input } from '@/components/ui/input';
import { useDashboardPageContext } from '@/hooks/use-page-context-helpers';
import { handleErrorToastOptions, useTRPC } from '@/integrations/trpc/react';
import { pushModal, showConfirm } from '@/modals';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useState } from 'react';

export const Route = createFileRoute(
  '/_app/$organizationId/$projectId/dashboards_/$dashboardId',
)({
  component: Component,
  head: () => {
    return {
      meta: [
        {
          title: createProjectTitle('Dashboard'),
        },
      ],
    };
  },
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.prefetchQuery(
        context.trpc.dashboard.byId.queryOptions({
          id: params.dashboardId,
          projectId: params.projectId,
        }),
      ),
      context.queryClient.prefetchQuery(
        context.trpc.report.list.queryOptions({
          dashboardId: params.dashboardId,
          projectId: params.projectId,
        }),
      ),
      context.queryClient.prefetchQuery(
        context.trpc.project.getProjectWithClients.queryOptions({
          projectId: params.projectId,
        }),
      ),
      context.queryClient.prefetchQuery(
        context.trpc.organization.get.queryOptions({
          organizationId: params.organizationId,
        }),
      ),
    ]);
  },
  pendingComponent: FullPageLoadingState,
});

function Component() {
  const router = useRouter();
  const { organizationId, dashboardId, projectId } = Route.useParams();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { range, startDate, endDate, interval } = useOverviewOptions();

  const dashboardQuery = useQuery(
    trpc.dashboard.byId.queryOptions({
      id: dashboardId,
      projectId,
    }),
  );

  const reportsQuery = useQuery(
    trpc.report.list.queryOptions({
      dashboardId,
      projectId,
    }),
  );

  const dashboardDeletion = useMutation(
    trpc.dashboard.delete.mutationOptions({
      onError: handleErrorToastOptions({}),
      onSuccess() {
        queryClient.invalidateQueries(trpc.dashboard.list.pathFilter());
        toast('Dashboard deleted');
        router.navigate({
          to: '/$organizationId/$projectId/dashboards',
          params: {
            organizationId,
            projectId,
          },
        });
      },
    }),
  );

  const reports = reportsQuery.data ?? [];
  const dashboard = dashboardQuery.data;

  // Rows saved before variables existed hold `[]`, so there is no null case.
  const variables = dashboard?.variables ?? [];
  const variableState = useDashboardVariables(variables, {
    projectId,
    range,
    startDate,
    endDate,
  });

  // One query for the whole page, not one per panel: twelve panels would
  // otherwise make twelve identical requests for the same project and window.
  const annotationState = useDashboardAnnotations({
    projectId,
    dashboardId,
    range,
    startDate,
    endDate,
  });

  const [isGridReady, setIsGridReady] = useState(false);
  const [enableTransitions, setEnableTransitions] = useState(false);
  const [search, setSearch] = useState('');

  const filteredReports = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return reports;
    return reports.filter((r) => r.name?.toLowerCase().includes(q));
  }, [reports, search]);

  /**
   * The reports as the panels should render them: the title with `$service`
   * resolved for display, and the variable values the panel's own queries
   * reference — nothing more.
   *
   * The narrowing is what makes the refetch selective. `variables` ends up in
   * the chart query input (report-chart's `useChartInput` spreads the whole
   * report), so it is part of the react-query key: a panel that references
   * `$service` gets a new key when `$service` changes, and a panel that
   * references `$env` or nothing at all keeps the key it had.
   */
  const reportsWithVariables = useMemo(() => {
    if (variables.length === 0) {
      return filteredReports;
    }

    return filteredReports.map((report) =>
      applyVariablesToReport(report, variableState.values),
    );
  }, [filteredReports, variables.length, variableState.values]);

  /**
   * The annotation markers, built once for the whole dashboard.
   *
   * An ARRAY of Recharts elements, which is what the charts' `annotations`
   * slot takes — a fragment or a wrapper component silently draws nothing (see
   * `renderAnnotations`). Built here rather than per panel because every line
   * and area panel on the dashboard shares one time domain and one list.
   */
  const annotationDeletion = useMutation(
    trpc.annotation.delete.mutationOptions({
      onError: handleErrorToastOptions({}),
      onSuccess() {
        queryClient.invalidateQueries(trpc.annotation.list.pathFilter());
        toast('Annotation deleted');
      },
    }),
  );

  const onSelectAnnotation = useCallback(
    (annotation: IAnnotation) => {
      // The confirm dialog rather than a bespoke popover: deleting is the only
      // action offered on a marker, the text and tags are already in the
      // marker's hover title, and this is how every other delete on this page
      // asks. Offered to anyone — the server lets any member with write access
      // on the project delete any annotation in it, and gating the button on
      // authorship would hide something the caller is entitled to do.
      showConfirm({
        title: 'Delete annotation',
        text: annotationLabel(annotation),
        onConfirm: () =>
          annotationDeletion.mutate({ id: annotation.id, projectId }),
      });
    },
    [annotationDeletion, projectId],
  );

  const annotationNodes = useMemo(() => {
    if (!(annotationState.enabled && annotationState.domain)) {
      return undefined;
    }

    const nodes = renderAnnotations({
      annotations: annotationState.annotations,
      domain: annotationState.domain,
      onSelect: onSelectAnnotation,
    });

    // `undefined` rather than `[]` so a dashboard with no annotations passes
    // nothing at all to the charts.
    return nodes.length > 0 ? nodes : undefined;
  }, [
    annotationState.enabled,
    annotationState.domain,
    annotationState.annotations,
    onSelectAnnotation,
  ]);

  /**
   * Cmd/Ctrl+click on a chart point opens the create modal at that moment.
   *
   * The payload's `date` is the clicked bucket's own date string, so the
   * modal's range prefill lands on the following bucket on the same grid.
   */
  const onModifierClick = useCallback(
    ({ date }: { date: string; metaKey: boolean; ctrlKey: boolean }) => {
      // `parseChartDate`, not `new Date`. A bucket date is
      // `formatClickhouseDate` output — "2026-09-07 10:00:00", a UTC instant
      // with no zone marker — and `new Date` reads that space-separated form
      // as LOCAL time, so the annotation would land hours from where it was
      // clicked for anyone outside UTC. Invisible on a UTC machine.
      let time: Date;
      try {
        time = parseChartDate(date);
      } catch {
        return;
      }

      if (Number.isNaN(time.getTime())) {
        return;
      }

      pushModal('CreateAnnotation', {
        projectId,
        dashboardId,
        time,
        interval: interval ?? 'day',
      });
    },
    [projectId, dashboardId, interval],
  );

  // Wait for initial render to ensure grid has proper dimensions
  useEffect(() => {
    if (reports.length > 0 && !isGridReady) {
      // Small delay to ensure container has rendered with proper width
      const timer = setTimeout(() => {
        setIsGridReady(true);
        // Enable transitions after initial render
        setTimeout(() => setEnableTransitions(true), 100);
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [reports.length, isGridReady]);

  const reportDeletion = useMutation(
    trpc.report.delete.mutationOptions({
      onError: handleErrorToastOptions({}),
      onSuccess() {
        queryClient.invalidateQueries(trpc.dashboard.list.pathFilter());
        reportsQuery.refetch();
        toast('Report deleted');
      },
    }),
  );

  const reportDuplicate = useMutation(
    trpc.report.duplicate.mutationOptions({
      onError: handleErrorToastOptions({}),
      onSuccess() {
        queryClient.invalidateQueries(trpc.dashboard.list.pathFilter());
        reportsQuery.refetch();
        toast('Report duplicated');
      },
    }),
  );

  const updateLayout = useMutation(
    trpc.report.updateLayout.mutationOptions({
      onError: handleErrorToastOptions({}),
      onSuccess() {
        // Silently refetch reports (which includes layouts)
        reportsQuery.refetch();
      },
    }),
  );

  const resetLayout = useMutation(
    trpc.report.resetLayout.mutationOptions({
      onError: handleErrorToastOptions({}),
      onSuccess() {
        toast('Layout reset to default');
        reportsQuery.refetch();
      },
    }),
  );

  // Convert reports to grid layout format for all breakpoints
  const layouts = useReportLayouts(reportsWithVariables);

  const dashboardPrimer = useMemo(
    () => ({
      name: dashboard?.name,
      reportCount: reports.length,
      reports: reports.map((r) => ({
        id: r.id,
        name: r.name,
        chartType: r.chartType,
      })),
    }),
    [dashboard?.name, reports],
  );

  useDashboardPageContext(dashboardId, dashboardPrimer);

  const handleLayoutChange = useCallback((newLayout: Layout[]) => {
    // This is called during dragging/resizing, we'll save on drag/resize stop
  }, []);

  const handleDragStop = useCallback(
    (newLayout: Layout[]) => {
      // Save each changed layout after drag stops
      newLayout.forEach((item) => {
        const report = reports.find((r) => r.id === item.i);
        if (report) {
          const oldLayout = report.layout;
          // Only update if layout actually changed
          if (
            !oldLayout ||
            oldLayout.x !== item.x ||
            oldLayout.y !== item.y ||
            oldLayout.w !== item.w ||
            oldLayout.h !== item.h
          ) {
            updateLayout.mutate({
              reportId: item.i,
              layout: {
                x: item.x,
                y: item.y,
                w: item.w,
                h: item.h,
                minW: item.minW ?? 3,
                minH: item.minH ?? 3,
              },
            });
          }
        }
      });
    },
    [reports, updateLayout],
  );

  const handleResizeStop = useCallback(
    (newLayout: Layout[]) => {
      // Save each changed layout after resize stops
      newLayout.forEach((item) => {
        const report = reports.find((r) => r.id === item.i);
        if (report) {
          const oldLayout = report.layout;
          // Only update if layout actually changed
          if (
            !oldLayout ||
            oldLayout.x !== item.x ||
            oldLayout.y !== item.y ||
            oldLayout.w !== item.w ||
            oldLayout.h !== item.h
          ) {
            updateLayout.mutate({
              reportId: item.i,
              layout: {
                x: item.x,
                y: item.y,
                w: item.w,
                h: item.h,
                minW: item.minW ?? 3,
                minH: item.minH ?? 3,
              },
            });
          }
        }
      });
    },
    [reports, updateLayout],
  );

  if (!dashboard) {
    return null; // Loading handled by suspense
  }

  return (
    <PageContainer>
      <PageHeader
        title={dashboard.name}
        description="View and manage your reports"
        className="mb-4"
        actions={
          <>
            {reports.length > 0 && (
              <div className="relative">
                <SearchIcon className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                <Input
                  type="search"
                  placeholder="Search reports..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-8 w-[180px] sm:w-[220px]"
                />
              </div>
            )}
            <OverviewRange />
            <OverviewInterval />
            <AnnotationsToolbar state={annotationState} />
            <LinkButton
              from={Route.fullPath}
              to={'/$organizationId/$projectId/reports'}
              icon={PlusIcon}
            >
              <span className="max-sm:hidden">Create report</span>
              <span className="sm:hidden">Report</span>
            </LinkButton>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-[200px]">
                <DropdownMenuGroup>
                  <DropdownMenuItem
                    onClick={() =>
                      pushModal('ShareDashboardModal', { dashboardId })
                    }
                  >
                    <ShareIcon className="mr-2 size-4" />
                    Share dashboard
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() =>
                      pushModal('DashboardVariables', {
                        dashboardId,
                        variables,
                      })
                    }
                  >
                    <VariableIcon className="mr-2 size-4" />
                    {variables.length > 0 ? 'Edit variables' : 'Add variables'}
                  </DropdownMenuItem>
                  {variables.length > 0 && (
                    <DropdownMenuItem
                      onClick={() =>
                        // The current selection travels as the same
                        // `var_<name>` params the dashboard uses, so Explore
                        // opens on what is on screen rather than on defaults.
                        router.navigate({
                          to: '/$organizationId/$projectId/metrics',
                          params: { organizationId, projectId },
                          search: variableState.searchParams,
                        })
                      }
                    >
                      <CompassIcon className="mr-2 size-4" />
                      Open in Explore
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    onClick={() =>
                      showConfirm({
                        title: 'Reset layout',
                        text: 'Are you sure you want to reset the layout to default? This will clear all custom positioning and sizing.',
                        onConfirm: () =>
                          resetLayout.mutate({ dashboardId, projectId }),
                      })
                    }
                  >
                    <RotateCcw className="mr-2 size-4" />
                    Reset layout
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() =>
                      showConfirm({
                        title: 'Delete dashboard',
                        text: 'Are you sure you want to delete this dashboard? All your reports will be deleted!',
                        onConfirm: () =>
                          dashboardDeletion.mutate({ id: dashboardId }),
                      })
                    }
                  >
                    <TrashIcon className="mr-2 size-4" />
                    Delete dashboard
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      <VariablesBar
        dashboardId={dashboardId}
        variables={variables}
        state={variableState}
      />

      {reports.length === 0 ? (
        <FullPageEmptyState title="No reports" icon={LayoutPanelTopIcon}>
          <p>You can visualize your data with a report</p>
          <LinkButton
            from={Route.fullPath}
            to={'/$organizationId/$projectId/reports'}
            className="mt-14"
            icon={PlusIcon}
          >
            Create report
          </LinkButton>
        </FullPageEmptyState>
      ) : !isGridReady ||
        reportsQuery.isLoading ||
        // A panel run against an unresolved `$service` fails on the server
        // rather than waiting, so hold the grid while the variables are still
        // resolving. Only while they are LOADING — a variable whose options
        // failed lets the panels through, so the failure shows up as a panel
        // error next to the bar's error rather than as a permanent skeleton.
        variableState.isResolving ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <ReportItemSkeleton />
          <ReportItemSkeleton />
          <ReportItemSkeleton />
          <ReportItemSkeleton />
          <ReportItemSkeleton />
          <ReportItemSkeleton />
        </div>
      ) : reportsWithVariables.length === 0 ? (
        <FullPageEmptyState title="No matching reports" icon={SearchIcon}>
          <p>No reports match "{search}". Try a different search.</p>
        </FullPageEmptyState>
      ) : (
        <GrafanaGrid
          transitions={enableTransitions}
          layouts={layouts}
          onLayoutChange={handleLayoutChange}
          onDragStop={handleDragStop}
          onResizeStop={handleResizeStop}
          isDraggable={!search}
          isResizable={!search}
        >
          {reportsWithVariables.map((report) => (
            <div key={report.id}>
              <DashboardPanel
                report={report}
                annotations={annotationNodes}
                onModifierClick={onModifierClick}
                variables={variableState.values}
                organizationId={organizationId}
                projectId={projectId}
                range={range}
                startDate={startDate}
                endDate={endDate}
                interval={interval}
                onDelete={(reportId) => {
                  reportDeletion.mutate({ reportId });
                }}
                onDuplicate={(reportId) => {
                  reportDuplicate.mutate({ reportId });
                }}
                onMove={(reportId) => {
                  pushModal('MoveReport', { reportId, dashboardId });
                }}
              />
            </div>
          ))}
        </GrafanaGrid>
      )}
    </PageContainer>
  );
}
