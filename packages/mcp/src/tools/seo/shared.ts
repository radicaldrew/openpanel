import {
  isDfsNotConfiguredError,
  SeoConfigMissingError,
} from '@openpanel/db';
import type { McpAuthContext } from '../../auth';
import { withErrorHandling } from '../shared';

/** A daily series longer than this stops being readable and starts being noise. */
export const MAX_SERIES_POINTS = 180;

const DFS_SETTINGS_PATH = 'Settings → DataForSEO';

/**
 * Only root clients may spend the organization's DataForSEO balance or change
 * tracking state; read clients are scoped to one project and read-only.
 */
export function requireWriteScope(context: McpAuthContext, action: string): void {
  if (context.clientType !== 'root') {
    throw new Error(
      `${action} requires a root (write-scoped) MCP client; this client is read-only. Create a root client under Settings → Clients or ask an organization admin to run it.`
    );
  }
}

/**
 * The DataForSEO error class lives in @openpanel/dataforseo, which this
 * package does not depend on; the two classes are recognised by shape.
 */
function asDataForSeoError(
  error: unknown
): { kind: string; message: string; dfsStatusCode?: number; path?: string } | null {
  if (
    error instanceof Error &&
    (error.name === 'DataForSeoError' || error.name === 'DataForSeoChargedTaskError') &&
    typeof (error as { kind?: unknown }).kind === 'string'
  ) {
    return error as Error & { kind: string; dfsStatusCode?: number; path?: string };
  }
  return null;
}

/**
 * Turn the SEO module's failure classes into messages an agent can act on:
 * what is missing and where in the app to fix it.
 */
export function describeSeoError(error: unknown): string | null {
  if (isDfsNotConfiguredError(error)) {
    return `DataForSEO is not connected for this organization. Add the DataForSEO login and password under ${DFS_SETTINGS_PATH}; it unlocks keyword research, rank tracking, backlinks, site audits and AI visibility for every project.`;
  }
  if (error instanceof SeoConfigMissingError) {
    return `This project has no SEO configuration yet. Set the domain to track, the target country and language under ${DFS_SETTINGS_PATH} (project section), or open any SEO tab in the dashboard to fill in the form.`;
  }
  const dfs = asDataForSeoError(error);
  if (!dfs) {
    return null;
  }
  switch (dfs.kind) {
    case 'billing':
      return `The connected DataForSEO account has no remaining balance (DataForSEO ${dfs.dfsStatusCode ?? 'billing'}). Top up at app.dataforseo.com/billing, then refresh the balance under ${DFS_SETTINGS_PATH}.`;
    case 'auth':
      return `DataForSEO rejected the stored login or password. Re-enter the credentials under ${DFS_SETTINGS_PATH}.`;
    case 'rate_limited':
      return 'DataForSEO rate limit reached. Wait a moment and try again.';
    case 'timeout':
    case 'upstream':
      return `DataForSEO did not respond (${dfs.path ?? 'unknown endpoint'}). This is a provider-side problem; try again in a minute.`;
    case 'validation':
      return `Invalid request to DataForSEO: ${dfs.message}`;
    default:
      return `DataForSEO error: ${dfs.message}`;
  }
}

/**
 * `withErrorHandling` for SEO tools: the same MCP error envelope, with the
 * module's failure classes rewritten into actionable text first.
 */
export function withSeoErrorHandling<T>(fn: () => Promise<T>) {
  return withErrorHandling(async () => {
    try {
      return await fn();
    } catch (error) {
      const described = describeSeoError(error);
      throw described ? new Error(described) : error;
    }
  });
}

/** Keep the most recent points of an over-long daily series. */
export function recentSeries<T>(points: readonly T[]): { points: T[]; note?: string } {
  if (points.length <= MAX_SERIES_POINTS) {
    return { points: [...points] };
  }
  return {
    points: points.slice(points.length - MAX_SERIES_POINTS),
    note: `Showing the most recent ${MAX_SERIES_POINTS} of ${points.length} days. Use a shorter range for full coverage.`,
  };
}

export function round(value: number | null | undefined, digits = 2): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
