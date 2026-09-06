import { z } from 'zod';

export const seoScheduleSchema = z.enum(['daily', 'weekly', 'manual']);
export type SeoSchedule = z.infer<typeof seoScheduleSchema>;

export const seoDevicesSchema = z.enum(['both', 'desktop', 'mobile']);
export type SeoDevices = z.infer<typeof seoDevicesSchema>;

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/**
 * When a schedule should fire next, counted from `from`. Manual schedules
 * never fire, so they have no next run; the schedulers filter on
 * `schedule != 'manual'` as well, but a null here keeps the row honest.
 */
export function computeNextRunAt(
  schedule: string,
  from: Date = new Date()
): Date | null {
  switch (schedule) {
    case 'daily':
      return new Date(from.getTime() + DAY_MS);
    case 'weekly':
      return new Date(from.getTime() + WEEK_MS);
    default:
      return null;
  }
}

/**
 * The next-run value a schedule change implies. Switching to a scheduled
 * cadence fires on the next scheduler tick (run now, then every period);
 * switching to manual clears the pointer; leaving the schedule alone leaves
 * the pointer alone.
 */
export function nextRunAtForScheduleChange({
  previous,
  next,
  currentNextRunAt,
  now = new Date(),
}: {
  previous: string | null;
  next: string;
  currentNextRunAt: Date | null;
  now?: Date;
}): Date | null {
  if (next === 'manual') {
    return null;
  }
  if (previous === next && currentNextRunAt) {
    return currentNextRunAt;
  }
  return now;
}
