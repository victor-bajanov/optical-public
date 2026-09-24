import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { runResolve } from "../../src/planning/resolve-internal";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { seedMissingDefaultContexts } from "../fixtures/seed-contexts";

/** A valid solver body with distinctive diagnostics so passthrough is provable. */
const OK_BODY = {
  schedule: [],
  dropped: [],
  objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } },
  diagnostics: { pass1_wall_seconds: 0.5, pass2_wall_seconds: 1.25, status: "FEASIBLE" },
};

/** A solver stub returning a scripted sequence of responses (last step repeats).
 *  `requests()` exposes the parsed JSON bodies actually sent, so a test can
 *  assert the captured envelope round-trips the REAL problem sent to the
 *  solver (not just a raw pre-transform value — window.start in particular is
 *  rewritten by computePlacementFloor + toLocalNaive before it ever reaches
 *  the solver, so it is never byte-equal to the caller's windowStart ISO
 *  string). */
function sequenceSolver(
  steps: Array<{ status: number; body: unknown }>,
): { fetcher: Fetcher; requests: () => unknown[] } {
  let calls = 0;
  const requests: unknown[] = [];
  const fetcher = {
    fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      const step = steps[Math.min(calls, steps.length - 1)]!;
      calls++;
      return new Response(JSON.stringify(step.body), {
        status: step.status,
        headers: { "content-type": "application/json" },
      });
    },
  } as unknown as Fetcher;
  return { fetcher, requests: () => requests };
}

// The test env always has SOLVER_CAPTURE bound (vitest.workspace.ts
// declares r2Buckets: ["SOLVER_CAPTURE"]); Env.SOLVER_CAPTURE is optional
// only because it's deliberately absent on deployments that haven't opted
// into collection.
const capture = (): R2Bucket => env.SOLVER_CAPTURE!;

/** Card 3.0: capturing live solver problems to R2 (SOLVER_CAPTURE_PROBLEMS). */
describe("solver problem capture (R2)", () => {
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
    // No explicit R2 cleanup: vitest-pool-workers gives each test isolated
    // storage (D1 above is wiped explicitly only because these fixtures are
    // shared setup, not because R2 state leaks between tests).
  });

  const now = () => Date.now();
  const args = (solver: Fetcher, extra: Partial<Record<string, unknown>> = {}) => {
    const t = now();
    return {
      env: { ...env, SOLVER: solver, SOLVER_TIMEOUT_MS: "20", ...extra } as typeof env,
      calendar: new MockCalendarProvider({ events: [] }),
      windowStart: new Date(t - 60 * 60_000).toISOString(),
      windowEnd: new Date(t + 7 * 24 * 60 * 60_000).toISOString(),
      accountEmail: "op@example.com",
      trigger: "api" as const,
    };
  };

  const rows = () =>
    env.DB.prepare("SELECT * FROM solver_calls ORDER BY at").all<Record<string, unknown>>().then((r) => r.results);

  it("captures the problem sent, keyed by the solver_calls row id, when the flag is true", async () => {
    const { fetcher, requests } = sequenceSolver([{ status: 200, body: OK_BODY }]);
    const res = await runResolve(args(fetcher, { SOLVER_CAPTURE_PROBLEMS: "true", DEPLOY_ENV: "dev" }));
    expect(res.kind).toBe("ok");

    const r = await rows();
    expect(r).toHaveLength(1);
    const id = r[0]!.id as string;

    const obj = await capture().get(`problems/${id}.json`);
    expect(obj).not.toBeNull();
    const envelope = JSON.parse(await obj!.text()) as {
      env: string;
      call_id: string;
      captured_at: string;
      problem: { tasks: unknown[]; window: { start: string } };
    };
    expect(envelope.env).toBe("dev");
    expect(envelope.call_id).toBe(id);
    expect(envelope.captured_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(envelope.problem.tasks.length).toBeGreaterThanOrEqual(1);
    // Round-trips the EXACT problem sent to the solver — not just a truthy
    // placeholder, and not a comparison against the caller's raw windowStart
    // ISO string (window.start is rewritten by computePlacementFloor +
    // toLocalNaive — quarter-rounded and reformatted into SCHEDULER_TZ,
    // "Australia/Sydney", with no "Z" suffix — before it ever reaches the
    // solver, so it is never byte-equal to the caller's UTC windowStart).
    const sent = requests()[0] as { window: { start: string } };
    expect(envelope.problem.window.start).toBe(sent.window.start);
    expect(envelope.problem).toEqual(sent);
  });

  it("captures on a 422, sharing the id with the UNSAT solver_calls row", async () => {
    const { fetcher } = sequenceSolver([
      { status: 422, body: { unsat_core: [{ type: "pinned_at", task_id: "t1", value: "x" }] } },
    ]);
    const res = await runResolve(args(fetcher, { SOLVER_CAPTURE_PROBLEMS: "true", DEPLOY_ENV: "dev" }));
    expect(res.kind).toBe("unsat");

    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]!.status).toBe("UNSAT");
    const id = r[0]!.id as string;

    const obj = await capture().get(`problems/${id}.json`);
    expect(obj).not.toBeNull();
    // Consume the body (unread R2ObjectBody streams leak across the isolated
    // storage boundary and break the next test in this file).
    await obj!.text();
  });

  it("captures nothing when the flag is unset", async () => {
    const { fetcher } = sequenceSolver([{ status: 200, body: OK_BODY }]);
    const res = await runResolve(args(fetcher, { SOLVER_CAPTURE_PROBLEMS: undefined }));
    expect(res.kind).toBe("ok");

    const listed = await capture().list();
    expect(listed.objects).toHaveLength(0);
  });

  it('captures nothing when the flag is "false"', async () => {
    const { fetcher } = sequenceSolver([{ status: 200, body: OK_BODY }]);
    const res = await runResolve(args(fetcher, { SOLVER_CAPTURE_PROBLEMS: "false" }));
    expect(res.kind).toBe("ok");

    const listed = await capture().list();
    expect(listed.objects).toHaveLength(0);
  });

  it("logs and continues (resolve still ok) when the R2 put rejects", async () => {
    const { fetcher } = sequenceSolver([{ status: 200, body: OK_BODY }]);
    const boomBucket = {
      put: () => Promise.reject(new Error("R2 boom")),
    } as unknown as R2Bucket;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await runResolve(
        args(fetcher, { SOLVER_CAPTURE_PROBLEMS: "true", DEPLOY_ENV: "dev", SOLVER_CAPTURE: boomBucket }),
      );
      expect(res.kind).toBe("ok");
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes("solver_capture put failed"))).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("logs and continues (resolve still ok) when the R2 put throws synchronously", async () => {
    const { fetcher } = sequenceSolver([{ status: 200, body: OK_BODY }]);
    const boomBucket = {
      put: () => {
        throw new Error("R2 boom sync");
      },
    } as unknown as R2Bucket;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await runResolve(
        args(fetcher, { SOLVER_CAPTURE_PROBLEMS: "true", DEPLOY_ENV: "dev", SOLVER_CAPTURE: boomBucket }),
      );
      expect(res.kind).toBe("ok");
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes("solver_capture put failed"))).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("stamps env: 'unknown' when DEPLOY_ENV is unset", async () => {
    const { fetcher } = sequenceSolver([{ status: 200, body: OK_BODY }]);
    const res = await runResolve(args(fetcher, { SOLVER_CAPTURE_PROBLEMS: "true", DEPLOY_ENV: undefined }));
    expect(res.kind).toBe("ok");

    const r = await rows();
    const id = r[0]!.id as string;
    const obj = await capture().get(`problems/${id}.json`);
    const envelope = JSON.parse(await obj!.text()) as { env: string };
    expect(envelope.env).toBe("unknown");
  });

  it("does not throw and captures nothing when the flag is true but the binding is absent (ms shape)", async () => {
    const { fetcher } = sequenceSolver([{ status: 200, body: OK_BODY }]);
    const a = args(fetcher, { SOLVER_CAPTURE_PROBLEMS: "true", DEPLOY_ENV: "dev" });
    const { SOLVER_CAPTURE: _unused, ...envWithoutCapture } = a.env as typeof a.env & { SOLVER_CAPTURE?: R2Bucket };
    const res = await runResolve({ ...a, env: envWithoutCapture as typeof a.env });
    expect(res.kind).toBe("ok");

    const listed = await capture().list();
    expect(listed.objects).toHaveLength(0);
  });
});
