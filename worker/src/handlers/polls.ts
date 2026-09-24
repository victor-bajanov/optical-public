// worker/src/handlers/polls.ts
// Authenticated /v1 operations for meeting polls: create, read full status
// (with live candidate ranking), manual nudge, cancel, and the escalation
// actions (resolveMeetingPoll). Auth mirrors handlers/booking-page.ts exactly
// (requireOwner: bearer + subject; no new scopes). The public, unauthenticated
// invitee-facing routes (GET/PUT /poll/:id, /poll/:id/grid, /poll/:id/join)
// are T7's file (worker/src/polls/route.ts), not this one.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Env } from "../env";
import type { AppVariables } from "../index-providers";
import { requireOwner } from "../middleware/owner-gate";
import { defaultCalendarProvider, defaultNotificationProvider } from "../index-providers";
import {
  createPoll,
  getPollForSubject,
  listInvitees,
  aggregateResponses,
  setPollStatus,
  casSetPollStatus,
  setPollDeadline,
  setInviteeTokenHash,
  clearPollEpisodeStamps,
  dropInvitee as dbDropInvitee,
  restoreInvitee,
  setInviteeName,
  setPollTitle,
  setPollLocation,
  setGuestTokenHash,
  newInviteeId,
  insertInvitee,
  type Poll,
  type PollInvitee,
} from "../db/polls";
import { mintPseudonym } from "../polls/pseudonyms";
import { candidateStarts } from "../polls/grid";
import { rankCandidates, type InviteeResponse, type PaintState, type CandidateScore } from "../polls/scoring";
// Static import is fine here (unlike the T9 booking-ENGINE seam below, which
// stays dynamic/indirected — do not touch that): resolveMeetingFitCurve is a
// pure loader with no test-injection needs of its own, and polls/booking.ts
// exists in every worktree by the time this fix lands. Single implementation
// by construction — see its own doc comment for why a second, independent
// fit-curve loader here would let getMeetingPoll show a ranking that isn't
// the one the booking engine actually books with (C-T9 round B, Fix 5 /
// correction-T8.md Fix 7).
import { resolveMeetingFitCurve } from "../polls/booking";
import {
  renderInviteEmail,
  renderNudgeEmail,
  renderDeadlineExtendedEmail,
  renderPollCancelledEmail,
  renderInviteeRemovedEmail,
} from "../polls/emails";
import { signCapabilityWithEnv } from "../auth/capability";
import { hashToken, generateOpaqueToken } from "../auth/tokens";
import { hashingKey } from "../auth/crypto-keys";
import { ALL_KINDS, MAX_LOCATION_LENGTH, type LocationKind } from "../booking/location";
import { loadBookingPage } from "../db/booking-page";
import { getHomeTz } from "../db/users";
import { loadBusinessHours, type BusinessHours } from "../db/business-hours";
import { loadPinnedTaskIds } from "../db/tasks";
import { listBookings } from "../db/bookings";
import { deriveBusyBlocks } from "../planning/busy-blocks";
import { readMeetingConfig } from "../meetings/config";
import { resolveBookableOverIds } from "../booking/bookable-over";
import { taskIdOfEvent } from "../calendar-feed/build-busy-ics";
import type { CalendarProvider } from "../providers/calendar-provider";

// ── Poll booking engine seam ────────────────────────────────────────────────
//
// worker/src/polls/booking.ts owns bookPollSlot/maybeBookOnAllIn (the actual
// claim + calendar-event-creation logic). It's already a normal, statically
// importable module now (see the static `resolveMeetingFitCurve` import
// above — that's a pure loader with no test-injection needs of its own, so it
// doesn't go through this seam). bookPollSlot/maybeBookOnAllIn stay behind
// the indirection below because THEY need per-test substitution: a handler
// test wants to stub "the booking engine did X" without also wiring up
// booking.ts's own, unrelated __setForTests (its calendar/notification/clock
// injection point). Tests call __setPollBookingEngineForTests; production
// code resolves the real module via a dynamic import indirected through a
// variable (not a string literal) so a test override can intercept it
// cleanly without TypeScript trying to inline/hoist the import.

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

export interface PollBookingEngine {
  bookPollSlot(env: Env, pollId: string, slotStartUtc: string): Promise<BookOutcome>;
  maybeBookOnAllIn(env: Env, pollId: string): Promise<void>;
  bookBestNow(env: Env, pollId: string): Promise<BookBestOutcome>;
}

let bookingEngineOverride: PollBookingEngine | null = null;

/** Test-only injection point. */
export function __setPollBookingEngineForTests(engine: PollBookingEngine | null): void {
  bookingEngineOverride = engine;
}

async function pollBookingEngine(): Promise<PollBookingEngine> {
  if (bookingEngineOverride) return bookingEngineOverride;
  // The specifier MUST be a string literal: esbuild can only bundle a
  // dynamic import it can resolve statically. A variable specifier survives
  // bundling verbatim and rejects at runtime in deployed workerd (no such
  // module in the single-file bundle) while resolving fine under vitest —
  // resolveMeetingPoll book/dropInvitee 500'd in dev for exactly this.
  // The import stays dynamic (not top-level) to break the module-init cycle
  // with polls/booking; same idiom as cron/scheduled-entry.ts.
  const mod = (await import("../polls/booking")) as PollBookingEngine;
  return mod;
}

async function mintInviteeToken(
  env: Env,
  pollId: string,
  inviteeId: string,
  subject: string,
  deadlineUtc: string,
  now: Date,
): Promise<{ token: string; tokenHash: string }> {
  // Expiry = deadline + 7 days grace (covers the escalation/resolve window).
  const ttlSeconds = Math.max(1, Math.round((Date.parse(deadlineUtc) - now.getTime()) / 1000)) + 7 * 86_400;
  const token = await signCapabilityWithEnv({ purpose: "poll-response", pollId, inviteeId, subject, ttlSeconds }, env);
  const tokenHash = await hashToken(token, hashingKey(env));
  return { token, tokenHash };
}

/** The organiser's status-page link (createMeetingPoll's statusUrl): a
 *  capability token, not a stored/rotatable one like invitee tokens — the
 *  status page is read-only, so there's nothing to invalidate on reuse.
 *  Same TTL math as mintInviteeToken (deadline + 7d grace) so the link keeps
 *  working through the same escalation/resolve window. */
async function mintStatusToken(env: Env, pollId: string, subject: string, deadlineUtc: string, now: Date): Promise<string> {
  const ttlSeconds = Math.max(1, Math.round((Date.parse(deadlineUtc) - now.getTime()) / 1000)) + 7 * 86_400;
  return signCapabilityWithEnv({ purpose: "poll-status", pollId, subject, ttlSeconds }, env);
}

function statusUrlFor(env: Env, pollId: string, token: string): string {
  // Hard contract with T11 (organiser status page verify side): query param
  // MUST be `t`, same name as the invitee link — do not vary without syncing
  // both sides.
  return `${env.OAUTH_ISSUER}/poll/${pollId}/status?t=${encodeURIComponent(token)}`;
}

function inviteeUrlFor(env: Env, pollId: string, token: string): string {
  // Fixed seam (plan §5): ${baseUrl}/poll/${pollId}?t=${token}. baseUrl is
  // derived the same way the accept-link email flow does — env.OAUTH_ISSUER
  // (see cron/monday-resolve.ts's acceptUrl) — not a new config var.
  return `${env.OAUTH_ISSUER}/poll/${pollId}?t=${encodeURIComponent(token)}`;
}

// ── Live candidate ranking ──────────────────────────────────────────────────
//
// booking/availability.ts's computeAvailability can't be reused directly: it
// walks bookable slots for ONE duration within the booking page's OWN
// horizon_days, which a multi-week poll range can outrun (a poll range can be
// up to 6 weeks; horizon_days defaults to 21). This reassembles the same busy
// picture computeAvailability does (deriveBusyBlocks + pinned chunks +
// bookings + bookable-over exclusions), sized to reach the poll's own range,
// then calls T4's candidateStarts (which does the correct range-aware walk)
// and T3's rankCandidates. Some duplication with T9's polls/booking.ts (which
// needs the identical assembly for its own booking decision) is expected —
// the plan keeps wave-2 files disjoint by design (see e.g. the ICS-parser
// duplication precedent in T6).

const FALLBACK_HOURS: BusinessHours = {
  days: ["mon", "tue", "wed", "thu", "fri"],
  start: "09:00",
  end: "17:00",
};

interface PollRanking {
  candidates: CandidateScore[];
  organiserFeasible: string[];
  allIn: boolean;
}

export async function rankPollCandidates(
  env: Env,
  db: D1Database,
  cal: CalendarProvider,
  owner: string,
  poll: Poll,
  now: Date,
): Promise<PollRanking> {
  const config = await loadBookingPage(db, owner);
  const tz = await getHomeTz(db, owner, env.SCHEDULER_TZ);

  // Generous UTC overestimate of the poll range's end (candidateStarts does
  // the precise local-date clipping against poll.rangeEnd afterwards).
  const horizonEndMs = Date.parse(`${poll.rangeEnd}T23:59:59Z`) + 2 * 86_400_000;
  const horizonEnd = new Date(Math.max(horizonEndMs, now.getTime() + 86_400_000));

  const { events } = await cal.fetchEventsInWindow(now.toISOString(), horizonEnd.toISOString(), { syncToken: false });

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
  const bookings = await listBookings(db, owner, now.toISOString(), horizonEnd.toISOString());

  // Mirrors booking/availability.ts's (unexported) pinnedChunkBlocks.
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

  const hours = config.hours ?? (await loadBusinessHours(db, owner)) ?? FALLBACK_HOURS;

  const organiserFeasible = candidateStarts(
    { duration_min: poll.durationMin, range_start: poll.rangeStart, range_end: poll.rangeEnd },
    { tz, hours, busy },
    { min_notice_minutes: config.min_notice_minutes, buffer_minutes: config.buffer_minutes },
    now,
  );

  const curve = await resolveMeetingFitCurve(db, owner);
  const invitees = await listInvitees(db, poll.id);
  const requiredInviteeIds = invitees.filter((i) => !i.dropped).map((i) => i.id);
  const allIn = requiredInviteeIds.every((id) => invitees.find((i) => i.id === id)?.respondedAt);

  const { byInvitee } = await aggregateResponses(db, poll.id);
  const responses: InviteeResponse[] = byInvitee.map((r) => ({
    inviteeId: r.inviteeId,
    cells: new Map(r.cells.map((c) => [c.cellStartUtc, c.state as PaintState])),
  }));

  const candidates = rankCandidates(organiserFeasible, responses, requiredInviteeIds, curve, poll.durationMin, tz);

  return { candidates, organiserFeasible, allIn };
}

// ── Validation helpers ──────────────────────────────────────────────────────

const DURATIONS = [15, 30, 45, 60, 90, 120] as const;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 42; // 6 weeks
// L5: a long poll range can produce hundreds of qualifying slots. Cap what
// getMeetingPoll RETURNS to the top-scored MAX_POLL_CANDIDATES; qualifyingCount
// stays uncapped (see getMeetingPoll's handler).
const MAX_POLL_CANDIDATES = 20;

class ValidationError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function normaliseInvitees(raw: { email: string; name?: string | null }[]): { email: string; name: string | null }[] {
  const seen = new Set<string>();
  const out: { email: string; name: string | null }[] = [];
  for (const inv of raw) {
    const email = inv.email.trim().toLowerCase();
    if (seen.has(email)) throw new ValidationError("duplicate_invitee", `duplicate invitee email '${email}'`);
    seen.add(email);
    out.push({ email, name: inv.name ?? null });
  }
  return out;
}

function validateRange(rangeStart: string, rangeEnd: string, now: Date): void {
  const startMs = Date.parse(`${rangeStart}T00:00:00Z`);
  const endMs = Date.parse(`${rangeEnd}T23:59:59Z`);
  if (endMs < startMs) throw new ValidationError("invalid_range", "rangeEnd must not be before rangeStart");
  const spanDays = (endMs - startMs) / 86_400_000;
  if (spanDays > MAX_RANGE_DAYS) throw new ValidationError("invalid_range", `range must span at most ${MAX_RANGE_DAYS} days`);
  if (endMs < now.getTime()) throw new ValidationError("invalid_range", "rangeEnd must not be entirely in the past");
}

function validateDeadline(deadlineUtc: string, rangeEnd: string, now: Date): void {
  const deadlineMs = Date.parse(deadlineUtc);
  if (deadlineMs < now.getTime() + 3_600_000) {
    throw new ValidationError("invalid_deadline", "deadlineUtc must be at least 1 hour from now");
  }
  const rangeEndMs = Date.parse(`${rangeEnd}T23:59:59Z`);
  if (deadlineMs > rangeEndMs) {
    throw new ValidationError("invalid_deadline", "deadlineUtc must not be later than 23:59 on rangeEnd");
  }
}

// Poll-specific location validation: unlike the booking page (owner sets
// `custom` up front, the BOOKER supplies phone/in_person detail at claim
// time), a poll has no booker — the organiser is the only party who ever
// sets this value, once, at creation. So every kind except `meet` needs a
// detail here, not just `custom` (booking/location.ts's needsOwnerDetail
// only covers the booking-page's two-phase split and doesn't fit).
const NEEDS_DETAIL: ReadonlySet<LocationKind> = new Set(["phone", "custom", "in_person"]);

function validatePollLocation(loc: { kind: string; detail?: string | null }): void {
  if (!ALL_KINDS.includes(loc.kind as LocationKind)) {
    throw new ValidationError("invalid_location", `unknown location kind '${loc.kind}'`);
  }
  const detail = (loc.detail ?? "").trim();
  const kind = loc.kind as LocationKind;
  if (NEEDS_DETAIL.has(kind) && detail.length === 0) {
    throw new ValidationError("invalid_location", `location kind '${kind}' requires a non-empty detail`);
  }
  if (kind === "meet" && detail.length > 0) {
    throw new ValidationError("invalid_location", "location kind 'meet' must not carry a detail");
  }
  if (detail.length > MAX_LOCATION_LENGTH) {
    throw new ValidationError("invalid_location", `location detail must be at most ${MAX_LOCATION_LENGTH} characters`);
  }
}

// ── Schemas ──────────────────────────────────────────────────────────────

const ErrorResponse = z.object({
  error: z.string().describe("Machine-readable error code."),
  detail: z.string().optional().describe("Human-readable detail; not machine-readable."),
});

const LocationInput = z.object({
  kind: z
    .enum(["meet", "phone", "custom", "in_person"])
    .describe(
      "How the booked meeting happens. 'meet' asks the calendar provider for a Google Meet link and needs no detail. 'phone'/'in_person'/'custom' need a `detail` — unlike the booking page, a poll has no separate booker step, so the organiser sets this value once, here.",
    ),
  detail: z
    .string()
    .max(MAX_LOCATION_LENGTH)
    .nullable()
    .optional()
    .describe(`Free text for the chosen kind (phone number, address, or fixed text). Required for every kind except 'meet'. Max ${MAX_LOCATION_LENGTH} characters.`),
});

const InviteeInput = z.object({
  email: z.string().email().describe("Invitee's email address; their personal poll link is sent here."),
  name: z
    .string()
    .min(1)
    .max(100)
    .nullable()
    .optional()
    .describe("Invitee's display name, shown to the organiser and (unless they hide it) to other invitees. Omit or null if unknown."),
});

const CreatePollBody = z.object({
  title: z.string().min(1).max(200).describe("Poll title — shown to invitees and used as the eventual calendar event title."),
  invitees: z
    .array(InviteeInput)
    .min(1)
    .max(20)
    .describe("Who to invite (1-20). Emails are normalised (trimmed, lowercased); an exact duplicate is rejected rather than silently dropped."),
  durationMin: z
    .union([z.literal(15), z.literal(30), z.literal(45), z.literal(60), z.literal(90), z.literal(120)])
    .describe("Meeting length in minutes. One of 15, 30, 45, 60, 90, 120."),
  rangeStart: z.string().regex(LOCAL_DATE).describe("Inclusive local calendar date (YYYY-MM-DD) the poll's window opens."),
  rangeEnd: z
    .string()
    .regex(LOCAL_DATE)
    .describe(`Inclusive local calendar date (YYYY-MM-DD) the poll's window closes. At most ${MAX_RANGE_DAYS} days after rangeStart; must not be entirely in the past.`),
  deadlineUtc: z
    .string()
    .datetime({ offset: true })
    .describe("When responses close (ISO 8601, UTC). Must be at least 1 hour from now and no later than 23:59 on rangeEnd."),
  location: LocationInput.describe("How the booked meeting happens; set once by the organiser."),
  guestLink: z
    .boolean()
    .describe(
      "When true, also mint a shareable guest-join link that lets anyone holding the link self-identify and get their own response token. While the guest link is enabled the poll never auto-books (or escalates) early — it waits for its deadline even once all named invitees have responded, since guests may still join.",
    ),
});

const CreatePollResponse = z.object({
  id: z.string().describe("Poll id."),
  statusUrl: z.string().describe("The organiser's own read-only status page for this poll (GET /poll/{id}/status): roster, response grid, and top candidate slots. Carries an embedded capability token (query param `t`) so it opens directly in a browser; it also accepts the same bearer-token auth as this API. Expires poll deadline + 7 days grace, same window as invitee links."),
  guestUrl: z.string().optional().describe("Shareable guest-join link; present only when guestLink was true. Opens a public join form (name, email, Turnstile challenge) — submitting it does not return a URL or token. Instead it emails the submitter their own personal, tokenised poll link, the same way an originally-invited invitee gets theirs."),
});

const InviteeSummary = z.object({
  id: z.string().describe("Invitee id."),
  email: z.string().describe("Invitee's email address."),
  name: z.string().nullable().describe("Invitee's display name, or null if never given."),
  pseudonym: z.string().describe("Stable per-poll pseudonym, shown to OTHER invitees in place of their name when hideName is true."),
  hideName: z.boolean().describe("Whether this invitee asked to be shown as their pseudonym to other invitees. The organiser always sees the real name here regardless."),
  responded: z.boolean().describe("Whether this invitee has submitted a response at least once."),
  dropped: z.boolean().describe("Whether this invitee was removed from the required set via updateMeetingPoll's removeInviteeIds."),
});

const WeightSummary = z.object({
  inviteeId: z.string().describe("Invitee id this weight belongs to."),
  weight: z.number().describe("This invitee's weight for the candidate: 1.0 if free, 0.5 if covered only by if_needed."),
});

const CandidateSummary = z.object({
  slotStartUtc: z.string().describe("Candidate start instant (ISO 8601, UTC)."),
  score: z.number().describe("organiserFit x the product of every required invitee's weight. Higher is better."),
  organiserFit: z.number().describe("Organiser fit-curve score for this slot, normalised to [0,1] (higher better)."),
  weights: z.array(WeightSummary).describe("Per-required-invitee weight contributing to score."),
});

const GetPollResponse = z.object({
  id: z.string().describe("Poll id."),
  title: z.string().describe("Poll title."),
  durationMin: z.number().describe("Meeting length in minutes."),
  rangeStart: z.string().describe("Inclusive local date the poll's window opens."),
  rangeEnd: z.string().describe("Inclusive local date the poll's window closes."),
  deadlineUtc: z.string().describe("When responses close (ISO 8601, UTC)."),
  location: LocationInput.describe("The organiser-set location."),
  status: z.enum(["open", "booked", "cancelled", "needs_attention"]).describe("Current poll state."),
  bookedSlotUtc: z.string().nullable().describe("The booked slot's start (ISO 8601, UTC), once booked; else null."),
  gcalEventId: z.string().nullable().describe("The created calendar event id, once booked; else null."),
  invitees: z.array(InviteeSummary).describe("Every invited or guest-joined attendee."),
  candidates: z
    .array(CandidateSummary)
    .describe(
      "Slots that currently qualify for every non-dropped invitee, ranked best-first with the full score breakdown, capped at the top 20 by score (see `intersection.qualifyingCount` for the total). Always empty once the poll is booked or cancelled.",
    ),
  intersection: z
    .object({
      allIn: z.boolean().describe("Whether every non-dropped invitee has responded at least once. Always false once the poll is booked or cancelled — it is not recomputed for terminal polls."),
      qualifyingCount: z.number().describe("TOTAL number of candidate slots that currently qualify for every non-dropped invitee — not capped like `candidates` (which lists at most the top 20). Always 0 once the poll is booked or cancelled — it is not recomputed for terminal polls."),
    })
    .describe("Summary of whether/how well the current responses intersect."),
});

const NudgeResponse = z.object({
  nudged: z.array(z.string()).describe("Emails of the non-responders a nudge was just sent to."),
  respondedCount: z.number().describe("Non-dropped invitees who have responded at least once, as of this nudge."),
  totalCount: z.number().describe("Total non-dropped invitees, as of this nudge."),
});

const CancelResponse = z.object({
  id: z.string().describe("Poll id."),
  status: z
    .literal("cancelled")
    .describe("The poll's new status. Every non-dropped invitee (invited and guest kinds, hidden included) is emailed a cancellation notice."),
});

const ResolveBody = z
  .discriminatedUnion("action", [
    z.object({
      action: z.literal("book").describe("Book a specific slot now, overriding the normal all-in/deadline triggers."),
      slotStartUtc: z
        .string()
        .datetime({ offset: true })
        .describe(
          "The slot to book (ISO 8601, UTC). Must currently be one of the organiser's bookable starts for this poll's duration/range — matched by instant, so any valid ISO-8601 rendering of an equal instant is accepted (e.g. with or without milliseconds).",
        ),
    }),
    z.object({
      action: z.literal("bookBest").describe(
        "Book the best slot right now for whoever has responded so far, without picking a slot yourself. Ranks candidates against exactly the same required set bookAtDeadline uses at the deadline (non-dropped invitees with at least one response) — non-responders are ranked out but still invited to the booked event, same as every other non-dropped invitee. Works pre-deadline and on a needs_attention poll (a rescue, like `book`); ignores the guest-link \"wait for the deadline\" guard, same override posture as `book`. On failure (no qualifying slot yet, a concurrent booking already claimed the poll, or the calendar provider was unreachable — for either a read or a write) the poll's status is left exactly as found — never escalated to needs_attention, even on needs_attention already — so a live guest-join link and future auto-book both stay intact; retry once more invitees respond.",
      ),
    }),
  ])
  .describe(
    "One escalation action, chosen by `action`: book a specific slot now, or book the best slot now for whoever has responded so far. Editing the poll itself — title, location, invitees, deadline, guest link — is updateMeetingPoll (PATCH), not this endpoint.",
  );

// ── PATCH /polls/{id} (updateMeetingPoll) ───────────────────────────────────

const UpdatePollBody = z
  .object({
    title: z.string().min(1).max(200).optional().describe("New poll title. Omit to leave unchanged. Never emailed — invitees see it on their next page load."),
    location: LocationInput.optional().describe(
      "Whole-object replace of the organiser-set location. Never emailed — location surfaces only at booking time (the booked event and booking-notice emails), so anyone reaching a booking sees the new value automatically.",
    ),
    deadlineUtc: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe(
        "New deadline (ISO 8601, UTC). Must be strictly after the current deadline, at least 1 hour from now, and no later than 23:59 on the poll's rangeEnd. Rotates and emails every non-dropped invitee EXCEPT ones added/restored in this same call (their invite already carries the new deadline). Also reopens a poll stuck in needs_attention.",
      ),
    addInvitees: z
      .array(InviteeInput)
      .optional()
      .describe(
        "Invitees to add. An email matching an existing non-dropped invitee is rejected (duplicate_invitee) unless that same invitee is also being removed in this call (removals apply first, so that's a deliberate re-invite instead); matching a dropped invitee restores that row (fresh token, invite email, old painted cells retained) — a supplied name updates the stored name, omit it to keep the existing one. Each new or restored invitee gets exactly one invite email; nobody else is emailed. The post-patch non-dropped invitee count must stay at or below 20 (too_many_invitees).",
      ),
    removeInviteeIds: z
      .array(z.string())
      .optional()
      .describe(
        "Invitee ids to remove from the required set. An unknown id 404s (invitee_not_found); an already-dropped id is an idempotent no-op (no email). The removed invitee gets exactly one polite removal notice; nobody else is emailed. If this actually drops a row (and it isn't immediately restored via addInvitees in the same call), an all-in booking re-attempt fires once at the end.",
      ),
    guestLink: z
      .boolean()
      .optional()
      .describe(
        "Enable or disable the guest-join link. Enabling when already enabled, or disabling when already disabled, is a no-op. Enabling mints a NEW link and returns it as `guestUrl` in the response (an existing link's raw token is unrecoverable from its stored hash — disable then enable to rotate). Disabling lifts the guest-link \"wait for the deadline\" guard and fires an all-in booking re-attempt.",
      ),
  })
  .describe(
    "Edit an open or escalated poll: change title/location, add/remove invitees, extend the deadline, and/or toggle the guest-join link, all in one call. Every field is optional but at least one must be supplied (else 400 no_changes). Validation is all-or-nothing: every supplied field is checked before any write. Apply order: removals -> additions/restores -> title/location/guestLink -> deadline (deadline last so invite emails for added/restored invitees render the final deadline). Booked/cancelled polls cannot be edited (409 invalid_status). The organiser is never emailed by this endpoint.",
  );

const UpdatePollResponse = z.object({
  id: z.string().describe("Poll id."),
  status: z
    .enum(["open", "booked", "cancelled", "needs_attention"])
    .describe("Poll status after applying the update (re-read, so a removal or guest-link disable that triggered an all-in booking is reflected here)."),
  title: z.string().describe("Poll title after applying the update."),
  deadlineUtc: z.string().describe("Deadline after applying the update."),
  location: LocationInput.describe("Location after applying the update."),
  bookedSlotUtc: z.string().nullable().describe("Booked slot start (ISO 8601, UTC), if a removal or guest-link disable just triggered a booking; else null."),
  gcalEventId: z.string().nullable().describe("Created calendar event id, under the same condition as bookedSlotUtc; else null."),
  invitees: z.array(InviteeSummary).describe("Every invited or guest-joined attendee, after applying the update."),
  guestUrl: z
    .string()
    .optional()
    .describe("Shareable guest-join link — present ONLY when this call newly enabled the guest link (enabling an already-enabled link cannot return it; disable-then-enable rotates it)."),
});

const ResolveResponse = z.object({
  id: z.string().describe("Poll id."),
  status: z.enum(["open", "booked", "cancelled", "needs_attention"]).describe("Poll status after applying the action."),
  bookedSlotUtc: z.string().nullable().describe("Booked slot start, if the action resulted in a booking; else null."),
  gcalEventId: z.string().nullable().describe("Created calendar event id, if the action resulted in a booking; else null."),
  deadlineUtc: z.string().describe("Current deadline after applying the action."),
});

const errs404 = {
  404: { content: { "application/json": { schema: ErrorResponse } }, description: "No such poll for this caller" },
} as const;

// The auth+flag gate (mountMeetingPollRoutes's `gate`) runs as middleware,
// outside createRoute's typed `responses` — so these are real behaviours
// that would otherwise appear nowhere in the generated OpenAPI/MCP tool
// definitions. Mirrors handlers/booking-page.ts's `errs`.
const errsAuth = {
  401: { content: { "application/json": { schema: ErrorResponse } }, description: "Missing or invalid bearer token." },
  403: { content: { "application/json": { schema: ErrorResponse } }, description: "MEETING_POLL_ENABLED is not enabled for this deployment." },
} as const;

// ── Routes ───────────────────────────────────────────────────────────────

export function mountMeetingPollRoutes(v1: OpenAPIHono<{ Bindings: Env; Variables: AppVariables }>) {
  // Auth and the feature flag are checked before @hono/zod-openapi's built-in
  // body/query validator runs, mirroring handlers/booking-page.ts's gate
  // exactly (same reasoning: a disabled-flag or unauthenticated request with
  // an invalid body must get 401/403, not 400). Every /polls path — with or
  // without a sub-path — goes through this gate.
  const gate = async (c: Parameters<typeof requireOwner>[0], next: () => Promise<void>) => {
    const owner = await requireOwner(c);
    if (owner instanceof Response) return owner;
    if (c.env.MEETING_POLL_ENABLED !== "true") return c.json({ error: "feature_disabled" }, 403);
    await next();
    return;
  };
  v1.use("/polls", gate);
  v1.use("/polls/*", gate);

  const createRouteDef = createRoute({
    method: "post",
    path: "/polls",
    operationId: "createMeetingPoll",
    tags: ["polls"],
    summary: "Create a meeting poll",
    description:
      "Create a meeting poll: invitees paint availability over an open date range; optical books the best mutual slot automatically once everyone responds (or at the deadline). Sends each invitee a personal, tokenised link.",
    security: [{ BearerAuth: [] }],
    request: { body: { content: { "application/json": { schema: CreatePollBody } } } },
    responses: {
      201: { content: { "application/json": { schema: CreatePollResponse } }, description: "Poll created; invites sent." },
      400: { content: { "application/json": { schema: ErrorResponse } }, description: "Validation error." },
      ...errsAuth,
    },
  });
  v1.openapi(createRouteDef, async (c) => {
    const owner = c.var.ownerSubject!; // set by the scoped requireOwner gate above
    const env = c.env;
    const db = env.DB;
    const body = c.req.valid("json");
    const now = new Date();

    let invitees: { email: string; name: string | null }[];
    try {
      invitees = normaliseInvitees(body.invitees);
      validateRange(body.rangeStart, body.rangeEnd, now);
      validateDeadline(body.deadlineUtc, body.rangeEnd, now);
      validatePollLocation(body.location);
    } catch (err) {
      if (err instanceof ValidationError) return c.json({ error: err.code, detail: err.message }, 400);
      throw err;
    }

    const location = { kind: body.location.kind, detail: (body.location.detail ?? "").trim() || null };

    let guestToken: string | null = null;
    let guestTokenHash: string | null = null;
    if (body.guestLink) {
      guestToken = generateOpaqueToken();
      guestTokenHash = await hashToken(guestToken, hashingKey(env));
    }

    const poll = await createPoll(db, {
      subject: owner,
      title: body.title,
      durationMin: body.durationMin,
      rangeStart: body.rangeStart,
      rangeEnd: body.rangeEnd,
      deadlineUtc: body.deadlineUtc,
      location,
      guestTokenHash,
      now: now.toISOString(),
    });

    const taken = new Set<string>();
    // R4-H1: production never sets c.var.notificationProvider (only test
    // middleware does) — mirrors the established fallback idiom at
    // replan-now.ts:50 / admin/run-cron-route.ts:20.
    const notification = c.var.notificationProvider ?? await defaultNotificationProvider(env, owner);
    for (const inv of invitees) {
      const inviteeId = newInviteeId();
      const pseudonym = mintPseudonym(taken);
      taken.add(pseudonym);
      const { token, tokenHash } = await mintInviteeToken(env, poll.id, inviteeId, owner, body.deadlineUtc, now);
      await insertInvitee(db, {
        id: inviteeId,
        pollId: poll.id,
        email: inv.email,
        name: inv.name,
        kind: "invited",
        tokenHash,
        pseudonym,
        now: now.toISOString(),
      });
      const inviteeUrl = inviteeUrlFor(env, poll.id, token);
      const content = renderInviteEmail({
        pollTitle: body.title,
        organiserName: owner,
        durationMin: body.durationMin,
        rangeStart: body.rangeStart,
        rangeEnd: body.rangeEnd,
        deadlineUtc: body.deadlineUtc,
        inviteeUrl,
      });
      try {
        await notification.sendPollEmail({ to: inv.email, ...content });
      } catch (err) {
        // Non-fatal (matches the extendDeadline/R1-F4 posture): the poll +
        // invitees are already committed by this point, and unlike
        // extendDeadline there is no natural retry at all here — a caller
        // retrying create() on a 500 would mint a DUPLICATE poll and
        // re-email everyone who already got an invite. The deadline-24h
        // cron nudge partially self-heals; a manual nudge is the organiser's
        // immediate remedy once they have the poll id (from statusUrl,
        // returned below regardless of this failure). Log by invitee id,
        // never the address (R1-F6).
        console.error(`poll ${poll.id}: invite email to invitee ${inviteeId} failed:`, String(err));
      }
    }

    const statusToken = await mintStatusToken(env, poll.id, owner, body.deadlineUtc, now);
    const statusUrl = statusUrlFor(env, poll.id, statusToken);
    const guestUrl = guestToken ? `${env.OAUTH_ISSUER}/poll/${poll.id}?g=${encodeURIComponent(guestToken)}` : undefined;
    return c.json({ id: poll.id, statusUrl, guestUrl }, 201);
  });

  // ── GET /polls/{id} ────────────────────────────────────────────────────

  const getRouteDef = createRoute({
    method: "get",
    path: "/polls/{id}",
    operationId: "getMeetingPoll",
    tags: ["polls"],
    summary: "Full status of a meeting poll",
    description: "Full poll status: every invitee's response state, and — while open — the current best candidate slots with the full score breakdown (organiser fit x per-invitee weights) and intersection health.",
    security: [{ BearerAuth: [] }],
    request: { params: z.object({ id: z.string().describe("Poll id.") }) },
    responses: {
      200: { content: { "application/json": { schema: GetPollResponse } }, description: "Poll status." },
      ...errs404,
      ...errsAuth,
    },
  });
  v1.openapi(getRouteDef, async (c) => {
    const owner = c.var.ownerSubject!; // set by the scoped requireOwner gate above
    const env = c.env;
    const db = env.DB;
    const { id } = c.req.valid("param");
    const poll = await getPollForSubject(db, owner, id);
    // `as any`: hono/zod-openapi's typed-response union isn't distributive
    // over a Promise<A|B> return (v0.19.10 typing issue, same as
    // handlers/plans.ts's `owner instanceof Response` casts) — an untyped
    // early return here is what keeps the final, precisely-typed success
    // return checkable against its schema.
    if (!poll) return c.json({ error: "not_found" }, 404) as any;

    const invitees = await listInvitees(db, poll.id);
    const inviteeSummaries = invitees.map((i) => ({
      id: i.id,
      email: i.email,
      name: i.name,
      pseudonym: i.pseudonym,
      hideName: i.hideName,
      responded: i.respondedAt !== null,
      dropped: i.dropped,
    }));

    let candidates: CandidateScore[] = [];
    let qualifyingCount = 0;
    let allIn = false;
    if (poll.status === "open" || poll.status === "needs_attention") {
      const cal = c.var.calendarProvider ?? await defaultCalendarProvider(env, owner);
      const ranking = await rankPollCandidates(env, db, cal, owner, poll, new Date());
      // L5: a long (up to 6-week) poll range can produce hundreds of
      // qualifying slots — cap what's returned to the top MAX_POLL_CANDIDATES
      // by score (already best-first from rankCandidates), but keep
      // qualifyingCount as the TOTAL so the organiser isn't told there are
      // only 20 options when there are actually more.
      qualifyingCount = ranking.candidates.length;
      candidates = ranking.candidates.slice(0, MAX_POLL_CANDIDATES);
      allIn = ranking.allIn;
    }

    const location = poll.location as { kind: string; detail: string | null };
    return c.json(
      {
        id: poll.id,
        title: poll.title,
        durationMin: poll.durationMin,
        rangeStart: poll.rangeStart,
        rangeEnd: poll.rangeEnd,
        deadlineUtc: poll.deadlineUtc,
        location,
        status: poll.status,
        bookedSlotUtc: poll.bookedSlotUtc,
        gcalEventId: poll.gcalEventId,
        invitees: inviteeSummaries,
        candidates,
        intersection: { allIn, qualifyingCount },
      } as z.infer<typeof GetPollResponse>,
      200,
    );
  });

  // ── POST /polls/{id}/nudge ─────────────────────────────────────────────

  const nudgeRouteDef = createRoute({
    method: "post",
    path: "/polls/{id}/nudge",
    operationId: "nudgeMeetingPoll",
    tags: ["polls"],
    summary: "Manually nudge non-responders",
    description: "Send a reminder email, right now, to every non-dropped invitee who hasn't responded yet. Independent of the automatic deadline/midpoint nudges the cron sweep sends.",
    security: [{ BearerAuth: [] }],
    request: { params: z.object({ id: z.string().describe("Poll id.") }) },
    responses: {
      200: { content: { "application/json": { schema: NudgeResponse } }, description: "Nudge sent." },
      409: { content: { "application/json": { schema: ErrorResponse } }, description: "Poll is not open (booked, cancelled, or needs_attention)." },
      ...errs404,
      ...errsAuth,
    },
  });
  v1.openapi(nudgeRouteDef, async (c) => {
    const owner = c.var.ownerSubject!; // set by the scoped requireOwner gate above
    const env = c.env;
    const db = env.DB;
    const { id } = c.req.valid("param");
    const poll = await getPollForSubject(db, owner, id);
    if (!poll) return c.json({ error: "not_found" }, 404) as any; // see getMeetingPoll's comment
    // Guarded to open-only (decision D4 / M5). A needs_attention poll's grid is
    // now live (Card B unlocked it for invitee edits), so this is no longer
    // about the link opening a dead page — the gate stays for reasons that
    // still hold: (a) nudge only emails non-responders, and an escalated
    // poll typically has none left to chase; (b) nudge rotates each
    // non-responder's token (setInviteeTokenHash below), which would kill
    // the very links the escalation email now tells the organiser still
    // work; (c) the sanctioned way to re-open/re-deliver on an escalated
    // poll is updateMeetingPoll's deadlineUtc arm, not nudge. booked/
    // cancelled must obviously not still email "please respond" either.
    if (poll.status !== "open") {
      return c.json({ error: "invalid_status", detail: `poll is ${poll.status}` }, 409) as any;
    }

    const invitees = (await listInvitees(db, poll.id)).filter((i) => !i.dropped);
    const respondedCount = invitees.filter((i) => i.respondedAt !== null).length;
    const totalCount = invitees.length;
    const nonResponders = invitees.filter((i) => i.respondedAt === null);

    const now = new Date();
    // R4-H1: production never sets c.var.notificationProvider (only test
    // middleware does) — mirrors the established fallback idiom at
    // replan-now.ts:50 / admin/run-cron-route.ts:20.
    const notification = c.var.notificationProvider ?? await defaultNotificationProvider(env, owner);
    const nudged: string[] = [];
    for (const inv of nonResponders) {
      const { token, tokenHash } = await mintInviteeToken(env, poll.id, inv.id, owner, poll.deadlineUtc, now);
      await setInviteeTokenHash(db, inv.id, tokenHash);
      const inviteeUrl = inviteeUrlFor(env, poll.id, token);
      const content = renderNudgeEmail({
        pollTitle: poll.title,
        organiserName: owner,
        durationMin: poll.durationMin,
        rangeStart: poll.rangeStart,
        rangeEnd: poll.rangeEnd,
        deadlineUtc: poll.deadlineUtc,
        inviteeUrl,
        respondedCount,
        totalCount,
      });
      await notification.sendPollEmail({ to: inv.email, ...content });
      nudged.push(inv.email);
    }

    return c.json({ nudged, respondedCount, totalCount }, 200);
  });

  // ── POST /polls/{id}/cancel ─────────────────────────────────────────────

  const cancelRouteDef = createRoute({
    method: "post",
    path: "/polls/{id}/cancel",
    operationId: "cancelMeetingPoll",
    tags: ["polls"],
    summary: "Cancel a meeting poll",
    description:
      "Cancel an open or escalated poll. Does not delete any data. A poll that is already booked or cancelled cannot be cancelled again. Every non-dropped invitee (invited and guest kinds, hidden included) is emailed a cancellation notice — the email is private per recipient, never a shared/BCC send.",
    security: [{ BearerAuth: [] }],
    request: { params: z.object({ id: z.string().describe("Poll id.") }) },
    responses: {
      200: { content: { "application/json": { schema: CancelResponse } }, description: "Poll cancelled." },
      409: {
        content: { "application/json": { schema: ErrorResponse } },
        description:
          "Poll is already booked or cancelled — either it already was when this call was made, or (CAS) a booking landed concurrently between the read and this call's own write.",
      },
      ...errs404,
      ...errsAuth,
    },
  });
  v1.openapi(cancelRouteDef, async (c) => {
    const owner = c.var.ownerSubject!; // set by the scoped requireOwner gate above
    const env = c.env;
    const db = env.DB;
    const { id } = c.req.valid("param");
    const poll = await getPollForSubject(db, owner, id);
    if (!poll) return c.json({ error: "not_found" }, 404) as any; // see getMeetingPoll's comment
    if (poll.status === "booked" || poll.status === "cancelled") {
      return c.json({ error: "invalid_status", detail: `poll is ${poll.status}` }, 409) as any;
    }
    // CAS, not a blind write: a concurrent casSetBooked (cron bookAtDeadline
    // or the all-in path) can land between the getPollForSubject read above
    // and this write. A blind UPDATE would clobber a just-booked poll back
    // to 'cancelled' — the calendar event would stay live (booking.ts's
    // compensation only fires when a booking CAS itself loses, not when a
    // later cancel overwrites a won one) — and the loop below would email
    // every invitee a false "no meeting will be booked" broadcast.
    // ["open", "needs_attention"] mirrors booking.ts's (unexported)
    // BOOKABLE_STATUSES.
    const moved = await casSetPollStatus(db, poll.id, "cancelled", ["open", "needs_attention"], new Date().toISOString());
    if (!moved) {
      return c.json({ error: "invalid_status", detail: "poll was booked or cancelled concurrently" }, 409) as any;
    }

    // Every non-dropped invitee — invited AND guest kinds, hidden included —
    // gets a private, per-recipient cancellation email (not a shared/BCC
    // send: hidden invitees' addresses must never leak to anyone else). A
    // dropped invitee was already told (implicitly, by losing access) they
    // are out of the required set, so they get nothing here.
    const invitees = (await listInvitees(db, poll.id)).filter((i) => !i.dropped);
    // R4-H1: production never sets c.var.notificationProvider (only test
    // middleware does) — mirrors the established fallback idiom at
    // replan-now.ts:50 / admin/run-cron-route.ts:20.
    const notification = c.var.notificationProvider ?? await defaultNotificationProvider(env, owner);
    const content = renderPollCancelledEmail({
      pollTitle: poll.title,
      organiserName: owner,
      durationMin: poll.durationMin,
      rangeStart: poll.rangeStart,
      rangeEnd: poll.rangeEnd,
    });
    for (const inv of invitees) {
      try {
        await notification.sendPollEmail({ to: inv.email, ...content });
      } catch (err) {
        // Non-fatal (matches the invite/deadline-extended posture):
        // the poll is already cancelled by this point, and a send failure
        // for one invitee must not stop the rest from being notified. Log
        // by invitee id, never the address (R1-F6).
        console.error(`poll ${poll.id}: cancellation email to invitee ${inv.id} failed:`, String(err));
      }
    }

    return c.json({ id: poll.id, status: "cancelled" as const }, 200);
  });

  // ── POST /polls/{id}/resolve ────────────────────────────────────────────

  const resolveRouteDef = createRoute({
    method: "post",
    path: "/polls/{id}/resolve",
    operationId: "resolveMeetingPoll",
    tags: ["polls"],
    summary: "Resolve a stuck (or not-yet-stuck) meeting poll",
    description:
      "Escalation actions: book a specific slot now (override), or book the best slot now for whoever has responded so far (bookBest — no slot picking, no escalation on failure). To edit the poll itself — title, location, invitees, deadline, guest link — use updateMeetingPoll (PATCH) instead.",
    security: [{ BearerAuth: [] }],
    request: {
      params: z.object({ id: z.string().describe("Poll id.") }),
      body: { content: { "application/json": { schema: ResolveBody } } },
    },
    responses: {
      200: { content: { "application/json": { schema: ResolveResponse } }, description: "Action applied." },
      400: {
        content: { "application/json": { schema: ErrorResponse } },
        description: "Invalid action for current state, or (bookBest) no invitee has responded yet (`no_responders`).",
      },
      409: {
        content: { "application/json": { schema: ErrorResponse } },
        description: "Poll is already booked or cancelled, or (bookBest) no qualifying slot / the poll was already claimed by a concurrent booking (`book_failed`).",
      },
      404: errs404[404],
      502: {
        content: { "application/json": { schema: ErrorResponse } },
        description:
          "The calendar provider was unreachable. For `book`, this is always a read failure while re-checking candidates. For `bookBest`, it can be either a read failure computing candidates, or a write failure creating the booked event — `bookBest` aborts on the FIRST such write failure rather than retrying every remaining ranked candidate.",
      },
      ...errsAuth,
    },
  });
  v1.openapi(resolveRouteDef, async (c) => {
    const owner = c.var.ownerSubject!; // set by the scoped requireOwner gate above
    const env = c.env;
    const db = env.DB;
    const { id } = c.req.valid("param");
    const poll = await getPollForSubject(db, owner, id);
    if (!poll) return c.json({ error: "not_found" }, 404) as any; // see getMeetingPoll's comment
    const body = c.req.valid("json");

    if (poll.status === "booked" || poll.status === "cancelled") {
      return c.json({ error: "invalid_status", detail: `poll is ${poll.status}` }, 409) as any;
    }

    if (body.action === "book") {
      const cal = c.var.calendarProvider ?? await defaultCalendarProvider(env, owner);
      const now = new Date();
      let ranking: PollRanking;
      try {
        ranking = await rankPollCandidates(env, db, cal, owner, poll, now);
      } catch (err) {
        console.error(`poll ${poll.id} resolve-book candidate ranking failed:`, String(err));
        return c.json({ error: "calendar_unavailable" }, 502) as any;
      }
      // Compare by epoch, not exact string: the feasible list stores the
      // canonical "...000Z" rendering, but a caller may send any equal
      // instant in a different valid ISO-8601 rendering (e.g. no
      // milliseconds). Bind to the CANONICAL feasible-list entry — that's
      // what bookPollSlot and the response must carry, since downstream code
      // and the calendar event need to see the same string the ranking/
      // grid/booking paths already agree on.
      const targetMs = Date.parse(body.slotStartUtc);
      const canonicalSlot = ranking.organiserFeasible.find((s) => Date.parse(s) === targetMs);
      if (canonicalSlot === undefined) {
        return c.json({ error: "invalid_slot", detail: "slotStartUtc is not currently one of the organiser's bookable starts" }, 400) as any;
      }
      const outcome = await (await pollBookingEngine()).bookPollSlot(env, poll.id, canonicalSlot);
      if (!outcome.ok) return c.json({ error: "book_failed", detail: outcome.reason }, 409) as any;
      return c.json(
        { id: poll.id, status: "booked" as const, bookedSlotUtc: canonicalSlot, gcalEventId: outcome.eventId, deadlineUtc: poll.deadlineUtc },
        200,
      );
    }

    if (body.action === "bookBest") {
      const outcome = await (await pollBookingEngine()).bookBestNow(env, poll.id);
      if (outcome.ok) {
        return c.json(
          { id: poll.id, status: "booked" as const, bookedSlotUtc: outcome.slotStartUtc, gcalEventId: outcome.eventId, deadlineUtc: poll.deadlineUtc },
          200,
        );
      }
      switch (outcome.reason) {
        case "no_responders":
          return c.json({ error: "no_responders", detail: "no invitee has responded yet" }, 400) as any;
        case "calendar_unavailable":
          return c.json({ error: "calendar_unavailable" }, 502) as any;
        case "poll_not_found":
          return c.json({ error: "not_found" }, 404) as any;
        case "poll_not_actionable":
          // Race past the top-of-handler pre-check above (poll was booked/
          // cancelled between that read and the engine call).
          return c.json({ error: "invalid_status", detail: "poll is booked or cancelled" }, 409) as any;
        case "no_qualifying_slot":
        case "poll_already_claimed":
          return c.json({ error: "book_failed", detail: outcome.reason }, 409) as any;
      }
    }

    // Unreachable: ResolveBody's discriminated union only has "book" and
    // "bookBest" members, and both if-blocks above return in every branch
    // (bookBest's switch covers every BookBestOutcome failure reason). This
    // return exists purely so the handler's inferred return type stays
    // `Response` rather than `Response | undefined`.
    throw new Error("resolveMeetingPoll: unreachable — no action branch returned");
  });

  // ── PATCH /polls/{id} (updateMeetingPoll) ────────────────────────────────

  const updateRouteDef = createRoute({
    method: "patch",
    path: "/polls/{id}",
    operationId: "updateMeetingPoll",
    tags: ["polls"],
    summary: "Edit a meeting poll",
    description:
      "Edit an open or escalated poll: change title/location, add/remove invitees, extend the deadline, and/or toggle the guest-join link, all in one call. Least-email principle throughout — only invitees materially affected by a given field are notified; see each field's own description. Validation is all-or-nothing, and every DB write commits before any email is sent.",
    security: [{ BearerAuth: [] }],
    request: {
      params: z.object({ id: z.string().describe("Poll id.") }),
      body: { content: { "application/json": { schema: UpdatePollBody } } },
    },
    responses: {
      200: { content: { "application/json": { schema: UpdatePollResponse } }, description: "Poll updated." },
      400: {
        content: { "application/json": { schema: ErrorResponse } },
        description: "Validation error: no_changes (empty body), invalid_location, invalid_deadline, duplicate_invitee, or too_many_invitees.",
      },
      // Own 404 entry rather than the shared errs404: unlike most other
      // routes, a 404 here can ALSO mean invitee_not_found — a poll that
      // exists and belongs to the caller, with an unknown removeInviteeIds id.
      404: {
        content: { "application/json": { schema: ErrorResponse } },
        description: "No such poll for this caller, or an unknown id in removeInviteeIds (invitee_not_found).",
      },
      409: {
        content: { "application/json": { schema: ErrorResponse } },
        description:
          "Poll is already booked or cancelled — either it already was when this call was made, or (deadlineUtc arm only) a booking landed concurrently between the read and this call's own CAS write.",
      },
      ...errsAuth,
    },
  });
  v1.openapi(updateRouteDef, async (c) => {
    const owner = c.var.ownerSubject!; // set by the scoped requireOwner gate above
    const env = c.env;
    const db = env.DB;
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const poll = await getPollForSubject(db, owner, id);
    if (!poll) return c.json({ error: "not_found" }, 404) as any; // see getMeetingPoll's comment
    if (poll.status === "booked" || poll.status === "cancelled") {
      return c.json({ error: "invalid_status", detail: `poll is ${poll.status}` }, 409) as any;
    }

    const hasChange =
      body.title !== undefined ||
      body.location !== undefined ||
      body.deadlineUtc !== undefined ||
      body.addInvitees !== undefined ||
      body.removeInviteeIds !== undefined ||
      body.guestLink !== undefined;
    if (!hasChange) {
      return c.json({ error: "no_changes", detail: "at least one field must be supplied" }, 400) as any;
    }

    const now = new Date();
    const currentInvitees = await listInvitees(db, poll.id);

    // ---- Validate-first, all-or-nothing: no write happens below this block
    // until every supplied field has been checked. ----
    let normalisedAdds: { email: string; name: string | null }[] = [];
    try {
      if (body.location !== undefined) validatePollLocation(body.location);
      if (body.deadlineUtc !== undefined) {
        if (Date.parse(body.deadlineUtc) <= Date.parse(poll.deadlineUtc)) {
          throw new ValidationError("invalid_deadline", "deadlineUtc must be strictly after the current deadline");
        }
        // Re-apply createMeetingPoll's own deadline/range invariant rather
        // than a second bespoke rule — see the historical extendDeadline
        // comment this replaces: without this, a PATCH could push the
        // deadline past rangeEnd (the exact instant create() rejects),
        // inverting the availability fetch window.
        validateDeadline(body.deadlineUtc, poll.rangeEnd, now);
      }
      if (body.addInvitees !== undefined) normalisedAdds = normaliseInvitees(body.addInvitees);
    } catch (err) {
      if (err instanceof ValidationError) return c.json({ error: err.code, detail: err.message }, 400) as any;
      throw err;
    }

    // Deduplicated: a caller-supplied duplicate id (e.g. accidental
    // double-submit) must apply exactly once — an un-deduplicated loop would
    // drop-then-drop-again (harmless) but ALSO email the removal notice and
    // fire the booking re-attempt twice for the same person.
    const removeIds = [...new Set(body.removeInviteeIds ?? [])];
    for (const rid of removeIds) {
      if (!currentInvitees.find((i) => i.id === rid)) return c.json({ error: "invitee_not_found" }, 404) as any;
    }

    // Simulate the FINAL dropped state (removals, then restores) purely to
    // validate duplicates/the invitee cap without writing anything yet.
    const droppedFinal = new Map<string, boolean>(currentInvitees.map((i) => [i.id, i.dropped]));
    for (const rid of removeIds) droppedFinal.set(rid, true);
    const emailToId = new Map(currentInvitees.map((i) => [i.email, i.id]));

    type AddPlanEntry =
      | { kind: "insert"; email: string; name: string | null }
      | { kind: "restore"; id: string; email: string; name: string | null };
    const addPlan: AddPlanEntry[] = [];
    let newCount = 0;
    for (const inv of normalisedAdds) {
      const existingId = emailToId.get(inv.email);
      if (existingId !== undefined) {
        if (droppedFinal.get(existingId) === false) {
          return c.json({ error: "duplicate_invitee", detail: `duplicate invitee email '${inv.email}'` }, 400) as any;
        }
        addPlan.push({ kind: "restore", id: existingId, email: inv.email, name: inv.name });
        droppedFinal.set(existingId, false);
      } else {
        addPlan.push({ kind: "insert", email: inv.email, name: inv.name });
        newCount += 1;
      }
    }
    const nonDroppedCount = [...droppedFinal.values()].filter((d) => !d).length + newCount;
    if (nonDroppedCount > 20) {
      return c.json({ error: "too_many_invitees", detail: `poll would have ${nonDroppedCount} non-dropped invitees, max 20` }, 400) as any;
    }

    // ---- Apply: removals -> additions/restores -> title/location/guestLink -> deadline. ----
    const finalDeadlineUtc = body.deadlineUtc ?? poll.deadlineUtc;
    const restoredIds = new Set(addPlan.filter((e) => e.kind === "restore").map((e) => e.id));

    // The deadlineUtc arm's CAS guard runs FIRST, before any other write —
    // not in its "natural" apply-order position at the end. A concurrent
    // booking (all-in or cron bookAtDeadline) can land between this
    // handler's initial read and this write; if the CAS were left until
    // after removals/additions/title/location/guestLink had already
    // committed, a 409 here would still leave those OTHER writes in place —
    // a renamed, re-rostered "booked" poll masquerading as an aborted
    // request. Running the CAS first means a 409 aborts with zero writes.
    // The deadline_utc write itself and clearPollEpisodeStamps stay in their
    // apply-order position at the end (deadline last, so invite emails for
    // added/restored invitees still render finalDeadlineUtc); ["open",
    // "needs_attention"] mirrors booking.ts's (unexported) BOOKABLE_STATUSES,
    // same as cancelMeetingPoll's CAS.
    if (body.deadlineUtc !== undefined) {
      const moved = await casSetPollStatus(db, poll.id, "open", ["open", "needs_attention"], now.toISOString());
      if (!moved) {
        return c.json({ error: "invalid_status", detail: "poll was booked or cancelled concurrently" }, 409) as any;
      }
    }

    // A removal that's immediately restored by addInvitees in the SAME call
    // nets out to "still on the poll" — the DB write still happens (removal
    // literally applies first, then the restore undoes it, per the apply
    // order), but neither the removal email nor the booking-reattempt
    // trigger should fire for a person who ends this call still invited;
    // they get the restore's invite email instead (a deliberate re-invite,
    // not a remove-then-re-add).
    const actuallyRemoved: PollInvitee[] = [];
    for (const rid of removeIds) {
      const target = currentInvitees.find((i) => i.id === rid)!;
      if (!target.dropped) {
        await dbDropInvitee(db, rid);
        if (!restoredIds.has(rid)) actuallyRemoved.push(target);
      }
    }

    const taken = new Set<string>(currentInvitees.map((i) => i.pseudonym));
    const addedOrRestoredIds = new Set<string>();
    const toInviteEmail: { inviteeId: string; email: string; url: string }[] = [];
    for (const entry of addPlan) {
      if (entry.kind === "insert") {
        const inviteeId = newInviteeId();
        const pseudonym = mintPseudonym(taken);
        taken.add(pseudonym);
        const { token, tokenHash } = await mintInviteeToken(env, poll.id, inviteeId, owner, finalDeadlineUtc, now);
        await insertInvitee(db, {
          id: inviteeId,
          pollId: poll.id,
          email: entry.email,
          name: entry.name,
          kind: "invited",
          tokenHash,
          pseudonym,
          now: now.toISOString(),
        });
        addedOrRestoredIds.add(inviteeId);
        toInviteEmail.push({ inviteeId, email: entry.email, url: inviteeUrlFor(env, poll.id, token) });
      } else {
        await restoreInvitee(db, entry.id);
        // A supplied name updates the stored one; omitting it (entry.name
        // null post-normalisation) keeps whatever name the row already had
        // — a restore must not silently blank out a name the organiser
        // never asked to change.
        if (entry.name !== null) await setInviteeName(db, entry.id, entry.name);
        const { token, tokenHash } = await mintInviteeToken(env, poll.id, entry.id, owner, finalDeadlineUtc, now);
        await setInviteeTokenHash(db, entry.id, tokenHash);
        addedOrRestoredIds.add(entry.id);
        toInviteEmail.push({ inviteeId: entry.id, email: entry.email, url: inviteeUrlFor(env, poll.id, token) });
      }
    }

    if (body.title !== undefined) await setPollTitle(db, poll.id, body.title);

    if (body.location !== undefined) {
      const location = { kind: body.location.kind, detail: (body.location.detail ?? "").trim() || null };
      await setPollLocation(db, poll.id, location);
    }

    let newGuestUrl: string | undefined;
    let guestLinkDisabled = false;
    if (body.guestLink === true && poll.guestTokenHash === null) {
      const guestToken = generateOpaqueToken();
      const guestTokenHash = await hashToken(guestToken, hashingKey(env));
      await setGuestTokenHash(db, poll.id, guestTokenHash);
      newGuestUrl = `${env.OAUTH_ISSUER}/poll/${poll.id}?g=${encodeURIComponent(guestToken)}`;
    } else if (body.guestLink === false && poll.guestTokenHash !== null) {
      await setGuestTokenHash(db, poll.id, null);
      guestLinkDisabled = true;
    }

    let deadlineExtended = false;
    if (body.deadlineUtc !== undefined) {
      // The CAS guard already ran above, first, before any other write — see
      // its own comment. By this point the poll is confirmed to have been
      // open/needs_attention (now set to 'open') at that check; setPollDeadline
      // and clearPollEpisodeStamps are plain writes with no status condition,
      // same posture as the old resolveMeetingPoll extendDeadline action.
      await setPollDeadline(db, poll.id, body.deadlineUtc);
      // A new deadline is a new response episode — see setPollDeadline's/
      // clearPollEpisodeStamps's own comments in db/polls.ts (Fix 3).
      await clearPollEpisodeStamps(db, poll.id);
      deadlineExtended = true;
    }

    // ---- Booking re-attempt: one best-effort call if a removal actually
    // dropped a row, or the guest-link wait-for-deadline guard just lifted. ----
    if (actuallyRemoved.length > 0 || guestLinkDisabled) {
      try {
        await (await pollBookingEngine()).maybeBookOnAllIn(env, poll.id);
      } catch {
        // Non-fatal, same posture as the old dropInvitee resolve action: the
        // poll stays open/needs_attention and a later trigger (response,
        // cron, another PATCH) tries again.
      }
    }

    // ---- Re-read for the response (reflects a booking that just landed). ----
    const finalPollRow = (await getPollForSubject(db, owner, poll.id)) ?? poll;
    const finalInvitees = await listInvitees(db, poll.id);

    // ---- Emails: all writes above are already committed; every send below
    // is best-effort and logged by invitee id, never the address (R1-F6). ----
    // R4-H1: production never sets c.var.notificationProvider (only test
    // middleware does) — mirrors the established fallback idiom at
    // replan-now.ts:50 / admin/run-cron-route.ts:20.
    const notification = c.var.notificationProvider ?? await defaultNotificationProvider(env, owner);

    for (const { inviteeId, email, url } of toInviteEmail) {
      const content = renderInviteEmail({
        pollTitle: finalPollRow.title,
        organiserName: owner,
        durationMin: finalPollRow.durationMin,
        rangeStart: finalPollRow.rangeStart,
        rangeEnd: finalPollRow.rangeEnd,
        deadlineUtc: finalDeadlineUtc,
        inviteeUrl: url,
      });
      try {
        await notification.sendPollEmail({ to: email, ...content });
      } catch (err) {
        console.error(`poll ${poll.id}: invite email to invitee ${inviteeId} failed:`, String(err));
      }
    }

    for (const removed of actuallyRemoved) {
      const content = renderInviteeRemovedEmail({
        pollTitle: finalPollRow.title,
        organiserName: owner,
        durationMin: finalPollRow.durationMin,
        rangeStart: finalPollRow.rangeStart,
        rangeEnd: finalPollRow.rangeEnd,
      });
      try {
        await notification.sendPollEmail({ to: removed.email, ...content });
      } catch (err) {
        console.error(`poll ${poll.id}: removal email to invitee ${removed.id} failed:`, String(err));
      }
    }

    if (deadlineExtended) {
      const toNotify = finalInvitees.filter((i) => !i.dropped && !addedOrRestoredIds.has(i.id));
      for (const inv of toNotify) {
        const { token, tokenHash } = await mintInviteeToken(env, poll.id, inv.id, owner, body.deadlineUtc!, now);
        await setInviteeTokenHash(db, inv.id, tokenHash);
        const inviteeUrl = inviteeUrlFor(env, poll.id, token);
        const content = renderDeadlineExtendedEmail({
          pollTitle: finalPollRow.title,
          organiserName: owner,
          durationMin: finalPollRow.durationMin,
          rangeStart: finalPollRow.rangeStart,
          rangeEnd: finalPollRow.rangeEnd,
          deadlineUtc: body.deadlineUtc!,
          inviteeUrl,
        });
        try {
          await notification.sendPollEmail({ to: inv.email, ...content });
        } catch (err) {
          console.error(`poll ${poll.id}: deadline-extended email to invitee ${inv.id} failed:`, String(err));
        }
      }
    }

    const inviteeSummaries = finalInvitees.map((i) => ({
      id: i.id,
      email: i.email,
      name: i.name,
      pseudonym: i.pseudonym,
      hideName: i.hideName,
      responded: i.respondedAt !== null,
      dropped: i.dropped,
    }));

    return c.json(
      {
        id: finalPollRow.id,
        status: finalPollRow.status,
        title: finalPollRow.title,
        deadlineUtc: finalPollRow.deadlineUtc,
        location: finalPollRow.location as { kind: string; detail: string | null },
        bookedSlotUtc: finalPollRow.bookedSlotUtc,
        gcalEventId: finalPollRow.gcalEventId,
        invitees: inviteeSummaries,
        guestUrl: newGuestUrl,
      } as z.infer<typeof UpdatePollResponse>,
      200,
    );
  });
}

export type { PollInvitee };
