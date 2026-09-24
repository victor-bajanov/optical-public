// worker/test/middleware/require-subject.test.ts
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { describe, it, expect } from "vitest";
import { requireSubject } from "../../src/middleware/require-subject";

function appWith(subject?: string) {
  const app = new Hono();
  app.use("*", async (c, next) => { if (subject) c.set("subject" as never, subject); await next(); });
  app.use("*", requireSubject);
  app.get("/", (c) => c.json({ owner: c.get("ownerSubject" as never) }));
  return app;
}

describe("requireSubject", () => {
  it("403s when no subject is present", async () => {
    const r = await appWith(undefined).request("/", {}, env);
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "no_subject" });
  });

  it("passes through and exposes ownerSubject when a subject is present", async () => {
    const r = await appWith("a@org").request("/", {}, env);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ owner: "a@org" });
  });
});
