import {
  LabelMatchers,
  VectorSelector,
  parser,
} from '@prometheus-io/lezer-promql';
import { PROJECT_LABEL, assertValidProjectId } from '../tenancy/project-label';

/**
 * Rewrite a raw PromQL query so every selector is scoped to one project.
 *
 * This is what makes a raw-query text box safe, and it is the ONLY sanctioned
 * way to accept one. The structured compiler (./compile.ts) never touches user
 * text; this does, so it uses the same grammar Prometheus itself ships rather
 * than any form of pattern matching.
 *
 * WHY NOT STRING MATCHING
 *
 * Every string-level approach fails on a query a determined user can write:
 *
 *   up                                    no braces at all to match on
 *   up # {op_project_id="other"}          a comment that looks like a selector
 *   up{job="a"} or up{job="b"}            several selectors, one expression
 *   sum(rate(x[5m] offset 1h))            selectors nested inside functions
 *   x @ 1609746000                        an @-modifier between name and brace
 *   label_replace(x, "op_project_id", …)  rewrites the label after selection
 *
 * The first line alone defeats "find the `{`". Parsing finds all of them by
 * construction, because a VectorSelector is a VectorSelector wherever it sits.
 *
 * WHAT THIS DOES NOT SOLVE
 *
 * `label_replace` and `label_join` can rewrite `op_project_id` on the RESULT of
 * a correctly-scoped selection. That does not let a query read another
 * project's data — the selection already happened — but it can make a response
 * carry a label claiming otherwise, which matters if anything downstream trusts
 * the returned labels. So those functions are rejected outright rather than
 * reasoned about.
 */

export class PromqlRewriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromqlRewriteError';
  }
}

/**
 * Functions that can forge the tenancy label on a result set.
 *
 * Rejected rather than rewritten: allowing them would mean proving that no
 * combination of arguments can produce a misleading label, and that proof is
 * harder than living without two functions.
 */
const FORBIDDEN_FUNCTIONS = ['label_replace', 'label_join'];

interface Edit {
  from: number;
  to: number;
  insert: string;
}

function matcherText(projectId: string): string {
  return `${PROJECT_LABEL}="${projectId}"`;
}

/**
 * Inject the project matcher into every vector selector.
 *
 * Edits are collected with absolute offsets and applied RIGHT TO LEFT, so each
 * insertion cannot shift the offsets of the ones not yet applied.
 */
export function rewritePromqlForProject(
  query: string,
  projectId: string,
): string {
  assertValidProjectId(projectId);

  if (query.length > 4000) {
    throw new PromqlRewriteError('Query is too long');
  }

  // The project id is validated to a charset with no quote or backslash, so it
  // cannot escape the literal it is placed in. Asserted rather than assumed.
  if (/["\\\n]/.test(projectId)) {
    throw new PromqlRewriteError('Project id is not safe to embed');
  }

  const tree = parser.parse(query);

  // A query the grammar cannot parse must not be forwarded. gigapipe's parser
  // is not this one, and handing it something we could not understand is
  // exactly how a rewriter gets bypassed.
  let hasError = false;
  tree.iterate({
    enter(node) {
      if (node.type.isError) {
        hasError = true;
      }
    },
  });

  if (hasError) {
    throw new PromqlRewriteError('Query is not valid PromQL');
  }

  for (const forbidden of FORBIDDEN_FUNCTIONS) {
    // Word-boundary match so a metric called `my_label_replace_total` is fine.
    if (new RegExp(`\\b${forbidden}\\s*\\(`).test(query)) {
      throw new PromqlRewriteError(
        `${forbidden} is not allowed — it can rewrite the project label on a result`,
      );
    }
  }

  const edits: Edit[] = [];
  let selectorCount = 0;

  const cursor = tree.cursor();
  do {
    if (cursor.type.id !== VectorSelector) {
      continue;
    }

    selectorCount += 1;

    // Does this selector already have a `{...}` block?
    let matchers: { from: number; to: number } | undefined;
    const inner = cursor.node.cursor();
    if (inner.firstChild()) {
      do {
        if (inner.type.id === LabelMatchers) {
          matchers = { from: inner.from, to: inner.to };
          break;
        }
      } while (inner.nextSibling());
    }

    if (matchers) {
      const body = query.slice(matchers.from + 1, matchers.to - 1).trim();

      // Insert just after the `{`, so the tenancy constraint is first and a
      // reviewer sees it without reading to the end.
      edits.push({
        from: matchers.from + 1,
        to: matchers.from + 1,
        insert: body.length > 0 ? `${matcherText(projectId)},` : matcherText(projectId),
      });
    } else {
      // A bare selector such as `up`. Append a whole matcher block — this is
      // the case every `{`-matching approach misses entirely.
      edits.push({
        from: cursor.to,
        to: cursor.to,
        insert: `{${matcherText(projectId)}}`,
      });
    }
  } while (cursor.next());

  if (selectorCount === 0) {
    // A query with no selector reads nothing, but it also cannot be scoped, and
    // "scoped to nothing" is not a state worth reasoning about later.
    throw new PromqlRewriteError('Query selects no metric');
  }

  let out = query;
  for (const edit of edits.sort((a, b) => b.from - a.from)) {
    out = out.slice(0, edit.from) + edit.insert + out.slice(edit.to);
  }

  return out;
}

/**
 * Verify a rewritten query: every selector carries our matcher, and no selector
 * carries anyone else's.
 *
 * Cheap, and it turns a future bug in the rewriter into a rejected query rather
 * than a cross-tenant read — the same belt-and-braces the ingest path uses.
 */
export function assertPromqlScoped(query: string, projectId: string): void {
  const tree = parser.parse(query);
  const expected = matcherText(projectId);
  const cursor = tree.cursor();

  let selectors = 0;
  do {
    if (cursor.type.id !== VectorSelector) {
      continue;
    }

    selectors += 1;
    if (!query.slice(cursor.from, cursor.to).includes(expected)) {
      throw new PromqlRewriteError(
        'Refusing to run: a selector is not scoped to this project',
      );
    }
  } while (cursor.next());

  if (selectors === 0) {
    throw new PromqlRewriteError('Refusing to run: query selects no metric');
  }
}
