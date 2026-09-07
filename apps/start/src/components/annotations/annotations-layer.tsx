import type { ReactNode } from 'react';
import { ReferenceArea, ReferenceLine } from 'recharts';

import {
  type IAnnotation,
  type ITimeDomain,
  annotationLabel,
  positionAnnotations,
} from './annotation-utils';

/**
 * Deploy and incident markers drawn over a metric chart.
 *
 * A FUNCTION returning an ARRAY, and both halves of that are load-bearing.
 * Both were established by rendering against recharts 2.15.4 in
 * `annotations-layer.test.tsx` — neither is guesswork, and both fail SILENTLY.
 *
 * Recharts decides what to render, and where, by inspecting the TYPE of the
 * chart's children (`findAllByType` in recharts/lib/util/ReactUtils):
 *
 *  - a CUSTOM COMPONENT is invisible to it. `<AnnotationsLayer />` has the
 *    function as its type, so the reference elements inside would never be
 *    found. Hence a function the panel calls, not a component it renders.
 *
 *  - a FRAGMENT is invisible to it too, in this position. `toArray` looks as
 *    though it flattens fragments, but the categorical chart's render path
 *    does not reach that, and `<>{lines}</>` draws nothing. An ARRAY of
 *    elements does work. Hence the array return.
 *
 * Both mistakes render an empty chart with no error, which is
 * indistinguishable from a chart that simply has no annotations — so do not
 * "tidy" this into a component or a fragment.
 */
export function renderAnnotations({
  annotations,
  domain,
  onSelect,
}: {
  annotations: IAnnotation[];
  domain: ITimeDomain;
  onSelect?: (annotation: IAnnotation) => void;
}): ReactNode[] {
  const positioned = positionAnnotations(annotations, domain);

  if (positioned.length === 0) {
    return [];
  }

  // Spans first so they sit behind the point markers: Recharts draws reference
  // elements in child order, and z-index does not apply inside the SVG plot
  // area, so ordering here is the only control there is.
  const spans = positioned.filter((p) => p.end !== null);
  const points = positioned.filter((p) => p.end === null);

  const color = 'var(--color-chart-annotation, #f59e0b)';

  return [
    ...spans.map(({ annotation, start, end }) => (
      <ReferenceArea
        key={annotation.id}
        x1={start}
        x2={end as number}
        // Without this Recharts extends the axis to reach a band that touches
        // the domain edge, silently rescaling the chart.
        ifOverflow="hidden"
        fill={color}
        fillOpacity={0.12}
        stroke={color}
        strokeOpacity={0.4}
        onClick={onSelect ? () => onSelect(annotation) : undefined}
        label={renderMarkerLabel(annotation, onSelect, false)}
      />
    )),
    ...points.map(({ annotation, start }) => (
      <ReferenceLine
        key={annotation.id}
        x={start}
        ifOverflow="hidden"
        stroke={color}
        strokeWidth={1.5}
        strokeDasharray="4 3"
        onClick={onSelect ? () => onSelect(annotation) : undefined}
        label={renderMarkerLabel(annotation, onSelect, true)}
      />
    )),
  ];
}

/**
 * The hover target: a small triangle carrying an SVG `<title>`.
 *
 * `<title>` rather than a React tooltip because the marker lives inside the
 * SVG plot area, where a portal-based tooltip would be positioned against the
 * page rather than the chart. The browser's native tooltip is plain, but it is
 * correct at every zoom level and costs nothing.
 *
 * The label text itself is deliberately just a marker: at four deploys an hour
 * the texts overlap into an unreadable smear, so the words live in the hover
 * and in the popover the click opens.
 */
function renderMarkerLabel(
  annotation: IAnnotation,
  onSelect: ((annotation: IAnnotation) => void) | undefined,
  isPoint: boolean,
) {
  const label = annotationLabel(annotation);

  return (props: { viewBox?: { x?: number; y?: number; width?: number } }) => {
    const viewBox = props?.viewBox ?? {};
    const x = (viewBox.x ?? 0) + (isPoint ? 0 : (viewBox.width ?? 0) / 2);
    const y = viewBox.y ?? 0;

    return (
      <g
        transform={`translate(${x}, ${y})`}
        onClick={onSelect ? () => onSelect(annotation) : undefined}
        style={{ cursor: onSelect ? 'pointer' : 'default' }}
        data-annotation-id={annotation.id}
      >
        <title>{label}</title>
        {/* An invisible pad so the hover target is bigger than the glyph. */}
        <rect x={-6} y={-2} width={12} height={14} fill="transparent" />
        <text
          textAnchor="middle"
          y={9}
          fontSize={9}
          fill="var(--color-chart-annotation, #f59e0b)"
        >
          ▲
        </text>
      </g>
    );
  };
}
