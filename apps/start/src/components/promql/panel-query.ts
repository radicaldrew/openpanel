import type { IPanelQuery, IPromqlBuilderState } from '@openpanel/validation';

/**
 * Making a new query row, in one place.
 *
 * Shared by the report editor's redux slice, the metrics explorer and the query
 * list itself, because every one of them needs the same two things: a refId
 * nobody else is using, and every defaulted field of `zPanelQuery` spelled out.
 * The defaults matter — `mode`, `hidden`, `unit`, `yAxis` and `instant` all
 * carry a zod `.default()`, so the INFERRED type has them required, and a row
 * built without them does not typecheck as an `IPanelQuery`.
 */

/** `zReportInput` caps a panel at ten queries. */
export const MAX_PANEL_QUERIES = 10;

const REF_IDS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

/**
 * The first letter no query in the panel is using.
 *
 * Reusing the letter of a deleted query is deliberate: refIds appear in legends
 * and in error messages ("Query B: …"), and a panel that has had rows added and
 * removed should read A, B, C rather than A, D, G.
 */
export function nextRefId(queries: { refId: string }[]): string {
  const taken = new Set(queries.map((query) => query.refId));
  const free = REF_IDS.find((id) => !taken.has(id));

  // Only reachable past 26 queries, which the schema's max of ten already
  // rules out; falling back to a number keeps this total rather than throwing
  // inside a reducer.
  return free ?? String(queries.length + 1);
}

export function createPanelQuery(
  refId: string,
  overrides: Partial<IPanelQuery> = {},
): IPanelQuery {
  return {
    refId,
    expr: '',
    mode: 'builder',
    hidden: false,
    unit: 'none',
    yAxis: 'left',
    instant: false,
    ...overrides,
  };
}

/** A query seeded from builder state, for the query-pattern menu. */
export function createBuilderQuery(
  refId: string,
  builder: IPromqlBuilderState,
  expr: string,
): IPanelQuery {
  return createPanelQuery(refId, { mode: 'builder', builder, expr });
}
