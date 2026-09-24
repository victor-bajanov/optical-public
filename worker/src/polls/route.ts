import type { Hono } from "hono";
import type { Env } from "../env";
import type { AppVariables } from "../index-providers";
import { defaultCalendarProvider, defaultNotificationProvider } from "../index-providers";
import type { CalendarProvider } from "../providers/calendar-provider";
import type { NotificationProvider } from "../providers/notification-provider";
import { verifyCapabilityWithEnv, signCapabilityWithEnv } from "../auth/capability";
import { hashToken } from "../auth/tokens";
import { hashingKey } from "../auth/crypto-keys";
import {
  getPoll,
  getPollForSubject,
  getInviteeByTokenHash,
  insertInvitee,
  newInviteeId,
  listInvitees,
  replaceResponses,
  markResponded,
  setHideName,
  setInviteeName,
  setInviteeTokenHash,
  aggregateResponses,
  recordJoinAttempt,
  countRecentJoinAttempts,
  type Poll,
  type PollInvitee,
  type ResponseState,
} from "../db/polls";
import { mintPseudonym } from "./pseudonyms";
import { candidateStarts, paintableCells, CELL_MINUTES, type CandidateAvailabilityInput } from "./grid";
import { verifyTurnstile } from "../booking/turnstile";
import { loadBookingPage } from "../db/booking-page";
import { getHomeTz } from "../db/users";
import { loadBusinessHours, type BusinessHours } from "../db/business-hours";
import { loadPinnedTaskIds } from "../db/tasks";
import { taskIdOfEvent } from "../calendar-feed/build-busy-ics";
import { listBookings } from "../db/bookings";
import { readMeetingConfig } from "../meetings/config";
import { resolveBookableOverIds } from "../booking/bookable-over";
import { deriveBusyBlocks } from "../planning/busy-blocks";
import {
  renderPollPage,
  renderPollExpiredPage,
  renderPollJoinFormPage,
  renderPollJoinSentPage,
  renderPollJoinErrorPage,
  POLL_PAGE_CSP,
  POLL_JOIN_PAGE_CSP,
} from "./page";
import { renderInviteEmail, renderPollResponseSavedEmail } from "./emails";
import { POLL_CLIENT_JS, POLL_CLIENT_HASH } from "./poll-client-source.generated";
// The real booking engine (worker/src/polls/booking.ts) is T9's file.
// Imported statically as the default; tests override via
// __setMaybeBookOnAllInForTests rather than depending on its real behaviour.
import { maybeBookOnAllIn as defaultMaybeBookOnAllIn } from "./booking";
import { requireOwner } from "../middleware/owner-gate";
// rankPollCandidates is the SAME ranking walk getMeetingPoll uses — imported
// (not reimplemented) so the status page's top candidates equal that
// endpoint's by construction, never by two independently-maintained copies.
// Exported specifically for this import (orchestrator-authorized, one-word
// change) rather than duplicated locally.
import { rankPollCandidates } from "../handlers/polls";
import {
  renderPollStatusPage,
  type RosterEntry,
  type AggregateRow,
  type CandidateRow,
} from "../web/poll-status-page";

/** Fallback hours when neither the poll's owner nor the instance has a
 *  config_business_hours row — mirrors booking/availability.ts's own
 *  (unexported) FALLBACK_HOURS constant. Duplicated rather than imported: the
 *  guardrail on availability.ts is read-only (its exports, not its internals),
 *  and this constant isn't exported. Under-offering (fewer paintable cells) is
 *  the safe failure direction, same reasoning as the booking page. */
const POLL_FALLBACK_HOURS: BusinessHours = {
  days: ["mon", "tue", "wed", "thu", "fri"],
  start: "09:00",
  end: "17:00",
};

/** Injection seam for `maybeBookOnAllIn`, mirroring the
 *  `__setHandlersForTests` idiom already used by
 *  worker/src/cron/scheduled-entry.ts. Lets T7's tests assert the hook fires
 *  (or observe its absence) without depending on T9's real booking engine. */
type MaybeBookOnAllIn = (env: Env, pollId: string) => Promise<void>;
let injectedMaybeBookOnAllIn: MaybeBookOnAllIn | null = null;
export function __setMaybeBookOnAllInForTests(fn: MaybeBookOnAllIn | null): void {
  injectedMaybeBookOnAllIn = fn;
}

/** Fire-and-forget, error-isolated: a booking failure must never fail the
 *  response save that triggered it (card guardrail). */
async function fireMaybeBookOnAllIn(env: Env, pollId: string): Promise<void> {
  try {
    const fn = injectedMaybeBookOnAllIn ?? defaultMaybeBookOnAllIn;
    await fn(env, pollId);
  } catch (err) {
    console.error(`poll ${pollId}: maybeBookOnAllIn failed`, String(err));
  }
}

/** Fire-and-forget, error-isolated (T-notify): tells the organiser who just
 *  responded, whether it's their first response or a revision, and how many
 *  (non-dropped) invitees have now responded in total. The CALLER gates
 *  repeat saves with the RESPONSE_NOTIFY_COOLDOWN_MS quiet-period debounce
 *  (see that constant's comment) — this helper itself sends unconditionally,
 *  unlike fireMaybeBookOnAllIn which only
 *  fires once all responses are in. `respondedCount` is read fresh from the
 *  DB (not derived from the caller's own pre-save snapshot) so the just-
 *  saved invitee's respondedAt update is already reflected in the count. */
async function fireOrganiserResponseNotification(
  env: Env,
  notification: NotificationProvider,
  poll: Poll,
  respondentName: string,
  isFirstResponse: boolean,
): Promise<void> {
  try {
    const roster = await listInvitees(env.DB, poll.id);
    const nonDropped = roster.filter((i) => !i.dropped);
    const respondedCount = nonDropped.filter((i) => i.respondedAt !== null).length;
    const content = renderPollResponseSavedEmail({
      pollTitle: poll.title,
      respondentName,
      isFirstResponse,
      respondedCount,
      totalCount: nonDropped.length,
    });
    await notification.sendPollEmail({ to: poll.subject, ...content });
  } catch (err) {
    console.error(`poll ${poll.id}: organiser response notification failed`, String(err));
  }
}

function notFound(): Response {
  return new Response("Not Found", { status: 404 });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "X-Robots-Tag": "noindex" },
  });
}

/** `csp` defaults to POLL_PAGE_CSP (every invitee/expired page); the guest-
 *  join form and its POST handler's HTML responses pass POLL_JOIN_PAGE_CSP
 *  instead — the one poll page that loads Turnstile and does a real
 *  navigation form POST. */
function htmlHeaders(csp: string = POLL_PAGE_CSP): HeadersInit {
  return {
    "content-type": "text/html; charset=utf-8",
    // The shell names the content-hashed client asset; see booking/route.ts's
    // identical comment for why this must never be cached.
    "cache-control": "no-cache",
    "X-Robots-Tag": "noindex",
    "Content-Security-Policy": csp,
    "X-Frame-Options": "DENY",
  };
}

function flagOn(env: Env): boolean {
  return env.MEETING_POLL_ENABLED === "true";
}

/** Verify a presented invitee token end-to-end: signature + expiry (via
 *  verifyCapabilityWithEnv), purpose + poll-id binding (narrowing the
 *  claims union), AND that its hash still matches the invitee row's
 *  token_hash — the re-issue-invalidation check from the plan's dev-gotcha
 *  note. A token that verifies structurally but was superseded by a re-issued
 *  one (T8's resolveMeetingPoll flows, out of this file's scope) must stop
 *  working the moment the new one is minted; comparing against the CURRENT
 *  stored hash is what makes that true. Returns null for every failure mode
 *  uniformly — callers must not distinguish "wrong poll" from "dropped" from
 *  "tampered signature" in what they show the caller (IDOR / info-leak
 *  guardrail). */
async function resolveInvitee(
  env: Env,
  db: D1Database,
  pollId: string,
  token: string,
): Promise<{ poll: Poll; invitee: PollInvitee } | null> {
  if (!token) return null;
  const claims = await verifyCapabilityWithEnv(token, env);
  if (!claims || claims.purpose !== "poll-response" || claims.pollId !== pollId) return null;
  const tokenHash = await hashToken(token, hashingKey(env));
  const invitee = await getInviteeByTokenHash(db, pollId, tokenHash);
  if (!invitee || invitee.dropped || invitee.id !== claims.inviteeId) return null;
  const poll = await getPoll(db, pollId);
  if (!poll || poll.subject !== claims.subject) return null;
  return { poll, invitee };
}

/** Verifies a presented STATUS token end-to-end: signature + expiry
 *  (verifyCapabilityWithEnv), purpose + pollId binding, AND that the claimed
 *  subject actually owns this poll (getPollForSubject — the same ownership
 *  check the requireOwner/bearer path uses below, so both auth paths on GET
 *  /poll/:id/status enforce identically; the DB is the source of truth, not
 *  just the token's own claims). Returns null uniformly for every failure
 *  mode — same "no oracle" reasoning as resolveInvitee: a wrong-poll token,
 *  a wrong-subject token, an INVITEE token presented here, and a tampered
 *  signature must all read the same to the caller.
 *
 *  Deliberately separate from resolveInvitee rather than folded in: this is
 *  an ORGANISER credential (one subject, no inviteeId, grants the full
 *  real-names status view), not an invitee one — conflating the two shapes
 *  would make it easy to get the security-relevant checks backwards. */
async function resolveStatusToken(
  env: Env,
  db: D1Database,
  pollId: string,
  token: string,
): Promise<Poll | null> {
  if (!token) return null;
  const claims = await verifyCapabilityWithEnv(token, env);
  if (!claims || claims.purpose !== "poll-status" || claims.pollId !== pollId) return null;
  return getPollForSubject(db, claims.subject, pollId);
}

/** Assembles the {tz, hours, busy} triple `grid.ts`'s `candidateStarts` needs,
 *  the same pieces `booking/availability.ts`'s `computeAvailability` builds
 *  internally — but sized to the POLL's own [range_start, range_end], not the
 *  owner's booking-page horizon_days. A poll's range (up to ~6 weeks per T8's
 *  validation) can run past a shorter booking-page horizon, and unlike
 *  computeAvailability this caller controls the fetch/horizon window
 *  directly, which is exactly why grid.ts's candidateStarts derives its own
 *  horizonDays from the poll range rather than trusting a caller-supplied
 *  one.
 *
 *  This duplicates computeAvailability's ORCHESTRATION (not its logic — every
 *  piece below is one of its own exported building blocks) because
 *  computeAvailability has no horizon override, and extending it is a
 *  db/booking-page.ts / booking/availability.ts change outside this file's
 *  fence. Two small pieces aren't exported at all (the pinned-chunk mapping
 *  and the FALLBACK_HOURS constant) and are reproduced verbatim above and
 *  below. Flagged in the implementation report as a follow-up candidate: T9's
 *  booking engine needs this exact same re-validation-at-booking-time
 *  computation (plan §T9), so a shared helper would remove BOTH copies. */
async function assemblePollAvailability(
  db: D1Database,
  env: Env,
  poll: Poll,
  cal: CalendarProvider,
  now: Date,
): Promise<CandidateAvailabilityInput> {
  const owner = poll.subject;
  const bookingCfg = await loadBookingPage(db, owner);
  const tz = await getHomeTz(db, owner, env.SCHEDULER_TZ);

  // Generous, UTC-safe margin past the poll's local range_end: at most a
  // ±14h zone offset plus a full extra day, so this never under-fetches
  // regardless of `tz`. Over-fetching a day or two of calendar events is
  // cheap; under-fetching would silently drop legitimate late-range
  // candidates.
  const horizonEndMs = Math.max(
    Date.parse(`${poll.rangeEnd}T00:00:00Z`) + 2 * 86_400_000,
    now.getTime() + 86_400_000,
  );
  const horizonEnd = new Date(horizonEndMs);

  const { events } = await cal.fetchEventsInWindow(now.toISOString(), horizonEnd.toISOString(), { syncToken: false });

  const meetingConfig = readMeetingConfig(env);
  const bookableOverIds = await resolveBookableOverIds(db, owner, events, {
    enabled: meetingConfig.enabled && bookingCfg.bookable_over_movable_meetings,
    minNoticeMinutes: meetingConfig.minNoticeMinutes,
    now,
  });

  const busyBlocks = deriveBusyBlocks(events, {
    tz,
    tentativeIsBusy: env.TENTATIVE_IS_BUSY === "true",
    excludeEventIds: bookableOverIds,
  });

  const pinnedTaskIds = await loadPinnedTaskIds(db, owner);
  // Mirrors booking/availability.ts's own (unexported) pinnedChunkBlocks: a
  // pinned task's chunk is real busy time even though deriveBusyBlocks drops
  // every optical chunk (the planner re-enters a pinned task as pinned in
  // place, but a poll has no such model).
  const pinnedChunks = events
    .filter((e) => (e.status ?? "").toLowerCase() !== "cancelled")
    .filter((e) => {
      const taskId = taskIdOfEvent(e);
      return taskId !== null && pinnedTaskIds.has(taskId);
    })
    .map((e) => ({ startUtc: e.start, endUtc: e.end }));

  const bookings = await listBookings(db, owner, now.toISOString(), horizonEnd.toISOString());

  const busy = [
    ...busyBlocks.map((b) => ({ startUtc: b.startUtc, endUtc: b.endUtc })),
    ...pinnedChunks,
    ...bookings.map((b) => ({ startUtc: b.start_utc, endUtc: b.end_utc })),
  ];

  const hours = bookingCfg.hours ?? (await loadBusinessHours(db, owner)) ?? POLL_FALLBACK_HOURS;
  return { tz, hours, busy };
}

interface PaintableResult {
  paintable: string[];
  /** Organiser's IANA zone, as resolved for THIS computation (assemblePoll-
   *  Availability's own getHomeTz call) — threaded through rather than
   *  re-resolved so the grid payload's `ownerTz` always matches the zone the
   *  paintable region was actually computed against. */
  tz: string;
}

/** The organiser's live paintable cells for this poll, right now. Re-run on
 *  every grid GET and every response PUT (spec decision 9: "live organiser
 *  region, re-validated"). */
async function computePaintable(
  db: D1Database,
  env: Env,
  cal: CalendarProvider,
  poll: Poll,
  now: Date,
): Promise<PaintableResult> {
  const bookingCfg = await loadBookingPage(db, poll.subject);
  const availability = await assemblePollAvailability(db, env, poll, cal, now);
  const candidates = candidateStarts(
    { duration_min: poll.durationMin, range_start: poll.rangeStart, range_end: poll.rangeEnd },
    availability,
    { min_notice_minutes: bookingCfg.min_notice_minutes, buffer_minutes: bookingCfg.buffer_minutes },
    now,
  );
  return { paintable: paintableCells(candidates, poll.durationMin), tz: availability.tz };
}

/** Hidden invitees show their pseudonym to EVERYONE — never the real name —
 *  applied uniformly (not just "if this isn't the caller") so there is no
 *  special case to get backwards. The one label rule, shared by
 *  `respondents` and the per-cell `freeWho`/`ifNeededWho` arrays (decision D3 /
 *  M1 hover-who) so the two can never disagree about who a viewer sees. */
function inviteeLabel(i: PollInvitee): string {
  return i.hideName || !i.name ? i.pseudonym : i.name;
}

interface OpenGridPayload {
  paintableCells: string[];
  durationMin: number;
  aggregate: Record<string, { free: number; ifNeeded: number; freeWho: string[]; ifNeededWho: string[] }>;
  respondents: Array<{ label: string; responded: boolean }>;
  you: { cells: Array<{ cell: string; state: ResponseState }>; hideName: boolean; name: string };
  ownerTz: string;
}

/** Assembles the fixed grid-endpoint payload (plan §5 / WAVE-1-seam contract)
 *  for an OPEN poll. Pure aggregation over already-fetched data — callers
 *  compute `paintable`/`ownerTz` themselves (via computePaintable) so GET
 *  /grid and PUT /response can each control exactly when the (expensive)
 *  calendar recomputation happens rather than this helper doing it twice. */
async function buildOpenGridPayload(
  db: D1Database,
  poll: Poll,
  invitee: PollInvitee,
  paintable: string[],
  ownerTz: string,
): Promise<OpenGridPayload> {
  const { cellCounts, byInvitee } = await aggregateResponses(db, poll.id);
  const aggregate: Record<string, { free: number; ifNeeded: number; freeWho: string[]; ifNeededWho: string[] }> = {};
  for (const c of cellCounts) aggregate[c.cellStartUtc] = { free: c.free, ifNeeded: c.ifNeeded, freeWho: [], ifNeededWho: [] };

  // R1-F5: listInvitees is ORDER BY email, but this array's order is public
  // (it drives BOTH `respondents` and the freeWho/ifNeededWho arrays below).
  // Labels are pseudonymised for a hidden invitee, but their ALPHABETICAL
  // POSITION was not — a viewer who knows their colleagues' addresses could
  // read a hidden person's email range straight off their index in these
  // arrays. Re-sorted by pseudonym (assigned randomly per poll, decorrelated
  // from email/creation order) so position carries no information. The
  // organiser status page keeps listInvitees' own email order — real names
  // there, so there is nothing to leak by ordering.
  const invitees = (await listInvitees(db, poll.id))
    .filter((i) => !i.dropped)
    .sort((a, b) => a.pseudonym.localeCompare(b.pseudonym));
  const respondents = invitees.map((i) => ({
    label: inviteeLabel(i),
    responded: i.respondedAt !== null,
  }));

  // Per-cell who-is-free/if-needed labels (decision D3 / M1 hover-who): walk
  // each non-dropped invitee's own painted cells (in the same invitee order
  // as `respondents`, for a stable, deterministic array), appending their
  // label into the matching bucket. `aggregate` already has an entry for
  // every cell with at least one response (from cellCounts above), so this
  // never needs to create one.
  for (const i of invitees) {
    const cells = byInvitee.find((b) => b.inviteeId === i.id)?.cells ?? [];
    const label = inviteeLabel(i);
    for (const c of cells) {
      const bucket = aggregate[c.cellStartUtc];
      if (!bucket) continue;
      (c.state === "free" ? bucket.freeWho : bucket.ifNeededWho).push(label);
    }
  }

  const mine = byInvitee.find((b) => b.inviteeId === invitee.id);
  const you = {
    cells: (mine?.cells ?? []).map((c) => ({ cell: c.cellStartUtc, state: c.state })),
    hideName: invitee.hideName,
    name: invitee.name ?? "",
  };

  return { paintableCells: paintable, durationMin: poll.durationMin, aggregate, respondents, you, ownerTz };
}

const MAX_JOIN_BODY_BYTES = 8 * 1024;
const MAX_RESPONSE_BODY_BYTES = 256 * 1024;
/** A poll's paintable region is bounded by (6 weeks x business hours / 30
 *  min); a few thousand cells is far above any real submission and far below
 *  anything that could exhaust the isolate. Sized to be obviously generous —
 *  this is a backstop for a header-less request (content-length absent means
 *  the byte-cap above never triggers), not a business rule. */
const MAX_RESPONSE_CELLS = 4000;
const MAX_RESPONSE_NAME_LENGTH = 100;
/** Stateless per-invitee QUIET-PERIOD DEBOUNCE on the response-saved
 *  organiser email (T-notify finding 1): defaultNotificationProvider sends
 *  AS the organiser, through their own account's send quota, so an invitee
 *  holding a live response token could otherwise loop this endpoint to burn
 *  through it. Needs no migration or new column — it reads the pre-save
 *  `invitee.respondedAt`. Important: that column is the invitee's last SAVE
 *  time, not their last-NOTIFIED time — `markResponded` stamps it on every
 *  save unconditionally, including saves this gate suppresses. So the window
 *  SLIDES: a save only notifies if it lands with a ≥15-minute gap since the
 *  invitee's PREVIOUS save, not since their previous email. An invitee who
 *  keeps revising at shorter intervals generates no further emails until
 *  they stop for 15 minutes — a continuous burst of saves produces exactly
 *  ONE email total (the first response), not one per 15-minute window. A
 *  FIRST response (pre-save respondedAt === null) always notifies regardless
 *  of this gate. ≤4 emails/hour/invitee is a hard ceiling (the case where
 *  every save happens to land just past the gate), not a typical rate. The
 *  save itself is never affected — this only gates the notification. */
const RESPONSE_NOTIFY_COOLDOWN_MS = 15 * 60_000;
const MAX_JOIN_NAME_LENGTH = 120;
const MAX_JOIN_EMAIL_LENGTH = 254;
/** Same shape as booking/route.ts's EMAIL_RE (not exported there — see that
 *  file's comment for the reasoning: excludes the characters that make an
 *  address dangerous downstream rather than merely invalid). */
const JOIN_EMAIL_RE = /^[^@\s<>"',;]+@[^@\s.<>"',;]+\.[^@\s<>"',;]+$/;
/** Poll-scoped circuit breaker on guest joins — counts non-dropped guests
 *  only (a dropped guest's row stays, so counting it would let the
 *  organiser's own abuse remedy ratchet the poll toward a permanent 429).
 *  Defense in depth ON TOP OF the real per-IP, time-windowed limit below
 *  (0033's ip_hash/created_at columns) — Turnstile is the primary,
 *  fail-closed gate; this just bounds total live guests on one poll
 *  regardless of how many distinct IPs contribute them. */
const MAX_GUESTS_PER_POLL = 20;
/** Real per-IP rate limit (0033) — booking/turnstile.ts's
 *  MAX_CLAIMS_PER_IP_24H shape, reproduced here rather than imported: that
 *  constant lives in booking's own file, and a poll join is a different
 *  action with its own tuning, not booking's claim flow under another name. */
const MAX_POLL_JOINS_PER_IP_24H = 5;
const POLL_JOIN_RATE_WINDOW_HOURS = 24;

interface ResponseBody {
  cells?: unknown;
  hideName?: unknown;
  name?: unknown;
}

/** Public, UNAUTHENTICATED meeting-poll routes. Mounted on the root app ahead
 *  of any auth — same reasoning as booking: invitees never sign in, and the
 *  per-invitee capability token is the access control. */
export function mountPollRoutes(app: Hono<{ Bindings: Env; Variables: AppVariables }>) {
  // Literal path registered before /poll/:id so it isn't swallowed as an id.
  app.get(`/poll/_static/poll.${POLL_CLIENT_HASH}.js`, (c) => {
    if (!flagOn(c.env)) return notFound();
    return new Response(POLL_CLIENT_JS, {
      status: 200,
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  });

  app.get("/poll/:id", async (c) => {
    if (!flagOn(c.env)) return notFound();
    const pollId = c.req.param("id");
    const token = c.req.query("t") ?? "";
    if (token) {
      const resolved = await resolveInvitee(c.env, c.env.DB, pollId, token);
      if (resolved) {
        return new Response(
          renderPollPage({ pollId, token, cellMinutes: CELL_MINUTES }),
          { status: 200, headers: htmlHeaders() },
        );
      }
      return new Response(renderPollExpiredPage(), { status: 200, headers: htmlHeaders() });
    }
    const guestToken = c.req.query("g") ?? "";
    if (guestToken) {
      const poll = await getPoll(c.env.DB, pollId);
      if (poll?.guestTokenHash) {
        const hash = await hashToken(guestToken, hashingKey(c.env));
        if (hash === poll.guestTokenHash) {
          return new Response(
            renderPollJoinFormPage({ pollId, guestToken, siteKey: c.env.TURNSTILE_SITE_KEY ?? "" }),
            { status: 200, headers: htmlHeaders(POLL_JOIN_PAGE_CSP) },
          );
        }
      }
    }
    return new Response(renderPollExpiredPage(), { status: 200, headers: htmlHeaders() });
  });

  app.get("/poll/:id/grid", async (c) => {
    if (!flagOn(c.env)) return notFound();
    const pollId = c.req.param("id");
    const token = c.req.query("t") ?? "";
    const resolved = await resolveInvitee(c.env, c.env.DB, pollId, token);
    if (!resolved) return json({ error: "invalid_token" }, 401);
    const { poll, invitee } = resolved;

    // needs_attention (escalated, no common slot) stays unlocked, same as
    // open — invitees may keep revising until the organiser books via the
    // resolveMeetingPoll API/MCP call. Only booked/cancelled are closed.
    if (poll.status !== "open" && poll.status !== "needs_attention") return json({ status: poll.status });

    const now = new Date();
    const cal = c.get("calendarProvider") ?? await defaultCalendarProvider(c.env, poll.subject);
    let result: PaintableResult;
    try {
      result = await computePaintable(c.env.DB, c.env, cal, poll, now);
    } catch (err) {
      console.error(`poll ${pollId} grid computation failed:`, String(err));
      return json({ error: "calendar_unavailable" }, 502);
    }
    return json(await buildOpenGridPayload(c.env.DB, poll, invitee, result.paintable, result.tz));
  });

  app.put("/poll/:id/response", async (c) => {
    if (!flagOn(c.env)) return notFound();
    const pollId = c.req.param("id");
    const token = c.req.query("t") ?? "";
    const resolved = await resolveInvitee(c.env, c.env.DB, pollId, token);
    if (!resolved) return json({ error: "invalid_token" }, 401);
    const { poll, invitee } = resolved;

    // needs_attention stays unlocked for edits, same as GET /grid — an
    // escalated poll's remedy is the organiser's manual resolveMeetingPoll
    // call, not another auto-book race, so the deadline gate below (which
    // exists only to stop an OPEN poll's invitee racing the cron's own
    // bookAtDeadline) does not apply here — a needs_attention poll has no
    // pending bookAtDeadline to race. Only booked/cancelled are closed.
    if (poll.status !== "open" && poll.status !== "needs_attention") return json({ status: poll.status });
    // "Revise until close" means until the poll closes, and the deadline IS
    // the close — status only flips to booked/needs_attention once the
    // hourly sweep runs, so without this an invitee could paint (and, via
    // fireMaybeBookOnAllIn, trigger a booking) for up to ~59 minutes after
    // the deadline, racing the cron's own bookAtDeadline for the same poll.
    // Open polls only: a needs_attention poll is never subject to
    // bookAtDeadline, so there is no race left to guard against there.
    if (poll.status === "open" && Date.now() >= Date.parse(poll.deadlineUtc)) {
      return json({ error: "poll_closed" }, 409);
    }

    const declaredLength = Number(c.req.header("content-length"));
    if (declaredLength > MAX_RESPONSE_BODY_BYTES) return json({ error: "invalid_body" }, 400);

    let body: ResponseBody;
    try {
      body = await c.req.json<ResponseBody>();
    } catch {
      return json({ error: "invalid_body" }, 400);
    }

    if (!Array.isArray(body.cells) || typeof body.hideName !== "boolean" || typeof body.name !== "string") {
      return json({ error: "invalid_body" }, 400);
    }
    // `content-length` is absent on a chunked/header-less request, and
    // `Number(undefined) > MAX` is false, so the size guard above silently
    // passes in that case — this is the bound that actually matters, applied
    // to the parsed array itself. Sized far above any real submission (a
    // poll's paintable region is bounded by ~6 weeks x business hours / 30
    // min) and far below anything that could exhaust the isolate.
    if (body.cells.length > MAX_RESPONSE_CELLS) return json({ error: "invalid_body" }, 400);
    if (body.name.length > MAX_RESPONSE_NAME_LENGTH) return json({ error: "invalid_body" }, 400);
    // L8: an empty trimmed name is "leave it as-is", not "blank it out". The
    // submit bar pre-fills from the stored name, but a client that resubmits
    // without repopulating that field (or a user who deliberately clears it)
    // must not erase an organiser-supplied or previously-confirmed name —
    // only a NON-empty trimmed value is treated as a real edit.
    const submittedName = body.name.trim() || (invitee.name ?? "");

    const cells: Array<{ cellStartUtc: string; state: ResponseState }> = [];
    const seenCells = new Set<string>();
    for (const raw of body.cells) {
      if (
        !raw ||
        typeof raw !== "object" ||
        typeof (raw as { cell?: unknown }).cell !== "string" ||
        ((raw as { state?: unknown }).state !== "free" && (raw as { state?: unknown }).state !== "if_needed")
      ) {
        return json({ error: "invalid_body" }, 400);
      }
      const entry = raw as { cell: string; state: ResponseState };
      // A cell repeated in the payload — with the same OR a different state —
      // breaks replaceResponses' insert (poll_responses' primary key is
      // (invitee_id, cell_start_utc)), surfacing as an unhandled 500 rather
      // than the malformed-body 400 it actually is.
      if (seenCells.has(entry.cell)) return json({ error: "invalid_body" }, 400);
      seenCells.add(entry.cell);
      cells.push({ cellStartUtc: entry.cell, state: entry.state });
    }

    const now = new Date();
    const cal = c.get("calendarProvider") ?? await defaultCalendarProvider(c.env, poll.subject);
    let result: PaintableResult;
    try {
      result = await computePaintable(c.env.DB, c.env, cal, poll, now);
    } catch (err) {
      console.error(`poll ${pollId} grid computation failed:`, String(err));
      return json({ error: "calendar_unavailable" }, 502);
    }
    const paintableSet = new Set(result.paintable);
    // The paintable region is recomputed live on every PUT, so when the
    // organiser's calendar fills in, a cell this invitee already saved can
    // fall OUT of it. The client resubmits `you.cells` verbatim (the
    // documented revise flow), so rejecting the whole submission on a stale
    // cell would make revise-until-close — and even a hide-name-only or
    // name-only edit — permanently impossible, with the client retrying the
    // identical body forever. The server is the only party that knows the
    // live region at write time, so it silently drops a previously-saved
    // cell that has since left it, and still rejects a cell that is neither
    // paintable now NOR already saved — that one really is a fresh paint the
    // invitee cannot have.
    const { byInvitee } = await aggregateResponses(c.env.DB, poll.id);
    const saved = new Set(
      (byInvitee.find((b) => b.inviteeId === invitee.id)?.cells ?? []).map((c) => c.cellStartUtc),
    );
    const kept = cells.filter((cell) => paintableSet.has(cell.cellStartUtc));
    const offenders = [...new Set(cells.map((cell) => cell.cellStartUtc))].filter(
      (cell) => !paintableSet.has(cell) && !saved.has(cell),
    );
    if (offenders.length > 0) return json({ error: "cell_not_paintable", cells: offenders }, 400);

    // Full replace (revise-until-close): the delete-then-insert in
    // replaceResponses means a shrunk selection leaves no stale rows. `kept`,
    // not `cells` — a stale-but-saved cell dropped above must not be
    // re-inserted here either, or the silent drop above would be undone.
    await replaceResponses(c.env.DB, invitee.id, kept);
    await markResponded(c.env.DB, invitee.id, now.toISOString());
    await setHideName(c.env.DB, invitee.id, body.hideName);
    // The submit bar's name field is a confirmation/edit, not just a
    // pre-fill (design spec: "name confirmation") — persist it so it
    // reflects on the next GET and on the organiser-facing roster.
    await setInviteeName(c.env.DB, invitee.id, submittedName);

    // Fire-and-forget, error-isolated (guardrail): the response is already
    // durably saved above, so nothing about the all-in check may fail it.
    // Open only: a needs_attention save must never auto-book — that stays
    // the organiser's manual resolveMeetingPoll call, or an invitee's edit
    // on an escalated poll would silently re-trigger booking behind their
    // back. Re-read status here rather than trusting `poll` (the snapshot
    // captured by resolveInvitee at the top of this handler, before the
    // calendar fetch and four DB writes above) — review finding B-R1: a
    // SIBLING invitee's save can escalate this same poll to needs_attention
    // in that window, and maybeBookOnAllIn's own re-read deliberately
    // admits needs_attention (the updateMeetingPoll removeInviteeIds rescue
    // path), so a stale
    // "open" read here would still fire it against an already-escalated
    // poll. This re-read narrows the race, it doesn't close it entirely —
    // a poll could still escalate in the gap between THIS read and
    // maybeBookOnAllIn's own; that residual window is documented in
    // runbook §L.
    const freshPoll = await getPoll(c.env.DB, poll.id);
    if (freshPoll?.status === "open") {
      const attempt = fireMaybeBookOnAllIn(c.env, poll.id);
      try {
        c.executionCtx.waitUntil(attempt);
      } catch {
        // No real ExecutionContext (e.g. `app.request()` in tests) — the
        // promise already swallows its own errors, so awaiting it inline is
        // safe. Same fallback idiom as calendar-feed/feed-route.ts.
        await attempt;
      }
    }

    // Organiser notification (T-notify), same fire-and-forget idiom: "first
    // response" is read from the PRE-save snapshot (`invitee`, not the
    // post-save `updatedInvitee` below) — that's the only place the
    // before/after distinction is still visible. `submittedName` falls back
    // to the invitee's email so the organiser always has an identifiable
    // respondent even for someone who has never set a name. A first response
    // always notifies; a repeat save only notifies once a ≥15-minute quiet
    // period has passed since the invitee's PREVIOUS SAVE (not their
    // previous email — see RESPONSE_NOTIFY_COOLDOWN_MS's own comment for why
    // those two aren't the same thing).
    const isFirstResponse = invitee.respondedAt === null;
    const cooledDown =
      isFirstResponse || now.getTime() - Date.parse(invitee.respondedAt!) >= RESPONSE_NOTIFY_COOLDOWN_MS;
    if (cooledDown) {
      const notifyProvider = c.get("notificationProvider") ?? await defaultNotificationProvider(c.env, poll.subject);
      const notifyAttempt = fireOrganiserResponseNotification(
        c.env,
        notifyProvider,
        poll,
        submittedName || invitee.email,
        isFirstResponse,
      );
      try {
        c.executionCtx.waitUntil(notifyAttempt);
      } catch {
        await notifyAttempt;
      }
    }

    const updatedInvitee: PollInvitee = {
      ...invitee,
      hideName: body.hideName,
      respondedAt: now.toISOString(),
      name: submittedName,
    };
    return json(await buildOpenGridPayload(c.env.DB, poll, updatedInvitee, result.paintable, result.tz));
  });

  app.post("/poll/:id/join", async (c) => {
    // Two submitters: the real join page (page.ts's renderPollJoinFormPage,
    // a plain navigation <form> — Turnstile in IMPLICIT mode writes a
    // `cf-turnstile-response` hidden field, no client JS of this card's own
    // involved) posts urlencoded; any JSON API client (poll-smoke.py) posts
    // JSON. `wantsHtml` follows the submitter: a urlencoded body can only
    // have come from a browser form navigation, which cannot read a JSON
    // response body — it needs an HTML page back either way. Computed FIRST
    // (content-type is available before anything else) so it covers every
    // exit from this handler, including the early ones below (R4-L1: those
    // used to fall through to the bare, non-HTML notFound() regardless of
    // submitter).
    const contentType = c.req.header("content-type") ?? "";
    const isForm = contentType.includes("application/x-www-form-urlencoded");
    const wantsHtml = isForm;
    const fail = (jsonBody: unknown, status: number, heading: string, message: string): Response =>
      wantsHtml
        ? new Response(renderPollJoinErrorPage(heading, message), { status, headers: htmlHeaders(POLL_JOIN_PAGE_CSP) })
        : json(jsonBody, status);
    const succeed = (): Response =>
      wantsHtml
        ? new Response(renderPollJoinSentPage(), { status: 200, headers: htmlHeaders(POLL_JOIN_PAGE_CSP) })
        : json({ sent: true }, 202);
    // Opaque 404: flag-off, unknown poll, no guest link, and a guest-token
    // hash mismatch all read identically — same "no oracle" reasoning as
    // booking's 404s — but still HTML for a form submitter (R4-L1), since a
    // browser navigation has no other way to show the failure.
    const notFoundResponse = (): Response =>
      wantsHtml
        ? new Response(renderPollJoinErrorPage("Can't join this poll", "This link is no longer valid."), {
            status: 404,
            headers: htmlHeaders(POLL_JOIN_PAGE_CSP),
          })
        : notFound();

    if (!flagOn(c.env)) return notFoundResponse();
    const pollId = c.req.param("id");
    const poll = await getPoll(c.env.DB, pollId);
    if (!poll || !poll.guestTokenHash) return notFoundResponse();

    const declaredLength = Number(c.req.header("content-length"));
    if (declaredLength > MAX_JOIN_BODY_BYTES) return json({ error: "invalid_body" }, 400);

    let raw: Record<string, unknown>;
    if (isForm) {
      try {
        raw = (await c.req.parseBody()) as Record<string, unknown>;
      } catch {
        return fail({ error: "invalid_body" }, 400, "Can't join this poll", "Something went wrong with your submission.");
      }
    } else {
      try {
        raw = await c.req.json<Record<string, unknown>>();
      } catch {
        return json({ error: "invalid_body" }, 400);
      }
    }

    const name = typeof raw.name === "string" ? raw.name : "";
    const email = typeof raw.email === "string" ? raw.email : "";
    // JSON callers send `turnstileToken`; the implicit-mode widget's own
    // hidden field is always named `cf-turnstile-response` — accepting
    // either lets both submitters share this one handler.
    const turnstileToken =
      typeof raw.turnstileToken === "string"
        ? raw.turnstileToken
        : typeof raw["cf-turnstile-response"] === "string"
          ? (raw["cf-turnstile-response"] as string)
          : "";
    const guestToken = typeof raw.guestToken === "string" ? raw.guestToken : "";
    if (!name || !email || !turnstileToken || !guestToken) {
      return fail({ error: "invalid_body" }, 400, "Can't join this poll", "Please fill in every field.");
    }

    // Turnstile before any further validation or DB write — same ordering as
    // booking/route.ts's claim handler, and for the same reason: it is the
    // only thing standing between this public endpoint and invitations sent
    // from the organiser's own account.
    const ip = c.req.header("cf-connecting-ip") ?? "";
    if (!(await verifyTurnstile(c.env, turnstileToken, ip, new URL(c.req.url).hostname))) {
      return fail({ error: "challenge_failed" }, 403, "Can't join this poll", "We couldn't verify you're human — please try again.");
    }

    const presentedGuestHash = await hashToken(guestToken, hashingKey(c.env));
    if (presentedGuestHash !== poll.guestTokenHash) return notFoundResponse();

    const trimmedName = name.trim();
    // Lowercased at the join boundary (R1-F2/R4-H3): organiser-added
    // invitees are stored lowercased (handlers/polls.ts's normaliseInvitees)
    // and UNIQUE(poll_id, email) in 0032 is a plain, case-sensitive TEXT
    // column — without this, a case-variant of a dropped address bypassed
    // the resurrection block below, and a case-variant of a LIVE invitee
    // created a silent duplicate (which, since every invitee is a required
    // attendee, can never respond and permanently blocks all-in booking).
    const trimmedEmail = email.trim().toLowerCase();
    if (
      trimmedName.length === 0 ||
      trimmedName.length > MAX_JOIN_NAME_LENGTH ||
      trimmedEmail.length > MAX_JOIN_EMAIL_LENGTH ||
      !JOIN_EMAIL_RE.test(trimmedEmail)
    ) {
      return fail({ error: "invalid_body" }, 400, "Can't join this poll", "Please check your name and email address.");
    }

    const nowMs = Date.now();
    if (poll.status !== "open" || nowMs >= Date.parse(poll.deadlineUtc)) {
      return fail({ error: "poll_closed" }, 409, "This poll is closed", "It's no longer accepting responses.");
    }

    // Real per-IP, time-windowed rate limit (0034) — MAX_GUESTS_PER_POLL
    // below stays as a separate, poll-scoped circuit breaker on top of this.
    // A join with no client IP can't be rate-limited, so — same reasoning as
    // booking/route.ts's claim handler — it is refused rather than silently
    // exempted; deliberately AFTER the Turnstile check, same "nothing until
    // the challenge passes" ordering.
    if (!ip) {
      console.error(`poll ${pollId}: join rejected, no cf-connecting-ip on the request`);
      return fail({ error: "client_ip_required" }, 400, "Can't join this poll", "Something went wrong — please try again.");
    }
    const ipHash = await hashToken(ip, hashingKey(c.env));
    const rateWindowStart = new Date(nowMs - POLL_JOIN_RATE_WINDOW_HOURS * 3600_000).toISOString();
    if ((await countRecentJoinAttempts(c.env.DB, pollId, ipHash, rateWindowStart)) >= MAX_POLL_JOINS_PER_IP_24H) {
      return fail({ error: "rate_limited" }, 429, "Too many attempts", "Please try again later.");
    }
    // Record this ATTEMPT now, before branching on what kind of attempt it
    // is (R1-F1/R4-H2 fix). The already-invited and dropped-invitee arms
    // below never insert a poll_invitees row, so recording only on insert
    // (the old design) left those arms completely unthrottled — one IP
    // could re-issue-and-email any known invitee's link without limit. This
    // call is unconditional: new guest, already-invited, dropped, and
    // at-cap all consume the same budget.
    await recordJoinAttempt(c.env.DB, pollId, ipHash, new Date(nowMs).toISOString());

    const notification = c.get("notificationProvider") ?? await defaultNotificationProvider(c.env, poll.subject);

    // Mints a fresh capability token for `inviteeId` and emails it as that
    // invitee's personal link. Used on BOTH the new-guest path and the
    // already-invited path below — one code path mints and sends every
    // guest-join token, so the two can never drift out of sync. A send
    // failure is logged and non-fatal: this is a public, best-effort
    // endpoint (the JSON contract is `202 {sent:true}`, an acknowledgement
    // that a send was attempted, not a delivery guarantee) — unlike the
    // organiser-authenticated create/nudge paths in handlers/polls.ts, a
    // transient email-provider hiccup here must not turn into a 500 for an
    // unauthenticated caller.
    async function mintAndEmailLink(inviteeId: string, toEmail: string): Promise<void> {
      const ttlSeconds = Math.max(60, Math.floor((Date.parse(poll!.deadlineUtc) + 7 * 86_400_000 - nowMs) / 1000));
      const capToken = await signCapabilityWithEnv(
        { purpose: "poll-response", pollId, inviteeId, subject: poll!.subject, ttlSeconds },
        c.env,
      );
      await setInviteeTokenHash(c.env.DB, inviteeId, await hashToken(capToken, hashingKey(c.env)));
      const inviteeUrl = `${new URL(c.req.url).origin}/poll/${pollId}?t=${encodeURIComponent(capToken)}`;
      const content = renderInviteEmail({
        pollTitle: poll!.title,
        organiserName: poll!.subject,
        durationMin: poll!.durationMin,
        rangeStart: poll!.rangeStart,
        rangeEnd: poll!.rangeEnd,
        deadlineUtc: poll!.deadlineUtc,
        inviteeUrl,
      });
      try {
        await notification.sendPollEmail({ to: toEmail, ...content });
      } catch (err) {
        // R1-F6: log the invitee id, never the address itself — this path
        // runs on a public, unauthenticated endpoint, and the address is
        // exactly the datum "hide my name" and the whole guest-join redesign
        // exist to protect.
        console.error(`poll ${pollId}: failed to email guest-join link to invitee ${inviteeId}`, String(err));
      }
    }

    // Email-membership-oracle fix (R1-F3/F4, R4-F2): the new-join and
    // already-invited paths below are byte-identical in what they return —
    // `succeed()` either way, never a url/token in the body — so a guest-
    // link holder learns nothing about who else is invited. Only the
    // mailbox owner ever sees the actual link.
    const existing = await listInvitees(c.env.DB, pollId);
    const already = existing.find((i) => i.email === trimmedEmail);
    if (already) {
      // A DROPPED invitee's email must not be silently resurrected by
      // rejoining through the shared guest link — that would hand the
      // organiser's drop remedy right back to whoever they dropped. The
      // response stays identical regardless (no oracle on drop status
      // either); this simply sends nothing.
      if (!already.dropped) await mintAndEmailLink(already.id, trimmedEmail);
      return succeed();
    }

    // Dropped guests are excluded from the cap: counting them would make
    // dropping an abusive guest RAISE the count toward it (the row stays,
    // only `dropped` flips), eventually pinning the poll at a permanent
    // block — the organiser's only remedy making the problem worse.
    const guestCount = existing.filter((i) => i.kind === "guest" && !i.dropped).length;
    if (guestCount >= MAX_GUESTS_PER_POLL) {
      // R1-F3: a distinguishable "guest limit reached" response re-opened
      // the membership oracle the whole redesign exists to close — a
      // stranger's 429-with-that-wording vs. an existing member's 202 told
      // an attacker exactly which emails were already invited, once a poll
      // held 20 guests. Same identical-response contract as the
      // already-invited/dropped-invitee arms above: silently decline
      // (create nothing, email nothing) and return the SAME success either
      // way. The per-IP attempt limit above (and the cap itself) still
      // bounds abuse; only the RESPONSE stops distinguishing member from
      // non-member.
      return succeed();
    }

    const taken = new Set(existing.map((i) => i.pseudonym));
    let pseudonym: string;
    try {
      pseudonym = mintPseudonym(taken);
    } catch {
      return fail({ error: "poll_full" }, 500, "Can't join this poll", "This poll is full.");
    }

    // The capability token's claims embed `inviteeId` (plan-fixed shape),
    // which db/polls.ts's `newInviteeId` lets a caller mint BEFORE the row
    // exists specifically so it can be bound into the token first.
    const inviteeId = newInviteeId();
    const placeholderTokenHash = await hashToken(`${inviteeId}:pending`, hashingKey(c.env));
    try {
      await insertInvitee(c.env.DB, {
        id: inviteeId,
        pollId,
        email: trimmedEmail,
        name: trimmedName,
        kind: "guest",
        // Placeholder, immediately overwritten by mintAndEmailLink's
        // setInviteeTokenHash below — deterministic per-invitee (not empty)
        // so a concurrent insert can never coincide with it, and the row is
        // never resolvable by ANY real bearer token for the instant it
        // exists in this state.
        tokenHash: placeholderTokenHash,
        pseudonym,
        now: new Date().toISOString(),
        ipHash,
      });
    } catch (err) {
      if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) {
        // Race: another request inserted this email between the `existing`
        // lookup above and this insert. Same identical-response contract —
        // succeed silently, without emailing (vanishingly rare, non-fatal;
        // the other request's own send already covers this address).
        return succeed();
      }
      throw err;
    }
    await mintAndEmailLink(inviteeId, trimmedEmail);
    return succeed();
  });

  // ── Organiser status page (authenticated) ─────────────────────────────
  //
  // GET /poll/:id/status — EXACTLY this path; handlers/polls.ts's statusUrl
  // (`${OAUTH_ISSUER}/poll/${poll.id}/status`) is a binding contract with
  // this route. TWO auth paths, either sufficient on its own:
  //
  //  - `?t=<poll-status token>` — a browser-navigable capability link (a
  //    browser can't send an Authorization header), verified by
  //    resolveStatusToken above. Takes priority when present: it exists
  //    specifically so a plain click works, and a browser navigation never
  //    carries a bearer anyway.
  //  - requireOwner (bearer + subject, no new scopes) when no `?t=` is
  //    present — mirrors handlers/polls.ts's own routes exactly (see that
  //    file's top-of-file comment), for the MCP/curl path.
  //
  // Both resolve to the SAME ownership-checked poll (getPollForSubject, used
  // directly by the bearer path and internally by resolveStatusToken), so a
  // poll id that exists but belongs to a different subject 404s either way
  // — same as every other cross-subject lookup in this codebase, never 403
  // (no confirming a poll id's existence to a caller who doesn't own it).
  app.get("/poll/:id/status", async (c) => {
    if (!flagOn(c.env)) return notFound();
    const pollId = c.req.param("id");

    const statusToken = c.req.query("t") ?? "";
    let poll: Poll | null;
    if (statusToken) {
      poll = await resolveStatusToken(c.env, c.env.DB, pollId, statusToken);
      if (!poll) return notFound();
    } else {
      const owner = await requireOwner(c);
      if (owner instanceof Response) return owner;
      poll = await getPollForSubject(c.env.DB, owner, pollId);
      if (!poll) return notFound();
    }

    const invitees = await listInvitees(c.env.DB, poll.id);
    const nameFor = (i: PollInvitee): string => (i.name && i.name.length > 0 ? i.name : i.pseudonym);
    const roster: RosterEntry[] = invitees.map((i) => ({
      email: i.email,
      displayName: nameFor(i),
      pseudonymIfHidden: i.hideName ? i.pseudonym : null,
      responded: i.respondedAt !== null,
      dropped: i.dropped,
    }));

    const { cellCounts, byInvitee } = await aggregateResponses(c.env.DB, poll.id);
    const cells = cellCounts.map((cc) => cc.cellStartUtc).sort();
    // Aggregate rows: non-dropped invitees who painted at least one cell —
    // real names (organiser sees everything), no pseudonym substitution.
    const aggregate: AggregateRow[] = invitees
      .filter((i) => !i.dropped)
      .map((i) => {
        const mine = byInvitee.find((b) => b.inviteeId === i.id);
        const statesByCell: Record<string, "free" | "if_needed" | undefined> = {};
        for (const cell of mine?.cells ?? []) statesByCell[cell.cellStartUtc] = cell.state;
        return { displayName: nameFor(i), statesByCell };
      })
      .filter((row) => Object.keys(row.statesByCell).length > 0);

    // Cheap regardless of poll status — the live ranking call below (open
    // and needs_attention only) resolves its own copy internally for
    // scoring, but this page's header line needs a zone even for a
    // booked/cancelled poll, which never calls it.
    const ownerTz = await getHomeTz(c.env.DB, poll.subject, c.env.SCHEDULER_TZ);

    let candidates: CandidateRow[] = [];
    // needs_attention too (matches getMeetingPoll:633) — Card B unlocks
    // invitee edits on an escalated poll, so a slot can become fully
    // covered again before the organiser re-resolves; the status page
    // should surface it rather than showing a stale "No candidate times
    // yet." until status flips back to open.
    if (poll.status === "open" || poll.status === "needs_attention") {
      const cal = c.get("calendarProvider") ?? await defaultCalendarProvider(c.env, poll.subject);
      try {
        // Imported from handlers/polls.ts (T15's file) rather than
        // reimplemented here: the organiser status page's top candidates
        // must equal getMeetingPoll's by construction, not by two
        // independently-maintained ranking walks (the review wave's R2-F2
        // finding — diverged fit-curve loaders producing "shown ≠ booked" —
        // is exactly the failure class a local copy would risk).
        const ranking = await rankPollCandidates(c.env, c.env.DB, cal, poll.subject, poll, new Date());
        const nameById = new Map(invitees.map((i) => [i.id, nameFor(i)]));
        candidates = ranking.candidates.slice(0, 5).map((cand) => ({
          slotStartUtc: cand.slotStartUtc,
          score: cand.score,
          organiserFit: cand.organiserFit,
          weights: cand.weights.map((w) => ({ label: nameById.get(w.inviteeId) ?? w.inviteeId, weight: w.weight })),
        }));
      } catch (err) {
        // Degrade gracefully: the roster/aggregate sections above are still
        // useful to the organiser even when live ranking (a calendar fetch)
        // fails — same "never fail the whole read on a calendar hiccup"
        // reasoning as GET /poll/:id/grid's own try/catch.
        console.error(`poll ${pollId} status-page ranking failed:`, String(err));
      }
    }

    return new Response(
      renderPollStatusPage({
        poll: {
          id: poll.id,
          title: poll.title,
          status: poll.status,
          durationMin: poll.durationMin,
          rangeStart: poll.rangeStart,
          rangeEnd: poll.rangeEnd,
          deadlineUtc: poll.deadlineUtc,
          bookedSlotUtc: poll.bookedSlotUtc,
        },
        ownerTz,
        roster,
        cells,
        aggregate,
        candidates,
      }),
      { status: 200, headers: htmlHeaders() },
    );
  });
}
