import type { useTRPC } from '@/integrations/trpc/react';
import type { PrometheusClient } from '@prometheus-io/codemirror-promql';
import type { QueryClient } from '@tanstack/react-query';

/**
 * The completion backend for the PromQL editor, over tRPC.
 *
 * `codemirror-promql` ships an HTTP client that talks to a Prometheus at a URL.
 * We cannot use it, and the reason is tenancy rather than plumbing: gigapipe's
 * `/api/v1/labels`, `/api/v1/series` and the label-values endpoint are GLOBAL.
 * They answer for every project on the deployment at once, so pointing the
 * browser at them would make the autocomplete dropdown an enumeration of other
 * customers' metric and label names — a data leak dressed up as a convenience,
 * and one nothing downstream would flag because no chart is ever drawn from it.
 *
 * `observability.metricNames` / `labelKeys` / `labelValues` read the same facts
 * out of ClickHouse's `time_series_gin` scoped to one project, behind the same
 * `assertProjectAccess` every other read uses. So the completion sees exactly
 * what the user is allowed to query, which is also the only useful answer: a
 * suggestion for a metric this project has never written is noise.
 *
 * Reads go through `queryClient.fetchQuery`, so the dropdown shares React
 * Query's cache with the builder's comboboxes — picking a metric in the builder
 * has already warmed the label list the code editor completes from.
 */

type TRPC = ReturnType<typeof useTRPC>;

interface Options {
  projectId: string;
  trpc: TRPC;
  queryClient: QueryClient;
}

/**
 * Completion is a convenience, and a failed convenience must not become an
 * error. A dropped request here would otherwise reject inside CodeMirror's
 * completion source, where there is nothing to catch it and nothing useful to
 * show — the user is mid-word. Returning nothing degrades to "no suggestions",
 * which is what a user without a telemetry backend sees anyway.
 */
async function orEmpty<T>(read: () => Promise<T[]>): Promise<T[]> {
  try {
    // The call is INSIDE the try, not just its result: building the query
    // options can throw synchronously on a malformed input, and a synchronous
    // throw out of a completion source is the one failure CodeMirror cannot
    // recover from at all.
    return await read();
  } catch {
    return [];
  }
}

export function createTrpcPrometheusClient({
  projectId,
  trpc,
  queryClient,
}: Options): PrometheusClient {
  return {
    metricNames() {
      // The prefix argument is ignored, as it is in the upstream HTTP client:
      // the completion source does its own filtering, and a project's metric
      // list is small enough to hand over whole and cache once.
      return orEmpty(() =>
        queryClient.fetchQuery(
          trpc.observability.metricNames.queryOptions({ projectId }),
        ),
      );
    },

    labelNames(metricName?: string) {
      return orEmpty(() =>
        queryClient.fetchQuery(
          trpc.observability.labelKeys.queryOptions({
            projectId,
            // Narrowed to the metric under the cursor when there is one, so the
            // dropdown does not offer labels that select nothing on it.
            metric: metricName || undefined,
          }),
        ),
      );
    },

    labelValues(labelName: string, metricName?: string) {
      if (!labelName) {
        return Promise.resolve([]);
      }

      return orEmpty(() =>
        queryClient.fetchQuery(
          trpc.observability.labelValues.queryOptions({
            projectId,
            label: labelName,
            metric: metricName || undefined,
          }),
        ),
      );
    },

    /**
     * Empty on purpose. Metric TYPE and HELP are what this would carry, and the
     * deployment does not have them: the OpenTelemetry Collector's Prometheus
     * remote-write exporter drops the `# TYPE` line, and gigapipe's own
     * `/api/v1/metadata` answers `{}`. The editor infers kind from the name
     * instead — see `inferMetricKind` — and the completion simply shows no type
     * badge rather than a wrong one.
     */
    metricMetadata() {
      return Promise.resolve({});
    },

    /**
     * Empty on purpose. `series` is only used to complete label values from a
     * full series list, which `labelValues` above already answers directly and
     * far more cheaply; there is no project-scoped series endpoint to back it.
     */
    series() {
      return Promise.resolve([]);
    },

    /** Prometheus runtime flags. Not ours to report. */
    flags() {
      return Promise.resolve({});
    },
  };
}
