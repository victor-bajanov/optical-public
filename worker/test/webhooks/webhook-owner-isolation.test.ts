import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { Hono } from "hono";
import { OpenAPIHono } from "@hono/zod-openapi";
import { mountGoogleCalendarWebhookRoute } from "../../src/webhooks/google-calendar";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { MockNotificationProvider } from "../../src/providers/mock-notification-provider";
import { __setReplanRunnerForTests } from "../../src/durable-objects/resolve-coordinator";
import type { CalendarProvider } from "../../src/providers/calendar-provider";
import type { NotificationProvider } from "../../src/providers/notification-provider";

const SUBJECT_A = "a@org";
const SUBJECT_B = "b@org";

type Vars = { calendarProvider: CalendarProvider; notificationProvider: NotificationProvider };

function makeApp() {
  const v1 = new OpenAPIHono<{ Bindings: typeof env; Variables: Vars }>();
  v1.use("*", async (c, next) => {
    c.set("calendarProvider", new MockCalendarProvider());
    c.set("notificationProvider", new MockNotificationProvider());
    await next();
  });
  // accountEmail is passed but the handler now routes by channel id; we keep it
  // to mirror the production mount.
  mountGoogleCalendarWebhookRoute(v1, { accountEmail: SUBJECT_A });
  const app = new Hono<{ Bindings: typeof env; Variables: Vars }>();
  app.route("/v1", v1);
  return app;
}

function post(app: ReturnType<typeof makeApp>, headers: Record<string, string>) {
  return app.request(
    "/v1/webhook/google-calendar",
    { method: "POST", headers },
    { ...env, OAUTH_ISSUER: "https://scheduler.example.com" },
  );
}

describe("webhook owner isolation", () => {
  beforeEach(async () => {
    __setReplanRunnerForTests(async () => {});
    await env.DB.prepare("DELETE FROM calendar_sync").run();
    // Two owners, distinct channels/tokens, same primary calendar.
    await env.DB
      .prepare(
        "INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url) VALUES (?, 'primary', NULL, 'ch-a', 'token-a', '2099-01-01T00:00:00Z', 'res-a', 'https://x/v1/webhook/google-calendar')",
      )
      .bind(SUBJECT_A)
      .run();
    await env.DB
      .prepare(
        "INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url) VALUES (?, 'primary', NULL, 'ch-b', 'token-b', '2099-01-01T00:00:00Z', 'res-b', 'https://x/v1/webhook/google-calendar')",
      )
      .bind(SUBJECT_B)
      .run();
  });

  afterEach(async () => {
    __setReplanRunnerForTests(null);
    // Clear any armed alarm/storage on both coordinators so a leftover alarm
    // can't race the isolated-storage snapshot at teardown.
    for (const subject of [SUBJECT_A, SUBJECT_B]) {
      const stub = env.RESOLVE_COORDINATOR.get(env.RESOLVE_COORDINATOR.idFromName(subject));
      await runInDurableObject(stub, async (_inst, state) => {
        await state.storage.deleteAlarm();
        await state.storage.deleteAll();
      });
    }
  });

  it("routes B's push to B's coordinator, never A's", async () => {
    const app = makeApp();
    const res = await post(app, {
      "X-Goog-Channel-Id": "ch-b",
      "X-Goog-Channel-Token": "token-b",
      "X-Goog-Resource-State": "exists",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, queued: true });

    // B's coordinator was notified (an alarm is armed); A's was not.
    const stubB = env.RESOLVE_COORDINATOR.get(env.RESOLVE_COORDINATOR.idFromName(SUBJECT_B));
    const alarmB = await runInDurableObject(stubB, (_i, s) => s.storage.getAlarm());
    expect(alarmB).not.toBeNull();
    const acctB = await runInDurableObject(stubB, (_i, s) => s.storage.get<string>("accountEmail"));
    expect(acctB).toBe(SUBJECT_B);

    const stubA = env.RESOLVE_COORDINATOR.get(env.RESOLVE_COORDINATOR.idFromName(SUBJECT_A));
    const alarmA = await runInDurableObject(stubA, (_i, s) => s.storage.getAlarm());
    expect(alarmA).toBeNull();
  });

  it("404s an unknown channel id", async () => {
    const app = makeApp();
    const res = await post(app, {
      "X-Goog-Channel-Id": "ch-nope",
      "X-Goog-Channel-Token": "token-b",
      "X-Goog-Resource-State": "exists",
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "unknown_channel" });
  });

  it("401s B's channel id presented with A's token", async () => {
    const app = makeApp();
    const res = await post(app, {
      "X-Goog-Channel-Id": "ch-b",
      "X-Goog-Channel-Token": "token-a",
      "X-Goog-Resource-State": "exists",
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "channel_token_mismatch" });

    // No coordinator was armed.
    for (const subject of [SUBJECT_A, SUBJECT_B]) {
      const stub = env.RESOLVE_COORDINATOR.get(env.RESOLVE_COORDINATOR.idFromName(subject));
      const alarm = await runInDurableObject(stub, (_i, s) => s.storage.getAlarm());
      expect(alarm).toBeNull();
    }
  });
});
