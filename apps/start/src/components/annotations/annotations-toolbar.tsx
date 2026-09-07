import { Button } from '@/components/ui/button';
import { ComboboxAdvanced } from '@/components/ui/combobox-advanced';
import { Tooltiper } from '@/components/ui/tooltip';
import { cn } from '@/utils/cn';
import { BookmarkIcon } from 'lucide-react';

import type { IDashboardAnnotationsState } from './use-dashboard-annotations';

/**
 * Show/hide plus a tag filter, for the dashboard header.
 *
 * Renders nothing when the project has never written an annotation: a control
 * for a feature you are not using is noise, and the empty state is taught by
 * the settings page's curl example rather than by a dead toggle here.
 */
export function AnnotationsToolbar({
  state,
}: {
  state: IDashboardAnnotationsState;
}) {
  const hasAny = state.availableTags.length > 0 || state.annotations.length > 0;

  // `enabled` is checked too, so the control does not disappear the moment
  // someone turns annotations off — that would leave no way to turn them back
  // on.
  if (!hasAny && state.enabled) {
    return null;
  }

  return (
    <div className="flex items-center gap-2">
      <Tooltiper content={state.enabled ? 'Hide annotations' : 'Show annotations'}>
        <Button
          variant={state.enabled ? 'default' : 'outline'}
          size="icon"
          aria-pressed={state.enabled}
          aria-label={
            state.enabled ? 'Hide annotations' : 'Show annotations'
          }
          onClick={() => state.setEnabled(!state.enabled)}
        >
          <BookmarkIcon className={cn('size-4')} />
        </Button>
      </Tooltiper>

      {state.enabled && state.availableTags.length > 0 && (
        <ComboboxAdvanced
          items={state.availableTags.map((tag) => ({ value: tag, label: tag }))}
          value={state.selectedTags}
          onChange={(tags) => state.setSelectedTags(tags as string[])}
          placeholder="All tags"
          className="min-w-[130px]"
          size="sm"
        />
      )}
    </div>
  );
}
