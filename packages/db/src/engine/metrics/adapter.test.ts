import { PROJECT_LABEL } from '@openpanel/gigapipe';
import { describe, expect, it } from 'vitest';
import {
  MetricsResponseError,
  adaptMatrixToConcreteSeries,
} from './adapter';

const options = { groupBy: [PROJECT_LABEL, 'route'], metricName: 'http_requests_total' };

const matrix = (result: unknown[]) => ({
  status: 'success',
  data: { resultType: 'matrix', result },
}) as Parameters<typeof adaptMatrixToConcreteSeries>[0];

/**
 * The backend does not return the grid it was asked for. A range starting at
 * :137 past the hour comes back at :135, and any start that is not step-aligned
 * shifts every point by the remainder. Because a bucket with no match reads as
 * zero, exact date matching drew a flat zero line — which looks exactly like
 * "no data" rather than like a bug, and is how this went unnoticed.
 */
describe('samples that do not land exactly on the grid', () => {
  const HOUR = 3_600_000;
  const base = Date.UTC(2024, 0, 1, 12, 0, 0);

  const grid = {
    buckets: ['2024-01-01 12:00:00', '2024-01-01 13:00:00', '2024-01-01 14:00:00'],
    bucketTimes: [base, base + HOUR, base + 2 * HOUR],
  };

  it('snaps an offset sample onto its bucket instead of dropping it', () => {
    const [series] = adaptMatrixToConcreteSeries(
      matrix([
        {
          metric: { [PROJECT_LABEL]: 'p1' },
          // 135 seconds past each bucket, exactly as gigapipe returns them.
          values: [
            [(base + 135_000) / 1000, '7'],
            [(base + HOUR + 135_000) / 1000, '9'],
          ],
        },
      ]),
      { ...options, ...grid },
    );

    expect(series?.data.map((d) => d.count)).toEqual([7, 9, 0]);
  });

  it('still reports a genuinely empty bucket as zero', () => {
    const [series] = adaptMatrixToConcreteSeries(
      matrix([
        {
          metric: { [PROJECT_LABEL]: 'p1' },
          values: [[(base + 2 * HOUR) / 1000, '4']],
        },
      ]),
      { ...options, ...grid },
    );

    expect(series?.data.map((d) => d.count)).toEqual([0, 0, 4]);
  });

  it('drops a sample that falls outside the grid rather than misdating it', () => {
    const [series] = adaptMatrixToConcreteSeries(
      matrix([
        {
          metric: { [PROJECT_LABEL]: 'p1' },
          values: [
            [(base - 5 * HOUR) / 1000, '99'],
            [(base + HOUR) / 1000, '3'],
          ],
        },
      ]),
      { ...options, ...grid },
    );

    expect(series?.data.map((d) => d.count)).toEqual([0, 3, 0]);
  });
});

describe('adaptMatrixToConcreteSeries', () => {
  it('maps a matrix series onto the shape format() consumes', () => {
    const [series] = adaptMatrixToConcreteSeries(
      matrix([
        {
          metric: { [PROJECT_LABEL]: 'p1', route: '/checkout' },
          values: [
            [1700000000, '10'],
            [1700000060, '12.5'],
          ],
        },
      ]),
      options,
    );

    expect(series?.name).toEqual(['/checkout']);
    expect(series?.context.breakdowns).toEqual({ route: '/checkout' });
    expect(series?.data.map((d) => d.count)).toEqual([10, 12.5]);
    expect(series?.data[0]?.date).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('strips the project label from breakdowns and from the name', () => {
    // It is the same for every series by construction, so surfacing it would
    // add a constant legend column and leak an internal identifier.
    const [series] = adaptMatrixToConcreteSeries(
      matrix([
        { metric: { [PROJECT_LABEL]: 'p1', route: '/a' }, values: [[1, '1']] },
      ]),
      options,
    );

    expect(series?.context.breakdowns).not.toHaveProperty(PROJECT_LABEL);
    expect(series?.name).toEqual(['/a']);
  });

  it('falls back to the metric name when there is nothing to group by', () => {
    const [series] = adaptMatrixToConcreteSeries(
      matrix([{ metric: { [PROJECT_LABEL]: 'p1' }, values: [[1, '5']] }]),
      { groupBy: [PROJECT_LABEL], metricName: 'up' },
    );

    expect(series?.name).toEqual(['up']);
  });

  it('treats NaN as a gap, never as zero', () => {
    // Prometheus renders a missing quantile as NaN. Drawing 0 there would
    // invent a measurement the backend explicitly declined to make.
    const [series] = adaptMatrixToConcreteSeries(
      matrix([
        {
          metric: { [PROJECT_LABEL]: 'p1', route: '/a' },
          values: [
            [1700000000, '10'],
            [1700000060, 'NaN'],
          ],
        },
      ]),
      options,
    );

    expect(series?.data).toHaveLength(1);
    expect(series?.data[0]?.count).toBe(10);
  });

  it('fills the caller-supplied bucket grid so a gap cannot shift the line', () => {
    // Prometheus omits empty steps. Without a dense grid every later point
    // moves left and the whole series is silently misdated.
    const buckets = [
      '2023-11-14 22:13:20',
      '2023-11-14 22:14:20',
      '2023-11-14 22:15:20',
    ];

    const [series] = adaptMatrixToConcreteSeries(
      matrix([
        {
          metric: { [PROJECT_LABEL]: 'p1', route: '/a' },
          values: [[1700000000, '7']],
        },
      ]),
      { ...options, buckets },
    );

    expect(series?.data.map((d) => d.date)).toEqual(buckets);
    expect(series?.data.map((d) => d.count)).toEqual([7, 0, 0]);
  });

  it('gives each series a stable id derived from its labels, not its index', () => {
    const [a, b] = adaptMatrixToConcreteSeries(
      matrix([
        { metric: { [PROJECT_LABEL]: 'p1', route: '/a' }, values: [] },
        { metric: { [PROJECT_LABEL]: 'p1', route: '/b' }, values: [] },
      ]),
      options,
    );

    expect(a?.id).toBe('route=/a');
    expect(b?.id).toBe('route=/b');
  });

  it('handles an empty result without throwing', () => {
    expect(adaptMatrixToConcreteSeries(matrix([]), options)).toEqual([]);
  });

  it('refuses a non-success response', () => {
    expect(() =>
      adaptMatrixToConcreteSeries(
        { status: 'error' } as Parameters<typeof adaptMatrixToConcreteSeries>[0],
        options,
      ),
    ).toThrow(MetricsResponseError);
  });

  it('refuses a vector when a matrix was expected', () => {
    // An instant query answering a range request would render one point per
    // series and look like a flat line rather than an error.
    expect(() =>
      adaptMatrixToConcreteSeries(
        {
          status: 'success',
          data: { resultType: 'vector', result: [] },
        } as Parameters<typeof adaptMatrixToConcreteSeries>[0],
        options,
      ),
    ).toThrow(MetricsResponseError);
  });
});
