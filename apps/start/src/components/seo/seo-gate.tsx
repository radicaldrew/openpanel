import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  GlobeIcon,
  KeyRoundIcon,
  Loader2Icon,
  SearchIcon,
  WalletIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { SeoProjectConfigForm } from './seo-project-config-form';
import {
  type SeoStatus,
  useInvalidateSeoStatus,
  useSeoStatus,
} from './use-seo-status';
import { FullPageEmptyState } from '@/components/full-page-empty-state';
import { Skeleton } from '@/components/skeleton';
import { Button } from '@/components/ui/button';
import { useAppParams } from '@/hooks/use-app-params';
import { handleError, useTRPC } from '@/integrations/trpc/react';

export type SeoRequirement = 'gsc' | 'dfs';

interface Props {
  requires: SeoRequirement[];
  /**
   * `all` (default): every requirement must be satisfied.
   * `any`: render children as soon as one requirement is satisfied, so a tab
   * can show whichever half of its data is available.
   */
  fallback?: 'any' | 'all';
  children: React.ReactNode;
}

type Blocker =
  | { kind: 'gsc' }
  | { kind: 'dfs' }
  | { kind: 'dfs-balance' }
  | { kind: 'config' };

const DATAFORSEO_BILLING_URL = 'https://app.dataforseo.com/billing';

/**
 * Walks the DataForSEO ladder: key configured → balance available → project
 * config present. Returns the first rung that is missing.
 */
function dfsBlocker(status: SeoStatus): Blocker | null {
  if (!status.dfs.configured) {
    return { kind: 'dfs' };
  }
  if (status.dfs.balanceUsd !== null && status.dfs.balanceUsd <= 0) {
    return { kind: 'dfs-balance' };
  }
  if (!status.config?.domain) {
    return { kind: 'config' };
  }
  return null;
}

function gscBlocker(status: SeoStatus): Blocker | null {
  return status.gsc.connected ? null : { kind: 'gsc' };
}

function resolveBlocker(
  status: SeoStatus,
  requires: SeoRequirement[],
  fallback: 'any' | 'all'
): Blocker | null {
  const blockers = requires.map((requirement) =>
    requirement === 'dfs' ? dfsBlocker(status) : gscBlocker(status)
  );
  const satisfiedCount = blockers.filter((blocker) => blocker === null).length;

  if (fallback === 'any') {
    if (satisfiedCount > 0) {
      return null;
    }
    // Nothing is available: prefer the DataForSEO prompt since it unlocks the
    // most, and the CTA below offers Search Console as the secondary path.
    return blockers.find((blocker) => blocker?.kind !== 'gsc') ?? blockers[0] ?? null;
  }

  return blockers.find((blocker) => blocker !== null) ?? null;
}

export function SeoGate({ requires, fallback = 'all', children }: Props) {
  const { projectId } = useAppParams();
  const statusQuery = useSeoStatus(projectId);

  if (statusQuery.isLoading || !statusQuery.data) {
    if (statusQuery.isError) {
      return (
        <FullPageEmptyState
          className="pt-[10vh]"
          description={statusQuery.error.message}
          title="Could not load SEO status"
        >
          <Button onClick={() => statusQuery.refetch()} variant="outline">
            Retry
          </Button>
        </FullPageEmptyState>
      );
    }
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const status = statusQuery.data;
  const blocker = resolveBlocker(status, requires, fallback);

  if (blocker === null) {
    return <>{children}</>;
  }

  return (
    <SeoGateFallback
      blocker={blocker}
      offerGsc={fallback === 'any' && requires.includes('gsc')}
      status={status}
    />
  );
}

function SeoGateFallback({
  blocker,
  status,
  offerGsc,
}: {
  blocker: Blocker;
  status: SeoStatus;
  offerGsc: boolean;
}) {
  const { organizationId, projectId } = useAppParams();
  const navigate = useNavigate();
  const params = { organizationId, projectId };

  const goToGscSettings = () =>
    navigate({ to: '/$organizationId/$projectId/settings/gsc', params });
  const goToDfsSettings = () =>
    navigate({ to: '/$organizationId/$projectId/settings/dataforseo', params });

  switch (blocker.kind) {
    case 'gsc':
      return (
        <FullPageEmptyState
          className="pt-[10vh]"
          description="Connect Google Search Console to see impressions, clicks and average positions for your site."
          icon={SearchIcon}
          title="No Search Console data yet"
        >
          <Button onClick={goToGscSettings}>Connect Google Search Console</Button>
        </FullPageEmptyState>
      );
    case 'dfs':
      return (
        <FullPageEmptyState
          className="pt-[10vh]"
          description="Add your DataForSEO login to this organization. It powers keyword research, rank tracking, backlinks, site audits and AI visibility for every project."
          icon={KeyRoundIcon}
          title="Connect DataForSEO to unlock keyword, ranking and backlink data"
        >
          <div className="flex flex-wrap justify-center gap-2">
            <Button onClick={goToDfsSettings}>Connect DataForSEO</Button>
            {offerGsc && !status.gsc.connected && (
              <Button onClick={goToGscSettings} variant="outline">
                Connect Google Search Console
              </Button>
            )}
          </div>
        </FullPageEmptyState>
      );
    case 'dfs-balance':
      return <DfsBalanceEmpty organizationId={organizationId} status={status} />;
    case 'config':
      return (
        <FullPageEmptyState
          className="pt-[10vh]"
          description="Tell us the domain, market and language to track. You can change everything later under Settings → DataForSEO."
          icon={GlobeIcon}
          title="Which site should we track?"
        >
          <SeoProjectConfigForm
            className="w-full text-left"
            config={status.config}
            gscSiteUrl={status.gsc.siteUrl}
            projectId={projectId}
            variant="compact"
          />
        </FullPageEmptyState>
      );
    default:
      return null;
  }
}

function DfsBalanceEmpty({
  organizationId,
  status,
}: {
  organizationId: string;
  status: SeoStatus;
}) {
  const trpc = useTRPC();
  const invalidateStatus = useInvalidateSeoStatus();

  const refresh = useMutation(
    trpc.seo.settings.refreshBalance.mutationOptions({
      onError: handleError,
      onSuccess: (next) => {
        invalidateStatus();
        if (next.balanceUsd !== null && next.balanceUsd > 0) {
          toast.success('Balance updated');
        } else {
          toast('Balance is still empty', {
            description: 'Top up at dataforseo.com and refresh again.',
          });
        }
      },
    })
  );

  return (
    <FullPageEmptyState
      className="pt-[10vh]"
      description={`The DataForSEO account ${status.dfs.login ?? ''} has no remaining balance. Add funds, then refresh to continue.`}
      icon={WalletIcon}
      title="DataForSEO balance is empty"
    >
      <div className="flex flex-wrap justify-center gap-2">
        <Button asChild>
          <a href={DATAFORSEO_BILLING_URL} rel="noopener" target="_blank">
            Open DataForSEO billing
          </a>
        </Button>
        <Button
          disabled={refresh.isPending}
          onClick={() => refresh.mutate({ organizationId })}
          variant="outline"
        >
          {refresh.isPending && (
            <Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
          )}
          Refresh balance
        </Button>
      </div>
    </FullPageEmptyState>
  );
}
