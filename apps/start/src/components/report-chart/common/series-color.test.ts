import { chartColors } from '@openpanel/constants';
import { describe, expect, it } from 'vitest';
import { type ColorableSerie, seriesColorIndexes, serieColorIndex } from './series-color';

const panel = (refId: string) =>
  ({ refId, unit: 'none', yAxis: 'left' }) as const;

const metricSerie = (id: string): ColorableSerie => ({ id, panel: panel('A') });
const eventSerie = (id: string): ColorableSerie => ({ id });

describe('events reports are untouched', () => {
  it('returns null when no series carries panel metadata', () => {
    expect(seriesColorIndexes([eventSerie('a'), eventSerie('b')])).toBeNull();
  });

  it('falls back to the series index when there is no map', () => {
    expect(serieColorIndex({ id: 'a', index: 3 }, null)).toBe(3);
  });

  it('returns null for an empty chart', () => {
    expect(seriesColorIndexes([])).toBeNull();
  });
});

describe('a colour follows the series, not its rank', () => {
  const ids = ['A:method=GET', 'A:method=POST', 'B:le=0.5', 'B:le=0.99'];

  it('gives the same answer whatever order the series arrive in', () => {
    // This is the actual bug: `format()` sorts by sum descending, so the array
    // order changes on an ordinary refresh when the values change.
    const forward = seriesColorIndexes(ids.map(metricSerie));
    const reversed = seriesColorIndexes([...ids].reverse().map(metricSerie));

    expect(forward).toEqual(reversed);
  });

  it('is deterministic across calls', () => {
    expect(seriesColorIndexes(ids.map(metricSerie))).toEqual(
      seriesColorIndexes(ids.map(metricSerie)),
    );
  });

  it('resolves through serieColorIndex regardless of the array position', () => {
    const indexes = seriesColorIndexes(ids.map(metricSerie));

    expect(serieColorIndex({ id: ids[1]!, index: 0 }, indexes)).toBe(
      serieColorIndex({ id: ids[1]!, index: 9 }, indexes),
    );
  });
});

describe('no two visible series share a colour', () => {
  it('assigns distinct slots while there are fewer series than colours', () => {
    const series = Array.from({ length: chartColors.length }, (_, i) =>
      metricSerie(`A:pod=p${i}`),
    );

    const indexes = seriesColorIndexes(series);
    expect(indexes).not.toBeNull();

    const used = [...indexes!.values()];
    expect(new Set(used).size).toBe(chartColors.length);
  });

  it('stays inside the palette when there are more series than colours', () => {
    const series = Array.from({ length: chartColors.length * 2 }, (_, i) =>
      metricSerie(`A:pod=p${i}`),
    );

    for (const index of seriesColorIndexes(series)!.values()) {
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(chartColors.length);
    }
  });
});

describe('when the series set changes', () => {
  it('keeps most colours when one series disappears', () => {
    const ids = ['A:a', 'A:b', 'A:c', 'A:d', 'A:e'];
    const before = seriesColorIndexes(ids.map(metricSerie))!;
    const after = seriesColorIndexes(ids.slice(1).map(metricSerie))!;

    const unchanged = ids
      .slice(1)
      .filter((id) => before.get(id) === after.get(id));

    // Index-based colouring would shift every one of them; identity-based
    // shifts only those whose preferred slot the removed series was occupying.
    expect(unchanged.length).toBeGreaterThanOrEqual(ids.length - 2);
  });

  it('a mixed panel still colours only by identity', () => {
    // One query's series must not be recoloured because ANOTHER query returned
    // a new label value.
    const before = seriesColorIndexes([
      metricSerie('A:method=GET'),
      metricSerie('B:le=0.99'),
    ])!;
    const after = seriesColorIndexes([
      metricSerie('A:method=GET'),
      metricSerie('A:method=POST'),
      metricSerie('B:le=0.99'),
    ])!;

    expect(after.get('A:method=GET')).toBe(before.get('A:method=GET'));
  });
});
