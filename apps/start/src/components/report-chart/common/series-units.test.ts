import type { IChartSerie, IPromqlUnit } from '@openpanel/validation';
import { describe, expect, it } from 'vitest';
import {
  axisUnit,
  hasRightAxis,
  lastValue,
  serieAxis,
  seriesPanels,
  showsSumColumn,
} from './series-units';

const serie = (
  panel?: { unit: IPromqlUnit; yAxis?: 'left' | 'right' },
): { panel?: IChartSerie['panel'] } =>
  panel
    ? { panel: { refId: 'A', unit: panel.unit, yAxis: panel.yAxis ?? 'left' } }
    : {};

describe('serieAxis', () => {
  it('is left for an events series, which has no panel', () => {
    expect(serieAxis(serie())).toBe('left');
  });

  it('reads the axis the query asked for', () => {
    expect(serieAxis(serie({ unit: 'seconds', yAxis: 'right' }))).toBe('right');
  });
});

describe('hasRightAxis', () => {
  it('is false for an events report', () => {
    expect(hasRightAxis([serie(), serie()])).toBe(false);
  });

  it('is true as soon as one query asks for the right axis', () => {
    expect(
      hasRightAxis([serie({ unit: 'ops' }), serie({ unit: 'seconds', yAxis: 'right' })]),
    ).toBe(true);
  });
});

describe('axisUnit', () => {
  it('is the shared unit of the series on that axis', () => {
    const series = [
      serie({ unit: 'ops' }),
      serie({ unit: 'ops' }),
      serie({ unit: 'seconds', yAxis: 'right' }),
    ];

    expect(axisUnit(series, 'left')).toBe('ops');
    expect(axisUnit(series, 'right')).toBe('seconds');
  });

  it('is undefined when the series on one axis disagree', () => {
    // Two units on one axis have no shared tick format; labelling a byte count
    // as seconds is worse than labelling neither.
    expect(
      axisUnit([serie({ unit: 'bytes' }), serie({ unit: 'seconds' })], 'left'),
    ).toBeUndefined();
  });

  it('is undefined for an events report', () => {
    expect(axisUnit([serie(), serie()], 'left')).toBeUndefined();
  });

  it('is undefined for an axis nothing is drawn on', () => {
    expect(axisUnit([serie({ unit: 'ops' })], 'right')).toBeUndefined();
  });
});

describe('showsSumColumn', () => {
  const cases: [string, { panel?: IChartSerie['panel'] }[], boolean][] = [
    ['an events report', [serie(), serie()], true],
    ['an empty chart', [], true],
    ['counts and rates', [serie({ unit: 'none' }), serie({ unit: 'ops' })], true],
    ['short numbers', [serie({ unit: 'short' })], true],
    ['latencies alone', [serie({ unit: 'seconds' })], false],
    ['bytes alone', [serie({ unit: 'bytes' })], false],
    ['percentages alone', [serie({ unit: 'percent' })], false],
    ['milliseconds alone', [serie({ unit: 'ms' })], false],
    [
      'one additive series among latencies, which keeps Sum meaningful for it',
      [serie({ unit: 'seconds' }), serie({ unit: 'ops' })],
      true,
    ],
    [
      'a metrics panel mixed with an events series',
      [serie({ unit: 'seconds' }), serie()],
      true,
    ],
  ];

  for (const [name, series, expected] of cases) {
    it(`${name} → ${expected}`, () => {
      expect(showsSumColumn(series)).toBe(expected);
    });
  }
});

describe('lastValue', () => {
  const point = (count: number) => ({ date: '', count });

  it('is the final point of a range series', () => {
    expect(lastValue({ data: [point(1), point(2), point(3)] })).toBe(3);
  });

  it('is the single point of an instant series', () => {
    expect(lastValue({ data: [point(42)] })).toBe(42);
  });

  it('keeps a trailing zero, which is a real measurement', () => {
    expect(lastValue({ data: [point(5), point(0)] })).toBe(0);
  });

  it('skips a non-finite trailing value', () => {
    expect(
      lastValue({ data: [point(5), point(Number.NaN)] }),
    ).toBe(5);
  });

  it('is undefined for a series with no data', () => {
    expect(lastValue({ data: [] })).toBeUndefined();
  });
});

describe('seriesPanels', () => {
  it('keys panel metadata by series id', () => {
    const map = seriesPanels([
      { id: 'A:x', ...serie({ unit: 'ops' }) },
      { id: 'B:y', ...serie({ unit: 'seconds', yAxis: 'right' }) },
    ]);

    expect(map.get('A:x')?.unit).toBe('ops');
    expect(map.get('B:y')?.yAxis).toBe('right');
  });

  it('omits events series, which have no panel', () => {
    expect(seriesPanels([{ id: 'a', ...serie() }]).size).toBe(0);
  });
});
