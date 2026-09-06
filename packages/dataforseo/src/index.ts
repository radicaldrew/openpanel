// Public surface of @openpanel/dataforseo.
//
// Everything funnels through core.ts (authenticated fetch, timeout, retries,
// onCost hook) and envelope.ts (task status ladder + billing metadata). The
// section files (labs / serp / backlinks / ai / lighthouse / on-page /
// appendix) expose plain fetchers that take a transport as their first
// argument; createDataforseoClient binds them to one org's key.

// ---------------------------------------------------------------------------
// Client + transport
// ---------------------------------------------------------------------------
export {
  createDataforseoClient,
  type DataforseoClient,
  type DataforseoClientOptions,
} from './client';
export {
  createDataforseoTransport,
  DATAFORSEO_API_BASE,
  type DataforseoCostHook,
  type DataforseoRequestOptions,
  type DataforseoTransport,
  type DataforseoTransportOptions,
} from './core';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
export {
  DataForSeoChargedTaskError,
  DataForSeoError,
  type DataForSeoErrorKind,
  isDataForSeoError,
} from './errors';

// ---------------------------------------------------------------------------
// Envelope helpers (for callers that use the transport directly)
// ---------------------------------------------------------------------------
export {
  assertOk,
  buildTaskBilling,
  type DataforseoApiCallCost,
  type DataforseoApiResponse,
  type DataforseoItemsResult,
  type DataforseoItemsTask,
  type DataforseoResponseLike,
  type DataforseoTaskLike,
  isNoResultsTask,
  isTaskInProgress,
  parseTaskItems,
  parseTaskTotalCount,
} from './envelope';

// ---------------------------------------------------------------------------
// Appendix — free account endpoints (key validation, balance)
// ---------------------------------------------------------------------------
export {
  type DataforseoUserData,
  type DataforseoUserDataMoney,
  fetchUserData,
} from './appendix';

// ---------------------------------------------------------------------------
// DataForSEO Labs
// ---------------------------------------------------------------------------
export {
  type DomainMetricsItem,
  type DomainRankedKeywordItem,
  fetchDomainRankOverview,
  fetchKeywordIdeas,
  fetchKeywordOverview,
  fetchKeywordSuggestions,
  fetchRankedKeywords,
  fetchRelatedKeywords,
  fetchRelevantPages,
  fetchSerpCompetitors,
  type KeywordOverviewItem,
  type LabsItemType,
  type LabsKeywordDataItem,
  type LabsKeywordInfo,
  type LabsMonthlySearch,
  type RankedKeywordsPage,
  type RelatedKeywordItem,
  type RelevantPagesItem,
  type RelevantPagesPage,
  type SerpCompetitorItem,
} from './labs';

// ---------------------------------------------------------------------------
// Keyword metrics (Labs keyword_overview with Google Ads fallback)
// ---------------------------------------------------------------------------
export {
  fetchKeywordMetricsForList,
  KEYWORD_METRICS_BATCH_SIZE,
  type KeywordMetricRow,
  type KeywordMetricsClient,
} from './keyword-metrics';
export {
  type AdsKeywordIdeaItem,
  type AdsKeywordItem,
  fetchAdsKeywordIdeas,
  fetchAdsSearchVolume,
} from './google-ads';

// ---------------------------------------------------------------------------
// SERP (live + task queue) and locations
// ---------------------------------------------------------------------------
export {
  fetchLiveSerp,
  fetchLocalSerp,
  fetchRankCheckSerp,
  fetchRankCheckTaskResult,
  fetchSerpTasksReady,
  type PostedRankCheckTask,
  postRankCheckTasks,
  RANK_CHECK_TOP_RESULTS,
  type RankCheckResult,
  type RankCheckTaskInput,
  type RankCheckTaskOutcome,
  type RankCheckTopResult,
  SERP_ANALYSIS_DEPTH,
  type SerpLiveItem,
  type SerpTaskReadyItem,
} from './serp';
export {
  fetchSerpLocationsForCountry,
  SERP_LOCATION_TYPES,
  type SerpLocationResult,
} from './serp-locations';
export {
  DEFAULT_LOCATION_CODE,
  formatLocationLabel,
  getIsoCountryCode,
  getKeywordDataProvider,
  getLanguageCode,
  getLanguageOptions,
  isLabsLocationCode,
  isLanguageServedForLocation,
  isSupportedLanguageCode,
  isSupportedLocationCode,
  type KeywordDataProvider,
  LABS_LOCATION_OPTIONS,
  type LanguageOption,
  LOCATION_OPTIONS,
  LOCATIONS,
  type LocationOption,
  resolveKeywordDataLanguage,
  resolveLabsMarket,
  resolveMarket,
  SERP_LANGUAGE_OPTIONS,
} from './locations';

// ---------------------------------------------------------------------------
// Backlinks
// ---------------------------------------------------------------------------
export {
  type BacklinksHistoryItem,
  backlinksHistoryItemSchema,
  type BacklinksItem,
  backlinksItemSchema,
  type BacklinksListRequest,
  type BacklinksRequest,
  type BacklinksSummaryItem,
  backlinksSummaryItemSchema,
  type BacklinksTimeseriesRequest,
  type DomainPageSummaryItem,
  domainPageSummaryItemSchema,
  fetchBacklinksHistory,
  fetchBacklinksRows,
  fetchBacklinksSummary,
  fetchDomainPagesSummary,
  fetchReferringDomains,
  type NormalizedBacklinkTarget,
  normalizeBacklinksTarget,
  type ReferringDomainItem,
  referringDomainItemSchema,
} from './backlinks';

// ---------------------------------------------------------------------------
// AI Optimization (LLM mentions + LLM responses)
// ---------------------------------------------------------------------------
export {
  ACCEPTED_LLM_MODEL_NAMES,
  fetchLlmAggregatedMetrics,
  fetchLlmCrossAggregatedMetrics,
  fetchLlmMentionsSearch,
  fetchLlmResponse,
  fetchLlmTopPages,
  type LlmResponseModelSlug,
} from './ai';
export {
  type LlmAggregatedTotal,
  llmAggregatedTotalSchema,
  type LlmCrossAggregatedItem,
  llmCrossAggregatedItemSchema,
  type LlmMentionItem,
  llmMentionItemSchema,
  type LlmResponseResult,
  llmResponseResultSchema,
  type LlmTopPagesItem,
  llmTopPagesItemSchema,
} from './ai-schemas';
export {
  buildLlmTarget,
  CHATGPT_LANGUAGE_CODE,
  CHATGPT_LOCATION_CODE,
  type LlmPlatform,
  type LlmTarget,
  MAX_TASKS_PER_POST,
} from './shared';

// ---------------------------------------------------------------------------
// Lighthouse (on_page/lighthouse/live/json)
// ---------------------------------------------------------------------------
export { fetchLighthouseResult, LIGHTHOUSE_REQUEST_PATH } from './lighthouse';
export {
  LIGHTHOUSE_CATEGORIES,
  type LighthouseCategory,
  LIGHTHOUSE_REQUEST_CATEGORIES,
  type LighthouseStrategy,
  parseDataforseoLighthousePayload,
  type StoredLighthouseIssue,
  type StoredLighthousePayload,
  storedLighthousePayloadSchema,
} from './lighthouse-payload';

// ---------------------------------------------------------------------------
// On-Page (site audit crawler)
// ---------------------------------------------------------------------------
export {
  fetchOnPageDuplicateTags,
  fetchOnPageLinks,
  fetchOnPageNonIndexable,
  fetchOnPagePages,
  fetchOnPageSummary,
  type OnPageDuplicateTagItem,
  onPageDuplicateTagItemSchema,
  type OnPageDuplicateTagsRequest,
  type OnPageLinkItem,
  onPageLinkItemSchema,
  type OnPageLinksRequest,
  type OnPageListPage,
  type OnPageNonIndexableItem,
  onPageNonIndexableItemSchema,
  type OnPageNonIndexableRequest,
  type OnPagePageItem,
  onPagePageItemSchema,
  type OnPagePagesRequest,
  type OnPageSummary,
  onPageSummarySchema,
  type OnPageTaskPostInput,
  type PostedOnPageTask,
  postOnPageTask,
} from './on-page';

// ---------------------------------------------------------------------------
// Filter DSL builders
// ---------------------------------------------------------------------------
export {
  assertFilterConditionBudget,
  buildIncludeOrGroup,
  collectNumericRange,
  escapeLikeTerm,
  type FilterClause,
  joinClauses,
  parseFilterTerms,
} from './filters';
export {
  BACKLINKS_SUBFOLDER_FILTER_CONDITIONS,
  defaultScopeForInput,
  defaultScopeForPath,
  isScopeAllowedForInput,
  isValidDomainHost,
  parseResearchTarget,
  RESEARCH_SCOPE_DESCRIPTIONS,
  RESEARCH_SCOPE_EXAMPLES,
  RESEARCH_SCOPE_FILTER_SLOTS,
  RESEARCH_SCOPE_LABELS,
  RESEARCH_SCOPE_PARAM_DESCRIPTION,
  RESEARCH_SCOPES,
  type ResearchScope,
  researchScopeSchema,
  type ResearchTarget,
  urlMatchesResearchTarget,
} from './research-scope';
export {
  buildBacklinksScopeFilter,
  buildRankedKeywordsScopeFilter,
  buildRelevantPagesScopeFilter,
  countExpressionConditions,
  prependScopeClauses,
  type ScopeFilter,
} from './research-scope-filters';

// ---------------------------------------------------------------------------
// Zod input/output schemas (ported from open-seo/src/types/schemas)
// ---------------------------------------------------------------------------
export {
  type KeywordIntent,
  type KeywordMode,
  keywordModeSchema,
  type MonthlySearch,
  monthlySearchSchema,
  type ResearchKeywordsInput,
  researchKeywordsSchema,
  type SavedKeywordMetric,
  savedKeywordMetricSchema,
  type SerpAnalysisInput,
  serpAnalysisSchema,
} from './types/keywords';
export {
  type RankCheckTriggerResult,
  type RankTrackingConfigInput,
  rankTrackingConfigSchema,
  type RankTrackingDevice,
  type RankTrackingDeviceResult,
  type RankTrackingDevices,
  rankTrackingDevicesSchema,
  type RankTrackingRow,
  type RankTrackingSchedule,
  rankTrackingScheduleSchema,
  serpDepthSchema,
  trackedKeywordSchema,
  trackedKeywordsSchema,
} from './types/rank-tracking';
export {
  BACKLINKS_DEFAULT_SORT,
  BACKLINKS_PAGE_SIZES,
  BACKLINKS_SCOPE_DESCRIPTION,
  type BacklinksLookupInput,
  backlinksLookupSchema,
  type BacklinksRowsFilters,
  backlinksRowsFiltersSchema,
  backlinksRowsModeSchema,
  type BacklinksRowsPageInput,
  backlinksRowsPageRequestSchema,
  type BacklinksRowsSortField,
  backlinksRowsSortFieldSchema,
  type BacklinksScopeWithLegacy,
  backlinksScopeParamSchema,
  backlinksScopeWithLegacySchema,
  type BacklinksSortOrder,
  backlinksSortOrderSchema,
  type BacklinksSpamFilterOptions,
  type BacklinksTab,
  backlinksTabSchema,
  type BacklinksTargetScope,
  DEFAULT_BACKLINKS_PAGE_SIZE,
  normalizeBacklinksSpamFilterOptions,
  type ReferringDomainsFilters,
  referringDomainsFiltersSchema,
  type ReferringDomainsPageInput,
  referringDomainsPageRequestSchema,
  type ReferringDomainsSortField,
  referringDomainsSortFieldSchema,
  resolveBacklinksScope,
  type TopPagesFilters,
  topPagesFiltersSchema,
  type TopPagesPageInput,
  topPagesPageRequestSchema,
  type TopPagesSortField,
  topPagesSortFieldSchema,
} from './types/backlinks';
export {
  booleanSearchParamSchema,
  DEFAULT_DOMAIN_KEYWORDS_PAGE_SIZE,
  DOMAIN_KEYWORDS_PAGE_SIZES,
  domainField,
  type DomainKeywordsFilters,
  domainKeywordsFiltersSchema,
  type DomainKeywordsPageInput,
  domainKeywordsPageRequestSchema,
  type DomainOverviewInput,
  domainOverviewSchema,
  type DomainPagesPageInput,
  domainPagesPageRequestSchema,
  MAX_DATAFORSEO_FILTER_CONDITIONS,
  normalizeDomain,
} from './types/domain';
export {
  BRAND_LOOKUP_MAX_INPUT_LENGTH,
  type BrandLookupInput,
  brandLookupInputSchema,
  type BrandLookupResult,
  brandLookupResultSchema,
  parseCompetitorList,
  PROMPT_EXPLORER_MAX_PROMPT_LENGTH,
  PROMPT_EXPLORER_MODELS,
  type PromptExplorerCitation,
  type PromptExplorerInput,
  promptExplorerInputSchema,
  type PromptExplorerModel,
  type PromptExplorerModelResult,
  promptExplorerModelResultSchema,
  promptExplorerModelSchema,
  type PromptExplorerResult,
  promptExplorerResultSchema,
  WEB_SEARCH_COUNTRY_CODES,
  type WebSearchCountryCode,
  webSearchCountryCodeSchema,
} from './types/ai-search';
