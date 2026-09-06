import { useMutation } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { formatDistanceToNow } from 'date-fns';
import { Loader2Icon, RefreshCwIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { InputWithLabel } from '@/components/forms/input-with-label';
import { SeoProjectConfigForm } from '@/components/seo/seo-project-config-form';
import {
  type SeoStatus,
  useInvalidateSeoStatus,
  useSeoStatus,
} from '@/components/seo/use-seo-status';
import { Skeleton } from '@/components/skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAppParams } from '@/hooks/use-app-params';
import { useOrganizationAccess } from '@/hooks/use-organization-access';
import { handleError, useTRPC } from '@/integrations/trpc/react';

export const Route = createFileRoute(
  '/_app/$organizationId/$projectId/settings/_tabs/dataforseo'
)({
  component: DataForSeoSettings,
});

const SPEND_WARNING_RATIO = 0.8;

const formatUsd = (value: number) =>
  value.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  });

function DataForSeoSettings() {
  const { projectId, organizationId } = useAppParams();
  const { isAdmin } = useOrganizationAccess(organizationId);
  const statusQuery = useSeoStatus(projectId);

  if (statusQuery.isLoading || !statusQuery.data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const status = statusQuery.data;

  return (
    <div className="space-y-10">
      <section className="space-y-6">
        <div>
          <h3 className="font-medium text-lg">DataForSEO</h3>
          <p className="mt-1 text-muted-foreground text-sm">
            Powers keyword research, rank tracking, backlinks, site audits and
            AI visibility. The key is shared by all projects in this
            organization.
          </p>
          {!isAdmin && (
            <p className="mt-2 text-muted-foreground text-sm">
              Only organization admins can change the key or spend cap.
            </p>
          )}
        </div>

        {status.dfs.configured ? (
          <ConnectedCard
            isAdmin={isAdmin}
            organizationId={organizationId}
            status={status}
          />
        ) : (
          <ConnectForm isAdmin={isAdmin} organizationId={organizationId} />
        )}
      </section>

      <section className="space-y-6">
        <div>
          <h3 className="font-medium text-lg">This project</h3>
          <p className="mt-1 text-muted-foreground text-sm">
            Which site to track, the market to check rankings in, and how often
            scheduled jobs run.
          </p>
        </div>
        <div className="rounded-lg border p-6">
          <SeoProjectConfigForm
            config={status.config}
            gscSiteUrl={status.gsc.siteUrl}
            key={status.config?.domain ?? 'new'}
            projectId={projectId}
            variant="full"
          />
        </div>
      </section>
    </div>
  );
}

function ConnectForm({
  organizationId,
  isAdmin,
}: {
  organizationId: string;
  isAdmin: boolean;
}) {
  const trpc = useTRPC();
  const invalidateStatus = useInvalidateSeoStatus();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');

  const setKey = useMutation(
    trpc.seo.settings.setDfsKey.mutationOptions({
      onError: handleError,
      onSuccess: (result) => {
        toast.success('DataForSEO connected', {
          description:
            result.balanceUsd === null
              ? undefined
              : `Balance: ${formatUsd(result.balanceUsd)}`,
        });
        setPassword('');
        invalidateStatus();
      },
    })
  );

  const canSubmit =
    isAdmin && login.trim() !== '' && password !== '' && !setKey.isPending;

  return (
    <form
      className="flex flex-col gap-4 rounded-lg border p-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) {
          setKey.mutate({ organizationId, login: login.trim(), password });
        }
      }}
    >
      <p className="text-muted-foreground text-sm">
        Use the API login and password from{' '}
        <a
          className="underline"
          href="https://app.dataforseo.com/api-access"
          rel="noopener"
          target="_blank"
        >
          app.dataforseo.com/api-access
        </a>
        . We validate it against your account before saving and store it
        encrypted.
      </p>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <InputWithLabel
          autoComplete="username"
          disabled={!isAdmin || setKey.isPending}
          label="API login"
          onChange={(e) => setLogin(e.target.value)}
          placeholder="you@example.com"
          value={login}
        />
        <InputWithLabel
          autoComplete="new-password"
          disabled={!isAdmin || setKey.isPending}
          label="API password"
          onChange={(e) => setPassword(e.target.value)}
          type="password"
          value={password}
        />
      </div>
      <Button className="w-fit" disabled={!canSubmit} type="submit">
        {setKey.isPending && (
          <Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
        )}
        Save and validate
      </Button>
    </form>
  );
}

function ConnectedCard({
  organizationId,
  status,
  isAdmin,
}: {
  organizationId: string;
  status: SeoStatus;
  isAdmin: boolean;
}) {
  const trpc = useTRPC();
  const invalidateStatus = useInvalidateSeoStatus();
  const [showReplace, setShowReplace] = useState(false);

  const refresh = useMutation(
    trpc.seo.settings.refreshBalance.mutationOptions({
      onError: handleError,
      onSuccess: () => {
        toast.success('Balance refreshed');
        invalidateStatus();
      },
    })
  );

  const remove = useMutation(
    trpc.seo.settings.removeDfsKey.mutationOptions({
      onError: handleError,
      onSuccess: () => {
        toast.success('DataForSEO key removed');
        invalidateStatus();
      },
    })
  );

  const { dfs } = status;
  const balanceIsEmpty = dfs.balanceUsd !== null && dfs.balanceUsd <= 0;
  const spendRatio =
    dfs.spendCapUsd && dfs.spendCapUsd > 0
      ? dfs.monthlySpendUsd / dfs.spendCapUsd
      : null;

  return (
    <div className="space-y-4">
      <div className="divide-y rounded-lg border">
        <Row label="Login">
          <span className="font-mono text-muted-foreground text-sm">
            {dfs.login}
          </span>
        </Row>
        <Row label="Password">
          <span className="font-mono text-muted-foreground text-sm">
            ••••••••••••
          </span>
        </Row>
        <Row label="Balance">
          <div className="flex items-center gap-2">
            {dfs.balanceUsd === null ? (
              <span className="text-muted-foreground text-sm">Unknown</span>
            ) : (
              <Badge variant={balanceIsEmpty ? 'destructive' : 'success'}>
                {formatUsd(dfs.balanceUsd)}
              </Badge>
            )}
            {dfs.balanceAt && (
              <span className="text-muted-foreground text-xs">
                {formatDistanceToNow(new Date(dfs.balanceAt), {
                  addSuffix: true,
                })}
              </span>
            )}
            <Button
              disabled={!isAdmin || refresh.isPending}
              onClick={() => refresh.mutate({ organizationId })}
              size="icon"
              title="Refresh balance"
              variant="ghost"
            >
              <RefreshCwIcon
                className={`h-4 w-4 ${refresh.isPending ? 'animate-spin' : ''}`}
              />
            </Button>
          </div>
        </Row>
        <Row label="Spent this month">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm">
              {formatUsd(dfs.monthlySpendUsd)}
            </span>
            {dfs.spendCapUsd !== null && (
              <span className="text-muted-foreground text-xs">
                of {formatUsd(dfs.spendCapUsd)} cap
              </span>
            )}
            {spendRatio !== null && spendRatio >= SPEND_WARNING_RATIO && (
              <Badge variant={spendRatio >= 1 ? 'destructive' : 'secondary'}>
                {spendRatio >= 1 ? 'Cap reached' : 'Near cap'}
              </Badge>
            )}
          </div>
        </Row>
        {dfs.lastError && (
          <div className="p-4">
            <div className="font-medium text-destructive text-sm">
              Last error
            </div>
            <div className="mt-1 break-words font-mono text-muted-foreground text-sm">
              {dfs.lastError}
            </div>
          </div>
        )}
      </div>

      <SpendCapForm
        currentCapUsd={dfs.spendCapUsd}
        isAdmin={isAdmin}
        organizationId={organizationId}
      />

      {showReplace ? (
        <div className="space-y-2">
          <Label>Replace key</Label>
          <ConnectForm isAdmin={isAdmin} organizationId={organizationId} />
          <Button
            onClick={() => setShowReplace(false)}
            size="sm"
            variant="ghost"
          >
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button
            disabled={!isAdmin}
            onClick={() => setShowReplace(true)}
            size="sm"
            variant="outline"
          >
            Replace key
          </Button>
          <Button
            disabled={!isAdmin || remove.isPending}
            onClick={() => remove.mutate({ organizationId })}
            size="sm"
            variant="destructive"
          >
            {remove.isPending && (
              <Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
            )}
            Remove
          </Button>
        </div>
      )}
    </div>
  );
}

function SpendCapForm({
  organizationId,
  currentCapUsd,
  isAdmin,
}: {
  organizationId: string;
  currentCapUsd: number | null;
  isAdmin: boolean;
}) {
  const trpc = useTRPC();
  const invalidateStatus = useInvalidateSeoStatus();
  const [value, setValue] = useState(
    currentCapUsd === null ? '' : String(currentCapUsd)
  );

  const setCap = useMutation(
    trpc.seo.settings.setSpendCap.mutationOptions({
      onError: handleError,
      onSuccess: (result) => {
        toast.success(
          result.capUsd === null
            ? 'Spend cap removed'
            : `Spend cap set to ${formatUsd(result.capUsd)}`
        );
        invalidateStatus();
      },
    })
  );

  const parsed = value.trim() === '' ? null : Number(value);
  const isValid = parsed === null || (Number.isFinite(parsed) && parsed >= 0);
  const isDirty = parsed !== currentCapUsd;

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (isValid && isDirty) {
          setCap.mutate({ organizationId, capUsd: parsed });
        }
      }}
    >
      <div>
        <Label htmlFor="dfs-spend-cap">Monthly spend cap (USD)</Label>
        <p className="mt-1 text-muted-foreground text-xs">
          Scheduled rank checks and backlink refreshes pause once this is
          reached. Leave empty for no cap. Manual actions are not blocked.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Input
          className="max-w-40"
          disabled={!isAdmin || setCap.isPending}
          error={isValid ? undefined : 'Enter a positive amount'}
          id="dfs-spend-cap"
          inputMode="decimal"
          min={0}
          onChange={(e) => setValue(e.target.value)}
          placeholder="No cap"
          step="0.01"
          type="number"
          value={value}
        />
        <Button
          disabled={!(isAdmin && isValid && isDirty) || setCap.isPending}
          size="sm"
          type="submit"
          variant="outline"
        >
          {setCap.isPending && (
            <Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
          )}
          Save cap
        </Button>
      </div>
    </form>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 p-4">
      <div className="font-medium text-sm">{label}</div>
      {children}
    </div>
  );
}
