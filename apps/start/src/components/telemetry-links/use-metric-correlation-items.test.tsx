// @vitest-environment jsdom
/**
 * Where the clicked series' service comes from, and what the menu item then
 * navigates to.
 *
 * The single source for it is the click PAYLOAD, which is by construction from
 * the render that was clicked. There used to be a `chart` prop to fall back on;
 * it was removed because a second source of the same fact is how the two drift,
 * and because a dashboard panel never had a chart to look in — which is how
 * this shipped broken once, resolving every dashboard click to `$service`
 * regardless of which line was under the cursor.
 *
 * Run with: cd apps/start && NITRO=1 npx vitest run src/components/telemetry-links
 */
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}));

const { useMetricCorrelationItems } = await import(
  './use-metric-correlation-items'
);

const project = { organizationId: 'org_1', projectId: 'proj_1' };

function itemsFor(
  options: Parameters<typeof useMetricCorrelationItems>[0],
  context: Parameters<ReturnType<typeof useMetricCorrelationItems>>[0],
) {
  const { result } = renderHook(() => useMetricCorrelationItems(options));
  return result.current(context);
}

/** The search params of the link the first menu item navigates to. */
function logsSearch(
  options: Parameters<typeof useMetricCorrelationItems>[0],
  context: Parameters<ReturnType<typeof useMetricCorrelationItems>>[0],
) {
  const items = itemsFor(options, context);
  items[0]?.onClick();
  return navigateMock.mock.calls.at(-1)?.[0]?.search as Record<string, string>;
}

beforeEach(() => {
  navigateMock.mockClear();
});

describe('useMetricCorrelationItems — where the service comes from', () => {
  it('reads the service off the click payload', () => {
    const search = logsSearch(
      { ...project, interval: 'minute' },
      {
        date: '2026-09-07 10:05:00',
        serieId: 'a-http',
        labels: { service_name: 'from-payload' },
      },
    );

    expect(search.service).toBe('from-payload');
  });

  it('gets a service from nowhere else, even given a series id', () => {
    // The regression guard for the removed `chart` fallback: a `serieId` with
    // no labels beside it must resolve NOTHING rather than reaching for some
    // other copy of the series set. If a lookup is ever reintroduced, this
    // fails.
    const search = logsSearch(
      { ...project, interval: 'minute', variables: { service: 'from-variable' } },
      { date: '2026-09-07 10:05:00', serieId: 'a-http' },
    );

    expect(search.service).toBe('from-variable');
  });

  it('uses the dashboard variable only when nothing else names a service', () => {
    const search = logsSearch(
      { ...project, interval: 'minute', variables: { service: 'from-variable' } },
      { date: '2026-09-07 10:05:00' },
    );

    expect(search.service).toBe('from-variable');
  });

  it('sends no service filter when nothing names one', () => {
    // Every service's logs for that minute is a better answer than none.
    const search = logsSearch(
      { ...project, interval: 'minute' },
      { date: '2026-09-07 10:05:00' },
    );

    expect(search).not.toHaveProperty('service');
    expect(search.start).toBe('2026-09-07T10:04:00.000Z');
  });
});

describe('useMetricCorrelationItems — where it navigates', () => {
  const context = {
    date: '2026-09-07 10:05:00',
    serieId: 'a-http',
    labels: { service_name: 'api' },
  };

  it('offers logs and traces, in that order', () => {
    const items = itemsFor({ ...project, interval: 'minute' }, context);

    expect(items.map((item) => item.label)).toEqual([
      'View logs for this range for api',
      'View traces for this range for api',
    ]);
  });

  it('navigates in the same tab, so Back returns to the chart', () => {
    const items = itemsFor({ ...project, interval: 'minute' }, context);
    items[1]?.onClick();

    expect(navigateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: '/$organizationId/$projectId/traces',
        params: project,
      }),
    );
  });

  it('reads the chart bucket as UTC, whatever the viewer’s clock says', () => {
    // `2026-09-07 10:05:00` has no zone marker; read as local time the link
    // lands on the wrong minute, silently, because it is still a window.
    const search = logsSearch({ ...project, interval: 'minute' }, context);

    expect(search.start).toBe('2026-09-07T10:04:00.000Z');
    expect(search.end).toBe('2026-09-07T10:07:00.000Z');
  });

  it('widens with the panel interval', () => {
    const search = logsSearch({ ...project, interval: 'hour' }, context);

    expect(search.start).toBe('2026-09-07T09:05:00.000Z');
    expect(search.end).toBe('2026-09-07T12:05:00.000Z');
  });

  it('offers nothing for a bucket it cannot read', () => {
    // A broken menu item is worse than a missing one.
    expect(
      itemsFor({ ...project, interval: 'minute' }, { date: 'not a date' }),
    ).toEqual([]);
  });
});
