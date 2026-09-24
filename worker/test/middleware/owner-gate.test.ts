// worker/test/middleware/owner-gate.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import type { Env } from "../../src/env";
import type { AppVariables } from "../../src/index-providers";
import { requireOwner } from "../../src/middleware/owner-gate";
import { hashToken } from "../../src/auth/tokens";

async function seedToken(token: string, subject: string | null) {
  const hashed = await hashToken(token, env.TOKEN_HASH_PEPPER);
  await env.DB.prepare(
    "INSERT OR REPLACE INTO oauth_tokens (hashed_token, client_id, scopes, expires_at, refresh_of, revoked_at, subject) VALUES (?, 'test-client', 'scheduler.write', NULL, NULL, NULL, ?)",
  ).bind(hashed, subject).run();
}

function makeApp() {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.get("/probe", async (c) => {
    const owner = await requireOwner(c);
    if (owner instanceof Response) return owner;
    return c.json({ owner }, 200);
  });
  return app;
}

describe("requireOwner", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM oauth_tokens").run();
  });

  it("401s when no bearer token is present", async () => {
    const res = await makeApp().request("/probe", {}, env);
    expect(res.status).toBe(401);
  });

  it("403s when the token carries no subject", async () => {
    await seedToken("nosub", null);
    const res = await makeApp().request("/probe", { headers: { Authorization: "Bearer nosub" } }, env);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("no_subject");
  });

  it("returns the token's subject when bearer + subject are valid", async () => {
    await seedToken("good", "me@x");
    const res = await makeApp().request("/probe", { headers: { Authorization: "Bearer good" } }, env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { owner: string }).owner).toBe("me@x");
  });
});
