// @vitest-environment jsdom
/**
 * SeoGate states from SEO.md §8.2. The status hook, the config form and the
 * app plumbing (router params, navigation, tRPC, toasts) are mocked; the gate,
 * the empty-state layout and React Query's useMutation are the real thing.
 *
 * Run with: cd apps/start && NITRO=1 npx vitest run src/components/seo
 * (NITRO=1 swaps the Cloudflare vite plugin, which cannot start inside a
 * vitest worker, for the Nitro one.)
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { navigateMock, refreshMock, useSeoStatusMock, toastMock } = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  refreshMock: vi.fn(),
  useSeoStatusMock: vi.fn(),
  toastMock: Object.assign(vi.fn(), { success: vi.fn() }),
}));

vi.mock('./use-seo-status', () => ({
  useSeoStatus: useSeoStatusMock,
  useInvalidateSeoStatus: () => vi.fn(),
}));
vi.mock('./seo-project-config-form', () => ({
  SeoProjectConfigForm: (props: { projectId: string; gscSiteUrl: string | null }) => (
    <div data-testid="config-form">
      {props.projectId}:{props.gscSiteUrl ?? 'no-gsc'}
    </div>
  ),
}));
vi.mock('@/hooks/use-app-params', () => ({
  useAppParams: () => ({ organizationId: 'org-1', projectId: 'proj-1' }),
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}));
vi.mock('@/integrations/trpc/react', () => ({
  handleError: vi.fn(),
  useTRPC: () => ({
    seo: {
      settings: {
        refreshBalance: {
          mutationOptions: (options: Record<string, unknown>) => ({
            mutationKey: ['seo', 'settings', 'refreshBalance'],
            mutationFn: refreshMock,
            ...options,
          }),
        },
      },
    },
  }),
}));
vi.mock('sonner', () => ({ toast: toastMock }));

import { SeoGate } from './seo-gate';
import type { SeoStatus } from './use-seo-status';

const READY: SeoStatus = {
  dfs: {
    configured: true,
    login: 'alice@example.com',
    balanceUsd: 42,
    balanceAt: '2026-09-06T00:00:00.000Z',
    monthlySpendUsd: 1.5,
    spendCapUsd: null,
    lastError: null,
  },
  gsc: { connected: true, siteUrl: 'sc-domain:example.com' },
  config: {
    domain: 'example.com',
    locationCode: 2840,
    languageCode: 'en',
    devices: 'both',
    serpDepth: 20,
    rankSchedule: 'daily',
    backlinkSchedule: 'weekly',
    competitors: [],
  },
};

function status(overrides: {
  dfs?: Partial<SeoStatus['dfs']>;
  gsc?: Partial<SeoStatus['gsc']>;
  config?: SeoStatus['config'];
}): SeoStatus {
  return {
    dfs: { ...READY.dfs, ...overrides.dfs },
    gsc: { ...READY.gsc, ...overrides.gsc },
    config: overrides.config === undefined ? READY.config : overrides.config,
  };
}

function givenStatus(data: SeoStatus | null, extra: Record<string, unknown> = {}) {
  useSeoStatusMock.mockReturnValue({
    data,
    isLoading: data === null && !extra.isError,
    isError: false,
    error: null,
    refetch: vi.fn(),
    ...extra,
  });
}

function renderGate(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const CHILD = <p>tab content</p>;

beforeEach(() => {
  vi.clearAllMocks();
  refreshMock.mockResolvedValue({ balanceUsd: 12 });
});

// No vitest globals here, so Testing Library does not unmount between tests
// on its own.
afterEach(() => {
  cleanup();
});

describe('SeoGate', () => {
  it('shows skeletons while the status loads', () => {
    givenStatus(null);
    const { container } = renderGate(<SeoGate requires={['dfs']}>{CHILD}</SeoGate>);
    expect(screen.queryByText('tab content')).toBeNull();
    expect(container.querySelectorAll('[class*="animate-pulse"]').length).toBeGreaterThan(0);
  });

  it('offers a retry when the status query fails', () => {
    const refetch = vi.fn();
    givenStatus(null, { isError: true, error: new Error('boom'), refetch, isLoading: false });
    renderGate(<SeoGate requires={['dfs']}>{CHILD}</SeoGate>);
    expect(screen.getByText('Could not load SEO status')).toBeTruthy();
    expect(screen.getByText('boom')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it('renders children when every requirement is met', () => {
    givenStatus(READY);
    renderGate(<SeoGate requires={['dfs', 'gsc']}>{CHILD}</SeoGate>);
    expect(screen.getByText('tab content')).toBeTruthy();
  });

  it('asks for Search Console when gsc is required and missing', () => {
    givenStatus(status({ gsc: { connected: false, siteUrl: null } }));
    renderGate(<SeoGate requires={['gsc']}>{CHILD}</SeoGate>);
    expect(screen.getByText('No Search Console data yet')).toBeTruthy();
    expect(screen.queryByText('tab content')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Connect Google Search Console' }));
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/$organizationId/$projectId/settings/gsc',
      params: { organizationId: 'org-1', projectId: 'proj-1' },
    });
  });

  it('asks for a DataForSEO key when dfs is required and not configured', () => {
    givenStatus(status({ dfs: { configured: false, login: null, balanceUsd: null } }));
    renderGate(<SeoGate requires={['dfs']}>{CHILD}</SeoGate>);
    expect(
      screen.getByText('Connect DataForSEO to unlock keyword, ranking and backlink data')
    ).toBeTruthy();
    expect(screen.queryByText('tab content')).toBeNull();
    // Only the DataForSEO CTA: GSC is not part of this tab's requirements.
    expect(screen.queryByRole('button', { name: 'Connect Google Search Console' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Connect DataForSEO' }));
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/$organizationId/$projectId/settings/dataforseo',
      params: { organizationId: 'org-1', projectId: 'proj-1' },
    });
  });

  it('shows the empty-balance state with a billing link and a refresh action', async () => {
    givenStatus(status({ dfs: { balanceUsd: 0 } }));
    renderGate(<SeoGate requires={['dfs']}>{CHILD}</SeoGate>);
    expect(screen.getByText('DataForSEO balance is empty')).toBeTruthy();
    expect(screen.getByText(/alice@example.com has no remaining balance/)).toBeTruthy();

    const billing = screen.getByRole('link', { name: 'Open DataForSEO billing' });
    expect(billing.getAttribute('href')).toBe('https://app.dataforseo.com/billing');
    expect(billing.getAttribute('target')).toBe('_blank');

    fireEvent.click(screen.getByRole('button', { name: 'Refresh balance' }));
    await waitFor(() =>
      expect(refreshMock).toHaveBeenCalledWith({ organizationId: 'org-1' }, expect.anything())
    );
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Balance updated'));
  });

  it('tells the user the balance is still empty after a refresh that finds none', async () => {
    givenStatus(status({ dfs: { balanceUsd: 0 } }));
    refreshMock.mockResolvedValue({ balanceUsd: 0 });
    renderGate(<SeoGate requires={['dfs']}>{CHILD}</SeoGate>);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh balance' }));
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith('Balance is still empty', expect.anything())
    );
  });

  it('does not treat an unknown balance as empty', () => {
    givenStatus(status({ dfs: { balanceUsd: null } }));
    renderGate(<SeoGate requires={['dfs']}>{CHILD}</SeoGate>);
    expect(screen.getByText('tab content')).toBeTruthy();
  });

  it('renders the inline project config form when the domain is not set', () => {
    givenStatus(status({ config: null }));
    renderGate(<SeoGate requires={['dfs']}>{CHILD}</SeoGate>);
    expect(screen.getByText('Which site should we track?')).toBeTruthy();
    // The form gets the project and the GSC property to prefill the domain.
    expect(screen.getByTestId('config-form').textContent).toBe('proj-1:sc-domain:example.com');
    expect(screen.queryByText('tab content')).toBeNull();
  });

  it('checks the DataForSEO ladder in order: key, then balance, then config', () => {
    givenStatus(status({ dfs: { configured: false, balanceUsd: 0 }, config: null }));
    renderGate(<SeoGate requires={['dfs']}>{CHILD}</SeoGate>);
    expect(
      screen.getByText('Connect DataForSEO to unlock keyword, ranking and backlink data')
    ).toBeTruthy();
    expect(screen.queryByText('DataForSEO balance is empty')).toBeNull();
    expect(screen.queryByText('Which site should we track?')).toBeNull();
  });

  describe('fallback="any"', () => {
    it('renders children when only Search Console is available', () => {
      givenStatus(status({ dfs: { configured: false, login: null, balanceUsd: null } }));
      renderGate(
        <SeoGate fallback="any" requires={['dfs', 'gsc']}>
          {CHILD}
        </SeoGate>
      );
      expect(screen.getByText('tab content')).toBeTruthy();
    });

    it('renders children when only DataForSEO is available', () => {
      givenStatus(status({ gsc: { connected: false, siteUrl: null } }));
      renderGate(
        <SeoGate fallback="any" requires={['dfs', 'gsc']}>
          {CHILD}
        </SeoGate>
      );
      expect(screen.getByText('tab content')).toBeTruthy();
    });

    it('prefers the DataForSEO prompt and offers Search Console when neither is available', () => {
      givenStatus(
        status({
          dfs: { configured: false, login: null, balanceUsd: null },
          gsc: { connected: false, siteUrl: null },
        })
      );
      renderGate(
        <SeoGate fallback="any" requires={['dfs', 'gsc']}>
          {CHILD}
        </SeoGate>
      );
      expect(
        screen.getByText('Connect DataForSEO to unlock keyword, ranking and backlink data')
      ).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Connect DataForSEO' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Connect Google Search Console' })).toBeTruthy();
      expect(screen.queryByText('tab content')).toBeNull();
    });

    it('still blocks with fallback="all" when one requirement is missing', () => {
      givenStatus(status({ gsc: { connected: false, siteUrl: null } }));
      renderGate(<SeoGate requires={['dfs', 'gsc']}>{CHILD}</SeoGate>);
      expect(screen.getByText('No Search Console data yet')).toBeTruthy();
    });
  });
});
