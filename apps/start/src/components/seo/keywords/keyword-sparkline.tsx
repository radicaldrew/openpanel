import type { MonthlySearch } from './types';

const WIDTH = 72;
const HEIGHT = 20;
const STROKE = 1.5;

/**
 * Twelve months of search volume as a tiny line. Flat or missing data
 * renders as an empty box of the same size so table rows stay aligned.
 */
export function KeywordSparkline({ data }: { data: MonthlySearch[] }) {
  if (data.length < 2) {
    return <div aria-hidden style={{ width: WIDTH, height: HEIGHT }} />;
  }
  const values = data.map((entry) => entry.searchVolume);
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = Math.max(max - min, 1);
  const stepX = WIDTH / (values.length - 1);
  const points = values
    .map((value, index) => {
      const x = index * stepX;
      const y = HEIGHT - STROKE - ((value - min) / span) * (HEIGHT - STROKE * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const first = values[0] ?? 0;
  const last = values.at(-1) ?? 0;
  const trendClass =
    last > first * 1.05
      ? 'stroke-emerald-500'
      : last < first * 0.95
        ? 'stroke-red-500'
        : 'stroke-muted-foreground';
  const firstMonth = data[0];
  const lastMonth = data.at(-1);
  const label = `Search volume ${firstMonth?.year}-${firstMonth?.month} to ${lastMonth?.year}-${lastMonth?.month}`;

  return (
    <svg
      aria-label={label}
      className={trendClass}
      height={HEIGHT}
      role="img"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      width={WIDTH}
    >
      <title>{label}</title>
      <polyline
        fill="none"
        points={points}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={STROKE}
      />
    </svg>
  );
}
