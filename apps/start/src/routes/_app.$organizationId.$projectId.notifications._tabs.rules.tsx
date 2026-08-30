import { FullPageEmptyState } from '@/components/full-page-empty-state';
import FullPageLoadingState from '@/components/full-page-loading-state';
import { IntegrationCardSkeleton } from '@/components/integrations/integration-card';
import { RuleCard } from '@/components/notifications/rule-card';
import { Button } from '@/components/ui/button';
import { useTRPC } from '@/integrations/trpc/react';
import { pushModal } from '@/modals';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { AnimatePresence, motion } from 'framer-motion';
import { ActivityIcon, PencilRulerIcon, PlusIcon } from 'lucide-react';
import { useMemo } from 'react';

export const Route = createFileRoute(
  '/_app/$organizationId/$projectId/notifications/_tabs/rules',
)({
  component: Component,
  loader: async ({ context, params }) => {
    await context.queryClient.prefetchQuery(
      context.trpc.notification.rules.queryOptions({
        projectId: params.projectId,
      }),
    );
  },
  pendingComponent: FullPageLoadingState,
});

function Component() {
  const { projectId } = Route.useParams();
  const trpc = useTRPC();
  const query = useQuery(
    trpc.notification.rules.queryOptions({
      projectId,
    }),
  );
  const data = useMemo(() => {
    return query.data || [];
  }, [query.data]);

  const isLoading = query.isLoading;

  if (!isLoading && data.length === 0) {
    return (
      <FullPageEmptyState title="No rules yet" icon={PencilRulerIcon}>
        <p>
          You have not created any rules yet. Create a rule to start getting
          notifications.
        </p>
        <Button
          className="mt-8"
          variant="outline"
          onClick={() =>
            pushModal('AddNotificationRule', {
              rule: undefined,
            })
          }
        >
          Add Rule
        </Button>
      </FullPageEmptyState>
    );
  }

  return (
    <div>
      <div className="mb-2 flex gap-2">
        <Button
          icon={PlusIcon}
          variant="outline"
          onClick={() =>
            pushModal('AddNotificationRule', {
              rule: undefined,
            })
          }
        >
          Add Rule
        </Button>
        {/* Metric alerts get their own editor: they share only a name and the
            delivery settings with event rules, and the event editor's body is
            an event picker that has no meaning for a metric threshold. */}
        <Button
          icon={ActivityIcon}
          variant="outline"
          onClick={() => pushModal('AddMetricAlertRule')}
        >
          Add Metric Alert
        </Button>
      </div>
      <div className="col gap-4 w-full grid md:grid-cols-2">
        {isLoading && (
          <>
            <IntegrationCardSkeleton />
            <IntegrationCardSkeleton />
            <IntegrationCardSkeleton />
          </>
        )}
        <AnimatePresence mode="popLayout">
          {data.map((item) => {
            return (
              <motion.div key={item.id} layout="position">
                <RuleCard rule={item} />
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}
