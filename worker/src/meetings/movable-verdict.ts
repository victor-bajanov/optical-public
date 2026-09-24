/** The planner's persisted answer to "can Optical actually relocate this
 *  meeting?", stamped on the meeting's task body by every resolve.
 *
 *  It exists because the decision is otherwise invisible outside the resolve
 *  that made it: degrade-to-immovable (unreadable attendee free/busy), the
 *  imminent-notice freeze and the commit-stability hold are all in-memory
 *  filters over the promoted set — they write nothing, so a frozen meeting is
 *  indistinguishable in D1 from a movable one. The booking page needs that
 *  answer to decide whether offering the meeting's time to a stranger is a
 *  promise Optical can keep. */
export interface MovableVerdict {
  /** ISO-Z instant of the resolve that produced this verdict. */
  at: string;
  /** True only when the meeting was promoted to the solver as movable. */
  ok: boolean;
  /** Why it was frozen; null when ok. */
  reason: MovableVerdictReason | null;
}

export type MovableVerdictReason =
  /** The meeting's task row outlived its calendar event (deleted/cancelled). */
  | "event_missing"
  /** Starts within MEETING_MIN_NOTICE_MINUTES — no move is allowed. */
  | "imminent_notice"
  /** Committed-moved within MEETING_COMMIT_STABILITY_MINUTES — held in place. */
  | "commit_stability"
  /** A constraining attendee's free/busy was unreadable, so no new slot can be
   *  confirmed free for the party. Persistent in practice (missing
   *  calendar.freebusy consent, a private attendee calendar). */
  | "attendee_availability_unknown"
  /** The availability mask came back empty; promoting would let the solver
   *  treat the meeting as unconstrained. */
  | "no_availability_windows"
  /** No attendee constrains the meeting under the effective enforcement policy
   *  (e.g. an 'accepted' policy and nobody has accepted yet, or Google omitted
   *  every responseStatus). An empty constraining set means nobody's
   *  availability is known — never that nobody's availability matters — so the
   *  meeting is held exactly as if their free/busy were unreadable. */
  | "no_constraining_attendees";

/** How long a verdict may be trusted by the booking page.
 *
 *  A verdict is a statement about a moment: these attendees were readable and
 *  free elsewhere *then*. One week is the cadence of the guaranteed refresh —
 *  the Sunday `monday-resolve` cron re-stamps every meeting in the week it
 *  resolves (calendar webhooks re-stamp far more often in practice). So a
 *  verdict older than a week means the meeting's week has not been re-evaluated
 *  since the last scheduled resolve, or that OWNED_MEETINGS_ENABLED has been
 *  turned off and nothing maintains these rows any more. Either way we no
 *  longer know the meeting is movable, and the booking page must fail closed. */
export const MOVABLE_VERDICT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** True when `verdict` says this meeting is movable AND is recent enough to be
 *  believed at `now`. Anything missing, malformed, negative or stale is false —
 *  absence of a verdict must never read as permission. */
export function isMovableVerdictUsable(verdict: unknown, now: Date): boolean {
  if (!verdict || typeof verdict !== "object") return false;
  const v = verdict as Partial<MovableVerdict>;
  if (v.ok !== true) return false;
  if (typeof v.at !== "string") return false;
  const at = Date.parse(v.at);
  if (!Number.isFinite(at)) return false;
  // A future `at` (clock skew between the resolve and this read) is treated as
  // fresh; only age is disqualifying.
  return now.getTime() - at <= MOVABLE_VERDICT_MAX_AGE_MS;
}

/** Persist one verdict per meeting task, as a single D1 batch.
 *
 *  Patches ONLY `$.movable_verdict` via json_set, so a concurrent write to any
 *  other part of the body is not clobbered, and deliberately leaves the
 *  `updated_at` column alone: the verdict carries its own timestamp and a
 *  resolve is not a user-visible edit of the task.
 *
 *  Best-effort by contract — the caller must not let a stamping failure fail a
 *  resolve. A missed stamp ages out and the booking page fails closed. */
export async function stampMovableVerdicts(
  db: D1Database,
  ownerSubject: string,
  verdicts: Map<string, MovableVerdict>,
): Promise<void> {
  if (verdicts.size === 0) return;
  const stmts = [...verdicts].map(([taskId, verdict]) =>
    db
      .prepare(
        "UPDATE tasks SET body = json_set(body, '$.movable_verdict', json(?)) WHERE id = ? AND owner_subject = ?",
      )
      .bind(JSON.stringify(verdict), taskId, ownerSubject),
  );
  await db.batch(stmts);
}
