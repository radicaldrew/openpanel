/**
 * The linter, and specifically the case it exists for: a query carrying
 * `$__rate_interval` must not be underlined in red, because that is the query
 * the builder writes the moment a counter is picked.
 *
 * The upstream strategy is stubbed rather than exercised — it needs a real
 * EditorState with the PromQL language attached, which is the editor's job, not
 * this module's. What is asserted here is the routing: variables present means
 * our masked syntax check, variables absent means upstream, untouched.
 *
 * Run with: cd apps/start && NITRO=1 npx vitest run src/components/promql
 */
import type { LintStrategy } from '@prometheus-io/codemirror-promql';
import type { EditorView } from '@codemirror/view';
import { describe, expect, it, vi } from 'vitest';

import {
  type PromqlDiagnostic,
  syntaxDiagnostics,
  variableTolerantLinter,
} from './promql-lint';
import { maskPromqlVariables } from './promql-variables';

/** Only `state.doc` is read, which is all the strategy interface promises. */
function viewOf(doc: string): EditorView {
  return {
    state: { doc: { toString: () => doc } },
  } as unknown as EditorView;
}

describe('syntaxDiagnostics', () => {
  it('says nothing about a valid query', () => {
    expect(syntaxDiagnostics('sum by (le)(rate(x_total[5m]))')).toEqual([]);
  });

  it('says nothing about a masked variable', () => {
    expect(
      syntaxDiagnostics(
        maskPromqlVariables('rate(http_requests_total[$__rate_interval])'),
      ),
    ).toEqual([]);
  });

  it('flags a syntax error inside the expression', () => {
    const diagnostics = syntaxDiagnostics('sum(rate(x_total[5m])) foo bar');

    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]?.severity).toBe('error');
  });

  it('leaves a half-typed tail alone', () => {
    // Everything typed so far is fine and the user is mid-expression; a red
    // underline here would be on screen for most of the time the box is used.
    expect(syntaxDiagnostics('sum(rate(')).toEqual([]);
  });

  it('reports positions into the unmasked document', () => {
    const expr = 'rate(x[$__rate_interval]) foo bar';
    const diagnostics = syntaxDiagnostics(maskPromqlVariables(expr));

    for (const diagnostic of diagnostics) {
      expect(diagnostic.from).toBeLessThanOrEqual(expr.length);
      expect(diagnostic.to).toBeLessThanOrEqual(expr.length);
    }

    // The error is past the variable, not at it.
    expect(diagnostics[0]?.from).toBeGreaterThanOrEqual(expr.indexOf('foo'));
  });
});

describe('variableTolerantLinter', () => {
  const upstreamDiagnostic: PromqlDiagnostic = {
    severity: 'error',
    message: 'from upstream',
    from: 0,
    to: 1,
  };

  function stubStrategy(lint: () => PromqlDiagnostic[]): {
    strategy: LintStrategy;
    calls: () => number;
  } {
    const inner = vi.fn(lint);
    return {
      strategy: { promQL: () => inner },
      calls: () => inner.mock.calls.length,
    };
  }

  it('delegates to the upstream linter when there are no variables', async () => {
    const { strategy, calls } = stubStrategy(() => [upstreamDiagnostic]);
    const lint = variableTolerantLinter(strategy).promQL();

    // Awaited rather than `.resolves`: the strategy may answer synchronously
    // or with a promise, and both are legal.
    expect(await lint(viewOf('sum(rate(x_total[5m]))'))).toEqual([
      upstreamDiagnostic,
    ]);
    expect(calls()).toBe(1);
  });

  it('never calls upstream on a query with a variable in it', async () => {
    const { strategy, calls } = stubStrategy(() => [upstreamDiagnostic]);
    const lint = variableTolerantLinter(strategy).promQL();

    // The whole point: upstream cannot parse this, and would report the
    // builder's own default query as broken.
    expect(
      await lint(viewOf('rate(http_requests_total[$__rate_interval])')),
    ).toEqual([]);
    expect(calls()).toBe(0);
  });

  it('still reports a real syntax error alongside a variable', async () => {
    const { strategy } = stubStrategy(() => []);
    const lint = variableTolerantLinter(strategy).promQL();
    const diagnostics = await lint(
      viewOf('rate(x[$__rate_interval]) foo bar'),
    );

    expect(diagnostics.length).toBeGreaterThan(0);
  });
});
