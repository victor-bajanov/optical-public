// Card D — D3 incumbent improvement phase
// (internal design notes §D3,
// internal design notes card D).
//
// What this suite pins:
//
//   - the neighbourhood schedule is a pure function of the incumbent — two
//     runs are bit-equal, and no engine module contains an RNG at all;
//   - acceptance is STRICTLY improving: a sub-solve that comes back worse,
//     incomplete, or with a frozen chunk moved is discarded, and the
//     incumbent handed in is what comes back out;
//   - the budget is honoured across sub-solves — the phase's own node
//     accounting includes every node its sub-solves burned;
//   - the freed/frozen contract on the wire: each request frees exactly the
//     ranked neighbourhood and pins everything else at the current best.
//
// The improvement phase is the only part of the engine that is allowed to be
// heuristic, so the guard rails are the assertions: legality and the
// recomputed objective come from the shared solution oracle's arithmetic
// (transcribed from the Python authority), never read back out of the engine.

import { describe, expect, it } from "vitest";
import { bakeProblem, SLOTS_PER_DAY } from "../../src/engine/substrate";
import { improve } from "../../src/engine/improve";
import { place } from "../../src/engine/pass2";
import type {
  Baked,
  Budget,
  Placement,
  Problem,
  SubsolveFn,
  SubsolveRequest,
  SubsolveResult,
} from "../../src/engine/types";

import engineSource from "../../src/engine/engine.ts?raw";
import fanoutSource from "../../src/engine/fanout.ts?raw";
import hallSource from "../../src/engine/hall.ts?raw";
import improveSource from "../../src/engine/improve.ts?raw";
import lagrangianSource from "../../src/engine/lagrangian.ts?raw";
import musSource from "../../src/engine/mus.ts?raw";
import pass1Source from "../../src/engine/pass1.ts?raw";
import pass2Source from "../../src/engine/pass2.ts?raw";
import substrateSource from "../../src/engine/substrate.ts?raw";

// ---------------------------------------------------------------------------
// fixture — the same greedy trap pass2.test.ts uses, built locally
// ---------------------------------------------------------------------------

const WINDOW = {
  start: "2026-05-18T00:00:00", // a Monday
  end: "2026-05-25T00:00:00",
  tz: "Australia/Sydney",
};

const UNBOUNDED: Budget = { wallMs: Infinity, nodeCap: Infinity };
const PHASE_OFF: Budget = { wallMs: 0, nodeCap: 0 };

function slot(day: number, hour: number): number {
  return day * SLOTS_PER_DAY + hour * 4;
}

/** Six 60-minute chunks in a `deep` context capped at 300 min/day (20 slots)
 * at 100 per 15 min over. Five filler tasks want Monday (a soft window worth
 * 500 a day of gap) and may also sit on Tuesday; the trap task has exactly two
 * legal starts, both free. Greedy parks the trap on Monday and pays 400 in cap
 * overrun; the optimum is 0 with the trap on Tuesday. */
function trapProblem(): Problem {
  const task = (id: string, over: Record<string, unknown>) =>
    ({
      id,
      title: id,
      context: "deep",
      priority: 50,
      chunks: [{ chunk_id: `${id}#0`, duration_minutes: 60 }],
      group_policy: { same_day: false, ordered: false },
      earliest_start: WINDOW.start,
      preferred_windows: [],
      dependencies: [],
      previous_placement: [],
      must_include: false,
      ...over,
    }) as unknown as Problem["tasks"][number];

  return {
    window: WINDOW,
    weights: {
      time_of_day_fit_per_15min: 0,
      churn_per_15min_moved: 0,
      priority_unit: 1,
      base_drop_penalty: 200,
      preferred_day_miss: 500,
      preferred_time_miss_per_15min: 0,
    },
    contexts: [
      {
        context: "deep",
        fit_curve: { peak_start: "09:00", peak_end: "18:00", falloff_end: "18:00" },
        max_minutes_per_day: 300,
        max_contiguous_minutes: null,
        over_daily_cap_penalty_per_15min: 100,
        over_streak_cap_penalty_per_15min: 0,
      },
    ],
    tasks: [
      task("trap", {
        availability_windows: [
          { start: "2026-05-18T09:00:00", end: "2026-05-18T10:00:00" },
          { start: "2026-05-19T09:00:00", end: "2026-05-19T10:00:00" },
        ],
      }),
      ...[0, 1, 2, 3, 4].map((i) =>
        task(`f${i}`, {
          availability_windows: [
            { start: "2026-05-18T09:00:00", end: "2026-05-18T18:00:00" },
            { start: "2026-05-19T09:00:00", end: "2026-05-19T18:00:00" },
          ],
          preferred_windows: [{ days: ["mon"], start: "09:00", end: "18:00", hard: false }],
        }),
      ),
    ],
    external_pinned: [],
    business_hours: null,
  } as unknown as Problem;
}

function allTaskIndices(baked: Baked): number[] {
  return baked.tasks.map((t) => t.index);
}

/** The trapped incumbent: what the bare search settles for. */
function trappedIncumbent(baked: Baked): { placement: Placement; cost: number } {
  const res = place(baked, allTaskIndices(baked), null, { nodeCap: 20_000, wallMs: Infinity }, {
    improveBudget: PHASE_OFF,
  });
  return { placement: res.placement, cost: res.cost };
}

/** Independent objective recomputation over the kept set: baked separable
 * table + streak constant + lateness + daily caps (drop cost excluded, which
 * is the pass-2 basis `improve` works in). */
function recomputeCost(baked: Baked, kept: readonly number[], p: Placement): number {
  let total = 0;
  for (const ti of kept) {
    const t = baked.tasks[ti]!;
    const ctx = t.contextIndex >= 0 ? baked.contexts[t.contextIndex]! : null;
    for (const ci of t.chunkIndices) {
      const c = baked.chunks[ci]!;
      const i = c.allowedStarts.indexOf(p[ci]!);
      expect(i, `${t.id}/${c.chunkId} start ${p[ci]} outside its domain`).toBeGreaterThanOrEqual(0);
      total += c.cost[i]!;
      if (ctx !== null && ctx.streakCapSlots >= 0 && c.durationSlots > ctx.streakCapSlots) {
        total += (c.durationSlots - ctx.streakCapSlots) * ctx.streakCapPenaltyPer15;
      }
    }
    if (t.hasSoftDeadline) {
      const ends = t.chunkIndices.map((ci) => p[ci]! + baked.chunks[ci]!.durationSlots);
      total += Math.max(0, Math.max(...ends) - t.deadlineSlot) * t.deadlinePenaltyPer15;
    }
  }
  const days = Math.floor(baked.horizon / SLOTS_PER_DAY);
  for (let cx = 0; cx < baked.contexts.length; cx++) {
    const ctx = baked.contexts[cx]!;
    if (ctx.dailyCapSlots < 0 || ctx.dailyCapPenaltyPer15 === 0) continue;
    for (let d = 0; d < days; d++) {
      const lo = d * SLOTS_PER_DAY;
      const hi = lo + SLOTS_PER_DAY;
      let used = 0;
      for (const ti of kept) {
        const t = baked.tasks[ti]!;
        if (t.contextIndex !== cx) continue;
        for (const ci of t.chunkIndices) {
          const s = p[ci]!;
          used += Math.max(0, Math.min(s + baked.chunks[ci]!.durationSlots, hi) - Math.max(s, lo));
        }
      }
      total += Math.max(0, used - ctx.dailyCapSlots) * ctx.dailyCapPenaltyPer15;
    }
  }
  return total;
}

/** No-overlap and domain membership over the kept set — enough to catch an
 * "improvement" bought with an illegal placement. */
function assertLegal(baked: Baked, kept: readonly number[], p: Placement): void {
  const occupied = new Map<number, string>();
  for (let s = 0; s < baked.horizon; s++) {
    if ((baked.externalMask[s >> 5]! >>> (s & 31)) & 1) occupied.set(s, "external");
  }
  for (const ti of kept) {
    const t = baked.tasks[ti]!;
    for (const ci of t.chunkIndices) {
      const c = baked.chunks[ci]!;
      const s = p[ci]!;
      expect(Array.from(c.allowedStarts), `${t.id}/${c.chunkId} in domain`).toContain(s);
      for (let k = s; k < s + c.durationSlots; k++) {
        expect(occupied.has(k), `${t.id}/${c.chunkId} overlaps ${occupied.get(k)}`).toBe(false);
        occupied.set(k, `${t.id}/${c.chunkId}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 1. determinism: ranked, not sampled
// ---------------------------------------------------------------------------

describe("determinism", () => {
  it("no engine module contains an RNG", () => {
    const sources: Array<[string, string]> = [
      ["engine.ts", engineSource],
      ["fanout.ts", fanoutSource],
      ["hall.ts", hallSource],
      ["improve.ts", improveSource],
      ["lagrangian.ts", lagrangianSource],
      ["mus.ts", musSource],
      ["pass1.ts", pass1Source],
      ["pass2.ts", pass2Source],
      ["substrate.ts", substrateSource],
    ];
    for (const [name, source] of sources) {
      expect(source.length, `${name} source did not load`).toBeGreaterThan(100);
      // Comments are allowed to say the word; code is not allowed to call it.
      const code = source.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
      expect(code, `${name} calls an RNG`).not.toMatch(/Math\s*\.\s*random/);
      expect(code, `${name} calls an RNG`).not.toMatch(/crypto\s*\.\s*getRandomValues/);
    }
  });

  it("ranks the same neighbourhoods on two identical runs", () => {
    const baked = bakeProblem(trapProblem());
    const kept = allTaskIndices(baked);
    const { placement, cost } = trappedIncumbent(baked);
    const runs = [0, 1].map(() =>
      improve(baked, kept, Int32Array.from(placement), cost, {
        wallMs: Infinity,
        nodeCap: 200_000,
      }),
    );
    const [a, b] = runs as [ReturnType<typeof improve>, ReturnType<typeof improve>];
    expect(Array.from(a.placement)).toEqual(Array.from(b.placement));
    expect(a.cost).toBe(b.cost);
    expect(a.iterations).toBe(b.iterations);
    expect(a.accepted).toBe(b.accepted);
  });

  it("issues the same request sequence on two identical runs", () => {
    const baked = bakeProblem(trapProblem());
    const kept = allTaskIndices(baked);
    const { placement, cost } = trappedIncumbent(baked);
    const record = (): SubsolveRequest[] => {
      const seen: SubsolveRequest[] = [];
      const spy: SubsolveFn = (req) => {
        seen.push(req);
        return { placement: Int32Array.from(req.frozen), cost: Infinity, proved: false, nodes: 1, descents: 0 };
      };
      improve(baked, kept, Int32Array.from(placement), cost, { wallMs: Infinity, nodeCap: 500 }, spy);
      return seen;
    };
    const a = record();
    const b = record();
    expect(a.length).toBeGreaterThan(0);
    expect(a.map((r) => Array.from(r.frozen))).toEqual(b.map((r) => Array.from(r.frozen)));
  });
});

// ---------------------------------------------------------------------------
// 2. acceptance is strictly improving, and never destructive
// ---------------------------------------------------------------------------

describe("acceptance", () => {
  it("improves the trapped incumbent and stays legal", () => {
    const baked = bakeProblem(trapProblem());
    const kept = allTaskIndices(baked);
    const { placement, cost } = trappedIncumbent(baked);
    expect(cost).toBe(400);
    const out = improve(baked, kept, Int32Array.from(placement), cost, {
      wallMs: Infinity,
      nodeCap: 200_000,
    });
    expect(out.cost).toBeLessThan(cost);
    expect(out.accepted).toBeGreaterThan(0);
    expect(out.iterations).toBeGreaterThanOrEqual(out.accepted);
    assertLegal(baked, kept, out.placement);
    expect(out.cost).toBe(recomputeCost(baked, kept, out.placement));
    expect(out.fanoutSubsolves).toBe(0); // in-process default
  });

  it("returns the incumbent untouched when every sub-solve is worse", () => {
    const baked = bakeProblem(trapProblem());
    const kept = allTaskIndices(baked);
    const { placement, cost } = trappedIncumbent(baked);
    let calls = 0;
    const worse: SubsolveFn = (req) => {
      calls++;
      // A legal-looking but strictly dearer answer: echo the frozen set and
      // claim a higher cost.
      return { placement: Int32Array.from(req.frozen), cost: cost + 1, proved: true, nodes: 3, descents: 1 };
    };
    const out = improve(baked, kept, Int32Array.from(placement), cost, {
      wallMs: Infinity,
      nodeCap: 300,
    }, worse);
    expect(calls).toBeGreaterThan(0);
    expect(out.accepted).toBe(0);
    expect(out.cost).toBe(cost);
    expect(Array.from(out.placement)).toEqual(Array.from(placement));
    expect(out.fanoutSubsolves).toBe(calls);
  });

  it("rejects a sub-solve that moved a frozen chunk, however cheap it claims to be", () => {
    const baked = bakeProblem(trapProblem());
    const kept = allTaskIndices(baked);
    const { placement, cost } = trappedIncumbent(baked);
    const cheat: SubsolveFn = (req) => {
      const p = Int32Array.from(req.frozen);
      // Move every chunk to the trap's Tuesday slot: cheap on paper, and
      // both illegal and a breach of the frozen contract.
      for (let i = 0; i < p.length; i++) if (p[i]! >= 0) p[i] = slot(1, 9);
      return { placement: p, cost: 0, proved: true, nodes: 1, descents: 1 };
    };
    const out = improve(baked, kept, Int32Array.from(placement), cost, {
      wallMs: Infinity,
      nodeCap: 300,
    }, cheat);
    expect(out.accepted).toBe(0);
    expect(out.cost).toBe(cost);
    expect(Array.from(out.placement)).toEqual(Array.from(placement));
  });

  it("rejects a starved sub-solve that reported no completed descent", () => {
    // ADJUDICATED (card E review): a leaf whose budget ran out before it
    // finished a descent reports cost 0 with descents 0 — and pass 2's cost
    // EXCLUDES drop cost, so 0 is a perfectly ordinary objective value, not a
    // sentinel. Nothing else about this answer is wrong: the placement is
    // complete, legal, and leaves every frozen chunk where it was. Only
    // `descents` says there was never an incumbent behind it.
    const baked = bakeProblem(trapProblem());
    const kept = allTaskIndices(baked);
    const { placement, cost } = trappedIncumbent(baked);
    // The sharpest form of the case: this leaf returns exactly what a correct
    // one would — the real sub-solve, complete and frozen-consistent, and
    // re-costing it agrees it is cheaper. Every other gate passes. The single
    // difference is that it reports no completed descent, so if `descents` is
    // not consulted this is accepted.
    let calls = 0;
    let cheaperSeen = false;
    const starved: SubsolveFn = (req) => {
      calls++;
      const real = place(baked, req.kept, null, { nodeCap: req.nodeCap, wallMs: Infinity }, {
        frozenChunks: req.frozen,
      });
      if (real.descents > 0 && real.cost < cost) cheaperSeen = true;
      return {
        placement: real.placement,
        cost: real.cost,
        proved: real.proved,
        nodes: real.nodes,
        descents: 0,
      };
    };
    const out = improve(
      baked,
      kept,
      Int32Array.from(placement),
      cost,
      { wallMs: Infinity, nodeCap: 300 },
      starved,
    );
    expect(calls).toBeGreaterThan(0);
    expect(cheaperSeen, "the fixture must offer a genuine improvement to refuse").toBe(true);
    expect(out.accepted).toBe(0);
    expect(out.cost).toBe(cost);
    expect(Array.from(out.placement)).toEqual(Array.from(placement));
  });

  it("rejects a sub-solve that left a kept chunk unplaced", () => {
    const baked = bakeProblem(trapProblem());
    const kept = allTaskIndices(baked);
    const { placement, cost } = trappedIncumbent(baked);
    const truncated: SubsolveFn = (req) => ({
      placement: Int32Array.from(req.frozen), // freed entries still -1
      cost: 0,
      proved: false,
      nodes: 1,
      descents: 1,
    });
    const out = improve(baked, kept, Int32Array.from(placement), cost, {
      wallMs: Infinity,
      nodeCap: 300,
    }, truncated);
    expect(out.accepted).toBe(0);
    expect(out.cost).toBe(cost);
  });
});

// ---------------------------------------------------------------------------
// 3. budgets, including everything the sub-solves spend
// ---------------------------------------------------------------------------

describe("budgets", () => {
  it("does nothing at all on a zero budget", () => {
    const baked = bakeProblem(trapProblem());
    const kept = allTaskIndices(baked);
    const { placement, cost } = trappedIncumbent(baked);
    let calls = 0;
    const spy: SubsolveFn = (req) => {
      calls++;
      return { placement: Int32Array.from(req.frozen), cost: 0, proved: true, nodes: 0, descents: 1 };
    };
    const out = improve(baked, kept, Int32Array.from(placement), cost, PHASE_OFF, spy);
    expect(calls).toBe(0);
    expect(out.iterations).toBe(0);
    expect(out.accepted).toBe(0);
    expect(out.cost).toBe(cost);
    expect(Array.from(out.placement)).toEqual(Array.from(placement));
  });

  it("counts sub-solve nodes against its own node budget", () => {
    const baked = bakeProblem(trapProblem());
    const kept = allTaskIndices(baked);
    const { placement, cost } = trappedIncumbent(baked);
    let spent = 0;
    const costly: SubsolveFn = (req) => {
      // Spend exactly the cap the phase handed out, so the accounting has to
      // be honest to terminate at all.
      spent += req.nodeCap;
      return {
        placement: Int32Array.from(req.frozen),
        cost: cost + 1,
        proved: false,
        nodes: req.nodeCap,
        descents: 1,
      };
    };
    const out = improve(baked, kept, Int32Array.from(placement), cost, {
      wallMs: Infinity,
      nodeCap: 1_000,
    }, costly);
    expect(spent).toBeLessThanOrEqual(1_000);
    expect(out.iterations).toBeGreaterThan(0);
  });

  it("is bounded by nodes, never by the clock", () => {
    // ADJUDICATED (card E review): the phase's sub-budgets are node-capped and
    // its iteration schedule is derived from node accounting alone. A wall that
    // could stop the loop would make the number of iterations depend on how
    // fast the machine is — and card E's fan-out runs the very same sub-solves
    // in parallel isolates, so a clock-driven schedule would stop being
    // bit-identical to the sequential path. Here the clock is already an age
    // past a 1 ms budget and the loop runs anyway.
    const baked = bakeProblem(trapProblem());
    const kept = allTaskIndices(baked);
    const { placement, cost } = trappedIncumbent(baked);
    let calls = 0;
    const spy: SubsolveFn = (req) => {
      calls++;
      return {
        placement: Int32Array.from(req.frozen),
        cost: cost + 1,
        proved: false,
        nodes: 1,
        descents: 1,
      };
    };
    // An expired clock and no clock at all must produce the identical run.
    const expired = improve(
      baked,
      kept,
      Int32Array.from(placement),
      cost,
      { wallMs: 1, nodeCap: 40, now: () => 1e9 },
      spy,
    );
    const withExpiredClock = calls;
    calls = 0;
    const untimed = improve(
      baked,
      kept,
      Int32Array.from(placement),
      cost,
      { wallMs: Infinity, nodeCap: 40 },
      spy,
    );
    expect(withExpiredClock).toBeGreaterThan(0);
    expect(calls).toBe(withExpiredClock);
    expect(untimed.iterations).toBe(expired.iterations);
    expect(Array.from(untimed.placement)).toEqual(Array.from(expired.placement));

    // ...and the node cap is what actually binds when it is the tighter one.
    calls = 0;
    const starvedOfNodes = improve(
      baked,
      kept,
      Int32Array.from(placement),
      cost,
      { wallMs: Infinity, nodeCap: 3 },
      spy,
    );
    // Round-batched accounting (card F): the first round dispatches its whole
    // menu with the remaining budget floor-divided across it, so 3 nodes fund
    // one 2-request round (1 node each) and the next round's floor hits zero.
    expect(starvedOfNodes.iterations).toBe(2);
    expect(starvedOfNodes.iterations).toBeLessThan(expired.iterations);
  });

  it("hands every sub-solve a node cap and no wall at all", () => {
    // The same invariant on the wire: a sub-solve budgeted in wall time would
    // return a different answer on a slower machine, or under fan-out, where it
    // shares its isolate's clock with nobody.
    const baked = bakeProblem(trapProblem());
    const kept = allTaskIndices(baked);
    const { placement, cost } = trappedIncumbent(baked);
    const seen: SubsolveRequest[] = [];
    const spy: SubsolveFn = (req) => {
      seen.push(req);
      return {
        placement: Int32Array.from(req.frozen),
        cost: Infinity,
        proved: false,
        nodes: 1,
        descents: 0,
      };
    };
    improve(baked, kept, Int32Array.from(placement), cost, { wallMs: 5, nodeCap: 25 }, spy);
    expect(seen.length).toBeGreaterThan(0);
    for (const req of seen) {
      expect(req.wallMs).toBe(Infinity);
      expect(req.nodeCap).toBeGreaterThan(0);
      expect(req.nodeCap).toBeLessThanOrEqual(25);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. the freed / frozen contract on the wire
// ---------------------------------------------------------------------------

describe("sub-solve requests", () => {
  it("frees a non-empty neighbourhood and pins the rest at the current best", () => {
    const baked = bakeProblem(trapProblem());
    const kept = allTaskIndices(baked);
    const { placement, cost } = trappedIncumbent(baked);
    const keptChunks = kept.flatMap((ti) => baked.tasks[ti]!.chunkIndices);
    const seen: SubsolveRequest[] = [];
    const spy: SubsolveFn = (req) => {
      seen.push({ ...req, frozen: Int32Array.from(req.frozen) });
      return { placement: Int32Array.from(req.frozen), cost: Infinity, proved: false, nodes: 1, descents: 0 };
    };
    improve(baked, kept, Int32Array.from(placement), cost, { wallMs: Infinity, nodeCap: 400 }, spy);
    expect(seen.length).toBeGreaterThan(0);
    for (const req of seen) {
      expect(req.problem).toBe(baked.problem);
      expect(req.kept).toEqual(kept);
      expect(req.nodeCap).toBeGreaterThan(0);
      let freed = 0;
      for (const ci of keptChunks) {
        if (req.frozen[ci]! < 0) freed++;
        else expect(req.frozen[ci]).toBe(placement[ci]); // nothing was accepted
      }
      expect(freed).toBeGreaterThan(0);
      expect(freed).toBeLessThan(keptChunks.length); // a sub-solve, not a re-solve
    }
  });

  it("survives a structured-clone round trip of its requests", () => {
    const baked = bakeProblem(trapProblem());
    const kept = allTaskIndices(baked);
    const { placement, cost } = trappedIncumbent(baked);
    const cloned: SubsolveFn = (req) => {
      const copy = structuredClone(req) as SubsolveRequest;
      expect(Array.from(copy.frozen)).toEqual(Array.from(req.frozen));
      expect(copy.kept).toEqual(req.kept);
      const out: SubsolveResult = {
        placement: Int32Array.from(copy.frozen),
        cost: Infinity,
        proved: false,
        nodes: 1,
        descents: 0,
      };
      return structuredClone(out) as SubsolveResult;
    };
    const out = improve(baked, kept, Int32Array.from(placement), cost, {
      wallMs: Infinity,
      nodeCap: 200,
    }, cloned);
    expect(out.cost).toBe(cost);
  });
});
