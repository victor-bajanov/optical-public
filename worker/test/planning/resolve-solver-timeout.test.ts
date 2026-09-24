import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { runResolve, SOLVER_MAX_ATTEMPTS } from "../../src/planning/resolve-internal";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { seedMissingDefaultContexts } from "../fixtures/seed-contexts";

function okResponse(): Response {
  return new Response(
    JSON.stringify({
      schedule: [],
      dropped: [],
      objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } },
      diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** A solver stub whose first `hangAttempts` calls never resolve until the
 *  abort signal fires (then reject like a real aborted fetch); subsequent calls
 *  return a 200. Lets us drive the timeout/retry path with a tiny timeout. */
function hangingSolver(hangAttempts: number): { fetcher: Fetcher; calls: () => number } {
  let calls = 0;
  const fetcher = {
    fetch: (input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const mine = ++calls;
        const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        if (mine <= hangAttempts) {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
          // no resolve(): hangs until aborted
        } else {
          resolve(okResponse());
        }
      }),
  } as unknown as Fetcher;
  return { fetcher, calls: () => calls };
}

/** A solver stub that returns a scripted sequence of HTTP responses. The last
 *  step repeats for any calls beyond the sequence length. Lets us drive the
 *  5xx-retry path deterministically (no hanging / no real timers). */
function sequenceSolver(
  steps: Array<{ status: number; body: unknown }>,
): { fetcher: Fetcher; calls: () => number } {
  let calls = 0;
  const fetcher = {
    fetch: async () => {
      // Math.min clamps to a valid index for any non-empty steps array; the
      // non-null assertion satisfies noUncheckedIndexedAccess.
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

/** A valid OPTIMAL solver body (matches okResponse() above) for the 200 step. */
const OK_BODY = {
  schedule: [],
  dropped: [],
  objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } },
  diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" },
};

describe("runResolve solver timeout + retry", () => {
  beforeEach(async () => {
    for (const t of ["calendar_sync", "tasks", "proposed_plans", "config_weights", "config_contexts"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
    await env.DB.prepare("INSERT INTO config_weights (owner_subject, body) VALUES ('__default__', ?)")
      .bind(JSON.stringify({ time_of_day_fit_per_15min: 5, churn_per_15min_moved: 10, priority_unit: 1, base_drop_penalty: 200 }))
      .run();
    await seedMissingDefaultContexts();
  });

  // Window is computed relative to real `now` (this suite uses REAL timers for
  // the abort/timeout path, so fake timers are not an option). A hardcoded window
  // rots: once wall-clock passes windowEnd the isWeekFullyPast guard short-
  // circuits runResolve before the solver is ever called (it returned an empty
  // "ok" with 0 calls, failing every assertion here — this is what bit us on
  // 2026-06-22 when the old 2026-06-14…06-21 window elapsed).
  const args = (solver: Fetcher) => {
    const now = Date.now();
    return {
      // 20ms per-attempt timeout keeps the test fast; the retry logic is identical.
      env: { ...env, SOLVER: solver, SOLVER_TIMEOUT_MS: "20" },
      calendar: new MockCalendarProvider({ events: [] }),
      windowStart: new Date(now - 60 * 60_000).toISOString(),
      windowEnd: new Date(now + 7 * 24 * 60 * 60_000).toISOString(),
      accountEmail: "op@example.com",
      trigger: "api" as const,
    };
  };

  it('clamps SOLVER_TIMEOUT_MS "0" up to the 1ms floor instead of falling back to the 45s default', async () => {
    // House posture (parseEnvNumberWithFloor): a value that parses but sits
    // below the floor clamps UP, so a deliberate tiny override can drive the
    // timeout path. The old `Number(...) || SOLVER_TIMEOUT_MS` treated "0" as
    // falsy and silently ran with the 45s default — under that code this test
    // hangs on the first attempt until the suite timeout kills it.
    const { fetcher, calls } = hangingSolver(1);
    const base = args(fetcher);
    const res = await runResolve({ ...base, env: { ...base.env, SOLVER_TIMEOUT_MS: "0" } });
    expect(res.kind).toBe("ok");
    expect(calls()).toBe(2);
  });

  it("retries once and succeeds when the first solver attempt hangs", async () => {
    const { fetcher, calls } = hangingSolver(1);
    const res = await runResolve(args(fetcher));
    expect(res.kind).toBe("ok");
    expect(calls()).toBe(2);
  });

  it("returns solver_error 504 when every attempt times out", async () => {
    const { fetcher, calls } = hangingSolver(Infinity);
    const res = await runResolve(args(fetcher));
    expect(res.kind).toBe("solver_error");
    if (res.kind === "solver_error") expect(res.status).toBe(504);
    expect(calls()).toBe(SOLVER_MAX_ATTEMPTS);
  });

  it("retries a cold-start 5xx and succeeds when a later attempt returns 200", async () => {
    const { fetcher, calls } = sequenceSolver([
      { status: 500, body: { detail: "container not ready" } },
      { status: 200, body: OK_BODY },
    ]);
    const res = await runResolve(args(fetcher));
    expect(res.kind).toBe("ok");
    expect(calls()).toBe(2);
  });

  it("returns solver_error with the solver's 5xx status when every attempt is 5xx", async () => {
    const { fetcher, calls } = sequenceSolver([{ status: 500, body: { detail: "boom" } }]);
    const res = await runResolve(args(fetcher));
    expect(res.kind).toBe("solver_error");
    // The fast 500 must be classified as a 500 (→ route maps to 502), NOT the
    // 504 timeout path — they are distinct failures.
    if (res.kind === "solver_error") expect(res.status).toBe(500);
    expect(calls()).toBe(SOLVER_MAX_ATTEMPTS);
  });

  it("does not retry a 422 (unsat is definitive)", async () => {
    const { fetcher, calls } = sequenceSolver([
      { status: 422, body: { unsat_core: [{ type: "pinned_at", task_id: "u1", value: "2026-06-15T11:00:00Z" }] } },
    ]);
    const res = await runResolve(args(fetcher));
    expect(res.kind).toBe("unsat");
    expect(calls()).toBe(1);
  });
});
