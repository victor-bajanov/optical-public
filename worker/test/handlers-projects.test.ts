import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { hashToken } from "../src/auth/tokens";
import { apolloProject } from "./fixtures/projects";

async function seed() {
  await env.DB.prepare("DELETE FROM oauth_tokens").run();
  await env.DB.prepare("DELETE FROM oauth_clients").run();
  await env.DB.prepare("DELETE FROM projects").run();
  await env.DB.prepare("INSERT INTO oauth_clients (id, name, type, redirect_uris, created_at) VALUES (?,?,?,?,?)")
    .bind("c1", "test", "pkce", null, "2026-01-01T00:00:00Z").run();
  const h = await hashToken("tok", env.TOKEN_HASH_PEPPER);
  await env.DB.prepare("INSERT INTO oauth_tokens (hashed_token, client_id, scopes, expires_at, refresh_of, revoked_at, subject) VALUES (?,?,?,?,?,?,?)")
    .bind(h, "c1", "scheduler:write", "2099-01-01T00:00:00Z", null, null, "seed@org").run();
}

const H = { Authorization: "Bearer tok", "Content-Type": "application/json" };

describe("/v1/projects", () => {
  beforeEach(async () => { await seed(); });

  it("creates and patches", async () => {
    const r = await SELF.fetch("https://x/v1/projects", { method: "POST", headers: H, body: JSON.stringify(apolloProject) });
    expect(r.status).toBe(201);
    const p = await r.json() as { id: string; priority_floor: number };
    expect(p.priority_floor).toBe(60);
    const r2 = await SELF.fetch(`https://x/v1/projects/${p.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ priority_floor: 90 }) });
    expect(r2.status).toBe(200);
    const p2 = await r2.json() as { priority_floor: number };
    expect(p2.priority_floor).toBe(90);
  });

  it("lists projects", async () => {
    await SELF.fetch("https://x/v1/projects", { method: "POST", headers: H, body: JSON.stringify(apolloProject) });
    const r = await SELF.fetch("https://x/v1/projects", { headers: { Authorization: "Bearer tok" } });
    const body = await r.json() as { projects: unknown[] };
    expect(body.projects).toHaveLength(1);
  });

  it("PATCH 404 on missing", async () => {
    const r = await SELF.fetch("https://x/v1/projects/11111111-1111-1111-1111-111111111111", {
      method: "PATCH", headers: H, body: JSON.stringify({ priority_floor: 10 }),
    });
    expect(r.status).toBe(404);
  });
});
