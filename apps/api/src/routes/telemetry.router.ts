import { isGigapipeEnabled } from '@openpanel/gigapipe';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import * as controller from '@/controllers/telemetry.controller';
import { logger } from '@/utils/logger';
import { activateRateLimiter } from '@/utils/rate-limiter';
import {
  TelemetryAuthError,
  validateTelemetryRequest,
} from '@/utils/telemetry-auth';
import { checkTelemetryQuota } from '@/utils/telemetry-quota';

/**
 * Telemetry ingest, mounted at /telemetry.
 *
 * Encapsulated as its own plugin with no imports from the tRPC layer, so that
 * if telemetry volume starts competing with event ingestion for the same event
 * loop it can be lifted into a standalone deployment by moving this directory
 * and its two dependencies (Prisma client, Redis cache) — a mechanical change
 * rather than an untangling.
 *
 * The route table is short on purpose. gigapipe serves far more than this, and
 * every route added here is a route someone has to prove carries a tenant
 * predicate. Not exposed, deliberately:
 *
 *   /v1/logs, /loki/api/v1/push  — logs are P3. Forwarding OTLP logs to
 *       gigapipe is specifically ruled out: its OTLP log decoder promotes every
 *       resource, scope AND record attribute to a stream label including
 *       trace_id, and the fingerprint covers the whole label set, so one trace
 *       id is one new series (~10k new series/s at 10k lines/s) with no
 *       configuration to disable it. Logs will be decoded here and pushed as
 *       Loki JSON with a closed label allowlist.
 *       See docs/observability/14-decisions.md D5.
 *   /v1/traces                   — P4.
 *   Prometheus remote-write      — deferred within P1; it needs snappy plus
 *       sorted label insertion, and an OTel Collector can already scrape
 *       Prometheus and forward as OTLP.
 */

const OTLP_PROTOBUF = 'application/x-protobuf';

const telemetryRouter: FastifyPluginAsync = async (fastify) => {
  // Telemetry is optional. When gigapipe is not configured the routes are not
  // registered at all, so a probe gets a 404 rather than a 503 that implies a
  // broken feature.
  if (!isGigapipeEnabled()) {
    logger.info(
      'Telemetry ingest disabled (GIGAPIPE_URL / GIGAPIPE_USER / GIGAPIPE_PASSWORD not all set)',
    );
    return;
  }

  await activateRateLimiter({ fastify, max: 600, timeWindow: '10 seconds' });

  // OTLP arrives as an opaque protobuf body. Fastify has no parser for this
  // content type by default, and we want the raw bytes rather than any parsed
  // representation — the whole rewrite works at wire level precisely so that
  // nothing reinterprets the payload.
  fastify.addContentTypeParser(
    OTLP_PROTOBUF,
    { parseAs: 'buffer', bodyLimit: 16 * 1024 * 1024 },
    (_req, body, done) => done(null, body),
  );

  fastify.addHook('preHandler', async (req: FastifyRequest, reply) => {
    try {
      const principal = await validateTelemetryRequest(req);
      req.client = principal.client;
      req.telemetryProjectId = principal.projectId;
    } catch (e) {
      // Deliberately uniform: the caller learns that the credential was not
      // accepted, never which half was wrong, and never whether a client id
      // exists.
      if (e instanceof TelemetryAuthError) {
        req.log.warn({ reason: e.message }, 'telemetry: auth rejected');
      } else {
        req.log.error({ err: e }, 'telemetry: auth error');
      }

      return reply
        .status(401)
        .header('www-authenticate', 'Bearer')
        .send({ error: 'Unauthorized' });
    }
  });

  /**
   * Quota, checked once for every ingest route rather than per handler.
   *
   * Placed after auth (it needs the project) and before the body is parsed, so
   * an over-quota project costs a header read rather than a protobuf decode.
   * 429 with Retry-After is what OTLP and remote-write clients back off on;
   * dropping the data silently would be worse than refusing it.
   */
  fastify.addHook('preHandler', async (req: FastifyRequest, reply) => {
    const projectId = req.telemetryProjectId;
    if (!projectId) {
      return;
    }

    const size = Number(req.headers['content-length'] ?? 0) || 0;
    const decision = await checkTelemetryQuota(projectId, size);

    if (!decision.allowed) {
      req.log.warn(
        { projectId, usedBytes: decision.usedBytes, limitBytes: decision.limitBytes },
        'telemetry: quota exceeded',
      );

      return reply
        .status(429)
        .header('retry-after', '3600')
        .send({
          error: 'Too Many Requests',
          message:
            'Telemetry quota for this billing period is exhausted. Usage resets at the start of next month.',
        });
    }
  });

  fastify.route({
    method: 'POST',
    url: '/v1/metrics',
    handler: controller.otlpMetrics,
  });

  fastify.route({
    method: 'POST',
    url: '/v1/logs',
    handler: controller.otlpLogs,
  });

  fastify.route({
    method: 'POST',
    url: '/v1/traces',
    handler: controller.otlpTraces,
  });

  fastify.route({
    method: 'POST',
    url: '/api/v1/write',
    handler: controller.promRemoteWrite,
  });
};

export default telemetryRouter;
