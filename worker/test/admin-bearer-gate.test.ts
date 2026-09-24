import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { hashToken } from "../src/auth/tokens";
import { hashingKey } from "../src/auth/crypto-keys";
import { upsertUser } from "../src/db/users";

// NOTE: import the real app via the Hono instance, NOT the default export of
// src/index (that's the {fetch,scheduled} handler object). The four /admin
// routes are mounted on the top-level Hono app in src/index.ts. To exercise
// them, build a minimal app that mounts just these routes — OR, if simpler,
// import { default as ... }. The orchestrator confirmed the pattern: mount the
// route functions onto a fresh Hono app. Use this approach:
import { Hono } from "hono";
import type { Env } from "../src/env";
import type { AppVariables } from "../src/index-providers";
import { mountRenewSubscriptionsRoute } from "../src/admin/renew-subscriptions-route";

function makeApp() {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  mountRenewSubscriptionsRoute(app);
  return app;
}

async function seedBearer(token: string, subject: string, scopes: string) {
  const h = await hashToken(token, hashingKey(env));
  await env.DB.prepare(`INSERT OR REPLACE INTO oauth_clients (id,name,type,redirect_uris,allowed_scopes,created_at) VALUES ('c','t','pkce',NULL,'scheduler:read scheduler:write admin','2026-01-01')`).run();
  await env.DB.prepare(`INSERT OR REPLACE INTO oauth_tokens (hashed_token,client_id,scopes,expires_at,refresh_of,revoked_at,subject) VALUES (?,?,?,?,?,?,?)`)
    .bind(h, "c", scopes, "2099-01-01T00:00:00Z", null, null, subject).run();
}

beforeEach(async () => {
  for (const t of ["oauth_tokens", "oauth_clients", "users"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
});

describe("POST /admin/renew-subscriptions auth", () => {
  it("401 without bearer", async () => {
    expect((await makeApp().request("/admin/renew-subscriptions", { method: "POST" }, env)).status).toBe(401);
  });
  it("403 for a member bearer", async () => {
    await upsertUser(env.DB, "m@org");
    await seedBearer("tok", "m@org", "scheduler:read scheduler:write");
    expect((await makeApp().request("/admin/renew-subscriptions", { method: "POST", headers: { Authorization: "Bearer tok" } }, env)).status).toBe(403);
  });
  it("403 for an admin bearer WITHOUT the admin scope", async () => {
    await upsertUser(env.DB, "a@org", "admin");
    await seedBearer("tok", "a@org", "scheduler:read scheduler:write");
    const res = await makeApp().request("/admin/renew-subscriptions", { method: "POST", headers: { Authorization: "Bearer tok" } }, env);
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe("insufficient_scope");
  });
  it("passes the gate for an admin bearer WITH the admin scope (reaches handler)", async () => {
    await upsertUser(env.DB, "a@org", "admin");
    await seedBearer("tok", "a@org", "scheduler:read scheduler:write admin");
    const res = await makeApp().request("/admin/renew-subscriptions", { method: "POST", headers: { Authorization: "Bearer tok" } }, env);
    // Handler runs (no channels → ok with failed:0); the point is NOT 401/403.
    expect([200, 500]).toContain(res.status);
  });
});
