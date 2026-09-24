import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env, SELF } from "cloudflare:test";
import { runResolve } from "../../src/planning/resolve-internal";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { hashToken } from "../../src/auth/tokens";
import { seedMissingDefaultContexts } from "../fixtures/seed-contexts";

// Week N = 2026-05-18 → 2026-05-25, week N+1 = 2026-05-25 → 2026-06-01.
// Clock frozen inside week N+1 so the fully-past-week guard does not trip.
const WEEK_N1_START = "2026-05-25T00:00:00Z";
const WEEK_N1_END = "2026-06-01T00:00:00Z";

const taskBody = {
  id: "t-stale",
  title: "Dropped last week",
  context: "deep",
  priority: 80,
  duration_minutes: 90,
};

const emptySolution = JSON.stringify({
  schedule: [],
  dropped: [],
  objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } },
  diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" },
});

describe("bring-forward: stale scheduled_for + timing PATCH", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T00:00:00.000Z"));
    await env.DB.prepare("DELETE FROM tasks").run();
    await env.DB.prepare("DELETE FROM task_templates").run();
    await env.DB.prepare("DELETE FROM proposed_plans").run();
    await env.DB.prepare("DELETE FROM config_weights").run();
    await env.DB.prepare("DELETE FROM config_contexts").run();
    await env.DB.prepare("DELETE FROM oauth_tokens").run();
    await env.DB.prepare("DELETE FROM oauth_clients").run();
    await env.DB.prepare("INSERT INTO config_weights (owner_subject, body) VALUES ('__default__', ?)")
      .bind(JSON.stringify({ time_of_day_fit_per_15min: 5, churn_per_15min_moved: 10, priority_unit: 1, base_drop_penalty: 200 })).run();
    await env.DB.prepare("INSERT INTO config_contexts (owner_subject, context, body) VALUES ('__default__', ?, ?)")
      .bind("deep", JSON.stringify({ context: "deep", fit_curve: { peak_start: "09:00", peak_end: "12:00", falloff_end: "16:00" }, max_minutes_per_day: 240, max_contiguous_minutes: 90, over_daily_cap_penalty_per_15min: 25, over_streak_cap_penalty_per_15min: 25 })).run();
    await seedMissingDefaultContexts();
    // Bearer for the PATCH, owned by the same subject the resolve scopes to.
    await env.DB.prepare(
      "INSERT INTO oauth_clients (id, name, type, redirect_uris, created_at) VALUES ('c1', 'test', 'pkce', NULL, '2026-01-01T00:00:00Z')",
    ).run();
    const h = await hashToken("tok", env.TOKEN_HASH_PEPPER);
    await env.DB.prepare(
      "INSERT INTO oauth_tokens (hashed_token, client_id, scopes, expires_at, refresh_of, revoked_at, subject) VALUES (?, 'c1', 'scheduler:read scheduler:write', '2099-01-01T00:00:00Z', NULL, NULL, 'seed@org')",
    ).bind(h).run();
    // Week-N relic: committed with a week-N stamp.
    await env.DB.prepare(
      "INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at, scheduled_for) VALUES (?, 'seed@org', ?, 'committed', '2026-05-17T00:00:00Z', '2026-05-17T00:00:00Z', '2026-05-19T09:00:00Z')",
    ).bind(taskBody.id, JSON.stringify(taskBody)).run();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function capturingSolver(captured: string[]): Fetcher {
    return {
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(init!.body as string) as { tasks: Array<{ id: string }> };
        for (const t of body.tasks) captured.push(t.id);
        return new Response(emptySolution, { status: 200, headers: { "content-type": "application/json" } });
      },
    } as unknown as Fetcher;
  }

  it("a stale-stamped task is shed from week N+1 until a timing PATCH brings it forward", async () => {
    // Baseline: stale stamp anchors the task to week N → shed from week N+1.
    const before: string[] = [];
    const r1 = await runResolve({
      env: { ...env, SOLVER: capturingSolver(before) },
      calendar: new MockCalendarProvider(),
      windowStart: WEEK_N1_START,
      windowEnd: WEEK_N1_END,
      accountEmail: "seed@org",
      trigger: "api",
    });
    expect(r1.kind).toBe("ok");
    expect(before).not.toContain("t-stale");

    // The MCP nudge: PATCH earliest_start into week N+1.
    const patch = await SELF.fetch("https://x/v1/tasks/t-stale", {
      method: "PATCH",
      headers: { Authorization: "Bearer tok", "Content-Type": "application/json" },
      body: JSON.stringify({ earliest_start: "2026-05-26T00:00:00Z" }),
    });
    expect(patch.status).toBe(200);

    // After the fix the stamp is cleared, so week N+1 now includes the task.
    const after: string[] = [];
    const r2 = await runResolve({
      env: { ...env, SOLVER: capturingSolver(after) },
      calendar: new MockCalendarProvider(),
      windowStart: WEEK_N1_START,
      windowEnd: WEEK_N1_END,
      accountEmail: "seed@org",
      trigger: "api",
    });
    expect(r2.kind).toBe("ok");
    expect(after).toContain("t-stale");
  });
});
