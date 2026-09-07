import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { ComboboxAdvanced } from '@/components/ui/combobox-advanced';
import { DropdownMenuComposed } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTRPC } from '@/integrations/trpc/react';
import { cn } from '@/utils/cn';
import {
  PromqlBuilderError,
  compileBuilder,
  defaultOperationsFor,
  inferMetricKind,
} from '@openpanel/common';
import type {
  IBuilderOp,
  IPromqlBuilderState,
} from '@openpanel/validation';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangleIcon, PlusIcon, XIcon } from 'lucide-react';
import { useMemo } from 'react';

/**
 * The structured half of the PromQL editor.
 *
 * It writes an expression; it never reads one. `expr` on `IPanelQuery` is the
 * source of truth and `builder-parse.ts` is what turns text back into the state
 * this component edits — so everything here can assume the state it is handed
 * is already known to be expressible.
 *
 * The operation list is a PIPELINE, left to right, each step wrapping the last.
 * That is the one thing this UI has to teach, because `rate` → `sum by (le)` →
 * `histogram_quantile` is a p95 and the same three in any other order is
 * nonsense. Hence chips in a row rather than a form with named slots.
 */

type MatcherOp = IPromqlBuilderState['labelMatchers'][number]['op'];

const MATCHER_OPS: { value: MatcherOp; label: string }[] = [
  { value: '=', label: '=' },
  { value: '!=', label: '≠' },
  { value: '=~', label: '=~' },
  { value: '!~', label: '!~' },
];

const RANGE_FUNCTIONS = ['rate', 'increase', 'irate', 'delta'] as const;
const AGGREGATIONS = ['sum', 'avg', 'min', 'max', 'count'] as const;

/**
 * What "+ Operation" offers, and in the order it offers it.
 *
 * `raw` is a member of `zBuilderOp` and is deliberately absent: an expression
 * carrying one cannot be read back by `builder-parse`, so adding one from here
 * would disable the Builder tab the moment the user left it. Code mode is the
 * better escape hatch and it is one click away.
 */
const ADDABLE_OPERATIONS: { value: string; label: string; description: string }[] =
  [
    {
      value: 'rate',
      label: 'rate',
      description: 'Per-second average increase of a counter',
    },
    {
      value: 'increase',
      label: 'increase',
      description: 'Total increase of a counter over the window',
    },
    { value: 'irate', label: 'irate', description: 'Instant per-second rate' },
    { value: 'delta', label: 'delta', description: 'Change in a gauge' },
    { value: 'sum', label: 'sum', description: 'Add series together' },
    { value: 'avg', label: 'avg', description: 'Average across series' },
    { value: 'min', label: 'min', description: 'Lowest series' },
    { value: 'max', label: 'max', description: 'Highest series' },
    { value: 'count', label: 'count', description: 'How many series' },
    {
      value: 'histogram_quantile',
      label: 'histogram_quantile',
      description: 'Quantile from summed bucket rates',
    },
    { value: 'topk', label: 'topk', description: 'Keep the k largest series' },
    {
      value: 'bottomk',
      label: 'bottomk',
      description: 'Keep the k smallest series',
    },
    {
      value: 'binary',
      label: 'binary operation',
      description: 'Combine with another expression (+ − × ÷)',
    },
  ];

const QUANTILES = [
  { value: '0.5', label: 'p50' },
  { value: '0.9', label: 'p90' },
  { value: '0.95', label: 'p95' },
  { value: '0.99', label: 'p99' },
];

const BINARY_OPERATORS = [
  { value: '+', label: '+' },
  { value: '-', label: '−' },
  { value: '*', label: '×' },
  { value: '/', label: '÷' },
];

function newOperation(kind: string): IBuilderOp | null {
  if ((RANGE_FUNCTIONS as readonly string[]).includes(kind)) {
    // `$__rate_interval` rather than a literal: the engine resolves it against
    // the step actually used, so the window can never end up narrower than the
    // interval the chart is drawn at — the classic cause of a rate that reads
    // zero at coarse resolutions.
    return {
      op: kind as (typeof RANGE_FUNCTIONS)[number],
      range: '$__rate_interval',
    };
  }

  if ((AGGREGATIONS as readonly string[]).includes(kind)) {
    return { op: kind as (typeof AGGREGATIONS)[number] };
  }

  if (kind === 'histogram_quantile') {
    return { op: 'histogram_quantile', q: 0.95 };
  }

  if (kind === 'topk' || kind === 'bottomk') {
    return { op: kind, k: 5 };
  }

  if (kind === 'binary') {
    return { op: 'binary', operator: '/', rhs: '' };
  }

  return null;
}

/** Whether an operation turns a cumulative series into a rate of change. */
function isRateLike(op: IBuilderOp): boolean {
  return (RANGE_FUNCTIONS as readonly string[]).includes(op.op);
}

interface MatcherRowProps {
  projectId: string;
  metric: string;
  enabled: boolean;
  labels: string[];
  value: IPromqlBuilderState['labelMatchers'][number];
  onChange: (next: IPromqlBuilderState['labelMatchers'][number]) => void;
  onRemove: () => void;
}

function MatcherRow({
  projectId,
  metric,
  enabled,
  labels,
  value,
  onChange,
  onRemove,
}: MatcherRowProps) {
  const trpc = useTRPC();

  // Values are narrowed to the metric for the same reason the labels are: a
  // value that exists on some other metric selects nothing here.
  const values = useQuery(
    trpc.observability.labelValues.queryOptions(
      { projectId, label: value.label, metric: metric || undefined },
      { enabled: enabled && !!value.label },
    ),
  );

  return (
    <div className="flex items-center gap-2">
      <Combobox
        className="w-44"
        items={labels.map((label) => ({ value: label, label }))}
        onChange={(next) => onChange({ ...value, label: next })}
        placeholder="Label"
        searchable
        value={value.label || null}
      />
      <Combobox
        className="w-20"
        items={MATCHER_OPS}
        onChange={(next) => onChange({ ...value, op: next })}
        placeholder="="
        value={value.op}
      />
      {/* A regex matcher is written, not chosen — `/v1/.*` is not in any value
          list — so only the equality operators get the picker. */}
      {value.op === '=' || value.op === '!=' ? (
        <Combobox
          className="w-56"
          items={(values.data ?? []).map((v) => ({ value: v, label: v }))}
          onChange={(next) => onChange({ ...value, value: next })}
          onCreate={(next) => onChange({ ...value, value: next })}
          placeholder={values.isLoading ? 'Loading…' : 'Value'}
          searchable
          value={value.value || null}
        />
      ) : (
        <Input
          className="w-56"
          onChange={(event) =>
            onChange({ ...value, value: event.target.value })
          }
          placeholder="Regular expression"
          value={value.value}
        />
      )}
      <Button
        aria-label="Remove filter"
        icon={XIcon}
        onClick={onRemove}
        size="icon"
        variant="ghost"
      />
    </div>
  );
}

interface OperationChipProps {
  op: IBuilderOp;
  labels: string[];
  onChange: (next: IBuilderOp) => void;
  onRemove: () => void;
}

function OperationChip({ op, labels, onChange, onRemove }: OperationChipProps) {
  return (
    <div className="flex items-center gap-1.5 rounded-md border bg-def-200 px-2 py-1.5">
      <span className="font-medium font-mono text-xs">{op.op}</span>

      {(op.op === 'rate' ||
        op.op === 'increase' ||
        op.op === 'irate' ||
        op.op === 'delta') && (
        <Input
          aria-label={`${op.op} window`}
          className="h-7 w-36"
          onChange={(event) =>
            onChange({ ...op, range: event.target.value })
          }
          placeholder="5m"
          value={op.range}
        />
      )}

      {(op.op === 'sum' ||
        op.op === 'avg' ||
        op.op === 'min' ||
        op.op === 'max' ||
        op.op === 'count') && (
        <>
          <Combobox
            className="h-7 w-24"
            items={[
              { value: 'by', label: 'by' },
              { value: 'without', label: 'without' },
            ]}
            onChange={(next) =>
              onChange(
                next === 'by'
                  ? { op: op.op, by: op.by ?? op.without ?? [] }
                  : { op: op.op, without: op.without ?? op.by ?? [] },
              )
            }
            placeholder="by"
            value={op.without ? 'without' : 'by'}
          />
          <ComboboxAdvanced
            className="h-7 min-w-40"
            items={labels.map((label) => ({ value: label, label }))}
            onChange={(next) =>
              onChange(
                op.without ? { op: op.op, without: next } : { op: op.op, by: next },
              )
            }
            placeholder="all labels"
            value={op.without ?? op.by ?? []}
          />
        </>
      )}

      {op.op === 'histogram_quantile' && (
        <Combobox
          className="h-7 w-24"
          items={QUANTILES}
          onChange={(next) => onChange({ ...op, q: Number(next) })}
          placeholder="p95"
          value={String(op.q)}
        />
      )}

      {(op.op === 'topk' || op.op === 'bottomk') && (
        <Input
          aria-label={`${op.op} count`}
          className="h-7 w-20"
          min={1}
          onChange={(event) =>
            onChange({ ...op, k: Number(event.target.value) || 1 })
          }
          type="number"
          value={op.k}
        />
      )}

      {op.op === 'binary' && (
        <>
          <Combobox
            className="h-7 w-16"
            items={BINARY_OPERATORS}
            onChange={(next) =>
              onChange({ ...op, operator: next as typeof op.operator })
            }
            placeholder="/"
            value={op.operator}
          />
          <Input
            aria-label="Right-hand side"
            className="h-7 w-48"
            onChange={(event) => onChange({ ...op, rhs: event.target.value })}
            placeholder="60"
            value={op.rhs}
          />
        </>
      )}

      <Button
        aria-label={`Remove ${op.op}`}
        className="size-6"
        icon={XIcon}
        onClick={onRemove}
        size="icon"
        variant="ghost"
      />
    </div>
  );
}

interface PromqlBuilderProps {
  projectId: string;
  value: IPromqlBuilderState;
  onChange: (next: IPromqlBuilderState) => void;
  /** False when the deployment has no telemetry backend to ask. */
  enabled?: boolean;
  className?: string;
}

export function PromqlBuilder({
  projectId,
  value,
  onChange,
  enabled = true,
  className,
}: PromqlBuilderProps) {
  const trpc = useTRPC();
  const metric = value.metric || null;

  const metrics = useQuery(
    trpc.observability.metricNames.queryOptions({ projectId }, { enabled }),
  );

  const labelKeys = useQuery(
    trpc.observability.labelKeys.queryOptions(
      { projectId, metric: metric ?? undefined },
      { enabled: enabled && !!metric },
    ),
  );

  const labels = labelKeys.data ?? [];
  const kind = metric ? inferMetricKind(metric) : null;

  // The compiled expression, or the reason it will not compile. Shown either
  // way: a builder whose preview goes blank when a field is half-filled reads
  // as broken, where the message says which field.
  const preview = useMemo(() => {
    try {
      return { expr: compileBuilder(value), error: null };
    } catch (error) {
      return {
        expr: null,
        error:
          error instanceof PromqlBuilderError
            ? error.message
            : 'This is not a valid query yet',
      };
    }
  }, [value]);

  /**
   * A cumulative metric with no rate on it draws its own running total, which
   * climbs forever and says nothing about now. It is legal, and someone
   * removing the chip may well mean it, so this is a warning beside the chips
   * rather than a chip that cannot be removed.
   */
  const missingRate =
    (kind === 'counter' || kind === 'histogram') &&
    !value.operations.some(isRateLike);

  const pickMetric = (next: string) => {
    // Seeded only when the operations are still whatever the previous metric
    // put there. Someone who has built a pipeline and then changes the metric
    // is refining a query, not starting one, and having their chips replaced
    // would be the editor throwing away work.
    const untouched =
      value.operations.length === 0 ||
      JSON.stringify(value.operations) ===
        JSON.stringify(defaultOperationsFor(value.metric));

    onChange({
      metric: next,
      // A matcher on a label the new metric does not carry selects nothing, and
      // says so with an empty chart rather than an error.
      labelMatchers: [],
      operations: untouched ? defaultOperationsFor(next) : value.operations,
    });
  };

  const updateOperation = (index: number, next: IBuilderOp) => {
    onChange({
      ...value,
      operations: value.operations.map((op, i) => (i === index ? next : op)),
    });
  };

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-64 flex-col">
          <Label>Metric</Label>
          <Combobox
            className="w-full"
            items={(metrics.data ?? []).map((name) => ({
              value: name,
              label: name,
            }))}
            onChange={pickMetric}
            placeholder={metrics.isLoading ? 'Loading…' : 'Pick a metric'}
            searchable
            value={metric}
          />
        </div>
        {kind && (
          // The kind is INFERRED from the name — nothing upstream keeps the
          // TYPE line — so it is shown rather than hidden, both to explain the
          // seeded operations and so a wrong guess is visible.
          <Badge className="mb-1" variant="secondary">
            {kind}
          </Badge>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Label className="mb-0">Filters</Label>
        {value.labelMatchers.map((matcher, index) => (
          <MatcherRow
            enabled={enabled}
            // Index-keyed on purpose: a matcher has no id, and its label is
            // empty for as long as it takes to pick one, so nothing else here
            // is unique.
            key={`matcher-${index}`}
            labels={labels}
            metric={value.metric}
            onChange={(next) =>
              onChange({
                ...value,
                labelMatchers: value.labelMatchers.map((m, i) =>
                  i === index ? next : m,
                ),
              })
            }
            onRemove={() =>
              onChange({
                ...value,
                labelMatchers: value.labelMatchers.filter(
                  (_, i) => i !== index,
                ),
              })
            }
            projectId={projectId}
            value={matcher}
          />
        ))}
        <div>
          <Button
            disabled={value.labelMatchers.length >= 20}
            icon={PlusIcon}
            onClick={() =>
              onChange({
                ...value,
                labelMatchers: [
                  ...value.labelMatchers,
                  { label: '', op: '=', value: '' },
                ],
              })
            }
            size="sm"
            variant="outline"
          >
            Add filter
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label className="mb-0">Operations</Label>
        <div className="flex flex-wrap items-center gap-2">
          {value.operations.map((op, index) => (
            <OperationChip
              // Same reasoning as the matcher rows, plus: two `sum` chips in a
              // row are a legitimate query.
              key={`operation-${index}`}
              labels={labels}
              onChange={(next) => updateOperation(index, next)}
              onRemove={() =>
                onChange({
                  ...value,
                  operations: value.operations.filter((_, i) => i !== index),
                })
              }
              op={op}
            />
          ))}
          <DropdownMenuComposed
            items={ADDABLE_OPERATIONS}
            label="Add operation"
            onChange={(kindToAdd) => {
              const op = newOperation(kindToAdd);
              if (op) {
                onChange({ ...value, operations: [...value.operations, op] });
              }
            }}
          >
            <Button
              disabled={value.operations.length >= 20}
              icon={PlusIcon}
              size="sm"
              variant="outline"
            >
              Operation
            </Button>
          </DropdownMenuComposed>
        </div>
        {missingRate && (
          <p className="flex items-start gap-2 text-amber-600 text-xs dark:text-amber-500">
            <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
            <span>
              {value.metric} is a {kind}, which only ever climbs. Without{' '}
              <code>rate</code> this draws the running total since the process
              started, not what is happening now.
            </span>
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <Label className="mb-0">Query</Label>
        {/* Read-only: this is the compiled result, and the place to edit it is
            the Code tab, where the editor can lint and complete. */}
        <code className="block overflow-x-auto rounded-md border bg-def-200 px-3 py-2 font-mono text-xs">
          {preview.expr || (
            <span className="text-muted-foreground">
              {preview.error ?? 'Pick a metric to build a query.'}
            </span>
          )}
        </code>
      </div>
    </div>
  );
}
