import { useOverviewOptions } from '@/components/overview/useOverviewOptions';
import { useSelector } from '@/redux';
import {
  type PageContext,
  type PageContextPage,
  usePageContext,
} from '@/contexts/page-context';
import {
  useEventQueryFilters,
  useEventQueryNamesFilter,
} from './use-event-query-filters';
import { useAppParams } from './use-app-params';
import type {
  IChartRange,
  IInterval,
  IReportInput,
} from '@openpanel/validation';

/**
 * For pages that share the standard date-range / interval filters
 * (Overview, Insights, Pages, SEO, Events, etc.). Reads the current
 * range + interval from `useOverviewOptions` and registers the page
 * context.
 */
export function useRangePageContext(page: PageContextPage) {
  const { projectId, organizationId } = useAppParams();
  const { range, startDate, endDate, interval } = useOverviewOptions();
  const [eventNames] = useEventQueryNamesFilter();
  const [eventFilters] = useEventQueryFilters();

  usePageContext({
    page,
    route: { projectId, organizationId },
    filters: {
      range,
      startDate: startDate ?? undefined,
      endDate: endDate ?? undefined,
      interval: interval ?? undefined,
      // Send the active event-name + property filters so the chat
      // assistant can reason about the current view (e.g. "you're
      // already filtering to mobile") and produce diff-style
      // updates via the apply_filters tool.
      ...(eventNames.length > 0 ? { eventNames } : {}),
      ...(eventFilters.length > 0 ? { eventFilters } : {}),
    },
  });
}

/**
 * For entity-detail pages (session detail, profile detail, group detail).
 * Takes the primary IDs + an optional primer object (small structured
 * snapshot of what's visible — country, device, duration, etc.) so the
 * model can answer trivial follow-ups without a tool call.
 */
export function useEntityPageContext(
  page: 'sessionDetail' | 'profileDetail' | 'groupDetail',
  ids: PageContext['ids'],
  primer?: Record<string, unknown>,
) {
  const { projectId, organizationId } = useAppParams();

  usePageContext({
    page,
    route: { projectId, organizationId },
    ids,
    primer,
  });
}

/**
 * For the Dashboard detail page. Sends the dashboardId + the active
 * range/interval picker (so `summarize_dashboard` runs each report
 * against whatever window the user is currently viewing) plus an
 * optional primer with the dashboard name + report list, so the model
 * can answer "what's on this dashboard?" without an extra tool call.
 */
export function useDashboardPageContext(
  dashboardId: string,
  primer?: Record<string, unknown>,
) {
  const { projectId, organizationId } = useAppParams();
  const { range, startDate, endDate, interval } = useOverviewOptions();

  usePageContext({
    page: 'dashboard',
    route: { projectId, organizationId },
    ids: { dashboardId },
    filters: {
      range,
      startDate: startDate ?? undefined,
      endDate: endDate ?? undefined,
      interval: interval ?? undefined,
    },
    ...(primer ? { primer } : {}),
  });
}

/**
 * For the metrics explorer.
 *
 * It cannot use `useRangePageContext`, and the difference is not cosmetic:
 * that helper reads the window from `useOverviewOptions`, i.e. from the URL,
 * and the metrics page keeps its range, custom dates and interval in local
 * React state — none of it is in the URL. Registering through it would tell
 * the model "Date range: 30d" (the nuqs default) while the page is drawing 7d,
 * and the model would then compose a chart over a window the user never chose
 * and describe it back as the one on screen. So the page passes what it is
 * actually rendering.
 *
 * No `eventNames` / `eventFilters` either — the metrics page has neither, and
 * the same fact keeps the UI-mutator tools off this page's tool set (see
 * `case 'metrics'` in apps/api/src/agents/tools/index.ts).
 */
export function useMetricsPageContext(view: {
  range: IChartRange;
  startDate: string | null;
  endDate: string | null;
  interval: IInterval;
}) {
  const { projectId, organizationId } = useAppParams();

  usePageContext({
    page: 'metrics',
    route: { projectId, organizationId },
    filters: {
      range: view.range,
      startDate: view.startDate ?? undefined,
      endDate: view.endDate ?? undefined,
      interval: view.interval,
    },
  });
}

/**
 * For the dashboards LIST page.
 *
 * Same `page` value as the detail route but with no `dashboardId`, which is
 * exactly how `composeChatTools` tells them apart: without an id there is no
 * dashboard to summarize and none of the filters the UI-mutator tools push, so
 * the list page gets the base set. It is worth registering anyway — "create a
 * dashboard called X" is a natural ask here, and until now this page sent no
 * context at all, so the model was not even told where the user was standing.
 */
export function useDashboardListPageContext() {
  const { projectId, organizationId } = useAppParams();

  usePageContext({
    page: 'dashboard',
    route: { projectId, organizationId },
  });
}

/**
 * For the Report Editor page. Sends the full live report draft so the
 * model can propose concrete edits via `preview_report_with_changes`.
 */
/**
 * The NEW-report editor, which has no saved report to load.
 *
 * Its draft exists only in the redux slice, so without this the one page that
 * is nothing but a live report draft registered no context at all —
 * `composeChatTools` fell through to `default:` and the model never got
 * REPORT_EDITOR_TOOLS (`preview_report_with_changes`, `suggest_breakdowns`,
 * `explain_filter_impact`) on the page where they are most useful.
 *
 * Held back until `ready`, because before the editor mounts the slice is
 * `initialState` — an empty draft the model would read as a real one.
 */
export function useReportDraftPageContext() {
  const draft = useSelector((state) => state.report);

  useReportEditorContext(
    draft.ready ? (draft as unknown as IReportInput) : null,
  );
}

export function useReportEditorContext(reportDraft: IReportInput | null) {
  const { projectId, organizationId } = useAppParams();

  // The draft can be null while the report loads — the cleanup handler
  // in usePageContext clears it on unmount, so passing null on every
  // render before the data arrives is safe (we just register a context
  // without a draft until the first render with a real draft).
  usePageContext({
    page: 'reportEditor',
    route: { projectId, organizationId },
    ...(reportDraft ? { reportDraft } : {}),
  });
}
