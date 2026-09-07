import { describe, expect, it } from 'vitest';
import { parseVariableQuery } from './observability';

/**
 * A variable's `query` is the one place a dashboard author writes a
 * Grafana-shaped expression that OpenPanel has to answer with a project-scoped
 * ClickHouse read. Each case here is either a form that must work or a form
 * that must fail LOUDLY — an empty dropdown and a wrong dropdown look the same
 * to the person configuring it.
 */
describe('parseVariableQuery', () => {
  const accepted: [string, ReturnType<typeof parseVariableQuery>][] = [
    ['label_names()', { kind: 'label_names' }],
    ['label_names(  )', { kind: 'label_names' }],
    ['  label_names()  ', { kind: 'label_names' }],
    [
      'label_values(service_name)',
      { kind: 'label_values', label: 'service_name' },
    ],
    [
      'label_values(up, service_name)',
      { kind: 'label_values', label: 'service_name', metric: 'up' },
    ],
    [
      'label_values( http_requests_total , method )',
      { kind: 'label_values', label: 'method', metric: 'http_requests_total' },
    ],
    [
      'label_values(job:http:rate5m, method)',
      { kind: 'label_values', label: 'method', metric: 'job:http:rate5m' },
    ],
  ];

  for (const [query, expected] of accepted) {
    it(`accepts ${JSON.stringify(query)}`, () => {
      expect(parseVariableQuery(query)).toEqual(expected);
    });
  }

  const rejected: [string, RegExp][] = [
    ['', /must be label_values/],
    ['up', /must be label_values/],
    ['label_values()', /must be label_values/],
    ['query_result(up)', /must be label_values/],
    ['label_values(up, my-label)', /not a valid label name/],
    ['label_values(up, )', /not a valid label name/],
  ];

  for (const [query, message] of rejected) {
    it(`rejects ${JSON.stringify(query)}`, () => {
      expect(() => parseVariableQuery(query)).toThrow(message);
    });
  }

});

/**
 * The selector form, once the metadata service gained matcher support. Each
 * case is either a selector people actually write in Grafana or a form that
 * the ClickHouse-backed reads cannot answer honestly.
 */
describe('parseVariableQuery selectors', () => {
  it('reads a matcher alongside the metric', () => {
    expect(parseVariableQuery('label_values(up{job="api"}, pod)')).toEqual({
      kind: 'label_values',
      label: 'pod',
      metric: 'up',
      matchers: [{ label: 'job', op: '=', value: 'api' }],
    });
  });

  it('reads several matchers', () => {
    expect(
      parseVariableQuery('label_values(up{job="api", zone!="eu"}, pod)'),
    ).toEqual({
      kind: 'label_values',
      label: 'pod',
      metric: 'up',
      matchers: [
        { label: 'job', op: '=', value: 'api' },
        { label: 'zone', op: '!=', value: 'eu' },
      ],
    });
  });

  it('reads a matcher-only selector', () => {
    expect(parseVariableQuery('label_values({job="api"}, pod)')).toEqual({
      kind: 'label_values',
      label: 'pod',
      metric: undefined,
      matchers: [{ label: 'job', op: '=', value: 'api' }],
    });
  });

  it('does not split a value that contains a comma', () => {
    // Splitting on every comma would cut this matcher in half and reject a
    // query that is perfectly valid.
    expect(parseVariableQuery('label_values(up{path="/a,b"}, pod)')).toEqual({
      kind: 'label_values',
      label: 'pod',
      metric: 'up',
      matchers: [{ label: 'path', op: '=', value: '/a,b' }],
    });
  });

  it('unescapes a quoted value', () => {
    expect(
      parseVariableQuery('label_values(up{msg="say \\"hi\\""}, pod)'),
    ).toEqual({
      kind: 'label_values',
      label: 'pod',
      metric: 'up',
      matchers: [{ label: 'msg', op: '=', value: 'say "hi"' }],
    });
  });

  it('keeps the plain metric form working', () => {
    expect(parseVariableQuery('label_values(up{}, pod)')).toEqual({
      kind: 'label_values',
      label: 'pod',
      metric: 'up',
      matchers: undefined,
    });
  });

  const rejected: [string, string, RegExp][] = [
    [
      'a regex matcher, which would scan every value of the key',
      'label_values(up{job=~"api.*"}, pod)',
      /equality matchers only/,
    ],
    [
      'a negated regex matcher',
      'label_values(up{job!~"api.*"}, pod)',
      /equality matchers only/,
    ],
    [
      'an unquoted matcher value',
      'label_values(up{job=api}, pod)',
      /is not a label matcher/,
    ],
    [
      'a matcher whose label is not an identifier',
      'label_values(up{my-job="api"}, pod)',
      /is not a label matcher/,
    ],
    [
      'a metric name that is not an identifier',
      'label_values(1up{job="api"}, pod)',
      /not a metric name or a selector/,
    ],
    [
      // The label is taken from the LAST comma, so the leftover reaches the
      // selector parser and is rejected there.
      'three arguments',
      'label_values(up, pod, extra)',
      /not a metric name or a selector/,
    ],
  ];

  for (const [name, query, message] of rejected) {
    it(`rejects ${name}`, () => {
      expect(() => parseVariableQuery(query)).toThrow(message);
    });
  }

  it('rejects more matchers than the metadata service accepts', () => {
    const matchers = Array.from({ length: 11 }, (_, i) => `l${i}="v"`).join(',');

    expect(() =>
      parseVariableQuery(`label_values(up{${matchers}}, pod)`),
    ).toThrow(/at most 10 label matchers/);
  });
});
