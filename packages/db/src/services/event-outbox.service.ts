import { createHash } from 'node:crypto';
import { getProjectByIdCached } from './project.service';
import { db } from '../prisma-client';
import type { IServiceCreateEventPayload } from './event.service';

/**
 * The write half of the OpenPanel → NATS event plane.
 *
 * Every ACCEPTED event gets a row here; a separate drain job builds a
 * `WrappedEvent` from it and publishes on
 * `vero.events.{tenantSlug}.{eventType}`. That is the difference from
 * `SignalOutbox`, which holds only the events a `SignalRule` matched and tells
 * gtmsrv what they mean: here the rule table lives on the gtmsrv side, so
 * everything goes and gtmsrv decides. Both paths run side by side until the
 * NATS pipe is proven.
 *
 * WHY THE TENANT IS RESOLVED HERE AND NOT IN THE DRAIN
 *
 * An unmapped project's events must not be published at all, and that is a
 * routing decision — making it at write time means no unroutable row is ever
 * created, and it leaves the drain a dumb pipe that reads a row and sends it.
 * A drain that resolved tenants could mis-route; this one cannot.
 *
 * The tradeoff, stated so the next reader does not file it as a bug: a row
 * carries the mapping it was written with. Remapping a project does not
 * re-address rows already queued — they publish to the tenant the events were
 * accepted under, which is what they belonged to when they happened.
 */

/**
 * The shape the event plane accepts, copied from
 * `services/event-plane/src/envelope.ts`.
 *
 * Copied rather than imported because that package is in another repository and
 * is not a dependency here. Verified by running it: every OpenPanel event name
 * as emitted — `repo_connected`, `screen_view`, `identify`, `signup` — is
 * REJECTED. It requires at least one dot and permits no underscore, so the
 * names cannot go on the bus unmapped.
 */
const EVENT_TYPE_RE = /^[a-z0-9]+(\.[a-z0-9]+)+$/;

/**
 * Names whose dotted form is a decision rather than a transliteration.
 *
 * A single-word name has no underscore to turn into a dot, so `_`→`.` cannot
 * produce a valid type for it — `signup` and `identify` are real events with
 * that shape. Both are put under `profile.` so they share a `canonical_type`
 * with each other (`deriveCanonicalType` is just the first segment), which is
 * what lets a rule match the whole family.
 *
 * This table is the contract with gtmsrv's `signal_rules` seed. A second,
 * subtly different copy over there is how the two sides drift, so it lives in
 * one place and is exported.
 */
/** The event type an `identify` call publishes as. */
export const PROFILE_IDENTIFIED_EVENT_TYPE = 'profile.identified';

export const EVENT_TYPE_OVERRIDES: Readonly<Record<string, string>> = {
  identify: PROFILE_IDENTIFIED_EVENT_TYPE,
  signup: 'profile.signup',
};

/**
 * The namespace a single-word name falls back to.
 *
 * Only reached by a name not in the table above — an event that ships after
 * this code was written. `product.` rather than a guess at its meaning: it says
 * where the event came from, which is true, instead of inventing a category.
 */
const FALLBACK_NAMESPACE = 'product';

/**
 * Turn an OpenPanel event name into an event type the bus will accept.
 *
 * Returns `null` when the name cannot be mapped at all, which the caller parks
 * rather than publishing. It never throws: an unmappable name arriving on the
 * ingest path must cost one event, not the pipeline.
 *
 * Order matters. The override table wins, so a deliberate name is never
 * overridden by the mechanical rule; then an already-dotted name passes through
 * unchanged; then `_`→`.`; then the namespace prefix for whatever is left.
 */
export function toEventType(name: string): string | null {
  const normalised = name
    .trim()
    .toLowerCase()
    .replace(/[\s\-/\\]+/g, '_')
    .replace(/[^a-z0-9._]/g, '')
    .replace(/_{2,}/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^[._]+|[._]+$/g, '');

  if (!normalised) {
    return null;
  }

  const override = EVENT_TYPE_OVERRIDES[normalised];

  if (override) {
    return override;
  }

  // `_` is not legal in an event type, so this is a conversion, not a choice:
  // `repo_connected` has exactly one dotted reading.
  const dotted = normalised.replace(/_/g, '.');

  const candidate = dotted.includes('.')
    ? dotted
    : `${FALLBACK_NAMESPACE}.${dotted}`;

  // Belt and braces. Everything above should produce a valid type; if some
  // input defeats it, say so here rather than letting the drain find out by
  // throwing mid-publish.
  return EVENT_TYPE_RE.test(candidate) ? candidate : null;
}

export interface EventOutboxTenant {
  tenantSlug: string;
  tenantId: string;
}

/**
 * The project's tenant mapping, or null when it has none.
 *
 * BOTH values are required. A project with a slug and no id (or the reverse) is
 * treated as unmapped rather than half-mapped: `tenant_id` is a mandatory UUID
 * on the envelope, so a row missing it could never be published and would sit
 * in the outbox failing forever.
 */
export function tenantForProject(project: {
  gtmTenantSlug?: string | null;
  gtmTenantId?: string | null;
}): EventOutboxTenant | null {
  const tenantSlug = project.gtmTenantSlug?.trim();
  const tenantId = project.gtmTenantId?.trim();

  if (!(tenantSlug && tenantId)) {
    return null;
  }

  return { tenantSlug, tenantId };
}

export interface RecordEventForOutboxInput {
  /** The ClickHouse event id — the dedup key and the `Nats-Msg-Id`. */
  eventId: string;
  projectId: string;
  eventType: string;
  occurredAt: Date;
  profileId?: string | null;
  sessionId?: string | null;
  properties?: Record<string, unknown>;
}

/**
 * Queue one accepted event for the bus.
 *
 * Returns whether a row was written, so a caller can count drops. Never throws
 * for an unmapped project — that is the normal case for every project that is
 * not wired to gtmsrv, which is most of them.
 */
export async function recordEventForOutbox(
  input: RecordEventForOutboxInput,
): Promise<boolean> {
  const project = await getProjectByIdCached(input.projectId);

  if (!project) {
    return false;
  }

  const tenant = tenantForProject(project);

  if (!tenant) {
    return false;
  }

  const eventType = toEventType(input.eventType);

  // The envelope builder THROWS on an event type it cannot address. If that
  // throw reached the drain it would stall every other row behind one bad name,
  // so an unmappable name is parked here instead: the row is written for the
  // record, with the reason, and `abandoned` keeps it out of the drain's
  // `status = 'pending'` query. One event fails to publish; nothing else stops.
  const abandoned = eventType === null;

  await db.eventOutbox.create({
    data: {
      projectId: input.projectId,
      eventId: input.eventId,
      // Kept verbatim so the row says what could not be mapped. It is never
      // published — `abandoned` rows are not drained.
      eventType: eventType ?? input.eventType,
      tenantSlug: tenant.tenantSlug,
      tenantId: tenant.tenantId,
      occurredAt: input.occurredAt,
      ...(abandoned
        ? {
            status: 'abandoned',
            lastError: `Event name ${JSON.stringify(input.eventType)} cannot be mapped to a dotted event type`,
          }
        : {}),
      data: {
        // The identifiers gtmsrv joins on, named as the envelope's consumers
        // expect rather than in this codebase's camelCase.
        project_id: input.projectId,
        ...(input.profileId ? { profile_id: input.profileId } : {}),
        ...(input.sessionId ? { session_id: input.sessionId } : {}),
        ...(input.properties ?? {}),
        // The name as OpenPanel recorded it. ClickHouse still holds the
        // snake_case name, so without this, joining a bus event back to its
        // source row means knowing the mapping by heart. Written LAST so a
        // user-defined property cannot shadow it — this one is ours.
        openpanel_event_name: input.eventType,
      },
    },
  });

  return !abandoned;
}

/**
 * Queue an accepted event from the analytics ingest path.
 *
 * Takes the payload the worker already holds plus the id `createEvent`
 * generated, so the row points at the event that was actually stored rather
 * than at a second identity invented here.
 */
export async function recordIncomingEventForOutbox(
  payload: IServiceCreateEventPayload,
  eventId: string,
): Promise<boolean> {
  return recordEventForOutbox({
    eventId,
    projectId: payload.projectId,
    eventType: payload.name,
    occurredAt: payload.createdAt,
    profileId: payload.profileId ? String(payload.profileId) : null,
    sessionId: payload.sessionId,
    properties: payload.properties as Record<string, unknown> | undefined,
  });
}

/**
 * Queue an `identify` call as `profile.identified`.
 *
 * Identify does NOT go through the analytics ingest path — the API upserts the
 * profile directly (`handleIdentify` → `upsertProfile`) and no ClickHouse event
 * row is ever created. So there is no event id to use as the dedup key, and one
 * has to be derived.
 *
 * Derived from the CONTENT, never from a clock or a random source, matching the
 * convention `SignalOutbox.dedupeKey` already sets. The consequence is
 * deliberate: identifying the same profile with the same traits twice is the
 * same fact and publishes once, while a change in traits is a new fact and
 * publishes again. A random id would put a duplicate on the bus every time the
 * browser re-identified on a reload.
 */
export async function recordIdentifyForOutbox(input: {
  projectId: string;
  profileId: string;
  sessionId?: string | null;
  properties?: Record<string, unknown>;
  occurredAt?: Date;
}): Promise<boolean> {
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify([
        input.projectId,
        input.profileId,
        // Sorted so an object built in a different key order is the same fact.
        Object.entries(input.properties ?? {}).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      ]),
    )
    .digest('hex');

  return recordEventForOutbox({
    eventId: `identify-${fingerprint}`,
    projectId: input.projectId,
    eventType: PROFILE_IDENTIFIED_EVENT_TYPE,
    occurredAt: input.occurredAt ?? new Date(),
    profileId: input.profileId,
    sessionId: input.sessionId,
    properties: input.properties,
  });
}
