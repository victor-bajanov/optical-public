import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { OpenAPIHono } from "@hono/zod-openapi";
import { mountMeetingPolicyRoute } from "../../src/planning/meeting-policy-route";
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
  mountMeetingPolicyRoute(v1);
  const app = new Hono<{ Bindings: typeof env; Variables: AppVariables }>();
  app.route("/v1", v1);
  return app;
}

async function authedGet(path: string) {
  return makeApp().request(path, { headers: { Authorization: "Bearer fake" } }, env);
}

describe("GET /v1/meeting-policy", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM config_meeting_policy").run();
    await env.DB.prepare("DELETE FROM oauth_tokens").run();
    await seedBearer("fake", "me@x");
  });

  it("returns the caller's effective meeting policy", async () => {
    await env.DB.prepare("DELETE FROM config_meeting_policy").run();
    await env.DB.prepare("INSERT INTO config_meeting_policy (owner_subject, body) VALUES ('__default__', ?)")
      .bind(JSON.stringify({ attendee_enforcement: "not_declined" })).run();
    const res = await authedGet("/v1/meeting-policy");
    expect(res.status).toBe(200);
    expect((await res.json() as { attendee_enforcement: string }).attendee_enforcement).toBe("not_declined");
  });

  it("returns the caller's own policy, not __default__", async () => {
    await env.DB.prepare("INSERT INTO config_meeting_policy (owner_subject, body) VALUES ('__default__', ?)")
      .bind(JSON.stringify({ attendee_enforcement: "not_declined" })).run();
    await env.DB.prepare("INSERT INTO config_meeting_policy (owner_subject, body) VALUES ('me@x', ?)")
      .bind(JSON.stringify({ attendee_enforcement: "accepted" })).run();
    const res = await authedGet("/v1/meeting-policy");
    expect(res.status).toBe(200);
    expect((await res.json() as { attendee_enforcement: string }).attendee_enforcement).toBe("accepted");
  });

  it("403s a subject-less token", async () => {
    await seedBearer("nosub-token", "");
    await env.DB.prepare(
      "UPDATE oauth_tokens SET subject = NULL WHERE client_id = 'test-client' AND hashed_token = ?",
    )
      .bind(await hashToken("nosub-token", env.TOKEN_HASH_PEPPER))
      .run();
    const res = await makeApp().request(
      "/v1/meeting-policy",
      { headers: { Authorization: "Bearer nosub-token" } },
      env,
    );
    expect(res.status).toBe(403);
  });
});
