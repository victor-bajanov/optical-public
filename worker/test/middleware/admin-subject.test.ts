import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Env } from "../../src/env";
import { requireAdminSubject } from "../../src/middleware/admin-subject";
import { upsertUser, deactivateUser } from "../../src/db/users";

function makeApp(subject?: string) {
  const app = new Hono<{ Bindings: Env; Variables: { subject?: string } }>();
  app.use("*", async (c, next) => { if (subject) c.set("subject", subject); await next(); });
  app.get("/x", requireAdminSubject, (c) => c.json({ ok: true }));
  return app;
}

beforeEach(async () => { await env.DB.prepare("DELETE FROM users").run(); });

describe("requireAdminSubject", () => {
  it("allows an active admin subject", async () => {
    await upsertUser(env.DB, "admin@org", "admin");
    expect((await makeApp("admin@org").request("/x", {}, env)).status).toBe(200);
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
    expect((await makeApp("ex@org").request("/x", {}, env)).status).toBe(403);
  });
  it("rejects when no subject is present", async () => {
    expect((await makeApp(undefined).request("/x", {}, env)).status).toBe(403);
  });
});
