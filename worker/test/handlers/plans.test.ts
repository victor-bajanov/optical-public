import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { OpenAPIHono } from "@hono/zod-openapi";
import { mountPlansRoutes } from "../../src/handlers/plans";
import type { AppVariables } from "../../src/index-providers";
import { hashToken } from "../../src/auth/tokens";
import { getProposedPlan } from "../../src/planning/proposed-plans";

const body = {
  schedule: [
    {
      task_id: "t",
      chunk_id: "t#0",
      start: "2026-05-19T09:00:00Z",
      end: "2026-05-19T10:00:00Z",
      context: "deep",
    },
  ],
  dropped: [],
  window: { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" },
};

async function seedBearer(token: string, subject: string) {
  const hashed = await hashToken(token, env.TOKEN_HASH_PEPPER);
  await env.DB.prepare(
    "INSERT OR REPLACE INTO oauth_tokens (hashed_token, client_id, scopes, expires_at, refresh_of, revoked_at, subject) VALUES (?, 'test-client', 'scheduler.write', NULL, NULL, NULL, ?)",
  )
    .bind(hashed, subject)
    .run();
}

function makeApp() {
  const v1 = new OpenAPIHono<{ Bindings: typeof env; Variables: AppVariables }>();
  mountPlansRoutes(v1);
  const app = new Hono<{ Bindings: typeof env; Variables: AppVariables }>();
  app.route("/v1", v1);
  return app;
}

describe("/v1/plans/:hash", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM proposed_plans").run();
    await env.DB.prepare("DELETE FROM oauth_tokens").run();
    await env.DB
      .prepare(
        "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES (?, ?, ?, ?, NULL, ?)",
      )
      .bind("hash-1", JSON.stringify(body), "2026-05-18T00:00:00Z", "2026-05-19T00:00:00Z", "me@x")
      .run();
    await seedBearer("fake", "me@x");
  });

  it("GET returns the body JSON", async () => {
    const app = makeApp();
    const res = await app.request(
      "/v1/plans/hash-1",
      { headers: { Authorization: "Bearer fake" } },
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { plan_hash: string; body: { schedule: unknown[] } };
    expect(json.plan_hash).toBe("hash-1");
    expect(json.body.schedule).toHaveLength(1);
  });

  it("GET returns 404 for unknown plan", async () => {
    const app = makeApp();
    const res = await app.request(
      "/v1/plans/nope",
      { headers: { Authorization: "Bearer fake" } },
      env,
    );
    expect(res.status).toBe(404);
  });

  it("DELETE removes the proposed plan", async () => {
    const app = makeApp();
    const res = await app.request(
      "/v1/plans/hash-1",
      { method: "DELETE", headers: { Authorization: "Bearer fake" } },
      env,
    );
    expect(res.status).toBe(204);
    const r = await env.DB
      .prepare("SELECT plan_hash FROM proposed_plans WHERE plan_hash = ?")
      .bind("hash-1")
      .first();
    expect(r).toBeNull();
  });

  it("DELETE returns 409 if the plan is already committed", async () => {
    await env.DB
      .prepare("UPDATE proposed_plans SET committed_at = ? WHERE plan_hash = ?")
      .bind("2026-05-18T01:00:00Z", "hash-1")
      .run();
    const app = makeApp();
    const res = await app.request(
      "/v1/plans/hash-1",
      { method: "DELETE", headers: { Authorization: "Bearer fake" } },
      env,
    );
    expect(res.status).toBe(409);
  });

  it("GET does not return another tenant's plan", async () => {
    await env.DB.prepare(
      "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES ('b-plan', ?, '2026-05-18T12:00:00Z', '2099-01-01T00:00:00Z', NULL, 'b@org')",
    ).bind(JSON.stringify(body)).run();
    const res = await makeApp().request("/v1/plans/b-plan", { headers: { Authorization: "Bearer fake" } }, env);
    expect(res.status).toBe(404);
  });

  it("GET response never leaks the subject field", async () => {
    const res = await makeApp().request("/v1/plans/hash-1", { headers: { Authorization: "Bearer fake" } }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty("subject");
  });

  it("GET response omits the internal window columns (body.window is the contract)", async () => {
    const res = await makeApp().request("/v1/plans/hash-1", { headers: { Authorization: "Bearer fake" } }, env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).not.toHaveProperty("window_start");
    expect(json).not.toHaveProperty("window_end");
  });

  it("DELETE cannot remove another tenant's plan", async () => {
    await env.DB.prepare(
      "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES ('b-plan', ?, '2026-05-18T12:00:00Z', '2099-01-01T00:00:00Z', NULL, 'b@org')",
    ).bind(JSON.stringify(body)).run();
    const res = await makeApp().request("/v1/plans/b-plan", { method: "DELETE", headers: { Authorization: "Bearer fake" } }, env);
    expect(res.status).toBe(404);
    expect(await getProposedPlan(env.DB, "b-plan")).not.toBeNull();
  });

  it("403s a subject-less token", async () => {
    const hashed = await hashToken("nosub", env.TOKEN_HASH_PEPPER);
    await env.DB.prepare(
      "INSERT OR REPLACE INTO oauth_tokens (hashed_token, client_id, scopes, expires_at, refresh_of, revoked_at, subject) VALUES (?, 'test-client', 'scheduler.write', NULL, NULL, NULL, NULL)",
    ).bind(hashed).run();
    const res = await makeApp().request("/v1/plans/hash-1", { headers: { Authorization: "Bearer nosub" } }, env);
    expect(res.status).toBe(403);
  });
});

describe("GET /v1/plans (pending list)", () => {
  // The 2026-07-06 incident left six bogus pending plans strewn across widely
  // separated weeks with no way to enumerate them — the API only offered
  // /plans/latest (globally or per ?covers instant), so cleanup meant guessing
  // week starts one at a time. This endpoint lists every live pending plan in
  // one call.
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM proposed_plans").run();
    await env.DB.prepare("DELETE FROM oauth_tokens").run();
    await seedBearer("fake", "me@x");

    const seed = async (
      hash: string,
      subject: string,
      committedAt: string | null,
      expiresAt: string,
      windowStart: string,
      windowEnd: string,
      createdAt: string,
    ) => {
      const planBody = { ...body, window: { start: windowStart, end: windowEnd } };
      await env.DB
        .prepare(
          "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject, window_start, window_end) VALUES (?,?,?,?,?,?,?,?)",
        )
        .bind(hash, JSON.stringify(planBody), createdAt, expiresAt, committedAt, subject, windowStart, windowEnd)
        .run();
    };
    // Two live pending plans in different weeks (out of created order to prove sorting is by window).
    await seed("p-late-week", "me@x", null, "2099-01-01T00:00:00Z", "2026-09-27T14:00:00Z", "2026-10-04T14:00:00Z", "2026-07-01T00:00:00Z");
    await seed("p-early-week", "me@x", null, "2099-01-01T00:00:00Z", "2026-07-05T14:00:00Z", "2026-07-12T14:00:00Z", "2026-07-02T00:00:00Z");
    // Excluded: committed, expired, and another tenant's pending plan.
    await seed("p-committed", "me@x", "2026-07-01T01:00:00Z", "2099-01-01T00:00:00Z", "2026-07-12T14:00:00Z", "2026-07-19T14:00:00Z", "2026-07-01T00:00:00Z");
    await seed("p-expired", "me@x", null, "2020-01-01T00:00:00Z", "2026-07-19T14:00:00Z", "2026-07-26T14:00:00Z", "2026-07-01T00:00:00Z");
    await seed("p-foreign", "other@x", null, "2099-01-01T00:00:00Z", "2026-08-02T14:00:00Z", "2026-08-09T14:00:00Z", "2026-07-01T00:00:00Z");
  });

  it("lists only the caller's live pending plans, ordered by window start", async () => {
    const res = await makeApp().request("/v1/plans", { headers: { Authorization: "Bearer fake" } }, env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { plans: Array<Record<string, unknown>> };
    expect(json.plans.map((p) => p.plan_hash)).toEqual(["p-early-week", "p-late-week"]);
    expect(json.plans[0]).toMatchObject({
      plan_hash: "p-early-week",
      window: { start: "2026-07-05T14:00:00Z", end: "2026-07-12T14:00:00Z" },
      created_at: "2026-07-02T00:00:00Z",
      expires_at: "2099-01-01T00:00:00Z",
    });
    // Plan bodies are heavyweight; the list is a summary — fetch a body via
    // GET /plans/{hash}.
    expect(json.plans[0]).not.toHaveProperty("body");
  });

  it("returns an empty list when nothing is pending", async () => {
    await env.DB.prepare("DELETE FROM proposed_plans WHERE subject = 'me@x' AND committed_at IS NULL AND expires_at > '2026-01-01'").run();
    const res = await makeApp().request("/v1/plans", { headers: { Authorization: "Bearer fake" } }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ plans: [] });
  });

  it("403s a subject-less token", async () => {
    const hashed = await hashToken("nosub2", env.TOKEN_HASH_PEPPER);
    await env.DB.prepare(
      "INSERT OR REPLACE INTO oauth_tokens (hashed_token, client_id, scopes, expires_at, refresh_of, revoked_at, subject) VALUES (?, 'test-client', 'scheduler.write', NULL, NULL, NULL, NULL)",
    ).bind(hashed).run();
    const res = await makeApp().request("/v1/plans", { headers: { Authorization: "Bearer nosub2" } }, env);
    expect(res.status).toBe(403);
  });
});
