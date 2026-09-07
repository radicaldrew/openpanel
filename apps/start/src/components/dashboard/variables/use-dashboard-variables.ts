import { parseAsString, useQueryStates } from 'nuqs';
import { useCallback, useMemo } from 'react';

import type {
  IChartRange,
  IDashboardVariable,
  IVariableValues,
} from '@openpanel/validation';

import {
  type IVariableOptionsMap,
  useVariableOptionsMap,
} from './use-variable-options';
import {
  defaultVariableValue,
  parseVariableValue,
  serializeVariableValue,
  unresolvedVariables,
  variableParamName,
} from './variable-values';

export type IDashboardVariablesState = {
  /** Every variable's current value, keyed by name. */
  values: IVariableValues;
  options: IVariableOptionsMap;
  setValue: (name: string, value: string | string[] | null) => void;
  /** Variables with no value yet, for whatever reason. */
  unresolved: string[];
  /**
   * Whether the panels should wait.
   *
   * Only true while a variable's options are still in flight. A variable whose
   * options FAILED does not hold the dashboard hostage: the bar shows the
   * error on that control and the panels render, each showing whatever the
   * server says about the unresolved `$name`. Blocking on it instead would
   * leave a permanent skeleton grid with the reason hidden in a tooltip.
   */
  isResolving: boolean;
  /** The `var_<name>` params, for handing the selection to Explore. */
  searchParams: Record<string, string>;
};

// `replace`, not `push`. Five tweaks to a variable should not mean five back
// presses to leave the dashboard; the property that matters — the current
// selection being in the URL, so a shared link reopens on it — holds either
// way. Grafana replaces here for the same reason.
const nuqsOptions = { history: 'replace' } as const;

/**
 * The dashboard's variable values, held in the URL.
 *
 * The URL rather than component state because a shared dashboard link has to
 * reopen on the same selection — that is the whole reason people send each
 * other dashboard links — and because it survives the panels remounting when
 * the grid relayouts.
 *
 * Values are read through one `useQueryStates` over a parser map built from
 * the variable list, following `use-table.tsx`: a `useQueryState` per variable
 * would change the hook count whenever someone adds or removes one.
 */
export function useDashboardVariables(
  variables: IDashboardVariable[],
  {
    projectId,
    range,
    startDate,
    endDate,
  }: {
    projectId: string;
    range: IChartRange;
    startDate?: string | null;
    endDate?: string | null;
  },
): IDashboardVariablesState {
  const options = useVariableOptionsMap(variables, {
    projectId,
    range,
    startDate,
    endDate,
  });

  const parsers = useMemo(
    () =>
      Object.fromEntries(
        variables.map((variable) => [
          variableParamName(variable.name),
          parseAsString,
        ]),
      ),
    [variables],
  );

  const [params, setParams] = useQueryStates(parsers, nuqsOptions);

  const values = useMemo(() => {
    const out: IVariableValues = {};

    for (const variable of variables) {
      const fromUrl = parseVariableValue(
        params[variableParamName(variable.name)],
        variable.multi,
      );

      const value =
        fromUrl ??
        defaultVariableValue(variable, options[variable.name]?.options ?? null);

      if (value !== null) {
        out[variable.name] = value;
      }
    }

    return out;
  }, [variables, params, options]);

  const setValue = useCallback(
    (name: string, value: string | string[] | null) => {
      setParams({
        // `null` clears the param rather than writing an empty one, so a
        // dashboard back on its defaults has a clean URL to share.
        [variableParamName(name)]:
          value === null || (Array.isArray(value) && value.length === 0)
            ? null
            : serializeVariableValue(value),
      });
    },
    [setParams],
  );

  const unresolved = useMemo(
    () => unresolvedVariables(variables, values),
    [variables, values],
  );

  const isResolving = useMemo(
    () => unresolved.some((name) => options[name]?.isLoading === true),
    [unresolved, options],
  );

  // The current selection as URL params, so "open in Explore" carries it. Built
  // from the resolved values, not from `params`, so a variable sitting on its
  // saved default travels too — otherwise Explore would open on a different
  // selection from the dashboard the link came from.
  const searchParams = useMemo(() => {
    const out: Record<string, string> = {};

    for (const variable of variables) {
      const value = values[variable.name];

      if (value !== undefined) {
        out[variableParamName(variable.name)] = serializeVariableValue(value);
      }
    }

    return out;
  }, [variables, values]);

  return { values, options, setValue, unresolved, isResolving, searchParams };
}
