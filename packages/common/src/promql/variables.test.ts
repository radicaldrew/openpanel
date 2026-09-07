import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCRAPE_INTERVAL_SECONDS,
  VARIABLE_ALL_SENTINEL,
  formatPromDuration,
  rateInterval,
  referencedVariables,
  substituteVariables,
} from './variables';

const opts = { step: 60, rangeSeconds: 86_400 };

describe('referencedVariables', () => {
  const cases: [string, string, string[]][] = [
    ['a bare variable', 'up{job="$service"}', ['service']],
    ['a braced variable', 'up{job="${service}"}', ['service']],
    [
      'several variables, deduplicated and in order',
      'a{x="$b"} + c{y="$d", z="$b"}',
      ['b', 'd'],
    ],
    ['no variables', 'rate(up[5m])', []],
    [
      'built-ins are excluded — they are resolved from the step, not chosen',
      'rate(up[$__rate_interval]) / $__range',
      [],
    ],
    ['a mix of built-ins and real variables', 'rate(up{job="$svc"}[$__interval])', ['svc']],
  ];

  for (const [name, expr, expected] of cases) {
    it(name, () => {
      expect(referencedVariables(expr)).toEqual(expected);
    });
  }
});

describe('formatPromDuration', () => {
  const cases: [number, string][] = [
    [15, '15s'],
    [60, '1m'],
    [90, '90s'],
    [300, '5m'],
    [3600, '1h'],
    [7200, '2h'],
    [86_400, '1d'],
    [0.4, '1s'],
    [0, '1s'],
  ];

  for (const [seconds, expected] of cases) {
    it(`${seconds} → ${expected}`, () => {
      expect(formatPromDuration(seconds)).toBe(expected);
    });
  }
});

describe('rateInterval', () => {
  it('is four steps when the step is the wider of the two', () => {
    expect(rateInterval(60)).toBe(240);
  });

  it('never drops below four scrape intervals', () => {
    expect(rateInterval(1)).toBe(DEFAULT_SCRAPE_INTERVAL_SECONDS * 4);
  });

  it('takes the deployment scrape interval when it is known', () => {
    expect(rateInterval(10, 30)).toBe(120);
  });
});

describe('built-in substitution', () => {
  const cases: [string, string, string][] = [
    ['$__interval is the step', 'x[$__interval]', 'x[1m]'],
    [
      '$__rate_interval is four steps',
      'rate(x[$__rate_interval])',
      'rate(x[4m])',
    ],
    ['$__range is the window', 'increase(x[$__range])', 'increase(x[1d])'],
    [
      'the braced form works too',
      'rate(x[${__rate_interval}])',
      'rate(x[4m])',
    ],
  ];

  for (const [name, expr, expected] of cases) {
    it(name, () => {
      expect(substituteVariables(expr, {}, opts)).toBe(expected);
    });
  }

  it('floors $__rate_interval at four scrape intervals for a fine step', () => {
    expect(substituteVariables('rate(x[$__rate_interval])', {}, {
      step: 5,
      rangeSeconds: 3600,
    })).toBe('rate(x[1m])');
  });
});

describe('value substitution', () => {
  const cases: [string, Record<string, string | string[]>, string, string][] = [
    [
      'a single value',
      { service: 'api' },
      'up{job=~"$service"}',
      'up{job=~"api"}',
    ],
    [
      'several values become an alternation',
      { service: ['api', 'worker'] },
      'up{job=~"$service"}',
      'up{job=~"(api|worker)"}',
    ],
    [
      'a single-element array is not wrapped',
      { service: ['api'] },
      'up{job=~"$service"}',
      'up{job=~"api"}',
    ],
    [
      'the All sentinel matches every non-empty value',
      { service: VARIABLE_ALL_SENTINEL },
      'up{job=~"$service"}',
      'up{job=~".+"}',
    ],
    [
      'All inside a multi-selection wins',
      { service: ['api', VARIABLE_ALL_SENTINEL] },
      'up{job=~"$service"}',
      'up{job=~".+"}',
    ],
    [
      'an empty selection matches everything rather than the empty string',
      { service: [] },
      'up{job=~"$service"}',
      'up{job=~".+"}',
    ],
    [
      'the braced form',
      { service: 'api' },
      'up{job=~"${service}"}',
      'up{job=~"api"}',
    ],
    [
      'the same variable in several places',
      { s: 'api' },
      'a{j=~"$s"} / b{j=~"$s"}',
      'a{j=~"api"} / b{j=~"api"}',
    ],
  ];

  for (const [name, values, expr, expected] of cases) {
    it(name, () => {
      expect(substituteVariables(expr, values, opts)).toBe(expected);
    });
  }

  it('leaves an unknown variable exactly as written', () => {
    // Dropping it would silently widen `job=~""` to match nothing, or `job=~".*"`
    // to match everything; leaving it makes the rewriter reject the query and
    // point at the text the user typed.
    expect(substituteVariables('up{job=~"$nope"}', { other: 'x' }, opts)).toBe(
      'up{job=~"$nope"}',
    );
  });
});

describe('a value can never leave its string literal', () => {
  const escapes: [string, string, string][] = [
    ['a double quote', 'a"b', 'a\\"b'],
    ['a backslash', 'a\\b', 'a\\\\\\\\b'],
    ['a regex wildcard', 'a.*b', 'a\\\\.\\\\*b'],
    ['an alternation', 'a|b', 'a\\\\|b'],
    ['a group', '(a)', '\\\\(a\\\\)'],
    ['an anchor', '^a$', '\\\\^a\\\\$'],
    ['a quantifier', 'a+b?', 'a\\\\+b\\\\?'],
    ['a character class', 'a[b]', 'a\\\\[b\\\\]'],
  ];

  for (const [name, value, expected] of escapes) {
    it(`escapes ${name}`, () => {
      expect(substituteVariables('up{j=~"$v"}', { v: value }, opts)).toBe(
        `up{j=~"${expected}"}`,
      );
    });
  }

  it('cannot inject a second matcher', () => {
    const out = substituteVariables(
      'up{job=~"$service"}',
      { service: 'x"} or up{op_project_id="other' },
      opts,
    );

    expect(out).toBe(
      'up{job=~"x\\"\\\\} or up\\\\{op_project_id=\\"other"}',
    );
    // Nothing in the substituted text terminates the literal: strip every
    // escape pair and no bare quote is left inside it. The braces the value
    // carried are still there, but backslash-escaped and therefore data.
    const inner = out.slice(out.indexOf('"') + 1, out.lastIndexOf('"'));
    expect(inner.replace(/\\./g, '')).not.toContain('"');
    expect(out.endsWith('"}')).toBe(true);
  });

  it('escapes each member of a multi-value selection', () => {
    expect(
      substituteVariables('up{j=~"$v"}', { v: ['a.b', 'c|d'] }, opts),
    ).toBe('up{j=~"(a\\\\.b|c\\\\|d)"}');
  });
});
