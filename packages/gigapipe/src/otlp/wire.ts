/**
 * Minimal protobuf wire-format primitives — enough to edit one nested field of
 * a message without knowing the rest of its schema.
 *
 * WHY NOT A REAL PROTOBUF LIBRARY
 *
 * The gateway's job on an OTLP payload is tiny: remove any resource attribute
 * that could collide with `op_project_id`, then add ours. Everything else must
 * arrive at gigapipe byte-for-byte identical.
 *
 * A schema-driven decode/re-encode cannot promise that. `Message.decode()`
 * DROPS fields the compiled schema does not know about, so the moment
 * OpenTelemetry adds a field — or we vendor a `.proto` that is a minor version
 * behind — the gateway silently deletes customer telemetry, and nothing fails
 * loudly. `@opentelemetry/otlp-transformer` cannot decode wire requests at all
 * (it serializes from SDK objects and deserializes responses), and no `.proto`
 * files ship in the dependency tree, so the schema route would also mean
 * vendoring and then tracking upstream forever.
 *
 * Wire-level editing inverts the default: bytes are copied verbatim unless a
 * rule explicitly rewrites them. Unknown fields survive because nothing looks
 * at them. The gateway needs exactly three field numbers, all of which are
 * frozen by protobuf's own compatibility rules — a field number cannot be
 * reused for a different meaning without breaking every OTLP implementation in
 * existence.
 *
 * Reference: https://protobuf.dev/programming-guides/encoding/
 */

export const WIRE_VARINT = 0;
export const WIRE_FIXED64 = 1;
export const WIRE_LEN = 2;
export const WIRE_SGROUP = 3;
export const WIRE_EGROUP = 4;
export const WIRE_FIXED32 = 5;

export class ProtobufWireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtobufWireError';
  }
}

interface Varint {
  value: number;
  next: number;
}

/**
 * Decode a base-128 varint.
 *
 * Capped at 10 bytes (the maximum for a 64-bit varint) so a malformed payload
 * of continuation bytes cannot spin. Values are returned as JS numbers, which
 * is exact for everything this module reads — tags and lengths, never the
 * 64-bit timestamps or counters inside the message body, which are copied as
 * opaque bytes.
 */
export function readVarint(buf: Uint8Array, offset: number): Varint {
  let value = 0;
  let shift = 0;
  let pos = offset;

  for (let i = 0; i < 10; i++) {
    if (pos >= buf.length) {
      throw new ProtobufWireError(
        `Truncated varint at offset ${offset} (buffer is ${buf.length} bytes)`,
      );
    }

    const byte = buf[pos] as number;
    pos += 1;

    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      return { value, next: pos };
    }

    shift += 7;
  }

  throw new ProtobufWireError(`Varint longer than 10 bytes at offset ${offset}`);
}

export function encodeVarint(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0) {
    throw new ProtobufWireError(`Cannot encode ${value} as a varint`);
  }

  const out: number[] = [];
  let remaining = value;

  do {
    let byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) {
      byte |= 0x80;
    }
    out.push(byte);
  } while (remaining > 0);

  return Uint8Array.from(out);
}

export interface WireField {
  fieldNumber: number;
  wireType: number;
  /** Value bytes only — for WIRE_LEN this excludes the length prefix. */
  value: Uint8Array;
  /** The complete field including its tag, for verbatim copying. */
  raw: Uint8Array;
}

/**
 * Walk every top-level field of a message.
 *
 * Groups (wire types 3 and 4) are rejected rather than skipped. They are
 * deprecated and absent from OTLP; encountering one means the payload is not
 * what we think it is, and guessing at that point risks emitting a corrupted
 * message. Fail closed.
 */
export function* readFields(buf: Uint8Array): Generator<WireField> {
  let pos = 0;

  while (pos < buf.length) {
    const start = pos;
    const tag = readVarint(buf, pos);
    pos = tag.next;

    const fieldNumber = Math.floor(tag.value / 8);
    const wireType = tag.value & 0x7;

    if (fieldNumber === 0) {
      throw new ProtobufWireError('Field number 0 is not valid');
    }

    let value: Uint8Array;

    switch (wireType) {
      case WIRE_VARINT: {
        const v = readVarint(buf, pos);
        value = buf.subarray(pos, v.next);
        pos = v.next;
        break;
      }
      case WIRE_FIXED64: {
        value = buf.subarray(pos, pos + 8);
        pos += 8;
        break;
      }
      case WIRE_LEN: {
        const len = readVarint(buf, pos);
        const from = len.next;
        const to = from + len.value;
        if (to > buf.length) {
          throw new ProtobufWireError(
            `Length-delimited field ${fieldNumber} claims ${len.value} bytes but only ${buf.length - from} remain`,
          );
        }
        value = buf.subarray(from, to);
        pos = to;
        break;
      }
      case WIRE_FIXED32: {
        value = buf.subarray(pos, pos + 4);
        pos += 4;
        break;
      }
      default:
        throw new ProtobufWireError(
          `Unsupported wire type ${wireType} for field ${fieldNumber}`,
        );
    }

    if (pos > buf.length) {
      throw new ProtobufWireError(
        `Field ${fieldNumber} runs past the end of the buffer`,
      );
    }

    yield { fieldNumber, wireType, value, raw: buf.subarray(start, pos) };
  }
}

export function encodeTag(fieldNumber: number, wireType: number): Uint8Array {
  return encodeVarint(fieldNumber * 8 + wireType);
}

/** Encode one length-delimited field: tag, length, then the payload. */
export function encodeLengthDelimited(
  fieldNumber: number,
  payload: Uint8Array,
): Uint8Array {
  return Buffer.concat([
    encodeTag(fieldNumber, WIRE_LEN),
    encodeVarint(payload.length),
    payload,
  ]);
}

export function encodeStringField(
  fieldNumber: number,
  value: string,
): Uint8Array {
  return encodeLengthDelimited(fieldNumber, Buffer.from(value, 'utf8'));
}

/**
 * Rewrite every length-delimited occurrence of one field, copying all other
 * bytes verbatim.
 *
 * `transform` receives the field's value bytes and returns replacements — an
 * empty array drops the field. When the field never appears, `ifAbsent` (if
 * given) supplies a value to append, which is how a missing `Resource` gets
 * created rather than skipped.
 */
export function rewriteField(
  message: Uint8Array,
  fieldNumber: number,
  transform: (value: Uint8Array) => Uint8Array[],
  ifAbsent?: () => Uint8Array | undefined,
): Uint8Array {
  const parts: Uint8Array[] = [];
  let seen = false;

  for (const field of readFields(message)) {
    if (field.fieldNumber !== fieldNumber || field.wireType !== WIRE_LEN) {
      parts.push(field.raw);
      continue;
    }

    seen = true;
    for (const replacement of transform(field.value)) {
      parts.push(encodeLengthDelimited(fieldNumber, replacement));
    }
  }

  if (!seen && ifAbsent) {
    const created = ifAbsent();
    if (created !== undefined) {
      parts.push(encodeLengthDelimited(fieldNumber, created));
    }
  }

  return Buffer.concat(parts);
}

/** Read the first length-delimited occurrence of a field as a UTF-8 string. */
export function readStringField(
  message: Uint8Array,
  fieldNumber: number,
): string | undefined {
  for (const field of readFields(message)) {
    if (field.fieldNumber === fieldNumber && field.wireType === WIRE_LEN) {
      return Buffer.from(field.value).toString('utf8');
    }
  }

  return undefined;
}
