import { z } from 'zod';
import { summarizeIssues } from './envelope';

export const LIGHTHOUSE_CATEGORIES = [
  'performance',
  'accessibility',
  'best-practices',
  'seo',
] as const;

export type LighthouseCategory = (typeof LIGHTHOUSE_CATEGORIES)[number];

/** Category ids as DataForSEO's request field spells them. */
export const LIGHTHOUSE_REQUEST_CATEGORIES = [
  'performance',
  'accessibility',
  'best_practices',
  'seo',
] as const;

export type LighthouseStrategy = 'mobile' | 'desktop';

export interface RawLighthouseAudit {
  title?: string;
  description?: string;
  score?: number | null;
  scoreDisplayMode?: string;
  displayValue?: string;
  numericValue?: number;
  details?: {
    overallSavingsMs?: number;
    overallSavingsBytes?: number;
    /** Newer "insight" audits report a single object instead of a list. */
    items?: Record<string, unknown>[] | Record<string, unknown>;
  };
}

export interface RawLighthouseCategory {
  score?: number | null;
  auditRefs?: { id?: string }[];
}

const storedLighthouseMetricSchema = z.object({
  score: z.number().nullable(),
  displayValue: z.string().nullable(),
  numericValue: z.number().nullable(),
});

const storedLighthouseMetricsSchema = z.object({
  firstContentfulPaint: storedLighthouseMetricSchema,
  largestContentfulPaint: storedLighthouseMetricSchema,
  totalBlockingTime: storedLighthouseMetricSchema,
  cumulativeLayoutShift: storedLighthouseMetricSchema,
  speedIndex: storedLighthouseMetricSchema,
  timeToInteractive: storedLighthouseMetricSchema,
  interactionToNextPaint: storedLighthouseMetricSchema,
  serverResponseTime: storedLighthouseMetricSchema,
});

const storedLighthouseIssueSchema = z.object({
  category: z.enum(LIGHTHOUSE_CATEGORIES),
  auditKey: z.string(),
  title: z.string(),
  description: z.string(),
  score: z.number().nullable(),
  scoreDisplayMode: z.string().nullable(),
  displayValue: z.string().nullable(),
  impactMs: z.number().nullable(),
  impactBytes: z.number().nullable(),
  severity: z.enum(['critical', 'warning', 'info']),
  items: z.array(z.string()),
});

/**
 * Compact, storable reduction of a Lighthouse report: category scores, the
 * core metrics, and failing audits. Kilobytes instead of the multi-MB raw
 * report, and validated so an off-spec provider field fails the check instead
 * of blanking the stored view on read.
 */
export const storedLighthousePayloadSchema = z.object({
  version: z.literal(2),
  source: z.literal('dataforseo-lighthouse'),
  hasIssueDetails: z.boolean(),
  metadata: z.object({
    requestedUrl: z.string(),
    finalUrl: z.string(),
    strategy: z.enum(['mobile', 'desktop']),
    fetchedAt: z.string(),
    lighthouseVersion: z.string().nullable(),
    taskId: z.string().nullable(),
    cost: z.number().nullable(),
  }),
  scores: z.object({
    performance: z.number().nullable(),
    accessibility: z.number().nullable(),
    'best-practices': z.number().nullable(),
    seo: z.number().nullable(),
  }),
  metrics: storedLighthouseMetricsSchema,
  issues: z.array(storedLighthouseIssueSchema),
});

type StoredLighthouseMetric = z.infer<typeof storedLighthouseMetricSchema>;
type StoredLighthouseMetrics = z.infer<typeof storedLighthouseMetricsSchema>;
export type StoredLighthouseIssue = z.infer<typeof storedLighthouseIssueSchema>;
export type StoredLighthousePayload = z.infer<typeof storedLighthousePayloadSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scoreToPercent(score: number | null | undefined): number | null {
  if (typeof score !== 'number' || Number.isNaN(score)) {
    return null;
  }
  return Math.round(score * 100);
}

function buildStoredMetric(audit: RawLighthouseAudit | undefined): StoredLighthouseMetric {
  return {
    score: scoreToPercent(audit?.score),
    displayValue: audit?.displayValue ?? null,
    numericValue: typeof audit?.numericValue === 'number' ? audit.numericValue : null,
  };
}

const DIAGNOSTIC_AUDIT_KEYS = new Set([
  'largest-contentful-paint-element',
  'layout-shifts',
  'diagnostics',
  'metrics',
  'network-requests',
  'network-rtt',
  'network-server-latency',
  'main-thread-tasks',
  'screenshot-thumbnails',
  'final-screenshot',
  'script-treemap-data',
  'resource-summary',
]);

const PREFERRED_ITEM_KEYS = [
  'url',
  'source',
  'nodeLabel',
  'snippet',
  'totalBytes',
  'wastedBytes',
  'wastedMs',
  'label',
  'value',
];

function compactItem(item: Record<string, unknown>): string {
  const output: Record<string, unknown> = {};
  for (const key of PREFERRED_ITEM_KEYS) {
    if (item[key] != null) {
      output[key] = item[key];
    }
  }
  if (Object.keys(output).length === 0) {
    for (const [key, value] of Object.entries(item).slice(0, 6)) {
      output[key] = value;
    }
  }
  return JSON.stringify(output);
}

const CRITICAL_IMPACT_MS = 300;
const CRITICAL_IMPACT_BYTES = 150_000;
const WARNING_IMPACT_MS = 100;
const WARNING_IMPACT_BYTES = 50_000;
const CRITICAL_SCORE = 50;
const PASSING_SCORE = 90;

function getSeverity(input: {
  score: number | null;
  impactMs: number | null;
  impactBytes: number | null;
}): 'critical' | 'warning' | 'info' {
  if (
    (input.impactMs ?? 0) >= CRITICAL_IMPACT_MS ||
    (input.impactBytes ?? 0) >= CRITICAL_IMPACT_BYTES
  ) {
    return 'critical';
  }
  if (input.score != null && input.score < CRITICAL_SCORE) {
    return 'critical';
  }
  if (
    (input.impactMs ?? 0) >= WARNING_IMPACT_MS ||
    (input.impactBytes ?? 0) >= WARNING_IMPACT_BYTES
  ) {
    return 'warning';
  }
  if (input.score != null && input.score < PASSING_SCORE) {
    return 'warning';
  }
  return 'info';
}

function buildStoredLighthouseIssues(input: {
  audits: Record<string, RawLighthouseAudit>;
  categories: Record<string, RawLighthouseCategory>;
}) {
  const hasIssueDetails = LIGHTHOUSE_CATEGORIES.some(
    (category) => (input.categories[category]?.auditRefs?.length ?? 0) > 0,
  );

  const issues: StoredLighthouseIssue[] = [];

  for (const category of LIGHTHOUSE_CATEGORIES) {
    const rawRefs = input.categories[category]?.auditRefs;
    const refs = Array.isArray(rawRefs) ? rawRefs : [];
    for (const ref of refs) {
      const auditKey = ref?.id;
      if (!auditKey) {
        continue;
      }

      const audit = input.audits[auditKey];
      if (!audit) {
        continue;
      }

      const score = scoreToPercent(audit.score);
      const scoreDisplayMode = audit.scoreDisplayMode ?? null;

      if (scoreDisplayMode === 'numeric') {
        continue;
      }
      if (DIAGNOSTIC_AUDIT_KEYS.has(auditKey)) {
        continue;
      }

      const isPass =
        score == null ||
        score >= PASSING_SCORE ||
        scoreDisplayMode === 'notApplicable' ||
        scoreDisplayMode === 'informative' ||
        scoreDisplayMode === 'manual' ||
        scoreDisplayMode === 'error';

      if (isPass) {
        continue;
      }

      const impactMs =
        typeof audit.details?.overallSavingsMs === 'number'
          ? audit.details.overallSavingsMs
          : null;
      const impactBytes =
        typeof audit.details?.overallSavingsBytes === 'number'
          ? audit.details.overallSavingsBytes
          : null;
      const rawItems = audit.details?.items;
      const itemList = Array.isArray(rawItems) ? rawItems : isRecord(rawItems) ? [rawItems] : [];
      const items = itemList.filter(isRecord).slice(0, 10).map(compactItem);

      issues.push({
        category,
        auditKey,
        title: audit.title ?? auditKey,
        description: audit.description ?? '',
        score,
        scoreDisplayMode,
        displayValue: audit.displayValue ?? null,
        impactMs,
        impactBytes,
        severity: getSeverity({ score, impactMs, impactBytes }),
        items,
      });
    }
  }

  return { hasIssueDetails, issues };
}

function buildStoredLighthouseMetrics(input: {
  audits: Record<string, RawLighthouseAudit>;
}): StoredLighthouseMetrics {
  return {
    firstContentfulPaint: buildStoredMetric(input.audits['first-contentful-paint']),
    largestContentfulPaint: buildStoredMetric(input.audits['largest-contentful-paint']),
    totalBlockingTime: buildStoredMetric(input.audits['total-blocking-time']),
    cumulativeLayoutShift: buildStoredMetric(input.audits['cumulative-layout-shift']),
    speedIndex: buildStoredMetric(input.audits['speed-index']),
    timeToInteractive: buildStoredMetric(input.audits.interactive),
    interactionToNextPaint: buildStoredMetric(input.audits['interaction-to-next-paint']),
    serverResponseTime: buildStoredMetric(input.audits['server-response-time']),
  };
}

const lighthouseResponseSchema = z.object({
  requestedUrl: z.string().optional(),
  finalUrl: z.string().optional(),
  lighthouseVersion: z.string().optional(),
  // Only the key map is copied here, so the multi-MB category/audit bodies
  // stay as the provider's own objects instead of being cloned by a deep parse.
  categories: z.record(z.string(), z.custom<RawLighthouseCategory>()).optional(),
  audits: z.record(z.string(), z.custom<RawLighthouseAudit>()).optional(),
});

const dataforseoTaskSchema = z.object({
  id: z.string().optional(),
  cost: z.number().optional(),
  status_code: z.number().optional(),
  status_message: z.string().optional(),
  result: z.array(lighthouseResponseSchema.nullable()).nullable().optional(),
});

const dataforseoLighthouseResponseSchema = z.object({
  status_code: z.number().optional(),
  status_message: z.string().optional(),
  tasks: z.array(dataforseoTaskSchema).optional(),
});

/**
 * Reduces a raw `on_page/lighthouse/live/json` envelope to the compact stored
 * payload. Throws a plain Error on any shape/status problem; the fetcher wraps
 * it with billing metadata because the provider has already charged the task.
 */
export function parseDataforseoLighthousePayload(
  payload: unknown,
  input: { url: string; strategy: LighthouseStrategy },
): StoredLighthousePayload {
  const parsed = dataforseoLighthouseResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `DataForSEO Lighthouse returned an invalid response: ${summarizeIssues(parsed.error)}`,
    );
  }

  if (parsed.data.status_code !== 20_000) {
    throw new Error(parsed.data.status_message ?? 'DataForSEO Lighthouse request failed');
  }

  const task = parsed.data.tasks?.[0];
  if (!task) {
    throw new Error('DataForSEO Lighthouse response missing task');
  }

  if (task.status_code !== 20_000) {
    throw new Error(task.status_message ?? 'DataForSEO Lighthouse task failed');
  }

  const result = task.result?.[0];
  if (!result) {
    throw new Error('DataForSEO Lighthouse response missing result');
  }

  const fetchedAt = new Date().toISOString();
  const categories = result.categories ?? {};
  const audits = result.audits ?? {};
  const issueReport = buildStoredLighthouseIssues({ audits, categories });
  const metrics = buildStoredLighthouseMetrics({ audits });
  const storedPayload: StoredLighthousePayload = {
    version: 2,
    source: 'dataforseo-lighthouse',
    hasIssueDetails: issueReport.hasIssueDetails,
    metadata: {
      requestedUrl: result.requestedUrl ?? input.url,
      finalUrl: result.finalUrl ?? input.url,
      strategy: input.strategy,
      fetchedAt,
      lighthouseVersion: result.lighthouseVersion ?? null,
      taskId: task.id ?? null,
      cost: task.cost ?? null,
    },
    scores: {
      performance: scoreToPercent(categories.performance?.score),
      accessibility: scoreToPercent(categories.accessibility?.score),
      'best-practices': scoreToPercent(categories['best-practices']?.score),
      seo: scoreToPercent(categories.seo?.score),
    },
    metrics,
    issues: issueReport.issues,
  };

  const allScoresMissing = Object.values(storedPayload.scores).every((score) => score == null);
  if (allScoresMissing) {
    throw new Error(
      `DataForSEO Lighthouse returned no category scores for ${storedPayload.metadata.finalUrl}`,
    );
  }

  const validated = storedLighthousePayloadSchema.safeParse(storedPayload);
  if (!validated.success) {
    throw new Error(
      `DataForSEO Lighthouse returned an invalid report: ${summarizeIssues(validated.error)}`,
    );
  }

  return storedPayload;
}
