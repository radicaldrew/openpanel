/**
 * Reading a PromQL range response into observations.
 *
 * Separated from the evaluator so the shape gigapipe returns can be tested
 * without a gigapipe, and so a change to that wire format lands in one place.
 */

import type { SeriesObservation } from './evaluate';
import { seriesKeyOf } from './evaluate';

interface MatrixSample {
  metric?: Record<string, string>;
  values?: [number, string][];
}

/**
 * Turn a `matrix` range response into one observation per series.
 *
 * Two decisions worth stating:
 *
 *  - The value taken is the last sample that actually parses. Trailing buckets
 *    are routinely empty or NaN because the most recent scrape has not landed,
 *    and reading one of those as a real number would resolve a live condition
 *    at the wrong moment.
 *  - A series with no usable sample yields `value: undefined`, not zero. The
 *    state machine treats absence as "hold what you knew", and zero would be a
 *    claim — for `mcp_calls <= 0` the difference is a customer who went quiet
 *    versus an exporter that died.
 */
export function observationsFromMatrix(payload: unknown): SeriesObservation[] {
  const result = matrixResult(payload);
  if (!result) {
    return [];
  }

  const observations: SeriesObservation[] = [];
  for (const sample of result) {
    const labels = cleanLabels(sample.metric);
    observations.push({
      seriesKey: seriesKeyOf(labels),
      labels,
      value: latestValue(sample.values),
    });
  }
  return observations;
}

function matrixResult(payload: unknown): MatrixSample[] | undefined {
  if (typeof payload !== 'object' || payload === null) {
    return undefined;
  }
  const data = (payload as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) {
    return undefined;
  }
  const result = (data as { result?: unknown }).result;
  return Array.isArray(result) ? (result as MatrixSample[]) : undefined;
}

/**
 * Drop `__name__` and any reserved label.
 *
 * They are gigapipe's bookkeeping, not the series' identity, and including
 * them in the series key would make it change when a metric is renamed.
 */
function cleanLabels(
  metric: Record<string, string> | undefined
): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const [key, value] of Object.entries(metric ?? {})) {
    if (key === '__name__' || key.startsWith('__')) {
      continue;
    }
    labels[key] = value;
  }
  return labels;
}

function latestValue(
  values: [number, string][] | undefined
): number | undefined {
  if (!Array.isArray(values)) {
    return undefined;
  }
  for (let i = values.length - 1; i >= 0; i--) {
    const raw = values[i]?.[1];
    if (raw === undefined) {
      continue;
    }
    const parsed = Number(raw);
    // Prometheus renders a gap as the string "NaN"; Number() gives NaN for it
    // and for anything else unparseable. Either way there is no observation.
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}
