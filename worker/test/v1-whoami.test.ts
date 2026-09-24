import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { v1 as app } from "../src/v1";
import { hashToken } from "../src/auth/tokens";
import { hashingKey } from "../src/auth/crypto-keys";
import { upsertUser } from "../src/db/users";
import { storeIdentityTokens } from "../src/auth/identity-store";

async function seedBearer(token: string, subject: string, scopes = "scheduler:read scheduler:write") {
  const h = await hashToken(token, hashingKey(env));
  await env.DB.prepare(
    `INSERT OR REPLACE INTO oauth_clients (id, name, type, redirect_uris, allowed_scopes, created_at) VALUES ('c','t','pkce',NULL,'scheduler:read scheduler:write','2026-01-01')`,
  ).run();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO oauth_tokens (hashed_token, client_id, scopes, expires_at, refresh_of, revoked_at, subject) VALUES (?,?,?,?,?,?,?)`,
  ).bind(h, "c", scopes, "2099-01-01T00:00:00Z", null, null, subject).run();
}

// Seeds a bearer whose oauth_tokens row carries no subject — the
// client-credentials case requireSubject rejects with 403 no_subject.
async function seedSubjectlessBearer(token: string, scopes = "scheduler:read") {
  const h = await hashToken(token, hashingKey(env));
  await env.DB.prepare(
    `INSERT OR REPLACE INTO oauth_clients (id, name, type, redirect_uris, allowed_scopes, created_at) VALUES ('c-no-subject','t','client_credentials',NULL,'scheduler:read','2026-01-01')`,
  ).run();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO oauth_tokens (hashed_token, client_id, scopes, expires_at, refresh_of, revoked_at, subject) VALUES (?,?,?,?,?,?,?)`,
  ).bind(h, "c-no-subject", scopes, "2099-01-01T00:00:00Z", null, null, null).run();
}

beforeEach(async () => {
  for (const t of ["oauth_tokens", "oauth_clients", "users", "identity_tokens"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
});

interface WhoamiResponse {
  email: string;
  home_tz: string;
  provider: "google" | "microsoft";
}

describe("GET /v1/whoami", () => {
  it("401 without a bearer", async () => {
    expect((await app.request("/whoami", {}, env)).status).toBe(401);
  });

  it("403 when the bearer carries no subject", async () => {
    await seedSubjectlessBearer("tok-no-subject");
    const res = await app.request("/whoami", { headers: { Authorization: "Bearer tok-no-subject" } }, env);
    expect(res.status).toBe(403);
  });

  it("returns the caller's email + effective home_tz", async () => {
    await upsertUser(env.DB, "u@org");
    await seedBearer("tok", "u@org");
    const res = await app.request("/whoami", { headers: { Authorization: "Bearer tok" } }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WhoamiResponse;
    expect(body.email).toBe("u@org");
    expect(typeof body.home_tz).toBe("string");
  });

  it("returns provider:google for a subject with no identity_tokens row (legacy/pre-provisioned default)", async () => {
    await upsertUser(env.DB, "u-nrow@org");
    await seedBearer("tok-nrow", "u-nrow@org");
    const res = await app.request("/whoami", { headers: { Authorization: "Bearer tok-nrow" } }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WhoamiResponse;
    expect(body.provider).toBe("google");
  });

  it("returns provider:google for a subject provisioned via storeIdentityTokens(... 'google')", async () => {
    await upsertUser(env.DB, "u-google@org");
    await seedBearer("tok-google", "u-google@org");
    await storeIdentityTokens(
      env,
      "u-google@org",
      { refreshToken: "r", accessToken: "at", expiresIn: 3600, scope: "s" },
      "google",
    );
    const res = await app.request("/whoami", { headers: { Authorization: "Bearer tok-google" } }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WhoamiResponse;
    expect(body.provider).toBe("google");
  });

  it("returns provider:microsoft for a Microsoft-provisioned subject", async () => {
    await upsertUser(env.DB, "u-ms@org");
    await seedBearer("tok-ms", "u-ms@org");
    await storeIdentityTokens(
      env,
      "u-ms@org",
      { refreshToken: "r", accessToken: "at", expiresIn: 3600, scope: "s" },
      "microsoft",
    );
    const res = await app.request("/whoami", { headers: { Authorization: "Bearer tok-ms" } }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WhoamiResponse;
    expect(body.email).toBe("u-ms@org");
    expect(body.provider).toBe("microsoft");
  });
});
