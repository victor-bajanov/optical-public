// Meeting-poll booking engine: all-in auto-book, deadline fallback, the
// on-demand "book whoever's in now" override (bookBestNow), and the atomic
// slot-claim + calendar-event creation shared by all three. Exports are a
// FIXED cross-task seam (plan §5) — T7/T8/T10 call these exact signatures.
//
// Provider/clock injection uses the module-level __setForTests idiom (same
// shape as cron/scheduled-entry.ts's __setHandlersForTests): the exported
// function signatures carry no extra params, so tests override the resolved
// CalendarProvider/NotificationProvider/clock here instead.

import type { Env } from "../env";
import type { CalendarProvider } from "../providers/calendar-provider";
import type { NotificationProvider } from "../providers/notification-provider";
import type { CalendarEvent } from "../providers/types";
import { defaultCalendarProvider, defaultNotificationProvider } from "../index-providers";
import {
  getPoll,
  listInvitees,
  aggregateResponses,
  casSetBooked,
  casSetPollStatus,
  type Poll,
  type PollStatus,
  type PollInvitee,
  type InviteeCells,
} from "../db/polls";
import { claimSlot, confirmBooking, failBooking, hasLiveBookingForPoll } from "../db/bookings";
import { loadBookingPage } from "../db/booking-page";
import { loadEffectiveContexts } from "../db/context-config";
import { getHomeTz } from "../db/users";
import { loadPinnedTaskIds } from "../db/tasks";
import { listBookings } from "../db/bookings";
import { loadBusinessHours, type BusinessHours } from "../db/business-hours";
import { deriveBusyBlocks } from "../planning/busy-blocks";
import { taskIdOfEvent } from "../calendar-feed/build-busy-ics";
import { readMeetingConfig } from "../meetings/config";
import { resolveBookableOverIds } from "../booking/bookable-over";
import { locationForEvent, type LocationKind } from "../booking/location";
import { candidateStarts, type CandidateAvailabilityInput, type CandidateBookingConfig } from "./grid";
import {
  rankCandidates,
  fitCurveFromContextConfig,
  type FitCurve,
  type InviteeResponse,
  type PaintState,
} from "./scoring";
import { renderEscalationEmail, renderBookingNoticeEmail, renderPollBookedEmail, type NearMissSlot } from "./emails";

export type BookOutcome = { ok: true; eventId: string } | { ok: false; reason: string };

export type BookBestOutcome =
  | { ok: true; slotStartUtc: string; eventId: string }
  | {
      ok: false;
      reason:
        | "poll_not_found"
        | "poll_not_actionable"
        | "no_responders"
        | "no_qualifying_slot"
        | "poll_already_claimed"
        | "calendar_unavailable";
    };

// ---------------------------------------------------------------------------
// Test injection
// ---------------------------------------------------------------------------

interface TestOverrides {
  calendar?: CalendarProvider;
  notification?: NotificationProvider;
  now?: () => Date;
}

let testOverrides: TestOverrides | null = null;

/** Test-only override for the calendar/notification providers and clock this
 *  module resolves internally (the exported functions' signatures are fixed
 *  by the plan and carry no room for injected params). Pass null to reset. */
export function __setForTests(overrides: TestOverrides | null): void {
  testOverrides = overrides;
}

async function resolveCalendar(env: Env, subject: string): Promise<CalendarProvider> {
  return testOverrides?.calendar ?? await defaultCalendarProvider(env, subject);
}

async function resolveNotification(env: Env, subject: string): Promise<NotificationProvider> {
  return testOverrides?.notification ?? await defaultNotificationProvider(env, subject);
}

function resolveNow(): Date {
  return testOverrides?.now ? testOverrides.now() : new Date();
}

// ---------------------------------------------------------------------------
// "meeting" context fit curve
// ---------------------------------------------------------------------------

/** A curve whose peak spans the entire day, so fitScoreAtMinute returns 0 for
 *  every minute of day and organiserFit is constant 1. Used when no usable
 *  'meeting'-context curve is available — see loadMeetingFitCurve. */
const FLAT_CURVE: FitCurve = { peak_start: "00:00", peak_end: "23:59", falloff_end: "23:59" };

/** Statuses from which a poll may still be booked. `needs_attention` is
 *  included deliberately: it is the state resolveMeetingPoll's book/bookBest
 *  and updateMeetingPoll's removeInviteeIds actions exist to rescue (see
 *  isActionable below), and the compensation path in bookPollSlotInternal
 *  must recognise it as a valid landing spot for a CAS, not just 'open'. */
const BOOKABLE_STATUSES: readonly PollStatus[] = ["open", "needs_attention"];

/** A poll the booking machinery may still act on. `needs_attention` is not a
 *  terminal state — it is the state resolveMeetingPoll's book/bookBest and
 *  updateMeetingPoll's removeInviteeIds actions exist to rescue, so treating
 *  it as unbookable makes those actions no-ops and parks the poll
 *  permanently (C-T9 round B, Fix 4). */
function isActionable(status: PollStatus): boolean {
  return status === "open" || status === "needs_attention";
}

/** The 'meeting' effective config for `subject`, via the same per-context
 *  merge the resolve pipeline uses (db/context-config.ts's
 *  loadEffectiveContexts: own row per context, else '__default__'). A subject
 *  who customised only other contexts therefore still gets the default
 *  meeting curve here — this replaced a pre-cost-curve-customisation
 *  own-wholesale-or-default reimplementation that diverged the moment
 *  partial customisation became possible.
 *
 *  Shape adaptation is T3's `fitCurveFromContextConfig` (scoring.ts), not
 *  reimplemented here; on real migrated data the default 'meeting' row is the
 *  single-window triple `{peak_start:"10:00", peak_end:"11:00",
 *  falloff_end:"17:00"}` (0005 collapsed 0002's multi-window seed; 0007/0017
 *  carry it forward), so a real curve is the everyday case. The null return —
 *  and the missing-'__default__'-seed catch — degrade to the caller's
 *  FLAT_CURVE fallback rather than failing the booking path over broken
 *  instance config. */
export async function loadMeetingFitCurve(db: D1Database, subject: string): Promise<FitCurve | null> {
  let contexts;
  try {
    contexts = await loadEffectiveContexts(db, subject);
  } catch (err) {
    // Degrading to FLAT_CURVE (via the caller) is the right booking-path
    // behaviour, but the cause — missing '__default__' seed, corrupted row
    // JSON, transient D1 failure — must stay observable.
    console.error(`loadMeetingFitCurve for ${subject}: degrading to flat curve:`, String(err));
    return null;
  }
  // The loader returns exactly the five known contexts or throws, so
  // 'meeting' is always present.
  const meeting = contexts.find((c) => c.context === "meeting")!;
  return fitCurveFromContextConfig(meeting.config);
}

/** The 'meeting' fit curve for `subject`, never null: the FLAT_CURVE fallback
 *  applied here is what the booking engine itself ranks with, so any caller
 *  that ranks poll candidates for display MUST use this and not its own
 *  loader — otherwise the organiser is shown a ranking that differs from the
 *  one that books (C-T9 round B, Fix 5: this replaces T8's independent,
 *  unvalidated, per-context-fallback implementation). Single implementation
 *  by construction. */
export async function resolveMeetingFitCurve(db: D1Database, subject: string): Promise<FitCurve> {
  return (await loadMeetingFitCurve(db, subject)) ?? FLAT_CURVE;
}

// ---------------------------------------------------------------------------
// Organiser availability (mirrors booking/availability.ts's computeAvailability,
// sized to the poll's own range rather than the booking page's horizon_days)
// ---------------------------------------------------------------------------

/** Hours used when neither the owner nor the instance has a
 *  config_business_hours row. Duplicated from booking/availability.ts (not
 *  exported there, and that file is outside this task's file fence) — same
 *  reasoning: under-offering is the safe direction, so an unseeded deployment
 *  must not treat "no hours row" as "every hour". */
const FALLBACK_HOURS: BusinessHours = {
  days: ["mon", "tue", "wed", "thu", "fri"],
  start: "09:00",
  end: "17:00",
};

/** Mirrors booking/availability.ts's computeAvailability internals (calendar
 *  busy + pinned task chunks + live bookings), but sized to an arbitrary
 *  horizon end rather than the booking page's own config.horizon_days: a poll
 *  range can span up to 6 weeks (spec) while the booking page's default
 *  horizon is 21 days, so calling computeAvailability itself would silently
 *  under-fetch the calendar for the tail of a long poll. availability.ts does
 *  not export the pieces this needs (pinnedChunkBlocks/FALLBACK_HOURS are
 *  private) and is not in this task's file fence, so they are duplicated here
 *  rather than widening that module's surface. */
async function assembleAvailability(
  db: D1Database,
  env: Env,
  subject: string,
  cal: CalendarProvider,
  now: Date,
  rangeEndDate: string,
): Promise<CandidateAvailabilityInput> {
  const config = await loadBookingPage(db, subject);
  const tz = await getHomeTz(db, subject, env.SCHEDULER_TZ);

  // Generous UTC padding past the poll's local range_end date. Safely covers
  // every real-world UTC offset (-12..+14) without needing the organiser's tz
  // resolved before sizing the fetch window — over-fetching a day or two is
  // harmless; under-fetching would silently offer a busy slot as free.
  //
  // Floored at now+1d (L2, mirrors route.ts's assemblePollAvailability):
  // without the floor, a poll re-evaluated well after its own rangeEnd+3d
  // (e.g. an updateMeetingPoll removeInviteeIds re-attempt on a long-overdue
  // poll) computes a horizonEnd BEFORE `now`, so
  // fetchEventsInWindow(now, horizonEnd) is handed an inverted window —
  // silently swallowed rather than erroring, not caught before this fix.
  const horizonEndMs = Math.max(
    Date.parse(`${rangeEndDate}T00:00:00Z`) + 3 * 86_400_000,
    now.getTime() + 86_400_000,
  );
  const horizonEnd = new Date(horizonEndMs);

  const { events } = await cal.fetchEventsInWindow(now.toISOString(), horizonEnd.toISOString(), { syncToken: false });

  const meetingConfig = readMeetingConfig(env);
  const bookableOverIds = await resolveBookableOverIds(db, subject, events, {
    enabled: meetingConfig.enabled && config.bookable_over_movable_meetings,
    minNoticeMinutes: meetingConfig.minNoticeMinutes,
    now,
  });

  const busyBlocks = deriveBusyBlocks(events, {
    tz,
    tentativeIsBusy: env.TENTATIVE_IS_BUSY === "true",
    excludeEventIds: bookableOverIds,
  });

  const pinnedTaskIds = await loadPinnedTaskIds(db, subject);
  const bookings = await listBookings(db, subject, now.toISOString(), horizonEnd.toISOString());

  const pinnedChunks = events
    .filter((e) => (e.status ?? "").toLowerCase() !== "cancelled")
    .filter((e) => {
      const taskId = taskIdOfEvent(e);
      return taskId !== null && pinnedTaskIds.has(taskId);
    })
    .map((e) => ({ startUtc: e.start, endUtc: e.end }));

  const busy = [
    ...busyBlocks.map((b) => ({ startUtc: b.startUtc, endUtc: b.endUtc })),
    ...pinnedChunks,
    ...bookings.map((b) => ({ startUtc: b.start_utc, endUtc: b.end_utc })),
  ];

  const hours = config.hours ?? (await loadBusinessHours(db, subject)) ?? FALLBACK_HOURS;
  return { tz, hours, busy };
}

async function loadBookingConfig(db: D1Database, subject: string): Promise<CandidateBookingConfig> {
  const config = await loadBookingPage(db, subject);
  return { min_notice_minutes: config.min_notice_minutes, buffer_minutes: config.buffer_minutes };
}

async function computeCandidates(env: Env, poll: Poll, cal: CalendarProvider, now: Date): Promise<{
  candidates: string[];
  tz: string;
}> {
  const availability = await assembleAvailability(env.DB, env, poll.subject, cal, now, poll.rangeEnd);
  const bookingCfg = await loadBookingConfig(env.DB, poll.subject);
  const candidates = candidateStarts(
    { duration_min: poll.durationMin, range_start: poll.rangeStart, range_end: poll.rangeEnd },
    availability,
    bookingCfg,
    now,
  );
  return { candidates, tz: availability.tz };
}

// ---------------------------------------------------------------------------
// Responses -> scoring.ts input
// ---------------------------------------------------------------------------

function toInviteeResponses(byInvitee: InviteeCells[], droppedIds: ReadonlySet<string>): InviteeResponse[] {
  return byInvitee
    .filter((r) => !droppedIds.has(r.inviteeId))
    .map((r) => ({
      inviteeId: r.inviteeId,
      cells: new Map<string, PaintState>(r.cells.map((c) => [c.cellStartUtc, c.state])),
    }));
}

function inviteeLabel(invitee: PollInvitee | undefined, fallbackId: string): string {
  // The escalation email goes only to the organiser, who always sees real
  // names (spec) — never the pseudonym.
  return invitee?.name ?? invitee?.email ?? fallbackId;
}

function computeNearMisses(
  candidates: string[],
  responses: InviteeResponse[],
  requiredInviteeIds: string[],
  curve: FitCurve,
  durationMin: number,
  tz: string,
  byId: Map<string, PollInvitee>,
): NearMissSlot[] {
  const misses: NearMissSlot[] = [];
  for (const droppedId of requiredInviteeIds) {
    const relaxed = requiredInviteeIds.filter((id) => id !== droppedId);
    const ranked = rankCandidates(candidates, responses, relaxed, curve, durationMin, tz);
    if (ranked.length === 0) continue;
    misses.push({ slotStartUtc: ranked[0]!.slotStartUtc, droppedInvitee: inviteeLabel(byId.get(droppedId), droppedId) });
  }
  return misses;
}

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

async function escalate(
  env: Env,
  poll: Poll,
  requiredInviteeIds: string[],
  candidates: string[],
  responses: InviteeResponse[],
  curve: FitCurve,
  tz: string | undefined,
  byId: Map<string, PollInvitee>,
  notification: NotificationProvider,
  now: Date,
): Promise<void> {
  const nowIso = now.toISOString();
  // Re-read: several awaited calendar round-trips happen between the
  // caller's own getPoll and here (the whole ranked-candidates walk through
  // bookPollSlotInternal), and a concurrent attempt may have booked the poll
  // in that window. Escalating over a booked poll would email the organiser
  // a false "couldn't book" alarm (C-T9 round B, Fix 3) — the FRESH status
  // decides, not the snapshot the caller happened to load earlier.
  const fresh = await getPoll(env.DB, poll.id);
  if (!fresh || !isActionable(fresh.status)) return;

  // A concurrent winner's status flip (casSetBooked) only lands once its
  // calendar write finishes — a real API round-trip that can take seconds —
  // so the status re-read above can still observe 'open'/'needs_attention'
  // while that winner is mid-flight. Its 'reserving' bookings row exists the
  // moment it claims, though (this poll's own ranking pass, above, is what
  // returned empty in the first place: that row shadowed the only qualifying
  // candidate as generically busy). Checking for it here is what actually
  // closes the race the status check alone cannot see yet.
  if (await hasLiveBookingForPoll(env.DB, poll.id)) return;

  if (fresh.escalatedAt === null) {
    const nearMisses =
      requiredInviteeIds.length === 0
        ? []
        : computeNearMisses(candidates, responses, requiredInviteeIds, curve, fresh.durationMin, tz ?? "UTC", byId);
    const email = renderEscalationEmail({
      poll: { id: fresh.id, title: fresh.title, durationMin: fresh.durationMin, deadlineUtc: fresh.deadlineUtc },
      nearMisses,
      organiserTz: tz,
    });
    await notification.sendPollEmail({ to: fresh.subject, ...email });
  }
  // A lost CAS here means a concurrent booking landed in the microsecond
  // window between the fresh-status check above and this write — one
  // spurious email in that vanishingly rare case is acceptable; a missing
  // one on a genuinely stuck poll is not, so the email is sent before this.
  await casSetPollStatus(env.DB, poll.id, "needs_attention", BOOKABLE_STATUSES, nowIso);
}

// ---------------------------------------------------------------------------
// Ranked booking walk (shared by attemptBookOrEscalate and bookBestNow)
// ---------------------------------------------------------------------------

type RankedWalkResult =
  | { kind: "booked"; slotStartUtc: string; eventId: string }
  | { kind: "already_claimed" } // stand down, someone else holds the poll's live booking
  | { kind: "not_actionable" } // poll went terminal (booked/cancelled) mid-walk
  | { kind: "calendar_write_failed" } // abortOnCalendarWriteFailure callers only
  | { kind: "no_slot"; candidates: string[]; responses: InviteeResponse[]; curve: FitCurve; tz: string };

interface RankedWalkOptions {
  /** bookBestNow-only (adversarial review FIX 1): abort on the FIRST
   *  calendar-write failure instead of trying every remaining ranked
   *  candidate. Without this, a provider WRITE outage (not just a read/fetch
   *  failure — those already throw and are caught by the caller) makes
   *  bookBestNow claim -> create -> fail on every single ranked candidate in
   *  one HTTP request (confirmed PoC: 80 createEvent calls, ~161 provider
   *  round-trips for one request), reports the misleading no_qualifying_slot
   *  instead of surfacing the real outage, and can blow the Workers
   *  subrequest budget on a long poll range. attemptBookOrEscalate does NOT
   *  set this: its existing behaviour — keep walking past a transient write
   *  failure, since a LATER candidate succeeding is exactly what the
   *  all-in/deadline paths want — must stay exactly as today (regression
   *  pinned in booking.test.ts's "FIX 1 regression" describe). */
  abortOnCalendarWriteFailure?: boolean;
}

/** Ranks candidates against `requiredInviteeIds` and walks the ranked list
 *  through bookPollSlotInternal, claiming the first workable slot. Shared by
 *  attemptBookOrEscalate (which escalates on `no_slot`) and bookBestNow
 *  (which never escalates — bookBest's failure is reported in-band via the
 *  HTTP response instead, see its own comment). Callers with zero required
 *  invitees must special-case that themselves before calling this — there is
 *  nothing to rank, and (for attemptBookOrEscalate) nothing to relax for a
 *  near-miss. */
async function rankedBookingWalk(
  env: Env,
  poll: Poll,
  requiredInviteeIds: string[],
  allInvitees: PollInvitee[],
  cal: CalendarProvider,
  now: Date,
  options?: RankedWalkOptions,
): Promise<RankedWalkResult> {
  const curve = await resolveMeetingFitCurve(env.DB, poll.subject);
  const { candidates, tz } = await computeCandidates(env, poll, cal, now);

  const { byInvitee } = await aggregateResponses(env.DB, poll.id);
  const droppedIds = new Set(allInvitees.filter((i) => i.dropped).map((i) => i.id));
  const responses = toInviteeResponses(byInvitee, droppedIds);

  const ranked = rankCandidates(candidates, responses, requiredInviteeIds, curve, poll.durationMin, tz);

  for (const candidate of ranked) {
    const outcome = await bookPollSlotInternal(env, poll, candidate.slotStartUtc, cal, now);
    if (outcome.ok) return { kind: "booked", slotStartUtc: candidate.slotStartUtc, eventId: outcome.eventId };
    if (outcome.reason === "poll_already_claimed") {
      // Another in-flight attempt (a concurrent response trigger, the cron
      // sweep, or an organiser resolve) already holds this poll's live
      // booking. Not our slot's problem and not an escalation — stand down
      // rather than flip a poll that is (or is about to be) booked over to
      // needs_attention (C-T9 round B, Fix 1/Fix 3).
      return { kind: "already_claimed" };
    }
    if (outcome.reason === "poll_not_open") {
      // The poll itself went terminal (booked/cancelled) mid-walk —
      // bookPollSlotInternal's isActionable check (top of the function) or
      // its post-createEvent CAS-lost branch (adversarial review FIX 2).
      // Either way every OTHER candidate would report the exact same thing
      // (the poll, not the slot, is the reason), so short-circuiting here —
      // for BOTH callers — only saves wasted work: escalate()'s own
      // fresh-status re-read already stands down on a terminal poll, so
      // attemptBookOrEscalate's observable behaviour is unchanged.
      return { kind: "not_actionable" };
    }
    if (outcome.reason === "calendar_write_failed" && options?.abortOnCalendarWriteFailure) {
      return { kind: "calendar_write_failed" };
    }
  }

  return { kind: "no_slot", candidates, responses, curve, tz };
}

/** Non-dropped invitees who have responded at least once — the required set
 *  bookAtDeadline and bookBestNow both rank against. Factored into one place
 *  (bookBest plan, decision 6) so the rule cannot silently diverge between
 *  the two. */
function respondedInvitees(invitees: PollInvitee[]): PollInvitee[] {
  return invitees.filter((i) => !i.dropped && i.respondedAt !== null);
}

// ---------------------------------------------------------------------------
// Book-or-escalate (shared by maybeBookOnAllIn and bookAtDeadline)
// ---------------------------------------------------------------------------

async function attemptBookOrEscalate(
  env: Env,
  poll: Poll,
  requiredInviteeIds: string[],
  allInvitees: PollInvitee[],
): Promise<void> {
  const notification = await resolveNotification(env, poll.subject);
  const now = resolveNow();
  const byId = new Map(allInvitees.map((i) => [i.id, i]));

  if (requiredInviteeIds.length === 0) {
    // Zero responders (deadline path) or zero non-dropped invitees: nothing
    // to rank, nothing to relax for a near-miss — escalate, never book.
    await escalate(env, poll, [], [], [], FLAT_CURVE, undefined, byId, notification, now);
    return;
  }

  const cal = await resolveCalendar(env, poll.subject);
  // No abortOnCalendarWriteFailure here — attemptBookOrEscalate's existing
  // behaviour (keep walking past a transient write failure, since a LATER
  // candidate succeeding is exactly what the all-in/deadline paths want)
  // must not change (FIX 1 regression, booking.test.ts).
  const result = await rankedBookingWalk(env, poll, requiredInviteeIds, allInvitees, cal, now);

  if (result.kind === "booked" || result.kind === "already_claimed" || result.kind === "not_actionable") return;
  if (result.kind === "calendar_write_failed") return; // unreachable: the abort flag above is never set for this caller

  await escalate(env, poll, requiredInviteeIds, result.candidates, result.responses, result.curve, result.tz, byId, notification, now);
}

// ---------------------------------------------------------------------------
// Claim + create (bookPollSlot)
// ---------------------------------------------------------------------------

async function bookPollSlotInternal(
  env: Env,
  poll: Poll,
  slotStartUtc: string,
  cal: CalendarProvider,
  now: Date,
): Promise<BookOutcome> {
  const db = env.DB;
  // Re-fetch: a concurrent call (another response submission, the cron
  // sweep, or an organiser resolve) may have already booked/cancelled this
  // poll since the caller's own snapshot was read.
  const fresh = await getPoll(db, poll.id);
  if (!fresh || !isActionable(fresh.status)) return { ok: false, reason: "poll_not_open" };

  // Live re-check: recompute organiser feasibility NOW, not from whatever
  // ranking pass (if any) chose this slot. This is what catches both a
  // pre-existing conflicting booking and a calendar that changed since
  // ranking (stale winner) — either way, a slot that is no longer offerable
  // is rejected here before any claim is attempted.
  const bookingCfg = await loadBookingConfig(db, poll.subject);
  const availability = await assembleAvailability(db, env, poll.subject, cal, now, poll.rangeEnd);
  const candidates = candidateStarts(
    { duration_min: poll.durationMin, range_start: poll.rangeStart, range_end: poll.rangeEnd },
    availability,
    bookingCfg,
    now,
  );
  if (!candidates.includes(slotStartUtc)) return { ok: false, reason: "slot_not_feasible" };

  const startMs = Date.parse(slotStartUtc);
  const endUtc = new Date(startMs + poll.durationMin * 60_000).toISOString();
  const guardStartUtc = new Date(startMs - bookingCfg.buffer_minutes.before * 60_000).toISOString();
  const guardEndUtc = new Date(
    startMs + poll.durationMin * 60_000 + bookingCfg.buffer_minutes.after * 60_000,
  ).toISOString();

  const location = poll.location as { kind: LocationKind; detail?: string | null };
  let placement;
  try {
    placement = locationForEvent(location.kind, location.detail ?? null, [
      { kind: location.kind, detail: location.detail ?? null },
    ]);
  } catch {
    return { ok: false, reason: "location_invalid" };
  }

  // Atomic claim, same primitive as the booking page (db/bookings.ts's
  // INSERT ... WHERE NOT EXISTS) — this is what actually resolves a genuine
  // concurrent race between two callers that both passed the feasibility
  // check above in the same instant.
  const claim = await claimSlot(db, {
    ownerSubject: poll.subject,
    slug: `poll:${poll.id}`,
    startUtc: slotStartUtc,
    endUtc,
    durationMinutes: poll.durationMin,
    bookerName: poll.title,
    bookerEmail: poll.subject,
    bookerNote: null,
    locationKind: location.kind,
    locationDetail: location.detail ?? null,
    ipHash: "poll",
    guardStartUtc,
    guardEndUtc,
    now,
    pollId: poll.id,
  });
  if (!claim) {
    // Either this exact slot was taken (the ordinary overlap guard), or a
    // concurrent attempt already claimed a DIFFERENT slot for this SAME poll
    // (the poll-scoped exclusion in claimSlot — C-T9 round B, Fix 1). The two
    // are indistinguishable from a single NULL, so read back which one it
    // was: the caller (attemptBookOrEscalate's ranked walk) must stand down
    // rather than escalate in the second case.
    const alreadyClaimed = await hasLiveBookingForPoll(db, poll.id);
    return { ok: false, reason: alreadyClaimed ? "poll_already_claimed" : "slot_taken" };
  }

  const invitees = await listInvitees(db, poll.id);
  // Hidden invitees ("hide my name") are excluded from the event's attendee
  // list (decision D2): the peer-visible respondent list on the poll page
  // shows their pseudonym, but a calendar attendee entry is always their
  // real email address, which would leak exactly what hiding was meant to
  // prevent. They still get the meeting — via a private booking-notice
  // email (BCC-equivalent) sent below, once the event is actually
  // confirmed. An all-hidden poll books with no invitees on the attendee
  // list at all; that is correct, not a bug.
  const hiddenNotified = invitees.filter((i) => !i.dropped && i.hideName);
  const attendees = invitees.filter((i) => !i.dropped && !i.hideName).map((i) => ({ email: i.email }));

  const event: CalendarEvent = {
    id: "",
    summary: poll.title,
    description: "Booked via Optical meeting poll.",
    start: slotStartUtc,
    end: endUtc,
    attendees,
    extendedProperties: {},
  };
  if (placement.location) event.location = placement.location;

  let eventId: string;
  try {
    ({ eventId } = await cal.createEvent(
      event,
      { optical_poll_id: poll.id },
      { notifyAttendees: true, addMeet: placement.addMeet, conferenceRequestId: claim.id },
    ));
  } catch (err) {
    console.error("poll booking calendar write failed:", String(err));
    await failBooking(db, claim.id, now);
    return { ok: false, reason: "calendar_write_failed" };
  }

  const moved = await casSetBooked(db, poll.id, slotStartUtc, eventId, BOOKABLE_STATUSES);
  if (!moved) {
    // The poll was cancelled (or booked by a concurrent attempt) while the
    // calendar write was in flight (C-T9 round B, Fix 2). The event just
    // created is now orphaned: delete it and release the claim, rather than
    // leaving a meeting on everyone's calendar for a poll that no longer
    // exists (or is already booked elsewhere). CAS runs BEFORE confirmBooking
    // so a lost CAS leaves the claim releasable.
    try {
      await cal.deleteEvent(eventId);
    } catch (err) {
      console.error(`poll ${poll.id}: orphaned event ${eventId} could not be deleted:`, String(err));
    }
    await failBooking(db, claim.id, now);
    return { ok: false, reason: "poll_not_open" };
  }
  await confirmBooking(db, claim.id, eventId, now);

  // Hidden invitees' booking notices go strictly after the event write is
  // confirmed (never for an orphaned event that gets deleted by the CAS
  // failure branch above) — see the `hiddenNotified` comment for why they
  // need this at all. Successes and failures are tracked separately
  // (`hiddenNoticeSucceeded`/`hiddenNoticeFailed`) so the organiser
  // notification below can report what actually happened, not what was
  // merely attempted (finding 6).
  const hiddenNoticeSucceeded: PollInvitee[] = [];
  const hiddenNoticeFailed: PollInvitee[] = [];
  if (hiddenNotified.length > 0) {
    const notification = await resolveNotification(env, poll.subject);
    const content = renderBookingNoticeEmail({
      pollId: poll.id,
      pollTitle: poll.title,
      organiserName: poll.subject,
      durationMin: poll.durationMin,
      slotStartUtc,
      slotEndUtc: endUtc,
      location: placement.location,
      now,
    });
    for (const invitee of hiddenNotified) {
      try {
        await notification.sendPollEmail({ to: invitee.email, ...content });
        hiddenNoticeSucceeded.push(invitee);
      } catch (err) {
        // Non-fatal: the booking already succeeded and must not be undone
        // (or reported as failed) over a notice-email hiccup. Log by invitee
        // id, never the address (R1-F6): this invitee hid their name
        // specifically to keep their email off the attendee list, so it must
        // not leak into worker logs from the failure path either.
        console.error(`poll ${poll.id}: booking-notice email to invitee ${invitee.id} failed:`, String(err));
        hiddenNoticeFailed.push(invitee);
      }
    }
  }

  // Organiser notification: escalate() already emails the organiser when a
  // poll fails to book (needs_attention); a successful booking was silent
  // until now (T-notify). All three booking paths (all-in, deadline
  // fallback, manual resolve book) share this one call site, so one place
  // covers all of them. Placed after confirmBooking (never for an orphaned
  // event that gets deleted by the CAS-failure branch above), same reasoning
  // as the hidden-invitee notices. The ENTIRE block — content build and send
  // alike — is inside this one try/catch (findings 2/3): nothing from here
  // on may escape bookPollSlotInternal uncaught, since the booking has
  // already committed and a throw here would surface as a 500 for a request
  // that actually succeeded (with a retry then hitting a 409, the poll
  // already being booked). `organiserTz` reuses `availability.tz` (already
  // resolved above for the live feasibility re-check) rather than issuing a
  // second, redundant getHomeTz DB read for the same value.
  try {
    const locationText = placement.addMeet
      ? // Google mints the Meet join link asynchronously — it isn't known at
        // this point, so point the organiser at the calendar event itself
        // rather than promising a URL this function doesn't have (finding 4).
        "Google Meet (link is on the calendar event)"
      : placement.location;
    const attendeeNames = invitees.filter((i) => !i.dropped && !i.hideName).map((i) => inviteeLabel(i, i.id));
    const hiddenNames = hiddenNoticeSucceeded.map((i) => inviteeLabel(i, i.id));
    const hiddenFailedNames = hiddenNoticeFailed.map((i) => inviteeLabel(i, i.id));
    const content = renderPollBookedEmail({
      pollTitle: poll.title,
      slotStartUtc,
      durationMin: poll.durationMin,
      location: locationText,
      organiserTz: availability.tz,
      attendeeNames,
      hiddenNames,
      hiddenFailedNames,
    });
    const orgNotification = await resolveNotification(env, poll.subject);
    await orgNotification.sendPollEmail({ to: poll.subject, ...content });
  } catch (err) {
    // Non-fatal, same reasoning as the hidden-invitee notice above: the
    // booking already succeeded. Logged by poll id only.
    console.error(`poll ${poll.id}: booked notification to organiser failed:`, String(err));
  }

  return { ok: true, eventId };
}

// ---------------------------------------------------------------------------
// Exported seam
// ---------------------------------------------------------------------------

export async function maybeBookOnAllIn(env: Env, pollId: string): Promise<void> {
  const db = env.DB;
  const poll = await getPoll(db, pollId);
  // needs_attention is not terminal here: updateMeetingPoll's
  // removeInviteeIds arm calls this to re-attempt booking an escalated poll
  // once its blocker is dropped (C-T9 round B, Fix 4) — requiring "open"
  // made that advertised remedy a silent no-op.
  if (!poll || !isActionable(poll.status)) return;

  // Guest-link polls must wait for the deadline: a guest can only join while
  // status === "open" and before the deadline (route.ts's guest-join
  // handler), so an early all-in book — or an early escalate, which also
  // flips status away from "open" — forecloses joins that were still live.
  // needs_attention is NOT covered by this guard: joins are already
  // impossible once escalated (status isn't "open"), and this is the state
  // resolveMeetingPoll's book/bookBest and updateMeetingPoll's
  // removeInviteeIds rescue actions exist to resolve — gating it here would
  // silently defeat that advertised remedy, same trap
  // isActionable's own comment describes. bookAtDeadline (below) is a
  // separate function; it is exempt from this guard, but — unlike this
  // comment used to claim — that exemption is no longer just "it only ever
  // fires at (or after) the deadline": it re-checks the freshly fetched
  // deadline itself (see its own comment) rather than trusting its caller's
  // due-ness snapshot, since that snapshot can go stale mid-sweep.
  if (poll.guestTokenHash !== null && poll.status === "open") return;

  const invitees = await listInvitees(db, pollId);
  const required = invitees.filter((i) => !i.dropped);
  if (required.some((i) => i.respondedAt === null)) return; // not all in yet

  await attemptBookOrEscalate(
    env,
    poll,
    required.map((i) => i.id),
    invitees,
  );
}

export async function bookPollSlot(env: Env, pollId: string, slotStartUtc: string): Promise<BookOutcome> {
  const poll = await getPoll(env.DB, pollId);
  if (!poll) return { ok: false, reason: "poll_not_found" };
  const cal = await resolveCalendar(env, poll.subject);
  const now = resolveNow();
  return bookPollSlotInternal(env, poll, slotStartUtc, cal, now);
}

export async function bookAtDeadline(env: Env, pollId: string): Promise<void> {
  const db = env.DB;
  const poll = await getPoll(db, pollId);
  // Deliberately narrower than isActionable: the sweep only ever hands this
  // OPEN polls (listOpenPollsDue selects status='open'), and a deadline-
  // triggered auto-book of a poll the organiser has already been asked to
  // resolve by hand (needs_attention) would be a surprise, not a rescue.
  if (!poll || poll.status !== "open") return;

  // Re-check the FRESHLY FETCHED deadline, not just the caller's say-so that
  // this poll is due. The cron sweep decides due-ness from a poll list
  // snapshotted once, before its per-poll loop (poll-sweep.ts's
  // sweepOnePoll); earlier polls in that same loop do multi-second calendar
  // round-trips. If updateMeetingPoll's deadlineUtc arm lands in
  // that window, the snapshot this call was dispatched from is stale — book
  // anyway here and a guest-link poll's deadline extension is silently
  // overridden, foreclosing exactly the joins the guestTokenHash guard above
  // exists to protect (and, for a non-guest-link poll, booking/escalating
  // ahead of an extended deadline the organiser explicitly asked for is
  // simply wrong regardless). Matches sweepOnePoll's own due-ness test
  // (`now.getTime() >= deadlineMs`) so this only ever refuses work the sweep
  // itself would no longer consider due.
  if (resolveNow().getTime() < Date.parse(poll.deadlineUtc)) return;

  const invitees = await listInvitees(db, pollId);
  const required = respondedInvitees(invitees);

  await attemptBookOrEscalate(
    env,
    poll,
    required.map((i) => i.id),
    invitees,
  );
}

/** resolveMeetingPoll{action:"bookBest"}'s engine: ranks candidates against
 *  bookAtDeadline's exact required-set rule (non-dropped invitees who have
 *  responded — see respondedInvitees) and books the top workable slot right
 *  now, regardless of the deadline, ignoring the guest-link "wait for the
 *  deadline" guard (that guard protects automatic triggers only — this is an
 *  organiser-initiated override, same posture as the explicit `book` action).
 *
 *  Unlike attemptBookOrEscalate's other two callers, a failure here NEVER
 *  escalates: it's a synchronous, exploratory "try booking now" — escalating
 *  as a side effect would freeze future auto-book (saves on an escalated
 *  poll never auto-book) and kill a live guest-join link (joins need status
 *  'open'), both surprising fallout of an action that failed. The poll's
 *  status is left exactly as found; the caller (resolveMeetingPoll) reports
 *  the failure in-band via the HTTP response instead. */
export async function bookBestNow(env: Env, pollId: string): Promise<BookBestOutcome> {
  const db = env.DB;
  const poll = await getPoll(db, pollId);
  if (!poll) return { ok: false, reason: "poll_not_found" };
  if (!isActionable(poll.status)) return { ok: false, reason: "poll_not_actionable" };

  const invitees = await listInvitees(db, pollId);
  const required = respondedInvitees(invitees).map((i) => i.id);
  if (required.length === 0) return { ok: false, reason: "no_responders" };

  const cal = await resolveCalendar(env, poll.subject);
  const now = resolveNow();

  let result: RankedWalkResult;
  try {
    // abortOnCalendarWriteFailure: true — a WRITE outage must be reported as
    // such (calendar_unavailable), not misreported as no_qualifying_slot
    // after silently retrying every ranked candidate (adversarial review
    // FIX 1 — see RankedWalkOptions' own comment for the full PoC/reasoning).
    result = await rankedBookingWalk(env, poll, required, invitees, cal, now, { abortOnCalendarWriteFailure: true });
  } catch (err) {
    // A thrown provider error (e.g. the calendar fetch feeding
    // computeCandidates) must not propagate — this is a synchronous,
    // organiser-initiated HTTP action, and the caller needs a reportable
    // reason, not a 500. Same posture as resolve-book's own candidate-ranking
    // try/catch (handlers/polls.ts).
    console.error(`poll ${poll.id} bookBest failed:`, String(err));
    return { ok: false, reason: "calendar_unavailable" };
  }

  if (result.kind === "booked") return { ok: true, slotStartUtc: result.slotStartUtc, eventId: result.eventId };
  if (result.kind === "already_claimed") return { ok: false, reason: "poll_already_claimed" };
  if (result.kind === "not_actionable") return { ok: false, reason: "poll_not_actionable" };
  if (result.kind === "calendar_write_failed") return { ok: false, reason: "calendar_unavailable" };

  // "no_slot" is ambiguous the same way escalate() has to disambiguate it
  // (see that function's own comment): a concurrent winner's 'reserving'
  // bookings row can shadow the only qualifying candidate as generically
  // busy BEFORE the ranked walk's own loop ever gets a chance to see it (the
  // slot never makes it into `candidates` at all, so the loop's own
  // already_claimed branch never fires). Re-check here — bookBestNow has no
  // escalate() call to do this for it.
  if (await hasLiveBookingForPoll(db, poll.id)) return { ok: false, reason: "poll_already_claimed" };
  return { ok: false, reason: "no_qualifying_slot" };
}
