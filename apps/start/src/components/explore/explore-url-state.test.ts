/**
 * Explore's URL round trip, the zoom-out arithmetic and the history dedupe.
 *
 * The round-trip cases carry the weight: plan §8 item 4 is that a shared link
 * reopens the page identically, and "identically" includes the legend, the unit
 * and the axis — the things the person pasting the link is usually pointing at.
 *
 * Run with: cd apps/start && NITRO=1 npx vitest run src/components/explore
 */
import { createPanelQuery } from '@/components/promql/panel-query';
import type { FinalChart, IPanelQuery } from '@openpanel/validation';
import { describe, expect, it } from 'vitest';

import {
  decodeQueries,
  encodeQueries,
  exprsToRecord,
  panelQueriesParser,
  windowFromChart,
  zoomOut,
} from './explore-url-state';

const query = (overrides: Partial<IPanelQuery>): IPanelQuery =>
  createPanelQuery(overrides.refId ?? 'A', overrides);

describe('encode/decode', () => {
  it('round-trips a plain query', () => {
    const queries = [query({ refId: 'A', expr: 'up', mode: 'builder' })];

    expect(decodeQueries(encodeQueries(queries))).toEqual(queries);
  });

  it('round-trips every display option', () => {
    const queries = [
      query({
        refId: 'A',
        expr: 'sum(rate(http_requests_total[5m]))',
        mode: 'code',
        legendFormat: '{{method}}',
        hidden: true,
        unit: 'ops',
        yAxis: 'right',
        minStep: '15s',
        instant: true,
      }),
      query({ refId: 'B', expr: 'up', mode: 'builder' }),
    ];

    expect(decodeQueries(encodeQueries(queries))).toEqual(queries);
  });

  it('spends URL on nothing that is at its default', () => {
    const [encoded] = encodeQueries([
      query({ refId: 'A', expr: 'up', mode: 'builder' }),
    ]);

    expect(encoded).toEqual({ r: 'A', e: 'up' });
  });

  it('keeps refIds rather than re-lettering by position', () => {
    // Legends and error messages name the query by refId, so a panel whose B
    // was deleted must not come back with C renamed to B.
    const queries = [
      query({ refId: 'A', expr: 'up' }),
      query({ refId: 'C', expr: 'down' }),
    ];

    expect(decodeQueries(encodeQueries(queries))?.map((q) => q.refId)).toEqual([
      'A',
      'C',
    ]);
  });

  it('drops a row with no expression rather than encoding an empty query', () => {
    // An unfilled builder row is the normal state of a page being built, and
    // `zPanelQuery` requires a non-empty expr.
    expect(
      encodeQueries([query({ refId: 'A', expr: '' }), query({ refId: 'B', expr: 'up' })]),
    ).toEqual([{ r: 'B', e: 'up' }]);
  });

  it('refuses a payload that is not a query list', () => {
    expect(decodeQueries(null)).toBeNull();
    expect(decodeQueries([])).toBeNull();
    expect(decodeQueries('up')).toBeNull();
    expect(decodeQueries([{ e: 'up' }])).toBeNull();
  });

  it('keeps the queries it understands when one is malformed', () => {
    // A stranger can write this URL. One bad entry should not throw away what
    // the sender was actually pointing at.
    expect(
      decodeQueries([
        { r: 'A', e: 'up' },
        { r: 'B', e: 'down', u: 'furlongs' },
      ]),
    ).toEqual([query({ refId: 'A', expr: 'up' })]);
  });

  it('never lets an unknown unit through', () => {
    // An unrecognised unit formats as a bare number with no error anywhere.
    expect(decodeQueries([{ r: 'A', e: 'up', u: 'furlongs' }])).toBeNull();
  });

  it('caps the list at what the panel schema allows', () => {
    const eleven = Array.from({ length: 11 }, (_, index) => ({
      r: String.fromCharCode(65 + index),
      e: 'up',
    }));

    expect(decodeQueries(eleven)).toBeNull();
  });
});

describe('panelQueriesParser', () => {
  it('parses what it serializes', () => {
    const queries = [
      query({ refId: 'A', expr: 'up', unit: 'bytes', mode: 'code' }),
    ];

    expect(panelQueriesParser.parse(panelQueriesParser.serialize(queries))).toEqual(
      queries,
    );
  });

  it('survives a hand-mangled parameter', () => {
    expect(panelQueriesParser.parse('not json')).toBeNull();
    expect(panelQueriesParser.parse('{}')).toBeNull();
  });

  it('treats two equal query lists as equal', () => {
    const a = [query({ refId: 'A', expr: 'up' })];
    const b = [query({ refId: 'A', expr: 'up' })];

    expect(panelQueriesParser.eq?.(a, b)).toBe(true);
  });
});

describe('windowFromChart', () => {
  const chartWith = (dates: string[]): FinalChart =>
    ({
      series: [
        {
          id: 'A:',
          names: ['A'],
          event: { name: 'A' },
          metrics: {},
          data: dates.map((date) => ({ date, count: 1, previous: null })),
        },
      ],
      metrics: {},
    }) as unknown as FinalChart;

  it('reads the drawn window off the buckets', () => {
    expect(
      windowFromChart(
        chartWith([
          '2026-09-07T10:00:00.000Z',
          '2026-09-07T11:00:00.000Z',
          '2026-09-07T12:00:00.000Z',
        ]),
      ),
    ).toEqual({
      startDate: '2026-09-07T10:00:00.000Z',
      endDate: '2026-09-07T12:00:00.000Z',
    });
  });

  it('has nothing to say before a result arrives', () => {
    expect(windowFromChart(undefined)).toBeNull();
    expect(windowFromChart(chartWith([]))).toBeNull();
  });

  it('reads the buckets the engine actually produces', () => {
    // `formatClickhouseDate` output, not ISO — a UTC instant with no zone
    // marker. Every fixture above is ISO, which is precisely how a
    // local-time misreading survives a green suite: run this file under
    // TZ=Europe/Stockholm and the naive parse lands two hours out.
    expect(
      windowFromChart(
        chartWith(['2026-09-07 10:00:00', '2026-09-07 11:00:00']),
      ),
    ).toEqual({
      startDate: '2026-09-07T10:00:00.000Z',
      endDate: '2026-09-07T11:00:00.000Z',
    });
  });

  it('hands zoomOut a window it can reason about', () => {
    // The two functions are only correct together: `zoomOut`'s live-edge branch
    // compares `now - end` against five minutes, so an `end` parsed an hour
    // early silently takes the centred branch instead — the exact case that
    // branch exists to avoid.
    const drawn = windowFromChart(
      chartWith(['2026-09-07 11:00:00', '2026-09-07 12:00:00']),
    );

    expect(zoomOut(drawn!, new Date('2026-09-07T12:00:30.000Z'))).toEqual({
      startDate: '2026-09-07T10:00:00.000Z',
      endDate: '2026-09-07T12:00:00.000Z',
    });
  });
});

describe('zoomOut', () => {
  it('doubles a past window around its centre', () => {
    expect(
      zoomOut(
        {
          startDate: '2026-09-07T10:00:00.000Z',
          endDate: '2026-09-07T12:00:00.000Z',
        },
        new Date('2026-09-07T20:00:00.000Z'),
      ),
    ).toEqual({
      startDate: '2026-09-07T09:00:00.000Z',
      endDate: '2026-09-07T13:00:00.000Z',
    });
  });

  it('extends backwards when the window already ends now', () => {
    // Zooming out of "the last hour" means the last two hours, not thirty
    // minutes of empty future.
    expect(
      zoomOut(
        {
          startDate: '2026-09-07T11:00:00.000Z',
          endDate: '2026-09-07T12:00:00.000Z',
        },
        new Date('2026-09-07T12:00:30.000Z'),
      ),
    ).toEqual({
      startDate: '2026-09-07T10:00:00.000Z',
      endDate: '2026-09-07T12:00:00.000Z',
    });
  });

  it('treats a window within one bucket of now as live', () => {
    const out = zoomOut(
      {
        startDate: '2026-09-07T11:00:00.000Z',
        endDate: '2026-09-07T12:00:00.000Z',
      },
      // Four minutes behind: the gap between the last drawn bucket and now,
      // not evidence the user was looking at the past.
      new Date('2026-09-07T12:04:00.000Z'),
    );

    expect(out.endDate).toBe('2026-09-07T12:00:00.000Z');
  });

  it('leaves a window it cannot make sense of alone', () => {
    const backwards = {
      startDate: '2026-09-07T12:00:00.000Z',
      endDate: '2026-09-07T10:00:00.000Z',
    };

    expect(zoomOut(backwards)).toEqual(backwards);
    expect(zoomOut({ startDate: 'nonsense', endDate: 'nonsense' })).toEqual({
      startDate: 'nonsense',
      endDate: 'nonsense',
    });
  });
});

describe('exprsToRecord', () => {
  it('records each visible expression once', () => {
    expect(
      exprsToRecord(
        [
          query({ refId: 'A', expr: 'up' }),
          query({ refId: 'B', expr: 'down' }),
        ],
        [],
      ),
    ).toEqual(['up', 'down']);
  });

  it('does not record the same expression twice in one run', () => {
    expect(
      exprsToRecord(
        [query({ refId: 'A', expr: 'up' }), query({ refId: 'B', expr: 'up' })],
        [],
      ),
    ).toEqual(['up']);
  });

  it('records nothing when the panel has not changed', () => {
    // The server only compares against its single most recent row, so a
    // two-query panel re-run unchanged would otherwise write both every time.
    expect(
      exprsToRecord(
        [
          query({ refId: 'A', expr: 'up' }),
          query({ refId: 'B', expr: 'down' }),
        ],
        ['up', 'down'],
      ),
    ).toEqual([]);
  });

  it('records only what changed', () => {
    expect(
      exprsToRecord(
        [
          query({ refId: 'A', expr: 'up' }),
          query({ refId: 'B', expr: 'sum(up)' }),
        ],
        ['up', 'down'],
      ),
    ).toEqual(['sum(up)']);
  });

  it('skips hidden and empty rows, which did not run', () => {
    expect(
      exprsToRecord(
        [
          query({ refId: 'A', expr: 'up', hidden: true }),
          query({ refId: 'B', expr: '   ' }),
          query({ refId: 'C', expr: 'down' }),
        ],
        [],
      ),
    ).toEqual(['down']);
  });
});
