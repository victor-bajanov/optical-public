import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Env } from "../../src/env";
import { requireAdmin } from "../../src/middleware/admin-role";
import { upsertUser, deactivateUser } from "../../src/db/users";

function makeApp(accessEmail: string) {
  const app = new Hono<{ Bindings: Env; Variables: { accessEmail: string } }>();
  app.use("*", async (c, next) => { c.set("accessEmail", accessEmail); await next(); });
  app.get("/x", requireAdmin, (c) => c.json({ ok: true }));
  return app;
}

beforeEach(async () => { await env.DB.prepare("DELETE FROM users").run(); });

describe("requireAdmin", () => {
  it("allows an active admin", async () => {
    await upsertUser(env.DB, "admin@org", "admin");
    const res = await makeApp("admin@org").request("/x", {}, env);
    expect(res.status).toBe(200);
  });

  it("rejects a member with 403", async () => {
    await upsertUser(env.DB, "member@org");
    const res = await makeApp("member@org").request("/x", {}, env);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden_not_admin" });
  });

  it("rejects a deactivated admin", async () => {
    await upsertUser(env.DB, "ex@org", "admin");
    await deactivateUser(env.DB, "ex@org");
    const res = await makeApp("ex@org").request("/x", {}, env);
    expect(res.status).toBe(403);
  });

  it("rejects when no accessEmail is present", async () => {
    const res = await makeApp("").request("/x", {}, env);
    expect(res.status).toBe(403);
  });
});
