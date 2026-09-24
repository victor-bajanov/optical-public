import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { OpenAPIHono } from "@hono/zod-openapi";
import { mountBusinessHoursRoute } from "../../src/planning/business-hours-route";
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

async function setBusinessHours(ownerSubject: string, body: unknown) {
  await env.DB.prepare(
    "INSERT OR REPLACE INTO config_business_hours (owner_subject, body) VALUES (?, ?)",
  )
    .bind(ownerSubject, JSON.stringify(body))
    .run();
}

function makeApp() {
  const v1 = new OpenAPIHono<{ Bindings: typeof env; Variables: AppVariables }>();
  mountBusinessHoursRoute(v1);
  const app = new Hono<{ Bindings: typeof env; Variables: AppVariables }>();
  app.route("/v1", v1);
  return app;
}

describe("GET /v1/business-hours", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM config_business_hours").run();
    await env.DB.prepare("DELETE FROM oauth_tokens").run();
    await seedBearer("fake", "me@x");
  });

  it("returns the caller's own business hours, not __default__", async () => {
    await setBusinessHours("__default__", { days: ["mon"], start: "09:00", end: "17:00" });
    await setBusinessHours("me@x", { days: ["tue", "wed"], start: "08:00", end: "12:00" });
    const res = await makeApp().request(
      "/v1/business-hours",
      { headers: { Authorization: "Bearer fake" } },
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { business_hours: { days: string[]; start: string; end: string } };
    expect(json.business_hours).toEqual({ days: ["tue", "wed"], start: "08:00", end: "12:00" });
  });

  it("falls back to __default__ when the caller has no own row", async () => {
    await setBusinessHours("__default__", { days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" });
    const res = await makeApp().request(
      "/v1/business-hours",
      { headers: { Authorization: "Bearer fake" } },
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { business_hours: { start: string } };
    expect(json.business_hours.start).toBe("09:00");
  });

  it("returns business_hours: null when neither row exists", async () => {
    const res = await makeApp().request(
      "/v1/business-hours",
      { headers: { Authorization: "Bearer fake" } },
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { business_hours: unknown };
    expect(json.business_hours).toBeNull();
  });

  it("403s a subject-less token", async () => {
    await seedBearer("nosub-token", "");
    await env.DB.prepare(
      "UPDATE oauth_tokens SET subject = NULL WHERE client_id = 'test-client' AND hashed_token = ?",
    )
      .bind(await hashToken("nosub-token", env.TOKEN_HASH_PEPPER))
      .run();
    const res = await makeApp().request(
      "/v1/business-hours",
      { headers: { Authorization: "Bearer nosub-token" } },
      env,
    );
    expect(res.status).toBe(403);
  });
});
