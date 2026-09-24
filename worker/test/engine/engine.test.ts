// Card E — engine orchestration tests. solveProblem composes substrate →
// pass 1 → MUS/demotion → pass 2 per the spec's proof-state table
// (internal design notes §Proof states) and mirrors
// two_pass.solve's drop reasons, contributing_constraints and objective
// component recomputation.
//
// The whole bench light tier runs as fixtures: statuses must match the
// committed reference run, objective totals AND components must be equal
// wherever the reference proved OPTIMAL, and every SAT schedule is
// re-validated by an independent hard-constraint checker (the TS half of
// the oracle — placement legality only; objective arithmetic is pinned
// per-component in the pass-2 suite and against the reference here).

import { describe, expect, it } from "vitest";
import { bakeProblem, datetimeToSlot } from "../../src/engine/substrate";
import { componentsFromPlacement, solveProblem } from "../../src/engine/engine";
import type { EngineBudgets, Problem, Solution } from "../../src/engine/types";

import reference from "./fixtures/reference-light.json";
import pInfeasibleExternalOverlap from "./fixtures/problems/infeasible_external_overlap.json";

import pAvailabilityWindows from "../../../bench/problems/availability_windows-light.json";
import pBaseline from "../../../bench/problems/baseline-light.json";
import pBusinessHours from "../../../bench/problems/business_hours-light.json";
import pChurn from "../../../bench/problems/churn-light.json";
import pComboChunkedWorkflow from "../../../bench/problems/combo_chunked_workflow-light.json";
import pComboDeadlineWindow from "../../../bench/problems/combo_deadline_window-light.json";
import pComboKitchenSink from "../../../bench/problems/combo_kitchen_sink-light.json";
import pComboMeeting from "../../../bench/problems/combo_meeting-light.json";
import pComboOversubscribed from "../../../bench/problems/combo_oversubscribed-light.json";
import pComboReplan from "../../../bench/problems/combo_replan-light.json";
import pContextCaps from "../../../bench/problems/context_caps-light.json";
import pDeadlineHard from "../../../bench/problems/deadline_hard-light.json";
import pDeadlineSoft from "../../../bench/problems/deadline_soft-light.json";
import pDependencies from "../../../bench/problems/dependencies-light.json";
import pEarliestStart from "../../../bench/problems/earliest_start-light.json";
import pEdgeEmptyHardWindow from "../../../bench/problems/edge_empty_hard_window-light.json";
import pEdgeMustIncludeDemotion from "../../../bench/problems/edge_must_include_demotion-light.json";
import pEdgeSoftDependencyIgnored from "../../../bench/problems/edge_soft_dependency_ignored-light.json";
import pEdgeUnsatMustInclude from "../../../bench/problems/edge_unsat_must_include-light.json";
import pFitCurve from "../../../bench/problems/fit_curve-light.json";
import pGroupOrdered from "../../../bench/problems/group_ordered-light.json";
import pGroupSameDay from "../../../bench/problems/group_same_day-light.json";
import pMustInclude from "../../../bench/problems/must_include-light.json";
import pPinnedAt from "../../../bench/problems/pinned_at-light.json";
import pPreferredWindowHard from "../../../bench/problems/preferred_window_hard-light.json";
import pPreferredWindowSoft from "../../../bench/problems/preferred_window_soft-light.json";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const BENCH: Array<[string, unknown]> = [
  ["availability_windows-light", pAvailabilityWindows],
  ["baseline-light", pBaseline],
  ["business_hours-light", pBusinessHours],
  ["churn-light", pChurn],
  ["combo_chunked_workflow-light", pComboChunkedWorkflow],
  ["combo_deadline_window-light", pComboDeadlineWindow],
  ["combo_kitchen_sink-light", pComboKitchenSink],
  ["combo_meeting-light", pComboMeeting],
  ["combo_oversubscribed-light", pComboOversubscribed],
  ["combo_replan-light", pComboReplan],
  ["context_caps-light", pContextCaps],
  ["deadline_hard-light", pDeadlineHard],
  ["deadline_soft-light", pDeadlineSoft],
  ["dependencies-light", pDependencies],
  ["earliest_start-light", pEarliestStart],
  ["edge_empty_hard_window-light", pEdgeEmptyHardWindow],
  ["edge_must_include_demotion-light", pEdgeMustIncludeDemotion],
  ["edge_soft_dependency_ignored-light", pEdgeSoftDependencyIgnored],
  ["edge_unsat_must_include-light", pEdgeUnsatMustInclude],
  ["fit_curve-light", pFitCurve],
  ["group_ordered-light", pGroupOrdered],
  ["group_same_day-light", pGroupSameDay],
  ["must_include-light", pMustInclude],
  ["pinned_at-light", pPinnedAt],
  ["preferred_window_hard-light", pPreferredWindowHard],
  ["preferred_window_soft-light", pPreferredWindowSoft],
];

type ReferenceRecord = {
  status: string;
  kept?: string[];
  dropped?: string[];
  drop_reasons?: Record<string, string>;
  objective_total: number | null;
  objective_components: Record<string, number> | null;
  unsat_core?: Array<{ type: string; task_id: string | null }>;
};

const REFERENCE = reference as unknown as Record<string, ReferenceRecord>;

function benchProblem(fixture: unknown): Problem {
  return (fixture as { problem: Problem }).problem;
}

const GENEROUS: EngineBudgets = {
  pass1: { wallMs: 20_000, nodeCap: 5_000_000 },
  pass2: { wallMs: 20_000, nodeCap: 5_000_000 },
  mus: { wallMs: 20_000, nodeCap: 100_000 },
};

// ---------------------------------------------------------------------------
// independent hard-constraint checker (the TS half of the oracle)
// ---------------------------------------------------------------------------

/** Placement legality only: every kept chunk lands on one of its baked
 * allowed starts (earliest_start ∩ pin ∩ hard windows ∩ BH ∩ availability ∩
 * hard deadline — pinned byte-for-byte against dump-domains.py in the
 * substrate suite), nothing overlaps externals or other chunks, group
 * policy and hard dependencies hold, and the schedule/dropped partition is
 * exactly the task list. */
function assertLegalSolution(problem: Problem, solution: Solution): void {
  const baked = bakeProblem(problem);
  const origin = problem.window.start;
  const droppedIds = new Set(solution.dropped.map((d) => d.task_id));

  const startBySlotKey = new Map<string, number>();
  for (const sc of solution.schedule) {
    expect(droppedIds.has(sc.task_id), `${sc.task_id} both scheduled and dropped`).toBe(false);
    startBySlotKey.set(`${sc.task_id} ${sc.chunk_id}`, datetimeToSlot(sc.start, origin));
  }

  // Partition covers the task list exactly.
  for (const task of problem.tasks) {
    if (droppedIds.has(task.id)) continue;
    for (const chunk of task.chunks) {
      expect(
        startBySlotKey.has(`${task.id} ${chunk.chunk_id}`),
        `kept ${task.id} missing chunk ${chunk.chunk_id}`,
      ).toBe(true);
    }
  }
  expect(solution.schedule.length).toBe(
    problem.tasks
      .filter((t) => !droppedIds.has(t.id))
      .reduce((n, t) => n + t.chunks.length, 0),
  );

  // Domain membership + occupancy (externals pre-marked).
  const occupied = new Int8Array(baked.horizon);
  for (const ev of problem.external_pinned) {
    const s = datetimeToSlot(ev.start, origin);
    const e = s + ev.duration_minutes / 15;
    for (let i = Math.max(0, s); i < Math.min(baked.horizon, e); i++) occupied[i] = 1;
  }
  for (const chunk of baked.chunks) {
    const task = baked.tasks[chunk.taskIndex]!;
    if (droppedIds.has(task.id)) continue;
    const s = startBySlotKey.get(`${task.id} ${chunk.chunkId}`)!;
    expect(
      Array.from(chunk.allowedStarts).includes(s),
      `${task.id}/${chunk.chunkId} start ${s} outside its baked domain`,
    ).toBe(true);
    for (let i = s; i < s + chunk.durationSlots; i++) {
      expect(occupied[i], `overlap at slot ${i} (${task.id}/${chunk.chunkId})`).toBe(0);
      occupied[i] = 1;
    }
  }

  // Group policy + hard dependencies.
  for (const task of baked.tasks) {
    if (droppedIds.has(task.id)) continue;
    const starts = task.chunkIndices.map((ci) => {
      const c = baked.chunks[ci]!;
      return { s: startBySlotKey.get(`${task.id} ${c.chunkId}`)!, dur: c.durationSlots };
    });
    if (task.sameDay) {
      const days = new Set(starts.map(({ s }) => Math.floor(s / 96)));
      expect(days.size, `${task.id} same_day violated`).toBe(1);
    }
    if (task.ordered) {
      for (let i = 1; i < starts.length; i++) {
        expect(
          starts[i]!.s >= starts[i - 1]!.s + starts[i - 1]!.dur,
          `${task.id} ordered violated at chunk ${i}`,
        ).toBe(true);
      }
    }
    for (const dep of task.deps) {
      if (dep.taskIndex >= 0) {
        const other = baked.tasks[dep.taskIndex]!;
        if (droppedIds.has(other.id)) continue; // scheduled_only semantics
        const otherStarts = other.chunkIndices.map((ci) => {
          const c = baked.chunks[ci]!;
          return { s: startBySlotKey.get(`${other.id} ${c.chunkId}`)!, dur: c.durationSlots };
        });
        const firstStart = Math.min(...starts.map(({ s }) => s));
        const lastEnd = Math.max(...starts.map(({ s, dur }) => s + dur));
        const otherFirst = Math.min(...otherStarts.map(({ s }) => s));
        const otherLast = Math.max(...otherStarts.map(({ s, dur }) => s + dur));
        if (dep.type === "after_task") {
          expect(firstStart >= otherLast, `${task.id} after_task ${other.id}`).toBe(true);
        } else if (dep.type === "before_task") {
          expect(lastEnd <= otherFirst, `${task.id} before_task ${other.id}`).toBe(true);
        }
      }
      // Event deps are folded into the baked domains — covered by domain
      // membership above.
    }
  }
}

function taskPresentIds(core: Array<{ type: string; task_id?: string | null }>): string[] {
  return core
    .filter((it) => it.type === "task_present")
    .map((it) => it.task_id!)
    .sort();
}

// ---------------------------------------------------------------------------
// 1. Full bench light tier vs the committed reference run
// ---------------------------------------------------------------------------

describe("solveProblem — bench light tier parity", () => {
  it("covers every reference entry", () => {
    expect(BENCH.length).toBe(Object.keys(REFERENCE).length);
  });

  for (const [name, fixture] of BENCH) {
    it(name, () => {
      const ref = REFERENCE[name]!;
      const problem = benchProblem(fixture);
      const result = solveProblem(problem, GENEROUS);

      if (ref.status === "UNSAT") {
        expect(result.kind).toBe("unsat");
        if (result.kind !== "unsat") return;
        // Coverage parity, never set-equality (plan Decisions #2): the same
        // conflicting tasks must be named.
        expect(taskPresentIds(result.response.unsat_core)).toEqual(
          taskPresentIds(ref.unsat_core!),
        );
        return;
      }

      expect(result.kind).toBe("solution");
      if (result.kind !== "solution") return;
      const sol = result.solution;

      // The certificate case: the reference proved OPTIMAL, so must we.
      expect(sol.diagnostics.status).toBe("OPTIMAL");
      expect(sol.diagnostics.bound_gap).toBe(0);
      expect(sol.objective.total).toBe(ref.objective_total);
      expect(sol.objective.components).toEqual(ref.objective_components);

      // Drop parity: same tasks, same reasons.
      expect(sol.dropped.map((d) => d.task_id).sort()).toEqual(ref.dropped ?? []);
      for (const d of sol.dropped) {
        expect(d.reason).toBe(ref.drop_reasons?.[d.task_id]);
      }

      assertLegalSolution(problem, sol);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Externals overlap: immediate 422, no search
// ---------------------------------------------------------------------------

describe("solveProblem — overlapping externals", () => {
  it("returns the external_pinned core straight from the substrate", () => {
    // Bare Problem (a solver-repo test fixture), unlike the wrapped bench
    // corpus files.
    const problem = pInfeasibleExternalOverlap as unknown as Problem;
    const result = solveProblem(problem, GENEROUS);
    expect(result.kind).toBe("unsat");
    if (result.kind !== "unsat") return;
    expect(result.response.unsat_core.length).toBeGreaterThan(0);
    for (const item of result.response.unsat_core) {
      expect(item.type).toBe("external_pinned");
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Proof-state mapping under squeezed budgets
// ---------------------------------------------------------------------------

describe("solveProblem — proof states", () => {
  // combo_deadline_window-light needs real pass-2 search (473 nodes at full
  // budget), so a tiny node cap forces an uncertified incumbent.
  const problem = benchProblem(pComboDeadlineWindow);
  const ref = REFERENCE["combo_deadline_window-light"]!;

  it("FEASIBLE with bound_gap when pass 2 hits its budget mid-search", () => {
    const result = solveProblem(problem, {
      ...GENEROUS,
      pass2: { wallMs: 20_000, nodeCap: 5 },
    });
    expect(result.kind).toBe("solution");
    if (result.kind !== "solution") return;
    expect(result.solution.diagnostics.status).toBe("FEASIBLE");
    expect(result.solution.diagnostics.bound_gap).toBeGreaterThan(0);
    // An incumbent can never beat the true optimum.
    expect(result.solution.objective.total).toBeGreaterThanOrEqual(ref.objective_total!);
    assertLegalSolution(problem, result.solution);
  });

  it("PASS1_FALLBACK serves the pass-1 witness when pass 2 cannot descend", () => {
    // A clock already past any deadline once pass 2 starts reading it: even
    // the witness-seeded hint descent (card F) aborts under a dead clock, so
    // no descent completes and the fallback serves the witness. (On a LIVE
    // clock the hint descent completes in one cheap pass, which is why the
    // real card-C cliff now surfaces as FEASIBLE — see the controller suite.)
    let calls = 0;
    const result = solveProblem(problem, {
      ...GENEROUS,
      pass2: { wallMs: 1, nodeCap: 5_000_000, now: () => (calls++ < 3 ? 0 : 1e9) },
    });
    expect(result.kind).toBe("solution");
    if (result.kind !== "solution") return;
    expect(result.solution.diagnostics.status).toBe("PASS1_FALLBACK");
    // The fallback is still a legal placement with an honestly-recomputed
    // objective — only optimality is surrendered.
    expect(result.solution.objective.total).toBeGreaterThanOrEqual(ref.objective_total!);
    assertLegalSolution(problem, result.solution);
  });

  it("omits bound_gap when pass 1 is the uncertified half", () => {
    // A pass-1 budget too small to certify the selection (the seed still
    // decides, so no MUS detour): the served answer is FEASIBLE, and the
    // true gap is UNKNOWN — emitting pass 2's own 0 would read as
    // "certified after all" (card F smoke finding).
    const result = solveProblem(problem, {
      ...GENEROUS,
      pass1: { wallMs: 20_000, nodeCap: 1 },
    });
    expect(result.kind).toBe("solution");
    if (result.kind !== "solution") return;
    expect(result.solution.diagnostics.status).toBe("FEASIBLE");
    expect(result.solution.diagnostics.bound_gap).toBeUndefined();
  });

  it("undecided pass 1 + starved pass 2 serves the MUS-attached witness", () => {
    // find-c regression: an undecided seed (pass-1 budget spent at zero)
    // routes through resolveInfeasibility, whose unbounded oracle proves the
    // must set packs; its placement must come back attached so a pass 2 that
    // completes no descent still has a PASS1_FALLBACK to serve, instead of
    // the "undecided pass-1 partition reached PASS1_FALLBACK" throw.
    const avail = [
      { start: "2026-05-19T09:00:00", end: "2026-05-19T11:00:00" },
    ] as Problem["tasks"][number]["availability_windows"];
    const must = benchProblem(pMustInclude);
    const p: Problem = {
      ...must,
      tasks: must.tasks.slice(0, 2).map((t, i) => ({
        ...t,
        id: `m${i}`,
        must_include: true,
        availability_windows: avail,
        chunks: [{ chunk_id: `m${i}#0`, duration_minutes: 60 }],
      })),
    };
    let calls = 0;
    const result = solveProblem(p, {
      pass1: { wallMs: 20_000, nodeCap: 0 },
      mus: { wallMs: 20_000, nodeCap: 100_000 },
      pass2: { wallMs: 1, nodeCap: 5_000_000, now: () => (calls++ < 3 ? 0 : 1e9) },
    });
    expect(result.kind).toBe("solution");
    if (result.kind !== "solution") return;
    expect(result.solution.diagnostics.status).toBe("PASS1_FALLBACK");
    expect(result.solution.schedule.length).toBe(2);
    assertLegalSolution(p, result.solution);
  });

  it("statuses and placements are deterministic across identical runs", () => {
    // Wall-clock diagnostics are real time and legitimately vary; everything
    // else — placements, objective, statuses, nodes — must be identical.
    const strip = (r: ReturnType<typeof solveProblem>) => {
      if (r.kind !== "solution") return r;
      const { pass1_wall_seconds, pass2_wall_seconds, ...rest } = r.solution.diagnostics;
      return { ...r, solution: { ...r.solution, diagnostics: rest } };
    };
    const a = solveProblem(problem, GENEROUS);
    const b = solveProblem(problem, GENEROUS);
    expect(strip(a)).toEqual(strip(b));
  });
});

// ---------------------------------------------------------------------------
// 3b. Objective-recomputation invariant guard
// ---------------------------------------------------------------------------

describe("componentsFromPlacement — invariant guard", () => {
  it("throws on a placement slot outside the chunk's baked domain", () => {
    // Unreachable from either search today (both emit subsets of
    // allowedStarts); the guard turns a future invariant break into a loud
    // engine error instead of NaN objective totals served on the wire
    // (review finding).
    const problem = benchProblem(pBaseline);
    const baked = bakeProblem(problem);
    const placement = new Int32Array(baked.chunks.length).fill(-1);
    const task = baked.tasks[0]!;
    for (const ci of task.chunkIndices) {
      const dom = new Set(baked.chunks[ci]!.allowedStarts);
      let s = 0;
      while (dom.has(s)) s++;
      placement[ci] = s;
    }
    expect(() => componentsFromPlacement(baked, placement, new Set([task.index]))).toThrow(
      /outside its baked domain/,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Demotion surface (drop reasons + contributing constraints)
// ---------------------------------------------------------------------------

describe("solveProblem — dropped-task surface", () => {
  it("demoted tasks carry the demotion reason, ordinary drops the cheaper-alternative reason", () => {
    const problem = benchProblem(pEdgeMustIncludeDemotion);
    const result = solveProblem(problem, GENEROUS);
    expect(result.kind).toBe("solution");
    if (result.kind !== "solution") return;
    const dropped = result.solution.dropped;
    expect(dropped.map((d) => [d.task_id, d.reason])).toEqual([
      ["task-0", "must_include_unplaceable_in_isolation"],
    ]);
    expect(dropped[0]!.drop_cost).toBeGreaterThan(0);
  });

  it("contributing_constraints mirrors two_pass._drop_contributing", () => {
    // A dropped task with a soft deadline and a soft preferred window lists
    // both; hard variants list neither.
    const problem = benchProblem(pEdgeEmptyHardWindow);
    const result = solveProblem(problem, GENEROUS);
    expect(result.kind).toBe("solution");
    if (result.kind !== "solution") return;
    for (const d of result.solution.dropped) {
      const task = problem.tasks.find((t) => t.id === d.task_id)!;
      const expected: string[] = [];
      if (task.deadline != null && !task.deadline.hard) expected.push("soft_deadline");
      if (task.preferred_windows.some((w) => !w.hard)) expected.push("preferred_window");
      expect(d.contributing_constraints).toEqual(expected);
    }
  });
});
