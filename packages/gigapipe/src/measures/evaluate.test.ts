import { describe, expect, it } from 'vitest';
import {
  evaluateRule,
  type MeasureEmission,
  type MeasureSeriesState,
  type SeriesObservation,
  seriesKeyOf,
} from './evaluate';
import {
  assertUsableRule,
  type MeasureRule,
  MeasureRuleError,
  MIN_RE_ARM_SECONDS,
} from './rule';

const PERIOD_SECONDS = 900; // fifteen minutes
const TICK = PERIOD_SECONDS * 1000;
const T0 = 1_700_000_000_000;

/**
 * SPEC §1.1's own example: `mcp_calls == 0 for 14d → mcp_idle`.
 *
 * The fourteen days live in the range selector, where the metric already holds
 * that history. `forSeconds` is one evaluation period — enough that a single
 * missing scrape does not fire it, short enough to actually mature.
 */
const idleRule: MeasureRule = {
  id: 'rule_idle',
  name: 'MCP gone quiet',
  projectId: 'proj_1',
  promql: 'sum by (customer_id) (increase(mcp_calls_total[14d]))',
  operator: 'lte',
  threshold: 0,
  forSeconds: PERIOD_SECONDS,
  signalKind: 'mcp_idle',
  subject: { kind: 'company', fromLabel: 'customer_id' },
  periodSeconds: PERIOD_SECONDS,
};

const IDLE = 0; // the condition holds: no calls in the window
const ACTIVE = 5; // the condition does not hold

function acme(value: number | undefined): SeriesObservation {
  return {
    seriesKey: 'customer_id=acme',
    labels: { customer_id: 'acme' },
    value,
  };
}

interface RunOptions {
  /** The value observed at evaluation `i`. */
  valueAt: (i: number) => number | undefined;
  /** Whether gtmsrv accepted the POST at evaluation `i`. Defaults to true. */
  deliverAt?: (i: number) => boolean;
  /** The rule in force at evaluation `i`. Defaults to the constant rule. */
  ruleAt?: (i: number) => MeasureRule;
}

/**
 * Run `count` evaluations one period apart, threading state exactly as the cron
 * does — including that an episode is marked emitted only after gtmsrv accepts
 * the signal.
 */
function run(rule: MeasureRule, count: number, options: RunOptions) {
  let state = new Map<string, MeasureSeriesState>();
  const emitted: {
    i: number;
    at: number;
    dedupeKey: string;
    occurredAt: string;
  }[] = [];
  const skipped: string[] = [];

  for (let i = 0; i < count; i++) {
    const at = T0 + i * TICK;
    const result = evaluateRule({
      rule: options.ruleAt?.(i) ?? rule,
      observations: [acme(options.valueAt(i))],
      previous: state,
      at,
    });

    const next = new Map<string, MeasureSeriesState>();
    for (const outcome of result.outcomes) {
      let stored = outcome.state;
      if (outcome.emission && (options.deliverAt?.(i) ?? true)) {
        emitted.push({
          i,
          at,
          dedupeKey: outcome.emission.dedupeKey,
          occurredAt: outcome.emission.occurredAt,
        });
        stored = {
          ...stored,
          episode: stored.episode && { ...stored.episode, emitted: true },
        };
      }
      if (outcome.skipped) {
        skipped.push(outcome.skipped);
      }
      next.set(outcome.seriesKey, stored);
    }
    state = next;
  }

  return { emitted, skipped, state };
}

const alwaysIdle = () => IDLE;

describe('a condition that stays true', () => {
  /**
   * THE test this workstream exists for.
   *
   * A threshold rule evaluated every fifteen minutes finds the condition true
   * every fifteen minutes. `mcp_idle` routes to Re-engage, so a second signal
   * is a second email to a real customer, and a naive evaluator sends four an
   * hour for as long as they stay quiet.
   */
  it('emits exactly one signal across ten consecutive evaluations', () => {
    const { emitted } = run(idleRule, 10, { valueAt: alwaysIdle });

    expect(emitted).toHaveLength(1);
  });

  it('still emits exactly one across a hundred evaluations — a day of them', () => {
    const { emitted } = run(idleRule, 100, { valueAt: alwaysIdle });

    expect(emitted).toHaveLength(1);
  });

  it('waits for the condition to mature before emitting at all', () => {
    const { emitted } = run(idleRule, 10, { valueAt: alwaysIdle });

    // Evaluation 0 opens the pending timer; evaluation 1 is the first at which
    // forSeconds has actually elapsed.
    expect(emitted[0]?.i).toBe(1);
  });

  it('keeps one dedupe key for the whole episode', () => {
    const { emitted } = run(idleRule, 10, { valueAt: alwaysIdle });

    expect(emitted[0]?.dedupeKey).toBe(
      `measure/rule_idle/customer_id=acme/${T0 + TICK}`
    );
  });

  it('dates the signal from when the condition opened, not from the tick', () => {
    const { emitted } = run(idleRule, 10, { valueAt: alwaysIdle });

    // A late evaluation must not date the signal late: SPEC §6's follow-up
    // counts from the event, not from when we noticed it.
    expect(emitted[0]?.occurredAt).toBe(new Date(T0 + TICK).toISOString());
  });
});

describe('a condition that clears and comes back', () => {
  it('is the same episode when it recurs inside the re-arm window', () => {
    // Idle, fires; active for an hour; idle again. An hour is far inside the
    // 24h re-arm floor, so the metric flapped — nothing new happened to the
    // customer.
    const { emitted } = run(idleRule, 20, {
      valueAt: (i) => (i >= 3 && i < 7 ? ACTIVE : IDLE),
    });

    expect(emitted).toHaveLength(1);
  });

  it('is a new episode, with a new key, once the re-arm window has passed', () => {
    const reArmTicks = MIN_RE_ARM_SECONDS / PERIOD_SECONDS; // 96
    // Fire, then active for longer than the re-arm window, then idle again.
    const activeFrom = 3;
    const activeUntil = activeFrom + reArmTicks + 2;

    const { emitted } = run(idleRule, activeUntil + 5, {
      valueAt: (i) => (i >= activeFrom && i < activeUntil ? ACTIVE : IDLE),
    });

    expect(emitted).toHaveLength(2);
    expect(emitted[0]?.dedupeKey).not.toBe(emitted[1]?.dedupeKey);
  });
});

describe('delivery', () => {
  it('retries with the same key when gtmsrv did not accept it', () => {
    // gtmsrv is down for the first three evaluations after the condition
    // matures.
    const { emitted } = run(idleRule, 10, {
      valueAt: alwaysIdle,
      deliverAt: (i) => i >= 4,
    });

    // One accepted signal, and its key is the episode's — so a POST that
    // actually succeeded while looking failed is collapsed by gtmsrv rather
    // than becoming a second email.
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.dedupeKey).toBe(
      `measure/rule_idle/customer_id=acme/${T0 + TICK}`
    );
  });

  it('keeps the original opening time through a retry', () => {
    const { emitted } = run(idleRule, 10, {
      valueAt: alwaysIdle,
      deliverAt: (i) => i >= 4,
    });

    // Not the time of the successful attempt: the condition opened earlier and
    // the signal has to say so.
    expect(emitted[0]?.occurredAt).toBe(new Date(T0 + TICK).toISOString());
    expect(emitted[0]?.i).toBe(4);
  });
});

describe('subjects', () => {
  it('raises nothing for a series it cannot resolve to somebody', () => {
    let state = new Map<string, MeasureSeriesState>();
    const anonymous: SeriesObservation = {
      seriesKey: 'region=eu',
      labels: { region: 'eu' },
      value: IDLE,
    };
    const emissions: MeasureEmission[] = [];

    for (let i = 0; i < 5; i++) {
      const result = evaluateRule({
        rule: idleRule,
        observations: [anonymous],
        previous: state,
        at: T0 + i * TICK,
      });
      emissions.push(...result.emissions);
      state = new Map(result.outcomes.map((o) => [o.seriesKey, o.state]));
    }

    // A subjectless signal opens no lead and matches no play — work that looks
    // done and is not.
    expect(emissions).toHaveLength(0);
  });

  it('says which label was missing rather than failing silently', () => {
    const result = evaluateRule({
      rule: idleRule,
      observations: [
        { seriesKey: 'region=eu', labels: { region: 'eu' }, value: IDLE },
      ],
      previous: new Map(),
      at: T0,
    });

    expect(result.outcomes[0]?.skipped).toContain('customer_id');
  });

  it('resolves the subject from the rule’s label', () => {
    let state = new Map<string, MeasureSeriesState>();
    let subject: { kind: string; id: string } | undefined;

    for (let i = 0; i < 3; i++) {
      const result = evaluateRule({
        rule: idleRule,
        observations: [acme(IDLE)],
        previous: state,
        at: T0 + i * TICK,
      });
      subject = result.emissions[0]?.subject ?? subject;
      state = new Map(result.outcomes.map((o) => [o.seriesKey, o.state]));
    }

    expect(subject).toEqual({ kind: 'company', id: 'acme' });
  });

  it('carries every label, not only the one that resolved the subject', () => {
    const rich: SeriesObservation = {
      seriesKey: 'customer_id=acme,plan=pro',
      labels: { customer_id: 'acme', plan: 'pro' },
      value: IDLE,
    };
    let state = new Map<string, MeasureSeriesState>();
    let evidence: Record<string, unknown> | undefined;

    for (let i = 0; i < 3; i++) {
      const result = evaluateRule({
        rule: idleRule,
        observations: [rich],
        previous: state,
        at: T0 + i * TICK,
      });
      evidence = result.emissions[0]?.evidence ?? evidence;
      state = new Map(result.outcomes.map((o) => [o.seriesKey, o.state]));
    }

    // gtmsrv may identify the lead better than we can; a label dropped here is
    // one it can never see.
    expect(evidence?.labels).toEqual({ customer_id: 'acme', plan: 'pro' });
  });
});

describe('absent data', () => {
  it('does not reopen an episode when the series stops reporting', () => {
    // The exporter dies for two evaluations. That is not the customer coming
    // back — and a series that vanishes because the service died must not
    // resolve its own condition at the moment it matters most.
    const { emitted } = run(idleRule, 12, {
      valueAt: (i) => (i === 5 || i === 6 ? undefined : IDLE),
    });

    expect(emitted).toHaveLength(1);
  });
});

describe('an edited rule', () => {
  it('starts a new episode when the condition itself changed', () => {
    // Loosened from "no calls at all" to "fewer than ten". The episode that was
    // open under the old threshold is not an episode of the new condition, and
    // continuing it would mean the edit never raises the signal it was made to
    // raise.
    const loosened: MeasureRule = { ...idleRule, threshold: 10 };

    const { emitted } = run(idleRule, 8, {
      valueAt: alwaysIdle,
      ruleAt: (i) => (i < 4 ? idleRule : loosened),
    });

    expect(emitted).toHaveLength(2);
    expect(emitted[0]?.dedupeKey).not.toBe(emitted[1]?.dedupeKey);
  });
});

describe('assertUsableRule', () => {
  it('accepts the shape SPEC §1.1 describes', () => {
    expect(() => assertUsableRule(idleRule)).not.toThrow();
  });

  it('refuses a rule with no subject mapping', () => {
    expect(() =>
      assertUsableRule({
        ...idleRule,
        subject: { kind: 'company', fromLabel: '  ' },
      })
    ).toThrow(MeasureRuleError);
  });

  /**
   * The mistake this catches is the one the author of these tests made first:
   * writing `forSeconds: 14 days` because the spec says "for 14d". The alert
   * machine drops a pending timer after three missed periods, so such a rule
   * needs fourteen days of uninterrupted evaluation and in practice never
   * fires — silently.
   */
  it('refuses a forSeconds that could never mature, and says where the window goes', () => {
    let message = '';
    try {
      assertUsableRule({ ...idleRule, forSeconds: 14 * 24 * 60 * 60 });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('never fire');
    expect(message).toContain('[14d]');
  });
});

describe('seriesKeyOf', () => {
  it('is stable regardless of label order', () => {
    expect(seriesKeyOf({ b: '2', a: '1' })).toBe(
      seriesKeyOf({ a: '1', b: '2' })
    );
  });

  it('names the unlabelled series rather than returning an empty key', () => {
    expect(seriesKeyOf({})).toBe('__all__');
    expect(seriesKeyOf(undefined)).toBe('__all__');
  });
});
