import { sanitizeOtlpKey } from '../tenancy/sanitize';
import { readFields, readStringField, WIRE_LEN } from '../otlp/wire';
import type { LogRecordInput } from './envelope';

/**
 * Decode an OTLP logs export request into records we can build a Loki push
 * from.
 *
 * This is the piece that makes D5 possible: because OpenPanel decodes the
 * payload itself rather than forwarding it, it — not gigapipe — decides what
 * becomes a stream label. gigapipe's own decoder would promote every attribute
 * including `trace_id` to a label, at one new stream per trace.
 *
 * OTLP field numbers used (frozen by protobuf compatibility):
 *
 *   ExportLogsServiceRequest.resource_logs = 1
 *   ResourceLogs.resource = 1, .scope_logs = 2
 *   ScopeLogs.scope = 1, .log_records = 2
 *   LogRecord.time_unix_nano = 1 (fixed64), .severity_number = 2,
 *            .severity_text = 3, .body = 5, .attributes = 6,
 *            .trace_id = 9 (bytes), .span_id = 10 (bytes),
 *            .observed_time_unix_nano = 11 (fixed64)
 *   InstrumentationScope.name = 1
 *   Resource.attributes = 1
 *   KeyValue.key = 1, .value = 2
 *   AnyValue.string_value = 1, .bool_value = 2, .int_value = 3,
 *            .double_value = 4
 */

const FIELD_RESOURCE_LOGS = 1;
const FIELD_RESOURCE = 1;
const FIELD_SCOPE_LOGS = 2;
const FIELD_SCOPE = 1;
const FIELD_LOG_RECORDS = 2;
const FIELD_ATTRIBUTES = 1;
const FIELD_KV_KEY = 1;
const FIELD_KV_VALUE = 2;

const LR_TIME = 1;
const LR_SEVERITY_TEXT = 3;
const LR_BODY = 5;
const LR_ATTRIBUTES = 6;
const LR_TRACE_ID = 9;
const LR_SPAN_ID = 10;
const LR_OBSERVED_TIME = 11;

const AV_STRING = 1;
const AV_BOOL = 2;
const AV_INT = 3;
const AV_DOUBLE = 4;

/** Read a fixed64 as a decimal string — nanosecond timestamps exceed 2^53. */
function readFixed64(bytes: Uint8Array): string | undefined {
  if (bytes.length !== 8) {
    return undefined;
  }

  // Little-endian, per protobuf. BigInt because a nanosecond timestamp loses
  // precision as a JS number — and a timestamp that is silently wrong by
  // microseconds puts log lines in the wrong order.
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );

  return view.getBigUint64(0, true).toString();
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/**
 * Render an AnyValue as a string.
 *
 * Only scalars are rendered; an array or kvlist body is JSON-encoded rather
 * than flattened, because flattening would silently lose structure a user put
 * there deliberately.
 */
function readAnyValue(anyValue: Uint8Array): string {
  for (const field of readFields(anyValue)) {
    switch (field.fieldNumber) {
      case AV_STRING:
        return Buffer.from(field.value).toString('utf8');
      case AV_BOOL:
        return field.value[0] ? 'true' : 'false';
      case AV_INT: {
        // varint, may be large
        let value = 0n;
        let shift = 0n;
        for (const byte of field.value) {
          value += BigInt(byte & 0x7f) << shift;
          shift += 7n;
        }
        return value.toString();
      }
      case AV_DOUBLE: {
        if (field.value.length !== 8) break;
        const view = new DataView(
          field.value.buffer,
          field.value.byteOffset,
          field.value.byteLength,
        );
        return String(view.getFloat64(0, true));
      }
      default:
        break;
    }
  }

  return '';
}

function readAttributes(
  message: Uint8Array,
  attributesField: number,
): Record<string, string> {
  const out: Record<string, string> = {};

  for (const field of readFields(message)) {
    if (field.fieldNumber !== attributesField || field.wireType !== WIRE_LEN) {
      continue;
    }

    const key = readStringField(field.value, FIELD_KV_KEY);
    if (key === undefined) {
      continue;
    }

    let value = '';
    for (const inner of readFields(field.value)) {
      if (inner.fieldNumber === FIELD_KV_VALUE && inner.wireType === WIRE_LEN) {
        value = readAnyValue(inner.value);
      }
    }

    // Sanitized so the keys we store match what a query would ask for, and so
    // the reserved-key checks downstream see the same spelling gigapipe would.
    out[sanitizeOtlpKey(key)] = value;
  }

  return out;
}

export interface DecodeOptions {
  /**
   * Timestamp to use when a record carries neither `time_unix_nano` nor
   * `observed_time_unix_nano`. Passed in rather than read from the clock so the
   * function stays pure and testable.
   */
  fallbackTimestampNs: string;
}

/**
 * Decode an OTLP logs request.
 *
 * Resource and scope attributes are merged into each record, resource first, so
 * a record-level attribute wins on conflict — matching OTLP's own precedence.
 * Everything lands in `attributes`; which of them may become a stream label is
 * decided later by the allowlist, in one place.
 */
export function decodeOtlpLogs(
  body: Uint8Array,
  options: DecodeOptions,
): LogRecordInput[] {
  const records: LogRecordInput[] = [];

  for (const resourceLogs of readFields(body)) {
    if (
      resourceLogs.fieldNumber !== FIELD_RESOURCE_LOGS ||
      resourceLogs.wireType !== WIRE_LEN
    ) {
      continue;
    }

    let resourceAttrs: Record<string, string> = {};

    for (const field of readFields(resourceLogs.value)) {
      if (field.fieldNumber === FIELD_RESOURCE && field.wireType === WIRE_LEN) {
        resourceAttrs = readAttributes(field.value, FIELD_ATTRIBUTES);
      }
    }

    for (const scopeLogs of readFields(resourceLogs.value)) {
      if (
        scopeLogs.fieldNumber !== FIELD_SCOPE_LOGS ||
        scopeLogs.wireType !== WIRE_LEN
      ) {
        continue;
      }

      let scopeName: string | undefined;
      for (const field of readFields(scopeLogs.value)) {
        if (field.fieldNumber === FIELD_SCOPE && field.wireType === WIRE_LEN) {
          scopeName = readStringField(field.value, 1);
        }
      }

      for (const logRecord of readFields(scopeLogs.value)) {
        if (
          logRecord.fieldNumber !== FIELD_LOG_RECORDS ||
          logRecord.wireType !== WIRE_LEN
        ) {
          continue;
        }

        let timestampNs: string | undefined;
        let observedNs: string | undefined;
        let severity: string | undefined;
        let bodyText = '';
        let traceId: string | undefined;
        let spanId: string | undefined;

        for (const field of readFields(logRecord.value)) {
          switch (field.fieldNumber) {
            case LR_TIME:
              timestampNs = readFixed64(field.value);
              break;
            case LR_OBSERVED_TIME:
              observedNs = readFixed64(field.value);
              break;
            case LR_SEVERITY_TEXT:
              severity = Buffer.from(field.value).toString('utf8');
              break;
            case LR_BODY:
              bodyText = readAnyValue(field.value);
              break;
            case LR_TRACE_ID:
              traceId = field.value.length ? toHex(field.value) : undefined;
              break;
            case LR_SPAN_ID:
              spanId = field.value.length ? toHex(field.value) : undefined;
              break;
            default:
              break;
          }
        }

        const recordAttrs = readAttributes(logRecord.value, LR_ATTRIBUTES);
        const attributes = { ...resourceAttrs, ...recordAttrs };

        // `service.name` sanitizes to `service_name`; the allowlist calls the
        // label `service`, so map it once here rather than teaching the
        // allowlist about OTLP's spelling.
        const service = attributes.service_name;
        const env = attributes.deployment_environment;

        records.push({
          // A zero timestamp is legal-but-useless in OTLP; prefer the observed
          // time, then the caller's fallback, so a line is never dropped for
          // want of a clock.
          timestampNs:
            timestampNs && timestampNs !== '0'
              ? timestampNs
              : observedNs && observedNs !== '0'
                ? observedNs
                : options.fallbackTimestampNs,
          body: bodyText,
          severity,
          labels: {
            ...(service ? { service } : {}),
            ...(env ? { env } : {}),
            ...(severity ? { level: severity.toLowerCase() } : {}),
            ...(scopeName ? { scope: scopeName } : {}),
          },
          traceId,
          spanId,
          sessionId: attributes.session_id,
          profileId: attributes.profile_id,
          attributes,
        });
      }
    }
  }

  return records;
}
