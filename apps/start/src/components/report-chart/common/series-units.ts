import { isAdditiveUnit } from '@openpanel/common';
import type { IChartSerie, IPromqlUnit } from '@openpanel/validation';

/**
 * Reading unit and axis off a chart's series.
 *
 * A metrics panel carries one unit and one axis PER QUERY — that is the whole
 * point of `panel` on the series — so nothing here can ask the report for a
 * single answer. An events report has no `panel` at all and keeps its legacy
 * free-string `report.unit`, which is why every function here is written to
 * return `undefined` rather than a default when there is nothing to say.
 */

export type UnitedSerie = Pick<IChartSerie, 'id' | 'data'> & {
  panel?: IChartSerie['panel'];
};

export type ChartAxis = 'left' | 'right';

export function serieAxis(serie: { panel?: IChartSerie['panel'] }): ChartAxis {
  return serie.panel?.yAxis ?? 'left';
}

/** Whether any visible series asked for the right-hand axis. */
export function hasRightAxis(
  series: { panel?: IChartSerie['panel'] }[],
): boolean {
  return series.some((serie) => serieAxis(serie) === 'right');
}

/**
 * The unit to label one axis with.
 *
 * `undefined` when the series on that axis disagree — two different units on
 * one axis have no shared tick format, and picking the first would label a
 * byte count as seconds. The caller falls back to a plain short number, which
 * is wrong for nobody rather than right for one series and wrong for the rest.
 */
export function axisUnit(
  series: { panel?: IChartSerie['panel'] }[],
  axis: ChartAxis,
): IPromqlUnit | undefined {
  const units = new Set(
    series
      .filter((serie) => serieAxis(serie) === axis)
      .map((serie) => serie.panel?.unit)
      .filter((unit): unit is IPromqlUnit => unit !== undefined),
  );

  return units.size === 1 ? [...units][0] : undefined;
}

/**
 * Whether the report table should offer a Sum column.
 *
 * Summing a column of latencies or percentages is arithmetic that means
 * nothing: the total of every p95 sample in a window is not a duration anyone
 * can act on. So Sum is dropped — and Last put in its place — only when NO
 * visible series is additive. One additive series is enough to keep it, because
 * its own total is still meaningful and hiding the column would take that away.
 *
 * An events series has no `panel` and counts as additive, so an events report
 * is never affected.
 */
export function showsSumColumn(
  series: { panel?: IChartSerie['panel'] }[],
): boolean {
  if (series.length === 0) {
    return true;
  }

  return series.some(
    (serie) => !serie.panel || isAdditiveUnit(serie.panel.unit),
  );
}

/**
 * The most recent value in a series.
 *
 * A genuine 0 is a real measurement, not a missing one — the engine renders a
 * bucket Prometheus did not answer as 0 and a `NaN` sample as a gap — so this
 * skips only non-finite values, never zeros. An instant query returns a single
 * point, which is therefore also the last one.
 */
export function lastValue(serie: {
  data: { count: number }[];
}): number | undefined {
  for (let i = serie.data.length - 1; i >= 0; i -= 1) {
    const count = serie.data[i]?.count;

    if (typeof count === 'number' && Number.isFinite(count)) {
      return count;
    }
  }

  return undefined;
}

/**
 * Panel metadata keyed by series id.
 *
 * Built once per chart and handed to the tooltip and table, which see one row
 * at a time and have no other way back to the query that produced it.
 */
export function seriesPanels(
  series: { id: string; panel?: IChartSerie['panel'] }[],
): Map<string, IChartSerie['panel']> {
  const out = new Map<string, IChartSerie['panel']>();

  for (const serie of series) {
    if (serie.panel) {
      out.set(serie.id, serie.panel);
    }
  }

  return out;
}
