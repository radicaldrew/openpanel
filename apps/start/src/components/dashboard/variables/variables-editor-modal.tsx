import { ButtonContainer } from '@/components/button-container';
import { WithLabel } from '@/components/forms/input-with-label';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Combobox } from '@/components/ui/combobox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { handleErrorToastOptions, useTRPC } from '@/integrations/trpc/react';
import { popModal } from '@/modals';
import { ModalContent, ModalHeader } from '@/modals/Modal/Container';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ChevronDownIcon,
  ChevronUpIcon,
  PlusIcon,
  TrashIcon,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { IDashboardVariable } from '@openpanel/validation';

import { variableQueryError } from './variable-values';

/** The zod regex from `zDashboardVariable`, checked here so the field can say why. */
const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const emptyVariable = (): IDashboardVariable => ({
  name: '',
  type: 'query',
  query: '',
  multi: false,
  includeAll: false,
});

/**
 * Why the name is validated here as well as in zod: the name is what panels
 * reference as `$name`, so a rejected save after someone has written four
 * variables is a bad trade against telling them at the field.
 */
function validate(variables: IDashboardVariable[]): Record<number, string> {
  const errors: Record<number, string> = {};

  variables.forEach((variable, index) => {
    const name = variable.name.trim();

    if (name === '') {
      errors[index] = 'A variable needs a name';
      return;
    }

    if (!NAME_RE.test(name)) {
      errors[index] =
        'Use letters, digits and underscores, starting with a letter or underscore';
      return;
    }

    if (variables.some((other, i) => i !== index && other.name.trim() === name)) {
      // Two variables with the same name means one of them silently never
      // substitutes. The server rejects this too; saying it here is kinder.
      errors[index] = `Another variable is already called $${name}`;
      return;
    }

    if (variable.type === 'query') {
      const queryError = variableQueryError(variable.query ?? '');

      if (queryError) {
        errors[index] = queryError;
      }
    }
  });

  return errors;
}

export default function DashboardVariables({
  dashboardId,
  variables: initialVariables,
}: {
  dashboardId: string;
  variables: IDashboardVariable[];
}) {
  const [variables, setVariables] = useState<IDashboardVariable[]>(
    initialVariables.length > 0 ? initialVariables : [emptyVariable()],
  );
  const [errors, setErrors] = useState<Record<number, string>>({});

  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const mutation = useMutation(
    trpc.dashboard.updateVariables.mutationOptions({
      onError: handleErrorToastOptions({}),
      onSuccess() {
        toast('Variables saved');
        queryClient.invalidateQueries(trpc.dashboard.byId.pathFilter());
        popModal();
      },
    }),
  );

  const update = (index: number, patch: Partial<IDashboardVariable>) => {
    setVariables((current) =>
      current.map((variable, i) =>
        i === index ? { ...variable, ...patch } : variable,
      ),
    );
  };

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;

    if (target < 0 || target >= variables.length) {
      return;
    }

    setVariables((current) => {
      const next = [...current];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved!);
      return next;
    });
  };

  const save = () => {
    // An empty trailing row is how the form starts; dropping it silently is
    // friendlier than refusing to save because of a row nobody filled in.
    const filled = variables.filter(
      (variable) => variable.name.trim() !== '' || variable.query?.trim(),
    );

    const nextErrors = validate(filled);
    setErrors(nextErrors);

    if (Object.keys(nextErrors).length > 0) {
      return;
    }

    mutation.mutate({
      id: dashboardId,
      variables: filled.map((variable) => ({
        ...variable,
        name: variable.name.trim(),
        // A `custom` variable's options are the source of its values; a
        // `query` variable's come from the server, so keeping a stale list on
        // it would be a second answer to the same question.
        options: variable.type === 'query' ? undefined : variable.options,
        query: variable.type === 'query' ? variable.query : undefined,
      })),
    });
  };

  return (
    <ModalContent className="max-w-2xl">
      <ModalHeader
        title="Dashboard variables"
        text="Reference a variable in a panel query or title as $name."
      />

      <div className="flex flex-col gap-4 max-h-[60vh] overflow-y-auto">
        {variables.map((variable, index) => (
          <div
            // Index as key: rows are reordered and renamed in place, and a
            // name-based key would remount the field being typed into.
            key={index}
            className="rounded-lg border border-border p-3 flex flex-col gap-3"
          >
            <div className="flex items-end gap-2">
              <WithLabel label="Name" className="flex-1" error={errors[index]}>
                <Input
                  value={variable.name}
                  placeholder="service"
                  onChange={(e) => update(index, { name: e.target.value })}
                />
              </WithLabel>

              <WithLabel label="Label" className="flex-1">
                <Input
                  value={variable.label ?? ''}
                  placeholder="Service"
                  onChange={(e) => update(index, { label: e.target.value })}
                />
              </WithLabel>

              <WithLabel label="Type" className="w-36">
                <Combobox
                  placeholder="Type"
                  items={[
                    { value: 'query', label: 'Query' },
                    { value: 'custom', label: 'Custom' },
                    { value: 'interval', label: 'Interval' },
                  ]}
                  value={variable.type}
                  onChange={(type) =>
                    update(index, {
                      type: type as IDashboardVariable['type'],
                    })
                  }
                />
              </WithLabel>

              <Button
                variant="ghost"
                size="icon"
                aria-label="Move variable up"
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <ChevronUpIcon className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Move variable down"
                disabled={index === variables.length - 1}
                onClick={() => move(index, 1)}
              >
                <ChevronDownIcon className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Delete variable"
                onClick={() =>
                  setVariables((current) =>
                    current.filter((_, i) => i !== index),
                  )
                }
              >
                <TrashIcon className="size-4" />
              </Button>
            </div>

            {variable.type === 'query' && (
              <WithLabel
                label="Query"
                info="label_values(up, service_name) lists a label's values on one metric, label_values(service_name) across all of them, and label_names() lists the labels themselves. Label matchers are not supported — the lookup narrows by metric name only."
              >
                <Input
                  value={variable.query ?? ''}
                  placeholder="label_values(up, service_name)"
                  onChange={(e) => update(index, { query: e.target.value })}
                />
              </WithLabel>
            )}

            {variable.type !== 'query' && (
              <WithLabel
                label="Options"
                info="One per line. An interval variable falls back to a standard ladder when this is empty."
              >
                <Textarea
                  rows={3}
                  value={(variable.options ?? []).join('\n')}
                  placeholder={variable.type === 'interval' ? '5m\n1h' : 'api\nweb'}
                  onChange={(e) =>
                    update(index, {
                      options: e.target.value
                        .split('\n')
                        .map((option) => option.trim())
                        .filter((option) => option !== ''),
                    })
                  }
                />
              </WithLabel>
            )}

            <div className="flex items-center gap-6">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={variable.multi}
                  onCheckedChange={(checked) =>
                    update(index, { multi: checked === true })
                  }
                />
                Allow multiple values
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={variable.includeAll}
                  onCheckedChange={(checked) =>
                    update(index, { includeAll: checked === true })
                  }
                />
                Include an "All" option
              </label>
            </div>
          </div>
        ))}
      </div>

      <Button
        variant="outline"
        className="mt-3 self-start"
        onClick={() => setVariables((current) => [...current, emptyVariable()])}
      >
        <PlusIcon className="mr-2 size-4" />
        Add variable
      </Button>

      <ButtonContainer>
        <Button type="button" variant="outline" onClick={() => popModal()}>
          Cancel
        </Button>
        <Button type="button" onClick={save} disabled={mutation.isPending}>
          Save
        </Button>
      </ButtonContainer>
    </ModalContent>
  );
}
