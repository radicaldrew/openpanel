import { PROJECT_LABEL, assertValidProjectId } from '../tenancy/project-label';

/**
 * Compile a structured log query into LogQL.
 *
 * The read half of the tenancy boundary for logs, and the only function
 * permitted to emit a LogQL stream selector. Same contract as the PromQL
 * compiler: the caller supplies a structured spec, never a string, so there is
 * no user text to escape into a selector.
 *
 * There is one hazard here that the metrics path does not have.
 * `ADVANCED_OMIT_EMPTY_VALUES` must be `true` on gigapipe, because when it is
 * false the LogQL planner walks the selector and SILENTLY REMOVES any matcher
 * whose value is empty, plus any `=~".*"` matcher
 * (`planner_stream_select.go:31-46`). The project matcher is the only thing
 * separating tenants on this path, so a compiler that could emit an empty value
 * would hand the planner a query it quietly widens to every project. Two
 * defences, because one of them is a config file someone can change:
 *
 *   1. gigapipe is configured with the flag set (docs/observability/14-decisions.md D8).
 *   2. This compiler refuses to emit an empty project value at all — the id is
 *      validated before it is used, and `assertValidProjectId` rejects the empty
 *      string.
 */

export type LineFilterOperator = 'contains' | 'notContains' | 'match' | 'notMatch';

export interface LogLabelMatcher {
  name: string;
  operator: 'eq' | 'neq' | 'match' | 'notMatch';
  value: string;
}

export interface LogLineFilter {
  operator: LineFilterOperator;
  value: string;
}

export interface LogQuery {
  /** Stream selectors, e.g. service="checkout-api". */
  matchers?: LogLabelMatcher[];
  /** Line filters applied after stream selection. */
  lineFilters?: LogLineFilter[];
  /** Cap on returned lines. */
  limit?: number;
}

export class LogQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LogQueryError';
  }
}

const LABEL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const LABEL_OPERATOR: Record<LogLabelMatcher['operator'], string> = {
  eq: '=',
  neq: '!=',
  match: '=~',
  notMatch: '!~',
};

const LINE_OPERATOR: Record<LineFilterOperator, string> = {
  contains: '|=',
  notContains: '!=',
  match: '|~',
  notMatch: '!~',
};

/** Same escaping rules as PromQL string literals. Backslash first. */
function escapeValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

function assertLabelName(name: string): string {
  if (!LABEL_NAME_RE.test(name)) {
    throw new LogQueryError(
      `Label name ${JSON.stringify(name)} is not a valid LogQL identifier`,
    );
  }

  return name;
}

export interface CompiledLogQuery {
  logql: string;
  limit: number;
}

export const DEFAULT_LOG_LIMIT = 200;
const MAX_LOG_LIMIT = 5000;

export function compileLogQuery(
  query: LogQuery,
  projectId: string,
): CompiledLogQuery {
  assertValidProjectId(projectId);

  const matchers = [
    // First position, always. A reviewer should see the tenancy constraint
    // without reading to the end of the selector.
    `${PROJECT_LABEL}="${escapeValue(projectId)}"`,
  ];

  for (const matcher of query.matchers ?? []) {
    const name = assertLabelName(matcher.name);

    if (name === PROJECT_LABEL) {
      throw new LogQueryError(
        `${PROJECT_LABEL} is reserved and cannot appear in a query matcher`,
      );
    }

    const op = LABEL_OPERATOR[matcher.operator];
    if (!op) {
      throw new LogQueryError(`Unknown matcher operator ${matcher.operator}`);
    }

    // An empty value on `=` or `=~` is exactly what the planner strips when
    // ADVANCED_OMIT_EMPTY_VALUES is false. Even with the flag set correctly,
    // refusing it here means a config regression cannot turn a user's filter
    // into a silently wider query.
    if (
      matcher.value === '' &&
      (matcher.operator === 'eq' || matcher.operator === 'match')
    ) {
      throw new LogQueryError(
        `Matcher on ${name} needs a value — an empty one is silently dropped by the query planner`,
      );
    }

    matchers.push(`${name}${op}"${escapeValue(matcher.value)}"`);
  }

  const parts = [`{${matchers.join(',')}}`];

  for (const filter of query.lineFilters ?? []) {
    const op = LINE_OPERATOR[filter.operator];
    if (!op) {
      throw new LogQueryError(`Unknown line filter ${filter.operator}`);
    }

    if (filter.value === '') {
      throw new LogQueryError('A line filter needs a value');
    }

    parts.push(`${op} "${escapeValue(filter.value)}"`);
  }

  const limit = Math.min(
    Math.max(1, Math.floor(query.limit ?? DEFAULT_LOG_LIMIT)),
    MAX_LOG_LIMIT,
  );

  return { logql: parts.join(' '), limit };
}
