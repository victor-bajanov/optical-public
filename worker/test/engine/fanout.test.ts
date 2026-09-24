// Card E — fan-out escape hatch (internal design notes §E).
//
// The load-bearing property is that the flag may change wall clock and NEVER
// the answer: a fan-out session must return exactly what the in-process
// sequential sub-solve would have returned, whatever order the RPC results
// arrive in, and whatever fails along the way.
//
// These tests exercise fanout.ts in isolation (no worker wiring — that is
// card F). The RPC binding is injected as a plain object, so "what workerd
// does to a typed array" is covered separately by the structured-clone
// round-trip below and by the entrypoint test in
// test/planning/engine-fanout.test.ts.

import { describe, expect, it, vi } from "vitest";
import { bakeProblem } from "../../src/engine/substrate";
import {
  MAX_SUBSOLVES_PER_RESOLVE,
  asInt32Array,
  fanoutEligible,
  fanoutFlagOn,
  fanoutMinChunks,
  makeFanoutSession,
  makeRpcSubsolve,
  runSubsolve,
} from "../../src/engine/fanout";
import type { EngineRpcBinding } from "../../src/engine/fanout";
import type { Problem, SubsolveRequest, SubsolveResult } from "../../src/engine/types";

import pBaseline from "../../../bench/problems/baseline-light.json";
import pEmptyHardWindow from "../../../bench/problems/edge_empty_hard_window-light.json";

function benchProblem(fixture: unknown): Problem {
  return (fixture as { problem: Problem }).problem;
}

const PROBLEM = benchProblem(pBaseline);
const BAKED = bakeProblem(PROBLEM);

/** A spread of genuinely different sub-problems over one problem: each frees a
 *  different task from the frozen incumbent, so results differ per request and
 *  "combined in request order" is observable rather than vacuous. */
function requestSet(count: number): SubsolveRequest[] {
  const all = BAKED.tasks.map((t) => t.index);
  const out: SubsolveRequest[] = [];
  for (let i = 0; i < count; i++) {
    const dropped = all[i % all.length]!;
    const kept = all.filter((t) => t !== dropped);
    const frozen = new Int32Array(BAKED.chunks.length).fill(-1);
    out.push({ problem: PROBLEM, kept, frozen, wallMs: 5_000, nodeCap: 200_000 });
  }
  return out;
}

/** Structural comparison — Int32Array vs Int32Array through toEqual is fine,
 *  but arrays read better in a failure diff. */
function plain(results: readonly SubsolveResult[]) {
  return results.map((r) => ({
    placement: Array.from(r.placement),
    cost: r.cost,
    proved: r.proved,
    nodes: r.nodes,
    descents: r.descents,
  }));
}

const sequential = (requests: readonly SubsolveRequest[]) => requests.map(runSubsolve);

/** Extract and parse every `<event> {json}` line for one event off a spy. */
function loggedEvents(
  spy: ReturnType<typeof vi.spyOn>,
  event: string,
): Array<Record<string, unknown>> {
  const prefix = `${event} `;
  return spy.mock.calls
    .map((c) => String(c[0]))
    .filter((m) => m.startsWith(prefix))
    .map((m) => JSON.parse(m.slice(prefix.length)) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// 1. Bit-identical determinism under out-of-order arrival
// ---------------------------------------------------------------------------

describe("fan-out determinism", () => {
  it("combines in request order however the RPC results arrive", async () => {
    const requests = requestSet(5);
    const arrivals: number[] = [];
    let issued = 0;
    const pending: Array<() => void> = [];
    const binding: EngineRpcBinding = {
      subsolve: (request) => {
        const i = issued++;
        const result = runSubsolve(request);
        // Later requests answer FIRST: arrival order is the exact reverse of
        // request order, the worst case for an arrival-ordered combine. The
        // batch cap (16) exceeds the request count, so all five issue before
        // any resolves — once the last is in, answer them back to front.
        return new Promise<SubsolveResult>((resolve) => {
          pending.push(() => {
            arrivals.push(i);
            resolve(result);
          });
          if (pending.length === requests.length) {
            for (const respond of [...pending].reverse()) respond();
          }
        });
      },
    };

    const combined = await makeRpcSubsolve(binding, 16)(requests);

    expect(arrivals).toEqual([4, 3, 2, 1, 0]);
    expect(plain(combined)).toEqual(plain(sequential(requests)));
  });

  it("is bit-identical across batch boundaries too", async () => {
    const requests = requestSet(7);
    const binding: EngineRpcBinding = {
      subsolve: async (request) => runSubsolve(request),
    };
    const combined = await makeRpcSubsolve(binding, 2)(requests);
    expect(plain(combined)).toEqual(plain(sequential(requests)));
  });

  it("a degraded session still returns the sequential answer", async () => {
    const requests = requestSet(4);
    const binding: EngineRpcBinding = {
      subsolve: () => Promise.reject(new Error("rpc exploded")),
    };
    const session = makeFanoutSession({ binding, sequential: runSubsolve });
    const combined = await session.subsolve(requests);
    expect(plain(combined)).toEqual(plain(sequential(requests)));
  });
});

// ---------------------------------------------------------------------------
// 2. Batching
// ---------------------------------------------------------------------------

describe("fan-out batching", () => {
  it("never has more than batchCap sub-solves in flight and chunks the list", async () => {
    const requests = requestSet(5);
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const binding: EngineRpcBinding = {
      subsolve: (request) => {
        calls++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const result = runSubsolve(request);
        return new Promise<SubsolveResult>((resolve) =>
          setTimeout(() => {
            inFlight--;
            resolve(result);
          }, 2),
        );
      },
    };

    const session = makeFanoutSession({ binding, sequential: runSubsolve, batchCap: 2 });
    await session.subsolve(requests);

    expect(calls).toBe(5);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(session.stats().batches).toBe(3);
    expect(session.stats().subsolves).toBe(5);
  });

  it("the per-resolve sub-solve cap stays under the same-worker invocation limit", () => {
    // The binding targets THIS worker, so the governing limit is the platform's
    // 32 invocations of the same Worker per request — not the 1000-subrequest
    // ceiling. Miniflare does not enforce it, so no test here can catch a cap
    // set above it; the constant is the only guard until card H's dev smoke
    // measures the true ceiling against a real deployment.
    expect(MAX_SUBSOLVES_PER_RESOLVE).toBeGreaterThan(0);
    expect(MAX_SUBSOLVES_PER_RESOLVE).toBeLessThan(32);
  });

  it("an oversize request list falls back to sequential rather than blowing the cap", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let calls = 0;
      const binding: EngineRpcBinding = {
        subsolve: async (request) => {
          calls++;
          return runSubsolve(request);
        },
      };
      const session = makeFanoutSession({
        binding,
        sequential: runSubsolve,
        batchCap: 8,
        maxSubsolves: 4,
      });

      const first = requestSet(3);
      expect(plain(await session.subsolve(first))).toEqual(plain(sequential(first)));
      expect(calls).toBe(3);

      // 3 + 3 would exceed the cap of 4 — this call must not be fanned out.
      const second = requestSet(3);
      expect(plain(await session.subsolve(second))).toEqual(plain(sequential(second)));
      expect(calls).toBe(3);

      const degraded = loggedEvents(warn, "engine_fanout_degraded");
      expect(degraded).toHaveLength(1);
      expect(degraded[0]!.reason).toBe("subsolve_cap");
    } finally {
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Degrade path + gating
// ---------------------------------------------------------------------------

describe("fan-out degrade path", () => {
  it("an RPC rejection degrades to sequential for the remainder, logged once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let calls = 0;
      const binding: EngineRpcBinding = {
        subsolve: () => {
          calls++;
          return Promise.reject(new Error("rpc exploded"));
        },
      };
      const session = makeFanoutSession({ binding, sequential: runSubsolve, batchCap: 4 });

      const first = requestSet(3);
      expect(plain(await session.subsolve(first))).toEqual(plain(sequential(first)));
      const afterFirst = calls;
      expect(afterFirst).toBeGreaterThan(0);

      const second = requestSet(3);
      expect(plain(await session.subsolve(second))).toEqual(plain(sequential(second)));
      // Latched: no further RPC attempts for the rest of the solve.
      expect(calls).toBe(afterFirst);

      const degraded = loggedEvents(warn, "engine_fanout_degraded");
      expect(degraded).toHaveLength(1);
      expect(degraded[0]!.reason).toBe("rpc_error");
      expect(String(degraded[0]!.error)).toContain("rpc exploded");
      expect(session.stats().degraded).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("the degraded line carries the work the session actually did", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Succeeds for the first batch, rejects for the rest: a session that has
      // already spent real round trips must not report subsolves 0, which is
      // indistinguishable from never having engaged at all.
      let calls = 0;
      const binding: EngineRpcBinding = {
        subsolve: async (request) => {
          calls++;
          if (calls > 2) throw new Error("rpc exploded");
          return runSubsolve(request);
        },
      };
      const session = makeFanoutSession({ binding, sequential: runSubsolve, batchCap: 2 });

      const requests = requestSet(4);
      expect(plain(await session.subsolve(requests))).toEqual(plain(sequential(requests)));

      const degraded = loggedEvents(warn, "engine_fanout_degraded");
      expect(degraded).toHaveLength(1);
      expect(degraded[0]!.subsolves).toBe(2);
      // Two batches were dispatched: the first returned both sub-solves, the
      // second returned none and carried the rejection. A batch that was sent
      // still cost a round trip, so it counts.
      expect(degraded[0]!.batches).toBe(2);
      expect(session.stats().subsolves).toBe(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("wall_ms measures the fan-out, not the sequential recompute after a degrade", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let clock = 0;
      const binding: EngineRpcBinding = {
        subsolve: () => {
          clock += 10;
          return Promise.reject(new Error("rpc exploded"));
        },
      };
      const session = makeFanoutSession({
        binding,
        // The degrade path's own cost must not be charged to fan-out: it is
        // work the sequential path would have done anyway.
        sequential: (request) => {
          clock += 1_000;
          return runSubsolve(request);
        },
        batchCap: 4,
        now: () => clock,
      });

      await session.subsolve(requestSet(3));
      session.finish();

      const lines = loggedEvents(info, "engine_fanout");
      expect(lines).toHaveLength(1);
      expect(lines[0]!.wall_ms).toBe(30);
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });

  it("emits one engine_fanout summary line on finish, and none when unused", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const binding: EngineRpcBinding = { subsolve: async (r) => runSubsolve(r) };
      const used = makeFanoutSession({ binding, sequential: runSubsolve, batchCap: 2 });
      await used.subsolve(requestSet(3));
      used.finish();
      // Idempotent: card F may call finish() on more than one exit path, and a
      // duplicated summary would double-count the soak's subsolve totals.
      used.finish();

      const lines = loggedEvents(info, "engine_fanout");
      expect(lines).toHaveLength(1);
      expect(lines[0]!.subsolves).toBe(3);
      expect(lines[0]!.batches).toBe(2);
      expect(typeof lines[0]!.wall_ms).toBe("number");

      info.mockClear();
      const unused = makeFanoutSession({ binding, sequential: runSubsolve });
      unused.finish();
      expect(loggedEvents(info, "engine_fanout")).toHaveLength(0);
    } finally {
      info.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Leaf contract: a non-answer must be distinguishable from a cost-0 optimum
// ---------------------------------------------------------------------------

describe("runSubsolve result contract", () => {
  it("reports descents so a no-incumbent sub-solve is not read as cost 0", () => {
    expect(runSubsolve(requestSet(1)[0]!).descents).toBeGreaterThanOrEqual(1);

    // edge_empty_hard_window's task 0 has an unsatisfiable hard window, so a
    // kept set containing it is a partition pass 2 cannot realise — exactly
    // what a frozen neighbourhood can hand a leaf once card D lands. Pass 2
    // then returns cost 0 / proved false (the drop component lives outside
    // Pass2Result.cost), the most attractive value a strict-improvement
    // acceptor can see. descents is the only field that discriminates.
    const unplaceable = benchProblem(pEmptyHardWindow);
    const baked = bakeProblem(unplaceable);
    const noIncumbent = runSubsolve({
      problem: unplaceable,
      kept: baked.tasks.map((t) => t.index),
      frozen: new Int32Array(baked.chunks.length).fill(-1),
      wallMs: 5_000,
      nodeCap: 200_000,
    });
    expect(noIncumbent.descents).toBe(0);
    expect(noIncumbent.cost).toBe(0);
    expect(noIncumbent.proved).toBe(false);
  });

  it("rejects a malformed request loudly rather than solving nonsense", () => {
    const base = requestSet(1)[0]!;
    expect(() => runSubsolve({ ...base, wallMs: Number.NaN })).toThrowError(/wallMs/);
    expect(() => runSubsolve({ ...base, wallMs: -1 })).toThrowError(/wallMs/);
    expect(() => runSubsolve({ ...base, nodeCap: 0 })).toThrowError(/nodeCap/);
    expect(() =>
      runSubsolve({ ...base, nodeCap: "lots" as unknown as number }),
    ).toThrowError(/nodeCap/);
    expect(() => runSubsolve({ ...base, kept: [0, -1] })).toThrowError(/kept/);
    expect(() => runSubsolve({ ...base, kept: [0, 1.5] })).toThrowError(/kept/);
    expect(() =>
      runSubsolve({ ...base, kept: "all" as unknown as number[] }),
    ).toThrowError(/kept/);

    // An unbounded wall is legitimate — the improvement phase's sub-budgets are
    // node-capped, with wallMs as a non-binding safety valve.
    expect(() => runSubsolve({ ...base, wallMs: Infinity })).not.toThrow();
  });
});

describe("fan-out gating", () => {
  const on = { flag: "true", binding: {} as EngineRpcBinding, improvementPhaseActive: true, chunkCount: 40, minChunks: 24 };

  it("engages only with the flag on, a bound binding, the phase active and enough chunks", () => {
    expect(fanoutEligible(on)).toBe(true);
    expect(fanoutEligible({ ...on, flag: "false" })).toBe(false);
    expect(fanoutEligible({ ...on, flag: undefined })).toBe(false);
    expect(fanoutEligible({ ...on, binding: undefined })).toBe(false);
    expect(fanoutEligible({ ...on, improvementPhaseActive: false })).toBe(false);
    expect(fanoutEligible({ ...on, chunkCount: 23 })).toBe(false);
    expect(fanoutEligible({ ...on, chunkCount: 24 })).toBe(true);
  });

  it("reads the flag with the house posture (exactly \"true\", trimmed)", () => {
    expect(fanoutFlagOn("true")).toBe(true);
    expect(fanoutFlagOn(" true ")).toBe(true);
    expect(fanoutFlagOn("false")).toBe(false);
    expect(fanoutFlagOn("TRUE")).toBe(false);
    expect(fanoutFlagOn("")).toBe(false);
    expect(fanoutFlagOn(undefined)).toBe(false);
  });

  it("parses the chunk threshold with the house parse-with-floor posture", () => {
    expect(fanoutMinChunks(undefined)).toBe(24);
    expect(fanoutMinChunks("")).toBe(24);
    expect(fanoutMinChunks("not-a-number")).toBe(24);
    expect(fanoutMinChunks("48")).toBe(48);
    // Below the floor clamps UP to 1 rather than falling back to the default —
    // the low override is what lets dev smoke trigger fan-out on a tiny problem.
    expect(fanoutMinChunks("1")).toBe(1);
    expect(fanoutMinChunks("0")).toBe(1);
    expect(fanoutMinChunks("-5")).toBe(1);
    expect(fanoutMinChunks("12.7")).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// 4. Serialization round-trip
// ---------------------------------------------------------------------------

describe("subsolve wire shapes survive structured clone", () => {
  it("keeps frozen placements and budgets intact through the RPC boundary", async () => {
    const request = requestSet(1)[0]!;
    request.frozen[0] = 17;
    request.frozen[1] = -1;

    const cloned = structuredClone(request) as SubsolveRequest;
    expect(cloned.frozen).toBeInstanceOf(Int32Array);
    expect(Array.from(cloned.frozen)).toEqual(Array.from(request.frozen));
    expect(cloned.kept).toEqual(request.kept);
    expect(cloned.wallMs).toBe(request.wallMs);
    expect(cloned.nodeCap).toBe(request.nodeCap);
    expect(cloned.problem).toEqual(request.problem);

    const result = runSubsolve(request);
    const clonedResult = structuredClone(result) as SubsolveResult;
    expect(clonedResult.placement).toBeInstanceOf(Int32Array);
    expect(Array.from(clonedResult.placement)).toEqual(Array.from(result.placement));
    expect(clonedResult.cost).toBe(result.cost);
    expect(clonedResult.proved).toBe(result.proved);
    expect(clonedResult.nodes).toBe(result.nodes);

    // And a sub-solve run on the CLONE is identical to one run on the original:
    // nothing in the request depends on identity or on a live object graph.
    expect(plain([runSubsolve(cloned)])).toEqual(plain([result]));
  });

  it("normalises a placement that came back as something other than Int32Array", () => {
    const source = new Int32Array([3, -1, 8]);
    expect(Array.from(asInt32Array(source, 3))).toEqual([3, -1, 8]);
    // JSON-degraded shapes (a plain array, or the object form a naive
    // serializer produces) are coerced rather than silently NaN-poisoning cost.
    expect(Array.from(asInt32Array([3, -1, 8], 3))).toEqual([3, -1, 8]);
    expect(Array.from(asInt32Array({ 0: 3, 1: -1, 2: 8 }, 3))).toEqual([3, -1, 8]);
    expect(Array.from(asInt32Array(source.buffer, 3))).toEqual([3, -1, 8]);
    expect(() => asInt32Array(null, 3)).toThrowError(/placement/);
  });

  it("applies the same strictness to every input shape", () => {
    const source = new Int32Array([3, -1, 8]);
    // Length is enforced uniformly — a short array is a truncated placement,
    // not something to pad with zeros (slot 0 is a real, cheap slot).
    expect(() => asInt32Array([3, -1], 3)).toThrowError(/length/);
    expect(() => asInt32Array(source, 4)).toThrowError(/length/);
    expect(() => asInt32Array(source.buffer, 4)).toThrowError(/length/);
    expect(() => asInt32Array([3, "x", 8], 3)).toThrowError(/placement entry/);

    // A view of some other element type is NOT reinterpretable as Int32 —
    // reading its bytes would produce a placement that is silently wrong.
    expect(() => asInt32Array(new Uint32Array([3, 1, 8]), 3)).toThrowError(/Uint32Array/);
    expect(() => asInt32Array(new Float64Array([3, 1, 8]), 3)).toThrowError(/Float64Array/);

    // A buffer that is not Int32-aligned fails in this module's vocabulary,
    // not as a bare RangeError from the TypedArray constructor.
    expect(() => asInt32Array(new ArrayBuffer(7), 1)).toThrowError(/placement/);
  });
});
