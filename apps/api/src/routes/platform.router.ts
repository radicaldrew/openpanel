import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZodOpenApi } from 'fastify-zod-openapi';
import * as controller from '@/controllers/platform.controller';
import { platformTokenMatches, zCreateOrganization } from '@/controllers/platform.controller';
import { activateRateLimiter } from '@/utils/rate-limiter';

/**
 * Mounted only when PLATFORM_ADMIN_TOKEN is set (app.ts). Authenticated by
 * `openpanel-platform-token`, compared in constant time.
 */
const platformRouter: FastifyPluginAsyncZodOpenApi = async (fastify) => {
  await activateRateLimiter({ fastify, max: 10, timeWindow: '10 seconds' });

  fastify.addHook('preHandler', async (req: FastifyRequest, reply) => {
    const presented = req.headers['openpanel-platform-token'];
    if (!platformTokenMatches(typeof presented === 'string' ? presented : undefined, process.env.PLATFORM_ADMIN_TOKEN)) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid platform token' });
    }
  });

  fastify.route({
    method: 'POST',
    url: '/organizations',
    schema: {
      body: zCreateOrganization,
      tags: ['Platform'],
      hide: true,
      description: 'Create an organisation with a root client scoped to it (gtm-platform).',
    },
    handler: controller.createOrganization,
  });
};

export default platformRouter;
