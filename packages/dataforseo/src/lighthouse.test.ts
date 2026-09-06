import { describe, expect, it } from 'vitest';
import { DataForSeoChargedTaskError } from './errors';
import { fetchLighthouseResult } from './lighthouse';
import { jsonResponse, makeTransport, mockFetch, requestBody } from './test-utils';

function lighthouseEnvelope(result: Record<string, unknown>) {
  return {
    status_code: 20_000,
    status_message: 'Ok.',
    tasks: [
      {
        id: 'task-1',
        status_code: 20_000,
        status_message: 'Ok.',
        path: ['v3', 'on_page', 'lighthouse', 'live', 'json'],
        cost: 0.004_25,
        result: [result],
      },
    ],
  };
}

describe('fetchLighthouseResult', () => {
  it('reduces a report to scores, metrics and failing audits', async () => {
    const fetchMock = mockFetch(
      jsonResponse(
        lighthouseEnvelope({
          requestedUrl: 'https://example.com/',
          finalUrl: 'https://example.com/',
          lighthouseVersion: '12.0.0',
          categories: {
            performance: { score: 0.61, auditRefs: [{ id: 'render-blocking-resources' }, { id: 'metrics' }] },
            accessibility: { score: 0.97, auditRefs: [{ id: 'color-contrast' }] },
            'best-practices': { score: 1, auditRefs: [] },
            seo: { score: 0.85, auditRefs: [{ id: 'meta-description' }] },
          },
          audits: {
            'first-contentful-paint': { score: 0.7, displayValue: '2.1 s', numericValue: 2100 },
            'largest-contentful-paint': { score: 0.4, displayValue: '4.2 s', numericValue: 4200 },
            'render-blocking-resources': {
              title: 'Eliminate render-blocking resources',
              description: 'Resources are blocking the first paint.',
              score: 0.2,
              scoreDisplayMode: 'metricSavings',
              displayValue: 'Potential savings of 450 ms',
              details: {
                overallSavingsMs: 450,
                items: [{ url: 'https://example.com/app.css', wastedMs: 450, totalBytes: 12_000 }],
              },
            },
            metrics: { score: 1, scoreDisplayMode: 'informative' },
            'color-contrast': { title: 'Contrast', description: '', score: 1 },
            'meta-description': {
              title: 'Document has a meta description',
              description: 'Meta descriptions may be included in search results.',
              score: 0,
              scoreDisplayMode: 'binary',
            },
          },
        }),
      ),
    );

    const result = await fetchLighthouseResult(makeTransport(fetchMock), {
      url: 'https://example.com/',
      strategy: 'mobile',
    });

    expect(requestBody(fetchMock.mock.calls[0])).toEqual([
      {
        url: 'https://example.com/',
        for_mobile: true,
        categories: ['performance', 'accessibility', 'best_practices', 'seo'],
      },
    ]);
    expect(result.billing).toEqual({
      path: ['v3', 'on_page', 'lighthouse', 'live', 'json'],
      costUsd: 0.004_25,
    });
    expect(result.data.scores).toEqual({
      performance: 61,
      accessibility: 97,
      'best-practices': 100,
      seo: 85,
    });
    expect(result.data.metrics.largestContentfulPaint).toEqual({
      score: 40,
      displayValue: '4.2 s',
      numericValue: 4200,
    });
    expect(result.data.metadata).toMatchObject({
      taskId: 'task-1',
      cost: 0.004_25,
      strategy: 'mobile',
      lighthouseVersion: '12.0.0',
    });
    expect(result.data.issues.map((issue) => [issue.auditKey, issue.severity])).toEqual([
      ['render-blocking-resources', 'critical'],
      ['meta-description', 'critical'],
    ]);
    expect(result.data.issues[0]?.items).toEqual([
      JSON.stringify({ url: 'https://example.com/app.css', totalBytes: 12_000, wastedMs: 450 }),
    ]);
  });

  it('carries billing metadata when parsing fails after a billed success', async () => {
    const fetchMock = mockFetch(
      jsonResponse(
        lighthouseEnvelope({
          requestedUrl: 'https://example.com/',
          finalUrl: 'https://example.com/',
          categories: {},
          audits: {},
        }),
      ),
    );

    const rejection = fetchLighthouseResult(makeTransport(fetchMock), {
      url: 'https://example.com/',
      strategy: 'mobile',
    });

    await expect(rejection).rejects.toBeInstanceOf(DataForSeoChargedTaskError);
    await expect(rejection).rejects.toMatchObject({
      kind: 'invalid_response',
      billing: { path: ['v3', 'on_page', 'lighthouse', 'live', 'json'], costUsd: 0.004_25 },
    });
  });

  it('does not retry an HTTP 5xx (the provider may have charged the task)', async () => {
    const fetchMock = mockFetch(new Response('upstream failure', { status: 503 }));

    await expect(
      fetchLighthouseResult(makeTransport(fetchMock), {
        url: 'https://example.com/',
        strategy: 'mobile',
      }),
    ).rejects.toMatchObject({ kind: 'upstream', status: 503 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
