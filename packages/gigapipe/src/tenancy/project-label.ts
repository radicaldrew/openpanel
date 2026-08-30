import { sanitizeLokiLabelName, sanitizeOtlpKey } from './sanitize';

/**
 * The tenancy boundary.
 *
 * gigapipe is single-tenant: its reader binds to one ClickHouse database at
 * boot and ignores the request context entirely, and its writer's `X-CH-DSN`
 * header is a fail-open node selector, not a tenancy mechanism. So project
 * isolation is not something gigapipe provides and OpenPanel configures — it is
 * something OpenPanel *is*, on both sides of every request:
 *
 *   ingest — this label is stamped from the authenticated token's project, and
 *            any customer-supplied key that could collide with it is removed
 *            first.
 *   query  — this label is injected as a mandatory `=` matcher by the query
 *            compilers, which are the only functions permitted to emit a `{`.
 *
 * See docs/observability/14-decisions.md D2 and docs/observability/01-tenancy-and-security.md.
 */
export const PROJECT_LABEL = 'op_project_id';

/**
 * Everything OpenPanel reserves for itself in the label namespace.
 *
 * This is a PREFIX reservation, not an exact-match one. Reserving only
 * `op_project_id` would mean that the day a second `op_`-prefixed label is
 * added — a signal marker, a shard key, an ingest-version tag — every customer
 * attribute that sanitizes onto the new name silently becomes a way to forge
 * it, and the vulnerability arrives with a feature that looks unrelated.
 *
 * The cost is that a customer attribute whose sanitized name starts with `op_`
 * is dropped on ingest. That is a documented, visible constraint. The
 * alternative is an invisible one.
 */
export const RESERVED_LABEL_PREFIX = 'op_';

/**
 * Project ids are validated, not escaped.
 *
 * The compilers build selectors by construction rather than by concatenating
 * user input, so this is defence in depth rather than the primary control — but
 * it is what lets the rest of the system treat the value as inert. The 100
 * character ceiling also keeps the value below gigapipe's 100-byte label
 * truncation on the Loki path, so a project id can never be silently shortened
 * into a different project's id.
 */
const PROJECT_ID_RE = /^[a-zA-Z0-9_-]{1,100}$/;

export function isValidProjectId(projectId: string): boolean {
  return PROJECT_ID_RE.test(projectId);
}

export class InvalidProjectIdError extends Error {
  constructor(projectId: string) {
    super(
      `Refusing to use ${JSON.stringify(projectId)} as a telemetry project id: it must match ${PROJECT_ID_RE}`,
    );
    this.name = 'InvalidProjectIdError';
  }
}

export function assertValidProjectId(projectId: string): string {
  if (!isValidProjectId(projectId)) {
    throw new InvalidProjectIdError(projectId);
  }

  return projectId;
}

/**
 * Would this customer-supplied attribute key collide with something we reserve,
 * once gigapipe has sanitized it?
 *
 * Checks the raw key AND both of gigapipe's sanitized forms, because a key
 * reaches ClickHouse through whichever path its signal takes and the two
 * sanitizers disagree on leading characters. A key is reserved if ANY of the
 * three forms lands in our namespace — fail closed.
 *
 * The comparison is case-insensitive on top of gigapipe's own rules. gigapipe
 * does not fold case, so `OP_PROJECT_ID` is a genuinely different label to it
 * and could not forge ours. It is rejected anyway: a customer attribute
 * differing from the tenancy label only by case is far more likely to be an
 * attempt than a coincidence, and letting it through would put a label into
 * query results that a reader would reasonably misread as ours.
 */
export function isReservedAttributeKey(key: string): boolean {
  const forms = [key, sanitizeOtlpKey(key), sanitizeLokiLabelName(key)];

  return forms.some((form) =>
    form.toLowerCase().startsWith(RESERVED_LABEL_PREFIX),
  );
}

/**
 * Remove every reserved key from an attribute bag, then stamp ours.
 *
 * Order matters and is not negotiable: strip first, stamp second. Stamping into
 * a bag that still holds a colliding key leaves two entries whose winner
 * depends on gigapipe's iteration order — for OTLP logs, record attributes are
 * merged last and would win.
 *
 * The stamped value overwrites unconditionally. A client that sends its own
 * `op_project_id` does not get an error, and does not get its value: tokens
 * decide project membership, payloads never do.
 */
export function stampProjectLabel<T extends Record<string, string>>(
  attributes: T,
  projectId: string,
): Record<string, string> {
  assertValidProjectId(projectId);

  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (isReservedAttributeKey(key)) {
      continue;
    }
    out[key] = value;
  }

  out[PROJECT_LABEL] = projectId;

  return out;
}
