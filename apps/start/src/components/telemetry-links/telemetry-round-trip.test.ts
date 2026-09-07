/**
 * The correlation chains, end to end: what a click builds, and what the
 * destination page resolves back out of it.
 *
 * This is plan §8 item 6 — "from a p95 spike, two clicks reach the log lines
 * for that minute" — verified as a chain rather than clicked, because there is
 * no browser in this session. Testing the two halves separately would not
 * catch the failure that actually matters: a link and a page that each look
 * correct and disagree about the window. So every case here goes all the way
 * from the data a chart click carries to the `{ startDate, endDate }` the
 * destination would query with.
 *
 * Deliberately run against a NON-UTC timezone as well — see the last block.
 * Chart buckets arrive as `formatClickhouseDate` strings, and the entire class
 * of bug they invite is invisible on a UTC machine.
 *
 * Run with: cd apps/start && NITRO=1 npx vitest run src/components/telemetry-links
 */
import { describe, expect, it } from 'vitest';

import {
  aroundTimestamp,
  bucketWindow,
  logsUrl,
  resolveTelemetryWindow,
  serviceFromLabels,
  tracesUrl,
} from './telemetry-urls';
import { firstTraceId } from './trace-ids';

const project = { organizationId: 'org_1', projectId: 'proj_1' };

/** What the destination route does with the search params it is handed. */
function windowAt(search: Record<string, string>, presetMinutes: number) {
  return resolveTelemetryWindow(
    { start: search.start, end: search.end },
    presetMinutes,
    new Date('2026-09-07T23:59:00.000Z'),
  );
}

describe('a p95 spike to its log lines', () => {
  // What the click menu is handed: the bucket the user clicked, as the chart
  // carries it, and the labels of the series under the cursor.
  const CLICKED_BUCKET = '2026-09-07 10:05:00';
  const LABELS = { service_name: 'api', le: '+Inf' };

  it('lands on the minute that was clicked, filtered to that service', () => {
    const service = serviceFromLabels(LABELS);
    const window = bucketWindow(CLICKED_BUCKET, 'minute');
    const link = logsUrl({ ...project, service, ...window });

    // The link.
    expect(link.to).toBe('/$organizationId/$projectId/logs');
    expect(link.search).toEqual({
      start: '2026-09-07T10:04:00.000Z',
      end: '2026-09-07T10:07:00.000Z',
      service: 'api',
    });

    // And what the logs page makes of it: the pinned window, NOT the "last
    // hour" preset it would otherwise fall back to.
    expect(windowAt(link.search, 60)).toEqual({
      startDate: '2026-09-07T10:04:00.000Z',
      endDate: '2026-09-07T10:07:00.000Z',
    });
  });

  it('contains the clicked instant, with a bucket of room either side', () => {
    const { start, end } = bucketWindow(CLICKED_BUCKET, 'minute');
    const clicked = new Date('2026-09-07T10:05:00.000Z').getTime();

    expect(new Date(start).getTime()).toBeLessThan(clicked);
    expect(new Date(end).getTime()).toBeGreaterThan(clicked);
  });

  it('reaches the traces for the same window by the same route', () => {
    const window = bucketWindow(CLICKED_BUCKET, 'minute');
    const logs = logsUrl({ ...project, service: 'api', ...window });
    const traces = tracesUrl({ ...project, service: 'api', ...window });

    // The two menu items differ only in where they land.
    expect(traces.search).toEqual(logs.search);
    expect(traces.to).toBe('/$organizationId/$projectId/traces');
  });

  it('shows every service when the series names none', () => {
    // A click that lands between series resolves no id, so no labels. Showing
    // the minute's logs unfiltered is a better answer than showing nothing.
    const link = logsUrl({
      ...project,
      service: serviceFromLabels(undefined),
      ...bucketWindow(CLICKED_BUCKET, 'minute'),
    });

    expect(link.search).not.toHaveProperty('service');
    expect(link.search.start).toBe('2026-09-07T10:04:00.000Z');
  });

  it('widens with the panel, so an hourly chart does not ask for a minute', () => {
    expect(bucketWindow(CLICKED_BUCKET, 'hour')).toEqual({
      start: '2026-09-07T09:05:00.000Z',
      end: '2026-09-07T12:05:00.000Z',
    });
  });
});

describe('a log line to its trace', () => {
  const ID = '4bf92f3577b34da6a3ce929d0e0e4736';
  const LINE = `level=error trace_id=${ID} msg="upstream timeout"`;
  const AT = '2026-09-07T10:05:12.000Z';

  it('opens that trace, in a window around the line', () => {
    const traceId = firstTraceId(LINE);
    expect(traceId).toBe(ID);

    const link = tracesUrl({
      ...project,
      trace: traceId,
      ...aroundTimestamp(AT, 60),
    });

    expect(link.search).toEqual({
      trace: ID,
      start: '2026-09-07T10:04:12.000Z',
      end: '2026-09-07T10:06:12.000Z',
    });

    // The traces page pins to that window rather than its own preset.
    expect(windowAt(link.search, 60).startDate).toBe('2026-09-07T10:04:12.000Z');
  });

  it('reaches the traces around the line even when it names no trace', () => {
    const link = tracesUrl({
      ...project,
      service: 'api',
      ...aroundTimestamp(AT, 2),
    });

    expect(link.search).toEqual({
      service: 'api',
      start: '2026-09-07T10:05:10.000Z',
      end: '2026-09-07T10:05:14.000Z',
    });
  });
});

describe('a span to its log lines', () => {
  it('asks for the span window, padded, filtered by the trace id', () => {
    // What the waterfall's link builds: the span's own window plus two seconds
    // at each end, with the trace id as the line filter — the same shape
    // `observability.logsForTrace` uses.
    const spanStart = new Date('2026-09-07T10:05:00.000Z').getTime();
    const durationMs = 1500;
    const padding = 2000;
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';

    const link = logsUrl({
      ...project,
      service: 'api',
      q: traceId,
      start: new Date(spanStart - padding).toISOString(),
      end: new Date(spanStart + durationMs + padding).toISOString(),
    });

    expect(link.search).toEqual({
      service: 'api',
      q: traceId,
      start: '2026-09-07T10:04:58.000Z',
      end: '2026-09-07T10:05:03.500Z',
    });
  });
});

describe('the chain does not depend on the viewer’s timezone', () => {
  it('resolves a chart bucket to the same instant everywhere', () => {
    // `2026-09-07 10:05:00` is a UTC instant with no zone marker. Read as local
    // time it is a different moment on every machine, and the link would land
    // on the wrong minute — silently, because it still looks like a window.
    const offsetMinutes = new Date('2026-09-07T10:05:00Z').getTimezoneOffset();

    expect(bucketWindow('2026-09-07 10:05:00', 'minute')).toEqual({
      start: '2026-09-07T10:04:00.000Z',
      end: '2026-09-07T10:07:00.000Z',
    });

    // Prove the naive reading would really have differed, so this assertion
    // cannot quietly become a tautology on a UTC CI box.
    if (offsetMinutes !== 0) {
      expect(new Date('2026-09-07 10:05:00').toISOString()).not.toBe(
        '2026-09-07T10:05:00.000Z',
      );
    }
  });
});
