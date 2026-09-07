import { Combobox } from '@/components/ui/combobox';
import { ComboboxAdvanced } from '@/components/ui/combobox-advanced';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { AlertCircleIcon } from 'lucide-react';

import { VARIABLE_ALL_SENTINEL } from '@openpanel/common';
import type { IDashboardVariable } from '@openpanel/validation';

import type { IVariableOptions } from './use-variable-options';

/**
 * One variable's control.
 *
 * A combobox rather than a plain select because a `label_values` variable can
 * come back with hundreds of services and the list has to be searchable; the
 * multi variant is the same component the chart filters already use.
 */
export function VariableControl({
  variable,
  value,
  options,
  onChange,
}: {
  variable: IDashboardVariable;
  value: string | string[] | undefined;
  options: IVariableOptions;
  onChange: (value: string | string[] | null) => void;
}) {
  const label = variable.label?.trim() || variable.name;

  const items = [
    // "All" is an option, not a checkbox beside the control: it occupies the
    // same slot as a real value, which is what it is — the sentinel the
    // substituter turns into `.+`.
    ...(variable.includeAll
      ? [{ value: VARIABLE_ALL_SENTINEL, label: 'All' }]
      : []),
    ...(options.options ?? []).map((option) => ({
      value: option,
      label: option,
    })),
  ];

  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-muted-foreground whitespace-nowrap">
        {label}
      </span>

      {options.error ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex items-center gap-1 text-sm text-destructive">
              <AlertCircleIcon className="size-4" />
              Failed to load
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm">{options.error}</TooltipContent>
        </Tooltip>
      ) : variable.multi ? (
        <ComboboxAdvanced
          items={items}
          value={Array.isArray(value) ? value : value ? [value] : []}
          onChange={(next) => onChange(next as string[])}
          placeholder={options.isLoading ? 'Loading…' : `Select ${label}`}
          className="min-w-[140px]"
          size="sm"
        />
      ) : (
        <Combobox
          items={items}
          value={typeof value === 'string' ? value : null}
          onChange={(next) => onChange(next)}
          placeholder={options.isLoading ? 'Loading…' : `Select ${label}`}
          searchable
          size="sm"
          className="min-w-[140px]"
        />
      )}
    </div>
  );
}
