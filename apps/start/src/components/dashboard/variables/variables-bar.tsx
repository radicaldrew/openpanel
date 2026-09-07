import { Button } from '@/components/ui/button';
import { pushModal } from '@/modals';
import { SettingsIcon } from 'lucide-react';

import type { IDashboardVariable } from '@openpanel/validation';

import type { IDashboardVariablesState } from './use-dashboard-variables';
import { VariableControl } from './variable-control';

/**
 * The row of variable pickers above the panels.
 *
 * Renders nothing at all when a dashboard has no variables — the edit entry
 * point lives in the dashboard's overflow menu, so an untouched dashboard
 * looks exactly as it did before this existed.
 */
export function VariablesBar({
  dashboardId,
  variables,
  state,
}: {
  dashboardId: string;
  variables: IDashboardVariable[];
  state: IDashboardVariablesState;
}) {
  if (variables.length === 0) {
    return null;
  }

  return (
    <div className="mb-4 flex flex-wrap items-center gap-4 rounded-lg border border-border bg-card p-3">
      {variables.map((variable) => (
        <VariableControl
          key={variable.name}
          variable={variable}
          value={state.values[variable.name]}
          options={
            state.options[variable.name] ?? {
              options: [],
              isLoading: false,
              error: null,
            }
          }
          onChange={(value) => state.setValue(variable.name, value)}
        />
      ))}

      <Button
        variant="ghost"
        size="sm"
        className="ml-auto"
        onClick={() =>
          pushModal('DashboardVariables', { dashboardId, variables })
        }
      >
        <SettingsIcon className="mr-2 size-4" />
        Edit variables
      </Button>
    </div>
  );
}
