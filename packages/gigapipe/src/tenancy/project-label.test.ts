import { describe, expect, it } from 'vitest';
import {
  InvalidProjectIdError,
  PROJECT_LABEL,
  isReservedAttributeKey,
  isValidProjectId,
  stampProjectLabel,
} from './project-label';
import { lokiValueWouldTruncate, sanitizeLokiLabelName, sanitizeOtlpKey } from './sanitize';

/**
 * This suite is the tenancy boundary's gate. Everything here is an attempt to
 * get a customer-controlled attribute to occupy, forge or survive alongside
 * `op_project_id`.
 *
 * If a case here fails, telemetry from one project can be attributed to — or
 * read by — another. Nothing in P1 ships while any of it is red.
 */

describe('sanitizeOtlpKey — transcription of gigapipe SanitizeKey', () => {
  it('replaces each invalid ASCII character with one underscore', () => {
    expect(sanitizeOtlpKey('op-project-id')).toBe('op_project_id');
    expect(sanitizeOtlpKey('op.project.id')).toBe('op_project_id');
    expect(sanitizeOtlpKey('op project id')).toBe('op_project_id');
  });

  it('replaces each non-ASCII RUNE with exactly one underscore', () => {
    // Go's regexp is rune-oriented. If this file's regex lost its `u` flag,
    // the astral case below would produce two underscores and stop matching
    // what gigapipe stores.
    expect(sanitizeOtlpKey('op–project–id')).toBe('op_project_id'); // en dash
    expect(sanitizeOtlpKey('op project id')).toBe('op_project_id'); // NBSP
    expect(sanitizeOtlpKey('opіprojectіid')).toBe('op_project_id'); // Cyrillic i
    expect(sanitizeOtlpKey('op\u{1f642}project\u{1f642}id')).toBe('op_project_id'); // astral
  });

  it('prefixes rather than replaces a leading digit', () => {
    expect(sanitizeOtlpKey('9abc')).toBe('_9abc');
  });

  it('maps the empty key to a single underscore', () => {
    expect(sanitizeOtlpKey('')).toBe('_');
  });
});

describe('sanitizeLokiLabelName — transcription of gigapipe sanitizeLabels', () => {
  it('REPLACES a leading digit, unlike the OTLP sanitizer', () => {
    // The two sanitizers genuinely disagree here. Checking only one form is
    // how a key slips through on the path you did not check.
    expect(sanitizeLokiLabelName('9abc')).toBe('_abc');
    expect(sanitizeOtlpKey('9abc')).toBe('_9abc');
  });

  it('collapses the same unicode spellings onto the reserved name', () => {
    expect(sanitizeLokiLabelName('op–project–id')).toBe('op_project_id');
    expect(sanitizeLokiLabelName('op\u{1f642}project\u{1f642}id')).toBe('op_project_id');
  });
});

describe('isReservedAttributeKey', () => {
  it('rejects the label itself', () => {
    expect(isReservedAttributeKey(PROJECT_LABEL)).toBe(true);
  });

  it.each([
    ['ascii hyphen', 'op-project-id'],
    ['dots', 'op.project.id'],
    ['spaces', 'op project id'],
    ['en dash', 'op–project–id'],
    ['no-break space', 'op project id'],
    ['cyrillic i', 'opіprojectіid'],
    ['astral emoji', 'op\u{1f642}project\u{1f642}id'],
    ['mixed', 'op–project.id'],
  ])('rejects a key that sanitizes onto the label (%s)', (_name, key) => {
    expect(isReservedAttributeKey(key)).toBe(true);
  });

  it('rejects case variants even though gigapipe would treat them as distinct', () => {
    expect(isReservedAttributeKey('OP_PROJECT_ID')).toBe(true);
    expect(isReservedAttributeKey('Op_Project_Id')).toBe(true);
  });

  it('rejects the whole reserved prefix, not just the current label', () => {
    // A future op_-prefixed label must not arrive pre-forgeable.
    expect(isReservedAttributeKey('op_signal')).toBe(true);
    expect(isReservedAttributeKey('op-anything-at-all')).toBe(true);
  });

  it('allows ordinary customer attributes', () => {
    for (const key of [
      'service.name',
      'http.route',
      'operation',      // starts with "op" but not "op_"
      'openpanel',      // ditto
      'ops_team',
      'my.op.counter',
      'project_id',
    ]) {
      expect(isReservedAttributeKey(key), key).toBe(false);
    }
  });
});

describe('stampProjectLabel', () => {
  it('stamps the authenticated project', () => {
    expect(stampProjectLabel({ 'service.name': 'api' }, 'proj_123')).toEqual({
      'service.name': 'api',
      [PROJECT_LABEL]: 'proj_123',
    });
  });

  it('overwrites a client-supplied value rather than merging or erroring', () => {
    const out = stampProjectLabel(
      { [PROJECT_LABEL]: 'someone-elses-project' },
      'proj_123',
    );

    expect(out[PROJECT_LABEL]).toBe('proj_123');
    expect(Object.values(out)).not.toContain('someone-elses-project');
  });

  it('strips colliding spellings BEFORE stamping, leaving exactly one label', () => {
    // The ordering bug this guards against is subtle: stamping into a bag that
    // still holds `op-project-id` leaves two keys that sanitize to the same
    // name, and for OTLP logs the record attributes are merged last and win.
    const out = stampProjectLabel(
      {
        'op-project-id': 'forged-a',
        'op–project–id': 'forged-b',
        'op\u{1f642}project\u{1f642}id': 'forged-c',
        'service.name': 'api',
      },
      'proj_123',
    );

    const collidingKeys = Object.keys(out).filter(
      (k) => sanitizeOtlpKey(k) === PROJECT_LABEL,
    );

    expect(collidingKeys).toEqual([PROJECT_LABEL]);
    expect(out[PROJECT_LABEL]).toBe('proj_123');
    expect(out['service.name']).toBe('api');
    expect(Object.values(out)).not.toContain('forged-a');
    expect(Object.values(out)).not.toContain('forged-b');
    expect(Object.values(out)).not.toContain('forged-c');
  });

  it('refuses an invalid project id rather than emitting an unscoped label', () => {
    for (const bad of ['', 'has space', 'has"quote', 'a'.repeat(101), '{}', 'a\nb']) {
      expect(() => stampProjectLabel({}, bad), bad).toThrow(InvalidProjectIdError);
    }
  });

  it('accepts the id shapes OpenPanel actually issues', () => {
    for (const good of ['proj_123', 'a', 'A-B_c-9', 'a'.repeat(100)]) {
      expect(isValidProjectId(good), good).toBe(true);
    }
  });

  it('never produces a project id that gigapipe would truncate', () => {
    // Loki truncates label VALUES at 100 bytes. A 101-char id would be cut to
    // 100 + "...", which could collide with a different project's prefix — so
    // the validator's ceiling and gigapipe's truncation point must agree.
    expect(lokiValueWouldTruncate('a'.repeat(100))).toBe(false);
    expect(isValidProjectId('a'.repeat(101))).toBe(false);
  });
});
