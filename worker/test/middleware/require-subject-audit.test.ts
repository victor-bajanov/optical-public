import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { requireSubject } from "../../src/middleware/require-subject";

beforeEach(async () => { await env.DB.prepare("DELETE FROM audit_log").run(); });

describe("requireSubject audit", () => {
  it("writes a denied_no_subject audit row and returns 403 when subject is absent", async () => {
    const app = new Hono();
    app.get("/owned", requireSubject, (c) => c.json({ ok: true }));
    const res = await app.request("/owned", {}, env);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "no_subject" });
    const row = await env.DB.prepare("SELECT action, source FROM audit_log").first<{ action: string; source: string }>();
    expect(row).toEqual({ action: "denied_no_subject", source: "api" });
  });

  it("passes through (no audit) when subject is present", async () => {
    const app = new Hono<{ Variables: { subject: string } }>();
    app.use("*", async (c, next) => { c.set("subject", "u@org"); await next(); });
    app.get("/owned", requireSubject, (c) => c.json({ ok: true }));
    const res = await app.request("/owned", {}, env);
    expect(res.status).toBe(200);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});
