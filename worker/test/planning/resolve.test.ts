import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { OpenAPIHono } from "@hono/zod-openapi";
import { mountResolveRoute } from "../../src/planning/resolve";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { MockNotificationProvider } from "../../src/providers/mock-notification-provider";
import type { CalendarProvider } from "../../src/providers/calendar-provider";
import type { NotificationProvider } from "../../src/providers/notification-provider";
import { hashToken } from "../../src/auth/tokens";
import { seedMissingDefaultContexts } from "../fixtures/seed-contexts";

type Env = typeof env;
type Vars = {
  calendarProvider: CalendarProvider;
  notificationProvider: NotificationProvider;
};

async function seedBearer(token: string, subject = "primary") {
  const hashed = await hashToken(token, env.TOKEN_HASH_PEPPER);
  await env.DB.prepare(
    "INSERT OR REPLACE INTO oauth_tokens (hashed_token, client_id, scopes, expires_at, refresh_of, revoked_at, subject) VALUES (?, 'test-client', 'scheduler.write', NULL, NULL, NULL, ?)",
  )
    .bind(hashed, subject)
    .run();
}

function makeApp(
  providers: { calendar: MockCalendarProvider; notify: MockNotificationProvider },
  solverHandler: (req: Request) => Promise<Response>,
) {
  const v1 = new OpenAPIHono<{ Bindings: Env; Variables: Vars }>();
  v1.use("*", async (c, next) => {
    c.set("calendarProvider", providers.calendar);
    c.set("notificationProvider", providers.notify);
    await next();
  });
  const solverFetcher: Fetcher = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      return solverHandler(req);
    },
  } as unknown as Fetcher;
  const stubEnv = { ...env, SOLVER: solverFetcher };
  mountResolveRoute(v1);
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();
  app.route("/v1", v1);
  return { app, stubEnv };
}

const baseTask = {
  id: "task-deep-1",
  title: "Deep work",
  context: "deep",
  priority: 80,
  duration_minutes: 90,
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

describe("POST /v1/resolve", () => {
  // Freeze the clock inside the fixed 2026-05-18 → 2026-05-25 resolve window
  // these tests use. runResolve's fully-past-week guard short-circuits any week
  // whose windowEnd <= now; with the real clock past 2026-05-25 the solver path
  // would never run and the schedule/unsat assertions would fail.
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T00:00:00.000Z"));
    await env.DB.prepare("DELETE FROM tasks").run();
    await env.DB.prepare("DELETE FROM proposed_plans").run();
    await env.DB.prepare("DELETE FROM config_weights").run();
    await env.DB.prepare("DELETE FROM config_contexts").run();
    await env.DB.prepare("DELETE FROM oauth_tokens").run();
    await env.DB.prepare("DELETE FROM identity_tokens").run();
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
      .bind(baseTask.id, "primary", JSON.stringify(baseTask), baseTask.created_at, baseTask.updated_at)
      .run();
    await env.DB
      .prepare(
        "INSERT INTO identity_tokens (account_email, refresh_token_encrypted, scopes, updated_at) VALUES ('u@example.com', X'00', 'calendar.events gmail.send', '2026-05-17T00:00:00Z')",
      )
      .run();
    await seedBearer("fake");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("happy path: persists proposed_plan and returns schedule + plan_hash", async () => {
    const cal = new MockCalendarProvider();
    const notify = new MockNotificationProvider();
    const { app, stubEnv } = makeApp({ calendar: cal, notify }, async (req) => {
      expect(new URL(req.url).pathname).toBe("/solve");
      const body = (await req.json()) as { tasks: unknown[]; window: { start: string } };
      expect(body.tasks).toHaveLength(1);
      return new Response(
        JSON.stringify({
          schedule: [
            {
              task_id: "task-deep-1",
              chunk_id: "task-deep-1#0",
              start: "2026-05-19T09:00:00",
              duration_minutes: 90,
              context: "deep",
            },
          ],
          dropped: [],
          objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } },
          diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const res = await app.request(
      "/v1/resolve",
      {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer fake" },
        body: JSON.stringify({
          window_start: "2026-05-18T00:00:00Z",
          window_end: "2026-05-25T00:00:00Z",
        }),
      },
      stubEnv,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      plan_hash: string;
      schedule: unknown[];
      dropped: unknown[];
    };
    expect(json.schedule).toHaveLength(1);
    expect(json.dropped).toEqual([]);
    expect(json.plan_hash).toMatch(/^[0-9a-f]{64}$/);

    const row = await env.DB.prepare("SELECT body FROM proposed_plans WHERE plan_hash = ?")
      .bind(json.plan_hash)
      .first<{ body: string }>();
    expect(row).not.toBeNull();
  });

  it("returns 500 internal_error when the solver returns an unparseable 200", async () => {
    const cal = new MockCalendarProvider();
    const notify = new MockNotificationProvider();
    const { app, stubEnv } = makeApp(
      { calendar: cal, notify },
      async () =>
        new Response(JSON.stringify({ not: "a valid solution" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const res = await app.request(
      "/v1/resolve",
      {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer fake" },
        body: JSON.stringify({
          window_start: "2026-05-18T00:00:00Z",
          window_end: "2026-05-25T00:00:00Z",
        }),
      },
      stubEnv,
    );

    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: string; detail: string };
    expect(json.error).toBe("internal_error");
    expect(typeof json.detail).toBe("string");
    expect(json.detail.length).toBeGreaterThan(0);
  });

  it("returns 422 with unsat_core when solver returns 422", async () => {
    const cal = new MockCalendarProvider();
    const notify = new MockNotificationProvider();
    const { app, stubEnv } = makeApp(
      { calendar: cal, notify },
      async () =>
        new Response(
          JSON.stringify({
            unsat_core: [{ type: "pinned_at", task_id: "u1", value: "2026-05-19T11:00:00Z" }],
          }),
          { status: 422, headers: { "content-type": "application/json" } },
        ),
    );

    const res = await app.request(
      "/v1/resolve",
      {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer fake" },
        body: JSON.stringify({
          window_start: "2026-05-18T00:00:00Z",
          window_end: "2026-05-25T00:00:00Z",
        }),
      },
      stubEnv,
    );
    expect(res.status).toBe(422);
    const json = (await res.json()) as { unsat_core: unknown[] };
    expect(json.unsat_core).toHaveLength(1);
  });

  it("passes external (non-scheduler-owned) events to solver as external_pinned", async () => {
    const cal = new MockCalendarProvider({
      events: [
        {
          id: "g1",
          summary: "Client meeting",
          start: "2026-05-19T11:00:00Z",
          end: "2026-05-19T12:00:00Z",
          extendedProperties: {},
        },
      ],
    });
    const notify = new MockNotificationProvider();
    let sawExternalPinned: unknown[] = [];
    const { app, stubEnv } = makeApp({ calendar: cal, notify }, async (req) => {
      const body = (await req.json()) as { external_pinned: unknown[] };
      sawExternalPinned = body.external_pinned;
      return new Response(
        JSON.stringify({ schedule: [], dropped: [], objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } }, diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const res = await app.request(
      "/v1/resolve",
      {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer fake" },
        body: JSON.stringify({
          window_start: "2026-05-18T00:00:00Z",
          window_end: "2026-05-25T00:00:00Z",
        }),
      },
      stubEnv,
    );
    expect(res.status).toBe(200);
    expect(sawExternalPinned).toHaveLength(1);
    expect(sawExternalPinned[0]).toMatchObject({
      id: expect.any(String),
      title: "Client meeting",
      start: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/),
      duration_minutes: expect.any(Number),
      context: "meeting",
    });
  });

  it("ignores the request body account_email for ownership (uses the token subject)", async () => {
    // A task owned by owner-b, plus a request that spoofs account_email: "owner-b".
    // The token subject is "primary", so the resolve must see ZERO tasks (primary
    // owns none) — never b's.
    await env.DB.prepare("DELETE FROM tasks").run();
    await env.DB.prepare("INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)")
      .bind("b1", "owner-b", JSON.stringify({ id: "b1", title: "B task", context: "deep", priority: 80, duration_minutes: 90, earliest_start: "2026-05-18T00:00:00Z" }), "2026-05-17T00:00:00Z", "2026-05-17T00:00:00Z").run();

    let capturedIds: string[] = [];
    const stubSolver: Fetcher = {
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(init!.body as string) as { tasks: Array<{ id: string }> };
        capturedIds = body.tasks.map((t) => t.id);
        return new Response(JSON.stringify({ schedule: [], dropped: [], objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } }, diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" } }), { status: 200, headers: { "content-type": "application/json" } });
      },
    } as unknown as Fetcher;

    const cal = new MockCalendarProvider();
    const notify = new MockNotificationProvider();
    const solverFetcher: Fetcher = stubSolver;
    const v1 = new OpenAPIHono<{ Bindings: Env; Variables: Vars }>();
    v1.use("*", async (c, next) => {
      c.set("calendarProvider", cal);
      c.set("notificationProvider", notify);
      await next();
    });
    mountResolveRoute(v1);
    const app = new Hono<{ Bindings: Env; Variables: Vars }>();
    app.route("/v1", v1);
    const stubEnv = { ...env, SOLVER: solverFetcher };

    const res = await app.request(
      "/v1/resolve",
      {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer fake" },
        body: JSON.stringify({ window_start: "2026-05-18T00:00:00Z", window_end: "2026-05-25T00:00:00Z", account_email: "owner-b" }),
      },
      stubEnv,
    );
    expect(res.status).toBe(200);
    expect(capturedIds).toEqual([]);
  });

  it("surfaces dropped[] with per-task drop reason", async () => {
    const cal = new MockCalendarProvider();
    const notify = new MockNotificationProvider();
    const { app, stubEnv } = makeApp(
      { calendar: cal, notify },
      async () =>
        new Response(
          JSON.stringify({
            schedule: [],
            dropped: [
              {
                task_id: "task-deep-1",
                title: "Deep work",
                drop_cost: 280,
                reason: "drop_was_cheaper_than_alternatives",
                contributing_constraints: ["soft_deadline", "preferred_window"],
              },
            ],
            objective: { total: 280, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 280 } },
            diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const res = await app.request(
      "/v1/resolve",
      {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer fake" },
        body: JSON.stringify({
          window_start: "2026-05-18T00:00:00Z",
          window_end: "2026-05-25T00:00:00Z",
        }),
      },
      stubEnv,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { dropped: Array<{ contributing_constraints: string[] }> };
    expect(json.dropped[0]!.contributing_constraints).toContain("soft_deadline");
  });
});

describe("POST /v1/resolve runs the recurrence sweep first", () => {
  // Freeze the clock inside the fixed 2026-05-18 → 2026-05-25 resolve window so
  // the fully-past-week guard does not short-circuit the solver path (see above).
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T00:00:00.000Z"));
    await env.DB.prepare("DELETE FROM tasks").run();
    await env.DB.prepare("DELETE FROM task_templates").run();
    await env.DB.prepare("DELETE FROM proposed_plans").run();
    await env.DB.prepare("DELETE FROM config_weights").run();
    await env.DB.prepare("DELETE FROM config_contexts").run();
    await env.DB.prepare("DELETE FROM oauth_tokens").run();
    await env.DB.prepare("DELETE FROM identity_tokens").run();
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
        "physical",
        JSON.stringify({
          context: "physical",
          fit_curve: { peak_start: "16:00", peak_end: "16:00", falloff_end: "20:00" },
          max_minutes_per_day: null,
          max_contiguous_minutes: null,
          over_daily_cap_penalty_per_15min: 25,
          over_streak_cap_penalty_per_15min: 25,
        }),
      )
      .run();
    await seedMissingDefaultContexts();
    await env.DB
      .prepare(
        "INSERT INTO identity_tokens (account_email, refresh_token_encrypted, scopes, updated_at) VALUES ('u@example.com', X'00', 'calendar.events gmail.send', '2026-05-17T00:00:00Z')",
      )
      .run();

    await env.DB
      .prepare("INSERT INTO task_templates (id, owner_subject, body, active_from, active_until) VALUES (?, ?, ?, ?, NULL)")
      .bind(
        "tpl-pilates",
        "primary",
        JSON.stringify({
          title: "Pilates",
          context: "physical",
          rrule: "FREQ=WEEKLY;BYDAY=FR",
          pinned_time: "19:00",
          duration_minutes: 90,
          active_from: "2026-01-01",
        }),
        "2026-01-01",
      )
      .run();

    await seedBearer("fake");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("materialises template instances and passes them to the solver", async () => {
    let solverSawTasks: Array<{ id: string }> = [];
    const cal = new MockCalendarProvider();
    const notify = new MockNotificationProvider();
    const { app, stubEnv } = makeApp({ calendar: cal, notify }, async (req) => {
      const body = (await req.json()) as { tasks: Array<{ id: string }> };
      solverSawTasks = body.tasks;
      return new Response(
        JSON.stringify({ schedule: [], dropped: [], objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } }, diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const res = await app.request(
      "/v1/resolve",
      {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer fake" },
        body: JSON.stringify({
          window_start: "2026-05-18T00:00:00Z",
          window_end: "2026-05-25T00:00:00Z",
        }),
      },
      stubEnv,
    );

    expect(res.status).toBe(200);
    expect(solverSawTasks).toHaveLength(1);

    const persistedCount = await env.DB
      .prepare("SELECT COUNT(*) AS c FROM tasks WHERE template_id = 'tpl-pilates'")
      .first<{ c: number }>();
    expect(persistedCount?.c).toBe(1);
  });
});
