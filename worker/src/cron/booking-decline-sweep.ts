// */5 * * * * sweep for the booking-page decline auto-cancel flow (see
// internal design notes, Card D). The webhook side
// (booking/decline-cancel.ts, Card C) stamps `cancel_pending_at` on a
// confirmed booking as soon as it sees the sole attendee decline; this sweep
// re-verifies each due row against the LIVE calendar event (the real
// misclick protection — the stamp alone only proves what was true at
// detection time) and either fires the cancellation or aborts. Rides
// BOOKING_PAGE_ENABLED — see scheduled-entry.ts for the master-switch gate.
import type { Env } from "../env";
import { parseEnvNumberWithFloor } from "../util/env-parse";
import type { CalendarProvider } from "../providers/calendar-provider";
import type { NotificationProvider, PollEmail } from "../providers/notification-provider";
import type { CalendarEvent } from "../providers/types";
import { defaultCalendarProvider, defaultNotificationProvider } from "../index-providers";
import {
  listCancelPendingDue,
  markCancelled,
  clearCancelPending,
  type CancelPendingRow,
} from "../db/bookings";
import { getHomeTz } from "../db/users";
import { isAllDeclined } from "../booking/decline-cancel";
import {
  renderBookingDeclineCancelledEmail,
  renderBookingDeclineCancelledOwnerEmail,
} from "../booking/emails";

const DEFAULT_GRACE_MINUTES = 10;

// Stringly-typed Worker var (env.ts), same idiom as MEETING_MIN_NOTICE_MINUTES
// etc. Two distinct failure shapes, per the plan ("parse with a default of
// 10, clamp to >= 1"): a value that doesn't PARSE (unset, "", non-numeric)
// falls back to the 10-minute default; a value that parses but is < 1
// ("0", a negative number) is a deliberately-too-short override and clamps
// UP to a 1-minute floor instead — it must not silently widen back out to 10.
function graceMinutes(env: Env): number {
  return parseEnvNumberWithFloor(env.BOOKING_DECLINE_GRACE_MINUTES, DEFAULT_GRACE_MINUTES, 1, true);
}

export interface BookingDeclineSweepDeps {
  makeCalendar?: (subject: string) => CalendarProvider | Promise<CalendarProvider>;
  makeNotification?: (subject: string) => NotificationProvider | Promise<NotificationProvider>;
}

export interface BookingDeclineSweepResult {
  checked: number;
  cancelled: number;
  cleared: number;
  closedQuietly: number;
  // A won re-verify (still all-declined, still future) whose OWN markCancelled
  // CAS then lost to something else that closed the row out in between —
  // the one path that deletes a live event with no other observable trace
  // (no email, no status flip performed by this call). Tracked separately
  // from `failed` (nothing threw) so it doesn't get silently absorbed.
  aborted: number;
  // Per-ROW failures only (sweepOneRow itself threw) — a row that was
  // actually attempted (counted in `checked`) and failed.
  failed: number;
  // Provider construction failed for this owner (e.g. a kill-switch-disabled
  // Microsoft account, or a transient D1 error resolving their provider) —
  // their whole row set was skipped WITHOUT being attempted, so it's tracked
  // separately from `failed` rather than overloading that counter.
  skippedOwners: number;
  skippedRows: number;
}

type RowOutcome = "cancelled" | "cleared" | "closed_quietly" | "aborted";

async function sweepOneRow(
  db: D1Database,
  homeTzDefault: string,
  cal: CalendarProvider,
  notify: NotificationProvider,
  oauthIssuer: string,
  owner: string,
  row: CancelPendingRow,
  now: Date,
): Promise<RowOutcome> {
  const nowIso = now.toISOString();
  const event = await cal.getEvent(row.google_event_id);

  // Gone, or Google's own "cancelled" shape (which may carry empty-string
  // start/end and no attendees — MUST be checked before any date/attendee
  // logic below). The owner deleted the event themselves; close the row out
  // quietly. Emailing here would be noise at best, wrong at worst.
  if (event === null || event.status === "cancelled") {
    await markCancelled(db, row.id, nowIso);
    return "closed_quietly";
  }

  // Defense-in-depth: refuse to act on an event that isn't the one THIS
  // booking's row created, even though its id matches google_event_id — an
  // id can be reused for an unrelated event after ours was deleted
  // out-of-band. Everything below this point (start/attendees/delete) is
  // meaningless, or actively dangerous, applied to someone else's event.
  if (event.extendedProperties?.private?.optical_booking !== row.id) {
    await clearCancelPending(db, row.id, owner, row.google_event_id, nowIso);
    return "cleared";
  }

  // The slot has started (or passed) since the stamp was set — leave the
  // live event alone and clear the stamp so nothing re-triggers on it later.
  // Fail CLOSED on an unparseable start (NaN compares false against
  // everything): this is the half of the feature that deletes live events,
  // so unknown time must abort, mirroring the detector's stamp guard.
  const startMs = Date.parse(event.start);
  if (!Number.isFinite(startMs) || startMs <= now.getTime()) {
    await clearCancelPending(db, row.id, owner, row.google_event_id, nowIso);
    return "cleared";
  }

  // The attendee is no longer all-declined (un-decline, or Optical itself
  // relocated the meeting and reset their RSVP — see Card C's relocation-race
  // note): abort.
  if (!isAllDeclined(event)) {
    await clearCancelPending(db, row.id, owner, row.google_event_id, nowIso);
    return "cleared";
  }

  // Fire. Delete BEFORE the CAS: a crash between the two self-heals on the
  // next tick via the "event gone" branch above — only the emails would be
  // lost, never a live event left standing while the row reads 'cancelled'.
  await cal.deleteEvent(row.google_event_id, { notifyAttendees: true });
  const won = await markCancelled(db, row.id, nowIso);
  if (!won) {
    // Something else closed this row out between our re-verify and our own
    // CAS (e.g. a concurrent sweep tick, or the owner acting in the same
    // window) — the event is already gone either way; don't email. This is
    // the one path that deletes a live event with no other observable
    // trace, so it gets its own log line even though nothing threw.
    console.info("booking-decline-sweep: lost CAS after delete (raced)", { bookingId: row.id });
    return "aborted";
  }

  const ownerTz = await getHomeTz(db, owner, homeTzDefault);
  // The just-re-fetched LIVE event's start, not row.start_utc — the row can
  // go stale (an owner manually dragging the event in Google leaves it
  // untouched; only Optical's own relocation calls syncBookingTime).
  const startUtc = event.start;

  const bookerEmail: PollEmail = {
    to: row.booker_email,
    ...renderBookingDeclineCancelledEmail({
      slug: row.slug,
      startUtc,
      ownerTz,
      oauthIssuer,
    }),
  };
  await notify.sendPollEmail(bookerEmail);

  const ownerEmail: PollEmail = {
    to: owner,
    ...renderBookingDeclineCancelledOwnerEmail({
      bookerName: row.booker_name,
      startUtc,
      ownerTz,
    }),
  };
  await notify.sendPollEmail(ownerEmail);

  return "cancelled";
}

export async function runBookingDeclineSweep(
  env: Env,
  now: Date,
  deps: BookingDeclineSweepDeps = {},
): Promise<BookingDeclineSweepResult> {
  const makeCalendar = deps.makeCalendar ?? ((subject: string) => defaultCalendarProvider(env, subject));
  const makeNotification = deps.makeNotification ?? ((subject: string) => defaultNotificationProvider(env, subject));

  const cutoffIso = new Date(now.getTime() - graceMinutes(env) * 60_000).toISOString();
  const rows = await listCancelPendingDue(env.DB, cutoffIso);

  // Group by owner so each subject's calendar/notification providers are
  // constructed once, not once per row — same posture as poll-sweep's
  // per-subject fan-out.
  const byOwner = new Map<string, CancelPendingRow[]>();
  for (const row of rows) {
    const list = byOwner.get(row.owner_subject) ?? [];
    list.push(row);
    byOwner.set(row.owner_subject, list);
  }

  let checked = 0;
  let cancelled = 0;
  let cleared = 0;
  let closedQuietly = 0;
  let aborted = 0;
  let failed = 0;
  let skippedOwners = 0;
  let skippedRows = 0;

  for (const [owner, ownerRows] of byOwner) {
    let cal: CalendarProvider;
    let notify: NotificationProvider;
    try {
      cal = await makeCalendar(owner);
      notify = await makeNotification(owner);
    } catch (e) {
      // A per-owner provider construction failure (e.g. MS_PROVIDER_ENABLED
      // flipped off mid-sweep, or a transient D1 error resolving the
      // subject's provider) must not abort the sweep for every other
      // owner's due rows. Tracked as skippedOwners/skippedRows, NOT `failed`
      // — `failed` is reserved for a row that was actually attempted
      // (sweepOneRow itself threw); these rows were never attempted at all.
      skippedOwners += 1;
      skippedRows += ownerRows.length;
      console.error("booking-decline-sweep: provider construction failed for owner, skipping their rows", {
        rowCount: ownerRows.length,
        error: String(e),
      });
      continue;
    }
    for (const row of ownerRows) {
      checked += 1;
      try {
        const outcome = await sweepOneRow(env.DB, env.SCHEDULER_TZ, cal, notify, env.OAUTH_ISSUER, owner, row, now);
        if (outcome === "cancelled") cancelled += 1;
        else if (outcome === "cleared") cleared += 1;
        else if (outcome === "closed_quietly") closedQuietly += 1;
        else if (outcome === "aborted") aborted += 1;
      } catch (e) {
        failed += 1;
        // Booking id only — never an address (repo logging rule R1-F6).
        console.error("booking-decline-sweep: booking failed", { bookingId: row.id, error: String(e) });
      }
    }
  }

  const summary = { checked, cancelled, cleared, closedQuietly, aborted, failed, skippedOwners, skippedRows };
  console.info("booking_decline_sweep", summary);
  return summary;
}
