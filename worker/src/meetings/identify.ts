import type { CalendarEvent } from "../providers/types";

/** Task.source.kind value marking a row that mirrors a calendar meeting. The
 *  row's source.external_id holds the Google event id (used by commit to patch
 *  the real event). */
export const MEETING_SOURCE_KIND = "meeting";

type Attendee = NonNullable<CalendarEvent["attendees"]>[number];

function isCountable(a: Attendee): boolean {
  if (a.resource) return false;
  if (a.self) return false;
  if (a.responseStatus === "declined") return false;
  return true;
}

/** A fetched event is an OWNED MOVABLE MEETING iff the signed-in user organises
 *  it AND at least one non-resource attendee other than the organiser exists.
 *  (guestsCanModify — moving someone else's meeting — is deferred.)
 *
 *  An event tagged `extendedProperties.private.optical_poll_id` (booked by the
 *  meeting-poll feature) is NEVER movable, checked before anything else and
 *  regardless of OWNED_MEETINGS_ENABLED: a poll's whole point is that
 *  attendees voted for this specific time, so the resolve loop must not later
 *  relocate it out from under them. */
export function isOwnedMovableMeeting(event: CalendarEvent): boolean {
  if (event.extendedProperties?.private?.optical_poll_id !== undefined) return false;
  if (event.organizer?.self !== true) return false;
  const others = (event.attendees ?? []).filter((a) => !a.resource && !a.self);
  return others.length >= 1;
}

/** Churn multiplier basis: non-resource, non-declined, non-organiser attendees
 *  (optional INCLUDED per review Q4), floored at 1 and capped at `cap`. */
export function attendeeCountForChurn(event: CalendarEvent, cap: number): number {
  const n = (event.attendees ?? []).filter(isCountable).length;
  return Math.min(Math.max(n, 1), cap);
}

export type AttendeeEnforcement = "accepted" | "accepted_or_tentative" | "not_declined";

const ENFORCEMENT_STATUSES: Record<AttendeeEnforcement, ReadonlySet<string>> = {
  accepted: new Set(["accepted"]),
  accepted_or_tentative: new Set(["accepted", "tentative"]),
  not_declined: new Set(["accepted", "tentative", "needsAction"]),
};

/** Availability-mask basis: the non-resource, non-self attendees whose free/busy
 *  constrains where the meeting may be placed, per the effective enforcement
 *  policy. Declined attendees never constrain. Replaces the accepted-only rule
 *  (review 4C) — 'accepted' reproduces it. */
export function constrainingAttendeeEmails(event: CalendarEvent, policy: AttendeeEnforcement): string[] {
  const allowed = ENFORCEMENT_STATUSES[policy];
  return (event.attendees ?? [])
    .filter((a) => !a.resource && !a.self && a.responseStatus !== undefined && allowed.has(a.responseStatus))
    .map((a) => a.email);
}
