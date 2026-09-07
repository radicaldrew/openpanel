/**
 * Trace-id detection in a log line.
 *
 * The bar is deliberately "unambiguous or nothing": a wrong link navigates away
 * from the line the user was reading and lands on an empty trace, which is
 * worse than not offering one. Most of these cases are therefore about what is
 * NOT matched.
 *
 * Run with: cd apps/start && NITRO=1 npx vitest run src/components/telemetry-links
 */
import { describe, expect, it } from 'vitest';

import { findTraceIds, firstTraceId, splitTraceIds } from './trace-ids';

const ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN = '00f067aa0ba902b7';

describe('findTraceIds', () => {
  it('reads every spelling of the key', () => {
    for (const key of ['trace_id', 'traceId', 'traceID', 'trace-id', 'tid']) {
      expect(firstTraceId(`level=error ${key}=${ID} msg="boom"`)).toBe(ID);
    }
  });

  it('reads a quoted value, as the log envelope writes it', () => {
    expect(firstTraceId(`{"tid":"${ID}","msg":"boom"}`)).toBe(ID);
  });

  it('reads a colon-separated value', () => {
    expect(firstTraceId(`traceId: ${ID}`)).toBe(ID);
  });

  it('reads a W3C traceparent, with or without its key', () => {
    expect(firstTraceId(`traceparent=00-${ID}-${SPAN}-01`)).toBe(ID);
    expect(firstTraceId(`inbound 00-${ID}-${SPAN}-01 done`)).toBe(ID);
  });

  it('reads a 16-character id, which older SDKs emit', () => {
    expect(firstTraceId('trace_id=4bf92f3577b34da6')).toBe('4bf92f3577b34da6');
  });

  it('lowercases, because the envelope stores hex lowercase', () => {
    expect(firstTraceId(`trace_id=${ID.toUpperCase()}`)).toBe(ID);
  });

  it('reports a traceparent as one id, not two', () => {
    // The trace id inside a traceparent is also reachable by the keyed rule;
    // the structured reading wins and the overlap is discarded.
    expect(findTraceIds(`traceparent=00-${ID}-${SPAN}-01`)).toHaveLength(1);
  });

  it('finds several distinct ids in order', () => {
    const other = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const found = findTraceIds(`from trace_id=${ID} to trace_id=${other}`);

    expect(found.map((match) => match.id)).toEqual([ID, other]);
    expect(found[0]!.from).toBeLessThan(found[1]!.from);
  });

  it('still reads a real id that merely starts with zeros', () => {
    // Only an ENTIRELY zero id is the invalid one; leading zeros are ordinary.
    const leadingZeros = `00000000${'4bf92f3577b34da6a3ce929d'}`;

    expect(firstTraceId(`trace_id=${leadingZeros}`)).toBe(leadingZeros);
  });

  it('points at the id itself, not at the key', () => {
    const line = `trace_id=${ID}`;
    const [match] = findTraceIds(line);

    expect(line.slice(match!.from, match!.to)).toBe(ID);
  });
});

describe('findTraceIds — what it refuses', () => {
  const refused: [string, string][] = [
    [
      'a bare hex string, which is also what a git sha or an MD5 looks like',
      `deploying ${ID}`,
    ],
    ['a hex string that is the wrong length', 'trace_id=4bf92f3577b34d'],
    ['a value that is not hex', 'trace_id=not-a-trace-id-at-all'],
    ['a longer hex blob the key happens to precede', `trace_id=${ID}ff`],
    ['a word that merely contains the key', `subtrace_id=${ID}`],
    ['a traceparent with the wrong group lengths', `00-${ID}-abc-01`],
    ['an empty line', ''],
    // OpenTelemetry's INVALID_TRACE_ID. A correlation formatter emits this
    // unconditionally when there is no active span — sampling off, a background
    // worker, anything logged before the first span — so in a real deployment
    // it is a large share of lines, and every one of them would otherwise get a
    // link to an empty waterfall.
    ['the all-zero trace id', `trace_id=${'0'.repeat(32)}`],
    ['the all-zero id in its 16-character form', `trace_id=${'0'.repeat(16)}`],
    [
      'an all-zero traceparent',
      `traceparent: 00-${'0'.repeat(32)}-${'0'.repeat(16)}-00`,
    ],
    [
      'a traceparent whose span id is all zero',
      `traceparent: 00-${'4bf92f3577b34da6a3ce929d0e0e4736'}-${'0'.repeat(16)}-01`,
    ],
    // W3C reserves version `ff` and says a parser must reject it.
    ['a traceparent with the reserved ff version', `ff-${ID}-${SPAN}-01`],
  ];

  for (const [what, line] of refused) {
    it(`does not match ${what}`, () => {
      expect(findTraceIds(line)).toEqual([]);
    });
  }
});

describe('splitTraceIds', () => {
  it('leaves a line with no id in one piece', () => {
    expect(splitTraceIds('nothing to see')).toEqual([
      { kind: 'text', from: 0, text: 'nothing to see' },
    ]);
  });

  it('splits around the id, preserving the whole line', () => {
    const line = `level=error trace_id=${ID} msg="boom"`;
    const segments = splitTraceIds(line);

    expect(segments.map((segment) => segment.text).join('')).toBe(line);
    expect(segments).toContainEqual({
      kind: 'trace',
      from: line.indexOf(ID),
      text: ID,
      traceId: ID,
    });
  });

  it('keeps the original casing on screen while linking the lowercase id', () => {
    const upper = ID.toUpperCase();
    const segments = splitTraceIds(`trace_id=${upper}`);
    const trace = segments.find((segment) => segment.kind === 'trace');

    expect(trace).toEqual({
      kind: 'trace',
      from: 'trace_id='.length,
      text: upper,
      traceId: ID,
    });
  });

  it('gives every segment a stable identity, not a position in an array', () => {
    // The offsets are what the renderer keys on: an array index would change
    // meaning if the line were ever re-split differently.
    const segments = splitTraceIds(`a trace_id=${ID} b`);
    const offsets = segments.map((segment) => segment.from);

    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    expect(new Set(offsets).size).toBe(offsets.length);
  });

  it('handles an id at the very end of a line', () => {
    const line = `done trace_id=${ID}`;
    expect(splitTraceIds(line).map((s) => s.text).join('')).toBe(line);
  });

  it('is repeatable — the regexes do not carry state between calls', () => {
    const line = `trace_id=${ID}`;
    expect(splitTraceIds(line)).toEqual(splitTraceIds(line));
    expect(findTraceIds(line)).toEqual(findTraceIds(line));
  });
});
