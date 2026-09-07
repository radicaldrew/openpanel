import { createPanelQuery, nextRefId } from '@/components/promql/panel-query';
import { chartDateToIso } from '@/utils/chart-dates';
import type { FinalChart, IPanelQuery } from '@openpanel/validation';
import { zPanelQuery } from '@openpanel/validation';
import { createParser } from 'nuqs';
import { z } from 'zod';

/**
 * Explore's state, in the URL.
 *
 * The requirement (plan §8 item 4) is that a shared link reopens the page
 * IDENTICALLY, which is stricter than "close enough": the legends, the axes and
 * the units all have to come back, because those are what the person pasting
 * the link is pointing at. So everything the query rows display is encoded, and
 * the only thing left out is what can be re-derived — `builder`, which
 * `parseBuilderState` recovers from `expr` exactly.
 *
 * Keys are one character because this whole array lives in a query string that
 * people paste into chat. `{"expr":"…","legendFormat":"…","hidden":false}` per
 * query spends more of the URL on field names than on queries.
 */

/** The per-query URL shape. Absent optional keys mean the schema default. */
const zEncodedQuery = z.object({
  /** refId */
  r: z.string().min(1).max(4),
  /** expr */
  e: z.string().min(1).max(4000),
  /** legendFormat */
  l: z.string().max(200).optional(),
  /** hidden */
  h: z.literal(1).optional(),
  /** unit, omitted when 'none' */
  u: z.string().max(20).optional(),
  /** yAxis, present only for the right axis */
  y: z.literal('r').optional(),
  /** minStep */
  s: z.string().max(20).optional(),
  /** instant */
  i: z.literal(1).optional(),
  /**
   * Code mode. Only ever set when the expression WOULD have opened in the
   * builder — a query the builder cannot express opens in code anyway, so
   * spending a character on it would be noise.
   */
  c: z.literal(1).optional(),
});

const zEncodedQueries = z.array(zEncodedQuery).min(1).max(10);

export type EncodedQuery = z.infer<typeof zEncodedQuery>;

export function encodeQueries(queries: IPanelQuery[]): EncodedQuery[] {
  return queries
    .filter((query) => query.expr.trim() !== '')
    .map((query) => ({
      r: query.refId,
      e: query.expr,
      ...(query.legendFormat ? { l: query.legendFormat } : {}),
      ...(query.hidden ? { h: 1 as const } : {}),
      ...(query.unit !== 'none' ? { u: query.unit } : {}),
      ...(query.yAxis === 'right' ? { y: 'r' as const } : {}),
      ...(query.minStep ? { s: query.minStep } : {}),
      ...(query.instant ? { i: 1 as const } : {}),
      ...(query.mode === 'code' ? { c: 1 as const } : {}),
    }));
}

/**
 * Rebuild the query rows from the URL, or return null if the URL does not
 * describe any.
 *
 * Every field goes back through `zPanelQuery` rather than being trusted: this
 * is the one input to the page that a stranger can write, and a `unit` the
 * renderer does not know formats as a bare number with no error anywhere.
 * `mode` is left at whatever the row builder decides, because the Builder tab
 * re-derives its state from `expr` on open.
 */
export function decodeQueries(raw: unknown): IPanelQuery[] | null {
  const parsed = zEncodedQueries.safeParse(raw);

  if (!parsed.success) {
    return null;
  }

  const queries: IPanelQuery[] = [];

  for (const encoded of parsed.data) {
    const query = zPanelQuery.safeParse({
      refId: encoded.r,
      expr: encoded.e,
      legendFormat: encoded.l,
      hidden: encoded.h === 1,
      unit: encoded.u ?? 'none',
      yAxis: encoded.y === 'r' ? 'right' : 'left',
      minStep: encoded.s,
      instant: encoded.i === 1,
      mode: encoded.c === 1 ? 'code' : 'builder',
    });

    // One malformed query does not throw the rest of the link away — the
    // others still describe what the sender was looking at.
    if (query.success) {
      queries.push(query.data);
    }
  }

  return queries.length > 0 ? queries : null;
}

/**
 * The `q` parameter.
 *
 * `eq` compares the serialized form because nuqs uses it to decide whether a
 * write is a no-op, and these are fresh objects on every render.
 */
export const panelQueriesParser = createParser({
  parse: (value: string) => {
    try {
      return decodeQueries(JSON.parse(value));
    } catch {
      return null;
    }
  },
  serialize: (value: IPanelQuery[]) => JSON.stringify(encodeQueries(value)),
  eq: (a: IPanelQuery[], b: IPanelQuery[]) =>
    JSON.stringify(encodeQueries(a)) === JSON.stringify(encodeQueries(b)),
});

/**
 * A URL parameter validated by a zod schema.
 *
 * Used for the range, interval and chart type, whose legal values are unions
 * the rest of the app already owns. Re-listing them here is how a picker and a
 * URL end up disagreeing after someone adds a range — this way the parameter
 * accepts exactly what the schema does, and a value it does not is dropped
 * rather than passed to a server that will reject it.
 */
export function zodParser<T extends string>(schema: z.ZodType<T>) {
  return createParser({
    parse: (value: string) => {
      const parsed = schema.safeParse(value);
      return parsed.success ? parsed.data : null;
    },
    serialize: (value: T) => value,
  });
}

/** The row Explore starts with when the URL says nothing. */
export function initialQueries(): IPanelQuery[] {
  return [createPanelQuery('A')];
}

export function appendQuery(
  queries: IPanelQuery[],
  overrides?: Partial<IPanelQuery>,
): IPanelQuery[] {
  return [...queries, createPanelQuery(nextRefId(queries), overrides)];
}

/**
 * The window the chart is actually drawn over.
 *
 * Taken from the returned buckets rather than from the range picker, because
 * the picker's value may be a preset — `7d`, `lastMonth` — and resolving one to
 * two timestamps is the server's job: it does it in the PROJECT's timezone, and
 * a browser doing it in the viewer's would shift every zoom by the offset
 * between them. The engine fills the bucket grid across the whole requested
 * window, so the first and last bucket are that window.
 */
export function windowFromChart(
  chart: FinalChart | undefined,
): { startDate: string; endDate: string } | null {
  const points = chart?.series?.[0]?.data;

  if (!points || points.length === 0) {
    return null;
  }

  const first = points[0]?.date;
  const last = points.at(-1)?.date;

  if (!(first && last)) {
    return null;
  }

  // Normalised on the way out, not on the way in to `zoomOut`. A bucket date is
  // `formatClickhouseDate` output — a UTC instant with no zone marker — and
  // `new Date()` reads that as LOCAL time, so every consumer of this window
  // would otherwise be shifted by the viewer's UTC offset. See chart-dates.ts.
  return { startDate: chartDateToIso(first), endDate: chartDateToIso(last) };
}

export interface TimeWindow {
  startDate: string;
  endDate: string;
}

/**
 * Double the window.
 *
 * Centred, EXCEPT when the window already ends at the present: someone looking
 * at the last hour and pressing zoom out wants the last two hours, not thirty
 * minutes of empty future beside ninety minutes of data. The tolerance absorbs
 * the gap between "the last bucket the engine drew" and "now", which is up to
 * one bucket wide and is not a signal that the user was looking at the past.
 */
const LIVE_EDGE_TOLERANCE_MS = 5 * 60 * 1000;

export function zoomOut(window: TimeWindow, now: Date = new Date()): TimeWindow {
  const start = new Date(window.startDate).getTime();
  const end = new Date(window.endDate).getTime();

  if (!(Number.isFinite(start) && Number.isFinite(end) && end > start)) {
    return window;
  }

  const span = end - start;
  const endsNow = now.getTime() - end < LIVE_EDGE_TOLERANCE_MS;

  if (endsNow) {
    return {
      startDate: new Date(end - span * 2).toISOString(),
      endDate: new Date(end).toISOString(),
    };
  }

  return {
    startDate: new Date(start - span / 2).toISOString(),
    endDate: new Date(end + span / 2).toISOString(),
  };
}

/**
 * The expressions a Run should write to the history, given what the last Run
 * wrote.
 *
 * The server already drops a repeat of the user's most recent expression, but
 * it compares against ONE row: a panel with A and B re-run unchanged would
 * write B, then A, then B again on the next Run, because neither is ever the
 * immediately preceding row. Deduplicating the whole set here is what makes
 * "run it again to watch it move" not fill the drawer.
 *
 * Hidden queries are left out because they did not run.
 */
export function exprsToRecord(
  queries: IPanelQuery[],
  lastRecorded: readonly string[],
): string[] {
  const seen = new Set(lastRecorded);
  const out: string[] = [];

  for (const query of queries) {
    const expr = query.expr.trim();

    if (query.hidden || expr === '' || seen.has(expr)) {
      continue;
    }

    seen.add(expr);
    out.push(expr);
  }

  return out;
}
