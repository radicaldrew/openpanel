import { describe, expect, it } from 'vitest';

import { __testing, TelemetryMetadataError } from './telemetry-metadata.service';

const { buildScope, toClickhouseDate } = __testing;

/**
 * These assert the invariants the file's header claims, on the SQL it builds,
 * without a live ClickHouse:
 *
 *  - every read is scoped to one project, including the sub-selects;
 *  - user-supplied values are bound parameters, never interpolated;
 *  - the date bound reaches the sub-selects, not only the outer query.
 *
 * A regression in any of those is a tenancy bug that would show up as one
 * project seeing another's label values — which no unit test of the RESULTS
 * would catch, because the results look perfectly ordinary.
 */
describe('every lookup is scoped to one project', () => {
  it('always includes the project fingerprint predicate', () => {
    const { fingerprints } = buildScope({});

    expect(fingerprints).toContain("key = 'op_project_id'");
    expect(fingerprints).toContain('{projectId:String}');
  });

  it('scopes the metric sub-select as well as the outer read', () => {
    const { fingerprints } = buildScope({ metric: 'up' });

    // Two separate fingerprint clauses, intersected: project AND metric.
    expect(fingerprints.match(/AND fingerprint IN/g)?.length).toBe(2);
    expect(fingerprints).toContain('{metric:String}');
  });

  it('scopes a negative matcher to the project too', () => {
    // Correct either way, since the outer query intersects with the project
    // set — but an unscoped NOT IN builds the set of every fingerprint in the
    // cluster carrying that value, across every tenant.
    const { fingerprints } = buildScope({
      matchers: [{ label: 'job', op: '!=', value: 'api' }],
    });

    const notIn = fingerprints.slice(fingerprints.indexOf('NOT IN'));

    expect(notIn).toContain("key = 'op_project_id'");
  });
});

describe('user values are bound, never interpolated', () => {
  it('binds a matcher label and value', () => {
    const { fingerprints, params } = buildScope({
      matchers: [{ label: 'job', op: '=', value: 'api' }],
    });

    expect(fingerprints).toContain('{m0k:String}');
    expect(fingerprints).toContain('{m0v:String}');
    expect(params).toMatchObject({ m0k: 'job', m0v: 'api' });
    expect(fingerprints).not.toContain('api');
  });

  it('keeps a hostile value out of the SQL entirely', () => {
    const hostile = "') OR 1=1 --";
    const { fingerprints, params } = buildScope({
      matchers: [{ label: 'job', op: '=', value: hostile }],
    });

    expect(fingerprints).not.toContain('OR 1=1');
    expect(params.m0v).toBe(hostile);
  });

  it('gives each matcher its own parameter names', () => {
    const { params } = buildScope({
      matchers: [
        { label: 'job', op: '=', value: 'api' },
        { label: 'pod', op: '=', value: 'a-1' },
      ],
    });

    expect(params).toMatchObject({
      m0k: 'job',
      m0v: 'api',
      m1k: 'pod',
      m1v: 'a-1',
    });
  });
});

describe('time scoping', () => {
  it('adds no date clause when no range is given', () => {
    // The autocomplete callers want every label ever written, not only the
    // ones alive in a panel's window.
    const { date, params } = buildScope({});

    expect(date).toBe('');
    expect(params.dateFrom).toBeUndefined();
  });

  it('bounds the read on both ends', () => {
    const { date, params } = buildScope({
      startDate: '2026-09-01T10:00:00.000Z',
      endDate: '2026-09-07T10:00:00.000Z',
    });

    expect(date).toContain('date >= {dateFrom:Date}');
    expect(date).toContain('date <= {dateTo:Date}');
    expect(params).toMatchObject({
      dateFrom: '2026-09-01',
      dateTo: '2026-09-07',
    });
  });

  it('applies the date bound inside every sub-select', () => {
    // `time_series_gin` is PARTITIONed by date, so this prunes partitions
    // rather than filtering rows. Bounding only the outer query would read
    // every partition of the inner one.
    const { fingerprints } = buildScope({
      metric: 'up',
      matchers: [{ label: 'job', op: '=', value: 'api' }],
      startDate: '2026-09-01',
      endDate: '2026-09-07',
    });

    const subSelects = fingerprints.match(/SELECT fingerprint FROM/g)?.length ?? 0;
    const dateBounds = fingerprints.match(/date >= \{dateFrom:Date\}/g)?.length ?? 0;

    expect(subSelects).toBeGreaterThan(0);
    expect(dateBounds).toBe(subSelects);
  });

  it('accepts a Date as well as a string', () => {
    const { params } = buildScope({
      startDate: new Date('2026-09-01T23:30:00.000Z'),
    });

    expect(params.dateFrom).toBe('2026-09-01');
  });

  it('converts in UTC, not the server timezone', () => {
    // The column is a Date written from UTC timestamps; converting locally
    // would shift the bound by a day for half the world.
    expect(toClickhouseDate('2026-09-01T00:30:00.000Z')).toBe('2026-09-01');
    expect(toClickhouseDate('2026-09-01T23:30:00.000Z')).toBe('2026-09-01');
  });

  it('rejects an unparseable date rather than reading everything', () => {
    expect(() => buildScope({ startDate: 'last tuesday' })).toThrow(
      TelemetryMetadataError,
    );
  });
});

describe('names are validated so a typo fails loudly', () => {
  it('rejects a label name that is not an identifier', () => {
    // Values are bound, so this is not what stops injection — it stops a
    // malformed name from matching nothing and reading as "no values".
    expect(() =>
      buildScope({ matchers: [{ label: 'my-label', op: '=', value: 'x' }] }),
    ).toThrow(/not a valid label name/);
  });

  it('rejects a metric name that is not an identifier', () => {
    expect(() => buildScope({ metric: 'up; DROP TABLE' })).toThrow(
      /not a valid metric name/,
    );
  });

  it('allows colons in a metric name', () => {
    expect(() => buildScope({ metric: 'job:rate5m' })).not.toThrow();
  });

  it('caps the number of matchers', () => {
    const matchers = Array.from({ length: 11 }, (_, i) => ({
      label: `l${i}`,
      op: '=' as const,
      value: 'x',
    }));

    expect(() => buildScope({ matchers })).toThrow(/At most 10/);
  });

  it('allows exactly the cap', () => {
    const matchers = Array.from({ length: 10 }, (_, i) => ({
      label: `l${i}`,
      op: '=' as const,
      value: 'x',
    }));

    expect(() => buildScope({ matchers })).not.toThrow();
  });
});
