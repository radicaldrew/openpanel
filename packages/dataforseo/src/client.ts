import {
  fetchLlmAggregatedMetrics,
  fetchLlmCrossAggregatedMetrics,
  fetchLlmMentionsSearch,
  fetchLlmResponse,
  fetchLlmTopPages,
} from './ai';
import { fetchUserData } from './appendix';
import {
  fetchBacklinksHistory,
  fetchBacklinksRows,
  fetchBacklinksSummary,
  fetchDomainPagesSummary,
  fetchReferringDomains,
} from './backlinks';
import {
  createDataforseoTransport,
  type DataforseoTransport,
  type DataforseoTransportOptions,
} from './core';
import type { DataforseoApiResponse } from './envelope';
import { fetchAdsKeywordIdeas, fetchAdsSearchVolume } from './google-ads';
import {
  fetchDomainRankOverview,
  fetchKeywordIdeas,
  fetchKeywordOverview,
  fetchKeywordSuggestions,
  fetchRankedKeywords,
  fetchRelatedKeywords,
  fetchRelevantPages,
  fetchSerpCompetitors,
} from './labs';
import { fetchLighthouseResult } from './lighthouse';
import {
  fetchOnPageDuplicateTags,
  fetchOnPageLinks,
  fetchOnPageNonIndexable,
  fetchOnPagePages,
  fetchOnPageSummary,
  postOnPageTask,
} from './on-page';
import {
  fetchLiveSerp,
  fetchLocalSerp,
  fetchRankCheckSerp,
  fetchRankCheckTaskResult,
  fetchSerpTasksReady,
  postRankCheckTasks,
} from './serp';
import { fetchSerpLocationsForCountry } from './serp-locations';

export type DataforseoClientOptions = DataforseoTransportOptions;

type Fetcher<I, T> = (
  transport: DataforseoTransport,
  input: I,
) => Promise<DataforseoApiResponse<T>>;

type NoInputFetcher<T> = (transport: DataforseoTransport) => Promise<DataforseoApiResponse<T>>;

function bind<I, T>(
  transport: DataforseoTransport,
  fetcher: Fetcher<I, T>,
): (input: I) => Promise<DataforseoApiResponse<T>> {
  return (input) => fetcher(transport, input);
}

function bindNoInput<T>(
  transport: DataforseoTransport,
  fetcher: NoInputFetcher<T>,
): () => Promise<DataforseoApiResponse<T>> {
  return () => fetcher(transport);
}

/**
 * One org's DataForSEO client: every section fetcher bound to a transport
 * built from that org's key. Each method resolves to `{ data, billing }`; the
 * transport additionally reports every envelope's cost through `onCost`.
 */
export function createDataforseoClient(options: DataforseoClientOptions) {
  const transport = createDataforseoTransport(options);
  return {
    /** Raw transport for endpoints without a typed wrapper. */
    transport,
    appendix: {
      /** Free: account login + balance. Rejects with kind "auth" on a bad key. */
      userData: bindNoInput(transport, fetchUserData),
    },
    backlinks: {
      summary: bind(transport, fetchBacklinksSummary),
      rows: bind(transport, fetchBacklinksRows),
      referringDomains: bind(transport, fetchReferringDomains),
      domainPages: bind(transport, fetchDomainPagesSummary),
      history: bind(transport, fetchBacklinksHistory),
    },
    keywords: {
      related: bind(transport, fetchRelatedKeywords),
      suggestions: bind(transport, fetchKeywordSuggestions),
      ideas: bind(transport, fetchKeywordIdeas),
      // Google Ads endpoints for countries Labs doesn't support.
      adsIdeas: bind(transport, fetchAdsKeywordIdeas),
      adsSearchVolume: bind(transport, fetchAdsSearchVolume),
    },
    domain: {
      rankOverview: bind(transport, fetchDomainRankOverview),
      rankedKeywords: bind(transport, fetchRankedKeywords),
      relevantPages: bind(transport, fetchRelevantPages),
    },
    serp: {
      live: bind(transport, fetchLiveSerp),
      rankCheck: bind(transport, fetchRankCheckSerp),
      // Posts up to 100 queued rank check tasks; DataForSEO bills task_post at
      // post time, collection is free.
      rankCheckTaskPost: bind(transport, postRankCheckTasks),
      rankCheckTaskGet: bind(transport, fetchRankCheckTaskResult),
      tasksReady: bindNoInput(transport, fetchSerpTasksReady),
      local: bind(transport, fetchLocalSerp),
      /** Free: sub-country locations for an ISO-2 country code. Cache it. */
      locationsForCountry: (countryCode: string) =>
        fetchSerpLocationsForCountry(transport, countryCode),
    },
    labs: {
      keywordOverview: bind(transport, fetchKeywordOverview),
      serpCompetitors: bind(transport, fetchSerpCompetitors),
    },
    lighthouse: {
      live: bind(transport, fetchLighthouseResult),
    },
    aiSearch: {
      mentionsSearch: bind(transport, fetchLlmMentionsSearch),
      aggregatedMetrics: bind(transport, fetchLlmAggregatedMetrics),
      topPages: bind(transport, fetchLlmTopPages),
      crossAggregatedMetrics: bind(transport, fetchLlmCrossAggregatedMetrics),
      llmResponse: bind(transport, fetchLlmResponse),
    },
    onPage: {
      taskPost: bind(transport, postOnPageTask),
      summary: (taskId: string) => fetchOnPageSummary(transport, taskId),
      pages: bind(transport, fetchOnPagePages),
      duplicateTags: bind(transport, fetchOnPageDuplicateTags),
      links: bind(transport, fetchOnPageLinks),
      nonIndexable: bind(transport, fetchOnPageNonIndexable),
    },
  } as const;
}

export type DataforseoClient = ReturnType<typeof createDataforseoClient>;
