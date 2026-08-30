import { db, executeMetricChart } from '@openpanel/db';
import { isGigapipeEnabled, stepSeries } from '@openpanel/gigapipe';
import type { SeriesState } from '@openpanel/gigapipe';
import type { INotificationRuleMetricConfig } from '@openpanel/validation';
import { logger } from '@/utils/logger';

/**
 * Metric alert evaluation.
 *
 * gigapipe's ruler evaluates RECORDING rules only — alerting rules may be
 * stored but are never evaluated — so evaluation lives here. Delivery does not:
 * a transition writes a `Notification` row and the existing integrations,
 * email and in-app paths take it from there, unchanged.
 *
 * Runs every 60 seconds from the cron switch in ./cron.ts.
 */

const EVALUATION_PERIOD_SECONDS = 60;

/** The window each evaluation queries. Wide enough to survive a late scrape. */
const LOOKBACK_MINUTES = 10;

/**
 * Cap the notifications one evaluation may send.
 *
 * A rule whose query returns hundreds of series can transition all of them at
 * once — a deploy that breaks every route, say. Without a cap that is hundreds
 * of emails for one incident. Beyond the cap the remainder is summarised in a
 * single message.
 */
const MAX_NOTIFICATIONS_PER_EVALUATION = 10;

function isMetricRuleConfig(
  config: unknown,
): config is INotificationRuleMetricConfig {
  return (
    typeof config === 'object' &&
    config !== null &&
    (config as { type?: string }).type === 'metric'
  );
}

/** Stable identity for a series within a rule: its sorted label set. */
function seriesKeyOf(breakdowns: Record<string, string> | undefined): string {
  if (!breakdowns || Object.keys(breakdowns).length === 0) {
    return '__all__';
  }

  return Object.entries(breakdowns)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
}

function describeSeries(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) {
    return 'all series';
  }
  return entries.map(([k, v]) => `${k}=${v}`).join(', ');
}

export async function metricAlertsCronJob(): Promise<void> {
  if (!isGigapipeEnabled()) {
    return;
  }

  const rules = await db.notificationRule.findMany({
    where: {
      // Cheap pre-filter; the real check is the type guard below, because the
      // JSON column cannot be narrowed by the query.
      config: { path: ['type'], equals: 'metric' },
    },
    include: { alertStates: true, integrations: true },
  });

  for (const rule of rules) {
    if (!isMetricRuleConfig(rule.config)) {
      continue;
    }

    try {
      await evaluateRule(rule, rule.config);
    } catch (error) {
      // One rule's failure must not stop the others. A backend outage would
      // otherwise silence every alert in the system.
      logger.error(
        { err: error, ruleId: rule.id },
        'metric alert: rule evaluation failed',
      );
    }
  }
}

type RuleWithState = Awaited<
  ReturnType<typeof db.notificationRule.findMany>
>[number] & {
  alertStates: {
    seriesKey: string;
    state: string;
    pendingSince: Date | null;
    lastNotifiedAt: Date | null;
    lastEvaluatedAt: Date | null;
  }[];
};

async function evaluateRule(
  rule: RuleWithState,
  config: INotificationRuleMetricConfig,
): Promise<void> {
  const now = Date.now();
  const end = new Date(now);
  const start = new Date(now - LOOKBACK_MINUTES * 60_000);

  const { chart } = await executeMetricChart({
    projectId: rule.projectId,
    query: config.query,
    interval: 'minute',
    startDate: start.toISOString(),
    endDate: end.toISOString(),
    // Evaluated at wall-clock now, never at a stored due time: a job that ran
    // late would otherwise evaluate a window that has already passed and alert
    // on history.
    previous: false,
    name: config.query.metric,
  });

  const priorByKey = new Map(
    rule.alertStates.map((s) => [s.seriesKey, s] as const),
  );

  const pending: {
    seriesKey: string;
    labels: Record<string, string>;
    next: SeriesState;
    value: number | undefined;
    transition: ReturnType<typeof stepSeries>['transition'];
  }[] = [];

  for (const serie of chart.series) {
    const labels = serie.event?.breakdowns ?? {};
    const seriesKey = seriesKeyOf(labels);

    // The latest point that actually has data. Trailing buckets are routinely
    // empty because the most recent scrape has not landed yet, and treating one
    // of those as a real zero would resolve a firing alert spuriously.
    const latest = [...serie.data].reverse().find((p) => p.count !== undefined);

    const prior = priorByKey.get(seriesKey);
    const previous: SeriesState | undefined = prior
      ? {
          state: prior.state as SeriesState['state'],
          pendingSince: prior.pendingSince?.getTime(),
          lastNotifiedAt: prior.lastNotifiedAt?.getTime(),
          lastEvaluatedAt: prior.lastEvaluatedAt?.getTime(),
        }
      : undefined;

    const result = stepSeries({
      previous,
      value: latest?.count,
      at: now,
      periodSeconds: EVALUATION_PERIOD_SECONDS,
      config: {
        operator: config.operator,
        threshold: config.threshold,
        forSeconds: config.forSeconds,
        cooldownSeconds: config.cooldownSeconds,
      },
    });

    pending.push({
      seriesKey,
      labels,
      next: result.state,
      value: latest?.count,
      transition: result.transition,
    });
  }

  // Persist every series' state, whether or not it transitioned — the state
  // machine's staleness check depends on lastEvaluatedAt being current.
  await db.$transaction(
    pending.map((p) =>
      db.metricAlertState.upsert({
        where: {
          ruleId_seriesKey: { ruleId: rule.id, seriesKey: p.seriesKey },
        },
        create: {
          ruleId: rule.id,
          seriesKey: p.seriesKey,
          labels: p.labels,
          state: p.next.state,
          pendingSince: p.next.pendingSince ? new Date(p.next.pendingSince) : null,
          lastNotifiedAt: p.next.lastNotifiedAt
            ? new Date(p.next.lastNotifiedAt)
            : null,
          lastEvaluatedAt: p.next.lastEvaluatedAt
            ? new Date(p.next.lastEvaluatedAt)
            : null,
          lastValue: p.value ?? null,
        },
        update: {
          labels: p.labels,
          state: p.next.state,
          pendingSince: p.next.pendingSince ? new Date(p.next.pendingSince) : null,
          lastNotifiedAt: p.next.lastNotifiedAt
            ? new Date(p.next.lastNotifiedAt)
            : null,
          lastEvaluatedAt: p.next.lastEvaluatedAt
            ? new Date(p.next.lastEvaluatedAt)
            : null,
          lastValue: p.value ?? null,
        },
      }),
    ),
  );

  const notifiable = pending.filter(
    (p) =>
      p.transition.kind === 'fire' ||
      p.transition.kind === 'refire' ||
      p.transition.kind === 'resolve',
  );

  if (notifiable.length === 0) {
    return;
  }

  const toSend = notifiable.slice(0, MAX_NOTIFICATIONS_PER_EVALUATION);
  const suppressed = notifiable.length - toSend.length;

  for (const item of toSend) {
    const resolved = item.transition.kind === 'resolve';

    await db.notification.create({
      data: {
        projectId: rule.projectId,
        notificationRuleId: rule.id,
        sendToApp: rule.sendToApp,
        sendToEmail: rule.sendToEmail,
        title: resolved
          ? `Resolved: ${rule.name}`
          : `Alert: ${rule.name}`,
        // The offending series' labels, not just the rule name — an alert that
        // says only "latency is high" cannot be acted on.
        message: resolved
          ? `${config.query.metric} (${describeSeries(item.labels)}) is back within threshold.`
          : `${config.query.metric} (${describeSeries(item.labels)}) is ${item.value} — threshold ${config.operator} ${config.threshold}.`,
        payload: {
          metric: config.query.metric,
          labels: item.labels,
          value: item.value ?? null,
          threshold: config.threshold,
          operator: config.operator,
          state: resolved ? 'resolved' : 'firing',
        } as never,
      },
    });
  }

  if (suppressed > 0) {
    await db.notification.create({
      data: {
        projectId: rule.projectId,
        notificationRuleId: rule.id,
        sendToApp: rule.sendToApp,
        sendToEmail: rule.sendToEmail,
        title: `Alert: ${rule.name}`,
        message: `${suppressed} more series also changed state. Open the rule to see all of them.`,
        payload: { rollup: true, suppressed } as never,
      },
    });
  }

  logger.info(
    { ruleId: rule.id, notified: toSend.length, suppressed },
    'metric alert: notifications created',
  );
}
