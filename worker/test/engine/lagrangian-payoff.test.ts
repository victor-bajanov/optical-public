// Card B — D1 payoff: the two mediums the plan expects to leave the bench
// allowlist (internal design notes, card B, test 6).
//
// BOTH CASES ARE EXPECTED FAILURES. D1 does not deliver these two, and the
// assertions stand at the card's target rather than being relaxed to what
// shipped — `test.fails` is how that stays visible without turning the suite
// red for cards D/E/F, and it INVERTS the moment either problem starts
// certifying: a passing assertion here is reported as a failure, which is
// exactly the signal wanted at D and F. Do not "fix" such a failure by
// deleting the case; it means the payoff arrived.
//
// WHY THEY FAIL (measured, and the reason this is not a tuning gap):
//
//   problem                        dual ceiling   reference optimum
//   combo_chunked_workflow-medium          429                 550
//   combo_kitchen_sink-medium            11 159              11 750
//
// The ceiling is stable from 500 to 10 000 subgradient iterations and
// insensitive to the Polyak target swept across 427…2165, so it is an
// integrality gap in the time-indexed relaxation, not a convergence failure.
// Strengthening the inner minimisation to respect intra-task coupling
// (same_day / ordered / intra-task no-overlap, which the per-chunk
// decomposition discards) was measured too: 456 and 11 164. Real, still short.
//
// Certifying also needs the SEARCH to reach the optimum, which is the other
// half and the larger one. CARD D HAS SINCE MOVED THAT HALF: the improvement
// phase takes combo_kitchen_sink-medium to 11 750 — the reference optimum
// EXACTLY — and combo_chunked_workflow-medium from 2165 to 2070. Neither
// certifies, and for kitchen_sink the reason is now purely the dual: the
// incumbent is optimal and the bound cannot rise to meet it. Whether the exact
// search can branch that 11 150 → 11 750 gap closed in budget is the
// measurement card F inherits.
//
// Budgets are by NODES, not wall clock, for the same reason the canaries next
// door are: a wall-limited run's objective belongs to the machine that
// produced it. The budget is small because it can be — every figure asserted
// below is invariant from 10 000 nodes to 1 000 000 (and to the 20 s wall
// budget the bench runner uses), since the search plateaus long before the
// cap and the blocker is the dual ceiling, which no node budget moves. Small
// also means no case can outlive the workerd isolate and silently drop
// another's result, which is what happened at the full 20 s budget.

import { describe, expect, it } from "vitest";
import { solveProblem } from "../../src/engine/engine";
import type { EngineBudgets, Problem } from "../../src/engine/types";

import comboChunkedWorkflowMedium from "../../../bench/problems/combo_chunked_workflow-medium.json";
import comboKitchenSinkMedium from "../../../bench/problems/combo_kitchen_sink-medium.json";

function benchProblem(fixture: unknown): Problem {
  return (fixture as { problem: Problem }).problem;
}

const NODE_BUDGETS: EngineBudgets = {
  pass1: { wallMs: Infinity, nodeCap: 5_000_000 },
  pass2: { wallMs: Infinity, nodeCap: 50_000 },
  mus: { wallMs: Infinity, nodeCap: 100_000 },
};

describe("payoff — the two mediums that should leave the allowlist", () => {
  const cases: Array<[string, unknown, number]> = [
    ["combo_chunked_workflow-medium", comboChunkedWorkflowMedium, 550],
    ["combo_kitchen_sink-medium", comboKitchenSinkMedium, 11750],
  ];

  for (const [name, fixture, referenceObjective] of cases) {
    it.fails(`certifies ${name} at the reference objective`, () => {
      const result = solveProblem(benchProblem(fixture), NODE_BUDGETS);
      expect(result.kind).toBe("solution");
      if (result.kind !== "solution") return;
      expect(result.solution.diagnostics.status).toBe("OPTIMAL");
      expect(result.solution.objective.total).toBe(referenceObjective);
    }, 60_000);
  }
});

describe("payoff — what D1 and D3 reach on the same two problems", () => {
  // The state of play, asserted rather than left in a comment, so a change in
  // either direction shows up as an ordinary test result. Root bounds are the
  // measured D1 values against the pre-D1 baseline's (190 and 10 580); card
  // F's improve-first pipeline optimizes λ from the witness incumbent, which
  // nudges them (425 → 427, 11 150 → 11 155). The objectives are card F's
  // improve-then-prove-once pipeline: 2165 → 2070 (card D) → 957, and 11 900
  // → 11 750 — the reference optimum, so the D1 dual gap (11 155 vs 11 750)
  // is provably the only thing between kitchen_sink and its certificate.
  const cases: Array<[string, unknown, number, number, number]> = [
    ["combo_chunked_workflow-medium", comboChunkedWorkflowMedium, 957, 427, 190],
    ["combo_kitchen_sink-medium", comboKitchenSinkMedium, 11750, 11155, 10580],
  ];

  for (const [name, fixture, objective, rootBound, baselineRootBound] of cases) {
    it(`${name}: the bound lifts and the phase moves the incumbent`, () => {
      const result = solveProblem(benchProblem(fixture), NODE_BUDGETS);
      expect(result.kind).toBe("solution");
      if (result.kind !== "solution") return;
      const d = result.solution.diagnostics;
      expect(d.status).toBe("FEASIBLE");
      expect(result.solution.objective.total).toBe(objective);
      expect(d.root_bound).toBe(rootBound);
      expect(d.root_bound!).toBeGreaterThan(baselineRootBound);
      expect(d.bound_lift!).toBeGreaterThan(0);
    }, 60_000);
  }
});
