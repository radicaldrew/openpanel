import type { IBuilderOp, IPromqlBuilderState } from '@openpanel/validation';
import { describe, expect, it } from 'vitest';
import {
  PromqlBuilderError,
  compileBuilder,
  defaultOperationsFor,
  escapePromqlString,
} from './compile-builder';

const state = (
  partial: Partial<IPromqlBuilderState> = {},
): IPromqlBuilderState => ({
  metric: 'http_requests_total',
  labelMatchers: [],
  operations: [],
  ...partial,
});

describe('the selector', () => {
  const cases: [string, IPromqlBuilderState, string][] = [
    ['a bare metric', state(), 'http_requests_total'],
    [
      'one matcher',
      state({ labelMatchers: [{ label: 'job', op: '=', value: 'api' }] }),
      'http_requests_total{job="api"}',
    ],
    [
      'every matcher operator',
      state({
        labelMatchers: [
          { label: 'a', op: '=', value: '1' },
          { label: 'b', op: '!=', value: '2' },
          { label: 'c', op: '=~', value: '3.*' },
          { label: 'd', op: '!~', value: '4.*' },
        ],
      }),
      'http_requests_total{a="1", b!="2", c=~"3.*", d!~"4.*"}',
    ],
    [
      'a matcher-only selector, which is valid PromQL',
      state({
        metric: '',
        labelMatchers: [{ label: 'job', op: '=', value: 'api' }],
      }),
      '{job="api"}',
    ],
    ['nothing at all', state({ metric: '' }), ''],
    [
      'a recording-rule name, which may carry a colon',
      state({ metric: 'job:http_requests:rate5m' }),
      'job:http_requests:rate5m',
    ],
    [
      'blank matcher rows, which the editor leaves behind',
      state({ labelMatchers: [{ label: '  ', op: '=', value: 'x' }] }),
      'http_requests_total',
    ],
  ];

  for (const [name, input, expected] of cases) {
    it(name, () => {
      expect(compileBuilder(input)).toBe(expected);
    });
  }

  it('escapes a value so it cannot leave its string literal', () => {
    expect(
      compileBuilder(
        state({
          labelMatchers: [{ label: 'path', op: '=', value: 'a"} or up{b="c' }],
        }),
      ),
    ).toBe('http_requests_total{path="a\\"} or up{b=\\"c"}');
  });

  it('escapes backslashes before quotes, not after', () => {
    expect(escapePromqlString('a\\"b')).toBe('a\\\\\\"b');
  });
});

describe('operations fold left to right', () => {
  const cases: [string, IBuilderOp[], string][] = [
    [
      'rate over the selector',
      [{ op: 'rate', range: '5m' }],
      'rate(http_requests_total[5m])',
    ],
    [
      'every range function',
      [{ op: 'irate', range: '1m' }],
      'irate(http_requests_total[1m])',
    ],
    [
      'a variable range',
      [{ op: 'rate', range: '$__rate_interval' }],
      'rate(http_requests_total[$__rate_interval])',
    ],
    [
      'rate then sum',
      [{ op: 'rate', range: '5m' }, { op: 'sum' }],
      'sum(rate(http_requests_total[5m]))',
    ],
    [
      'sum by',
      [
        { op: 'rate', range: '5m' },
        { op: 'sum', by: ['method', 'status'] },
      ],
      'sum by (method, status)(rate(http_requests_total[5m]))',
    ],
    [
      'sum without',
      [
        { op: 'rate', range: '5m' },
        { op: 'sum', without: ['instance'] },
      ],
      'sum without (instance)(rate(http_requests_total[5m]))',
    ],
    [
      'the p95 pipeline',
      [
        { op: 'rate', range: '5m' },
        { op: 'sum', by: ['le'] },
        { op: 'histogram_quantile', q: 0.95 },
      ],
      'histogram_quantile(0.95, sum by (le)(rate(http_requests_total[5m])))',
    ],
    [
      'topk after an aggregation',
      [
        { op: 'rate', range: '5m' },
        { op: 'sum', by: ['route'] },
        { op: 'topk', k: 5 },
      ],
      'topk(5, sum by (route)(rate(http_requests_total[5m])))',
    ],
    [
      'a binary operation against a literal',
      [{ op: 'sum' }, { op: 'binary', operator: '/', rhs: '60' }],
      'sum(http_requests_total) / 60',
    ],
    [
      'a binary operation against a function call, which needs no parentheses',
      [
        { op: 'sum' },
        { op: 'binary', operator: '/', rhs: 'sum(http_requests_created)' },
      ],
      'sum(http_requests_total) / sum(http_requests_created)',
    ],
    [
      'a binary operation against an expression that would reassociate',
      [{ op: 'sum' }, { op: 'binary', operator: '/', rhs: 'a + b' }],
      'sum(http_requests_total) / (a + b)',
    ],
    [
      'a chained binary, where the left side is parenthesised so it cannot reassociate',
      [
        { op: 'binary', operator: '+', rhs: '1' },
        { op: 'binary', operator: '*', rhs: '2' },
      ],
      '(http_requests_total + 1) * 2',
    ],
    [
      'a raw operation wrapping what came before',
      [
        { op: 'rate', range: '5m' },
        { op: 'raw', expr: 'clamp_min($__expr, 0)' },
      ],
      'clamp_min(rate(http_requests_total[5m]), 0)',
    ],
    [
      'a raw operation standing alone',
      [{ op: 'raw', expr: 'vector(1)' }],
      'vector(1)',
    ],
  ];

  for (const [name, operations, expected] of cases) {
    it(name, () => {
      expect(compileBuilder(state({ operations }))).toBe(expected);
    });
  }

  it('uses a subquery when a range function follows a non-selector', () => {
    // `sum(x)[5m]` is a parse error; `(sum(x))[5m:]` is what PromQL requires.
    expect(
      compileBuilder(
        state({
          operations: [{ op: 'sum' }, { op: 'rate', range: '5m' }],
        }),
      ),
    ).toBe('rate((sum(http_requests_total))[5m:])');
  });

  it('deduplicates grouping labels', () => {
    expect(
      compileBuilder(
        state({ operations: [{ op: 'sum', by: ['le', 'le', 'method'] }] }),
      ),
    ).toBe('sum by (le, method)(http_requests_total)');
  });

  it('never emits the tenancy label — the server injects it', () => {
    const out = compileBuilder(
      state({
        operations: [
          { op: 'rate', range: '5m' },
          { op: 'sum', by: ['method'] },
        ],
      }),
    );

    expect(out).not.toContain('op_project_id');
  });
});

describe('rejections', () => {
  const cases: [string, IPromqlBuilderState][] = [
    ['a metric name with a brace', state({ metric: 'up{job="a"}' })],
    ['a metric name with a space', state({ metric: 'http requests' })],
    [
      'a label name that is not an identifier',
      state({ labelMatchers: [{ label: 'a-b', op: '=', value: 'x' }] }),
    ],
    [
      'a range that could close the bracket',
      state({ operations: [{ op: 'rate', range: '5m] or up[1h' }] }),
    ],
    [
      'a range that is not a duration',
      state({ operations: [{ op: 'rate', range: 'five minutes' }] }),
    ],
    [
      'a group-by label that is not an identifier',
      state({ operations: [{ op: 'sum', by: ['le) or up (' ] }] }),
    ],
    [
      'topk with a non-integer k',
      state({ operations: [{ op: 'topk', k: 1.5 }] }),
    ],
    [
      'a binary with an empty right-hand side',
      state({ operations: [{ op: 'binary', operator: '/', rhs: '   ' }] }),
    ],
    [
      'an operation with no metric under it',
      state({ metric: '', operations: [{ op: 'sum' }] }),
    ],
  ];

  for (const [name, input] of cases) {
    it(`rejects ${name}`, () => {
      expect(() => compileBuilder(input)).toThrow(PromqlBuilderError);
    });
  }
});

describe('defaultOperationsFor', () => {
  it('seeds a histogram with the full quantile pipeline', () => {
    expect(defaultOperationsFor('http_request_duration_seconds_bucket')).toEqual(
      [
        { op: 'rate', range: '$__rate_interval' },
        { op: 'sum', by: ['le'] },
        { op: 'histogram_quantile', q: 0.95 },
      ],
    );
  });

  it('seeds a counter with rate then sum', () => {
    expect(defaultOperationsFor('http_requests_total')).toEqual([
      { op: 'rate', range: '$__rate_interval' },
      { op: 'sum' },
    ]);
  });

  it('leaves a gauge alone, because rate over a gauge is always zero', () => {
    expect(defaultOperationsFor('active_workers')).toEqual([]);
  });

  it('produces the p95 expression a histogram is picked for', () => {
    expect(
      compileBuilder(
        state({
          metric: 'http_request_duration_seconds_bucket',
          operations: defaultOperationsFor(
            'http_request_duration_seconds_bucket',
          ),
        }),
      ),
    ).toBe(
      'histogram_quantile(0.95, sum by (le)(rate(http_request_duration_seconds_bucket[$__rate_interval])))',
    );
  });
});
