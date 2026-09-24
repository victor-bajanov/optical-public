import { describe, it, expect } from "vitest";
import { parseSolution, parseUnsatCore } from "../../src/planning/parse-solution";

const SYD = "Australia/Sydney";

describe("parseSolution", () => {
  it("converts local-naive starts back to ISO-Z and derives end from duration_minutes", () => {
    const json = {
      schedule: [
        {
          task_id: "task-A",
          chunk_id: "task-A#0",
          start: "2026-05-19T09:00:00",
          duration_minutes: 60,
          context: "deep",
        },
      ],
      dropped: [],
      objective: {
        total: 0,
        components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 },
      },
      diagnostics: { pass1_wall_seconds: 0.1, pass2_wall_seconds: 0.2, status: "OPTIMAL" },
    };
    const r = parseSolution(json, SYD, new Map());
    expect(r.schedule).toEqual([
      {
        task_id: "task-A",
        chunk_id: "task-A#0",
        start: "2026-05-18T23:00:00.000Z",
        end: "2026-05-19T00:00:00.000Z",
        context: "deep",
      },
    ]);
  });

  it("passes through dropped entries unchanged", () => {
    const json = {
      schedule: [],
      dropped: [
        {
          task_id: "task-X",
          title: "Drop me",
          drop_cost: 230,
          reason: "drop_was_cheaper_than_alternatives",
          contributing_constraints: ["soft_deadline"],
        },
      ],
      objective: {
        total: 230,
        components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 230 },
      },
      diagnostics: { pass1_wall_seconds: 0.1, pass2_wall_seconds: 0.2, status: "OPTIMAL" },
    };
    const r = parseSolution(json, SYD, new Map());
    expect(r.dropped).toEqual(json.dropped);
  });

  it("returns structured objective and diagnostics", () => {
    const json = {
      schedule: [],
      dropped: [],
      objective: {
        total: 1234,
        components: { lateness: 100, fit: 120, churn: 50, daily_cap: 0, streak_cap: 0, drop: 0 },
      },
      diagnostics: { pass1_wall_seconds: 0.42, pass2_wall_seconds: 0.31, status: "OPTIMAL" },
    };
    const r = parseSolution(json, SYD, new Map());
    // preferred_window defaults to 0 when absent in the solver response.
    expect(r.objective).toEqual({
      ...json.objective,
      components: { ...json.objective.components, preferred_window: 0 },
    });
    expect(r.diagnostics).toEqual(json.diagnostics);
  });

  it("rejects responses missing required fields", () => {
    expect(() => parseSolution({ schedule: [], dropped: [] }, SYD, new Map())).toThrow();
    expect(() =>
      parseSolution(
        {
          schedule: [],
          dropped: [],
          objective: { total: 0 },
          diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" },
        },
        SYD,
        new Map(),
      ),
    ).toThrow();
  });

  it("rejects schedule entries with malformed chunk_id", () => {
    const baseObjective = {
      total: 0,
      components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 },
    };
    const baseDiagnostics = { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" };
    // chunk_id without a `#<index>` suffix.
    expect(() =>
      parseSolution(
        {
          schedule: [
            {
              task_id: "task-A",
              chunk_id: "task-A",
              start: "2026-05-19T09:00:00",
              duration_minutes: 60,
              context: "deep",
            },
          ],
          dropped: [],
          objective: baseObjective,
          diagnostics: baseDiagnostics,
        },
        SYD,
        new Map(),
      ),
    ).toThrow();
    // chunk_id with a non-numeric index after `#`.
    expect(() =>
      parseSolution(
        {
          schedule: [
            {
              task_id: "task-A",
              chunk_id: "task-A#abc",
              start: "2026-05-19T09:00:00",
              duration_minutes: 60,
              context: "deep",
            },
          ],
          dropped: [],
          objective: baseObjective,
          diagnostics: baseDiagnostics,
        },
        SYD,
        new Map(),
      ),
    ).toThrow();
  });

  it("surfaces the preferred_window objective component", () => {
    const solverResponse = {
      schedule: [],
      dropped: [],
      objective: {
        total: 7,
        components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0, preferred_window: 7 },
      },
      diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" },
    };
    const result = parseSolution(solverResponse, SYD, new Map());
    expect(result.objective.components.preferred_window).toBe(7);
  });

  it("derives end from the REAL duration when the chunk is in the map (solver rounded up)", () => {
    // Solver was sent a 30-min (rounded-up) chunk but the task's real duration
    // is 20 min; the rendered end must reflect the real 20 minutes, not 30.
    const json = {
      schedule: [
        {
          task_id: "task-A",
          chunk_id: "task-A#0",
          start: "2026-05-19T09:00:00",
          duration_minutes: 30,
          context: "admin",
        },
      ],
      dropped: [],
      objective: {
        total: 0,
        components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 },
      },
      diagnostics: { pass1_wall_seconds: 0.1, pass2_wall_seconds: 0.2, status: "OPTIMAL" },
    };
    const r = parseSolution(json, SYD, new Map([["task-A#0", 20]]));
    expect(r.schedule[0]!.start).toBe("2026-05-18T23:00:00.000Z");
    // start + 20 minutes (real), NOT start + 30 (solver value).
    expect(r.schedule[0]!.end).toBe("2026-05-18T23:20:00.000Z");
  });

  it("falls back to the solver duration when the chunk is absent from the map", () => {
    const json = {
      schedule: [
        {
          task_id: "task-A",
          chunk_id: "task-A#0",
          start: "2026-05-19T09:00:00",
          duration_minutes: 30,
          context: "admin",
        },
      ],
      dropped: [],
      objective: {
        total: 0,
        components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 },
      },
      diagnostics: { pass1_wall_seconds: 0.1, pass2_wall_seconds: 0.2, status: "OPTIMAL" },
    };
    const r = parseSolution(json, SYD, new Map());
    // No mapping for task-A#0 → end falls back to start + 30 (solver value).
    expect(r.schedule[0]!.end).toBe("2026-05-18T23:30:00.000Z");
  });
});

describe("parseUnsatCore", () => {
  it("parses an unsat_core array", () => {
    const json = {
      unsat_core: [
        { type: "pinned_at", task_id: "u-1", value: "2026-05-19T11:00:00" },
        { type: "hard_dependency", task_id: "u-2", ref: "u-1" },
      ],
    };
    const r = parseUnsatCore(json);
    expect(r.unsat_core).toEqual(json.unsat_core);
  });
});
