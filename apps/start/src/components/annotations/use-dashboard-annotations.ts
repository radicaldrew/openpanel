import { useTRPC } from '@/integrations/trpc/react';
import { useQuery } from '@tanstack/react-query';
import { parseAsArrayOf, parseAsString, useQueryState } from 'nuqs';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { IChartRange } from '@openpanel/validation';

import type { IAnnotation, ITimeDomain } from './annotation-utils';
import { collectTags, filterByTags } from './annotation-utils';

export type IDashboardAnnotationsState = {
  /** Already tag-filtered, ready to hand to every panel. */
  annotations: IAnnotation[];
  /**
   * The window the panels are drawing, as the SERVER resolved it — same
   * preset, same project timezone, same `getChartStartEndDate` the charts use.
   * `null` until the first response, since re-deriving it in the browser is
   * how a marker ends up a bucket off.
   */
  domain: ITimeDomain | null;
  /** Every tag present before filtering, for the toolbar's picker. */
  availableTags: string[];
  selectedTags: string[];
  setSelectedTags: (tags: string[]) => void;
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  isLoading: boolean;
};

/** Per-dashboard, per-browser. A preference, not shared state. */
const storageKey = (dashboardId: string) => `op:annotations:${dashboardId}`;

function readEnabled(dashboardId: string): boolean {
  if (typeof window === 'undefined') {
    return true;
  }

  try {
    // Default ON: someone who has annotations wants to see them, and the
    // toggle exists for the busy case rather than as an opt-in.
    return window.localStorage.getItem(storageKey(dashboardId)) !== 'off';
  } catch {
    // Private mode, or storage disabled. Showing them is the better default.
    return true;
  }
}

/**
 * The dashboard's annotations: ONE query for the whole page.
 *
 * Deliberately not per panel. A twelve-panel dashboard would otherwise issue
 * twelve identical requests for the same project and window, and every panel
 * would re-request on every range change. The list is small, the panels differ
 * only in which slice of it they draw, and the drawing is pure — so it is
 * fetched once here and passed down.
 *
 * The toggle and the tag filter are part of this rather than of the toolbar so
 * that "what the panels draw" has exactly one source.
 */
export function useDashboardAnnotations({
  projectId,
  dashboardId,
  range,
  startDate,
  endDate,
  enabled: featureEnabled = true,
}: {
  projectId: string;
  dashboardId: string;
  range: IChartRange;
  startDate?: string | null;
  endDate?: string | null;
  enabled?: boolean;
}): IDashboardAnnotationsState {
  const trpc = useTRPC();

  const [storedEnabled, setStoredEnabled] = useLocalToggle(dashboardId);

  const [selectedTags, setSelectedTagsRaw] = useQueryState(
    // In the URL, like the variable values: a link to a dashboard filtered to
    // "incident" should reopen filtered to "incident".
    'annotation_tags',
    // `replace` for the same reason as the variable values: a filter tweak is
    // not a navigation step, but the selection still has to be in the URL so a
    // link to "this dashboard, filtered to incidents" reopens that way.
    parseAsArrayOf(parseAsString).withDefault([]).withOptions({
      history: 'replace',
    }),
  );

  const query = useQuery(
    trpc.annotation.list.queryOptions(
      {
        projectId,
        dashboardId,
        range,
        startDate: startDate ?? null,
        endDate: endDate ?? null,
      },
      { enabled: featureEnabled && storedEnabled },
    ),
  );

  const all = useMemo(
    () => (query.data?.annotations ?? []) as unknown as IAnnotation[],
    [query.data],
  );

  const domain = useMemo(() => {
    if (!query.data?.window) {
      return null;
    }

    return {
      start: new Date(query.data.window.startDate).getTime(),
      end: new Date(query.data.window.endDate).getTime(),
    };
  }, [query.data]);

  const availableTags = useMemo(() => collectTags(all), [all]);

  // Filtered client-side rather than by refetching with a `tags` input: the
  // list is already here, and refetching on every tag click would make the
  // filter feel slower than the chart it filters.
  const annotations = useMemo(
    () => (storedEnabled ? filterByTags(all, selectedTags) : []),
    [all, selectedTags, storedEnabled],
  );

  const setSelectedTags = useCallback(
    (tags: string[]) => {
      setSelectedTagsRaw(tags.length > 0 ? tags : null);
    },
    [setSelectedTagsRaw],
  );

  return {
    annotations,
    domain,
    availableTags,
    selectedTags,
    setSelectedTags,
    enabled: storedEnabled,
    setEnabled: setStoredEnabled,
    isLoading: query.isLoading,
  };
}

/**
 * The show/hide toggle, persisted per dashboard.
 *
 * localStorage rather than the URL: it is a viewing preference, and someone
 * who shares a dashboard link should not silently turn the recipient's
 * annotations off. The tag filter IS in the URL, for the opposite reason —
 * "look at this, filtered to incidents" is a thing you send someone.
 *
 * Read in an effect rather than as a lazy `useState` initialiser because this
 * app server-renders: reading storage during the first render makes the server
 * and the client disagree, which React reports as a hydration mismatch. So the
 * first paint always shows annotations and the stored preference lands
 * immediately after — the wrong order for one frame, but never a mismatch.
 */
function useLocalToggle(
  dashboardId: string,
): [boolean, (next: boolean) => void] {
  const [enabled, setEnabledState] = useState(true);

  useEffect(() => {
    setEnabledState(readEnabled(dashboardId));
  }, [dashboardId]);

  const setEnabled = useCallback(
    (next: boolean) => {
      setEnabledState(next);

      try {
        window.localStorage.setItem(
          storageKey(dashboardId),
          next ? 'on' : 'off',
        );
      } catch {
        // Private mode or storage disabled. The preference is lost on reload,
        // which is not worth telling anyone about.
      }
    },
    [dashboardId],
  );

  return [enabled, setEnabled];
}
