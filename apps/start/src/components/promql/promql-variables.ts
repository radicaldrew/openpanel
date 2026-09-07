/**
 * Making a query with dashboard variables in it parseable in the browser.
 *
 * WHY THIS EXISTS
 *
 * `$__rate_interval` is not PromQL. The grammar has no notion of a variable, so
 * `rate(http_requests_total[$__rate_interval])` parses as an error node at the
 * `$` and every token after it is garbage — the whole tail of the expression
 * falls out of the tree. That is not an edge case here: `defaultOperationsFor`
 * seeds exactly that expression the moment a counter is picked, so it is the
 * FIRST thing the editor is asked to parse. Substitution happens server-side in
 * `executeMetricPanel`, which is right — the step is only known there — but it
 * leaves the browser holding a string its parser rejects.
 *
 * Two things in this folder parse: the lint in `promql-code-editor.tsx` and the
 * PromQL→builder round trip in `builder-parse.ts`. Without masking, the first
 * underlines a correct query in red and the second disables the Builder tab on
 * the query the builder just wrote.
 *
 * WHY EQUAL-LENGTH MASKING RATHER THAN SUBSTITUTION
 *
 * Every offset in the resulting tree has to point back into the ORIGINAL text,
 * because `builder-parse` slices the real range (`$__rate_interval`) out of it
 * and the linter reports positions into the real document. Replacing a variable
 * with a shorter or longer stand-in shifts every offset after it and there is
 * no honest way back. A same-length mask keeps `from`/`to` usable as-is.
 *
 * WHY A DURATION
 *
 * A variable has to be masked as one shape, and the shape that matters is the
 * range vector: every `$__*` builtin resolves to a duration (`$__rate_interval`,
 * `$__interval`, `$__range`), and that is the only place a variable appears
 * OUTSIDE a string literal in anything the builder emits. User variables land in
 * label matcher values — `service_name=~"$service"` — which are inside quotes
 * and already parse. A digits-plus-`s` token is a valid duration at any length
 * of two or more, and `$x` is the shortest variable there is.
 *
 * A variable used as a bare metric name (`$metric{job="api"}`) still fails to
 * parse, and is reported as the syntax error it is. Supporting it would mean
 * masking as an identifier, which breaks the range case — the common one.
 */

/**
 * `$name` and `${name}`, including the `$__*` builtins. Leading `_` is legal in
 * a Prometheus label name and every builtin uses it, so the first character
 * class has to admit it.
 */
const VARIABLE_RE = /\$(?:\{[a-zA-Z_][a-zA-Z0-9_]*\}|[a-zA-Z_][a-zA-Z0-9_]*)/g;

export function hasVariables(expr: string): boolean {
  // The regex is a module constant, so its lastIndex survives between calls —
  // reset it rather than relying on the previous caller having exhausted it.
  VARIABLE_RE.lastIndex = 0;
  return VARIABLE_RE.test(expr);
}

/**
 * Replace every variable with a duration literal of exactly the same length.
 *
 * `$__rate_interval` (16 characters) becomes `999999999999999s`. Offsets in a
 * tree parsed from the result are valid offsets into the input.
 */
export function maskPromqlVariables(expr: string): string {
  return expr.replace(VARIABLE_RE, (match) => {
    // A variable is at minimum `$x`, so `length - 1` is never zero and the
    // token is never a bare unit.
    return `${'9'.repeat(match.length - 1)}s`;
  });
}
