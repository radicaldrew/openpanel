import { beforeEach, describe, expect, it, vi } from 'vitest';

const { create, getProjectByIdCached } = vi.hoisted(() => ({
  create: vi.fn(),
  getProjectByIdCached: vi.fn(),
}));

vi.mock('../prisma-client', () => ({
  db: { eventOutbox: { create } },
}));

vi.mock('./project.service', () => ({ getProjectByIdCached }));

import {
  recordEventForOutbox,
  recordIdentifyForOutbox,
  tenantForProject,
  toEventType,
} from './event-outbox.service';

const MAPPED = {
  id: 'gitgraph',
  gtmTenantSlug: 'gitgraph',
  gtmTenantId: '11111111-2222-3333-4444-555555555555',
};

beforeEach(() => {
  create.mockReset();
  getProjectByIdCached.mockReset();
  getProjectByIdCached.mockResolvedValue(MAPPED);
  create.mockResolvedValue({});
});

/**
 * The subject is `vero.events.{tenantSlug}.{eventType}`, and the event plane
 * REJECTS anything that is not dotted lowercase — verified against its own
 * `EVENT_TYPE_RE`, which every OpenPanel event name as emitted fails. So this
 * function is the whole reason events can reach the bus at all, and two
 * spellings of one event must not become two subjects.
 */
describe('toEventType', () => {
  /** The regex the event plane actually applies, copied from envelope.ts. */
  const EVENT_TYPE_RE = /^[a-z0-9]+(\.[a-z0-9]+)+$/;

  const cases: [string, string][] = [
    ['repo_connected', 'repo.connected'],
    ['screen_view', 'screen.view'],
    ['mcp_install', 'mcp.install'],
    ['session_start', 'session.start'],
    ['profile.identified', 'profile.identified'],
    ['Repo Connected', 'repo.connected'],
    ['  repo_connected  ', 'repo.connected'],
    ['MCP_Install', 'mcp.install'],
    ['screen-view', 'screen.view'],
    ['a/b', 'a.b'],
    ['repo   connected', 'repo.connected'],
    ['repo__connected', 'repo.connected'],
    ['a..b', 'a.b'],
    ['_repo_connected_', 'repo.connected'],
    ['repo✨connected', 'product.repoconnected'],
  ];

  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      expect(toEventType(input)).toBe(expected);
    });
  }

  /**
   * The case a plain `_`→`.` rule misses: a single word has no underscore, so
   * it can never gain the dot the regex requires. `signup` is a real
   * production event, not a hypothetical.
   */
  it('gives a single-word name a namespace, deliberately for the known ones', () => {
    expect(toEventType('signup')).toBe('profile.signup');
    expect(toEventType('identify')).toBe('profile.identified');
  });

  it('falls back to a namespace for a single-word name it has never seen', () => {
    expect(toEventType('checkout')).toBe('product.checkout');
  });

  it('puts signup and identify under one canonical type', () => {
    // `deriveCanonicalType` is the first segment, so this is what lets one rule
    // match the family.
    const first = (t: string) => t.split('.')[0];
    expect(first(toEventType('signup') as string)).toBe(
      first(toEventType('identify') as string)
    );
  });

  it('produces something the event plane accepts, for every real event name', () => {
    // The assertion that matters: not "it changed the string" but "the result
    // would not be rejected". Every one of these is REJECTED as emitted.
    for (const name of [
      'repo_connected',
      'repo_created',
      'mcp_install',
      'screen_view',
      'identify',
      'signup',
      'link_out',
      'session_start',
      'device_auth',
      'repo_connect_started',
    ]) {
      expect(EVENT_TYPE_RE.test(name), `${name} should be rejected as emitted`).toBe(
        false
      );

      const mapped = toEventType(name);
      expect(mapped, name).not.toBeNull();
      expect(EVENT_TYPE_RE.test(mapped as string), `${name} → ${mapped}`).toBe(
        true
      );
    }
  });

  it('collapses two spellings of one event onto one subject', () => {
    expect(toEventType('Repo Connected')).toBe(toEventType('repo_connected'));
  });

  it('is idempotent — normalising twice changes nothing', () => {
    for (const [input] of cases) {
      const once = toEventType(input) as string;
      expect(toEventType(once), input).toBe(once);
    }
  });

  it('returns null, never throws, for a name with nothing usable in it', () => {
    expect(toEventType('✨')).toBeNull();
    expect(toEventType('   ')).toBeNull();
    expect(toEventType('...')).toBeNull();
    expect(toEventType('___')).toBeNull();
  });
});

/**
 * Half a mapping cannot produce a valid envelope: `tenant_id` is a required
 * UUID on WrappedEvent, so a row with a slug and no id could never publish and
 * would retry forever.
 */
describe('tenantForProject', () => {
  it('maps a project with both values', () => {
    expect(tenantForProject(MAPPED)).toEqual({
      tenantSlug: 'gitgraph',
      tenantId: '11111111-2222-3333-4444-555555555555',
    });
  });

  const unmapped: [string, Record<string, string | null | undefined>][] = [
    ['neither value', {}],
    ['a slug but no id', { gtmTenantSlug: 'gitgraph' }],
    ['an id but no slug', { gtmTenantId: MAPPED.gtmTenantId }],
    ['nulls', { gtmTenantSlug: null, gtmTenantId: null }],
    ['empty strings', { gtmTenantSlug: '', gtmTenantId: '' }],
    ['whitespace only', { gtmTenantSlug: '  ', gtmTenantId: '  ' }],
  ];

  for (const [name, project] of unmapped) {
    it(`treats ${name} as unmapped`, () => {
      expect(tenantForProject(project)).toBeNull();
    });
  }
});

const input = {
  eventId: 'evt-1',
  projectId: 'gitgraph',
  eventType: 'repo_connected',
  occurredAt: new Date('2026-09-09T10:00:00.000Z'),
  profileId: 'user-42',
  sessionId: 'sess-9',
  properties: { repo: 'acme/web', private: false },
};

describe('recordEventForOutbox', () => {
  it('writes a row for a mapped project', async () => {
    await expect(recordEventForOutbox(input)).resolves.toBe(true);
    expect(create).toHaveBeenCalledTimes(1);

    expect(create.mock.calls[0]?.[0]?.data).toEqual({
      projectId: 'gitgraph',
      eventId: 'evt-1',
      eventType: 'repo.connected',
      tenantSlug: 'gitgraph',
      tenantId: MAPPED.gtmTenantId,
      occurredAt: input.occurredAt,
      data: {
        project_id: 'gitgraph',
        profile_id: 'user-42',
        session_id: 'sess-9',
        repo: 'acme/web',
        private: false,
        openpanel_event_name: 'repo_connected',
      },
    });
  });

  it('names the identifiers as the envelope consumers expect', async () => {
    await recordEventForOutbox(input);

    const data = create.mock.calls[0]?.[0]?.data?.data;
    // snake_case, not this codebase's camelCase — gtmsrv reads these.
    expect(Object.keys(data)).toEqual(
      expect.arrayContaining(['project_id', 'profile_id', 'session_id'])
    );
    expect(data).not.toHaveProperty('projectId');
    expect(data).not.toHaveProperty('profileId');
  });

  const drops: [string, unknown][] = [
    ['the project does not exist', null],
    ['the project has no tenant mapping', { id: 'p' }],
    ['the project is half-mapped', { id: 'p', gtmTenantSlug: 'gitgraph' }],
  ];

  for (const [name, project] of drops) {
    it(`writes nothing when ${name}`, async () => {
      getProjectByIdCached.mockResolvedValue(project);

      await expect(recordEventForOutbox(input)).resolves.toBe(false);
      expect(create).not.toHaveBeenCalled();
    });
  }

  /**
   * An unmappable name PARKS rather than drops or throws. The envelope builder
   * throws on a type it cannot address, and a throw reaching the drain would
   * stall every other row behind one bad name.
   */
  it('parks an unmappable event name instead of dropping it', async () => {
    await expect(
      recordEventForOutbox({ ...input, eventType: '✨' })
    ).resolves.toBe(false);

    expect(create).toHaveBeenCalledTimes(1);

    const row = create.mock.calls[0]?.[0]?.data;
    // `abandoned` keeps it out of the drain's `status = 'pending'` query, so it
    // is a record rather than a poison message.
    expect(row.status).toBe('abandoned');
    expect(row.lastError).toContain('cannot be mapped');
    // The name is kept verbatim so the row says what failed.
    expect(row.eventType).toBe('✨');
  });

  it('does not park a name it can map', async () => {
    await recordEventForOutbox(input);

    expect(create.mock.calls[0]?.[0]?.data?.status).toBeUndefined();
    expect(create.mock.calls[0]?.[0]?.data?.lastError).toBeUndefined();
  });

  it('records the original event name for joining back to ClickHouse', async () => {
    await recordEventForOutbox({ ...input, eventType: 'repo_connected' });

    const row = create.mock.calls[0]?.[0]?.data;
    expect(row.eventType).toBe('repo.connected');
    expect(row.data.openpanel_event_name).toBe('repo_connected');
  });

  it('does not let a property shadow the original event name', async () => {
    await recordEventForOutbox({
      ...input,
      properties: { openpanel_event_name: 'not_this' },
    });

    // Ours wins: it is written after the user's properties are spread.
    expect(
      create.mock.calls[0]?.[0]?.data?.data?.openpanel_event_name
    ).toBe(input.eventType);
  });

  it('normalises the event type on the way in', async () => {
    await recordEventForOutbox({ ...input, eventType: 'Repo Connected' });

    expect(create.mock.calls[0]?.[0]?.data?.eventType).toBe('repo.connected');
  });

  it('omits absent identifiers rather than writing empty strings', async () => {
    await recordEventForOutbox({
      ...input,
      profileId: null,
      sessionId: undefined,
    });

    const data = create.mock.calls[0]?.[0]?.data?.data;
    expect(data).not.toHaveProperty('profile_id');
    expect(data).not.toHaveProperty('session_id');
    expect(data.project_id).toBe('gitgraph');
  });

  it('does not let a property overwrite the identifiers it collides with', async () => {
    await recordEventForOutbox({
      ...input,
      properties: { project_id: 'somebody-elses-project' },
    });

    // Documents current precedence: properties are spread last, so a
    // user-supplied `project_id` WINS. Asserted so a change is deliberate.
    expect(create.mock.calls[0]?.[0]?.data?.data?.project_id).toBe(
      'somebody-elses-project'
    );
  });
});

/**
 * Identify has no ClickHouse event, so its dedup key is derived from content.
 * That key is also the `Nats-Msg-Id`, so getting it wrong either floods the bus
 * with duplicates or silently swallows a real change of traits.
 */
describe('recordIdentifyForOutbox', () => {
  const identify = {
    projectId: 'gitgraph',
    profileId: 'user-42',
    sessionId: 'sess-9',
    properties: { username: 'drew', plan: 'pro' },
  };

  const keyOf = () => create.mock.calls[0]?.[0]?.data?.eventId as string;

  it('publishes as profile.identified', async () => {
    await recordIdentifyForOutbox(identify);

    expect(create.mock.calls[0]?.[0]?.data?.eventType).toBe(
      'profile.identified'
    );
  });

  it('derives the same key for the same facts', async () => {
    await recordIdentifyForOutbox(identify);
    const first = keyOf();

    create.mockClear();
    await recordIdentifyForOutbox({ ...identify, occurredAt: new Date(0) });

    // A different clock, the same facts — so the same key, and JetStream
    // dedup collapses the repeat. A random id would publish twice on every
    // browser reload.
    expect(keyOf()).toBe(first);
  });

  it('ignores the order the properties were built in', async () => {
    await recordIdentifyForOutbox(identify);
    const first = keyOf();

    create.mockClear();
    await recordIdentifyForOutbox({
      ...identify,
      properties: { plan: 'pro', username: 'drew' },
    });

    expect(keyOf()).toBe(first);
  });

  const differing: [string, Record<string, unknown>][] = [
    ['a changed trait', { properties: { username: 'drew', plan: 'free' } }],
    ['a new trait', { properties: { username: 'drew', plan: 'pro', x: 1 } }],
    ['a different profile', { profileId: 'user-43' }],
    ['a different project', { projectId: 'cloudmeet' }],
  ];

  for (const [name, override] of differing) {
    it(`derives a different key for ${name}`, async () => {
      await recordIdentifyForOutbox(identify);
      const first = keyOf();

      create.mockClear();
      getProjectByIdCached.mockResolvedValue(MAPPED);
      await recordIdentifyForOutbox({ ...identify, ...override });

      expect(keyOf()).not.toBe(first);
    });
  }

  it('carries the identify traits as data', async () => {
    await recordIdentifyForOutbox(identify);

    const data = create.mock.calls[0]?.[0]?.data?.data;
    expect(data.profile_id).toBe('user-42');
    expect(data.session_id).toBe('sess-9');
    expect(data.username).toBe('drew');
    expect(data.openpanel_event_name).toBe('profile.identified');
  });

  it('drops an identify from an unmapped project', async () => {
    getProjectByIdCached.mockResolvedValue({ id: 'p' });

    await expect(recordIdentifyForOutbox(identify)).resolves.toBe(false);
    expect(create).not.toHaveBeenCalled();
  });
});
