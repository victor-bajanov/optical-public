import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import type { Env } from "../../src/env";
import { requireScope } from "../../src/middleware/require-scope";

function makeApp(scopes: string[]) {
  const app = new Hono<{ Bindings: Env; Variables: { scopes: string[] } }>();
  app.use("*", async (c, next) => { c.set("scopes", scopes); await next(); });
  app.get("/x", requireScope("admin"), (c) => c.json({ ok: true }));
  return app;
}

describe("requireScope", () => {
  it("allows when the scope is present", async () => {
    const res = await makeApp(["scheduler:read", "admin"]).request("/x", {}, env);
    expect(res.status).toBe(200);
  });
  it("403 insufficient_scope when absent", async () => {
    const res = await makeApp(["scheduler:read"]).request("/x", {}, env);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "insufficient_scope", required: "admin" });
  });
  it("403 when no scopes set at all", async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.get("/x", requireScope("admin"), (c) => c.json({ ok: true }));
    const res = await app.request("/x", {}, env);
    expect(res.status).toBe(403);
  });
});
