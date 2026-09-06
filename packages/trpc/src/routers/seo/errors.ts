import { isDataForSeoError } from '@openpanel/dataforseo';
import { DfsNotConfiguredError, SeoConfigMissingError } from '@openpanel/db';
import { TRPCError } from '@trpc/server';

/**
 * Stable machine-readable reasons. The client cannot read `cause` (it is not
 * serialized), so the same code is also embedded as the message prefix;
 * `getSeoErrorCode` on the client side can split it back out.
 */
export const SEO_ERROR_CODES = {
  DFS_NOT_CONFIGURED: 'DFS_NOT_CONFIGURED',
  DFS_NO_BALANCE: 'DFS_NO_BALANCE',
  DFS_INVALID_CREDENTIALS: 'DFS_INVALID_CREDENTIALS',
  SEO_CONFIG_MISSING: 'SEO_CONFIG_MISSING',
} as const;

export type SeoErrorCode =
  (typeof SEO_ERROR_CODES)[keyof typeof SEO_ERROR_CODES];

/** DataForSEO status codes that mean "the account has no money". */
const DFS_NO_BALANCE_STATUS_CODES = new Set([40_200, 40_201]);

export class SeoPreconditionError extends TRPCError {
  readonly seoCode: SeoErrorCode;

  constructor(seoCode: SeoErrorCode, message: string, cause?: unknown) {
    super({
      code: 'PRECONDITION_FAILED',
      message: `${seoCode}: ${message}`,
      cause: cause ?? new Error(seoCode),
    });
    this.seoCode = seoCode;
  }
}

/**
 * Translate DataForSEO failures into TRPC errors the dashboard can act on.
 * Anything not recognised is rethrown untouched so tRPC reports it as an
 * internal error with the original stack.
 */
export function toSeoTrpcError(error: unknown): unknown {
  if (error instanceof TRPCError) {
    return error;
  }

  if (error instanceof DfsNotConfiguredError) {
    return new SeoPreconditionError(
      SEO_ERROR_CODES.DFS_NOT_CONFIGURED,
      'DataForSEO is not connected for this organization',
      error
    );
  }

  if (error instanceof SeoConfigMissingError) {
    return new SeoPreconditionError(
      SEO_ERROR_CODES.SEO_CONFIG_MISSING,
      'Set a domain, location and language for this project first',
      error
    );
  }

  if (isDataForSeoError(error)) {
    const noBalance =
      error.kind === 'billing' ||
      (error.dfsStatusCode !== undefined &&
        DFS_NO_BALANCE_STATUS_CODES.has(error.dfsStatusCode));

    if (noBalance) {
      return new SeoPreconditionError(
        SEO_ERROR_CODES.DFS_NO_BALANCE,
        'The DataForSEO account has no remaining balance',
        error
      );
    }

    if (error.kind === 'auth') {
      return new TRPCError({
        code: 'UNAUTHORIZED',
        message: `${SEO_ERROR_CODES.DFS_INVALID_CREDENTIALS}: DataForSEO rejected the stored login or password`,
        cause: error,
      });
    }

    if (error.kind === 'rate_limited') {
      return new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'DataForSEO rate limit reached, try again shortly',
        cause: error,
      });
    }

    if (error.kind === 'timeout' || error.kind === 'upstream') {
      return new TRPCError({
        code: 'BAD_GATEWAY',
        message: `DataForSEO did not respond (${error.path})`,
        cause: error,
      });
    }

    return new TRPCError({
      code: 'BAD_REQUEST',
      message: error.message,
      cause: error,
    });
  }

  return error;
}

/**
 * Wrap any resolver body that talks to DataForSEO:
 *
 *   .query(({ input }) => withSeoErrors(() => doWork(input)))
 */
export async function withSeoErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw toSeoTrpcError(error);
  }
}
