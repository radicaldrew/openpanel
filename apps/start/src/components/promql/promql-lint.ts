import type { LintStrategy } from '@prometheus-io/codemirror-promql';
import { parser } from '@prometheus-io/lezer-promql';

import { hasVariables, maskPromqlVariables } from './promql-variables';

/**
 * The linter the PromQL editor runs, and the one case where it cannot be the
 * upstream one.
 */

/**
 * The diagnostic types, derived from the strategy interface rather than
 * imported from `@codemirror/lint`.
 *
 * That package is a peer of codemirror-promql and reaches this app only through
 * `codemirror`'s `basicSetup`; it is not a declared dependency, and the plan
 * allows exactly two new ones. Deriving the types costs nothing and keeps
 * package.json honest about what this file imports.
 */
type LintFn = ReturnType<LintStrategy['promQL']>;
type Diagnostics = Awaited<ReturnType<LintFn>>;
export type PromqlDiagnostic = Diagnostics[number];

/**
 * Syntax errors from the grammar, for a document the upstream linter cannot be
 * asked about.
 *
 * Deliberately only the parse errors: this runs on a MASKED document (see
 * below), and reporting the upstream linter's type errors against text that has
 * had `$__rate_interval` swapped for a made-up duration would be reporting on a
 * query nobody wrote.
 */
export function syntaxDiagnostics(masked: string): PromqlDiagnostic[] {
  const tree = parser.parse(masked);
  const diagnostics: PromqlDiagnostic[] = [];

  tree.iterate({
    enter(node) {
      if (!node.type.isError) {
        return;
      }

      // An error node flush against the end of the document is almost always a
      // half-typed expression rather than a mistake. Underlining it means the
      // box is red for most of the time the user spends in it, which trains
      // people to ignore the underline — the same call the upstream linter
      // makes.
      if (node.to >= masked.length) {
        return;
      }

      diagnostics.push({
        severity: 'error',
        message: 'Unexpected expression',
        from: node.from,
        to: Math.max(node.to, node.from + 1),
      });
    },
  });

  return diagnostics;
}

/**
 * The upstream linter, except on a query that carries dashboard variables.
 *
 * `$__rate_interval` is not PromQL, so the grammar produces an error node at
 * the `$` and loses the rest of the expression — and `defaultOperationsFor`
 * seeds exactly that the moment a counter is picked. Left alone, the linter
 * would underline the builder's own default query in red, which is worse than
 * useless: an editor that cries wolf on its own output teaches the user that
 * the underline means nothing.
 *
 * So a document with no variables in it — every hand-written query, which is
 * where linting earns its keep — gets the upstream linter untouched, type
 * checking and all. A document WITH variables gets parse errors reported
 * against the masked text instead, which is accurate about syntax and silent
 * about types. Accuracy about the common half beats a plausible answer about
 * both.
 */
export function variableTolerantLinter(base: LintStrategy): LintStrategy {
  return {
    promQL(): LintFn {
      const baseLint = base.promQL();

      return (view) => {
        const doc = view.state.doc.toString();

        if (!hasVariables(doc)) {
          return baseLint(view);
        }

        // Masking is length-preserving, so these offsets index the real
        // document. See promql-variables.ts.
        return syntaxDiagnostics(maskPromqlVariables(doc));
      };
    },
  };
}
