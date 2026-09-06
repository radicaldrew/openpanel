import { describe, expect, it } from 'vitest';
import {
  fetchBacklinksHistory,
  fetchBacklinksRows,
  fetchBacklinksSummary,
  fetchReferringDomains,
  normalizeBacklinksTarget,
} from './backlinks';
import { jsonResponse, makeTransport, mockFetch, requestBody } from './test-utils';

// A successful DataForSEO task always carries billing metadata (path + cost).
const billed = {
  path: ['v3', 'backlinks', 'summary', 'live'],
  cost: 0.02,
  result_count: 0,
};

function okResponse(result: unknown[]) {
  return jsonResponse({
    status_code: 20_000,
    status_message: 'Ok.',
    tasks: [{ status_code: 20_000, status_message: 'Ok.', ...billed, result }],
  });
}

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('Expected normalizeBacklinksTarget to throw');
}

const VALIDATION_ERROR = { kind: 'validation' };

describe('normalizeBacklinksTarget', () => {
  it('defaults inputs with a path to a subfolder lookup', () => {
    expect(normalizeBacklinksTarget('https://github.com/Openpanel-dev/openpanel/')).toEqual({
      apiTarget: 'github.com',
      displayTarget: 'github.com/Openpanel-dev/openpanel',
      scope: 'subfolder',
      includeSubdomains: false,
      path: '/Openpanel-dev/openpanel',
    });
  });

  it('strips query strings and fragments for subfolder lookups', () => {
    expect(
      normalizeBacklinksTarget('example.com/blog?utm_source=x#hero', { scope: 'subfolder' }).path,
    ).toBe('/blog');
  });

  it('rejects subfolder scope without a path', () => {
    expect(captureError(() => normalizeBacklinksTarget('example.com', { scope: 'subfolder' }))).toMatchObject(VALIDATION_ERROR);
  });

  it('defaults bare hostnames to subdomains scope', () => {
    expect(normalizeBacklinksTarget('Example.com')).toEqual({
      apiTarget: 'example.com',
      displayTarget: 'example.com',
      scope: 'subdomains',
      includeSubdomains: true,
      path: '',
    });
  });

  it('includes subdomains only for subdomains scope', () => {
    expect(normalizeBacklinksTarget('https://Example.com/pricing', { scope: 'subdomains' })).toEqual({
      apiTarget: 'example.com',
      displayTarget: 'example.com',
      scope: 'subdomains',
      includeSubdomains: true,
      path: '',
    });
  });

  it('lets callers force a page lookup for bare hostnames', () => {
    expect(normalizeBacklinksTarget('Example.com', { scope: 'exact_url' })).toEqual({
      apiTarget: 'https://example.com/',
      displayTarget: 'https://example.com/',
      scope: 'exact_url',
      includeSubdomains: true,
      path: '',
    });
  });

  it('maps the legacy page scope onto exact_url', () => {
    expect(normalizeBacklinksTarget('Example.com', { scope: 'page' })).toEqual({
      apiTarget: 'https://example.com/',
      displayTarget: 'https://example.com/',
      scope: 'exact_url',
      includeSubdomains: true,
      path: '',
    });
  });

  it('rejects exact-url targets with query strings or fragments', () => {
    expect(captureError(() => normalizeBacklinksTarget('https://example.com/pricing?token=secret#hero', {
        scope: 'exact_url',
      }))).toMatchObject(VALIDATION_ERROR);
  });

  it('rejects page targets with embedded credentials', () => {
    expect(captureError(() => normalizeBacklinksTarget('https://user:pass@example.com/private'))).toMatchObject(VALIDATION_ERROR);
  });

  it('rejects hostnames DataForSEO would bill and fail on (underscores, no TLD, IPs)', () => {
    expect(captureError(() => normalizeBacklinksTarget('my_site.com'))).toMatchObject(VALIDATION_ERROR);
    expect(captureError(() => normalizeBacklinksTarget('localhost'))).toMatchObject(VALIDATION_ERROR);
    expect(captureError(() => normalizeBacklinksTarget('127.0.0.1'))).toMatchObject(VALIDATION_ERROR);
    expect(captureError(() => normalizeBacklinksTarget('example.c0m'))).toMatchObject(VALIDATION_ERROR);
  });
});

describe('fetchBacklinksSummary', () => {
  it('classifies top-level DataForSEO body errors as billing using status_code', async () => {
    const transport = makeTransport(
      mockFetch(
        jsonResponse({ status_code: 40_200, status_message: 'Account balance is too low', tasks: [] }),
      ),
    );

    await expect(fetchBacklinksSummary(transport, { target: 'example.com' })).rejects.toMatchObject({
      kind: 'billing',
      dfsStatusCode: 40_200,
      path: '/v3/backlinks/summary/live',
    });
  });

  it('treats null summary results as a valid zero-data response', async () => {
    const transport = makeTransport(mockFetch(okResponse([null])));
    await expect(
      fetchBacklinksSummary(transport, { target: 'not-a-real-input.example' }),
    ).resolves.toMatchObject({ data: {} });
  });

  it('treats empty summary results as a valid zero-data response', async () => {
    const transport = makeTransport(mockFetch(okResponse([])));
    await expect(fetchBacklinksSummary(transport, { target: 'example.com' })).resolves.toMatchObject(
      { data: {}, billing: { costUsd: 0.02 } },
    );
  });

  it('asks DataForSEO to exclude subdomains for a domain-scoped target', async () => {
    const fetchMock = mockFetch(okResponse([]));
    await fetchBacklinksSummary(makeTransport(fetchMock), {
      target: 'example.com',
      includeSubdomains: false,
    });
    expect(requestBody(fetchMock.mock.calls[0])).toMatchObject([
      { target: 'example.com', include_subdomains: false },
    ]);
  });

  it('parses a populated summary', async () => {
    const transport = makeTransport(
      mockFetch(okResponse([{ target: 'example.com', rank: 55, backlinks: 1200, referring_domains: 80 }])),
    );
    await expect(fetchBacklinksSummary(transport, { target: 'example.com' })).resolves.toMatchObject({
      data: { rank: 55, backlinks: 1200, referring_domains: 80 },
    });
  });
});

describe('backlinks lists', () => {
  it('treats empty backlinks rows and history results as valid empty arrays', async () => {
    const transport = makeTransport(mockFetch(okResponse([]), okResponse([])));

    await expect(fetchBacklinksRows(transport, { target: 'example.com' })).resolves.toMatchObject({
      data: { items: [], totalCount: null },
    });
    await expect(
      fetchBacklinksHistory(transport, {
        target: 'example.com',
        dateFrom: '2025-01-01',
        dateTo: '2025-12-31',
      }),
    ).resolves.toMatchObject({ data: [] });
  });

  it('appends the default spam filter and merges it with user filters', async () => {
    const fetchMock = mockFetch(okResponse([{ items: [], total_count: 0 }]), okResponse([]));
    const transport = makeTransport(fetchMock);

    await fetchBacklinksRows(transport, {
      target: 'example.com',
      filters: [['dofollow', '=', true]],
      mode: 'as_is',
    });
    expect(requestBody(fetchMock.mock.calls[0])).toMatchObject([
      {
        limit: 100,
        order_by: ['rank,desc'],
        mode: 'as_is',
        filters: [['dofollow', '=', true], 'and', ['backlink_spam_score', '<=', 40]],
      },
    ]);

    await fetchReferringDomains(transport, { target: 'example.com', hideSpam: false });
    const body = requestBody(fetchMock.mock.calls[1]) as Record<string, unknown>[];
    expect(body[0]).not.toHaveProperty('filters');
    expect(body[0]).toMatchObject({ order_by: ['backlinks,desc'] });
  });

  it('reads total_count for paginated lists', async () => {
    const transport = makeTransport(
      mockFetch(okResponse([{ items: [{ domain_from: 'a.com', rank: 10 }], total_count: 321 }])),
    );
    await expect(fetchBacklinksRows(transport, { target: 'example.com' })).resolves.toMatchObject({
      data: { items: [{ domain_from: 'a.com', rank: 10 }], totalCount: 321 },
    });
  });
});
