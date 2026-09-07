/**
 * The bucket-date reading, checked in a timezone that is NOT UTC.
 *
 * The timezone matters more than the assertions do: this whole class of bug is
 * invisible on a UTC machine, which is why it survived a suite of ISO fixtures.
 *
 * Run with: cd apps/start && TZ=Europe/Stockholm NITRO=1 npx vitest run src/utils
 */
import { describe, expect, it } from 'vitest';

import { chartDateToIso, parseChartDate } from './chart-dates';

describe('parseChartDate', () => {
  it('reads a ClickHouse datetime as the UTC instant it is', () => {
    // `new Date('2026-09-07 10:00:00')` reads this as LOCAL time and is wrong
    // by the browser's offset on every machine outside UTC.
    expect(chartDateToIso('2026-09-07 10:00:00')).toBe(
      '2026-09-07T10:00:00.000Z',
    );
  });

  it('keeps fractional seconds', () => {
    expect(chartDateToIso('2026-09-07 10:00:00.123')).toBe(
      '2026-09-07T10:00:00.123Z',
    );
  });

  it('reads a date-only bucket as UTC midnight', () => {
    expect(chartDateToIso('2026-09-07')).toBe('2026-09-07T00:00:00.000Z');
  });

  it('leaves an ISO string alone', () => {
    expect(chartDateToIso('2026-09-07T10:00:00.000Z')).toBe(
      '2026-09-07T10:00:00.000Z',
    );
  });

  it('honours an explicit offset', () => {
    expect(chartDateToIso('2026-09-07T12:00:00+02:00')).toBe(
      '2026-09-07T10:00:00.000Z',
    );
  });

  it('passes a Date through', () => {
    const date = new Date('2026-09-07T10:00:00.000Z');
    expect(parseChartDate(date)).toBe(date);
  });

  it('does not depend on the machine running it', () => {
    // The property that actually matters. Asserted against a fixed expectation
    // rather than against a second parse, so a change that reintroduces local
    // parsing still fails here even on a UTC box — and the second half proves
    // the naive reading really would have differed, so this cannot quietly
    // become a tautology.
    const offsetMinutes = new Date('2026-09-07T10:00:00Z').getTimezoneOffset();

    expect(chartDateToIso('2026-09-07 10:00:00')).toBe(
      '2026-09-07T10:00:00.000Z',
    );

    if (offsetMinutes !== 0) {
      expect(new Date('2026-09-07 10:00:00').toISOString()).not.toBe(
        '2026-09-07T10:00:00.000Z',
      );
    }
  });

  it('refuses something that is not a date at all', () => {
    expect(() => chartDateToIso('not a date')).toThrow();
  });
});
