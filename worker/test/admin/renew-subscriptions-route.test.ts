import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import type { Env } from "../../src/env";
import type { AppVariables } from "../../src/index-providers";
import { mountRenewSubscriptionsRoute } from "../../src/admin/renew-subscriptions-route";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { hashToken } from "../../src/auth/tokens";
import { hashingKey } from "../../src/auth/crypto-keys";
import { upsertUser } from "../../src/db/users";
import { getCalendarSync } from "../../src/db/calendar-sync";

function makeApp(calendar?: MockCalendarProvider) {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  if (calendar) {
    app.use("*", async (c, next) => {
      c.set("calendarProvider", calendar);
      await next();
    });
  }
  mountRenewSubscriptionsRoute(app);
  return app;
}

async function seedAdminBearer(token: string, subject: string) {
  const h = await hashToken(token, hashingKey(env));
  await env.DB.prepare(`INSERT OR REPLACE INTO oauth_clients (id,name,type,redirect_uris,allowed_scopes,created_at) VALUES ('c','t','pkce',NULL,'scheduler:read scheduler:write admin','2026-01-01')`).run();
  await env.DB.prepare(`INSERT OR REPLACE INTO oauth_tokens (hashed_token,client_id,scopes,expires_at,refresh_of,revoked_at,subject) VALUES (?,?,?,?,?,?,?)`)
    .bind(h, "c", "scheduler:read scheduler:write admin", "2099-01-01T00:00:00Z", null, null, subject).run();
}

async function seedExpiredChannel(owner: string) {
  const expired = new Date(Date.now() - 3600 * 1000).toISOString();
  await env.DB.prepare(
    "INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url) VALUES (?, 'primary', 'tok', ?, 'secret', ?, ?, 'https://x/v1/webhook/google-calendar')",
  )
    .bind(owner, `ch-${owner}`, expired, `res-${owner}`)
    .run();
}

describe("POST /admin/renew-subscriptions", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM calendar_sync").run();
    for (const t of ["oauth_tokens", "oauth_clients", "users"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  });

  it("401 without bearer", async () => {
    const res = await makeApp().request("/admin/renew-subscriptions", { method: "POST" }, env);
    expect(res.status).toBe(401);
  });

  it("renews expired channels across all owners and reports counts", async () => {
    await upsertUser(env.DB, "operator@org", "admin");
    await seedAdminBearer("tok", "operator@org");
    await seedExpiredChannel("a@org");
    await seedExpiredChannel("b@org");

    const res = await makeApp(new MockCalendarProvider()).request(
      "/admin/renew-subscriptions",
      { method: "POST", headers: { Authorization: "Bearer tok" } },
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, checked: 2, renewed: 2, failed: 0 });
    expect((await getCalendarSync(env.DB, "a@org", "primary"))?.channel_id).not.toBe("ch-a@org");
    expect((await getCalendarSync(env.DB, "b@org", "primary"))?.channel_id).not.toBe("ch-b@org");
  });

  it("500 with counts when a renewal fails", async () => {
    await upsertUser(env.DB, "operator@org", "admin");
    await seedAdminBearer("tok", "operator@org");
    await seedExpiredChannel("a@org");
    const cal = new MockCalendarProvider();
    cal.subscribeToChanges = async () => {
      throw new Error("google 500");
    };

    const res = await makeApp(cal).request(
      "/admin/renew-subscriptions",
      { method: "POST", headers: { Authorization: "Bearer tok" } },
      env,
    );

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, checked: 1, renewed: 0, failed: 1 });
  });
});
