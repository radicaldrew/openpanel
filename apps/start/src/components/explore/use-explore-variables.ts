import {
  VARIABLE_PARAM_PREFIX,
  parseVariableValue,
} from '@/components/dashboard/variables/variable-values';
import type { IVariableValues } from '@openpanel/validation';
import { useSearch } from '@tanstack/react-router';
import { useMemo } from 'react';

/**
 * The dashboard variable values a link into Explore carried with it.
 *
 * "Open in Explore" from a dashboard hands the current selection over as
 * `var_<name>` search params, so the query the user was looking at runs here
 * against the same `$service` it ran against there. Without this, following
 * that link silently changes the query — `substituteVariables` leaves an
 * unresolved `$service` in place and the rewriter rejects it, which reads as
 * "the link is broken".
 *
 * Values are forwarded exactly as written. Explore has no variable definitions,
 * so it cannot know whether a comma-joined value is one value or several — and
 * guessing wrong in the splitting direction turns one label value into an
 * alternation that matches things the dashboard was not showing. Forwarded
 * whole, a value that SHOULD have been split renders as a literal that matches
 * nothing, which is wrong but visibly wrong: the compiled query is on screen
 * under the Query disclosure.
 *
 * Read through the router rather than through nuqs because the names are not
 * known ahead of time — there is no fixed key to declare.
 */
export function useExploreVariables(): IVariableValues | undefined {
  const search = useSearch({ strict: false }) as
    | Record<string, unknown>
    | undefined;

  return useMemo(() => {
    if (!search) {
      return undefined;
    }

    const values: IVariableValues = {};

    for (const [key, raw] of Object.entries(search)) {
      if (!key.startsWith(VARIABLE_PARAM_PREFIX) || typeof raw !== 'string') {
        continue;
      }

      const parsed = parseVariableValue(raw, false);

      if (parsed !== null) {
        values[key.slice(VARIABLE_PARAM_PREFIX.length)] = parsed;
      }
    }

    return Object.keys(values).length > 0 ? values : undefined;
  }, [search]);
}
