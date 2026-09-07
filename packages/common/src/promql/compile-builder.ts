import type { IBuilderOp, IPromqlBuilderState } from '@openpanel/validation';
import { inferMetricKind } from '../metric-kind';

/**
 * Compile the builder's structured state into PromQL.
 *
 * THIS DOES NOT SCOPE THE QUERY TO A PROJECT, and that is deliberate. The
 * builder runs in the browser, where a tenancy matcher would be advisory at
 * best; `rewritePromqlForProject` injects `op_project_id` into every selector
 * server-side and `assertPromqlScoped` re-reads the result before it is sent.
 * Emitting the label here as well would suggest the browser is a gate, and the
 * first person to hand-edit the expression in code mode would find out it is
 * not. See packages/gigapipe/src/promql/rewrite.ts.
 *
 * The compiled string is a CONVENIENCE, not the source of truth: `IPanelQuery`
 * carries `expr`, and that is always what runs. The builder state exists so the
 * editor can round-trip an expression it recognises; a panel saved from code
 * mode has no builder state and runs just the same.
 *
 * The operation list folds LEFT TO RIGHT, each step wrapping the previous
 * expression. `rate` then `sum by (le)` then `histogram_quantile` is a p95; the
 * same three in any other order is nonsense, so the order the user sees in the
 * chip row is the order the nesting happens.
 */

export class PromqlBuilderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromqlBuilderError';
  }
}

/**
 * Prometheus metric names, which may carry `:` because that is how recording
 * rules are named. Validated rather than escaped: PromQL has no escape syntax
 * for an identifier, so a name outside this shape cannot be expressed safely
 * and is refused instead of mangled.
 */
const METRIC_NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

/** Label names, which may not carry `:`. */
const LABEL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * A range-vector window: either a literal Prometheus duration or a variable
 * that resolves to one (`$__rate_interval`, `$window`, `${window}`).
 *
 * Anything else is refused, because this value is placed inside `[...]` where a
 * `]` would close the range and everything after it would become expression
 * syntax.
 */
const RANGE_RE = /^(?:[0-9]+(?:ms|s|m|h|d|w|y))+$|^\$\{?[a-zA-Z_][a-zA-Z0-9_]*\}?$/;

/** Word operators, which bind like the symbolic ones. */
const WORD_OPERATOR_RE = /(^|[^a-zA-Z0-9_:])(and|or|unless)([^a-zA-Z0-9_:]|$)/;

/**
 * Does this expression carry a binary operator at the top level?
 *
 * Only such an expression needs wrapping before another operator is applied to
 * it: `a + b` then `* 2` has to become `(a + b) * 2`, while `sum(a)` then `/ 60`
 * does not. Parenthesising everything would be safe and unreadable, and the
 * compiled query is shown to the user in the editor's preview.
 *
 * Depth is tracked across `()`, `[]` and `{}` and string literals are skipped,
 * so a `=~` inside a matcher and a `:` inside a subquery are not mistaken for
 * operators.
 */
function hasTopLevelBinaryOperator(expr: string): boolean {
  let depth = 0;
  let quote: string | undefined;

  for (let i = 0; i < expr.length; i += 1) {
    const char = expr[i] as string;

    if (quote) {
      if (char === '\\') {
        i += 1;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }

    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
      continue;
    }

    if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
      continue;
    }

    // A leading sign is part of the number, not an operator.
    if (depth === 0 && i > 0 && '+-*/%^'.includes(char)) {
      return true;
    }
  }

  return WORD_OPERATOR_RE.test(expr);
}

/**
 * Escape a matcher value for a PromQL string literal.
 *
 * Backslash first: escaping it after the quote would double-escape the
 * backslashes this function just introduced. Newlines matter because an
 * unescaped one terminates the literal and turns the rest of the value into
 * expression syntax.
 */
export function escapePromqlString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

function assertMetricName(value: string): string {
  if (!METRIC_NAME_RE.test(value)) {
    throw new PromqlBuilderError(
      `Metric name ${JSON.stringify(value)} is not a valid Prometheus identifier`,
    );
  }

  return value;
}

function assertLabelName(value: string, what: string): string {
  if (!LABEL_NAME_RE.test(value)) {
    throw new PromqlBuilderError(
      `${what} ${JSON.stringify(value)} is not a valid Prometheus label name`,
    );
  }

  return value;
}

function assertRange(value: string): string {
  if (!RANGE_RE.test(value)) {
    throw new PromqlBuilderError(
      `Range ${JSON.stringify(value)} is not a Prometheus duration or a variable`,
    );
  }

  return value;
}

function parenthesize(expr: string): string {
  const trimmed = expr.trim();

  return hasTopLevelBinaryOperator(trimmed) ? `(${trimmed})` : trimmed;
}

function renderGrouping(op: string, by?: string[], without?: string[]): string {
  // `without` wins when both are given rather than being silently merged: they
  // are opposites, and picking one arbitrarily would draw a chart the user did
  // not ask for. The editor only ever sets one.
  if (without && without.length > 0) {
    const labels = without.map((l) => assertLabelName(l, 'Group-by label'));
    return `${op} without (${[...new Set(labels)].join(', ')})`;
  }

  if (by && by.length > 0) {
    const labels = by.map((l) => assertLabelName(l, 'Group-by label'));
    return `${op} by (${[...new Set(labels)].join(', ')})`;
  }

  return op;
}

/**
 * The base vector: the metric name with its matcher block.
 *
 * An empty metric is allowed — the builder starts there, and a matcher-only
 * selector (`{service_name="api"}`) is valid PromQL — so this returns an empty
 * string only when there is genuinely nothing to select.
 */
function renderSelector(state: IPromqlBuilderState): string {
  const metric = state.metric.trim();
  const matchers = (state.labelMatchers ?? [])
    .filter((m) => m.label.trim() !== '')
    .map(
      (m) =>
        `${assertLabelName(m.label.trim(), 'Label name')}${m.op}"${escapePromqlString(m.value)}"`,
    );

  if (metric === '') {
    return matchers.length > 0 ? `{${matchers.join(', ')}}` : '';
  }

  assertMetricName(metric);

  return matchers.length > 0 ? `${metric}{${matchers.join(', ')}}` : metric;
}

/**
 * The placeholder a `raw` operation uses to say where the expression built so
 * far should go. Without it the raw text stands alone, which is the escape
 * hatch for "I will write this one myself".
 */
export const RAW_OP_PLACEHOLDER = '$__expr';

/**
 * Apply one operation to the expression built so far.
 *
 * `isSelector` tracks whether `expr` is still a bare instant vector. A range
 * function needs a range vector, and only a selector can carry `[5m]` directly
 * — over anything else PromQL requires a subquery, `(...)[5m:]`. Emitting the
 * wrong one produces a parse error the user has no way to interpret.
 */
function applyOperation(
  expr: string,
  op: IBuilderOp,
  isSelector: boolean,
): { expr: string; isSelector: boolean } {
  switch (op.op) {
    case 'rate':
    case 'increase':
    case 'irate':
    case 'delta': {
      const range = assertRange(op.range);
      const inner = isSelector
        ? `${expr}[${range}]`
        : `(${expr})[${range}:]`;

      return { expr: `${op.op}(${inner})`, isSelector: false };
    }

    case 'histogram_quantile': {
      if (op.q < 0 || op.q > 1 || Number.isNaN(op.q)) {
        throw new PromqlBuilderError(
          `Quantile ${op.q} is outside the range 0–1`,
        );
      }

      return {
        expr: `histogram_quantile(${op.q}, ${expr})`,
        isSelector: false,
      };
    }

    case 'sum':
    case 'avg':
    case 'min':
    case 'max':
    case 'count':
      return {
        expr: `${renderGrouping(op.op, op.by, op.without)}(${expr})`,
        isSelector: false,
      };

    case 'topk':
    case 'bottomk': {
      if (!Number.isInteger(op.k) || op.k < 1) {
        throw new PromqlBuilderError(`${op.op} needs a positive whole k`);
      }

      return { expr: `${op.op}(${op.k}, ${expr})`, isSelector: false };
    }

    case 'binary': {
      const rhs = op.rhs.trim();
      if (rhs === '') {
        throw new PromqlBuilderError(
          `A ${op.operator} operation needs a right-hand side`,
        );
      }

      return {
        expr: `${parenthesize(expr)} ${op.operator} ${parenthesize(rhs)}`,
        isSelector: false,
      };
    }

    case 'raw': {
      const raw = op.expr.trim();
      if (raw === '') {
        throw new PromqlBuilderError('A raw operation needs an expression');
      }

      return {
        expr: raw.includes(RAW_OP_PLACEHOLDER)
          ? raw.split(RAW_OP_PLACEHOLDER).join(expr)
          : raw,
        isSelector: false,
      };
    }

    default: {
      // Exhaustiveness: a new member of the union lands here as a type error
      // rather than as an operation that silently does nothing.
      const never: never = op;
      throw new PromqlBuilderError(
        `Unknown builder operation ${JSON.stringify(never)}`,
      );
    }
  }
}

export function compileBuilder(state: IPromqlBuilderState): string {
  let expr = renderSelector(state);
  let isSelector = expr !== '';

  if (expr === '' && (state.operations ?? []).length === 0) {
    return '';
  }

  for (const op of state.operations ?? []) {
    // A `raw` operation is the one thing that can stand on its own with no
    // selector under it, so an empty base is only a problem for the others.
    if (expr === '' && op.op !== 'raw') {
      throw new PromqlBuilderError(
        `Pick a metric before adding a ${op.op} operation`,
      );
    }

    const next = applyOperation(expr, op, isSelector);
    expr = next.expr;
    isSelector = next.isSelector;
  }

  return expr;
}

/**
 * The operations to seed when a metric is first picked.
 *
 * A counter is meaningless unrated — it only ever climbs — and a gauge is
 * meaningless rated, so the seed is the difference between a chart that answers
 * the question on the first click and one that has to be corrected before it
 * shows anything. A `_bucket` series gets the full quantile pipeline, because
 * summing raw bucket counts is the sawtooth this whole path exists to stop.
 *
 * `$__rate_interval` rather than a literal window: the engine resolves it
 * against the step actually used, so the rate window can never be narrower than
 * the interval it is drawn at.
 */
export function defaultOperationsFor(metric: string): IBuilderOp[] {
  const kind = inferMetricKind(metric);

  if (kind === 'histogram') {
    return [
      { op: 'rate', range: '$__rate_interval' },
      { op: 'sum', by: ['le'] },
      { op: 'histogram_quantile', q: 0.95 },
    ];
  }

  if (kind === 'counter') {
    return [{ op: 'rate', range: '$__rate_interval' }, { op: 'sum' }];
  }

  return [];
}
