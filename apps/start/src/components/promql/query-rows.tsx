import { Button } from '@/components/ui/button';
import { DropdownMenuComposed } from '@/components/ui/dropdown-menu';
import { cn } from '@/utils/cn';
import {
  QUERY_PATTERNS,
  applyQueryPattern,
  compileBuilder,
  findQueryPattern,
} from '@openpanel/common';
import type { IPanelQuery } from '@openpanel/validation';
import { PlusIcon, SparklesIcon } from 'lucide-react';

import {
  MAX_PANEL_QUERIES,
  createBuilderQuery,
  createPanelQuery,
  nextRefId,
} from './panel-query';
import { QueryRow } from './query-row';

/**
 * The queries a metrics panel runs, as an editable list.
 *
 * Shared verbatim between the report editor and the metrics explorer, which is
 * the point: "Add to dashboard" from the explorer has to produce the same panel
 * the editor would, and it does that by there being one component rather than
 * two that agree today.
 */

interface QueryRowsProps {
  projectId: string;
  value: IPanelQuery[];
  onAdd: (query: IPanelQuery) => void;
  onUpdate: (refId: string, query: IPanelQuery) => void;
  onRemove: (refId: string) => void;
  onDuplicate: (refId: string) => void;
  /** Cmd/Ctrl+Enter inside a code editor. */
  onRun?: () => void;
  /** False when the deployment has no telemetry backend to ask. */
  enabled?: boolean;
  /** Instant queries only mean something on the stat card. */
  showInstant?: boolean;
  className?: string;
}

export function QueryRows({
  projectId,
  value,
  onAdd,
  onUpdate,
  onRemove,
  onDuplicate,
  onRun,
  enabled = true,
  showInstant = false,
  className,
}: QueryRowsProps) {
  const full = value.length >= MAX_PANEL_QUERIES;

  const addPattern = (patternId: string) => {
    const pattern = findQueryPattern(patternId);

    if (!pattern) {
      return;
    }

    // Patterns carry no metric on purpose — they describe the pipeline, not the
    // series — so the new row lands in the builder with its operations already
    // in the right order and the metric combobox as the one thing left to fill
    // in. `compileBuilder` cannot produce an expression without a metric, so
    // `expr` stays empty until it is picked.
    const builder = applyQueryPattern(pattern, '');
    let expr = '';

    try {
      expr = compileBuilder(builder);
    } catch {
      expr = '';
    }

    onAdd(createBuilderQuery(nextRefId(value), builder, expr));
  };

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {value.map((query) => (
        <QueryRow
          enabled={enabled}
          key={query.refId}
          onChange={(next) => onUpdate(query.refId, next)}
          // A panel with one query has nothing to remove down to; the row is
          // cleared rather than deleted.
          onDuplicate={full ? undefined : () => onDuplicate(query.refId)}
          onRemove={value.length > 1 ? () => onRemove(query.refId) : undefined}
          onRun={onRun}
          projectId={projectId}
          showInstant={showInstant}
          value={query}
        />
      ))}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={full}
          icon={PlusIcon}
          onClick={() => onAdd(createPanelQuery(nextRefId(value)))}
          size="sm"
          variant="outline"
        >
          Add query
        </Button>

        <DropdownMenuComposed
          items={QUERY_PATTERNS.map((pattern) => ({
            value: pattern.id,
            label: pattern.label,
            description: pattern.description,
          }))}
          label="Query patterns"
          onChange={addPattern}
        >
          <Button disabled={full} icon={SparklesIcon} size="sm" variant="ghost">
            Query patterns
          </Button>
        </DropdownMenuComposed>

        {full && (
          <span className="text-muted-foreground text-xs">
            A panel runs at most {MAX_PANEL_QUERIES} queries.
          </span>
        )}
      </div>
    </div>
  );
}
