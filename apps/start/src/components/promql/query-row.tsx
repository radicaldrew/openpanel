import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltiper } from '@/components/ui/tooltip';
import { cn } from '@/utils/cn';
import { compileBuilder } from '@openpanel/common';
import type {
  IPanelQuery,
  IPromqlBuilderState,
  IPromqlUnit,
} from '@openpanel/validation';
import { CopyIcon, EyeIcon, EyeOffIcon, Trash2Icon } from 'lucide-react';
import { useMemo } from 'react';

import { parseBuilderState } from './builder-parse';
import { PromqlBuilder } from './promql-builder';
import { PromqlCodeEditor } from './promql-code-editor';

/**
 * One query in a metrics panel: the editor for it, and the display options that
 * belong to it rather than to the panel.
 *
 * Builder and Code are two views of ONE value, not two values kept in sync.
 * `expr` is what runs; `builder` is the structured state, present only while
 * the Builder tab is the active one and always compiled straight back into
 * `expr`. Switching to Builder re-derives that state from the text; switching
 * away drops it. So there is never a moment where the two disagree, and a query
 * typed in code mode is never quietly replaced by a lossy structured version of
 * itself.
 */

const EMPTY_BUILDER: IPromqlBuilderState = {
  metric: '',
  labelMatchers: [],
  operations: [],
};

const UNITS: { value: IPromqlUnit; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'short', label: 'Short (k, M, B)' },
  { value: 'ops', label: 'Ops/sec' },
  { value: 'seconds', label: 'Seconds' },
  { value: 'ms', label: 'Milliseconds' },
  { value: 'bytes', label: 'Bytes' },
  { value: 'percent', label: 'Percent (0–100)' },
  { value: 'percentunit', label: 'Percent (0–1)' },
];

const Y_AXES = [
  { value: 'left', label: 'Left axis' },
  { value: 'right', label: 'Right axis' },
];

/**
 * Compile, or return nothing.
 *
 * An incomplete builder state — a filter whose label has not been picked yet —
 * throws, and it throws on nearly every keystroke while a query is being built.
 * Blanking `expr` is the honest answer: the query genuinely cannot run, the
 * panel says so, and the builder's own preview carries the message explaining
 * which field is missing. Keeping the last expression that DID compile would
 * leave the chart drawing something the controls no longer describe.
 */
function safeCompile(state: IPromqlBuilderState): string {
  try {
    return compileBuilder(state);
  } catch {
    return '';
  }
}

interface QueryRowProps {
  projectId: string;
  value: IPanelQuery;
  onChange: (next: IPanelQuery) => void;
  onRemove?: () => void;
  onDuplicate?: () => void;
  /** Cmd/Ctrl+Enter in the code editor. */
  onRun?: () => void;
  /** False when the deployment has no telemetry backend to ask. */
  enabled?: boolean;
  /**
   * Instant queries return one value rather than a series, which only means
   * anything on the stat card. Hidden elsewhere rather than disabled: an option
   * that cannot change the chart is noise beside four that can.
   */
  showInstant?: boolean;
  className?: string;
}

export function QueryRow({
  projectId,
  value,
  onChange,
  onRemove,
  onDuplicate,
  onRun,
  enabled = true,
  showInstant = false,
  className,
}: QueryRowProps) {
  // Recomputed from the text, because the text is the source of truth. `null`
  // means the expression says something the chip row cannot say.
  const parsed = useMemo(() => parseBuilderState(value.expr), [value.expr]);

  // An empty query has nothing to parse and is exactly where the builder is
  // most useful, so it is not "too complex" — it is where you start.
  const builderAvailable = value.expr.trim() === '' || parsed !== null;

  const setMode = (mode: 'builder' | 'code') => {
    if (mode === value.mode) {
      return;
    }

    if (mode === 'code') {
      // The structured state is derivable from the text, so it is dropped
      // rather than left behind to go stale.
      onChange({ ...value, mode, builder: undefined });
      return;
    }

    onChange({
      ...value,
      mode,
      builder: parsed ?? value.builder ?? EMPTY_BUILDER,
    });
  };

  return (
    <div className={cn('rounded-lg border bg-card', className)}>
      <div className="flex flex-wrap items-center gap-2 border-b p-2">
        <Badge className="font-mono" variant="outline">
          {value.refId}
        </Badge>

        <Tabs
          onValueChange={(next) => setMode(next as 'builder' | 'code')}
          value={value.mode}
        >
          <TabsList className="w-auto border-b-0">
            <Tooltiper
              asChild
              content="This query is too complex for the builder — edit it in code."
              disabled={builderAvailable}
            >
              {/* The span carries the tooltip because a disabled trigger emits
                  no pointer events, and "why is this tab disabled" is the one
                  question the tooltip exists to answer. */}
              <span>
                <TabsTrigger disabled={!builderAvailable} value="builder">
                  Builder
                </TabsTrigger>
              </span>
            </Tooltiper>
            <TabsTrigger value="code">Code</TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="ml-auto flex items-center gap-1">
          <Tooltiper
            asChild
            content={value.hidden ? 'Show this query' : 'Hide this query'}
          >
            <Button
              aria-label={value.hidden ? 'Show query' : 'Hide query'}
              aria-pressed={value.hidden}
              icon={value.hidden ? EyeOffIcon : EyeIcon}
              onClick={() => onChange({ ...value, hidden: !value.hidden })}
              size="icon"
              variant="ghost"
            />
          </Tooltiper>
          {onDuplicate && (
            <Tooltiper asChild content="Duplicate query">
              <Button
                aria-label="Duplicate query"
                icon={CopyIcon}
                onClick={onDuplicate}
                size="icon"
                variant="ghost"
              />
            </Tooltiper>
          )}
          {onRemove && (
            <Tooltiper asChild content="Remove query">
              <Button
                aria-label="Remove query"
                icon={Trash2Icon}
                onClick={onRemove}
                size="icon"
                variant="ghost"
              />
            </Tooltiper>
          )}
        </div>
      </div>

      <div className={cn('p-3', value.hidden && 'opacity-50')}>
        {value.mode === 'builder' ? (
          <PromqlBuilder
            enabled={enabled}
            onChange={(next) =>
              onChange({ ...value, builder: next, expr: safeCompile(next) })
            }
            projectId={projectId}
            value={value.builder ?? parsed ?? EMPTY_BUILDER}
          />
        ) : (
          <PromqlCodeEditor
            onChange={(next) => onChange({ ...value, expr: next })}
            onRun={onRun}
            projectId={projectId}
            value={value.expr}
          />
        )}
      </div>

      <div className="flex flex-wrap items-end gap-3 border-t p-3">
        <div className="flex min-w-48 flex-1 flex-col">
          <Label className="mb-1.5">Legend</Label>
          <Input
            onChange={(event) =>
              onChange({
                ...value,
                // Empty means "work it out from the labels", which is what
                // `formatLegend` does with an absent format — so the field is
                // cleared rather than saved as an empty string.
                legendFormat: event.target.value || undefined,
              })
            }
            placeholder="{{method}} {{status}}"
            value={value.legendFormat ?? ''}
          />
        </div>

        <div className="flex w-40 flex-col">
          <Label className="mb-1.5">Unit</Label>
          <Combobox
            className="w-full"
            items={UNITS}
            onChange={(next) => onChange({ ...value, unit: next })}
            placeholder="None"
            value={value.unit}
          />
        </div>

        <div className="flex w-32 flex-col">
          <Label className="mb-1.5">Y axis</Label>
          <Combobox
            className="w-full"
            items={Y_AXES}
            onChange={(next) =>
              onChange({ ...value, yAxis: next as IPanelQuery['yAxis'] })
            }
            placeholder="Left axis"
            value={value.yAxis}
          />
        </div>

        <div className="flex w-28 flex-col">
          {/* The tooltip sits on the label, not the field: `Tooltiper` renders
              its trigger as a button unless told otherwise, and an input inside
              a button is neither valid nor focusable the way it looks. */}
          <Tooltiper
            asChild
            content="A floor on the resolution this query is fetched at. Leave it empty to follow the panel's interval."
          >
            <Label className="mb-1.5 w-fit cursor-help underline decoration-dotted underline-offset-4">
              Min step
            </Label>
          </Tooltiper>
          <Input
            onChange={(event) =>
              onChange({ ...value, minStep: event.target.value || undefined })
            }
            placeholder="15s"
            value={value.minStep ?? ''}
          />
        </div>

        {showInstant && (
          <label className="mb-2 flex items-center gap-2 text-sm">
            <Switch
              checked={value.instant}
              onCheckedChange={(next) =>
                onChange({ ...value, instant: next })
              }
            />
            Instant
          </label>
        )}
      </div>
    </div>
  );
}
