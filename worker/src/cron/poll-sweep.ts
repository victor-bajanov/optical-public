// Hourly sweep for meeting polls (see
// internal design notes, "Emails" +
// "Scoring and booking"): books polls whose deadline has passed, and fires
// the two nudge cadences — deadline−24h, plus a midpoint nudge for polls
// whose lifetime (created→deadline) exceeds 7 days. Neither cadence fires
// for a poll born inside the deadline−24h window (the invite itself already
// carries the urgency), and neither fires before the poll is MIN_NUDGE_AGE_MS
// old, regardless of how the window/lifetime math falls out — see
// sweepOnePoll for both guards. Both nudge stamps are idempotent per poll
// episode (see db/polls.ts markNudged).
import type { Env } from "../env";
import type { NotificationProvider, PollEmail } from "../providers/notification-provider";
import { defaultNotificationProvider } from "../index-providers";
import { listSubjects } from "../auth/identity-store";
import {
  listOpenPollsDue,
  listInvitees,
  markNudged,
  setInviteeTokenHash,
  type Poll,
  type PollInvitee,
} from "../db/polls";
import { renderNudgeEmail } from "../polls/emails";
import { signCapabilityWithEnv } from "../auth/capability";
import { hashToken } from "../auth/tokens";
import { hashingKey } from "../auth/crypto-keys";

// T9's booking module (worker/src/polls/booking.ts) is a parallel Wave-2 task
// and may not exist yet in a given worktree — this file deliberately never
// imports it (statically or dynamically); the real function is wired in by
// the caller (scheduled-entry.ts) once it exists. Signature pinned by the
// orchestrator (plan §5 / T10 Wave-1-adjustments note).
export type BookAtDeadline = (env: Env, pollId: string) => Promise<void>;

export interface PollSweepDeps {
  bookAtDeadline: BookAtDeadline;
  // Defaults to the real per-subject Gmail provider (index-providers.ts) —
  // unlike bookAtDeadline, this has a safe, already-existing default.
  makeNotification?: (subject: string) => NotificationProvider | Promise<NotificationProvider>;
}

export interface PollSweepResult {
  checked: number;
  // Counts deadline-triggered bookAtDeadline attempts, NOT successful
  // bookings — bookAtDeadline's fixed signature returns void, so a poll it
  // escalates (empty intersection, all candidates dead) is counted here too.
  // The poll rows are the source of truth for which outcome actually happened.
  deadlineProcessed: number;
  nudgedFinal: number;
  nudgedMidpoint: number;
  failed: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const FINAL_NUDGE_LEAD_MS = DAY_MS;
const MIDPOINT_LIFETIME_THRESHOLD_MS = 7 * DAY_MS;
// Minimum time since creation before ANY nudge cadence fires. The
// born-inside-window guard below only catches a poll whose deadline−24h is
// already past AT creation; an ordinary poll (e.g. 24h05m lifetime) is born
// just OUTSIDE that window and would still get final-nudged on the very next
// hourly tick — minutes after its invite email, rotating the just-emailed
// token. This floor covers that case too. It's organically vacuous for the
// midpoint cadence (eligible lifetimes exceed 7 days, so the earliest
// possible midpoint is created + 3.5d, always past 6h) — folded in anyway as
// cheap, self-documenting defence-in-depth rather than special-cased out.
const MIN_NUDGE_AGE_MS = 6 * 60 * 60 * 1000;

/** Mint a FRESH capability token for this invitee, store its hash, and return
 *  the URL. resolveInvitee (route.ts) checks a presented token's hash against
 *  the STORED token_hash, so a nudge that signs a token without storing its
 *  hash produces a link that can never resolve — re-issuing (not re-signing)
 *  is the fix, matching the manual nudge path in handlers/polls.ts exactly
 *  (same expiry formula: deadline + 7 days grace, evaluated against the
 *  ttlSeconds contract signCapabilityWithEnv expects). Re-issuing invalidates
 *  the invitee's previous link by design — see resolveInvitee's comment. */
async function mintAndStoreInviteeUrl(env: Env, poll: Poll, invitee: PollInvitee, now: Date): Promise<string> {
  const ttlSeconds = Math.max(1, Math.round((Date.parse(poll.deadlineUtc) - now.getTime()) / 1000)) + 7 * 86_400;
  const token = await signCapabilityWithEnv(
    { purpose: "poll-response", pollId: poll.id, inviteeId: invitee.id, subject: poll.subject, ttlSeconds },
    env,
  );
  await setInviteeTokenHash(env.DB, invitee.id, await hashToken(token, hashingKey(env)));
  return `${env.OAUTH_ISSUER}/poll/${poll.id}?t=${encodeURIComponent(token)}`;
}

// One email per non-responder, via T5's nudge renderer. A no-op (no email
// sent) when everyone required has already responded — the caller still
// stamps the nudge column so this cadence check doesn't re-run every tick.
async function nudgeNonResponders(
  env: Env,
  poll: Poll,
  notification: NotificationProvider,
  now: Date,
): Promise<void> {
  const invitees = await listInvitees(env.DB, poll.id);
  const nonDropped = invitees.filter((i) => !i.dropped);
  const nonResponders = nonDropped.filter((i) => i.respondedAt === null);
  const respondedCount = nonDropped.length - nonResponders.length;
  const totalCount = nonDropped.length;
  for (const invitee of nonResponders) {
    const inviteeUrl = await mintAndStoreInviteeUrl(env, poll, invitee, now);
    const content = renderNudgeEmail({
      pollTitle: poll.title,
      organiserName: poll.subject,
      durationMin: poll.durationMin,
      rangeStart: poll.rangeStart,
      rangeEnd: poll.rangeEnd,
      deadlineUtc: poll.deadlineUtc,
      inviteeUrl,
      respondedCount,
      totalCount,
    });
    const email: PollEmail = { to: invitee.email, ...content };
    await notification.sendPollEmail(email);
  }
}

interface SweepOutcome {
  deadlineProcessed: boolean;
  nudgedFinal: boolean;
  nudgedMidpoint: boolean;
}

async function sweepOnePoll(
  env: Env,
  poll: Poll,
  now: Date,
  bookAtDeadline: BookAtDeadline,
  makeNotification: (subject: string) => NotificationProvider | Promise<NotificationProvider>,
): Promise<SweepOutcome> {
  const deadlineMs = Date.parse(poll.deadlineUtc);
  if (now.getTime() >= deadlineMs) {
    await bookAtDeadline(env, poll.id);
    return { deadlineProcessed: true, nudgedFinal: false, nudgedMidpoint: false };
  }

  const createdMs = Date.parse(poll.createdAt);
  // Computed from immutable created_at, not stamped, so neither guard can
  // re-arm on its own — but both still compose with updateMeetingPoll's deadlineUtc arm: pushing
  // the deadline out re-evaluates them against the new deadlineMs on the
  // next tick.
  const ageOk = now.getTime() - createdMs >= MIN_NUDGE_AGE_MS;

  // A poll born inside the final-nudge window (deadline - 24h already past at
  // creation) never final-nudges — the invite itself already carries the
  // urgency, and firing here would rotate the invitee token out from under
  // the link just emailed (see the internal backlog, "a poll created inside the 24h
  // nudge window"). Composes with updateMeetingPoll {deadlineUtc}: pushing the deadline out
  // past created_at + 24h makes the poll eligible for a real final nudge.
  const finalDue =
    now.getTime() >= deadlineMs - FINAL_NUDGE_LEAD_MS &&
    createdMs < deadlineMs - FINAL_NUDGE_LEAD_MS &&
    ageOk &&
    poll.nudgedFinalAt === null;

  const lifetimeMs = deadlineMs - createdMs;
  const midpointDue =
    lifetimeMs > MIDPOINT_LIFETIME_THRESHOLD_MS &&
    now.getTime() >= createdMs + lifetimeMs / 2 &&
    ageOk &&
    poll.nudgedMidpointAt === null;

  // A poll first swept late (downtime, or a deadline extension) can have
  // both cadences due at once. Stamp both columns, but send each
  // non-responder a single combined email rather than two near-duplicates.
  if (finalDue || midpointDue) {
    await nudgeNonResponders(env, poll, await makeNotification(poll.subject), now);
    if (finalDue) await markNudged(env.DB, poll.id, "final", now.toISOString());
    if (midpointDue) await markNudged(env.DB, poll.id, "midpoint", now.toISOString());
  }

  return { deadlineProcessed: false, nudgedFinal: finalDue, nudgedMidpoint: midpointDue };
}

export async function runPollSweep(env: Env, now: Date, deps: PollSweepDeps): Promise<PollSweepResult> {
  const bookAtDeadline = deps.bookAtDeadline;
  const makeNotification = deps.makeNotification ?? ((subject: string) => defaultNotificationProvider(env, subject));

  const subjects = await listSubjects(env);
  const nowIso = now.toISOString();
  let checked = 0;
  let deadlineProcessed = 0;
  let nudgedFinal = 0;
  let nudgedMidpoint = 0;
  let failed = 0;

  // Per-subject fan-out with per-poll try/catch isolation — one poll's
  // failure (a throwing bookAtDeadline, a notification-send error) must
  // never abort the sweep for the rest, same posture as the Monday cron.
  for (const subject of subjects) {
    const polls = await listOpenPollsDue(env.DB, subject, nowIso);
    for (const poll of polls) {
      checked += 1;
      try {
        const outcome = await sweepOnePoll(env, poll, now, bookAtDeadline, makeNotification);
        if (outcome.deadlineProcessed) deadlineProcessed += 1;
        if (outcome.nudgedFinal) nudgedFinal += 1;
        if (outcome.nudgedMidpoint) nudgedMidpoint += 1;
      } catch (e) {
        failed += 1;
        console.error("poll-sweep: poll failed", { pollId: poll.id, subject, error: String(e) });
      }
    }
  }

  const summary = { checked, deadlineProcessed, nudgedFinal, nudgedMidpoint, failed };
  console.info("poll_sweep", summary);
  return summary;
}
