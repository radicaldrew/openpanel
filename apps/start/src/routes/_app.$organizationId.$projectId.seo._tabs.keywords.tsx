import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { OverviewRange } from '@/components/overview/overview-range';
import { useOverviewOptions } from '@/components/overview/useOverviewOptions';
import { downloadKeywordsCsv } from '@/components/seo/keywords/keyword-csv';
import { KeywordResearchPanel } from '@/components/seo/keywords/keyword-research-panel';
import { KeywordResultsTable } from '@/components/seo/keywords/keyword-results-table';
import { SerpPreviewSheet } from '@/components/seo/keywords/serp-preview-sheet';
import {
  gscRowToTableRow,
  type KeywordSource,
  type KeywordTableRow,
  rankedRowToTableRow,
  researchRowToTableRow,
} from '@/components/seo/keywords/types';
import { useTrackKeywords } from '@/components/seo/keywords/use-track-keywords';
import { SeoGate } from '@/components/seo/seo-gate';
import { useSeoStatus } from '@/components/seo/use-seo-status';
import { useAppParams } from '@/hooks/use-app-params';
import { useTRPC } from '@/integrations/trpc/react';

export const Route = createFileRoute(
  '/_app/$organizationId/$projectId/seo/_tabs/keywords'
)({
  component: Component,
});

const RESEARCH_LIMIT = 200;
const GSC_LIMIT = 100;
const LABS_STALE_TIME_MS = 24 * 60 * 60 * 1000;

function Component() {
  return (
    <SeoGate requires={['dfs']}>
      <KeywordsTab />
    </SeoGate>
  );
}

/** What the user last submitted; queries key off this, not the live inputs. */
interface Submitted {
  source: KeywordSource;
  seed: string;
  domain: string;
}

function KeywordsTab() {
  const { projectId } = useAppParams();
  const trpc = useTRPC();
  const statusQuery = useSeoStatus(projectId);
  const status = statusQuery.data;
  const gscConnected = status?.gsc.connected ?? false;
  const ownDomain = status?.config?.domain ?? '';
  const domains = useMemo(
    () => [ownDomain, ...(status?.config?.competitors ?? [])].filter(Boolean),
    [ownDomain, status?.config?.competitors]
  );

  const [seed, setSeed] = useState('');
  const [source, setSource] = useState<KeywordSource>('ideas');
  const [domain, setDomain] = useState(ownDomain);
  const [submitted, setSubmitted] = useState<Submitted | null>(null);
  const [previewKeyword, setPreviewKeyword] = useState<string | null>(null);

  const { range, startDate, endDate } = useOverviewOptions();
  const { track, isPending: isTracking } = useTrackKeywords(projectId);

  const seedInput = {
    projectId,
    seed: submitted?.seed ?? '',
    limit: RESEARCH_LIMIT,
  };
  const seedEnabled = (target: KeywordSource) =>
    submitted?.source === target && submitted.seed.trim().length > 0;
  const labsOptions = { staleTime: LABS_STALE_TIME_MS };

  const ideasQuery = useQuery(
    trpc.seo.keywords.ideas.queryOptions(seedInput, {
      ...labsOptions,
      enabled: seedEnabled('ideas'),
    })
  );
  const suggestionsQuery = useQuery(
    trpc.seo.keywords.suggestions.queryOptions(seedInput, {
      ...labsOptions,
      enabled: seedEnabled('suggestions'),
    })
  );
  const relatedQuery = useQuery(
    trpc.seo.keywords.related.queryOptions(seedInput, {
      ...labsOptions,
      enabled: seedEnabled('related'),
    })
  );
  const rankedQuery = useQuery(
    trpc.seo.keywords.rankedKeywords.queryOptions(
      {
        projectId,
        domain: submitted?.domain || undefined,
        limit: RESEARCH_LIMIT,
      },
      { ...labsOptions, enabled: submitted?.source === 'ranked' }
    )
  );
  const gscQuery = useQuery(
    trpc.seo.keywords.gscEnriched.queryOptions(
      { projectId, range, startDate, endDate, limit: GSC_LIMIT },
      {
        enabled: submitted?.source === 'gsc' && gscConnected,
        // Pending rows resolve once the background job lands; poll gently.
        refetchInterval: (query) =>
          query.state.data?.rows.some((row) => row.pending) ? 15_000 : false,
      }
    )
  );

  const active = (() => {
    switch (submitted?.source) {
      case 'ideas':
        return { query: ideasQuery, rows: ideasQuery.data?.map(researchRowToTableRow) };
      case 'suggestions':
        return {
          query: suggestionsQuery,
          rows: suggestionsQuery.data?.map(researchRowToTableRow),
        };
      case 'related':
        return { query: relatedQuery, rows: relatedQuery.data?.map(researchRowToTableRow) };
      case 'ranked':
        return { query: rankedQuery, rows: rankedQuery.data?.rows.map(rankedRowToTableRow) };
      case 'gsc':
        return { query: gscQuery, rows: gscQuery.data?.rows.map(gscRowToTableRow) };
      default:
        return null;
    }
  })();

  const rows: KeywordTableRow[] = active?.rows ?? [];
  const isLoading = active?.query.isLoading ?? false;
  const error = active?.query.error ?? null;

  const emptyMessage = submitted
    ? error
      ? error.message
      : submitted.source === 'gsc'
        ? 'No Search Console queries in this range.'
        : 'No keywords found. Try a broader seed.'
    : 'Pick a source and a seed keyword to start researching.';

  const exportName = submitted
    ? submitted.source === 'ranked'
      ? submitted.domain
      : submitted.source === 'gsc'
        ? 'search-console'
        : `${submitted.source}-${submitted.seed}`
    : 'keywords';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="text-muted-foreground text-sm">
          Research for <span className="font-mono">{ownDomain}</span>
        </p>
        {source === 'gsc' && <OverviewRange />}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
        <KeywordResearchPanel
          domain={domain || ownDomain}
          domains={domains}
          gscConnected={gscConnected}
          isLoading={isLoading}
          onDomainChange={setDomain}
          onSeedChange={setSeed}
          onSourceChange={(next) => {
            setSource(next);
            if (!KEYWORD_SOURCE_NEEDS_SEED[next]) {
              setSubmitted({ source: next, seed: '', domain: domain || ownDomain });
            }
          }}
          onSubmit={() =>
            setSubmitted({
              source,
              seed: seed.trim(),
              domain: domain || ownDomain,
            })
          }
          seed={seed}
          source={source}
        />

        <KeywordResultsTable
          emptyMessage={emptyMessage}
          isLoading={isLoading}
          isTracking={isTracking}
          onExport={(selectedRows) => downloadKeywordsCsv(selectedRows, exportName)}
          onRowClick={setPreviewKeyword}
          onTrack={(keywords) =>
            track(keywords, submitted?.source === 'gsc' ? 'gsc' : 'research')
          }
          rows={rows}
          showGsc={submitted?.source === 'gsc'}
          showRank={submitted?.source === 'ranked'}
        />
      </div>

      <SerpPreviewSheet
        keyword={previewKeyword}
        onClose={() => setPreviewKeyword(null)}
        projectId={projectId}
      />
    </div>
  );
}

const KEYWORD_SOURCE_NEEDS_SEED: Record<KeywordSource, boolean> = {
  ideas: true,
  suggestions: true,
  related: true,
  ranked: false,
  gsc: false,
};
