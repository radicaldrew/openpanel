// Explicit public surface for @openpanel/gigapipe.
//
// Not a wildcard barrel: everything here is deliberately exported. The tenancy
// internals are reachable only through the functions below, so there is no way
// to stamp a payload without going through the strip-then-stamp path, and no
// way to build a gigapipe URL outside the route allow-list.

export {
  PROJECT_LABEL,
  RESERVED_LABEL_PREFIX,
  InvalidProjectIdError,
  assertValidProjectId,
  isReservedAttributeKey,
  isValidProjectId,
  stampProjectLabel,
} from './src/tenancy/project-label';

export { stampOtlpMetricsRequest } from './src/otlp/stamp-metrics';
export { stampOtlpTracesRequest } from './src/otlp/stamp-traces';

export {
  UnscopedPayloadError,
  assertPayloadScopedTo,
  readStampedProjectIds,
  stampOtlpRequest,
} from './src/otlp/stamp';

export {
  GIGAPIPE_ROUTES,
  GigapipeError,
  GigapipeNotConfiguredError,
  getGigapipeConfig,
  isGigapipeEnabled,
  postToGigapipe,
} from './src/client';
export { queryRange } from './src/client';
export type {
  GigapipeConfig,
  GigapipeRoute,
  RangeQueryParams,
} from './src/client';

export {
  MetricQueryError,
  compileMetricQuery,
} from './src/promql/compile';
export type {
  CompiledQuery,
  MetricAggregation,
  MetricFn,
  MetricMatcher,
  MetricQuery,
  MatcherOperator,
} from './src/promql/compile';

export {
  CircuitBreaker,
  CircuitOpenError,
} from './src/admission/breaker';
export type { BreakerOptions, BreakerState } from './src/admission/breaker';

export {
  CardinalityBudgetExceededError,
  DEFAULT_SERIES_BUDGET,
  checkCardinalityBudget,
} from './src/admission/cardinality';
export type {
  CardinalityCounter,
  CardinalityDecision,
} from './src/admission/cardinality';

export { seriesKeysFromMetricsPayload } from './src/otlp/series-keys';

export {
  buildLokiPush,
  parseLogEnvelope,
  LOG_LABEL_ALLOWLIST,
  LOG_DENIED_LABELS,
  LOG_ENVELOPE_VERSION,
  LogIngestError,
} from './src/logs/envelope';
export type { LogEnvelope, LogRecordInput, LokiPushBody } from './src/logs/envelope';

export { decodeOtlpLogs } from './src/logs/otlp-decode';

export {
  DEFAULT_LOG_LIMIT,
  LogQueryError,
  compileLogQuery,
} from './src/logql/compile';
export type { LogQuery, LogLabelMatcher, LogLineFilter } from './src/logql/compile';

export { pushLogs, queryLogRange, queryLogPatterns } from './src/client';

export { stepSeries } from './src/alerts/state-machine';
export type {
  AlertConfig,
  AlertState,
  AlertTransition,
  SeriesState,
  StepInput,
  StepResult,
} from './src/alerts/state-machine';

export {
  readRemoteWriteProjectIds,
  stampRemoteWriteRequest,
} from './src/prometheus/remote-write';

export {
  PromqlRewriteError,
  assertPromqlScoped,
  rewritePromqlForProject,
} from './src/promql/rewrite';
