import type {
  CohortDefinition,
  IImportConfig,
  IProjectAccessGrant,
  IIntegrationConfig,
  INotificationRuleConfig,
  IMetricQuery,
  IDashboardVariable,
  IPanelQuery,
  IProjectFilters,
  ISavedTelemetryQuery,
  IWidgetOptions,
  InsightPayload,
} from '@openpanel/validation';
import type { IChartEventFilter } from '@openpanel/validation';
import type {
  IClickhouseBotEvent,
  IClickhouseEvent,
} from './services/event.service';
import type { INotificationPayload } from './services/notification.service';
import type { IClickhouseProfile } from './services/profile.service';

declare global {
  namespace PrismaJson {
    type IPrismaImportConfig = IImportConfig;
    type IPrismaNotificationRuleConfig = INotificationRuleConfig;
    type IPrismaIntegrationConfig = IIntegrationConfig;
    type IPrismaNotificationPayload = INotificationPayload;
    type IPrismaProjectFilters = IProjectFilters[];
    type IPrismaInviteProjectAccess = IProjectAccessGrant[];
    type IPrismaProjectInsightPayload = InsightPayload;
    type IPrismaWidgetOptions = IWidgetOptions;
    type IPrismaClickhouseEvent = IClickhouseEvent;
    type IPrismaClickhouseProfile = IClickhouseProfile;
    // A signal rule's property filters, ANDed. The same shape charts and
    // notification rules use, so matching goes through the one matchEvent().
    type IPrismaSignalRuleFilters = IChartEventFilter[];
    // Facts supporting a signal, passed to gtmsrv verbatim as `evidence`.
    type IPrismaSignalOutboxEvidence = Record<string, unknown>;
    // The `data` of a WrappedEvent on the NATS event plane. Deliberately open:
    // it carries the event's own properties, which are user-defined, alongside
    // the identifiers gtmsrv joins on.
    type IPrismaEventOutboxData = Record<string, unknown>;
    type IPrismaClickhouseBotEvent = IClickhouseBotEvent;
    type IPrismaCohortDefinition = CohortDefinition;
    // The structured metric query behind a `dataSource = metrics` report. The
    // compiler turns this into PromQL server-side; it is never raw PromQL, which
    // is what keeps the tenancy matcher unforgeable.
    // The validation package's type, not gigapipe's: this is what the report
    // input is parsed into, so the two must be the same shape or a saved report
    // cannot be fed back through the chart pipeline. zod defaults are applied on
    // write, so the stored JSON always has them.
    type IPrismaMetricQuery = IMetricQuery;
    // The PromQL queries behind a multi-query metrics panel. Unlike
    // `IPrismaMetricQuery` above, `expr` here IS raw PromQL — the tenancy gate
    // moved from "only the compiler emits a selector" to "the server rewrites
    // every selector before it leaves", so a stored expression is safe to keep
    // verbatim. zod defaults are applied on write, so the stored JSON always
    // has mode/hidden/unit/yAxis/instant.
    type IPrismaPanelQueries = IPanelQuery[];
    // A dashboard's variable definitions. Current values are URL state, not
    // stored here.
    type IPrismaDashboardVariables = IDashboardVariable[];
    // A saved log or trace search. Structured, never a raw query string.
    type IPrismaSavedTelemetryQuery = ISavedTelemetryQuery;
    // Each ChatMessage row stores one Better Agent `ConversationItem`
    // (message, tool call, or tool result) as JSON. Typed as `unknown[]`
    // here to avoid pulling `@better-agent/core` into @openpanel/db's
    // dependency graph; the real shape is narrowed at the API boundary
    // in apps/api/src/agents/persistence.ts.
    type IPrismaUIMessageParts = unknown[];
    type IPrismaSubscriptionStatus =
      | 'incomplete'
      | 'incomplete_expired'
      | 'trialing'
      | 'active'
      | 'past_due'
      | 'canceled'
      | 'unpaid'
      | 'paused';
    // Compact summary of the discount applied to the subscription, synced
    // from Polar's embedded discount object so the dashboard can show it.
    type IPrismaSubscriptionDiscount = {
      id: string;
      name: string;
      type: 'percentage' | 'fixed';
      // Set for percentage discounts (3000 = 30%).
      basisPoints: number | null;
      // Set for fixed discounts (minor units + currency).
      amount: number | null;
      currency: string | null;
      duration: 'once' | 'forever' | 'repeating';
      durationInMonths: number | null;
    };
    // Steps of the wind-down sequence, in order. The column stores the last
    // step whose email was sent; `blocked` and `final_warning` also mean
    // ingestion is rejected. See apps/worker/src/jobs/cron.wind-down.ts.
    type IPrismaWindDownStep =
      | 'expired_notice'
      | 'stopping_soon'
      | 'blocked'
      | 'final_warning';
    // Mirrors Polar's CustomerCancellationReason enum.
    type IPrismaCancellationReason =
      | 'too_expensive'
      | 'missing_features'
      | 'switched_service'
      | 'unused'
      | 'customer_service'
      | 'low_quality'
      | 'too_complex'
      | 'other';
  }
}
