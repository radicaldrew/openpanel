import type { IVariableValues } from '@openpanel/validation';
import { escapePromqlString } from './compile-builder';

/**
 * Dashboard variables, substituted into an expression before it runs.
 *
 * Substitution happens SERVER-SIDE, on the way into
 * `rewritePromqlForProject`, so the string that reaches the rewriter is the
 * string that reaches gigapipe. Doing it in the browser would mean the server
 * scopes an expression it has not seen in its final form.
 *
 * THE ESCAPING RULE
 *
 * A variable's value is user data and lands inside a matcher's string literal.
 * Two things have to hold for that to be safe:
 *
 *   1. It cannot leave the literal — so `"` and `\` are escaped.
 *   2. It cannot widen the selection — so regex metacharacters are escaped
 *      too. A variable is written `label=~"$var"` precisely so that a
 *      multi-value selection compiles to `(a|b)`; an unescaped `.` or `.*` in
 *      a single value would then match series the user never chose.
 *
 * Rule 2 is why a single value is regex-escaped as well: a variable is only
 * ever meant to sit behind `=~`, and escaping there is correct while escaping
 * behind `=` is merely redundant for every value that does not contain a
 * metacharacter.
 */

/** `$name` or `${name}` — including the `$__*` built-ins. */
const VARIABLE_RE = /\$(?:\{([a-zA-Z_][a-zA-Z0-9_]*)\}|([a-zA-Z_][a-zA-Z0-9_]*))/g;

/**
 * The value an "All" selection carries.
 *
 * A sentinel rather than the literal list, so a dashboard shared with someone
 * whose project has since gained a new service still means "all of them".
 * Substitutes to `.+` — every non-empty value — rather than `.*`, which would
 * also match series where the label is absent.
 */
export const VARIABLE_ALL_SENTINEL = '__all__';

/**
 * Prometheus's default scrape interval, and the floor `$__rate_interval` is
 * built on when the deployment has not said otherwise.
 */
export const DEFAULT_SCRAPE_INTERVAL_SECONDS = 15;

export interface SubstituteOptions {
  /** The step the chart is drawn at, in seconds. */
  step: number;
  /** The full window being charted, in seconds. */
  rangeSeconds: number;
  /** The backend's scrape interval, if the deployment knows it. */
  scrapeIntervalSeconds?: number;
}

/**
 * Render seconds as a Prometheus duration.
 *
 * Whole units where they divide evenly, so a step of 3600 reads `1h` rather
 * than `3600s`. Sub-second steps round up to `1s`: Prometheus accepts `ms`, but
 * a rate window under a second samples nothing useful and reads as a mistake.
 */
export function formatPromDuration(seconds: number): string {
  const total = Math.max(1, Math.round(seconds));

  if (total % 86_400 === 0) {
    return `${total / 86_400}d`;
  }
  if (total % 3600 === 0) {
    return `${total / 3600}h`;
  }
  if (total % 60 === 0) {
    return `${total / 60}m`;
  }

  return `${total}s`;
}

/**
 * The window a `rate()` needs at this step.
 *
 * Prometheus's own guidance is at least four scrape intervals; four steps is
 * the same reasoning expressed in the unit the chart controls. A window
 * narrower than the step samples the gaps between buckets and draws a sawtooth
 * that reads as real instability in the service.
 */
export function rateInterval(
  stepSeconds: number,
  scrapeIntervalSeconds = DEFAULT_SCRAPE_INTERVAL_SECONDS,
): number {
  return Math.max(stepSeconds * 4, scrapeIntervalSeconds * 4);
}

/** Escape a value so it is a literal inside a PromQL regex matcher. */
function escapeRegexValue(value: string): string {
  return escapePromqlString(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

function renderValue(value: string | string[]): string {
  const values = Array.isArray(value) ? value : [value];

  if (values.includes(VARIABLE_ALL_SENTINEL)) {
    return '.+';
  }

  if (values.length === 0) {
    // Nothing selected matches nothing, and saying so explicitly beats leaving
    // an empty alternation that PromQL reads as "the empty string".
    return '.+';
  }

  if (values.length === 1) {
    return escapeRegexValue(values[0] as string);
  }

  return `(${values.map(escapeRegexValue).join('|')})`;
}

/**
 * Variables an expression refers to, excluding the `$__*` built-ins.
 *
 * Used to refetch only the panels a changed variable actually affects, which is
 * the difference between changing `$service` on a twelve-panel dashboard and
 * reloading all twelve.
 */
export function referencedVariables(expr: string): string[] {
  const out = new Set<string>();

  for (const match of expr.matchAll(VARIABLE_RE)) {
    const name = (match[1] ?? match[2]) as string;

    if (!name.startsWith('__')) {
      out.add(name);
    }
  }

  return [...out];
}

/**
 * Substitute variables and the `$__*` built-ins into an expression.
 *
 * An unknown variable is LEFT AS WRITTEN rather than removed or defaulted. The
 * rewriter parses what comes out and refuses anything it cannot understand, so
 * a typo surfaces as "not valid PromQL" pointing at the text the user wrote —
 * where dropping it would silently widen the selection to every series.
 */
export function substituteVariables(
  expr: string,
  values: IVariableValues | undefined,
  opts: SubstituteOptions,
): string {
  const scrape = opts.scrapeIntervalSeconds ?? DEFAULT_SCRAPE_INTERVAL_SECONDS;

  return expr.replace(VARIABLE_RE, (whole, braced?: string, bare?: string) => {
    const name = (braced ?? bare) as string;

    switch (name) {
      case '__rate_interval':
        return formatPromDuration(rateInterval(opts.step, scrape));
      case '__interval':
        return formatPromDuration(opts.step);
      case '__range':
        return formatPromDuration(opts.rangeSeconds);
      default:
        break;
    }

    const value = values?.[name];

    return value === undefined ? whole : renderValue(value);
  });
}
