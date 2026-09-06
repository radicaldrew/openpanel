/**
 * Site-audit issue catalogue, keyed by DataForSEO on_page `checks` keys.
 *
 * Labels, severities and how-to-fix text mirror open-seo's
 * `shared/audit-issues.ts` where a DFS check corresponds to one of its
 * issue types; checks open-seo does not have get text in the same voice.
 * A few DFS checks are "positive" (true is good, e.g. seo_friendly_url);
 * those carry `invert: true` and count as an issue when the check is false.
 *
 * The page-level booleans DFS reports outside `checks` (broken_links,
 * broken_resources, duplicate_title, duplicate_description,
 * duplicate_content) are merged into checks_json at insert time so this one
 * table describes everything the UI can group by.
 */

export type SeoAuditIssueSeverity = 'critical' | 'warning' | 'info';

export interface SeoAuditIssue {
  key: string;
  label: string;
  severity: SeoAuditIssueSeverity;
  description: string;
  howToFix: string;
  /** Issue is present when the check is `false` rather than `true`. */
  invert?: true;
}

export const SEO_AUDIT_SEVERITY_ORDER: Record<SeoAuditIssueSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

export const SEO_AUDIT_ISSUES: readonly SeoAuditIssue[] = [
  // ---------------------------------------------------------------- critical
  {
    key: 'is_5xx_code',
    label: 'Server error (5xx)',
    severity: 'critical',
    description:
      'The page returned a 5xx server error. Search engines that repeatedly see server errors will crawl the site less and may drop the page from the index.',
    howToFix:
      'Check the server logs for this URL and fix the underlying error. If the page is gone, return a 404/410 or redirect it to a relevant page instead of erroring.',
  },
  {
    key: 'is_broken',
    label: 'Page is broken',
    severity: 'critical',
    description:
      'The URL could not be fetched successfully (4xx/5xx or an unreadable response), so neither users nor crawlers get any content from it.',
    howToFix:
      'Restore the page or make it return a proper status. If it is intentionally gone, remove links and sitemap entries pointing at it.',
  },
  {
    key: 'broken_links',
    label: 'Broken internal link',
    severity: 'critical',
    description:
      'This page links to an internal URL that returns an error status (4xx/5xx). Broken links waste crawl budget, leak link equity, and frustrate users — they are among the most common and most damaging technical SEO issues.',
    howToFix:
      'Update the link to point at the correct live URL, or remove it. If the target was moved, prefer linking directly to the new URL rather than relying on a redirect.',
  },
  {
    key: 'no_title',
    label: 'Missing title tag',
    severity: 'critical',
    description:
      'The page has no <title>. The title is the strongest on-page relevance signal and the headline shown in search results; without it search engines generate one themselves, usually badly.',
    howToFix:
      "Add a unique, descriptive <title> of roughly 50–60 characters that includes the page's primary topic.",
  },
  {
    key: 'canonical_to_broken',
    label: 'Canonical points to a broken page',
    severity: 'critical',
    description:
      'The rel=canonical target returns an error, so search engines are told to index a page that does not exist and may drop this one too.',
    howToFix:
      'Point the canonical at a live 200 page — usually the page itself — and fix or remove the broken target.',
  },
  // ----------------------------------------------------------------- warning
  {
    key: 'is_4xx_code',
    label: 'Page returns an error (4xx)',
    severity: 'warning',
    description:
      'This crawled URL returned a client error (e.g. 404). If it is referenced from your sitemap or other pages, crawlers keep wasting requests on it.',
    howToFix:
      'If the page should exist, restore it. If it is intentionally gone, remove it from the sitemap and internal links, and consider a 301 redirect to the closest live page.',
  },
  {
    key: 'duplicate_title',
    label: 'Duplicate title',
    severity: 'warning',
    description:
      'Multiple pages share the same title tag. Search engines use titles to differentiate pages; duplicates make pages compete with each other and depress click-through rates.',
    howToFix:
      'Write a unique title for each page describing its specific content. For templated pages, include the distinguishing attribute (name, category, location) in the template.',
  },
  {
    key: 'duplicate_description',
    label: 'Duplicate meta description',
    severity: 'warning',
    description:
      'Multiple pages share the same meta description, so search results show identical snippets and users cannot tell the pages apart.',
    howToFix:
      'Write a unique meta description per page, or remove the duplicated one entirely — search engines will generate a snippet from page content, which beats a wrong duplicate.',
  },
  {
    key: 'duplicate_content',
    label: 'Duplicate page content',
    severity: 'warning',
    description:
      'Two or more URLs serve near-identical visible text. Search engines pick one version to index and ignore the rest, and ranking signals get split across the duplicates.',
    howToFix:
      'Consolidate duplicates: pick the canonical URL, add rel=canonical from the others, and 301-redirect duplicate URLs where possible (common causes: trailing-slash variants, URL parameters, http/https or www variants).',
  },
  {
    key: 'duplicate_meta_tags',
    label: 'Duplicate meta tags on the page',
    severity: 'warning',
    description:
      'The page declares the same meta tag more than once (for example two descriptions), so search engines pick one arbitrarily.',
    howToFix:
      'Keep a single instance of each meta tag in the <head>; check templates and plugins that inject their own tags.',
  },
  {
    key: 'no_description',
    label: 'Missing meta description',
    severity: 'warning',
    description:
      'The page has no meta description. Search engines will assemble a snippet from page text, which is often less compelling and hurts click-through rate.',
    howToFix:
      'Add a meta description of roughly 70–160 characters that summarizes the page and gives a reason to click.',
  },
  {
    key: 'no_h1_tag',
    label: 'Missing H1 heading',
    severity: 'warning',
    description:
      'The page has no H1. The H1 tells users and search engines what the page is about; pages without one tend to have weaker topical clarity.',
    howToFix:
      "Add a single H1 that states the page's main topic, consistent with the title tag.",
  },
  {
    key: 'redirect_chain',
    label: 'Redirect chain',
    severity: 'warning',
    description:
      'Reaching the final page requires two or more consecutive redirects. Each hop adds latency, leaks link equity, and burns crawl budget; long chains may not be followed at all.',
    howToFix:
      'Point the first URL (and any internal links) directly at the final destination so there is at most one redirect.',
  },
  {
    key: 'canonical_chain',
    label: 'Canonical chain',
    severity: 'warning',
    description:
      'The canonical target itself declares another canonical. Search engines may stop following the chain and choose their own canonical.',
    howToFix:
      'Point every page in the chain directly at the final canonical URL.',
  },
  {
    key: 'canonical_to_redirect',
    label: 'Canonical points to a redirect',
    severity: 'warning',
    description:
      'The rel=canonical target redirects elsewhere, which weakens the signal and can be ignored.',
    howToFix:
      'Update the canonical to the final destination URL of the redirect.',
  },
  {
    key: 'recursive_canonical',
    label: 'Recursive canonical',
    severity: 'warning',
    description:
      'Two or more pages canonicalize to each other, so there is no page search engines can treat as the source.',
    howToFix:
      'Pick one URL as canonical and make every page in the loop point at it.',
  },
  {
    key: 'is_link_relation_conflict',
    label: 'Conflicting canonical signals',
    severity: 'warning',
    description:
      'The page declares different canonical URLs in its HTML <link rel=canonical> and its HTTP Link header. When signals conflict, search engines ignore both and choose their own canonical.',
    howToFix:
      'Pick one canonical URL and declare it in exactly one place (HTML head is the most common); remove or align the other declaration.',
  },
  {
    key: 'low_content_rate',
    label: 'Thin content',
    severity: 'warning',
    description:
      'The page has very little visible text relative to its markup. Thin pages rarely rank, can drag down sitewide quality assessments, and (if the site renders client-side) may indicate content invisible to plain-HTML crawlers.',
    howToFix:
      'Either expand the page with genuinely useful content, noindex it, or consolidate it into a stronger page. If the content exists but is rendered by JavaScript, ensure it is server-rendered or pre-rendered.',
  },
  {
    key: 'no_image_alt',
    label: 'Images missing alt text',
    severity: 'warning',
    description:
      'One or more images on the page lack alt attributes. Alt text is an accessibility requirement and the main way search engines understand images.',
    howToFix:
      'Add descriptive alt text to meaningful images; use an empty alt (alt="") only for purely decorative ones.',
  },
  {
    key: 'is_orphan_page',
    label: 'Orphan page',
    severity: 'warning',
    description:
      "No crawled page links to this URL — it was only discoverable via the sitemap. Pages without internal links receive little crawl attention and no internal link equity, and users can't find them by browsing.",
    howToFix:
      "Link to this page from relevant pages (navigation, related content, hub pages), or remove it from the sitemap if it shouldn't be indexed.",
  },
  {
    key: 'broken_resources',
    label: 'Broken resources',
    severity: 'warning',
    description:
      'Images, scripts or stylesheets referenced by the page fail to load, which breaks rendering and wastes crawl requests.',
    howToFix:
      'Fix or remove the failing resource references; check for moved files and mixed-content blocks.',
  },
  {
    key: 'is_http',
    label: 'Not served over HTTPS',
    severity: 'warning',
    description:
      'The page is served over plain HTTP. Browsers mark it as not secure and search engines prefer the HTTPS version.',
    howToFix:
      'Serve the page over HTTPS and 301-redirect the HTTP URL to it.',
  },
  {
    key: 'https_to_http_links',
    label: 'HTTPS page links to HTTP',
    severity: 'warning',
    description:
      'A secure page links to insecure HTTP URLs, sending users and crawlers through redirects or to a less secure version.',
    howToFix:
      'Update internal links to their HTTPS equivalents.',
  },
  {
    key: 'has_links_to_redirects',
    label: 'Links to redirecting URLs',
    severity: 'warning',
    description:
      'The page links to URLs that redirect. Every hop costs latency and leaks link equity.',
    howToFix:
      'Point internal links directly at the final destination URLs.',
  },
  // -------------------------------------------------------------------- info
  {
    key: 'title_too_long',
    label: 'Title too long',
    severity: 'info',
    description:
      'The title exceeds ~60 characters, so search results will truncate it and the ending may be cut off mid-phrase.',
    howToFix:
      'Shorten the title to roughly 50–60 characters, front-loading the most important words.',
  },
  {
    key: 'title_too_short',
    label: 'Title too short',
    severity: 'info',
    description:
      'The title is very short, which is usually too generic to describe the page or attract clicks.',
    howToFix:
      'Expand the title into a descriptive phrase (roughly 30–60 characters) that states what the page offers.',
  },
  {
    key: 'irrelevant_title',
    label: 'Title does not match content',
    severity: 'info',
    description:
      'The title shares little vocabulary with the page body, so it may not describe what the page is actually about.',
    howToFix:
      "Rewrite the title to reflect the page's main topic using words that also appear in the content.",
  },
  {
    key: 'irrelevant_description',
    label: 'Meta description does not match content',
    severity: 'info',
    description:
      'The meta description shares little vocabulary with the page body; search engines are more likely to replace it with their own snippet.',
    howToFix:
      'Rewrite the description to summarize the actual page content.',
  },
  {
    key: 'irrelevant_meta_keywords',
    label: 'Meta keywords do not match content',
    severity: 'info',
    description:
      'The meta keywords tag lists terms that do not appear on the page. Search engines ignore the tag anyway.',
    howToFix:
      'Remove the meta keywords tag or align it with the content.',
  },
  {
    key: 'low_character_count',
    label: 'Very little text',
    severity: 'info',
    description:
      'The page contains fewer than roughly 1,000 characters of text, which is rarely enough to rank for anything competitive.',
    howToFix:
      'Add substantive content, or noindex the page if it is not meant to rank.',
  },
  {
    key: 'high_character_count',
    label: 'Very long page',
    severity: 'info',
    description:
      'The page contains an unusually large amount of text, which can be hard to read and slow to render.',
    howToFix:
      'Consider splitting the content into focused pages linked from a hub.',
  },
  {
    key: 'low_readability_rate',
    label: 'Low readability',
    severity: 'info',
    description:
      'The text scores poorly on readability indexes (long sentences, complex words).',
    howToFix:
      'Shorten sentences, use plain language and add headings and lists to break up the text.',
  },
  {
    key: 'high_loading_time',
    label: 'Slow page load',
    severity: 'info',
    description:
      'The page took over three seconds to load. Slow pages hurt every performance metric and reduce crawl rate on large sites.',
    howToFix:
      'Reduce page weight and render-blocking resources; serve cached or statically generated HTML where possible.',
  },
  {
    key: 'high_waiting_time',
    label: 'Slow server response',
    severity: 'info',
    description:
      'Time to first byte was high. Slow server responses drag down every downstream performance metric and reduce crawl rate on large sites.',
    howToFix:
      'Investigate server/database time and caching for this route; serving cached or statically generated HTML usually fixes it.',
  },
  {
    key: 'has_render_blocking_resources',
    label: 'Render-blocking resources',
    severity: 'info',
    description:
      'Scripts or stylesheets in the <head> block rendering until they are downloaded.',
    howToFix:
      'Defer or async non-critical scripts, inline critical CSS and load the rest asynchronously.',
  },
  {
    key: 'size_greater_than_3mb',
    label: 'Page larger than 3 MB',
    severity: 'info',
    description:
      'The HTML document alone is over 3 MB, which is slow to download and may be truncated by crawlers.',
    howToFix:
      'Move large inline data out of the HTML and paginate or lazy-load long content.',
  },
  {
    key: 'large_page_size',
    label: 'Large page',
    severity: 'info',
    description:
      'The page is heavier than typical, which slows loading, especially on mobile.',
    howToFix:
      'Compress images, remove unused scripts and styles, and enable text compression.',
  },
  {
    key: 'small_page_size',
    label: 'Unusually small page',
    severity: 'info',
    description:
      'The page is very small, which often means an empty template, an error page or content rendered only by JavaScript.',
    howToFix:
      'Verify the page renders its content server-side and is not an accidental placeholder.',
  },
  {
    key: 'is_redirect',
    label: 'Page redirects',
    severity: 'info',
    description:
      'The URL returns a 3xx redirect. Redirects are normal on their own; internal links should point at the destination.',
    howToFix:
      'Update internal links and sitemap entries to the final URL so crawlers do not need the redirect.',
  },
  {
    key: 'has_meta_refresh_redirect',
    label: 'Meta refresh redirect',
    severity: 'info',
    description:
      'The page redirects via a <meta http-equiv="refresh"> tag, which is slower than a server redirect and passes less signal.',
    howToFix:
      'Replace the meta refresh with a 301 server-side redirect.',
  },
  {
    key: 'no_favicon',
    label: 'Missing favicon',
    severity: 'info',
    description:
      'No favicon is declared. Search results and browser tabs show a generic icon instead of your brand.',
    howToFix:
      'Add a <link rel="icon"> pointing at a square icon of at least 48×48 px.',
  },
  {
    key: 'no_image_title',
    label: 'Images missing title attribute',
    severity: 'info',
    description:
      'Images lack a title attribute. This is a minor signal compared with alt text.',
    howToFix:
      'Add title attributes where a tooltip adds value; alt text matters more.',
  },
  {
    key: 'seo_friendly_url',
    label: 'URL is not SEO-friendly',
    severity: 'info',
    description:
      'The URL is long, dynamic or contains characters that make it hard to read and share.',
    howToFix:
      'Use short, lowercase, hyphen-separated URLs that describe the page.',
    invert: true,
  },
  {
    key: 'no_content_encoding',
    label: 'No text compression',
    severity: 'info',
    description:
      'The response is not compressed (gzip/brotli), so the page downloads slower than it needs to.',
    howToFix:
      'Enable gzip or brotli compression on the server or CDN.',
  },
  {
    key: 'no_doctype',
    label: 'Missing doctype',
    severity: 'info',
    description:
      'The document has no <!DOCTYPE>, which puts browsers into quirks mode and can break rendering.',
    howToFix:
      'Add <!DOCTYPE html> as the first line of the document.',
  },
  {
    key: 'no_encoding_meta_tag',
    label: 'Missing charset declaration',
    severity: 'info',
    description:
      'The page does not declare its character encoding, so browsers and crawlers have to guess.',
    howToFix:
      'Add <meta charset="utf-8"> to the <head>.',
  },
  {
    key: 'meta_charset_consistency',
    label: 'Charset mismatch',
    severity: 'info',
    description:
      'The charset declared in the HTML differs from the one in the HTTP headers.',
    howToFix:
      'Declare the same encoding (normally UTF-8) in both the Content-Type header and the meta tag.',
    invert: true,
  },
  {
    key: 'deprecated_html_tags',
    label: 'Deprecated HTML tags',
    severity: 'info',
    description:
      'The page uses HTML elements that are obsolete in HTML5 (for example <center> or <font>).',
    howToFix:
      'Replace deprecated elements with semantic HTML and CSS.',
  },
  {
    key: 'has_misspelling',
    label: 'Possible misspellings',
    severity: 'info',
    description:
      'The crawler detected words that look misspelled, which reads as low quality to users.',
    howToFix:
      'Proofread the page content.',
  },
  {
    key: 'lorem_ipsum',
    label: 'Placeholder text',
    severity: 'info',
    description:
      'The page still contains "lorem ipsum" placeholder text.',
    howToFix:
      'Replace the placeholder with real content or noindex the page until it is ready.',
  },
  {
    key: 'frame',
    label: 'Uses frames',
    severity: 'info',
    description:
      'The page uses <frame> or <iframe> for primary content, which search engines index poorly.',
    howToFix:
      'Move the framed content into the page itself.',
  },
  {
    key: 'flash',
    label: 'Uses Flash',
    severity: 'info',
    description:
      'The page embeds Flash content, which no modern browser can play.',
    howToFix:
      'Replace Flash with HTML5 equivalents.',
  },
  {
    key: 'has_micromarkup_errors',
    label: 'Structured data errors',
    severity: 'info',
    description:
      'The page contains schema.org markup with validation errors, so search engines may ignore it.',
    howToFix:
      "Validate the markup with Google's Rich Results Test and fix the reported errors.",
  },
];

const ISSUE_BY_KEY: ReadonlyMap<string, SeoAuditIssue> = new Map(
  SEO_AUDIT_ISSUES.map((issue) => [issue.key, issue])
);

export function getSeoAuditIssue(key: string): SeoAuditIssue | null {
  return ISSUE_BY_KEY.get(key) ?? null;
}

/**
 * Whether a check value means "this issue is present". Unknown keys never
 * count; null means DFS could not evaluate the check.
 */
export function isIssuePresent(
  key: string,
  value: boolean | null | undefined
): boolean {
  const issue = ISSUE_BY_KEY.get(key);
  if (!issue || value === null || value === undefined) {
    return false;
  }
  return issue.invert ? value === false : value === true;
}

/** The catalogue entries a page's checks trigger, most severe first. */
export function issuesForChecks(
  checks: Record<string, boolean | null | undefined> | null | undefined
): SeoAuditIssue[] {
  if (!checks) {
    return [];
  }
  const present: SeoAuditIssue[] = [];
  for (const [key, value] of Object.entries(checks)) {
    if (isIssuePresent(key, value)) {
      present.push(ISSUE_BY_KEY.get(key)!);
    }
  }
  return sortIssues(present);
}

export function sortIssues<T extends { severity: SeoAuditIssueSeverity; label: string }>(
  issues: T[]
): T[] {
  return [...issues].sort(
    (a, b) =>
      SEO_AUDIT_SEVERITY_ORDER[a.severity] - SEO_AUDIT_SEVERITY_ORDER[b.severity] ||
      a.label.localeCompare(b.label)
  );
}

export interface SeoAuditIssueCount extends SeoAuditIssue {
  count: number;
}

export interface SeoAuditIssueSummary {
  issues: SeoAuditIssueCount[];
  totals: Record<SeoAuditIssueSeverity, number>;
}

/**
 * Turn `(key, value) → pages` tallies (what one ClickHouse GROUP BY over
 * checks_json yields) into catalogue entries with counts, dropping unknown
 * keys and honouring inverted checks.
 */
export function summarizeIssueCounts(
  tallies: Array<{ key: string; value: boolean; count: number }>
): SeoAuditIssueSummary {
  const counts = new Map<string, number>();
  for (const tally of tallies) {
    if (isIssuePresent(tally.key, tally.value) && tally.count > 0) {
      counts.set(tally.key, (counts.get(tally.key) ?? 0) + tally.count);
    }
  }
  const issues = sortIssues(
    Array.from(counts, ([key, count]) => ({ ...ISSUE_BY_KEY.get(key)!, count }))
  );
  const totals: Record<SeoAuditIssueSeverity, number> = {
    critical: 0,
    warning: 0,
    info: 0,
  };
  for (const issue of issues) {
    totals[issue.severity] += issue.count;
  }
  return { issues, totals };
}
