import { describe, expect, it } from 'vitest';
import { compileBuilder } from './compile-builder';
import { QUERY_PATTERNS, applyQueryPattern, findQueryPattern } from './patterns';

describe('QUERY_PATTERNS', () => {
  it('has unique ids', () => {
    const ids = QUERY_PATTERNS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('leaves the metric empty so the editor fills it in', () => {
    for (const pattern of QUERY_PATTERNS) {
      expect(pattern.state.metric, pattern.id).toBe('');
    }
  });

  it('every pattern compiles once a metric is applied', () => {
    for (const pattern of QUERY_PATTERNS) {
      const applied = applyQueryPattern(pattern, 'http_requests_total');
      expect(() => compileBuilder(applied), pattern.id).not.toThrow();
      expect(compileBuilder(applied), pattern.id).toContain(
        'http_requests_total',
      );
    }
  });

  const compiled: [string, string, string][] = [
    [
      'request-rate',
      'http_requests_total',
      'sum(rate(http_requests_total[$__rate_interval]))',
    ],
    [
      'error-rate',
      'http_requests_total',
      'sum(rate(http_requests_total{status=~"5.."}[$__rate_interval]))',
    ],
    [
      'p95',
      'http_request_duration_seconds_bucket',
      'histogram_quantile(0.95, sum by (le)(rate(http_request_duration_seconds_bucket[$__rate_interval])))',
    ],
    [
      'top-k',
      'http_requests_total',
      'topk(5, sum by (service_name)(rate(http_requests_total[$__rate_interval])))',
    ],
    ['saturation', 'active_workers', 'max by (service_name)(active_workers)'],
  ];

  for (const [id, metric, expected] of compiled) {
    it(`${id} compiles to the shape people get wrong by hand`, () => {
      const pattern = findQueryPattern(id);
      expect(pattern, id).toBeDefined();
      expect(compileBuilder(applyQueryPattern(pattern!, metric))).toBe(expected);
    });
  }
});

describe('applyQueryPattern', () => {
  it('does not mutate the shared pattern', () => {
    const pattern = findQueryPattern('error-rate')!;
    const applied = applyQueryPattern(pattern, 'a_total');

    applied.labelMatchers[0]!.value = 'changed';
    applied.operations.push({ op: 'sum' });

    expect(pattern.state.metric).toBe('');
    expect(pattern.state.labelMatchers[0]!.value).toBe('5..');
    expect(pattern.state.operations).toHaveLength(2);
  });
});

describe('findQueryPattern', () => {
  it('returns undefined for an id that does not exist', () => {
    expect(findQueryPattern('nope')).toBeUndefined();
  });
});
