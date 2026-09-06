import {
  createDataforseoClient,
  type DataforseoClient,
} from '@openpanel/dataforseo';
import { createLogger } from '@openpanel/logger';
import { getRedisCache } from '@openpanel/redis';
import { decrypt } from '../encryption';
import { db } from '../prisma-client';

const logger = createLogger({ name: 'db:seo' });

/**
 * Thrown when an organization has no DataForSEO key and no
 * DATAFORSEO_DEFAULT_KEY fallback exists. Routers translate this to
 * PRECONDITION_FAILED so the UI can show the "connect DataForSEO" state.
 */
export class DfsNotConfiguredError extends Error {
  readonly code = 'DFS_NOT_CONFIGURED' as const;
  readonly organizationId: string;

  constructor(organizationId: string) {
    super(
      `DataForSEO is not configured for organization ${organizationId}. Add a key under Settings → DataForSEO.`
    );
    this.name = 'DfsNotConfiguredError';
    this.organizationId = organizationId;
  }
}

export function isDfsNotConfiguredError(
  error: unknown
): error is DfsNotConfiguredError {
  return error instanceof DfsNotConfiguredError;
}

/** Redis key holding spend not yet flushed to Postgres (SEO.md §10). */
export const seoSpendKey = (organizationId: string) =>
  `seo:spend:${organizationId}`;
const SEO_SPEND_KEY_PATTERN = 'seo:spend:*';
const SEO_SPEND_KEY_PREFIX = 'seo:spend:';
// Below this the counter is float noise left over from `INCRBYFLOAT -x`.
const SPEND_EPSILON = 1e-9;

export function encodeDfsApiKey(login: string, password: string): string {
  return Buffer.from(`${login}:${password}`, 'utf8').toString('base64');
}

/**
 * DATAFORSEO_DEFAULT_KEY may be given either as DFS expects it
 * (base64 of `login:password`) or as the raw `login:password`; the latter is
 * what people paste from the DFS dashboard, so accept both.
 */
function normalizeEnvKey(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.includes(':')
    ? Buffer.from(trimmed, 'utf8').toString('base64')
    : trimmed;
}

export type DfsKeySource = 'organization' | 'env';

export async function resolveDfsApiKey(
  organizationId: string
): Promise<{ apiKey: string; source: DfsKeySource }> {
  const conn = await db.dataForSeoConnection.findUnique({
    where: { organizationId },
    select: { apiKeyEnc: true },
  });
  if (conn) {
    return { apiKey: decrypt(conn.apiKeyEnc), source: 'organization' };
  }

  const envKey = process.env.DATAFORSEO_DEFAULT_KEY;
  if (envKey?.trim()) {
    return { apiKey: normalizeEnvKey(envKey), source: 'env' };
  }

  throw new DfsNotConfiguredError(organizationId);
}

/**
 * Every DFS envelope carries a `cost`; the client's onCost hook lands it here.
 * Redis rather than a Postgres UPDATE per call because a rank run makes
 * hundreds of calls; flushSpendToPostgres() moves the total across.
 */
export async function recordDfsSpend(
  organizationId: string,
  costUsd: number
): Promise<void> {
  if (!(costUsd > 0)) {
    return;
  }
  await getRedisCache().incrbyfloat(seoSpendKey(organizationId), costUsd);
}

/** Spend recorded in Redis but not yet flushed to Postgres. */
export async function getPendingDfsSpend(
  organizationId: string
): Promise<number> {
  const raw = await getRedisCache().get(seoSpendKey(organizationId));
  const value = raw ? Number.parseFloat(raw) : 0;
  return Number.isFinite(value) && value > SPEND_EPSILON ? value : 0;
}

export function createDfsClientForOrganization({
  organizationId,
  apiKey,
}: {
  organizationId: string;
  apiKey: string;
}): DataforseoClient {
  return createDataforseoClient({
    apiKey,
    onCost: (_path: string, costUsd: number) =>
      recordDfsSpend(organizationId, costUsd),
  });
}

export async function getDfsClientForOrganization(
  organizationId: string
): Promise<DataforseoClient> {
  const { apiKey } = await resolveDfsApiKey(organizationId);
  return createDfsClientForOrganization({ organizationId, apiKey });
}

export async function getProjectOrganizationId(
  projectId: string
): Promise<string> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { organizationId: true },
  });
  if (!project) {
    throw new Error(`Project ${projectId} not found`);
  }
  return project.organizationId;
}

export async function getDfsClientForProject(
  projectId: string
): Promise<DataforseoClient> {
  const organizationId = await getProjectOrganizationId(projectId);
  return getDfsClientForOrganization(organizationId);
}

/**
 * Whether the org's monthly spend (flushed + pending) has hit its cap. Orgs
 * without a connection row (env key) or without a cap never hit it.
 */
export async function isDfsSpendCapReached(
  organizationId: string
): Promise<boolean> {
  const conn = await db.dataForSeoConnection.findUnique({
    where: { organizationId },
    select: { monthlySpendUsd: true, spendCapUsd: true },
  });
  if (!conn || conn.spendCapUsd === null) {
    return false;
  }
  const pending = await getPendingDfsSpend(organizationId);
  return conn.monthlySpendUsd + pending >= conn.spendCapUsd;
}

async function scanSpendKeys(): Promise<string[]> {
  const redis = getRedisCache();
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(
      cursor,
      'MATCH',
      SEO_SPEND_KEY_PATTERN,
      'COUNT',
      100
    );
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');
  return keys;
}

/**
 * Move the Redis spend counters into DataForSeoConnection.monthlySpendUsd.
 *
 * Reads the counter, adds it to Postgres, then subtracts exactly what was
 * read (not DEL): cost recorded between the read and the subtract survives
 * for the next flush, and a crash after the read loses nothing because the
 * counter was not touched yet. Double counting is only possible if the
 * Postgres write succeeded and the subtract failed, which is the failure
 * direction we prefer for a soft cap.
 *
 * An org using DATAFORSEO_DEFAULT_KEY has no connection row and so no place
 * to keep a monthly total; its counter is dropped with a log line.
 */
export async function flushSpendToPostgres(): Promise<{
  flushed: number;
  totalUsd: number;
}> {
  const redis = getRedisCache();
  const keys = await scanSpendKeys();
  let flushed = 0;
  let totalUsd = 0;

  for (const key of keys) {
    const raw = await redis.get(key);
    const amount = raw ? Number.parseFloat(raw) : 0;
    if (!Number.isFinite(amount) || amount <= SPEND_EPSILON) {
      await redis.del(key);
      continue;
    }

    const organizationId = key.slice(SEO_SPEND_KEY_PREFIX.length);
    const result = await db.dataForSeoConnection.updateMany({
      where: { organizationId },
      data: { monthlySpendUsd: { increment: amount } },
    });

    const remaining = Number.parseFloat(await redis.incrbyfloat(key, -amount));
    if (!(remaining > SPEND_EPSILON)) {
      await redis.del(key);
    }

    if (result.count > 0) {
      flushed += 1;
      totalUsd += amount;
    } else {
      logger.debug(
        { organizationId, amount },
        'DFS spend dropped: organization has no connection row'
      );
    }
  }

  return { flushed, totalUsd };
}
