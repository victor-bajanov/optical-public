import { describe, it, expect } from "vitest";
import { buildSolverProblem } from "../../src/planning/build-problem";

const base = {
  externalEvents: [],
  previousSchedule: [],
  window: { start: "2026-06-15T00:00:00Z", end: "2026-06-20T00:00:00Z" },
  weights: {} as any,
  contexts: [] as any,
  tz: "UTC",
  businessHours: undefined as any,
  tentativeIsBusy: false,
};

const twoChunkTask = {
  id: "t1",
  title: "Two sessions",
  context: "deep",
  priority: 80,
  chunks: [{ duration_minutes: 30 }, { duration_minutes: 30 }],
  group_policy: { same_day: false, ordered: false },
  earliest_start: "2026-06-15T00:00:00Z",
} as any;

describe("buildSolverProblem completed-chunk dropping", () => {
  it("omits a completed chunk from the task's chunk list", () => {
    const problem = buildSolverProblem({
      ...base,
      tasks: [twoChunkTask],
      completedChunkIds: new Set(["t1#0"]),
    } as any);
    const wireTask = problem.tasks.find((t) => t.id === "t1")!;
    expect(wireTask.chunks.map((c) => c.chunk_id)).toEqual(["t1#1"]);
  });

  it("drops a completed chunk from previous_placement too", () => {
    const problem = buildSolverProblem({
      ...base,
      tasks: [twoChunkTask],
      previousSchedule: [
        { task_id: "t1", chunk_id: "t1#0", start: "2026-06-16T09:00:00Z", end: "2026-06-16T09:30:00Z", context: "deep" },
        { task_id: "t1", chunk_id: "t1#1", start: "2026-06-17T09:00:00Z", end: "2026-06-17T09:30:00Z", context: "deep" },
      ],
      completedChunkIds: new Set(["t1#0"]),
    } as any);
    const wireTask = problem.tasks.find((t) => t.id === "t1")!;
    expect(wireTask.previous_placement.map((p) => p.chunk_id)).toEqual(["t1#1"]);
  });

  it("with no completedChunkIds, behavior is unchanged (both chunks present)", () => {
    const problem = buildSolverProblem({ ...base, tasks: [twoChunkTask] } as any);
    const wireTask = problem.tasks.find((t) => t.id === "t1")!;
    expect(wireTask.chunks.map((c) => c.chunk_id)).toEqual(["t1#0", "t1#1"]);
  });
});
