import {
  PROJECT_LABEL,
  assertValidProjectId,
  isReservedAttributeKey,
} from '../tenancy/project-label';
import {
  encodeLengthDelimited,
  encodeStringField,
  readFields,
  readStringField,
  rewriteField,
  WIRE_LEN,
} from '../otlp/wire';

/**
 * Stamp a Prometheus remote-write payload.
 *
 * Operates on the DECOMPRESSED protobuf: snappy is the transport's business and
 * belongs at the gateway, not here, so this stays dependency-free and testable
 * without a native module.
 *
 * Field numbers (prometheus/prompb/remote.proto, types.proto):
 *   WriteRequest.timeseries = 1
 *   TimeSeries.labels = 1, .samples = 2
 *   Label.name = 1, .value = 2
 *
 * THE SORTING RULE
 *
 * The remote-write specification requires a TimeSeries' labels to be sorted
 * lexicographically by name, and receivers are entitled to rely on it — several
 * compute the series fingerprint by hashing labels in order, so an out-of-order
 * set silently produces a *different series* rather than an error. Appending
 * `op_project_id` at the end would therefore be wrong for exactly the values
 * that sort before it. So the label list is rebuilt in sorted order.
 */

const FIELD_TIMESERIES = 1;
const FIELD_LABELS = 1;
const LABEL_NAME = 1;
const LABEL_VALUE = 2;

function encodeLabel(name: string, value: string): Uint8Array {
  return Buffer.concat([
    encodeStringField(LABEL_NAME, name),
    encodeStringField(LABEL_VALUE, value),
  ]);
}

/**
 * Rebuild one TimeSeries' label set: drop reserved names, add ours, sort.
 *
 * Everything that is not a label — samples, exemplars, histograms, and any
 * field a newer Prometheus adds — is copied through verbatim, in place.
 */
function stampTimeSeries(series: Uint8Array, projectId: string): Uint8Array {
  const labels: { name: string; value: string }[] = [];
  const others: Uint8Array[] = [];

  for (const field of readFields(series)) {
    if (field.fieldNumber !== FIELD_LABELS || field.wireType !== WIRE_LEN) {
      others.push(field.raw);
      continue;
    }

    const name = readStringField(field.value, LABEL_NAME);
    if (name === undefined) {
      continue;
    }

    // Same reserved-prefix rule as every other signal, so a forged label cannot
    // arrive by this path either.
    if (isReservedAttributeKey(name)) {
      continue;
    }

    labels.push({
      name,
      value: readStringField(field.value, LABEL_VALUE) ?? '',
    });
  }

  labels.push({ name: PROJECT_LABEL, value: projectId });
  labels.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return Buffer.concat([
    ...labels.map((l) => encodeLengthDelimited(FIELD_LABELS, encodeLabel(l.name, l.value))),
    ...others,
  ]);
}

export function stampRemoteWriteRequest(
  body: Uint8Array,
  projectId: string,
): Uint8Array {
  assertValidProjectId(projectId);

  return rewriteField(body, FIELD_TIMESERIES, (series) => [
    stampTimeSeries(series, projectId),
  ]);
}

/** Read back the project labels present, for the pre-forward assertion. */
export function readRemoteWriteProjectIds(body: Uint8Array): string[] {
  const found: string[] = [];

  for (const series of readFields(body)) {
    if (series.fieldNumber !== FIELD_TIMESERIES || series.wireType !== WIRE_LEN) {
      continue;
    }

    for (const label of readFields(series.value)) {
      if (label.fieldNumber !== FIELD_LABELS || label.wireType !== WIRE_LEN) {
        continue;
      }

      if (readStringField(label.value, LABEL_NAME) === PROJECT_LABEL) {
        found.push(readStringField(label.value, LABEL_VALUE) ?? '');
      }
    }
  }

  return found;
}
