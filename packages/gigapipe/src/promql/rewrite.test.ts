import { describe, expect, it } from 'vitest';
import { InvalidProjectIdError, PROJECT_LABEL } from '../tenancy/project-label';
import {
  PromqlRewriteError,
  assertPromqlScoped,
  rewritePromqlForProject,
} from './rewrite';

const P = 'proj_123';
const rw = (q: string) => rewritePromqlForProject(q, P);
const M = `${PROJECT_LABEL}="proj_123"`;

/**
 * The adversarial suite for raw PromQL. Each case here is a way a string-level
 * rewriter gets bypassed; all of them must come back scoped or rejected.
 */

describe('every selector gets scoped', () => {
  it('a selector that already has matchers', () => {
    expect(rw('http_requests_total{job="api"}')).toBe(
      `http_requests_total{${M},job="api"}`,
    );
  });

  it('a BARE selector with no braces — the case "find the {" misses entirely', () => {
    expect(rw('up')).toBe(`up{${M}}`);
  });

  it('an empty matcher block', () => {
    expect(rw('up{}')).toBe(`up{${M}}`);
  });

  it('EVERY selector in a binary operation, not just the first', () => {
    const out = rw('up{job="a"} / up{job="b"}');
    expect(out).toBe(`up{${M},job="a"} / up{${M},job="b"}`);
    expect(out.match(new RegExp(M.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(2);
  });

  it('a mix of bare and braced selectors', () => {
    expect(rw('up + http_requests_total{job="a"}')).toBe(
      `up{${M}} + http_requests_total{${M},job="a"}`,
    );
  });

  it('selectors nested inside functions and aggregations', () => {
    // The grouping list gains the tenancy label too — see the aggregation suite
    // below for why an aggregation that drops it cannot be rendered.
    expect(rw('sum by (route) (rate(http_requests_total{job="api"}[5m]))')).toBe(
      `sum by (route, ${PROJECT_LABEL}) (rate(http_requests_total{${M},job="api"}[5m]))`,
    );
  });

  it('a selector with an offset modifier', () => {
    expect(rw('sum(rate(x[5m] offset 1h))')).toContain(`x{${M}}`);
  });

  it('a selector inside a subquery', () => {
    expect(rw('max_over_time(rate(x[5m])[30m:1m])')).toContain(`x{${M}}`);
  });

  it('a query with a comment that looks like a selector', () => {
    // A comment cannot introduce a matcher, and must not confuse the rewriter
    // into thinking one is already present.
    const out = rw('up # {op_project_id="other-project"}');
    expect(out).toContain(`up{${M}}`);
  });
});

describe('rejections', () => {
  it('rejects a query the grammar cannot parse', () => {
    // Never forward something we could not understand: gigapipe's parser is not
    // this one, and that gap is exactly how a rewriter gets bypassed.
    for (const q of ['up{', 'sum by (', 'rate(x[5m]', '}{']) {
      expect(() => rw(q), q).toThrow(PromqlRewriteError);
    }
  });

  it('rejects label_replace, which can forge the label on a RESULT', () => {
    expect(() =>
      rw('label_replace(up, "op_project_id", "other", "", "")'),
    ).toThrow(/label_replace is not allowed/);
  });

  it('rejects label_join for the same reason', () => {
    expect(() => rw('label_join(up, "op_project_id", "", "job")')).toThrow(
      /label_join is not allowed/,
    );
  });

  it('allows a metric whose NAME merely contains a forbidden word', () => {
    expect(() => rw('my_label_replace_total')).not.toThrow();
  });

  it('rejects a query with no selector at all', () => {
    expect(() => rw('1 + 1')).toThrow(/selects no metric/);
  });

  it('rejects an over-long query', () => {
    expect(() => rw(`up{job="${'a'.repeat(4100)}"}`)).toThrow(/too long/);
  });

  it('rejects an invalid project id rather than emitting an unscoped query', () => {
    expect(() => rewritePromqlForProject('up', 'has space')).toThrow(
      InvalidProjectIdError,
    );
  });
});

describe('assertPromqlScoped', () => {
  it('passes a correctly rewritten query', () => {
    expect(() => assertPromqlScoped(rw('up{job="a"} / up'), P)).not.toThrow();
  });

  it('catches a selector that was never scoped', () => {
    // Simulates the rewriter having missed one — this assertion is what turns a
    // future bug into a rejected query rather than a cross-tenant read.
    expect(() => assertPromqlScoped(`up{${M}} / up{job="b"}`, P)).toThrow(
      PromqlRewriteError,
    );
  });

  it('catches a query scoped to a DIFFERENT project', () => {
    expect(() =>
      assertPromqlScoped(`up{${PROJECT_LABEL}="someone-else"}`, P),
    ).toThrow(PromqlRewriteError);
  });
});

/**
 * Scoping the selectors is only half of it. An aggregation discards every label
 * it does not group by, including the one the response-side ownership check
 * reads — so a query that is perfectly scoped on the way out can come back
 * unprovable. Each case here is an aggregation shape that would otherwise
 * arrive at `adaptMatrixToConcreteSeries` with no project label.
 */
describe('every aggregation keeps the project label', () => {
  const cases: [string, string, string][] = [
    [
      'a bare aggregation, which groups by nothing at all',
      'sum(rate(x[5m]))',
      `sum by (${PROJECT_LABEL})(rate(x{${M}}[5m]))`,
    ],
    [
      'sum by, the ordinary case',
      'sum by (method) (x)',
      `sum by (method, ${PROJECT_LABEL}) (x{${M}})`,
    ],
    [
      'an empty grouping list, which is a bare aggregation written out',
      'sum by () (x)',
      `sum by (${PROJECT_LABEL}) (x{${M}})`,
    ],
    [
      'a modifier written AFTER the argument list',
      'sum (x) by (method)',
      `sum (x{${M}}) by (method, ${PROJECT_LABEL})`,
    ],
    [
      'sum without, which keeps every other label by definition',
      'sum without (instance) (x)',
      `sum without (instance) (x{${M}})`,
    ],
    [
      'nested aggregations, each one separately',
      'max(sum by (method) (rate(x[5m])))',
      `max by (${PROJECT_LABEL})(sum by (method, ${PROJECT_LABEL}) (rate(x{${M}}[5m])))`,
    ],
    [
      'the p95 shape, where the quantile carries the label out through le',
      'histogram_quantile(0.95, sum by (le) (rate(x_bucket[5m])))',
      `histogram_quantile(0.95, sum by (le, ${PROJECT_LABEL}) (rate(x_bucket{${M}}[5m])))`,
    ],
    [
      'topk, which takes a parameter before the vector',
      'topk(5, sum by (route) (rate(x[5m])))',
      `topk by (${PROJECT_LABEL})(5, sum by (route, ${PROJECT_LABEL}) (rate(x{${M}}[5m])))`,
    ],
    [
      'both sides of a binary operation',
      'sum(a) / sum(b)',
      `sum by (${PROJECT_LABEL})(a{${M}}) / sum by (${PROJECT_LABEL})(b{${M}})`,
    ],
    [
      'an aggregation over a subquery',
      'max_over_time(sum by (method) (rate(x[5m]))[30m:1m])',
      `max_over_time(sum by (method, ${PROJECT_LABEL}) (rate(x{${M}}[5m]))[30m:1m])`,
    ],
    [
      'an aggregation the user already grouped by the project label',
      `sum by (${PROJECT_LABEL}) (x)`,
      `sum by (${PROJECT_LABEL}) (x{${M}})`,
    ],
    [
      'a case-insensitive aggregation, which PromQL accepts',
      'SUM BY (method) (x)',
      `SUM BY (method, ${PROJECT_LABEL}) (x{${M}})`,
    ],
    [
      'avg, min, max, count — every aggregator, not just sum',
      'avg(min(max(count(x))))',
      `avg by (${PROJECT_LABEL})(min by (${PROJECT_LABEL})(max by (${PROJECT_LABEL})(count by (${PROJECT_LABEL})(x{${M}}))))`,
    ],
  ];

  for (const [name, input, expected] of cases) {
    it(name, () => {
      expect(rw(input)).toBe(expected);
    });
  }

  it('every rewritten query still parses, and passes its own scope check', () => {
    for (const [, input] of cases) {
      const out = rw(input);
      expect(() => assertPromqlScoped(out, P), input).not.toThrow();
      // No grouping list gains the label twice. (The selector matcher is a
      // different matter: the rewriter only ever sees user input, never its own
      // output, and a repeated `=` matcher on the same value is harmless.)
      for (const grouping of out.match(/\((?:[a-zA-Z_][a-zA-Z0-9_]*\s*,?\s*)*\)/g) ?? []) {
        expect(
          grouping.split(PROJECT_LABEL).length - 1,
          `${input} → ${grouping}`,
        ).toBeLessThanOrEqual(1);
      }
    }
  });

  it('rejects without (op_project_id) — the one case that cannot be repaired', () => {
    expect(() => rw(`sum without (${PROJECT_LABEL}) (x)`)).toThrow(
      /removes the label that proves this query is scoped/,
    );
  });

  it('rejects it however it is written', () => {
    for (const q of [
      `sum without (instance, ${PROJECT_LABEL}) (x)`,
      `SUM WITHOUT (${PROJECT_LABEL}) (x)`,
      `sum (x) without (${PROJECT_LABEL})`,
      `max(sum without (${PROJECT_LABEL}) (x))`,
    ]) {
      expect(() => rw(q), q).toThrow(PromqlRewriteError);
    }
  });

  it('rejects count_values, which can invent the label from a sample value', () => {
    expect(() => rw(`count_values("${PROJECT_LABEL}", x)`)).toThrow(
      /count_values is not allowed/,
    );
  });
});

describe('assertPromqlScoped reads the aggregations too', () => {
  it('catches an aggregation that would discard the label', () => {
    // Simulates the rewriter having missed one. Without this the query runs,
    // comes back with no project label, and is rejected only at the adapter —
    // by which point it has already cost a gigapipe query.
    expect(() => assertPromqlScoped(`sum(up{${M}})`, P)).toThrow(
      /discard the project label/,
    );
  });

  it('catches a grouping list that names other labels but not ours', () => {
    expect(() => assertPromqlScoped(`sum by (method) (up{${M}})`, P)).toThrow(
      /discard the project label/,
    );
  });

  it('catches a without that names the label', () => {
    expect(() =>
      assertPromqlScoped(`sum without (${PROJECT_LABEL}) (up{${M}})`, P),
    ).toThrow(/remove the project label/);
  });

  it('passes a without that names something else', () => {
    expect(() =>
      assertPromqlScoped(`sum without (instance) (up{${M}})`, P),
    ).not.toThrow();
  });
});

/**
 * Found by review, reproduced before it was fixed.
 *
 * Both of these were live: the first forwarded a forbidden function to
 * gigapipe, the second accepted a selector that carried no tenancy matcher.
 * Neither could read another project's data — the selector is scoped either
 * way — but both defeat a check whose whole job is to stop a response CARRYING
 * a project label it did not earn.
 */
describe('forbidden functions cannot be hidden behind a comment', () => {
  const evasions: [string, string][] = [
    ['label_replace', 'label_replace # x\n(up, "op_project_id", "other", "", "")'],
    ['label_join', 'label_join # x\n(up, "op_project_id", "", "job")'],
    ['count_values', 'count_values # x\n("op_project_id", up)'],
    ['a CRLF comment', 'label_replace #c\r\n(up, "op_project_id", "o", "", "")'],
    ['a comment on its own line', 'label_replace\n# note\n(up, "op_project_id", "o", "", "")'],
    ['several comments', 'label_replace # a\n # b\n(up, "op_project_id", "o", "", "")'],
    ['a comment then more whitespace', 'label_replace # c\n   (up, "op_project_id", "o", "", "")'],
    // Not comments, but the same class: anything between the name and the
    // paren that a `\s*` regex might or might not span.
    ['a non-breaking space', 'label_replace\u00a0(up, "op_project_id", "o", "", "")'],
    ['a unicode line separator', 'label_replace\u2028(up, "op_project_id", "o", "", "")'],
  ];

  for (const [name, query] of evasions) {
    it(`rejects ${name}`, () => {
      // `\s*` in a word-boundary regex does not span a comment, and the result
      // parses — so neither the text match nor the post-rewrite re-parse saw
      // these. Matching the grammar node makes the whitespace irrelevant.
      expect(() => rw(query)).toThrow(PromqlRewriteError);
    });
  }

  it('still allows a metric whose NAME contains a forbidden word', () => {
    expect(() => rw('my_label_replace_total')).not.toThrow();
    expect(() => rw('count_values_total')).not.toThrow();
  });

  it('refuses the shapes the grammar cannot read, rather than guessing', () => {
    // A C-style comment is not PromQL and a name split across a newline is not
    // one token. Both are rejected as unparseable — which is the right answer
    // and, unlike the text regex, does not depend on the rejection list.
    for (const query of [
      'label_replace/**/(up, "op_project_id", "o", "", "")',
      'label_\nreplace(up, "op_project_id", "o", "", "")',
    ]) {
      expect(() => rw(query), query).toThrow(/not valid PromQL/);
    }
  });
});

describe('assertPromqlScoped reads matchers, not text', () => {
  it('rejects a selector that merely CONTAINS the matcher text', () => {
    // PromQL has two string forms where a bare `"` is legal, so a value can
    // spell out the tenancy matcher without being one. The substring check
    // this replaced accepted both.
    for (const query of [
      `up{job='${PROJECT_LABEL}="proj_123"'}`,
      `up{job=\`${PROJECT_LABEL}="proj_123"\`}`,
    ]) {
      expect(() => assertPromqlScoped(query, P), query).toThrow(
        PromqlRewriteError,
      );
    }
  });

  it('rejects a non-equality matcher on the tenancy label', () => {
    // `!=` and `=~` do not pin the selection to one project; accepting them as
    // scoping would be exactly the fail-open this check exists to prevent.
    for (const op of ['!=', '=~', '!~']) {
      expect(() =>
        assertPromqlScoped(`up{${PROJECT_LABEL}${op}"proj_123"}`, P),
        op,
      ).toThrow(PromqlRewriteError);
    }
  });

  it('still accepts everything the rewriter actually produces', () => {
    for (const query of [
      'up',
      'sum by (le) (rate(x[5m]))',
      'a / b',
      'sum without (instance) (up)',
      'topk(5, up)',
      'histogram_quantile(0.95, sum by (le) (rate(x_bucket[5m])))',
    ]) {
      const out = rw(query);
      expect(() => assertPromqlScoped(out, P), query).not.toThrow();
    }
  });
});
