import type { ITelemetryLabelMatcher } from '@openpanel/db';
import {
  executeMetricChart,
  executeMetricPanel,
  getChartStartEndDate,
  getSettingsForProject,
  TelemetryMetadataError,
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
import {
  zPanelQuery,
  zRange,
  zSavedTelemetryQuery,
  zVariableValues,
} from '@openpanel/validation';
import {
  DEFAULT_LOG_LIMIT,
  GigapipeError,
  GigapipeNotConfiguredError,
  compileLogQuery,
  isGigapipeEnabled,
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

/**
 * How many expressions the Explore history drawer keeps, per user per project.
 *
 * Long enough to find this morning's query, short enough that the drawer is a
 * list rather than an archive.
 */
const QUERY_HISTORY_LIMIT = 50;

const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const METRIC_NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

const LABEL_NAMES_RE = /^label_names\(\s*\)$/;
const LABEL_VALUES_RE = /^label_values\(\s*(.+?)\s*\)$/;

/** `metric{a="b", c!="d"}` — the metric name is optional. */
const SELECTOR_RE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)?\s*(?:\{(.*)\})?$/s;

/** One matcher inside a selector's braces. */
const MATCHER_RE = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*(=~|!~|!=|=)\s*"((?:[^"\\]|\\.)*)"$/;

export type VariableQuery =
  | { kind: 'label_names' }
  | {
      kind: 'label_values';
      label: string;
      metric?: string;
      matchers?: ITelemetryLabelMatcher[];
    };

function badRequest(message: string): TRPCError {
  return new TRPCError({ code: 'BAD_REQUEST', message });
}

/** Undo the PromQL string escapes, so the value compares against stored data. */
function unescapeMatcherValue(value: string): string {
  return value.replace(/\\(.)/g, (_, char: string) => {
    if (char === 'n') {
      return '\n';
    }
    if (char === 'r') {
      return '\r';
    }
    if (char === 't') {
      return '\t';
    }
    return char;
  });
}

/**
 * Split a selector's matcher list on commas that are not inside a string.
 *
 * A value may legitimately contain a comma — `path="/a,b"` — so splitting on
 * every comma would cut a matcher in half and reject a query that is fine.
 */
function splitMatchers(body: string): string[] {
  const out: string[] = [];
  let current = '';
  let inString = false;
  let escaped = false;

  for (const char of body) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      current += char;
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      current += char;
      continue;
    }

    if (char === ',' && !inString) {
      out.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  out.push(current);

  return out.map((part) => part.trim()).filter((part) => part !== '');
}

/**
 * Parse the selector half of `label_values(<selector>, <label>)`.
 *
 * REGEX MATCHERS ARE REFUSED. `=` and `!=` are set operations over the
 * inverted index; `=~` would scan every value of that key and run a regex per
 * row on a table whose primary key gives no help past `key`. Refusing is the
 * honest answer — the alternative is a dropdown that takes seconds to open and
 * nobody can see why.
 */
function parseSelector(selector: string): {
  metric?: string;
  matchers?: ITelemetryLabelMatcher[];
} {
  const match = SELECTOR_RE.exec(selector.trim());

  if (!match) {
    throw badRequest(
      `${JSON.stringify(selector)} is not a metric name or a selector`,
    );
  }

  const metric = match[1];
  const body = match[2];

  if (!metric && body === undefined) {
    throw badRequest(
      `${JSON.stringify(selector)} is not a metric name or a selector`,
    );
  }

  if (metric && !METRIC_NAME_RE.test(metric)) {
    throw badRequest(`${JSON.stringify(metric)} is not a valid metric name`);
  }

  const matchers: ITelemetryLabelMatcher[] = [];

  for (const part of splitMatchers(body ?? '')) {
    const parsed = MATCHER_RE.exec(part);

    if (!parsed) {
      throw badRequest(
        `${JSON.stringify(part)} is not a label matcher — write label="value"`,
      );
    }

    const operator = parsed[2] as string;

    if (operator === '=~' || operator === '!~') {
      throw badRequest(
        'Variable selectors support equality matchers only (= and !=); a regex matcher would have to scan every value of that label',
      );
    }

    matchers.push({
      label: parsed[1] as string,
      op: operator as '=' | '!=',
      value: unescapeMatcherValue(parsed[3] as string),
    });
  }

  if (matchers.length > MAX_VARIABLE_MATCHERS) {
    throw badRequest(
      `A variable selector takes at most ${MAX_VARIABLE_MATCHERS} label matchers`,
    );
  }

  return {
    metric,
    matchers: matchers.length > 0 ? matchers : undefined,
  };
}

/** What the metadata service accepts in one selector. */
const MAX_VARIABLE_MATCHERS = 10;

/**
 * Parse a variable's `query` string.
 *
 * Throws rather than returning an empty list. A variable whose query is a typo
 * would otherwise render as a dropdown with nothing in it, which is
 * indistinguishable from "this project has no such label" — so the editor could
 * not tell the user which of the two it is looking at.
 */
export function parseVariableQuery(query: string): VariableQuery {
  const trimmed = query.trim();

  if (LABEL_NAMES_RE.test(trimmed)) {
    return { kind: 'label_names' };
  }

  const match = LABEL_VALUES_RE.exec(trimmed);

  if (!match) {
    throw badRequest(
      'A query variable must be label_values(<selector>, <label>), label_values(<label>) or label_names()',
    );
  }

  const args = match[1] as string;
  const comma = splitTopLevelArgs(args);

  if (comma.length === 1) {
    const label = comma[0] as string;

    if (!IDENTIFIER_RE.test(label)) {
      throw badRequest(`${JSON.stringify(label)} is not a valid label name`);
    }

    return { kind: 'label_values', label };
  }

  if (comma.length !== 2) {
    throw badRequest(
      'label_values() takes a selector and a label, or a label alone',
    );
  }

  const label = comma[1] as string;

  if (!IDENTIFIER_RE.test(label)) {
    throw badRequest(`${JSON.stringify(label)} is not a valid label name`);
  }

  return {
    kind: 'label_values',
    label,
    ...parseSelector(comma[0] as string),
  };
}

/**
 * Split `label_values(...)`'s arguments on the comma that separates the
 * selector from the label — not on the commas INSIDE the selector's braces.
 */
function splitTopLevelArgs(args: string): string[] {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = args.length - 1; i >= 0; i -= 1) {
    const char = args[i] as string;

    // Scanning backwards, so an escape is the character BEFORE a backslash.
    escaped = i > 0 && args[i - 1] === '\\';

    if (inString) {
      if (char === '"' && !escaped) {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '}') {
      depth += 1;
      continue;
    }

    if (char === '{') {
      depth -= 1;
      continue;
    }

    if (char === ',' && depth === 0) {
      return [args.slice(0, i).trim(), args.slice(i + 1).trim()];
    }
  }

  return [args.trim()];
}

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

  /**
   * Run a multi-query PromQL panel.
   *
   * Page-local: Explore calls this directly with whatever is in the editor, so
   * nothing has to be saved before it can be run. A SAVED metric report goes
   * through `chart.chart` instead, which reaches the same engine by way of
   * `executeChart` — so the two surfaces cannot drift into rendering the same
   * panel differently.
   *
   * `expr` is user text. It is safe for exactly one reason: the engine folds in
   * the variables, then hands the result to `rewritePromqlForProject`, which
   * parses it with Prometheus's own grammar and scopes every selector — and
   * re-reads its own output before sending it. See
   * packages/db/src/engine/metrics/panel.ts.
   */
  panel: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        queries: z.array(zPanelQuery).min(1).max(10),
        interval: zTimeInterval.default('hour'),
        range: zRange.optional(),
        startDate: z.string().nullish(),
        endDate: z.string().nullish(),
        previous: z.boolean().default(false),
        variables: zVariableValues.optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      assertEnabled();
      await assertProjectAccess(ctx.session.userId, input.projectId);

      const { timezone } = await getSettingsForProject(input.projectId);
      const { startDate, endDate } = getChartStartEndDate(
        {
          startDate: input.startDate,
          endDate: input.endDate,
          range: input.range ?? 'last24h',
        },
        timezone,
      );

      try {
        return await executeMetricPanel({
          projectId: input.projectId,
          queries: input.queries,
          interval: input.interval,
          startDate,
          endDate,
          previous: input.previous,
          variables: input.variables,
        });
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  /**
   * Recently run expressions, for the Explore history drawer.
   *
   * Scoped to the calling user as well as the project: query history is a
   * record of what someone was investigating, and a shared list would put one
   * engineer's half-formed debugging in front of the whole team.
   */
  queryHistory: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        search: z.string().max(200).optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      await assertProjectAccess(ctx.session.userId, input.projectId);

      const rows = await db.promqlQueryHistory.findMany({
        where: {
          projectId: input.projectId,
          userId: ctx.session.userId,
          ...(input.search
            ? { expr: { contains: input.search, mode: 'insensitive' as const } }
            : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: QUERY_HISTORY_LIMIT,
      });

      return rows.map((row) => ({
        id: row.id,
        expr: row.expr,
        createdAt: row.createdAt,
      }));
    }),

  /**
   * Record an expression that was run.
   *
   * Two things keep this from becoming a write on every keystroke: the caller
   * only sends it on an explicit Run, and a repeat of the user's most recent
   * expression is dropped. Without the second, re-running the same query to
   * watch it change fills the drawer with one line repeated.
   */
  recordQuery: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        expr: z.string().min(1).max(4000),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await assertProjectAccess(ctx.session.userId, input.projectId);

      const expr = input.expr.trim();

      if (expr === '') {
        return { recorded: false };
      }

      const latest = await db.promqlQueryHistory.findFirst({
        where: { projectId: input.projectId, userId: ctx.session.userId },
        orderBy: { createdAt: 'desc' },
        select: { expr: true },
      });

      if (latest?.expr === expr) {
        return { recorded: false };
      }

      await db.promqlQueryHistory.create({
        data: {
          projectId: input.projectId,
          userId: ctx.session.userId,
          expr,
        },
      });

      // Trim to the newest N. Done here rather than on a cron because the list
      // is per user and tiny, and a cron that has not run yet is a drawer that
      // grows without bound.
      const overflow = await db.promqlQueryHistory.findMany({
        where: { projectId: input.projectId, userId: ctx.session.userId },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
        skip: QUERY_HISTORY_LIMIT,
      });

      if (overflow.length > 0) {
        await db.promqlQueryHistory.deleteMany({
          where: { id: { in: overflow.map((row) => row.id) } },
        });
      }

      return { recorded: true };
    }),

  /**
   * Resolve a dashboard variable's options.
   *
   * Understands the two Grafana forms the variable editor offers:
   *
   *   label_values(<selector>, <label>)   values of <label> on that metric
   *   label_values(<label>)               values of <label> anywhere in the project
   *   label_names()                       every label key in the project
   *
   * Backed by the project-scoped ClickHouse reads, NOT by gigapipe's own label
   * endpoints — those answer globally, and proxying one to the browser would
   * list every tenant's label values. See telemetry-metadata.service.ts.
   *
   * Sorted and de-duplicated here rather than in the browser, so Explore and
   * the dashboard bar cannot present the same variable in two different orders.
   *
   * Takes `range` plus optional custom dates, the same shape every other chart
   * read takes, and resolves them with the project's own timezone — rather than
   * two pre-resolved timestamps, which would make the browser reimplement
   * `getChartStartEndDate` and let the picker's window drift from the window
   * the panels underneath it are drawn at.
   *
   * The window IS applied: `time_series_gin` is partitioned by date, so
   * bounding the read prunes partitions and costs less than the unbounded one.
   * The picker therefore lists what the visible window actually contains,
   * rather than everything the project has ever written.
   */
  variableOptions: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        query: z.string().min(1).max(500),
        range: zRange.optional(),
        startDate: z.string().nullish(),
        endDate: z.string().nullish(),
      }),
    )
    .query(async ({ input, ctx }) => {
      assertEnabled();
      await assertProjectAccess(ctx.session.userId, input.projectId);

      const parsed = parseVariableQuery(input.query);

      const { timezone } = await getSettingsForProject(input.projectId);
      const { startDate, endDate } = getChartStartEndDate(
        {
          startDate: input.startDate,
          endDate: input.endDate,
          range: input.range ?? 'last24h',
        },
        timezone,
      );

      try {
        const values =
          parsed.kind === 'label_names'
            ? await getTelemetryLabelKeys(input.projectId, {
                startDate,
                endDate,
              })
            : await getTelemetryLabelValues(input.projectId, parsed.label, {
                metric: parsed.metric,
                matchers: parsed.matchers,
                startDate,
                endDate,
              });

        return [...new Set(values)].sort((a, b) => a.localeCompare(b));
      } catch (error) {
        // The metadata service now REJECTS a name that is not an identifier
        // rather than returning an empty list. Surfaced as the same
        // BAD_REQUEST the parser produces, so the variable editor can show it
        // at the field instead of the user meeting a 500.
        if (error instanceof TelemetryMetadataError) {
          throw badRequest(error.message);
        }

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
