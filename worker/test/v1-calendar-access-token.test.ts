import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { v1 as app } from "../src/v1";
import { hashToken } from "../src/auth/tokens";
import { hashingKey } from "../src/auth/crypto-keys";
import { upsertUser } from "../src/db/users";
import { storeIdentityTokens, ACCESS_PREFIX } from "../src/auth/identity-store";

async function seedBearer(token: string, subject: string, scopes: string) {
  const h = await hashToken(token, hashingKey(env));
  await env.DB.prepare(
    `INSERT OR REPLACE INTO oauth_clients (id,name,type,redirect_uris,allowed_scopes,created_at) VALUES ('c','t','pkce',NULL,'scheduler:read scheduler:write calendar:raw-token','2026-01-01')`,
  ).run();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO oauth_tokens (hashed_token,client_id,scopes,expires_at,refresh_of,revoked_at,subject) VALUES (?,?,?,?,?,?,?)`,
  )
    .bind(h, "c", scopes, "2099-01-01T00:00:00Z", null, null, subject)
    .run();
}

beforeEach(async () => {
  for (const t of ["oauth_tokens", "oauth_clients", "users"])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  await upsertUser(env.DB, "u@org");
});

describe("GET /v1/calendar-access-token", () => {
  it("401 without bearer", async () => {
    expect((await app.request("/calendar-access-token", {}, env)).status).toBe(401);
  });

  it("403 insufficient_scope when the bearer lacks calendar:raw-token", async () => {
    await seedBearer("tok", "u@org", "scheduler:read scheduler:write");
    const res = await app.request(
      "/calendar-access-token",
      { headers: { Authorization: "Bearer tok" } },
      env,
    );
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe("insufficient_scope");
  });

  describe("provider-aware IdP selection", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("mints the token through the Microsoft IdP for a subject signed in with Microsoft", async () => {
      const msEnv = {
        ...env,
        MS_PROVIDER_ENABLED: "true",
        MICROSOFT_OAUTH_CLIENT_ID: "ms-client",
        MICROSOFT_OAUTH_CLIENT_SECRET: "ms-secret",
      };
      await storeIdentityTokens(
        msEnv, "u@org",
        { refreshToken: "r", accessToken: "a", expiresIn: 3600, scope: "s" },
        "microsoft",
      );
      // storeIdentityTokens caches the access token; delete it so getAccessToken
      // falls through to idp.refreshAccessToken and we can observe which IdP fired.
      await msEnv.GOOGLE_TOKEN_CACHE.delete(ACCESS_PREFIX + "u@org");
      await seedBearer("tok", "u@org", "scheduler:read scheduler:write calendar:raw-token");

      const fetchFn = vi.fn(async () => new Response(JSON.stringify({
        access_token: "at2", expires_in: 3599, refresh_token: "r2",
      })));
      vi.stubGlobal("fetch", fetchFn);

      const res = await app.request(
        "/calendar-access-token",
        { headers: { Authorization: "Bearer tok" } },
        msEnv,
      );
      expect(res.status).toBe(200);
      expect((await res.json() as { access_token: string }).access_token).toBe("at2");
      expect(fetchFn).toHaveBeenCalledTimes(1);
      const url = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
      expect(url).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/token");
    });
  });
});
