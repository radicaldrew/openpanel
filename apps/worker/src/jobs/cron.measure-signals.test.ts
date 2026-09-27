import type {
  MeasureEmission,
  MeasureRule,
  MeasureSeriesState,
  SeriesObservation,
} from '@openpanel/gigapipe';
import { observationsFromMatrix } from '@openpanel/gigapipe';
import { describe, expect, it, vi } from 'vitest';
import {
  gtmsrvMeasures,
  DEFAULT_SOURCE_NAME,
  evaluateMeasures,
  loadRulesFromEnv,
  type MeasureDeps,
  type MeasureRunSummary,
  sourceField,
} from './cron.measure-signals';

vi.mock('@/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const PERIOD_SECONDS = 900;
const TICK = PERIOD_SECONDS * 1000;
const T0 = 1_700_000_000_000;

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

/**
 * A whole world with no gigapipe, no gtmsrv and no Redis: state lives in a Map,
 * observations come from a function, and gtmsrv's acceptance is a boolean.
 */
function world(options: {
  rules?: MeasureRule[];
  observe?: (rule: MeasureRule, now: number) => SeriesObservation[];
  accept?: (emission: MeasureEmission) => boolean;
}) {
  const store = new Map<string, Map<string, MeasureSeriesState>>();
  const posted: MeasureEmission[] = [];
  let clock = T0;

  const deps: MeasureDeps = {
    rules: async () => options.rules ?? [idleRule],
    observe: async (rule, now) =>
      options.observe?.(rule, now) ?? [
        {
          seriesKey: 'customer_id=acme',
          labels: { customer_id: 'acme' },
          value: 0,
        },
      ],
    loadState: async (ruleId) => new Map(store.get(ruleId) ?? new Map()),
    saveState: async (ruleId, state) => {
      store.set(ruleId, new Map(state));
    },
    emit: async (emission) => {
      const accepted = options.accept?.(emission) ?? true;
      if (accepted) {
        posted.push(emission);
      }
      return accepted;
    },
    now: () => clock,
  };

  return {
    deps,
    posted,
    store,
    async tick(times = 1) {
      const summaries: MeasureRunSummary[] = [];
      for (let i = 0; i < times; i++) {
        summaries.push(await evaluateMeasures(deps));
        clock += TICK;
      }
      return summaries;
    },
  };
}

describe('the measure evaluator, end to end', () => {
  /**
   * The point of the workstream, at the level that would actually send email.
   *
   * Ten evaluations, condition true throughout, one POST to gtmsrv. A naive
   * implementation posts ten times and Re-engage emails the customer ten times.
   */
  it('posts exactly one signal for a condition true across ten evaluations', async () => {
    const w = world({});

    await w.tick(10);

    expect(w.posted).toHaveLength(1);
    expect(w.posted[0]?.kind).toBe('mcp_idle');
    expect(w.posted[0]?.subject).toEqual({ kind: 'company', id: 'acme' });
  });

  it('sends a dedupe key that identifies the condition, not the evaluation', async () => {
    const w = world({});

    await w.tick(10);

    // The key must not contain the tick that noticed it: gtmsrv dedupes on
    // exactly this string, so an evaluation-derived key makes every evaluation
    // a new signal and every one is honoured.
    expect(w.posted[0]?.dedupeKey).toBe(
      `measure/rule_idle/customer_id=acme/${T0 + TICK}`
    );
  });

  it('retries an undelivered crossing with the same key until gtmsrv takes it', async () => {
    let up = false;
    const w = world({ accept: () => up });

    await w.tick(3); // gtmsrv down throughout
    expect(w.posted).toHaveLength(0);

    up = true;
    await w.tick(1);

    expect(w.posted).toHaveLength(1);
    expect(w.posted[0]?.dedupeKey).toBe(
      `measure/rule_idle/customer_id=acme/${T0 + TICK}`
    );

    // And having landed, it does not land again.
    await w.tick(5);
    expect(w.posted).toHaveLength(1);
  });

  it('reports an undelivered crossing rather than counting it as sent', async () => {
    const w = world({ accept: () => false });

    const summaries = await w.tick(3);

    expect(summaries.at(-1)?.emitted).toBe(0);
    expect(summaries.at(-1)?.undelivered).toBe(1);
  });

  it('does not raise a signal for a series it cannot resolve to somebody', async () => {
    const w = world({
      observe: () => [
        { seriesKey: 'region=eu', labels: { region: 'eu' }, value: 0 },
      ],
    });

    const summaries = await w.tick(5);

    expect(w.posted).toHaveLength(0);
    expect(summaries.at(-1)?.skipped).toBe(1);
  });

  it('keeps evaluating the other rules when one throws', async () => {
    const broken: MeasureRule = { ...idleRule, id: 'rule_broken', promql: '' };
    const w = world({ rules: [broken, idleRule] });

    const summaries = await w.tick(2);

    // A single bad query must not silence every measure in the system.
    expect(summaries.at(-1)?.failedRules).toBe(1);
    expect(w.posted).toHaveLength(1);
  });

  it('leaves a disabled rule alone', async () => {
    const w = world({ rules: [{ ...idleRule, enabled: false }] });

    await w.tick(5);

    expect(w.posted).toHaveLength(0);
  });

  it('persists state between evaluations, keyed by rule', async () => {
    const w = world({});

    await w.tick(2);

    expect(
      w.store.get('rule_idle')?.get('customer_id=acme')?.episode?.emitted
    ).toBe(true);
  });

  /**
   * Losing state is the failure this design has to survive: to a fresh
   * evaluator every firing condition looks new. It cannot be prevented here —
   * that is what the Redis TTL and durability are for — but it must at least be
   * bounded to one repeat rather than one per evaluation.
   */
  it('raises at most one more signal after its memory is lost', async () => {
    const w = world({});
    await w.tick(4);
    expect(w.posted).toHaveLength(1);

    w.store.clear();
    await w.tick(6);

    expect(w.posted).toHaveLength(2);
  });
});

describe('loadRulesFromEnv', () => {
  it('reads a JSON array', () => {
    expect(loadRulesFromEnv(JSON.stringify([idleRule]))).toHaveLength(1);
  });

  it('is empty when unset', () => {
    expect(loadRulesFromEnv(undefined)).toEqual([]);
    expect(loadRulesFromEnv('   ')).toEqual([]);
  });

  it('is empty rather than throwing on malformed JSON', () => {
    // A malformed rule set must not take the worker down, and it is logged as
    // an error so it does not look like a system with nothing to report.
    expect(loadRulesFromEnv('{ not json')).toEqual([]);
  });
});

describe('reading gigapipe’s answer', () => {
  const matrix = (result: unknown) => ({
    status: 'success',
    data: { resultType: 'matrix', result },
  });

  it('takes the last sample that actually parses', () => {
    const observations = observationsFromMatrix(
      matrix([
        {
          metric: { __name__: 'mcp_calls_total', customer_id: 'acme' },
          values: [
            [1, '5'],
            [2, '0'],
            // The most recent scrape has not landed. Reading this as a real
            // number would resolve a live condition at the wrong moment.
            [3, 'NaN'],
          ],
        },
      ])
    );

    expect(observations).toEqual([
      {
        seriesKey: 'customer_id=acme',
        labels: { customer_id: 'acme' },
        value: 0,
      },
    ]);
  });

  it('reports no data as absent, never as zero', () => {
    const observations = observationsFromMatrix(
      matrix([{ metric: { customer_id: 'acme' }, values: [] }])
    );

    // For `mcp_calls <= 0` the difference between absent and zero is a customer
    // who went quiet versus an exporter that died.
    expect(observations[0]?.value).toBeUndefined();
  });

  it('survives a shape it did not expect', () => {
    expect(observationsFromMatrix(undefined)).toEqual([]);
    expect(observationsFromMatrix({})).toEqual([]);
    expect(observationsFromMatrix({ data: { result: 'nope' } })).toEqual([]);
  });
});

describe('naming this producer to gtmsrv', () => {
  /**
   * gtmsrv stamps the source from the credential and rejects a request whose
   * `source` disagrees with it — a 400, deliberately, so a producer cannot name
   * itself as another producer.
   *
   * That rejection is invisible in the worst way from here: this job treats any
   * non-2xx as "try again", so a hardcoded name that stops matching would retry
   * every crossing forever and deliver none. Hence configuration, not a
   * constant.
   */
  it('sends its own name on the shared token, where nothing better exists', () => {
    vi.stubEnv('GTM_INGEST_SOURCE', undefined as unknown as string);
    expect(sourceField()).toEqual({ source: DEFAULT_SOURCE_NAME });
    vi.unstubAllEnvs();
  });

  it('sends the configured name, for a credential registered under one', () => {
    vi.stubEnv('GTM_INGEST_SOURCE', 'Product');
    expect(sourceField()).toEqual({ source: 'Product' });
    vi.unstubAllEnvs();
  });

  it('omits the field entirely when configured empty, letting the credential decide', () => {
    vi.stubEnv('GTM_INGEST_SOURCE', '');
    expect(sourceField()).toEqual({});
    vi.unstubAllEnvs();
  });
});

describe('gtmsrvMeasures', () => {
  const rule = {
    id: 'msr_1',
    workspaceId: 'ws-uuid',
    name: 'Queue backing up',
    projectId: 'gitgraph',
    promql: 'max(queue_depth)',
    operator: 'gt' as const,
    threshold: 100,
    forSeconds: 900,
    signalKind: 'queue_backlog',
  };

  it('is off unless both the URL and the token are set', () => {
    expect(gtmsrvMeasures(undefined, 't')).toBeUndefined();
    expect(gtmsrvMeasures('http://gtmsrv:8848', undefined)).toBeUndefined();
  });

  it('lists rules and posts a crossing with its workspace, bearer-authenticated', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/platform/measure-rules')) {
        return new Response(JSON.stringify({ rules: [rule] }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const gtm = gtmsrvMeasures('http://gtmsrv:8848/', 'sekret', fake)!;

    expect(await gtm.rules()).toEqual([rule]);
    const ok = await gtm.emit(
      {
        ruleId: 'msr_1',
        seriesKey: '',
        kind: 'queue_backlog',
        dedupeKey: 'measure:msr_1:abc',
        strength: 100,
        evidence: { value: 140 },
        occurredAt: '2026-09-27T10:00:00.000Z',
      },
      'ws-uuid'
    );
    expect(ok).toBe(true);
    const post = calls[1]!;
    expect(post.url).toBe('http://gtmsrv:8848/platform/measure-crossings');
    expect((post.init?.headers as Record<string, string>).authorization).toBe('Bearer sekret');
    const body = JSON.parse(String(post.init?.body));
    expect(body).toMatchObject({ rule_id: 'msr_1', workspace_id: 'ws-uuid', kind: 'queue_backlog', dedupe_key: 'measure:msr_1:abc' });
    expect(body.subject).toBeUndefined();
  });

  it('treats a refusal or an unknown workspace as not delivered', async () => {
    const refusing = (async () => new Response('nope', { status: 403 })) as unknown as typeof fetch;
    const gtm = gtmsrvMeasures('http://gtmsrv:8848', 't', refusing)!;
    const e = { ruleId: 'x', seriesKey: '', kind: 'k', dedupeKey: 'd', strength: 1, evidence: {}, occurredAt: '' };
    expect(await gtm.emit(e, 'ws')).toBe(false);
    expect(await gtm.emit(e, undefined)).toBe(false);
    expect(await gtm.rules()).toEqual([]);
  });
});
