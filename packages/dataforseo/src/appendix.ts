import type { DataforseoTransport } from './core';
import {
  assertOk,
  buildFreeTaskBilling,
  type DataforseoApiResponse,
  type DataforseoTaskLike,
} from './envelope';

const USER_DATA_PATH = '/v3/appendix/user_data';

export interface DataforseoUserDataMoney {
  /** Lifetime deposited, USD. */
  total?: number | null;
  /** Remaining balance, USD. */
  balance?: number | null;
  /** Spend grouped by function under `total_<function>` keys. */
  statistics?: {
    day?: Record<string, unknown> | null;
    minute?: Record<string, unknown> | null;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

/**
 * Account snapshot from the free GET /v3/appendix/user_data. Every field is
 * optional on the wire.
 */
export interface DataforseoUserData {
  login?: string | null;
  timezone?: string | null;
  rates?: Record<string, unknown> | null;
  money?: DataforseoUserDataMoney | null;
  [key: string]: unknown;
}

/**
 * Reads account spend + balance. This is the standard, non-billable way to
 * inspect an account, and doubles as key validation: a wrong key rejects with
 * a DataForSeoError of kind `auth`.
 */
export async function fetchUserData(
  transport: DataforseoTransport,
): Promise<DataforseoApiResponse<DataforseoUserData | undefined>> {
  const response = await transport.get<
    DataforseoTaskLike & { result?: DataforseoUserData[] }
  >(USER_DATA_PATH);
  const task = assertOk(response, { path: USER_DATA_PATH });
  return {
    data: task.result?.[0],
    billing: buildFreeTaskBilling(task, USER_DATA_PATH),
  };
}
