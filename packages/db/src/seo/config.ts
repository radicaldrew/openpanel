import { z } from 'zod';
import type { SeoProjectConfig } from '../generated/prisma/client';
import { db } from '../prisma-client';
import {
  nextRunAtForScheduleChange,
  seoDevicesSchema,
  seoScheduleSchema,
} from './schedule';

const GSC_DOMAIN_PROPERTY_PREFIX = 'sc-domain:';
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
const MIN_SERP_DEPTH = 10;
const MAX_SERP_DEPTH = 100;

/**
 * "example.com" from a Search Console property.
 *
 * GSC has two property kinds: domain properties (`sc-domain:example.com`)
 * and URL-prefix properties (`https://www.example.com/`). Both reduce to a
 * host: strip the `sc-domain:` prefix, the scheme, anything after the host
 * (a URL-prefix property may carry a path) and the trailing slash. `www.` is
 * kept — a URL-prefix property on `www.` is a statement about that host.
 */
export function deriveDomainFromGscSiteUrl(
  siteUrl: string | null | undefined
): string | null {
  if (!siteUrl) {
    return null;
  }
  let value = siteUrl.trim();
  if (value.toLowerCase().startsWith(GSC_DOMAIN_PROPERTY_PREFIX)) {
    value = value.slice(GSC_DOMAIN_PROPERTY_PREFIX.length);
  }
  value = value.replace(SCHEME_PATTERN, '');
  const slash = value.indexOf('/');
  if (slash !== -1) {
    value = value.slice(0, slash);
  }
  value = value.replace(/\.+$/, '').toLowerCase();
  return value.length > 0 ? value : null;
}

/** User-entered domains get the same treatment so both paths agree. */
export function normalizeSeoDomain(domain: string): string | null {
  return deriveDomainFromGscSiteUrl(domain);
}

export const upsertSeoProjectConfigSchema = z.object({
  projectId: z.string().min(1),
  domain: z.string().trim().min(1).optional(),
  locationCode: z.number().int().positive().optional(),
  languageCode: z.string().trim().min(2).max(10).optional(),
  devices: seoDevicesSchema.optional(),
  serpDepth: z.number().int().min(MIN_SERP_DEPTH).max(MAX_SERP_DEPTH).optional(),
  rankSchedule: seoScheduleSchema.optional(),
  backlinkSchedule: seoScheduleSchema.optional(),
  competitors: z.array(z.string().trim().min(1)).max(20).optional(),
});
export type UpsertSeoProjectConfigInput = z.infer<
  typeof upsertSeoProjectConfigSchema
>;

export async function getSeoProjectConfig(
  projectId: string
): Promise<SeoProjectConfig | null> {
  return db.seoProjectConfig.findUnique({ where: { projectId } });
}

async function getGscDerivedDomain(projectId: string): Promise<string | null> {
  const gsc = await db.gscConnection.findUnique({
    where: { projectId },
    select: { siteUrl: true },
  });
  return deriveDomainFromGscSiteUrl(gsc?.siteUrl);
}

function normalizeCompetitors(competitors: string[]): string[] {
  const seen = new Set<string>();
  for (const raw of competitors) {
    const domain = normalizeSeoDomain(raw);
    if (domain) {
      seen.add(domain);
    }
  }
  return [...seen];
}

/**
 * Create or update a project's SEO settings. On create the domain defaults
 * to the project's GSC property when one is connected; otherwise it must be
 * given. Schedule changes move the next-run pointer (see schedule.ts) so
 * the cron schedulers pick the project up on their next tick.
 */
export async function upsertSeoProjectConfig(
  rawInput: UpsertSeoProjectConfigInput
): Promise<SeoProjectConfig> {
  const input = upsertSeoProjectConfigSchema.parse(rawInput);
  const { projectId } = input;
  const now = new Date();

  const explicitDomain =
    input.domain === undefined ? undefined : normalizeSeoDomain(input.domain);
  if (explicitDomain === null) {
    throw new Error(`"${input.domain}" is not a valid domain`);
  }

  const competitors =
    input.competitors === undefined
      ? undefined
      : normalizeCompetitors(input.competitors);

  const existing = await db.seoProjectConfig.findUnique({
    where: { projectId },
  });

  if (!existing) {
    const domain = explicitDomain ?? (await getGscDerivedDomain(projectId));
    if (!domain) {
      throw new Error(
        'A domain is required: connect Search Console or enter one'
      );
    }
    const rankSchedule = input.rankSchedule ?? 'daily';
    const backlinkSchedule = input.backlinkSchedule ?? 'weekly';

    return db.seoProjectConfig.create({
      data: {
        projectId,
        domain,
        locationCode: input.locationCode,
        languageCode: input.languageCode,
        devices: input.devices,
        serpDepth: input.serpDepth,
        rankSchedule,
        rankNextRunAt: nextRunAtForScheduleChange({
          previous: null,
          next: rankSchedule,
          currentNextRunAt: null,
          now,
        }),
        backlinkSchedule,
        backlinkNextRunAt: nextRunAtForScheduleChange({
          previous: null,
          next: backlinkSchedule,
          currentNextRunAt: null,
          now,
        }),
        competitors: competitors ?? [],
      },
    });
  }

  const rankSchedule = input.rankSchedule ?? existing.rankSchedule;
  const backlinkSchedule = input.backlinkSchedule ?? existing.backlinkSchedule;

  return db.seoProjectConfig.update({
    where: { projectId },
    data: {
      domain: explicitDomain,
      locationCode: input.locationCode,
      languageCode: input.languageCode,
      devices: input.devices,
      serpDepth: input.serpDepth,
      rankSchedule,
      rankNextRunAt: nextRunAtForScheduleChange({
        previous: existing.rankSchedule,
        next: rankSchedule,
        currentNextRunAt: existing.rankNextRunAt,
        now,
      }),
      backlinkSchedule,
      backlinkNextRunAt: nextRunAtForScheduleChange({
        previous: existing.backlinkSchedule,
        next: backlinkSchedule,
        currentNextRunAt: existing.backlinkNextRunAt,
        now,
      }),
      competitors,
    },
  });
}
