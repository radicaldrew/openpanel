import { describe, expect, it } from 'vitest';
import { formatLegend, legendPlaceholders } from './legend';

const labels = {
  __name__: 'http_requests_total',
  op_project_id: 'proj_123',
  method: 'GET',
  status: '200',
};

describe('legendFormat', () => {
  const cases: [string, string, string][] = [
    ['one placeholder', '{{method}}', 'GET'],
    ['several placeholders', '{{method}} {{status}}', 'GET 200'],
    ['surrounding text', 'rate for {{method}}', 'rate for GET'],
    ['whitespace inside the braces', '{{ method }}', 'GET'],
    ['the refId placeholder', '{{__refId}} {{method}}', 'B GET'],
    ['the metric name, which is a real label', '{{__name__}}', 'http_requests_total'],
    ['a placeholder for a label that is missing', 'x {{pod}}', 'x'],
  ];

  for (const [name, format, expected] of cases) {
    it(name, () => {
      expect(
        formatLegend(format, labels, { refId: 'B', multi: true }),
      ).toBe(expected);
    });
  }

  it('falls through when every placeholder resolves to nothing', () => {
    // Rendering every line as a blank string is worse than ignoring the format.
    expect(formatLegend('{{pod}}', labels, { refId: 'B', multi: true })).toBe(
      '{method="GET", status="200"}',
    );
  });

  it('falls through on a blank format', () => {
    expect(formatLegend('   ', labels, { refId: 'B', multi: false })).toBe(
      'GET 200',
    );
  });
});

describe('the fallback chain', () => {
  it('renders labels with their keys when the panel has several queries', () => {
    expect(formatLegend(undefined, labels, { refId: 'A', multi: true })).toBe(
      '{method="GET", status="200"}',
    );
  });

  it('renders bare values when there is only one query', () => {
    expect(formatLegend(undefined, labels, { refId: 'A', multi: false })).toBe(
      'GET 200',
    );
  });

  it('sorts labels so a legend does not reorder between refetches', () => {
    expect(
      formatLegend(
        undefined,
        { status: '200', method: 'GET', app: 'api' },
        { refId: 'A', multi: true },
      ),
    ).toBe('{app="api", method="GET", status="200"}');
  });

  it('never leaks the tenancy label', () => {
    expect(
      formatLegend(
        undefined,
        { op_project_id: 'proj_123', method: 'GET' },
        { refId: 'A', multi: true },
      ),
    ).toBe('{method="GET"}');
  });

  it('skips empty label values', () => {
    expect(
      formatLegend(
        undefined,
        { method: 'GET', pod: '' },
        { refId: 'A', multi: true },
      ),
    ).toBe('{method="GET"}');
  });

  it('falls back to the metric name when nothing distinguishes the series', () => {
    expect(
      formatLegend(
        undefined,
        { __name__: 'up', op_project_id: 'proj_123' },
        { refId: 'A', multi: true },
      ),
    ).toBe('up');
  });

  it('falls back to the refId when there is nothing at all', () => {
    expect(formatLegend(undefined, {}, { refId: 'C', multi: true })).toBe('C');
  });
});

describe('legendPlaceholders', () => {
  it('lists each placeholder once', () => {
    expect(legendPlaceholders('{{method}} {{status}} {{method}}')).toEqual([
      'method',
      'status',
    ]);
  });

  it('is empty for a format with no placeholders', () => {
    expect(legendPlaceholders('total')).toEqual([]);
  });
});
