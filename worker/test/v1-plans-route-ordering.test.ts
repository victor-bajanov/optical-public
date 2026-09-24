import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { v1 } from "../src/v1";
import { Hono } from "hono";
import type { AppVariables } from "../src/index-providers";
import { hashToken } from "../src/auth/tokens";

// Regression guard for the static-vs-param route collision: GET /v1/plans/latest
// (static, mountLatestPlanRoute) and GET /v1/plans/{plan_hash} (param,
// mountPlansRoutes) share a prefix. OpenAPIHono route matching is
// registration-order sensitive (NOT static-priority), so if the param route is
// mounted first, "latest" is captured as a plan_hash → the latest-plan handler
// is shadowed and the call 404s. The unit test for mountLatestPlanRoute mounts
// it in isolation and cannot catch this — this test exercises the REAL v1 app
// (production registration order), so a future reorder regresses loudly here.
//
// (mu-smoke M6 hit this live: GET /v1/plans/latest?covers=... → 404.)

const planBody = {
  schedule: [],
  dropped: [],
  window: { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" },
};

async function seedBearer(token: string, subject: string) {
  const hashed = await hashToken(token, env.TOKEN_HASH_PEPPER);
  await env.DB.prepare(
    "INSERT OR REPLACE INTO oauth_tokens (hashed_token, client_id, scopes, expires_at, refresh_of, revoked_at, subject) VALUES (?, 'test-client', 'scheduler:read scheduler:write', NULL, NULL, NULL, ?)",
  )
    .bind(hashed, subject)
    .run();
}

function makeApp() {
  const app = new Hono<{ Bindings: typeof env; Variables: AppVariables }>();
  app.route("/v1", v1);
  return app;
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM proposed_plans").run();
  await env.DB.prepare("DELETE FROM oauth_tokens").run();
});

describe("v1 /plans/latest vs /plans/{plan_hash} route ordering", () => {
  it("GET /v1/plans/latest reaches the latest-plan handler (not captured as plan_hash='latest')", async () => {
    await seedBearer("tok", "u@org");
    const res = await makeApp().request(
      "/v1/plans/latest",
      { headers: { Authorization: "Bearer tok" } },
      env,
    );
    // The latest-plan handler returns 200 {plan:null}; the param handler would
    // 404 looking up a plan with hash "latest".
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ plan: null });
  });

  it("GET /v1/plans/latest?covers= reaches the latest-plan handler (the exact mu-smoke M6 call)", async () => {
    await seedBearer("tok", "u@org");
    await env.DB.prepare(
      "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES (?, ?, ?, ?, NULL, ?)",
    )
      .bind("h1", JSON.stringify(planBody), "2026-05-18T00:00:00Z", "2099-01-01T00:00:00Z", "u@org")
      .run();
    const res = await makeApp().request(
      "/v1/plans/latest?covers=2026-05-20T12:00:00Z",
      { headers: { Authorization: "Bearer tok" } },
      env,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { plan: { plan_hash: string } }).plan?.plan_hash).toBe("h1");
  });

  it("GET /v1/plans/{plan_hash} still resolves a real hash (param route not shadowed)", async () => {
    await seedBearer("tok", "u@org");
    await env.DB.prepare(
      "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES (?, ?, ?, ?, NULL, ?)",
    )
      .bind("h1", JSON.stringify(planBody), "2026-05-18T00:00:00Z", "2099-01-01T00:00:00Z", "u@org")
      .run();
    const res = await makeApp().request(
      "/v1/plans/h1",
      { headers: { Authorization: "Bearer tok" } },
      env,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { plan_hash: string }).plan_hash).toBe("h1");
  });
});
