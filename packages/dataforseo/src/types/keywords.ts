import { z } from 'zod';

export type KeywordIntent =
  | 'informational'
  | 'commercial'
  | 'transactional'
  | 'navigational'
  | 'unknown';

export const monthlySearchSchema = z.object({
  year: z.number().int().positive(),
  month: z.number().int().min(1).max(12),
  searchVolume: z.number().int().nonnegative(),
});

export type MonthlySearch = z.infer<typeof monthlySearchSchema>;

export const keywordModeSchema = z.enum(['auto', 'related', 'suggestions', 'ideas']);
export type KeywordMode = z.infer<typeof keywordModeSchema>;

export const researchKeywordsSchema = z.object({
  keywords: z.array(z.string().min(1)).min(1).max(200),
  locationCode: z.number().int().positive().optional(),
  languageCode: z.string().min(2).max(8).optional(),
  resultLimit: z.union([z.literal(150), z.literal(300), z.literal(500)]).default(150),
  mode: keywordModeSchema.optional().default('auto'),
  // Clickstream-refined volumes double the DataForSEO request cost; opt-in.
  clickstream: z.boolean().optional().default(false),
});

export type ResearchKeywordsInput = z.infer<typeof researchKeywordsSchema>;

export const savedKeywordMetricSchema = z.object({
  keyword: z.string().min(1),
  searchVolume: z.number().int().nonnegative().nullable().optional(),
  cpc: z.number().nonnegative().nullable().optional(),
  competition: z.number().min(0).max(1).nullable().optional(),
  keywordDifficulty: z.number().int().min(0).max(100).nullable().optional(),
  intent: z
    .enum(['informational', 'commercial', 'transactional', 'navigational', 'unknown'])
    .nullable()
    .optional(),
  monthlySearches: z.array(monthlySearchSchema).optional(),
});

export type SavedKeywordMetric = z.infer<typeof savedKeywordMetricSchema>;

export const serpAnalysisSchema = z.object({
  keyword: z.string().min(1),
  locationCode: z.number().int().positive().optional(),
  languageCode: z.string().min(2).max(8).optional(),
  // Only two depths: the default top-20 snapshot, and the full 100 a SERP
  // panel buys when a user pages past the loaded results. Each 10 of depth is
  // another crawled Google page.
  depth: z.union([z.literal(20), z.literal(100)]).default(20),
});

export type SerpAnalysisInput = z.infer<typeof serpAnalysisSchema>;
