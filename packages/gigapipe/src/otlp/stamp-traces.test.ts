import { describe, expect, it } from 'vitest';
import { PROJECT_LABEL } from '../tenancy/project-label';
import { readStampedProjectIds } from './stamp';
import { stampOtlpTracesRequest } from './stamp-traces';
import { encodeLengthDelimited, encodeStringField, readFields } from './wire';

const kv = (key: string, value: string) =>
  Buffer.concat([
    encodeStringField(1, key),
    encodeLengthDelimited(2, encodeStringField(1, value)),
  ]);

/** Span with attributes (9), one event (11) and one link (13). */
const span = (attrs: Uint8Array[], eventAttrs: Uint8Array[] = [], linkAttrs: Uint8Array[] = []) =>
  Buffer.concat([
    encodeStringField(5, 'GET /x'),
    ...attrs.map((a) => encodeLengthDelimited(9, a)),
    ...(eventAttrs.length
      ? [
          encodeLengthDelimited(
            11,
            Buffer.concat([
              encodeStringField(2, 'evt'),
              ...eventAttrs.map((a) => encodeLengthDelimited(3, a)),
            ]),
          ),
        ]
      : []),
    ...(linkAttrs.length
      ? [
          encodeLengthDelimited(
            13,
            Buffer.concat(linkAttrs.map((a) => encodeLengthDelimited(4, a))),
          ),
        ]
      : []),
  ]);

const request = (spans: Uint8Array[], resourceAttrs: Uint8Array[] = []) =>
  encodeLengthDelimited(
    1,
    Buffer.concat([
      encodeLengthDelimited(1, Buffer.concat(resourceAttrs.map((a) => encodeLengthDelimited(1, a)))),
      encodeLengthDelimited(2, Buffer.concat(spans.map((s) => encodeLengthDelimited(2, s)))),
    ]),
  );

describe('stampOtlpTracesRequest', () => {
  it('stamps the resource, which is what reaches the attribute index', () => {
    const out = stampOtlpTracesRequest(request([span([kv('http.route', '/x')])]), 'proj_123');
    expect(readStampedProjectIds(out)).toEqual(['proj_123']);
  });

  it('strips a forged label from SPAN attributes', () => {
    // Verified against a live gigapipe: a resource-only stamp let
    // `op-project-id: FORGED` reach tempo_traces_attrs_gin next to ours.
    const out = stampOtlpTracesRequest(
      request([span([kv('op-project-id', 'FORGED'), kv('http.route', '/x')])]),
      'proj_123',
    );

    expect(Buffer.from(out).includes(Buffer.from('FORGED'))).toBe(false);
    expect(Buffer.from(out).includes(Buffer.from('/x'))).toBe(true);
  });

  it('strips from span EVENT attributes too', () => {
    const out = stampOtlpTracesRequest(
      request([span([], [kv('op_project_id', 'FORGED-EVENT')])]),
      'proj_123',
    );
    expect(Buffer.from(out).includes(Buffer.from('FORGED-EVENT'))).toBe(false);
  });

  it('strips from span LINK attributes too', () => {
    const out = stampOtlpTracesRequest(
      request([span([], [], [kv('op–project–id', 'FORGED-LINK')])]),
      'proj_123',
    );
    expect(Buffer.from(out).includes(Buffer.from('FORGED-LINK'))).toBe(false);
  });

  it('preserves the span name and unrelated attributes', () => {
    const out = stampOtlpTracesRequest(
      request([span([kv('http.route', '/checkout'), kv('db.system', 'pg')])]),
      'proj_123',
    );
    const text = Buffer.from(out).toString('utf8');
    expect(text).toContain('GET /x');
    expect(text).toContain('/checkout');
    expect(text).toContain('pg');
  });

  it('overwrites a resource-level forgery', () => {
    const out = stampOtlpTracesRequest(
      request([span([])], [kv(PROJECT_LABEL, 'other-project')]),
      'proj_123',
    );
    expect(readStampedProjectIds(out)).toEqual(['proj_123']);
    expect(Buffer.from(out).includes(Buffer.from('other-project'))).toBe(false);
  });
});
