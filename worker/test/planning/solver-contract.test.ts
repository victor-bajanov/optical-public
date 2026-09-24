import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { buildSolverProblem } from "../../src/planning/build-problem";
import * as scenarios from "../fixtures/contract-scenarios";
import type { Problem, WireTask, LocalNaive, ContextConfig, Weights } from "../../src/planning/solver-contract";
import type { Task } from "../../src/types/task";

const SOLVER_DIR = path.resolve(__dirname, "../../../solver");
const VALIDATOR = path.resolve(SOLVER_DIR, "bin/validate-problem.py");

function validateAgainstSolver(problem: unknown): { ok: boolean; stderr: string } {
  const r = spawnSync(
    "uv",
    ["run", "--project", SOLVER_DIR, "python", VALIDATOR],
    {
      input: JSON.stringify(problem),
      encoding: "utf-8",
      timeout: 30_000,
    },
  );
  return { ok: r.status === 0, stderr: r.stderr ?? "" };
}

/** Minimal valid Problem suitable for wire-contract shape tests. */
function makeMinimalProblem(): Problem {
  const task: WireTask = {
    id: "wire-t1",
    title: "Wire task",
    context: "meeting",
    priority: 50,
    chunks: [{ chunk_id: "wire-t1#0", duration_minutes: 60 }],
    group_policy: { same_day: false, ordered: false },
    earliest_start: "2026-05-19T00:00:00" as LocalNaive,
    preferred_windows: [],
    dependencies: [],
    previous_placement: [],
    must_include: false,
  };
  return {
    window: {
      start: "2026-05-19T00:00:00" as LocalNaive,
      end: "2026-05-26T00:00:00" as LocalNaive,
      tz: "Australia/Sydney",
    },
    weights: {
      time_of_day_fit_per_15min: 5,
      churn_per_15min_moved: 10,
      priority_unit: 1,
      base_drop_penalty: 200,
    },
    contexts: [
      {
        context: "meeting",
        fit_curve: { peak_start: "10:00", peak_end: "11:00", falloff_end: "17:00" },
        max_minutes_per_day: 180,
        max_contiguous_minutes: 120,
        over_daily_cap_penalty_per_15min: 25,
        over_streak_cap_penalty_per_15min: 25,
      },
    ],
    tasks: [task],
    external_pinned: [],
  };
}

describe.skipIf(process.env.SKIP_SOLVER_CONTRACT === "1")("solver-contract", () => {
  for (const [name, input] of Object.entries(scenarios)) {
    it(`validates ${name}`, () => {
      const p = buildSolverProblem(input as never);
      const r = validateAgainstSolver(p);
      if (!r.ok) {
        console.error(`Pydantic ValidationError for scenario ${name}:`);
        console.error(r.stderr);
      }
      expect(r.ok).toBe(true);
    });
  }

  it("accepts availability_windows + churn_multiplier on a wire task", () => {
    const problem = makeMinimalProblem();
    const task = problem.tasks[0]!;
    task.availability_windows = [
      { start: "2026-05-19T09:00:00" as LocalNaive, end: "2026-05-19T12:00:00" as LocalNaive },
    ];
    task.churn_multiplier = 6;
    const r = validateAgainstSolver(problem);
    if (!r.ok) {
      console.error("Pydantic ValidationError for availability_windows + churn_multiplier:");
      console.error(r.stderr);
    }
    expect(r.ok).toBe(true);
  });

  // Card D pin 5: a per-user customised curve + customised weights (the
  // config-to-problem seam pinned in config-to-problem.test.ts) still
  // satisfies the unchanged Pydantic Problem contract — customisation never
  // needs a solver-side change.
  it("accepts a customised-curve + customised-weights Problem built via buildSolverProblem", () => {
    const customisedDeepContext: ContextConfig = {
      context: "deep",
      // Extreme but valid (peak_start <= peak_end <= falloff_end) — a
      // user-chosen curve well outside the instance default.
      fit_curve: { peak_start: "05:00", peak_end: "05:15", falloff_end: "06:00" },
      max_minutes_per_day: 45,
      max_contiguous_minutes: 15,
      over_daily_cap_penalty_per_15min: 500,
      over_streak_cap_penalty_per_15min: 500,
    };
    const otherContexts: ContextConfig[] = (["admin", "physical", "family", "meeting"] as const).map(
      (context) => ({
        context,
        fit_curve: { peak_start: "09:00", peak_end: "12:00", falloff_end: "17:00" },
        max_minutes_per_day: null,
        max_contiguous_minutes: null,
        over_daily_cap_penalty_per_15min: 0,
        over_streak_cap_penalty_per_15min: 0,
      }),
    );
    const customisedWeights: Weights = {
      time_of_day_fit_per_15min: 5,
      churn_per_15min_moved: 47, // customised persistent value (Card D pin 3)
      priority_unit: 1,
      base_drop_penalty: 200,
      // Every real resolve back-fills these two (loadEffectiveWeights /
      // loadWeights) — include them so this payload matches production shape.
      preferred_day_miss: 40,
      preferred_time_miss_per_15min: 5,
    };
    const task: Task = {
      id: "customised-task",
      title: "Deep work",
      context: "deep",
      priority: 70,
      duration_minutes: 30,
      earliest_start: "2026-05-18T00:00:00Z",
      preferred_windows: [],
      dependencies: [],
      pinned_at: null,
      template_id: null,
      project_id: null,
      source: { kind: "mcp", external_id: null },
      status: "pending",
      must_include: false,
      created_at: "2026-05-17T00:00:00Z",
      updated_at: "2026-05-17T00:00:00Z",
    };

    const problem = buildSolverProblem({
      tasks: [task],
      externalEvents: [],
      previousSchedule: [],
      window: { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" },
      weights: customisedWeights,
      contexts: [customisedDeepContext, ...otherContexts],
      tz: "Australia/Sydney",
      // A per-resolve override on top of the already-customised weights row —
      // proves the full precedence chain still yields a contract-valid payload.
      weightsOverride: { churn_per_15min_moved: 999 },
    });

    expect(problem.weights.churn_per_15min_moved).toBe(999);
    expect(problem.contexts.find((c) => c.context === "deep")).toEqual(customisedDeepContext);

    const r = validateAgainstSolver(problem);
    if (!r.ok) {
      console.error("Pydantic ValidationError for customised curve + weights:");
      console.error(r.stderr);
    }
    expect(r.ok).toBe(true);
  });
});
