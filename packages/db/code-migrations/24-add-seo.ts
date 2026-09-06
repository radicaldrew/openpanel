import fs from 'node:fs';
import path from 'node:path';
import {
  createMaterializedView,
  createTable,
  runClickhouseMigrationCommands,
} from '../src/clickhouse/migration';
import { getIsCluster } from './helpers';

// SEO time series (SEO.md §5.2). Postgres keeps configuration and the small
// entity tables (tracked keywords, runs, audits); everything high-cardinality
// or append-only lands here, mirroring the GSC split in migration 12.
export function buildSeoMigrationSqls(isClustered: boolean): string[] {
  const replicatedVersion = '1';

  return [
    // One row per keyword × device × check. Append-only: a project can be
    // checked several times a day (scheduled run + "check now"), and every
    // check is worth keeping. The daily view below collapses them for charts.
    ...createTable({
      name: 'seo_rank_snapshots',
      columns: [
        '`project_id` String CODEC(ZSTD(3))',
        '`keyword` String CODEC(ZSTD(3))',
        '`device` LowCardinality(String)',
        '`checked_at` DateTime CODEC(Delta(4), LZ4)',
        '`run_id` String CODEC(ZSTD(3))',
        // NULL = not found within the project's serpDepth.
        '`position` Nullable(UInt16) CODEC(T64, LZ4)',
        '`url` String CODEC(ZSTD(3))',
        '`serp_features` Array(String) CODEC(ZSTD(3))',
        // Top-10 [{domain, position}] for the competitor overlay.
        '`competitors_json` String CODEC(ZSTD(3))',
      ],
      orderBy: ['project_id', 'keyword', 'device', 'checked_at'],
      partitionBy: 'toYYYYMM(checked_at)',
      engine: 'MergeTree()',
      distributionHash: 'cityHash64(project_id)',
      replicatedVersion,
      isClustered,
    }),

    // Cache of Labs keyword_overview per keyword × market. Replaced on every
    // refresh, so the newest fetch wins.
    ...createTable({
      name: 'seo_keyword_metrics',
      columns: [
        '`project_id` String CODEC(ZSTD(3))',
        '`keyword` String CODEC(ZSTD(3))',
        '`location_code` UInt32 CODEC(T64, LZ4)',
        '`language_code` LowCardinality(String)',
        '`search_volume` UInt32 CODEC(T64, LZ4)',
        '`difficulty` UInt8',
        '`cpc` Float32 CODEC(Gorilla, LZ4)',
        '`competition` Float32 CODEC(Gorilla, LZ4)',
        // 12-month search volume array as returned by DFS.
        '`monthly_json` String CODEC(ZSTD(3))',
        '`fetched_at` DateTime DEFAULT now() CODEC(Delta(4), LZ4)',
      ],
      orderBy: ['project_id', 'keyword', 'location_code', 'language_code'],
      engine: 'ReplacingMergeTree(fetched_at)',
      distributionHash: 'cityHash64(project_id)',
      replicatedVersion,
      isClustered,
    }),

    // One row per project × day from backlinks/summary + backlinks/history.
    ...createTable({
      name: 'seo_backlink_snapshots',
      columns: [
        '`project_id` String CODEC(ZSTD(3))',
        '`date` Date CODEC(Delta(2), LZ4)',
        '`backlinks` UInt32 CODEC(T64, LZ4)',
        '`referring_domains` UInt32 CODEC(T64, LZ4)',
        '`referring_ips` UInt32 CODEC(T64, LZ4)',
        '`rank` UInt16 CODEC(T64, LZ4)',
        '`spam_score` UInt8',
        '`new_backlinks` UInt32 CODEC(T64, LZ4)',
        '`lost_backlinks` UInt32 CODEC(T64, LZ4)',
        '`synced_at` DateTime DEFAULT now() CODEC(Delta(4), LZ4)',
      ],
      orderBy: ['project_id', 'date'],
      partitionBy: 'toYYYYMM(date)',
      engine: 'ReplacingMergeTree(synced_at)',
      distributionHash: 'cityHash64(project_id)',
      replicatedVersion,
      isClustered,
    }),

    // Per-page rows of an on_page crawl. Keyed by audit so two audits of the
    // same site never collide, and old audits can be dropped by audit_id.
    ...createTable({
      name: 'seo_audit_pages',
      columns: [
        '`project_id` String CODEC(ZSTD(3))',
        '`audit_id` String CODEC(ZSTD(3))',
        '`url` String CODEC(ZSTD(3))',
        '`status_code` UInt16 CODEC(T64, LZ4)',
        '`onpage_score` Float32 CODEC(Gorilla, LZ4)',
        '`title` String CODEC(ZSTD(3))',
        '`meta_description` String CODEC(ZSTD(3))',
        '`h1` String CODEC(ZSTD(3))',
        '`word_count` UInt32 CODEC(T64, LZ4)',
        '`load_time_ms` UInt32 CODEC(T64, LZ4)',
        '`size_bytes` UInt32 CODEC(T64, LZ4)',
        '`internal_links` UInt16 CODEC(T64, LZ4)',
        '`external_links` UInt16 CODEC(T64, LZ4)',
        '`is_indexable` UInt8',
        '`canonical` String CODEC(ZSTD(3))',
        // DFS per-page `checks` object, verbatim.
        '`checks_json` String CODEC(ZSTD(3))',
      ],
      orderBy: ['project_id', 'audit_id', 'url'],
      engine: 'MergeTree()',
      distributionHash: 'cityHash64(project_id)',
      replicatedVersion,
      isClustered,
    }),

    // Daily rollup of seo_rank_snapshots for the trend chart and the GSC join
    // (SEO.md §8.2: LEFT JOIN gsc_queries_daily ON project_id, query=keyword,
    // date). Same key shape as gsc_queries_daily so that join stays trivial.
    //
    // AggregatingMergeTree with SimpleAggregateFunction columns rather than a
    // ReplacingMergeTree: each insert block only sees its own rows, so a
    // Replacing engine would keep whichever check batch arrived last, not the
    // best of the day. SimpleAggregateFunction merges across blocks AND reads
    // as a plain column — `SELECT best_position FROM seo_rank_daily FINAL`
    // gives a Nullable(UInt16), no -Merge functions needed. `min` ignores
    // NULLs, so a keyword that was in range on one check and out on another
    // still reports its ranked position. `url` is from the latest check of
    // the day (anyLast), which is what the chart shows alongside the trend.
    ...createMaterializedView({
      name: 'seo_rank_daily',
      tableName: 'seo_rank_snapshots',
      engine: 'AggregatingMergeTree()',
      orderBy: ['project_id', 'keyword', 'device', 'date'],
      partitionBy: 'toYYYYMM(date)',
      query: `SELECT
        project_id,
        keyword,
        device,
        toDate(checked_at) AS date,
        minSimpleState(position) AS best_position,
        anyLastSimpleState(url) AS url
      FROM {seo_rank_snapshots}
      GROUP BY project_id, keyword, device, date`,
      distributionHash: 'cityHash64(project_id)',
      replicatedVersion,
      isClustered,
      populate: false,
    }),
  ];
}

export async function up() {
  const isClustered = getIsCluster();
  const sqls = buildSeoMigrationSqls(isClustered);

  fs.writeFileSync(
    path.join(import.meta.filename.replace('.ts', '.sql')),
    sqls
      .map((sql) =>
        sql
          .trim()
          .replace(/;$/, '')
          .replace(/\n{2,}/g, '\n')
          .concat(';')
      )
      .join('\n\n---\n\n')
  );

  if (!process.argv.includes('--dry')) {
    await runClickhouseMigrationCommands(sqls);
  }
}
