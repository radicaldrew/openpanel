import { useTRPC } from '@/integrations/trpc/react';
import { inferMetricKind } from '@openpanel/common';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import {
  type TelemetryLink,
  exploreRateQuery,
  exploreUrl,
} from './telemetry-urls';

/**
 * "Open in Explore" from a log line, when there is anything worth opening.
 *
 * The jump only makes sense if this project actually writes a counter that
 * carries the service the user is looking at — otherwise the link lands on an
 * empty chart, which is a worse answer than no link. So this is deliberately
 * conservative and returns `null` far more often than not: no service selected,
 * no counters, or the chosen counter has never carried that service's name.
 *
 * Best effort by design (plan §7): it does not enumerate every counter looking
 * for the best one. That would be one `labelValues` request per metric, on a
 * page whose job is reading logs.
 */

interface Options {
  projectId: string;
  /** The service the logs are filtered to; without one there is nothing to jump with. */
  service: string | null | undefined;
  organizationId: string;
  /** The window the user is looking at, carried across so the chart matches. */
  start?: string;
  end?: string;
  enabled?: boolean;
}

export interface ExploreSuggestion {
  metric: string;
  link: TelemetryLink;
}

/**
 * The counter to offer.
 *
 * A request counter is what someone leaving a log line almost always wants —
 * "was there a spike in traffic when this happened" — so a name containing
 * `request` wins. Otherwise the alphabetically first counter, which is at least
 * stable: an arbitrary-but-stable choice can be recognised and learned, where a
 * choice that changes with the metric list cannot.
 */
export function pickCounter(metricNames: string[]): string | undefined {
  const counters = metricNames
    .filter((name) => inferMetricKind(name) === 'counter')
    .sort((a, b) => a.localeCompare(b));

  return (
    counters.find((name) => name.toLowerCase().includes('request')) ??
    counters[0]
  );
}

export function useExploreSuggestion({
  projectId,
  service,
  organizationId,
  start,
  end,
  enabled = true,
}: Options): ExploreSuggestion | null {
  const trpc = useTRPC();
  const active = enabled && !!service;

  const metrics = useQuery(
    trpc.observability.metricNames.queryOptions({ projectId }, { enabled: active }),
  );

  const metric = useMemo(
    () => pickCounter(metrics.data ?? []),
    [metrics.data],
  );

  // The one check that makes this honest: does that counter carry this service?
  const services = useQuery(
    trpc.observability.labelValues.queryOptions(
      { projectId, label: 'service_name', metric },
      { enabled: active && !!metric },
    ),
  );

  return useMemo(() => {
    if (!(active && metric && service)) {
      return null;
    }

    if (!(services.data ?? []).includes(service)) {
      return null;
    }

    return {
      metric,
      link: exploreUrl({
        organizationId,
        projectId,
        queries: [exploreRateQuery(metric, service)],
        start,
        end,
      }),
    };
  }, [active, metric, service, services.data, organizationId, projectId, start, end]);
}
