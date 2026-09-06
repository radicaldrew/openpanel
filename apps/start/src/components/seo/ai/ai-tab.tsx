import { useSeoStatus } from '../use-seo-status';
import { AiMentionsPanel } from './ai-mentions-panel';
import { AiTrafficPanel } from './ai-traffic-panel';
import { PromptExplorer } from './prompt-explorer';
import { Skeleton } from '@/components/skeleton';
import { useAppParams } from '@/hooks/use-app-params';

/**
 * Two halves of the same question. Left: are you visible in AI answers
 * (DataForSEO, needs a key and a project domain). Right: is that visibility
 * sending anyone (OpenPanel's own sessions, always available). The gate
 * lets either half through on its own; the DFS half simply stays hidden
 * until it is configured.
 */
export function AiTab() {
  const { projectId } = useAppParams();
  const statusQuery = useSeoStatus(projectId);
  const status = statusQuery.data;

  if (!status) {
    return <Skeleton className="h-96 w-full" />;
  }

  const domain = status.config?.domain ?? null;
  const dfsReady =
    status.dfs.configured &&
    domain !== null &&
    !(status.dfs.balanceUsd !== null && status.dfs.balanceUsd <= 0);

  return (
    <div className="col gap-8">
      <div
        className={
          dfsReady ? 'grid grid-cols-1 gap-8 lg:grid-cols-2' : 'grid grid-cols-1 gap-8'
        }
      >
        {dfsReady && domain && (
          <AiMentionsPanel
            competitors={status.config?.competitors ?? []}
            projectId={projectId}
          />
        )}
        <AiTrafficPanel projectId={projectId} />
      </div>
      {dfsReady && domain && <PromptExplorer ownDomain={domain} projectId={projectId} />}
    </div>
  );
}
