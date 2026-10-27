// Card C5: GET /v1/calendar-access-token hands out the user's raw provider
// credential, so it exists only where CALENDAR_RAW_TOKEN_ENABLED is exactly
// "true" (the smoke deployments, for the smoke harnesses). Anywhere else the route answers
// 404 not_found BEFORE auth, mirroring SELF_SERVE_DELETE_ENABLED: an
// unauthenticated caller and a valid raw-token bearer get the same answer, and
// no IdP fetch happens.
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { v1 as app } from "../../src/v1";
import { hashToken } from "../../src/auth/tokens";
import { hashingKey } from "../../src/auth/crypto-keys";
import { upsertUser } from "../../src/db/users";
import { storeIdentityTokens, dropCachedAccessToken } from "../../src/auth/identity-store";

const SUBJECT = "u@org";
const RAW = "scheduler:read scheduler:write calendar:raw-token";

async function seedBearer(token: string, scopes: string) {
  const h = await hashToken(token, hashingKey(env));
  await env.DB.prepare(
    `INSERT OR REPLACE INTO oauth_clients (id,name,type,redirect_uris,allowed_scopes,created_at) VALUES ('c','t','pkce',NULL,'${RAW}','2026-01-01')`,
  ).run();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO oauth_tokens (hashed_token,client_id,scopes,expires_at,refresh_of,revoked_at,subject) VALUES (?,?,?,?,?,?,?)`,
  ).bind(h, "c", scopes, "2099-01-01T00:00:00Z", null, null, SUBJECT).run();
}

function envWith(flag: string | undefined) {
  const e = { ...env } as Record<string, unknown>;
  if (flag === undefined) delete e.CALENDAR_RAW_TOKEN_ENABLED;
  else e.CALENDAR_RAW_TOKEN_ENABLED = flag;
  return e as unknown as typeof env;
}

function get(e: typeof env, token?: string) {
  return app.request(
    "/calendar-access-token",
    token ? { headers: { Authorization: `Bearer ${token}` } } : {},
    e,
  );
}

let fetchFn: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  for (const t of ["oauth_tokens", "oauth_clients", "users", "identity_tokens"])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  await upsertUser(env.DB, SUBJECT);
  await storeIdentityTokens(env, SUBJECT, { refreshToken: "r", accessToken: "a", expiresIn: 3600, scope: "s" });
  // Force any token read through the IdP so a leak past the gate is visible.
  await dropCachedAccessToken(env, SUBJECT);
  fetchFn = vi.fn(async () => new Response(JSON.stringify({ access_token: "at2", expires_in: 3599 })));
  vi.stubGlobal("fetch", fetchFn);
});

afterEach(() => vi.unstubAllGlobals());

describe("CALENDAR_RAW_TOKEN_ENABLED off: 404 before auth", () => {
  for (const flag of [undefined, "false", "TRUE", "1", ""]) {
    const label = flag === undefined ? "unset" : JSON.stringify(flag);

    it(`flag ${label}: unauthenticated GET is 404 not_found`, async () => {
      const res = await get(envWith(flag));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    });

    it(`flag ${label}: a valid raw-token bearer is 404 not_found and no IdP fetch happens`, async () => {
      await seedBearer("tok", RAW);
      const res = await get(envWith(flag), "tok");
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
      expect(fetchFn).not.toHaveBeenCalled();
    });
  }
});

describe('CALENDAR_RAW_TOKEN_ENABLED "true": today\'s behaviour', () => {
  const on = () => envWith("true");

  it("401 without a bearer", async () => {
    expect((await get(on())).status).toBe(401);
  });

  it("403 insufficient_scope without calendar:raw-token", async () => {
    await seedBearer("tok", "scheduler:read scheduler:write");
    const res = await get(on(), "tok");
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe("insufficient_scope");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("200 with the provider token for a raw-token bearer", async () => {
    await seedBearer("tok", RAW);
    const res = await get(on(), "tok");
    expect(res.status).toBe(200);
    expect((await res.json() as { access_token: string }).access_token).toBe("at2");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
