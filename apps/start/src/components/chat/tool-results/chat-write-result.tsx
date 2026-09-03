import { Button } from '@/components/ui/button';
import { pushModal } from '@/modals';
import type { IReport } from '@openpanel/validation';
import { LayoutPanelTopIcon, SaveIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { ResultCard, ToolStateGuard } from './shared';
import type { ToolResultProps } from './types';

/**
 * Renderers for the two write-intent tools, `save_report` and
 * `create_dashboard`.
 *
 * Neither one wrote anything. Both are client tools whose handler opens the
 * ordinary dialog and returns immediately (see `tool-handlers.ts`), so the
 * card has to say what was PROPOSED and who has to act, not report a result —
 * without this they fell through to `DefaultToolResult`, which renders a
 * "Done — Save report" chip over a collapsed JSON blob. "Done" is the one
 * thing that is not true yet.
 *
 * The button matters as much as the wording. A dialog the user dismissed (or
 * that opened while they were scrolled up the conversation) is otherwise
 * unrecoverable: the model has already moved on and calling the tool again
 * costs a turn. Re-opening from the card is free and lands on exactly the
 * config the model proposed, because it reads the tool's own input.
 */

export function ChatSaveReportResult({ part }: ToolResultProps) {
  const input = (part.input ?? {}) as {
    name?: string;
    report?: Record<string, unknown>;
  };

  return (
    <ToolStateGuard
      state={part.state}
      errorText={part.errorText}
      toolName="save_report"
    >
      <WriteIntentCard
        title="Save to a dashboard"
        name={input.name}
        action={
          input.report ? (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-sm"
              onClick={() =>
                pushModal('SaveReport', {
                  // Mirrors the handler: `series` is a floor the model's own
                  // value overrides, and the proposed name prefills the field.
                  report: {
                    series: [],
                    ...input.report,
                    name: input.name,
                  } as unknown as IReport,
                  disableRedirect: true,
                })
              }
            >
              <SaveIcon className="size-3 mr-1" />
              Open again
            </Button>
          ) : null
        }
      >
        Pick a dashboard and hit <strong>Save</strong> — nothing is saved until
        you do.
      </WriteIntentCard>
    </ToolStateGuard>
  );
}

export function ChatCreateDashboardResult({ part }: ToolResultProps) {
  const input = (part.input ?? {}) as { name?: string };

  return (
    <ToolStateGuard
      state={part.state}
      errorText={part.errorText}
      toolName="create_dashboard"
    >
      <WriteIntentCard
        title="New dashboard"
        name={input.name}
        action={
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-sm"
            onClick={() => pushModal('AddDashboard')}
          >
            <LayoutPanelTopIcon className="size-3 mr-1" />
            Open again
          </Button>
        }
      >
        {/* The AddDashboard modal takes no props, so the name is a suggestion
            to type rather than something we can prefill. */}
        Type the name and hit <strong>Create</strong> — nothing exists until you
        do.
      </WriteIntentCard>
    </ToolStateGuard>
  );
}

function WriteIntentCard({
  title,
  name,
  action,
  children,
}: {
  title: string;
  name?: string;
  action: ReactNode;
  children: ReactNode;
}) {
  return (
    <ResultCard title={title}>
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <div className="min-w-0">
          {name && (
            <div className="truncate font-medium text-sm">{name}</div>
          )}
          <div className="text-sm text-muted-foreground">{children}</div>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
    </ResultCard>
  );
}
