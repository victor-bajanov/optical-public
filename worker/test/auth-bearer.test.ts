import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { requireBearer } from "../src/middleware/auth-bearer";
import type { Env } from "../src/env";
import { hashToken } from "../src/auth/tokens";
import { hashingKey } from "../src/auth/crypto-keys";

async function seedToken(clientId: string, token: string, opts: { expires_at?: string; revoked?: boolean; scopes?: string } = {}) {
  const h = await hashToken(token, env.TOKEN_HASH_PEPPER);
  await env.DB.prepare(
    `INSERT OR REPLACE INTO oauth_tokens (hashed_token, client_id, scopes, expires_at, refresh_of, revoked_at) VALUES (?,?,?,?,?,?)`,
  ).bind(h, clientId, opts.scopes ?? "scheduler:read scheduler:write", opts.expires_at ?? "2099-01-01T00:00:00Z", null, opts.revoked ? "2024-01-01T00:00:00Z" : null).run();
}

async function seedClient(id: string) {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO oauth_clients (id, name, type, redirect_uris, created_at) VALUES (?,?,?,?,?)`,
  ).bind(id, "test", "pkce", null, "2026-01-01T00:00:00Z").run();
}

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", requireBearer);
  app.get("/x", (c) => c.json({ client: c.get("clientId" as never) }));
  return app;
}

describe("requireBearer", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM oauth_tokens").run();
    await env.DB.prepare("DELETE FROM oauth_clients").run();
  });

  it("401 when no Authorization header", async () => {
    const res = await makeApp().request("/x", {}, env);
    expect(res.status).toBe(401);
  });

  it("401 when token unknown", async () => {
    const res = await makeApp().request("/x", { headers: { Authorization: "Bearer nope" } }, env);
    expect(res.status).toBe(401);
  });

  it("200 with valid token", async () => {
    await seedClient("c1");
    await seedToken("c1", "validtoken");
    const res = await makeApp().request("/x", { headers: { Authorization: "Bearer validtoken" } }, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ client: "c1" });
  });

  it("401 when token revoked", async () => {
    await seedClient("c1");
    await seedToken("c1", "revokedtoken", { revoked: true });
    const res = await makeApp().request("/x", { headers: { Authorization: "Bearer revokedtoken" } }, env);
    expect(res.status).toBe(401);
  });

  it("401 when token expired", async () => {
    await seedClient("c1");
    await seedToken("c1", "expiredtoken", { expires_at: "2000-01-01T00:00:00Z" });
    const res = await makeApp().request("/x", { headers: { Authorization: "Bearer expiredtoken" } }, env);
    expect(res.status).toBe(401);
  });

  it("200 when the access token was hashed with a distinct HASHING_KEY (split secrets)", async () => {
    // issueTokens stores the access-token hash using hashingKey(env) — HASHING_KEY,
    // falling back to TOKEN_HASH_PEPPER. A deployment that splits its secrets so
    // HASHING_KEY != TOKEN_HASH_PEPPER (the dev env does) breaks unless requireBearer
    // verifies with the SAME key. Regression for the dev-smoke 401 where mint used
    // HASHING_KEY but verify used TOKEN_HASH_PEPPER, so every access token failed
    // while refresh (which uses hashingKey) still worked.
    const prev = (env as unknown as { HASHING_KEY?: string }).HASHING_KEY;
    (env as unknown as { HASHING_KEY?: string }).HASHING_KEY = "a-distinct-hashing-key-not-the-pepper";
    try {
      await seedClient("c1");
      const h = await hashToken("splittoken", hashingKey(env as unknown as Env));
      await env.DB.prepare(
        `INSERT OR REPLACE INTO oauth_tokens (hashed_token, client_id, scopes, expires_at, refresh_of, revoked_at) VALUES (?,?,?,?,?,?)`,
      ).bind(h, "c1", "scheduler:read scheduler:write", "2099-01-01T00:00:00Z", null, null).run();
      const res = await makeApp().request("/x", { headers: { Authorization: "Bearer splittoken" } }, env);
      expect(res.status).toBe(200);
    } finally {
      (env as unknown as { HASHING_KEY?: string }).HASHING_KEY = prev;
    }
  });

  it("401 when a refresh token is presented as a bearer", async () => {
    await seedClient("c1");
    const h = await hashToken("refreshtoken", env.TOKEN_HASH_PEPPER);
    await env.DB.prepare(
      `INSERT OR REPLACE INTO oauth_tokens (hashed_token, client_id, scopes, expires_at, refresh_of, revoked_at) VALUES (?,?,?,?,?,?)`,
    ).bind(h, "c1", "scheduler:read", "2099-01-01T00:00:00Z", "some-access-hash", null).run();
    const res = await makeApp().request("/x", { headers: { Authorization: "Bearer refreshtoken" } }, env);
    expect(res.status).toBe(401);
  });
});
