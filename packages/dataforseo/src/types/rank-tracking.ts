import { z } from 'zod';
import { isSupportedLanguageCode } from '../locations';
import { domainField } from './domain';

/** Maximum length of a single tracked keyword. */
const MAX_TRACKED_KEYWORD_LENGTH = 200;

export type RankCheckTriggerResult =
  | { ok: true; runId: string }
  | { ok: false; reason: 'already_running'; blockingRunId: string | null };

export interface RankTrackingDeviceResult {
  position: number | null;
  previousPosition: number | null;
  rankingUrl: string | null;
  serpFeatures: string[];
}

export interface RankTrackingRow {
  trackingKeywordId: string;
  keyword: string;
  searchVolume: number | null;
  keywordDifficulty: number | null;
  cpc: number | null;
  desktop: RankTrackingDeviceResult;
  mobile: RankTrackingDeviceResult;
}

export const rankTrackingDevicesSchema = z.enum(['both', 'desktop', 'mobile']);
export type RankTrackingDevices = z.infer<typeof rankTrackingDevicesSchema>;
export type RankTrackingDevice = 'desktop' | 'mobile';

export const rankTrackingScheduleSchema = z.enum(['daily', 'weekly', 'manual']);
export type RankTrackingSchedule = z.infer<typeof rankTrackingScheduleSchema>;

/** DataForSEO crawls SERPs in pages of 10; 10-100 in steps of 10. */
export const serpDepthSchema = z.number().int().min(10).max(100).multipleOf(10);

// Rank tracking runs against the SERP API, which serves any language in any
// country — but an unknown code is a *charged* DataForSEO failure, so reject
// it here at cost 0.
const languageCodeField = z
  .string()
  .max(10)
  .refine(isSupportedLanguageCode, 'Unsupported language code');

export const rankTrackingConfigSchema = z.object({
  domain: domainField,
  locationCode: z.number().int().positive().optional(),
  languageCode: languageCodeField.optional(),
  locationName: z.string().min(1).max(200).optional(),
  devices: rankTrackingDevicesSchema.optional(),
  serpDepth: serpDepthSchema,
  scheduleInterval: rankTrackingScheduleSchema.optional(),
});

export type RankTrackingConfigInput = z.infer<typeof rankTrackingConfigSchema>;

export const trackedKeywordSchema = z.string().min(1).max(MAX_TRACKED_KEYWORD_LENGTH);
export const trackedKeywordsSchema = z.array(trackedKeywordSchema).min(1).max(2000);
