import { Prisma } from '@openpanel/db';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZodOpenApi } from 'fastify-zod-openapi';
import {
  createAnnotation,
  zAnnotationApiBody,
} from '@/controllers/annotation.controller';
import { validateAnnotationRequest } from '@/utils/auth';
import { activateRateLimiter } from '@/utils/rate-limiter';

/**
 * Annotations posted by infrastructure — a deploy marker, an incident note —
 * so they show up on the metric charts for the same minute.
 *
 * Authenticated with the project's client id + secret, exactly like /import
 * and /insights, which is what makes the project id implicit rather than a
 * body field.
 */
const annotationsRouter: FastifyPluginAsyncZodOpenApi = async (fastify) => {
  await activateRateLimiter({ fastify, max: 60, timeWindow: '10 seconds' });

  fastify.addHook('preHandler', async (req: FastifyRequest, reply) => {
    try {
      const client = await validateAnnotationRequest(req.headers);
      req.client = client;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError) {
        return reply.status(401).send({
          error: 'Unauthorized',
          message: 'Client ID seems to be malformed',
        });
      }

      if (e instanceof Error) {
        return reply
          .status(401)
          .send({ error: 'Unauthorized', message: e.message });
      }

      return reply
        .status(401)
        .send({ error: 'Unauthorized', message: 'Unexpected error' });
    }
  });

  await fastify.route({
    method: 'POST',
    url: '/',
    schema: {
      body: zAnnotationApiBody,
      tags: ['Annotations'],
      description:
        'Mark a point or span on this project’s metric charts (deploy, incident, note). Responds 201 with the created annotation.',
    },
    handler: createAnnotation,
  });
};

export default annotationsRouter;
