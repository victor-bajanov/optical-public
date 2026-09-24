import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { mountOffboardRoute } from "../../src/admin/offboard-route";
import { upsertUser, getUser } from "../../src/db/users";
import { hashToken } from "../../src/auth/tokens";
import { hashingKey } from "../../src/auth/crypto-keys";

async function seedBearer(token: string, subject: string, scopes: string) {
  const h = await hashToken(token, hashingKey(env));
  await env.DB.prepare(`INSERT OR REPLACE INTO oauth_clients (id,name,type,redirect_uris,allowed_scopes,created_at) VALUES ('c','t','pkce',NULL,'scheduler:read scheduler:write admin','2026-01-01')`).run();
  await env.DB.prepare(`INSERT OR REPLACE INTO oauth_tokens (hashed_token,client_id,scopes,expires_at,refresh_of,revoked_at,subject) VALUES (?,?,?,?,?,?,?)`)
    .bind(h, "c", scopes, "2099-01-01T00:00:00Z", null, null, subject).run();
}

function makeApp() {
  const app = new Hono();
  mountOffboardRoute(app as any);
  return app;
}

beforeEach(async () => {
  for (const t of ["users", "tasks", "task_templates", "projects", "proposed_plans", "identity_tokens", "oauth_tokens", "oauth_clients", "calendar_sync", "audit_log"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
});

describe("POST /admin/offboard", () => {
  it("lets an admin offboard a subject", async () => {
    await upsertUser(env.DB, "admin@org", "admin");
    await upsertUser(env.DB, "leaver@org");
    await seedBearer("tok", "admin@org", "scheduler:read scheduler:write admin");
    const res = await makeApp().request("/admin/offboard",
      { method: "POST", headers: { Authorization: "Bearer tok", "content-type": "application/json" }, body: JSON.stringify({ subject: "leaver@org" }) }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, subject: "leaver@org" });
    expect((await getUser(env.DB, "leaver@org"))?.is_active).toBe(0);
  });

  it("rejects a member with 403", async () => {
    await upsertUser(env.DB, "member@org");
    await upsertUser(env.DB, "leaver@org");
    await seedBearer("tok", "member@org", "scheduler:read scheduler:write admin");
    const res = await makeApp().request("/admin/offboard",
      { method: "POST", headers: { Authorization: "Bearer tok", "content-type": "application/json" }, body: JSON.stringify({ subject: "leaver@org" }) }, env);
    expect(res.status).toBe(403);
    expect((await getUser(env.DB, "leaver@org"))?.is_active).toBe(1);
  });

  it("403 insufficient_scope for an admin bearer without the admin scope", async () => {
    await upsertUser(env.DB, "admin@org", "admin");
    await upsertUser(env.DB, "leaver@org");
    await seedBearer("tok", "admin@org", "scheduler:read scheduler:write");
    const res = await makeApp().request("/admin/offboard",
      { method: "POST", headers: { Authorization: "Bearer tok", "content-type": "application/json" }, body: JSON.stringify({ subject: "leaver@org" }) }, env);
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe("insufficient_scope");
    expect((await getUser(env.DB, "leaver@org"))?.is_active).toBe(1);
  });

  it("400s when subject is missing", async () => {
    await upsertUser(env.DB, "admin@org", "admin");
    await seedBearer("tok", "admin@org", "scheduler:read scheduler:write admin");
    const res = await makeApp().request("/admin/offboard",
      { method: "POST", headers: { Authorization: "Bearer tok", "content-type": "application/json" }, body: JSON.stringify({}) }, env);
    expect(res.status).toBe(400);
  });

  it("401 without bearer", async () => {
    const res = await makeApp().request("/admin/offboard",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subject: "leaver@org" }) }, env);
    expect(res.status).toBe(401);
  });
});
