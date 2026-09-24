import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { OpenAPIHono } from "@hono/zod-openapi";
import { mountMicrosoftCalendarWebhookRoute } from "../../src/webhooks/microsoft-calendar";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { getCalendarSync } from "../../src/db/calendar-sync";
import type { CalendarProvider } from "../../src/providers/calendar-provider";
import type { NotificationProvider } from "../../src/providers/notification-provider";

type TestEnv = typeof env;
type Vars = { calendarProvider: CalendarProvider; notificationProvider: NotificationProvider };

function makeApp(cal?: MockCalendarProvider) {
  const v1 = new OpenAPIHono<{ Bindings: TestEnv; Variables: Vars }>();
  if (cal) {
    v1.use("*", async (c, next) => {
      c.set("calendarProvider", cal);
      await next();
    });
  }
  mountMicrosoftCalendarWebhookRoute(v1, {});
  const app = new Hono<{ Bindings: TestEnv; Variables: Vars }>();
  app.route("/v1", v1);
  return app;
}

/** A RESOLVE_COORDINATOR stand-in that counts notifyChange invocations per
 *  owner, rather than relying on the real DO's debounced-alarm semantics
 *  (which cannot distinguish one call from two — both just leave an alarm
 *  set). Lets the batch-dedupe test assert an exact call count. */
function fakeCoordinator() {
  const calls: string[] = [];
  const notifyChange = vi.fn(async (owner: string) => {
    calls.push(owner);
  });
  const namespace = {
    idFromName: (name: string) => name,
    get: () => ({ notifyChange }),
  } as unknown as TestEnv["RESOLVE_COORDINATOR"];
  return { namespace, notifyChange, calls };
}

/** Wraps env.DB, counting calls to prepare() whose SQL is the
 *  getCalendarSyncByChannelId lookup (WHERE channel_id = ?) so a test can
 *  assert N notifications sharing one subscriptionId cause exactly one DB
 *  lookup, not N. */
function countingChannelLookupDB(realDb: TestEnv["DB"]) {
  const state = { count: 0 };
  const proxy = {
    prepare(sql: string) {
      if (sql.includes("WHERE channel_id = ?")) state.count += 1;
      return realDb.prepare(sql);
    },
  } as unknown as TestEnv["DB"];
  return { proxy, state };
}

/** Minimal ExecutionContext stand-in: waitUntil just collects the promise
 *  (fire-and-forget, like the real one) instead of awaiting it inline —
 *  lets a test observe that the HTTP response resolves before deferred work
 *  does, then drain that work afterwards. */
function fakeExecutionCtx() {
  const tasks: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      tasks.push(p);
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  return { ctx, drain: () => Promise.all(tasks) };
}

describe("POST /v1/webhook/microsoft-calendar", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM calendar_sync").run();
  });

  it("200 text/plain echoes the URL-decoded validationToken", async () => {
    const app = makeApp();
    const res = await app.request(
      "/v1/webhook/microsoft-calendar?validationToken=abc%20def",
      { method: "POST" },
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
    expect(await res.text()).toBe("abc def");
  });

  it("202 (not 500) for a body that is JSON null", async () => {
    const { namespace, notifyChange } = fakeCoordinator();
    const app = makeApp();
    const res = await app.request(
      "/v1/webhook/microsoft-calendar",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "null",
      },
      { ...env, RESOLVE_COORDINATOR: namespace },
    );
    expect(res.status).toBe(202);
    expect(notifyChange).not.toHaveBeenCalled();
  });

  it("202 and skips (no error, no notify) a notification whose clientState is JSON null", async () => {
    await env.DB.prepare(
      "INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url) VALUES ('primary', 'primary', 'tok', 'sub-1', 'right', '2099-01-01T00:00:00Z', 'res-1', 'https://x/v1/webhook/microsoft-calendar')",
    ).run();
    const { namespace, notifyChange } = fakeCoordinator();
    const app = makeApp();
    const res = await app.request(
      "/v1/webhook/microsoft-calendar",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          value: [{ subscriptionId: "sub-1", changeType: "updated", clientState: null, resourceData: { id: "e1" } }],
        }),
      },
      { ...env, RESOLVE_COORDINATOR: namespace },
    );
    expect(res.status).toBe(202);
    expect(notifyChange).not.toHaveBeenCalled();
  });

  it("202 and no DO notify when clientState mismatches", async () => {
    await env.DB.prepare(
      "INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url) VALUES ('primary', 'primary', 'tok', 'sub-1', 'right', '2099-01-01T00:00:00Z', 'res-1', 'https://x/v1/webhook/microsoft-calendar')",
    ).run();
    const { namespace, notifyChange } = fakeCoordinator();
    const app = makeApp();
    const res = await app.request(
      "/v1/webhook/microsoft-calendar",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          value: [{ subscriptionId: "sub-1", changeType: "updated", clientState: "wrong", resourceData: { id: "e1" } }],
        }),
      },
      { ...env, RESOLVE_COORDINATOR: namespace },
    );
    expect(res.status).toBe(202);
    expect(notifyChange).not.toHaveBeenCalled();
  });

  it("202 and RESOLVE_COORDINATOR.notifyChange called once on matching clientState", async () => {
    await env.DB.prepare(
      "INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url) VALUES ('primary', 'primary', 'tok', 'sub-1', 'right', '2099-01-01T00:00:00Z', 'res-1', 'https://x/v1/webhook/microsoft-calendar')",
    ).run();
    const { namespace, notifyChange } = fakeCoordinator();
    const app = makeApp();
    const res = await app.request(
      "/v1/webhook/microsoft-calendar",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          value: [{ subscriptionId: "sub-1", changeType: "updated", clientState: "right", resourceData: { id: "e1" } }],
        }),
      },
      { ...env, RESOLVE_COORDINATOR: namespace },
    );
    expect(res.status).toBe(202);
    expect(notifyChange).toHaveBeenCalledTimes(1);
    expect(notifyChange).toHaveBeenCalledWith("primary");
  });

  it("dedupes two notifications for the same subscription into one notifyChange call", async () => {
    await env.DB.prepare(
      "INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url) VALUES ('primary', 'primary', 'tok', 'sub-1', 'right', '2099-01-01T00:00:00Z', 'res-1', 'https://x/v1/webhook/microsoft-calendar')",
    ).run();
    const { namespace, notifyChange } = fakeCoordinator();
    const app = makeApp();
    const res = await app.request(
      "/v1/webhook/microsoft-calendar",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          value: [
            { subscriptionId: "sub-1", changeType: "updated", clientState: "right", resourceData: { id: "e1" } },
            { subscriptionId: "sub-1", changeType: "updated", clientState: "right", resourceData: { id: "e2" } },
          ],
        }),
      },
      { ...env, RESOLVE_COORDINATOR: namespace },
    );
    expect(res.status).toBe(202);
    expect(notifyChange).toHaveBeenCalledTimes(1);
  });

  it("N notifications sharing one subscriptionId cause exactly one getCalendarSyncByChannelId DB lookup", async () => {
    await env.DB.prepare(
      "INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url) VALUES ('primary', 'primary', 'tok', 'sub-1', 'right', '2099-01-01T00:00:00Z', 'res-1', 'https://x/v1/webhook/microsoft-calendar')",
    ).run();
    const { namespace } = fakeCoordinator();
    const { proxy, state } = countingChannelLookupDB(env.DB);
    const app = makeApp();
    const res = await app.request(
      "/v1/webhook/microsoft-calendar",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          value: [
            { subscriptionId: "sub-1", changeType: "updated", clientState: "right", resourceData: { id: "e1" } },
            { subscriptionId: "sub-1", changeType: "updated", clientState: "right", resourceData: { id: "e2" } },
            { subscriptionId: "sub-1", changeType: "updated", clientState: "right", resourceData: { id: "e3" } },
          ],
        }),
      },
      { ...env, DB: proxy, RESOLVE_COORDINATOR: namespace },
    );
    expect(res.status).toBe(202);
    expect(state.count).toBe(1);
  });

  it("returns 202 before a slow notifyChange resolves (fanned into the same waitUntil as lifecycle work)", async () => {
    await env.DB.prepare(
      "INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url) VALUES ('primary', 'primary', 'tok', 'sub-1', 'right', '2099-01-01T00:00:00Z', 'res-1', 'https://x/v1/webhook/microsoft-calendar')",
    ).run();
    let notifyResolved = false;
    let resolveNotify!: () => void;
    const notifyChange = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveNotify = () => {
            notifyResolved = true;
            resolve();
          };
        }),
    );
    const namespace = {
      idFromName: (name: string) => name,
      get: () => ({ notifyChange }),
    } as unknown as TestEnv["RESOLVE_COORDINATOR"];
    const { ctx, drain } = fakeExecutionCtx();
    const app = makeApp();

    const res = await app.request(
      "/v1/webhook/microsoft-calendar",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          value: [{ subscriptionId: "sub-1", changeType: "updated", clientState: "right", resourceData: { id: "e1" } }],
        }),
      },
      { ...env, RESOLVE_COORDINATOR: namespace },
      ctx,
    );

    expect(res.status).toBe(202);
    // The response resolved WITHOUT notifyChange having resolved yet.
    expect(notifyResolved).toBe(false);

    resolveNotify();
    await drain();
    expect(notifyChange).toHaveBeenCalledTimes(1);
  });

  it("a rejecting notifyChange for one owner does not abort the deferred work: other owners still get notified and the lifecycle re-ensure still runs", async () => {
    await env.DB.prepare(
      "INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url) VALUES ('owner-a', 'primary', 'tok', 'sub-a', 'right-a', '2099-01-01T00:00:00Z', 'res-1', 'https://x/v1/webhook/microsoft-calendar')",
    ).run();
    await env.DB.prepare(
      "INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url) VALUES ('owner-b', 'primary', 'tok', 'sub-b', 'right-b', '2099-01-01T00:00:00Z', 'res-1', 'https://x/v1/webhook/microsoft-calendar')",
    ).run();
    await env.DB.prepare(
      "INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url) VALUES ('owner-c', 'primary', 'tok', 'sub-c', 'right-c', '2099-01-01T00:00:00Z', 'res-1', 'https://scheduler.test/v1/webhook/microsoft-calendar')",
    ).run();
    const calls: string[] = [];
    const notifyChange = vi.fn(async (owner: string) => {
      if (owner === "owner-a") throw new Error("DO RPC rejected");
      calls.push(owner);
    });
    const namespace = {
      idFromName: (name: string) => name,
      get: () => ({ notifyChange }),
    } as unknown as TestEnv["RESOLVE_COORDINATOR"];
    const cal = new MockCalendarProvider();
    const { ctx, drain } = fakeExecutionCtx();
    const app = makeApp(cal);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await app.request(
      "/v1/webhook/microsoft-calendar",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          value: [
            { subscriptionId: "sub-a", changeType: "updated", clientState: "right-a", resourceData: { id: "e1" } },
            { subscriptionId: "sub-b", changeType: "updated", clientState: "right-b", resourceData: { id: "e2" } },
            // A non-"missed" lifecycle event so owner-c lands ONLY in
            // lifecycleOwners, isolating the re-ensure from the notifyChange
            // fan-out for this assertion.
            { subscriptionId: "sub-c", lifecycleEvent: "reauthorizationRequired", clientState: "right-c" },
          ],
        }),
      },
      { ...env, RESOLVE_COORDINATOR: namespace },
      ctx,
    );

    expect(res.status).toBe(202);
    await drain();

    // owner-b still notified despite owner-a's rejection...
    expect(calls).toEqual(["owner-b"]);
    // ...and the lifecycle re-ensure for owner-c still ran.
    expect(cal.getSubscribeCallCount()).toBe(1);
    // owner-a's failure was logged, not silently swallowed.
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("notifyChange"),
      expect.objectContaining({ owner: "owner-a" }),
    );

    consoleError.mockRestore();
  });

  it("202 (not 500) when body.value is present but not an array", async () => {
    const { namespace, notifyChange } = fakeCoordinator();
    const app = makeApp();
    const res = await app.request(
      "/v1/webhook/microsoft-calendar",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "abc" }),
      },
      { ...env, RESOLVE_COORDINATOR: namespace },
    );
    expect(res.status).toBe(202);
    expect(notifyChange).not.toHaveBeenCalled();
  });

  it("skips a notification with an empty-string subscriptionId without querying the DB", async () => {
    const { namespace, notifyChange } = fakeCoordinator();
    const { proxy, state } = countingChannelLookupDB(env.DB);
    const app = makeApp();
    const res = await app.request(
      "/v1/webhook/microsoft-calendar",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          value: [{ subscriptionId: "", changeType: "updated", clientState: "right", resourceData: { id: "e1" } }],
        }),
      },
      { ...env, DB: proxy, RESOLVE_COORDINATOR: namespace },
    );
    expect(res.status).toBe(202);
    expect(state.count).toBe(0);
    expect(notifyChange).not.toHaveBeenCalled();
  });

  it("caps the distinct subscriptionId lookup set at 100 (unauthenticated route)", async () => {
    const { namespace, notifyChange } = fakeCoordinator();
    const { proxy, state } = countingChannelLookupDB(env.DB);
    const app = makeApp();
    const value = Array.from({ length: 150 }, (_, i) => ({
      subscriptionId: `sub-${i}`,
      changeType: "updated",
      clientState: "right",
      resourceData: { id: `e${i}` },
    }));
    const res = await app.request(
      "/v1/webhook/microsoft-calendar",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value }),
      },
      { ...env, DB: proxy, RESOLVE_COORDINATOR: namespace },
    );
    expect(res.status).toBe(202);
    expect(state.count).toBeLessThanOrEqual(100);
    expect(notifyChange).not.toHaveBeenCalled();
  });

  it("202 and no DO call for an unknown subscriptionId (doesn't leak validity)", async () => {
    const { namespace, notifyChange } = fakeCoordinator();
    const app = makeApp();
    const res = await app.request(
      "/v1/webhook/microsoft-calendar",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          value: [{ subscriptionId: "sub-unknown", changeType: "updated", clientState: "whatever", resourceData: { id: "e1" } }],
        }),
      },
      { ...env, RESOLVE_COORDINATOR: namespace },
    );
    expect(res.status).toBe(202);
    expect(notifyChange).not.toHaveBeenCalled();
  });

  it("lifecycle event re-ensures the subscription for the owner even when the row is fresh (force)", async () => {
    // Seeded FRESH (far from the 48h renewal threshold) AND with a
    // channel_callback_url matching what webhookCallbackUrl(env, "microsoft")
    // actually produces here (OAUTH_ISSUER="https://scheduler.test" in the
    // test env) — so the freshness gate is genuinely exercised, not
    // incidentally bypassed by a callback-url mismatch. This proves the
    // lifecycle branch passes force:true rather than relying on a stale
    // expiry or a mismatched callback to coincidentally trigger the rotate path.
    const farFuture = new Date(Date.now() + 6 * 24 * 3600 * 1000).toISOString();
    await env.DB.prepare(
      "INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url) VALUES ('primary', 'primary', 'tok', 'sub-1', 'right', ?, 'res-1', 'https://scheduler.test/v1/webhook/microsoft-calendar')",
    ).bind(farFuture).run();
    const cal = new MockCalendarProvider();
    const { namespace, notifyChange } = fakeCoordinator();
    const app = makeApp(cal);
    const res = await app.request(
      "/v1/webhook/microsoft-calendar",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          value: [{ subscriptionId: "sub-1", lifecycleEvent: "reauthorizationRequired", clientState: "right" }],
        }),
      },
      { ...env, RESOLVE_COORDINATOR: namespace },
    );
    expect(res.status).toBe(202);
    // A reauthorizationRequired lifecycle notification must not trigger a replan.
    expect(notifyChange).not.toHaveBeenCalled();
    expect(cal.getSubscribeCallCount()).toBe(1);
    const row = await getCalendarSync(env.DB, "primary", "primary");
    expect(row?.channel_id).not.toBe("sub-1");
  });

  it("a missed lifecycle event both re-ensures the subscription AND triggers a replan", async () => {
    const farFuture = new Date(Date.now() + 6 * 24 * 3600 * 1000).toISOString();
    await env.DB.prepare(
      "INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url) VALUES ('primary', 'primary', 'tok', 'sub-1', 'right', ?, 'res-1', 'https://scheduler.test/v1/webhook/microsoft-calendar')",
    ).bind(farFuture).run();
    const cal = new MockCalendarProvider();
    const { namespace, notifyChange } = fakeCoordinator();
    const app = makeApp(cal);
    const res = await app.request(
      "/v1/webhook/microsoft-calendar",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          value: [{ subscriptionId: "sub-1", lifecycleEvent: "missed", clientState: "right" }],
        }),
      },
      { ...env, RESOLVE_COORDINATOR: namespace },
    );
    expect(res.status).toBe(202);
    expect(notifyChange).toHaveBeenCalledTimes(1);
    expect(notifyChange).toHaveBeenCalledWith("primary");
    expect(cal.getSubscribeCallCount()).toBe(1);
  });
});
