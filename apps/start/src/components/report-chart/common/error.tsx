import { useAppParams } from '@/hooks/use-app-params';
import { cn } from '@/utils/cn';
import { Link } from '@tanstack/react-router';
import { PencilIcon, ServerCrashIcon } from 'lucide-react';
import { useReportChartContext } from '../context';

/**
 * A failed panel says what failed, inside the panel.
 *
 * NOT a toast. On a dashboard of twelve panels a toast cannot say which one
 * broke, it disappears before anyone reads it, and twelve of them stack. The
 * message belongs where the chart would have been.
 *
 * The message is worth showing because it has already been made presentable on
 * the way here: the panel engine prefixes a query failure with its refId
 * (`Query B: …`) and the telemetry router maps an over-large query to a
 * "narrow the time range" message rather than a bare 500. A user who can see
 * WHICH query failed and why can fix it; "there was an error" sends them to
 * bisect by hand.
 */

/** Long enough for any message we produce, short enough not to fill the panel. */
const MAX_MESSAGE_LENGTH = 300;

function messageOf(error: unknown): string | undefined {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : undefined;

  const trimmed = raw?.trim();

  if (!trimmed) {
    return undefined;
  }

  return trimmed.length > MAX_MESSAGE_LENGTH
    ? `${trimmed.slice(0, MAX_MESSAGE_LENGTH)}…`
    : trimmed;
}

export function ReportChartError({ error }: { error?: unknown }) {
  const { isEditMode, report, reportId } = useReportChartContext();
  const { organizationId, projectId } = useAppParams();
  const message = messageOf(error);

  // Only when we know which report to open AND we are not already in its
  // editor — a link back to the page you are on is noise.
  const editableReportId = isEditMode ? undefined : (report.id ?? reportId);

  return (
    <div
      className={cn(
        'center-center h-full w-full flex-col p-4',
        isEditMode && 'card',
      )}
    >
      <ServerCrashIcon
        strokeWidth={1.2}
        className="mb-4 size-10 animate-pulse text-muted-foreground"
      />
      <div className="font-medium text-muted-foreground text-sm">
        There was an error loading this chart.
      </div>
      {message && (
        <div className="mt-2 max-w-full break-words text-center font-mono text-muted-foreground/80 text-xs">
          {message}
        </div>
      )}
      {editableReportId && organizationId && projectId && (
        <Link
          className="row mt-3 items-center gap-1 font-medium text-muted-foreground text-xs hover:text-foreground"
          to="/$organizationId/$projectId/reports/$reportId"
          params={{
            organizationId,
            projectId,
            reportId: editableReportId,
          }}
        >
          <PencilIcon className="size-3" />
          Edit query
        </Link>
      )}
    </div>
  );
}
