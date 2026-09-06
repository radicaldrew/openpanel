import { scoreClass } from './audit-status';
import { cn } from '@/utils/cn';

const SIZE = 120;
const STROKE = 10;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** On-page score 0-100 as a ring. */
export function AuditScoreGauge({
  score,
  label = 'On-page score',
  className,
}: {
  score: number | null;
  label?: string;
  className?: string;
}) {
  const value = score === null ? 0 : Math.max(0, Math.min(100, score));
  const offset = CIRCUMFERENCE * (1 - value / 100);
  const colorClass = scoreClass(score);

  return (
    <div className={cn('flex flex-col items-center gap-2', className)}>
      <svg
        aria-label={`${label}: ${score === null ? 'not available' : score}`}
        height={SIZE}
        role="img"
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        width={SIZE}
      >
        <title>
          {label}: {score === null ? 'n/a' : score}
        </title>
        <circle
          className="stroke-muted"
          cx={SIZE / 2}
          cy={SIZE / 2}
          fill="none"
          r={RADIUS}
          strokeWidth={STROKE}
        />
        <circle
          className={cn('transition-[stroke-dashoffset] duration-500', colorClass)}
          cx={SIZE / 2}
          cy={SIZE / 2}
          fill="none"
          r={RADIUS}
          stroke="currentColor"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={offset}
          strokeLinecap="round"
          strokeWidth={STROKE}
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
        />
        <text
          className={cn('fill-current font-mono font-semibold', colorClass)}
          dominantBaseline="central"
          fontSize={28}
          textAnchor="middle"
          x="50%"
          y="50%"
        >
          {score === null ? '–' : score}
        </text>
      </svg>
      <span className="text-muted-foreground text-xs">{label}</span>
    </div>
  );
}
