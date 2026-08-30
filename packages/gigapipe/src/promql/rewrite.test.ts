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
    expect(rw('sum by (route) (rate(http_requests_total{job="api"}[5m]))')).toBe(
      `sum by (route) (rate(http_requests_total{${M},job="api"}[5m]))`,
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
