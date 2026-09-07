import {
  Add,
  AggregateExpr,
  AggregateModifier,
  By,
  Div,
  DurationExpr,
  FunctionCall,
  FunctionCallBody,
  FunctionIdentifier,
  GroupingLabels,
  Identifier,
  LabelMatchers,
  LabelName,
  MatchOp,
  MatrixSelector,
  Mul,
  NumberDurationLiteral,
  ParenExpr,
  StringLiteral,
  Sub,
  SubqueryExpr,
  UnquotedLabelMatcher,
  VectorSelector,
  Without,
  BinaryExpr,
  AggregateOp,
  parser,
} from '@prometheus-io/lezer-promql';
import type {
  IBuilderOp,
  IPromqlBuilderState,
} from '@openpanel/validation';
import { maskPromqlVariables } from './promql-variables';

/**
 * Read a PromQL expression back into builder state, or say it cannot.
 *
 * This is what makes the Builder tab safe to offer. `expr` is the source of
 * truth — a panel saved from code mode has no builder state at all — so the
 * Builder tab is not a second representation kept in sync, it is a view that
 * has to be RE-DERIVED from the text every time. If the text says something the
 * chip row cannot say, the honest answer is "no", not a best effort: a best
 * effort would show a builder that silently drops the part it did not
 * understand, and the first click on any chip would overwrite the user's query
 * with the lossy version.
 *
 * So every node type below is handled explicitly and anything else returns
 * `null`. There is deliberately no fallback branch. `null` disables the tab; it
 * never touches the text.
 *
 * WHAT IT CAN READ
 *
 * Exactly what `compileBuilder` can write: a vector selector, wrapped in any
 * left-to-right sequence of rate/increase/irate/delta, sum/avg/min/max/count
 * with `by`/`without`, topk/bottomk, histogram_quantile, and one binary
 * operator against a free-text right-hand side. Parentheses are transparent,
 * and so is the step-less subquery (`rate((sum(x))[5m:])`) the compiler emits
 * when a range function follows an aggregation.
 *
 * WHAT IT REFUSES
 *
 * Subqueries with an explicit step (`x[5m:1m]`), `offset`, `@`, `bool` and
 * `on/ignoring` modifiers,
 * quoted label matchers (`{"a.b"="c"}`), aggregations the builder has no chip
 * for (`quantile`, `stddev`, `count_values`), and every other function —
 * `avg_over_time` included. All of those are legal PromQL and stay perfectly
 * runnable in code mode; they just have no builder representation.
 *
 * The only information this loses is cosmetic — whitespace, `by(a)` vs
 * `by (a)`, `0.950` vs `0.95` — so the compiled result is never a different
 * query from the one that was read. That is why there is no round-trip check
 * here: conservatism at every node buys the guarantee outright.
 */

/**
 * Lezer's node type, taken from the parser rather than imported.
 *
 * `@lezer/common` is a transitive dependency of the grammar, not a declared
 * dependency of this app, and adding one for a type alias would put a package
 * in `package.json` that no runtime import needs.
 */
type SyntaxNode = ReturnType<typeof parser.parse>['topNode'];

/** zod caps both of these; a longer expression is not builder-representable. */
const MAX_OPERATIONS = 20;
const MAX_LABEL_MATCHERS = 20;

const RANGE_FUNCTIONS: Record<string, 'rate' | 'increase' | 'irate' | 'delta'> =
  {
    rate: 'rate',
    increase: 'increase',
    irate: 'irate',
    delta: 'delta',
  };

const AGGREGATIONS: Record<string, 'sum' | 'avg' | 'min' | 'max' | 'count'> = {
  sum: 'sum',
  avg: 'avg',
  min: 'min',
  max: 'max',
  count: 'count',
};

const TOP_BOTTOM: Record<string, 'topk' | 'bottomk'> = {
  topk: 'topk',
  bottomk: 'bottomk',
};

const BINARY_OPERATORS = new Map<number, '+' | '-' | '*' | '/'>([
  [Add, '+'],
  [Sub, '-'],
  [Mul, '*'],
  [Div, '/'],
]);

const MATCH_OPERATORS = new Set(['=', '!=', '=~', '!~']);

function children(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  let child = node.firstChild;

  while (child) {
    out.push(child);
    child = child.nextSibling;
  }

  return out;
}

/**
 * Undo the escaping `escapePromqlString` applies.
 *
 * Backtick literals are raw by definition and carry no escapes. A literal that
 * is not quoted at all cannot have come from the grammar, so it is refused
 * rather than guessed at.
 */
function unquote(raw: string): string | null {
  const quote = raw[0];

  if (quote === '`') {
    return raw.slice(1, -1);
  }

  if (quote !== '"' && quote !== "'") {
    return null;
  }

  const body = raw.slice(1, -1);
  let out = '';

  // An indexed loop rather than `for…of`, which lint prefers: the body ADVANCES
  // the cursor to swallow the character after a backslash, and `for…of` has no
  // way to skip an element.
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] !== '\\') {
      out += body[i];
      continue;
    }

    i += 1;
    const escaped = body[i];

    if (escaped === undefined) {
      return null;
    }

    if (escaped === 'n') {
      out += '\n';
    } else if (escaped === 'r') {
      out += '\r';
    } else if (escaped === 't') {
      out += '\t';
    } else {
      // `\\`, `\"`, `\'` and anything else the grammar accepted: the character
      // stands for itself.
      out += escaped;
    }
  }

  return out;
}

/** The vector selector at the bottom of the pipeline. */
function readSelector(
  node: SyntaxNode,
  source: string,
): Pick<IPromqlBuilderState, 'metric' | 'labelMatchers'> | null {
  let metric = '';
  const labelMatchers: IPromqlBuilderState['labelMatchers'] = [];

  for (const child of children(node)) {
    if (child.type.id === Identifier) {
      metric = source.slice(child.from, child.to);
      continue;
    }

    if (child.type.id !== LabelMatchers) {
      // A `MetricName`/`QuotedLabelName` selector, or anything else the grammar
      // can put here that the builder has no field for.
      return null;
    }

    for (const matcher of children(child)) {
      if (matcher.type.id !== UnquotedLabelMatcher) {
        // A quoted matcher — `{"a.b"="c"}` — carries a label name the builder's
        // `assertLabelName` would refuse to write back.
        return null;
      }

      const name = matcher.getChild(LabelName);
      const op = matcher.getChild(MatchOp);
      const value = matcher.getChild(StringLiteral);

      if (!(name && op && value)) {
        return null;
      }

      const operator = source.slice(op.from, op.to);
      if (!MATCH_OPERATORS.has(operator)) {
        return null;
      }

      const unquoted = unquote(source.slice(value.from, value.to));
      if (unquoted === null) {
        return null;
      }

      labelMatchers.push({
        label: source.slice(name.from, name.to),
        op: operator as IPromqlBuilderState['labelMatchers'][number]['op'],
        value: unquoted,
      });
    }
  }

  if (labelMatchers.length > MAX_LABEL_MATCHERS) {
    return null;
  }

  return { metric, labelMatchers };
}

/** The `by (…)` / `without (…)` clause of an aggregation, if it has one. */
function readGrouping(
  node: SyntaxNode,
  source: string,
): { by?: string[]; without?: string[] } | null {
  const modifier = node.getChild(AggregateModifier);

  if (!modifier) {
    return {};
  }

  const labels = (modifier.getChild(GroupingLabels)?.getChildren(LabelName) ??
    []) as SyntaxNode[];
  const names = labels.map((label) => source.slice(label.from, label.to));

  if (modifier.getChild(Without)) {
    return { without: names };
  }

  if (modifier.getChild(By)) {
    return { by: names };
  }

  return null;
}

/**
 * The single expression an aggregation or a function is applied to.
 *
 * `FunctionCallBody` holds the argument list, so "exactly one child" is the
 * check that a one-argument call really is one — `clamp(x, 0, 1)` has three and
 * is refused here rather than silently read as `clamp(x)`.
 */
function soleArgument(body: SyntaxNode | null): SyntaxNode | null {
  if (!body) {
    return null;
  }

  const args = children(body);
  return args.length === 1 ? (args[0] ?? null) : null;
}


/**
 * Peel one operation off the outside of `node` and recurse into what is left,
 * bottoming out at the vector selector.
 *
 * Recursive rather than a loop with a reassigned cursor because the cursor's
 * next value is derived from its own children, and TypeScript will not infer a
 * type that references itself — a parameter annotation is the only way to say
 * it once. Depth is bounded by the operation cap, so there is no recursion to
 * run away with.
 */
function readPipeline(
  node: SyntaxNode,
  source: string,
  operations: IBuilderOp[],
): IPromqlBuilderState | null {
  if (operations.length > MAX_OPERATIONS) {
    return null;
  }

  const id = node.type.id;

  if (id === ParenExpr) {
    const inner = children(node)[0];
    return inner ? readPipeline(inner, source, operations) : null;
  }

  if (id === VectorSelector) {
    const selector = readSelector(node, source);

    if (!selector) {
      return null;
    }

    // Collected outermost-first, so the last one read is the innermost. The
    // builder's list runs the other way — `compileBuilder` folds it left to
    // right, wrapping as it goes — so it is reversed here.
    return { ...selector, operations: operations.slice().reverse() };
  }

  if (id === AggregateExpr) {
    const opNode = node.getChild(AggregateOp);

    if (!opNode) {
      return null;
    }

    const name = source.slice(opNode.from, opNode.to);
    const body = node.getChild(FunctionCallBody);
    const topBottom = TOP_BOTTOM[name];

    if (topBottom) {
      // `topk(5, x)`: the k and the expression, in that order.
      const args = body ? children(body) : [];
      const kNode = args[0];
      const inner = args[1];

      if (
        args.length !== 2 ||
        !kNode ||
        !inner ||
        kNode.type.id !== NumberDurationLiteral
      ) {
        return null;
      }

      const k = Number(source.slice(kNode.from, kNode.to));

      // The schema caps k at 100 and requires a whole number, so anything else
      // could be read here but not written back.
      if (!Number.isInteger(k) || k < 1 || k > 100) {
        return null;
      }

      // `topk by (…)` is legal PromQL, but the builder's topk chip carries only
      // a k, so a grouped one is not representable.
      const grouping = readGrouping(node, source);

      if (!grouping || grouping.by || grouping.without) {
        return null;
      }

      return readPipeline(inner, source, [...operations, { op: topBottom, k }]);
    }

    const aggregation = AGGREGATIONS[name];
    const inner = soleArgument(body);
    const grouping = aggregation ? readGrouping(node, source) : null;

    if (!(aggregation && inner && grouping)) {
      return null;
    }

    return readPipeline(inner, source, [
      ...operations,
      { op: aggregation, ...grouping },
    ]);
  }

  if (id === FunctionCall) {
    const identifier = node.getChild(FunctionIdentifier);

    if (!identifier) {
      return null;
    }

    const name = source.slice(identifier.from, identifier.to);
    const body = node.getChild(FunctionCallBody);

    if (name === 'histogram_quantile') {
      const args = body ? children(body) : [];
      const qNode = args[0];
      const inner = args[1];

      if (
        args.length !== 2 ||
        !qNode ||
        !inner ||
        qNode.type.id !== NumberDurationLiteral
      ) {
        return null;
      }

      const q = Number(source.slice(qNode.from, qNode.to));

      if (!Number.isFinite(q) || q < 0 || q > 1) {
        return null;
      }

      return readPipeline(inner, source, [
        ...operations,
        { op: 'histogram_quantile', q },
      ]);
    }

    const rangeFunction = RANGE_FUNCTIONS[name];

    if (!rangeFunction) {
      return null;
    }

    const argument = soleArgument(body);

    if (!argument) {
      return null;
    }

    let duration: SyntaxNode | null = null;
    let inner: SyntaxNode | null = null;

    if (argument.type.id === MatrixSelector) {
      duration = argument.getChild(DurationExpr);
      inner = argument.getChild(VectorSelector);
    } else if (argument.type.id === SubqueryExpr) {
      // `rate((sum(x))[5m:])` — what `compileBuilder` emits when a range
      // function follows an operation that has already left the bare selector
      // behind, because PromQL will not take `[5m]` over anything else. An
      // EXPLICIT resolution step (`[5m:1m]`) adds a second DurationExpr and has
      // no chip, so only the step-less form reads back.
      const durations: SyntaxNode[] = argument.getChildren(DurationExpr);

      if (durations.length !== 1) {
        return null;
      }

      duration = durations[0] ?? null;
      inner = children(argument)[0] ?? null;

      if (inner?.type.id === DurationExpr) {
        return null;
      }
    } else {
      return null;
    }

    if (!(duration && inner)) {
      return null;
    }

    return readPipeline(inner, source, [
      ...operations,
      {
        op: rangeFunction,
        // Sliced from the ORIGINAL text, so a masked `$__rate_interval` comes
        // back as the variable the user wrote rather than as its stand-in.
        range: source.slice(duration.from, duration.to),
      },
    ]);
  }

  if (id === BinaryExpr) {
    const parts = children(node);

    // Exactly left, operator, right. A `bool` modifier or an `on (…)` clause
    // adds a fourth child and is refused, because the builder's binary chip
    // carries neither.
    if (parts.length !== 3) {
      return null;
    }

    const lhs = parts[0];
    const operatorNode = parts[1];
    const rhs = parts[2];

    if (!(lhs && operatorNode && rhs)) {
      return null;
    }

    const operator = BINARY_OPERATORS.get(operatorNode.type.id);

    if (!operator) {
      return null;
    }

    return readPipeline(lhs, source, [
      ...operations,
      {
        op: 'binary',
        operator,
        // The right-hand side stays as text: it is a free-form expression in
        // the chip, so there is nothing to be gained by understanding it.
        rhs: source.slice(rhs.from, rhs.to),
      },
    ]);
  }

  // OffsetExpr, StepInvariantExpr, a subquery with a step, UnaryExpr, a bare
  // number — all legal, none of them buildable.
  return null;
}

export function parseBuilderState(expr: string): IPromqlBuilderState | null {
  const trimmed = expr.trim();

  if (trimmed === '') {
    return null;
  }

  // Dashboard variables are not PromQL; mask them to a duration of the same
  // length so the grammar accepts the expression and every offset below still
  // indexes into `trimmed`. See promql-variables.ts.
  const tree = parser.parse(maskPromqlVariables(trimmed));

  let valid = true;
  tree.iterate({
    enter(node) {
      if (node.type.isError) {
        valid = false;
      }
    },
  });

  if (!valid) {
    return null;
  }

  const root = tree.topNode.firstChild;

  return root ? readPipeline(root, trimmed, []) : null;
}
