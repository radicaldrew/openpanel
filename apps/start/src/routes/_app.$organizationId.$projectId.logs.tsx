import { FullPageEmptyState } from '@/components/full-page-empty-state';
import { PageContainer } from '@/components/page-container';
import { Badge } from '@/components/ui/badge';
import { Combobox } from '@/components/ui/combobox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { useTRPC } from '@/integrations/trpc/react';
import { cn } from '@/utils/cn';
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { createFileRoute, useParams } from '@tanstack/react-router';
import { PauseIcon, PlayIcon, SaveIcon, ScrollTextIcon, ServerIcon } from 'lucide-react';
import VirtualList from 'rc-virtual-list';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

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

function formatTimestamp(nanoseconds: string): string {
  // Nanoseconds exceed Number.MAX_SAFE_INTEGER, so divide as BigInt before
  // converting — parseInt would lose the low digits and, worse, do it silently.
  const ms = Number(BigInt(nanoseconds) / 1_000_000n);
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
}

function Component() {
  const { projectId } = useParams({
    from: '/_app/$organizationId/$projectId/logs',
  });
  const trpc = useTRPC();

  const [range, setRange] = useState<(typeof RANGES)[number]['value']>('1h');
  const [service, setService] = useState<string | null>(null);
  const [level, setLevel] = useState<string | null>(null);
  const [search, setSearch] = useState('');
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

  const enabled = useQuery(trpc.observability.enabled.queryOptions());
  const telemetryOn = enabled.data?.enabled ?? false;

  const services = useQuery(
    trpc.observability.services.queryOptions(
      { projectId },
      { enabled: telemetryOn },
    ),
  );

  const { startDate, endDate } = useMemo(() => {
    const minutes =
      RANGES.find((r) => r.value === range)?.minutes ?? 60;
    const end = new Date();
    return {
      endDate: end.toISOString(),
      startDate: new Date(end.getTime() - minutes * 60_000).toISOString(),
    };
    // windowTick is a deliberate dependency: it is what advances `end` to now
    // on each poll.
  }, [range, windowTick]);

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
        refetchInterval: following ? 5000 : false,
      },
    ),
  );

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
          <Button
            variant={following ? 'default' : 'outline'}
            icon={following ? PauseIcon : PlayIcon}
            onClick={() => setFollowing((value) => !value)}
          >
            {following ? 'Following' : 'Follow'}
          </Button>
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
          <Label>Level</Label>
          <Combobox
            placeholder="All levels"
            items={[
              { value: '', label: 'All levels' },
              ...LEVELS.map((l) => ({ value: l, label: l })),
            ]}
            value={level ?? ''}
            onChange={(value) => setLevel(value || null)}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label>Contains</Label>
          <Input
            placeholder="Search line text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
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
              <div
                className="flex items-start gap-3 border-b px-3 py-1 font-mono text-xs last:border-b-0"
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
                <span className="min-w-0 break-all">{line.body}</span>
                {line.traceId && (
                  // Correlation ids live in the envelope, not the labels — this
                  // is what that buys: they are visible and searchable without
                  // ever having cost a stream.
                  <span className="ml-auto shrink-0 text-muted-foreground/60">
                    {line.traceId.slice(0, 8)}
                  </span>
                )}
              </div>
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
