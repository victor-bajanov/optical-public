import type { ScheduleEntry } from "../diff/compute-diff";

export interface ChurnBaselineInput {
  /** `getCommittedPlanForWeek(...)?.body.schedule` — the committed plan for the
   *  week being resolved, or null/undefined when the subject has none. Absent
   *  and [] are deliberately equivalent: a committed plan whose entries have
   *  all been completed or filtered away is no more of a baseline than no plan
   *  at all, and falls through to the calendar the same way. */
  weekPlanSchedule: ScheduleEntry[] | null | undefined;
  /** Scheduler-owned calendar events already fetched for this window. */
  priorEvents: ScheduleEntry[];
  windowStartMs: number;
  windowEndMs: number;
}

/** In-window entries, at most one per chunk_id (the earliest start wins), in
 *  first-appearance order. Two calendar events can carry the same
 *  scheduler_chunk_id — commit's stray-event repair only heals chunks with NO
 *  in-window event (2026-07-06) — and the solver's two churn paths resolve a
 *  duplicated chunk oppositely (first-wins when compiling placements,
 *  last-wins when building the objective) with no schema error to catch it. So
 *  the baseline is made chunk-unique here, on start rather than on position:
 *  calendar fetch order is not guaranteed, and a baseline that depends on it
 *  would price churn differently run to run. */
function inWindow(entries: ScheduleEntry[], startMs: number, endMs: number): ScheduleEntry[] {
  const byChunk = new Map<string, ScheduleEntry>();
  for (const e of entries) {
    const ms = Date.parse(e.start);
    if (!Number.isFinite(ms) || ms < startMs || ms >= endMs) continue;
    const seen = byChunk.get(e.chunk_id);
    if (!seen || ms < Date.parse(seen.start)) byChunk.set(e.chunk_id, e);
  }
  return [...byChunk.values()];
}

/**
 * The churn baseline for a resolve: what the solver should treat as "where
 * these chunks are now", so moving them costs churn.
 *
 * The committed plan for the week wins whenever it still has an entry inside
 * the window — it is the *intended* baseline, kept in sync with hand-drags by
 * the manual-move write-back, and it anchors chunks whose calendar event the
 * user has deleted. The live calendar takes over only when the plan yields
 * nothing in-window: no committed plan for the week at all, or one whose
 * in-window entries have all elapsed under a mid-week narrowing.
 *
 * Source selection is all-or-nothing and happens AFTER the window filter: a
 * partially surviving plan (the normal mid-week-replan shape — a Mon-anchored
 * plan against a Wed-narrowed window) is a non-empty baseline and is used with
 * exactly its surviving subset. Topping it up per chunk from the calendar would
 * re-anchor the very chunks the write-back deliberately updated.
 *
 * Both sources go through the same filter-and-dedupe here (priorEvents is
 * already window-fetched, and a plan's schedule is chunk-unique by
 * construction) so the invariant lives in one place: an out-of-window anchor
 * has no meaningful churn distance to anything being placed now, and passing
 * one through makes the solver constrain placements to impossible slots and
 * eventually crash (bug doc 2026-05-22).
 */
export function computeChurnBaseline(input: ChurnBaselineInput): ScheduleEntry[] {
  const fromPlan = inWindow(input.weekPlanSchedule ?? [], input.windowStartMs, input.windowEndMs);
  if (fromPlan.length > 0) return fromPlan;
  return inWindow(input.priorEvents, input.windowStartMs, input.windowEndMs);
}
