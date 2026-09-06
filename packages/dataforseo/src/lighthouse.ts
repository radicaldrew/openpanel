import type { DataforseoTransport } from './core';
import { assertOk, buildTaskBilling, type DataforseoApiResponse } from './envelope';
import { DataForSeoChargedTaskError } from './errors';
import {
  LIGHTHOUSE_REQUEST_CATEGORIES,
  type LighthouseStrategy,
  parseDataforseoLighthousePayload,
  type StoredLighthousePayload,
} from './lighthouse-payload';

export const LIGHTHOUSE_REQUEST_PATH = '/v3/on_page/lighthouse/live/json';
// Lighthouse runs take tens of seconds and the JSON report is 1-10MB.
const LIGHTHOUSE_TIMEOUT_MS = 120_000;

/**
 * Runs a live Lighthouse audit and reduces the multi-MB report to the compact
 * stored payload. Billed and non-idempotent: a 5xx does not prove the provider
 * skipped the charge, so the call is never replayed.
 */
export async function fetchLighthouseResult(
  transport: DataforseoTransport,
  input: {
    url: string;
    strategy: LighthouseStrategy;
  },
): Promise<DataforseoApiResponse<StoredLighthousePayload>> {
  const body = await transport.post(
    LIGHTHOUSE_REQUEST_PATH,
    [
      {
        url: input.url,
        for_mobile: input.strategy === 'mobile',
        categories: [...LIGHTHOUSE_REQUEST_CATEGORIES],
      },
    ],
    { maxServerErrorRetries: 0, timeoutMs: LIGHTHOUSE_TIMEOUT_MS },
  );

  // Build the billing envelope before parsing. The provider has already
  // charged a successful task, so a malformed payload must carry its billing
  // metadata out to the caller instead of looking retryable.
  const task = assertOk(body, { path: LIGHTHOUSE_REQUEST_PATH });
  const billing = buildTaskBilling(task);
  try {
    const data = parseDataforseoLighthousePayload(body, input);
    return { data, billing };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DataForSeoChargedTaskError(message, billing, {
      kind: 'invalid_response',
      path: LIGHTHOUSE_REQUEST_PATH,
      cause: error,
    });
  }
}
