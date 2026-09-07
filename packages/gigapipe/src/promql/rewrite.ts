import {
  AggregateExpr,
  AggregateModifier,
  AggregateOp,
  CountValues,
  EqlSingle,
  GroupingLabels,
  LabelJoin,
  LabelMatchers,
  LabelName,
  MatchOp,
  LabelReplace,
  StringLiteral,
  UnquotedLabelMatcher,
  VectorSelector,
  Without,
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
 * a correctly-scoped selection, and `count_values` can invent it outright. That
 * does not let a query read another project's data — the selection already
 * happened — but it can make a response carry a label claiming otherwise, which
 * matters if anything downstream trusts the returned labels. So those functions
 * are rejected outright rather than reasoned about.
 *
 * WHAT THIS ALSO DOES: AGGREGATION
 *
 * Scoping the selectors is not enough on its own, because an aggregation
 * DISCARDS the label that proves the scoping happened. `sum by (method) (x)`
 * returns series carrying only `method`, and `adaptMatrixToConcreteSeries`
 * refuses a series with no `op_project_id` — so a correctly-scoped raw query
 * would be rejected at the response check.
 *
 * The fix is the same one the structured compiler makes (`renderGrouping` in
 * ./compile.ts): every `by (…)` gains `op_project_id`, and an aggregation with
 * no modifier at all gains `by (op_project_id)`. Both are semantically free —
 * the selector already constrains the result to one project, so grouping by
 * that label groups by a constant — and they keep the response-side check
 * meaningful instead of vacuous.
 *
 * `without (… op_project_id …)` is the one case that cannot be repaired: it
 * asks for the label to be removed. Rejected with a message that says so,
 * rather than left to fail later as "a series with no project label".
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
 * harder than living without three functions.
 *
 * MATCHED BY GRAMMAR NODE, NOT BY TEXT. This was a word-boundary regex over the
 * raw query — `\blabel_replace\s*\(` — and `\s*` does not span a COMMENT, so
 * every one of them was reachable:
 *
 *   label_replace # x
 *   (up, "op_project_id", "other-tenant", "", "")
 *
 * That parses, so the post-rewrite re-parse did not catch it either, and the
 * query was scoped and forwarded. It cannot read another project's data — the
 * selector is still scoped — but it can make a response CARRY a foreign
 * project label, which is the whole reason these three are refused. The panel
 * path drops such a response at `assertOwnedBy`; `observability.rawQuery`
 * returns the backend response unchecked, so there it would reach the caller.
 *
 * The grammar gives each of these its own node type, so matching on the node
 * makes the comment — and any other whitespace trick — irrelevant.
 */
const FORBIDDEN_NODES: Record<number, { name: string; reason: string }> = {
  [LabelReplace]: {
    name: 'label_replace',
    reason: 'it can rewrite the project label on a result',
  },
  [LabelJoin]: {
    name: 'label_join',
    reason: 'it can rewrite the project label on a result',
  },
  [CountValues]: {
    name: 'count_values',
    reason: 'it can create a project label from a sample value',
  },
};

interface Edit {
  from: number;
  to: number;
  insert: string;
}

/** `op_project_id` as a whole word, wherever a grouping list mentions it. */
const PROJECT_LABEL_WORD_RE = new RegExp(`\\b${PROJECT_LABEL}\\b`);

/**
 * The `by (...)` / `without (...)` attached to one aggregation.
 *
 * The modifier is optional and may sit on EITHER side of the argument list —
 * `sum by (le) (x)` and `sum (x) by (le)` are the same query — so it is found
 * by walking the aggregation's direct children rather than by position.
 */
interface AggregateModifierNode {
  /** True for `without`, false for `by`. */
  isWithout: boolean;
  /** Source span of the `(...)` list, parentheses included. */
  labels: { from: number; to: number };
}

function readAggregate(
  node: { cursor: () => TreeCursorLike },
): { opEnd: number; modifier?: AggregateModifierNode } | undefined {
  const child = node.cursor();

  if (!child.firstChild()) {
    return undefined;
  }

  let opEnd: number | undefined;
  let modifier: AggregateModifierNode | undefined;

  do {
    if (child.type.id === AggregateOp) {
      opEnd = child.to;
      continue;
    }

    if (child.type.id !== AggregateModifier) {
      continue;
    }

    let isWithout = false;
    let labels: { from: number; to: number } | undefined;

    const inner = child.node.cursor();
    if (inner.firstChild()) {
      do {
        if (inner.type.id === Without) {
          isWithout = true;
        }
        if (inner.type.id === GroupingLabels) {
          labels = { from: inner.from, to: inner.to };
        }
      } while (inner.nextSibling());
    }

    if (labels) {
      modifier = { isWithout, labels };
    }
  } while (child.nextSibling());

  return opEnd === undefined ? undefined : { opEnd, modifier };
}

/**
 * The subset of lezer's TreeCursor this file uses.
 *
 * Written out rather than imported: `@lezer/common` is a transitive dependency
 * of the grammar, not a direct one, and naming it here would make the tenancy
 * gate depend on a package nothing declares.
 */
interface TreeCursorLike {
  readonly type: { id: number; isError: boolean };
  readonly from: number;
  readonly to: number;
  readonly node: { cursor: () => TreeCursorLike };
  firstChild: () => boolean;
  nextSibling: () => boolean;
  next: () => boolean;
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

  const edits: Edit[] = [];
  let selectorCount = 0;

  const cursor = tree.cursor();
  do {
    const forbidden = FORBIDDEN_NODES[cursor.type.id];

    if (forbidden) {
      throw new PromqlRewriteError(
        `${forbidden.name} is not allowed — ${forbidden.reason}`,
      );
    }

    if (cursor.type.id === AggregateExpr) {
      const aggregate = readAggregate(cursor.node as never);

      if (!aggregate) {
        continue;
      }

      if (!aggregate.modifier) {
        // A bare `sum(x)` collapses every label, including the one that proves
        // the scoping. Give it the grouping the structured compiler always
        // emits.
        edits.push({
          from: aggregate.opEnd,
          to: aggregate.opEnd,
          insert: ` by (${PROJECT_LABEL})`,
        });
        continue;
      }

      const { isWithout, labels } = aggregate.modifier;
      const body = query.slice(labels.from + 1, labels.to - 1).trim();
      const mentionsProject = PROJECT_LABEL_WORD_RE.test(body);

      if (isWithout) {
        if (mentionsProject) {
          throw new PromqlRewriteError(
            `without (${PROJECT_LABEL}) is not allowed — it removes the label that proves this query is scoped to your project`,
          );
        }

        // Every other `without` keeps the label by definition.
        continue;
      }

      if (!mentionsProject) {
        edits.push({
          from: labels.to - 1,
          to: labels.to - 1,
          insert: body.length > 0 ? `, ${PROJECT_LABEL}` : PROJECT_LABEL,
        });
      }

      continue;
    }

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

  // Re-parse what we produced. Every edit above is an insertion into a position
  // the grammar chose, so this should never fire — which is exactly why it is
  // worth asserting: a rewriter that emits invalid PromQL would otherwise hand
  // gigapipe a string neither parser agrees on, and that gap is how a rewriter
  // gets bypassed.
  const rewrittenTree = parser.parse(out);
  let rewriteBroke = false;
  rewrittenTree.iterate({
    enter(node) {
      if (node.type.isError) {
        rewriteBroke = true;
      }
    },
  });

  if (rewriteBroke) {
    throw new PromqlRewriteError(
      'Refusing to run: scoping this query did not produce valid PromQL',
    );
  }

  return out;
}

/**
 * Does this selector carry a real `op_project_id="<project>"` equality matcher?
 *
 * Read from the MATCHER NODES, not from the selector's source text. The text
 * form — `slice(from, to).includes('op_project_id="p"')` — is satisfied by a
 * selector that merely CONTAINS those characters, and PromQL has two string
 * forms where a bare `"` is legal:
 *
 *   up{job='op_project_id="victim-proj"'}
 *   up{job=`op_project_id="victim-proj"`}
 *
 * Both passed the substring check while carrying no tenancy matcher at all.
 * Not reachable in practice — the rewriter inserts the real matcher before this
 * runs — but this check exists precisely to catch a rewriter that did not, so
 * it has to be strong exactly where a text match is weak.
 */
function selectorCarriesProject(
  query: string,
  node: { cursor: () => TreeCursorLike },
  projectId: string,
): boolean {
  const child = node.cursor();

  if (!child.firstChild()) {
    return false;
  }

  do {
    if (child.type.id !== LabelMatchers) {
      continue;
    }

    const matcher = child.node.cursor();

    if (!matcher.firstChild()) {
      continue;
    }

    do {
      if (matcher.type.id !== UnquotedLabelMatcher) {
        continue;
      }

      let name: string | undefined;
      let value: string | undefined;
      let isEquality = false;

      const part = matcher.node.cursor();

      if (!part.firstChild()) {
        continue;
      }

      do {
        if (part.type.id === LabelName) {
          name = query.slice(part.from, part.to);
        }
        if (part.type.id === MatchOp) {
          // `=` only. `!=`, `=~` and `!~` do not pin the selection to one
          // project, and treating them as scoping would be the exact
          // fail-open this function exists to prevent.
          const op = part.node.cursor();
          if (op.firstChild()) {
            do {
              if (op.type.id === EqlSingle) {
                isEquality = true;
              }
            } while (op.nextSibling());
          }
        }
        if (part.type.id === StringLiteral) {
          value = query.slice(part.from, part.to);
        }
      } while (part.nextSibling());

      if (
        isEquality &&
        name === PROJECT_LABEL &&
        // The literal INCLUDING its quotes, compared against the same form the
        // rewriter emits, so an escaped or differently-quoted spelling of the
        // id is not accepted as equivalent.
        value === `"${projectId}"`
      ) {
        return true;
      }
    } while (matcher.nextSibling());
  } while (child.nextSibling());

  return false;
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
  const cursor = tree.cursor();

  let selectors = 0;
  do {
    // An aggregation that does not carry the label forward makes the
    // response-side ownership check vacuous: it would find no project label to
    // verify because the aggregation removed it. Checked here as well as
    // rewritten above, so a bug in the rewriter is a rejected query rather than
    // a chart nobody can prove the provenance of.
    if (cursor.type.id === AggregateExpr) {
      const aggregate = readAggregate(cursor.node as never);

      if (!aggregate) {
        continue;
      }

      if (!aggregate.modifier) {
        throw new PromqlRewriteError(
          'Refusing to run: an aggregation would discard the project label',
        );
      }

      const { isWithout, labels } = aggregate.modifier;
      const body = query.slice(labels.from + 1, labels.to - 1);
      const mentionsProject = PROJECT_LABEL_WORD_RE.test(body);

      if (isWithout === mentionsProject) {
        throw new PromqlRewriteError(
          isWithout
            ? 'Refusing to run: an aggregation would remove the project label'
            : 'Refusing to run: an aggregation would discard the project label',
        );
      }

      continue;
    }

    if (cursor.type.id !== VectorSelector) {
      continue;
    }

    selectors += 1;

    if (!selectorCarriesProject(query, cursor.node as never, projectId)) {
      throw new PromqlRewriteError(
        'Refusing to run: a selector is not scoped to this project',
      );
    }
  } while (cursor.next());

  if (selectors === 0) {
    throw new PromqlRewriteError('Refusing to run: query selects no metric');
  }
}
