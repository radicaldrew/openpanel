import { assertValidProjectId } from '../tenancy/project-label';
import { stampAttributeList, stampResourceEntry, stripReservedAttributes } from './stamp';
import { rewriteField } from './wire';

/**
 * Stamp an OTLP traces export request.
 *
 * Traces differ from both other signals:
 *
 *   - Unlike METRICS, the resource stamp is sufficient for querying. Verified
 *     against a live gigapipe: a resource-level `op_project_id` lands in
 *     `tempo_traces_attrs_gin` once per span, which is exactly the predicate
 *     the read path uses.
 *
 *   - Unlike LOGS, the payload is forwarded rather than rebuilt, so anything a
 *     client puts on a span travels with it.
 *
 * That second point is why this exists. A span attribute named `op-project-id`
 * survived a resource-only stamp and appeared in the attribute index alongside
 * ours:
 *
 *     op-project-id   FORGED       2
 *     op_project_id   trace-demo   2
 *
 * It could not forge the read predicate as things stand, because gigapipe
 * stores trace attribute keys unsanitized and `op-project-id` is a different
 * key from `op_project_id`. But it is a near-miss that becomes a real one the
 * day anyone adds sanitization to that path, writes a `LIKE 'op%'` predicate,
 * or renders span attributes in a UI where a reader would take it for ours.
 *
 * So reserved keys are stripped at every level a client controls: span
 * attributes, span event attributes, and span link attributes.
 *
 * Field numbers (frozen by protobuf compatibility):
 *   ResourceSpans.scope_spans = 2
 *   ScopeSpans.spans = 2
 *   Span.attributes = 9, .events = 11, .links = 13
 *   Span.Event.attributes = 3
 *   Span.Link.attributes = 4
 */

const FIELD_RESOURCE_SPANS = 1;
const FIELD_SCOPE_SPANS = 2;
const FIELD_SPANS = 2;
const SPAN_ATTRIBUTES = 9;
const SPAN_EVENTS = 11;
const SPAN_LINKS = 13;
const EVENT_ATTRIBUTES = 3;
const LINK_ATTRIBUTES = 4;

function stripSpan(span: Uint8Array): Uint8Array {
  // Span's own attributes.
  let out = stripReservedAttributes(span, SPAN_ATTRIBUTES);

  // Each event's attributes.
  out = rewriteField(out, SPAN_EVENTS, (event) => [
    stripReservedAttributes(event, EVENT_ATTRIBUTES),
  ]);

  // Each link's attributes.
  out = rewriteField(out, SPAN_LINKS, (link) => [
    stripReservedAttributes(link, LINK_ATTRIBUTES),
  ]);

  return out;
}

export function stampOtlpTracesRequest(
  body: Uint8Array,
  projectId: string,
): Uint8Array {
  assertValidProjectId(projectId);

  return rewriteField(body, FIELD_RESOURCE_SPANS, (entry) => {
    const withResource = stampResourceEntry(entry, projectId);

    return [
      rewriteField(withResource, FIELD_SCOPE_SPANS, (scopeSpans) => [
        rewriteField(scopeSpans, FIELD_SPANS, (span) => [stripSpan(span)]),
      ]),
    ];
  });
}

export { stampAttributeList };
