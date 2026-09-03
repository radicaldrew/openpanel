import { pushModal } from '@/modals';
import type {
  ApplyFiltersInput,
  ChatClientToolHandlers,
  CreateDashboardInput,
  IReport,
  SaveReportInput,
  SetEventNamesFilterInput,
  SetPropertyFiltersInput,
} from '@openpanel/validation';

/**
 * Client-side handlers for tools the LLM can invoke to mutate page
 * state. Better Agent emits these as `tool-call` parts with no server
 * execution; the controller forwards each call to the matching entry
 * here, and the return value is sent back as the tool's `output`.
 *
 * Keep handlers tiny and side-effect-only — they shouldn't render UI
 * or maintain state of their own. The two write handlers at the bottom
 * push a modal, which is the same kind of fire-and-forget side effect:
 * they hand off to a dialog that already exists and own none of it.
 *
 * URL params we mutate map 1:1 to what the dashboard hooks read:
 *   - `range`, `start`, `end`, `overrideInterval` ← `useOverviewOptions`
 *   - `events`                                    ← `useEventQueryNamesFilter`
 *   - `f`                                         ← `useEventQueryFilters`
 *
 * After mutating the URL we dispatch a `popstate` event so nuqs picks
 * up the change without a hook subscription on our side.
 *
 * Handler types come from `@openpanel/validation` (shared with the
 * server's tool schemas) so the map stays in sync with the Zod inputs
 * without crossing the app boundary for its type.
 */

type PropertyFilter = SetPropertyFiltersInput['filters'][number];

function pushUrl(url: URL): void {
  window.history.pushState(null, '', url.toString());
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function applyFilters(input: ApplyFiltersInput): {
  applied: boolean;
  applied_filters: ApplyFiltersInput;
} {
  if (typeof window === 'undefined') {
    return { applied: false, applied_filters: input };
  }
  const url = new URL(window.location.href);

  if (input.startDate && input.endDate) {
    url.searchParams.set('range', 'custom');
    url.searchParams.set('start', input.startDate);
    url.searchParams.set('end', input.endDate);
  } else if (input.range) {
    url.searchParams.set('range', input.range);
    url.searchParams.delete('start');
    url.searchParams.delete('end');
  }

  if (input.interval) {
    url.searchParams.set('overrideInterval', input.interval);
  }

  pushUrl(url);
  return { applied: true, applied_filters: input };
}

/**
 * Mirrors the serializer in `useEventQueryFilters` — each filter is
 * `name,operator,value1|value2`, joined by `;`. We URL-encode the
 * values to match the parser.
 */
function serializePropertyFilters(filters: PropertyFilter[]): string {
  return filters
    .map((f) => {
      const op = f.operator ?? 'is';
      const values = f.value.map((v) => encodeURIComponent(v.trim())).join('|');
      return `${f.name},${op},${values}`;
    })
    .join(';');
}

function setPropertyFilters(input: SetPropertyFiltersInput): {
  applied: boolean;
  count: number;
} {
  if (typeof window === 'undefined') {
    return { applied: false, count: 0 };
  }
  const url = new URL(window.location.href);
  if (input.filters.length === 0) {
    url.searchParams.delete('f');
  } else {
    url.searchParams.set('f', serializePropertyFilters(input.filters));
  }
  pushUrl(url);
  return { applied: true, count: input.filters.length };
}

function setEventNamesFilter(input: SetEventNamesFilterInput): {
  applied: boolean;
  count: number;
} {
  if (typeof window === 'undefined') {
    return { applied: false, count: 0 };
  }
  const url = new URL(window.location.href);
  if (input.eventNames.length === 0) {
    url.searchParams.delete('events');
  } else {
    // nuqs `parseAsArrayOf(parseAsString)` defaults to comma-separated.
    url.searchParams.set('events', input.eventNames.join(','));
  }
  pushUrl(url);
  return { applied: true, count: input.eventNames.length };
}

/**
 * The write path — `save_report` and `create_dashboard`.
 *
 * These two are why the agent has no write tool of its own. Both open the
 * ordinary dialog a person uses and stop there; the row is created only when
 * the human submits that form, through the same trpc `report.create` /
 * `dashboard.create` the Save button behind every chart uses. The reasoning is
 * in the block comment at the top of apps/api/src/agents/tools/persist.ts —
 * the short version is that the same turn feeds the model event names and
 * property values collected through the public track API, so prompt text
 * ("ask first") is not a gate on a tool that writes.
 *
 * They return as soon as the dialog is OPEN, not when it is submitted. Better
 * Agent parks the whole run on a client tool until its result comes back
 * (`awaitClientToolResult`, bounded by `clientToolResultTimeoutMs`), so
 * awaiting a human filling in a form would hold the turn open for as long as
 * they take and then fail the run when they take too long. Both tool
 * descriptions and the prompt tell the model it is never told whether the user
 * went through with it.
 */

function saveReport(input: SaveReportInput): {
  dialog_opened: boolean;
  name: string;
} {
  if (typeof window === 'undefined') {
    return { dialog_opened: false, name: input.name };
  }

  pushModal('SaveReport', {
    report: {
      // `series: []` as a FLOOR, not a rewrite — anything the model sent wins.
      //
      // `save_report`'s schema gives `series` a default so a metrics report
      // (described entirely by `metricQuery`) is not bounced for a key it has
      // no use for, but that default never reaches us: Better Agent validates
      // a client tool's arguments server-side and then hands the CLIENT the
      // model's raw JSON, not the parsed value (`JSON.parse(pending.argsJson)`
      // in @better-agent/client's `processClientToolCall`). `report.create`
      // meanwhile still requires `series` — it is the one required key on
      // `zReport.omit({ projectId: true })` — so without this a metric report
      // saved from chat would fail in the tRPC call AFTER the user had picked
      // a dashboard and clicked Save. Everything else on a report carries a
      // schema default, so this is the whole gap.
      series: [],
      ...input.report,
      // The dialog prefills its name field from `report.name`; the model sends
      // the name it proposes separately.
      name: input.name,
    } as unknown as IReport,
    // Stay where the user is. The chat drawer is mounted globally and the
    // conversation is mid-turn — navigating to the new report out from under
    // it would bury the answer. The modal's success toast still offers
    // "View report".
    disableRedirect: true,
    // Makes the dialog show what it is about to write. Without it the only
    // human gate on an AI-initiated write is a name field and a dashboard
    // picker, which cannot tell the user whether the payload matches the chart
    // they just looked at.
    proposedBy: 'agent',
  });

  return { dialog_opened: true, name: input.name };
}

function createDashboard(input: CreateDashboardInput): {
  dialog_opened: boolean;
  suggested_name: string;
} {
  if (typeof window === 'undefined') {
    return { dialog_opened: false, suggested_name: input.name };
  }

  // `AddDashboard` takes no props — its name field starts empty. The suggested
  // name is echoed back instead so the model can state it in prose for the
  // user to type, which is what the tool description tells it to do.
  pushModal('AddDashboard');

  return { dialog_opened: true, suggested_name: input.name };
}

export const chatToolHandlers: ChatClientToolHandlers = {
  apply_filters: async (input) => applyFilters(input as ApplyFiltersInput),
  set_property_filters: async (input) =>
    setPropertyFilters(input as SetPropertyFiltersInput),
  set_event_names_filter: async (input) =>
    setEventNamesFilter(input as SetEventNamesFilterInput),
  save_report: async (input) => saveReport(input as SaveReportInput),
  create_dashboard: async (input) =>
    createDashboard(input as CreateDashboardInput),
};
