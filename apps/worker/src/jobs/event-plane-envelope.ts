/**
 * The wrapped event envelope — VENDORED, not authored here.
 *
 * SOURCE OF TRUTH: `services/event-plane/src/types/wrapped-envelope.ts` and
 * `services/event-plane/src/envelope.ts` in the gtm-platform repository. This is
 * a copy because that code lives in a different repository with no shared
 * workspace; it is NOT a second design, and it must not become one.
 *
 * WHY A SECOND SHAPE IS WORSE THAN A COPY
 *
 * All three live consumers parse this envelope through `fromWrappedEnvelope`.
 * Hand a them a differently-shaped event and it reads an absent `ts_ms`,
 * evaluates `new Date(undefined).toISOString()`, throws a RangeError, and the
 * consumer's own try/catch swallows it — the event is **dropped with a warning,
 * never dead-lettered**. Silent loss, no error anyone sees. That is why the
 * brief says share or vendor, and never hand-roll.
 *
 * KEEPING IT HONEST: `event-plane-envelope.test.ts` asserts the exact field set
 * and the derivations. If the upstream file changes, that test is what should
 * fail — update both together or the drift is invisible until events start
 * disappearing.
 */

import { createHash } from 'node:crypto';

/** Root of every subject this publishes (EVENT-PLANE.md §5). */
export const SUBJECT_ROOT = 'vero.events';

/**
 * Guaranteed-non-empty `channel_id` when the envelope's `data` carries none.
 * Consumer validators reject an empty `channel_id`, which is why a product
 * event — which has no channel at all — uses this rather than omitting it.
 */
export const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

export type Direction = 'inbound' | 'outbound' | 'internal';

export interface WrappedEvent<T = Record<string, unknown>> {
  /** Envelope schema version. Currently always `1`. */
  schema_version: number;
  /** Deterministic event id, used as the idempotency / dedup key. */
  event_id: string;
  /** Dotted lowercase event type, e.g. `message.received`. */
  event_type: string;
  /** Event timestamp as epoch milliseconds. */
  ts_ms: number;
  /** Owning tenant id (UUID). */
  tenant_id: string;
  /** Producing service. Becomes `adapter_type` when unwrapped. */
  source: string;
  /** Type-specific event data. Carries `channel_id` and `direction`. */
  data: T;
}

export interface EventInput {
  /** Owning tenant UUID. Goes in the envelope. */
  tenantId: string;
  /** Tenant subject token. Goes in the subject, never the envelope. */
  tenantSlug: string;
  /** Channel UUID. `ZERO_UUID` for anything with no channel. */
  channelId: string;
  /** Dotted lowercase, e.g. `repo.connected`. */
  eventType: string;
  direction: Direction;
  /** Producing adapter. Becomes `source` / `adapter_type`. */
  source: string;
  /**
   * The producer's own id for this thing. Hashed into a stable `event_id` so a
   * retry produces the same envelope — which is what makes `Nats-Msg-Id`
   * deduplicate a redelivery rather than admitting a second copy.
   */
  externalId?: string;
  occurredAt?: Date;
  payload: Record<string, unknown>;
}

/**
 * A tenant slug is a subject token, so it must be one: NATS splits on `.` and
 * treats `*` and `>` as wildcards. A slug with a dot in it silently changes the
 * shape of every subject that tenant publishes.
 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * A lowercase UUID satisfies SLUG_RE — it is only hex and hyphens. So "slug,
 * not UUID" is a convention the shape cannot enforce on its own, and passing
 * the UUID through would silently undo it while every test still passed.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Dotted lowercase segments — at least one dot, and NO underscores.
 *
 * Worth reading twice before writing a producer: OpenPanel's own event names
 * (`repo_connected`, `mcp_install`, `screen_view`) all FAIL this. They have to
 * be translated to dotted form before they reach an envelope.
 */
const EVENT_TYPE_RE = /^[a-z0-9]+(\.[a-z0-9]+)+$/;

export function assertValidSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new Error(
      `invalid tenant_slug ${JSON.stringify(slug)}: must match ${SLUG_RE} (a subject token — no dots, no wildcards)`,
    );
  }
  if (UUID_RE.test(slug)) {
    throw new Error(
      `invalid tenant_slug ${JSON.stringify(slug)}: that is a UUID. Subjects carry the slug and the envelope carries the UUID (EVENT-PLANE.md §5).`,
    );
  }
}

export function assertValidEventType(eventType: string): void {
  if (!EVENT_TYPE_RE.test(eventType)) {
    throw new Error(
      `invalid event_type ${JSON.stringify(eventType)}: must be dotted lowercase, e.g. "repo.connected"`,
    );
  }
}

/**
 * `vero.events.{tenant_slug}.{event_type}` — EVENT-PLANE.md §5.
 *
 * No `canonical_type` token: it is the first segment of `event_type`, so
 * including both would yield `repo.repo.connected`.
 */
export function subjectFor(tenantSlug: string, eventType: string): string {
  assertValidSlug(tenantSlug);
  assertValidEventType(eventType);
  return `${SUBJECT_ROOT}.${tenantSlug}.${eventType}`;
}

/** The first segment of a dotted event type. */
export function deriveCanonicalType(eventType: string): string {
  return (eventType.split('.')[0] ?? '').toLowerCase();
}

/**
 * A deterministic UUIDv5 over a producer's own id (RFC 4122 §4.3).
 *
 * `WrappedEvent.event_id` is the dedup key at both ends: JetStream collapses a
 * repeat via `Nats-Msg-Id`, and the consumer's store keys on it. Deriving it
 * from the producer's id means a redelivery is the same event rather than a
 * second one.
 */
export function deterministicEventId(
  source: string,
  externalId: string,
): string {
  const NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'; // DNS namespace
  const nsBytes = Buffer.from(NAMESPACE.replace(/-/g, ''), 'hex');
  const name = Buffer.from(`${source}:${externalId}`, 'utf8');
  const hash = createHash('sha1')
    .update(Buffer.concat([nsBytes, name]))
    .digest();

  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant

  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

export function buildEvent(input: EventInput): WrappedEvent {
  assertValidSlug(input.tenantSlug);
  assertValidEventType(input.eventType);

  const occurredAt = input.occurredAt ?? new Date();
  const tsMs = occurredAt.getTime();
  if (!Number.isFinite(tsMs)) {
    throw new Error(
      `invalid occurredAt for ${input.eventType}: ${String(input.occurredAt)}`,
    );
  }

  // No producer identity means no dedupe. The upstream falls back to a random
  // UUID here; this vendored copy REQUIRES an externalId instead, because every
  // caller in this repo has one (the outbox row's `eventId`) and a random id
  // would silently turn a redelivery into a duplicate event.
  if (!input.externalId) {
    throw new Error(
      `externalId is required for ${input.eventType}: without it a redelivery becomes a second event`,
    );
  }

  return {
    schema_version: 1,
    event_id: deterministicEventId(input.source, input.externalId),
    event_type: input.eventType,
    ts_ms: tsMs,
    tenant_id: input.tenantId,
    source: input.source,
    data: {
      ...input.payload,
      channel_id: input.channelId,
      direction: input.direction,
    },
  };
}

/** Build the envelope and the subject together, so they cannot disagree. */
export function buildAddressedEvent(input: EventInput): {
  subject: string;
  event: WrappedEvent;
} {
  return {
    subject: subjectFor(input.tenantSlug, input.eventType),
    event: buildEvent(input),
  };
}
