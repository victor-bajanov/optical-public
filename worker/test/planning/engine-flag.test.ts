import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import {
  ENGINE_WALL_GUARD_MS,
  engineBudgets,
  engineMode,
  engineWallGuardMs,
  runResolve,
  solveForResolve,
} from "../../src/planning/resolve-internal";
import type { SolveContext } from "../../src/planning/resolve-internal";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { seedMissingDefaultContexts } from "../fixtures/seed-contexts";
import type { EngineResult } from "../../src/engine/types";
import type { Problem } from "../../src/planning/solver-contract";

/** The container's answer — deliberately distinguishable from the engine's by
 *  objective total, so "which one was served" is provable from the response. */
const CONTAINER_BODY = {
  schedule: [],
  dropped: [],
  objective: { total: 11, components: { lateness: 0, fit: 11, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } },
  diagnostics: { pass1_wall_seconds: 0.5, pass2_wall_seconds: 1.25, status: "FEASIBLE" },
};

const CONTAINER_UNSAT = { unsat_core: [{ type: "pinned_at", task_id: "t1", value: "container" }] };

/** Solver stub returning a scripted sequence (last step repeats), counting calls
 *  so "the HTTP hop never happened" is assertable. Mirrors the helper in
 *  resolve-observability.test.ts. */
function sequenceSolver(
  steps: Array<{ status: number; body: unknown }>,
): { fetcher: Fetcher; calls: () => number } {
  let calls = 0;
  const fetcher = {
    fetch: async () => {
      const step = steps[Math.min(calls, steps.length - 1)]!;
      calls++;
      return new Response(JSON.stringify(step.body), {
        status: step.status,
        headers: { "content-type": "application/json" },
      });
    },
  } as unknown as Fetcher;
  return { fetcher, calls: () => calls };
}

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

const rows = () =>
  env.DB.prepare("SELECT * FROM solver_calls ORDER BY at").all<Record<string, unknown>>().then((r) => r.results);

// ---------------------------------------------------------------------------
// Mode wiring, end to end through runResolve, against the REAL engine.
// ---------------------------------------------------------------------------

describe("SOLVER_ENGINE mode wiring (runResolve, real engine)", () => {
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

  // Window relative to real now — a hardcoded window rots (isWeekFullyPast
  // short-circuits before the solver). Same shape as the other resolve tests.
  const args = (solver: Fetcher, engineMode?: string, events: Array<Record<string, unknown>> = []) => {
    const t = Date.now();
    return {
      env: {
        ...env,
        SOLVER: solver,
        SOLVER_TIMEOUT_MS: "200",
        ...(engineMode === undefined ? {} : { SOLVER_ENGINE: engineMode }),
      } as typeof env,
      calendar: new MockCalendarProvider({ events: events as never }),
      windowStart: new Date(t - 60 * 60_000).toISOString(),
      windowEnd: new Date(t + 7 * 24 * 60 * 60_000).toISOString(),
      accountEmail: "op@example.com",
      trigger: "api" as const,
    };
  };

  it("unset flag: solves via the container, byte-identical to today", async () => {
    const { fetcher, calls } = sequenceSolver([{ status: 200, body: CONTAINER_BODY }]);
    const res = await runResolve(args(fetcher));

    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.body.objective.total).toBe(11);
    expect(calls()).toBe(1);

    const diags = loggedEvents(infoSpy, "solver_diagnostics");
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ engine: "container", status: "FEASIBLE", attempts: 1 });
    // No engine ran: an in-process solve would have been the only source of a
    // second diagnostics line, and the container's row owns the call id.
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ engine: "container", http_status: 200, attempts: 1 });
  });

  it("an unrecognised SOLVER_ENGINE value behaves as container and warns once", async () => {
    const { fetcher, calls } = sequenceSolver([{ status: 200, body: CONTAINER_BODY }]);
    const res = await runResolve(args(fetcher, "wroker"));

    expect(res.kind).toBe("ok");
    expect(calls()).toBe(1);
    const warns = loggedEvents(warnSpy, "solver_engine_unknown");
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({ value: "wroker", using: "container" });
    expect((await rows())[0]).toMatchObject({ engine: "container" });
  });

  it("the unknown-value warning is once per value, not once per resolve", async () => {
    // A value used by no other test: the dedupe set lives for the isolate's
    // lifetime, which is exactly the behaviour under test.
    const { fetcher } = sequenceSolver([{ status: 200, body: CONTAINER_BODY }]);
    expect((await runResolve(args(fetcher, "shadwo"))).kind).toBe("ok");
    expect((await runResolve(args(fetcher, "shadwo"))).kind).toBe("ok");

    const warns = loggedEvents(warnSpy, "solver_engine_unknown").filter((w) => w.value === "shadwo");
    expect(warns).toHaveLength(1);
  });

  it("worker mode: round-trips through solveProblem with no container fetch", async () => {
    const { fetcher, calls } = sequenceSolver([{ status: 200, body: CONTAINER_BODY }]);
    const res = await runResolve(args(fetcher, "worker"));

    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(calls()).toBe(0);
    // The real engine planned the one seeded task.
    expect(res.body.schedule).toHaveLength(1);
    expect(res.body.schedule[0]!.task_id).toBe("t1");

    const diags = loggedEvents(infoSpy, "solver_diagnostics");
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ engine: "worker", status: "OPTIMAL", attempts: null, solver_uptime_ms: null });
    expect(typeof diags[0]!.nodes).toBe("number");

    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ engine: "worker", status: "OPTIMAL", http_status: null, attempts: null });
    expect(typeof r[0]!.round_trip_ms).toBe("number");
  });

  // Worker-mode 422 propagation is asserted in the decision-table describe
  // below, against an injected engine. It is not exercised end to end because
  // no realistic D1 fixture reliably makes the REAL engine return a core: the
  // problem builder merges overlapping externals (so the substrate's
  // unconditional-UNSAT case is unreachable from runResolve), and a
  // must_include capacity conflict tight enough to survive demotion depends on
  // the business-hours floor at the wall-clock hour the suite happens to run.

  it("shadow mode: serves the container answer and logs one solver_shadow line", async () => {
    const { fetcher, calls } = sequenceSolver([{ status: 200, body: CONTAINER_BODY }]);
    const res = await runResolve(args(fetcher, "shadow"));

    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.body.objective.total).toBe(11);
    expect(res.body.schedule).toEqual([]);
    expect(calls()).toBe(1);

    const shadows = loggedEvents(infoSpy, "solver_shadow");
    expect(shadows).toHaveLength(1);
    expect(shadows[0]).toMatchObject({ engine_status: "OPTIMAL", container_status: "FEASIBLE", sat_agree: true });
    expect(typeof shadows[0]!.engine_wall_ms).toBe("number");
    expect(typeof shadows[0]!.container_wall_ms).toBe("number");
    expect(typeof shadows[0]!.engine_objective_total).toBe("number");

    // The served answer is the container's — never the shadow engine's.
    expect((await rows())[0]).toMatchObject({ engine: "container" });
  });

  it("fallback mode: the engine certifies this week, so the container is never called", async () => {
    const { fetcher, calls } = sequenceSolver([{ status: 200, body: CONTAINER_BODY }]);
    const res = await runResolve(args(fetcher, "fallback"));

    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(calls()).toBe(0);
    expect(res.body.schedule).toHaveLength(1);
    expect(loggedEvents(warnSpy, "solver_fallback")).toHaveLength(0);
    expect((await rows())[0]).toMatchObject({ engine: "worker", status: "OPTIMAL" });
  });
});

// ---------------------------------------------------------------------------
// Mixed-mode decision table, driven through solveForResolve with an injected
// engine. This is the same function runResolve calls (mode wiring is covered
// above); injection is how an exact status / crash is produced, since the
// workers pool does not honour vi.mock for the code under test's own imports.
// ---------------------------------------------------------------------------

describe("SOLVER_ENGINE fallback decision table", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await seed();
    infoSpy = vi.spyOn(console, "info");
    warnSpy = vi.spyOn(console, "warn");
    errorSpy = vi.spyOn(console, "error");
  });

  afterEach(() => {
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  const PROBLEM = {
    window: { start: "2026-05-18T00:00:00", end: "2026-05-25T00:00:00" },
    weights: {},
    contexts: [],
    tasks: [{ id: "t1", chunks: [{ chunk_id: "t1#0", duration_minutes: 90 }] }],
    external_pinned: [],
  } as unknown as Problem;

  const ctx = (
    solver: Fetcher,
    engine: SolveContext["engine"],
    mode: string,
    extraEnv: Record<string, string> = {},
  ): SolveContext => ({
    env: { ...env, SOLVER: solver, SOLVER_TIMEOUT_MS: "200", SOLVER_ENGINE: mode, ...extraEnv } as typeof env,
    db: env.DB,
    problem: PROBLEM,
    callId: crypto.randomUUID(),
    ownerSubject: "op@example.com",
    windowStart: "2026-05-18T00:00:00Z",
    windowEnd: "2026-05-25T00:00:00Z",
    trigger: "api",
    homeTz: "Australia/Sydney",
    realDurationByChunkId: new Map(),
    engine,
  });

  const engineSolution = (status: string, total = 777): (() => EngineResult) => () =>
    ({
      kind: "solution",
      solution: {
        schedule: [],
        dropped: [
          { task_id: "t1", title: "Deep work", drop_cost: 280, reason: "drop_was_cheaper_than_alternatives", contributing_constraints: [] },
        ],
        objective: {
          total,
          components: { lateness: 0, fit: total, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0, preferred_window: 0 },
        },
        diagnostics: {
          pass1_wall_seconds: 0.01,
          pass2_wall_seconds: 0.02,
          status,
          bound_gap: status === "OPTIMAL" ? 0 : 42,
          nodes: 123,
        },
      },
    }) as EngineResult;

  const engineUnsat = (): EngineResult => ({
    kind: "unsat",
    response: { unsat_core: [{ type: "deadline", task_id: "t1", value: "engine" }] },
  });

  it("threads env-derived budgets into the engine call", async () => {
    let got: unknown;
    const capture: SolveContext["engine"] = (_p, budgets) => {
      got = budgets;
      return engineSolution("OPTIMAL")();
    };
    const { fetcher } = sequenceSolver([{ status: 200, body: CONTAINER_BODY }]);
    await solveForResolve(
      ctx(fetcher, capture, "worker", { SOLVER_ENGINE_PASS1_TIME_LIMIT_S: "3" }),
    );
    expect((got as { pass1: { wallMs: number } }).pass1.wallMs).toBe(3000);
  });

  it("engine OPTIMAL: served, container never called", async () => {
    const { fetcher, calls } = sequenceSolver([{ status: 200, body: CONTAINER_BODY }]);
    const out = await solveForResolve(ctx(fetcher, engineSolution("OPTIMAL"), "fallback"));

    expect(out.kind).toBe("solution");
    if (out.kind !== "solution") return;
    expect(out.solution.objective.total).toBe(777);
    expect(calls()).toBe(0);
    expect(loggedEvents(warnSpy, "solver_fallback")).toHaveLength(0);

    const diags = loggedEvents(infoSpy, "solver_diagnostics");
    expect(diags[0]).toMatchObject({ engine: "worker", status: "OPTIMAL", bound_gap: 0, nodes: 123 });
    expect((await rows())[0]).toMatchObject({ engine: "worker", status: "OPTIMAL", n_dropped: 1, http_status: null, attempts: null });
  });

  it("engine throw: container served, reason engine_error", async () => {
    const { fetcher, calls } = sequenceSolver([{ status: 200, body: CONTAINER_BODY }]);
    const out = await solveForResolve(
      ctx(fetcher, () => {
        throw new Error("engine boom");
      }, "fallback"),
    );

    expect(out.kind).toBe("solution");
    if (out.kind !== "solution") return;
    expect(out.solution.objective.total).toBe(11);
    expect(calls()).toBe(1);

    const fb = loggedEvents(warnSpy, "solver_fallback");
    expect(fb).toHaveLength(1);
    expect(fb[0]).toMatchObject({ reason: "engine_error", engine_status: "ERROR", container_status: "FEASIBLE" });
    expect(String(fb[0]!.engine_error)).toContain("engine boom");
    expect(typeof fb[0]!.engine_wall_ms).toBe("number");
    expect(typeof fb[0]!.container_wall_ms).toBe("number");

    expect((await rows())[0]).toMatchObject({ engine: "container", http_status: 200 });
  });

  it("engine FEASIBLE: uncertified, container served", async () => {
    const { fetcher, calls } = sequenceSolver([{ status: 200, body: CONTAINER_BODY }]);
    const out = await solveForResolve(ctx(fetcher, engineSolution("FEASIBLE"), "fallback"));

    expect(out.kind).toBe("solution");
    if (out.kind !== "solution") return;
    expect(out.solution.objective.total).toBe(11);
    expect(calls()).toBe(1);
    expect(loggedEvents(warnSpy, "solver_fallback")[0]).toMatchObject({
      reason: "engine_uncertified",
      engine_status: "FEASIBLE",
    });
    expect((await rows())[0]).toMatchObject({ engine: "container" });
  });

  it("engine PASS1_FALLBACK: uncertified too", async () => {
    const { fetcher, calls } = sequenceSolver([{ status: 200, body: CONTAINER_BODY }]);
    const out = await solveForResolve(ctx(fetcher, engineSolution("PASS1_FALLBACK"), "fallback"));

    expect(out.kind).toBe("solution");
    expect(calls()).toBe(1);
    expect(loggedEvents(warnSpy, "solver_fallback")[0]).toMatchObject({
      reason: "engine_uncertified",
      engine_status: "PASS1_FALLBACK",
    });
  });

  it("engine over the wall guard: not served even when OPTIMAL, reason engine_timeout", async () => {
    const { fetcher, calls } = sequenceSolver([{ status: 200, body: CONTAINER_BODY }]);
    const slowButOptimal = () => {
      // The guard is post-hoc (the engine is synchronous), so the only way to
      // trip it is to actually spend the wall — 3 ms against a 1 ms guard.
      const until = Date.now() + 3;
      while (Date.now() < until) {
        /* spin */
      }
      return engineSolution("OPTIMAL")();
    };
    const out = await solveForResolve(
      ctx(fetcher, slowButOptimal, "fallback", { SOLVER_ENGINE_WALL_GUARD_MS: "1" }),
    );

    expect(out.kind).toBe("solution");
    if (out.kind !== "solution") return;
    expect(out.solution.objective.total).toBe(11);
    expect(calls()).toBe(1);
    expect(loggedEvents(warnSpy, "solver_fallback")[0]).toMatchObject({
      reason: "engine_timeout",
      engine_status: "OPTIMAL",
    });
    expect((await rows())[0]).toMatchObject({ engine: "container" });
  });

  it("engine unsat confirmed by a container 422: the 422 is served", async () => {
    const { fetcher, calls } = sequenceSolver([{ status: 422, body: CONTAINER_UNSAT }]);
    const out = await solveForResolve(ctx(fetcher, engineUnsat, "fallback"));

    expect(out.kind).toBe("unsat");
    if (out.kind !== "unsat") return;
    // The container stays the authority on the user-visible error.
    expect(out.unsatCore).toEqual(CONTAINER_UNSAT);
    expect(calls()).toBe(1);
    expect(loggedEvents(warnSpy, "solver_fallback")[0]).toMatchObject({
      reason: "engine_unsat_confirm",
      container_status: "UNSAT",
    });
    expect(loggedEvents(errorSpy, "solver_engine_disagreement")).toHaveLength(0);
    expect((await rows())[0]).toMatchObject({ engine: "container", status: "UNSAT", http_status: 422 });
  });

  it("engine PLAN contradicted by a container 422: the 422 is served and the disagreement is logged", async () => {
    // The mirror image of the unsat case: parity is falsified in this direction
    // too, so the error-level signal must fire here as well.
    const { fetcher, calls } = sequenceSolver([{ status: 422, body: CONTAINER_UNSAT }]);
    const out = await solveForResolve(ctx(fetcher, engineSolution("FEASIBLE"), "fallback"));

    expect(out.kind).toBe("unsat");
    if (out.kind !== "unsat") return;
    expect(out.unsatCore).toEqual(CONTAINER_UNSAT);
    expect(calls()).toBe(1);
    expect(loggedEvents(warnSpy, "solver_fallback")[0]).toMatchObject({
      reason: "engine_uncertified",
      container_status: "UNSAT",
    });

    const dis = loggedEvents(errorSpy, "solver_engine_disagreement");
    expect(dis).toHaveLength(1);
    expect(dis[0]).toMatchObject({ engine_status: "FEASIBLE", container_status: "UNSAT" });
  });

  it("a wall-guarded engine unsat contradicted by a container plan still logs the disagreement", async () => {
    const { fetcher, calls } = sequenceSolver([{ status: 200, body: CONTAINER_BODY }]);
    const slowUnsat = () => {
      const until = Date.now() + 3;
      while (Date.now() < until) {
        /* spin past the 1 ms guard */
      }
      return engineUnsat();
    };
    const out = await solveForResolve(
      ctx(fetcher, slowUnsat, "fallback", { SOLVER_ENGINE_WALL_GUARD_MS: "1" }),
    );

    expect(out.kind).toBe("solution");
    expect(calls()).toBe(1);
    // The guard changes the REASON, never whether a contradiction is reported.
    expect(loggedEvents(warnSpy, "solver_fallback")[0]).toMatchObject({
      reason: "engine_timeout",
      engine_status: "UNSAT",
    });
    const dis = loggedEvents(errorSpy, "solver_engine_disagreement");
    expect(dis).toHaveLength(1);
    expect(dis[0]).toMatchObject({ engine_status: "UNSAT", container_status: "FEASIBLE" });
  });

  it("container transport failure during a fallback: solver_error, and the line names it", async () => {
    const throwingSolver = {
      fetch: async () => {
        throw new Error("connection reset");
      },
    } as unknown as Fetcher;
    const out = await solveForResolve(ctx(throwingSolver, engineSolution("FEASIBLE"), "fallback"));

    expect(out.kind).toBe("solver_error");
    if (out.kind !== "solver_error") return;
    expect(out.status).toBe(504);
    expect(loggedEvents(warnSpy, "solver_fallback")[0]).toMatchObject({
      reason: "engine_uncertified",
      container_status: "transport_error",
    });
    // No answer at all: nothing to record.
    expect(await rows()).toHaveLength(0);
  });

  it("container 5xx during a fallback: the line names the status code", async () => {
    const { fetcher } = sequenceSolver([{ status: 500, body: { detail: "container not ready" } }]);
    const out = await solveForResolve(ctx(fetcher, engineSolution("FEASIBLE"), "fallback"));

    expect(out.kind).toBe("solver_error");
    if (out.kind !== "solver_error") return;
    expect(out.status).toBe(500);
    expect(loggedEvents(warnSpy, "solver_fallback")[0]).toMatchObject({
      reason: "engine_uncertified",
      container_status: "http_500",
    });
    expect(await rows()).toHaveLength(0);
  });

  it("engine unsat contradicted by a container plan: plan served, disagreement at error level", async () => {
    const { fetcher, calls } = sequenceSolver([{ status: 200, body: CONTAINER_BODY }]);
    const out = await solveForResolve(ctx(fetcher, engineUnsat, "fallback"));

    expect(out.kind).toBe("solution");
    if (out.kind !== "solution") return;
    expect(out.solution.objective.total).toBe(11);
    expect(calls()).toBe(1);
    expect(loggedEvents(warnSpy, "solver_fallback")[0]).toMatchObject({ reason: "engine_unsat_confirm" });

    const dis = loggedEvents(errorSpy, "solver_engine_disagreement");
    expect(dis).toHaveLength(1);
    expect(dis[0]).toMatchObject({ engine_status: "UNSAT", container_status: "FEASIBLE", owner: "op@example.com" });
    expect((await rows())[0]).toMatchObject({ engine: "container", http_status: 200 });
  });

  it("worker mode: an engine crash is a solver_error, never a silent container rescue", async () => {
    const { fetcher, calls } = sequenceSolver([{ status: 200, body: CONTAINER_BODY }]);
    const out = await solveForResolve(
      ctx(fetcher, () => {
        throw new Error("worker boom");
      }, "worker"),
    );

    expect(out.kind).toBe("solver_error");
    if (out.kind !== "solver_error") return;
    expect(out.detail).toContain("worker boom");
    expect(calls()).toBe(0);
    expect(await rows()).toHaveLength(0);
  });

  it("worker mode: an engine unsat is parsed through the container's own unsat path", async () => {
    const { fetcher, calls } = sequenceSolver([{ status: 200, body: CONTAINER_BODY }]);
    const out = await solveForResolve(ctx(fetcher, engineUnsat, "worker"));

    expect(out.kind).toBe("unsat");
    if (out.kind !== "unsat") return;
    expect(out.unsatCore).toEqual({ unsat_core: [{ type: "deadline", task_id: "t1", value: "engine" }] });
    expect(calls()).toBe(0);
    expect((await rows())[0]).toMatchObject({ engine: "worker", status: "UNSAT" });
  });

  it("shadow mode: an engine crash is swallowed to the comparison line", async () => {
    const { fetcher, calls } = sequenceSolver([{ status: 200, body: CONTAINER_BODY }]);
    const out = await solveForResolve(
      ctx(fetcher, () => {
        throw new Error("shadow boom");
      }, "shadow"),
    );

    expect(out.kind).toBe("solution");
    if (out.kind !== "solution") return;
    expect(out.solution.objective.total).toBe(11);
    expect(calls()).toBe(1);

    const shadows = loggedEvents(infoSpy, "solver_shadow");
    expect(shadows).toHaveLength(1);
    expect(String(shadows[0]!.engine_error)).toContain("shadow boom");
    expect(shadows[0]).toMatchObject({ container_status: "FEASIBLE", container_objective_total: 11 });
    expect((await rows())[0]).toMatchObject({ engine: "container" });
  });

  it("shadow mode: the comparison line reports objective agreement", async () => {
    const { fetcher } = sequenceSolver([{ status: 200, body: CONTAINER_BODY }]);
    const out = await solveForResolve(ctx(fetcher, engineSolution("FEASIBLE", 11), "shadow"));

    expect(out.kind).toBe("solution");
    const shadows = loggedEvents(infoSpy, "solver_shadow");
    expect(shadows).toHaveLength(1);
    expect(shadows[0]).toMatchObject({
      engine_status: "FEASIBLE",
      container_status: "FEASIBLE",
      engine_objective_total: 11,
      container_objective_total: 11,
      status_agree: true,
      sat_agree: true,
      objective_agree: true,
    });
  });
});

describe("engineMode whitespace", () => {
  it("trims stray whitespace before matching the mode", () => {
    // "shadow " from a dashboard paste must start the soak, not silently
    // demote to container with one warn line (review finding).
    expect(engineMode({ ...env, SOLVER_ENGINE: "shadow " } as typeof env)).toBe("shadow");
    expect(engineMode({ ...env, SOLVER_ENGINE: " fallback" } as typeof env)).toBe("fallback");
  });
});

describe("engineBudgets", () => {
  const withVars = (v: Record<string, string | undefined>) => ({ ...env, ...v }) as typeof env;

  it("defaults to the engine's own DEFAULT_BUDGETS walls", () => {
    const b = engineBudgets(withVars({}));
    expect(b.pass1.wallMs).toBe(20_000);
    expect(b.pass2.wallMs).toBe(20_000);
    expect(b.mus.wallMs).toBe(20_000);
  });

  it("parses seconds (fractions allowed), falls back on junk, floors at 1ms", () => {
    const b = engineBudgets(
      withVars({
        SOLVER_ENGINE_PASS1_TIME_LIMIT_S: "3",
        SOLVER_ENGINE_PASS2_TIME_LIMIT_S: "0.5",
        SOLVER_ENGINE_MUS_TIME_LIMIT_S: "abc",
      }),
    );
    expect(b.pass1.wallMs).toBe(3000);
    expect(b.pass2.wallMs).toBe(500);
    expect(b.mus.wallMs).toBe(20_000);
    expect(engineBudgets(withVars({ SOLVER_ENGINE_PASS1_TIME_LIMIT_S: "0" })).pass1.wallMs).toBe(1);
  });

  it("wall guard default derives from the env-tuned budgets", () => {
    expect(
      engineWallGuardMs(
        withVars({
          SOLVER_ENGINE_PASS1_TIME_LIMIT_S: "1",
          SOLVER_ENGINE_PASS2_TIME_LIMIT_S: "1",
          SOLVER_ENGINE_MUS_TIME_LIMIT_S: "1",
        }),
      ),
    ).toBe(6000);
  });
});

describe("engineWallGuardMs", () => {
  const withVar = (value?: string) => ({ ...env, SOLVER_ENGINE_WALL_GUARD_MS: value }) as typeof env;

  it("defaults to twice the engine's own wall budgets when unset", () => {
    expect(ENGINE_WALL_GUARD_MS).toBe(120_000);
    expect(engineWallGuardMs(withVar(undefined))).toBe(ENGINE_WALL_GUARD_MS);
  });

  it("treats blank as unset", () => {
    expect(engineWallGuardMs(withVar(""))).toBe(ENGINE_WALL_GUARD_MS);
    expect(engineWallGuardMs(withVar("   "))).toBe(ENGINE_WALL_GUARD_MS);
  });

  it("falls back to the default on an unparseable value", () => {
    expect(engineWallGuardMs(withVar("abc"))).toBe(ENGINE_WALL_GUARD_MS);
  });

  it("clamps a parseable value below 1 UP to the 1 ms floor, never to zero", () => {
    expect(engineWallGuardMs(withVar("0"))).toBe(1);
    expect(engineWallGuardMs(withVar("-5"))).toBe(1);
  });

  it("honours a real override", () => {
    expect(engineWallGuardMs(withVar("2500"))).toBe(2500);
    expect(engineWallGuardMs(withVar("2500.9"))).toBe(2500);
  });
});
