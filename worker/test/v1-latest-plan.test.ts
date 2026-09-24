import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { OpenAPIHono } from "@hono/zod-openapi";
import { mountLatestPlanRoute } from "../src/handlers/latest-plan";
import type { AppVariables } from "../src/index-providers";
import { hashToken } from "../src/auth/tokens";

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
  const v1 = new OpenAPIHono<{ Bindings: typeof env; Variables: AppVariables }>();
  mountLatestPlanRoute(v1);
  const app = new Hono<{ Bindings: typeof env; Variables: AppVariables }>();
  app.route("/v1", v1);
  return app;
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM proposed_plans").run();
  await env.DB.prepare("DELETE FROM oauth_tokens").run();
});

describe("GET /v1/plans/latest", () => {
  it("401 without bearer", async () => {
    const res = await makeApp().request("/v1/plans/latest", {}, env);
    expect(res.status).toBe(401);
  });

  it("returns {plan:null} when the caller has no proposed plan", async () => {
    await seedBearer("tok", "u@org");
    const res = await makeApp().request(
      "/v1/plans/latest",
      { headers: { Authorization: "Bearer tok" } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ plan: null });
  });

  it("returns the latest unexpired uncommitted plan for the caller", async () => {
    await seedBearer("tok", "u@org");
    await env.DB.prepare(
      "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES (?, ?, ?, ?, NULL, ?)",
    )
      .bind("h1", JSON.stringify(planBody), "2026-05-18T00:00:00Z", "2099-01-01T00:00:00Z", "u@org")
      .run();
    const res = await makeApp().request(
      "/v1/plans/latest",
      { headers: { Authorization: "Bearer tok" } },
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { plan: { plan_hash: string; window: unknown } };
    expect(json.plan?.plan_hash).toBe("h1");
    expect(json.plan?.window).toEqual(planBody.window);
  });

  it("does not return another tenant's plan", async () => {
    await seedBearer("tok", "u@org");
    await env.DB.prepare(
      "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES (?, ?, ?, ?, NULL, ?)",
    )
      .bind("h-other", JSON.stringify(planBody), "2026-05-18T00:00:00Z", "2099-01-01T00:00:00Z", "other@org")
      .run();
    const res = await makeApp().request(
      "/v1/plans/latest",
      { headers: { Authorization: "Bearer tok" } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ plan: null });
  });

  it("does not return an expired plan", async () => {
    await seedBearer("tok", "u@org");
    await env.DB.prepare(
      "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES (?, ?, ?, ?, NULL, ?)",
    )
      .bind("h-exp", JSON.stringify(planBody), "2020-01-01T00:00:00Z", "2020-01-02T00:00:00Z", "u@org")
      .run();
    const res = await makeApp().request(
      "/v1/plans/latest",
      { headers: { Authorization: "Bearer tok" } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ plan: null });
  });

  it("does not return a committed plan", async () => {
    await seedBearer("tok", "u@org");
    await env.DB.prepare(
      "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(
        "h-committed",
        JSON.stringify(planBody),
        "2026-05-18T00:00:00Z",
        "2099-01-01T00:00:00Z",
        "2026-05-18T01:00:00Z",
        "u@org",
      )
      .run();
    const res = await makeApp().request(
      "/v1/plans/latest",
      { headers: { Authorization: "Bearer tok" } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ plan: null });
  });

  it("?covers= returns the plan whose window covers that instant", async () => {
    await seedBearer("tok", "u@org");
    // Plan covering week A
    const bodyA = {
      schedule: [],
      dropped: [],
      window: { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" },
    };
    // Plan covering week B (newer)
    const bodyB = {
      schedule: [],
      dropped: [],
      window: { start: "2026-05-25T00:00:00Z", end: "2026-06-01T00:00:00Z" },
    };
    await env.DB.prepare(
      "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES (?, ?, ?, ?, NULL, ?)",
    )
      .bind("h-a", JSON.stringify(bodyA), "2026-05-18T00:00:00Z", "2099-01-01T00:00:00Z", "u@org")
      .run();
    await env.DB.prepare(
      "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES (?, ?, ?, ?, NULL, ?)",
    )
      .bind("h-b", JSON.stringify(bodyB), "2026-05-25T00:00:00Z", "2099-01-01T00:00:00Z", "u@org")
      .run();
    // Without ?covers: returns the most recent (h-b)
    const resLatest = await makeApp().request(
      "/v1/plans/latest",
      { headers: { Authorization: "Bearer tok" } },
      env,
    );
    expect(((await resLatest.json()) as { plan: { plan_hash: string } }).plan?.plan_hash).toBe("h-b");
    // With ?covers= pointing into week A: returns h-a
    const resCovered = await makeApp().request(
      "/v1/plans/latest?covers=2026-05-20T12:00:00Z",
      { headers: { Authorization: "Bearer tok" } },
      env,
    );
    expect(resCovered.status).toBe(200);
    expect(((await resCovered.json()) as { plan: { plan_hash: string } }).plan?.plan_hash).toBe("h-a");
  });

  it("403 on a subject-less token", async () => {
    const hashed = await hashToken("nosub", env.TOKEN_HASH_PEPPER);
    await env.DB.prepare(
      "INSERT OR REPLACE INTO oauth_tokens (hashed_token, client_id, scopes, expires_at, refresh_of, revoked_at, subject) VALUES (?, 'test-client', 'scheduler:read', NULL, NULL, NULL, NULL)",
    )
      .bind(hashed)
      .run();
    const res = await makeApp().request(
      "/v1/plans/latest",
      { headers: { Authorization: "Bearer nosub" } },
      env,
    );
    expect(res.status).toBe(403);
  });
});
