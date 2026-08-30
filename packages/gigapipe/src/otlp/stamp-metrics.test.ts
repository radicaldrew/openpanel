import { describe, expect, it } from 'vitest';
import { PROJECT_LABEL } from '../tenancy/project-label';
import { stampOtlpMetricsRequest } from './stamp-metrics';
import {
  encodeLengthDelimited,
  encodeStringField,
  encodeTag,
  encodeVarint,
  readFields,
  WIRE_VARINT,
} from './wire';

/**
 * Regression suite for a bug that only surfaced against a running gigapipe.
 *
 * Stamping `op_project_id` onto the OTLP *resource* is correct for logs and
 * traces, and it is NOT sufficient for metrics: gigapipe collects resource
 * attributes into a separate `target_info` gauge rather than putting them on
 * each series, so a resource-only stamp produced
 *
 *     http_server_requests_total{job=..., route=...}    <- no project label
 *
 * which the read-side matcher would never select for its own project, and which
 * an unmatched query would return for every project. The label has to go on
 * each DATA POINT.
 */

const kv = (key: string, value: string) =>
  Buffer.concat([
    encodeStringField(1, key),
    encodeLengthDelimited(2, encodeStringField(1, value)),
  ]);

/** NumberDataPoint — attributes are field 7. */
const numberDataPoint = (attrs: Uint8Array[]) =>
  Buffer.concat([
    ...attrs.map((a) => encodeLengthDelimited(7, a)),
    // time_unix_nano (field 3, fixed64) so the point looks real
    Buffer.concat([encodeTag(3, 1), Buffer.alloc(8)]),
  ]);

/** HistogramDataPoint — attributes are field 9. */
const histogramDataPoint = (attrs: Uint8Array[]) =>
  Buffer.concat([
    ...attrs.map((a) => encodeLengthDelimited(9, a)),
    Buffer.concat([encodeTag(3, 1), Buffer.alloc(8)]),
  ]);

/** Metric carrying one `oneof data` variant. */
const metric = (name: string, dataField: number, dataPoints: Uint8Array[]) =>
  Buffer.concat([
    encodeStringField(1, name),
    encodeLengthDelimited(
      dataField,
      Buffer.concat([
        ...dataPoints.map((dp) => encodeLengthDelimited(1, dp)),
        // aggregation_temporality = 2 (CUMULATIVE)
        Buffer.concat([encodeTag(2, WIRE_VARINT), encodeVarint(2)]),
      ]),
    ),
  ]);

const request = (metrics: Uint8Array[]) =>
  encodeLengthDelimited(
    1, // ExportMetricsServiceRequest.resource_metrics
    Buffer.concat([
      encodeLengthDelimited(1, Buffer.concat([])), // empty Resource
      encodeLengthDelimited(
        2, // ResourceMetrics.scope_metrics
        Buffer.concat(metrics.map((m) => encodeLengthDelimited(2, m))),
      ),
    ]),
  );

/** Pull every data-point attribute key/value out of a stamped request. */
function dataPointAttrs(
  body: Uint8Array,
  attrsField: number,
): Record<string, string>[] {
  const out: Record<string, string>[] = [];

  for (const rm of readFields(body)) {
    if (rm.fieldNumber !== 1) continue;
    for (const sm of readFields(rm.value)) {
      if (sm.fieldNumber !== 2) continue;
      for (const m of readFields(sm.value)) {
        if (m.fieldNumber !== 2) continue;
        for (const data of readFields(m.value)) {
          if (data.fieldNumber === 1) continue; // metric name
          for (const dp of readFields(data.value)) {
            if (dp.fieldNumber !== 1) continue; // data_points
            const attrs: Record<string, string> = {};
            for (const a of readFields(dp.value)) {
              if (a.fieldNumber !== attrsField) continue;
              let k: string | undefined;
              let v: string | undefined;
              for (const f of readFields(a.value)) {
                if (f.fieldNumber === 1)
                  k = Buffer.from(f.value).toString('utf8');
                if (f.fieldNumber === 2) {
                  for (const inner of readFields(f.value)) {
                    if (inner.fieldNumber === 1)
                      v = Buffer.from(inner.value).toString('utf8');
                  }
                }
              }
              if (k !== undefined) attrs[k] = v ?? '';
            }
            out.push(attrs);
          }
        }
      }
    }
  }

  return out;
}

describe('stampOtlpMetricsRequest', () => {
  it('stamps NumberDataPoint attributes for a Sum (field 7 -> attrs 7)', () => {
    const body = request([
      metric('http_requests', 7, [numberDataPoint([kv('route', '/checkout')])]),
    ]);

    const out = stampOtlpMetricsRequest(body, 'proj_123');

    expect(dataPointAttrs(out, 7)).toEqual([
      { route: '/checkout', [PROJECT_LABEL]: 'proj_123' },
    ]);
  });

  it('stamps NumberDataPoint attributes for a Gauge (field 5 -> attrs 7)', () => {
    const body = request([
      metric('queue_depth', 5, [numberDataPoint([kv('queue', 'events')])]),
    ]);

    expect(dataPointAttrs(stampOtlpMetricsRequest(body, 'proj_123'), 7)).toEqual([
      { queue: 'events', [PROJECT_LABEL]: 'proj_123' },
    ]);
  });

  it('stamps HistogramDataPoint attributes (field 9 -> attrs 9)', () => {
    // The attribute field number differs from NumberDataPoint's. Using 7 here
    // would write the label into `explicit_bounds` and corrupt the histogram.
    const body = request([
      metric('latency', 9, [histogramDataPoint([kv('route', '/checkout')])]),
    ]);

    expect(dataPointAttrs(stampOtlpMetricsRequest(body, 'proj_123'), 9)).toEqual([
      { route: '/checkout', [PROJECT_LABEL]: 'proj_123' },
    ]);
  });

  it('strips a forged label from the data point, not just the resource', () => {
    const body = request([
      metric('http_requests', 7, [
        numberDataPoint([kv('op-project-id', 'FORGED'), kv('route', '/x')]),
      ]),
    ]);

    const attrs = dataPointAttrs(stampOtlpMetricsRequest(body, 'proj_123'), 7);

    expect(attrs).toEqual([{ route: '/x', [PROJECT_LABEL]: 'proj_123' }]);
    expect(JSON.stringify(attrs)).not.toContain('FORGED');
  });

  it('stamps every data point of a multi-point metric', () => {
    const body = request([
      metric('http_requests', 7, [
        numberDataPoint([kv('route', '/a')]),
        numberDataPoint([kv('route', '/b')]),
      ]),
    ]);

    const attrs = dataPointAttrs(stampOtlpMetricsRequest(body, 'proj_123'), 7);

    expect(attrs).toHaveLength(2);
    for (const a of attrs) {
      expect(a[PROJECT_LABEL]).toBe('proj_123');
    }
  });

  it('still stamps the resource, so target_info carries the project too', () => {
    const body = request([
      metric('http_requests', 7, [numberDataPoint([])]),
    ]);

    const out = stampOtlpMetricsRequest(body, 'proj_123');

    // Resource is ResourceMetrics field 1; its attributes are field 1.
    const resourceAttrs: string[] = [];
    for (const rm of readFields(out)) {
      for (const res of readFields(rm.value)) {
        if (res.fieldNumber !== 1) continue;
        for (const a of readFields(res.value)) {
          if (a.fieldNumber !== 1) continue;
          for (const f of readFields(a.value)) {
            if (f.fieldNumber === 1)
              resourceAttrs.push(Buffer.from(f.value).toString('utf8'));
          }
        }
      }
    }

    expect(resourceAttrs).toContain(PROJECT_LABEL);
  });
});
