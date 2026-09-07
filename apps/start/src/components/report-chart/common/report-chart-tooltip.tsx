import { useFormatDateInterval } from '@/hooks/use-format-date-interval';
import { useUnitFormat } from '@/hooks/use-numer-formatter';
import { parseChartDate } from '@/utils/chart-dates';
import type { IRechartPayloadItem } from '@/hooks/use-rechart-data-model';
import React from 'react';

import {
  ChartTooltipHeader,
  ChartTooltipItem,
  createChartTooltip,
} from '@/components/charts/chart-tooltip';
import type { RouterOutputs } from '@/trpc/client';
import { getChartColor } from '@/utils/theme';
import type { IChartSerie, IInterval } from '@openpanel/validation';
import {
  format,
  isSameDay,
  isSameHour,
  isSameMinute,
  isSameMonth,
  isSameWeek,
} from 'date-fns';
import { useReportChartContext } from '../context';
import { PreviousDiffIndicator } from './previous-diff-indicator';
import { SerieIcon } from './serie-icon';
import { SerieName } from './serie-name';

const getMatchingReferences = (
  interval: IInterval,
  references: RouterOutputs['reference']['getChartReferences'],
  date: Date,
) => {
  return references.filter((reference) => {
    if (interval === 'minute') {
      return isSameMinute(reference.date, date);
    }
    if (interval === 'hour') {
      return isSameHour(reference.date, date);
    }
    if (interval === 'day') {
      return isSameDay(reference.date, date);
    }
    if (interval === 'week') {
      return isSameWeek(reference.date, date);
    }
    if (interval === 'month') {
      return isSameMonth(reference.date, date);
    }
    return false;
  });
};

type Context = {
  references?: RouterOutputs['reference']['getChartReferences'];
  /**
   * Per-series panel metadata, keyed by series id.
   *
   * The tooltip formats each row with the unit of the query that produced it,
   * so a panel showing a request rate and a p95 reads `1.2 K ops/s` on one row
   * and `34 ms` on the next. A single report-level unit cannot express that:
   * the panel has two answers.
   */
  panels?: Map<string, IChartSerie['panel']>;
  /**
   * The colour each series is drawn in, keyed by series id.
   *
   * Resolved by the chart rather than re-derived here, so the swatch beside a
   * name is by construction the colour of the line it describes. This used to
   * come off the payload, where it was baked from the series' position in the
   * VISIBLE array while the line took its colour from the position in the full
   * one — so the two could already disagree before identity-based colouring
   * existed.
   */
  seriesColors?: Map<string, string>;
};
type Data = {
  date: string;
  timestamp: number;
  [key: `${string}:count`]: number;
  [key: `${string}:payload`]: IRechartPayloadItem;
};
export const ReportChartTooltip = createChartTooltip<Data, Context>(
  ({ context: { references, panels, seriesColors }, data }) => {
    const {
      report: { interval, unit },
    } = useReportChartContext();
    const formatDate = useFormatDateInterval({
      interval,
      short: false,
    });
    const unitFormat = useUnitFormat();

    if (!data || data.length === 0) {
      return null;
    }

    const firstItem = data[0];
    const matchingReferences = getMatchingReferences(
      interval,
      references ?? [],
      // Through the shared reader: a bucket string has no zone marker, and the
      // naive reading would compare a reference against an hour it does not
      // belong to — so a marker would show on the wrong tooltip.
      parseChartDate(firstItem.date),
    );

    // Get all payload items from the first data point
    const payloadItems = Object.keys(firstItem)
      .filter((key) => key.endsWith(':payload'))
      .map(
        (key) =>
          firstItem[key as keyof typeof firstItem] as IRechartPayloadItem,
      )
      .filter((item) => item && typeof item === 'object' && 'id' in item);

    // Sort by count
    const sorted = payloadItems.sort((a, b) => (b.count || 0) - (a.count || 0));
    const limit = 3;
    const visible = sorted.slice(0, limit);
    const hidden = sorted.slice(limit);

    return (
      <>
        {visible.map((item, index) => (
          <React.Fragment key={item.id}>
            {index === 0 && item.date && (
              <ChartTooltipHeader>
                <div>{formatDate(parseChartDate(item.date))}</div>
              </ChartTooltipHeader>
            )}
            <ChartTooltipItem
              color={seriesColors?.get(item.id) ?? getChartColor(0)}
            >
              <div className="flex items-center gap-1">
                <SerieIcon name={item.names} />
                <SerieName name={item.names} />
              </div>
              <div className="flex justify-between gap-8 font-mono font-medium">
                <div className="row gap-1">
                  {unitFormat.full(item.count, panels?.get(item.id)?.unit, unit)}
                  {!!item.previous && (
                    <span className="text-muted-foreground">
                      (
                      {unitFormat.full(
                        item.previous.value,
                        panels?.get(item.id)?.unit,
                        unit,
                      )}
                      )
                    </span>
                  )}
                </div>
                <PreviousDiffIndicator {...item.previous} />
              </div>
            </ChartTooltipItem>
          </React.Fragment>
        ))}
        {hidden.length > 0 && (
          <div className="text-muted-foreground">
            and {hidden.length} more...
          </div>
        )}
        {matchingReferences.length > 0 && (
          <>
            <hr className="border-border" />
            {matchingReferences.map((reference) => (
              <div
                key={reference.id}
                className="row justify-between items-center"
              >
                <div className="font-medium text-sm">{reference.title}</div>
                <div className="font-medium text-sm shrink-0 text-muted-foreground">
                  {format(reference.date, 'HH:mm')}
                </div>
              </div>
            ))}
          </>
        )}
      </>
    );
  },
);
