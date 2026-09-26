import crypto from 'node:crypto';
import { hashPassword } from '@openpanel/common/server';
import { db, getId } from '@openpanel/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

/**
 * The platform-admin API: one OpenPanel organisation per gtm-platform customer
 * (gtm-platform docs/PLAN-signals-tracking.md, Phase A1).
 *
 * OpenPanel only ever creates an organisation through onboarding, for a
 * signed-in dashboard user. gtmsrv has no such user: it provisions an
 * organisation per customer workspace and then works inside it with a root
 * client scoped to that organisation — so OpenPanel itself, not a filter in
 * gtmsrv, is what keeps one customer out of another's projects.
 */

/**
 * The owner every platform-made organisation gets. Not a login (no user row):
 * `cron.delete` removes any organisation with no `org:admin` member, so an
 * organisation that only a root client uses would be deleted on the next run.
 */
export const PLATFORM_OWNER_EMAIL = 'gtmsrv@gtmswarm.com';

// Mirrors onboarding's allowance so a platform org is never "limit exceeded".
const EVENTS_LIMIT = 10_000_000;

export const zCreateOrganization = z.object({
  name: z.string().min(1).max(120),
  // The gtm workspace this organisation belongs to, recorded for operators.
  workspaceId: z.string().uuid().optional(),
  timezone: z.string().optional(),
});

/**
 * Whether a presented platform token is the configured one. Constant-time, and
 * false when none is configured — the route is not even mounted then, but
 * this must not be the thing that fails open if it ever is.
 */
export function platformTokenMatches(
  presented: string | undefined,
  configured: string | undefined,
): boolean {
  if (!configured || configured.length < 32 || !presented) return false;
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(configured).digest();
  return crypto.timingSafeEqual(a, b);
}

export async function createOrganization(
  request: FastifyRequest<{ Body: z.infer<typeof zCreateOrganization> }>,
  reply: FastifyReply,
) {
  const { name, workspaceId, timezone } = request.body;
  const organizationId = await getId('organization', name);
  const secret = `sec_${crypto.randomBytes(24).toString('hex')}`;

  const [organization, , client] = await db.$transaction([
    db.organization.create({
      data: {
        id: organizationId,
        name,
        subscriptionStatus: 'active',
        subscriptionPeriodEventsLimit: EVENTS_LIMIT,
        timezone: timezone ?? 'UTC',
        onboarding: '',
      },
    }),
    db.member.create({
      data: {
        email: PLATFORM_OWNER_EMAIL,
        organizationId,
        role: 'org:admin',
        meta: workspaceId ? { gtmWorkspaceId: workspaceId } : undefined,
      },
    }),
    db.client.create({
      data: {
        name: 'gtmsrv (root)',
        organizationId,
        type: 'root',
        secret: await hashPassword(secret),
      },
    }),
  ]);

  reply.send({
    data: {
      organizationId: organization.id,
      name: organization.name,
      // Returned once. OpenPanel keeps only the hash.
      client: { id: client.id, secret },
    },
  });
}
