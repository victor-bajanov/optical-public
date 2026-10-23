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

// O14 #2: the target is resolved against the STORED subject (case-insensitive,
// users ∪ identity_tokens), never bound raw. An unknown or ambiguous subject
// must not write an audit row or report success.
describe("POST /admin/offboard subject resolution", () => {
  async function asAdmin(subject: string) {
    await upsertUser(env.DB, "admin@org", "admin");
    await seedBearer("tok", "admin@org", "scheduler:read scheduler:write admin");
    return makeApp().request("/admin/offboard",
      { method: "POST", headers: { Authorization: "Bearer tok", "content-type": "application/json" }, body: JSON.stringify({ subject }) }, env);
  }
  async function auditCount(): Promise<number> {
    return (await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log").first<{ n: number }>())?.n ?? -1;
  }
  async function seedIdentity(email: string) {
    await env.DB.prepare("INSERT INTO identity_tokens (account_email, refresh_token_encrypted, scopes, updated_at) VALUES (?,?,?,?)")
      .bind(email, new Uint8Array([1]), "openid", "2026-01-01T00:00:00Z").run();
  }

  it("offboards the stored subject when the input differs only in case / whitespace, and echoes it", async () => {
    await upsertUser(env.DB, "leaver@org");
    const res = await asAdmin(" Leaver@Org ");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, subject: "leaver@org" });
    expect((await getUser(env.DB, "leaver@org"))?.is_active).toBe(0);
    const a = await env.DB.prepare("SELECT subject FROM audit_log WHERE action = 'offboard'").all<{ subject: string }>();
    expect(a.results).toEqual([{ subject: "leaver@org" }]);
  });

  it("404 unknown_subject for a subject nobody holds: no audit row, no users row", async () => {
    const res = await asAdmin("nobody@org");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown_subject" });
    expect(await auditCount()).toBe(0);
    expect(await getUser(env.DB, "nobody@org")).toBeNull();
  });

  it("offboards a legacy subject present only in identity_tokens (no users row)", async () => {
    await seedIdentity("legacy@org");
    const res = await asAdmin("Legacy@Org");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, subject: "legacy@org" });
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM identity_tokens WHERE account_email = 'legacy@org'").first<{ n: number }>();
    expect(left?.n).toBe(0);
    const a = await env.DB.prepare("SELECT subject FROM audit_log WHERE action = 'offboard'").all<{ subject: string }>();
    expect(a.results).toEqual([{ subject: "legacy@org" }]);
  });

  it("an exact match wins over a case-variant row", async () => {
    await upsertUser(env.DB, "pat@org");
    await upsertUser(env.DB, "Pat@Org");
    const res = await asAdmin("Pat@Org");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, subject: "Pat@Org" });
    expect((await getUser(env.DB, "Pat@Org"))?.is_active).toBe(0);
    expect((await getUser(env.DB, "pat@org"))?.is_active).toBe(1);
  });

  it("a users row and its identity_tokens row are one subject, not an ambiguity", async () => {
    await upsertUser(env.DB, "both@org");
    await seedIdentity("both@org");
    const res = await asAdmin("BOTH@org");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, subject: "both@org" });
  });

  it("409 ambiguous_subject when several stored subjects match only case-insensitively: nothing offboarded", async () => {
    await upsertUser(env.DB, "pat@org");
    await seedIdentity("Pat@Org");
    const res = await asAdmin("PAT@ORG");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "ambiguous_subject" });
    expect(await auditCount()).toBe(0);
    expect((await getUser(env.DB, "pat@org"))?.is_active).toBe(1);
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM identity_tokens WHERE account_email = 'Pat@Org'").first<{ n: number }>();
    expect(left?.n).toBe(1);
  });
});
