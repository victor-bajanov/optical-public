import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { hashToken } from "../src/auth/tokens";
import { pilatesTemplate } from "./fixtures/templates";

async function seed() {
  await env.DB.prepare("DELETE FROM oauth_tokens").run();
  await env.DB.prepare("DELETE FROM oauth_clients").run();
  await env.DB.prepare("DELETE FROM task_templates").run();
  await env.DB.prepare(
    "INSERT INTO oauth_clients (id, name, type, redirect_uris, created_at) VALUES (?,?,?,?,?)",
  ).bind("c1", "test", "pkce", null, "2026-01-01T00:00:00Z").run();
  const h = await hashToken("tok", env.TOKEN_HASH_PEPPER);
  await env.DB.prepare(
    "INSERT INTO oauth_tokens (hashed_token, client_id, scopes, expires_at, refresh_of, revoked_at, subject) VALUES (?,?,?,?,?,?,?)",
  ).bind(h, "c1", "scheduler:read scheduler:write", "2099-01-01T00:00:00Z", null, null, "seed@org").run();
}

const H = { Authorization: "Bearer tok", "Content-Type": "application/json" };

describe("/v1/templates", () => {
  beforeEach(async () => { await seed(); });

  it("requires auth", async () => {
    const r = await SELF.fetch("https://x/v1/templates", { method: "POST", body: JSON.stringify(pilatesTemplate) });
    expect(r.status).toBe(401);
  });

  it("creates a template", async () => {
    const r = await SELF.fetch("https://x/v1/templates", { method: "POST", headers: H, body: JSON.stringify(pilatesTemplate) });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { id: string; rrule: string };
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.rrule).toBe("FREQ=WEEKLY;BYDAY=FR");
  });

  it("rejects malformed rrule", async () => {
    const bad = { ...pilatesTemplate, rrule: "BYDAY=MO" };
    const r = await SELF.fetch("https://x/v1/templates", { method: "POST", headers: H, body: JSON.stringify(bad) });
    expect(r.status).toBe(400);
  });

  it("lists templates", async () => {
    await SELF.fetch("https://x/v1/templates", { method: "POST", headers: H, body: JSON.stringify(pilatesTemplate) });
    const r = await SELF.fetch("https://x/v1/templates", { headers: { Authorization: "Bearer tok" } });
    const body = (await r.json()) as { templates: unknown[] };
    expect(body.templates).toHaveLength(1);
  });

  it("deletes a template", async () => {
    const c = await SELF.fetch("https://x/v1/templates", { method: "POST", headers: H, body: JSON.stringify(pilatesTemplate) });
    const t = (await c.json()) as { id: string };
    const r = await SELF.fetch(`https://x/v1/templates/${t.id}`, { method: "DELETE", headers: { Authorization: "Bearer tok" } });
    expect(r.status).toBe(204);
  });
});
