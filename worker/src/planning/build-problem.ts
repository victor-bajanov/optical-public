import type { Task } from "../types/task";
import type { CalendarEvent } from "../providers/types";
import type {
  Problem,
  WireTask,
  Chunk,
  ExternalPinned,
  PreviousPlacement,
  Weights,
  ContextConfig,
  Window,
  Deadline,
  BusinessHours,
} from "./solver-contract";
import { toLocalNaive, floorToQuarter, ceilToQuarter } from "./datetime";
import { chunkIdsOfTask } from "./chunk-ids";
import { deriveBusyBlocks } from "./busy-blocks";

// Re-export for callers that still import these from build-problem.ts.
export type { Weights, ContextConfig } from "./solver-contract";
// Legacy alias preserved so resolve-internal.ts / resolve.ts don't need
// `SolverWeights` → `Weights` rename in this task.
export type SolverWeights = Weights;

// Schedule-entry shape used as input for previousSchedule. Inline-typed here
// rather than imported from resolve-internal to keep this module unidirectional.
export interface PreviousScheduleEntry {
  task_id: string;
  chunk_id: string;
  start: string; // ISO-Z
  end: string;   // ISO-Z (unused here, kept for shape parity with ResolveBody)
  context: string;
}

export interface MeetingSolverInput {
  taskId: string;
  eventId: string;
  currentStartISO: string; // ISO-Z live calendar start (churn anchor)
  durationMinutes: number;
  availabilityWindowsISO: Array<{ start: string; end: string }>; // ISO-Z
  churnMultiplier: number;
}

export interface BuildSolverProblemInput {
  tasks: Task[];
  externalEvents: CalendarEvent[];
  previousSchedule: PreviousScheduleEntry[];
  window: { start: string; end: string }; // ISO-Z
  // The earliest instant the solver may place a chunk into (ISO-Z), computed by
  // the caller as max(weekStart, ceilToQuarter(now)) — see computePlacementFloor.
  // Decouples PLACEMENT (floored at now) from SELECTION/FETCH (the full week).
  // Used as the solver window.start AND the per-task earliest_start default.
  // Omitted (legacy/unit callers) → falls back to window.start (no floor).
  placementFloor?: string;
  weights: Weights;
  contexts: ContextConfig[];
  tz: string;
  weightsOverride?: Partial<Weights>;
  businessHours?: BusinessHours | null;
  // Decision D (TENTATIVE_IS_BUSY toggle). When false/undefined, events with
  // status "tentative" are dropped from busy time; when true they block like
  // any other busy event. runResolve passes env.TENTATIVE_IS_BUSY === "true".
  tentativeIsBusy?: boolean;
  /** Chunk ids (`<task_id>#<index>`) with a durable completion record. Dropped
   *  from the task's chunk list and previous_placement so the solver places only
   *  remaining work and the completed slots are freed. Optional: omitted/empty =
   *  no chunks completed (legacy + unit callers). */
  completedChunkIds?: Set<string>;
  /** Per-meeting solver metadata for owned movable meetings. Each entry's
   *  taskId matches a task in `tasks`; build-problem stamps its availability
   *  mask + churn multiplier and anchors churn to the live calendar position.
   *  Its eventId is removed from external_pinned so the meeting doesn't block
   *  itself. Omitted/empty = no meetings (today's behaviour). */
  meetingInputs?: MeetingSolverInput[];
  /** Owned-meeting minimum notice in minutes (MEETING_MIN_NOTICE_MINUTES). A
   *  promoted meeting's wire earliest_start is floored at placementFloor + this,
   *  so it may move as early as now + min-notice (the availability mask shares
   *  the same floor) instead of being pinned to its current slot. Default 0. */
  meetingMinNoticeMinutes?: number;
}

function minutesBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 60_000);
}

/** Round a task/chunk duration UP to the next quarter hour. The solver schedules
 *  work in 15-minute blocks and rejects non-15-multiples, so every chunk's
 *  reserved length is rounded up here; the REAL (unrounded) duration is recovered
 *  later from realDurationsByChunkId to render the calendar/email event end. */
const roundUpTo15 = (m: number): number => Math.ceil(m / 15) * 15;

// Instant-domain quarter rounding lives in ./datetime (floorToQuarter /
// ceilToQuarter) so the placement-floor math and the window/event-block math
// share one home and cannot drift. `roundDownToQuarterHour` / `roundUpToQuarterHour`
// are local aliases preserving the original call-site names.
const roundDownToQuarterHour = floorToQuarter;
const roundUpToQuarterHour = ceilToQuarter;

function projectDeadline(d: NonNullable<Task["deadline"]>, tz: string): Deadline {
  return {
    at: toLocalNaive(d.at, tz),
    hard: d.hard,
    penalty_per_15min: d.penalty_per_15min ?? 0,
  };
}

function projectTask(
  t: Task,
  prevByTaskId: Map<string, PreviousPlacement[]>,
  tz: string,
  placementFloorISO: string,
  completedChunkIds: Set<string>,
  meetingByTaskId: Map<string, MeetingSolverInput>,
  meetingMinNoticeMinutes: number,
): WireTask {
  const ids = chunkIdsOfTask(t);
  const allChunks: Chunk[] = t.chunks
    ? t.chunks.map((c, i) => ({ chunk_id: ids[i]!, duration_minutes: roundUpTo15(c.duration_minutes) }))
    : [{ chunk_id: ids[0]!, duration_minutes: roundUpTo15(t.duration_minutes!) }];
  // Completed chunks are done: drop them so the solver places only the
  // remaining work and their reserved slots return to the pool.
  const chunks: Chunk[] = allChunks.filter((c) => !completedChunkIds.has(c.chunk_id));

  const group_policy = t.group_policy ?? { same_day: false, ordered: false };
  // A task with no explicit earliest_start floors at the placement floor (now,
  // rounded up), not the week start — so an undone task is never re-placed onto
  // an already-elapsed slot.
  const earliestStartISO = t.earliest_start ?? placementFloorISO;

  const wire: WireTask = {
    id: t.id,
    title: t.title,
    context: t.context,
    priority: t.priority,
    chunks,
    group_policy,
    earliest_start: toLocalNaive(earliestStartISO, tz),
    // Business hours is applied solver-side as a global placement floor
    // (Problem.business_hours), not injected per-task — see solver model.py
    // _add_business_hours. Tasks carry only their own preferred_windows.
    preferred_windows: t.preferred_windows ?? [],
    dependencies: (t.dependencies ?? []).map((d) => ({
      type: d.type,
      ref: d.ref,
      hard: d.hard,
    })),
    previous_placement: (prevByTaskId.get(t.id) ?? []).filter((p) => !completedChunkIds.has(p.chunk_id)),
    must_include: t.must_include ?? false,
  };
  if (t.deadline) wire.deadline = projectDeadline(t.deadline, tz);
  // Past hard-pin release: a pin strictly before the placement floor (a pinned
  // slot that has already elapsed) is dropped, so the chunk becomes movable and
  // reschedules forward instead of compiling to an infeasible hard constraint
  // that drops the whole task. Pins at/after the floor stay hard.
  if (t.pinned_at && Date.parse(t.pinned_at) >= Date.parse(placementFloorISO)) {
    wire.pinned_at = toLocalNaive(t.pinned_at, tz);
  }

  const meeting = meetingByTaskId.get(t.id);
  if (meeting) {
    // The meeting row's earliest_start carries the LIVE event time as a marker
    // (sync.ts), but the availability mask below is the authoritative placement
    // constraint. Leaving earliest_start at the meeting time emits a hard lower
    // bound that forbids every earlier in-mask slot, so a meeting whose current
    // slot is taken but whose only free slots are EARLIER drops as unplaceable.
    // Floor it at placementFloor + min-notice (≈ now + min-notice), the same
    // floor the availability mask uses — so a meeting may move as early as the
    // min-notice horizon allows (e.g. a meeting tomorrow can move to now + 2h).
    const meetingFloorISO = new Date(
      Date.parse(placementFloorISO) + meetingMinNoticeMinutes * 60_000,
    ).toISOString();
    wire.earliest_start = toLocalNaive(meetingFloorISO, tz);
    // Hard availability mask (already unioned with the current slot upstream).
    wire.availability_windows = meeting.availabilityWindowsISO.map((w) => ({
      start: toLocalNaive(roundDownToQuarterHour(w.start), tz),
      end: toLocalNaive(roundDownToQuarterHour(w.end), tz),
    }));
    wire.churn_multiplier = meeting.churnMultiplier;
    // Churn anchor = LIVE calendar position, NOT the committed plan. Overrides
    // any previous_placement derived from previousSchedule (a moved meeting reads
    // back at its new calendar time next resolve → churn 0 → stable; see §5.6).
    const chunkId = wire.chunks[0]?.chunk_id;
    if (chunkId) {
      wire.previous_placement = [
        { chunk_id: chunkId, start: toLocalNaive(roundDownToQuarterHour(meeting.currentStartISO), tz) },
      ];
    }
  }

  return wire;
}

export function buildSolverProblem(input: BuildSolverProblemInput): Problem {
  const tz = input.tz;

  // PLACEMENT floor (rounded DOWN to a slot the solver accepts) drives both the
  // solver window.start and the per-task earliest_start default. When the caller
  // omits placementFloor (legacy/unit), fall back to window.start — preserving
  // the prior "start of week" behavior. SELECTION/FETCH stay week-wide upstream;
  // window.end is always the week end.
  const placementFloorRoundedISO = roundDownToQuarterHour(
    input.placementFloor ?? input.window.start,
  );

  const window: Window = {
    // start rounds DOWN, end rounds UP: conservative outer-boundary rounding
    // ensures the solver's window fully contains the real requested span.
    start: toLocalNaive(placementFloorRoundedISO, tz),
    end: toLocalNaive(roundUpToQuarterHour(input.window.end), tz),
    tz,
  };

  const completedChunkIds = input.completedChunkIds ?? new Set<string>();

  const meetingInputs = input.meetingInputs ?? [];
  const meetingByTaskId = new Map(meetingInputs.map((m) => [m.taskId, m]));
  const movableMeetingEventIds = new Set(meetingInputs.map((m) => m.eventId));

  const prevByTaskId = new Map<string, PreviousPlacement[]>();
  for (const entry of input.previousSchedule) {
    const list = prevByTaskId.get(entry.task_id) ?? [];
    list.push({ chunk_id: entry.chunk_id, start: toLocalNaive(roundDownToQuarterHour(entry.start), tz) });
    prevByTaskId.set(entry.task_id, list);
  }

  // External calendar events are busy-time the scheduler must avoid, not
  // constraints to satisfy. Movable meetings are excluded because they are
  // tasks in the model, not busy blocks. See planning/busy-blocks.ts for the
  // full free/busy rule set.
  const merged = deriveBusyBlocks(input.externalEvents, {
    tz,
    tentativeIsBusy: input.tentativeIsBusy,
    excludeEventIds: movableMeetingEventIds,
  });

  const external_pinned: ExternalPinned[] = merged.map((m) => ({
    id: m.id,
    title: m.title,
    start: toLocalNaive(m.startUtc, tz),
    duration_minutes: minutesBetween(m.startUtc, m.endUtc),
    context: "meeting" as const,
  }));

  return {
    window,
    weights: { ...input.weights, ...(input.weightsOverride ?? {}) },
    contexts: input.contexts,
    tasks: input.tasks.map((t) =>
      projectTask(t, prevByTaskId, tz, placementFloorRoundedISO, completedChunkIds, meetingByTaskId, input.meetingMinNoticeMinutes ?? 0),
    ),
    external_pinned,
    business_hours: input.businessHours ?? null,
  };
}

/** Chunk-id → REAL (unrounded) duration in minutes. The solver receives each
 *  chunk's duration rounded UP to the next quarter hour (see roundUpTo15); this
 *  recovers the original requested duration so parse-solution can render the
 *  calendar/email event end from the real length, not the padded one. Uses the
 *  SAME `${t.id}#${i}` key convention as chunkIdsOfTask (chunk-ids.ts) so the
 *  two cannot drift. */
export function realDurationsByChunkId(tasks: Task[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tasks) {
    if (t.chunks) t.chunks.forEach((c, i) => m.set(`${t.id}#${i}`, c.duration_minutes));
    else m.set(`${t.id}#0`, t.duration_minutes!);
  }
  return m;
}
