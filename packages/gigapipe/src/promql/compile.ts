import { PROJECT_LABEL, assertValidProjectId } from '../tenancy/project-label';

/**
 * Compile a structured metric query into PromQL.
 *
 * THIS FUNCTION IS THE READ-SIDE HALF OF THE TENANCY BOUNDARY.
 *
 * It is the only place in the codebase permitted to emit a `{`. Every selector
 * it produces carries `op_project_id="<project>"` as a mandatory `=` matcher,
 * and because the caller supplies a structured spec rather than a string, there
 * is no user-controlled text to escape — the selector is built, not
 * concatenated.
 *
 * That property is what makes phase-1 safe without a PromQL parser. When raw
 * PromQL is exposed later it cannot reuse this function: it needs a real parse
 * (`@prometheus-io/lezer-promql`), a walk to every VectorSelector, and a
 * matcher inserted into each — anything that pattern-matches on `{` is defeated
 * by a comment, a subquery, an @-modifier, or `label_replace` rewriting the
 * label back.
 */

export type MetricFn = 'rate' | 'increase' | 'delta' | 'raw';

export type MetricAggregation =
  | 'sum'
  | 'avg'
  | 'min'
  | 'max'
  | 'count'
  | 'p50'
  | 'p90'
  | 'p95'
  | 'p99';

export type MatcherOperator = 'eq' | 'neq' | 'match' | 'notMatch';

export interface MetricMatcher {
  name: string;
  operator: MatcherOperator;
  value: string;
}

export interface MetricQuery {
  metric: string;
  matchers?: MetricMatcher[];
  fn?: MetricFn;
  aggregation?: MetricAggregation;
  groupBy?: string[];
  /** Range-vector window, e.g. `5m`. Defaults from the chart interval. */
  window?: string;
}

export class MetricQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetricQueryError';
  }
}

/**
 * Prometheus metric and label names. Validated rather than escaped: PromQL has
 * no escape syntax for an identifier, so anything outside this shape cannot be
 * expressed safely and is refused.
 */
const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const QUANTILES: Record<string, string> = {
  p50: '0.5',
  p90: '0.9',
  p95: '0.95',
  p99: '0.99',
};

const OPERATOR_SYMBOL: Record<MatcherOperator, string> = {
  eq: '=',
  neq: '!=',
  match: '=~',
  notMatch: '!~',
};

function assertIdentifier(value: string, what: string): string {
  if (!IDENTIFIER_RE.test(value)) {
    throw new MetricQueryError(
      `${what} ${JSON.stringify(value)} is not a valid Prometheus identifier`,
    );
  }

  return value;
}

/**
 * Escape a matcher VALUE for a PromQL string literal.
 *
 * Values are user data and may legitimately contain anything, so unlike
 * identifiers they are escaped rather than refused. Backslash first — escaping
 * it after the quote would double-escape the backslashes this function just
 * introduced. Newlines matter because an unescaped one terminates the literal
 * and everything after it becomes expression syntax.
 */
function escapeValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

function renderMatcher(matcher: MetricMatcher): string {
  const name = assertIdentifier(matcher.name, 'Label name');

  // A caller-supplied matcher on the tenancy label would sit alongside ours.
  // For `=` that is at best redundant and at worst a second, conflicting
  // constraint; for `!=` / `!~` it is an attempt to widen the selection. Refuse
  // all of them: the label is ours, and the compiler is its only author.
  if (name === PROJECT_LABEL) {
    throw new MetricQueryError(
      `${PROJECT_LABEL} is reserved and cannot appear in a query matcher`,
    );
  }

  const op = OPERATOR_SYMBOL[matcher.operator];
  if (!op) {
    throw new MetricQueryError(`Unknown matcher operator ${matcher.operator}`);
  }

  return `${name}${op}"${escapeValue(matcher.value)}"`;
}

/**
 * Build the selector, with the project matcher ALWAYS first.
 *
 * First is not cosmetic: gigapipe's LogQL planner has historically had
 * behaviours keyed on selector position, and a reviewer scanning a compiled
 * query should be able to see the tenancy constraint without reading to the
 * end.
 */
function renderSelector(query: MetricQuery, projectId: string): string {
  const metric = assertIdentifier(query.metric, 'Metric name');

  const matchers = [
    `${PROJECT_LABEL}="${escapeValue(projectId)}"`,
    ...(query.matchers ?? []).map(renderMatcher),
  ];

  return `${metric}{${matchers.join(',')}}`;
}

/**
 * `by (...)` always includes the project label.
 *
 * Without it, an aggregation collapses every project's series into one result
 * and the response-side ownership check becomes vacuous — it would find no
 * project label to verify because the aggregation removed it. Including it
 * costs nothing (the selector already constrains to one project, so it adds one
 * constant-valued grouping key) and keeps the invariant checkable end to end.
 */
function renderGrouping(groupBy: string[] | undefined): string {
  const labels = [
    PROJECT_LABEL,
    ...(groupBy ?? []).map((l) => assertIdentifier(l, 'Group-by label')),
  ];

  const unique = [...new Set(labels)];

  return `by (${unique.join(', ')})`;
}

const WINDOW_RE = /^[0-9]+(ms|s|m|h|d|w|y)$/;

function assertWindow(window: string): string {
  if (!WINDOW_RE.test(window)) {
    throw new MetricQueryError(
      `Window ${JSON.stringify(window)} is not a valid Prometheus duration`,
    );
  }

  return window;
}

export interface CompiledQuery {
  /** The PromQL to send to gigapipe. */
  promql: string;
  /** Grouping labels present in the result, project label first. */
  groupBy: string[];
  /** Notices worth surfacing in the UI (e.g. a widened rate window). */
  notices: string[];
}

/**
 * Compile a spec for a given project.
 *
 * `window` is required for every `fn` other than `raw`; the caller derives it
 * from the chart interval so a rate window is never shorter than the step it is
 * rendered at — a rate over a window narrower than the step samples gaps and
 * draws a sawtooth that looks like real instability.
 */
export function compileMetricQuery(
  query: MetricQuery,
  projectId: string,
): CompiledQuery {
  assertValidProjectId(projectId);

  const notices: string[] = [];
  const selector = renderSelector(query, projectId);
  const fn = query.fn ?? 'rate';
  const aggregation = query.aggregation ?? 'sum';
  const groupBy = [PROJECT_LABEL, ...(query.groupBy ?? [])];
  const grouping = renderGrouping(query.groupBy);

  const quantile = QUANTILES[aggregation];

  // Percentiles are computed over a histogram's `_bucket` series, which is a
  // different selector and a different shape from every other aggregation, so
  // it gets its own branch rather than being folded into the general path.
  if (quantile) {
    if (!query.metric.endsWith('_bucket')) {
      throw new MetricQueryError(
        `Aggregation ${aggregation} requires a histogram bucket series (a metric ending in _bucket), got ${query.metric}`,
      );
    }

    const window = assertWindow(query.window ?? '5m');
    const inner = `sum by (le, ${[...new Set(groupBy)].join(', ')}) (rate(${selector}[${window}]))`;

    return {
      promql: `histogram_quantile(${quantile}, ${inner})`,
      groupBy,
      notices,
    };
  }

  let vector: string;
  switch (fn) {
    case 'raw':
      vector = selector;
      break;
    case 'rate':
    case 'increase':
    case 'delta': {
      const window = assertWindow(query.window ?? '5m');
      vector = `${fn}(${selector}[${window}])`;
      break;
    }
    default:
      throw new MetricQueryError(`Unknown function ${fn}`);
  }

  const AGGREGATORS: Record<string, string> = {
    sum: 'sum',
    avg: 'avg',
    min: 'min',
    max: 'max',
    count: 'count',
  };

  const aggregator = AGGREGATORS[aggregation];
  if (!aggregator) {
    throw new MetricQueryError(`Unknown aggregation ${aggregation}`);
  }

  return {
    promql: `${aggregator} ${grouping} (${vector})`,
    groupBy,
    notices,
  };
}
