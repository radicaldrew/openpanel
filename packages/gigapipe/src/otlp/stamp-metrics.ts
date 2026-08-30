import { assertValidProjectId } from '../tenancy/project-label';
import { stampAttributeList, stampResourceEntry } from './stamp';
import { rewriteField } from './wire';

/**
 * Metrics need the project label on EVERY DATA POINT, not just the resource.
 *
 * This is not symmetry for its own sake — it is forced by how gigapipe
 * translates OTLP metrics to Prometheus series. Resource attributes do NOT
 * become labels on the metric series: they are collected into a separate
 * `target_info` gauge, and only `service.namespace`/`service.name` (as `job`)
 * and `service.instance.id` (as `instance`) propagate onto the series
 * themselves. Everything else on a series comes from the instrumentation scope
 * and from the DATA POINT's own attributes.
 *
 * So a metrics payload stamped only at the resource produces series like:
 *
 *     http_server_requests_total{job="checkout-api", route="/checkout"}
 *
 * with no `op_project_id` anywhere. The read-side matcher would then select
 * nothing for its own project — and a query without the matcher would select
 * every project's series. The boundary would be open in both directions.
 *
 * Verified empirically against a running gigapipe, not inferred: stamping only
 * the resource put `op_project_id` on `target_info` and left
 * `http_server_requests_total` unlabelled.
 *
 * FIELD NUMBERS
 *
 * The attribute field number differs per data-point type. Getting one wrong
 * would corrupt the payload, so each is named rather than assumed:
 *
 *   ResourceMetrics.scope_metrics                    = 2
 *   ScopeMetrics.metrics                             = 2
 *   Metric.gauge                                     = 5
 *   Metric.sum                                       = 7
 *   Metric.histogram                                 = 9
 *   Metric.exponential_histogram                     = 10
 *   Metric.summary                                   = 11
 *   {Gauge,Sum,Histogram,ExponentialHistogram,Summary}.data_points = 1
 *   NumberDataPoint.attributes                       = 7
 *   HistogramDataPoint.attributes                    = 9
 *   ExponentialHistogramDataPoint.attributes         = 1
 *   SummaryDataPoint.attributes                      = 7
 */

const FIELD_RESOURCE_METRICS = 1;
const FIELD_SCOPE_METRICS = 2;
const FIELD_METRICS = 2;
const FIELD_DATA_POINTS = 1;

/** Metric.<oneof data> field number -> that data point type's attributes field. */
const DATA_FIELD_TO_ATTRIBUTES: ReadonlyMap<number, number> = new Map([
  [5, 7], // gauge                 -> NumberDataPoint.attributes
  [7, 7], // sum                   -> NumberDataPoint.attributes
  [9, 9], // histogram             -> HistogramDataPoint.attributes
  [10, 1], // exponential_histogram -> ExponentialHistogramDataPoint.attributes
  [11, 7], // summary               -> SummaryDataPoint.attributes
]);

/** Rewrite one data point's attribute list. */
function stampDataPoint(
  dataPoint: Uint8Array,
  attributesField: number,
  projectId: string,
): Uint8Array {
  return stampAttributeList(dataPoint, attributesField, projectId);
}

/** Rewrite the `data_points` of one Gauge/Sum/Histogram/... message. */
function stampDataSet(
  dataSet: Uint8Array,
  attributesField: number,
  projectId: string,
): Uint8Array {
  return rewriteField(dataSet, FIELD_DATA_POINTS, (dp) => [
    stampDataPoint(dp, attributesField, projectId),
  ]);
}

/** Rewrite whichever `oneof data` variant this Metric carries. */
function stampMetric(metric: Uint8Array, projectId: string): Uint8Array {
  let out = metric;

  for (const [dataField, attributesField] of DATA_FIELD_TO_ATTRIBUTES) {
    out = rewriteField(out, dataField, (dataSet) => [
      stampDataSet(dataSet, attributesField, projectId),
    ]);
  }

  return out;
}

function stampScopeMetrics(scope: Uint8Array, projectId: string): Uint8Array {
  return rewriteField(scope, FIELD_METRICS, (metric) => [
    stampMetric(metric, projectId),
  ]);
}

/**
 * Stamp an OTLP metrics export request at both levels.
 *
 * The resource is still stamped — it is what makes `target_info` carry the
 * project, and `target_info` is how a services overview enumerates what is
 * reporting. The data points are what make the metric series themselves
 * queryable per project.
 */
export function stampOtlpMetricsRequest(
  body: Uint8Array,
  projectId: string,
): Uint8Array {
  assertValidProjectId(projectId);

  return rewriteField(body, FIELD_RESOURCE_METRICS, (entry) => {
    const withResource = stampResourceEntry(entry, projectId);

    return [
      rewriteField(withResource, FIELD_SCOPE_METRICS, (scope) => [
        stampScopeMetrics(scope, projectId),
      ]),
    ];
  });
}
