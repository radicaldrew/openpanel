// @vitest-environment jsdom
/**
 * Renders the layer inside a real Recharts chart.
 *
 * This exists because the failure mode here is SILENT. Recharts finds its
 * reference elements by inspecting child types, so an annotation layer wrapped
 * in a component of our own renders nothing at all — no error, no warning, an
 * empty chart that looks exactly like a chart with no annotations. A test that
 * only checked `positionAnnotations` would pass while the feature was
 * completely broken on screen.
 *
 * Run with: cd apps/start && NITRO=1 npx vitest run src/components/annotations
 */
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { LineChart, Line, XAxis } from 'recharts';

import type { IAnnotation } from './annotation-utils';
import { renderAnnotations } from './annotations-layer';

afterEach(cleanup);

const at = (iso: string) => new Date(iso).getTime();

const domain = {
  start: at('2026-09-07T00:00:00.000Z'),
  end: at('2026-09-08T00:00:00.000Z'),
};

const annotation = (overrides: Partial<IAnnotation> = {}): IAnnotation => ({
  id: 'a1',
  projectId: 'p1',
  dashboardId: null,
  time: new Date('2026-09-07T12:00:00.000Z'),
  timeEnd: null,
  text: 'Deployed v2',
  tags: ['deploy'],
  createdBy: 'user_1',
  source: 'manual',
  createdAt: new Date('2026-09-07T12:00:00.000Z'),
  ...overrides,
});

const data = [
  { timestamp: domain.start, count: 1 },
  { timestamp: domain.end, count: 2 },
];

/** A chart shaped like the real line panel: numeric UTC x-axis on `timestamp`. */
function Chart({ annotations }: { annotations: React.ReactNode }) {
  return (
    <LineChart width={600} height={300} data={data}>
      <XAxis
        dataKey="timestamp"
        type="number"
        scale="utc"
        domain={['dataMin', 'dataMax']}
      />
      <Line dataKey="count" isAnimationActive={false} />
      {annotations}
    </LineChart>
  );
}

describe('the layer actually reaches the plot area', () => {
  it('draws a point annotation Recharts can see', () => {
    const { container } = render(
      <Chart
        annotations={renderAnnotations({
          annotations: [annotation()],
          domain,
        })}
      />,
    );

    // The marker group is rendered through Recharts' own label pipeline, which
    // only happens if Recharts recognised the ReferenceLine as its child.
    expect(container.querySelector('[data-annotation-id="a1"]')).not.toBeNull();
    expect(container.querySelector('.recharts-reference-line')).not.toBeNull();
  });

  it('draws a span as a reference area', () => {
    const { container } = render(
      <Chart
        annotations={renderAnnotations({
          annotations: [
            annotation({
              id: 'span',
              timeEnd: new Date('2026-09-07T18:00:00.000Z'),
            }),
          ],
          domain,
        })}
      />,
    );

    expect(container.querySelector('.recharts-reference-area')).not.toBeNull();
    expect(
      container.querySelector('[data-annotation-id="span"]'),
    ).not.toBeNull();
  });

  it('shows the text and tags as a hover title', () => {
    const { container } = render(
      <Chart
        annotations={renderAnnotations({
          annotations: [annotation()],
          domain,
        })}
      />,
    );

    const marker = container.querySelector('[data-annotation-id="a1"]');

    expect(marker?.querySelector('title')?.textContent).toBe(
      'Deployed v2 [deploy]',
    );
  });

  it('calls onSelect when the marker is clicked', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <Chart
        annotations={renderAnnotations({
          annotations: [annotation()],
          domain,
          onSelect,
        })}
      />,
    );

    const marker = container.querySelector(
      '[data-annotation-id="a1"]',
    ) as SVGGElement;
    marker.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'a1' }),
    );
  });

  it('renders nothing when every annotation is off screen', () => {
    const { container } = render(
      <Chart
        annotations={renderAnnotations({
          annotations: [annotation({ time: new Date('2026-01-01T00:00:00Z') })],
          domain,
        })}
      />,
    );

    expect(container.querySelector('.recharts-reference-line')).toBeNull();
  });

  it('draws spans behind points', () => {
    // Recharts draws reference elements in child order and z-index does not
    // apply inside the SVG, so order is the only control.
    const { container } = render(
      <Chart
        annotations={renderAnnotations({
          annotations: [
            annotation({ id: 'point' }),
            annotation({
              id: 'span',
              timeEnd: new Date('2026-09-07T18:00:00.000Z'),
            }),
          ],
          domain,
        })}
      />,
    );

    const html = container.innerHTML;

    expect(html.indexOf('data-annotation-id="span"')).toBeLessThan(
      html.indexOf('data-annotation-id="point"'),
    );
  });
});
