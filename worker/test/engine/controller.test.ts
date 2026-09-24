// Card F — D4 budget controller + LNS orchestration (main session).
//
// The controller (`splitPass2Budget`) divides the pass-2 node budget that
// remains after the first placement search between the LNS improvement phase
// and a re-prove pass, in proportion to the relative root gap: a closed gap
// spends nothing on improvement (the certificate path), a wide-open gap
// leans on the phase, and everything unspent flows back to proof. The
// orchestration in `solveProblem` hoists card D's LNS out of pass 2 so the
// fan-out path can await the identical schedule asynchronously — the flag
// may change wall clock, never the answer, so the sync and async drivers
// must be bit-identical given the same sub-solver.

import { describe, expect, it } from "vitest";
import { bakeProblem } from "../../src/engine/substrate";
import {
  pass2PhaseFanout,
  pass2PhaseSync,
  solveProblem,
  splitPass2Budget,
} from "../../src/engine/engine";
import type { PhaseOutcome } from "../../src/engine/engine";
import { selectTasks } from "../../src/engine/pass1";
import { place } from "../../src/engine/pass2";
import { improve, improveAsync } from "../../src/engine/improve";
import { runSubsolve } from "../../src/engine/fanout";
import type {
  Baked,
  Budget,
  Problem,
  SubsolveRequest,
  SubsolveResult,
} from "../../src/engine/types";

import pBaseline from "../../../bench/problems/baseline-light.json";
import pChurn from "../../../bench/problems/churn-light.json";
import pFitCurve from "../../../bench/problems/fit_curve-light.json";
import pContextCapsMedium from "../../../bench/problems/context_caps-medium.json";
import pOversubscribedMedium from "../../../bench/problems/combo_oversubscribed-medium.json";

const baseline = (pBaseline as unknown as { problem: Problem }).problem;
const churn = (pChurn as unknown as { problem: Problem }).problem;
const fitCurve = (pFitCurve as unknown as { problem: Problem }).problem;
const contextCapsMedium = (pContextCapsMedium as unknown as { problem: Problem }).problem;
const oversubscribedMedium = (pOversubscribedMedium as unknown as { problem: Problem }).problem;

// ---------------------------------------------------------------------------
// 1. splitPass2Budget — the D4 rule
// ---------------------------------------------------------------------------

describe("splitPass2Budget", () => {
  it("closed root gap spends everything on proof", () => {
    expect(splitPass2Budget(0, 0, 20_000)).toEqual({ proof: 20_000, improve: 0 });
    expect(splitPass2Budget(550, 550, 8_000)).toEqual({ proof: 8_000, improve: 0 });
    // Incumbent BELOW the bound is still a closed gap, not a negative one.
    expect(splitPass2Budget(600, 550, 8_000)).toEqual({ proof: 8_000, improve: 0 });
  });

  it("open gap splits gap-proportionally, clamped, and conserves the budget", () => {
    // relGap = (250-100)/250 = 0.6 ⇒ improve 4800 / proof 3200.
    expect(splitPass2Budget(100, 250, 8_000)).toEqual({ proof: 3_200, improve: 4_800 });
    // Wide-open gap (bound 0) clamps at the 75 % ceiling.
    expect(splitPass2Budget(0, 1_000, 8_000)).toEqual({ proof: 2_000, improve: 6_000 });
    // Nearly-closed gap clamps at the 25 % floor.
    expect(splitPass2Budget(999, 1_000, 8_000)).toEqual({ proof: 6_000, improve: 2_000 });
  });

  it("no incumbent at all leans on the phase at the ceiling share", () => {
    expect(splitPass2Budget(0, Infinity, 8_000)).toEqual({ proof: 2_000, improve: 6_000 });
  });

  it("degenerate remainders pass through untouched", () => {
    expect(splitPass2Budget(0, 1_000, 0)).toEqual({ proof: 0, improve: 0 });
    expect(splitPass2Budget(0, 1_000, Infinity)).toEqual({
      proof: Infinity,
      improve: Infinity,
    });
  });

  it("is a pure integer function of its inputs", () => {
    for (const remaining of [1, 7, 100, 12_345]) {
      const a = splitPass2Budget(190, 2_165, remaining);
      const b = splitPass2Budget(190, 2_165, remaining);
      expect(a).toEqual(b);
      expect(Number.isInteger(a.proof)).toBe(true);
      expect(Number.isInteger(a.improve)).toBe(true);
      expect(a.proof + a.improve).toBe(remaining);
      expect(a.proof).toBeGreaterThanOrEqual(0);
      expect(a.improve).toBeGreaterThanOrEqual(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Witness seeding — pass 2 starts from the pass-1 witness
// ---------------------------------------------------------------------------

describe("witness seeding", () => {
  function solvedPlacement(problem: Problem): { baked: Baked; kept: number[]; placement: Int32Array; cost: number } {
    const baked = bakeProblem(problem);
    const kept = baked.tasks.map((t) => t.index);
    const full = place(baked, kept, null, { wallMs: Infinity, nodeCap: 500_000 });
    expect(full.descents).toBeGreaterThan(0);
    return { baked, kept, placement: full.placement, cost: full.cost };
  }

  it("a legal warm start yields an incumbent even at a starved node budget", () => {
    const { baked, kept, placement, cost } = solvedPlacement(baseline);
    // nodeCap 0: no search at all — the hint descent alone must recover the
    // witness, so a PASS1_FALLBACK-shaped budget still serves real placements.
    const seeded = place(baked, kept, placement, { wallMs: Infinity, nodeCap: 0 });
    expect(seeded.descents).toBeGreaterThan(0);
    expect(seeded.cost).toBeLessThanOrEqual(cost);
    for (const task of baked.tasks) {
      for (const ci of task.chunkIndices) {
        expect(seeded.placement[ci]).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Sync/async LNS drivers are bit-identical
// ---------------------------------------------------------------------------

describe("improveAsync bit-identity", () => {
  function incumbentFor(problem: Problem) {
    const baked = bakeProblem(problem);
    const kept = baked.tasks.map((t) => t.index);
    // A deliberately shallow first descent so the phase has room to improve.
    const first = place(baked, kept, null, { wallMs: Infinity, nodeCap: 200 }, {
      improveBudget: { wallMs: 0, nodeCap: 0 },
    });
    expect(first.descents).toBeGreaterThan(0);
    return { baked, kept, placement: first.placement, cost: first.cost };
  }

  it("the async driver over an in-process batch equals the sync driver", async () => {
    for (const problem of [churn, fitCurve]) {
      const { baked, kept, placement, cost } = incumbentFor(problem);
      const budget = { wallMs: Infinity, nodeCap: 20_000 };

      const sync = improve(baked, kept, Int32Array.from(placement), cost, budget);

      const batch = async (requests: readonly SubsolveRequest[]): Promise<SubsolveResult[]> =>
        requests.map((r) => runSubsolve(r));
      const asyncRun = await improveAsync(
        baked,
        kept,
        Int32Array.from(placement),
        cost,
        budget,
        batch,
      );

      expect(asyncRun.cost).toBe(sync.cost);
      expect(Array.from(asyncRun.placement)).toEqual(Array.from(sync.placement));
      expect(asyncRun.iterations).toBe(sync.iterations);
      expect(asyncRun.accepted).toBe(sync.accepted);
      // The async driver went through an external sub-solver, so its calls
      // are fan-out sub-solves; the in-process sync driver's are not.
      expect(asyncRun.fanoutSubsolves).toBe(asyncRun.iterations);
      expect(sync.fanoutSubsolves).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Orchestration — controller-path behaviour through solveProblem
// ---------------------------------------------------------------------------

describe("solveProblem controller paths", () => {
  it("a certificate spends nothing on improvement", () => {
    const result = solveProblem(baseline);
    expect(result.kind).toBe("solution");
    if (result.kind !== "solution") return;
    expect(result.solution.diagnostics.status).toBe("OPTIMAL");
    expect(result.solution.diagnostics.improve_iterations).toBe(0);
    expect(result.solution.diagnostics.improve_accepted).toBe(0);
    expect(result.solution.diagnostics.fanout_subsolves).toBe(0);
  });

  it("total reported nodes stay within the configured budgets plus the round slack", () => {
    const budgets = {
      pass1: { wallMs: Infinity, nodeCap: 100_000 },
      pass2: { wallMs: Infinity, nodeCap: 30_000 },
      mus: { wallMs: Infinity, nodeCap: 10_000 },
    };
    const result = solveProblem(churn, budgets);
    expect(result.kind).toBe("solution");
    if (result.kind !== "solution") return;
    const d = result.solution.diagnostics;
    // A round's sub-solve caps are carved out of the remaining budget
    // (floor-divided across the round), so the phase can never overshoot.
    expect(d.nodes).toBeLessThanOrEqual(100_000 + 30_000 + 10_000);
  });
});

// ---------------------------------------------------------------------------
// 5. One phase driver, two ways to run it
// ---------------------------------------------------------------------------

// `pass2PhaseSync` and `pass2PhaseFanout` used to be hand-kept twins — same
// root evaluation, same split, same proof step, differing only in who runs
// the LNS. They now drive ONE step sequence, and this is the seam that says
// so: given the same sub-solver the two must produce the same PhaseOutcome,
// down to the node counts, not merely the same served answer.

describe("phase driver equivalence", () => {
  const P2: Budget = { wallMs: Infinity, nodeCap: 20_000 };
  const P1: Budget = { wallMs: Infinity, nodeCap: 200_000 };

  /** Each arm gets its OWN bake and its own pass-1 selection: sharing either
   * would let one driver observe state the other left behind, which is
   * exactly what this test claims cannot happen. */
  async function bothWays(problem: Problem) {
    const syncBaked = bakeProblem(problem);
    const sync = pass2PhaseSync(syncBaked, selectTasks(syncBaked, P1), P2);
    const batch = async (requests: readonly SubsolveRequest[]): Promise<SubsolveResult[]> =>
      requests.map((r) => runSubsolve(r));
    const fanoutBaked = bakeProblem(problem);
    const fanout = await pass2PhaseFanout(fanoutBaked, selectTasks(fanoutBaked, P1), P2, batch);
    return { sync, fanout };
  }

  /** Everything but `fanoutSubsolves`, which is the ONE field that must
   * differ: an in-process LNS makes no fan-out sub-solves and a batched one
   * makes exactly its iterations. */
  function comparable(out: PhaseOutcome) {
    const { fanoutSubsolves: _fanout, ...rest } = out;
    return rest;
  }

  // One that ends unproved (the phase improves, the proof search still runs
  // out of nodes) and one the phase closes outright — the two shapes of the
  // step sequence past the LNS job.
  it("the two drivers agree field for field on a fixture with an active phase", async () => {
    for (const problem of [oversubscribedMedium, contextCapsMedium]) {
      const { sync, fanout } = await bothWays(problem);
      // Not vacuous: the improve step has to have actually run.
      expect(sync.improveIterations).toBeGreaterThan(0);
      expect(comparable(fanout)).toEqual(comparable(sync));
      expect(sync.fanoutSubsolves).toBe(0);
      expect(fanout.fanoutSubsolves).toBe(fanout.improveIterations);
    }
  });

  it("agrees on the certificate path, where the phase never engages", async () => {
    const { sync, fanout } = await bothWays(baseline);
    expect(sync.proved).toBe(true);
    expect(sync.improveIterations).toBe(0);
    expect(comparable(fanout)).toEqual(comparable(sync));
    expect(fanout.fanoutSubsolves).toBe(0);
  });
});
