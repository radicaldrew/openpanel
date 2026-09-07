/**
 * Series naming for PromQL panels.
 *
 * A legend is the only thing that tells two lines apart, so every branch here
 * exists to avoid the two failure modes that make a multi-query panel useless:
 * several lines rendered under the same name, and a line rendered under a name
 * that is an internal identifier.
 */

/**
 * The tenancy label, stripped from every legend.
 *
 * Duplicated from `@openpanel/gigapipe`'s `PROJECT_LABEL` rather than imported:
 * this module is browser-safe and dependency-free by contract, and gigapipe
 * pulls in the lezer PromQL grammar. The constant is a wire format, not a
 * setting — it is the label written at ingest — so a copy cannot drift without
 * the ingest path changing too.
 */
const PROJECT_LABEL = 'op_project_id';

/** Prometheus's own name label, which is the metric name, not a breakdown. */
const NAME_LABEL = '__name__';

/** `{{method}}`, `{{ status }}`, `{{__refId}}`. */
const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

export interface LegendContext {
  /** The query this series came from: 'A', 'B', … */
  refId: string;
  /**
   * Whether the panel runs more than one visible query.
   *
   * Controls how a label set is rendered when there is no `legendFormat`. With
   * one query the labels alone identify a line, so the bare values read best —
   * `GET 200`, matching how the structured metrics adapter has always named a
   * breakdown. With several queries two lines can carry the same values from
   * different expressions, so the keys have to be visible: `{method="GET"}`.
   */
  multi: boolean;
}

function labelsWithoutInternals(
  labels: Record<string, string>,
): [string, string][] {
  return Object.entries(labels)
    .filter(
      ([key, value]) =>
        key !== PROJECT_LABEL && key !== NAME_LABEL && value !== '',
    )
    .sort(([a], [b]) => a.localeCompare(b));
}

/**
 * Build the display name for one series.
 *
 * Order: the user's `legendFormat` if it renders to anything; then the
 * distinguishing labels; then the metric name; then the query's refId, which
 * always exists and so guarantees a name.
 *
 * A `legendFormat` whose placeholders all resolve to nothing falls through
 * rather than producing an empty legend — `{{pod}}` on a query that does not
 * group by pod would otherwise render every line as a blank string.
 */
export function formatLegend(
  legendFormat: string | undefined,
  labels: Record<string, string>,
  ctx: LegendContext,
): string {
  if (legendFormat && legendFormat.trim() !== '') {
    const rendered = legendFormat
      .replace(PLACEHOLDER_RE, (_, name: string) =>
        name === '__refId' ? ctx.refId : (labels[name] ?? ''),
      )
      .trim();

    if (rendered !== '') {
      return rendered;
    }
  }

  const relevant = labelsWithoutInternals(labels);

  if (relevant.length > 0) {
    return ctx.multi
      ? `{${relevant.map(([key, value]) => `${key}="${value}"`).join(', ')}}`
      : relevant.map(([, value]) => value).join(' ');
  }

  const metricName = labels[NAME_LABEL];
  if (metricName) {
    return metricName;
  }

  return ctx.refId;
}

/**
 * Variables a legend format refers to, so the editor can warn about a
 * placeholder no query produces.
 */
export function legendPlaceholders(legendFormat: string): string[] {
  const out = new Set<string>();

  for (const match of legendFormat.matchAll(PLACEHOLDER_RE)) {
    out.add(match[1] as string);
  }

  return [...out];
}
