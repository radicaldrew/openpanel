import { useTRPC } from '@/integrations/trpc/react';
import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';

import type { IChartRange, IDashboardVariable } from '@openpanel/validation';

import { staticVariableOptions } from './variable-values';

export type IVariableOptions = {
  options: string[] | null;
  isLoading: boolean;
  error: string | null;
};

export type IVariableOptionsMap = Record<string, IVariableOptions>;

/**
 * The options every variable on the dashboard offers.
 *
 * `custom` and `interval` variables answer for themselves; only `query`
 * variables go to the server, through `observability.variableOptions`, which
 * understands `label_values(<selector>, <label>)` and `label_names()`.
 *
 * One `useQueries` rather than a hook per variable: the variable list changes
 * when someone edits it, and a hook per variable would change the hook count
 * between renders.
 *
 * The time range is part of the input because label values are only recorded
 * against the series that existed in that window — a service that was
 * decommissioned last week should not be offered on a "last hour" dashboard.
 *
 * The range is sent the way every chart input sends it — the preset plus
 * optional custom dates — rather than as two resolved timestamps, so the
 * server resolves it with the same timezone-aware `getChartStartEndDate` the
 * panels use. Resolving it in the browser would give the dropdown a different
 * window from the charts underneath it.
 */
export function useVariableOptionsMap(
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
): IVariableOptionsMap {
  const trpc = useTRPC();

  const queryVariables = useMemo(
    () =>
      variables.filter(
        (variable) => variable.type === 'query' && !!variable.query?.trim(),
      ),
    [variables],
  );

  const results = useQueries({
    queries: queryVariables.map((variable) =>
      trpc.observability.variableOptions.queryOptions({
        projectId,
        query: variable.query ?? '',
        range,
        startDate: startDate ?? null,
        endDate: endDate ?? null,
      }),
    ),
  });

  return useMemo(() => {
    const map: IVariableOptionsMap = {};

    for (const variable of variables) {
      const staticOptions = staticVariableOptions(variable);

      if (staticOptions !== null) {
        map[variable.name] = {
          options: staticOptions,
          isLoading: false,
          error: null,
        };
        continue;
      }

      const index = queryVariables.indexOf(variable);
      const result = index === -1 ? undefined : results[index];

      if (!result) {
        // A `query` variable with no query written yet. Not an error — it is
        // half-configured, and the bar shows it as empty rather than broken.
        map[variable.name] = { options: [], isLoading: false, error: null };
        continue;
      }

      map[variable.name] = {
        options: result.data ?? null,
        isLoading: result.isLoading,
        error: result.error ? result.error.message : null,
      };
    }

    return map;
  }, [variables, queryVariables, results]);
}
