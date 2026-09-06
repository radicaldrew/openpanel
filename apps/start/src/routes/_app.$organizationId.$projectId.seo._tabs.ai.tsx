import { createFileRoute } from '@tanstack/react-router';
import { AiTab } from '@/components/seo/ai/ai-tab';
import { SeoGate } from '@/components/seo/seo-gate';

export const Route = createFileRoute(
  '/_app/$organizationId/$projectId/seo/_tabs/ai'
)({
  component: Component,
});

function Component() {
  return (
    <SeoGate fallback="any" requires={['dfs', 'gsc']}>
      <AiTab />
    </SeoGate>
  );
}
