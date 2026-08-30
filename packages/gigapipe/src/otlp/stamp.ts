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
} from './wire';

/**
 * Stamp `op_project_id` onto every resource in an OTLP export request, and
 * remove anything that could be mistaken for it.
 *
 * The OTLP field numbers used here. All three are load-bearing and all three
 * are frozen by protobuf compatibility — a field number cannot change meaning
 * without breaking every OTLP implementation:
 *
 *   ExportMetricsServiceRequest.resource_metrics = 1
 *   ExportLogsServiceRequest.resource_logs       = 1
 *   ExportTraceServiceRequest.resource_spans     = 1
 *   Resource{Metrics,Logs,Spans}.resource        = 1
 *   Resource.attributes                          = 1
 *   KeyValue.key                                 = 1
 *   KeyValue.value                               = 2
 *   AnyValue.string_value                        = 1
 *
 * The three signal request types share the same shape at the levels we touch,
 * which is why one function covers all of them.
 */

const FIELD_RESOURCE_ENTRIES = 1;
const FIELD_RESOURCE = 1;
const FIELD_ATTRIBUTES = 1;
const FIELD_KV_KEY = 1;
const FIELD_KV_VALUE = 2;
const FIELD_ANYVALUE_STRING = 1;

/** `KeyValue{ key: <key>, value: AnyValue{ string_value: <value> } }` */
function encodeStringKeyValue(key: string, value: string): Uint8Array {
  const anyValue = encodeStringField(FIELD_ANYVALUE_STRING, value);

  return Buffer.concat([
    encodeStringField(FIELD_KV_KEY, key),
    encodeLengthDelimited(FIELD_KV_VALUE, anyValue),
  ]);
}

/**
 * Rewrite one `Resource`: drop reserved attributes, then append ours.
 *
 * Order is the whole point. Appending into a bag that still holds a colliding
 * key leaves two attributes that sanitize to the same label name, and gigapipe
 * resolves that by iteration order — on the OTLP logs path record attributes
 * merge last and win, so the forged value would be the one that survives.
 * Stripping first makes the outcome independent of anyone's iteration order.
 */
export function stampAttributeList(
  message: Uint8Array,
  attributesField: number,
  projectId: string,
): Uint8Array {
  const kept: Uint8Array[] = [];

  for (const field of readFields(message)) {
    if (
      field.fieldNumber !== attributesField ||
      field.wireType !== WIRE_LEN
    ) {
      // Not an attribute — Resource.dropped_attributes_count, or a field added
      // by a newer OTLP version. Copy it through untouched.
      kept.push(field.raw);
      continue;
    }

    const key = readStringField(field.value, FIELD_KV_KEY);

    // A KeyValue with no key cannot be addressed by any query, and gigapipe
    // nil-derefs on some valueless entries. Dropping it is both safe and a
    // small robustness win for the backend.
    if (key === undefined) {
      continue;
    }

    if (isReservedAttributeKey(key)) {
      continue;
    }

    kept.push(field.raw);
  }

  kept.push(
    encodeLengthDelimited(
      attributesField,
      encodeStringKeyValue(PROJECT_LABEL, projectId),
    ),
  );

  return Buffer.concat(kept);
}

/**
 * Remove reserved attributes WITHOUT adding ours.
 *
 * Used where a client-controlled attribute bag needs sanitising but does not
 * need to carry the label itself — span, event and link attributes on traces,
 * where the resource-level stamp already puts `op_project_id` into the
 * attribute index once per span.
 */
export function stripReservedAttributes(
  message: Uint8Array,
  attributesField: number,
): Uint8Array {
  return rewriteField(message, attributesField, (attr) => {
    const key = readStringField(attr, FIELD_KV_KEY);

    if (key === undefined || isReservedAttributeKey(key)) {
      return [];
    }

    return [attr];
  });
}

/** Convenience wrapper for a `Resource` message, whose attributes are field 1. */
function stampResource(resource: Uint8Array, projectId: string): Uint8Array {
  return stampAttributeList(resource, FIELD_ATTRIBUTES, projectId);
}

/**
 * Rewrite the `resource` of one Resource{Metrics,Logs,Spans} entry, creating it
 * when absent so an entry can never reach gigapipe carrying no project label.
 */
export function stampResourceEntry(
  entry: Uint8Array,
  projectId: string,
): Uint8Array {
  return rewriteField(
    entry,
    FIELD_RESOURCE,
    (resource) => [stampResource(resource, projectId)],
    () => stampResource(new Uint8Array(0), projectId),
  );
}

/**
 * Stamp every resource in an OTLP export request.
 *
 * Works for metrics, logs and traces: the outer repeated field and the nested
 * `resource` field are field 1 in all three.
 *
 * A `ResourceMetrics` with no `resource` at all gets one created rather than
 * skipped — otherwise its data points would reach gigapipe carrying no project
 * label, which is exactly the unscoped write the boundary exists to prevent.
 */
export function stampOtlpRequest(
  body: Uint8Array,
  projectId: string,
): Uint8Array {
  assertValidProjectId(projectId);

  return rewriteField(body, FIELD_RESOURCE_ENTRIES, (entry) => [
    stampResourceEntry(entry, projectId),
  ]);
}

/**
 * Read back every `op_project_id` value present in a request.
 *
 * Used by the tests and by an assertion on the forwarding path: if a payload
 * about to be sent to gigapipe carries anything other than exactly the
 * authenticated project on every resource, the request is refused rather than
 * forwarded. Cheap, and it turns any future bug in the rewrite above into a
 * rejected request instead of a cross-tenant write.
 */
export function readStampedProjectIds(body: Uint8Array): string[] {
  const found: string[] = [];

  for (const entry of readFields(body)) {
    if (
      entry.fieldNumber !== FIELD_RESOURCE_ENTRIES ||
      entry.wireType !== WIRE_LEN
    ) {
      continue;
    }

    for (const resourceField of readFields(entry.value)) {
      if (
        resourceField.fieldNumber !== FIELD_RESOURCE ||
        resourceField.wireType !== WIRE_LEN
      ) {
        continue;
      }

      for (const attr of readFields(resourceField.value)) {
        if (
          attr.fieldNumber !== FIELD_ATTRIBUTES ||
          attr.wireType !== WIRE_LEN
        ) {
          continue;
        }

        if (readStringField(attr.value, FIELD_KV_KEY) !== PROJECT_LABEL) {
          continue;
        }

        const anyValue = attr.value;
        for (const v of readFields(anyValue)) {
          if (v.fieldNumber === FIELD_KV_VALUE && v.wireType === WIRE_LEN) {
            const s = readStringField(v.value, FIELD_ANYVALUE_STRING);
            if (s !== undefined) {
              found.push(s);
            }
          }
        }
      }
    }
  }

  return found;
}

export class UnscopedPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnscopedPayloadError';
  }
}

/**
 * Last line of defence before forwarding. Never trust the rewrite blindly.
 */
export function assertPayloadScopedTo(
  body: Uint8Array,
  projectId: string,
): void {
  const found = readStampedProjectIds(body);
  const wrong = found.filter((id) => id !== projectId);

  if (wrong.length > 0) {
    throw new UnscopedPayloadError(
      `Refusing to forward: payload carries ${wrong.length} resource(s) labelled for another project`,
    );
  }
}
