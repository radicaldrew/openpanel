/**
 * PromQL → builder state, and the round trip back through `compileBuilder`.
 *
 * The round-trip cases are the ones that matter: the Builder tab is only safe
 * to enable when reading an expression and re-compiling it produces the SAME
 * query, because the moment the user touches a chip the compiled string
 * replaces `expr`. A parse that quietly drops a modifier would rewrite the
 * user's query behind their back, so every accepted shape is asserted to
 * survive the trip, and every shape that cannot survive it is asserted to be
 * refused outright.
 *
 * Run with: cd apps/start && NITRO=1 npx vitest run src/components/promql
 */
import { compileBuilder, defaultOperationsFor } from '@openpanel/common';
import { describe, expect, it } from 'vitest';

import { parseBuilderState } from './builder-parse';
import { hasVariables, maskPromqlVariables } from './promql-variables';

/** Parse, then compile back, for the "does the tab lie" question. */
function roundTrip(expr: string): string | null {
  const state = parseBuilderState(expr);
  return state === null ? null : compileBuilder(state);
}

describe('parseBuilderState — shapes the builder can express', () => {
  it('reads a bare selector', () => {
    expect(parseBuilderState('up')).toEqual({
      metric: 'up',
      labelMatchers: [],
      operations: [],
    });
  });

  it('reads label matchers with every operator', () => {
    expect(
      parseBuilderState(
        'node_load1{job="api",instance!="x",route=~"/v1/.*",method!~"GET"}',
      ),
    ).toEqual({
      metric: 'node_load1',
      labelMatchers: [
        { label: 'job', op: '=', value: 'api' },
        { label: 'instance', op: '!=', value: 'x' },
        { label: 'route', op: '=~', value: '/v1/.*' },
        { label: 'method', op: '!~', value: 'GET' },
      ],
      operations: [],
    });
  });

  it('reads a matcher-only selector, which has no metric', () => {
    expect(parseBuilderState('{service_name="api"}')).toEqual({
      metric: '',
      labelMatchers: [{ label: 'service_name', op: '=', value: 'api' }],
      operations: [],
    });
  });

  it('orders operations innermost-first, the way compileBuilder folds them', () => {
    // Read outermost-in — histogram_quantile, then sum, then rate — and
    // reversed, so the list runs in the order the chips are shown.
    expect(
      parseBuilderState(
        'histogram_quantile(0.95, sum by (le)(rate(http_request_duration_seconds_bucket[5m])))',
      ),
    ).toEqual({
      metric: 'http_request_duration_seconds_bucket',
      labelMatchers: [],
      operations: [
        { op: 'rate', range: '5m' },
        { op: 'sum', by: ['le'] },
        { op: 'histogram_quantile', q: 0.95 },
      ],
    });
  });

  it('keeps a dashboard variable as the range the user wrote', () => {
    // The masking that makes this parse must not leak into the result: the
    // range is sliced out of the ORIGINAL text, not out of the stand-in.
    expect(
      parseBuilderState('rate(http_requests_total[$__rate_interval])'),
    ).toEqual({
      metric: 'http_requests_total',
      labelMatchers: [],
      operations: [{ op: 'rate', range: '$__rate_interval' }],
    });
  });

  it('reads without() as well as by()', () => {
    expect(parseBuilderState('sum without (instance)(node_memory_bytes)'))
      .toEqual({
        metric: 'node_memory_bytes',
        labelMatchers: [],
        operations: [{ op: 'sum', without: ['instance'] }],
      });
  });

  it('reads an unmodified aggregation as neither by nor without', () => {
    expect(parseBuilderState('sum(up)')).toEqual({
      metric: 'up',
      labelMatchers: [],
      operations: [{ op: 'sum' }],
    });
  });

  it('reads topk with its k', () => {
    expect(parseBuilderState('topk(5, sum(rate(x_total[5m])))')).toEqual({
      metric: 'x_total',
      labelMatchers: [],
      operations: [
        { op: 'rate', range: '5m' },
        { op: 'sum' },
        { op: 'topk', k: 5 },
      ],
    });
  });

  it('reads a binary operation, keeping the right-hand side as text', () => {
    expect(parseBuilderState('sum(rate(x_total[5m])) / 60')).toEqual({
      metric: 'x_total',
      labelMatchers: [],
      operations: [
        { op: 'rate', range: '5m' },
        { op: 'sum' },
        { op: 'binary', operator: '/', rhs: '60' },
      ],
    });
  });

  it('sees through parentheses', () => {
    expect(parseBuilderState('((sum((up))))')).toEqual({
      metric: 'up',
      labelMatchers: [],
      operations: [{ op: 'sum' }],
    });
  });

  it('reads the step-less subquery a rate over an aggregation compiles to', () => {
    expect(parseBuilderState('rate((sum(x_total))[5m:])')).toEqual({
      metric: 'x_total',
      labelMatchers: [],
      operations: [{ op: 'sum' }, { op: 'rate', range: '5m' }],
    });
  });

  it('unescapes a matcher value back to what the user typed', () => {
    expect(parseBuilderState('up{path="a\\"b\\\\c"}')).toEqual({
      metric: 'up',
      labelMatchers: [{ label: 'path', op: '=', value: 'a"b\\c' }],
      operations: [],
    });
  });

  it('accepts every range function', () => {
    for (const fn of ['rate', 'increase', 'irate', 'delta'] as const) {
      expect(parseBuilderState(`${fn}(x_total[5m])`)?.operations).toEqual([
        { op: fn, range: '5m' },
      ]);
    }
  });

  it('accepts every aggregation', () => {
    for (const fn of ['sum', 'avg', 'min', 'max', 'count'] as const) {
      expect(parseBuilderState(`${fn}(up)`)?.operations).toEqual([{ op: fn }]);
    }
  });
});

describe('parseBuilderState — shapes it refuses rather than mangles', () => {
  const refused: [string, string][] = [
    ['empty input', ''],
    ['whitespace only', '   '],
    ['a syntax error', 'sum(rate(x_total[5m])'],
    ['an unknown function', 'avg_over_time(x[5m])'],
    ['an aggregation with no chip', 'quantile(0.9, up)'],
    ['count_values', 'count_values("v", up)'],
    ['a multi-argument function', 'clamp_max(up, 5)'],
    ['an offset modifier', 'rate(x_total[5m] offset 1h)'],
    ['an @ modifier', 'x_total @ 1609746000'],
    ['a subquery with an explicit step', 'rate((sum(x_total))[5m:1m])'],
    ['a quoted label matcher', 'up{"a.b"="c"}'],
    ['a bool modifier', 'up > bool 1'],
    ['an on() clause', 'up / on (job) up'],
    ['an unsupported binary operator', 'up % 2'],
    ['a bare number', '42'],
    ['a unary expression', '-up'],
    ['a variable used as a metric name', '$metric{job="api"}'],
    ['a range vector on its own', 'x_total[5m]'],
    ['topk with a grouping', 'topk by (job)(5, up)'],
    ['topk with a k the schema rejects', 'topk(0, up)'],
    ['topk with a fractional k', 'topk(1.5, up)'],
    ['a quantile outside 0–1', 'histogram_quantile(1.5, up)'],
  ];

  for (const [what, expr] of refused) {
    it(`refuses ${what}`, () => {
      expect(parseBuilderState(expr)).toBeNull();
    });
  }
});

describe('parseBuilderState — round trips through compileBuilder', () => {
  const cases: string[] = [
    'up',
    '{service_name="api"}',
    'up{job="api", route=~"/v1/.*"}',
    'sum(up)',
    'sum by (method, status)(rate(http_requests_total[5m]))',
    'sum without (instance)(node_memory_bytes)',
    'histogram_quantile(0.95, sum by (le)(rate(http_request_duration_seconds_bucket[$__rate_interval])))',
    'topk(5, sum(rate(x_total[5m])))',
    'rate((sum(x_total))[5m:])',
  ];

  for (const expr of cases) {
    it(`re-compiles ${expr} unchanged`, () => {
      expect(roundTrip(expr)).toBe(expr);
    });
  }

  it('normalises only cosmetics, never the query', () => {
    // Spacing and a redundant grouping label are the whole of what a round trip
    // is allowed to change.
    expect(roundTrip('sum by(le , le)( rate( x_total[5m] ) )')).toBe(
      'sum by (le)(rate(x_total[5m]))',
    );
  });

  it('preserves a value that would break out of its string literal', () => {
    const expr = 'up{path="a\\"b"}';
    expect(roundTrip(expr)).toBe(expr);
  });
});

describe('the operations a picked metric seeds', () => {
  // Plan §5 dev3 acceptance check 4, and the property that keeps the Builder
  // tab usable: if the pipeline the builder writes on the first click could not
  // be read back, the tab would disable itself on its own output.
  const seeded = (metric: string) => ({
    metric,
    labelMatchers: [],
    operations: defaultOperationsFor(metric),
  });

  it('seeds a histogram with rate → sum by (le) → p95, and reads it back', () => {
    const state = seeded('http_request_duration_seconds_bucket');

    expect(state.operations).toEqual([
      { op: 'rate', range: '$__rate_interval' },
      { op: 'sum', by: ['le'] },
      { op: 'histogram_quantile', q: 0.95 },
    ]);

    const expr = compileBuilder(state);
    expect(expr).toBe(
      'histogram_quantile(0.95, sum by (le)(rate(http_request_duration_seconds_bucket[$__rate_interval])))',
    );
    expect(parseBuilderState(expr)).toEqual(state);
  });

  it('seeds a counter with rate → sum, and reads it back', () => {
    const state = seeded('http_requests_total');
    const expr = compileBuilder(state);

    expect(expr).toBe('sum(rate(http_requests_total[$__rate_interval]))');
    expect(parseBuilderState(expr)).toEqual(state);
  });

  it('seeds a gauge with nothing, and reads it back', () => {
    const state = seeded('git_operations_in_flight');
    const expr = compileBuilder(state);

    expect(expr).toBe('git_operations_in_flight');
    expect(parseBuilderState(expr)).toEqual(state);
  });
});

describe('maskPromqlVariables', () => {
  it('keeps the length of every variable form', () => {
    // The `${…}` below are Grafana variable syntax inside PromQL, not template
    // placeholders — single-quoted on purpose, because the literal text is what
    // is being masked.
    for (const expr of [
      'rate(x[$__rate_interval])',
      'rate(x[${window}])',
      'rate(x[$w])',
      'up{job=~"$service"} / up{job=~"${other}"}',
    ]) {
      expect(maskPromqlVariables(expr)).toHaveLength(expr.length);
    }
  });

  it('turns a variable range into something the grammar accepts', () => {
    expect(maskPromqlVariables('rate(x[$__rate_interval])')).toBe(
      'rate(x[999999999999999s])',
    );
  });

  it('leaves an expression with no variables alone', () => {
    expect(maskPromqlVariables('rate(x[5m])')).toBe('rate(x[5m])');
    expect(hasVariables('rate(x[5m])')).toBe(false);
  });

  it('finds variables wherever they sit', () => {
    expect(hasVariables('rate(x[$__rate_interval])')).toBe(true);
    expect(hasVariables('up{job=~"$service"}')).toBe(true);
    // A bare `$` is not a variable, and neither is `$1`.
    expect(hasVariables('up{a="$"}')).toBe(false);
    expect(hasVariables('up{a="$1"}')).toBe(false);
  });
});
