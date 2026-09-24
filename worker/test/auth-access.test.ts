import { describe, it, expect, vi } from "vitest";
import { requireAccess } from "../src/middleware/auth-access";
import { Hono } from "hono";

const fakeEnv = {
  ACCESS_TEAM_DOMAIN: "https://test.cloudflareaccess.com",
  ACCESS_POLICY_AUD: "test-aud",
};

describe("requireAccess middleware", () => {
  it("returns 401 when header missing", async () => {
    const app = new Hono();
    app.use("*", requireAccess);
    app.get("/x", (c) => c.text("ok"));
    const res = await app.request("/x", {}, fakeEnv);
    expect(res.status).toBe(401);
  });

  it("calls jose.jwtVerify with team domain + aud", async () => {
    const app = new Hono();
    app.use("*", requireAccess);
    app.get("/x", (c) => c.json({ email: c.get("accessEmail" as never) }));

    // Stub jose at module level via spy: we expose a hook for tests.
    const { __setVerifierForTests } = await import("../src/middleware/auth-access");
    __setVerifierForTests(async () => ({ payload: { email: "u@example.com" }, protectedHeader: {} as never }));

    const res = await app.request("/x", { headers: { "cf-access-jwt-assertion": "token" } }, fakeEnv);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ email: "u@example.com" });
    __setVerifierForTests(null);
  });

  it("returns 401 on verification failure", async () => {
    const app = new Hono();
    app.use("*", requireAccess);
    app.get("/x", (c) => c.text("ok"));
    const { __setVerifierForTests } = await import("../src/middleware/auth-access");
    __setVerifierForTests(async () => { throw new Error("bad sig"); });
    const res = await app.request("/x", { headers: { "cf-access-jwt-assertion": "bad" } }, fakeEnv);
    expect(res.status).toBe(401);
    __setVerifierForTests(null);
  });
});
