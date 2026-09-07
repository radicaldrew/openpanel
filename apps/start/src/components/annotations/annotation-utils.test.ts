import { describe, expect, it } from 'vitest';

import {
  type IAnnotation,
  annotationLabel,
  collectTags,
  defaultRangeEnd,
  filterByTags,
  positionAnnotations,
} from './annotation-utils';

const at = (iso: string) => new Date(iso).getTime();

const annotation = (overrides: Partial<IAnnotation> = {}): IAnnotation => ({
  id: 'a1',
  projectId: 'p1',
  dashboardId: null,
  time: new Date('2026-09-07T12:00:00.000Z'),
  timeEnd: null,
  text: 'Deployed v2',
  tags: [],
  createdBy: 'user_1',
  source: 'manual',
  createdAt: new Date('2026-09-07T12:00:00.000Z'),
  ...overrides,
});

const domain = {
  start: at('2026-09-07T00:00:00.000Z'),
  end: at('2026-09-08T00:00:00.000Z'),
};

describe('only what is on screen is drawn', () => {
  it('keeps a point inside the window', () => {
    const [first] = positionAnnotations([annotation()], domain);

    expect(first?.start).toBe(at('2026-09-07T12:00:00.000Z'));
    expect(first?.end).toBeNull();
  });

  it('drops a point outside the window rather than clamping it', () => {
    // Clamping would pin last week's deploy to the left edge of today's chart,
    // which reads as "this happened at the start of this window".
    const before = annotation({ time: new Date('2026-09-01T00:00:00.000Z') });
    const after = annotation({ time: new Date('2026-09-09T00:00:00.000Z') });

    expect(positionAnnotations([before, after], domain)).toEqual([]);
  });

  it('keeps a point exactly on either boundary', () => {
    const start = annotation({ time: new Date('2026-09-07T00:00:00.000Z') });
    const end = annotation({ time: new Date('2026-09-08T00:00:00.000Z') });

    expect(positionAnnotations([start, end], domain)).toHaveLength(2);
  });

  it('clips a span that starts before the window', () => {
    // Recharts stretches the axis to reach an off-domain ReferenceArea, so an
    // unclipped span would silently rescale the chart.
    const [first] = positionAnnotations(
      [
        annotation({
          time: new Date('2026-09-06T00:00:00.000Z'),
          timeEnd: new Date('2026-09-07T06:00:00.000Z'),
        }),
      ],
      domain,
    );

    expect(first?.start).toBe(domain.start);
    expect(first?.end).toBe(at('2026-09-07T06:00:00.000Z'));
  });

  it('clips a span that runs past the window', () => {
    const [first] = positionAnnotations(
      [
        annotation({
          time: new Date('2026-09-07T18:00:00.000Z'),
          timeEnd: new Date('2026-09-10T00:00:00.000Z'),
        }),
      ],
      domain,
    );

    expect(first?.end).toBe(domain.end);
  });

  it('keeps a span that straddles the whole window', () => {
    const [first] = positionAnnotations(
      [
        annotation({
          time: new Date('2026-09-01T00:00:00.000Z'),
          timeEnd: new Date('2026-09-20T00:00:00.000Z'),
        }),
      ],
      domain,
    );

    expect(first).toMatchObject({ start: domain.start, end: domain.end });
  });

  it('drops a span entirely outside the window', () => {
    expect(
      positionAnnotations(
        [
          annotation({
            time: new Date('2026-09-01T00:00:00.000Z'),
            timeEnd: new Date('2026-09-02T00:00:00.000Z'),
          }),
        ],
        domain,
      ),
    ).toEqual([]);
  });

  it('reads a backwards span as a bad row, not a backwards span', () => {
    const [first] = positionAnnotations(
      [
        annotation({
          time: new Date('2026-09-07T18:00:00.000Z'),
          timeEnd: new Date('2026-09-07T06:00:00.000Z'),
        }),
      ],
      domain,
    );

    expect(first?.start).toBe(at('2026-09-07T06:00:00.000Z'));
    expect(first?.end).toBe(at('2026-09-07T18:00:00.000Z'));
  });

  it('skips a row with an unparseable time instead of throwing', () => {
    const bad = annotation({ time: new Date('nonsense') });

    expect(positionAnnotations([bad, annotation()], domain)).toHaveLength(1);
  });

  it('returns nothing for an inverted domain', () => {
    // Happens for one render while a chart with no data resolves its axis.
    expect(
      positionAnnotations([annotation()], { start: domain.end, end: domain.start }),
    ).toEqual([]);
  });

  it('orders by start so overlapping markers stack stably', () => {
    const late = annotation({ id: 'late', time: new Date('2026-09-07T18:00:00.000Z') });
    const early = annotation({ id: 'early', time: new Date('2026-09-07T06:00:00.000Z') });

    expect(
      positionAnnotations([late, early], domain).map((a) => a.annotation.id),
    ).toEqual(['early', 'late']);
  });
});

describe('tag filtering', () => {
  const deploy = annotation({ id: 'd', tags: ['deploy'] });
  const incident = annotation({ id: 'i', tags: ['incident', 'sev2'] });
  const untagged = annotation({ id: 'u', tags: [] });
  const all = [deploy, incident, untagged];

  it('collects every tag, sorted and deduplicated', () => {
    expect(collectTags(all)).toEqual(['deploy', 'incident', 'sev2']);
  });

  it('treats an empty selection as no filter', () => {
    expect(filterByTags(all, [])).toEqual(all);
  });

  it('matches any selected tag, not all of them', () => {
    // Requiring every tag would make selecting two tags usually show nothing.
    expect(filterByTags(all, ['deploy', 'incident']).map((a) => a.id)).toEqual([
      'd',
      'i',
    ]);
  });

  it('drops untagged annotations once a filter is on', () => {
    expect(filterByTags(all, ['deploy']).map((a) => a.id)).toEqual(['d']);
  });

  it('matches an annotation on any one of its own tags', () => {
    expect(filterByTags(all, ['sev2']).map((a) => a.id)).toEqual(['i']);
  });
});

describe('range prefill', () => {
  const time = new Date('2026-09-07T12:00:00.000Z');

  it('defaults the end to one bucket later', () => {
    // A zero-width ReferenceArea draws nothing, so ticking "range" has to
    // produce a visible span or the checkbox appears to do nothing.
    expect(defaultRangeEnd(time, 'hour').toISOString()).toBe(
      '2026-09-07T13:00:00.000Z',
    );
    expect(defaultRangeEnd(time, 'minute').toISOString()).toBe(
      '2026-09-07T12:01:00.000Z',
    );
    expect(defaultRangeEnd(time, 'day').toISOString()).toBe(
      '2026-09-08T12:00:00.000Z',
    );
  });

  it('falls back to an hour for an interval it does not know', () => {
    expect(defaultRangeEnd(time, 'fortnight').toISOString()).toBe(
      '2026-09-07T13:00:00.000Z',
    );
  });

  it('is always after the start', () => {
    for (const interval of ['minute', 'hour', 'day', 'week', 'month']) {
      expect(defaultRangeEnd(time, interval).getTime()).toBeGreaterThan(
        time.getTime(),
      );
    }
  });
});

describe('label', () => {
  it('appends the tags', () => {
    expect(annotationLabel(annotation({ tags: ['deploy', 'api'] }))).toBe(
      'Deployed v2 [deploy, api]',
    );
  });

  it('is just the text when there are none', () => {
    expect(annotationLabel(annotation())).toBe('Deployed v2');
  });
});
