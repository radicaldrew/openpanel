import {
  getIsoCountryCode,
  getLanguageOptions,
  isDataForSeoError,
  LOCATION_OPTIONS,
  type LocationOption,
  SERP_LANGUAGE_OPTIONS,
} from '@openpanel/dataforseo';
import {
  getDfsConnection,
  getSeoStatus,
  refreshDfsBalance,
  removeDfsConnection,
  setDfsSpendCap,
  upsertDfsConnection,
  upsertSeoProjectConfig,
  validateDfsCredentials,
} from '@openpanel/db';
import { z } from 'zod';
import { requireOrganizationAdmin, requireProjectAccess } from '../../access';
import { TRPCBadRequestError } from '../../errors';
import { createTRPCRouter, protectedProcedure } from '../../trpc';
import { withSeoErrors } from './errors';

const MIN_SERP_DEPTH = 10;
const MAX_SERP_DEPTH = 100;
const MAX_COMPETITORS = 10;
const DEFAULT_LOCATION_LIMIT = 50;
const MAX_LOCATION_LIMIT = 200;

const zDomain = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, 'Domain is required')
  .max(253)
  .regex(
    /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/,
    'Enter a bare domain such as example.com'
  );

export const zSeoProjectConfigInput = z.object({
  projectId: z.string(),
  domain: zDomain,
  locationCode: z.number().int().positive(),
  languageCode: z.string().trim().min(2).max(8),
  devices: z.enum(['both', 'desktop', 'mobile']),
  serpDepth: z.number().int().min(MIN_SERP_DEPTH).max(MAX_SERP_DEPTH),
  rankSchedule: z.enum(['daily', 'weekly', 'manual']),
  backlinkSchedule: z.enum(['daily', 'weekly', 'manual']),
  competitors: z.array(zDomain).max(MAX_COMPETITORS),
});

export type SeoProjectConfigInput = z.infer<typeof zSeoProjectConfigInput>;

export interface SeoLocationItem {
  code: number;
  name: string;
  shortName: string;
  countryIsoCode: string;
  languageCode: string;
}

function toLocationItem(option: LocationOption): SeoLocationItem {
  return {
    code: option.code,
    name: option.label,
    shortName: option.shortLabel,
    countryIsoCode: getIsoCountryCode(option.code),
    languageCode: option.languageCode,
  };
}

/**
 * Filters the static country list. Matches on label, short label and ISO code
 * so "us", "united" and "states" all find the United States. No DFS call.
 */
export function searchLocations(
  q: string | undefined,
  limit: number
): SeoLocationItem[] {
  const needle = q?.trim().toLowerCase() ?? '';
  const all = LOCATION_OPTIONS.map(toLocationItem);
  if (needle === '') {
    return all.slice(0, limit);
  }
  const startsWith: SeoLocationItem[] = [];
  const contains: SeoLocationItem[] = [];
  for (const item of all) {
    const haystacks = [
      item.name.toLowerCase(),
      item.shortName.toLowerCase(),
      item.countryIsoCode.toLowerCase(),
    ];
    if (haystacks.some((value) => value.startsWith(needle))) {
      startsWith.push(item);
    } else if (haystacks.some((value) => value.includes(needle))) {
      contains.push(item);
    }
  }
  return [...startsWith, ...contains].slice(0, limit);
}

export const seoSettingsRouter = createTRPCRouter({
  getStatus: protectedProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input, ctx }) => {
      await requireProjectAccess({
        userId: ctx.session.userId,
        projectId: input.projectId,
        level: 'read',
      });
      return getSeoStatus(input.projectId);
    }),

  setDfsKey: protectedProcedure
    .input(
      z.object({
        organizationId: z.string(),
        login: z.string().trim().min(1, 'Login is required').max(255),
        password: z.string().min(1, 'Password is required').max(255),
      })
    )
    .mutation(async ({ input, ctx }) => {
      await requireOrganizationAdmin({
        userId: ctx.session.userId,
        organizationId: input.organizationId,
        message: 'Only organization admins can manage the DataForSEO key',
      });

      // Validate before anything is stored so a typo never replaces a
      // working key.
      const account = await withSeoErrors(async () => {
        try {
          return await validateDfsCredentials(input);
        } catch (error) {
          if (isDataForSeoError(error) && error.kind === 'auth') {
            throw new TRPCBadRequestError(
              'DataForSEO rejected this login and password'
            );
          }
          throw error;
        }
      });

      await upsertDfsConnection(input);
      await withSeoErrors(() => refreshDfsBalance(input.organizationId));

      return {
        login: account.login ?? input.login,
        balanceUsd: account.balanceUsd,
      };
    }),

  removeDfsKey: protectedProcedure
    .input(z.object({ organizationId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await requireOrganizationAdmin({
        userId: ctx.session.userId,
        organizationId: input.organizationId,
        message: 'Only organization admins can manage the DataForSEO key',
      });
      await removeDfsConnection(input.organizationId);
      return { success: true };
    }),

  setSpendCap: protectedProcedure
    .input(
      z.object({
        organizationId: z.string(),
        capUsd: z.number().nonnegative().nullable(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      await requireOrganizationAdmin({
        userId: ctx.session.userId,
        organizationId: input.organizationId,
        message: 'Only organization admins can change the spend cap',
      });
      await setDfsSpendCap(input.organizationId, input.capUsd);
      return { capUsd: input.capUsd };
    }),

  /**
   * Re-reads the balance from `appendix/user_data`. Not in the spec's list but
   * the "balance is empty" gate needs a way to recover once the user tops up.
   */
  refreshBalance: protectedProcedure
    .input(z.object({ organizationId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await requireOrganizationAdmin({
        userId: ctx.session.userId,
        organizationId: input.organizationId,
        message: 'Only organization admins can refresh the DataForSEO balance',
      });
      await withSeoErrors(() => refreshDfsBalance(input.organizationId));
      const connection = await getDfsConnection(input.organizationId);
      return {
        balanceUsd: connection?.balanceUsd ?? null,
        balanceAt: connection?.balanceAt?.toISOString() ?? null,
      };
    }),

  upsertProjectConfig: protectedProcedure
    .input(zSeoProjectConfigInput)
    .mutation(async ({ input, ctx }) => {
      await requireProjectAccess({
        userId: ctx.session.userId,
        projectId: input.projectId,
        level: 'write',
      });
      const competitors = Array.from(
        new Set(input.competitors.filter((value) => value !== input.domain))
      );
      return upsertSeoProjectConfig({ ...input, competitors });
    }),

  listLocations: protectedProcedure
    .input(
      z.object({
        q: z.string().max(100).optional(),
        /** Resolve one known code, for showing the current selection. */
        locationCode: z.number().int().optional(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LOCATION_LIMIT)
          .default(DEFAULT_LOCATION_LIMIT),
      })
    )
    .query(({ input }): SeoLocationItem[] => {
      if (input.locationCode !== undefined) {
        const option = LOCATION_OPTIONS.find(
          (candidate: LocationOption) => candidate.code === input.locationCode
        );
        return option ? [toLocationItem(option)] : [];
      }
      return searchLocations(input.q, input.limit);
    }),

  listLanguages: protectedProcedure
    .input(z.object({ locationCode: z.number().int().optional() }).optional())
    .query(({ input }) => {
      // Keyword-data APIs only serve a country's own languages, so once a
      // location is chosen offer just those; the full SERP list otherwise.
      const options =
        input?.locationCode === undefined
          ? SERP_LANGUAGE_OPTIONS
          : getLanguageOptions(input.locationCode);
      return options.map((language) => ({
        code: language.code,
        label: language.label,
      }));
    }),
});
