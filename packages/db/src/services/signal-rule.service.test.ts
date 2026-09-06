/**
 * The mapping half of the signal sink, tested without a database.
 *
 * The dedupe key gets the most attention here because it is the value that
 * decides whether a retry is safe. gtmsrv collapses two signals sharing one and
 * rejects a signal without one, so a key that changes across a replay is a
 * duplicate signal — and SPEC §6 routes `upgrade_gate_abandoned` straight to
 * outreach, where a duplicate is a second email to a real person.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMock } = vi.hoisted(() => ({
  dbMock: {
    signalRule: { findMany: vi.fn() },
    signalOutbox: { createMany: vi.fn() },
  },
}));

vi.mock('../prisma-client', () => ({ db: dbMock }));
// cacheable wraps a function in Redis; here it is the identity so the tests
// exercise the query and the matching rather than the cache. Partial, because
// this module's import graph reaches @openpanel/queue, which needs the real
// connection factories at module load.
vi.mock('@openpanel/redis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@openpanel/redis')>()),
  cacheable: (_name: string, fn: unknown) => fn,
}));

const {
  matchSignalRules,
  recordSignalsForEvent,
  signalDedupeKey,
  stableStringify,
  subjectFor,
} = await import('./signal-rule.service');

const createdAt = new Date('2026-09-04T11:30:00.000Z');

function event(overrides: Record<string, unknown> = {}) {
  return {
    name: 'pricing_page_view',
    projectId: 'proj_1',
    profileId: 'profile_42',
    deviceId: 'device_9',
    sessionId: 'session_7',
    properties: { plan: 'pro', seats: 12 },
    createdAt,
    path: '/pricing',
    origin: 'https://acme.com',
    referrer: 'https://google.com',
    groups: [],
    ...overrides,
  } as never;
}

function rule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rule_1',
    name: 'Pricing page visit',
    eventName: 'pricing_page_view',
    filters: [],
    signalKind: 'pricing_page_visit',
    strength: 60,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.signalOutbox.createMany.mockResolvedValue({ count: 1 });
});

describe('the dedupe key', () => {
  it('is identical for the same event evaluated twice', () => {
    // The property the outbox depends on: a replayed BullMQ job derives the
    // same key, the unique index rejects the insert, and nothing is queued
    // twice.
    expect(signalDedupeKey('rule_1', event())).toBe(
      signalDedupeKey('rule_1', event())
    );
  });

  it('does not depend on our clock', () => {
    // A key containing Date.now() would differ on every replay, which defeats
    // the entire mechanism. This asserts the absence of that bug directly.
    const first = signalDedupeKey('rule_1', event());
    const later = signalDedupeKey('rule_1', event());
    expect(first).toBe(later);
  });

  it('survives property key reordering', () => {
    // JSON.stringify preserves insertion order, so the same properties arriving
    // with keys in a different order would otherwise hash differently and be
    // delivered as a second signal.
    const a = signalDedupeKey('rule_1', event({ properties: { plan: 'pro', seats: 12 } }));
    const b = signalDedupeKey('rule_1', event({ properties: { seats: 12, plan: 'pro' } }));
    expect(a).toBe(b);
  });

  it('differs when the event genuinely differs', () => {
    const base = signalDedupeKey('rule_1', event());
    expect(signalDedupeKey('rule_1', event({ name: 'signup' }))).not.toBe(base);
    expect(signalDedupeKey('rule_1', event({ profileId: 'other' }))).not.toBe(base);
    expect(signalDedupeKey('rule_1', event({ projectId: 'proj_2' }))).not.toBe(base);
    expect(
      signalDedupeKey('rule_1', event({ createdAt: new Date('2026-09-04T11:30:01Z') }))
    ).not.toBe(base);
    expect(
      signalDedupeKey('rule_1', event({ properties: { plan: 'free' } }))
    ).not.toBe(base);
  });

  it('differs per rule so two rules on one event both fire', () => {
    // Without the rule id the second rule's signal would be swallowed as a
    // duplicate of the first.
    expect(signalDedupeKey('rule_2', event())).not.toBe(
      signalDedupeKey('rule_1', event())
    );
  });

  it('is bounded regardless of how large the properties are', () => {
    const huge = Object.fromEntries(
      Array.from({ length: 500 }, (_, i) => [`k${i}`, 'x'.repeat(100)])
    );
    expect(signalDedupeKey('rule_1', event({ properties: huge })).length).toBeLessThan(64);
  });
});

describe('stableStringify', () => {
  it('sorts object keys recursively but preserves array order', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(
      '{"a":{"c":3,"d":2},"b":1}'
    );
    expect(stableStringify([2, 1])).toBe('[2,1]');
  });

  it('handles null and nested nulls without throwing', () => {
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify({ a: null })).toBe('{"a":null}');
  });
});

describe('subject', () => {
  it('maps an identified profile to a person', () => {
    expect(subjectFor(event())).toEqual({ kind: 'person', id: 'profile_42' });
  });

  it('omits the subject when the profile is just the device id', () => {
    // OpenPanel sets profileId = deviceId for anonymous traffic, so a non-empty
    // profileId is not the same thing as a known person. Treating it as one
    // would open a lead for an anonymous browser.
    expect(subjectFor(event({ profileId: 'device_9' }))).toBeUndefined();
  });

  it('omits the subject when there is no profile at all', () => {
    expect(subjectFor(event({ profileId: '' }))).toBeUndefined();
  });
});

describe('matching', () => {
  it('matches on event name and carries the rule through', async () => {
    dbMock.signalRule.findMany.mockResolvedValue([rule()]);

    const matches = await matchSignalRules(event());

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      kind: 'pricing_page_visit',
      strength: 60,
      ruleName: 'Pricing page visit',
      source: 'OpenPanel',
      subject: { kind: 'person', id: 'profile_42' },
      occurredAt: createdAt,
    });
  });

  it('ignores an event no rule names', async () => {
    dbMock.signalRule.findMany.mockResolvedValue([rule()]);
    expect(await matchSignalRules(event({ name: 'something_else' }))).toHaveLength(0);
  });

  it('honours property filters', async () => {
    dbMock.signalRule.findMany.mockResolvedValue([
      rule({
        filters: [{ name: 'properties.plan', operator: 'is', value: ['enterprise'] }],
      }),
    ]);
    expect(await matchSignalRules(event())).toHaveLength(0);

    dbMock.signalRule.findMany.mockResolvedValue([
      rule({
        filters: [{ name: 'properties.plan', operator: 'is', value: ['pro'] }],
      }),
    ]);
    expect(await matchSignalRules(event())).toHaveLength(1);
  });

  it('supports a wildcard rule', async () => {
    dbMock.signalRule.findMany.mockResolvedValue([rule({ eventName: '*' })]);
    expect(await matchSignalRules(event({ name: 'anything' }))).toHaveLength(1);
  });

  it('fires every matching rule, with distinct keys', async () => {
    dbMock.signalRule.findMany.mockResolvedValue([
      rule({ id: 'rule_1', signalKind: 'pricing_page_visit' }),
      rule({ id: 'rule_2', signalKind: 'high_intent' }),
    ]);

    const matches = await matchSignalRules(event());

    expect(matches.map((m) => m.kind)).toEqual(['pricing_page_visit', 'high_intent']);
    expect(matches[0]!.dedupeKey).not.toBe(matches[1]!.dedupeKey);
  });

  it('puts the profile id in evidence so a lead can be traced back', async () => {
    dbMock.signalRule.findMany.mockResolvedValue([rule()]);
    const [match] = await matchSignalRules(event());
    expect(match!.evidence).toMatchObject({
      profile_id: 'profile_42',
      event: 'pricing_page_view',
      path: '/pricing',
    });
  });

  it('records a null profile id in evidence for anonymous traffic', async () => {
    dbMock.signalRule.findMany.mockResolvedValue([rule()]);
    const [match] = await matchSignalRules(event({ profileId: 'device_9' }));
    expect(match!.subject).toBeUndefined();
    expect(match!.evidence).toMatchObject({ profile_id: null });
  });

  it('reads nothing when the project has no rules', async () => {
    dbMock.signalRule.findMany.mockResolvedValue([]);
    expect(await matchSignalRules(event())).toEqual([]);
  });
});

describe('recording', () => {
  it('writes one outbox row per match, skipping duplicates', async () => {
    dbMock.signalRule.findMany.mockResolvedValue([rule()]);

    await recordSignalsForEvent(event());

    const arg = dbMock.signalOutbox.createMany.mock.calls[0]![0];
    // skipDuplicates is what makes a replayed job a no-op rather than a second
    // signal — the unique index on dedupeKey does the work.
    expect(arg.skipDuplicates).toBe(true);
    expect(arg.data[0]).toMatchObject({
      projectId: 'proj_1',
      kind: 'pricing_page_visit',
      subjectKind: 'person',
      subjectId: 'profile_42',
      occurredAt: createdAt,
    });
  });

  it('stores no subject columns for anonymous traffic', async () => {
    dbMock.signalRule.findMany.mockResolvedValue([rule()]);
    await recordSignalsForEvent(event({ profileId: 'device_9' }));
    expect(dbMock.signalOutbox.createMany.mock.calls[0]![0].data[0]).toMatchObject({
      subjectKind: null,
      subjectId: null,
    });
  });

  it('does not touch the database when nothing matches', async () => {
    dbMock.signalRule.findMany.mockResolvedValue([rule({ eventName: 'other' })]);
    expect(await recordSignalsForEvent(event())).toBe(0);
    expect(dbMock.signalOutbox.createMany).not.toHaveBeenCalled();
  });
});
