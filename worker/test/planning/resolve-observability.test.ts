import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { runResolve, SOLVER_MAX_ATTEMPTS } from "../../src/planning/resolve-internal";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { seedMissingDefaultContexts } from "../fixtures/seed-contexts";

/** A valid solver body with distinctive diagnostics so passthrough is provable. */
const OK_BODY = {
  schedule: [],
  dropped: [],
  objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } },
  diagnostics: { pass1_wall_seconds: 0.5, pass2_wall_seconds: 1.25, status: "FEASIBLE" },
};

/** A solver stub returning a scripted sequence of responses (last step repeats),
 *  optionally with extra headers — used to drive the uptime-header path. */
function sequenceSolver(
  steps: Array<{ status: number; body: unknown; headers?: Record<string, string> }>,
): { fetcher: Fetcher; calls: () => number } {
  let calls = 0;
  const fetcher = {
    fetch: async () => {
      const step = steps[Math.min(calls, steps.length - 1)]!;
      calls++;
      return new Response(JSON.stringify(step.body), {
        status: step.status,
        headers: { "content-type": "application/json", ...step.headers },
      });
    },
  } as unknown as Fetcher;
  return { fetcher, calls: () => calls };
}

/** A solver stub whose first `hangAttempts` calls hang until aborted. */
function hangingSolver(hangAttempts: number): Fetcher {
  let calls = 0;
  return {
    fetch: (input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const mine = ++calls;
        const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        if (mine <= hangAttempts) {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        } else {
          resolve(new Response(JSON.stringify(OK_BODY), { status: 200, headers: { "content-type": "application/json" } }));
        }
      }),
  } as unknown as Fetcher;
}

/** Extract and parse every `<event> {json}` console.info line for one event. */
function loggedEvents(spy: ReturnType<typeof vi.spyOn>, event: string): Array<Record<string, unknown>> {
  const prefix = `${event} `;
  return spy.mock.calls
    .map((c) => String(c[0]))
    .filter((m) => m.startsWith(prefix))
    .map((m) => JSON.parse(m.slice(prefix.length)) as Record<string, unknown>);
}

describe("solver observability log lines", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    for (const t of ["calendar_sync", "tasks", "proposed_plans", "config_weights", "config_contexts", "solver_calls"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
    await env.DB.prepare("INSERT INTO config_weights (owner_subject, body) VALUES ('__default__', ?)")
      .bind(JSON.stringify({ time_of_day_fit_per_15min: 5, churn_per_15min_moved: 10, priority_unit: 1, base_drop_penalty: 200 }))
      .run();
    await seedMissingDefaultContexts();
    infoSpy = vi.spyOn(console, "info");
  });

  afterEach(() => {
    infoSpy.mockRestore();
  });

  // Window relative to real now — see resolve-solver-timeout.test.ts for why a
  // hardcoded window rots (isWeekFullyPast short-circuits before the solver).
  const args = (solver: Fetcher) => {
    const now = Date.now();
    return {
      env: { ...env, SOLVER: solver, SOLVER_TIMEOUT_MS: "20" },
      calendar: new MockCalendarProvider({ events: [] }),
      windowStart: new Date(now - 60 * 60_000).toISOString(),
      windowEnd: new Date(now + 7 * 24 * 60 * 60_000).toISOString(),
      accountEmail: "op@example.com",
      trigger: "api" as const,
    };
  };

  it("logs solver_fetch (attempt, ms, status) and solver_diagnostics on success", async () => {
    const { fetcher } = sequenceSolver([{ status: 200, body: OK_BODY }]);
    const res = await runResolve(args(fetcher));
    expect(res.kind).toBe("ok");

    const fetches = loggedEvents(infoSpy, "solver_fetch");
    expect(fetches).toHaveLength(1);
    expect(fetches[0]).toMatchObject({ attempt: 1, status: 200 });
    expect(typeof fetches[0]!.ms).toBe("number");

    const diags = loggedEvents(infoSpy, "solver_diagnostics");
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({
      pass1_wall_seconds: 0.5,
      pass2_wall_seconds: 1.25,
      status: "FEASIBLE",
    });
    expect(typeof diags[0]!.round_trip_ms).toBe("number");
  });

  it("propagates the solver's X-Solver-Uptime-Ms header into the solver_fetch line", async () => {
    const { fetcher } = sequenceSolver([
      { status: 200, body: OK_BODY, headers: { "X-Solver-Uptime-Ms": "123" } },
    ]);
    const res = await runResolve(args(fetcher));
    expect(res.kind).toBe("ok");
    const fetches = loggedEvents(infoSpy, "solver_fetch");
    expect(fetches[0]).toMatchObject({ solver_uptime_ms: 123 });
  });

  it("logs one solver_fetch line per attempt across a 5xx retry", async () => {
    const { fetcher } = sequenceSolver([
      { status: 500, body: { detail: "container not ready" } },
      { status: 200, body: OK_BODY },
    ]);
    const res = await runResolve(args(fetcher));
    expect(res.kind).toBe("ok");
    const fetches = loggedEvents(infoSpy, "solver_fetch");
    expect(fetches).toHaveLength(2);
    expect(fetches[0]).toMatchObject({ attempt: 1, status: 500 });
    expect(fetches[1]).toMatchObject({ attempt: 2, status: 200 });
  });

  it("logs a solver_fetch line with an error field when an attempt aborts on timeout", async () => {
    const res = await runResolve(args(hangingSolver(SOLVER_MAX_ATTEMPTS)));
    expect(res.kind).toBe("solver_error");
    const fetches = loggedEvents(infoSpy, "solver_fetch");
    expect(fetches).toHaveLength(SOLVER_MAX_ATTEMPTS);
    for (const [i, f] of fetches.entries()) {
      expect(f.attempt).toBe(i + 1);
      expect(typeof f.ms).toBe("number");
      expect(String(f.error)).toContain("abort");
    }
  });
});

/** Card 1.1: every solve that gets an HTTP answer is persisted to `solver_calls`
 *  so the demand dataset outlives the 7-day Workers Logs retention. */
describe("solver_calls persistence", () => {
  const TASK = {
    id: "t1",
    title: "Deep work",
    context: "deep",
    priority: 80,
    duration_minutes: 90,
  };

  beforeEach(async () => {
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
  });

  const now = () => Date.now();
  const args = (solver: Fetcher, trigger: "api" | "webhook" | "cron", extra: Partial<Record<string, unknown>> = {}) => {
    const t = now();
    return {
      env: { ...env, SOLVER: solver, SOLVER_TIMEOUT_MS: "20", ...extra } as typeof env,
      calendar: new MockCalendarProvider({
        events: [
          { id: "ext1", summary: "Client call", start: new Date(t + 2 * 3_600_000).toISOString(), end: new Date(t + 3 * 3_600_000).toISOString(), extendedProperties: {} },
        ],
      }),
      windowStart: new Date(t - 60 * 60_000).toISOString(),
      windowEnd: new Date(t + 7 * 24 * 60 * 60_000).toISOString(),
      accountEmail: "op@example.com",
      trigger,
    };
  };

  const rows = () => env.DB.prepare("SELECT * FROM solver_calls ORDER BY at").all<Record<string, unknown>>().then((r) => r.results);

  it("writes one row with trigger, sizes and timings on success", async () => {
    const body = {
      ...OK_BODY,
      dropped: [{ task_id: "t1", title: "Deep work", drop_cost: 280, reason: "capacity", contributing_constraints: [] }],
    };
    const { fetcher } = sequenceSolver([{ status: 200, body, headers: { "X-Solver-Uptime-Ms": "4321" } }]);
    const res = await runResolve(args(fetcher, "webhook"));
    expect(res.kind).toBe("ok");

    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      owner: "op@example.com",
      trigger: "webhook",
      attempts: 1,
      http_status: 200,
      solver_uptime_ms: 4321,
      pass1_ms: 500,
      pass2_ms: 1250,
      status: "FEASIBLE",
      n_tasks: 1,
      n_external: 1,
      n_dropped: 1,
      source: "live",
    });
    expect(typeof r[0]!.id).toBe("string");
    expect(String(r[0]!.at)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(String(r[0]!.window_start)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r[0]!.n_chunks as number).toBeGreaterThanOrEqual(1);
    expect(typeof r[0]!.round_trip_ms).toBe("number");
  });

  it("writes a row with status UNSAT and null pass fields on a 422", async () => {
    const { fetcher } = sequenceSolver([
      { status: 422, body: { unsat_core: [{ type: "pinned_at", task_id: "t1", value: "x" }] } },
    ]);
    const res = await runResolve(args(fetcher, "cron"));
    expect(res.kind).toBe("unsat");

    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      trigger: "cron",
      http_status: 422,
      status: "UNSAT",
      pass1_ms: null,
      pass2_ms: null,
      n_dropped: null,
      n_tasks: 1,
    });
  });

  it("records attempts=2 across a 5xx retry", async () => {
    const { fetcher } = sequenceSolver([
      { status: 500, body: { detail: "container not ready" } },
      { status: 200, body: OK_BODY },
    ]);
    const res = await runResolve(args(fetcher, "api"));
    expect(res.kind).toBe("ok");
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ trigger: "api", attempts: 2, http_status: 200 });
  });

  it("does not throw (resolve still ok) when the solver_calls insert fails", async () => {
    const { fetcher } = sequenceSolver([{ status: 200, body: OK_BODY }]);
    const a = args(fetcher, "api");
    // Wrap DB so only the solver_calls insert blows up; every other statement
    // (tasks load, plan persist) must keep working for this to prove isolation.
    const realDb = env.DB;
    const db = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (/INSERT INTO solver_calls/i.test(sql)) {
              return { bind: () => ({ run: () => Promise.reject(new Error("D1 boom")) }) };
            }
            return target.prepare(sql);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await runResolve({ ...a, env: { ...a.env, DB: db } });
    expect(res.kind).toBe("ok");
    expect(await rows()).toHaveLength(0);
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("solver_calls"))).toBe(true);
    errSpy.mockRestore();
  });

  it("extends the solver_diagnostics log line with trigger, attempts and sizes", async () => {
    const infoSpy = vi.spyOn(console, "info");
    const { fetcher } = sequenceSolver([{ status: 200, body: OK_BODY }]);
    await runResolve(args(fetcher, "webhook"));
    const diags = loggedEvents(infoSpy, "solver_diagnostics");
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ trigger: "webhook", attempts: 1, n_tasks: 1, n_external: 1, n_dropped: 0 });
    infoSpy.mockRestore();
  });
});
