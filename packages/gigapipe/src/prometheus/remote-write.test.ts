import { describe, expect, it } from 'vitest';
import { InvalidProjectIdError, PROJECT_LABEL } from '../tenancy/project-label';
import {
  encodeLengthDelimited,
  encodeStringField,
  encodeTag,
  readFields,
} from '../otlp/wire';
import {
  readRemoteWriteProjectIds,
  stampRemoteWriteRequest,
} from './remote-write';

const label = (name: string, value: string) =>
  Buffer.concat([encodeStringField(1, name), encodeStringField(2, value)]);

/** TimeSeries with labels (1) and one sample (2). */
const timeSeries = (labels: Uint8Array[]) =>
  Buffer.concat([
    ...labels.map((l) => encodeLengthDelimited(1, l)),
    encodeLengthDelimited(
      2,
      Buffer.concat([encodeTag(1, 1), Buffer.alloc(8)]),
    ),
  ]);

const request = (series: Uint8Array[]) =>
  Buffer.concat(series.map((s) => encodeLengthDelimited(1, s)));

/** Read a stamped payload's labels back, in stored order. */
function labelsOf(body: Uint8Array): { name: string; value: string }[][] {
  const out: { name: string; value: string }[][] = [];

  for (const series of readFields(body)) {
    if (series.fieldNumber !== 1) continue;
    const labels: { name: string; value: string }[] = [];
    for (const l of readFields(series.value)) {
      if (l.fieldNumber !== 1) continue;
      let name = '';
      let value = '';
      for (const f of readFields(l.value)) {
        if (f.fieldNumber === 1) name = Buffer.from(f.value).toString('utf8');
        if (f.fieldNumber === 2) value = Buffer.from(f.value).toString('utf8');
      }
      labels.push({ name, value });
    }
    out.push(labels);
  }

  return out;
}

describe('stampRemoteWriteRequest', () => {
  it('adds the project label', () => {
    const out = stampRemoteWriteRequest(
      request([timeSeries([label('__name__', 'up')])]),
      'proj_123',
    );

    expect(readRemoteWriteProjectIds(out)).toEqual(['proj_123']);
  });

  it('keeps labels SORTED, which the receiver relies on for the fingerprint', () => {
    // Several receivers hash labels in order to compute the series identity, so
    // an out-of-order set silently becomes a different series rather than an
    // error. Appending ours at the end would break exactly the sets whose
    // labels sort after "op_project_id".
    const out = stampRemoteWriteRequest(
      request([
        timeSeries([
          label('__name__', 'up'),
          label('zone', 'eu'),
          label('instance', 'a'),
        ]),
      ]),
      'proj_123',
    );

    const names = labelsOf(out)[0]!.map((l) => l.name);
    expect(names).toEqual([...names].sort());
    expect(names).toEqual(['__name__', 'instance', PROJECT_LABEL, 'zone']);
  });

  it('strips a forged label before adding ours', () => {
    const out = stampRemoteWriteRequest(
      request([
        timeSeries([label('op-project-id', 'FORGED'), label('__name__', 'up')]),
      ]),
      'proj_123',
    );

    expect(readRemoteWriteProjectIds(out)).toEqual(['proj_123']);
    expect(Buffer.from(out).includes(Buffer.from('FORGED'))).toBe(false);
  });

  it('overwrites a client-supplied project label', () => {
    const out = stampRemoteWriteRequest(
      request([timeSeries([label(PROJECT_LABEL, 'someone-else')])]),
      'proj_123',
    );

    expect(readRemoteWriteProjectIds(out)).toEqual(['proj_123']);
    expect(Buffer.from(out).includes(Buffer.from('someone-else'))).toBe(false);
  });

  it('stamps every series in the request', () => {
    const out = stampRemoteWriteRequest(
      request([
        timeSeries([label('__name__', 'a')]),
        timeSeries([label('__name__', 'b')]),
        timeSeries([label('__name__', 'c')]),
      ]),
      'proj_123',
    );

    expect(readRemoteWriteProjectIds(out)).toEqual([
      'proj_123',
      'proj_123',
      'proj_123',
    ]);
  });

  it('preserves samples and unknown fields', () => {
    const original = request([timeSeries([label('__name__', 'up')])]);
    const out = stampRemoteWriteRequest(original, 'proj_123');

    // The sample field (2) survives the label rebuild.
    const series = [...readFields(out)][0]!.value;
    const sampleFields = [...readFields(series)].filter((f) => f.fieldNumber === 2);
    expect(sampleFields).toHaveLength(1);
  });

  it('refuses an invalid project id', () => {
    expect(() =>
      stampRemoteWriteRequest(request([timeSeries([])]), 'has space'),
    ).toThrow(InvalidProjectIdError);
  });
});
