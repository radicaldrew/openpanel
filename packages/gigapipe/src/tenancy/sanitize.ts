/**
 * Ports of gigapipe's own key sanitizers.
 *
 * These are not "roughly equivalent" helpers — they are transcriptions, and they
 * have to stay transcriptions. The tenancy boundary works by refusing to let a
 * customer-supplied attribute key collide with the label we stamp
 * (`op_project_id`). gigapipe decides whether two keys collide *after* it
 * sanitizes them, so the only way to know what collides is to sanitize the same
 * way it does.
 *
 * Concretely: an enumerated deny-list of spellings cannot work. Go's `regexp`
 * is rune-oriented, so `[^a-zA-Z0-9_]` replaces each non-ASCII rune with a
 * single `_`. All of these sanitize to exactly `op_project_id`:
 *
 *     op-project-id          (ASCII hyphen)
 *     op–project–id          (U+2013 en dash)
 *     op project id          (U+00A0 no-break space)
 *     opіprojectіid          (U+0456 Cyrillic i)
 *     op🙂project🙂id         (astral plane, one code point each)
 *
 * There are infinitely many such spellings. The predicate has to be computed.
 *
 * gigapipe has TWO sanitizers with DIFFERENT semantics, and both matter because
 * a key can reach ClickHouse through either path:
 *
 *   - `SanitizeKey`   (writer/utils/unmarshal/otlplogs.go:107) — OTLP attributes.
 *     Replaces invalid runes, then PREFIXES `_` if the result is empty or starts
 *     with a digit.
 *   - `sanitizeLabels` (writer/utils/unmarshal/unmarshal.go:274) — the Loki push
 *     path. One regex whose first alternative REPLACES a leading non-letter,
 *     non-underscore character rather than prefixing.
 *
 * They disagree on leading digits: `9x` becomes `_9x` under the first and `_x`
 * under the second. Checking only one form leaves a hole in the other path.
 */

/**
 * `[^a-zA-Z0-9_]` from otlplogs.go:105.
 *
 * The `u` flag is load-bearing. Without it JavaScript matches UTF-16 code
 * units, so an astral character (a surrogate pair) would become TWO
 * underscores where Go produces one — and a key crafted from astral characters
 * would sanitize differently here than in gigapipe, which is precisely the gap
 * an attacker needs.
 */
const OTLP_INVALID_CHAR = /[^a-zA-Z0-9_]/gu;

/**
 * `(^[^a-zA-Z_]|[^a-zA-Z0-9_])` from unmarshal.go:272.
 *
 * In both Go and JavaScript (no multiline flag) `^` anchors to the start of the
 * whole string only, so the alternation behaves identically.
 */
const LOKI_INVALID_CHAR = /(^[^a-zA-Z_]|[^a-zA-Z0-9_])/gu;

/**
 * Transcription of gigapipe's `SanitizeKey` — the OTLP attribute path.
 *
 * Applied to resource, scope and record/data-point attribute keys on every OTLP
 * signal.
 */
export function sanitizeOtlpKey(key: string): string {
  const sanitized = key.replace(OTLP_INVALID_CHAR, '_');

  // otlplogs.go:112 — `len(sanitized) == 0 || (sanitized[0] >= '0' && <= '9')`.
  // Indexing a Go string yields a byte, but after the replace above the string
  // is pure ASCII, so byte and character coincide and a plain charAt is exact.
  const first = sanitized.charAt(0);
  if (sanitized.length === 0 || (first >= '0' && first <= '9')) {
    return `_${sanitized}`;
  }

  return sanitized;
}

/**
 * Transcription of gigapipe's `sanitizeLabels` key half — the Loki push path.
 *
 * Note this is a REPLACE of the leading character, not a prefix. `9x` -> `_x`,
 * where {@link sanitizeOtlpKey} gives `_9x`.
 */
export function sanitizeLokiLabelName(key: string): string {
  return key.replace(LOKI_INVALID_CHAR, '_');
}

/**
 * gigapipe truncates label VALUES at 100 bytes on the Loki path
 * (unmarshal.go:277) and appends `...`, and it never de-duplicates label names.
 *
 * Exported because the value side has its own consequence: two distinct values
 * that share a 100-byte prefix become the same label value, so a value is never
 * a safe carrier of identity. Nothing in the tenancy path may depend on a label
 * value surviving intact beyond 100 bytes — the project id is validated to at
 * most 100 characters partly for this reason.
 */
export const LOKI_LABEL_VALUE_MAX_BYTES = 100;

export function lokiValueWouldTruncate(value: string): boolean {
  return Buffer.byteLength(value, 'utf8') > LOKI_LABEL_VALUE_MAX_BYTES;
}
