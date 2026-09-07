import { db } from '@openpanel/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

/**
 * The body of `POST /annotations`.
 *
 * Note what is NOT here: `projectId`. The client secret already names exactly
 * one project, and taking the id from the body as well would create a second,
 * forgeable answer to "whose annotation is this" — the same class of bug the
 * telemetry tenancy design exists to avoid.
 */
export const zAnnotationApiBody = z.object({
  // Defaults to now, which is what a deploy hook means when it posts nothing.
  time: z.string().datetime().optional(),
  timeEnd: z.string().datetime().nullish(),
  text: z.string().min(1).max(2000),
  tags: z.array(z.string().max(50)).max(20).default([]),
  // Omit for a global annotation: shown on every dashboard in the project.
  dashboardId: z.string().nullish(),
});

export type IAnnotationApiBody = z.infer<typeof zAnnotationApiBody>;

export async function createAnnotation(
  request: FastifyRequest<{ Body: IAnnotationApiBody }>,
  reply: FastifyReply,
) {
  const projectId = request.client?.projectId;

  if (!projectId) {
    return reply
      .status(400)
      .send({ error: 'Bad Request', message: 'Client has no project' });
  }

  const { time, timeEnd, text, tags, dashboardId } = request.body;

  // Bind the dashboard to the authenticated project before storing the id,
  // otherwise this project's notes would appear on another organization's
  // board.
  if (dashboardId) {
    const dashboard = await db.dashboard.findFirst({
      where: { id: dashboardId, projectId },
      select: { id: true },
    });

    if (!dashboard) {
      return reply
        .status(404)
        .send({ error: 'Not Found', message: 'Dashboard not found' });
    }
  }

  const annotation = await db.annotation.create({
    data: {
      projectId,
      dashboardId: dashboardId ?? null,
      time: time ? new Date(time) : new Date(),
      timeEnd: timeEnd ? new Date(timeEnd) : null,
      text,
      tags,
      // No user is involved: the credential is a client secret, so the row
      // records where it came from rather than inventing an author.
      createdBy: null,
      source: 'api',
    },
  });

  return reply.status(201).send(annotation);
}
