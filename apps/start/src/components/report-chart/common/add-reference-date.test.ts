import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chartDateToIso, parseChartDate } from '@/utils/chart-dates';
import { isSameHour } from 'date-fns';
import { describe, expect, it } from 'vitest';

/**
 * The AddReference menu item writes a timestamp to the DATABASE.
 *
 * `clickedData.date` is a chart bucket — `formatClickhouseDate` output, a UTC
 * instant with no zone marker — and `new Date()` reads that form as LOCAL
 * time. Every chart's "Add reference" built its datetime that way, so a
 * reference created from a non-UTC browser was persisted shifted by the
 * viewer's offset and stayed wrong afterwards for everyone, including viewers
 * in UTC who could never have produced it.
 *
 * Unlike the zoom-out case this is written down, so the test guards both the
 * behaviour and the call sites: a future edit that reaches for `new Date()`
 * again reintroduces a silent data-corruption bug that no runtime assertion in
 * these components would catch.
 */

const BUCKET = '2026-09-07 10:00:00';

describe('a chart bucket is read as the instant it is', () => {
  it('reads the bucket as UTC', () => {
    expect(chartDateToIso(BUCKET)).toBe('2026-09-07T10:00:00.000Z');
  });

  it('differs from the naive reading wherever the machine is not UTC', () => {
    // Guarded so this cannot quietly become a tautology on a UTC CI box — it
    // asserts something only where there is something to assert, and CI runs
    // the suite under TZ=America/Los_Angeles as well.
    if (new Date().getTimezoneOffset() === 0) {
      expect(new Date(BUCKET).toISOString()).toBe(chartDateToIso(BUCKET));
      return;
    }

    expect(new Date(BUCKET).toISOString()).not.toBe(chartDateToIso(BUCKET));
  });
});

/**
 * The display-only readers.
 *
 * These do not persist anything, so the consequence is smaller — a tooltip
 * heading, the "now" dot, whether the last segment is dashed, and which
 * reference markers a tooltip shows. But they are wrong by the same offset for
 * the same reason, and the reference-marker one is not purely cosmetic: it
 * decides which markers appear against which bucket.
 */
describe('no chart reads a bucket date with a bare Date', () => {
  const CHARTS = ['line', 'area', 'histogram', 'conversion'] as const;

  for (const chart of CHARTS) {
    it(`${chart} routes its AddReference datetime through chartDateToIso`, () => {
      const source = readFileSync(
        join(__dirname, '..', chart, 'chart.tsx'),
        'utf8',
      );

      // Only meaningful for a chart that actually offers the item.
      expect(source, `${chart} no longer pushes AddReference`).toContain(
        "'AddReference'",
      );
      expect(source).toContain('chartDateToIso(clickedData.date)');
      expect(source).not.toContain('new Date(clickedData.date)');
    });
  }

  for (const chart of ['line', 'area'] as const) {
    it(`${chart} reads its bucket dates through parseChartDate`, () => {
      const source = readFileSync(
        join(__dirname, '..', chart, 'chart.tsx'),
        'utf8',
      );

      expect(source).toContain('isSameHour(parseChartDate(item.date)');
      expect(source).not.toContain('isSameHour(item.date,');
      expect(source).not.toMatch(/last\(series\[0\]\?\.data \|\| \[\]\)\?\.date \|\|/);
    });
  }

  it('the tooltip reads its bucket dates through parseChartDate', () => {
    const source = readFileSync(join(__dirname, 'report-chart-tooltip.tsx'), 'utf8');

    expect(source).toContain('parseChartDate(firstItem.date)');
    expect(source).toContain('formatDate(parseChartDate(item.date))');
    expect(source).not.toContain('new Date(firstItem.date)');
    expect(source).not.toContain('new Date(item.date)');
  });
});

/**
 * date-fns parses a zone-less string the same way `new Date()` does, so the
 * comparison helpers carry the bug too — this is the behaviour the source
 * checks above are protecting.
 */
describe('date-fns comparisons on a bucket string', () => {
  it('agrees with the shared reader only once the string is parsed', () => {
    const bucket = '2026-09-07 10:00:00';
    const sameInstant = new Date('2026-09-07T10:00:00.000Z');

    expect(isSameHour(parseChartDate(bucket), sameInstant)).toBe(true);

    if (new Date().getTimezoneOffset() === 0) {
      expect(isSameHour(bucket, sameInstant)).toBe(true);
      return;
    }

    // The naive form disagrees wherever the machine is not UTC.
    expect(isSameHour(bucket, sameInstant)).toBe(false);
  });
});
