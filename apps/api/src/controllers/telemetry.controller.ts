import { compressSync, uncompressSync } from 'snappy';
import {
  buildLokiPush,
  decodeOtlpLogs,
  pushLogs,
  CircuitOpenError,
  GIGAPIPE_ROUTES,
  GigapipeError,
  GigapipeNotConfiguredError,
  assertPayloadScopedTo,
  checkCardinalityBudget,
  postToGigapipe,
  seriesKeysFromMetricsPayload,
  stampOtlpMetricsRequest,
  stampOtlpTracesRequest,
  stampRemoteWriteRequest,
  readRemoteWriteProjectIds,
} from '@openpanel/gigapipe';
import { getRedisCache } from '@openpanel/redis';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  cardinalityCounter,
  gigapipeBreaker,
  seriesBudgetFor,
} from '@/utils/telemetry-admission';

/**
 * OTLP/HTTP metrics ingest.
 *
 * The whole handler is: authenticate (done in the router's preHandler), rewrite
 * the payload so it carries exactly this project's label, verify that it does,
 * forward, meter.
 *
 * Only protobuf is accepted. gigapipe does accept OTLP JSON on `/v1/metrics`,
 * but supporting a second encoding would double the surface of the one piece of
 * code that must never get the tenancy rewrite wrong — for one wire format that
 * no OTel SDK sends by default.
 */

const OTLP_CONTENT_TYPE = 'application/x-protobuf';

/**
 * Per-project ingest counters, for billing and for spotting a runaway service.
 *
 * Best-effort by design: a Redis blip must not reject telemetry that has
 * already been accepted and forwarded, so the counter is incremented after the
 * forward succeeds and its failure is swallowed. Under-counting on an outage is
 * the right direction — the alternative is charging for data we dropped.
 */
async function meter(projectId: string, bytes: number): Promise<void> {
  try {
    const redis = getRedisCache();
    // Hour-bucketed so a rollup job can sweep completed hours without racing
    // the current one. Timestamp comes from the request, not a stored clock.
    const bucket = new Date().toISOString().slice(0, 13);
    const key = `telemetry:usage:${projectId}:${bucket}`;

    await redis
      .multi()
      .hincrby(key, 'requests', 1)
      .hincrby(key, 'bytes', bytes)
      // Outlives the rollup window by a wide margin; the rollup deletes what it
      // has consumed, this is only a backstop against orphaned keys.
      .expire(key, 60 * 60 * 72)
      .exec();
  } catch {
    // Intentionally silent — see above.
  }
}

export async function otlpMetrics(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const projectId = req.telemetryProjectId;

  if (!projectId) {
    // Unreachable if the router's preHandler ran. Fail closed rather than
    // forward something unscoped.
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const body = req.body;

  if (!Buffer.isBuffer(body)) {
    return reply.status(415).send({
      error: 'Unsupported Media Type',
      message: `Send OTLP protobuf with Content-Type: ${OTLP_CONTENT_TYPE}`,
    });
  }

  if (body.length === 0) {
    // An empty export is legal and means nothing to do.
    return reply
      .status(200)
      .header('content-type', OTLP_CONTENT_TYPE)
      .send(Buffer.alloc(0));
  }

  let stamped: Uint8Array;
  try {
    stamped = stampOtlpMetricsRequest(body, projectId);
    // Never trust the rewrite blindly: re-read the payload and refuse to
    // forward if any resource carries a label for a different project. Turns a
    // future bug in the rewrite into a rejected request rather than a
    // cross-tenant write.
    assertPayloadScopedTo(stamped, projectId);
  } catch (error) {
    req.log.warn(
      { err: error, projectId },
      'telemetry: rejected malformed OTLP metrics payload',
    );
    return reply.status(400).send({
      error: 'Bad Request',
      message: 'Payload is not a valid OTLP metrics export',
    });
  }

  // Cardinality budget. Checked on the ORIGINAL body: the series identity that
  // matters is the customer's, and our own label is constant so it adds nothing
  // to the count. Fails open — see the note in the cardinality module.
  const decision = await checkCardinalityBudget(
    projectId,
    seriesKeysFromMetricsPayload(body),
    cardinalityCounter,
    seriesBudgetFor(projectId),
  );

  if (!decision.allowed) {
    req.log.warn(
      {
        projectId,
        estimated: decision.estimated,
        limit: decision.limit,
        sample: decision.sample,
      },
      'telemetry: series cardinality budget exceeded',
    );

    // 429 rather than 400: this is a quota, it clears on its own when the
    // offending series stop arriving, and OTLP clients back off on 429.
    return reply.status(429).header('retry-after', '60').send({
      error: 'Too Many Requests',
      message:
        `Series cardinality budget exceeded (~${decision.estimated} of ${decision.limit}). ` +
        'A label with unbounded values (request id, user id, URL with query string) is the usual cause. ' +
        `Sample: ${decision.sample.join(', ')}`,
    });
  }

  try {
    // Through the breaker: when gigapipe is unhealthy this rejects without a
    // network call, so a degraded backend cannot occupy event-loop slots in the
    // process that also serves /track.
    await gigapipeBreaker.run(() =>
      postToGigapipe(GIGAPIPE_ROUTES.otlpMetrics, stamped, OTLP_CONTENT_TYPE),
    );
  } catch (error) {
    if (error instanceof CircuitOpenError) {
      const seconds = Math.ceil(error.retryAfterMs / 1000);
      req.log.warn({ projectId, retryAfterMs: error.retryAfterMs }, 'telemetry: circuit open');
      return reply
        .status(503)
        .header('retry-after', String(Math.max(1, seconds)))
        .send({
          error: 'Service Unavailable',
          message: 'Telemetry backend is unhealthy, retry later',
        });
    }

    if (error instanceof GigapipeNotConfiguredError) {
      return reply.status(503).send({
        error: 'Service Unavailable',
        message: 'Telemetry ingest is not configured on this deployment',
      });
    }

    req.log.error({ err: error, projectId }, 'telemetry: forward failed');

    // 503 rather than 500: OTLP clients treat 503 as retryable and back off,
    // which is what we want while the backend recovers. A 500 makes many
    // clients drop the batch.
    const status =
      error instanceof GigapipeError && error.status === 400 ? 400 : 503;

    return reply.status(status).send({
      error: status === 400 ? 'Bad Request' : 'Service Unavailable',
      message:
        status === 400
          ? 'Telemetry backend rejected the payload'
          : 'Telemetry backend is unavailable, retry later',
    });
  }

  await meter(projectId, body.length);

  // ExportMetricsServiceResponse with no partial_success — every field is
  // optional, so the empty message is the correct success body.
  return reply
    .status(200)
    .header('content-type', OTLP_CONTENT_TYPE)
    .send(Buffer.alloc(0));
}


/**
 * OTLP/HTTP logs ingest.
 *
 * Unlike metrics, this does NOT forward the OTLP payload. gigapipe's own OTLP
 * log decoder promotes every resource, scope and record attribute — including
 * `trace_id` — to a stream label, and the stream fingerprint covers the whole
 * label set, so one trace id becomes one new stream (~10k/s for a busy
 * service) with no way to disable it. Worse, the fingerprint is part of the
 * storage key, so the damage cannot be repaired in place.
 *
 * So OpenPanel decodes the payload, builds a closed five-label stream set, and
 * pushes Loki JSON instead. See docs/observability/14-decisions.md D5.
 */
export async function otlpLogs(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const projectId = req.telemetryProjectId;

  if (!projectId) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const body = req.body;

  if (!Buffer.isBuffer(body)) {
    return reply.status(415).send({
      error: 'Unsupported Media Type',
      message: `Send OTLP protobuf with Content-Type: ${OTLP_CONTENT_TYPE}`,
    });
  }

  if (body.length === 0) {
    return reply
      .status(200)
      .header('content-type', OTLP_CONTENT_TYPE)
      .send(Buffer.alloc(0));
  }

  let push: ReturnType<typeof buildLokiPush>;
  try {
    const records = decodeOtlpLogs(body, {
      // Records with no usable clock are stamped on arrival rather than
      // dropped — a log line with an approximate time is far more useful than
      // no line at all.
      fallbackTimestampNs: `${Date.now()}000000`,
    });

    if (records.length === 0) {
      return reply
        .status(200)
        .header('content-type', OTLP_CONTENT_TYPE)
        .send(Buffer.alloc(0));
    }

    push = buildLokiPush(records, projectId);
  } catch (error) {
    req.log.warn(
      { err: error, projectId },
      'telemetry: rejected malformed OTLP logs payload',
    );
    return reply.status(400).send({
      error: 'Bad Request',
      message: 'Payload is not a valid OTLP logs export',
    });
  }

  try {
    await gigapipeBreaker.run(() => pushLogs(push));
  } catch (error) {
    if (error instanceof CircuitOpenError) {
      return reply
        .status(503)
        .header('retry-after', String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))))
        .send({
          error: 'Service Unavailable',
          message: 'Telemetry backend is unhealthy, retry later',
        });
    }

    if (error instanceof GigapipeNotConfiguredError) {
      return reply.status(503).send({
        error: 'Service Unavailable',
        message: 'Telemetry ingest is not configured on this deployment',
      });
    }

    req.log.error({ err: error, projectId }, 'telemetry: log forward failed');

    return reply.status(503).send({
      error: 'Service Unavailable',
      message: 'Telemetry backend is unavailable, retry later',
    });
  }

  await meter(projectId, body.length);

  return reply
    .status(200)
    .header('content-type', OTLP_CONTENT_TYPE)
    .send(Buffer.alloc(0));
}


/**
 * OTLP/HTTP traces ingest.
 *
 * Forwarded rather than rebuilt, unlike logs: gigapipe's trace decoder does not
 * promote attributes to stream labels, so there is no cardinality explosion to
 * avoid. The resource stamp is what lands `op_project_id` in
 * `tempo_traces_attrs_gin` — once per span — which is the predicate the read
 * path filters on.
 *
 * Reserved keys are stripped from span, event and link attributes as well as
 * the resource. See docs/observability/14-decisions.md D14.
 */
export async function otlpTraces(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const projectId = req.telemetryProjectId;

  if (!projectId) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const body = req.body;

  if (!Buffer.isBuffer(body)) {
    return reply.status(415).send({
      error: 'Unsupported Media Type',
      message: `Send OTLP protobuf with Content-Type: ${OTLP_CONTENT_TYPE}`,
    });
  }

  if (body.length === 0) {
    return reply
      .status(200)
      .header('content-type', OTLP_CONTENT_TYPE)
      .send(Buffer.alloc(0));
  }

  let stamped: Uint8Array;
  try {
    stamped = stampOtlpTracesRequest(body, projectId);
    assertPayloadScopedTo(stamped, projectId);
  } catch (error) {
    req.log.warn(
      { err: error, projectId },
      'telemetry: rejected malformed OTLP traces payload',
    );
    return reply.status(400).send({
      error: 'Bad Request',
      message: 'Payload is not a valid OTLP traces export',
    });
  }

  try {
    await gigapipeBreaker.run(() =>
      postToGigapipe(GIGAPIPE_ROUTES.otlpTraces, stamped, OTLP_CONTENT_TYPE),
    );
  } catch (error) {
    if (error instanceof CircuitOpenError) {
      return reply
        .status(503)
        .header('retry-after', String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))))
        .send({ error: 'Service Unavailable', message: 'Telemetry backend is unhealthy, retry later' });
    }

    if (error instanceof GigapipeNotConfiguredError) {
      return reply.status(503).send({
        error: 'Service Unavailable',
        message: 'Telemetry ingest is not configured on this deployment',
      });
    }

    req.log.error({ err: error, projectId }, 'telemetry: trace forward failed');
    return reply.status(503).send({
      error: 'Service Unavailable',
      message: 'Telemetry backend is unavailable, retry later',
    });
  }

  await meter(projectId, body.length);

  return reply
    .status(200)
    .header('content-type', OTLP_CONTENT_TYPE)
    .send(Buffer.alloc(0));
}


const REMOTE_WRITE_CONTENT_TYPE = 'application/x-protobuf';

/**
 * Prometheus remote-write 1.0.
 *
 * The body is snappy-compressed protobuf. It is decompressed here, stamped,
 * and re-compressed — gigapipe restores the original body when snappy decoding
 * fails, so sending it uncompressed would also work, but re-compressing keeps
 * the hop the same size the sender intended.
 */
export async function promRemoteWrite(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const projectId = req.telemetryProjectId;

  if (!projectId) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const body = req.body;

  if (!Buffer.isBuffer(body)) {
    return reply.status(415).send({
      error: 'Unsupported Media Type',
      message: 'Send snappy-compressed Prometheus remote-write protobuf',
    });
  }

  if (body.length === 0) {
    return reply.status(204).send();
  }

  let stamped: Buffer;
  try {
    const raw = uncompressSync(body) as Buffer;
    const rewritten = stampRemoteWriteRequest(raw, projectId);

    // Same belt-and-braces check as the OTLP path: never trust the rewrite.
    const wrong = readRemoteWriteProjectIds(rewritten).filter(
      (id) => id !== projectId,
    );
    if (wrong.length > 0) {
      throw new Error('rewrite produced a series scoped to another project');
    }

    stamped = compressSync(Buffer.from(rewritten)) as Buffer;
  } catch (error) {
    req.log.warn(
      { err: error, projectId },
      'telemetry: rejected malformed remote-write payload',
    );
    return reply.status(400).send({
      error: 'Bad Request',
      message: 'Payload is not a valid snappy-compressed remote-write request',
    });
  }

  try {
    await gigapipeBreaker.run(() =>
      postToGigapipe(
        GIGAPIPE_ROUTES.promRemoteWrite,
        stamped,
        REMOTE_WRITE_CONTENT_TYPE,
      ),
    );
  } catch (error) {
    if (error instanceof CircuitOpenError) {
      return reply
        .status(503)
        .header('retry-after', String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))))
        .send({ error: 'Service Unavailable', message: 'Telemetry backend is unhealthy, retry later' });
    }

    if (error instanceof GigapipeNotConfiguredError) {
      return reply.status(503).send({
        error: 'Service Unavailable',
        message: 'Telemetry ingest is not configured on this deployment',
      });
    }

    req.log.error({ err: error, projectId }, 'telemetry: remote-write forward failed');
    return reply.status(503).send({
      error: 'Service Unavailable',
      message: 'Telemetry backend is unavailable, retry later',
    });
  }

  await meter(projectId, body.length);

  // Prometheus expects 204 on success.
  return reply.status(204).send();
}
