import type { IChartSerie } from '@openpanel/validation';
import { chartColors } from '@openpanel/constants';

/**
 * Which palette slot each series gets.
 *
 * WHY THIS EXISTS
 *
 * `format()` sorts a chart's series by their sum, descending. The renderer then
 * colours each series by its position in that sorted array — so the moment two
 * series swap places, every colour after them shifts. On a metrics panel that
 * happens on an ordinary refresh, because the values are what changed: a line
 * the user was watching turns from blue to orange while they look at it, and
 * the legend they had just read is wrong.
 *
 * Keying the colour to the series' IDENTITY instead of its rank fixes that. The
 * id is `${refId}:${sortedLabels}` for a panel series, so it survives a
 * refetch, a reorder, and a change in value.
 *
 * WHY NOT JUST HASH
 *
 * A bare `hash(id) % palette` is stable but collides: with a 20-ish palette and
 * a dozen series, two lines sharing a colour is likely rather than rare, and a
 * legend that maps two names to one swatch is worse than one that reorders.
 * Hashing to a PREFERRED slot and probing forward when it is taken keeps both
 * properties — stable across refreshes, and collision-free while there are
 * fewer series than colours.
 *
 * EVENTS REPORTS ARE UNAFFECTED
 *
 * Returns `null` when no series carries panel metadata, and every caller falls
 * back to the series' index. An events report has always coloured by index and
 * its series ids are not stable in the same way, so nothing changes for it.
 */

const PALETTE_SIZE = chartColors.length;

/**
 * FNV-1a. Chosen for being short, dependency-free and well-distributed over
 * short ASCII strings — which is exactly what a series id is. Not a security
 * hash and nothing here needs one.
 */
function hashId(id: string): number {
  let hash = 0x81_1c_9d_c5;

  for (let i = 0; i < id.length; i += 1) {
    // biome-ignore lint/suspicious/noBitwiseOperators: XOR and the unsigned shift below ARE the FNV-1a algorithm; there is no arithmetic equivalent
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01_00_01_93);
  }

  // `>>> 0` because Math.imul yields a signed 32-bit result and a negative
  // modulo would index backwards off the palette.
  // biome-ignore lint/suspicious/noBitwiseOperators: coercing to unsigned 32-bit is the point
  return hash >>> 0;
}

export type ColorableSerie = Pick<IChartSerie, 'id'> & {
  panel?: IChartSerie['panel'];
};

export function seriesColorIndexes(
  series: ColorableSerie[],
): Map<string, number> | null {
  if (!series.some((serie) => serie.panel)) {
    return null;
  }

  // Sorted by id, NOT by the order the chart happens to hold them in. The
  // assignment has to depend only on the SET of series, or probing would hand
  // out different colours for the same set arriving in a different order —
  // which is the bug this function exists to fix.
  const ids = [...new Set(series.map((serie) => serie.id))].sort();

  const taken = new Set<number>();
  const out = new Map<string, number>();

  for (const id of ids) {
    const preferred = hashId(id) % PALETTE_SIZE;
    let index = preferred;

    for (let probe = 0; probe < PALETTE_SIZE; probe += 1) {
      const candidate = (preferred + probe) % PALETTE_SIZE;

      if (!taken.has(candidate)) {
        index = candidate;
        break;
      }
    }

    // More series than colours: the palette is exhausted and something has to
    // repeat. Falling back to the preferred slot keeps the choice deterministic
    // rather than dependent on how far the probe got.
    taken.add(index);
    out.set(id, index);
  }

  return out;
}

/**
 * The palette slot for one series.
 *
 * `indexes` is the map above, or `null` for an events report — in which case
 * the series' position is used, exactly as before.
 */
export function serieColorIndex(
  serie: { id: string; index: number },
  indexes: Map<string, number> | null,
): number {
  return indexes?.get(serie.id) ?? serie.index;
}
