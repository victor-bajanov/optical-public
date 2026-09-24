import { describe, it, expect } from "vitest";
import { buildSolverProblem } from "../../src/planning/build-problem";
import type { Task } from "../../src/types/task";
import type { Weights, ContextConfig, BusinessHours, Weekday } from "../../src/planning/solver-contract";

const WEIGHTS: Weights = {
  time_of_day_fit_per_15min: 5,
  churn_per_15min_moved: 10,
  priority_unit: 1,
  base_drop_penalty: 200,
};

const CONTEXTS: ContextConfig[] = [
  {
    context: "deep",
    fit_curve: { peak_start: "09:00", peak_end: "12:00", falloff_end: "16:00" },
    max_minutes_per_day: 240,
    max_contiguous_minutes: 90,
    over_daily_cap_penalty_per_15min: 25,
    over_streak_cap_penalty_per_15min: 25,
  },
];

const BH: BusinessHours = {
  days: ["mon", "tue", "wed", "thu", "fri"],
  start: "09:00",
  end: "17:00",
};

const WINDOW = { start: "2026-06-01T00:00:00Z", end: "2026-06-08T00:00:00Z" };

function baseTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "Deep work",
    context: "deep",
    priority: 70,
    duration_minutes: 90,
    earliest_start: null,
    deadline: null,
    preferred_windows: [],
    dependencies: [],
    pinned_at: null,
    source: { kind: "mcp", external_id: null },
    status: "pending",
    created_at: "2026-05-30T00:00:00Z",
    updated_at: "2026-05-30T00:00:00Z",
    ...overrides,
  } as Task;
}

describe("buildSolverProblem business-hours passthrough", () => {
  // Business hours is now a first-class Problem field applied solver-side as a
  // presence-gated placement floor (see solver model.py _add_business_hours).
  // buildSolverProblem must pass it through verbatim and must NOT mutate any
  // task's preferred_windows — injecting it per-task as a hard window made
  // tasks mandatory and turned overloaded weeks into 422 unsat.
  it("passes business_hours through to the Problem and leaves tasks untouched", () => {
    const problem = buildSolverProblem({
      tasks: [baseTask()],
      externalEvents: [],
      previousSchedule: [],
      window: WINDOW,
      weights: WEIGHTS,
      contexts: CONTEXTS,
      tz: "Australia/Sydney",
      businessHours: BH,
    });
    expect(problem.business_hours).toEqual(BH);
    expect(problem.tasks[0]!.preferred_windows).toHaveLength(0);
  });

  it("emits business_hours: null when the arg is omitted (backwards compat)", () => {
    const problem = buildSolverProblem({
      tasks: [baseTask()],
      externalEvents: [],
      previousSchedule: [],
      window: WINDOW,
      weights: WEIGHTS,
      contexts: CONTEXTS,
      tz: "Australia/Sydney",
    });
    expect(problem.business_hours).toBeNull();
    expect(problem.tasks[0]!.preferred_windows).toHaveLength(0);
  });

  it("preserves a task's own preferred_windows verbatim", () => {
    const ownWindow = {
      days: ["tue"] as Weekday[],
      start: "14:00",
      end: "16:00",
      hard: false,
    };
    const problem = buildSolverProblem({
      tasks: [baseTask({ preferred_windows: [ownWindow] })],
      externalEvents: [],
      previousSchedule: [],
      window: WINDOW,
      weights: WEIGHTS,
      contexts: CONTEXTS,
      tz: "Australia/Sydney",
      businessHours: BH,
    });
    expect(problem.tasks[0]!.preferred_windows).toEqual([ownWindow]);
    expect(problem.business_hours).toEqual(BH);
  });

  it("does not add windows to a pinned task", () => {
    const problem = buildSolverProblem({
      tasks: [baseTask({ pinned_at: "2026-06-02T19:00:00Z" })],
      externalEvents: [],
      previousSchedule: [],
      window: WINDOW,
      weights: WEIGHTS,
      contexts: CONTEXTS,
      tz: "Australia/Sydney",
      businessHours: BH,
    });
    expect(problem.tasks[0]!.preferred_windows).toHaveLength(0);
    expect(problem.business_hours).toEqual(BH);
  });
});
