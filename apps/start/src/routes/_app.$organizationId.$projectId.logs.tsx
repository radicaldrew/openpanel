import { FullPageEmptyState } from '@/components/full-page-empty-state';
import { PageContainer } from '@/components/page-container';
import {
  aroundTimestamp,
  isoFromNanos,
  resolveTelemetryWindow,
  tracesUrl,
} from '@/components/telemetry-links/telemetry-urls';
import { splitTraceIds } from '@/components/telemetry-links/trace-ids';
import { useExploreSuggestion } from '@/components/telemetry-links/use-explore-suggestion';
import { Badge } from '@/components/ui/badge';
import { Combobox } from '@/components/ui/combobox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Tooltiper } from '@/components/ui/tooltip';
import { useTRPC } from '@/integrations/trpc/react';
import { cn } from '@/utils/cn';
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { Link, createFileRoute, useParams } from '@tanstack/react-router';
import {
  ActivityIcon,
  PauseIcon,
  PlayIcon,
  SaveIcon,
  ScrollTextIcon,
  ServerIcon,
  WaypointsIcon,
} from 'lucide-react';
import { createParser, parseAsString, useQueryState } from 'nuqs';
import VirtualList from 'rc-virtual-list';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';

export const Route = createFileRoute('/_app/$organizationId/$projectId/logs')({
  component: Component,
  head: () => ({ meta: [{ title: 'Logs' }] }),
});

const RANGES = [
  { value: '15m', label: 'Last 15 minutes', minutes: 15 },
  { value: '1h', label: 'Last hour', minutes: 60 },
  { value: '6h', label: 'Last 6 hours', minutes: 360 },
  { value: '24h', label: 'Last 24 hours', minutes: 1440 },
  { value: '7d', label: 'Last 7 days', minutes: 10_080 },
] as const;

const LEVELS = ['error', 'warn', 'info', 'debug'] as const;

/**
 * The page's state, in the URL.
 *
 * It is here so a link can point at it: a metric spike, a log line's neighbour,
 * a span's window all navigate to this route with a window and a service, and
 * none of that works while the filters live in `useState`. nuqs rather than the
 * route's `validateSearch` because Explore already uses nuqs and because
 * `validateSearch` strips keys it does not know — which would quietly delete a
 * parameter the moment two of us disagreed about the schema.
 */
const RANGE_PARAM = createParser({
  parse: (value: string) =>
    z
      .enum(RANGES.map((r) => r.value) as [string, ...string[]])
      .safeParse(value).data ?? null,
  serialize: (value: string) => value,
}).withDefault('1h');

const TEXT_PARAM = parseAsString.withDefault('');

/**
 * Typing writes to the URL, but throttled and without a history entry: a
 * back button that walks back through every character of a search is not a
 * back button.
 */
const SEARCH_PARAM = TEXT_PARAM.withOptions({
  throttleMs: 400,
  history: 'replace',
});

/** Severity drives colour; anything unrecognised stays neutral rather than guessing. */
const LEVEL_CLASS: Record<string, string> = {
  error: 'text-red-500',
  fatal: 'text-red-500',
  warn: 'text-amber-500',
  warning: 'text-amber-500',
  info: 'text-blue-500',
  debug: 'text-muted-foreground',
};

const ROW_HEIGHT = 30;
const LIST_HEIGHT = 560;

/** A pinned window, short enough to sit under the range picker. */
function formatWindow(startDate: string, endDate: string): string {
  const from = new Date(startDate);
  const to = new Date(endDate);
  const sameDay = from.toISOString().slice(0, 10) === to.toISOString().slice(0, 10);

  const time = (date: Date) => date.toISOString().slice(11, 19);

  return sameDay
    ? `${from.toISOString().slice(0, 10)} ${time(from)}–${time(to)}`
    : `${from.toISOString().slice(0, 16)} → ${to.toISOString().slice(0, 16)}`;
}

function formatTimestamp(nanoseconds: string): string {
  // Nanoseconds exceed Number.MAX_SAFE_INTEGER, so divide as BigInt before
  // converting — parseInt would lose the low digits and, worse, do it silently.
  const ms = Number(BigInt(nanoseconds) / 1_000_000n);
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
}

function Component() {
  const { organizationId, projectId } = useParams({
    from: '/_app/$organizationId/$projectId/logs',
  });
  const trpc = useTRPC();

  const [range, setRange] = useQueryState('range', RANGE_PARAM);
  const [service, setService] = useQueryState('service');
  const [level, setLevel] = useQueryState('level');
  const [search, setSearch] = useQueryState('q', SEARCH_PARAM);
  // An absolute window, as every correlation link carries. It supersedes the
  // preset rather than being one of its values: a link from a chart points at a
  // moment, and "last hour" resolved when the link is FOLLOWED is a different
  // hour from the one that was clicked.
  const [start, setStart] = useQueryState('start');
  const [end, setEnd] = useQueryState('end');
  const pinned = !!start && !!end;
  // "Follow" is a poll, not a WebSocket. gigapipe does expose /loki/api/v1/tail,
  // but a socket needs its own auth, backpressure and reconnect handling on a
  // path that is already rate-limited and cached; a 5s refetch gives the same
  // experience for a log explorer someone is watching for a minute or two.
  const [following, setFollowing] = useState(false);
  // The query window has to ADVANCE while following, or the refetch keeps
  // asking for the same fixed window and no new line can ever appear — a
  // "Follow" button that silently does nothing. This tick moves the window.
  const [windowTick, setWindowTick] = useState(0);
  const client = useQueryClient();

  useEffect(() => {
    if (!following) return;
    const id = setInterval(() => setWindowTick((t) => t + 1), 5000);
    return () => clearInterval(id);
  }, [following]);

  // Arriving on a link with a pinned window while Follow was left on would poll
  // a window that cannot move, which looks like a broken Follow button rather
  // than like a pinned window.
  useEffect(() => {
    if (pinned && following) {
      setFollowing(false);
    }
  }, [pinned, following]);

  const enabled = useQuery(trpc.observability.enabled.queryOptions());
  const telemetryOn = enabled.data?.enabled ?? false;

  const services = useQuery(
    trpc.observability.services.queryOptions(
      { projectId },
      { enabled: telemetryOn },
    ),
  );

  const { startDate, endDate } = useMemo(() => {
    // Shared with the link builders, so what a correlation link points at and
    // what this page resolves are the same window by construction.
    return resolveTelemetryWindow(
      { start, end },
      RANGES.find((r) => r.value === range)?.minutes ?? 60,
    );
    // windowTick is a deliberate dependency: it is what advances the end of a
    // PRESET window to now on each poll. A pinned window does not move, which
    // is why Follow is disabled below rather than left to spin on a fixed
    // window and never show a new line.
  }, [range, windowTick, start, end]);

  const logs = useQuery(
    trpc.observability.logs.queryOptions(
      {
        projectId,
        startDate,
        endDate,
        matchers: [
          ...(service
            ? [{ name: 'service', operator: 'eq' as const, value: service }]
            : []),
          ...(level
            ? [{ name: 'level', operator: 'eq' as const, value: level }]
            : []),
        ],
        // Only send a filter once it is worth sending: an empty string is
        // rejected by the compiler, and a one-character filter matches so much
        // it is slower than no filter at all.
        lineFilters:
          search.trim().length >= 2
            ? [{ operator: 'contains' as const, value: search.trim() }]
            : [],
        limit: 500,
      },
      {
        enabled: telemetryOn,
        placeholderData: keepPreviousData,
        refetchInterval: following && !pinned ? 5000 : false,
      },
    ),
  );

  // Offered only when this project writes a counter that has carried the
  // selected service. Returns null far more often than not, on purpose.
  const exploreSuggestion = useExploreSuggestion({
    projectId,
    organizationId,
    service,
    start: startDate,
    end: endDate,
    enabled: telemetryOn,
  });

  const savedSearches = useQuery(
    trpc.observability.savedSearches.queryOptions(
      { projectId, kind: 'logs' },
      { enabled: telemetryOn },
    ),
  );

  const saveSearch = useMutation(
    trpc.observability.saveSearch.mutationOptions({
      onSuccess() {
        toast.success('Search saved');
        client.invalidateQueries({
          queryKey: trpc.observability.savedSearches.queryKey({
            projectId,
            kind: 'logs',
          }),
        });
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const applySaved = (id: string) => {
    const found = savedSearches.data?.find((s) => s.id === id);
    if (!found) return;

    const query = found.query as {
      matchers?: { name: string; value: string }[];
      lineFilters?: { value: string }[];
    };

    setService(
      query.matchers?.find((m) => m.name === 'service')?.value ?? null,
    );
    setLevel(query.matchers?.find((m) => m.name === 'level')?.value ?? null);
    setSearch(query.lineFilters?.[0]?.value ?? '');
  };

  const onSave = () => {
    const name = window.prompt('Name this search');
    if (!name) return;

    saveSearch.mutate({
      projectId,
      name,
      kind: 'logs',
      query: {
        matchers: [
          ...(service
            ? [{ name: 'service', operator: 'eq' as const, value: service }]
            : []),
          ...(level
            ? [{ name: 'level', operator: 'eq' as const, value: level }]
            : []),
        ],
        lineFilters:
          search.trim().length >= 2
            ? [{ operator: 'contains' as const, value: search.trim() }]
            : [],
      },
    });
  };

  if (enabled.isLoading) {
    return null;
  }

  if (!telemetryOn) {
    return (
      <PageContainer>
        <FullPageEmptyState title="Telemetry is not configured" icon={ServerIcon}>
          <p>
            Set <code>GIGAPIPE_URL</code>, <code>GIGAPIPE_USER</code> and{' '}
            <code>GIGAPIPE_PASSWORD</code> to enable logs, then restart the API.
          </p>
        </FullPageEmptyState>
      </PageContainer>
    );
  }

  const lines = logs.data?.lines ?? [];

  return (
    <PageContainer>
      <div className="mb-6 flex items-center gap-3">
        <h1 className="font-medium text-2xl">Logs</h1>
        <Badge variant="outline">Server telemetry</Badge>
        {logs.isFetching && (
          <span className="text-muted-foreground text-sm">Searching…</span>
        )}
        <div className="ml-auto flex gap-2">
          {exploreSuggestion && (
            /* Only when this project writes a counter that has actually carried
               this service — otherwise the link lands on an empty chart, which
               is a worse answer than no link. */
            <Tooltiper
              asChild
              content={`Chart ${exploreSuggestion.metric} for ${service}`}
            >
              <Button asChild icon={ActivityIcon} variant="outline">
                <Link
                  params={exploreSuggestion.link.params}
                  search={exploreSuggestion.link.search}
                  to={exploreSuggestion.link.to}
                >
                  Open in Explore
                </Link>
              </Button>
            </Tooltiper>
          )}
          <Tooltiper
            asChild
            content="A pinned window cannot move, so there is nothing to follow"
            disabled={!pinned}
          >
            <span>
              <Button
                disabled={pinned}
                icon={following ? PauseIcon : PlayIcon}
                onClick={() => setFollowing((value) => !value)}
                variant={following ? 'default' : 'outline'}
              >
                {following ? 'Following' : 'Follow'}
              </Button>
            </span>
          </Tooltiper>
          <Button variant="outline" icon={SaveIcon} onClick={onSave}>
            Save
          </Button>
        </div>
      </div>

      {(savedSearches.data?.length ?? 0) > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-sm">Saved:</span>
          {savedSearches.data?.map((saved) => (
            <Button
              key={saved.id}
              variant="outline"
              size="sm"
              onClick={() => applySaved(saved.id)}
            >
              {saved.name}
            </Button>
          ))}
        </div>
      )}

      <div className="mb-4 grid gap-4 md:grid-cols-4">
        <div className="flex flex-col gap-2">
          <Label>Range</Label>
          <Combobox
            items={RANGES.map((r) => ({ value: r.value, label: r.label }))}
            onChange={(value) => {
              // Choosing a preset is how you get OUT of a window a link pinned
              // you to; leaving the absolute dates in place would make the
              // picker look broken.
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
              Pinned to {formatWindow(startDate, endDate)} — clear
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
          <Label>Level</Label>
          <Combobox
            placeholder="All levels"
            items={[
              { value: '', label: 'All levels' },
              ...LEVELS.map((l) => ({ value: l, label: l })),
            ]}
            onChange={(value) => void setLevel(value || null)}
            value={level ?? ''}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label>Contains</Label>
          <Input
            onChange={(event) => void setSearch(event.target.value)}
            placeholder="Search line text"
            value={search}
          />
        </div>
      </div>

      {logs.isError && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
          {logs.error.message}
        </div>
      )}

      {!logs.isError && lines.length === 0 && !logs.isFetching && (
        <FullPageEmptyState title="No logs in this range" icon={ScrollTextIcon}>
          <p>
            Widen the range, clear the filters, or point a collector at{' '}
            <code>{'{API_URL}'}/telemetry/v1/logs</code>.
          </p>
        </FullPageEmptyState>
      )}

      {lines.length > 0 && (
        <div className="overflow-hidden rounded-lg border bg-card">
          <VirtualList
            data={lines}
            height={LIST_HEIGHT}
            itemHeight={ROW_HEIGHT}
            itemKey={(line) => `${line.timestampNs}-${line.body.slice(0, 32)}`}
          >
            {(line) => (
              <LogLine
                fallbackService={service}
                line={line}
                organizationId={organizationId}
                projectId={projectId}
              />
            )}
          </VirtualList>
        </div>
      )}

      {lines.length > 0 && (
        <p className="mt-2 text-muted-foreground text-sm">
          {lines.length} lines · newest first
        </p>
      )}
    </PageContainer>
  );
}

/**
 * One log line, with the two ways out of it.
 *
 * A trace id in a log line is the single most useful thing on this page and the
 * single least usable: it is 32 hex characters, so nobody follows one by hand.
 * Linking it is most of what "correlation" means here. The id comes from the
 * envelope when the collector filled it in, and otherwise from the line text —
 * see trace-ids.ts for why that detection refuses to guess.
 */
function LogLine({
  line,
  organizationId,
  projectId,
  fallbackService,
}: {
  line: {
    timestampNs: string;
    body: string;
    severity?: string | null;
    labels: Record<string, string>;
    traceId?: string | null;
  };
  organizationId: string;
  projectId: string;
  /** The service the page is filtered to, when the line does not name one. */
  fallbackService: string | null;
}) {
  const at = isoFromNanos(line.timestampNs);
  const service = line.labels.service ?? fallbackService ?? undefined;

  // Two seconds either side. Wide enough to catch the span that produced the
  // line and the ones around it, narrow enough that the answer is still about
  // this moment.
  const nearby = aroundTimestamp(at, 2);

  const traceLink = (traceId: string) =>
    tracesUrl({
      organizationId,
      projectId,
      trace: traceId,
      ...aroundTimestamp(at, 60),
    });

  const segments = splitTraceIds(line.body);

  return (
    <div
      className="group flex items-start gap-3 border-b px-3 py-1 font-mono text-xs last:border-b-0"
      style={{ minHeight: ROW_HEIGHT }}
    >
      <span className="shrink-0 text-muted-foreground tabular-nums">
        {formatTimestamp(line.timestampNs)}
      </span>
      <span
        className={cn(
          'w-12 shrink-0 uppercase',
          LEVEL_CLASS[(line.severity ?? '').toLowerCase()] ??
            'text-muted-foreground',
        )}
      >
        {line.severity ?? ''}
      </span>
      {line.labels.service && (
        <span className="shrink-0 text-muted-foreground">
          {line.labels.service}
        </span>
      )}
      <span className="min-w-0 break-all">
        {segments.map((segment) =>
          segment.kind === 'trace' ? (
            <Link
              className="underline decoration-dotted underline-offset-2 hover:text-foreground"
              // Keyed on the offset into the line, which is a real identity —
              // the segments of one line are stable, and an array index would
              // not survive the line being re-split after an edit.
              key={segment.from}
              params={traceLink(segment.traceId).params}
              search={traceLink(segment.traceId).search}
              to={traceLink(segment.traceId).to}
            >
              {segment.text}
            </Link>
          ) : (
            <span key={segment.from}>{segment.text}</span>
          ),
        )}
      </span>

      <span className="ml-auto flex shrink-0 items-center gap-2">
        <Tooltiper asChild content="Traces in the two seconds around this line">
          <Link
            className="opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100"
            params={{ organizationId, projectId }}
            search={
              tracesUrl({
                organizationId,
                projectId,
                service,
                ...nearby,
              }).search
            }
            to="/$organizationId/$projectId/traces"
          >
            <WaypointsIcon className="size-3.5 text-muted-foreground hover:text-foreground" />
          </Link>
        </Tooltiper>

        {line.traceId && (
          // Correlation ids live in the envelope, not the labels — this is what
          // that buys: they are visible and followable without ever having cost
          // a stream.
          <Link
            className="text-muted-foreground/60 hover:text-foreground"
            params={traceLink(line.traceId).params}
            search={traceLink(line.traceId).search}
            to={traceLink(line.traceId).to}
          >
            {line.traceId.slice(0, 8)}
          </Link>
        )}
      </span>
    </div>
  );
}
