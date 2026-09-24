import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { runResolve } from "../../src/planning/resolve-internal";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { seedTwoUsers } from "../fixtures/owners";
import { seedMissingDefaultContexts } from "../fixtures/seed-contexts";

// Merge gate: a resolve run as user A must never read or place user B's tasks.
describe("runResolve owner isolation", () => {
  // Freeze inside the fixed 2026-05-18 → 2026-05-25 window so the fully-past-week
  // guard does not short-circuit before the solver (windowEnd <= real now).
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T00:00:00.000Z"));
    await env.DB.prepare("DELETE FROM proposed_plans").run();
    await env.DB.prepare("DELETE FROM config_weights").run();
    await env.DB.prepare("DELETE FROM config_contexts").run();
    await env.DB.prepare("INSERT INTO config_weights (owner_subject, body) VALUES ('__default__', ?)")
      .bind(JSON.stringify({ time_of_day_fit_per_15min: 5, churn_per_15min_moved: 10, priority_unit: 1, base_drop_penalty: 200 })).run();
    await env.DB.prepare("INSERT INTO config_contexts (owner_subject, context, body) VALUES ('__default__', ?, ?)")
      .bind("deep", JSON.stringify({ context: "deep", fit_curve: { peak_start: "09:00", peak_end: "12:00", falloff_end: "16:00" }, max_minutes_per_day: 240, max_contiguous_minutes: 90, over_daily_cap_penalty_per_15min: 25, over_streak_cap_penalty_per_15min: 25 })).run();
    await seedMissingDefaultContexts();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves only the acting owner's task and never the other owner's", async () => {
    // seedUsers (via seedTwoUsers) DELETEs tasks and seeds subjects user0@org / user1@org.
    const { a, b } = await seedTwoUsers();

    const aTask = { id: "a-task", title: "A deep work", context: "deep", priority: 80, duration_minutes: 90, earliest_start: "2026-05-18T00:00:00Z" };
    const bTask = { id: "b-task", title: "B deep work", context: "deep", priority: 80, duration_minutes: 90, earliest_start: "2026-05-18T00:00:00Z" };
    await env.DB.prepare("INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)")
      .bind("a-task", a.subject, JSON.stringify(aTask), "2026-05-17T00:00:00Z", "2026-05-17T00:00:00Z").run();
    await env.DB.prepare("INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)")
      .bind("b-task", b.subject, JSON.stringify(bTask), "2026-05-17T00:00:00Z", "2026-05-17T00:00:00Z").run();

    let capturedIds: string[] = [];
    const stubSolver = { fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as { tasks: Array<{ id: string }> };
      capturedIds = body.tasks.map((t) => t.id);
      return new Response(JSON.stringify({
        schedule: [{ task_id: "a-task", chunk_id: "a-task#0", start: "2026-05-19T09:00:00", duration_minutes: 90, context: "deep" }],
        dropped: [],
        objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } },
        diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    } } as unknown as Fetcher;

    const cal = new MockCalendarProvider();
    const result = await runResolve({
      env: { ...env, SOLVER: stubSolver },
      calendar: cal,
      windowStart: "2026-05-18T00:00:00Z",
      windowEnd: "2026-05-25T00:00:00Z",
      accountEmail: a.subject,
      trigger: "api",
    });

    // Solver only ever saw A's task.
    expect(capturedIds).toEqual(["a-task"]);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    // The produced plan references only A's task, never B's.
    const planTaskIds = result.body.schedule.map((e) => e.task_id);
    expect(planTaskIds).not.toContain("b-task");
    expect(result.body.account_email).toBe(a.subject);
  });
});
