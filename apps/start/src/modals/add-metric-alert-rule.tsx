import { zodResolver } from '@hookform/resolvers/zod';
import { zCreateNotificationRule } from '@openpanel/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SaveIcon } from 'lucide-react';
import { Controller, type SubmitHandler, useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import { popModal } from '.';
import { ModalHeader } from './Modal/Container';
import { InputWithLabel, WithLabel } from '@/components/forms/input-with-label';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { SheetContent } from '@/components/ui/sheet';
import { useAppParams } from '@/hooks/use-app-params';
import { useTRPC } from '@/integrations/trpc/react';

type IForm = z.infer<typeof zCreateNotificationRule>;

const OPERATORS = [
  { value: 'gt', label: 'is above' },
  { value: 'gte', label: 'is at or above' },
  { value: 'lt', label: 'is below' },
  { value: 'lte', label: 'is at or below' },
] as const;

const FUNCTIONS = [
  { value: 'rate', label: 'Per-second rate' },
  { value: 'increase', label: 'Increase' },
  { value: 'delta', label: 'Delta' },
  { value: 'raw', label: 'Raw value' },
] as const;

const AGGREGATIONS = [
  { value: 'sum', label: 'Sum' },
  { value: 'avg', label: 'Average' },
  { value: 'max', label: 'Max' },
  { value: 'min', label: 'Min' },
  { value: 'p95', label: 'p95 (histogram)' },
  { value: 'p99', label: 'p99 (histogram)' },
] as const;

const FOR_OPTIONS = [
  { value: '0', label: 'Immediately' },
  { value: '300', label: 'For 5 minutes' },
  { value: '900', label: 'For 15 minutes' },
  { value: '1800', label: 'For 30 minutes' },
] as const;

const COOLDOWN_OPTIONS = [
  { value: '900', label: 'At most every 15 minutes' },
  { value: '1800', label: 'At most every 30 minutes' },
  { value: '3600', label: 'At most hourly' },
  { value: '21600', label: 'At most every 6 hours' },
] as const;

/**
 * Editor for a metric alert rule.
 *
 * Separate from the event/funnel rule modal rather than a fourth branch inside
 * it: the two share only a name and delivery settings, and the event modal's
 * whole body is an event picker with filters that has no meaning here.
 */
export default function AddMetricAlertRule() {
  const client = useQueryClient();
  const trpc = useTRPC();
  const { projectId } = useAppParams();

  const form = useForm<IForm>({
    resolver: zodResolver(zCreateNotificationRule),
    defaultValues: {
      name: '',
      projectId,
      sendToApp: true,
      sendToEmail: false,
      integrations: [],
      config: {
        type: 'metric',
        query: {
          metric: '',
          matchers: [],
          fn: 'rate',
          aggregation: 'sum',
          groupBy: [],
        },
        operator: 'gt',
        threshold: 0,
        forSeconds: 300,
        cooldownSeconds: 1800,
      },
    },
  });

  const metrics = useQuery(
    trpc.observability.metricNames.queryOptions({ projectId }),
  );

  const selectedMetric = useWatch({
    control: form.control,
    name: 'config.query.metric',
  });

  const labels = useQuery(
    trpc.observability.labelKeys.queryOptions(
      { projectId, metric: selectedMetric },
      { enabled: !!selectedMetric },
    ),
  );

  const mutation = useMutation(
    trpc.notification.createOrUpdateRule.mutationOptions({
      onSuccess() {
        toast.success('Alert rule saved');
        client.invalidateQueries({ queryKey: trpc.notification.rules.queryKey() });
        popModal();
      },
      onError(error) {
        toast.error(error.message);
      },
    }),
  );

  const onSubmit: SubmitHandler<IForm> = (data) => {
    if (!('query' in data.config) || !data.config.query.metric) {
      toast.error('Pick a metric to alert on');
      return;
    }
    mutation.mutate(data);
  };

  return (
    <SheetContent>
      <ModalHeader
        title="New metric alert"
        text="Alert when a server metric crosses a threshold."
      />

      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="mt-4 flex flex-col gap-4"
      >
        <InputWithLabel
          label="Name"
          placeholder="Checkout latency too high"
          {...form.register('name')}
        />

        <WithLabel label="Metric">
          <Controller
            control={form.control}
            name="config.query.metric"
            render={({ field }) => (
              <Combobox
                placeholder={metrics.isLoading ? 'Loading…' : 'Pick a metric'}
                items={(metrics.data ?? []).map((m) => ({ value: m, label: m }))}
                value={field.value}
                onChange={field.onChange}
              />
            )}
          />
        </WithLabel>

        <div className="grid grid-cols-2 gap-4">
          <WithLabel label="Function">
            <Controller
              control={form.control}
              name="config.query.fn"
              render={({ field }) => (
                <Combobox
                  placeholder="Function"
                  items={FUNCTIONS.map((f) => ({ value: f.value, label: f.label }))}
                  value={field.value}
                  onChange={field.onChange}
                />
              )}
            />
          </WithLabel>

          <WithLabel label="Aggregation">
            <Controller
              control={form.control}
              name="config.query.aggregation"
              render={({ field }) => (
                <Combobox
                  placeholder="Aggregation"
                  items={AGGREGATIONS.map((a) => ({ value: a.value, label: a.label }))}
                  value={field.value}
                  onChange={field.onChange}
                />
              )}
            />
          </WithLabel>
        </div>

        <WithLabel label="Alert separately per">
          <Controller
            control={form.control}
            name="config.query.groupBy"
            render={({ field }) => (
              <Combobox
                placeholder="Whole metric (one alert)"
                items={[
                  { value: '', label: 'Whole metric (one alert)' },
                  ...(labels.data ?? []).map((l) => ({ value: l, label: l })),
                ]}
                value={field.value?.[0] ?? ''}
                onChange={(value) => field.onChange(value ? [value] : [])}
              />
            )}
          />
          <p className="mt-1 text-muted-foreground text-sm">
            Each group alerts and resolves on its own, so one noisy route cannot
            hide the others.
          </p>
        </WithLabel>

        <div className="grid grid-cols-2 gap-4">
          <WithLabel label="Alert when the value">
            <Controller
              control={form.control}
              name="config.operator"
              render={({ field }) => (
                <Combobox
                  placeholder="Condition"
                  items={OPERATORS.map((o) => ({ value: o.value, label: o.label }))}
                  value={field.value}
                  onChange={field.onChange}
                />
              )}
            />
          </WithLabel>

          <InputWithLabel
            label="Threshold"
            type="number"
            step="any"
            {...form.register('config.threshold', { valueAsNumber: true })}
          />
        </div>

        <WithLabel label="And has held">
          <Controller
            control={form.control}
            name="config.forSeconds"
            render={({ field }) => (
              <Combobox
                placeholder="Duration"
                items={FOR_OPTIONS.map((f) => ({ value: f.value, label: f.label }))}
                value={String(field.value)}
                onChange={(value) => field.onChange(Number(value))}
              />
            )}
          />
          <p className="mt-1 text-muted-foreground text-sm">
            A duration stops a single spike from paging anyone.
          </p>
        </WithLabel>

        <WithLabel label="Notify">
          <Controller
            control={form.control}
            name="config.cooldownSeconds"
            render={({ field }) => (
              <Combobox
                placeholder="Cooldown"
                items={COOLDOWN_OPTIONS.map((c) => ({
                  value: c.value,
                  label: c.label,
                }))}
                value={String(field.value)}
                onChange={(value) => field.onChange(Number(value))}
              />
            )}
          />
        </WithLabel>

        <Button
          type="submit"
          icon={SaveIcon}
          loading={mutation.isPending}
          className="mt-2"
        >
          Save alert
        </Button>
      </form>
    </SheetContent>
  );
}
