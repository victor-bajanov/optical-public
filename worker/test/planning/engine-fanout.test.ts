// Card E — worker-side wiring for the fan-out escape hatch
// (internal design notes §E).
//
// Covers the entrypoint (`EngineRpc.subsolve` answers exactly what an
// in-process `place()` answers), the env plumbing (`ENGINE_RPC`,
// `SOLVER_ENGINE_FANOUT`, `SOLVER_ENGINE_FANOUT_MIN_CHUNKS`), and the
// ships-dark property: with the flag ON and a binding bound, a resolve today
// still makes zero RPC calls, because the improvement phase that would use
// them is card D/F's and does not exist yet.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { defaultEngineSolve, runResolve } from "../../src/planning/resolve-internal";
import { solveProblem } from "../../src/engine/engine";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { seedMissingDefaultContexts } from "../fixtures/seed-contexts";
import { bakeProblem } from "../../src/engine/substrate";
import { place } from "../../src/engine/pass2";
import {
  fanoutEligible,
  fanoutMinChunks,
  makeRpcSubsolve,
  runSubsolve,
} from "../../src/engine/fanout";
import type { EngineRpcBinding } from "../../src/engine/fanout";
import type { Problem, SubsolveRequest, SubsolveResult } from "../../src/engine/types";

import pBaseline from "../../../bench/problems/baseline-light.json";
import pEmptyHardWindow from "../../../bench/problems/edge_empty_hard_window-light.json";

const PROBLEM = (pBaseline as unknown as { problem: Problem }).problem;

function smallRequest(): SubsolveRequest {
  const baked = bakeProblem(PROBLEM);
  return {
    problem: PROBLEM,
    kept: baked.tasks.map((t) => t.index),
    frozen: new Int32Array(baked.chunks.length).fill(-1),
    wallMs: 5_000,
    nodeCap: 200_000,
  };
}

function plain(r: SubsolveResult) {
  return {
    placement: Array.from(r.placement),
    cost: r.cost,
    proved: r.proved,
    nodes: r.nodes,
    descents: r.descents,
  };
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

// ENGINE_RPC is bound to this worker's own EngineRpc entrypoint by
// vitest.workspace.ts (kCurrentWorker), so these calls are real cross-isolate
// RPC — the request and result genuinely cross workerd's serialization
// boundary rather than being handed over in-process.
describe("EngineRpc entrypoint", () => {
  const rpc = () => {
    const binding = env.ENGINE_RPC;
    if (binding === undefined) throw new Error("ENGINE_RPC is not bound in the test env");
    return binding;
  };

  it("subsolve matches an in-process place() on the same sub-problem", async () => {
    const request = smallRequest();
    const baked = bakeProblem(PROBLEM);
    const inProcess = place(
      baked,
      request.kept,
      null,
      { wallMs: request.wallMs, nodeCap: request.nodeCap },
      { frozenChunks: request.frozen },
    );

    const viaRpc = await rpc().subsolve(request);

    expect(plain(viaRpc)).toEqual({
      placement: Array.from(inProcess.placement),
      cost: inProcess.cost,
      proved: inProcess.proved,
      nodes: inProcess.nodes,
      descents: inProcess.descents,
    });
    // And the same thing the master would have computed for itself.
    expect(plain(viaRpc)).toEqual(plain(runSubsolve(request)));
  });

  it("carries frozen placements and budgets across the RPC boundary intact", async () => {
    const request = smallRequest();
    request.frozen[0] = 17;

    const viaRpc = await rpc().subsolve(request);
    // What comes back over real RPC is a typed array, not a JSON husk — the
    // property engine/fanout.ts's asInt32Array() exists to defend.
    expect(viaRpc.placement).toBeInstanceOf(Int32Array);
    expect(plain(viaRpc)).toEqual(plain(runSubsolve(request)));

    // A tiny budget must be honoured on the far side, not silently ignored:
    // the sub-solve is the caller's budget to spend, and a leaf that ran to
    // completion regardless would blow the improvement phase's wall.
    const starved = await rpc().subsolve({ ...request, wallMs: 1, nodeCap: 1 });
    expect(starved.nodes).toBeLessThanOrEqual(viaRpc.nodes);
  });

  it("carries descents across the wire, so a non-answer stays distinguishable", async () => {
    const request = smallRequest();
    expect((await rpc().subsolve(request)).descents).toBeGreaterThanOrEqual(1);

    // A partition pass 2 cannot realise returns cost 0 / proved false; only
    // descents says it produced nothing. That has to survive serialization or
    // card D's acceptance would read a non-answer as a free optimum.
    const unplaceable = (pEmptyHardWindow as unknown as { problem: Problem }).problem;
    const baked = bakeProblem(unplaceable);
    const noIncumbent = await rpc().subsolve({
      problem: unplaceable,
      kept: baked.tasks.map((t) => t.index),
      frozen: new Int32Array(baked.chunks.length).fill(-1),
      wallMs: 5_000,
      nodeCap: 200_000,
    });
    expect(noIncumbent.descents).toBe(0);
    expect(noIncumbent.cost).toBe(0);
  });

  it("batches through makeRpcSubsolve over the live binding, in request order", async () => {
    const baked = bakeProblem(PROBLEM);
    const all = baked.tasks.map((t) => t.index);
    const requests: SubsolveRequest[] = all.map((dropped) => ({
      problem: PROBLEM,
      kept: all.filter((t) => t !== dropped),
      frozen: new Int32Array(baked.chunks.length).fill(-1),
      wallMs: 5_000,
      nodeCap: 200_000,
    }));

    const combined = await makeRpcSubsolve(rpc(), 2)(requests);
    expect(combined.map(plain)).toEqual(requests.map((r) => plain(runSubsolve(r))));
  });
});

// ---------------------------------------------------------------------------
// Env plumbing + gating against the real Env shape
// ---------------------------------------------------------------------------

describe("fan-out env plumbing", () => {
  it("is off on the deployed config, bound binding or not", () => {
    // wrangler.toml pins the flag to an explicit "false" in every env block —
    // the ships-dark guarantee, asserted here against the real config rather
    // than trusted to a comment.
    expect(env.SOLVER_ENGINE_FANOUT).toBe("false");
    expect(env.ENGINE_RPC).toBeDefined();
    expect(
      fanoutEligible({
        flag: env.SOLVER_ENGINE_FANOUT,
        binding: env.ENGINE_RPC,
        improvementPhaseActive: true,
        chunkCount: 1_000,
        minChunks: fanoutMinChunks(env.SOLVER_ENGINE_FANOUT_MIN_CHUNKS),
      }),
    ).toBe(false);
  });

  it("is off when the flag is on but no binding is bound", () => {
    expect(
      fanoutEligible({
        flag: "true",
        binding: undefined,
        improvementPhaseActive: true,
        chunkCount: 1_000,
        minChunks: 24,
      }),
    ).toBe(false);
  });

  it("defaults the chunk threshold to 24 and honours a low dev override", () => {
    expect(fanoutMinChunks(env.SOLVER_ENGINE_FANOUT_MIN_CHUNKS)).toBe(24);
    expect(fanoutMinChunks("1")).toBe(1);
  });

  it("engages once the flag, the binding and the size threshold all line up", () => {
    const binding: EngineRpcBinding = { subsolve: async (r) => runSubsolve(r) };
    expect(
      fanoutEligible({
        flag: "true",
        binding,
        improvementPhaseActive: true,
        chunkCount: 24,
        minChunks: fanoutMinChunks(undefined),
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Ships dark
// ---------------------------------------------------------------------------

describe("fan-out ships dark", () => {
  const TASK = { id: "t1", title: "Deep work", context: "deep", priority: 80, duration_minutes: 90 };

  const seed = async () => {
    for (const t of ["calendar_sync", "tasks", "proposed_plans", "config_weights", "config_contexts", "solver_calls"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
    await env.DB.prepare("INSERT INTO config_weights (owner_subject, body) VALUES ('__default__', ?)")
      .bind(JSON.stringify({ time_of_day_fit_per_15min: 5, churn_per_15min_moved: 10, priority_unit: 1, base_drop_penalty: 200 }))
      .run();
    await seedMissingDefaultContexts();
    await env.DB
      .prepare("INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', '2026-05-17T00:00:00Z', '2026-05-17T00:00:00Z')")
      .bind("t1", "op@example.com", JSON.stringify(TASK))
      .run();
  };

  let infoSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await seed();
    infoSpy = vi.spyOn(console, "info");
    warnSpy = vi.spyOn(console, "warn");
  });
  afterEach(() => {
    infoSpy.mockRestore();
    warnSpy.mockRestore();
  });

  const resolveWith = async (mode: string, binding: EngineRpcBinding) => {
    const t = Date.now();
    return runResolve({
      env: {
        ...env,
        SOLVER: { fetch: async () => new Response("{}", { status: 500 }) } as unknown as Fetcher,
        SOLVER_TIMEOUT_MS: "200",
        SOLVER_ENGINE: mode,
        SOLVER_ENGINE_FANOUT: "true",
        SOLVER_ENGINE_FANOUT_MIN_CHUNKS: "1",
        ENGINE_RPC: binding,
      } as typeof env,
      calendar: new MockCalendarProvider({ events: [] }),
      windowStart: new Date(t - 60 * 60_000).toISOString(),
      windowEnd: new Date(t + 7 * 24 * 60 * 60_000).toISOString(),
      accountEmail: "op@example.com",
      trigger: "api" as const,
    });
  };

  const loggedLines = () =>
    [...infoSpy.mock.calls, ...warnSpy.mock.calls].map((c) => String(c[0]));

  it("a worker-mode resolve with the flag ON makes zero RPC calls today", async () => {
    let rpcCalls = 0;
    const binding: EngineRpcBinding = {
      subsolve: async (r) => {
        rpcCalls++;
        return runSubsolve(r);
      },
    };
    const res = await resolveWith("worker", binding);

    expect(res.kind).toBe("ok");
    // Card F wired the flag; a resolve this small CERTIFIES, so the
    // improvement phase never engages and no RPC is made — the gate's
    // phase-active condition enforced by construction.
    expect(rpcCalls).toBe(0);
    // The gate line is the ONLY engine_fanout* emission: no engagement, so no
    // session summary and nothing degraded. Written as a wildcard over the
    // family rather than a list of names, so a future engine_fanout_* line
    // that slips into a dark-by-construction resolve fails here.
    const fanoutLines = loggedLines().filter((l) => l.startsWith("engine_fanout"));
    expect(fanoutLines.every((l) => l.startsWith("engine_fanout_gate "))).toBe(true);
    // Exactly ONE gate line per resolve — the card's literal contract, which
    // per-call unit tests cannot see.
    expect(fanoutLines).toHaveLength(1);
  });

  it("carries the resolve's call_id, joining the gate decision to its solver_calls row", async () => {
    const binding: EngineRpcBinding = { subsolve: async (r) => runSubsolve(r) };
    const res = await resolveWith("worker", binding);
    expect(res.kind).toBe("ok");

    const gate = loggedLines().filter((l) => l.startsWith("engine_fanout_gate "));
    expect(gate).toHaveLength(1);
    const body = JSON.parse(gate[0]!.slice("engine_fanout_gate ".length)) as {
      call_id?: unknown;
    };
    expect(typeof body.call_id).toBe("string");
    expect(body.call_id).not.toBe("");

    // A cron invocation resolving several subjects interleaves their lines in
    // one logs[] array; the id is what pulls one resolve's gate decision back
    // together with the row recording what that solve did.
    const row = await env.DB.prepare("SELECT id FROM solver_calls").first<{ id: string }>();
    expect(body.call_id).toBe(row?.id);
  });

  it("emits exactly one gate line in fallback mode, where a second solver exists", async () => {
    const binding: EngineRpcBinding = { subsolve: async (r) => runSubsolve(r) };
    // Fallback runs the engine first and serves it only when it certifies.
    // This problem does certify, so the container stub is never reached and
    // the resolve succeeds — but the mode is the one that carries a second
    // solve machinery, so it is where a duplicated gate line would surface.
    const res = await resolveWith("fallback", binding);
    expect(res.kind).toBe("ok");
    expect(loggedLines().filter((l) => l.startsWith("engine_fanout_gate "))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Card F — engine selection wiring (defaultEngineSolve)
// ---------------------------------------------------------------------------

describe("card F — defaultEngineSolve", () => {
  const budgets = {
    pass1: { wallMs: Infinity, nodeCap: 500_000 },
    pass2: { wallMs: Infinity, nodeCap: 3_000 },
    mus: { wallMs: Infinity, nodeCap: 100_000 },
  };

  it("flag off, binding absent, or below threshold picks the sync engine", () => {
    const off = defaultEngineSolve({ ...env, SOLVER_ENGINE_FANOUT: "false" } as typeof env, PROBLEM);
    expect(off.fanout).toBe(false);
    const unbound = defaultEngineSolve(
      { ...env, SOLVER_ENGINE_FANOUT: "true", ENGINE_RPC: undefined } as typeof env,
      PROBLEM,
    );
    expect(unbound.fanout).toBe(false);
    const tooSmall = defaultEngineSolve(
      { ...env, SOLVER_ENGINE_FANOUT: "true", SOLVER_ENGINE_FANOUT_MIN_CHUNKS: "9999" } as typeof env,
      PROBLEM,
    );
    expect(tooSmall.fanout).toBe(false);
  });

  it("eligible: the fan-out engine answers bit-identically to the sync path", async () => {
    // A node budget small enough that the solve does NOT certify, so the
    // improvement phase engages and real RPC sub-solves cross the binding.
    const fanoutEnv = {
      ...env,
      SOLVER_ENGINE_FANOUT: "true",
      SOLVER_ENGINE_FANOUT_MIN_CHUNKS: "1",
    } as typeof env;
    const picked = defaultEngineSolve(fanoutEnv, PROBLEM);
    expect(picked.fanout).toBe(true);

    const viaFanout = await picked.engine(PROBLEM, budgets);
    picked.finish();
    const sync = solveProblem(PROBLEM, budgets);

    expect(viaFanout.kind).toBe("solution");
    if (viaFanout.kind !== "solution" || sync.kind !== "solution") return;
    // The answer must be identical; wall clocks and the fan-out counter are
    // the only fields the flag may change.
    const strip = (s: typeof sync.solution) => {
      const { pass1_wall_seconds, pass2_wall_seconds, fanout_subsolves, ...d } = s.diagnostics;
      return { ...s, diagnostics: d };
    };
    expect(strip(viaFanout.solution)).toEqual(strip(sync.solution));
  });
});

// ---------------------------------------------------------------------------
// Card D finding (f) — engine_fanout_gate
// ---------------------------------------------------------------------------

describe("engine_fanout_gate", () => {
  const CHUNKS = PROBLEM.tasks.reduce((n, t) => n + t.chunks.length, 0);

  let infoSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    infoSpy = vi.spyOn(console, "info");
  });
  afterEach(() => {
    infoSpy.mockRestore();
  });

  const gateLines = () =>
    infoSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith("engine_fanout_gate "))
      .map((l) => JSON.parse(l.slice("engine_fanout_gate ".length)) as Record<string, unknown>);

  it("logs the gate's no when the flag is on but no binding is bound", () => {
    defaultEngineSolve(
      { ...env, SOLVER_ENGINE_FANOUT: "true", ENGINE_RPC: undefined } as typeof env,
      PROBLEM,
    );
    expect(gateLines()).toEqual([
      { eligible: false, chunk_count: CHUNKS, min_chunks: 24, binding_bound: false },
    ]);
  });

  it("logs the counts that decided a below-threshold no", () => {
    defaultEngineSolve(
      {
        ...env,
        SOLVER_ENGINE_FANOUT: "true",
        SOLVER_ENGINE_FANOUT_MIN_CHUNKS: "9999",
      } as typeof env,
      PROBLEM,
    );
    expect(gateLines()).toEqual([
      { eligible: false, chunk_count: CHUNKS, min_chunks: 9999, binding_bound: true },
    ]);
  });

  it("logs eligible:true once when the gate opens", () => {
    const picked = defaultEngineSolve(
      { ...env, SOLVER_ENGINE_FANOUT: "true", SOLVER_ENGINE_FANOUT_MIN_CHUNKS: "1" } as typeof env,
      PROBLEM,
    );
    picked.finish();
    // Exactly one line per resolve — the gate decision, not engagement. This
    // problem certifies, so the improvement phase stays idle and the
    // engine_fanout summary never fires: eligible-but-idle, the soak's
    // threshold-tuning signal.
    expect(gateLines()).toEqual([
      { eligible: true, chunk_count: CHUNKS, min_chunks: 1, binding_bound: true },
    ]);
  });

  it("logs the EFFECTIVE clamped threshold, not the raw env value", () => {
    defaultEngineSolve(
      { ...env, SOLVER_ENGINE_FANOUT: "true", SOLVER_ENGINE_FANOUT_MIN_CHUNKS: "0" } as typeof env,
      PROBLEM,
    );
    // fanoutMinChunks clamps UP to 1; the gate compares against that, so the
    // line has to report it. Logging the raw "0" would read as a gate that
    // opens for every problem while the real floor is 1.
    expect(gateLines()).toEqual([
      { eligible: true, chunk_count: CHUNKS, min_chunks: 1, binding_bound: true },
    ]);
  });

  it("is byte-silent on a dark deployment (flag false or unset)", () => {
    defaultEngineSolve({ ...env, SOLVER_ENGINE_FANOUT: "false" } as typeof env, PROBLEM);
    defaultEngineSolve({ ...env, SOLVER_ENGINE_FANOUT: undefined } as typeof env, PROBLEM);
    expect(gateLines()).toEqual([]);
  });
});
