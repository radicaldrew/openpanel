import { FullPageEmptyState } from '@/components/full-page-empty-state';
import { PageContainer } from '@/components/page-container';
import {
  isoFromNanos,
  logsUrl,
  resolveTelemetryWindow,
} from '@/components/telemetry-links/telemetry-urls';
import { Badge } from '@/components/ui/badge';
import { Combobox } from '@/components/ui/combobox';
import { Label } from '@/components/ui/label';
import { Tooltiper } from '@/components/ui/tooltip';
import { useTRPC } from '@/integrations/trpc/react';
import { cn } from '@/utils/cn';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, createFileRoute, useParams } from '@tanstack/react-router';
import { ScrollTextIcon, ServerIcon, WaypointsIcon } from 'lucide-react';
import { createParser, useQueryState } from 'nuqs';
import { useMemo } from 'react';
import { z } from 'zod';

export const Route = createFileRoute('/_app/$organizationId/$projectId/traces')({
  component: Component,
  head: () => ({ meta: [{ title: 'Traces' }] }),
});

const RANGES = [
  { value: '15m', label: 'Last 15 minutes', minutes: 15 },
  { value: '1h', label: 'Last hour', minutes: 60 },
  { value: '6h', label: 'Last 6 hours', minutes: 360 },
  { value: '24h', label: 'Last 24 hours', minutes: 1440 },
] as const;

const DURATIONS = [
  { value: '0', label: 'Any duration' },
  { value: '100', label: 'Slower than 100ms' },
  { value: '500', label: 'Slower than 500ms' },
  { value: '1000', label: 'Slower than 1s' },
] as const;

/**
 * The page's state, in the URL — same reasoning as the logs route. A link from
 * a log line lands here with a trace id and a window, and `trace` opens that
 * trace's waterfall on arrival rather than making the user find the row.
 */
const RANGE_PARAM = createParser({
  parse: (value: string) =>
    z
      .enum(RANGES.map((r) => r.value) as [string, ...string[]])
      .safeParse(value).data ?? null,
  serialize: (value: string) => value,
}).withDefault('1h');

const DURATION_PARAM = createParser({
  parse: (value: string) =>
    DURATIONS.some((d) => d.value === value) ? value : null,
  serialize: (value: string) => value,
}).withDefault('0');

function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms >= 1) return `${ms.toFixed(0)}ms`;
  return `${(ms * 1000).toFixed(0)}µs`;
}

function formatTimestamp(nanoseconds: string): string {
  // BigInt division: a nanosecond timestamp exceeds Number.MAX_SAFE_INTEGER and
  // parseInt would drop the low digits silently.
  return new Date(Number(BigInt(nanoseconds) / 1_000_000n))
    .toISOString()
    .replace('T', ' ')
    .replace('Z', '');
}

/**
 * The span waterfall.
 *
 * Laid out from the spans' own timestamps rather than from a nesting structure,
 * because a trace is not guaranteed to be a well-formed tree here: this project
 * may own only part of it, so a span's parent can legitimately be missing. A
 * time-based layout degrades gracefully in that case — an orphan renders in its
 * correct position instead of disappearing or forcing a fake root.
 */
function Waterfall({
  spans,
  organizationId,
  projectId,
  traceId,
}: {
  spans: TraceSpanView[];
  organizationId: string;
  projectId: string;
  traceId: string;
}) {
  const bounds = useMemo(() => {
    if (spans.length === 0) return null;

    const starts = spans.map((s) => BigInt(s.startTimeNs));
    const min = starts.reduce((a, b) => (a < b ? a : b));
    const ends = spans.map(
      (s, i) => starts[i]! + BigInt(Math.round(s.durationMs * 1_000_000)),
    );
    const max = ends.reduce((a, b) => (a > b ? a : b));

    // Guard against a zero-width trace (every span instantaneous), which would
    // divide by zero and render nothing.
    const span = max > min ? max - min : 1n;
    return { min, span };
  }, [spans]);

  if (!bounds) return null;

  const depthOf = (span: TraceSpanView): number => {
    let depth = 0;
    let current = span;
    const seen = new Set<string>();

    while (current.parentId) {
      if (seen.has(current.spanId)) break; // cycle guard
      seen.add(current.spanId);
      const parent = spans.find((s) => s.spanId === current.parentId);
      if (!parent) break; // parent belongs to another project — stop here
      current = parent;
      depth += 1;
      if (depth > 20) break;
    }

    return depth;
  };

  return (
    <div className="flex flex-col">
      {spans.map((span) => {
        const start = BigInt(span.startTimeNs);
        const offset =
          Number(((start - bounds.min) * 10_000n) / bounds.span) / 100;
        const width = Math.max(
          0.5,
          Number(
            (BigInt(Math.round(span.durationMs * 1_000_000)) * 10_000n) /
              bounds.span,
          ) / 100,
        );

        return (
          <div
            key={span.spanId}
            className="group flex items-center gap-3 border-b px-3 py-1.5 text-xs last:border-b-0 hover:bg-muted/40"
          >
            <div
              className="min-w-0 shrink-0 truncate font-medium"
              style={{ width: 260, paddingLeft: depthOf(span) * 12 }}
              title={span.name}
            >
              {span.name}
            </div>
            <div className="w-32 shrink-0 truncate text-muted-foreground">
              {span.service}
            </div>
            <div className="relative h-4 flex-1 rounded bg-muted/40">
              <div
                className="absolute h-4 rounded bg-primary/70"
                style={{ left: `${offset}%`, width: `${width}%` }}
              />
            </div>
            <div className="w-20 shrink-0 text-right tabular-nums text-muted-foreground">
              {formatDuration(span.durationMs)}
            </div>
            {/* The window is the span's own, widened by two seconds at each
                end, and the line filter is the trace id — the same shape
                `observability.logsForTrace` uses, so what lands here and what
                that procedure returns are the same set of lines. Two seconds
                because a log written just as a span closed is still part of
                what the span did. */}
            <Tooltiper asChild content="Logs written during this span">
              <Link
                className="shrink-0 opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100"
                params={{ organizationId, projectId }}
                search={
                  logsUrl({
                    organizationId,
                    projectId,
                    service: span.service,
                    q: traceId,
                    ...spanWindow(span),
                  }).search
                }
                to="/$organizationId/$projectId/logs"
              >
                <ScrollTextIcon className="size-3.5 text-muted-foreground hover:text-foreground" />
              </Link>
            </Tooltiper>
          </div>
        );
      })}
    </div>
  );
}

/**
 * A span's window, widened by two seconds at each end.
 *
 * The padding is not cosmetic: a log line written as the span closed carries
 * the same trace id and is part of what the span did, but its timestamp can
 * land just outside the span's own bounds — clock skew between the process that
 * emitted the span and the one that wrote the log is enough.
 */
const SPAN_LOG_PADDING_SECONDS = 2;

function spanWindow(span: TraceSpanView): { start: string; end: string } {
  const startMs = new Date(isoFromNanos(span.startTimeNs)).getTime();
  const endMs = startMs + span.durationMs;
  const padding = SPAN_LOG_PADDING_SECONDS * 1000;

  return {
    start: new Date(startMs - padding).toISOString(),
    end: new Date(endMs + padding).toISOString(),
  };
}

interface TraceSpanView {
  spanId: string;
  parentId: string | null;
  name: string;
  service: string;
  startTimeNs: string;
  durationMs: number;
  attributes: Record<string, string>;
}

function Component() {
  const { organizationId, projectId } = useParams({
    from: '/_app/$organizationId/$projectId/traces',
  });
  const trpc = useTRPC();

  const [range, setRange] = useQueryState('range', RANGE_PARAM);
  const [service, setService] = useQueryState('service');
  const [minDuration, setMinDuration] = useQueryState(
    'minDuration',
    DURATION_PARAM,
  );
  // The open trace, in the URL: a link from a log line names one, and expanding
  // a row should be shareable for the same reason the filters are.
  const [selected, setSelected] = useQueryState('trace');
  // An absolute window, superseding the preset. See the logs route.
  const [start, setStart] = useQueryState('start');
  const [end, setEnd] = useQueryState('end');
  const pinned = !!start && !!end;

  const enabled = useQuery(trpc.observability.enabled.queryOptions());
  const telemetryOn = enabled.data?.enabled ?? false;

  const services = useQuery(
    trpc.observability.traceServices.queryOptions(
      { projectId },
      { enabled: telemetryOn },
    ),
  );

  const { startDate, endDate } = useMemo(
    () =>
      resolveTelemetryWindow(
        { start, end },
        RANGES.find((r) => r.value === range)?.minutes ?? 60,
      ),
    [range, start, end],
  );

  const traces = useQuery(
    trpc.observability.traceSearch.queryOptions(
      {
        projectId,
        startDate,
        endDate,
        service: service ?? undefined,
        minDurationMs: Number(minDuration) || undefined,
        limit: 50,
      },
      { enabled: telemetryOn, placeholderData: keepPreviousData },
    ),
  );

  const trace = useQuery(
    trpc.observability.trace.queryOptions(
      { projectId, traceId: selected ?? '' },
      { enabled: telemetryOn && !!selected },
    ),
  );

  if (enabled.isLoading) return null;

  if (!telemetryOn) {
    return (
      <PageContainer>
        <FullPageEmptyState title="Telemetry is not configured" icon={ServerIcon}>
          <p>
            Set <code>GIGAPIPE_URL</code>, <code>GIGAPIPE_USER</code> and{' '}
            <code>GIGAPIPE_PASSWORD</code> to enable traces, then restart the API.
          </p>
        </FullPageEmptyState>
      </PageContainer>
    );
  }

  const rows = traces.data ?? [];
  // Whether the open trace is one the current search returned. When it is not,
  // it came from a link and is rendered on its own above the list.
  const selectedRow = rows.find((row) => row.traceId === selected);

  return (
    <PageContainer>
      <div className="mb-6 flex items-center gap-3">
        <h1 className="font-medium text-2xl">Traces</h1>
        <Badge variant="outline">Server telemetry</Badge>
        {traces.isFetching && (
          <span className="text-muted-foreground text-sm">Searching…</span>
        )}
      </div>

      <div className="mb-4 grid gap-4 md:grid-cols-3">
        <div className="flex flex-col gap-2">
          <Label>Range</Label>
          <Combobox
            items={RANGES.map((r) => ({ value: r.value, label: r.label }))}
            onChange={(value) => {
              // Choosing a preset is how you leave a window a link pinned you
              // to; leaving the absolute dates behind would make the picker
              // look broken.
              void setRange(value);
              void setStart(null);
              void setEnd(null);
            }}
            placeholder="Range"
            value={pinned ? '' : range}
          />
          {pinned && (
            <button
              className="text-left text-muted-foreground text-xs underline underline-offset-2"
              onClick={() => {
                void setStart(null);
                void setEnd(null);
              }}
              type="button"
            >
              Pinned to a window from a link — clear
            </button>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <Label>Service</Label>
          <Combobox
            placeholder="All services"
            items={[
              { value: '', label: 'All services' },
              ...(services.data ?? []).map((s) => ({ value: s, label: s })),
            ]}
            onChange={(value) => void setService(value || null)}
            value={service ?? ''}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label>Duration</Label>
          <Combobox
            placeholder="Any duration"
            items={DURATIONS.map((d) => ({ value: d.value, label: d.label }))}
            onChange={(value) => void setMinDuration(value)}
            value={minDuration}
          />
        </div>
      </div>

      {traces.isError && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
          {traces.error.message}
        </div>
      )}

      {/*
        A trace arrived by link but is not in the search results.

        This is the normal case for the logs → traces jump, not an edge case:
        the search returns the fifty most recent traces in the window, and the
        one a log line names is only in that list by luck — its root span may
        have started before the window, or it may simply be the fifty-first. The
        waterfall lives inside the row list, so without this the link lands on a
        page that shows everything EXCEPT the trace it was pointing at.
      */}
      {selected && !selectedRow && (
        <div className="mb-4 overflow-hidden rounded-lg border bg-card">
          <div className="flex flex-wrap items-center gap-3 border-b px-4 py-2 text-sm">
            <span className="font-medium">Linked trace</span>
            <code className="font-mono text-muted-foreground text-xs">
              {selected}
            </code>
            <button
              className="ml-auto text-muted-foreground text-xs underline underline-offset-2"
              onClick={() => void setSelected(null)}
              type="button"
            >
              Close
            </button>
          </div>
          {trace.isLoading && (
            <div className="p-4 text-muted-foreground text-sm">
              Loading spans…
            </div>
          )}
          {!trace.isLoading && (trace.data?.length ?? 0) === 0 && (
            <div className="p-4 text-muted-foreground text-sm">
              No spans for this trace in this project. It may have been dropped
              by retention, or belong to another project.
            </div>
          )}
          {!trace.isLoading && (trace.data?.length ?? 0) > 0 && (
            <Waterfall
              organizationId={organizationId}
              projectId={projectId}
              spans={trace.data as TraceSpanView[]}
              traceId={selected}
            />
          )}
        </div>
      )}

      {!traces.isError &&
        rows.length === 0 &&
        !traces.isFetching &&
        // Not when a linked trace is on screen above: the list being empty is
        // then a fact about the search, not about the page.
        !selected && (
          <FullPageEmptyState icon={WaypointsIcon} title="No traces in this range">
            <p>
              Point an OpenTelemetry collector at{' '}
              <code>{'{API_URL}'}/telemetry/v1/traces</code>, or widen the range.
            </p>
          </FullPageEmptyState>
        )}

      {rows.length > 0 && (
        <div className="overflow-hidden rounded-lg border bg-card">
          {rows.map((row) => (
            <div key={row.traceId} className="border-b last:border-b-0">
              <button
                type="button"
                onClick={() =>
                  void setSelected(selected === row.traceId ? null : row.traceId)
                }
                className={cn(
                  'flex w-full items-center gap-4 px-4 py-2 text-left text-sm hover:bg-muted/40',
                  selected === row.traceId && 'bg-muted/60',
                )}
              >
                <span className="w-44 shrink-0 truncate font-medium">
                  {row.rootName}
                </span>
                <span className="w-32 shrink-0 truncate text-muted-foreground">
                  {row.rootService}
                </span>
                <span className="w-16 shrink-0 tabular-nums text-muted-foreground">
                  {row.spanCount} spans
                </span>
                <span className="w-20 shrink-0 text-right tabular-nums">
                  {formatDuration(row.durationMs)}
                </span>
                <span className="ml-auto shrink-0 font-mono text-muted-foreground text-xs">
                  {formatTimestamp(row.startTimeNs)}
                </span>
              </button>

              {selected === row.traceId && (
                <div className="border-t bg-muted/20">
                  {trace.isLoading && (
                    <div className="p-4 text-muted-foreground text-sm">
                      Loading spans…
                    </div>
                  )}
                  {!trace.isLoading && (trace.data?.length ?? 0) === 0 && (
                    <div className="p-4 text-muted-foreground text-sm">
                      No spans available for this trace.
                    </div>
                  )}
                  {!trace.isLoading && (trace.data?.length ?? 0) > 0 && (
                    <Waterfall
                      organizationId={organizationId}
                      projectId={projectId}
                      spans={trace.data as TraceSpanView[]}
                      traceId={row.traceId}
                    />
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </PageContainer>
  );
}
