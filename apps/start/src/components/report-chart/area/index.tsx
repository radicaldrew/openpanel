import { useTRPC } from '@/integrations/trpc/react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { AspectContainer } from '../aspect-container';
import { ReportChartEmpty } from '../common/empty';
import { ReportChartError } from '../common/error';
import { ReportChartLoading } from '../common/loading';
import {
  useChartInput,
  useOwnedChartResult,
  useReportChartContext,
} from '../context';
import { Chart } from './chart';

export function ReportAreaChart() {
  const { isLazyLoading, shareId, annotations } = useReportChartContext();
  const chartInput = useChartInput();
  const trpc = useTRPC();
  // When the caller already holds the chart — Explore does, because it needs
  // the notices and compiled PromQL from the same response — the query below
  // is disabled rather than run and thrown away.
  const owned = useOwnedChartResult();

  const res = useQuery(
    trpc.chart.chart.queryOptions(
      {
        ...chartInput,
        shareId,
      },
      {
        placeholderData: keepPreviousData,
        enabled: !(isLazyLoading || owned.owned),
      },
    ),
  );

  const view = owned.owned
    ? {
        data: owned.data,
        isLoading: owned.isLoading ?? false,
        isFetching: owned.isFetching ?? false,
        error: owned.error,
      }
    : {
        data: res.data,
        isLoading: res.isLoading,
        isFetching: res.isFetching,
        error: res.isError ? res.error : undefined,
      };

  if (
    isLazyLoading ||
    view.isLoading ||
    (view.isFetching && !view.data?.series.length)
  ) {
    return <Loading />;
  }

  if (view.error) {
    return <Error error={view.error} />;
  }

  if (!view.data || view.data?.series.length === 0) {
    return <Empty />;
  }

  return (
    <AspectContainer>
      <Chart data={view.data} annotations={annotations} />
    </AspectContainer>
  );
}

function Loading() {
  return (
    <AspectContainer>
      <ReportChartLoading />
    </AspectContainer>
  );
}

function Error({ error }: { error?: unknown }) {
  return (
    <AspectContainer>
      <ReportChartError error={error} />
    </AspectContainer>
  );
}

function Empty() {
  return (
    <AspectContainer>
      <ReportChartEmpty />
    </AspectContainer>
  );
}
