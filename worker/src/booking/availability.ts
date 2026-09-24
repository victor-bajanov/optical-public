import type { Env } from "../env";
import type { CalendarProvider } from "../providers/calendar-provider";
import type { CalendarEvent } from "../providers/types";
import { deriveBusyBlocks } from "../planning/busy-blocks";
import { taskIdOfEvent } from "../calendar-feed/build-busy-ics";
import { loadPinnedTaskIds } from "../db/tasks";
import { loadBookingPage, type BookingPageConfig } from "../db/booking-page";
import { loadBusinessHours, type BusinessHours } from "../db/business-hours";
import { getHomeTz } from "../db/users";
import { listBookings } from "../db/bookings";
import { readMeetingConfig } from "../meetings/config";
import { resolveBookableOverIds } from "./bookable-over";
import { computeBookableSlots, slotStepForDurations, pageWindow, type PageWindow } from "./slots";

/** Hours used when neither the owner nor the instance has a
 *  config_business_hours row (loadBusinessHours returns null).
 *
 *  MUST NOT be null: businessHoursIntervals reads null as "the entire window",
 *  so an unseeded deployment would publish every hour of every day of the
 *  horizon on a public URL. Under-offering is the safe direction — a booker
 *  simply sees fewer times — so fall back to the same weekday span migration
 *  0006 seeds as the instance default. */
const FALLBACK_HOURS: BusinessHours = {
  days: ["mon", "tue", "wed", "thu", "fri"],
  start: "09:00",
  end: "17:00",
};

export interface AvailabilityResult {
  slots: string[];
  config: BookingPageConfig;
  tz: string;
  /** The page these slots are for, and the span it covers. */
  page: number;
  window: PageWindow;
  /** Whether a page after this one exists — `window.hasMore`, surfaced. */
  hasMore: boolean;
}

/** The requested page lies past the owner's reach (`max_horizon_days`, or
 *  one page when unset). Thrown BEFORE any calendar or D1 read: an
 *  unauthenticated caller must not be able to spend a calendar read on a
 *  page that cannot exist. */
export class PageOutOfRangeError extends Error {}

/** Chunks of PINNED tasks, as busy blocks.
 *
 *  deriveBusyBlocks drops EVERY optical chunk, because in the planner a pinned
 *  task re-enters the model as a task pinned in place. The booking page has no
 *  such model, so pinned chunks must be added back or their committed time
 *  would be offered to a booker. Movable chunks stay dropped — that is the
 *  whole point of the feature. */
function pinnedChunkBlocks(events: CalendarEvent[], pinnedTaskIds: Set<string>) {
  return events
    .filter((e) => (e.status ?? "").toLowerCase() !== "cancelled")
    .filter((e) => {
      const taskId = taskIdOfEvent(e);
      return taskId !== null && pinnedTaskIds.has(taskId);
    })
    .map((e) => ({ startUtc: e.start, endUtc: e.end }));
}

/** Bookable slot starts for one duration on one page, plus the config and
 *  timezone the caller needs to render them.
 *
 *  One page is one calendar read and one bookings read, both sized to the
 *  page's window (`pageWindow`) — never to the whole reach. That is what lets
 *  an owner offer a year without the public endpoint reading a year of
 *  calendar per request: a booker who wants day 300 pays for the page holding
 *  it, and only when they ask. Page 0 with no reach set is exactly the single
 *  window this served before paging existed. */
export async function computeAvailability(
  db: D1Database,
  env: Env,
  owner: string,
  cal: CalendarProvider,
  durationMinutes: number,
  now: Date,
  page = 0,
): Promise<AvailabilityResult> {
  const config = await loadBookingPage(db, owner);
  const window = pageWindow(now.getTime(), page, config.horizon_days, config.max_horizon_days);
  if (!window) throw new PageOutOfRangeError(`page ${page} is past the reach`);
  const tz = await getHomeTz(db, owner, env.SCHEDULER_TZ);
  const windowStart = new Date(window.startMs).toISOString();
  const windowEnd = new Date(window.endMs).toISOString();

  const { events } = await cal.fetchEventsInWindow(windowStart, windowEnd, { syncToken: false });

  // Both flags must be on: the per-user flag is what the owner chose, but the
  // ops kill-switch (OWNED_MEETINGS_ENABLED) stops resolves from re-stamping
  // or clearing movable_verdict rows, so a stale ok:true verdict must not keep
  // offering a meeting's slot once the switch is off.
  const meetingConfig = readMeetingConfig(env);
  const bookableOverIds = await resolveBookableOverIds(db, owner, events, {
    enabled: meetingConfig.enabled && config.bookable_over_movable_meetings,
    minNoticeMinutes: meetingConfig.minNoticeMinutes,
    now,
  });

  const busyBlocks = deriveBusyBlocks(events, {
    tz,
    tentativeIsBusy: env.TENTATIVE_IS_BUSY === "true",
    excludeEventIds: bookableOverIds,
  });

  const pinnedTaskIds = await loadPinnedTaskIds(db, owner);
  const bookings = await listBookings(db, owner, windowStart, windowEnd);

  const busy = [
    ...busyBlocks.map((b) => ({ startUtc: b.startUtc, endUtc: b.endUtc })),
    ...pinnedChunkBlocks(events, pinnedTaskIds),
    ...bookings.map((b) => ({ startUtc: b.start_utc, endUtc: b.end_utc })),
  ];

  const hours = config.hours ?? (await loadBusinessHours(db, owner)) ?? FALLBACK_HOURS;
  const slots = computeBookableSlots({
    tz,
    hours,
    nowMs: now.getTime(),
    minNoticeMinutes: config.min_notice_minutes,
    windowStartMs: window.startMs,
    windowEndMs: window.endMs,
    durationMinutes,
    slotStepMinutes: slotStepForDurations(config.durations_minutes),
    bufferBeforeMinutes: config.buffer_minutes.before,
    bufferAfterMinutes: config.buffer_minutes.after,
    busy,
  });

  return { slots, config, tz, page, window, hasMore: window.hasMore };
}
