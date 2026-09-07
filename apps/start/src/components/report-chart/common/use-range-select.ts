import { useCallback, useRef, useState } from 'react';

/**
 * Drag-to-zoom on a time chart.
 *
 * Explore lets you sweep across a spike and re-run at that range. Recharts has
 * no selection of its own, so this is the standard composition: remember the
 * x value under the pointer on mousedown, follow it on mousemove, and hand the
 * pair back on mouseup — with a `ReferenceArea` drawn between them meanwhile.
 */

export interface SelectedRange {
  startDate: string;
  endDate: string;
}

/**
 * Turn two x values from the chart into an ISO range.
 *
 * Returns null for a non-drag: a plain click puts mousedown and mouseup on the
 * same bucket, and zooming to a zero-width range would leave the user staring
 * at an empty chart with no obvious way back.
 *
 * The two values are ordered, so sweeping right-to-left works — people do it
 * about half the time, and a backwards range silently returns nothing.
 */
export function selectedRange(
  from: number | null,
  to: number | null,
): SelectedRange | null {
  if (from === null || to === null || from === to) {
    return null;
  }

  if (!(Number.isFinite(from) && Number.isFinite(to))) {
    return null;
  }

  const start = Math.min(from, to);
  const end = Math.max(from, to);

  return {
    startDate: new Date(start).toISOString(),
    endDate: new Date(end).toISOString(),
  };
}

/** The x value Recharts reports under the pointer, as a timestamp. */
function activeTimestamp(event: unknown): number | null {
  const label = (event as { activeLabel?: unknown } | undefined)?.activeLabel;

  if (label === undefined || label === null) {
    return null;
  }

  const value = Number(label);

  return Number.isFinite(value) ? value : null;
}

export function useRangeSelect(onRangeSelect?: (range: SelectedRange) => void) {
  const [from, setFrom] = useState<number | null>(null);
  const [to, setTo] = useState<number | null>(null);

  // A completed sweep also fires the chart's click handler, which would open
  // the context menu on top of the newly-zoomed chart. This survives that one
  // render so the menu can be suppressed for it.
  const draggedRef = useRef(false);

  const reset = useCallback(() => {
    setFrom(null);
    setTo(null);
  }, []);

  const onMouseDown = useCallback(
    (event: unknown) => {
      if (!onRangeSelect) {
        return;
      }

      draggedRef.current = false;
      setFrom(activeTimestamp(event));
      setTo(null);
    },
    [onRangeSelect],
  );

  const onMouseMove = useCallback(
    (event: unknown) => {
      if (!onRangeSelect || from === null) {
        return;
      }

      setTo(activeTimestamp(event));
    },
    [onRangeSelect, from],
  );

  const onMouseUp = useCallback(() => {
    if (!onRangeSelect) {
      return;
    }

    const range = selectedRange(from, to);
    draggedRef.current = range !== null;
    reset();

    if (range) {
      onRangeSelect(range);
    }
  }, [onRangeSelect, from, to, reset]);

  // Leaving the plot mid-sweep abandons it rather than zooming to wherever the
  // pointer happened to exit.
  const onMouseLeave = useCallback(() => {
    if (from !== null) {
      reset();
    }
  }, [from, reset]);

  return {
    /** Spread onto the Recharts chart element. */
    chartProps: onRangeSelect
      ? { onMouseDown, onMouseMove, onMouseUp, onMouseLeave }
      : {},
    /** The in-progress sweep, or null. */
    selection: from !== null && to !== null ? { x1: from, x2: to } : null,
    /** True for the click that ends a sweep — used to suppress the menu. */
    consumeDrag: () => {
      const dragged = draggedRef.current;
      draggedRef.current = false;
      return dragged;
    },
  };
}
