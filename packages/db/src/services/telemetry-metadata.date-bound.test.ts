import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getTelemetryClickhouse, TELEMETRY_DATABASE } from '../clickhouse/telemetry-client';
import {
  getTelemetryLabelValues,
  getTelemetryMetricNames,
} from './telemetry-metadata.service';

/**
 * The date bound on the metadata lookups, against a REAL multi-day fixture.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE SQL TESTS
 *
 * `telemetry-metadata.service.test.ts` asserts the generated SQL — that the
 * bound is present, and present in every sub-select. It cannot answer the
 * question that actually decides whether the feature works, which is what
 * `time_series_gin.date` MEANS.
 *
 * If gigapipe wrote one gin row per series when it first saw it, bounding by
 * date would return only series first seen inside the window — so every
 * long-lived series would vanish from the variable picker the moment someone
 * looked at a recent range. Total, silent failure of dashboard variables. If
 * instead it writes a row per series per day, a long-lived series appears in
 * every day's partition and the bound means "seen during this window", which
 * is what the picker wants.
 *
 * It is the second. This test pins that down with two days of rows for one
 * series, because the distinction is invisible to a single-day fixture — which
 * is all the earlier verification had.
 *
 * Requires a locally reachable ClickHouse (`pnpm dock:up`); skips if there
 * is none, like chart-sql.test.ts.
 */

const PROJECT_ID = 'date-bound-fixture';
const METRIC = 'date_bound_fixture_total';
const LABEL = 'zone';
const VALUE = 'eu-west';

/**
 * Fixture dates are RELATIVE, and they have to be.
 *
 * `time_series_gin` carries `TTL date + toIntervalDay(30)`, so a row dated
 * more than 30 days ago is dropped at insert time — ClickHouse answers 200 and
 * keeps nothing. A fixture on fixed historical dates therefore inserts
 * "successfully" and then finds no rows, which reads exactly like the date
 * bound being broken. Relative dates also keep this test from rotting.
 */
const daysAgo = (days: number): string => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
};

const DAY_ONE = daysAgo(3);
const DAY_TWO = daysAgo(2);
/** Inside retention, but before the fixture's own days. */
const BEFORE = { startDate: daysAgo(10), endDate: daysAgo(8) };

/**
 * Arbitrary and distinctive, so the cleanup below cannot touch a real series.
 * Well inside Number.MAX_SAFE_INTEGER, since it is also written into SQL.
 */
const FP = 424_242_424_242;

let reachable = false;

const ch = () => getTelemetryClickhouse();

/** One series, present on both days — which is the whole point of the fixture. */
const rows = () => {
  const out: {
    date: string;
    key: string;
    val: string;
    fingerprint: number;
    type: number;
  }[] = [];

  for (const date of [DAY_ONE, DAY_TWO]) {
    for (const [key, val] of [
      ['op_project_id', PROJECT_ID],
      ['__name__', METRIC],
      [LABEL, VALUE],
    ] as const) {
      out.push({ date, key, val, fingerprint: FP, type: 0 });
    }
  }

  return out;
};

beforeAll(async () => {
  try {
    await ch().command({ query: 'SELECT 1' });
    reachable = true;
  } catch {
    reachable = false;
    return;
  }

  await ch().insert({
    table: `${TELEMETRY_DATABASE}.time_series_gin`,
    values: rows(),
    format: 'JSONEachRow',
  });
});

afterAll(async () => {
  if (!reachable) {
    return;
  }

  // Scoped to the fixture's own project label and fingerprint, so this cannot
  // reach a real series even if the ids ever collided.
  await ch().command({
    query: `ALTER TABLE ${TELEMETRY_DATABASE}.time_series_gin DELETE WHERE fingerprint = ${FP}`,
  });
});

const itCH = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (!reachable) {
      console.warn('[date-bound] skipping: ClickHouse not reachable');
      return;
    }
    await fn();
  });

describe('time_series_gin carries one row per series PER DAY, so the date bound means "seen during this window"', () => {
  itCH('finds a two-day series in a window covering only its FIRST day', async () => {
    // The load-bearing case. If gin rows were written once when a series was
    // first seen, this would pass while the next test failed — and the picker
    // would silently lose every series older than the window.
    const values = await getTelemetryLabelValues(PROJECT_ID, LABEL, {
      startDate: DAY_ONE,
      endDate: DAY_ONE,
    });

    expect(values).toEqual([VALUE]);
  });

  itCH('finds the same series in a window covering only its SECOND day', async () => {
    // This is the one that distinguishes per-day rows from write-once. A
    // write-once table would return [] here, because the series was first seen
    // on day one.
    const values = await getTelemetryLabelValues(PROJECT_ID, LABEL, {
      startDate: DAY_TWO,
      endDate: DAY_TWO,
    });

    expect(values).toEqual([VALUE]);
  });

  itCH('finds it in a window spanning both days, without duplicating it', async () => {
    const values = await getTelemetryLabelValues(PROJECT_ID, LABEL, {
      startDate: DAY_ONE,
      endDate: DAY_TWO,
    });

    expect(values).toEqual([VALUE]);
  });

  itCH('returns nothing for a window before the series existed', async () => {
    const values = await getTelemetryLabelValues(PROJECT_ID, LABEL, BEFORE);

    expect(values).toEqual([]);
  });

  itCH('applies the same bound to metric names', async () => {
    await expect(
      getTelemetryMetricNames(PROJECT_ID, {
        startDate: DAY_TWO,
        endDate: DAY_TWO,
      }),
    ).resolves.toEqual([METRIC]);

    await expect(
      getTelemetryMetricNames(PROJECT_ID, BEFORE),
    ).resolves.toEqual([]);
  });

  itCH('still finds the series when no window is given', async () => {
    const values = await getTelemetryLabelValues(PROJECT_ID, LABEL);

    expect(values).toEqual([VALUE]);
  });
});
