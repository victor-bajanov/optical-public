// Card A (engine search strengthening) — seam stubs, inert PlaceOptions, and
// the new instrumentation diagnostics (internal design notes).
//
// This suite pins the card-A contract:
//   1. the four new engine modules exist with their typed seam exports, and
//      every stub fails loudly (nothing may silently depend on an
//      unimplemented bound/cut/phase);
//   2. `place()` accepts PlaceOptions and treats them as inert no-ops —
//      bit-identical results with and without options, over real bench
//      problems (the golden re-run for the B/D merge points);
//   3. solveProblem's diagnostics carry the new instrumentation fields:
//      root_bound / root_incumbent / bound_lift measured on the pass-2 path,
//      improve_iterations / improve_accepted / fanout_subsolves hard zero
//      until cards D/E exist, and the pass-2 root fields absent on paths
//      pass 2 never instrumented (PASS1_FALLBACK with no incumbent).

import { describe, expect, it } from "vitest";
import { bakeProblem } from "../../src/engine/substrate";
import { place } from "../../src/engine/pass2";
import { solveProblem, splitPass2Budget } from "../../src/engine/engine";
import { evaluateBound, optimizeMultipliers } from "../../src/engine/lagrangian";
import { buildHallIndex, hallViolation } from "../../src/engine/hall";
import { improve } from "../../src/engine/improve";
import { makeRpcSubsolve } from "../../src/engine/fanout";
import type {
  Baked,
  Budget,
  EngineBudgets,
  PlaceOptions,
  Problem,
} from "../../src/engine/types";

import pBaseline from "../../../bench/problems/baseline-light.json";
import pChurn from "../../../bench/problems/churn-light.json";
import pComboKitchenSink from "../../../bench/problems/combo_kitchen_sink-light.json";
import pContextCaps from "../../../bench/problems/context_caps-light.json";
import pGroupOrdered from "../../../bench/problems/group_ordered-light.json";

function benchProblem(fixture: unknown): Problem {
  return (fixture as { problem: Problem }).problem;
}

const GENEROUS: EngineBudgets = {
  pass1: { wallMs: 20_000, nodeCap: 5_000_000 },
  pass2: { wallMs: 20_000, nodeCap: 5_000_000 },
  mus: { wallMs: 20_000, nodeCap: 100_000 },
};

const UNBOUNDED: Budget = { wallMs: Infinity, nodeCap: Infinity };

function allTaskIndices(baked: Baked): number[] {
  return baked.tasks.map((t) => t.index);
}

// ---------------------------------------------------------------------------
// 1. stub seams exist and fail loudly
// ---------------------------------------------------------------------------

describe("seam stubs (cards B/C/D/E fill them)", () => {
  const baked = bakeProblem(benchProblem(pBaseline));
  const residual = { occ: baked.externalMask, unplaced: [0] };

  // Card B has landed: the lagrangian seam is live, not a stub. Its own suite
  // (lagrangian.test.ts) owns admissibility; here we only pin the seam shape
  // the other cards build against.
  it("lagrangian seam returns a λ ≥ 0 state and an evaluate-only bound", () => {
    const state = optimizeMultipliers(baked, residual, 50);
    expect(state.lambda).toHaveLength(baked.horizon);
    for (const v of state.lambda) expect(v).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(state.bound)).toBe(true);
    expect(evaluateBound(baked, residual, new Int32Array(baked.horizon))).toBeLessThanOrEqual(
      state.bound,
    );
  });

  // Card C has landed: the hall seam is implemented, so what the suite pins
  // here is the seam signature the other cards build against — an index whose
  // `boundaries` are the sorted distinct envelope boundaries, and a violation
  // check that stays silent on a problem that comfortably fits.
  it("hall seam is implemented (card C)", () => {
    const index = buildHallIndex(baked);
    expect(index.boundaries.length).toBeGreaterThan(0);
    expect(index.boundaries[0]).toBe(0);
    expect(index.boundaries[index.boundaries.length - 1]).toBe(baked.horizon);
    expect(hallViolation(index, allTaskIndices(baked), null)).toBeNull();
  });

  // Card D has landed: the improve seam is live. Its own suite
  // (improve.test.ts) owns the phase's behaviour; here we only pin the seam
  // shape the other cards build against.
  it("improve seam returns the incumbent untouched when there is nothing to work from", () => {
    const incumbent = new Int32Array(baked.chunks.length).fill(-1);
    const out = improve(baked, allTaskIndices(baked), incumbent, 0, UNBOUNDED);
    expect(Array.from(out.placement)).toEqual(Array.from(incumbent));
    expect(out.cost).toBe(0);
    expect(out.iterations).toBe(0);
    expect(out.accepted).toBe(0);
    expect(out.fanoutSubsolves).toBe(0);
    expect(out.nodes).toBe(0);
  });

  // Card E has landed: makeRpcSubsolve is real. Its behaviour is pinned by
  // test/engine/fanout.test.ts; all this seam check owes is that the shape
  // the other cards build against is a batched AsyncSubsolveFn.
  it("fanout returns a batched sub-solve function", () => {
    const binding = { subsolve: () => Promise.reject(new Error("unused")) };
    const subsolve = makeRpcSubsolve(binding, 10);
    expect(typeof subsolve).toBe("function");
    expect(subsolve.length).toBe(1);
  });

  // Card F has landed: the controller is live. Its rule is pinned by
  // test/engine/controller.test.ts; the seam check owes the two boundary
  // behaviours the other paths rely on — a closed gap is all proof, an open
  // gap funds the phase.
  it("controller seam: closed gap all-proof, open gap splits", () => {
    expect(splitPass2Budget(0, 0, 20_000)).toEqual({ proof: 20_000, improve: 0 });
    expect(splitPass2Budget(100, 250, 8_000)).toEqual({ proof: 3_200, improve: 4_800 });
  });
});

// ---------------------------------------------------------------------------
// 2. PlaceOptions are inert no-ops
// ---------------------------------------------------------------------------

describe("place() with PlaceOptions — inert", () => {
  const cases: Array<[string, unknown]> = [
    ["baseline-light", pBaseline],
    ["churn-light", pChurn],
    ["combo_kitchen_sink-light", pComboKitchenSink],
    ["context_caps-light", pContextCaps],
    ["group_ordered-light", pGroupOrdered],
  ];

  for (const [name, fixture] of cases) {
    it(`no-op options leave ${name} bit-identical`, () => {
      const baked = bakeProblem(benchProblem(fixture));
      const kept = allTaskIndices(baked);
      // discrepancyLimit is NO LONGER inert (card D made it the LDS probe), so
      // it is not part of the no-op set any more; improve.test.ts and the
      // pass-2 suite own its semantics. The remaining three are still no-ops:
      // a null freeze pins nothing, a zero hook can never raise a bound that is
      // already non-negative, and a zero improve budget is the phase switched
      // off, which is what every pre-card-D caller effectively had.
      const options: PlaceOptions = {
        frozenChunks: null,
        remainderBoundHook: () => 0,
        improveBudget: { wallMs: 0, nodeCap: 0 },
      };
      const plain = place(baked, kept, null, { ...UNBOUNDED });
      const opted = place(baked, kept, null, { ...UNBOUNDED }, options);
      expect(Array.from(opted.placement)).toEqual(Array.from(plain.placement));
      expect(opted.cost).toBe(plain.cost);
      expect(opted.proved).toBe(plain.proved);
      expect(opted.boundGap).toBe(plain.boundGap);
      expect(opted.nodes).toBe(plain.nodes);
      expect(opted.descents).toBe(plain.descents);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. instrumentation diagnostics
// ---------------------------------------------------------------------------

describe("instrumentation diagnostics", () => {
  it("pass-2 path carries root_bound/root_incumbent and hard zeros", () => {
    const result = solveProblem(benchProblem(pBaseline), GENEROUS);
    expect(result.kind).toBe("solution");
    if (result.kind !== "solution") return;
    const d = result.solution.diagnostics;
    expect(typeof d.root_bound).toBe("number");
    expect(typeof d.root_incumbent).toBe("number");
    // The incumbent can never beat an admissible root bound.
    expect(d.root_incumbent!).toBeGreaterThanOrEqual(d.root_bound!);
    // No Lagrangian yet: the lift over the separable bound is exactly zero.
    expect(d.bound_lift).toBe(0);
    // No improvement phase / fan-out yet: hard zeros, present so the
    // instrumented baseline records concrete values.
    expect(d.improve_iterations).toBe(0);
    expect(d.improve_accepted).toBe(0);
    expect(d.fanout_subsolves).toBe(0);
  });

  it("root fields are absent when pass 2 produced no incumbent (PASS1_FALLBACK)", () => {
    // Same construction as the engine suite's fallback test: pass 2 is given
    // a clock that expires immediately after setup, so no descent completes —
    // even the witness-seeded hint descent (card F) aborts under a dead clock.
    let calls = 0;
    const result = solveProblem(benchProblem(pBaseline), {
      pass1: { wallMs: 20_000, nodeCap: 5_000_000 },
      mus: { wallMs: 20_000, nodeCap: 100_000 },
      pass2: { wallMs: 1, nodeCap: 5_000_000, now: () => (calls++ < 3 ? 0 : 1e9) },
    });
    expect(result.kind).toBe("solution");
    if (result.kind !== "solution") return;
    const d = result.solution.diagnostics;
    expect(d.status).toBe("PASS1_FALLBACK");
    expect(d.root_incumbent).toBeUndefined();
    // The phase counters still report truthfully: nothing ran.
    expect(d.improve_iterations).toBe(0);
    expect(d.improve_accepted).toBe(0);
    expect(d.fanout_subsolves).toBe(0);
  });

  it("diagnostics stay deterministic across identical runs", () => {
    const strip = (r: ReturnType<typeof solveProblem>) => {
      if (r.kind !== "solution") return r;
      const { pass1_wall_seconds, pass2_wall_seconds, ...rest } = r.solution.diagnostics;
      return rest;
    };
    const a = solveProblem(benchProblem(pComboKitchenSink), GENEROUS);
    const b = solveProblem(benchProblem(pComboKitchenSink), GENEROUS);
    expect(strip(a)).toEqual(strip(b));
  });
});
