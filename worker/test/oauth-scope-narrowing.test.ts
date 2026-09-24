import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { upsertUser } from "../src/db/users";
import { narrowScopesForGrant } from "../src/auth/oauth-provider";

async function seedClient(id: string, allowed: string) {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO oauth_clients (id, name, type, redirect_uris, allowed_scopes, created_at)
     VALUES (?,?,?,?,?,?)`,
  ).bind(id, "t", "pkce", '["http://localhost/cb"]', allowed, "2026-01-01T00:00:00Z").run();
}

describe("narrowScopesForGrant", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM oauth_clients").run();
    await env.DB.prepare("DELETE FROM users").run();
  });

  it("grants full set to an admin via an admin-capable client", async () => {
    await seedClient("smoke-cli", "scheduler:read scheduler:write calendar:raw-token admin");
    await upsertUser(env.DB, "admin@org", "admin");
    const r = await narrowScopesForGrant(env, "smoke-cli",
      "scheduler:read scheduler:write calendar:raw-token admin", "admin@org");
    expect(r).toEqual({ ok: true, scopes: "scheduler:read scheduler:write calendar:raw-token admin" });
  });

  it("drops admin for a member via the same client", async () => {
    await seedClient("smoke-cli", "scheduler:read scheduler:write calendar:raw-token admin");
    await upsertUser(env.DB, "member@org");
    const r = await narrowScopesForGrant(env, "smoke-cli",
      "scheduler:read scheduler:write calendar:raw-token admin", "member@org");
    expect(r).toEqual({ ok: true, scopes: "scheduler:read scheduler:write calendar:raw-token" });
  });

  it("fails loud when a client requests a scope outside its allowlist", async () => {
    await seedClient("mcp", "scheduler:read scheduler:write");
    await upsertUser(env.DB, "admin@org", "admin");
    const r = await narrowScopesForGrant(env, "mcp", "scheduler:read admin", "admin@org");
    expect(r).toEqual({ ok: false });
  });
});
