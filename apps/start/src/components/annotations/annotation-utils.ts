/**
 * Annotations: points and spans marked on a metric chart — a deploy, an
 * incident, a note.
 *
 * The pure half. What a chart draws is decided entirely by the annotation rows
 * and the chart's own time domain, and getting that wrong is quiet (a marker
 * on the wrong bucket looks exactly like a marker on the right one), so it is
 * separated from the rendering and tested directly.
 */

/** One annotation row, as `annotation.list` returns it (superjson keeps Dates). */
export type IAnnotation = {
  id: string;
  projectId: string;
  dashboardId: string | null;
  time: Date;
  timeEnd: Date | null;
  text: string;
  tags: string[];
  createdBy: string | null;
  source: string;
  createdAt: Date;
};

/** The chart's x-axis domain, in epoch ms — the units `dataKey: 'timestamp'` uses. */
export type ITimeDomain = { start: number; end: number };

/** An annotation positioned on that axis. A point has `end === null`. */
export type IPositionedAnnotation = {
  annotation: IAnnotation;
  start: number;
  end: number | null;
};

/**
 * The annotations that intersect the chart's window, positioned in epoch ms.
 *
 * A span that starts before the window but runs into it is on screen and must
 * be drawn — clipped to the domain, because Recharts will happily place a
 * `ReferenceArea` off the end of the axis and stretch the plot to reach it.
 * A point outside the window is dropped entirely rather than clamped: clamping
 * would pin a deploy from last week onto the left edge of today's chart, which
 * reads as "this deploy happened at the start of this window".
 */
export function positionAnnotations(
  annotations: IAnnotation[],
  domain: ITimeDomain,
): IPositionedAnnotation[] {
  if (domain.end < domain.start) {
    return [];
  }

  const out: IPositionedAnnotation[] = [];

  for (const annotation of annotations) {
    const start = annotation.time.getTime();
    const end = annotation.timeEnd?.getTime() ?? null;

    if (Number.isNaN(start) || (end !== null && Number.isNaN(end))) {
      continue;
    }

    if (end === null) {
      if (start >= domain.start && start <= domain.end) {
        out.push({ annotation, start, end: null });
      }
      continue;
    }

    // A span whose end precedes its start is a bad row, not a backwards span.
    const from = Math.min(start, end);
    const to = Math.max(start, end);

    if (to < domain.start || from > domain.end) {
      continue;
    }

    out.push({
      annotation,
      start: Math.max(from, domain.start),
      end: Math.min(to, domain.end),
    });
  }

  // Earliest first, so overlapping markers stack in a stable order rather than
  // in whatever order the query returned.
  return out.sort((a, b) => a.start - b.start);
}

/** Every tag present, sorted, for the toolbar's filter. */
export function collectTags(annotations: IAnnotation[]): string[] {
  const tags = new Set<string>();

  for (const annotation of annotations) {
    for (const tag of annotation.tags) {
      tags.add(tag);
    }
  }

  return [...tags].sort();
}

/**
 * Filter by tag, matching ANY selected tag.
 *
 * Any rather than all: the filter is there to narrow a busy chart to "deploys"
 * or "incidents", and requiring every selected tag on one annotation would
 * make selecting two tags usually show nothing.
 *
 * An empty selection means no filter, not "annotations with no tags".
 */
export function filterByTags(
  annotations: IAnnotation[],
  selected: string[],
): IAnnotation[] {
  if (selected.length === 0) {
    return annotations;
  }

  const wanted = new Set(selected);

  return annotations.filter((annotation) =>
    annotation.tags.some((tag) => wanted.has(tag)),
  );
}

/** Bucket widths, in ms, for each interval the report can be drawn at. */
const INTERVAL_MS: Record<string, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_592_000_000,
};

/**
 * The end time to prefill when someone ticks "range" on a new annotation.
 *
 * One bucket after the clicked point, so the default span covers the bucket
 * that was actually clicked rather than being zero-width. A zero-width
 * `ReferenceArea` draws nothing at all, so the default has to be non-empty or
 * ticking the box appears to do nothing.
 */
export function defaultRangeEnd(time: Date, interval: string): Date {
  const step = INTERVAL_MS[interval] ?? INTERVAL_MS.hour!;

  return new Date(time.getTime() + step);
}

/** How an annotation reads in a tooltip: the text, then its tags. */
export function annotationLabel(annotation: IAnnotation): string {
  return annotation.tags.length > 0
    ? `${annotation.text} [${annotation.tags.join(', ')}]`
    : annotation.text;
}
