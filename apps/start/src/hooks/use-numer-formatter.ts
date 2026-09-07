import { round } from '@/utils/math';
import { formatValue } from '@openpanel/common';
import type { IPromqlUnit } from '@openpanel/validation';
import { isNil } from 'ramda';
import { useMemo } from 'react';

export function fancyMinutes(time: number) {
  const minutes = Math.floor(time / 60);
  if (minutes > 60) {
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  }
  const seconds = round(time - minutes * 60, 0);
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

export const formatNumber =
  (locale: string) => (value: number | null | undefined) => {
    if (isNil(value)) {
      return 'N/A';
    }
    return new Intl.NumberFormat(locale).format(value);
  };

export const shortNumber =
  (locale: string) => (value: number | null | undefined) => {
    if (isNil(value)) {
      return 'N/A';
    }
    return new Intl.NumberFormat(locale, {
      notation: 'compact',
    }).format(value);
  };

export const formatCurrency =
  (locale: string) =>
  (
    amount: number,
    options?: {
      currency?: string;
      short?: boolean;
    },
  ) => {
    const short = options?.short ?? false;
    const currency = options?.currency ?? 'USD';
    if (short) {
      // Use compact notation for short format (e.g., "73K $")
      const formatter = new Intl.NumberFormat(locale, {
        notation: 'compact',
        minimumFractionDigits: 0,
        maximumFractionDigits: 1,
      });
      const formatted = formatter.format(amount);
      // Get currency symbol
      const currencyFormatter = new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: currency,
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      });
      const parts = currencyFormatter.formatToParts(0);
      const symbol =
        parts.find((part) => part.type === 'currency')?.value || '$';
      return `${formatted} ${symbol}`;
    }
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 1,
    }).format(amount);
  };

export function useNumber() {
  const locale = 'en-US';
  const format = formatNumber(locale);
  const short = shortNumber(locale);
  const currency = formatCurrency(locale);

  return {
    currency,
    format,
    short,
    shortWithUnit: (value: number | null | undefined, unit?: string | null) => {
      if (isNil(value)) {
        return 'N/A';
      }
      if (unit === 'min') {
        return fancyMinutes(value);
      }
      return `${short(value)}${unit ? ` ${unit}` : ''}`;
    },
    formatWithUnit: (
      value: number | null | undefined,
      unit?: string | null,
    ) => {
      if (isNil(value)) {
        return 'N/A';
      }
      if (unit === 'min') {
        return fancyMinutes(value);
      }
      if (unit === '%') {
        return `${format(round(value * 100, 1))}${unit ? ` ${unit}` : ''}`;
      }
      return `${format(value)}${unit ? ` ${unit}` : ''}`;
    },
  };
}

/**
 * Values on a chart that may carry EITHER kind of unit.
 *
 * A metrics panel gives every series a typed `IPromqlUnit` from its own query —
 * `seconds`, `bytes`, `percentunit` — and `formatValue` knows how to scale each
 * one (34 ms rather than 0.034, 3 GiB rather than 3221225472). An events report
 * has no such thing: it carries one free-string `report.unit` (`%`, `min`, `$`)
 * that the legacy formatter special-cases.
 *
 * Both paths stay, and the typed one wins when it is present. Collapsing them
 * into one would either lose the scaling a metrics panel needs or break the
 * three strings events reports have always used.
 */
export function useUnitFormat() {
  const number = useNumber();

  return useMemo(
    () => ({
      /** Full precision: tooltips, tables, stat cards. */
      full: (
        value: number | null | undefined,
        unit: IPromqlUnit | undefined,
        legacyUnit?: string | null,
      ) => {
        if (isNil(value)) {
          return 'N/A';
        }

        return unit ? formatValue(value, unit) : number.formatWithUnit(value, legacyUnit);
      },
      /**
       * Compact: axis ticks, where the width of the label decides the width of
       * the axis. Without a typed unit this stays exactly as it was — the
       * legacy axis has never rendered `report.unit` on a tick, and starting
       * now would change every existing events chart.
       */
      tick: (value: number, unit: IPromqlUnit | undefined) =>
        unit ? formatValue(value, unit) : number.short(value),
    }),
    [number],
  );
}
