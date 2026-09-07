/**
 * Reading a chart bucket's timestamp as the instant it actually is.
 *
 * `FinalChart.series[].data[].date` is `formatClickhouseDate` output —
 * `"2026-09-07 10:00:00"` — which is a UTC instant written WITHOUT a zone
 * marker. `new Date()` parses that space-separated form as LOCAL time, so every
 * arithmetic on a bucket date silently shifts by the browser's UTC offset:
 *
 *   TZ=UTC                  new Date('2026-09-07 10:00:00') → 10:00:00Z
 *   TZ=Europe/Stockholm                                     → 08:00:00Z
 *   TZ=America/Los_Angeles                                  → 17:00:00Z
 *
 * That is invisible on a UTC machine and invisible in a test suite whose
 * fixtures are ISO strings, which is exactly how it survives: the code is
 * correct for the input the tests give it, and that input is not what arrives
 * at runtime. Anything that turns a bucket into a window — zooming out, jumping
 * to the logs for a spike — has to go through here first.
 */

/** `YYYY-MM-DD HH:MM:SS`, with optional fractional seconds and no zone. */
const CLICKHOUSE_DATETIME = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/;

/** `YYYY-MM-DD`, which is what a day/week/month bucket looks like. */
const CLICKHOUSE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A chart bucket as a `Date`.
 *
 * Accepts an ISO string or a `Date` unchanged, so a caller that already holds a
 * real instant does not have to know which kind it has.
 */
export function parseChartDate(value: string | Date): Date {
  if (value instanceof Date) {
    return value;
  }

  const datetime = CLICKHOUSE_DATETIME.exec(value);

  if (datetime) {
    // The `Z` is the whole point: it says out loud what the string meant all
    // along, and stops the runtime guessing the viewer's timezone.
    return new Date(`${datetime[1]}T${datetime[2]}Z`);
  }

  if (CLICKHOUSE_DATE.test(value)) {
    return new Date(`${value}T00:00:00Z`);
  }

  // An ISO string, with or without an offset — already unambiguous.
  return new Date(value);
}

/** The same instant, as ISO, for a URL or an engine input. */
export function chartDateToIso(value: string | Date): string {
  const date = parseChartDate(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Cannot read ${String(value)} as a chart date`);
  }

  return date.toISOString();
}
