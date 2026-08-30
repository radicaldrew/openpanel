import { readFields, readStringField, WIRE_LEN } from './wire';

/**
 * Extract the series identity of every data point in an OTLP metrics payload.
 *
 * A "series" in Prometheus terms is a metric name plus its full label set, and
 * each distinct one costs a row in `time_series` and a row per label in
 * `time_series_gin`, forever. The classic way a metrics stack falls over is one
 * service putting something unbounded — a user id, a request id, a URL with a
 * query string — into an attribute, and discovering it a week later when
 * ClickHouse is out of disk.
 *
 * Counting series at the gateway is the only place it can be stopped cheaply:
 * once the rows are written, the fingerprint is part of the key and the data
 * cannot be rewritten in place, only deleted and re-ingested.
 *
 * The keys returned here are approximations of gigapipe's own fingerprint —
 * they do not need to match it exactly, because they are only used to COUNT
 * distinct series, never to look one up.
 */

const FIELD_RESOURCE_METRICS = 1;
const FIELD_SCOPE_METRICS = 2;
const FIELD_METRICS = 2;
const FIELD_METRIC_NAME = 1;
const FIELD_DATA_POINTS = 1;
const FIELD_KV_KEY = 1;
const FIELD_KV_VALUE = 2;
const FIELD_ANYVALUE_STRING = 1;

/** Metric.<oneof data> field -> that data point type's attributes field. */
const DATA_FIELD_TO_ATTRIBUTES: ReadonlyMap<number, number> = new Map([
  [5, 7],
  [7, 7],
  [9, 9],
  [10, 1],
  [11, 7],
]);

function attributeText(attr: Uint8Array): string | undefined {
  const key = readStringField(attr, FIELD_KV_KEY);
  if (key === undefined) {
    return undefined;
  }

  let value = '';
  for (const field of readFields(attr)) {
    if (field.fieldNumber === FIELD_KV_VALUE && field.wireType === WIRE_LEN) {
      // Only string values contribute to identity here. A non-string AnyValue
      // still forms a distinct series, so it is represented by its raw byte
      // length rather than being ignored — enough to distinguish, cheap to
      // compute, and it never tries to interpret a nested value.
      value =
        readStringField(field.value, FIELD_ANYVALUE_STRING) ??
        `#${field.value.length}`;
    }
  }

  return `${key}=${value}`;
}

function dataPointKey(
  metricName: string,
  dataPoint: Uint8Array,
  attributesField: number,
): string {
  const parts: string[] = [];

  for (const field of readFields(dataPoint)) {
    if (field.fieldNumber !== attributesField || field.wireType !== WIRE_LEN) {
      continue;
    }

    const text = attributeText(field.value);
    if (text !== undefined) {
      parts.push(text);
    }
  }

  // Sorted so that attribute ordering — which OTLP does not guarantee — cannot
  // make one logical series look like several.
  parts.sort();

  return `${metricName}{${parts.join(',')}}`;
}

/**
 * Every distinct series key in the payload.
 *
 * Deduplicated within the request: a single export legitimately carries many
 * data points for the same series across time, and counting those as separate
 * series would make the budget meaningless.
 */
export function seriesKeysFromMetricsPayload(body: Uint8Array): string[] {
  const keys = new Set<string>();

  for (const rm of readFields(body)) {
    if (rm.fieldNumber !== FIELD_RESOURCE_METRICS || rm.wireType !== WIRE_LEN) {
      continue;
    }

    for (const sm of readFields(rm.value)) {
      if (sm.fieldNumber !== FIELD_SCOPE_METRICS || sm.wireType !== WIRE_LEN) {
        continue;
      }

      for (const metric of readFields(sm.value)) {
        if (metric.fieldNumber !== FIELD_METRICS || metric.wireType !== WIRE_LEN) {
          continue;
        }

        const name =
          readStringField(metric.value, FIELD_METRIC_NAME) ?? '<unnamed>';

        for (const data of readFields(metric.value)) {
          const attributesField = DATA_FIELD_TO_ATTRIBUTES.get(data.fieldNumber);
          if (attributesField === undefined || data.wireType !== WIRE_LEN) {
            continue;
          }

          for (const dp of readFields(data.value)) {
            if (dp.fieldNumber !== FIELD_DATA_POINTS || dp.wireType !== WIRE_LEN) {
              continue;
            }

            keys.add(dataPointKey(name, dp.value, attributesField));
          }
        }
      }
    }
  }

  return [...keys];
}
