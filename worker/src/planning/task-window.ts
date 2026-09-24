// Window-relative task shedding. A task is included in a resolve only when it
// "belongs" to the window being resolved. Pastness is judged statelessly
// against the window start — no global "now", no status transitions. See
// internal design notes.

export interface TaskAnchors {
  /** User pin — the highest-priority positional anchor. */
  pinned_at?: string | null;
  /** Earliest committed chunk start, stamped at commit (system-owned column). */
  scheduled_for?: string | null;
  /** "Not before" floor; a pastness signal ONLY for recurring occurrences. */
  earliest_start?: string | null;
  /** Set (column) iff this row is a materialised recurrence occurrence. */
  template_id?: string | null;
  /** Soft or hard; only `at` is consulted, and only on the past side. */
  deadline?: { at: string } | null;
}

/**
 * Parse an ISO datetime to epoch ms, or null if absent/unparseable. A malformed
 * value is treated as absent so a bad anchor can never silently shed a task.
 */
function toMs(value: string | null | undefined): number | null {
  if (value == null) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The positional anchor: the first present-and-parseable of pinned_at,
 * scheduled_for, then earliest_start (the last only for recurring occurrences).
 * An unparseable candidate is skipped, not adopted as the anchor.
 */
function positionalAnchorMs(a: TaskAnchors): number | null {
  const pinned = toMs(a.pinned_at);
  if (pinned !== null) return pinned;
  const scheduled = toMs(a.scheduled_for);
  if (scheduled !== null) return scheduled;
  if (a.template_id != null) {
    const earliest = toMs(a.earliest_start);
    if (earliest !== null) return earliest;
  }
  return null;
}

/**
 * True when the task belongs to the resolve window [windowStartMs, windowEndMs).
 *
 * - With a positional anchor: included iff the anchor falls inside the window
 *   (deadline is irrelevant — the task is claimed for this week, replan handles
 *   it).
 * - Without a positional anchor: excluded ("overdue") iff it has a deadline
 *   strictly before the window start; otherwise included (live backlog, or
 *   working ahead of a future deadline) — EXCEPT in a window that has not
 *   started yet (windowStartMs > nowMs). A future-week resolve (e.g. a webhook
 *   replan triggered by a new invite weeks out) must not capture the live
 *   backlog: accepting that plan stamps `scheduled_for` into the future week,
 *   which then excludes the task from every current-week resolve (prod
 *   2026-08-12, "Gym" exported to a week four weeks out). A task claims a
 *   future window only explicitly: a deadline at/after the window start
 *   (work-ahead), or an `earliest_start` floor at/after the window start
 *   (combined with the futureness guard above, a floor inside the window).
 */
export function taskBelongsInWindow(
  a: TaskAnchors,
  windowStartMs: number,
  windowEndMs: number,
  nowMs: number,
): boolean {
  // Read-time futureness guard, symmetric to the past-deadline guard below: a
  // task whose earliest_start floor is at/after the window end cannot run this
  // week, so it never belongs here — even if a stale in-window scheduled_for
  // stamp would otherwise anchor it. Applies to all tasks (one-off and
  // recurring) and overrides the positional anchor.
  const earliestMs = toMs(a.earliest_start);
  if (earliestMs !== null && earliestMs >= windowEndMs) return false;

  const anchor = positionalAnchorMs(a);
  if (anchor !== null) {
    return anchor >= windowStartMs && anchor < windowEndMs;
  }
  const deadlineMs = toMs(a.deadline?.at);
  if (deadlineMs !== null && deadlineMs < windowStartMs) return false;
  if (windowStartMs > nowMs && deadlineMs === null) {
    // Pure backlog in a not-yet-started window: only an earliest_start floor
    // targeting the window keeps it (>= start; the guard above already shed
    // floors at/after the window end).
    return earliestMs !== null && earliestMs >= windowStartMs;
  }
  return true;
}
