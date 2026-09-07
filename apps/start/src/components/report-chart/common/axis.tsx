import { useDebounceFn } from '@/hooks/use-debounce-fn';
import { useFormatDateInterval } from '@/hooks/use-format-date-interval';
import { useUnitFormat } from '@/hooks/use-numer-formatter';
import { isNil } from 'ramda';
import { useRef, useState } from 'react';
import type { AxisDomain } from 'recharts/types/util/types';

import type { IInterval, IPromqlUnit } from '@openpanel/validation';
export const AXIS_FONT_PROPS = {
  fontSize: 8,
  className: 'font-mono',
};

export function getYAxisWidth(value: string | undefined | null) {
  const charLength = AXIS_FONT_PROPS.fontSize * 0.6;

  if (isNil(value) || value.length === 0) {
    return charLength * 2;
  }

  return charLength * value.length + charLength;
}

export const useYAxisProps = (options?: {
  hide?: boolean;
  tickFormatter?: (value: number) => string;
  width?: number;
  /**
   * The typed unit of the metrics queries drawn on this axis, when they all
   * agree on one. Ticks are then scaled and suffixed — `34 ms`, `3 GiB` —
   * instead of being rendered as a bare short number, which is the difference
   * between an axis you can read a latency off and one you cannot.
   *
   * Undefined for an events report and for an axis whose series disagree, and
   * the ticks then format exactly as they always have.
   */
  unit?: IPromqlUnit;
}) => {
  const [width, setWidth] = useState(options?.width || 24);
  const setWidthDebounced = useDebounceFn(setWidth, 100);
  const unitFormat = useUnitFormat();
  const ref = useRef<number[]>([]);

  return {
    ...AXIS_FONT_PROPS,
    width: options?.hide ? 0 : width,
    axisLine: false,
    tickLine: false,
    // A latency axis is all decimals below one second, so a metrics panel with
    // a typed unit has to allow them. Events charts count things and keep the
    // whole-number ticks they have always had.
    allowDecimals: options?.unit !== undefined,
    tickFormatter: (value: number) => {
      const tick = options?.tickFormatter
        ? options.tickFormatter(value)
        : unitFormat.tick(value, options?.unit);
      if(!options?.width) {
        const newWidth = getYAxisWidth(tick);
        ref.current.push(newWidth);
        setWidthDebounced(Math.max(...ref.current));
      }
      return tick;
    },
  };
};

export const X_AXIS_STYLE_PROPS = {
  height: 14,
  tickSize: 10,
  axisLine: false,
  tickLine: false,
  ...AXIS_FONT_PROPS,
};

export const useXAxisProps = (
  {
    interval = 'auto',
    hide,
  }: {
    interval?: IInterval | 'auto';
    hide?: boolean;
  } = {
    hide: false,
    interval: 'auto',
  },
) => {
  const formatDate = useFormatDateInterval({
    interval: interval === 'auto' ? 'day' : interval,
    short: true,
  });

  return {
    ...X_AXIS_STYLE_PROPS,
    height: hide ? 0 : X_AXIS_STYLE_PROPS.height,
    dataKey: 'timestamp',
    scale: 'utc',
    domain: ['dataMin', 'dataMax'] as AxisDomain,
    tickFormatter:
      interval === 'auto'
        ? undefined
        : (m: string) => {
            if (['dataMin', 'dataMax'].includes(m)) {
              return m;
            }

            return formatDate(new Date(m));
          },
    type: 'number' as const,
  } as const;
};
