import { describe, expect, it } from 'vitest';

import type { IDashboardVariable } from '@openpanel/validation';

import {
  applyVariablesToReport,
  defaultVariableValue,
  formatVariableValue,
  isValidVariableQuery,
  parseVariableValue,
  serializeVariableValue,
  staticVariableOptions,
  substituteTitle,
  unresolvedVariables,
  VARIABLE_QUERY_REGEX_HINT,
  variableParamName,
  variableQueryError,
  variablesForQueries,
} from './variable-values';

const variable = (
  overrides: Partial<IDashboardVariable> = {},
): IDashboardVariable => ({
  name: 'service',
  type: 'query',
  multi: false,
  includeAll: false,
  ...overrides,
});

describe('URL round trip', () => {
  it('prefixes the param so a variable cannot collide with range or search', () => {
    expect(variableParamName('range')).toBe('var_range');
  });

  it('round trips a single value', () => {
    expect(parseVariableValue(serializeVariableValue('api'), false)).toBe('api');
  });

  it('round trips a multi value', () => {
    expect(
      parseVariableValue(serializeVariableValue(['api', 'web']), true),
    ).toEqual(['api', 'web']);
  });

  it('reads an absent or empty param as no value', () => {
    expect(parseVariableValue(null, false)).toBeNull();
    expect(parseVariableValue('', true)).toBeNull();
  });

  it('drops blanks from a hand-edited multi param', () => {
    expect(parseVariableValue('api, ,web,', true)).toEqual(['api', 'web']);
  });

  it('keeps a comma-looking single value intact', () => {
    // Only a multi variable splits: a single-valued variable holding "a,b"
    // means the label value "a,b".
    expect(parseVariableValue('a,b', false)).toBe('a,b');
  });
});

describe('a variable starts on something usable', () => {
  it('prefers the saved current value', () => {
    expect(
      defaultVariableValue(variable({ current: 'api' }), ['web', 'worker']),
    ).toBe('api');
  });

  it('wraps a saved single value when the variable is now multi', () => {
    expect(
      defaultVariableValue(variable({ multi: true, current: 'api' }), null),
    ).toEqual(['api']);
  });

  it('unwraps a saved multi value when the variable is now single', () => {
    expect(
      defaultVariableValue(variable({ current: ['api', 'web'] }), null),
    ).toBe('api');
  });

  it('falls back to All when the variable offers it', () => {
    expect(defaultVariableValue(variable({ includeAll: true }), ['api'])).toBe(
      '__all__',
    );
    expect(
      defaultVariableValue(variable({ includeAll: true, multi: true }), ['api']),
    ).toEqual(['__all__']);
  });

  it('falls back to the first option', () => {
    expect(defaultVariableValue(variable({}), ['api', 'web'])).toBe('api');
  });

  it('has no value while a query variable is still loading its options', () => {
    // The panels wait for this rather than running with `$service` unresolved,
    // which the server would reject as a parse error.
    expect(defaultVariableValue(variable({}), null)).toBeNull();
  });
});

describe('options a variable knows without asking the server', () => {
  it('gives custom variables their own list', () => {
    expect(
      staticVariableOptions(variable({ type: 'custom', options: ['a', 'b'] })),
    ).toEqual(['a', 'b']);
  });

  it('gives interval variables a default ladder', () => {
    const options = staticVariableOptions(variable({ type: 'interval' }));

    expect(options).toContain('5m');
    expect(options).toContain('1h');
  });

  it('lets an interval variable override the ladder', () => {
    expect(
      staticVariableOptions(variable({ type: 'interval', options: ['30s'] })),
    ).toEqual(['30s']);
  });

  it('leaves query variables to the server', () => {
    expect(staticVariableOptions(variable({ type: 'query' }))).toBeNull();
  });
});

describe('panels wait for unresolved variables', () => {
  it('names a variable with no value', () => {
    expect(unresolvedVariables([variable()], {})).toEqual(['service']);
  });

  it('counts an empty multi selection as unresolved', () => {
    expect(
      unresolvedVariables([variable({ multi: true })], { service: [] }),
    ).toEqual(['service']);
  });

  it('is empty once every variable has a value', () => {
    expect(unresolvedVariables([variable()], { service: 'api' })).toEqual([]);
  });
});

describe('a panel only gets the variables it references', () => {
  const values = { service: 'api', env: 'prod', region: 'eu' };

  it('returns undefined for an events panel', () => {
    // Not `{}`: an empty object is a different react-query key from an absent
    // one, so every events panel would refetch the moment anyone added a
    // variable to the dashboard.
    expect(variablesForQueries(undefined, values)).toBeUndefined();
    expect(variablesForQueries([], values)).toBeUndefined();
  });

  it('returns undefined for a metric panel that references nothing', () => {
    expect(
      variablesForQueries([{ expr: 'sum(rate(http_requests_total[5m]))' }], values),
    ).toBeUndefined();
  });

  it('picks up both $name and ${name}', () => {
    expect(
      variablesForQueries(
        [{ expr: 'up{service_name="$service", env="${env}"}' }],
        values,
      ),
    ).toEqual({ env: 'prod', service: 'api' });
  });

  it('unions the variables across every query in the panel', () => {
    expect(
      variablesForQueries(
        [{ expr: 'up{service_name="$service"}' }, { expr: 'up{region="$region"}' }],
        values,
      ),
    ).toEqual({ region: 'eu', service: 'api' });
  });

  it('ignores the $__ built-ins, which the engine resolves itself', () => {
    expect(
      variablesForQueries([{ expr: 'rate(x[$__rate_interval])' }], values),
    ).toBeUndefined();
  });

  it('leaves out a referenced variable that has no value', () => {
    expect(
      variablesForQueries([{ expr: 'up{cluster="$cluster"}' }], values),
    ).toBeUndefined();
  });

  it('gives two panels referencing different variables different maps', () => {
    // This is the acceptance criterion: changing $service must refetch the
    // panels that use it and no others.
    const a = variablesForQueries([{ expr: 'up{s="$service"}' }], values);
    const b = variablesForQueries([{ expr: 'up{e="$env"}' }], values);

    expect(a).not.toEqual(b);
  });
});

describe('panel titles show the current selection', () => {
  it('substitutes both forms', () => {
    expect(substituteTitle('$service in ${env}', { service: 'api', env: 'prod' })).toBe(
      'api in prod',
    );
  });

  it('joins a multi selection with commas', () => {
    expect(substituteTitle('$service latency', { service: ['api', 'web'] })).toBe(
      'api, web latency',
    );
  });

  it('leaves an unknown variable as written', () => {
    // Same rule as the expression substituter: a typo should look like a typo
    // rather than silently disappear from the title.
    expect(substituteTitle('$nope latency', { service: 'api' })).toBe(
      '$nope latency',
    );
  });

  it('leaves the $__ built-ins alone', () => {
    expect(substituteTitle('over $__range', { service: 'api' })).toBe(
      'over $__range',
    );
  });

  it('never mutates a title with no variables in it', () => {
    expect(substituteTitle('Request rate', { service: 'api' })).toBe(
      'Request rate',
    );
  });
});

describe('display formatting', () => {
  it('reads the All sentinel as All', () => {
    expect(formatVariableValue('__all__')).toBe('All');
    expect(formatVariableValue(['__all__'])).toBe('All');
  });

  it('joins a multi selection', () => {
    expect(formatVariableValue(['api', 'web'])).toBe('api, web');
  });

  it('renders nothing for no value', () => {
    expect(formatVariableValue(undefined)).toBe('');
    expect(formatVariableValue([])).toBe('');
  });
});

describe('the editor validates a query variable before saving it', () => {
  // Deliberately permissive: the server's parseVariableQuery is the authority,
  // and blocking a query it would answer is worse than letting a bad one
  // through, since a bad one comes back with a precise message.
  it('accepts every form the server accepts', () => {
    expect(isValidVariableQuery('label_values(up, service_name)')).toBe(true);
    expect(isValidVariableQuery('label_values(service_name)')).toBe(true);
    expect(isValidVariableQuery('label_names()')).toBe(true);
    expect(isValidVariableQuery('label_values(job:rate5m, service_name)')).toBe(
      true,
    );
  });

  it('accepts a selector with equality matchers', () => {
    // This is the regression dev1 caught: an earlier version rejected anything
    // containing `{`, so the editor refused to save a query the server had
    // just learned to answer.
    expect(isValidVariableQuery('label_values(up{job="api"}, pod)')).toBe(true);
    expect(isValidVariableQuery('label_values({job="api"}, pod)')).toBe(true);
    expect(isValidVariableQuery('label_values(up{job!="api"}, pod)')).toBe(true);
  });

  it('accepts a value containing a comma or an escaped quote', () => {
    // The server scans for the separating comma at brace depth 0 and unescapes
    // quoted values, so neither of these is the client's business to reject.
    expect(isValidVariableQuery('label_values(up{path="/a,b"}, pod)')).toBe(
      true,
    );
    expect(
      isValidVariableQuery('label_values(up{msg="say \\"hi\\""}, pod)'),
    ).toBe(true);
  });

  it('rejects a regex matcher, with the reason the server gives', () => {
    expect(isValidVariableQuery('label_values(up{job=~"api.*"}, pod)')).toBe(
      false,
    );
    expect(variableQueryError('label_values(up{job=~"api.*"}, pod)')).toBe(
      VARIABLE_QUERY_REGEX_HINT,
    );
    expect(variableQueryError('label_values(up{job!~"api.*"}, pod)')).toBe(
      VARIABLE_QUERY_REGEX_HINT,
    );
  });

  it('rejects a query that is not one of the two functions', () => {
    expect(isValidVariableQuery('up')).toBe(false);
    expect(isValidVariableQuery('query_result(up)')).toBe(false);
    expect(isValidVariableQuery('label_names(up)')).toBe(false);
  });

  it('says a blank query is blank rather than malformed', () => {
    expect(variableQueryError('')).toBe('A query variable needs a query');
  });
});

/**
 * The acceptance criterion for dashboard variables, asserted on the object
 * that becomes the react-query key.
 *
 * `$service` drives four panels on a six-panel dashboard: changing it must
 * produce a different chart input for exactly those four. TanStack Query
 * refetches on a changed key and serves the cache on an unchanged one, so
 * "the input object is identical" IS "the panel does not refetch".
 */
describe('changing a variable refetches only the panels that use it', () => {
  const dashboard = [
    { id: '1', name: '$service requests', metricQueries: [{ expr: 'rate(http_requests_total{service_name="$service"}[5m])' }] },
    { id: '2', name: '$service errors', metricQueries: [{ expr: 'rate(errors_total{service_name="$service"}[5m])' }] },
    { id: '3', name: '$service p95', metricQueries: [{ expr: 'histogram_quantile(0.95, sum by (le) (rate(d_bucket{service_name="$service"}[5m])))' }] },
    { id: '4', name: '$service saturation', metricQueries: [{ expr: 'max(queue_depth{service_name="$service"})' }] },
    { id: '5', name: 'Cluster CPU', metricQueries: [{ expr: 'avg(cpu_usage{env="$env"})' }] },
    { id: '6', name: 'Signups', metricQueries: undefined },
  ];

  const render = (values: Record<string, string | string[]>) =>
    dashboard.map((report) => applyVariablesToReport(report, values));

  it('changes the input of the four panels that reference $service, and no others', () => {
    const before = render({ service: 'api', env: 'prod' });
    const after = render({ service: 'web', env: 'prod' });

    const changed = before
      .filter((report, index) => !isSameInput(report, after[index]!))
      .map((report) => report.id);

    expect(changed).toEqual(['1', '2', '3', '4']);
  });

  it('changes only the unrelated panel when the other variable moves', () => {
    const before = render({ service: 'api', env: 'prod' });
    const after = render({ service: 'api', env: 'staging' });

    const changed = before
      .filter((report, index) => !isSameInput(report, after[index]!))
      .map((report) => report.id);

    expect(changed).toEqual(['5']);
  });

  it('leaves an events panel with no variables key at all', () => {
    // Not `variables: {}` — the server's cache key is JSON.stringify(input),
    // so an empty object would be a different entry from the one every events
    // panel has been using since before variables existed.
    const [, , , , , events] = render({ service: 'api', env: 'prod' });

    expect(events && 'variables' in events).toBe(false);
  });

  it('also refetches a panel whose TITLE alone references the variable', () => {
    // Documented, accepted: `name` is part of the chart input, so a panel
    // titled "$service ..." that queries something else still gets a new key.
    // Asserted so the behaviour is a decision rather than a surprise.
    const titleOnly = {
      id: '7',
      name: '$service overview',
      metricQueries: [{ expr: 'up' }],
    };

    const before = applyVariablesToReport(titleOnly, { service: 'api' });
    const after = applyVariablesToReport(titleOnly, { service: 'web' });

    expect(isSameInput(before, after)).toBe(false);
    expect(before.variables).toBeUndefined();
  });

  it('substitutes the title without touching the query input', () => {
    const [first] = render({ service: 'api', env: 'prod' });

    expect(first?.name).toBe('api requests');
    expect(first?.variables).toEqual({ service: 'api' });
  });
});

/** Compares two panels the way TanStack Query compares keys. */
function isSameInput(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
