import { z } from 'zod';
import {
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
import type { DataforseoTransport } from './core';
import {
  assertOk,
  buildTaskBilling,
  type DataforseoApiResponse,
  type DataforseoTaskLike,
  isRecord,
  parseWithSchema,
} from './envelope';
import { DataForSeoError } from './errors';
import type { LlmPlatform, LlmTarget } from './shared';

function clampLimit(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function targetList(target: LlmTarget): LlmTarget[] {
  return [target];
}

function firstResult(task: DataforseoTaskLike): Record<string, unknown> | null {
  const first = task.result?.[0];
  return isRecord(first) ? first : null;
}

// ---------------------------------------------------------------------------
// LLM Mentions Search
// ---------------------------------------------------------------------------

interface LlmMentionsSearchInput {
  target: LlmTarget;
  platform: LlmPlatform;
  locationCode: number;
  languageCode: string;
  limit?: number;
}

export async function fetchLlmMentionsSearch(
  transport: DataforseoTransport,
  input: LlmMentionsSearchInput,
): Promise<DataforseoApiResponse<LlmMentionItem[]>> {
  const path = '/v3/ai_optimization/llm_mentions/search/live';
  const response = await transport.post(path, [
    {
      target: targetList(input.target),
      platform: input.platform,
      location_code: input.locationCode,
      language_code: input.languageCode,
      limit: clampLimit(input.limit ?? 100, 1, 1000),
    },
  ]);
  const task = assertOk(response, { path });
  const items = parseWithSchema(
    'llm_mentions/search',
    task,
    firstResult(task)?.items ?? [],
    z.array(llmMentionItemSchema),
  );
  return { data: items, billing: buildTaskBilling(task) };
}

// ---------------------------------------------------------------------------
// LLM Mentions Aggregated Metrics
// ---------------------------------------------------------------------------

interface LlmAggregatedMetricsInput {
  target: LlmTarget;
  platform: LlmPlatform;
  locationCode: number;
  languageCode: string;
  internalListLimit?: number;
}

export async function fetchLlmAggregatedMetrics(
  transport: DataforseoTransport,
  input: LlmAggregatedMetricsInput,
): Promise<DataforseoApiResponse<LlmAggregatedTotal>> {
  const path = '/v3/ai_optimization/llm_mentions/aggregated_metrics/live';
  const response = await transport.post(path, [
    {
      target: targetList(input.target),
      platform: input.platform,
      location_code: input.locationCode,
      language_code: input.languageCode,
      internal_list_limit: clampLimit(input.internalListLimit ?? 10, 1, 20),
    },
  ]);
  const task = assertOk(response, { path });
  const total = parseWithSchema(
    'llm_mentions/aggregated_metrics',
    task,
    firstResult(task)?.total ?? {},
    llmAggregatedTotalSchema,
  );
  return { data: total, billing: buildTaskBilling(task) };
}

// ---------------------------------------------------------------------------
// LLM Mentions Top Pages
// ---------------------------------------------------------------------------

interface LlmTopPagesInput {
  target: LlmTarget;
  platform: LlmPlatform;
  locationCode: number;
  languageCode: string;
  itemsListLimit?: number;
}

export async function fetchLlmTopPages(
  transport: DataforseoTransport,
  input: LlmTopPagesInput,
): Promise<DataforseoApiResponse<LlmTopPagesItem[]>> {
  const path = '/v3/ai_optimization/llm_mentions/top_pages/live';
  const response = await transport.post(path, [
    {
      target: targetList(input.target),
      platform: input.platform,
      location_code: input.locationCode,
      language_code: input.languageCode,
      links_scope: 'sources',
      items_list_limit: clampLimit(input.itemsListLimit ?? 10, 1, 10),
      internal_list_limit: 5,
    },
  ]);
  const task = assertOk(response, { path });
  const items = parseWithSchema(
    'llm_mentions/top_pages',
    task,
    firstResult(task)?.items ?? [],
    z.array(llmTopPagesItemSchema),
  );
  return { data: items, billing: buildTaskBilling(task) };
}

// ---------------------------------------------------------------------------
// LLM Mentions Cross-Aggregated Metrics
// Compares 2..10 aggregation groups (target + competitors) in one call and
// returns one item per group, keyed by its aggregation_key (brand label).
// ---------------------------------------------------------------------------

interface LlmCrossAggregatedMetricsInput {
  groups: Array<{ key: string; target: LlmTarget }>;
  platform: LlmPlatform;
  locationCode: number;
  languageCode: string;
  internalListLimit?: number;
}

export async function fetchLlmCrossAggregatedMetrics(
  transport: DataforseoTransport,
  input: LlmCrossAggregatedMetricsInput,
): Promise<DataforseoApiResponse<LlmCrossAggregatedItem[]>> {
  const path = '/v3/ai_optimization/llm_mentions/cross_aggregated_metrics/live';
  if (input.groups.length < 2 || input.groups.length > 10) {
    throw new DataForSeoError(
      'DataForSEO llm_mentions/cross_aggregated_metrics requires 2 to 10 target groups',
      { kind: 'validation', path },
    );
  }

  const response = await transport.post(path, [
    {
      targets: input.groups.map((group) => ({
        aggregation_key: group.key,
        target: targetList(group.target),
      })),
      platform: input.platform,
      location_code: input.locationCode,
      language_code: input.languageCode,
      internal_list_limit: clampLimit(input.internalListLimit ?? 5, 1, 10),
    },
  ]);
  const task = assertOk(response, { path });
  const items = parseWithSchema(
    'llm_mentions/cross_aggregated_metrics',
    task,
    firstResult(task)?.items ?? [],
    z.array(llmCrossAggregatedItemSchema),
  );
  return { data: items, billing: buildTaskBilling(task) };
}

// ---------------------------------------------------------------------------
// LLM Responses (per-model)
// ---------------------------------------------------------------------------

export type LlmResponseModelSlug = 'chat_gpt' | 'claude' | 'gemini' | 'perplexity';

/**
 * Accepted `model_name` values per slug, mirroring DataForSEO's
 * `/ai_optimization/{model}/llm_responses/models` catalog (verified 2026-06-30).
 * We validate against this before dispatching because DataForSEO BILLS a task
 * that fails with `Invalid Field: 'model_name'` — a stale or mistyped model name
 * would otherwise pay for a guaranteed-rejected call. DataForSEO resolves a
 * basic alias (e.g. `claude-sonnet-4-5`) to its latest dated version.
 */
export const ACCEPTED_LLM_MODEL_NAMES: Record<LlmResponseModelSlug, ReadonlySet<string>> = {
  chat_gpt: new Set(['gpt-5']),
  claude: new Set(['claude-sonnet-4-5', 'claude-sonnet-4-6']),
  gemini: new Set(['gemini-2.5-pro']),
  perplexity: new Set(['sonar-reasoning-pro', 'sonar-pro', 'sonar']),
};

interface LlmResponsesInput {
  userPrompt: string;
  modelSlug: LlmResponseModelSlug;
  modelName: string;
  webSearch?: boolean;
  maxOutputTokens?: number;
  /** Two-letter ISO country code used to geolocate the web-search component. */
  webSearchCountryCode?: string;
}

interface LlmResponseRequestFields {
  user_prompt: string;
  model_name: string;
  web_search: boolean;
  max_output_tokens: number;
  web_search_country_iso_code?: string;
}

export async function fetchLlmResponse(
  transport: DataforseoTransport,
  input: LlmResponsesInput,
): Promise<DataforseoApiResponse<LlmResponseResult>> {
  const path = `/v3/ai_optimization/${input.modelSlug}/llm_responses/live`;
  // Fail fast on an unknown model_name: DataForSEO charges for tasks that fail
  // with `Invalid Field: 'model_name'`, so we must never dispatch one.
  if (!ACCEPTED_LLM_MODEL_NAMES[input.modelSlug].has(input.modelName)) {
    throw new DataForSeoError(
      `Unsupported DataForSEO model_name "${input.modelName}" for ${input.modelSlug}`,
      { kind: 'validation', path },
    );
  }

  // DataForSEO's Gemini endpoint rejects `web_search_country_iso_code` with a
  // 40501 "Invalid Field" error. The other three models accept it.
  const supportsCountry = input.modelSlug !== 'gemini';
  const fields: LlmResponseRequestFields = {
    user_prompt: input.userPrompt,
    model_name: input.modelName,
    web_search: input.webSearch ?? true,
    max_output_tokens: clampLimit(input.maxOutputTokens ?? 1024, 256, 4096),
    ...(supportsCountry && input.webSearchCountryCode
      ? { web_search_country_iso_code: input.webSearchCountryCode }
      : {}),
  };

  // Billed, non-idempotent: never replay on a 5xx.
  const response = await transport.post(path, [fields], { maxServerErrorRetries: 0 });
  const task = assertOk(response, { path });
  const result = parseWithSchema(
    'llm_responses',
    task,
    firstResult(task) ?? {},
    llmResponseResultSchema,
  );
  return { data: result, billing: buildTaskBilling(task) };
}
