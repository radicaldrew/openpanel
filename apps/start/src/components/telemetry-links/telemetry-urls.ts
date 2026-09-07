import { encodeQueries } from '@/components/explore/explore-url-state';
import { createPanelQuery } from '@/components/promql/panel-query';
import { parseChartDate } from '@/utils/chart-dates';
import { compileBuilder } from '@openpanel/common';
import type {
  IInterval,
  IPanelQuery,
  IPromqlBuilderState,
  IVariableValues,
} from '@openpanel/validation';

/**
 * Every link between the telemetry surfaces, built in one place.
 *
 * Correlation is only worth anything if the link lands somewhere exact — "the
 * logs for THIS minute of THIS service", not "the logs page". That means the
 * window and the service have to be computed identically wherever the link is
 * offered: from a dashboard panel's click menu (dev2's route), from Explore
 * (mine), from a log line, from a span. Three implementations of "±1 bucket"
 * would drift, and the drift would be invisible — a link that lands on a window
 * an hour wide instead of a minute still looks like it worked.
 *
 * So these return route targets rather than strings: `{ to, params, search }`
 * is what both `<Link>` and `router.navigate` take, which keeps the navigation
 * in the same tab and in the history, so Back returns to the chart.
 */

export interface ProjectRoute {
  organizationId: string;
  projectId: string;
}

export interface TelemetryLink {
  to: string;
  params: { organizationId: string; projectId: string };
  search: Record<string, string>;
}

const LOGS_ROUTE = '/$organizationId/$projectId/logs';
const TRACES_ROUTE = '/$organizationId/$projectId/traces';
const METRICS_ROUTE = '/$organizationId/$projectId/metrics';

/**
 * The window as two absolute timestamps.
 *
 * Deliberately not a preset: a link from a chart points at a moment, and
 * "last hour" resolved when the link is FOLLOWED is a different hour from the
 * one the user clicked on. The logs and traces routes accept both, and take
 * absolute dates over a preset when they have them.
 */
export interface AbsoluteWindow {
  start: string;
  end: string;
}

export interface LogsLinkInput extends ProjectRoute, Partial<AbsoluteWindow> {
  service?: string | null;
  level?: string | null;
  q?: string | null;
  /** A preset, used only when there is no absolute window. */
  range?: string | null;
}

export function logsUrl({
  organizationId,
  projectId,
  start,
  end,
  service,
  level,
  q,
  range,
}: LogsLinkInput): TelemetryLink {
  return {
    to: LOGS_ROUTE,
    params: { organizationId, projectId },
    search: compact({
      range: start && end ? undefined : range,
      start,
      end,
      service,
      level,
      q,
    }),
  };
}

export interface TracesLinkInput extends ProjectRoute, Partial<AbsoluteWindow> {
  service?: string | null;
  /** Milliseconds; omitted when zero, which is what "any duration" means. */
  minDuration?: number | null;
  /** Opens this trace's waterfall on arrival. */
  trace?: string | null;
  range?: string | null;
}

export function tracesUrl({
  organizationId,
  projectId,
  start,
  end,
  service,
  minDuration,
  trace,
  range,
}: TracesLinkInput): TelemetryLink {
  return {
    to: TRACES_ROUTE,
    params: { organizationId, projectId },
    search: compact({
      range: start && end ? undefined : range,
      start,
      end,
      service,
      minDuration:
        minDuration && minDuration > 0 ? String(minDuration) : undefined,
      trace,
    }),
  };
}

export interface ExploreLinkInput extends ProjectRoute, Partial<AbsoluteWindow> {
  queries: IPanelQuery[];
  variables?: IVariableValues;
  range?: string | null;
  interval?: IInterval;
}

export function exploreUrl({
  organizationId,
  projectId,
  queries,
  variables,
  start,
  end,
  range,
  interval,
}: ExploreLinkInput): TelemetryLink {
  return {
    to: METRICS_ROUTE,
    params: { organizationId, projectId },
    search: compact({
      // The same encoding Explore's own `q` parameter uses, so a link built
      // here and a link copied out of the address bar are the same link.
      q: queries.length > 0 ? JSON.stringify(encodeQueries(queries)) : undefined,
      range: start && end ? 'custom' : range,
      start,
      end,
      interval,
      ...variableParams(variables),
    }),
  };
}

/**
 * Dashboard variable values, in the `var_<name>` form Explore and the dashboard
 * both read. Kept here rather than imported so this module has no dependency on
 * the dashboard components; the prefix is asserted against theirs by test.
 */
function variableParams(
  variables: IVariableValues | undefined,
): Record<string, string> {
  if (!variables) {
    return {};
  }

  const out: Record<string, string> = {};

  for (const [name, value] of Object.entries(variables)) {
    out[`var_${name}`] = Array.isArray(value) ? value.join(',') : value;
  }

  return out;
}

function compact(
  search: Record<string, string | null | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(search)) {
    if (value !== null && value !== undefined && value !== '') {
      out[key] = value;
    }
  }

  return out;
}

/**
 * Which service a metric series belongs to.
 *
 * `service_name` is what the OTLP collector writes for every resource, so it is
 * right almost always. `job` is Prometheus's own convention and is what a
 * scrape-based exporter sets. `service` is what this deployment's LOG labels
 * use, which matters because the whole point of this function is to hand a name
 * to the logs page.
 *
 * The dashboard's `$service` is the last resort rather than the first: a
 * variable says what the user is filtering the DASHBOARD to, and a panel can
 * legitimately draw a series from another service. A label on the series itself
 * is evidence; the variable is a guess.
 */
export const SERVICE_LABELS = ['service_name', 'job', 'service'] as const;

export function serviceFromLabels(
  labels: Record<string, string> | undefined,
  variables?: IVariableValues,
): string | undefined {
  for (const label of SERVICE_LABELS) {
    const value = labels?.[label];

    if (value) {
      return value;
    }
  }

  const fromVariable = variables?.service;

  if (typeof fromVariable === 'string' && fromVariable !== '') {
    return fromVariable;
  }

  // A multi-valued `$service` names several, and picking the first would filter
  // the logs to one of them without saying so.
  return undefined;
}

const MINUTES_PER_INTERVAL: Record<Exclude<IInterval, 'week' | 'month'>, number> =
  {
    minute: 1,
    hour: 60,
    day: 60 * 24,
  };

const MINUTES_PER_WEEK = 60 * 24 * 7;

function addUtcMinutes(at: Date, minutes: number): string {
  return new Date(at.getTime() + minutes * 60_000).toISOString();
}

function addUtcMonths(at: Date, months: number): string {
  const shifted = new Date(at.getTime());
  shifted.setUTCMonth(shifted.getUTCMonth() + months);
  return shifted.toISOString();
}

/**
 * One bucket, plus a bucket either side.
 *
 * The extra bucket is not padding for its own sake: a chart bucket is a
 * half-open window and the spike a user clicks on is often produced by
 * something that started just before it. A minute either side of a minute is
 * cheap; a day either side of a day is three days of logs, which is why the
 * span is the INTERVAL's own width rather than a fixed number of seconds.
 */
export function bucketWindow(
  date: string | Date,
  interval: IInterval,
): AbsoluteWindow {
  // Through `parseChartDate`, because the caller is a chart click and the date
  // it hands over is `formatClickhouseDate` output — a UTC instant with no zone
  // marker, which `new Date()` would read as local time and shift by the
  // viewer's offset. A link that lands an hour off still looks like it worked.
  const at = parseChartDate(date);

  if (Number.isNaN(at.getTime())) {
    throw new Error(`Cannot build a window around ${String(date)}`);
  }

  if (interval === 'month') {
    // Month arithmetic in UTC, not through date-fns: `addMonths` works in the
    // VIEWER's local time, so a window that crosses a DST boundary comes back
    // an hour out and two people looking at the same chart get different links.
    // The engine buckets in the PROJECT's timezone, which the browser does not
    // know — so the honest choice is a rule that at least does not vary by who
    // is looking.
    return {
      start: addUtcMonths(at, -1),
      // Two buckets forward, not one: the clicked bucket runs from `date` to
      // `date + one interval`, so its own width is included before the bucket
      // after it.
      end: addUtcMonths(at, 2),
    };
  }

  const minutes =
    interval === 'week' ? MINUTES_PER_WEEK : MINUTES_PER_INTERVAL[interval];

  return {
    start: addUtcMinutes(at, -minutes),
    end: addUtcMinutes(at, minutes * 2),
  };
}

/**
 * The window a logs or traces page is actually looking at.
 *
 * Absolute dates supersede the preset rather than being one of its values. A
 * link from a chart points at a MOMENT, and "last hour" resolved when the link
 * is followed is a different hour from the one that was clicked — so the two
 * cannot both be live, and the specific one has to win.
 *
 * Shared by both routes and by the round-trip tests, so what a link builds and
 * what a page resolves are provably the same window rather than two
 * implementations that agree today.
 */
export function resolveTelemetryWindow(
  params: {
    start?: string | null;
    end?: string | null;
  },
  presetMinutes: number,
  now: Date = new Date(),
): { startDate: string; endDate: string } {
  if (params.start && params.end) {
    return { startDate: params.start, endDate: params.end };
  }

  return {
    endDate: now.toISOString(),
    startDate: new Date(now.getTime() - presetMinutes * 60_000).toISOString(),
  };
}

/** A window centred on a moment, for "what else happened around here". */
export function aroundTimestamp(
  date: string | Date,
  seconds: number,
): AbsoluteWindow {
  const at = parseChartDate(date);

  if (Number.isNaN(at.getTime())) {
    throw new Error(`Cannot build a window around ${String(date)}`);
  }

  return {
    start: new Date(at.getTime() - seconds * 1000).toISOString(),
    end: new Date(at.getTime() + seconds * 1000).toISOString(),
  };
}

/** Nanoseconds since the epoch, as the log and span rows carry them. */
export function isoFromNanos(nanoseconds: string): string {
  // BigInt division: a nanosecond timestamp is past Number.MAX_SAFE_INTEGER and
  // parseInt drops the low digits silently.
  return new Date(Number(BigInt(nanoseconds) / 1_000_000n)).toISOString();
}

/**
 * The prefilled Explore query for a counter, by service.
 *
 * `sum by (service_name)` rather than a bare `sum`, so arriving from one
 * service's logs still shows how that service compares with the others — which
 * is the question someone leaving a log line usually has.
 */
export function exploreRateQuery(
  metric: string,
  service?: string,
): IPanelQuery {
  const builder: IPromqlBuilderState = {
    metric,
    labelMatchers: service
      ? [{ label: 'service_name', op: '=', value: service }]
      : [],
    operations: [
      { op: 'rate', range: '$__rate_interval' },
      { op: 'sum', by: ['service_name'] },
    ],
  };

  // Compiled rather than written out, so the expression and the builder state
  // cannot disagree — and so a service name with a quote in it is escaped by
  // the same function everything else uses.
  return createPanelQuery('A', {
    mode: 'builder',
    builder,
    expr: compileBuilder(builder),
  });
}
