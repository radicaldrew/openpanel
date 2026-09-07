import type { IChartData } from '@/trpc/client';
import { useMemo } from 'react';

export type IRechartPayloadItem = {
  id: string;
  names: string[];
  event: { id?: string; name: string };
  count: number;
  date: string;
  previous?: {
    value: number;
    diff: number | null;
    state: 'positive' | 'negative' | 'neutral';
  };
};

export function useRechartDataModel(series: IChartData['series']) {
  return useMemo(() => {
    return (
      series[0]?.data.map(({ date }) => {
        return {
          date,
          timestamp: new Date(date).getTime(),
          ...series.reduce((acc, serie) => {
            return {
              ...acc,
              ...serie.data.reduce(
                (acc2, item) => {
                  if (item.date === date) {
                    if (item.previous) {
                      acc2[`${serie.id}:prev:count`] = item.previous.value;
                    }
                    acc2[`${serie.id}:count`] = item.count;
                    // NO `color`. It used to be baked in from the series'
                    // position in the VISIBLE array, while the chart coloured
                    // from its position in the full one — so the tooltip swatch
                    // could already disagree with the line it described. Colour
                    // is now assigned once per chart, by series identity, and
                    // the tooltip looks it up from there.
                    acc2[`${serie.id}:payload`] = {
                      ...item,
                      id: serie.id,
                      event: serie.event,
                      names: serie.names,
                    } satisfies IRechartPayloadItem;
                  }
                  return acc2;
                },
                {} as Record<string, any>,
              ),
            };
          }, {}),
        };
      }) ?? []
    );
  }, [series]);
}
