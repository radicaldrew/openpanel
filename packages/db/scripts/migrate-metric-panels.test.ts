import { describe, expect, it } from 'vitest';

import type { IMetricQuery } from '@openpanel/validation';

import { migrateMetricQuery } from './migrate-metric-panels';

/**
 * The mapping is checked against the PromQL the LEGACY compiler emitted
 * (`packages/gigapipe/src/promql/compile.ts`), minus the `op_project_id`
 * matcher the server injects at query time. A migrated panel that draws a
 * different chart from the one it replaced is the only real failure mode here,
 * and it is silent — the panel still renders, just wrongly.
 */
const query = (overrides: Partial<IMetricQuery>): IMetricQuery => ({
  metric: 'http_requests_total',
  matchers: [],
  fn: 'rate',
  aggregation: 'sum',
  groupBy: [],
  ...overrides,
});

/** The expression, or the reason it was skipped — whichever the test wants. */
const exprOf = (result: ReturnType<typeof migrateMetricQuery>) =>
  result.status === 'migrated' ? result.query.expr : `SKIPPED: ${result.reason}`;

describe('a legacy metric query becomes one panel query', () => {
  it('maps rate + sum', () => {
    expect(exprOf(migrateMetricQuery(query({})))).toBe(
      'sum(rate(http_requests_total[5m]))',
    );
  });

  it('keeps the stored window', () => {
    expect(exprOf(migrateMetricQuery(query({ window: '1m' })))).toBe(
      'sum(rate(http_requests_total[1m]))',
    );
  });

  it('defaults the window to the legacy 5m rather than $__rate_interval', () => {
    // Fidelity beats the better default: a migrated panel has to draw the
    // chart it drew yesterday, or the migration is a silent behaviour change.
    const result = migrateMetricQuery(query({ window: undefined }));

    expect(exprOf(result)).toContain('[5m]');
  });

  it('maps group-by onto the aggregation', () => {
    expect(
      exprOf(migrateMetricQuery(query({ groupBy: ['method', 'status'] }))),
    ).toBe('sum by (method, status)(rate(http_requests_total[5m]))');
  });

  it('maps every aggregation', () => {
    for (const aggregation of ['sum', 'avg', 'min', 'max', 'count'] as const) {
      expect(
        exprOf(migrateMetricQuery(query({ metric: 'queue_depth', fn: 'raw', aggregation }))),
      ).toBe(`${aggregation}(queue_depth)`);
    }
  });

  it('maps increase and delta', () => {
    for (const fn of ['increase', 'delta'] as const) {
      expect(exprOf(migrateMetricQuery(query({ fn })))).toBe(
        `sum(${fn}(http_requests_total[5m]))`,
      );
    }
  });

  it('maps every matcher operator', () => {
    const result = migrateMetricQuery(
      query({
        matchers: [
          { name: 'method', operator: 'eq', value: 'GET' },
          { name: 'status', operator: 'neq', value: '500' },
          { name: 'route', operator: 'match', value: '/api/.*' },
          { name: 'job', operator: 'notMatch', value: 'test.*' },
        ],
      }),
    );

    expect(exprOf(result)).toBe(
      'sum(rate(http_requests_total{method="GET", status!="500", route=~"/api/.*", job!~"test.*"}[5m]))',
    );
  });

  it('escapes a matcher value that would break out of its literal', () => {
    const result = migrateMetricQuery(
      query({
        matchers: [{ name: 'route', operator: 'eq', value: 'a"b\\c' }],
      }),
    );

    expect(exprOf(result)).toContain('route="a\\"b\\\\c"');
  });
});

describe('percentiles become the histogram_quantile pipeline', () => {
  it('maps p95 on a bucket series', () => {
    const result = migrateMetricQuery(
      query({
        metric: 'http_request_duration_seconds_bucket',
        aggregation: 'p95',
      }),
    );

    expect(exprOf(result)).toBe(
      'histogram_quantile(0.95, sum by (le)(rate(http_request_duration_seconds_bucket[5m])))',
    );
  });

  it('keeps le first and appends the group-by labels', () => {
    const result = migrateMetricQuery(
      query({
        metric: 'http_request_duration_seconds_bucket',
        aggregation: 'p99',
        groupBy: ['route'],
      }),
    );

    expect(exprOf(result)).toBe(
      'histogram_quantile(0.99, sum by (le, route)(rate(http_request_duration_seconds_bucket[5m])))',
    );
  });

  it('does not duplicate le when the report already grouped by it', () => {
    const result = migrateMetricQuery(
      query({
        metric: 'http_request_duration_seconds_bucket',
        aggregation: 'p50',
        groupBy: ['le'],
      }),
    );

    expect(exprOf(result)).toBe(
      'histogram_quantile(0.5, sum by (le)(rate(http_request_duration_seconds_bucket[5m])))',
    );
  });

  it('rates even when the stored fn said otherwise, and says so', () => {
    // The legacy percentile branch ignored `fn` entirely. Reproducing that is
    // right; doing it silently is not.
    const result = migrateMetricQuery(
      query({
        metric: 'http_request_duration_seconds_bucket',
        aggregation: 'p95',
        fn: 'raw',
      }),
    );

    expect(exprOf(result)).toContain('rate(');
    expect(result.status === 'migrated' && result.notices).toEqual([
      'fn "raw" was ignored by the legacy percentile path; kept as rate',
    ]);
  });

  it('skips a percentile on a metric that is not a bucket series', () => {
    // The legacy compiler threw on this, so the report never rendered. There
    // is no chart to be faithful to.
    const result = migrateMetricQuery(
      query({ metric: 'http_requests_total', aggregation: 'p95' }),
    );

    expect(result.status).toBe('skipped');
    expect(result.status === 'skipped' && result.reason).toContain(
      'not a _bucket series',
    );
  });
});

describe('raw on a cumulative metric is the bug, and is converted', () => {
  it('prepends a rate to a raw counter and reports it', () => {
    const result = migrateMetricQuery(query({ fn: 'raw' }));

    expect(exprOf(result)).toBe(
      'sum(rate(http_requests_total[$__rate_interval]))',
    );
    expect(result.status === 'migrated' && result.notices[0]).toContain(
      'auto-converted',
    );
  });

  it('prepends a rate to raw histogram buckets', () => {
    const result = migrateMetricQuery(
      query({ metric: 'http_request_duration_seconds_bucket', fn: 'raw' }),
    );

    expect(exprOf(result)).toBe(
      'sum(rate(http_request_duration_seconds_bucket[$__rate_interval]))',
    );
  });

  it('leaves a raw gauge alone', () => {
    // A gauge's rate is zero when the gauge is steady, so rating one would
    // replace a working chart with a flat line.
    const result = migrateMetricQuery(
      query({ metric: 'active_workers', fn: 'raw', aggregation: 'avg' }),
    );

    expect(exprOf(result)).toBe('avg(active_workers)');
    expect(result.status === 'migrated' && result.notices).toEqual([]);
  });
});

describe('the panel query carries what the renderer needs', () => {
  it('opens in the builder with round-trippable state', () => {
    const result = migrateMetricQuery(query({ groupBy: ['method'] }));

    expect(result.status === 'migrated' && result.query).toMatchObject({
      refId: 'A',
      mode: 'builder',
      hidden: false,
      yAxis: 'left',
      instant: false,
      builder: {
        metric: 'http_requests_total',
        operations: [
          { op: 'rate', range: '5m' },
          { op: 'sum', by: ['method'] },
        ],
      },
    });
  });

  it("keeps the report's own display unit over the metric name", () => {
    // After migration the renderer prefers the per-series panel unit, so
    // dropping this would silently restyle a chart someone had set up.
    const result = migrateMetricQuery(query({ metric: 'queue_depth', fn: 'raw' }), 'bytes');

    expect(result.status === 'migrated' && result.query.unit).toBe('bytes');
  });

  it("maps the legacy '%' to percentunit, not percent", () => {
    // The legacy formatter multiplies a '%' value by 100, so the stored number
    // is a 0-1 ratio — which is what percentunit means. Mapping it to percent
    // would render every value 100x too small.
    const result = migrateMetricQuery(query({ metric: 'error_rate', fn: 'raw' }), '%');

    expect(result.status === 'migrated' && result.query.unit).toBe('percentunit');
  });

  it('maps the other legacy units', () => {
    const cases = [
      ['s', 'seconds'],
      ['ms', 'ms'],
      ['bytes', 'bytes'],
    ] as const;

    for (const [reportUnit, expected] of cases) {
      const result = migrateMetricQuery(
        query({ metric: 'queue_depth', fn: 'raw' }),
        reportUnit,
      );

      expect(result.status === 'migrated' && result.query.unit).toBe(expected);
    }
  });

  it('falls back to the metric name for a unit it does not recognise', () => {
    const result = migrateMetricQuery(
      query({ metric: 'http_request_duration_seconds_bucket', aggregation: 'p95' }),
      'users',
    );

    expect(result.status === 'migrated' && result.query.unit).toBe('seconds');
  });

  it('infers the unit from the metric name', () => {
    const cases = [
      ['http_request_duration_seconds_bucket', 'seconds'],
      ['heap_bytes', 'bytes'],
      ['http_requests_total', 'none'],
    ] as const;

    for (const [metric, unit] of cases) {
      const result = migrateMetricQuery(
        query({
          metric,
          aggregation: metric.endsWith('_bucket') ? 'p95' : 'sum',
        }),
      );

      expect(result.status === 'migrated' && result.query.unit).toBe(unit);
    }
  });

  it('skips rather than throws when a query cannot compile', () => {
    // A metric name that is not a Prometheus identifier: stored rows predate
    // any validation of this, and one bad row must not stop the migration.
    const result = migrateMetricQuery(query({ metric: 'not a metric' }));

    expect(result.status).toBe('skipped');
  });
});
