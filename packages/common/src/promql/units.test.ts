import type { IPromqlUnit } from '@openpanel/validation';
import { describe, expect, it } from 'vitest';
import { formatValue, inferPromqlUnit, isAdditiveUnit } from './units';

describe('formatValue', () => {
  const cases: [IPromqlUnit, number, string][] = [
    ['none', 0, '0'],
    ['none', 1234.5, '1,234.5'],
    ['none', -1234.5, '-1,234.5'],
    ['none', 1_234_567, '1,234,567'],
    ['none', 0.125, '0.13'],

    ['short', 999, '999'],
    ['short', 1500, '1.5 K'],
    ['short', 2_500_000, '2.5 M'],
    ['short', 3_200_000_000, '3.2 B'],
    ['short', 4e12, '4 T'],

    ['percent', 42.5, '42.5%'],
    ['percent', 0.5, '0.5%'],
    ['percentunit', 0.5, '50%'],
    ['percentunit', 0.0342, '3.42%'],

    ['seconds', 0, '0 s'],
    ['seconds', 0.034, '34 ms'],
    ['seconds', 0.000_034, '34 µs'],
    ['seconds', 0.000_000_034, '34 ns'],
    ['seconds', 1.5, '1.5 s'],
    ['seconds', 90, '1.5 min'],
    ['seconds', 7200, '2 h'],
    ['seconds', 172_800, '2 d'],
    ['seconds', -0.034, '-34 ms'],

    ['ms', 0, '0 ms'],
    ['ms', 0.5, '500 µs'],
    ['ms', 34, '34 ms'],
    ['ms', 1500, '1.5 s'],
    ['ms', 90_000, '1.5 min'],

    ['bytes', 512, '512 B'],
    ['bytes', 2048, '2 KiB'],
    ['bytes', 5 * 1024 ** 2, '5 MiB'],
    ['bytes', 3 * 1024 ** 3, '3 GiB'],
    ['bytes', 2 * 1024 ** 4, '2 TiB'],

    ['ops', 12.345, '12.35 ops/s'],
  ];

  for (const [unit, value, expected] of cases) {
    it(`${unit}: ${value} → ${expected}`, () => {
      expect(formatValue(value, unit)).toBe(expected);
    });
  }

  it('renders a non-finite value as a dash rather than NaN', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(formatValue(value, 'seconds')).toBe('—');
    }
  });
});

describe('isAdditiveUnit', () => {
  const cases: [IPromqlUnit, boolean][] = [
    ['none', true],
    ['short', true],
    ['ops', true],
    ['seconds', false],
    ['ms', false],
    ['bytes', false],
    ['percent', false],
    ['percentunit', false],
  ];

  for (const [unit, expected] of cases) {
    it(`${unit} → ${expected}`, () => {
      expect(isAdditiveUnit(unit)).toBe(expected);
    });
  }
});

describe('inferPromqlUnit', () => {
  const cases: [string, IPromqlUnit][] = [
    ['http_request_duration_seconds', 'seconds'],
    ['http_request_duration_seconds_bucket', 'seconds'],
    ['http_request_duration_seconds_sum', 'seconds'],
    ['job_latency_ms', 'ms'],
    ['heap_size_bytes', 'bytes'],
    ['cache_hit_ratio', 'percentunit'],
    ['disk_used_percent', 'percent'],
    ['http_requests_total', 'none'],
    ['active_workers', 'none'],
  ];

  for (const [metric, expected] of cases) {
    it(`${metric} → ${expected}`, () => {
      expect(inferPromqlUnit(metric)).toBe(expected);
    });
  }
});
