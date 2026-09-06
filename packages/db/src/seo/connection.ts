import { encrypt } from '../encryption';
import type { DataForSeoConnection } from '../generated/prisma/client';
import { db } from '../prisma-client';
import {
  createDfsClientForOrganization,
  DfsNotConfiguredError,
  encodeDfsApiKey,
  getDfsClientForOrganization,
} from './client';

/** A connection as it may leave the db package: never the encrypted key. */
export type DfsConnection = Omit<DataForSeoConnection, 'apiKeyEnc'>;

const publicConnectionSelect = {
  id: true,
  organizationId: true,
  login: true,
  balanceUsd: true,
  balanceAt: true,
  lastError: true,
  monthlySpendUsd: true,
  spendCapUsd: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function getDfsConnection(
  organizationId: string
): Promise<DfsConnection | null> {
  return db.dataForSeoConnection.findUnique({
    where: { organizationId },
    select: publicConnectionSelect,
  });
}

/**
 * Store (or replace) an org's DFS credentials. Validating them against
 * appendix/user_data is the caller's job — see validateDfsCredentials — so a
 * router can decide whether a failing key is still worth saving.
 */
export async function upsertDfsConnection({
  organizationId,
  login,
  password,
}: {
  organizationId: string;
  login: string;
  password: string;
}): Promise<DfsConnection> {
  const trimmedLogin = login.trim();
  if (!(trimmedLogin && password)) {
    throw new Error('DataForSEO login and password are required');
  }
  const apiKeyEnc = encrypt(encodeDfsApiKey(trimmedLogin, password));

  return db.dataForSeoConnection.upsert({
    where: { organizationId },
    create: { organizationId, login: trimmedLogin, apiKeyEnc },
    // A new key starts clean: the balance and error belonged to the old one.
    update: {
      login: trimmedLogin,
      apiKeyEnc,
      balanceUsd: null,
      balanceAt: null,
      lastError: null,
    },
    select: publicConnectionSelect,
  });
}

export async function removeDfsConnection(
  organizationId: string
): Promise<{ removed: boolean }> {
  const result = await db.dataForSeoConnection.deleteMany({
    where: { organizationId },
  });
  return { removed: result.count > 0 };
}

export async function setDfsSpendCap(
  organizationId: string,
  capUsd: number | null
): Promise<DfsConnection> {
  if (capUsd !== null && !(Number.isFinite(capUsd) && capUsd >= 0)) {
    throw new Error('Spend cap must be a non-negative number or null');
  }
  const existing = await db.dataForSeoConnection.findUnique({
    where: { organizationId },
    select: { id: true },
  });
  if (!existing) {
    throw new DfsNotConfiguredError(organizationId);
  }
  return db.dataForSeoConnection.update({
    where: { organizationId },
    data: { spendCapUsd: capUsd },
    select: publicConnectionSelect,
  });
}

export interface DfsAccountInfo {
  login: string | null;
  balanceUsd: number | null;
}

/**
 * Check raw credentials against appendix/user_data without storing them.
 * Throws the package's DataForSeoError (kind 'auth' for a bad key). Spend
 * from the call (none — the endpoint is free) is attributed to the org.
 */
export async function validateDfsCredentials({
  organizationId,
  login,
  password,
}: {
  organizationId: string;
  login: string;
  password: string;
}): Promise<DfsAccountInfo> {
  const client = createDfsClientForOrganization({
    organizationId,
    apiKey: encodeDfsApiKey(login.trim(), password),
  });
  const { data } = await client.appendix.userData();
  return {
    login: data?.login ?? null,
    balanceUsd: data?.money?.balance ?? null,
  };
}

/**
 * Pull the current balance from appendix/user_data onto the connection row.
 * Records the failure on the row and rethrows, so the daily cron can log per
 * org while the settings page still sees why the key stopped working.
 */
export async function refreshDfsBalance(organizationId: string): Promise<{
  balanceUsd: number | null;
  balanceAt: Date;
}> {
  const existing = await db.dataForSeoConnection.findUnique({
    where: { organizationId },
    select: { id: true },
  });
  if (!existing) {
    throw new DfsNotConfiguredError(organizationId);
  }

  try {
    const client = await getDfsClientForOrganization(organizationId);
    const { data } = await client.appendix.userData();
    const balanceUsd = data?.money?.balance ?? null;
    const balanceAt = new Date();
    await db.dataForSeoConnection.update({
      where: { organizationId },
      data: { balanceUsd, balanceAt, lastError: null },
    });
    return { balanceUsd, balanceAt };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.dataForSeoConnection.update({
      where: { organizationId },
      data: { lastError: message },
    });
    throw error;
  }
}
