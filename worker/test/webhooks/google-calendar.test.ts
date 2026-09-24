import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { runInDurableObject } from "cloudflare:test";
import { Hono } from "hono";
import { OpenAPIHono } from "@hono/zod-openapi";
import { mountGoogleCalendarWebhookRoute } from "../../src/webhooks/google-calendar";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { MockNotificationProvider } from "../../src/providers/mock-notification-provider";
import { __setReplanRunnerForTests } from "../../src/durable-objects/resolve-coordinator";
import type { CalendarProvider } from "../../src/providers/calendar-provider";
import type { NotificationProvider } from "../../src/providers/notification-provider";
import { seedMissingDefaultContexts } from "../fixtures/seed-contexts";

function makeApp(cal: MockCalendarProvider, notify: MockNotificationProvider, solver: Fetcher) {
  const v1 = new OpenAPIHono<{ Bindings: typeof env; Variables: { calendarProvider: CalendarProvider; notificationProvider: NotificationProvider } }>();
  v1.use("*", async (c, next) => {
    c.set("calendarProvider", cal);
    c.set("notificationProvider", notify);
    await next();
  });
  mountGoogleCalendarWebhookRoute(v1, { accountEmail: "primary" });
  void solver;
  const app = new Hono<{ Bindings: typeof env; Variables: { calendarProvider: CalendarProvider; notificationProvider: NotificationProvider } }>();
  app.route("/v1", v1);
  return app;
}

const stubOkSolver = { fetch: async () => new Response(JSON.stringify({ schedule: [{ task_id: "t1", chunk_id: "t1#0", start: "2026-05-19T09:00:00", duration_minutes: 90, context: "deep" }], dropped: [], objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } }, diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" } }), { status: 200, headers: { "content-type": "application/json" } }) } as unknown as Fetcher;

describe("POST /v1/webhook/google-calendar", () => {
  beforeEach(async () => {
    __setReplanRunnerForTests(async () => {});
    await env.DB.prepare("DELETE FROM calendar_sync").run();
    await env.DB.prepare("DELETE FROM tasks").run();
    await env.DB.prepare("DELETE FROM proposed_plans").run();
    await env.DB.prepare("DELETE FROM config_weights").run();
    await env.DB.prepare("DELETE FROM config_contexts").run();
    await env.DB.prepare("INSERT INTO config_weights (owner_subject, body) VALUES ('__default__', ?)").bind(JSON.stringify({ time_of_day_fit_per_15min: 5, churn_per_15min_moved: 10, priority_unit: 1, base_drop_penalty: 200 })).run();
    await env.DB.prepare("INSERT INTO config_contexts (owner_subject, context, body) VALUES ('__default__', ?, ?)").bind("deep", JSON.stringify({ context: "deep", fit_curve: { peak_start: "09:00", peak_end: "12:00", falloff_end: "16:00" }, max_minutes_per_day: 240, max_contiguous_minutes: 90, over_daily_cap_penalty_per_15min: 25, over_streak_cap_penalty_per_15min: 25 })).run();
    await seedMissingDefaultContexts();
    await env.DB.prepare("INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)")
      .bind("t1", "primary", JSON.stringify({ id: "t1", title: "Deep work", context: "deep", priority: 80, duration_minutes: 90 }), "2026-05-17T00:00:00Z", "2026-05-17T00:00:00Z").run();
    await env.DB.prepare("INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url) VALUES ('primary', 'primary', 'tok-old', 'ch-1', 'shared-secret', '2099-01-01T00:00:00Z', 'res-1', 'https://x/v1/webhook/google-calendar')").run();
  });

  afterEach(async () => {
    __setReplanRunnerForTests(null);
    // The delegation test arms a real alarm on the "primary" coordinator. Clear
    // its storage so a leftover pending alarm can't race the vitest-pool-workers
    // isolated-storage snapshot at teardown (the "Isolated storage failed" flake).
    const stub = env.RESOLVE_COORDINATOR.get(env.RESOLVE_COORDINATOR.idFromName("primary"));
    await runInDurableObject(stub, async (_inst, state) => {
      await state.storage.deleteAlarm();
      await state.storage.deleteAll();
    });
  });

  it("401 when X-Goog-Channel-Token mismatches", async () => {
    const app = makeApp(new MockCalendarProvider(), new MockNotificationProvider(), stubOkSolver);
    const res = await app.request("/v1/webhook/google-calendar", { method: "POST", headers: { "X-Goog-Channel-Id": "ch-1", "X-Goog-Channel-Token": "wrong", "X-Goog-Resource-State": "exists" } }, { ...env, SOLVER: stubOkSolver, OAUTH_ISSUER: "https://scheduler.example.com" });
    expect(res.status).toBe(401);
  });

  it("200 + no replan on 'sync' bootstrap message", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(new MockCalendarProvider(), notify, stubOkSolver);
    const res = await app.request("/v1/webhook/google-calendar", { method: "POST", headers: { "X-Goog-Channel-Id": "ch-1", "X-Goog-Channel-Token": "shared-secret", "X-Goog-Resource-State": "sync" } }, { ...env, SOLVER: stubOkSolver, OAUTH_ISSUER: "https://scheduler.example.com" });
    expect(res.status).toBe(200);
    expect(notify.sent).toHaveLength(0);
  });

  it("delegates to the coordinator and returns queued without resolving inline", async () => {
    const notify = new MockNotificationProvider();
    const app = makeApp(new MockCalendarProvider(), notify, stubOkSolver);
    const res = await app.request(
      "/v1/webhook/google-calendar",
      { method: "POST", headers: { "X-Goog-Channel-Id": "ch-1", "X-Goog-Channel-Token": "shared-secret", "X-Goog-Resource-State": "exists" } },
      { ...env, SOLVER: stubOkSolver, OAUTH_ISSUER: "https://scheduler.example.com" },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, queued: true });
    // No synchronous resolve happened.
    expect(notify.sent).toHaveLength(0);
    // An alarm was scheduled on the per-account coordinator.
    const id = env.RESOLVE_COORDINATOR.idFromName("primary");
    const stub = env.RESOLVE_COORDINATOR.get(id);
    const alarmAt = await runInDurableObject(stub, (_inst, state) => state.storage.getAlarm());
    expect(alarmAt).not.toBeNull();
  });

  it("401 (not a 500) when X-Goog-Channel-Token header is missing entirely", async () => {
    const app = makeApp(new MockCalendarProvider(), new MockNotificationProvider(), stubOkSolver);
    const res = await app.request(
      "/v1/webhook/google-calendar",
      { method: "POST", headers: { "X-Goog-Channel-Id": "ch-1", "X-Goog-Resource-State": "exists" } },
      { ...env, SOLVER: stubOkSolver, OAUTH_ISSUER: "https://scheduler.example.com" },
    );
    expect(res.status).toBe(401);
  });

  it("404 when the channel id is unknown", async () => {
    const app = makeApp(new MockCalendarProvider(), new MockNotificationProvider(), stubOkSolver);
    const res = await app.request(
      "/v1/webhook/google-calendar",
      { method: "POST", headers: { "X-Goog-Channel-Id": "ch-unknown", "X-Goog-Channel-Token": "shared-secret", "X-Goog-Resource-State": "exists" } },
      { ...env, SOLVER: stubOkSolver, OAUTH_ISSUER: "https://scheduler.example.com" },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "unknown_channel" });
  });
});
