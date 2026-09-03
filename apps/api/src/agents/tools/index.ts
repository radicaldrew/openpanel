import type { AgentToolDefinition } from '@better-agent/core';
import { isGigapipeEnabled } from '@openpanel/gigapipe';
import type { ChatAgentContext } from '../context';
import * as base from './base';
import * as dashboard from './dashboard';
import * as events from './events';
import * as groups from './groups';
import * as insights from './insights';
import * as metrics from './metrics';
import * as pages from './pages';
import * as persist from './persist';
import * as profile from './profile';
import * as references from './references';
import * as report from './report';
import * as seo from './seo';
import * as session from './session';
import * as ui from './ui';

// Tool arrays are typed loosely as `AgentToolDefinition[]` — without
// this, TypeScript tries to compute the union of every tool's schema +
// result type and hits its instantiation depth limit.
type ToolList = AgentToolDefinition[];

/**
 * Always-available base tool set: discovery + saved reports + aggregate
 * analytics + free-form queries. Every chat session starts here.
 */
const BASE_TOOLS: ToolList = [
  // Discovery
  base.listEventNames,
  base.listEventProperties,
  base.getEventPropertyValues,
  // Saved dashboards & reports
  base.listDashboards,
  base.listReports,
  base.getReportData,
  base.generateReport,
  // Aggregate analytics
  base.getAnalyticsOverview,
  base.getTopPages,
  base.getTopReferrers,
  base.getCountryBreakdown,
  base.getDeviceBreakdown,
  base.getRollingActiveUsers,
  base.getFunnel,
  base.getRetentionCohort,
  base.getUserFlow,
  // Free-form queries
  base.queryEvents,
  base.querySessions,
  base.findProfiles,
  // References — manual annotations the user adds for real-world
  // events (campaigns, deploys, announcements). Available everywhere
  // because "what happened around X?" is a useful question on
  // every page, not just the overview.
  references.listReferences,
  references.getReferencesAround,
] as AgentToolDefinition[];

/**
 * Observability discovery — the metric analogue of the event-name /
 * property tools above. Layered onto the base set on every page, but only
 * when the deployment has a telemetry backend; see `composeChatTools`.
 */
const METRICS_TOOLS: ToolList = [
  metrics.listTelemetryServices,
  metrics.listMetrics,
  metrics.describeMetric,
  metrics.getMetricLabelValues,
] as AgentToolDefinition[];

/**
 * The two write-intent tools. Neither one writes: both are `.client()`
 * declarations whose frontend handler opens the ordinary Save-report /
 * Add-dashboard dialog, and the row is created only when the human submits
 * that form through trpc (see the block comment at the top of persist.ts).
 *
 * That is why they now sit in the BASE set instead of being scoped to
 * `reportEditor` and `dashboard`. The old scoping existed because these were
 * auto-executing mutations — "a write tool the model can see on every page is
 * a write tool it can talk itself into on every page" — and because a report
 * saved from, say, a profile drill-down landed on a dashboard the user was
 * not looking at. Neither holds any more: the model cannot complete the write
 * at all, and the person choosing the destination in the dialog is the one
 * who then gets the "View report" toast.
 *
 * Meanwhile the scoping was actively wrong. `save_report` was reachable only
 * from `case 'reportEditor'` and `case 'dashboard'`, and the two pages where
 * "save this chart" is the natural ask reached neither: the metrics explorer
 * registered no page context at all, so it fell to `default:`, and the
 * dashboards LIST route registered none either. "Chart my request latency and
 * save it" — the whole point of the metrics work — could not complete from the
 * page the chart was on. Both pages now register (see
 * `use-page-context-helpers.ts`), but only so the model knows where the user
 * is: the list route still has no `dashboardId`, by design, and putting the
 * write tools back behind a page would recreate the same hole the next time
 * someone adds a page that renders a chart.
 */
const WRITE_TOOLS: ToolList = [
  persist.saveReport,
  persist.createDashboard,
] as AgentToolDefinition[];

const PROFILE_TOOLS: ToolList = [
  profile.getProfileFull,
  profile.getProfileEvents,
  profile.getProfileSessions,
  profile.getProfileMetrics,
  profile.getProfileJourney,
  profile.getProfileGroups,
  profile.compareProfileToAverage,
] as AgentToolDefinition[];

const SESSION_TOOLS: ToolList = [
  session.getSessionFull,
  session.getSessionPath,
  session.getSessionEvents,
  session.getSimilarSessions,
  session.compareSessionToTypical,
  session.getSessionReferrerContext,
  session.getSessionReplaySummary,
] as AgentToolDefinition[];

const REPORT_EDITOR_TOOLS: ToolList = [
  report.previewReportWithChanges,
  report.suggestBreakdowns,
  report.compareToPreviousPeriod,
  report.findAnomaliesInCurrentReport,
  report.explainFilterImpact,
] as AgentToolDefinition[];

const PAGES_TOOLS: ToolList = [
  pages.getPagePerformance,
  pages.getPageConversions,
  pages.getEntryExitPages,
  pages.findDecliningPages,
] as AgentToolDefinition[];

const SEO_TOOLS: ToolList = [
  seo.gscGetOverview,
  seo.gscGetTopQueries,
  seo.gscGetTopPages,
  seo.gscGetQueryDetails,
  seo.gscGetPageDetails,
  seo.gscGetQueryOpportunities,
  seo.gscGetCannibalization,
  seo.correlateSeoWithTraffic,
] as AgentToolDefinition[];

const EVENTS_TOOLS: ToolList = [
  events.analyzeEventDistribution,
  events.correlateEvents,
  events.getEventPropertyDistribution,
  events.listPropertiesForEvent,
] as AgentToolDefinition[];

const INSIGHTS_TOOLS: ToolList = [
  insights.listInsights,
  insights.explainInsight,
  insights.findRelatedInsights,
] as AgentToolDefinition[];

const GROUP_TOOLS: ToolList = [
  groups.getGroupFull,
  groups.getGroupMembers,
  groups.getGroupEvents,
  groups.getGroupMetrics,
  groups.compareGroups,
] as AgentToolDefinition[];

const DASHBOARD_TOOLS: ToolList = [
  dashboard.summarizeDashboard,
] as AgentToolDefinition[];

// Client-side UI mutators. Available on pages that have user-
// settable filters (date range, event names, property filters) so
// the assistant can act on requests like "filter to last 7 days",
// "show me only signups", or "referrers from GitHub" instead of
// just describing data.
const UI_TOOLS: ToolList = [
  ui.applyFilters,
  ui.setEventNamesFilter,
  ui.setPropertyFilters,
] as AgentToolDefinition[];

/**
 * Compose the chat tool set for a given request. Base tools are always
 * present; page-specific tools layer on top.
 *
 * Page-specific tools are only included when the corresponding entity
 * id is present in pageContext (e.g. profile tools require profileId),
 * so the LLM doesn't see tools it can't usefully call.
 *
 * The LLM sees fewer-but-more-focused tools per page, which produces
 * better tool selection than one giant flat registry.
 *
 * Two layers do NOT key off the page, for reasons given at each: metric
 * discovery keys off whether the deployment has telemetry at all, and the
 * write-intent tools are in the base set because they no longer write.
 */
export function composeChatTools(context: ChatAgentContext) {
  const page = context.pageContext?.page;
  const ids = context.pageContext?.ids;

  // Telemetry discovery is gated on the DEPLOYMENT, not the page. Page is
  // the wrong axis for it: `generate_report` is a base tool and now accepts
  // `dataSource: "metrics"` everywhere, and its description tells the model
  // to call list_metrics before naming a metric — scoping discovery to one
  // page would point that instruction at a tool the model cannot see, and a
  // guessed metric name compiles fine and charts nothing, which reads as "no
  // traffic" rather than "no such metric". Deployment is what actually
  // varies: without a telemetry backend all four tools can only answer "not
  // configured", so an events-only install sees exactly the base set it saw
  // before. `buildBasePrompt` takes the same flag for the same reason.
  //
  // The write-intent tools ride along on every page — see WRITE_TOOLS.
  const baseTools = isGigapipeEnabled()
    ? [...BASE_TOOLS, ...METRICS_TOOLS, ...WRITE_TOOLS]
    : [...BASE_TOOLS, ...WRITE_TOOLS];

  switch (page) {
    case 'profileDetail':
      return ids?.profileId
        ? [...baseTools, ...PROFILE_TOOLS, ...UI_TOOLS]
        : [...baseTools, ...UI_TOOLS];
    case 'sessionDetail':
      return ids?.sessionId ? [...baseTools, ...SESSION_TOOLS] : baseTools;
    case 'reportEditor':
      // The editor tools operate ON the draft and are useless without one.
      return context.pageContext?.reportDraft
        ? [...baseTools, ...REPORT_EDITOR_TOOLS]
        : baseTools;
    case 'pages':
      return [...baseTools, ...PAGES_TOOLS, ...UI_TOOLS];
    case 'seo':
      return [...baseTools, ...SEO_TOOLS, ...UI_TOOLS];
    case 'events':
      return [...baseTools, ...EVENTS_TOOLS, ...UI_TOOLS];
    case 'insights':
      return [...baseTools, ...INSIGHTS_TOOLS, ...UI_TOOLS];
    case 'groupDetail':
      return ids?.groupId ? [...baseTools, ...GROUP_TOOLS] : baseTools;
    case 'dashboard':
      // No dashboardId means the dashboards LIST page, which has neither a
      // dashboard to summarize nor any of the filters UI_TOOLS mutate — they
      // would push URL params nothing on that page reads, and the model would
      // report a change that never happened.
      return ids?.dashboardId
        ? [...baseTools, ...DASHBOARD_TOOLS, ...UI_TOOLS]
        : baseTools;
    case 'metrics':
      // The metrics explorer keeps its range, interval and metric in local
      // React state, not in the URL — so UI_TOOLS are deliberately absent
      // here: apply_filters would push `range`/`start`/`end` params that page
      // never reads, leaving the model to announce a filter change that did
      // not happen. The page registers itself anyway (`useMetricsPageContext`)
      // and hands over the window it is actually drawing, so "Current view"
      // reports the truth instead of nuqs defaults; the four METRICS_TOOLS
      // already ride along in baseTools wherever telemetry is configured.
      return baseTools;
    case 'overview':
      return [...baseTools, ...UI_TOOLS];
    default:
      return baseTools;
  }
}
