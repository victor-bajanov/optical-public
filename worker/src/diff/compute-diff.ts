export interface ScheduleEntry {
  task_id: string;
  chunk_id: string;
  start: string;
  end: string;
  context: string;
}

export interface DroppedEntry {
  task_id: string;
  title: string;
  drop_cost: number;
  reason: string;
  contributing_constraints: string[];
}

export interface PlanBody {
  schedule: ScheduleEntry[];
  dropped: DroppedEntry[];
  window: { start: string; end: string };
}

export interface Move {
  task_id: string;
  chunk_id: string;
  from: ScheduleEntry;
  to: ScheduleEntry;
}

export interface PlanDiff {
  moved: Move[];
  added: ScheduleEntry[];
  removed: ScheduleEntry[];
  dropped: DroppedEntry[];
  // The subset of `dropped` whose task was NOT already dropped in the committed
  // baseline — i.e. genuinely new "couldn't fit" news. A task that was dropped in
  // the last accepted plan and is still dropped is not a change (see isEmpty).
  // Always populated by computePlanDiff; optional only so hand-built test fixtures
  // that don't exercise it stay terse.
  newlyDropped?: DroppedEntry[];
  isEmpty: boolean;
}

function key(e: ScheduleEntry): string {
  return e.chunk_id;
}

// Compare two timestamps by the instant they denote, not by string form. Times
// reaching the diff may differ in surface form (e.g. Google's offset-form
// `+10:00` vs the solver's canonical `Z`, or differing millisecond precision)
// while denoting the same moment; a naive string compare would report those as
// "moved". Matches the instant-based comparison used in planning/commit.ts.
function sameInstant(a: string, b: string): boolean {
  return Date.parse(a) === Date.parse(b);
}

export function computePlanDiff(proposed: PlanBody, committed: PlanBody | null): PlanDiff {
  const cMap = new Map<string, ScheduleEntry>();
  if (committed) for (const e of committed.schedule) cMap.set(key(e), e);
  const pMap = new Map<string, ScheduleEntry>();
  for (const e of proposed.schedule) pMap.set(key(e), e);

  const moved: Move[] = [];
  const added: ScheduleEntry[] = [];
  const removed: ScheduleEntry[] = [];

  for (const [k, p] of pMap) {
    const prev = cMap.get(k);
    if (!prev) {
      added.push(p);
    } else if (!sameInstant(prev.start, p.start) || !sameInstant(prev.end, p.end)) {
      moved.push({ task_id: p.task_id, chunk_id: p.chunk_id, from: prev, to: p });
    }
  }
  for (const [k, c] of cMap) {
    if (!pMap.has(k)) removed.push(c);
  }

  const dropped = proposed.dropped.slice();
  // A drop only counts as a change when it is NEW relative to the committed
  // baseline's dropped set. A persistently-unfittable task (e.g. Lunch) that was
  // already dropped in the last accepted plan and is still dropped must not, on
  // its own, defeat the no-op gate — otherwise every unrelated calendar edit
  // re-emails an identical BEFORE/AFTER plan (2026-07-07 incident). A drop that
  // genuinely matters (a previously-SCHEDULED task now dropped) already surfaces
  // as a `removed` calendar event and fires the email through that path.
  const committedDropped = new Set((committed?.dropped ?? []).map((d) => d.task_id));
  const newlyDropped = dropped.filter((d) => !committedDropped.has(d.task_id));
  const isEmpty =
    moved.length === 0 && added.length === 0 && removed.length === 0 && newlyDropped.length === 0;
  return { moved, added, removed, dropped, newlyDropped, isEmpty };
}
