import type { ChartClickMenuItem } from '@/components/report-chart/common/chart-click-menu';
import type { IInterval, IVariableValues } from '@openpanel/validation';
import { useNavigate } from '@tanstack/react-router';
import { ScrollTextIcon, WaypointsIcon } from 'lucide-react';
import { useCallback } from 'react';

import {
  bucketWindow,
  logsUrl,
  serviceFromLabels,
  tracesUrl,
} from './telemetry-urls';

/**
 * "View logs for this range" and "View traces for this range", for a metric
 * chart's click menu.
 *
 * This is plan §8 item 6 — from a p95 spike, two clicks to the log lines for
 * that minute — and it is a hook rather than a component because the items are
 * data: `options.extraMenuItems` on the chart context takes a function and the
 * renderer draws them. Explore and the dashboard both call this, which is the
 * point: the window and the service must be computed identically or the same
 * spike gives two different answers depending on which page you clicked it on.
 */

interface Options {
  organizationId: string;
  projectId: string;
  /** The panel's interval — it decides how wide "this range" is. */
  interval: IInterval;
  /** Dashboard variables, as the last resort for the service name. */
  variables?: IVariableValues;
}

export interface MetricClickContext {
  date: string;
  serieId?: string;
  panel?: { refId: string } | undefined;
  /** The clicked series' labels, straight off the click payload. */
  labels?: Record<string, string>;
}

export function useMetricCorrelationItems({
  organizationId,
  projectId,
  interval,
  variables,
}: Options): (context: MetricClickContext) => ChartClickMenuItem[] {
  const navigate = useNavigate();

  return useCallback(
    ({ date, labels }: MetricClickContext): ChartClickMenuItem[] => {
      if (!date) {
        return [];
      }

      // The labels come off the click payload and nowhere else. They are by
      // construction from the render that was clicked, where a chart prop would
      // be whatever the last render left behind — and a dashboard panel has no
      // chart to look in at all.
      //
      // A click that lands between series carries no labels, and that is fine:
      // the bucket is what the window is built from, and the service falls back
      // to the dashboard's variable — or to no filter at all, which shows every
      // service's logs for that minute rather than nothing.
      const service = serviceFromLabels(labels, variables);

      let window: { start: string; end: string };

      try {
        window = bucketWindow(date, interval);
      } catch {
        // An unreadable bucket date is not worth a broken menu item.
        return [];
      }

      const forRange = service ? ` for ${service}` : '';

      return [
        {
          label: `View logs for this range${forRange}`,
          icon: <ScrollTextIcon size={16} />,
          onClick: () => {
            // Same tab, pushed onto the history, so Back returns to the chart
            // the user was reading.
            void navigate(
              logsUrl({ organizationId, projectId, service, ...window }),
            );
          },
        },
        {
          label: `View traces for this range${forRange}`,
          icon: <WaypointsIcon size={16} />,
          onClick: () => {
            void navigate(
              tracesUrl({ organizationId, projectId, service, ...window }),
            );
          },
        },
      ];
    },
    [navigate, organizationId, projectId, interval, variables],
  );
}
