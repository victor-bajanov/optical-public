// Card D — D3 payoff (internal design notes, card D,
// test 5) plus the three no-allowance canary mediums.
//
// Budgets are by NODES, never wall clock: a wall-limited objective belongs to
// the machine that produced it, and card B already recorded that a workerd
// replay of a wall-limited baseline does not reproduce the bench numbers. Each
// case also runs in its own `it`, and the file is separate from
// improve.test.ts, because a long synchronous solve makes the workers pool drop
// its control connection and take every other case's report with it — cards B
// and C both hit that, and so did this one at a 50 000-node pass-2 budget.
//
// The pass-2 node cap is 30 000 for the same reason. Every figure below is
// unchanged from 30 000 through 50 000 nodes: `deadline_soft-heavy`'s phase
// converges after ~12 000 phase nodes and the rest of any larger budget goes to
// a proof search that cannot close (its root bound is 0), so a bigger cap buys
// only wall time.
//
// Reference optima and pre-D3 baselines, for what each assertion is worth:
//
//   problem                        pre-D3   now   reference   note
//   deadline_soft-heavy             17176     0           0   certifies at the root bound
//   churn-heavy                     48750 28550       28150   +73.2 % → +1.4 % (card F pipeline)
//   combo_deadline_window-medium     6670  6290        5915   canary (upper bound; F improves further)
//   combo_replan-medium            102724 99984       95374   canary (upper bound)
//   combo_meeting-medium             5850  5715        5575   canary (upper bound)
//
// The canary baselines are the committed wall-limited bench records — the
// numbers the plan's Thresholds section pins — because those are what card G's
// compare gate gets measured against. At this file's node budget the pre-D3
// engine scored 7010 / 107739 / 5885 on the same three, so the assertions below
// are the stricter of the two comparisons.

import { describe, expect, it } from "vitest";
import { solveProblem } from "../../src/engine/engine";
import { bakeProblem } from "../../src/engine/substrate";
import type { EngineBudgets, Problem } from "../../src/engine/types";
import { assertScheduleLegal, keptOf, placementOf, recomputeTotal } from "./solution-oracle";

import churnHeavy from "../../../bench/problems/churn-heavy.json";
import comboDeadlineWindowMedium from "../../../bench/problems/combo_deadline_window-medium.json";
import comboMeetingMedium from "../../../bench/problems/combo_meeting-medium.json";
import comboReplanMedium from "../../../bench/problems/combo_replan-medium.json";
import deadlineSoftHeavy from "../../../bench/problems/deadline_soft-heavy.json";

function benchProblem(fixture: unknown): Problem {
  return (fixture as { problem: Problem }).problem;
}

const NODE_BUDGETS: EngineBudgets = {
  pass1: { wallMs: Infinity, nodeCap: 5_000_000 },
  pass2: { wallMs: Infinity, nodeCap: 30_000 },
  mus: { wallMs: Infinity, nodeCap: 100_000 },
};

/** Solve, then re-derive the objective from the schedule the engine actually
 * emitted — a cheaper number is worth nothing if it was bought with an illegal
 * placement or a mis-added total, and the improvement phase is the one part of
 * the engine allowed to be heuristic. */
function solveAndAudit(fixture: unknown, label: string, budgets: EngineBudgets = NODE_BUDGETS) {
  const problem = benchProblem(fixture);
  const result = solveProblem(problem, budgets);
  expect(result.kind).toBe("solution");
  if (result.kind !== "solution") throw new Error("unsat");
  const baked = bakeProblem(problem);
  const kept = keptOf(baked, result.solution);
  const placement = placementOf(baked, result.solution);
  assertScheduleLegal(baked, kept, placement, label);
  expect(recomputeTotal(baked, kept, placement)).toBe(result.solution.objective.total);
  return result.solution;
}

describe("payoff — deadline_soft-heavy", () => {
  it("finds the zero-cost optimum and certifies at bound 0", () => {
    // The spec's cleanest D3 target: finding the zero-cost solution IS the
    // certificate, because the root bound is already 0 and a matching
    // incumbent closes the gap with no further search.
    const s = solveAndAudit(deadlineSoftHeavy, "deadline_soft-heavy");
    expect(s.diagnostics.root_bound).toBe(0);
    expect(s.objective.total).toBe(0);
    expect(s.diagnostics.status).toBe("OPTIMAL");
    expect(s.diagnostics.bound_gap).toBe(0);
    expect(s.diagnostics.improve_accepted).toBeGreaterThan(0);
  }, 120_000);
});

describe("payoff — churn-heavy", () => {
  it("lands inside the class C heavy ceiling of +25 % over reference 28150", () => {
    // 15 000 pass-2 nodes (result 28 550 / +1.4 %, measured invariant from
    // 15k through 30k), PLUS a real wall as the safety valve: the pipeline
    // improves first — the node-budgeted LNS reaches 28 550 deterministically
    // — and only the seeded proof search that follows is wall-stopped, which
    // keeps the synchronous block under what the workers pool tolerates
    // before dropping its control connection. The proof tail can only ever
    // LOWER the objective, so the ceiling assertion is machine-independent.
    const s = solveAndAudit(churnHeavy, "churn-heavy", {
      ...NODE_BUDGETS,
      pass2: { wallMs: 4_000, nodeCap: 15_000 },
    });
    expect(s.objective.total).toBeLessThanOrEqual(35_187);
    expect(s.diagnostics.improve_accepted).toBeGreaterThan(0);
  }, 120_000);
});

describe("canaries — the three no-allowance combo mediums", () => {
  const cases: Array<[string, unknown, number]> = [
    ["combo_deadline_window-medium", comboDeadlineWindowMedium, 6670],
    ["combo_replan-medium", comboReplanMedium, 102_724],
    ["combo_meeting-medium", comboMeetingMedium, 5850],
  ];
  for (const [name, fixture, baseline] of cases) {
    it(`${name} is no worse than its committed baseline`, () => {
      const s = solveAndAudit(fixture, name);
      expect(s.objective.total).toBeLessThanOrEqual(baseline);
    }, 120_000);
  }
});
