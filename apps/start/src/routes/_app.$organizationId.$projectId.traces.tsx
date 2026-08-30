import { FullPageEmptyState } from '@/components/full-page-empty-state';
import { PageContainer } from '@/components/page-container';
import { Badge } from '@/components/ui/badge';
import { Combobox } from '@/components/ui/combobox';
import { Label } from '@/components/ui/label';
import { useTRPC } from '@/integrations/trpc/react';
import { cn } from '@/utils/cn';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { createFileRoute, useParams } from '@tanstack/react-router';
import { ServerIcon, WaypointsIcon } from 'lucide-react';
import { useMemo, useState } from 'react';

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
function Waterfall({ spans }: { spans: TraceSpanView[] }) {
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
            className="flex items-center gap-3 border-b px-3 py-1.5 text-xs last:border-b-0 hover:bg-muted/40"
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
          </div>
        );
      })}
    </div>
  );
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
  const { projectId } = useParams({
    from: '/_app/$organizationId/$projectId/traces',
  });
  const trpc = useTRPC();

  const [range, setRange] = useState<(typeof RANGES)[number]['value']>('1h');
  const [service, setService] = useState<string | null>(null);
  const [minDuration, setMinDuration] = useState('0');
  const [selected, setSelected] = useState<string | null>(null);

  const enabled = useQuery(trpc.observability.enabled.queryOptions());
  const telemetryOn = enabled.data?.enabled ?? false;

  const services = useQuery(
    trpc.observability.traceServices.queryOptions(
      { projectId },
      { enabled: telemetryOn },
    ),
  );

  const { startDate, endDate } = useMemo(() => {
    const minutes = RANGES.find((r) => r.value === range)?.minutes ?? 60;
    const end = new Date();
    return {
      endDate: end.toISOString(),
      startDate: new Date(end.getTime() - minutes * 60_000).toISOString(),
    };
  }, [range]);

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
            placeholder="Range"
            items={RANGES.map((r) => ({ value: r.value, label: r.label }))}
            value={range}
            onChange={(value) => setRange(value as typeof range)}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label>Service</Label>
          <Combobox
            placeholder="All services"
            items={[
              { value: '', label: 'All services' },
              ...(services.data ?? []).map((s) => ({ value: s, label: s })),
            ]}
            value={service ?? ''}
            onChange={(value) => setService(value || null)}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label>Duration</Label>
          <Combobox
            placeholder="Any duration"
            items={DURATIONS.map((d) => ({ value: d.value, label: d.label }))}
            value={minDuration}
            onChange={(value) => setMinDuration(value)}
          />
        </div>
      </div>

      {traces.isError && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
          {traces.error.message}
        </div>
      )}

      {!traces.isError && rows.length === 0 && !traces.isFetching && (
        <FullPageEmptyState title="No traces in this range" icon={WaypointsIcon}>
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
                  setSelected(selected === row.traceId ? null : row.traceId)
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
                    <Waterfall spans={trace.data as TraceSpanView[]} />
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
