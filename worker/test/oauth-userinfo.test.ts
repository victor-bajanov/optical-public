import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { hashToken } from "../src/auth/tokens";

async function seedClient(id: string) {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO oauth_clients (id, name, type, redirect_uris, created_at) VALUES (?,?,?,?,?)`,
  ).bind(id, "test", "pkce", null, "2026-01-01T00:00:00Z").run();
}

async function seedToken(clientId: string, token: string, subject: string | null = null) {
  const h = await hashToken(token, env.TOKEN_HASH_PEPPER);
  await env.DB.prepare(
    `INSERT OR REPLACE INTO oauth_tokens (hashed_token, client_id, scopes, expires_at, refresh_of, revoked_at, subject) VALUES (?,?,?,?,?,?,?)`,
  ).bind(h, clientId, "read write", "2099-01-01T00:00:00Z", null, null, subject).run();
}

describe("GET /oauth/userinfo", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM oauth_tokens").run();
    await env.DB.prepare("DELETE FROM oauth_clients").run();
    await env.DB.prepare("DELETE FROM identity_tokens").run();
  });

  it("401 without bearer", async () => {
    const res = await SELF.fetch("https://x/oauth/userinfo");
    expect(res.status).toBe(401);
  });

  it("returns {sub} when bearer is valid and no Google account is connected", async () => {
    await seedClient("codemode-mcp");
    await seedToken("codemode-mcp", "tok-userinfo");
    const res = await SELF.fetch("https://x/oauth/userinfo", {
      headers: { Authorization: "Bearer tok-userinfo" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sub: "codemode-mcp" });
  });

  it("returns {sub, email} when a Google account is connected", async () => {
    await seedClient("codemode-mcp");
    await seedToken("codemode-mcp", "tok-with-email", "victor@example.com");
    const res = await SELF.fetch("https://x/oauth/userinfo", {
      headers: { Authorization: "Bearer tok-with-email" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sub: "victor@example.com", email: "victor@example.com" });
  });
});
