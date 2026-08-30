import { describe, expect, it } from 'vitest';
import {
  type AlertConfig,
  type SeriesState,
  stepSeries,
} from './state-machine';

const config: AlertConfig = {
  operator: 'gt',
  threshold: 100,
  forSeconds: 300,
  cooldownSeconds: 1800,
};

const PERIOD = 60;
const T0 = 1_700_000_000_000;

const step = (
  previous: SeriesState | undefined,
  value: number | undefined,
  at: number,
  overrides: Partial<AlertConfig> = {},
) =>
  stepSeries({
    previous,
    value,
    at,
    periodSeconds: PERIOD,
    config: { ...config, ...overrides },
  });

describe('basic transitions', () => {
  it('stays inactive while the condition is false', () => {
    const r = step(undefined, 50, T0);
    expect(r.state.state).toBe('inactive');
    expect(r.transition.kind).toBe('none');
  });

  it('goes pending on the first breach, without notifying', () => {
    // A `for` duration exists precisely so a single spike does not page anyone.
    const r = step(undefined, 150, T0);
    expect(r.state.state).toBe('pending');
    expect(r.transition.kind).toBe('pending');
  });

  it('fires once the condition has held for the full duration', () => {
    // Evaluated every period, as the cron actually does. Stepping in larger
    // jumps than the staleness window would (correctly) restart the pending
    // timer, which is the behaviour the staleness tests below cover.
    let state = step(undefined, 150, T0).state;
    expect(state.state).toBe('pending');

    for (let t = PERIOD * 1000; t < 300_000; t += PERIOD * 1000) {
      const r = step(state, 150, T0 + t);
      expect(r.state.state, `at +${t}ms`).toBe('pending');
      state = r.state;
    }

    const r = step(state, 150, T0 + 300_000);
    expect(r.state.state).toBe('firing');
    expect(r.transition).toEqual({ kind: 'fire', value: 150 });
  });

  it('resolves when the condition clears', () => {
    const firing: SeriesState = {
      state: 'firing',
      pendingSince: T0,
      lastNotifiedAt: T0 + 300_000,
      lastEvaluatedAt: T0 + 300_000,
    };

    const r = step(firing, 50, T0 + 360_000);
    expect(r.state.state).toBe('inactive');
    expect(r.transition.kind).toBe('resolve');
  });

  it('does NOT send a resolve for a pending alert that never fired', () => {
    // Nobody was told it was pending, so nobody needs telling it stopped.
    const pending: SeriesState = {
      state: 'pending',
      pendingSince: T0,
      lastEvaluatedAt: T0,
    };

    const r = step(pending, 50, T0 + 60_000);
    expect(r.state.state).toBe('inactive');
    expect(r.transition.kind).toBe('none');
  });
});

describe('cooldown', () => {
  it('does not re-notify while firing inside the cooldown', () => {
    const firing: SeriesState = {
      state: 'firing',
      lastNotifiedAt: T0,
      lastEvaluatedAt: T0,
    };

    const r = step(firing, 150, T0 + 600_000);
    expect(r.state.state).toBe('firing');
    expect(r.transition.kind).toBe('none');
  });

  it('re-notifies once the cooldown has elapsed', () => {
    const firing: SeriesState = {
      state: 'firing',
      lastNotifiedAt: T0,
      lastEvaluatedAt: T0,
    };

    const r = step(firing, 150, T0 + 1_800_000);
    expect(r.transition).toEqual({ kind: 'refire', value: 150 });
    expect(r.state.lastNotifiedAt).toBe(T0 + 1_800_000);
  });
});

describe('missing data', () => {
  it('does NOT resolve a firing alert when the series disappears', () => {
    // A service that died stops reporting. Resolving there would silence the
    // alert at exactly the moment it matters most.
    const firing: SeriesState = {
      state: 'firing',
      lastNotifiedAt: T0,
      lastEvaluatedAt: T0,
    };

    const r = step(firing, undefined, T0 + 60_000);
    expect(r.state.state).toBe('firing');
    expect(r.transition.kind).toBe('none');
  });

  it('holds a pending timer rather than restarting it', () => {
    const pending: SeriesState = {
      state: 'pending',
      pendingSince: T0,
      lastEvaluatedAt: T0,
    };

    const r = step(pending, undefined, T0 + 60_000);
    expect(r.state.pendingSince).toBe(T0);
  });

  it('records that it looked, so staleness is measured correctly', () => {
    const r = step(undefined, undefined, T0);
    expect(r.state.lastEvaluatedAt).toBe(T0);
  });
});

describe('staleness — the restart case', () => {
  it('does NOT fire immediately after a long evaluation gap', () => {
    // The bug this prevents: a worker down for an hour comes back, sees a
    // pendingSince from before the outage, computes `now - pendingSince > for`
    // and fires — claiming the condition held across an hour nobody observed.
    const pending: SeriesState = {
      state: 'pending',
      pendingSince: T0,
      lastEvaluatedAt: T0,
    };

    const r = step(pending, 150, T0 + 3_600_000);

    expect(r.state.state).toBe('pending');
    expect(r.transition.kind).toBe('none');
    // The timer restarted from now, not from before the gap.
    expect(r.state.pendingSince).toBe(T0 + 3_600_000);
  });

  it('keeps the timer across a normal evaluation interval', () => {
    const pending: SeriesState = {
      state: 'pending',
      pendingSince: T0,
      lastEvaluatedAt: T0,
    };

    const r = step(pending, 150, T0 + 60_000);
    expect(r.state.pendingSince).toBe(T0);
  });

  it('tolerates a gap up to the staleness window', () => {
    const pending: SeriesState = {
      state: 'pending',
      pendingSince: T0,
      lastEvaluatedAt: T0,
    };

    // 3 periods exactly — at the boundary, still trusted.
    const r = step(pending, 150, T0 + 3 * PERIOD * 1000);
    expect(r.state.pendingSince).toBe(T0);
  });
});

describe('operators', () => {
  it.each([
    ['gt', 101, true],
    ['gt', 100, false],
    ['gte', 100, true],
    ['lt', 99, true],
    ['lt', 100, false],
    ['lte', 100, true],
  ] as const)('%s %i -> %s', (operator, value, shouldBreach) => {
    const r = step(undefined, value, T0, { operator, forSeconds: 0 });
    expect(r.state.state).toBe(shouldBreach ? 'firing' : 'inactive');
  });
});

describe('for: 0', () => {
  it('fires on the first breach when no duration is required', () => {
    const r = step(undefined, 150, T0, { forSeconds: 0 });
    expect(r.transition).toEqual({ kind: 'fire', value: 150 });
  });
});

describe('idempotency under duplicate delivery', () => {
  it('a repeated evaluation at the same instant does not double-notify', () => {
    // BullMQ delivers at least once, so the same evaluation can run twice.
    const first = step(undefined, 150, T0, { forSeconds: 0 });
    expect(first.transition.kind).toBe('fire');

    const second = step(first.state, 150, T0, { forSeconds: 0 });
    // Still firing, but the cooldown suppresses a second notification.
    expect(second.state.state).toBe('firing');
    expect(second.transition.kind).toBe('none');
  });
});
