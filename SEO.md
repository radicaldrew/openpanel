# OpenPanel SEO Module — Implementation Spec

**Repo:** `radicaldrew/openpanel` (fork)
**Reference implementation:** `every-app/open-seo` (MIT) — used for the DataForSEO client and data-model shape, not copied as an app.
**Status:** Draft v1 — 2026-09-06

---

## 1. Goal

Turn the single-page GSC dashboard at `/$organizationId/$projectId/seo` into a tabbed SEO module that combines:

- **Google Search Console** (already built) — first-party data: what *your* site gets.
- **DataForSEO** (new) — market data: keyword volume/difficulty, live SERP positions, backlinks, site audit, AI-engine visibility.

The distinguishing feature versus open-seo or Semrush is the **join**: GSC queries enriched with DFS metrics, GSC average position vs. actual SERP snapshot, tracked keywords seeded from real GSC traffic.

### Non-goals (v1)

- Multi-tenant billing / credit accounting for DFS spend (single DFS key per org is fine; see §11).
- Google Business Profile / local SEO (open-seo's `business.ts`) — defer.
- Porting open-seo's Sam chat agent — openpanel already has "Ask AI"; expose DFS data to it via MCP tools instead.
- Replacing open-seo's custom crawler — use DFS On-Page API for the audit in v1.

---

## 2. Current state (what already exists in openpanel)

| Layer | Existing GSC artefact | Location |
|---|---|---|
| Prisma | `GscConnection` (1:1 with `Project`, encrypted tokens, sync status) | `packages/db/prisma/schema.prisma` |
| ClickHouse | `gsc_daily`, `gsc_pages_daily`, `gsc_queries_daily` (`ReplacingMergeTree(synced_at)`, partitioned by month) | `packages/db/code-migrations/12-add-gsc.ts` |
| DB service | `getGscAccessToken`, `syncGscData`, `getGscOverview`, `getGscPages`, `getGscQueries`, cannibalization | `packages/db/src/gsc.ts` |
| Queue | `gscQueue` with `gscProjectSync` / `gscProjectBackfill`; cron `gscSync` → `gscSyncAllJob` | `packages/queue/src/queues.ts`, `apps/worker/src/jobs/gsc.ts`, `cron.ts` |
| OAuth | `gsc-oauth-callback.controller.ts` | `apps/api/src/controllers/` |
| tRPC | `gsc` router: `getConnection`, `initiateOAuth`, `getSites`, `selectSite`, `disconnect`, `getOverview`, `getPages`, `getPageDetails`, `getQueries`, `getQueryDetails`, `getSearchEngines`, `getAiEngines`, `getPreviousOverview`, `getCannibalization` | `packages/trpc/src/routers/gsc.ts` |
| MCP | `gsc_get_overview`, pages, queries, cannibalization tools | `packages/mcp/src/tools/gsc/` |
| UI | `seo.tsx` (single page, gated on `gsc.getConnection().siteUrl`), `settings/_tabs/gsc.tsx` | `apps/start/src/routes/` |
| Sidebar | Single `SEO` link | `components/sidebar-project-menu.tsx` |

Patterns to reuse verbatim: `_tabs` layout routes (`events._tabs.tsx`), `usePageTabs`, `useRangePageContext`, `FullPageEmptyState`, `encrypt`/`decrypt` from `packages/db/src/encryption.ts`, `cacheable` from `@openpanel/redis`, `guardQueue`, `withErrorHandling`/`resolveProjectId`/`table` from `packages/mcp/src/tools/shared.ts`, the `createTable` migration helper.

---

## 3. Architecture overview

```
apps/start (TanStack)            apps/api (Fastify)         apps/worker (BullMQ)
 seo/_tabs/*  ──trpc──►  packages/trpc/routers/seo/*  ──►  packages/db/src/seo/*
                                                       │           │
                                                       │     packages/dataforseo (new)
                                                       │           │
                                                       ▼           ▼
                                               Postgres (Prisma)   ClickHouse   api.dataforseo.com
                                               config / keys /     time series
                                               tracked keywords    snapshots
                                                       ▲
                                    seoQueue jobs ─────┘   (rank checks, audit polling, backlink snapshots)
packages/mcp/tools/seo/*  ── same db services ── exposes everything to Ask AI + external agents
```

Rules:

- **Postgres** holds configuration and small entity tables (tracked keywords, audit runs, competitor lists).
- **ClickHouse** holds anything time-series or high-cardinality (rank snapshots, keyword metrics cache, backlink snapshots, audit page rows). Same reasoning as GSC.
- **All DFS calls go through `packages/dataforseo`**. No route/router/job calls `api.dataforseo.com` directly.
- **Live calls are cached in Redis** with a per-endpoint TTL so a page refresh doesn't cost money. Scheduled work runs in the worker, never in a request handler.

---

## 4. `packages/dataforseo` (new package)

Lift `open-seo/src/server/lib/dataforseo/` nearly wholesale (~3k LOC ex-tests, MIT). Keep the file split:

| File | Keep | Notes |
|---|---|---|
| `core.ts` | yes | Authenticated fetch, 60 s timeout, 2 retries on 5xx. Replace `getRequiredEnvValue("DATAFORSEO_API_KEY")` with a key passed in at client construction (per-org key, see §5). Replace `AppError` with a local `DataForSeoError` class carrying `status`, `dfsStatusCode`, `path`. |
| `envelope.ts` | yes | Parses `tasks[].result[]` wrapper and `status_code` per task; this is where most DFS foot-guns live. |
| `client.ts` | yes | `createDataforseoClient({ apiKey, fetchImpl?, onCost? })`. Add an `onCost(path, costUsd)` hook — DFS returns `cost` in every envelope; log it per org. |
| `labs.ts` | yes | keyword_ideas, keyword_suggestions, related_keywords, keyword_overview, ranked_keywords, relevant_pages, serp_competitors, domain_rank_overview. |
| `keyword-metrics.ts`, `google-ads.ts` | yes | search_volume / keywords_for_keywords fallback when Labs has no data. |
| `serp.ts`, `serp-locations.ts` | yes | organic live/advanced + task_post/task_get flow. |
| `backlinks.ts` | yes | summary, backlinks, referring_domains, history, domain_pages_summary. |
| `ai.ts` | yes | ai_optimization/llm_mentions/*. |
| `lighthouse.ts` | yes | on_page/lighthouse/live/json. |
| `filters.ts`, `researchScopeFilters.ts`, `shared.ts` | yes | DFS filter DSL builders. |
| `appendix.ts` | yes | `appendix/user_data` — used for "validate key" + balance display. |
| `business.ts` | **drop** | GBP not in scope. |
| `dataforseoBillingClassification.ts` | **drop** | open-seo's hosted-billing concern. |
| `on-page.ts` | **new** | `on_page/task_post`, `on_page/summary`, `on_page/pages`, `on_page/duplicate_tags`, `on_page/links`, `on_page/non_indexable`. open-seo uses its own crawler; we use DFS On-Page (§8.5). |

Package layout:

```
packages/dataforseo/
  package.json          ("@openpanel/dataforseo", deps: zod only)
  src/index.ts
  src/client.ts ... (as above)
  src/types/*.ts        (zod schemas from open-seo/src/types/schemas/{keywords,rank-tracking,backlinks,domain,ai-search}.ts)
```

Bring the tests across too (`*.test.ts` use vitest; openpanel is vitest as well).

---

## 5. Data model

### 5.1 Prisma (Postgres)

```prisma
// Per-organization DFS credentials. Org-level, not project-level, so one key
// serves every site the org tracks. Encrypted with packages/db encryption.ts
// exactly like GscConnection tokens.
model DataForSeoConnection {
  id             String       @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  organizationId String       @unique
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  apiKeyEnc      String       // base64(login:password), encrypted
  login          String       // plain, for display
  balanceUsd     Float?       // last seen from appendix/user_data
  balanceAt      DateTime?
  lastError      String?
  monthlySpendUsd Float       @default(0) // rolling counter, reset by cron
  spendCapUsd    Float?       // optional soft cap; jobs skip when exceeded
  createdAt      DateTime     @default(now())
  updatedAt      DateTime     @default(now()) @updatedAt
  @@map("dataforseo_connections")
}

// Per-project SEO settings. Created lazily on first use of any SEO tab.
model SeoProjectConfig {
  id            String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  projectId     String   @unique
  project       Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
  domain        String   // "example.com" — derived from GscConnection.siteUrl if present, else user-entered
  locationCode  Int      @default(2840)  // DFS location_code; 2376 = Israel
  languageCode  String   @default("en")  // "he" for Hebrew
  devices       String   @default("both") // both | desktop | mobile
  serpDepth     Int      @default(20)
  rankSchedule  String   @default("daily") // daily | weekly | manual
  rankNextRunAt DateTime?
  rankLastRunAt DateTime?
  backlinkSchedule String @default("weekly")
  backlinkNextRunAt DateTime?
  competitors   String[] // domains
  createdAt     DateTime @default(now())
  updatedAt     DateTime @default(now()) @updatedAt
  @@map("seo_project_configs")
}

model SeoTrackedKeyword {
  id            String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  projectId     String
  project       Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
  keyword       String
  tags          String[]
  source        String   @default("manual") // manual | gsc | research
  searchVolume  Int?
  difficulty    Int?
  cpc           Float?
  metricsAt     DateTime?
  isActive      Boolean  @default(true)
  createdAt     DateTime @default(now())
  @@unique([projectId, keyword])
  @@index([projectId, isActive])
  @@map("seo_tracked_keywords")
}

model SeoRankRun {
  id              String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  projectId       String
  project         Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
  status          String   // pending | running | completed | failed
  keywordsTotal   Int      @default(0)
  keywordsChecked Int      @default(0)
  costUsd         Float    @default(0)
  error           String?
  startedAt       DateTime @default(now())
  completedAt     DateTime?
  @@index([projectId, startedAt])
  @@map("seo_rank_runs")
}

model SeoAudit {
  id           String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  projectId    String
  project      Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
  dfsTaskId    String?  // on_page task id
  status       String   // queued | crawling | completed | failed
  maxPages     Int      @default(500)
  pagesCrawled Int      @default(0)
  score        Int?     // onpage_score
  summary      Json?    // on_page/summary result (issue counts etc.)
  costUsd      Float    @default(0)
  error        String?
  startedAt    DateTime @default(now())
  completedAt  DateTime?
  @@index([projectId, startedAt])
  @@map("seo_audits")
}
```

Add relations on `Organization` (`dataForSeoConnection DataForSeoConnection?`) and `Project` (`seoConfig`, `seoTrackedKeywords`, `seoRankRuns`, `seoAudits`).

### 5.2 ClickHouse — `code-migrations/NN-add-seo.ts`

Reuse `createTable` from `12-add-gsc.ts` (same `isClustered` / `distributionHash` handling).

```
seo_rank_snapshots
  project_id String, keyword String, device LowCardinality(String),
  checked_at DateTime, run_id String,
  position Nullable(UInt16),      -- null = not in top serpDepth
  url String, serp_features Array(String),
  competitors_json String,        -- top-10 [{domain, position}] for competitor overlay
  ORDER BY (project_id, keyword, device, checked_at)   PARTITION BY toYYYYMM(checked_at)
  ENGINE MergeTree  (append-only; multiple checks/day are legitimate)

seo_keyword_metrics
  project_id String, keyword String, location_code UInt32, language_code LowCardinality(String),
  search_volume UInt32, difficulty UInt8, cpc Float32, competition Float32,
  monthly_json String,             -- 12-month search volume array
  fetched_at DateTime
  ORDER BY (project_id, keyword, location_code, language_code)
  ENGINE ReplacingMergeTree(fetched_at)

seo_backlink_snapshots
  project_id String, date Date,
  backlinks UInt32, referring_domains UInt32, referring_ips UInt32,
  rank UInt16, spam_score UInt8,
  new_backlinks UInt32, lost_backlinks UInt32,
  synced_at DateTime
  ORDER BY (project_id, date)   ENGINE ReplacingMergeTree(synced_at)

seo_audit_pages
  project_id String, audit_id String, url String,
  status_code UInt16, onpage_score Float32,
  title String, meta_description String, h1 String,
  word_count UInt32, load_time_ms UInt32, size_bytes UInt32,
  internal_links UInt16, external_links UInt16,
  is_indexable UInt8, canonical String,
  checks_json String               -- DFS per-page checks object
  ORDER BY (project_id, audit_id, url)   ENGINE MergeTree
```

Rank snapshot rows for a run are also aggregated into a materialized view `seo_rank_daily` (`project_id, keyword, device, date, best_position, url`) to make the trend chart cheap. Same shape as `gsc_queries_daily` so the join in §8.2 is a simple `LEFT JOIN … ON (project_id, query=keyword, date)`.

---

## 6. Queues & worker jobs

`packages/queue/src/queues.ts`:

```ts
export type SeoQueuePayload =
  | { type: 'seoRankRun';        payload: { projectId: string; runId: string; keywordIds?: string[] } }
  | { type: 'seoRankTaskPoll';   payload: { projectId: string; runId: string; taskIds: string[] } }
  | { type: 'seoBacklinkSnapshot'; payload: { projectId: string } }
  | { type: 'seoAuditStart';     payload: { projectId: string; auditId: string } }
  | { type: 'seoAuditPoll';      payload: { projectId: string; auditId: string } }
  | { type: 'seoKeywordMetrics'; payload: { projectId: string; keywords: string[] } };

export const seoQueue = guardQueue(new Queue<SeoQueuePayload>(getQueueName('seo'), {...}), 'seo');
```

Cron additions (`cron.ts` + `CronQueuePayload`):

- `seoRankScheduler` (every 15 min) — finds `SeoProjectConfig` where `rankNextRunAt <= now()` and `rankSchedule != 'manual'`, creates a `SeoRankRun`, enqueues `seoRankRun`, advances `rankNextRunAt`.
- `seoBacklinkScheduler` (daily) — same for `backlinkNextRunAt`.
- `seoSpendReset` (monthly) — zeroes `monthlySpendUsd`.
- `seoBalanceRefresh` (daily) — `appendix/user_data` per org → `balanceUsd`.

`apps/worker/src/jobs/seo.ts` dispatch, one file per job family:

- **`seo.rank.ts`** — For each active keyword × device: `serp/google/organic/task_post` in batches of 100 (DFS max per call), with `postback_url` omitted (poll instead; simpler behind Cloudflare). Enqueue `seoRankTaskPoll` with delay 60 s. Poll job: `serp/google/organic/tasks_ready` → `task_get/advanced/{id}` for ready ones, write snapshots to ClickHouse, update `keywordsChecked`; re-enqueue with backoff (60 → 120 → 300 s, max 30 min) until all done or `SeoRankRun.startedAt + 2h` → mark failed with partial data kept. Sum `cost` from every envelope into `SeoRankRun.costUsd` and `DataForSeoConnection.monthlySpendUsd`.
  - For runs ≤ 10 keywords (manual "check now" on a few) use `live/advanced` synchronously instead; simpler UX.
  - Skip the run and set `error='spend cap reached'` if `monthlySpendUsd >= spendCapUsd`.
- **`seo.backlinks.ts`** — `backlinks/summary/live` + `backlinks/history/live` (last 30 d) → `seo_backlink_snapshots`.
- **`seo.audit.ts`** — `on_page/task_post` with `{target: domain, max_crawl_pages, enable_javascript: false, load_resources: false}` → store `dfsTaskId`, enqueue `seoAuditPoll` (30 s). Poll: `on_page/summary/{id}`; when `crawl_progress == 'finished'` page through `on_page/pages/{id}` (limit 1000/offset) into `seo_audit_pages`, store summary JSON, mark completed.
- **`seo.metrics.ts`** — `dataforseo_labs/google/keyword_overview/live` in batches of 700 (Labs max) → `seo_keyword_metrics` + copy volume/difficulty/cpc onto `SeoTrackedKeyword`. Triggered when keywords are added and by a weekly cron refresh.

All jobs resolve the org key via `getDfsClientForProject(projectId)` in `packages/db/src/seo/client.ts` (project → organization → decrypted key → `createDataforseoClient`). Throws a typed `DfsNotConfiguredError` that routers translate to `PRECONDITION_FAILED`.

---

## 7. tRPC routers

New folder `packages/trpc/src/routers/seo/` merged into the app router as `seo`. Keep the existing `gsc` router untouched.

### `seo.settings`
- `getStatus({projectId})` → `{ dfs: {configured, login, balanceUsd, monthlySpendUsd, spendCapUsd}, gsc: {connected, siteUrl}, config: SeoProjectConfig | null }`. This is the single call every tab's gate uses.
- `setDfsKey({organizationId, login, password})` — validates via `appendix/user_data`, encrypts, upserts. Org admin only.
- `removeDfsKey({organizationId})`.
- `setSpendCap({organizationId, capUsd | null})`.
- `upsertProjectConfig({projectId, domain, locationCode, languageCode, devices, serpDepth, rankSchedule, backlinkSchedule, competitors})`.
- `listLocations({q})` — from `serp-locations.ts` static list (no DFS call).

### `seo.keywords` (research)
All `live` calls, Redis-cached 24 h keyed by `(org, endpoint, hash(params))`.
- `ideas({projectId, seed, limit})` → `labs/keyword_ideas`
- `suggestions({projectId, seed, limit})` → `labs/keyword_suggestions`
- `related({projectId, seed})` → `labs/related_keywords`
- `overview({projectId, keywords[]})` → `labs/keyword_overview` (and persist into `seo_keyword_metrics`)
- `rankedKeywords({projectId, domain?})` → `labs/ranked_keywords` (your domain or a competitor)
- `serpPreview({projectId, keyword})` → `serp/google/organic/live/advanced` (cached 6 h)
- `gscEnriched({projectId, range})` — **the join**: `getGscQueries` top-N ∪ `seo_keyword_metrics`; for queries missing metrics, enqueue `seoKeywordMetrics` and return `pending: true` for those rows.

### `seo.tracking`
- `list({projectId, tag?, search?})` → tracked keywords + latest snapshot per device + 7d/30d delta (one CH query against `seo_rank_daily`).
- `add({projectId, keywords[], tags?, source})` — upsert, enqueue `seoKeywordMetrics`.
- `addFromGsc({projectId, minImpressions, limit})` — top GSC queries in last 28 d not already tracked → `add(..., source:'gsc')`.
- `remove({projectId, ids[]})`, `setTags`, `setActive`.
- `runNow({projectId, keywordIds?})` — creates run, enqueues `seoRankRun`. Rate-limit 1 pending run per project.
- `runs({projectId, limit})`, `run({runId})` (progress polling).
- `history({projectId, keyword, device, range})` → position series + `gsc_queries_daily.position` on the same dates for overlay.
- `competitors({projectId, range})` → share-of-voice from `competitors_json` in snapshots.

### `seo.backlinks`
- `summary({projectId, target?})` → latest `seo_backlink_snapshots` row + live `backlinks/summary` if older than 24 h.
- `history({projectId, range})` → series.
- `list({projectId, target?, filters, sort, cursor})` → `backlinks/backlinks/live` (paged, cached 6 h).
- `referringDomains(...)` → `backlinks/referring_domains/live`.
- `pages(...)` → `backlinks/domain_pages_summary/live`.
- `snapshotNow({projectId})` → enqueue `seoBacklinkSnapshot`.

### `seo.audit`
- `list({projectId})`, `get({auditId})` (summary + issue counts), `start({projectId, maxPages})`, `cancel`.
- `pages({auditId, issue?, sort, cursor})` → from `seo_audit_pages`, filter by check key.
- `issues({auditId})` → grouped counts derived from `checks_json` (`duplicate_title`, `no_h1`, `low_content_rate`, `broken_links`, `is_redirect`, `canonical_chain`, etc. — mirror open-seo's `issues/` catalogue for labels/severity/how-to-fix text).
- `lighthouse({projectId, url, device})` → `on_page/lighthouse/live/json` (cached 24 h). Optional per-page detail.

### `seo.ai`
- `mentions({projectId, keyword|domain, engines[], range})` → `ai_optimization/llm_mentions/search/live`
- `aggregate({projectId, domain, range})` → `aggregated_metrics/live`
- `shareOfVoice({projectId, competitors[], range})` → `cross_aggregated_metrics/live`
- `topPages({projectId, domain})` → `top_pages/live`
- Note the existing `gsc.getAiEngines` (referrals from AI engines in your own traffic) — surface both on the same tab: *visibility in AI answers* (DFS) next to *traffic from AI answers* (GSC/OpenPanel events).

Every DFS-backed procedure is wrapped so `DfsNotConfiguredError` → `TRPCError PRECONDITION_FAILED` with `cause: 'DFS_NOT_CONFIGURED'`, and `DataForSeoError` with DFS `status_code 40200/40201` (insufficient funds) → `PRECONDITION_FAILED` with `cause: 'DFS_NO_BALANCE'`. The UI maps these to the empty states in §8.

---

## 8. UI — routes and tabs

### 8.1 Route restructure

```
routes/
  _app.$organizationId.$projectId.seo._tabs.tsx            layout: PageHeader "SEO" + Tabs + <Outlet/>
  _app.$organizationId.$projectId.seo._tabs.index.tsx      = today's seo.tsx (GSC overview), renamed
  _app.$organizationId.$projectId.seo._tabs.keywords.tsx   Keyword research
  _app.$organizationId.$projectId.seo._tabs.rankings.tsx   Rank tracking
  _app.$organizationId.$projectId.seo._tabs.backlinks.tsx
  _app.$organizationId.$projectId.seo._tabs.audit.tsx
  _app.$organizationId.$projectId.seo._tabs.audit_.$auditId.tsx   (drill-in, outside tabs like cohorts_.$cohortId)
  _app.$organizationId.$projectId.seo._tabs.ai.tsx
  _app.$organizationId.$projectId.settings._tabs.dataforseo.tsx
```

Layout copies `events._tabs.tsx`:

```ts
const { activeTab, tabs } = usePageTabs([
  { id: 'index',     label: 'Search Console' },
  { id: 'keywords',  label: 'Keywords' },
  { id: 'rankings',  label: 'Rankings' },
  { id: 'backlinks', label: 'Backlinks' },
  { id: 'audit',     label: 'Site Audit' },
  { id: 'ai',        label: 'AI Visibility' },
]);
useRangePageContext('seo');
```

Sidebar: unchanged, still one `SEO` entry. Settings tabs: add `{ id: 'dataforseo', label: 'DataForSEO' }` after `gsc`.

### 8.2 Gating — one shared component

`components/seo/seo-gate.tsx`:

```tsx
<SeoGate requires={['gsc'] | ['dfs'] | ['dfs','gsc']} fallback="any"|"all">
```

Reads `seo.settings.getStatus` once (React Query, shared across tabs). Renders `FullPageEmptyState` with the right CTA:

| Missing | Title | CTA → |
|---|---|---|
| gsc | No Search Console data yet | `settings/gsc` (existing) |
| dfs | Connect DataForSEO to unlock keyword, ranking and backlink data | `settings/dataforseo` |
| dfs balance | DataForSEO balance is empty | link to dataforseo.com billing + "refresh balance" button |
| project config (domain) | Which site should we track? | inline form: domain (prefilled from `GscConnection.siteUrl`), location, language |

Per-tab requirements:

| Tab | Requires |
|---|---|
| Search Console | gsc |
| Keywords | dfs (GSC optional: enables "From Search Console" source) |
| Rankings | dfs (GSC optional: enables seeding + overlay) |
| Backlinks | dfs |
| Site Audit | dfs |
| AI Visibility | dfs *or* gsc (`fallback="any"`: show whichever half is available) |

### 8.3 Tab contents

**Search Console (index)** — unchanged, plus two additions once DFS is configured: a "Volume" and "Difficulty" column on the queries table (from `seo.keywords.gscEnriched`), and a "Track" action on each query row → `seo.tracking.add`.

**Keywords** — left: seed input + source selector (Ideas / Suggestions / Related / Ranked keywords for domain / From Search Console); right: results table (keyword, volume, difficulty, CPC, intent, trend sparkline from `monthly_json`) with multi-select → "Track selected" / "Export CSV". Row click → SERP preview drawer (`serpPreview`) showing top 10 with your domain highlighted and features (PAA, featured snippet, video…).

**Rankings** — header cards: avg position, keywords in top 3 / top 10 / top 20, visibility score (Σ volume-weighted CTR curve), last run + "Check now". Table: keyword, tags, volume, position desktop / mobile with delta chips, ranking URL, SERP features. Row click → history chart: DFS position line(s) with GSC average position overlaid as a dashed line (`seo.tracking.history`). Secondary view "Competitors": share-of-voice stacked bar per configured competitor. Empty state when no keywords: two buttons — "Add keywords" (textarea) and "Import top queries from Search Console" (`addFromGsc`, disabled when GSC missing).

**Backlinks** — cards (backlinks, referring domains, domain rank, spam score, new/lost 30 d), history chart, tabbed tables: Backlinks / Referring domains / Top pages, with filters (dofollow, new/lost, min rank). Target switcher: your domain or a competitor.

**Site Audit** — list of audits (date, pages, score, status with progress bar while crawling) + "Run audit" (maxPages selector; show estimated cost = pages × DFS price). Detail route: score gauge, issues grouped by severity with counts, click issue → filtered page table, page drawer with checks + optional Lighthouse fetch.

**AI Visibility** — two columns. Left (DFS): mention counts per engine (ChatGPT, Gemini, Perplexity, …), share of voice vs. competitors, top cited pages. Right (existing `gsc.getAiEngines` + OpenPanel referrer events): traffic from AI engines. Prompt explorer: enter a prompt → which domains get cited.

### 8.4 Settings → DataForSEO tab

Org-scoped (note it in the copy: "shared by all projects in this organization"). Fields: login, password (masked), Save → validates with `appendix/user_data` and shows balance; monthly spend so far; spend cap; "Remove". Below: per-project config block (domain, location, language, devices, SERP depth, rank schedule, backlink schedule, competitors list) — same form the inline gate uses.

### 8.5 Site audit: DFS On-Page vs. porting open-seo's crawler

open-seo crawls itself (`lib/audit/discovery.ts`, `page-analyzer.ts`) and only uses DFS for Lighthouse. Options:

- **v1: DFS On-Page API.** ~300 LOC, no crawler infra, JS rendering available, costs ≈ $0.0001–0.001/page. Chosen.
- **v2 (optional):** port open-seo's crawler into the worker for free unlimited crawls of small sites. The `seo_audit_pages` schema is crawler-agnostic (`checks_json`), so this is a drop-in later.

---

## 9. MCP tools — `packages/mcp/src/tools/seo/`

Mirror the router surface; register in `tools/index.ts` next to the GSC tools. Follow `gsc/overview.ts` conventions (`projectIdSchema(context)`, `withErrorHandling`, `table()` for tabular output, cap series at 180 points).

| Tool | Backs |
|---|---|
| `seo_keyword_ideas`, `seo_keyword_overview`, `seo_serp_preview` | keywords router |
| `seo_gsc_enriched_queries` | the join |
| `seo_tracked_keywords`, `seo_track_keywords`, `seo_rank_history`, `seo_run_rank_check` | tracking |
| `seo_backlinks_summary`, `seo_backlinks_list`, `seo_referring_domains` | backlinks |
| `seo_audit_list`, `seo_audit_issues`, `seo_audit_pages`, `seo_start_audit` | audit |
| `seo_ai_mentions`, `seo_ai_share_of_voice` | ai |
| `seo_status` | settings.getStatus (so an agent can tell the user what's missing) |

Mutating tools (`seo_track_keywords`, `seo_run_rank_check`, `seo_start_audit`) require write scope in `McpAuthContext` and include the estimated cost in their description so "Ask AI" can warn before spending.

---

## 10. Redis caching & cost control

- Cache key: `seo:{orgId}:{endpoint}:{sha1(canonical-json(params))}`; TTLs — Labs/keyword endpoints 24 h, SERP live 6 h, backlinks lists 6 h, Lighthouse 24 h, `user_data` 1 h. Use `cacheable` from `@openpanel/redis`.
- Every DFS response's `cost` is summed via the client `onCost` hook into `DataForSeoConnection.monthlySpendUsd` (Redis `INCRBYFLOAT` + periodic flush to Postgres to avoid write amplification).
- Scheduled jobs check `spendCapUsd` before posting tasks. Interactive calls do not block on the cap but show a banner at 80 %.
- Rank runs use `task_post` (standard priority, ≈ 1/3 the price of `live`) except the ≤10-keyword "check now" path.
- Never call DFS from a request handler without a cache lookup first; never loop over keywords with one call each — always batch (SERP 100/call, Labs 700/call).

---

## 11. Multi-tenancy note

Key is org-level and spend is tracked per org. That is enough for Vero-internal use and for a "bring your own key" offer. If SEO is later sold to customers without their own DFS account, add a `credits` model on top of `monthlySpendUsd` — the `onCost` hook is the single place that would need to debit. Do not build this now.

---

## 12. Environment & config

```
DATAFORSEO_DEFAULT_KEY=        # optional; used when an org has no key (self-host convenience)
SEO_RANK_TASK_PRIORITY=1       # 1 normal, 2 high (2× cost)
SEO_AUDIT_MAX_PAGES_DEFAULT=500
```

Everything else is per-org in Postgres. Reuse `ENCRYPTION_KEY` already required by GSC.

---

## 13. Delivery phases

| Phase | Scope | Est. |
|---|---|---|
| 0 | `packages/dataforseo` ported + tests green; `DataForSeoConnection` + settings tab; `seo.settings.getStatus`; `_tabs` restructure with GSC page as `index`; `SeoGate` | 2 d |
| 1 | Keywords tab (ideas/suggestions/overview/SERP preview) + `gscEnriched` + volume/difficulty columns on the GSC queries table | 2 d |
| 2 | Rank tracking: Prisma models, CH tables + MV, `seoQueue`, rank run + poll jobs, scheduler cron, Rankings tab incl. GSC overlay and GSC seeding | 4–5 d |
| 3 | Backlinks tab + weekly snapshot job | 2 d |
| 4 | Site audit via DFS On-Page: models, jobs, list + detail routes, issue catalogue | 3–4 d |
| 5 | AI visibility tab (DFS + existing GSC AI engines side-by-side) | 2 d |
| 6 | MCP tools for all of the above; spend cap + balance cron; CSV exports | 2 d |

Total ≈ 17–19 working days for a solo build; phases 1, 3, 5 are independent of 2 and 4 and can be reordered.

---

## 14. Testing

- `packages/dataforseo`: port open-seo's vitest suites (envelope parsing, error classification, filter builders, endpoint payloads). Add fixtures for `on_page/*` responses.
- Worker jobs: unit-test with a fake client (`fetchImpl`) — rank run batching, poll backoff, partial-failure bookkeeping, spend-cap skip.
- ClickHouse: extend the existing migration test harness for `NN-add-seo.ts`; assert the `seo_rank_daily` MV yields one row per keyword/device/day.
- tRPC: `gscEnriched` join with and without metrics present; `addFromGsc` dedupe against existing tracked keywords.
- E2E (Playwright, existing setup): SEO tabs render correct gate per `getStatus` combination (4 states), settings key save/validate/remove.

---

## 15. Open questions

1. **Location default** — `2840` (US) like open-seo, or `2376` (Israel) given the target market? Proposal: default from the org's country if OpenPanel has it, else US, always editable.
2. **Hebrew SERPs** — DFS supports `language_code: "he"`; confirm Labs keyword_ideas coverage for Hebrew is adequate before promising volume data for Israeli clients.
3. **Devices default** — `both` doubles rank-check cost. Proposal: default `desktop`, let the user opt into mobile.
4. **Audit crawl of SPA sites** — enable `enable_javascript` (≈ 2× cost) automatically when the project's OpenPanel events show a SPA framework, or always ask? Proposal: checkbox in "Run audit", off by default.
5. **Public share** — should SEO tabs participate in `ShareOverview`/dashboards? Out of scope for v1; note that rank history would be a natural dashboard widget later.
