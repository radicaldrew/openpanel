import { describe, expect, it } from 'vitest';
import { InvalidProjectIdError, PROJECT_LABEL } from '../tenancy/project-label';
import { MetricQueryError, compileMetricQuery } from './compile';

const P = 'proj_123';
const compile = (q: Parameters<typeof compileMetricQuery>[0], project = P) =>
  compileMetricQuery(q, project).promql;

/**
 * This suite guards the read half of the tenancy boundary. A failure here means
 * a user can build a query that reads another project's telemetry.
 */

describe('tenancy — every compiled query is scoped', () => {
  it('injects the project matcher first, always', () => {
    // `fn` and `aggregation` are orthogonal, so a `raw` vector is still
    // wrapped by the default `sum` aggregator — the assertion is about the
    // selector, not the whole expression.
    expect(compile({ metric: 'http_requests_total', fn: 'raw' })).toContain(
      `http_requests_total{${PROJECT_LABEL}="proj_123"}`,
    );
  });

  it('keeps the matcher when the caller supplies their own filters', () => {
    expect(
      compile({
        metric: 'http_requests_total',
        fn: 'raw',
        matchers: [{ name: 'route', operator: 'eq', value: '/checkout' }],
      }),
    ).toContain(
      `http_requests_total{${PROJECT_LABEL}="proj_123",route="/checkout"}`,
    );
  });

  it('REFUSES a caller matcher on the tenancy label', () => {
    // Not "ignores" — refuses. An `=` would be redundant or conflicting, and a
    // `!=`/`!~` is an attempt to widen the selection beyond one project.
    for (const operator of ['eq', 'neq', 'match', 'notMatch'] as const) {
      expect(() =>
        compile({
          metric: 'm',
          fn: 'raw',
          matchers: [{ name: PROJECT_LABEL, operator, value: '.*' }],
        }),
      ).toThrow(MetricQueryError);
    }
  });

  it('always groups by the project label so the response check is not vacuous', () => {
    // An aggregation without it collapses every project into one series and
    // removes the label the ownership check looks for.
    const compiled = compileMetricQuery(
      { metric: 'm', aggregation: 'sum', groupBy: ['route'] },
      P,
    );

    expect(compiled.promql).toContain(`by (${PROJECT_LABEL}, route)`);
    expect(compiled.groupBy).toEqual([PROJECT_LABEL, 'route']);
  });

  it('does not duplicate the project label if the caller also groups by it', () => {
    expect(
      compile({ metric: 'm', aggregation: 'sum', groupBy: [PROJECT_LABEL] }),
    ).toContain(`by (${PROJECT_LABEL})`);
  });

  it('refuses an invalid project id rather than emitting an unscoped query', () => {
    expect(() => compile({ metric: 'm' }, 'has space')).toThrow(
      InvalidProjectIdError,
    );
  });
});

describe('injection resistance', () => {
  it('rejects a metric name that is not an identifier', () => {
    for (const metric of [
      'http_requests"} or up{',
      'a b',
      '1_starts_with_digit',
      'has-hyphen',
      '',
    ]) {
      expect(() => compile({ metric, fn: 'raw' }), metric).toThrow(
        MetricQueryError,
      );
    }
  });

  it('rejects a label name that is not an identifier', () => {
    expect(() =>
      compile({
        metric: 'm',
        fn: 'raw',
        matchers: [{ name: 'bad"name', operator: 'eq', value: 'x' }],
      }),
    ).toThrow(MetricQueryError);
  });

  it('escapes matcher VALUES rather than refusing them', () => {
    // Values are user data and may contain anything. The quote must not be able
    // to close the literal and start new expression syntax.
    const out = compile({
      metric: 'm',
      fn: 'raw',
      matchers: [
        { name: 'path', operator: 'eq', value: 'a"} or up{b="' },
      ],
    });

    expect(out).toContain(
      `m{${PROJECT_LABEL}="proj_123",path="a\\"} or up{b=\\""}`,
    );
    // No unescaped quote can terminate the literal early.
    expect(out.match(/(?<!\\)"/g)).toHaveLength(4);
  });

  it('escapes backslashes before quotes, not after', () => {
    // Escaping in the wrong order double-escapes the backslashes just added and
    // leaves the quote effectively unescaped.
    expect(
      compile({
        metric: 'm',
        fn: 'raw',
        matchers: [{ name: 'p', operator: 'eq', value: 'a\\"b' }],
      }),
    ).toContain('p="a\\\\\\"b"');
  });

  it('escapes newlines, which would otherwise terminate the literal', () => {
    expect(
      compile({
        metric: 'm',
        fn: 'raw',
        matchers: [{ name: 'p', operator: 'eq', value: 'a\nor up' }],
      }),
    ).toContain('p="a\\nor up"');
  });

  it('rejects a window that is not a Prometheus duration', () => {
    for (const window of ['5m) or up[1m', '5', 'abc', '']) {
      expect(() => compile({ metric: 'm', window }), window).toThrow(
        MetricQueryError,
      );
    }
  });
});

describe('compilation', () => {
  it('rates a counter by default', () => {
    expect(compile({ metric: 'http_requests_total', window: '1m' })).toBe(
      `sum by (${PROJECT_LABEL}) (rate(http_requests_total{${PROJECT_LABEL}="proj_123"}[1m]))`,
    );
  });

  it.each(['rate', 'increase', 'delta'] as const)(
    'supports %s over a range vector',
    (fn) => {
      expect(compile({ metric: 'm', fn, window: '5m' })).toContain(
        `${fn}(m{${PROJECT_LABEL}="proj_123"}[5m])`,
      );
    },
  );

  it.each(['sum', 'avg', 'min', 'max', 'count'] as const)(
    'supports the %s aggregator',
    (aggregation) => {
      expect(compile({ metric: 'm', aggregation, window: '1m' })).toContain(
        `${aggregation} by (`,
      );
    },
  );

  it('compiles a percentile to histogram_quantile over the bucket series', () => {
    expect(
      compile({
        metric: 'http_duration_seconds_bucket',
        aggregation: 'p95',
        groupBy: ['route'],
        window: '5m',
      }),
    ).toBe(
      `histogram_quantile(0.95, sum by (le, ${PROJECT_LABEL}, route) ` +
        `(rate(http_duration_seconds_bucket{${PROJECT_LABEL}="proj_123"}[5m])))`,
    );
  });

  it('refuses a percentile on a non-bucket metric instead of returning nonsense', () => {
    expect(() =>
      compile({ metric: 'http_requests_total', aggregation: 'p95' }),
    ).toThrow(/requires a histogram bucket series/);
  });

  it('carries the le label in the percentile grouping', () => {
    // histogram_quantile needs `le` to survive the inner aggregation; dropping
    // it yields NaN for every bucket.
    expect(
      compile({ metric: 'd_bucket', aggregation: 'p50', window: '1m' }),
    ).toContain('by (le,');
  });
});
