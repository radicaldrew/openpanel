import { createFileRoute } from '@tanstack/react-router';
import { RankingsTab } from '@/components/seo/rankings/rankings-tab';
import { SeoGate } from '@/components/seo/seo-gate';

export const Route = createFileRoute(
  '/_app/$organizationId/$projectId/seo/_tabs/rankings'
)({
  component: Component,
});

function Component() {
  return (
    <SeoGate requires={['dfs']}>
      <RankingsTab />
    </SeoGate>
  );
}
