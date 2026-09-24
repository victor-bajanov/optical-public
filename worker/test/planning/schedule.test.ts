import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { OpenAPIHono } from "@hono/zod-openapi";
import { mountScheduleRoute } from "../../src/planning/schedule";
import type { AppVariables } from "../../src/index-providers";
import { hashToken } from "../../src/auth/tokens";

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
  mountScheduleRoute(v1);
  const app = new Hono<{ Bindings: typeof env; Variables: AppVariables }>();
  app.route("/v1", v1);
  return app;
}

describe("GET /v1/schedule", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM proposed_plans").run();
    await env.DB.prepare("DELETE FROM oauth_tokens").run();
    await seedBearer("fake", "me@x");
  });

  it("returns 404 when no committed plan exists", async () => {
    const res = await makeApp().request(
      "/v1/schedule",
      { headers: { Authorization: "Bearer fake" } },
      env,
    );
    expect(res.status).toBe(404);
  });

  it("returns the most recently committed plan body", async () => {
    const body1 = {
      schedule: [
        {
          task_id: "old",
          chunk_id: "old#0",
          start: "2026-05-12T09:00:00Z",
          end: "2026-05-12T10:00:00Z",
          context: "deep",
        },
      ],
      dropped: [],
      window: { start: "2026-05-11T00:00:00Z", end: "2026-05-18T00:00:00Z" },
    };
    const body2 = {
      schedule: [
        {
          task_id: "new",
          chunk_id: "new#0",
          start: "2026-05-19T09:00:00Z",
          end: "2026-05-19T10:00:00Z",
          context: "deep",
        },
      ],
      dropped: [],
      window: { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" },
    };
    await env.DB
      .prepare(
        "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES ('h-old', ?, '2026-05-11T00:00:00Z', '2026-05-12T00:00:00Z', '2026-05-11T01:00:00Z', 'me@x')",
      )
      .bind(JSON.stringify(body1))
      .run();
    await env.DB
      .prepare(
        "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES ('h-new', ?, '2026-05-18T00:00:00Z', '2026-05-19T00:00:00Z', '2026-05-18T01:00:00Z', 'me@x')",
      )
      .bind(JSON.stringify(body2))
      .run();

    const res = await makeApp().request(
      "/v1/schedule",
      { headers: { Authorization: "Bearer fake" } },
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { schedule: Array<{ task_id: string }> };
    expect(json.schedule[0]!.task_id).toBe("new");
  });

  it("does NOT return another tenant's committed plan", async () => {
    const theirs = {
      schedule: [{ task_id: "theirs", chunk_id: "theirs#0", start: "2026-05-26T09:00:00Z", end: "2026-05-26T10:00:00Z", context: "deep" }],
      dropped: [],
      window: { start: "2026-05-25T00:00:00Z", end: "2026-06-01T00:00:00Z" },
    };
    await env.DB.prepare(
      "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES ('h-theirs', ?, '2026-05-25T00:00:00Z', '2026-05-26T00:00:00Z', '2026-05-25T01:00:00Z', 'other@y')",
    ).bind(JSON.stringify(theirs)).run();
    const res = await makeApp().request("/v1/schedule", { headers: { Authorization: "Bearer fake" } }, env);
    expect(res.status).toBe(404);
  });

  it("403s a subject-less token", async () => {
    await seedBearer("nosub-token", "");
    await env.DB.prepare("UPDATE oauth_tokens SET subject = NULL WHERE client_id = 'test-client' AND hashed_token = ?")
      .bind(await hashToken("nosub-token", env.TOKEN_HASH_PEPPER)).run();
    const res = await makeApp().request("/v1/schedule", { headers: { Authorization: "Bearer nosub-token" } }, env);
    expect(res.status).toBe(403);
  });
});
