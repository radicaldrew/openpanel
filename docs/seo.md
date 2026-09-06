# The SEO module — DataForSEO on top of Search Console

Search Console already told a project what Google showed it. This module adds
what it does not: keyword volume and difficulty, tracked rankings, backlinks,
a site crawl and visibility in AI answers. All of that comes from DataForSEO
(DFS), which bills per call, so most of the design below is about paying once
and remembering the answer.

Nothing DFS-backed runs unless an organization has a key (Settings →
DataForSEO) or the deployment sets `DATAFORSEO_DEFAULT_KEY`. Search Console
keeps working without either.

## Where things live

```
packages/dataforseo/            typed client: transport, envelope parsing, one file per DFS section
packages/db/src/seo/            services: config, keys, spend, cache, tracking, rank runs, audits, backlinks, keywords, ai
packages/trpc/src/routers/seo/  settings · keywords · tracking · backlinks · audit · ai  (+ errors.ts)
apps/worker/src/jobs/seo.*.ts   the `seo` queue dispatcher, one file per job family, seo.cron.ts for the cron jobs
apps/start/…/seo._tabs.*.tsx    one route per tab; components under components/seo/<tab>/
packages/mcp/src/tools/seo/     the same services exposed as MCP tools
```

The rule that keeps this honest: **no route, router or job calls
api.dataforseo.com directly**. Everything goes through
`packages/dataforseo`, and everything in a request handler goes through
`withSeoCache` first. Scheduled work lives in the worker.

Every DFS client is built by `getDfsClientForOrganization` /
`getDfsClientForProject` in `packages/db/src/seo/client.ts`: the org's key is
decrypted (same `ENCRYPTION_KEY` and `encryption.ts` as Search Console
tokens), or the env default is used, or `DfsNotConfiguredError` is thrown.
The client carries an `onCost` hook; that hook is the whole spend story
(below).

## The three databases

**Postgres** holds configuration and the small entity tables.

| table | one row per | notes |
|---|---|---|
| `dataforseo_connections` | organization | encrypted `login:password`, cached balance, `monthlySpendUsd`, optional `spendCapUsd` |
| `seo_project_configs` | project | domain, DFS location/language, devices, SERP depth, rank/backlink schedules and their `…NextRunAt` pointers, competitors |
| `seo_tracked_keywords` | project × keyword | normalized spelling (trim, collapse spaces, lowercase); volume/difficulty/cpc copied from the metrics table |
| `seo_rank_runs` | rank check run | `keywordsTotal`/`keywordsChecked` count keyword × device checks once the run starts; `costUsd`; `error` doubles as a warning on completed runs |
| `seo_audits` | crawl | `dfsTaskId`, `maxPages`, `score`, `summary` JSON holds `{ options, dfs }`, `costUsd` |

**ClickHouse** holds the time series (`code-migrations/24-add-seo.ts`).

| table | engine | what |
|---|---|---|
| `seo_rank_snapshots` | MergeTree, partition by month | one row per keyword × device × check, `position` NULL = not in the top `serpDepth`, `competitors_json` = top-10 organic domains |
| `seo_rank_daily` | materialized view, AggregatingMergeTree | daily rollup of the above with `SimpleAggregateFunction` columns, so `best_position` / `url` read as plain values with `FINAL`. A Replacing engine would keep the *last* check of a day, not the best |
| `seo_keyword_metrics` | ReplacingMergeTree(fetched_at) | Labs keyword_overview cache; `-1` stores "DFS returned nothing" so a real 0 stays distinct |
| `seo_backlink_snapshots` | ReplacingMergeTree(synced_at) | one row per project × day from backlinks/summary + backlinks/history |
| `seo_audit_pages` | MergeTree | one row per crawled page per audit, `checks_json` is the DFS checks object with the page-level booleans merged in |

**Redis** holds two kinds of key:

- `seo:spend:{orgId}` — an `INCRBYFLOAT` counter of unflushed spend.
- `seo:{orgId}:{endpoint}:{sha1(canonical-json(params))}` — cached DFS
  responses (`seo/cache.ts`). Only the `data` half of a response is cached;
  billing belongs to the call that paid.

## Queue and cron

One BullMQ queue, `seo`, dispatched by `apps/worker/src/jobs/seo.ts`:

| payload | file | what it does |
|---|---|---|
| `seoRankRun` | `seo.rank.ts` | posts SERP tasks for a run (or runs live for 10 keywords or fewer) |
| `seoRankTaskPoll` | `seo.rank.ts` | collects finished tasks, re-enqueues itself |
| `seoBacklinkSnapshot` | `seo.backlinks.ts` | summary + 30-day history → `seo_backlink_snapshots` |
| `seoAuditStart` / `seoAuditPoll` | `seo.audit.ts` | on_page task_post, then summary polling and page import |
| `seoKeywordMetrics` | `seo.metrics.ts` | `fetchAndStoreKeywordMetrics` for a keyword list |

Cron jobs (`boot-cron.ts`, handlers in `seo.cron.ts`):

| job | schedule | what |
|---|---|---|
| `seoRankScheduler` | every 15 min | flushes spend, then claims every config whose `rankNextRunAt` is due with a conditional `updateMany` (the concurrency guard), creates a `SeoRankRun` and enqueues it. Advances the pointer by a day or a week |
| `seoBacklinkScheduler` | daily 03:30 | same for `backlinkNextRunAt`, enqueues `seoBacklinkSnapshot` |
| `seoSpendReset` | 1st of month 00:00 | flushes spend, then zeroes every `monthlySpendUsd` |
| `seoBalanceRefresh` | daily 04:00 | `appendix/user_data` per org → `balanceUsd`; a bad key lands in `lastError` |
| `seoMetricsRefresh` | Monday 05:00 | one `seoKeywordMetrics` job per project with active tracked keywords (jobId per project + ISO week, so a re-run stacks nothing); skips orgs without a key or over the cap |

Search Console's own `gscSync` still runs daily at 03:00.

### A rank run, end to end

`createRankRun` (manual) or the scheduler creates a `pending` row; one active
run per project. The job then:

1. refuses if the config has no domain, there are no active keywords, or the
   spend cap is reached (`error = 'spend cap reached'`);
2. builds keyword × device checks and marks the run `running` with that
   count;
3. **10 keywords or fewer**: `serp/google/organic/live/advanced` per check,
   synchronously, result written and run completed in the same job;
4. **otherwise**: `task_post` in batches of 100 with
   `priority = SEO_RANK_TASK_PRIORITY`, no postback URL, then a
   `seoRankTaskPoll` at 60 s. The poll reads `tasks_ready`, maps each task
   back through its `keywordId:device` tag, collects with
   `task_get/advanced`, inserts snapshots, and re-enqueues the remainder at
   60 → 120 → 300 s, doubling after that, capped at 30 min. Two hours after
   `startedAt` the run is failed with whatever was collected.

Rejected task_post entries and failed `task_get`s count as checked, and the
first failure message becomes the completed run's `error`, so a run never
hangs on one bad keyword.

### An audit, end to end

`createAudit` enforces one active audit per project and the spend cap, then
`seoAuditStart` posts `on_page/task_post` for the config domain with
`max_crawl_pages`, records the task id and its cost, and schedules the first
poll at 30 s. The poll reads `on_page/summary/{id}`; backoff is keyed on crawl
age (30 s for two minutes, then 60 s, 120 s, 300 s) with a 3-hour deadline.
When `crawl_progress` is `finished`, pages are imported 1000 per call (resource
items dropped, hard ceiling 100 000 items) and the audit is completed with the
DFS summary stored under `summary.dfs`.

**There is no DFS cancel.** `cancelAudit` flips the row to `failed` /
`cancelled`; the next poll sees a non-crawling status and stops. DFS finishes
the crawl anyway and the task_post charge stands.

## Spend

DFS returns a `cost` on every envelope. The flow is:

```
transport onCost(path, costUsd)
  └─ recordDfsSpend(orgId, cost)       INCRBYFLOAT seo:spend:{orgId}   (skipped when cost is 0)
        └─ flushSpendToPostgres()      read counter → monthlySpendUsd += amount → INCRBYFLOAT −amount
              (rank scheduler tick, every 15 min; and seoSpendReset)
```

The flush subtracts exactly what it read rather than deleting the key, so
cost recorded mid-flush survives. An org on `DATAFORSEO_DEFAULT_KEY` has no
connection row, so its counter has nowhere to go and is dropped at flush time
— and it has no cap.

`isDfsSpendCapReached(orgId)` compares `monthlySpendUsd` **plus the pending
Redis counter** with `spendCapUsd`. Who honours it:

| path | behaviour |
|---|---|
| scheduled (rank scheduler, backlink scheduler, `seoRankRun`, `seoAuditStart`, `seoBacklinkSnapshot` jobs) | checked before anything is posted; a capped rank run or audit leaves a `failed` row with `error = 'spend cap reached'` so the UI can say why |
| manual (`runNow`, `audit.start`, `backlinks.snapshotNow`) | same check at creation time; the router returns a discriminated `{ ok: false, reason: 'spend_cap' }` (tracking, backlinks) or a `PRECONDITION_FAILED` with the `DFS_SPEND_CAP:` prefix (audit) |
| interactive (keyword research, SERP preview, backlink lists, AI mentions, Lighthouse) | never blocked; they hit the cache first and the settings page shows spend against the cap |

The settings page's "spent this month" number is `monthlySpendUsd` plus the
pending counter (`getSeoStatus`), so it does not lag the flush.

## Cache keys and TTLs

`withSeoCache({ organizationId, endpoint, params, ttl }, loader)` in
`seo/cache.ts`. TTLs (`SEO_CACHE_TTL_SECONDS`):

| ttl key | seconds | used by |
|---|---|---|
| `labs` | 24 h | keyword ideas / suggestions / related / ranked_keywords |
| `serpLive` | 6 h | SERP preview |
| `backlinks` | 6 h | backlink lists, competitor overviews, the own-domain snapshot refresh (keyed per project and calendar day) |
| `lighthouse` | 24 h | on_page/lighthouse |
| `userData` | 1 h | appendix/user_data |
| `serpLocations` | 30 d | location lists |
| `aiSearch` | 24 h | every llm_mentions endpoint |

Two things are cached by other means: keyword overview uses
`seo_keyword_metrics` itself (rows younger than the Labs TTL are served
without a call; the weekly `seoMetricsRefresh` cron keeps tracked keywords'
numbers current), and Lighthouse only accepts URLs on the project's domain or
a subdomain of it.

## Error codes

`packages/trpc/src/routers/seo/errors.ts` wraps every DFS-touching resolver
with `withSeoErrors`. The client cannot read a TRPC `cause`, so the machine
code is also the message prefix (`CODE: human text`):

| condition | TRPC code | prefix |
|---|---|---|
| `DfsNotConfiguredError` | `PRECONDITION_FAILED` | `DFS_NOT_CONFIGURED` |
| `SeoConfigMissingError` (no domain yet) | `PRECONDITION_FAILED` | `SEO_CONFIG_MISSING` |
| DFS `kind: 'billing'` or status 40200/40201 | `PRECONDITION_FAILED` | `DFS_NO_BALANCE` |
| DFS `kind: 'auth'` | `UNAUTHORIZED` | `DFS_INVALID_CREDENTIALS` |
| DFS `kind: 'rate_limited'` | `TOO_MANY_REQUESTS` | — |
| DFS `kind: 'timeout' \| 'upstream'` | `BAD_GATEWAY` | — |
| any other `DataForSeoError` | `BAD_REQUEST` | — |

The audit router adds `DFS_SPEND_CAP` (`PRECONDITION_FAILED`) and `CONFLICT`
for "an audit is already running". Tracking and backlinks prefer discriminated
results (`{ ok: false, reason }`) over throwing for the expected refusals.
`SeoGate` in the dashboard maps the prefixes to its empty states.

## Ops checklist

1. `pnpm migrate:deploy` — applies the Prisma migration
   `20260906120000_add_seo` (five tables) and then the ClickHouse code
   migration `24-add-seo` (four tables + the `seo_rank_daily` view; clustered
   deployments get the replicated/distributed pair like the GSC tables).
2. `ENCRYPTION_KEY` — 64-char hex, already required for Search Console. DFS
   keys are encrypted with it; rotating it invalidates stored keys.
3. `DATAFORSEO_DEFAULT_KEY` — optional. Used when an org has no key. Accepts
   the DFS base64 form or raw `login:password`. Orgs on it have no spend cap.
4. `SEO_RANK_TASK_PRIORITY` — `1` (default) or `2`. Priority 2 doubles the
   task_post price for faster turnaround.
5. `SEO_AUDIT_MAX_PAGES_DEFAULT` — default for the "Maximum pages" selector,
   clamped to 10–10 000, falls back to 500.
6. The worker must run the `seo` queue (it is in the default `ENABLED_QUEUES`
   set) and the cron queue.
7. Bull Board shows the `seo` queue; a stuck rank run is one whose poll jobs
   stopped re-enqueueing — the 2 h deadline fails it on the next tick that
   does fire.

## Known limitations

- **No DFS cancel for audits.** Cancelling stops our polling; the crawl and
  its charge continue on DFS's side.
- **Competitor data is never persisted.** Backlink overviews, histories and
  AI share of voice for competitors are live calls behind the cache; only
  the project's own domain gets snapshots.
- **A caller-supplied domain must be the tracked domain or a configured
  competitor** (ranked keywords, backlinks, AI mentions, Lighthouse URL).
  This is deliberate: it keeps one project from spending the org's budget
  on arbitrary sites.
- **Search Console has no AI-referral data.** SEO.md assumed a GSC half for
  the AI Visibility tab; the "traffic from AI answers" column is OpenPanel's
  own sessions matched on referrer name (`seo/ai.ts`), which is also what the
  older `gsc.getAiEngines` procedure had always queried.
- **ChatGPT mention data is US/English only** (DFS constraint); Google AI
  follows the project market. Those are the two engines DFS knows.
- **The root vitest config needs Docker.** `test/global-setup.ts` truncates a
  live Postgres, so run the SEO suites per package:
  `cd packages/db && npx vitest run src/seo`,
  `cd apps/worker && npx vitest run src/jobs/seo`,
  `cd packages/trpc && npx vitest run src/routers/seo`,
  `cd packages/mcp && npx vitest run src/tools/seo`,
  `cd apps/start && pnpm test` (the gate tests; the script sets `NITRO=1` so
  the Cloudflare Vite plugin is skipped inside vitest).
- **Prices in the UI are estimates.** The audit dialog's "estimated cost" uses
  `AUDIT_PRICE_PER_PAGE_USD` (× 4 with JavaScript rendering); what DFS bills
  is what lands in `costUsd`.
