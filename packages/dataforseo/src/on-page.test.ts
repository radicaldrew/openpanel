import { describe, expect, it, vi } from 'vitest';
import {
  fetchOnPageDuplicateTags,
  fetchOnPageLinks,
  fetchOnPageNonIndexable,
  fetchOnPagePages,
  fetchOnPageSummary,
  postOnPageTask,
} from './on-page';
import { jsonResponse, makeTransport, mockFetch, requestBody, requestUrl } from './test-utils';

// Fixtures follow the shapes documented at
// https://docs.dataforseo.com/v3/on_page/ (task_post, summary, pages,
// duplicate_tags, links, non_indexable).

const TASK_ID = '07131248-1535-0216-1000-17384017ad04';

const taskPostEnvelope = {
  version: '0.1.20240801',
  status_code: 20_000,
  status_message: 'Ok.',
  time: '0.0519 sec.',
  cost: 0.0125,
  tasks_count: 1,
  tasks_error: 0,
  tasks: [
    {
      id: TASK_ID,
      status_code: 20_100,
      status_message: 'Task Created.',
      time: '0.0051 sec.',
      cost: 0.0125,
      result_count: 0,
      path: ['v3', 'on_page', 'task_post'],
      data: {
        api: 'on_page',
        function: 'task_post',
        target: 'example.com',
        max_crawl_pages: 100,
        tag: 'audit-1',
      },
      result: null,
    },
  ],
};

function freeEnvelope(path: string[], result: unknown[]) {
  return {
    status_code: 20_000,
    status_message: 'Ok.',
    cost: 0,
    tasks: [
      {
        id: TASK_ID,
        status_code: 20_000,
        status_message: 'Ok.',
        cost: 0,
        result_count: result.length,
        path,
        result,
      },
    ],
  };
}

const summaryResult = {
  crawl_progress: 'finished',
  crawl_status: { max_crawl_pages: 100, pages_in_queue: 0, pages_crawled: 87 },
  crawl_gateway_address: '94.130.93.30',
  crawl_stop_reason: null,
  domain_info: {
    name: 'example.com',
    cms: null,
    ip: '93.184.216.34',
    server: 'ECS',
    crawl_start: '2026-09-06 10:00:00 +00:00',
    crawl_end: '2026-09-06 10:04:12 +00:00',
    total_pages: 87,
    ssl_info: { valid_certificate: true, certificate_issuer: 'DigiCert' },
    checks: { sitemap: 1, robots_txt: 1, http2: 1 },
  },
  page_metrics: {
    links_external: 12,
    links_internal: 640,
    duplicate_title: 4,
    duplicate_description: 9,
    duplicate_content: 0,
    broken_links: 3,
    broken_resources: 1,
    links_relation_conflict: 0,
    redirect_loop: 0,
    onpage_score: 91.3,
    non_indexable: 6,
    checks: { no_description: 5, title_too_long: 2, is_https: 87 },
  },
};

const pageItem = {
  resource_type: 'html',
  status_code: 200,
  location: null,
  url: 'https://example.com/pricing',
  size: 51_234,
  encoded_size: 12_034,
  total_transfer_size: 12_500,
  fetch_time: '2026-09-06 10:01:12 +00:00',
  click_depth: 1,
  onpage_score: 88.2,
  is_resource: false,
  url_length: 27,
  relative_url_length: 8,
  meta: {
    title: 'Pricing - Example',
    charset: 65_001,
    follow: true,
    generator: null,
    htags: { h1: ['Pricing'], h2: ['Plans', 'FAQ'] },
    description: 'Simple pricing for everyone.',
    favicon: 'https://example.com/favicon.ico',
    meta_keywords: null,
    canonical: 'https://example.com/pricing',
    internal_links_count: 34,
    external_links_count: 2,
    inbound_links_count: 12,
    images_count: 6,
    images_size: 240_000,
    scripts_count: 4,
    scripts_size: 300_000,
    stylesheets_count: 2,
    stylesheets_size: 40_000,
    title_length: 17,
    description_length: 28,
    render_blocking_scripts_count: 1,
    render_blocking_stylesheets_count: 2,
    cumulative_layout_shift: 0.02,
    content: {
      plain_text_size: 4200,
      plain_text_rate: 0.08,
      plain_text_word_count: 700,
      automated_readability_index: 8.1,
      flesch_kincaid_readability_index: 62.5,
      title_to_content_consistency: 0.9,
      description_to_content_consistency: 0.7,
    },
    social_media_tags: { 'og:title': 'Pricing', 'og:image': null },
  },
  page_timing: {
    time_to_interactive: 900,
    dom_complete: 850,
    largest_contentful_paint: 1200,
    first_input_delay: 10,
    connection_time: 30,
    time_to_secure_connection: 40,
    request_sent_time: 1,
    waiting_time: 120,
    download_time: 20,
    duration_time: 211,
    fetch_start: 0,
    fetch_end: 211,
  },
  checks: {
    no_title: false,
    no_description: false,
    is_https: true,
    title_too_long: false,
    has_render_blocking_resources: true,
  },
  content_encoding: 'gzip',
  media_type: 'text/html',
  server: 'ECS',
  cache_control: { cachable: true, ttl: 600 },
  checks_errors: [],
  checks_warnings: ['has_render_blocking_resources'],
  broken_resources: false,
  broken_links: false,
  duplicate_title: false,
  duplicate_description: true,
  duplicate_content: false,
};

describe('postOnPageTask', () => {
  it('posts a crawl and returns the task id, tag and provisional cost', async () => {
    const fetchMock = mockFetch(jsonResponse(taskPostEnvelope));
    const onCost = vi.fn();
    const transport = makeTransport(fetchMock, { onCost });

    const result = await postOnPageTask(transport, {
      target: 'example.com',
      maxCrawlPages: 100,
      tag: 'audit-1',
      crawlSubdomains: false,
      maxCrawlRate: 5,
    });

    expect(requestUrl(fetchMock.mock.calls[0])).toBe('https://api.dataforseo.com/v3/on_page/task_post');
    expect(requestBody(fetchMock.mock.calls[0])).toEqual([
      {
        target: 'example.com',
        max_crawl_pages: 100,
        enable_javascript: false,
        load_resources: false,
        allow_subdomains: false,
        max_crawl_rate: 5,
        tag: 'audit-1',
      },
    ]);
    expect(result.data).toEqual({ taskId: TASK_ID, tag: 'audit-1', costUsd: 0.0125 });
    expect(result.billing).toEqual({ path: ['v3', 'on_page', 'task_post'], costUsd: 0.0125 });
    expect(onCost).toHaveBeenCalledWith('/v3/on_page/task_post', 0.0125);
  });

  it('rejects a non-positive page budget before dispatch and never retries a 5xx', async () => {
    const fetchMock = mockFetch(new Response('boom', { status: 500 }));
    const transport = makeTransport(fetchMock);

    await expect(postOnPageTask(transport, { target: 'example.com', maxCrawlPages: 0 })).rejects.toMatchObject(
      { kind: 'validation' },
    );
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(postOnPageTask(transport, { target: 'example.com', maxCrawlPages: 10 })).rejects.toMatchObject(
      { kind: 'upstream', status: 500 },
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('surfaces a rejected task_post entry as a task error', async () => {
    const fetchMock = mockFetch(
      jsonResponse({
        status_code: 20_000,
        tasks: [
          {
            id: TASK_ID,
            status_code: 40_501,
            status_message: "Invalid Field: 'target'.",
            cost: 0,
            path: ['v3', 'on_page', 'task_post'],
            data: { target: 'not a domain' },
          },
        ],
      }),
    );
    await expect(
      postOnPageTask(makeTransport(fetchMock), { target: 'not a domain', maxCrawlPages: 10 }),
    ).rejects.toMatchObject({
      kind: 'task',
      dfsStatusCode: 40_501,
      message: `Invalid Field: 'target'. (sent target="not a domain")`,
    });
  });
});

describe('fetchOnPageSummary', () => {
  it('returns crawl progress and site-wide metrics', async () => {
    const fetchMock = mockFetch(
      jsonResponse(freeEnvelope(['v3', 'on_page', 'summary', TASK_ID], [summaryResult])),
    );
    const result = await fetchOnPageSummary(makeTransport(fetchMock), TASK_ID);

    expect(requestUrl(fetchMock.mock.calls[0])).toBe(
      `https://api.dataforseo.com/v3/on_page/summary/${TASK_ID}`,
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('GET');
    expect(result.data.crawl_progress).toBe('finished');
    expect(result.data.crawl_status).toMatchObject({ pages_crawled: 87 });
    expect(result.data.page_metrics).toMatchObject({
      onpage_score: 91.3,
      duplicate_description: 9,
      non_indexable: 6,
      checks: { no_description: 5 },
    });
    expect(result.data.domain_info?.checks).toEqual({ sitemap: 1, robots_txt: 1, http2: 1 });
    expect(result.billing).toEqual({ path: ['v3', 'on_page', 'summary', TASK_ID], costUsd: 0 });
  });

  it('reports an in-progress crawl', async () => {
    const fetchMock = mockFetch(
      jsonResponse(
        freeEnvelope(
          ['v3', 'on_page', 'summary', TASK_ID],
          [
            {
              crawl_progress: 'in_progress',
              crawl_status: { max_crawl_pages: 100, pages_in_queue: 40, pages_crawled: 12 },
              domain_info: null,
              page_metrics: null,
            },
          ],
        ),
      ),
    );
    const result = await fetchOnPageSummary(makeTransport(fetchMock), TASK_ID);
    expect(result.data.crawl_progress).toBe('in_progress');
    expect(result.data.page_metrics).toBeNull();
  });

  it('fails loudly when the summary has no result yet', async () => {
    const fetchMock = mockFetch(jsonResponse(freeEnvelope(['v3', 'on_page', 'summary', TASK_ID], [])));
    await expect(fetchOnPageSummary(makeTransport(fetchMock), TASK_ID)).rejects.toMatchObject({
      kind: 'invalid_response',
    });
  });
});

describe('fetchOnPagePages', () => {
  it('pages through crawled pages with filters and clamps the limit', async () => {
    const fetchMock = mockFetch(
      jsonResponse(
        freeEnvelope(
          ['v3', 'on_page', 'pages'],
          [{ crawl_progress: 'finished', total_items_count: 87, items_count: 1, items: [pageItem] }],
        ),
      ),
    );
    const result = await fetchOnPagePages(makeTransport(fetchMock), {
      taskId: TASK_ID,
      limit: 5000,
      offset: 200,
      filters: [['status_code', '>=', 400]],
      orderBy: ['onpage_score,asc'],
    });

    expect(requestUrl(fetchMock.mock.calls[0])).toBe('https://api.dataforseo.com/v3/on_page/pages');
    expect(requestBody(fetchMock.mock.calls[0])).toEqual([
      {
        id: TASK_ID,
        limit: 1000,
        offset: 200,
        filters: [['status_code', '>=', 400]],
        order_by: ['onpage_score,asc'],
      },
    ]);
    expect(result.data.crawlProgress).toBe('finished');
    expect(result.data.items).toHaveLength(1);
    expect(result.data.items[0]).toMatchObject({
      url: 'https://example.com/pricing',
      status_code: 200,
      onpage_score: 88.2,
      meta: { title: 'Pricing - Example', htags: { h1: ['Pricing'] } },
      checks: { is_https: true, has_render_blocking_resources: true },
      duplicate_description: true,
    });
    expect(result.data.totalCount).toBeNull();
  });

  it('returns an empty page while the crawl is still running', async () => {
    const fetchMock = mockFetch(
      jsonResponse(
        freeEnvelope(
          ['v3', 'on_page', 'pages'],
          [{ crawl_progress: 'in_progress', total_items_count: 0, items_count: 0, items: [] }],
        ),
      ),
    );
    const result = await fetchOnPagePages(makeTransport(fetchMock), { taskId: TASK_ID });
    expect(requestBody(fetchMock.mock.calls[0])).toEqual([{ id: TASK_ID, limit: 100, offset: 0 }]);
    expect(result.data).toEqual({ items: [], totalCount: null, crawlProgress: 'in_progress' });
  });
});

describe('fetchOnPageDuplicateTags', () => {
  it('lists pages sharing a title', async () => {
    const fetchMock = mockFetch(
      jsonResponse(
        freeEnvelope(
          ['v3', 'on_page', 'duplicate_tags'],
          [
            {
              crawl_progress: 'finished',
              total_items_count: 2,
              items_count: 2,
              items: [
                {
                  accumulator: 'Example - Home',
                  total_count: 3,
                  pages: ['https://example.com/', 'https://example.com/index', 'https://example.com/home'],
                },
                { accumulator: 'Blog', total_count: 2, pages: ['https://example.com/blog', 'https://example.com/blog/'] },
              ],
            },
          ],
        ),
      ),
    );
    const result = await fetchOnPageDuplicateTags(makeTransport(fetchMock), {
      taskId: TASK_ID,
      type: 'duplicate_title',
      limit: 50,
    });
    expect(requestBody(fetchMock.mock.calls[0])).toEqual([
      { id: TASK_ID, type: 'duplicate_title', limit: 50, offset: 0 },
    ]);
    expect(result.data.items.map((item) => item.accumulator)).toEqual(['Example - Home', 'Blog']);
    expect(result.data.items[0]?.pages).toHaveLength(3);
  });
});

describe('fetchOnPageLinks', () => {
  it('lists links with page scoping and filters', async () => {
    const fetchMock = mockFetch(
      jsonResponse(
        freeEnvelope(
          ['v3', 'on_page', 'links'],
          [
            {
              crawl_progress: 'finished',
              total_items_count: 1,
              items_count: 1,
              items: [
                {
                  type: 'link',
                  domain_from: 'example.com',
                  domain_to: 'partner.example',
                  page_from: '/pricing',
                  page_to: 'https://partner.example/deal',
                  link_from: 'https://example.com/pricing',
                  link_to: 'https://partner.example/deal',
                  dofollow: true,
                  page_from_scheme: 'https',
                  page_to_scheme: 'https',
                  direction: 'external',
                  is_broken: true,
                  is_link_relation_conflict: false,
                  is_redirect: false,
                  link_attribute: null,
                  text: 'Our partner',
                  text_pre: 'Read about ',
                  text_post: ' here.',
                },
              ],
            },
          ],
        ),
      ),
    );
    const result = await fetchOnPageLinks(makeTransport(fetchMock), {
      taskId: TASK_ID,
      pageFrom: '/pricing',
      filters: [['is_broken', '=', true]],
    });
    expect(requestBody(fetchMock.mock.calls[0])).toEqual([
      { id: TASK_ID, page_from: '/pricing', limit: 100, offset: 0, filters: [['is_broken', '=', true]] },
    ]);
    expect(result.data.items[0]).toMatchObject({
      direction: 'external',
      is_broken: true,
      link_to: 'https://partner.example/deal',
      text: 'Our partner',
    });
  });
});

describe('fetchOnPageNonIndexable', () => {
  it('lists non-indexable pages with the blocking reason', async () => {
    const fetchMock = mockFetch(
      jsonResponse(
        freeEnvelope(
          ['v3', 'on_page', 'non_indexable'],
          [
            {
              crawl_progress: 'finished',
              total_items_count: 2,
              items_count: 2,
              items: [
                { url: 'https://example.com/admin', reason: 'robots', status_code: 200, resource_type: 'html' },
                {
                  url: 'https://example.com/old',
                  reason: 'http_status_code',
                  status_code: 404,
                  resource_type: 'html',
                  checks: { is_4xx_code: true },
                },
              ],
            },
          ],
        ),
      ),
    );
    const result = await fetchOnPageNonIndexable(makeTransport(fetchMock), { taskId: TASK_ID, limit: 200 });
    expect(requestBody(fetchMock.mock.calls[0])).toEqual([{ id: TASK_ID, limit: 200, offset: 0 }]);
    expect(result.data.items.map((item) => [item.url, item.reason])).toEqual([
      ['https://example.com/admin', 'robots'],
      ['https://example.com/old', 'http_status_code'],
    ]);
    expect(result.billing.costUsd).toBe(0);
  });
});
