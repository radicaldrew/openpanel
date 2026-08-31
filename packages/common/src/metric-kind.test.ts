import { describe, expect, it } from 'vitest';
import {
  defaultMetricFn,
  inferMetricKind,
  inferMetricUnit,
  supportsRateFunctions,
} from './metric-kind';

/**
 * The cases below are the metric names actually present on the gitgraph
 * instance, because the bug this exists to prevent was not hypothetical: every
 * chart read zero, and the reason was `rate` applied to a steady gauge.
 */
describe('inferMetricKind', () => {
  it.each([
    ['saist_findings_total', 'counter'],
    ['graph_write_latency_ms_count', 'counter'],
    ['ast_parse_duration_seconds_sum', 'counter'],
    ['http_request_duration_seconds_bucket', 'histogram'],
    ['queue_depth', 'gauge'],
    ['active_workers', 'gauge'],
    ['cgo_in_flight', 'gauge'],
    ['up', 'gauge'],
    ['scrape_samples_scraped', 'gauge'],
    ['scrape_duration_seconds', 'gauge'],
  ] as const)('%s is a %s', (name, kind) => {
    expect(inferMetricKind(name)).toBe(kind);
  });

  it('is not confused by case', () => {
    expect(inferMetricKind('Requests_Total')).toBe('counter');
  });

  it('reads a bucket as a histogram, not as the counter it is underneath', () => {
    // Technically cumulative, but the useful operation is a quantile, and
    // calling it a counter would default it to rate.
    expect(inferMetricKind('latency_bucket')).toBe('histogram');
  });
});

describe('defaultMetricFn', () => {
  it('rates a counter, because a counter only ever climbs', () => {
    expect(defaultMetricFn('saist_findings_total')).toBe('rate');
  });

  it('reads a gauge raw, because the rate of a steady gauge is always zero', () => {
    // The exact failure that made every chart read zero: `up` sits at 1
    // forever, and rate(up) is 0 forever.
    expect(defaultMetricFn('up')).toBe('raw');
    expect(defaultMetricFn('queue_depth')).toBe('raw');
    expect(defaultMetricFn('scrape_samples_scraped')).toBe('raw');
  });
});

describe('supportsRateFunctions', () => {
  it('hides rate-style functions for a gauge', () => {
    expect(supportsRateFunctions('queue_depth')).toBe(false);
  });

  it('offers them for a counter', () => {
    expect(supportsRateFunctions('saist_findings_total')).toBe(true);
  });
});

describe('inferMetricUnit', () => {
  it.each([
    ['scrape_duration_seconds', 's'],
    ['graph_write_latency_ms', 'ms'],
    ['heap_bytes', 'bytes'],
    ['saist_tier_drop_ratio', '%'],
    ['cpu_percent', '%'],
  ] as const)('%s is measured in %s', (name, unit) => {
    expect(inferMetricUnit(name)).toBe(unit);
  });

  it('sees through a cumulative suffix', () => {
    expect(inferMetricUnit('ast_parse_duration_seconds_sum')).toBe('s');
    expect(inferMetricUnit('graph_write_latency_ms_count')).toBe('ms');
  });

  it('says nothing when the name states nothing', () => {
    expect(inferMetricUnit('queue_depth')).toBeUndefined();
    expect(inferMetricUnit('up')).toBeUndefined();
  });
});
