import { describe, expect, it } from 'vitest';
import {
  getSeoAuditIssue,
  isIssuePresent,
  issuesForChecks,
  SEO_AUDIT_ISSUES,
  summarizeIssueCounts,
} from './audit-issues';

describe('SEO_AUDIT_ISSUES', () => {
  it('has unique keys and complete text', () => {
    const keys = SEO_AUDIT_ISSUES.map((issue) => issue.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const issue of SEO_AUDIT_ISSUES) {
      expect(issue.label.length).toBeGreaterThan(3);
      expect(issue.description.length).toBeGreaterThan(20);
      expect(issue.howToFix.length).toBeGreaterThan(10);
      expect(['critical', 'warning', 'info']).toContain(issue.severity);
    }
  });

  it('covers the checks the spec calls out', () => {
    for (const key of [
      'duplicate_title',
      'no_h1_tag',
      'low_content_rate',
      'broken_links',
      'is_redirect',
      'canonical_chain',
      'no_description',
      'title_too_long',
    ]) {
      expect(getSeoAuditIssue(key)).not.toBeNull();
    }
  });
});

describe('isIssuePresent', () => {
  it('treats true as present for normal checks and false for inverted ones', () => {
    expect(isIssuePresent('no_title', true)).toBe(true);
    expect(isIssuePresent('no_title', false)).toBe(false);
    expect(isIssuePresent('seo_friendly_url', false)).toBe(true);
    expect(isIssuePresent('seo_friendly_url', true)).toBe(false);
  });

  it('ignores unknown keys and unevaluated checks', () => {
    expect(isIssuePresent('is_https', true)).toBe(false);
    expect(isIssuePresent('no_title', null)).toBe(false);
    expect(isIssuePresent('no_title', undefined)).toBe(false);
  });
});

describe('issuesForChecks', () => {
  it('returns triggered catalogue entries most severe first', () => {
    const issues = issuesForChecks({
      title_too_long: true,
      no_title: false,
      no_description: true,
      is_5xx_code: true,
      is_https: true,
      seo_friendly_url: false,
      no_favicon: null,
    });
    expect(issues.map((issue) => issue.key)).toEqual([
      'is_5xx_code',
      'no_description',
      'title_too_long',
      'seo_friendly_url',
    ]);
  });

  it('is empty for missing checks', () => {
    expect(issuesForChecks(null)).toEqual([]);
  });
});

describe('summarizeIssueCounts', () => {
  it('groups ClickHouse tallies into catalogue counts and severity totals', () => {
    const summary = summarizeIssueCounts([
      { key: 'no_title', value: true, count: 3 },
      { key: 'no_title', value: false, count: 97 },
      { key: 'duplicate_title', value: true, count: 12 },
      { key: 'seo_friendly_url', value: false, count: 5 },
      { key: 'seo_friendly_url', value: true, count: 95 },
      { key: 'is_https', value: true, count: 100 },
      { key: 'made_up_key', value: true, count: 9 },
      { key: 'title_too_long', value: true, count: 0 },
    ]);
    expect(summary.issues.map((issue) => [issue.key, issue.count])).toEqual([
      ['no_title', 3],
      ['duplicate_title', 12],
      ['seo_friendly_url', 5],
    ]);
    expect(summary.totals).toEqual({ critical: 3, warning: 12, info: 5 });
  });
});
