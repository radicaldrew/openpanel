import { describe, expect, it } from 'vitest';
import { PROJECT_LABEL, InvalidProjectIdError } from '../tenancy/project-label';
import {
  UnscopedPayloadError,
  assertPayloadScopedTo,
  readStampedProjectIds,
  stampOtlpRequest,
} from './stamp';
import {
  encodeLengthDelimited,
  encodeStringField,
  encodeTag,
  encodeVarint,
  ProtobufWireError,
  readFields,
  WIRE_VARINT,
} from './wire';

// --- fixture builders (mirror the OTLP field numbers in stamp.ts) -----------

const kv = (key: string, value: string) =>
  Buffer.concat([
    encodeStringField(1, key),
    encodeLengthDelimited(2, encodeStringField(1, value)),
  ]);

const resource = (attrs: Uint8Array[], extra: Uint8Array[] = []) =>
  Buffer.concat([...attrs.map((a) => encodeLengthDelimited(1, a)), ...extra]);

const resourceEntry = (res?: Uint8Array, extra: Uint8Array[] = []) =>
  Buffer.concat([
    ...(res ? [encodeLengthDelimited(1, res)] : []),
    ...extra,
  ]);

const request = (entries: Uint8Array[]) =>
  Buffer.concat(entries.map((e) => encodeLengthDelimited(1, e)));

const attrsOf = (body: Uint8Array): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const entry of readFields(body)) {
    for (const resField of readFields(entry.value)) {
      if (resField.fieldNumber !== 1) continue;
      for (const attr of readFields(resField.value)) {
        if (attr.fieldNumber !== 1) continue;
        let k: string | undefined;
        let v: string | undefined;
        for (const f of readFields(attr.value)) {
          if (f.fieldNumber === 1) k = Buffer.from(f.value).toString('utf8');
          if (f.fieldNumber === 2) {
            for (const inner of readFields(f.value)) {
              if (inner.fieldNumber === 1)
                v = Buffer.from(inner.value).toString('utf8');
            }
          }
        }
        if (k !== undefined) out[k] = v ?? '';
      }
    }
  }
  return out;
};

// --- the encoder is checked against bytes computed by hand ------------------

describe('wire encoding', () => {
  it('matches hand-computed protobuf bytes', () => {
    // KeyValue{key:"a", value:AnyValue{string_value:"b"}}
    //   0A 01 61            field 1 (key), len 1, 'a'
    //   12 03 0A 01 62      field 2 (value), len 3, AnyValue{0A 01 62}
    expect(Buffer.from(kv('a', 'b')).toString('hex')).toBe('0a0161' + '12030a0162');

    // ExportMetricsServiceRequest{ resource_metrics:[ { resource:{ attributes:[kv] } } ] }
    const built = request([resourceEntry(resource([kv('a', 'b')]))]);
    expect(Buffer.from(built).toString('hex')).toBe(
      '0a0c' + '0a0a' + '0a08' + '0a0161' + '12030a0162',
    );
  });

  it('round-trips varints at byte boundaries', () => {
    for (const n of [0, 1, 127, 128, 300, 16383, 16384, 2 ** 31, 2 ** 40]) {
      const buf = encodeVarint(n);
      const round = Buffer.concat([encodeTag(1, WIRE_VARINT), buf]);
      const [field] = [...readFields(round)];
      expect(Buffer.from(field!.value).toString('hex')).toBe(
        Buffer.from(buf).toString('hex'),
      );
    }
  });

  it('rejects a truncated length-delimited field rather than guessing', () => {
    // field 1, LEN, claims 10 bytes but supplies 2
    const bad = Buffer.from([0x0a, 0x0a, 0x01, 0x02]);
    expect(() => [...readFields(bad)]).toThrow(ProtobufWireError);
  });
});

describe('stampOtlpRequest', () => {
  it('adds the project label to a resource that has none', () => {
    const body = request([resourceEntry(resource([kv('service.name', 'api')]))]);
    const out = stampOtlpRequest(body, 'proj_123');

    expect(attrsOf(out)).toEqual({
      'service.name': 'api',
      [PROJECT_LABEL]: 'proj_123',
    });
  });

  it('overwrites a client-supplied label instead of trusting it', () => {
    const body = request([
      resourceEntry(resource([kv(PROJECT_LABEL, 'someone-else')])),
    ]);
    const out = stampOtlpRequest(body, 'proj_123');

    expect(attrsOf(out)).toEqual({ [PROJECT_LABEL]: 'proj_123' });
    expect(readStampedProjectIds(out)).toEqual(['proj_123']);
  });

  it.each([
    ['ascii hyphen', 'op-project-id'],
    ['en dash', 'op–project–id'],
    ['no-break space', 'op project id'],
    ['cyrillic i', 'opіprojectіid'],
    ['astral emoji', 'op\u{1f642}project\u{1f642}id'],
    ['uppercase', 'OP_PROJECT_ID'],
    ['reserved prefix', 'op_future_label'],
  ])('strips a forged spelling (%s) before stamping', (_name, forged) => {
    const body = request([
      resourceEntry(resource([kv(forged, 'forged'), kv('service.name', 'api')])),
    ]);
    const out = stampOtlpRequest(body, 'proj_123');

    expect(attrsOf(out)).toEqual({
      'service.name': 'api',
      [PROJECT_LABEL]: 'proj_123',
    });
    expect(Object.values(attrsOf(out))).not.toContain('forged');
    // Exactly one label — not ours plus a colliding one whose winner would
    // depend on gigapipe's merge order.
    expect(readStampedProjectIds(out)).toEqual(['proj_123']);
  });

  it('creates a resource when the entry has none, rather than passing it through unscoped', () => {
    // A ResourceMetrics carrying only scope_metrics (field 2) and no resource.
    const scopeMetrics = encodeLengthDelimited(2, encodeStringField(1, 'scope'));
    const body = request([resourceEntry(undefined, [scopeMetrics])]);

    const out = stampOtlpRequest(body, 'proj_123');

    expect(readStampedProjectIds(out)).toEqual(['proj_123']);
  });

  it('stamps every resource entry, not just the first', () => {
    const body = request([
      resourceEntry(resource([kv('service.name', 'a')])),
      resourceEntry(resource([kv('service.name', 'b')])),
      resourceEntry(resource([kv(PROJECT_LABEL, 'forged')])),
    ]);

    expect(readStampedProjectIds(stampOtlpRequest(body, 'proj_123'))).toEqual([
      'proj_123',
      'proj_123',
      'proj_123',
    ]);
  });

  it('preserves fields it does not understand, byte for byte', () => {
    // A field number OTLP does not currently use, at both levels — standing in
    // for whatever a future OTLP version adds. If schema-driven decoding were
    // used here, these would be silently dropped.
    const unknownInResource = Buffer.concat([
      encodeTag(99, WIRE_VARINT),
      encodeVarint(42),
    ]);
    const unknownInEntry = encodeLengthDelimited(77, Buffer.from('payload'));
    const scopeMetrics = encodeLengthDelimited(2, Buffer.from('opaque-metrics'));

    const body = request([
      resourceEntry(resource([kv('service.name', 'api')], [unknownInResource]), [
        scopeMetrics,
        unknownInEntry,
      ]),
    ]);

    const out = stampOtlpRequest(body, 'proj_123');
    const hex = Buffer.from(out).toString('hex');

    expect(hex).toContain(Buffer.from(unknownInResource).toString('hex'));
    expect(hex).toContain(Buffer.from(unknownInEntry).toString('hex'));
    expect(hex).toContain(Buffer.from(scopeMetrics).toString('hex'));
    expect(attrsOf(out)['service.name']).toBe('api');
  });

  it('leaves an empty request empty', () => {
    expect(stampOtlpRequest(new Uint8Array(0), 'proj_123')).toHaveLength(0);
  });

  it('refuses an invalid project id', () => {
    const body = request([resourceEntry(resource([]))]);
    expect(() => stampOtlpRequest(body, 'has space')).toThrow(
      InvalidProjectIdError,
    );
  });
});

describe('assertPayloadScopedTo', () => {
  it('passes for a correctly stamped payload', () => {
    const out = stampOtlpRequest(
      request([resourceEntry(resource([kv('service.name', 'api')]))]),
      'proj_123',
    );

    expect(() => assertPayloadScopedTo(out, 'proj_123')).not.toThrow();
  });

  it('refuses to forward a payload labelled for another project', () => {
    // Simulates the rewrite having failed: this is the assertion that turns a
    // future bug in stampOtlpRequest into a rejected request rather than a
    // cross-tenant write.
    const unstamped = request([
      resourceEntry(resource([kv(PROJECT_LABEL, 'other-project')])),
    ]);

    expect(() => assertPayloadScopedTo(unstamped, 'proj_123')).toThrow(
      UnscopedPayloadError,
    );
  });
});
