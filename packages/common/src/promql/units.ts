import type { IPromqlUnit } from '@openpanel/validation';

/**
 * Value formatting for PromQL panels.
 *
 * A closed enum rather than the free-string `unit` on a report, because these
 * do real work: `seconds` picks between nanoseconds and hours, `bytes` divides
 * by 1024, `percentunit` multiplies by 100. An unrecognised string would
 * silently format as a bare number, which is the difference between "p95 is
 * 34 ms" and "p95 is 0.034".
 */

/** Non-finite values: a gap, a division by zero, a missing quantile. */
const NO_VALUE = '—';

/**
 * Round for display without dragging a locale in.
 *
 * `toLocaleString` would make every test depend on the machine's locale, and a
 * chart axis that renders differently in CI than in the browser is a bug that
 * only shows up in screenshots.
 */
function trimNumber(value: number, decimals = 2): string {
  const fixed = value.toFixed(decimals);

  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
}

/** Thousands separators, applied to the integer part only. */
function group(value: string): string {
  const [whole = '', fraction] = value.split('.');
  const sign = whole.startsWith('-') ? '-' : '';
  const digits = sign ? whole.slice(1) : whole;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  return fraction ? `${sign}${grouped}.${fraction}` : `${sign}${grouped}`;
}

interface Scale {
  /** Divide by this. */
  factor: number;
  suffix: string;
}

/**
 * Pick the largest scale the value clears, so a chart never reads `0.000034 s`
 * where it could read `34 µs`.
 */
function scaled(value: number, scales: Scale[], fallback: Scale): string {
  const magnitude = Math.abs(value);

  for (const scale of scales) {
    if (magnitude >= scale.factor) {
      return `${trimNumber(value / scale.factor)} ${scale.suffix}`;
    }
  }

  return `${trimNumber(value / fallback.factor)} ${fallback.suffix}`;
}

const SI_SCALES: Scale[] = [
  { factor: 1e12, suffix: 'T' },
  { factor: 1e9, suffix: 'B' },
  { factor: 1e6, suffix: 'M' },
  { factor: 1e3, suffix: 'K' },
];

const SECOND_SCALES: Scale[] = [
  { factor: 86_400, suffix: 'd' },
  { factor: 3600, suffix: 'h' },
  { factor: 60, suffix: 'min' },
  { factor: 1, suffix: 's' },
  { factor: 1e-3, suffix: 'ms' },
  { factor: 1e-6, suffix: 'µs' },
];

const MILLISECOND_SCALES: Scale[] = [
  { factor: 86_400_000, suffix: 'd' },
  { factor: 3_600_000, suffix: 'h' },
  { factor: 60_000, suffix: 'min' },
  { factor: 1000, suffix: 's' },
  { factor: 1, suffix: 'ms' },
];

/** Binary prefixes: a `_bytes` metric counts bytes, and 1 KiB is 1024 of them. */
const BYTE_SCALES: Scale[] = [
  { factor: 1024 ** 5, suffix: 'PiB' },
  { factor: 1024 ** 4, suffix: 'TiB' },
  { factor: 1024 ** 3, suffix: 'GiB' },
  { factor: 1024 ** 2, suffix: 'MiB' },
  { factor: 1024, suffix: 'KiB' },
];

export function formatValue(value: number, unit: IPromqlUnit): string {
  if (!Number.isFinite(value)) {
    return NO_VALUE;
  }

  switch (unit) {
    case 'short':
      return Math.abs(value) >= 1000
        ? scaled(value, SI_SCALES, { factor: 1, suffix: '' }).trimEnd()
        : trimNumber(value);

    case 'percent':
      // Already expressed in percent: `100 * a / b`, or a `_percent` gauge.
      return `${trimNumber(value)}%`;

    case 'percentunit':
      // A ratio in 0–1, which is what a PromQL division produces.
      return `${trimNumber(value * 100)}%`;

    case 'seconds':
      return value === 0
        ? '0 s'
        : scaled(value, SECOND_SCALES, { factor: 1e-9, suffix: 'ns' });

    case 'ms':
      return value === 0
        ? '0 ms'
        : scaled(value, MILLISECOND_SCALES, { factor: 1e-3, suffix: 'µs' });

    case 'bytes':
      return Math.abs(value) >= 1024
        ? scaled(value, BYTE_SCALES, { factor: 1, suffix: 'B' })
        : `${trimNumber(value)} B`;

    case 'ops':
      return `${trimNumber(value)} ops/s`;

    default:
      return group(trimNumber(value));
  }
}

/**
 * Whether adding two values of this unit produces a meaningful number.
 *
 * The report table offers Sum, Average, Min and Max for every series. Summing a
 * column of latencies or percentages is arithmetic that means nothing — the sum
 * of every p95 sample in a window is not a duration anyone can act on — so the
 * renderer hides Sum and shows Last instead when no visible query is additive.
 * Counts and rates are the units where a total is a real quantity.
 */
export function isAdditiveUnit(unit: IPromqlUnit): boolean {
  return unit === 'none' || unit === 'short' || unit === 'ops';
}

/**
 * The unit to seed from a metric's name.
 *
 * The panel enum, unlike `inferMetricUnit`'s free-string answer for the legacy
 * report `unit` field. Same convention, different vocabulary.
 */
export function inferPromqlUnit(metric: string): IPromqlUnit {
  const lower = metric.toLowerCase();
  const base = ['_total', '_count', '_sum', '_bucket'].reduce(
    (acc, suffix) => (acc.endsWith(suffix) ? acc.slice(0, -suffix.length) : acc),
    lower,
  );

  if (base.endsWith('_seconds')) {
    return 'seconds';
  }
  if (base.endsWith('_milliseconds') || base.endsWith('_ms')) {
    return 'ms';
  }
  if (base.endsWith('_bytes')) {
    return 'bytes';
  }
  if (base.endsWith('_ratio')) {
    return 'percentunit';
  }
  if (base.endsWith('_percent')) {
    return 'percent';
  }

  return 'none';
}
