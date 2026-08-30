import {
  executeMetricChart,
  getTelemetryLabelKeys,
  getTelemetryLabelValues,
  getTelemetryMetricNames,
  getTelemetryServices,
  getTrace,
  getTraceServices,
  getTracesForSession,
  searchTraces,
} from '@openpanel/db';
import { db } from '@openpanel/db';
import { zSavedTelemetryQuery } from '@openpanel/validation';
import {
  DEFAULT_LOG_LIMIT,
  GigapipeError,
  GigapipeNotConfiguredError,
  PromqlRewriteError,
  assertPromqlScoped,
  compileLogQuery,
  isGigapipeEnabled,
  queryRange,
  rewritePromqlForProject,
  parseLogEnvelope,
  queryLogPatterns,
  queryLogRange,
} from '@openpanel/gigapipe';
import { zTimeInterval } from '@openpanel/validation';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { getProjectAccess } from '../access';
import { TRPCForbiddenError } from '../errors';
import { createTRPCRouter, protectedProcedure } from '../trpc';

/**
 * Read-side telemetry API.
 *
 * Every procedure here is `protectedProcedure` plus an explicit project-access
 * check. There is deliberately no `shareId` path: the chart router accepts one
 * so public dashboards can render, and extending that to telemetry would let an
 * anonymous link execute PromQL against a shared backend. Public sharing of
 * metric reports is a separate decision with its own cost controls, and until
 * it is made the answer is no.
 */

const zMatcher = z.object({
  name: z.string().min(1).max(200),
  operator: z.enum(['eq', 'neq', 'match', 'notMatch']),
  value: z.string().max(2000),
});

/**
 * The structured query the UI builds. There is no raw-PromQL field, and that is
 * the point: the compiler is the only emitter of a selector, so there is no
 * user-controlled string to escape. Raw PromQL arrives later behind a real
 * parser.
 */
export const zMetricQueryInput = z.object({
  metric: z.string().min(1).max(200),
  matchers: z.array(zMatcher).max(20).default([]),
  fn: z.enum(['rate', 'increase', 'delta', 'raw']).default('rate'),
  aggregation: z
    .enum(['sum', 'avg', 'min', 'max', 'count', 'p50', 'p90', 'p95', 'p99'])
    .default('sum'),
  groupBy: z.array(z.string().max(200)).max(5).default([]),
  window: z.string().max(20).optional(),
});

async function assertProjectAccess(userId: string, projectId: string) {
  const access = await getProjectAccess({ userId, projectId });

  if (!access) {
    throw new TRPCForbiddenError('You do not have access to this project');
  }
}

function assertEnabled() {
  if (!isGigapipeEnabled()) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Telemetry is not configured on this deployment',
    });
  }
}

/**
 * Map a backend failure onto something the UI can act on.
 *
 * The distinction that matters is retryable vs not: an over-large query needs
 * the user to narrow the range, while an unavailable backend needs them to wait.
 * Collapsing both into INTERNAL_SERVER_ERROR produces a spinner that never
 * resolves and a user who does not know which lever to pull.
 */
function toTRPCError(error: unknown): TRPCError {
  if (error instanceof GigapipeNotConfiguredError) {
    return new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Telemetry is not configured on this deployment',
    });
  }

  if (error instanceof GigapipeError) {
    if (error.status === 413) {
      return new TRPCError({
        code: 'PAYLOAD_TOO_LARGE',
        message: error.message,
      });
    }

    return new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Telemetry backend is unavailable',
      cause: error,
    });
  }

  if (error instanceof TRPCError) {
    return error;
  }

  return new TRPCError({
    code: 'BAD_REQUEST',
    message: error instanceof Error ? error.message : 'Invalid metric query',
  });
}

export const observabilityRouter = createTRPCRouter({
  /** Whether the telemetry surfaces should render at all. */
  enabled: protectedProcedure.query(() => ({ enabled: isGigapipeEnabled() })),

  /**
   * Metric names this project has written.
   *
   * Backed by a direct, project-scoped ClickHouse read rather than gigapipe's
   * global label endpoints — see the service for why.
   */
  metricNames: protectedProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input, ctx }) => {
      assertEnabled();
      await assertProjectAccess(ctx.session.userId, input.projectId);

      try {
        return await getTelemetryMetricNames(input.projectId);
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  labelKeys: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        // Narrowing to one metric matters: offering every label in the project
        // would suggest filters that select nothing on the chosen metric.
        metric: z.string().max(200).optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      assertEnabled();
      await assertProjectAccess(ctx.session.userId, input.projectId);

      try {
        return await getTelemetryLabelKeys(input.projectId, {
          metric: input.metric,
        });
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  labelValues: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        label: z.string().min(1).max(200),
        metric: z.string().max(200).optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      assertEnabled();
      await assertProjectAccess(ctx.session.userId, input.projectId);

      try {
        return await getTelemetryLabelValues(input.projectId, input.label, {
          metric: input.metric,
        });
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  services: protectedProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input, ctx }) => {
      assertEnabled();
      await assertProjectAccess(ctx.session.userId, input.projectId);

      try {
        return await getTelemetryServices(input.projectId);
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  /**
   * Log search.
   *
   * Returns lines with the envelope already unpacked, so the explorer never
   * parses storage format. A line that is not one of our envelopes — ingested
   * before this format, or written by something else pointed at the same
   * backend — is surfaced as raw text rather than dropped or errored.
   */
  logs: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        matchers: z
          .array(
            z.object({
              name: z.string().min(1).max(200),
              operator: z.enum(['eq', 'neq', 'match', 'notMatch']),
              value: z.string().max(2000),
            }),
          )
          .max(10)
          .default([]),
        lineFilters: z
          .array(
            z.object({
              operator: z.enum(['contains', 'notContains', 'match', 'notMatch']),
              value: z.string().min(1).max(1000),
            }),
          )
          .max(5)
          .default([]),
        startDate: z.string(),
        endDate: z.string(),
        limit: z.number().int().min(1).max(5000).default(DEFAULT_LOG_LIMIT),
      }),
    )
    .query(async ({ input, ctx }) => {
      assertEnabled();
      await assertProjectAccess(ctx.session.userId, input.projectId);

      const start = new Date(input.startDate);
      const end = new Date(input.endDate);

      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Log search requires a valid start and end date',
        });
      }

      try {
        const compiled = compileLogQuery(
          {
            matchers: input.matchers,
            lineFilters: input.lineFilters,
            limit: input.limit,
          },
          input.projectId,
        );

        const response = (await queryLogRange({
          logql: compiled.logql,
          start,
          end,
          limit: compiled.limit,
        })) as {
          data?: { result?: { stream: Record<string, string>; values: [string, string][] }[] };
        };

        const lines = (response.data?.result ?? []).flatMap((stream) =>
          (stream.values ?? []).map(([timestampNs, raw]) => {
            const envelope = parseLogEnvelope(raw);

            return {
              timestampNs,
              // Fall back to the raw text so a foreign line is still readable.
              body: envelope?.b ?? raw,
              severity: envelope?.sev,
              traceId: envelope?.tid,
              spanId: envelope?.sid,
              sessionId: envelope?.sess,
              profileId: envelope?.prof,
              attributes: envelope?.attr ?? {},
              labels: stream.stream ?? {},
            };
          }),
        );

        // Loki orders within a stream, not across them.
        lines.sort((a, b) =>
          a.timestampNs < b.timestampNs ? 1 : a.timestampNs > b.timestampNs ? -1 : 0,
        );

        return { lines, compiled: compiled.logql };
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  /**
   * Trace search.
   *
   * Reads ClickHouse directly — gigapipe's Tempo reader applies no tenant
   * predicate at all, so routing this through it would expose every project's
   * spans. See docs/observability/14-decisions.md D5's sibling finding.
   */
  traceSearch: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        startDate: z.string(),
        endDate: z.string(),
        service: z.string().max(200).optional(),
        minDurationMs: z.number().min(0).max(3_600_000).optional(),
        limit: z.number().int().min(1).max(200).default(50),
      }),
    )
    .query(async ({ input, ctx }) => {
      assertEnabled();
      await assertProjectAccess(ctx.session.userId, input.projectId);

      const start = new Date(input.startDate);
      const end = new Date(input.endDate);

      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Trace search requires a valid start and end date',
        });
      }

      try {
        return await searchTraces(
          input.projectId,
          { start, end },
          { service: input.service, minDurationMs: input.minDurationMs },
          input.limit,
        );
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  /**
   * One trace's spans.
   *
   * Returns an empty array for a trace the project does not own, rather than a
   * 404 — distinguishing "no such trace" from "not yours" would confirm another
   * project's trace id to anyone who guessed one.
   */
  trace: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        traceId: z.string().min(1).max(32),
      }),
    )
    .query(async ({ input, ctx }) => {
      assertEnabled();
      await assertProjectAccess(ctx.session.userId, input.projectId);

      try {
        return await getTrace(input.projectId, input.traceId);
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  /**
   * Logs belonging to one trace.
   *
   * `trace_id` is deliberately NOT a stream label — that is the whole basis of
   * the log cardinality design — so this is a line filter rather than a
   * selector. It matches the envelope's own field (`"tid":"<id>"`) rather than
   * the bare id, so a trace id appearing incidentally in a log message does not
   * masquerade as a correlated line.
   *
   * The project matcher is still injected by the compiler, so this cannot read
   * another project's logs even given a correct trace id.
   */
  logsForTrace: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        traceId: z.string().min(1).max(32).regex(/^[0-9a-fA-F]+$/),
        startDate: z.string(),
        endDate: z.string(),
        limit: z.number().int().min(1).max(1000).default(200),
      }),
    )
    .query(async ({ input, ctx }) => {
      assertEnabled();
      await assertProjectAccess(ctx.session.userId, input.projectId);

      const start = new Date(input.startDate);
      const end = new Date(input.endDate);

      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Correlated log search requires a valid start and end date',
        });
      }

      try {
        const compiled = compileLogQuery(
          {
            lineFilters: [
              {
                operator: 'contains',
                // Lowercased: the envelope stores hex ids lowercase, while a
                // span id read off the waterfall comes from ClickHouse's hex()
                // in uppercase.
                value: `"tid":"${input.traceId.toLowerCase()}"`,
              },
            ],
            limit: input.limit,
          },
          input.projectId,
        );

        const response = (await queryLogRange({
          logql: compiled.logql,
          start,
          end,
          limit: compiled.limit,
        })) as {
          data?: {
            result?: { stream: Record<string, string>; values: [string, string][] }[];
          };
        };

        const lines = (response.data?.result ?? []).flatMap((stream) =>
          (stream.values ?? []).map(([timestampNs, raw]) => {
            const envelope = parseLogEnvelope(raw);
            return {
              timestampNs,
              body: envelope?.b ?? raw,
              severity: envelope?.sev,
              spanId: envelope?.sid,
              labels: stream.stream ?? {},
            };
          }),
        );

        lines.sort((a, b) =>
          a.timestampNs < b.timestampNs ? -1 : a.timestampNs > b.timestampNs ? 1 : 0,
        );

        return { lines };
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  /**
   * Traces produced by one OpenPanel session.
   *
   * The session-replay-to-backend-trace jump. Requires the customer's server to
   * attach `openpanel.session.id` as a span attribute — the SDK's
   * `getTelemetryHeaders()` carries the id from the browser for it to read.
   */
  tracesForSession: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        sessionId: z.string().min(1).max(200),
        limit: z.number().int().min(1).max(100).default(25),
      }),
    )
    .query(async ({ input, ctx }) => {
      assertEnabled();
      await assertProjectAccess(ctx.session.userId, input.projectId);

      try {
        return await getTracesForSession(
          input.projectId,
          input.sessionId,
          input.limit,
        );
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  traceServices: protectedProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input, ctx }) => {
      assertEnabled();
      await assertProjectAccess(ctx.session.userId, input.projectId);

      try {
        return await getTraceServices(input.projectId);
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  /** Named log and trace searches for this project. */
  savedSearches: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        kind: z.enum(['logs', 'traces']).optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      await assertProjectAccess(ctx.session.userId, input.projectId);

      return db.savedTelemetrySearch.findMany({
        where: {
          projectId: input.projectId,
          ...(input.kind ? { kind: input.kind } : {}),
        },
        orderBy: { name: 'asc' },
      });
    }),

  saveSearch: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid().optional(),
        projectId: z.string(),
        name: z.string().min(1).max(200),
        kind: z.enum(['logs', 'traces']),
        query: zSavedTelemetryQuery,
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await assertProjectAccess(ctx.session.userId, input.projectId);

      if (input.id) {
        // Scoped by projectId as well as id: an id alone would let a member of
        // one project update another project's saved search by guessing a uuid.
        const existing = await db.savedTelemetrySearch.findFirst({
          where: { id: input.id, projectId: input.projectId },
          select: { id: true },
        });

        if (!existing) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Search not found' });
        }

        return db.savedTelemetrySearch.update({
          where: { id: input.id },
          data: { name: input.name, query: input.query },
        });
      }

      return db.savedTelemetrySearch.create({
        data: {
          projectId: input.projectId,
          name: input.name,
          kind: input.kind,
          query: input.query,
          createdBy: ctx.session.userId,
        },
      });
    }),

  deleteSavedSearch: protectedProcedure
    .input(z.object({ projectId: z.string(), id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      await assertProjectAccess(ctx.session.userId, input.projectId);

      // deleteMany, not delete: it takes a compound where, so the projectId
      // scope is enforced by the query rather than by a prior read.
      const result = await db.savedTelemetrySearch.deleteMany({
        where: { id: input.id, projectId: input.projectId },
      });

      return { deleted: result.count };
    }),

  /**
   * Raw PromQL, rewritten to be project-scoped.
   *
   * The structured `chart` procedure never touches user text; this one does, so
   * it goes through the grammar Prometheus itself ships rather than any pattern
   * matching. Every VectorSelector gets the tenancy matcher injected, the
   * result is re-verified before it is sent, and a query the grammar cannot
   * parse is refused rather than forwarded — handing gigapipe something we
   * could not understand is exactly how a rewriter gets bypassed.
   *
   * Returns the rewritten query alongside the data so the user can see what
   * actually ran.
   */
  rawQuery: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        promql: z.string().min(1).max(4000),
        startDate: z.string(),
        endDate: z.string(),
        stepSeconds: z.number().int().min(1).max(86_400).default(60),
      }),
    )
    .query(async ({ input, ctx }) => {
      assertEnabled();
      await assertProjectAccess(ctx.session.userId, input.projectId);

      const start = new Date(input.startDate);
      const end = new Date(input.endDate);

      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Raw query requires a valid start and end date',
        });
      }

      let rewritten: string;
      try {
        rewritten = rewritePromqlForProject(input.promql, input.projectId);
        // Belt and braces: re-read the rewritten query and refuse to run it if
        // any selector is unscoped. Turns a future rewriter bug into a rejected
        // query rather than a cross-tenant read.
        assertPromqlScoped(rewritten, input.projectId);
      } catch (error) {
        if (error instanceof PromqlRewriteError) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
        }
        throw toTRPCError(error);
      }

      try {
        const response = await queryRange({
          promql: rewritten,
          start,
          end,
          step: `${input.stepSeconds}s`,
        });

        return { promql: rewritten, response };
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  /**
   * Log pattern grouping — "what shapes of line are in here".
   *
   * Scoped by the same compiled LogQL as a normal search. This is the only
   * LOG_DRILLDOWN endpoint OpenPanel exposes; its siblings take a `targetLabels`
   * parameter that gigapipe string-interpolates into a LogQL expression, and are
   * absent from the route allowlist with a test asserting so (D9).
   */
  logPatterns: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        matchers: z
          .array(
            z.object({
              name: z.string().min(1).max(200),
              operator: z.enum(['eq', 'neq', 'match', 'notMatch']),
              value: z.string().max(2000),
            }),
          )
          .max(10)
          .default([]),
        startDate: z.string(),
        endDate: z.string(),
      }),
    )
    .query(async ({ input, ctx }) => {
      assertEnabled();
      await assertProjectAccess(ctx.session.userId, input.projectId);

      const start = new Date(input.startDate);
      const end = new Date(input.endDate);

      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Pattern search requires a valid start and end date',
        });
      }

      try {
        const compiled = compileLogQuery({ matchers: input.matchers }, input.projectId);
        const response = await queryLogPatterns({
          logql: compiled.logql,
          start,
          end,
        });

        return { patterns: response, compiled: compiled.logql };
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  chart: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        query: zMetricQueryInput,
        interval: zTimeInterval.default('hour'),
        startDate: z.string(),
        endDate: z.string(),
        previous: z.boolean().default(false),
        name: z.string().max(200).optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      assertEnabled();
      await assertProjectAccess(ctx.session.userId, input.projectId);

      try {
        return await executeMetricChart({
          projectId: input.projectId,
          query: input.query,
          interval: input.interval,
          startDate: input.startDate,
          endDate: input.endDate,
          previous: input.previous,
          name: input.name,
        });
      } catch (error) {
        throw toTRPCError(error);
      }
    }),
});
