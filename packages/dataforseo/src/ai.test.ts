import { describe, expect, it, vi } from 'vitest';
import {
  fetchLlmAggregatedMetrics,
  fetchLlmCrossAggregatedMetrics,
  fetchLlmMentionsSearch,
  fetchLlmResponse,
  fetchLlmTopPages,
} from './ai';
import { buildLlmTarget } from './shared';
import { jsonResponse, makeTransport, mockFetch, requestBody, requestUrl } from './test-utils';

describe('AI Optimization endpoints', () => {
  it('serializes LLM mentions domain targets for search, top pages, and aggregated endpoints', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((url) => {
      const path = typeof url === 'string' || url instanceof URL ? url.toString() : url.url;
      const result = path.includes('/aggregated_metrics/') ? { total: { platform: [] } } : { items: [] };
      return Promise.resolve(
        jsonResponse({
          status_code: 20_000,
          tasks: [
            {
              status_code: 20_000,
              path: new URL(path).pathname.split('/').filter(Boolean),
              cost: 0.0001,
              result_count: 1,
              result: [result],
            },
          ],
        }),
      );
    });
    const transport = makeTransport(fetchMock);
    const target = buildLlmTarget({ type: 'domain', value: 'example.com' });

    await fetchLlmMentionsSearch(transport, {
      target,
      platform: 'google',
      locationCode: 2840,
      languageCode: 'en',
    });
    await fetchLlmAggregatedMetrics(transport, {
      target,
      platform: 'google',
      locationCode: 2840,
      languageCode: 'en',
    });
    await fetchLlmTopPages(transport, {
      target,
      platform: 'google',
      locationCode: 2840,
      languageCode: 'en',
      itemsListLimit: 10,
    });
    const expectedTarget = [
      {
        search_scope: ['any'],
        search_filter: 'include',
        domain: 'example.com',
        include_subdomains: true,
      },
    ];
    const payloads = fetchMock.mock.calls.map((call) => requestBody(call));

    expect(payloads).toEqual([
      [
        {
          target: expectedTarget,
          location_code: 2840,
          language_code: 'en',
          platform: 'google',
          limit: 100,
        },
      ],
      [
        {
          target: expectedTarget,
          location_code: 2840,
          language_code: 'en',
          platform: 'google',
          internal_list_limit: 10,
        },
      ],
      [
        {
          target: expectedTarget,
          location_code: 2840,
          language_code: 'en',
          platform: 'google',
          links_scope: 'sources',
          items_list_limit: 10,
          internal_list_limit: 5,
        },
      ],
    ]);
  });

  it('serializes cross-aggregated target groups', async () => {
    const fetchMock = mockFetch(
      jsonResponse({
        status_code: 20_000,
        tasks: [
          {
            status_code: 20_000,
            path: ['v3', 'ai_optimization', 'llm_mentions', 'cross_aggregated_metrics', 'live'],
            cost: 0.0001,
            result_count: 1,
            result: [{ items: [] }],
          },
        ],
      }),
    );
    const transport = makeTransport(fetchMock);

    await fetchLlmCrossAggregatedMetrics(transport, {
      groups: [
        { key: 'example.com', target: buildLlmTarget({ type: 'domain', value: 'example.com' }) },
        { key: 'Acme Storage', target: buildLlmTarget({ type: 'keyword', value: 'Acme Storage' }) },
      ],
      platform: 'google',
      locationCode: 2840,
      languageCode: 'en',
    });

    expect(requestBody(fetchMock.mock.calls[0])).toEqual([
      {
        targets: [
          {
            aggregation_key: 'example.com',
            target: [
              {
                search_scope: ['any'],
                search_filter: 'include',
                domain: 'example.com',
                include_subdomains: true,
              },
            ],
          },
          {
            aggregation_key: 'Acme Storage',
            target: [
              {
                search_scope: ['any', 'brand_entities'],
                search_filter: 'include',
                keyword: 'Acme Storage',
                match_type: 'word_match',
              },
            ],
          },
        ],
        location_code: 2840,
        language_code: 'en',
        platform: 'google',
        internal_list_limit: 5,
      },
    ]);
  });

  it('rejects cross-aggregated calls with fewer than two groups before dispatch', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await expect(
      fetchLlmCrossAggregatedMetrics(makeTransport(fetchMock), {
        groups: [{ key: 'x', target: buildLlmTarget({ type: 'domain', value: 'x.com' }) }],
        platform: 'google',
        locationCode: 2840,
        languageCode: 'en',
      }),
    ).rejects.toMatchObject({ kind: 'validation' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('serializes LLM mentions keyword targets', async () => {
    const fetchMock = mockFetch(
      jsonResponse({
        status_code: 20_000,
        tasks: [
          {
            status_code: 20_000,
            path: ['v3', 'ai_optimization', 'llm_mentions', 'search', 'live'],
            cost: 0.0001,
            result_count: 1,
            result: [{ items: [] }],
          },
        ],
      }),
    );

    await fetchLlmMentionsSearch(makeTransport(fetchMock), {
      target: buildLlmTarget({ type: 'keyword', value: 'Acme Storage' }),
      platform: 'chat_gpt',
      locationCode: 2840,
      languageCode: 'en',
    });

    expect(requestBody(fetchMock.mock.calls[0])).toEqual([
      {
        target: [
          {
            search_scope: ['any', 'brand_entities'],
            search_filter: 'include',
            keyword: 'Acme Storage',
            match_type: 'word_match',
          },
        ],
        location_code: 2840,
        language_code: 'en',
        platform: 'chat_gpt',
        limit: 100,
      },
    ]);
  });

  it('preserves web_search for Perplexity LLM responses', async () => {
    const fetchMock = mockFetch(
      jsonResponse({
        status_code: 20_000,
        tasks: [
          {
            status_code: 20_000,
            path: ['v3', 'ai_optimization', 'perplexity', 'llm_responses', 'live'],
            cost: 0.0001,
            result_count: 1,
            result: [{ model_name: 'sonar', output_tokens: 12, web_search: false, items: [] }],
          },
        ],
      }),
    );

    const result = await fetchLlmResponse(makeTransport(fetchMock), {
      userPrompt: 'What is Openpanel?',
      modelSlug: 'perplexity',
      modelName: 'sonar',
      webSearch: false,
      webSearchCountryCode: 'US',
    });

    expect(requestUrl(fetchMock.mock.calls[0])).toBe(
      'https://api.dataforseo.com/v3/ai_optimization/perplexity/llm_responses/live',
    );
    expect(requestBody(fetchMock.mock.calls[0])).toEqual([
      {
        user_prompt: 'What is Openpanel?',
        model_name: 'sonar',
        web_search: false,
        max_output_tokens: 1024,
        web_search_country_iso_code: 'US',
      },
    ]);
    expect(result.data.model_name).toBe('sonar');
  });

  it('drops web_search_country_iso_code for Gemini, which rejects it', async () => {
    const fetchMock = mockFetch(
      jsonResponse({
        status_code: 20_000,
        tasks: [
          {
            status_code: 20_000,
            path: ['v3', 'ai_optimization', 'gemini', 'llm_responses', 'live'],
            cost: 0.0001,
            result: [{ items: [] }],
          },
        ],
      }),
    );
    await fetchLlmResponse(makeTransport(fetchMock), {
      userPrompt: 'hi',
      modelSlug: 'gemini',
      modelName: 'gemini-2.5-pro',
      webSearchCountryCode: 'US',
    });
    expect(requestBody(fetchMock.mock.calls[0])).toEqual([
      { user_prompt: 'hi', model_name: 'gemini-2.5-pro', web_search: true, max_output_tokens: 1024 },
    ]);
  });

  it('rejects an unknown model_name before dispatching a paid LLM task', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await expect(
      fetchLlmResponse(makeTransport(fetchMock), {
        userPrompt: 'What is Openpanel?',
        modelSlug: 'claude',
        // DataForSEO dropped this from its catalog; it must never be dispatched.
        modelName: 'claude-sonnet-4-0',
      }),
    ).rejects.toMatchObject({ kind: 'validation' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
