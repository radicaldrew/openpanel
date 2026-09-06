// Explicit public surface for @openpanel/gigapipe.
//
// Not a wildcard barrel: everything here is deliberately exported. The tenancy
// internals are reachable only through the functions below, so there is no way
// to stamp a payload without going through the strip-then-stamp path, and no
// way to build a gigapipe URL outside the route allow-list.

export type { BreakerOptions, BreakerState } from './src/admission/breaker';
export {
  CircuitBreaker,
  CircuitOpenError,
} from './src/admission/breaker';
export type {
  CardinalityCounter,
  CardinalityDecision,
} from './src/admission/cardinality';
export {
  CardinalityBudgetExceededError,
  checkCardinalityBudget,
  DEFAULT_SERIES_BUDGET,
} from './src/admission/cardinality';
export type {
  AlertConfig,
  AlertState,
  AlertTransition,
  SeriesState,
  StepInput,
  StepResult,
} from './src/alerts/state-machine';
export { stepSeries } from './src/alerts/state-machine';
export type {
  GigapipeConfig,
  GigapipeRoute,
  RangeQueryParams,
} from './src/client';
export {
  GIGAPIPE_ROUTES,
  GigapipeError,
  GigapipeNotConfiguredError,
  getGigapipeConfig,
  isGigapipeEnabled,
  postToGigapipe,
  pushLogs,
  queryLogPatterns,
  queryLogRange,
  queryRange,
} from './src/client';
export type {
  LogLabelMatcher,
  LogLineFilter,
  LogQuery,
} from './src/logql/compile';
export {
  compileLogQuery,
  DEFAULT_LOG_LIMIT,
  LogQueryError,
} from './src/logql/compile';
export type {
  LogEnvelope,
  LogRecordInput,
  LokiPushBody,
} from './src/logs/envelope';
export {
  buildLokiPush,
  LOG_DENIED_LABELS,
  LOG_ENVELOPE_VERSION,
  LOG_LABEL_ALLOWLIST,
  LogIngestError,
  parseLogEnvelope,
} from './src/logs/envelope';
export { decodeOtlpLogs } from './src/logs/otlp-decode';
export type { EpisodeDecision, EpisodeState } from './src/measures/episode';
export { dedupeKeyFor, stepEpisode } from './src/measures/episode';
export type {
  EvaluateInput,
  EvaluateResult,
  MeasureEmission,
  MeasureSeriesState,
  SeriesObservation,
  SeriesOutcome,
} from './src/measures/evaluate';
export { evaluateRule, seriesKeyOf } from './src/measures/evaluate';
export { observationsFromMatrix } from './src/measures/response';
export type {
  MeasureOperator,
  MeasureRule,
  SubjectMapping,
} from './src/measures/rule';
export {
  assertUsableRule,
  DEFAULT_PERIOD_SECONDS,
  defaultReArmSeconds,
  fingerprintOf,
  MeasureRuleError,
  MIN_RE_ARM_SECONDS,
  periodSecondsOf,
  reArmSecondsOf,
  strengthOf,
} from './src/measures/rule';
export { seriesKeysFromMetricsPayload } from './src/otlp/series-keys';
export {
  assertPayloadScopedTo,
  readStampedProjectIds,
  stampOtlpRequest,
  UnscopedPayloadError,
} from './src/otlp/stamp';
export { stampOtlpMetricsRequest } from './src/otlp/stamp-metrics';
export { stampOtlpTracesRequest } from './src/otlp/stamp-traces';
export {
  readRemoteWriteProjectIds,
  stampRemoteWriteRequest,
} from './src/prometheus/remote-write';
export type {
  CompiledQuery,
  MatcherOperator,
  MetricAggregation,
  MetricFn,
  MetricMatcher,
  MetricQuery,
} from './src/promql/compile';
export {
  compileMetricQuery,
  MetricQueryError,
} from './src/promql/compile';
export {
  assertPromqlScoped,
  PromqlRewriteError,
  rewritePromqlForProject,
} from './src/promql/rewrite';
export {
  assertValidProjectId,
  InvalidProjectIdError,
  isReservedAttributeKey,
  isValidProjectId,
  PROJECT_LABEL,
  RESERVED_LABEL_PREFIX,
  stampProjectLabel,
} from './src/tenancy/project-label';
