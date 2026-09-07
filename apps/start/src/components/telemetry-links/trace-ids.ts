/**
 * Finding a trace id inside a log line.
 *
 * The envelope already carries one — `line.traceId` — when the collector filled
 * it in, and that is always preferred. This is for everything else: a service
 * that logs its own correlation id into the message, a proxy that echoes the
 * W3C `traceparent` header, a framework that prints `trace_id=…` and nothing
 * more. Those lines are exactly the ones nobody can follow by hand, because a
 * 32-character hex string is not something a person retypes.
 *
 * The rule throughout is that a match must be UNAMBIGUOUS. A bare 32-hex string
 * in a line is not necessarily a trace id — it is also what a git object, an MD5
 * digest and a request signature look like — so nothing is matched without
 * either a key naming it or the `traceparent` structure around it. A wrong link
 * is worse than no link: it navigates away from the line the user was reading
 * and lands on an empty trace.
 *
 * The same rule rejects the all-zero id, which is the single highest-volume way
 * to get a link that goes nowhere — see {@link isAllZero}.
 */

/**
 * `trace_id=…`, `traceId: …`, `trace-id "…"`, and the `tid` the log envelope
 * uses. The id itself is 16 or 32 hex characters — 32 is the W3C length, 16 is
 * what some older SDKs emit — and is followed by a word boundary so a longer
 * hex blob is not silently truncated into a "match".
 */
const KEYED_TRACE_ID =
  /\b(?:trace[_-]?id|traceid|tid)\b["']?\s*[=:]\s*["']?([0-9a-f]{16}|[0-9a-f]{32})\b/gi;

/**
 * A W3C traceparent: version, trace id, span id, flags. Matched with or without
 * the `traceparent=` key, because the header value on its own is distinctive
 * enough — four hex groups of exactly the right lengths, hyphen separated.
 */
const TRACEPARENT =
  /\b(?:traceparent["']?\s*[=:]\s*["']?)?([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})\b/gi;

/**
 * OpenTelemetry's `INVALID_TRACE_ID`, and its span-id equivalent.
 *
 * This is not a malformed id, which is why the shape checks above let it
 * through: it is the id a log-correlation formatter emits UNCONDITIONALLY when
 * there is no active span — sampling disabled, a background worker, anything
 * logged before the first span opens. In a real deployment that is a large
 * share of lines, not an edge case, and every one of them would otherwise get a
 * link to an empty waterfall.
 */
function isAllZero(hex: string): boolean {
  return /^0+$/.test(hex);
}

export interface TraceIdMatch {
  /** Lowercased: the log envelope stores hex lowercase and the search is exact. */
  id: string;
  /** Offset of the ID ITSELF, not of the key that introduced it. */
  from: number;
  to: number;
}

/**
 * Every trace id in a line, in the order they appear, without overlaps.
 *
 * `traceparent` is scanned first because its trace id sits inside a structure a
 * keyed match could also see; taking the structured reading first and then
 * discarding any keyed match that overlaps it means `traceparent=00-abc…-def…-01`
 * yields one id rather than two.
 */
export function findTraceIds(text: string): TraceIdMatch[] {
  const matches: TraceIdMatch[] = [];

  const push = (id: string | undefined, index: number) => {
    if (!id || isAllZero(id)) {
      return;
    }

    const from = text.indexOf(id, index);

    if (from === -1) {
      return;
    }

    const to = from + id.length;

    // Overlapping matches are the same id read two ways.
    if (matches.some((match) => from < match.to && to > match.from)) {
      return;
    }

    matches.push({ id: id.toLowerCase(), from, to });
  };

  TRACEPARENT.lastIndex = 0;
  let traceparent = TRACEPARENT.exec(text);
  while (traceparent !== null) {
    const [, version, traceId, spanId] = traceparent;

    // W3C reserves version `ff` as invalid and says a parser must reject it.
    // Nothing emits one, but the version is captured anyway, so honouring it
    // makes the structural match mean what it claims to.
    //
    // An all-zero SPAN id marks the same "no active span" case the all-zero
    // trace id does, and the pair travels together.
    if (
      version !== 'ff' &&
      !(spanId && isAllZero(spanId))
    ) {
      push(traceId, traceparent.index);
    }

    traceparent = TRACEPARENT.exec(text);
  }

  KEYED_TRACE_ID.lastIndex = 0;
  let keyed = KEYED_TRACE_ID.exec(text);
  while (keyed !== null) {
    push(keyed[1], keyed.index);
    keyed = KEYED_TRACE_ID.exec(text);
  }

  return matches.sort((a, b) => a.from - b.from);
}

/** The first id in a line, which is what a per-line link uses. */
export function firstTraceId(text: string): string | undefined {
  return findTraceIds(text)[0]?.id;
}

export type LineSegment = {
  /** Offset into the original line. A real identity, so it can be a React key. */
  from: number;
} & (
  | { kind: 'text'; text: string }
  | { kind: 'trace'; text: string; traceId: string }
);

/**
 * A line split into plain runs and trace ids, ready to render.
 *
 * Returned as data rather than as markup so the splitting can be tested
 * without a DOM, and so the caller decides what a link looks like.
 */
export function splitTraceIds(text: string): LineSegment[] {
  const matches = findTraceIds(text);

  if (matches.length === 0) {
    return [{ kind: 'text', from: 0, text }];
  }

  const segments: LineSegment[] = [];
  let cursor = 0;

  for (const match of matches) {
    if (match.from > cursor) {
      segments.push({
        kind: 'text',
        from: cursor,
        text: text.slice(cursor, match.from),
      });
    }

    segments.push({
      kind: 'trace',
      from: match.from,
      text: text.slice(match.from, match.to),
      traceId: match.id,
    });

    cursor = match.to;
  }

  if (cursor < text.length) {
    segments.push({ kind: 'text', from: cursor, text: text.slice(cursor) });
  }

  return segments;
}
