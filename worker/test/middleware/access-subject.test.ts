// worker/test/middleware/access-subject.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import type { Env } from "../../src/env";
import type { AppVariables } from "../../src/index-providers";
import { requireAccess, __setVerifierForTests } from "../../src/middleware/auth-access";
import { requireCaller } from "../../src/middleware/access-subject";

function makeApp() {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.get("/probe", requireAccess, (c) => {
    const caller = requireCaller(c);
    if (caller instanceof Response) return caller;
    return c.json({ caller }, 200);
  });
  return app;
}

const HEADERS = { "CF-Access-Jwt-Assertion": "x.y.z" };

describe("requireCaller", () => {
  afterEach(() => __setVerifierForTests(null));

  it("returns the verified CF-Access caller email", async () => {
    __setVerifierForTests(async () => ({ payload: { email: "caller@org" } }));
    const res = await makeApp().request("/probe", { headers: HEADERS }, env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { caller: string }).caller).toBe("caller@org");
  });

  it("401s (no_caller) when the verified JWT carries no email", async () => {
    __setVerifierForTests(async () => ({ payload: {} }));
    const res = await makeApp().request("/probe", { headers: HEADERS }, env);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("no_caller");
  });
});
