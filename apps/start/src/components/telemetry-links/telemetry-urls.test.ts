/**
 * The links between the telemetry surfaces.
 *
 * These are asserted rather than clicked because there is no browser in this
 * session, and because the failure they guard against is silent: a link that
 * lands on a window an hour wide instead of a minute still looks like it
 * worked. The URL chain — click → built link → what the destination parses back
 * out — is verified end to end in telemetry-round-trip.test.ts.
 *
 * Run with: cd apps/start && NITRO=1 npx vitest run src/components/telemetry-links
 */
import { VARIABLE_PARAM_PREFIX } from '@/components/dashboard/variables/variable-values';
import { decodeQueries } from '@/components/explore/explore-url-state';
import { parseBuilderState } from '@/components/promql/builder-parse';
import { describe, expect, it } from 'vitest';

import {
  aroundTimestamp,
  bucketWindow,
  exploreRateQuery,
  exploreUrl,
  isoFromNanos,
  logsUrl,
  serviceFromLabels,
  tracesUrl,
} from './telemetry-urls';

const project = { organizationId: 'org_1', projectId: 'proj_1' };

describe('logsUrl', () => {
  it('carries the absolute window and the filters', () => {
    expect(
      logsUrl({
        ...project,
        start: '2026-09-07T10:00:00.000Z',
        end: '2026-09-07T10:02:00.000Z',
        service: 'api',
        level: 'error',
        q: 'timeout',
      }),
    ).toEqual({
      to: '/$organizationId/$projectId/logs',
      params: project,
      search: {
        start: '2026-09-07T10:00:00.000Z',
        end: '2026-09-07T10:02:00.000Z',
        service: 'api',
        level: 'error',
        q: 'timeout',
      },
    });
  });

  it('drops a preset once there is an absolute window', () => {
    // "Last hour" resolved when the link is FOLLOWED is a different hour from
    // the one the user clicked on, so the two must not both be in the URL.
    expect(
      logsUrl({
        ...project,
        range: '1h',
        start: '2026-09-07T10:00:00.000Z',
        end: '2026-09-07T10:02:00.000Z',
      }).search,
    ).not.toHaveProperty('range');
  });

  it('keeps the preset when there is no absolute window', () => {
    expect(logsUrl({ ...project, range: '6h' }).search).toEqual({ range: '6h' });
  });

  it('omits empty filters rather than sending blanks', () => {
    expect(
      logsUrl({ ...project, service: null, level: '', q: undefined }).search,
    ).toEqual({});
  });
});

describe('tracesUrl', () => {
  it('carries the window, the service and the trace', () => {
    expect(
      tracesUrl({
        ...project,
        start: '2026-09-07T10:00:00.000Z',
        end: '2026-09-07T10:00:04.000Z',
        service: 'api',
        trace: 'abc123',
      }).search,
    ).toEqual({
      start: '2026-09-07T10:00:00.000Z',
      end: '2026-09-07T10:00:04.000Z',
      service: 'api',
      trace: 'abc123',
    });
  });

  it('treats a zero minimum duration as "any", which is not a filter', () => {
    expect(tracesUrl({ ...project, minDuration: 0 }).search).toEqual({});
    expect(tracesUrl({ ...project, minDuration: 500 }).search).toEqual({
      minDuration: '500',
    });
  });
});

describe('exploreUrl', () => {
  it('encodes the queries the way Explore reads them', () => {
    const queries = [exploreRateQuery('http_requests_total', 'api')];
    const search = exploreUrl({ ...project, queries }).search;
    const decoded = decodeQueries(JSON.parse(search.q ?? 'null'));

    // The whole point: a link built here and a link copied out of Explore's
    // address bar have to be the same link. `builder` is the one field that
    // does not survive, by design — the encoding leaves it out because
    // `parseBuilderState` re-derives it from `expr`, which is asserted next.
    expect(decoded).toEqual(
      queries.map(({ builder: _builder, ...rest }) => rest),
    );
    expect(parseBuilderState(decoded?.[0]?.expr ?? '')).toEqual(
      queries[0]?.builder,
    );
  });

  it('marks an absolute window as a custom range', () => {
    // Unlike logs and traces, Explore's range enum HAS a `custom` member and
    // the engine reads it, so the window and the range travel together.
    expect(
      exploreUrl({
        ...project,
        queries: [],
        start: '2026-09-07T10:00:00.000Z',
        end: '2026-09-07T11:00:00.000Z',
      }).search,
    ).toEqual({
      range: 'custom',
      start: '2026-09-07T10:00:00.000Z',
      end: '2026-09-07T11:00:00.000Z',
    });
  });

  it('passes dashboard variables in the form the dashboard writes them', () => {
    const search = exploreUrl({
      ...project,
      queries: [],
      variables: { service: 'api', region: ['eu', 'us'] },
    }).search;

    expect(search[`${VARIABLE_PARAM_PREFIX}service`]).toBe('api');
    // Multi-valued variables are comma-joined, matching the dashboard.
    expect(search[`${VARIABLE_PARAM_PREFIX}region`]).toBe('eu,us');
  });

  it('omits the query parameter when there is nothing to run', () => {
    expect(exploreUrl({ ...project, queries: [] }).search).not.toHaveProperty(
      'q',
    );
  });
});

describe('serviceFromLabels', () => {
  it('prefers what the OTLP collector writes', () => {
    expect(
      serviceFromLabels({ service_name: 'api', job: 'scrape', service: 'other' }),
    ).toBe('api');
  });

  it('falls back through job to service', () => {
    expect(serviceFromLabels({ job: 'scrape', service: 'other' })).toBe('scrape');
    expect(serviceFromLabels({ service: 'other' })).toBe('other');
  });

  it('uses the dashboard variable only when the series says nothing', () => {
    // A label on the series is evidence; a variable is what the user filtered
    // the dashboard to, and a panel may legitimately draw another service.
    expect(serviceFromLabels({ service_name: 'api' }, { service: 'web' })).toBe(
      'api',
    );
    expect(serviceFromLabels({}, { service: 'web' })).toBe('web');
  });

  it('will not pick one of several services', () => {
    // A multi-valued `$service` names several; choosing the first would filter
    // the logs to one of them without saying so.
    expect(serviceFromLabels({}, { service: ['api', 'web'] })).toBeUndefined();
  });

  it('has nothing to say about a series with no service label', () => {
    expect(serviceFromLabels(undefined)).toBeUndefined();
    expect(serviceFromLabels({ method: 'GET' })).toBeUndefined();
  });
});

describe('bucketWindow', () => {
  it('spans the clicked bucket plus one either side', () => {
    // The clicked minute runs 10:05–10:06, so the window is 10:04–10:07.
    expect(bucketWindow('2026-09-07T10:05:00.000Z', 'minute')).toEqual({
      start: '2026-09-07T10:04:00.000Z',
      end: '2026-09-07T10:07:00.000Z',
    });
  });

  it('scales with the interval rather than using a fixed padding', () => {
    expect(bucketWindow('2026-09-07T10:00:00.000Z', 'hour')).toEqual({
      start: '2026-09-07T09:00:00.000Z',
      end: '2026-09-07T12:00:00.000Z',
    });

    expect(bucketWindow('2026-09-07T00:00:00.000Z', 'day')).toEqual({
      start: '2026-09-06T00:00:00.000Z',
      end: '2026-09-09T00:00:00.000Z',
    });
  });

  it('uses calendar arithmetic for months, and UTC for all of it', () => {
    expect(bucketWindow('2026-09-07T00:00:00.000Z', 'week')).toEqual({
      start: '2026-08-31T00:00:00.000Z',
      end: '2026-09-21T00:00:00.000Z',
    });

    // February is not 30 days, so a fixed millisecond span would drift — and
    // the arithmetic is in UTC, so the answer does not depend on whether the
    // viewer's timezone crosses a DST boundary in between.
    expect(bucketWindow('2026-02-01T00:00:00.000Z', 'month')).toEqual({
      start: '2026-01-01T00:00:00.000Z',
      end: '2026-04-01T00:00:00.000Z',
    });
  });

  it('refuses a date it cannot read', () => {
    expect(() => bucketWindow('not a date', 'hour')).toThrow();
  });
});

describe('aroundTimestamp', () => {
  it('centres the window on the moment', () => {
    expect(aroundTimestamp('2026-09-07T10:00:10.000Z', 2)).toEqual({
      start: '2026-09-07T10:00:08.000Z',
      end: '2026-09-07T10:00:12.000Z',
    });
  });
});

describe('isoFromNanos', () => {
  it('does not lose the low digits', () => {
    // 1757239200123456789ns. Parsed as a Number this is past
    // MAX_SAFE_INTEGER and silently wrong.
    expect(isoFromNanos('1757239200123456789')).toBe('2025-09-07T10:00:00.123Z');
  });
});

describe('exploreRateQuery', () => {
  it('compiles a per-service rate for a counter', () => {
    expect(exploreRateQuery('http_requests_total', 'api')).toMatchObject({
      refId: 'A',
      mode: 'builder',
      expr: 'sum by (service_name)(rate(http_requests_total{service_name="api"}[$__rate_interval]))',
    });
  });

  it('groups by service even when no service was chosen', () => {
    // Arriving from a log line, "how does this compare with the others" is the
    // question, so the grouping stays.
    expect(exploreRateQuery('http_requests_total').expr).toBe(
      'sum by (service_name)(rate(http_requests_total[$__rate_interval]))',
    );
  });

  it('escapes a service name that would break out of the matcher', () => {
    expect(exploreRateQuery('x_total', 'a"b').expr).toContain('\\"');
  });
});
