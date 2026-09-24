import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { runResolve } from "../../src/planning/resolve-internal";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { upsertUser, touchLastSeen, getUser } from "../../src/db/users";
import { sweepInactiveUsers } from "../../src/lifecycle/sweep-inactive";
import { seedMissingDefaultContexts } from "../fixtures/seed-contexts";

const A = "alice@org";
const B = "bob@org";

const DEEP = {
  context: "deep",
  fit_curve: { peak_start: "09:00", peak_end: "12:00", falloff_end: "16:00" },
  max_minutes_per_day: 240,
  max_contiguous_minutes: 90,
  over_daily_cap_penalty_per_15min: 25,
  over_streak_cap_penalty_per_15min: 25,
};
const BASE_WEIGHTS = { time_of_day_fit_per_15min: 5, churn_per_15min_moved: 10, priority_unit: 1, base_drop_penalty: 200 };

// A stub solver that records the problem it was handed and returns an empty schedule.
function capturingSolver(captured: { problem?: any }) {
  return {
    fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured.problem = JSON.parse(init!.body as string);
      return new Response(
        JSON.stringify({
          schedule: [],
          dropped: [],
          objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } },
          diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  } as unknown as Fetcher;
}

async function seedTask(subject: string, id: string) {
  await env.DB.prepare(
    "INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', '2026-05-17T00:00:00Z', '2026-05-17T00:00:00Z')",
  ).bind(id, subject, JSON.stringify({ id, title: "Deep work", context: "deep", priority: 80, duration_minutes: 90, earliest_start: "2026-05-18T00:00:00Z" })).run();
}

describe("merge gate: per-user config isolation", () => {
  // Freeze inside the fixed 2026-05-18 → 2026-05-25 window so the fully-past-week
  // guard does not short-circuit these resolves before the solver.
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T00:00:00.000Z"));
    for (const t of ["tasks", "task_templates", "proposed_plans", "config_weights", "config_contexts", "config_business_hours", "users"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
    await upsertUser(env.DB, A);
    await upsertUser(env.DB, B);
    // Default config that B (no overrides) falls back to.
    await env.DB.prepare("INSERT INTO config_weights (owner_subject, body) VALUES ('__default__', ?)")
      .bind(JSON.stringify({ ...BASE_WEIGHTS, base_drop_penalty: 200 })).run();
    await env.DB.prepare("INSERT INTO config_contexts (owner_subject, context, body) VALUES ('__default__', 'deep', ?)")
      .bind(JSON.stringify(DEEP)).run();
    await seedMissingDefaultContexts();
    await env.DB.prepare("INSERT INTO config_business_hours (owner_subject, body) VALUES ('__default__', ?)")
      .bind(JSON.stringify({ days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" })).run();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("(i) gives each user their OWN weights and business-hours in the solver problem", async () => {
    // Alice overrides weights + business-hours; Bob has no override.
    await env.DB.prepare("INSERT INTO config_weights (owner_subject, body) VALUES (?, ?)")
      .bind(A, JSON.stringify({ ...BASE_WEIGHTS, base_drop_penalty: 999 })).run();
    await env.DB.prepare("INSERT INTO config_contexts (owner_subject, context, body) VALUES (?, 'deep', ?)")
      .bind(A, JSON.stringify(DEEP)).run();
    await env.DB.prepare("INSERT INTO config_business_hours (owner_subject, body) VALUES (?, ?)")
      .bind(A, JSON.stringify({ days: ["mon"], start: "08:00", end: "12:00" })).run();
    await seedTask(A, "a1");
    await seedTask(B, "b1");

    const capA: { problem?: any } = {};
    await runResolve({ env: { ...env, SOLVER: capturingSolver(capA) }, calendar: new MockCalendarProvider(), windowStart: "2026-05-18T00:00:00Z", windowEnd: "2026-05-25T00:00:00Z", accountEmail: A , trigger: "api"});
    const capB: { problem?: any } = {};
    await runResolve({ env: { ...env, SOLVER: capturingSolver(capB) }, calendar: new MockCalendarProvider(), windowStart: "2026-05-18T00:00:00Z", windowEnd: "2026-05-25T00:00:00Z", accountEmail: B , trigger: "api"});

    expect(capA.problem.weights.base_drop_penalty).toBe(999);
    expect(capA.problem.business_hours).toEqual({ days: ["mon"], start: "08:00", end: "12:00" });
    expect(capB.problem.weights.base_drop_penalty).toBe(200);
    expect(capB.problem.business_hours.start).toBe("09:00");
  });

  it("(ii) a user with no override resolves against the __default__ rows", async () => {
    await seedTask(B, "b1");
    const capB: { problem?: any } = {};
    await runResolve({ env: { ...env, SOLVER: capturingSolver(capB) }, calendar: new MockCalendarProvider(), windowStart: "2026-05-18T00:00:00Z", windowEnd: "2026-05-25T00:00:00Z", accountEmail: B , trigger: "api"});
    expect(capB.problem.weights.base_drop_penalty).toBe(200);
    expect(capB.problem.business_hours.start).toBe("09:00");
    expect(capB.problem.contexts.map((c: any) => c.context)).toContain("deep");
  });
});

describe("merge gate: per-user timezone isolation", () => {
  // Freeze inside the fixed 2026-05-18 → 2026-05-25 window so the fully-past-week
  // guard does not short-circuit these resolves before the solver.
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T00:00:00.000Z"));
    for (const t of ["tasks", "task_templates", "proposed_plans", "config_weights", "config_contexts", "config_business_hours", "users"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
    await env.DB.prepare("INSERT INTO config_weights (owner_subject, body) VALUES ('__default__', ?)")
      .bind(JSON.stringify(BASE_WEIGHTS)).run();
    await env.DB.prepare("INSERT INTO config_contexts (owner_subject, context, body) VALUES ('__default__', 'deep', ?)")
      .bind(JSON.stringify(DEEP)).run();
    await seedMissingDefaultContexts();
    await upsertUser(env.DB, A);
    await upsertUser(env.DB, B);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses each user's home_tz for the solver problem tz, falling back to SCHEDULER_TZ", async () => {
    // Alice pins a home_tz; Bob has none and must fall back to env.SCHEDULER_TZ.
    await env.DB.prepare("UPDATE users SET home_tz = ? WHERE subject = ?").bind("America/New_York", A).run();
    await seedTask(A, "a1");
    await seedTask(B, "b1");

    const capA: { problem?: any } = {};
    await runResolve({ env: { ...env, SCHEDULER_TZ: "Australia/Sydney", SOLVER: capturingSolver(capA) }, calendar: new MockCalendarProvider(), windowStart: "2026-05-18T00:00:00Z", windowEnd: "2026-05-25T00:00:00Z", accountEmail: A , trigger: "api"});
    const capB: { problem?: any } = {};
    await runResolve({ env: { ...env, SCHEDULER_TZ: "Australia/Sydney", SOLVER: capturingSolver(capB) }, calendar: new MockCalendarProvider(), windowStart: "2026-05-18T00:00:00Z", windowEnd: "2026-05-25T00:00:00Z", accountEmail: B , trigger: "api"});

    expect(capA.problem.window.tz).toBe("America/New_York");
    expect(capB.problem.window.tz).toBe("Australia/Sydney");
  });
});

describe("merge gate: inactive-user sweep", () => {
  const noopCalendar = { calendarFor: () => ({ stopChannel: async () => {} }) as any };
  const NOW = new Date("2026-06-01T00:00:00Z");

  beforeEach(async () => {
    for (const t of ["users", "tasks", "task_templates", "projects", "calendar_sync", "identity_tokens", "oauth_tokens", "oauth_codes", "proposed_plans", "audit_log"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
  });

  it("(iii) is a strict no-op when RETENTION_DAYS is unset", async () => {
    await upsertUser(env.DB, A);
    await touchLastSeen(env.DB, A, "2020-01-01T00:00:00Z");
    const swept = await sweepInactiveUsers({ ...env, RETENTION_DAYS: undefined }, NOW, noopCalendar);
    expect(swept).toEqual([]);
    expect((await getUser(env.DB, A))?.is_active).toBe(1);
  });

  it("(iv) offboards a user past retention and leaves a recently-seen user intact", async () => {
    await upsertUser(env.DB, A);
    await touchLastSeen(env.DB, A, "2026-04-01T00:00:00Z"); // stale
    await upsertUser(env.DB, B);
    await touchLastSeen(env.DB, B, "2026-05-31T00:00:00Z"); // recent
    await env.DB.prepare("INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?,?,?,?,?,?)")
      .bind("a1", A, "{}", "pending", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z").run();

    const swept = await sweepInactiveUsers({ ...env, RETENTION_DAYS: "30" }, NOW, noopCalendar);

    expect(swept).toEqual([A]);
    expect((await getUser(env.DB, A))?.is_active).toBe(0);
    expect((await getUser(env.DB, B))?.is_active).toBe(1);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM tasks WHERE owner_subject = ?").bind(A).first<{ n: number }>();
    expect(n?.n).toBe(0);
    const auditRow = await env.DB.prepare("SELECT subject, actor, action, source FROM audit_log WHERE action = 'sweep_offboard'").first<Record<string, unknown>>();
    expect(auditRow).toEqual({ subject: A, actor: "cron-sweep", action: "sweep_offboard", source: "cron" });
  });
});
