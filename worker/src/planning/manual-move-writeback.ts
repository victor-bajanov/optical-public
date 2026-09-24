import { SCHEDULER_CHUNK_ID_KEY, type CalendarEvent } from "../providers/types";
import type { ScheduleEntry } from "../diff/compute-diff";

/** A committed-plan body with a typed schedule. The committed plan also carries
 *  `dropped` and `window`, preserved verbatim via the spread. */
export type PatchablePlanBody = Record<string, unknown> & { schedule: ScheduleEntry[] };

/**
 * Reconcile a committed plan's schedule with the scheduler-owned events currently
 * on the calendar. An entry whose calendar `start` differs (instant-based) from the
 * plan's recorded `start` was hand-moved by the user; rewrite its `start`/`end` to
 * the calendar position (normalized to canonical ISO-Z). Entries whose start is
 * unchanged are our own commit echo and are left alone; chunks not on the calendar
 * keep their existing anchor. Pure — no I/O.
 *
 * The churn baseline reads only this plan's `schedule` (see resolve-internal.ts),
 * so patching it here makes the next replan churn-neutral at the moved position.
 */
export function computeMovedPlanPatch(
  body: PatchablePlanBody,
  schedulerEvents: CalendarEvent[],
): { changed: boolean; body: PatchablePlanBody; movedTaskIds: string[] } {
  const calByChunk = new Map<string, { start: string; end: string }>();
  for (const e of schedulerEvents) {
    const chunkId = e.extendedProperties?.private?.[SCHEDULER_CHUNK_ID_KEY];
    if (!chunkId) continue;
    calByChunk.set(chunkId, { start: e.start, end: e.end });
  }

  let changed = false;
  const moved = new Set<string>();
  const schedule = body.schedule.map((entry) => {
    const cal = calByChunk.get(entry.chunk_id);
    if (!cal) return entry; // not currently on the calendar → keep the anchor
    const calStartMs = Date.parse(cal.start);
    const planStartMs = Date.parse(entry.start);
    // Instant-based: an offset-form calendar start equal to the plan's ISO-Z start
    // is the same moment (our echo), not a move. Unparseable cal start → skip.
    if (!Number.isFinite(calStartMs) || calStartMs === planStartMs) return entry;
    changed = true;
    moved.add(entry.task_id);
    return { ...entry, start: new Date(cal.start).toISOString(), end: new Date(cal.end).toISOString() };
  });

  return changed
    ? { changed, body: { ...body, schedule }, movedTaskIds: [...moved] }
    : { changed: false, body, movedTaskIds: [] };
}

/**
 * Reconcile a task's own constraint fields with a hand-dragged position. A drag
 * is authoritative intent (see internal design notes):
 * the floor follows the drop rather than overriding it. Returns the restamp
 * target plus a body delta to merge — `null` when nothing conflicts (the common
 * case), so the caller can write the body unchanged. Comparisons are instant-based
 * so an offset-form field equal to the canonical-Z drop is not mistaken for a move.
 * Pure — no I/O.
 *
 * - earliest_start: lowered to the drop when the drop precedes it (X6). Keeps a
 *   floor (the new, earlier one), so a later solve won't drift the task further.
 * - pinned_at: moved to the drop so the pin follows the drag (L6).
 */
export function reconcileMovedTask(
  body: Record<string, unknown>,
  newStart: string,
): { scheduledFor: string; bodyPatch: Record<string, unknown> | null } {
  const patch: Record<string, unknown> = {};
  const startMs = Date.parse(newStart);

  const es = body.earliest_start;
  if (typeof es === "string") {
    const esMs = Date.parse(es);
    if (Number.isFinite(esMs) && Number.isFinite(startMs) && startMs < esMs) {
      patch.earliest_start = newStart;
    }
  }

  const pin = body.pinned_at;
  if (typeof pin === "string") {
    const pinMs = Date.parse(pin);
    if (Number.isFinite(pinMs) && Number.isFinite(startMs) && pinMs !== startMs) {
      patch.pinned_at = newStart;
    }
  }

  return { scheduledFor: newStart, bodyPatch: Object.keys(patch).length > 0 ? patch : null };
}
