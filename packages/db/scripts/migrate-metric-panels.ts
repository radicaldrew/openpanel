/**
 * One-off: rewrite legacy single-query metric reports onto `metricQueries`.
 *
 *   pnpm --filter @openpanel/db migrate:metric-panels            # dry run
 *   pnpm --filter @openpanel/db migrate:metric-panels -- --apply # writes
 *
 * A dry run is the default posture: it prints the before and after for every
 * affected report and writes nothing. Read the output, then re-run with
 * `--apply`. (`--dry-run` is accepted too, for the person who types it out of
 * habit.)
 *
 * WHY A SCRIPT RATHER THAN A LAZY READ-TIME CONVERSION
 *
 * The engine already falls back to `metricQuery` when `metricQueries` is
 * empty, so nothing is broken while this has not run. What the fallback cannot
 * do is let someone EDIT an old panel: the new editor writes the new column,
 * and a panel that opens as a builder state has to have one. Converting the
 * rows once, visibly, is also what lets `metricQuery` be dropped later.
 *
 * The conversion is not always faithful, and where it is not it says so:
 *  - `fn: 'raw'` on a counter or a histogram is the sawtooth this whole build
 *    exists to fix. Those get a `rate` prepended and are reported as
 *    auto-converted, because reproducing the broken chart exactly would be
 *    migrating a bug forward.
 *  - a percentile aggregation on a metric that is not a `_bucket` series never
 *    rendered at all — the legacy compiler threw on it. Those are skipped
 *    rather than guessed at, and keep their `metricQuery`, so nothing about
 *    them changes.
 */
import {
  compileBuilder,
  inferMetricKind,
  inferPromqlUnit,
} from '@openpanel/common';
import type {
  IBuilderOp,
  IMetricQuery,
  IPanelQuery,
  IPromqlBuilderState,
  IPromqlUnit,
} from '@openpanel/validation';

type IMatcherOp = IPromqlBuilderState['labelMatchers'][number]['op'];

/** The legacy matcher vocabulary, in PromQL's. */
const MATCHER_OPS = {
  eq: '=',
  neq: '!=',
  match: '=~',
  notMatch: '!~',
} as const satisfies Record<string, IMatcherOp>;

const QUANTILES: Record<string, number | undefined> = {
  p50: 0.5,
  p90: 0.9,
  p95: 0.95,
  p99: 0.99,
};

/**
 * What the legacy compiler used when a query carried no window.
 *
 * Kept rather than switching to `$__rate_interval` so a migrated panel draws
 * the same chart it drew yesterday. The better default belongs to queries
 * authored from here on, not to a silent rewrite of existing ones.
 */
const LEGACY_DEFAULT_WINDOW = '5m';

/**
 * The report's free-string display `unit`, in the panel enum.
 *
 * A legacy metric report carries `unit` on the REPORT (`inferMetricUnit`'s
 * vocabulary: 's', 'ms', 'bytes', '%'). After migration the renderer prefers
 * the per-series `panel.unit` over the report's, so dropping this would
 * silently restyle a chart someone had already set up — a report saved as a
 * percentage would render as a bare number.
 *
 * `'%'` maps to `percentunit`, NOT `percent`. The legacy formatter multiplies a
 * `'%'` value by 100, so the stored number is a 0–1 ratio, which is exactly
 * what `percentunit` means. Mapping it to `percent` would render every value
 * 100× too small.
 */
const LEGACY_UNITS: Record<string, IPromqlUnit | undefined> = {
  '%': 'percentunit',
  s: 'seconds',
  ms: 'ms',
  bytes: 'bytes',
};

function panelUnitFor(
  metric: string,
  reportUnit: string | null | undefined,
): IPromqlUnit {
  const explicit = reportUnit ? LEGACY_UNITS[reportUnit.trim()] : undefined;

  // The name is only consulted when the report did not state a unit: a unit
  // someone chose beats one inferred from a suffix.
  return explicit ?? inferPromqlUnit(metric);
}

export type IPanelMigration =
  | { status: 'migrated'; query: IPanelQuery; notices: string[] }
  | { status: 'skipped'; reason: string };

/**
 * Map one legacy `metricQuery` onto a single panel query.
 *
 * Pure, and exported for the test beside this file: the mapping is the part
 * that has to be right, and it should be checkable without a database.
 */
export function migrateMetricQuery(
  query: IMetricQuery,
  /** The report's own display unit, which takes precedence over the metric name. */
  reportUnit?: string | null,
): IPanelMigration {
  const metric = query.metric;
  const kind = inferMetricKind(metric);
  const fn = query.fn ?? 'rate';
  const aggregation = query.aggregation ?? 'sum';
  const groupBy = query.groupBy ?? [];
  const window = query.window ?? LEGACY_DEFAULT_WINDOW;
  const notices: string[] = [];

  const labelMatchers = (query.matchers ?? []).map((matcher) => ({
    label: matcher.name,
    op: MATCHER_OPS[matcher.operator],
    value: matcher.value,
  }));

  const quantile = QUANTILES[aggregation];
  let operations: IBuilderOp[];

  if (quantile !== undefined) {
    // The legacy compiler REFUSED this combination, so the report has never
    // rendered. Converting it would invent a chart nobody has seen.
    if (!metric.endsWith('_bucket')) {
      return {
        status: 'skipped',
        reason: `${aggregation} on "${metric}", which is not a _bucket series — this report never rendered (the legacy compiler rejected it)`,
      };
    }

    // The legacy percentile branch always rated, whatever `fn` said.
    if (fn !== 'rate') {
      notices.push(
        `fn "${fn}" was ignored by the legacy percentile path; kept as rate`,
      );
    }

    operations = [
      { op: 'rate', range: window },
      { op: 'sum', by: [...new Set(['le', ...groupBy])] },
      { op: 'histogram_quantile', q: quantile },
    ];
  } else {
    operations = [];

    if (fn === 'raw') {
      // A bare counter only ever climbs, and summing raw histogram buckets is
      // the sawtooth. Both are the bug, not a preference.
      if (kind === 'counter' || kind === 'histogram') {
        operations.push({ op: 'rate', range: '$__rate_interval' });
        notices.push(
          `auto-converted: raw ${kind} "${metric}" now goes through rate($__rate_interval)`,
        );
      }
    } else {
      operations.push({ op: fn, range: window });
    }

    operations.push({
      op: aggregation as 'sum' | 'avg' | 'min' | 'max' | 'count',
      ...(groupBy.length > 0 ? { by: groupBy } : {}),
    });
  }

  const builder: IPromqlBuilderState = {
    metric,
    labelMatchers,
    operations,
  };

  let expr: string;
  try {
    expr = compileBuilder(builder);
  } catch (error) {
    return {
      status: 'skipped',
      reason: `could not compile: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (expr === '') {
    return { status: 'skipped', reason: 'compiled to an empty expression' };
  }

  return {
    status: 'migrated',
    query: {
      refId: 'A',
      expr,
      mode: 'builder',
      builder,
      hidden: false,
      unit: panelUnitFor(metric, reportUnit),
      yAxis: 'left',
      instant: false,
    },
    notices,
  };
}

async function main() {
  // Imported inside `main` rather than at the top so the mapping above can be
  // unit tested without opening a database connection.
  const { db } = await import('../src/prisma-client');

  // `--dry-run` wins when both are given. Someone being careful and typing
  // both means the cautious one; letting `--apply` win would hand them the
  // exact opposite of what they asked for.
  const explicitDryRun = process.argv.includes('--dry-run');
  const apply = process.argv.includes('--apply') && !explicitDryRun;
  const dryRun = !apply;

  if (explicitDryRun && process.argv.includes('--apply')) {
    console.log('--dry-run and --apply were both given; treating this as a dry run.\n');
  }

  const reports = await db.report.findMany({
    where: { dataSource: 'metrics' },
    select: {
      id: true,
      name: true,
      projectId: true,
      unit: true,
      metricQuery: true,
      metricQueries: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  const legacyReports = reports.filter((report) => report.metricQuery);

  console.log(
    `${legacyReports.length} metric report(s) with a legacy query${
      dryRun ? ' — DRY RUN, nothing will be written' : ''
    }`,
  );
  console.log('');

  let migrated = 0;
  let skipped = 0;
  let alreadyDone = 0;

  for (const report of legacyReports) {
    const legacy = report.metricQuery;

    if (!legacy) {
      continue;
    }

    // Already converted by a previous run, or authored in the new editor and
    // still carrying its old query. Either way it is not ours to overwrite.
    if (report.metricQueries.length > 0) {
      alreadyDone++;
      console.log(
        `- ${report.name} (${report.id}): already has panel queries, left alone`,
      );
      continue;
    }

    const result = migrateMetricQuery(legacy, report.unit);

    console.log(`- ${report.name} (${report.id})`);
    console.log(`    before: ${JSON.stringify(legacy)}`);

    if (result.status === 'skipped') {
      skipped++;
      console.log(`    SKIPPED: ${result.reason}`);
      console.log('');
      continue;
    }

    console.log(`    after:  ${result.query.expr}`);
    console.log(`    unit:   ${result.query.unit}`);
    for (const notice of result.notices) {
      console.log(`    NOTE:   ${notice}`);
    }
    console.log('');

    if (apply) {
      await db.report.update({
        where: { id: report.id },
        data: { metricQueries: [result.query] },
      });
    }

    migrated++;
  }

  console.log('');
  console.log(
    `${migrated} migrated, ${skipped} skipped, ${alreadyDone} already had panel queries.`,
  );

  if (dryRun) {
    console.log('Dry run: nothing was written. Re-run with --apply to write.');
  }

  await db.$disconnect();
}

// Only run the CLI when this file is the entry point, so importing the mapping
// from the test beside it neither opens a connection nor migrates anything.
const invokedDirectly =
  process.argv[1]?.endsWith('migrate-metric-panels.ts') ?? false;

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
