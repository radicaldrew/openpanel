import {
  assertUsableRule,
  evaluateRule,
  isGigapipeEnabled,
  type MeasureEmission,
  type MeasureRule,
  type MeasureSeriesState,
  observationsFromMatrix,
  periodSecondsOf,
  queryRange,
  type SeriesObservation,
} from '@openpanel/gigapipe';
import { getRedisCache } from '@openpanel/redis';
import { logger } from '@/utils/logger';

/**
 * Measure signals: SPEC §1.1's other half.
 *
 * Events route to plays. Measures cannot — `mcp_calls == 0` is true at every
 * instant it is true, and a play runs once — so a rule on the source turns a
 * threshold crossing into one discrete event. That "one" is the whole problem:
 * this job runs every fifteen minutes, and `mcp_idle` routes to Re-engage.
 *
 * The evaluation itself is pure and lives in @openpanel/gigapipe/measures. This
 * file is only the I/O: query gigapipe, remember what is already firing, POST
 * crossings to gtmsrv. Everything it touches is injectable, so the behaviour
 * that matters is tested with neither service running.
 */

/** How far back each evaluation looks. Wide enough to survive a late scrape. */
const LOOKBACK_PERIODS = 4;

/**
 * Cap the signals one evaluation may raise.
 *
 * A rule whose query returns hundreds of series can cross for all of them at
 * once. Each crossing is a lead and potentially an email, so an unbounded
 * evaluation is an unbounded outreach campaign started by a metric.
 */
const MAX_EMISSIONS_PER_EVALUATION = 25;

/** Redis key for one rule's state. */
function stateKey(ruleId: string): string {
  return `measure:state:${ruleId}`;
}

/**
 * How long remembered state survives.
 *
 * Longer than any plausible re-arm window: state that expired while a condition
 * was still firing would look like a new episode and raise the signal again.
 * Thirty days covers the 24h floor and the long `mcp_idle` case with room over.
 */
const STATE_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface MeasureDeps {
  rules(): Promise<MeasureRule[]>;
  observe(rule: MeasureRule, now: number): Promise<SeriesObservation[]>;
  loadState(ruleId: string): Promise<Map<string, MeasureSeriesState>>;
  saveState(
    ruleId: string,
    state: Map<string, MeasureSeriesState>
  ): Promise<void>;
  /** Returns true only when gtmsrv accepted the signal. */
  emit(emission: MeasureEmission): Promise<boolean>;
  now(): number;
}

export interface MeasureRunSummary {
  rulesEvaluated: number;
  emitted: number;
  /** Attempted but not accepted; retried next evaluation with the same key. */
  undelivered: number;
  skipped: number;
  failedRules: number;
}

/**
 * Evaluate every rule. Injectable so the test suite runs with no gigapipe, no
 * gtmsrv and no Redis.
 */
export async function evaluateMeasures(
  deps: MeasureDeps
): Promise<MeasureRunSummary> {
  const summary: MeasureRunSummary = {
    rulesEvaluated: 0,
    emitted: 0,
    undelivered: 0,
    skipped: 0,
    failedRules: 0,
  };

  const rules = await deps.rules();

  for (const rule of rules) {
    if (rule.enabled === false) {
      continue;
    }

    try {
      const counts = await evaluateOne(rule, deps);
      summary.rulesEvaluated++;
      summary.emitted += counts.emitted;
      summary.undelivered += counts.undelivered;
      summary.skipped += counts.skipped;
    } catch (error) {
      // One rule's failure must not stop the others: a single bad query would
      // otherwise silence every measure in the system.
      summary.failedRules++;
      logger.error(
        { err: error, ruleId: rule.id },
        'measure signals: rule evaluation failed'
      );
    }
  }

  return summary;
}

async function evaluateOne(rule: MeasureRule, deps: MeasureDeps) {
  assertUsableRule(rule);

  const now = deps.now();
  const observations = await deps.observe(rule, now);
  const previous = await deps.loadState(rule.id);

  const { outcomes } = evaluateRule({ rule, observations, previous, at: now });

  const next = new Map<string, MeasureSeriesState>();
  let emitted = 0;
  let undelivered = 0;
  let skipped = 0;
  let budget = MAX_EMISSIONS_PER_EVALUATION;

  for (const outcome of outcomes) {
    let state = outcome.state;

    if (outcome.skipped) {
      skipped++;
    }

    if (outcome.emission) {
      if (budget <= 0) {
        // Over budget: leave the episode unemitted so the next evaluation
        // picks it up with the same key. Deferred, never dropped.
        undelivered++;
        logger.warn(
          { ruleId: rule.id, seriesKey: outcome.seriesKey },
          'measure signals: emission budget reached, deferring to the next evaluation'
        );
        next.set(outcome.seriesKey, state);
        continue;
      }
      budget--;

      const accepted = await deps.emit(outcome.emission);
      if (accepted) {
        emitted++;
        // Marked emitted only once gtmsrv has it. A failure leaves the episode
        // open and unemitted, and the retry carries the same dedupe key — so a
        // POST that succeeded while looking failed is collapsed rather than
        // becoming a second signal.
        state = {
          ...state,
          episode: state.episode && { ...state.episode, emitted: true },
        };
      } else {
        undelivered++;
      }
    }

    next.set(outcome.seriesKey, state);
  }

  // Persist every series, transitioned or not: the staleness guard depends on
  // lastEvaluatedAt being current.
  await deps.saveState(rule.id, next);

  return { emitted, undelivered, skipped };
}

// --- the wired-up job -----------------------------------------------------

export async function measureSignalsCronJob(): Promise<void> {
  if (!isGigapipeEnabled()) {
    return;
  }
  const rules = loadRulesFromEnv();
  if (rules.length === 0) {
    return;
  }

  const summary = await evaluateMeasures({
    rules: async () => rules,
    observe: observeFromGigapipe,
    loadState: loadStateFromRedis,
    saveState: saveStateToRedis,
    emit: postToGtmsrv,
    now: () => Date.now(),
  });

  if (
    summary.emitted > 0 ||
    summary.failedRules > 0 ||
    summary.undelivered > 0
  ) {
    logger.info({ ...summary }, 'measure signals: evaluated');
  }
}

/**
 * Where rules come from, for now.
 *
 * There is no `MeasureRule` table: adding one is a Prisma migration in shared
 * territory, and this workstream is the evaluator. `GTM_MEASURE_RULES` holds a
 * JSON array of the same shape. A table with the rule editor beside it is the
 * right home, and moving there changes only this function.
 */
export function loadRulesFromEnv(
  raw: string | undefined = process.env.GTM_MEASURE_RULES
): MeasureRule[] {
  if (!raw?.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new TypeError('GTM_MEASURE_RULES must be a JSON array');
    }
    return parsed as MeasureRule[];
  } catch (error) {
    // Loud, and empty: a malformed rule set must not silently become "no
    // rules", which looks exactly like a system with nothing to report.
    logger.error(
      { err: error },
      'measure signals: GTM_MEASURE_RULES is not valid JSON'
    );
    return [];
  }
}

async function observeFromGigapipe(
  rule: MeasureRule,
  now: number
): Promise<SeriesObservation[]> {
  const periodSeconds = periodSecondsOf(rule);
  const payload = await queryRange({
    promql: rule.promql,
    start: new Date(now - periodSeconds * LOOKBACK_PERIODS * 1000),
    end: new Date(now),
    step: `${periodSeconds}s`,
  });
  return observationsFromMatrix(payload);
}

async function loadStateFromRedis(
  ruleId: string
): Promise<Map<string, MeasureSeriesState>> {
  const raw = await getRedisCache().get(stateKey(ruleId));
  if (!raw) {
    return new Map();
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, MeasureSeriesState>;
    return new Map(Object.entries(parsed));
  } catch (error) {
    // Unreadable state is the dangerous case: treated as absent, every firing
    // condition looks new and raises its signal again. Say so rather than let
    // it look like a fresh start.
    logger.error(
      { err: error, ruleId },
      'measure signals: stored state is unreadable; conditions already firing may re-raise'
    );
    return new Map();
  }
}

async function saveStateToRedis(
  ruleId: string,
  state: Map<string, MeasureSeriesState>
): Promise<void> {
  await getRedisCache().set(
    stateKey(ruleId),
    JSON.stringify(Object.fromEntries(state)),
    'EX',
    STATE_TTL_SECONDS
  );
}

/**
 * POST one crossing to gtmsrv.
 *
 * Returns whether it was ACCEPTED. A non-2xx is not an exception here: the
 * caller's response to "not accepted" is to leave the episode unemitted and try
 * again next period, which is the correct handling for both a down gtmsrv and a
 * transient network fault.
 */
async function postToGtmsrv(emission: MeasureEmission): Promise<boolean> {
  const url = process.env.GTM_INGEST_URL?.trim();
  const token = process.env.GTM_INGEST_TOKEN?.trim();
  if (!(url && token)) {
    logger.error(
      { kind: emission.kind },
      'measure signals: GTM_INGEST_URL or GTM_INGEST_TOKEN is unset; crossing not delivered'
    );
    return false;
  }

  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/ingest/signal`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        kind: emission.kind,
        ...sourceField(),
        dedupe_key: emission.dedupeKey,
        strength: emission.strength,
        subject: { kind: emission.subject.kind, id: emission.subject.id },
        evidence: emission.evidence,
        occurred_at: emission.occurredAt,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      // A 4xx will never succeed on retry, and this caller retries forever:
      // the episode stays unemitted and comes back every period. Say plainly
      // that it is a configuration fault so it is not read as gtmsrv being
      // down. The likeliest cause is the source name — see sourceField().
      const permanent = res.status >= 400 && res.status < 500;
      logger.error(
        {
          status: res.status,
          permanent,
          kind: emission.kind,
          dedupeKey: emission.dedupeKey,
          body: (await res.text().catch(() => '')).slice(0, 500),
        },
        permanent
          ? 'measure signals: gtmsrv rejected the signal and will keep rejecting it — this is a configuration fault, not an outage'
          : 'measure signals: gtmsrv refused the signal'
      );
      return false;
    }
    return true;
  } catch (error) {
    logger.error(
      { err: error, kind: emission.kind, dedupeKey: emission.dedupeKey },
      'measure signals: gtmsrv unreachable'
    );
    return false;
  }
}

/**
 * The `source` field, or nothing.
 *
 * gtmsrv trusts a self-declared source only on the legacy shared token. A
 * credentialed request has its source stamped from the credential, and a name
 * that disagrees with it is a 400 — deliberately, because a producer that could
 * name itself could name itself as another producer.
 *
 * That 400 would be invisible here in the worst way: this caller treats any
 * non-2xx as "try again", so every crossing would retry forever and nothing
 * would ever arrive. So the name is configuration rather than a constant. Set
 * `GTM_INGEST_SOURCE` to whatever the credential is registered as, or to an
 * empty string to omit the field and let the credential decide.
 */
export function sourceField(): { source?: string } {
  const configured = process.env.GTM_INGEST_SOURCE;
  if (configured === undefined) {
    return { source: DEFAULT_SOURCE_NAME };
  }
  const trimmed = configured.trim();
  return trimmed ? { source: trimmed } : {};
}

/** What this producer calls itself on the shared token. */
export const DEFAULT_SOURCE_NAME = 'Measures';
