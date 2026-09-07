import { describe, expect, it } from 'vitest';
import { selectedRange } from './use-range-select';

const AT = (iso: string) => Date.parse(iso);

describe('selectedRange', () => {
  it('turns a forward sweep into an ISO range', () => {
    expect(
      selectedRange(AT('2026-09-07T10:00:00.000Z'), AT('2026-09-07T12:00:00.000Z')),
    ).toEqual({
      startDate: '2026-09-07T10:00:00.000Z',
      endDate: '2026-09-07T12:00:00.000Z',
    });
  });

  it('orders a backward sweep, which is about half of them', () => {
    expect(
      selectedRange(AT('2026-09-07T12:00:00.000Z'), AT('2026-09-07T10:00:00.000Z')),
    ).toEqual({
      startDate: '2026-09-07T10:00:00.000Z',
      endDate: '2026-09-07T12:00:00.000Z',
    });
  });

  const nulls: [string, number | null, number | null][] = [
    ['a plain click, where both ends are the same bucket', 1, 1],
    ['no mousedown', null, 1],
    ['no mouseup', 1, null],
    ['neither', null, null],
    ['a non-finite start', Number.NaN, 1],
    ['a non-finite end', 1, Number.POSITIVE_INFINITY],
  ];

  for (const [name, from, to] of nulls) {
    it(`is null for ${name}`, () => {
      expect(selectedRange(from, to)).toBeNull();
    });
  }
});
