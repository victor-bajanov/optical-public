import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { v1 as app } from "../src/v1";
import { hashToken } from "../src/auth/tokens";
import { hashingKey } from "../src/auth/crypto-keys";
import { upsertUser } from "../src/db/users";
import { storeIdentityTokens } from "../src/auth/identity-store";
import { MicrosoftCalendarProvider } from "../src/providers/microsoft-calendar-provider";
import { MicrosoftGraphNotificationProvider } from "../src/providers/microsoft-graph-notification-provider";
import * as googleCalendarWebhook from "../src/webhooks/google-calendar";

async function seedBearer(token: string, subject: string, scopes = "scheduler:read scheduler:write") {
  const h = await hashToken(token, hashingKey(env));
  await env.DB.prepare(
    `INSERT OR REPLACE INTO oauth_clients (id, name, type, redirect_uris, allowed_scopes, created_at) VALUES ('c','t','pkce',NULL,'scheduler:read scheduler:write','2026-01-01')`,
  ).run();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO oauth_tokens (hashed_token, client_id, scopes, expires_at, refresh_of, revoked_at, subject) VALUES (?,?,?,?,?,?,?)`,
  ).bind(h, "c", scopes, "2099-01-01T00:00:00Z", null, null, subject).run();
}

beforeEach(async () => {
  for (const t of ["oauth_tokens", "oauth_clients", "users"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /v1/replan-now", () => {
  it("401 without bearer", async () => {
    const res = await app.request("/replan-now", { method: "POST" }, env);
    expect(res.status).toBe(401);
  });

  it("resolves a microsoft caller to Microsoft providers on the real (non-injected) wiring path", async () => {
    const msEnv = { ...env, MS_PROVIDER_ENABLED: "true", MICROSOFT_OAUTH_CLIENT_ID: "x", MICROSOFT_OAUTH_CLIENT_SECRET: "y" };
    await upsertUser(env.DB, "ms-caller@example.com");
    await seedBearer("tok", "ms-caller@example.com");
    await storeIdentityTokens(
      msEnv,
      "ms-caller@example.com",
      { refreshToken: "r", accessToken: "a", expiresIn: 3600, scope: "s" },
      "microsoft",
    );
    const spy = vi
      .spyOn(googleCalendarWebhook, "runWebhookReplan")
      .mockResolvedValue({ kind: "no_diff" });

    const res = await app.request(
      "/replan-now",
      { method: "POST", headers: { Authorization: "Bearer tok" } },
      msEnv,
    );

    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledOnce();
    const call = spy.mock.calls[0]![0];
    expect(call.calendar).toBeInstanceOf(MicrosoftCalendarProvider);
    expect(call.notify).toBeInstanceOf(MicrosoftGraphNotificationProvider);
  });
});
