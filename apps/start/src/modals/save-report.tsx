import { ButtonContainer } from '@/components/button-container';
import { SelectDashboard } from '@/components/dashboards/select-dashboard';
import { InputWithLabel } from '@/components/forms/input-with-label';
import { Button } from '@/components/ui/button';
import { useAppParams } from '@/hooks/use-app-params';
import { handleError } from '@/integrations/trpc/react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter, useSearch } from '@tanstack/react-router';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import type { IReport } from '@openpanel/validation';

import { useTRPC } from '@/integrations/trpc/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { popModal } from '.';
import { ModalContent, ModalHeader } from './Modal/Container';

type SaveReportProps = {
  report: IReport;
  disableRedirect?: boolean;
  /**
   * Set when the chat agent proposed this report rather than the user building
   * it. The dialog is the only human gate on an AI-initiated write, and a gate
   * that shows nothing about what is being written is only as good as the
   * assumption that the payload matches the chart the user just looked at —
   * which nothing enforces. So the agent path gets a summary of the actual
   * config; the normal Save flow does not, because there the user built it.
   */
  proposedBy?: 'agent';
};

/** What the report will actually query, in the fewest lines that stay honest. */
function ProposedReport({ report }: { report: IReport }) {
  const rows: { label: string; value: string }[] = [];

  if (report.dataSource === 'metrics' && report.metricQuery) {
    const q = report.metricQuery;

    rows.push({ label: 'Source', value: 'Server metrics' });
    rows.push({ label: 'Metric', value: q.metric });
    rows.push({ label: 'Function', value: `${q.fn} · ${q.aggregation}` });

    if (q.matchers?.length) {
      rows.push({
        label: 'Filters',
        value: q.matchers
          .map((m) => `${m.name} ${m.operator} ${m.value}`)
          .join(', '),
      });
    }

    if (q.groupBy?.length) {
      rows.push({ label: 'Group by', value: q.groupBy.join(', ') });
    }
  } else {
    rows.push({ label: 'Source', value: 'Product events' });
    rows.push({
      label: report.series.length === 1 ? 'Event' : 'Events',
      value:
        report.series
          .map((s) =>
            s.type === 'formula' ? `formula ${s.formula}` : `${s.name} (${s.segment})`,
          )
          .join(', ') || 'none',
    });

    const filterCount = report.series.reduce(
      (total, s) => total + (s.type === 'formula' ? 0 : (s.filters?.length ?? 0)),
      report.globalFilters?.length ?? 0,
    );

    if (filterCount > 0) {
      rows.push({
        label: 'Filters',
        value: `${filterCount} applied`,
      });
    }
  }

  rows.push({
    label: 'Range',
    value:
      report.range === 'custom' && report.startDate && report.endDate
        ? `${report.startDate.slice(0, 10)} → ${report.endDate.slice(0, 10)}`
        : `${report.range} · ${report.interval}`,
  });

  return (
    <div className="rounded-lg border bg-def-200 p-3 text-sm">
      <div className="mb-2 font-medium">
        Claude proposed this chart — check it before saving
      </div>
      <dl className="flex flex-col gap-1">
        {rows.map((row) => (
          <div className="flex gap-2" key={row.label}>
            <dt className="w-20 shrink-0 text-muted-foreground">{row.label}</dt>
            <dd className="min-w-0 break-words font-mono text-xs leading-5">
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

const validator = z.object({
  name: z.string().min(1, 'Required'),
  dashboardId: z.string().min(1, 'Required'),
});

type IForm = z.infer<typeof validator>;

export default function SaveReport({
  report,
  disableRedirect,
  proposedBy,
}: SaveReportProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { organizationId, projectId } = useAppParams();
  const searchParams = useSearch({
    from: '/_app/$organizationId/$projectId/reports',
    shouldThrow: false,
  });
  const dashboardId = searchParams?.dashboardId;

  const trpc = useTRPC();
  const save = useMutation(
    trpc.report.create.mutationOptions({
      onError: handleError,
      onSuccess(res) {
        queryClient.invalidateQueries(
          trpc.report.list.queryFilter({
            dashboardId: res.dashboardId,
            projectId,
          }),
        );
        queryClient.invalidateQueries(trpc.dashboard.list.pathFilter());

        const goToReport = () => {
          router.navigate({
            to: '/$organizationId/$projectId/reports/$reportId',
            params: {
              organizationId,
              projectId,
              reportId: res.id,
            },
            search: searchParams,
          });
        };

        toast('Report created', {
          description: `${res.name}`,
          action: {
            label: 'View report',
            onClick: () => goToReport(),
          },
        });

        if (!disableRedirect) {
          goToReport();
        }

        popModal();
      },
    }),
  );

  const { register, handleSubmit, formState, control, setValue } =
    useForm<IForm>({
      resolver: zodResolver(validator),
      defaultValues: {
        name: report.name,
        dashboardId,
      },
    });

  return (
    <ModalContent>
      <ModalHeader title="Create report" />
      <form
        className="flex flex-col gap-4"
        onSubmit={handleSubmit(({ name, ...values }) => {
          save.mutate({
            report: {
              ...report,
              name,
            },
            ...values,
          });
        })}
      >
        {proposedBy === 'agent' && <ProposedReport report={report} />}
        <InputWithLabel
          label="Report name"
          placeholder="Name"
          {...register('name')}
          defaultValue={report.name}
        />
        <Controller
          control={control}
          name="dashboardId"
          render={({ field }) => {
            return (
              <SelectDashboard
                value={field.value}
                onChange={field.onChange}
                projectId={projectId!}
              />
            );
          }}
        />
        <ButtonContainer>
          <Button
            type="button"
            variant="outline"
            onClick={() => popModal()}
            size="default"
          >
            Cancel
          </Button>
          <Button type="submit" disabled={!formState.isValid} size="default">
            Save
          </Button>
        </ButtonContainer>
      </form>
    </ModalContent>
  );
}

