import { describe, it, expect } from "vitest";
import { buildSolverProblem } from "../../src/planning/build-problem";
import type { Task } from "../../src/types/task";

const WEIGHTS = { time_of_day_fit_per_15min: 0, churn_per_15min_moved: 1, priority_unit: 1, base_drop_penalty: 200 };

function meetingTask(): Task {
  return {
    id: "task-m1",
    title: "Standup",
    context: "meeting",
    priority: 100,
    duration_minutes: 30,
    must_include: true,
    source: { kind: "meeting", external_id: "evt1" },
    status: "pending",
    created_at: "2026-05-18T00:00:00Z",
    updated_at: "2026-05-18T00:00:00Z",
  } as Task;
}

describe("build-problem meeting promotion", () => {
  it("excludes the movable meeting event from external_pinned and sets mask/multiplier/anchor", () => {
    const problem = buildSolverProblem({
      tasks: [meetingTask()],
      externalEvents: [
        {
          id: "evt1",
          summary: "Standup",
          start: "2026-05-19T09:00:00Z",
          end: "2026-05-19T09:30:00Z",
          extendedProperties: {},
        },
      ],
      previousSchedule: [],
      window: { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" },
      weights: WEIGHTS,
      contexts: [],
      tz: "UTC",
      meetingInputs: [
        {
          taskId: "task-m1",
          eventId: "evt1",
          currentStartISO: "2026-05-19T09:00:00Z",
          durationMinutes: 30,
          availabilityWindowsISO: [
            { start: "2026-05-19T09:00:00Z", end: "2026-05-19T12:00:00Z" },
          ],
          churnMultiplier: 6,
        },
      ],
    });

    // evt1 must NOT appear as external_pinned (it's now movable).
    expect(problem.external_pinned.find((p) => p.id === "evt1")).toBeUndefined();

    const wire = problem.tasks.find((t) => t.id === "task-m1")!;
    expect(wire.churn_multiplier).toBe(6);
    expect(wire.availability_windows?.[0]?.start).toBe("2026-05-19T09:00:00");
    // churn anchor = live calendar position, regardless of previousSchedule
    expect(wire.previous_placement).toEqual([{ chunk_id: "task-m1#0", start: "2026-05-19T09:00:00" }]);
  });

  it("floors a promoted meeting's earliest_start to the placement floor (so it can move EARLIER than its current slot)", () => {
    // sync.ts stamps the meeting row's earliest_start with the live event time as
    // a marker. That must NOT survive into the wire as a hard lower bound: the
    // availability mask is the authoritative placement constraint, and a meeting
    // must be free to move to an earlier in-mask slot when its current slot is
    // taken. Regression: a meeting at 16:00 whose only free in-mask slots are
    // earlier (09:00–12:00) dropped as unplaceable because earliest_start=16:00
    // forbade them.
    const task = { ...meetingTask(), earliest_start: "2026-05-19T16:00:00Z" } as Task;
    const problem = buildSolverProblem({
      tasks: [task],
      externalEvents: [
        { id: "evt1", summary: "Standup", start: "2026-05-19T16:00:00Z", end: "2026-05-19T16:30:00Z", extendedProperties: {} },
      ],
      previousSchedule: [],
      window: { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" },
      weights: WEIGHTS,
      contexts: [],
      tz: "UTC",
      meetingInputs: [
        {
          taskId: "task-m1",
          eventId: "evt1",
          currentStartISO: "2026-05-19T16:00:00Z",
          durationMinutes: 30,
          availabilityWindowsISO: [
            { start: "2026-05-19T09:00:00Z", end: "2026-05-19T12:00:00Z" },
            { start: "2026-05-19T13:00:00Z", end: "2026-05-19T16:30:00Z" },
          ],
          churnMultiplier: 1,
        },
      ],
    });
    const wire = problem.tasks.find((t) => t.id === "task-m1")!;
    // Floored to the placement floor (defaults to window.start), NOT 16:00.
    expect(wire.earliest_start).toBe("2026-05-18T00:00:00");
  });

  it("floors a promoted meeting's earliest_start at placementFloor + min-notice", () => {
    const task = { ...meetingTask(), earliest_start: "2026-05-19T16:00:00Z" } as Task;
    const problem = buildSolverProblem({
      tasks: [task],
      externalEvents: [
        { id: "evt1", summary: "Standup", start: "2026-05-19T16:00:00Z", end: "2026-05-19T16:30:00Z", extendedProperties: {} },
      ],
      previousSchedule: [],
      window: { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" },
      placementFloor: "2026-05-19T10:00:00Z",
      meetingMinNoticeMinutes: 120, // 2h → now + 2h
      weights: WEIGHTS,
      contexts: [],
      tz: "UTC",
      meetingInputs: [
        {
          taskId: "task-m1",
          eventId: "evt1",
          currentStartISO: "2026-05-19T16:00:00Z",
          durationMinutes: 30,
          availabilityWindowsISO: [{ start: "2026-05-19T12:00:00Z", end: "2026-05-19T16:30:00Z" }],
          churnMultiplier: 1,
        },
      ],
    });
    const wire = problem.tasks.find((t) => t.id === "task-m1")!;
    // 10:00 placement floor + 2h min-notice = 12:00.
    expect(wire.earliest_start).toBe("2026-05-19T12:00:00");
  });
});
