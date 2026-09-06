import { db } from '../prisma-client';
import { getPendingDfsSpend } from './client';
import type { SeoDevices, SeoSchedule } from './schedule';

/**
 * Everything the SEO shell needs to decide which gate to show. The shape is
 * shared with apps/start (SEO.md §8.2); change it only together with the UI.
 */
export interface SeoStatus {
  dfs: {
    configured: boolean;
    login: string | null;
    balanceUsd: number | null;
    balanceAt: string | null;
    monthlySpendUsd: number;
    spendCapUsd: number | null;
    lastError: string | null;
  };
  gsc: { connected: boolean; siteUrl: string | null };
  config: {
    domain: string;
    locationCode: number;
    languageCode: string;
    devices: SeoDevices;
    serpDepth: number;
    rankSchedule: SeoSchedule;
    backlinkSchedule: SeoSchedule;
    competitors: string[];
  } | null;
}

function asDevices(value: string): SeoDevices {
  return value === 'desktop' || value === 'mobile' ? value : 'both';
}

function asSchedule(value: string): SeoSchedule {
  return value === 'daily' || value === 'weekly' ? value : 'manual';
}

export function hasDefaultDfsKey(): boolean {
  return Boolean(process.env.DATAFORSEO_DEFAULT_KEY?.trim());
}

export async function getSeoStatus(projectId: string): Promise<SeoStatus> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: {
      organizationId: true,
      gscConnection: { select: { siteUrl: true } },
      seoConfig: true,
      organization: {
        select: {
          dataForSeoConnection: {
            select: {
              login: true,
              balanceUsd: true,
              balanceAt: true,
              monthlySpendUsd: true,
              spendCapUsd: true,
              lastError: true,
            },
          },
        },
      },
    },
  });
  if (!project) {
    throw new Error(`Project ${projectId} not found`);
  }

  const conn = project.organization.dataForSeoConnection;
  // Spend the client has recorded in Redis but the cron has not yet flushed;
  // without it the 80 % banner lags the flush interval.
  const pendingSpend = conn
    ? await getPendingDfsSpend(project.organizationId)
    : 0;

  const siteUrl = project.gscConnection?.siteUrl || null;
  const config = project.seoConfig;

  return {
    dfs: {
      configured: Boolean(conn) || hasDefaultDfsKey(),
      login: conn?.login ?? null,
      balanceUsd: conn?.balanceUsd ?? null,
      balanceAt: conn?.balanceAt?.toISOString() ?? null,
      monthlySpendUsd: (conn?.monthlySpendUsd ?? 0) + pendingSpend,
      spendCapUsd: conn?.spendCapUsd ?? null,
      lastError: conn?.lastError ?? null,
    },
    gsc: { connected: siteUrl !== null, siteUrl },
    config: config
      ? {
          domain: config.domain,
          locationCode: config.locationCode,
          languageCode: config.languageCode,
          devices: asDevices(config.devices),
          serpDepth: config.serpDepth,
          rankSchedule: asSchedule(config.rankSchedule),
          backlinkSchedule: asSchedule(config.backlinkSchedule),
          competitors: config.competitors,
        }
      : null,
  };
}
