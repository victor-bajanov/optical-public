import type { CalendarEvent } from "../providers/types";
import { markCancelPending, clearCancelPending } from "../db/bookings";

/** True iff the event has at least one counted attendee and every counted
 *  attendee has declined. "Counted" excludes `self` (the organiser's own copy)
 *  and `resource` (room/equipment) attendees, mirroring the `others` filter
 *  in meetings/identify.ts's `isOwnedMovableMeeting` (NOT `isCountable`,
 *  which also excludes declined attendees — mirroring that would disable
 *  this function entirely). A booking-page event always has exactly one
 *  explicit attendee — the booker (see plan finding #2) — but the rule is
 *  written to hold for any attendee shape. */
export function isAllDeclined(event: CalendarEvent): boolean {
  const counted = (event.attendees ?? []).filter((a) => !a.resource && !a.self);
  if (counted.length === 0) return false;
  return counted.every((a) => a.responseStatus === "declined");
}

/** Scan a webhook's changed events for `optical_booking`-tagged (booking-page)
 *  events and stamp or clear the decline grace clock on the matching
 *  `bookings` row.
 *
 *  The tag's value IS the `bookings.id` (booking/route.ts stamps
 *  `{ optical_booking: claim.id }` at claim time — plan finding #2), so no
 *  lookup query is needed here: `markCancelPending`/`clearCancelPending`
 *  already take that id directly, and their own CAS predicates
 *  (`db/bookings.ts`) are the sole source of truth for every reason a stamp
 *  is refused — wrong status, event-id mismatch, a poll booking, or a stamp
 *  already running. This function does not re-derive any of those; it only
 *  decides WHETHER to call stamp vs clear, from the event's own shape:
 *
 *  - all counted attendees declined AND the event hasn't started yet →
 *    `markCancelPending` (idempotent: a repeat delivery of the same decline
 *    is just a CAS no-op, never resets the clock);
 *  - not all-declined → `clearCancelPending` (the fast un-decline abort; a
 *    no-op if no clock was running);
 *  - a Google-cancelled event (`status: "cancelled"`), or an event whose
 *    start has already passed while still declined, is left alone entirely —
 *    no stamp, no clear. (A past-start decline is the sweep's fire-time
 *    re-verify's job, not detection's — Card D.)
 *  - an event with no `optical_booking` tag — including one tagged
 *    `optical_poll_id` instead — is never a booking-page event and is
 *    skipped outright; this is the "ignore non-booking-page events" rule. */
export async function detectBookingDeclines(
  db: D1Database,
  subject: string,
  events: CalendarEvent[],
  now: Date,
): Promise<void> {
  const nowIso = now.toISOString();
  for (const event of events) {
    if (event.status === "cancelled") continue;
    // Defense-in-depth: a poll-booked event never carries `optical_booking`
    // (a different tag, polls/booking.ts:600), so this is normally redundant
    // with the tag check below — but poll bookings are explicitly out of
    // scope, so refuse to act on one even if it somehow carried both tags.
    if (event.extendedProperties?.private?.optical_poll_id !== undefined) continue;
    const bookingId = event.extendedProperties?.private?.optical_booking;
    if (bookingId === undefined) continue;

    if (isAllDeclined(event)) {
      // Fail closed on an unparseable start: Date.parse("") is NaN, and
      // `NaN <= x` is false, so a naive comparison would treat an
      // unverifiable start as "hasn't started yet" and stamp it.
      const startMs = Date.parse(event.start);
      if (!Number.isFinite(startMs) || startMs <= now.getTime()) continue;
      await markCancelPending(db, bookingId, subject, event.id, nowIso);
    } else {
      await clearCancelPending(db, bookingId, subject, event.id, nowIso);
    }
  }
}
