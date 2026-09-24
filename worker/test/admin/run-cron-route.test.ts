import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import type { Env } from "../../src/env";
import type { AppVariables } from "../../src/index-providers";
import { mountRunCronRoute } from "../../src/admin/run-cron-route";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { MockNotificationProvider } from "../../src/providers/mock-notification-provider";
import { hashToken } from "../../src/auth/tokens";
import { hashingKey } from "../../src/auth/crypto-keys";
import { upsertUser } from "../../src/db/users";
import * as mondayResolve from "../../src/cron/monday-resolve";
import { storeIdentityTokens } from "../../src/auth/identity-store";
import { MicrosoftCalendarProvider } from "../../src/providers/microsoft-calendar-provider";
import { MicrosoftGraphNotificationProvider } from "../../src/providers/microsoft-graph-notification-provider";

function makeApp() {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("calendarProvider", new MockCalendarProvider());
    c.set("notificationProvider", new MockNotificationProvider());
    await next();
  });
  mountRunCronRoute(app);
  return app;
}

// No c.var.*Provider injection — exercises the real defaultProviders path.
function makeAppReal() {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  mountRunCronRoute(app);
  return app;
}

async function seedAdminBearer(token: string, subject: string) {
  const h = await hashToken(token, hashingKey(env));
  await env.DB.prepare(`INSERT OR REPLACE INTO oauth_clients (id,name,type,redirect_uris,allowed_scopes,created_at) VALUES ('c','t','pkce',NULL,'scheduler:read scheduler:write admin','2026-01-01')`).run();
  await env.DB.prepare(`INSERT OR REPLACE INTO oauth_tokens (hashed_token,client_id,scopes,expires_at,refresh_of,revoked_at,subject) VALUES (?,?,?,?,?,?,?)`)
    .bind(h, "c", "scheduler:read scheduler:write admin", "2099-01-01T00:00:00Z", null, null, subject).run();
}

describe("POST /admin/run-cron", () => {
  beforeEach(async () => {
    for (const t of ["oauth_tokens", "oauth_clients", "users"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("401 without bearer", async () => {
    const res = await makeApp().request("/admin/run-cron", { method: "POST" }, env);
    expect(res.status).toBe(401);
  });

  it("403 insufficient_scope for an admin bearer without the admin scope", async () => {
    await upsertUser(env.DB, "owner@example.com", "admin");
    const h = await hashToken("tok", hashingKey(env));
    await env.DB.prepare(`INSERT OR REPLACE INTO oauth_clients (id,name,type,redirect_uris,allowed_scopes,created_at) VALUES ('c','t','pkce',NULL,'scheduler:read scheduler:write admin','2026-01-01')`).run();
    await env.DB.prepare(`INSERT OR REPLACE INTO oauth_tokens (hashed_token,client_id,scopes,expires_at,refresh_of,revoked_at,subject) VALUES (?,?,?,?,?,?,?)`)
      .bind(h, "c", "scheduler:read scheduler:write", "2099-01-01T00:00:00Z", null, null, "owner@example.com").run();
    const res = await makeApp().request("/admin/run-cron?subject=target@example.com",
      { method: "POST", headers: { Authorization: "Bearer tok" } }, env);
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe("insufficient_scope");
  });

  it("invokes runMondayResolve for the named subject and returns its result", async () => {
    await upsertUser(env.DB, "owner@example.com", "admin");
    await seedAdminBearer("tok", "owner@example.com");
    const spy = vi
      .spyOn(mondayResolve, "runMondayResolve")
      .mockResolvedValue({ kind: "ok", planHash: "abc123" });

    const res = await makeApp().request(
      "/admin/run-cron?subject=target@example.com",
      { method: "POST", headers: { Authorization: "Bearer tok" } },
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: "ok", planHash: "abc123" });
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]![0]).toMatchObject({ accountEmail: "target@example.com" });
  });

  it("400 when ?subject= is missing", async () => {
    await upsertUser(env.DB, "owner@example.com", "admin");
    await seedAdminBearer("tok", "owner@example.com");
    const res = await makeApp().request(
      "/admin/run-cron",
      { method: "POST", headers: { Authorization: "Bearer tok" } },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("returns 500 with body when runMondayResolve reports solver_error", async () => {
    await upsertUser(env.DB, "owner@example.com", "admin");
    await seedAdminBearer("tok", "owner@example.com");
    vi.spyOn(mondayResolve, "runMondayResolve").mockResolvedValue({
      kind: "solver_error",
      status: 502,
    });

    const res = await makeApp().request(
      "/admin/run-cron?subject=target@example.com",
      {
        method: "POST",
        headers: { Authorization: "Bearer tok" },
      },
      env,
    );

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ kind: "solver_error", status: 502 });
  });

  it("resolves a microsoft target subject to Microsoft providers on the real (non-injected) wiring path", async () => {
    const msEnv = { ...env, MS_PROVIDER_ENABLED: "true", MICROSOFT_OAUTH_CLIENT_ID: "x", MICROSOFT_OAUTH_CLIENT_SECRET: "y" };
    await upsertUser(env.DB, "owner@example.com", "admin");
    await seedAdminBearer("tok", "owner@example.com");
    await storeIdentityTokens(
      msEnv,
      "ms-target@example.com",
      { refreshToken: "r", accessToken: "a", expiresIn: 3600, scope: "s" },
      "microsoft",
    );
    const spy = vi
      .spyOn(mondayResolve, "runMondayResolve")
      .mockResolvedValue({ kind: "ok", planHash: "abc123" });

    const res = await makeAppReal().request(
      "/admin/run-cron?subject=ms-target@example.com",
      { method: "POST", headers: { Authorization: "Bearer tok" } },
      msEnv,
    );

    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledOnce();
    const call = spy.mock.calls[0]![0];
    expect(call.calendar).toBeInstanceOf(MicrosoftCalendarProvider);
    expect(call.notification).toBeInstanceOf(MicrosoftGraphNotificationProvider);
  });
});
