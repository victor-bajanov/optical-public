import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { OpenAPIHono } from "@hono/zod-openapi";
import { mountResolveRoute } from "../../src/planning/resolve";
import { mountCommitRoute } from "../../src/planning/commit";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { MockNotificationProvider } from "../../src/providers/mock-notification-provider";
import type { CalendarProvider } from "../../src/providers/calendar-provider";
import type { NotificationProvider } from "../../src/providers/notification-provider";
import { hashToken } from "../../src/auth/tokens";
import { seedMissingDefaultContexts } from "../fixtures/seed-contexts";

const taskBody = {
  id: "t-int-1",
  title: "Integration deep work",
  context: "deep",
  priority: 80,
  duration_minutes: 60,
  earliest_start: "2026-05-18T00:00:00Z",
  preferred_windows: [],
  dependencies: [],
  pinned_at: null,
  template_id: null,
  project_id: null,
  source: { kind: "mcp", external_id: null },
  status: "pending",
  created_at: "2026-05-17T00:00:00Z",
  updated_at: "2026-05-17T00:00:00Z",
};

async function seedBearer(token: string) {
  const hashed = await hashToken(token, env.TOKEN_HASH_PEPPER);
  await env.DB.prepare(
    "INSERT OR REPLACE INTO oauth_tokens (hashed_token, client_id, scopes, expires_at, refresh_of, revoked_at, subject) VALUES (?, 'test-client', 'scheduler.write', NULL, NULL, NULL, ?)",
  )
    .bind(hashed, "primary")
    .run();
}

describe("integration: resolve → commit", () => {
  // Freeze inside the fixed 2026-05-18 → 2026-05-25 window so the fully-past-week
  // guard does not short-circuit the resolve before the solver (windowEnd <= now).
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T00:00:00.000Z"));
    await env.DB.prepare("DELETE FROM tasks").run();
    await env.DB.prepare("DELETE FROM proposed_plans").run();
    await env.DB.prepare("DELETE FROM config_weights").run();
    await env.DB.prepare("DELETE FROM config_contexts").run();
    await env.DB.prepare("DELETE FROM oauth_tokens").run();
    await env.DB
      .prepare("INSERT INTO config_weights (owner_subject, body) VALUES ('__default__', ?)")
      .bind(
        JSON.stringify({
          time_of_day_fit_per_15min: 5,
          churn_per_15min_moved: 10,
          priority_unit: 1,
          base_drop_penalty: 200,
        }),
      )
      .run();
    await env.DB
      .prepare("INSERT INTO config_contexts (owner_subject, context, body) VALUES ('__default__', ?, ?)")
      .bind(
        "deep",
        JSON.stringify({
          context: "deep",
          fit_curve: { peak_start: "09:00", peak_end: "12:00", falloff_end: "16:00" },
          max_minutes_per_day: 240,
          max_contiguous_minutes: 90,
          over_daily_cap_penalty_per_15min: 25,
          over_streak_cap_penalty_per_15min: 25,
        }),
      )
      .run();
    await env.DB
      .prepare("INSERT INTO config_contexts (owner_subject, context, body) VALUES ('__default__', ?, ?)")
      .bind(
        "meeting",
        JSON.stringify({
          context: "meeting",
          fit_curve: { peak_start: "10:00", peak_end: "11:00", falloff_end: "17:00" },
          max_minutes_per_day: 180,
          max_contiguous_minutes: 120,
          over_daily_cap_penalty_per_15min: 25,
          over_streak_cap_penalty_per_15min: 25,
        }),
      )
      .run();
    await seedMissingDefaultContexts();
    await env.DB
      .prepare(
        "INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)",
      )
      .bind(taskBody.id, "primary", JSON.stringify(taskBody), taskBody.created_at, taskBody.updated_at)
      .run();
    await seedBearer("fake");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates a proposed plan, then commits it, with a single calendar event written", async () => {
    const cal = new MockCalendarProvider();
    const notify = new MockNotificationProvider();
    const stubSolver: Fetcher = {
      fetch: async () =>
        new Response(
          JSON.stringify({
            schedule: [
              {
                task_id: taskBody.id,
                chunk_id: `${taskBody.id}#0`,
                start: "2026-05-19T09:00:00",
                duration_minutes: 60,
                context: "deep",
              },
            ],
            dropped: [],
            objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } },
            diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    } as unknown as Fetcher;
    const stubEnv = { ...env, SOLVER: stubSolver };

    const v1 = new OpenAPIHono<{
      Bindings: typeof env;
      Variables: { calendarProvider: CalendarProvider; notificationProvider: NotificationProvider };
    }>();
    v1.use("*", async (c, next) => {
      c.set("calendarProvider", cal);
      c.set("notificationProvider", notify);
      await next();
    });
    mountResolveRoute(v1);
    mountCommitRoute(v1);
    const app = new Hono<{
      Bindings: typeof env;
      Variables: { calendarProvider: CalendarProvider; notificationProvider: NotificationProvider };
    }>();
    app.route("/v1", v1);

    const r1 = await app.request(
      "/v1/resolve",
      {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer fake" },
        body: JSON.stringify({
          window_start: "2026-05-18T00:00:00Z",
          window_end: "2026-05-25T00:00:00Z",
          account_email: "test@example.com",
        }),
      },
      stubEnv,
    );
    expect(r1.status).toBe(200);
    const j1 = (await r1.json()) as { plan_hash: string };

    const r2 = await app.request(
      "/v1/commit",
      {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer fake" },
        body: JSON.stringify({ plan_hash: j1.plan_hash }),
      },
      stubEnv,
    );
    expect(r2.status).toBe(200);

    expect(cal.getCreated()).toHaveLength(1);
    expect(cal.getCreated()[0]!.summary).toBe("Integration deep work");
    expect(cal.getCreated()[0]!.extendedProperties.private?.scheduler_chunk_id).toBe(
      `${taskBody.id}#0`,
    );
  });
});
