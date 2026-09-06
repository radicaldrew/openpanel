import { z } from 'zod';
import { isValidDomainHost, researchScopeSchema } from '../research-scope';

const SCHEME_RE = /^[a-z]+:\/\//;

/**
 * Extract and validate a bare hostname from user input that may be a full URL.
 * Strips protocol, www prefix, path, query-string, and hash.
 */
export function normalizeDomain(input: string): string {
  let d = input.trim().toLowerCase();
  // Ensure URL() can parse the input by adding a protocol if missing
  if (!SCHEME_RE.test(d)) {
    d = `https://${d}`;
  }
  const { hostname } = new URL(d); // throws on truly invalid input
  return hostname.replace(/^www\./, '');
}

/** Zod field: accepts a bare domain or full URL, outputs a clean hostname. */
export const domainField = z
  .string()
  .min(1)
  .max(253)
  .transform((val, ctx) => {
    try {
      const hostname = normalizeDomain(val);
      if (!(hostname.includes('.') && isValidDomainHost(hostname))) {
        ctx.addIssue({ code: 'custom', message: 'Enter a valid domain like example.com' });
        return z.NEVER;
      }
      return hostname;
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid domain like example.com' });
      return z.NEVER;
    }
  });

export const booleanSearchParamSchema = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((value) => value === true || value === 'true');

export const domainOverviewSchema = z.object({
  domain: z.string().min(1, 'Domain is required').max(2048),
  scope: researchScopeSchema.optional(),
  locationCode: z.number().int().positive().optional(),
  languageCode: z.string().min(2).max(8).optional(),
});

export type DomainOverviewInput = z.infer<typeof domainOverviewSchema>;

const domainSortModes = ['rank', 'traffic', 'volume', 'score', 'cpc'] as const;
const domainSortOrders = ['asc', 'desc'] as const;

export const DOMAIN_KEYWORDS_PAGE_SIZES = [50, 100, 200] as const;
export const DEFAULT_DOMAIN_KEYWORDS_PAGE_SIZE = 100;
export const MAX_DATAFORSEO_FILTER_CONDITIONS = 8;

const optionalNumber = z
  .union([
    z.number(),
    z.string().transform((value, ctx) => {
      const trimmed = value.trim();
      if (trimmed === '') {
        return undefined;
      }
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed)) {
        ctx.addIssue({ code: 'custom', message: 'Invalid number' });
        return z.NEVER;
      }
      return parsed;
    }),
  ])
  .optional();

export const domainKeywordsFiltersSchema = z.object({
  include: z.string().optional(),
  exclude: z.string().optional(),
  minTraffic: optionalNumber,
  maxTraffic: optionalNumber,
  minVol: optionalNumber,
  maxVol: optionalNumber,
  minCpc: optionalNumber,
  maxCpc: optionalNumber,
  minKd: optionalNumber,
  maxKd: optionalNumber,
  minRank: optionalNumber,
  maxRank: optionalNumber,
});

export type DomainKeywordsFilters = z.infer<typeof domainKeywordsFiltersSchema>;

const pageSizeField = z
  .number()
  .int()
  .refine((value) => (DOMAIN_KEYWORDS_PAGE_SIZES as readonly number[]).includes(value))
  .default(DEFAULT_DOMAIN_KEYWORDS_PAGE_SIZE);

export const domainKeywordsPageRequestSchema = z.object({
  domain: z.string().min(1).max(2048),
  scope: researchScopeSchema.optional(),
  locationCode: z.number().int().positive().optional(),
  languageCode: z.string().min(2).max(8).optional(),
  page: z.number().int().positive().default(1),
  pageSize: pageSizeField,
  sortMode: z.enum(domainSortModes).default('traffic'),
  sortOrder: z.enum(domainSortOrders).default('desc'),
  filters: domainKeywordsFiltersSchema.default({}),
  search: z.string().optional(),
});

export type DomainKeywordsPageInput = z.infer<typeof domainKeywordsPageRequestSchema>;

const domainPagesSortModes = ['traffic', 'keywords'] as const;

export const domainPagesPageRequestSchema = z.object({
  domain: z.string().min(1).max(2048),
  scope: researchScopeSchema.optional(),
  locationCode: z.number().int().positive().optional(),
  languageCode: z.string().min(2).max(8).optional(),
  page: z.number().int().positive().default(1),
  pageSize: pageSizeField,
  sortMode: z.enum(domainPagesSortModes).default('traffic'),
  sortOrder: z.enum(domainSortOrders).default('desc'),
  filters: domainKeywordsFiltersSchema.default({}),
  search: z.string().optional(),
});

export type DomainPagesPageInput = z.infer<typeof domainPagesPageRequestSchema>;
