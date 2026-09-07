import {
  VARIABLE_ALL_SENTINEL,
  referencedVariables,
} from '@openpanel/common';
import type {
  IDashboardVariable,
  IPanelQuery,
  IVariableValues,
} from '@openpanel/validation';

/**
 * Dashboard variables, as they travel between the URL, the panels and the
 * queries.
 *
 * Everything here is pure. The value of a variable is URL state — a shared
 * dashboard link has to reopen on the same selection — and the rules for
 * turning that text into something a query can use are the part that has to be
 * right, so they live apart from the components that render them.
 */

/**
 * Values live in the URL as `var_<name>`.
 *
 * Prefixed rather than bare so a variable can never collide with the range,
 * interval or search params the dashboard route already owns — a variable
 * called `range` is legal under the zod name regex.
 */
export const VARIABLE_PARAM_PREFIX = 'var_';

export const variableParamName = (name: string) =>
  `${VARIABLE_PARAM_PREFIX}${name}`;

/**
 * Multi-value selections are comma-joined.
 *
 * Label values with a comma in them would be ambiguous here. That is accepted:
 * Prometheus label values can contain anything, but the ones people build
 * variables from — service names, routes, methods, status codes — do not
 * contain commas, and the alternative (JSON in a query param) makes every
 * shared link unreadable.
 */
const MULTI_SEPARATOR = ',';

export function serializeVariableValue(value: string | string[]): string {
  return Array.isArray(value) ? value.join(MULTI_SEPARATOR) : value;
}

export function parseVariableValue(
  raw: string | null | undefined,
  multi: boolean,
): string | string[] | null {
  if (raw === null || raw === undefined || raw === '') {
    return null;
  }

  if (!multi) {
    return raw;
  }

  const parts = raw
    .split(MULTI_SEPARATOR)
    .map((part) => part.trim())
    .filter((part) => part !== '');

  return parts.length > 0 ? parts : null;
}

/** The durations an `interval` variable offers when it names none itself. */
export const DEFAULT_INTERVAL_OPTIONS = [
  '1m',
  '5m',
  '10m',
  '30m',
  '1h',
  '6h',
  '12h',
  '1d',
] as const;

/**
 * The options a variable offers, for the types that know them without asking
 * the server. `query` variables resolve theirs through
 * `observability.variableOptions` and are not answered here.
 */
export function staticVariableOptions(
  variable: IDashboardVariable,
): string[] | null {
  if (variable.type === 'custom') {
    return variable.options ?? [];
  }

  if (variable.type === 'interval') {
    return variable.options?.length
      ? variable.options
      : [...DEFAULT_INTERVAL_OPTIONS];
  }

  return null;
}

/**
 * The value a variable should start on.
 *
 * In order: what the URL says, then what was saved as `current`, then "All"
 * when the variable offers it, then the first option. The last two matter
 * because a variable with no value at all leaves `$service` in the expression,
 * and the rewriter rejects that with a parse error rather than a blank panel —
 * correct, but not what someone opening a dashboard should be shown.
 */
export function defaultVariableValue(
  variable: IDashboardVariable,
  options: string[] | null,
): string | string[] | null {
  if (variable.current !== undefined && variable.current !== null) {
    // A saved single value on a variable that has since been made multi is
    // still usable; the reverse would hand a query an array it cannot render.
    if (variable.multi) {
      return Array.isArray(variable.current)
        ? variable.current
        : [variable.current];
    }

    return Array.isArray(variable.current)
      ? (variable.current[0] ?? null)
      : variable.current;
  }

  if (variable.includeAll) {
    return variable.multi ? [VARIABLE_ALL_SENTINEL] : VARIABLE_ALL_SENTINEL;
  }

  const first = options?.[0];

  if (first === undefined) {
    return null;
  }

  return variable.multi ? [first] : first;
}

/**
 * Every variable that still has no value.
 *
 * A `query` variable has none until its options come back, and a panel run
 * against an unresolved variable fails on the server rather than waiting, so
 * the dashboard holds the panels until this is empty.
 */
export function unresolvedVariables(
  variables: IDashboardVariable[],
  values: IVariableValues,
): string[] {
  return variables
    .filter((variable) => {
      const value = values[variable.name];

      if (value === undefined) {
        return true;
      }

      return Array.isArray(value) ? value.length === 0 : value === '';
    })
    .map((variable) => variable.name);
}

/**
 * The values a panel actually needs.
 *
 * This is the whole point of the selective-refetch requirement: the value map
 * is part of the react-query key, so a panel that references nothing keeps the
 * key it had before variables existed, and a panel that references `$service`
 * refetches when `$service` changes and not when `$env` does.
 *
 * Returns `undefined` rather than `{}` when nothing is referenced — an empty
 * object is a different query key from an absent one, and every events panel
 * on the dashboard would refetch the first time anyone added a variable.
 */
export function variablesForQueries(
  queries: Pick<IPanelQuery, 'expr'>[] | undefined,
  values: IVariableValues,
): IVariableValues | undefined {
  if (!queries?.length) {
    return undefined;
  }

  const referenced = new Set<string>();

  for (const query of queries) {
    for (const name of referencedVariables(query.expr)) {
      referenced.add(name);
    }
  }

  const out: IVariableValues = {};

  // Sorted so the object is built the same way every render. TanStack Query
  // hashes keys with sorted object keys, so this is tidiness rather than
  // correctness — but it makes a logged query key diffable by eye.
  for (const name of [...referenced].sort()) {
    const value = values[name];

    if (value !== undefined) {
      out[name] = value;
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * A report as the dashboard should render it under the current selection.
 *
 * The two things a variable changes about a panel: the title it shows, and the
 * values its queries run with. Kept here rather than inline in the route so
 * the refetch behaviour — the acceptance criterion for this whole feature —
 * is something a test can assert on directly.
 *
 * `variables` ends up in the chart query input (report-chart's `useChartInput`
 * spreads the whole report), so it is part of the react-query key: two panels
 * referencing different variables get different keys, and only the panels
 * referencing the one that changed refetch.
 *
 * The substituted title does NOT cause a refetch: `useChartInput` in
 * report-chart/context.tsx strips `name` from the query input. The one
 * exception is a LEGACY structured-metrics panel, where `name` still travels
 * because `executeMetricChart` uses it to name its single series — so a legacy
 * panel titled `$service …` does refetch when `$service` changes. That path
 * disappears with the metricQueries migration.
 */
export function applyVariablesToReport<
  T extends { name?: string; metricQueries?: Pick<IPanelQuery, 'expr'>[] },
>(report: T, values: IVariableValues): T & { variables?: IVariableValues } {
  const variables = variablesForQueries(report.metricQueries, values);

  return {
    ...report,
    // Display only — the stored name keeps its `$service`.
    ...(report.name ? { name: substituteTitle(report.name, values) } : {}),
    // Spread conditionally: an explicit `variables: undefined` is a different
    // object from an absent key once it reaches `JSON.stringify` in the
    // server's cache key.
    ...(variables ? { variables } : {}),
  };
}

/** `$name` or `${name}`, the same two forms `substituteVariables` accepts. */
const TITLE_VARIABLE_RE = /\$(?:\{([a-zA-Z_][a-zA-Z0-9_]*)\}|([a-zA-Z_][a-zA-Z0-9_]*))/g;

/**
 * Substitute variables into a panel title, for display only.
 *
 * Never writes back: the saved name stays `$service latency`, so renaming a
 * variable or changing its value does not quietly rewrite what is stored.
 * Unknown names are left as written, which is what the expression substituter
 * does too — a typo should look like a typo rather than vanish.
 */
export function substituteTitle(
  title: string,
  values: IVariableValues,
): string {
  return title.replace(TITLE_VARIABLE_RE, (match, braced, bare) => {
    const name = (braced ?? bare) as string;

    if (name.startsWith('__')) {
      return match;
    }

    const value = values[name];

    if (value === undefined) {
      return match;
    }

    if (Array.isArray(value)) {
      return value.length > 0 ? value.join(', ') : match;
    }

    return value;
  });
}

/** How a value reads in a control or a title: "All", or comma-joined. */
export function formatVariableValue(
  value: string | string[] | undefined,
): string {
  if (value === undefined) {
    return '';
  }

  const asArray = Array.isArray(value) ? value : [value];

  if (asArray.length === 0) {
    return '';
  }

  return asArray
    .map((item) => (item === VARIABLE_ALL_SENTINEL ? 'All' : item))
    .join(', ');
}

/**
 * A light shape check on a query variable's query.
 *
 * Deliberately PERMISSIVE. The server's `parseVariableQuery` is the authority
 * and it understands more than a regex here reasonably can — selectors with
 * matchers, matcher-only selectors, commas inside quoted values, escaped
 * quotes. An earlier version of this rejected anything containing `{`, which
 * meant the editor refused to save `label_values(up{job="api"}, pod)` after
 * the server had learned to answer it. Blocking a valid query at the field is
 * worse than letting an invalid one through: an invalid one comes back from
 * the server with a precise message, which the bar shows on the control.
 *
 * So this catches only what it can be sure about — the wrong function, and the
 * one restriction the server states explicitly.
 */

const LABEL_NAMES_RE = /^label_names\(\s*\)$/;
const LABEL_VALUES_RE = /^label_values\(.*\)$/s;
/** `=~` or `!~` anywhere in the selector. */
const REGEX_MATCHER_RE = /[=!]~/;

export const VARIABLE_QUERY_HINT =
  'Expected label_values(<metric>, <label>), label_values(<label>) or label_names()';

/**
 * The server rejects regex matchers because answering one would mean scanning
 * every value of that label — see `getTelemetryLabelValues`, which takes
 * equality matchers only.
 */
export const VARIABLE_QUERY_REGEX_HINT =
  'Variable selectors support equality matchers only (= and !=)';

export function variableQueryError(query: string): string | null {
  const trimmed = query.trim();

  if (trimmed === '') {
    return 'A query variable needs a query';
  }

  if (LABEL_NAMES_RE.test(trimmed)) {
    return null;
  }

  if (!LABEL_VALUES_RE.test(trimmed)) {
    return VARIABLE_QUERY_HINT;
  }

  return REGEX_MATCHER_RE.test(trimmed) ? VARIABLE_QUERY_REGEX_HINT : null;
}

export function isValidVariableQuery(query: string): boolean {
  return variableQueryError(query) === null;
}
