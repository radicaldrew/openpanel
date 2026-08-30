import { describe, expect, it } from 'vitest';
import {
  encodeLengthDelimited,
  encodeStringField,
  encodeTag,
} from '../otlp/wire';
import { seriesKeysFromMetricsPayload } from '../otlp/series-keys';
import {
  CircuitBreaker,
  CircuitOpenError,
} from './breaker';
import {
  DEFAULT_SERIES_BUDGET,
  checkCardinalityBudget,
  type CardinalityCounter,
} from './cardinality';

// --- fixtures ---------------------------------------------------------------

const kv = (key: string, value: string) =>
  Buffer.concat([
    encodeStringField(1, key),
    encodeLengthDelimited(2, encodeStringField(1, value)),
  ]);

const numberDataPoint = (attrs: Uint8Array[]) =>
  Buffer.concat([
    ...attrs.map((a) => encodeLengthDelimited(7, a)),
    Buffer.concat([encodeTag(3, 1), Buffer.alloc(8)]),
  ]);

const request = (name: string, dataPoints: Uint8Array[]) =>
  encodeLengthDelimited(
    1,
    Buffer.concat([
      encodeLengthDelimited(1, Buffer.concat([])),
      encodeLengthDelimited(
        2,
        encodeLengthDelimited(
          2,
          Buffer.concat([
            encodeStringField(1, name),
            encodeLengthDelimited(
              7, // Sum
              Buffer.concat(
                dataPoints.map((dp) => encodeLengthDelimited(1, dp)),
              ),
            ),
          ]),
        ),
      ),
    ]),
  );

// --- series keys ------------------------------------------------------------

describe('seriesKeysFromMetricsPayload', () => {
  it('builds one key per distinct label set', () => {
    const body = request('http_requests', [
      numberDataPoint([kv('route', '/a')]),
      numberDataPoint([kv('route', '/b')]),
    ]);

    expect(seriesKeysFromMetricsPayload(body).sort()).toEqual([
      'http_requests{route=/a}',
      'http_requests{route=/b}',
    ]);
  });

  it('is order-independent, so one series cannot look like several', () => {
    // OTLP does not guarantee attribute ordering. Without the sort, the same
    // series arriving with attributes in a different order would inflate the
    // count and eventually trip the budget for no reason.
    const a = request('m', [numberDataPoint([kv('x', '1'), kv('y', '2')])]);
    const b = request('m', [numberDataPoint([kv('y', '2'), kv('x', '1')])]);

    expect(seriesKeysFromMetricsPayload(a)).toEqual(
      seriesKeysFromMetricsPayload(b),
    );
  });

  it('deduplicates repeated points of the same series within one export', () => {
    // A normal export carries many points for one series over time; counting
    // those separately would make the budget meaningless.
    const body = request('m', [
      numberDataPoint([kv('route', '/a')]),
      numberDataPoint([kv('route', '/a')]),
      numberDataPoint([kv('route', '/a')]),
    ]);

    expect(seriesKeysFromMetricsPayload(body)).toEqual(['m{route=/a}']);
  });

  it('sees a runaway label for what it is', () => {
    const body = request(
      'http_requests',
      Array.from({ length: 50 }, (_, i) =>
        numberDataPoint([kv('request_id', `req-${i}`)]),
      ),
    );

    expect(seriesKeysFromMetricsPayload(body)).toHaveLength(50);
  });

  it('returns nothing for an empty payload', () => {
    expect(seriesKeysFromMetricsPayload(new Uint8Array(0))).toEqual([]);
  });
});

// --- cardinality budget -----------------------------------------------------

function setCounter(): CardinalityCounter & { seen: Set<string> } {
  const seen = new Set<string>();
  return {
    seen,
    async observe(_projectId, keys) {
      for (const k of keys) seen.add(k);
      return seen.size;
    },
  };
}

describe('checkCardinalityBudget', () => {
  it('allows a payload inside the budget', async () => {
    const decision = await checkCardinalityBudget(
      'p1',
      ['a', 'b'],
      setCounter(),
      10,
    );

    expect(decision.allowed).toBe(true);
    expect(decision.estimated).toBe(2);
  });

  it('rejects once the estimate passes the limit', async () => {
    const counter = setCounter();
    await checkCardinalityBudget('p1', ['a', 'b', 'c'], counter, 3);

    const decision = await checkCardinalityBudget('p1', ['d'], counter, 3);

    expect(decision.allowed).toBe(false);
    expect(decision.estimated).toBe(4);
    expect(decision.limit).toBe(3);
  });

  it('names a few offenders without dumping thousands', async () => {
    const keys = Array.from({ length: 500 }, (_, i) => `m{id=${i}}`);
    const decision = await checkCardinalityBudget('p1', keys, setCounter(), 10);

    expect(decision.allowed).toBe(false);
    expect(decision.sample).toHaveLength(5);
  });

  it('FAILS OPEN when the counter is unavailable', async () => {
    // Deliberately the opposite of the tenancy checks. A Redis outage must not
    // reject a customer's telemetry; the budget guards slow growth over days.
    const broken: CardinalityCounter = {
      async observe() {
        throw new Error('redis down');
      },
    };

    const decision = await checkCardinalityBudget('p1', ['a'], broken, 1);
    expect(decision.allowed).toBe(true);
  });

  it('skips the counter entirely for an empty payload', async () => {
    const counter = setCounter();
    const decision = await checkCardinalityBudget('p1', [], counter, 0);

    expect(decision.allowed).toBe(true);
    expect(counter.seen.size).toBe(0);
  });

  it('has a default budget', () => {
    expect(DEFAULT_SERIES_BUDGET).toBeGreaterThan(0);
  });
});

// --- circuit breaker --------------------------------------------------------

describe('CircuitBreaker', () => {
  const ok = () => Promise.resolve('ok');
  const fail = () => Promise.reject(new Error('backend down'));

  it('stays closed while calls succeed', async () => {
    const b = new CircuitBreaker({ failureThreshold: 2 });
    await expect(b.run(ok)).resolves.toBe('ok');
    expect(b.state).toBe('closed');
  });

  it('opens after the threshold and then rejects WITHOUT calling through', async () => {
    let calls = 0;
    const counted = () => {
      calls += 1;
      return Promise.reject(new Error('down'));
    };

    const b = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000 });
    await expect(b.run(counted)).rejects.toThrow('down');
    await expect(b.run(counted)).rejects.toThrow('down');

    expect(b.state).toBe('open');
    expect(calls).toBe(2);

    // The point of the breaker: this one must not reach the network at all.
    await expect(b.run(counted)).rejects.toThrow(CircuitOpenError);
    expect(calls).toBe(2);
  });

  it('a success resets the failure count', async () => {
    const b = new CircuitBreaker({ failureThreshold: 3 });
    await expect(b.run(fail)).rejects.toThrow();
    await expect(b.run(fail)).rejects.toThrow();
    await expect(b.run(ok)).resolves.toBe('ok');
    await expect(b.run(fail)).rejects.toThrow();

    expect(b.state).toBe('closed');
  });

  it('half-opens after the cooldown and closes on a successful probe', async () => {
    let clock = 1000;
    const b = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 500,
      now: () => clock,
    });

    await expect(b.run(fail)).rejects.toThrow();
    expect(b.state).toBe('open');

    clock += 500;
    expect(b.state).toBe('half_open');

    await expect(b.run(ok)).resolves.toBe('ok');
    expect(b.state).toBe('closed');
  });

  it('a failing probe restarts the cooldown instead of staying probe-able', async () => {
    let clock = 1000;
    const b = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 500,
      now: () => clock,
    });

    await expect(b.run(fail)).rejects.toThrow();
    clock += 500;
    expect(b.state).toBe('half_open');

    await expect(b.run(fail)).rejects.toThrow();
    // Without re-stamping openedAt this would still read half_open, letting
    // every caller probe a dead backend forever.
    expect(b.state).toBe('open');
  });

  it('admits only one probe at a time in half_open', async () => {
    let clock = 1000;
    const b = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 100,
      now: () => clock,
    });

    await expect(b.run(fail)).rejects.toThrow();
    clock += 100;

    let release: (v: string) => void = () => {};
    const slow = () => new Promise<string>((r) => { release = r; });

    const first = b.run(slow);
    // Concurrent caller is rejected rather than queued — queueing would rebuild
    // the pile-up the breaker exists to prevent.
    await expect(b.run(ok)).rejects.toThrow(CircuitOpenError);

    release('done');
    await expect(first).resolves.toBe('done');
    expect(b.state).toBe('closed');
  });

  it('reports how long until the next probe', async () => {
    let clock = 1000;
    const b = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 1000,
      now: () => clock,
    });

    await expect(b.run(fail)).rejects.toThrow();
    expect(b.retryAfterMs()).toBe(1000);

    clock += 400;
    expect(b.retryAfterMs()).toBe(600);

    clock += 600;
    expect(b.retryAfterMs()).toBe(0);
  });
});
