// Card B — D1: time-indexed Lagrangian contention bound
// (internal design notes §D1).
//
// The module is a lower-bound oracle, so every test here is an admissibility
// test in some disguise: the bound the engine trusts must never exceed a cost
// the search could actually reach. The reference optima are brute-forced in
// the test from the baked separable table — never read back out of the engine
// — and the probes use a seeded pseudo-random generator so a failure is
// reproducible (no Math.random anywhere in this suite or the module).

import { describe, expect, it } from "vitest";
import { bakeProblem, SLOTS_PER_DAY } from "../../src/engine/substrate";
import { evaluateBound, optimizeMultipliers } from "../../src/engine/lagrangian";
import type { Baked, Problem, Residual } from "../../src/engine/types";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const WINDOW = {
  start: "2026-05-18T00:00:00", // a Monday
  end: "2026-05-25T00:00:00",
  tz: "Australia/Sydney",
};

type TaskOverrides = Partial<Problem["tasks"][number]>;

function makeTask(id: string, over: TaskOverrides = {}): Problem["tasks"][number] {
  return {
    id,
    title: id,
    context: "deep",
    priority: 50,
    chunks: [{ chunk_id: `${id}#0`, duration_minutes: 60 }],
    group_policy: { same_day: false, ordered: false },
    earliest_start: WINDOW.start as Problem["tasks"][number]["earliest_start"],
    preferred_windows: [],
    dependencies: [],
    previous_placement: [],
    must_include: false,
    ...over,
  } as Problem["tasks"][number];
}

type Weights = Problem["weights"];

function makeProblem(over: Partial<Problem> = {}, weights: Partial<Weights> = {}): Problem {
  return {
    window: WINDOW as Problem["window"],
    weights: {
      time_of_day_fit_per_15min: 1000,
      churn_per_15min_moved: 0,
      priority_unit: 1,
      base_drop_penalty: 200,
      preferred_day_miss: 0,
      preferred_time_miss_per_15min: 0,
      ...weights,
    } as Weights,
    contexts: [
      {
        context: "deep",
        fit_curve: { peak_start: "09:00", peak_end: "11:00", falloff_end: "13:00" },
        max_minutes_per_day: null,
        max_contiguous_minutes: null,
        over_daily_cap_penalty_per_15min: 25,
        over_streak_cap_penalty_per_15min: 25,
      },
    ] as never,
    tasks: [],
    external_pinned: [],
    business_hours: null,
    ...over,
  } as Problem;
}

/** n single-chunk tasks of `durMin`, available only 09:00–13:00 every day of
 * the window. Capacity is 7 × 16 slots; demand is n × durMin/15, so the
 * instance is pure no-overlap contention: every chunk on its own can reach the
 * zero-cost 09:00 peak, which is exactly why the separable Σ-min bound sits at
 * zero however crowded the week gets. */
function crowdedWeek(n: number, durMin: number): Problem {
  return makeProblem({
    business_hours: { days: ALL_DAYS, start: "09:00", end: "13:00" } as never,
    tasks: Array.from({ length: n }, (_, i) =>
      makeTask(`t${i}`, { chunks: [{ chunk_id: `t${i}#0`, duration_minutes: durMin }] }),
    ),
  });
}

const ALL_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

function allChunkIndices(baked: Baked): number[] {
  return baked.chunks.map((c) => c.index);
}

function rootResidual(baked: Baked): Residual {
  return { occ: Uint32Array.from(baked.externalMask), unplaced: allChunkIndices(baked) };
}

function slot(day: number, hour: number, minute = 0): number {
  return day * SLOTS_PER_DAY + hour * 4 + minute / 15;
}

// ---------------------------------------------------------------------------
// test-side oracles (independent of the engine's own arithmetic)
// ---------------------------------------------------------------------------

function isFree(occ: Uint32Array, start: number, dur: number): boolean {
  for (let s = start; s < start + dur; s++) {
    if (((occ[s >> 5]! >>> (s & 31)) & 1) === 1) return false;
  }
  return true;
}

/** Σ_c min over the chunk's occ-legal starts of its baked separable cost —
 * the term the engine calls `sumMinSep`, recomputed here from the baked
 * tables. Chunks with no legal start contribute nothing (the residual is
 * infeasible; any value is then a lower bound). */
function separableBound(baked: Baked, residual: Residual): number {
  let total = 0;
  for (const ci of residual.unplaced) {
    const chunk = baked.chunks[ci]!;
    let min = Infinity;
    for (let i = 0; i < chunk.allowedStarts.length; i++) {
      const s = chunk.allowedStarts[i]!;
      if (!isFree(residual.occ, s, chunk.durationSlots)) continue;
      if (chunk.cost[i]! < min) min = chunk.cost[i]!;
    }
    if (min !== Infinity) total += min;
  }
  return total;
}

/** Exhaustive minimum of Σ separable cost over every no-overlap assignment of
 * the residual's chunks. Exponential — fixtures stay tiny. Returns null when
 * the residual has no feasible completion. */
function bruteForceSeparableOptimum(baked: Baked, residual: Residual): number | null {
  const occ = Uint32Array.from(residual.occ);
  const chunks = residual.unplaced.map((ci) => baked.chunks[ci]!);
  let best: number | null = null;

  const mark = (start: number, dur: number, on: boolean): void => {
    for (let s = start; s < start + dur; s++) {
      if (on) occ[s >> 5]! |= 1 << (s & 31);
      else occ[s >> 5]! &= ~(1 << (s & 31));
    }
  };

  const recurse = (k: number, acc: number): void => {
    if (k === chunks.length) {
      if (best === null || acc < best) best = acc;
      return;
    }
    const chunk = chunks[k]!;
    for (let i = 0; i < chunk.allowedStarts.length; i++) {
      const s = chunk.allowedStarts[i]!;
      if (!isFree(occ, s, chunk.durationSlots)) continue;
      mark(s, chunk.durationSlots, true);
      recurse(k + 1, acc + chunk.cost[i]!);
      mark(s, chunk.durationSlots, false);
    }
  };
  recurse(0, 0);
  return best;
}

/** Deterministic 32-bit PRNG (mulberry32). Seeded per probe so a failing
 * randomized case is reproducible; `Math.random` is never used. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// 1. λ = 0 reproduces the separable bound exactly
// ---------------------------------------------------------------------------

describe("evaluateBound at λ = 0", () => {
  const cases: Array<[string, Problem]> = [
    ["crowded week, 6 × 120 min", crowdedWeek(6, 120)],
    ["crowded week, 12 × 120 min", crowdedWeek(12, 120)],
    [
      "with externals",
      makeProblem({
        business_hours: { days: ALL_DAYS, start: "09:00", end: "13:00" } as never,
        tasks: [makeTask("a"), makeTask("b", { chunks: [{ chunk_id: "b#0", duration_minutes: 120 }] })],
        external_pinned: [
          {
            id: "ext",
            title: "ext",
            start: "2026-05-18T09:00:00",
            duration_minutes: 120,
            context: "meeting",
          },
        ] as never,
      }),
    ],
  ];

  for (const [name, problem] of cases) {
    it(`equals Σ min live separable cost — ${name}`, () => {
      const baked = bakeProblem(problem);
      const residual = rootResidual(baked);
      const zero = new Int32Array(baked.horizon);
      expect(evaluateBound(baked, residual, zero)).toBe(separableBound(baked, residual));
    });
  }
});

// ---------------------------------------------------------------------------
// 2. admissibility — brute-forced optima vs random λ and the optimized λ*
// ---------------------------------------------------------------------------

describe("admissibility", () => {
  /** Small enough to enumerate: 3 chunks of 2 h over one 09:00–13:00 day. */
  function tinyDay(nTasks: number, durMin: number, days: string[] = ["mon"]): Problem {
    return makeProblem({
      business_hours: { days, start: "09:00", end: "13:00" } as never,
      tasks: Array.from({ length: nTasks }, (_, i) =>
        makeTask(`t${i}`, { chunks: [{ chunk_id: `t${i}#0`, duration_minutes: durMin }] }),
      ),
    });
  }

  const fixtures: Array<[string, Problem]> = [
    ["2 × 120 min, one day", tinyDay(2, 120)],
    ["3 × 60 min, one day", tinyDay(3, 60)],
    ["2 × 90 min, two days", tinyDay(2, 90, ["mon", "tue"])],
    ["4 × 60 min, two days", tinyDay(4, 60, ["mon", "tue"])],
  ];

  for (const [name, problem] of fixtures) {
    it(`randomized λ probes never exceed the optimum — ${name}`, () => {
      const baked = bakeProblem(problem);
      const residual = rootResidual(baked);
      const optimum = bruteForceSeparableOptimum(baked, residual);
      expect(optimum).not.toBeNull();
      const next = rng(0xc0ffee);
      for (let probe = 0; probe < 60; probe++) {
        const lambda = new Int32Array(baked.horizon);
        const magnitude = 1 + Math.floor(next() * 40000);
        for (let t = 0; t < baked.horizon; t++) {
          lambda[t] = Math.floor(next() * magnitude);
        }
        expect(evaluateBound(baked, residual, lambda)).toBeLessThanOrEqual(optimum!);
      }
    });

    it(`stays admissible at the multiplier ceiling — ${name}`, () => {
      // λ at LAMBDA_MAX is where the arithmetic is most likely to break: a
      // 672-slot prefix sum of 2^30 is ~7.2e11, and the per-chunk minimum
      // carries LAMBDA_SCALE × cost on top. All of it is integer-valued and
      // inside 2^53, so the bound must still be a bound — it will simply be a
      // very negative one, since Σ λ·cap now dwarfs everything.
      const baked = bakeProblem(problem);
      const residual = rootResidual(baked);
      const optimum = bruteForceSeparableOptimum(baked, residual)!;
      const ceiling = 1 << 30;
      const next = rng(0xce111a);
      for (const magnitude of [ceiling, ceiling >> 1, 1_000_000]) {
        for (let probe = 0; probe < 10; probe++) {
          const lambda = new Int32Array(baked.horizon);
          for (let t = 0; t < baked.horizon; t++) {
            lambda[t] = Math.floor(next() * magnitude);
          }
          const bound = evaluateBound(baked, residual, lambda);
          expect(Number.isFinite(bound)).toBe(true);
          expect(bound).toBeLessThanOrEqual(optimum);
        }
      }
      // a λ pinned flat at the ceiling is the exact clamp state
      const clamped = new Int32Array(baked.horizon).fill(ceiling);
      expect(evaluateBound(baked, residual, clamped)).toBeLessThanOrEqual(optimum);
    });

    it(`the optimized λ* never exceeds the optimum — ${name}`, () => {
      const baked = bakeProblem(problem);
      const residual = rootResidual(baked);
      const optimum = bruteForceSeparableOptimum(baked, residual)!;
      const state = optimizeMultipliers(baked, residual, 120);
      expect(state.bound).toBeLessThanOrEqual(optimum);
      expect(evaluateBound(baked, residual, state.lambda)).toBeLessThanOrEqual(optimum);
      for (let t = 0; t < state.lambda.length; t++) {
        expect(state.lambda[t]!).toBeGreaterThanOrEqual(0);
        expect(state.lambda[t]!).toBeLessThanOrEqual(1 << 30); // LAMBDA_MAX
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 4. residual validity after forced partial assignments
// ---------------------------------------------------------------------------

describe("residual validity", () => {
  it("evaluate-only stays below the residual optimum after forced placements", () => {
    const problem = makeProblem({
      business_hours: { days: ["mon", "tue"], start: "09:00", end: "13:00" } as never,
      tasks: Array.from({ length: 4 }, (_, i) =>
        makeTask(`t${i}`, { chunks: [{ chunk_id: `t${i}#0`, duration_minutes: 60 }] }),
      ),
    });
    const baked = bakeProblem(problem);
    const root = rootResidual(baked);
    // λ* is optimized ONCE at the root and then only evaluated — the property
    // under test is that this stays admissible for every restriction.
    const state = optimizeMultipliers(baked, root, 120);

    const next = rng(0x51ded);
    for (let trial = 0; trial < 40; trial++) {
      const occ = Uint32Array.from(baked.externalMask);
      const unplaced: number[] = [];
      let feasible = true;
      for (const ci of allChunkIndices(baked)) {
        const chunk = baked.chunks[ci]!;
        // force roughly half the chunks onto a legal start, at random
        if (next() < 0.5) {
          unplaced.push(ci);
          continue;
        }
        const legal: number[] = [];
        for (const s of chunk.allowedStarts) {
          if (isFree(occ, s, chunk.durationSlots)) legal.push(s);
        }
        if (legal.length === 0) {
          feasible = false;
          break;
        }
        const s = legal[Math.floor(next() * legal.length)]!;
        for (let x = s; x < s + chunk.durationSlots; x++) occ[x >> 5]! |= 1 << (x & 31);
      }
      if (!feasible || unplaced.length === 0) continue;
      const residual: Residual = { occ, unplaced };
      const optimum = bruteForceSeparableOptimum(baked, residual);
      if (optimum === null) continue; // no completion: any bound is vacuous
      expect(evaluateBound(baked, residual, state.lambda)).toBeLessThanOrEqual(optimum);
      expect(evaluateBound(baked, residual, new Int32Array(baked.horizon))).toBeLessThanOrEqual(
        optimum,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 5. determinism
// ---------------------------------------------------------------------------

describe("determinism", () => {
  it("two optimizeMultipliers runs are bit-equal", () => {
    const baked = bakeProblem(crowdedWeek(10, 120));
    const residual = rootResidual(baked);
    const a = optimizeMultipliers(baked, residual, 150);
    const b = optimizeMultipliers(baked, residual, 150);
    expect(a.bound).toBe(b.bound);
    expect(Array.from(a.lambda)).toEqual(Array.from(b.lambda));
  });

  it("the bound sequence over growing iteration counts is reproducible", () => {
    const baked = bakeProblem(crowdedWeek(8, 120));
    const residual = rootResidual(baked);
    const sequence = (): number[] =>
      [10, 25, 50, 100, 150].map((iters) => optimizeMultipliers(baked, residual, iters).bound);
    expect(sequence()).toEqual(sequence());
  });

  it("evaluateBound is a pure function of its inputs", () => {
    const baked = bakeProblem(crowdedWeek(6, 120));
    const residual = rootResidual(baked);
    const state = optimizeMultipliers(baked, residual, 100);
    const first = evaluateBound(baked, residual, state.lambda);
    expect(evaluateBound(baked, residual, state.lambda)).toBe(first);
    // and it must not mutate what it was handed
    expect(Array.from(residual.occ)).toEqual(Array.from(baked.externalMask));
  });
});

// ---------------------------------------------------------------------------
// 3a. the bound lifts off zero on the contention instance
// ---------------------------------------------------------------------------

describe("contention lift", () => {
  it("lifts off the separable zero on the 12 × 120 min / 240 min-per-day week", () => {
    const baked = bakeProblem(crowdedWeek(12, 120));
    const residual = rootResidual(baked);
    // Every chunk can reach the 09:00 peak on some day, so the separable bound
    // is exactly zero however crowded the week is — the D1 blind spot.
    expect(separableBound(baked, residual)).toBe(0);
    expect(evaluateBound(baked, residual, new Int32Array(baked.horizon))).toBe(0);

    const state = optimizeMultipliers(baked, residual, 150);
    expect(state.bound).toBeGreaterThan(0);
    // ... and it stays a bound. Two 2 h chunks fill a 09:00–13:00 day, so
    // pairing them off day by day is feasible by construction; its cost is an
    // upper bound the dual may never cross.
    let feasible = 0;
    for (let i = 0; i < baked.chunks.length; i++) {
      const chunk = baked.chunks[i]!;
      const start = slot((i / 2) | 0, i % 2 === 0 ? 9 : 11);
      const at = Array.from(chunk.allowedStarts).indexOf(start);
      expect(at, `chunk ${i} may start at ${start}`).toBeGreaterThanOrEqual(0);
      feasible += chunk.cost[at]!;
    }
    expect(state.bound).toBeLessThanOrEqual(feasible);
  });

  it("does not fire on an uncrowded week (nothing to lift)", () => {
    const baked = bakeProblem(crowdedWeek(2, 120));
    const residual = rootResidual(baked);
    const state = optimizeMultipliers(baked, residual, 150);
    // Two chunks, 112 free slots: no contention, so the dual optimum is the
    // separable zero and λ* must not manufacture a positive bound.
    expect(state.bound).toBe(0);
  });

  it("keeps a placement's own slots out of the residual", () => {
    const baked = bakeProblem(crowdedWeek(4, 120));
    const occ = Uint32Array.from(baked.externalMask);
    const first = baked.chunks[0]!;
    const s = slot(0, 9);
    expect(Array.from(first.allowedStarts)).toContain(s);
    for (let x = s; x < s + first.durationSlots; x++) occ[x >> 5]! |= 1 << (x & 31);
    const residual: Residual = { occ, unplaced: allChunkIndices(baked).slice(1) };
    const zero = new Int32Array(baked.horizon);
    // the freed chunk is gone from the sum and its slots are gone from capacity
    expect(evaluateBound(baked, residual, zero)).toBe(separableBound(baked, residual));
  });
});

// ---------------------------------------------------------------------------
// 7. canaries — no status regression, no objective worsening
//     (internal design notes, card B; the payoff pair is
//     next door in lagrangian-payoff.test.ts, which is RED — see its header)
//
// The canaries are budgeted by NODES, not wall clock. The committed baseline
// records for all five of these mediums are wall-limited runs, so their
// objectives are a property of the machine that produced them: replaying the
// unmodified engine on this machine reproduces four of the five and returns
// 6685 rather than 6670 for combo_deadline_window-medium. A node budget makes
// the comparison reproducible and isolates what D1 actually changes — search
// efficiency — from how fast the host happens to be. The "before" figures
// below were measured here with the D1 code stashed out (engine @ 43fac37).
// ---------------------------------------------------------------------------

import { solveProblem } from "../../src/engine/engine";
import {
  assertScheduleLegal,
  keptOf,
  placementOf,
  recomputeTotal,
} from "./solution-oracle";
import type { EngineBudgets } from "../../src/engine/types";

import comboDeadlineWindowMedium from "../../../bench/problems/combo_deadline_window-medium.json";
import comboMeetingMedium from "../../../bench/problems/combo_meeting-medium.json";
import comboReplanMedium from "../../../bench/problems/combo_replan-medium.json";

function benchProblem(fixture: unknown): Problem {
  return (fixture as { problem: Problem }).problem;
}

/** Wall-free budgets: the run is then a pure function of the problem. */
const NODE_BUDGETS: EngineBudgets = {
  pass1: { wallMs: Infinity, nodeCap: 5_000_000 },
  pass2: { wallMs: Infinity, nodeCap: 200_000 },
  mus: { wallMs: Infinity, nodeCap: 100_000 },
};

describe("canaries — no status regression, no objective worsening", () => {
  const cases: Array<[string, unknown, number]> = [
    ["combo_deadline_window-medium", comboDeadlineWindowMedium, 6685],
    ["combo_meeting-medium", comboMeetingMedium, 5885],
    ["combo_replan-medium", comboReplanMedium, 107739],
  ];

  for (const [name, fixture, baselineObjective] of cases) {
    it(`${name} is no worse than the pre-D1 engine`, () => {
      const result = solveProblem(benchProblem(fixture), NODE_BUDGETS);
      expect(result.kind).toBe("solution");
      if (result.kind !== "solution") return;
      const d = result.solution.diagnostics;
      // all three are FEASIBLE at this budget, before and after; a drop to
      // PASS1_FALLBACK would be the status regression to catch.
      expect(d.status).toBe("FEASIBLE");
      expect(result.solution.objective.total).toBeLessThanOrEqual(baselineObjective);
      // the bound is where the change is meant to show
      expect(d.bound_lift!).toBeGreaterThan(0);
      expect(d.root_bound!).toBeLessThanOrEqual(result.solution.objective.total);

      // ... and none of that counts unless the schedule is real. A cheaper
      // objective bought with an overlapping placement, or simply mis-added,
      // would sail past the comparison above.
      const baked = bakeProblem(benchProblem(fixture));
      const kept = keptOf(baked, result.solution);
      const placement = placementOf(baked, result.solution);
      assertScheduleLegal(baked, kept, placement, name);
      expect(recomputeTotal(baked, kept, placement)).toBe(result.solution.objective.total);
    }, 60_000);
  }
});
