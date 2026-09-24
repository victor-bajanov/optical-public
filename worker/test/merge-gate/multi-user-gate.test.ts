import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { __setIdentityProviderForTests } from "../../src/auth/identity-provider";
import type { IdentityProvider } from "../../src/auth/identity-provider";
import { __setVerifierForTests, requireAccess } from "../../src/middleware/auth-access";
import { requireAdmin } from "../../src/middleware/admin-role";
import { upsertUser, getUser } from "../../src/db/users";
import { offboardUser } from "../../src/lifecycle/offboard";

function idp(email: string): IdentityProvider {
  return {
    scopes: ["s"],
    authorizeUrl: ({ state }) => `https://idp.test/auth?state=${state}`,
    exchangeCode: async () => ({ accessToken: "a", refreshToken: "r", expiresIn: 3600, scope: "s" }),
    fetchIdentity: async () => ({ email, providerSubject: `sub-${email}` }),
    refreshAccessToken: async () => ({ accessToken: "a", expiresIn: 3600 }),
  };
}

async function startLogin(): Promise<{ state: string; cookie: string }> {
  const u = new URL("https://x/oauth/authorize");
  Object.entries({ response_type: "code", client_id: "codemode", redirect_uri: "https://app.code-mode.example/cb",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256",
    scope: "scheduler:read", state: "client-state" }).forEach(([k, v]) => u.searchParams.set(k, v));
  const res = await SELF.fetch(u.toString(), { redirect: "manual" });
  const state = new URL(res.headers.get("location")!).searchParams.get("state")!;
  return { state, cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "" };
}

beforeEach(async () => {
  for (const t of ["users", "oauth_clients", "oauth_codes", "oauth_tokens", "identity_tokens", "tasks", "task_templates", "projects", "proposed_plans", "calendar_sync", "audit_log"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
  await env.DB.prepare("INSERT INTO oauth_clients (id, name, type, redirect_uris, created_at) VALUES (?,?,?,?,?)")
    .bind("codemode", "Code Mode", "pkce", JSON.stringify(["https://app.code-mode.example/cb"]), "2026-01-01T00:00:00Z").run();
});
afterEach(() => { __setIdentityProviderForTests(null); __setVerifierForTests(null); });

describe("MERGE GATE: multi-user identity boundary", () => {
  it("(i) rejects a non-member email at login (no code, no identity, no user)", async () => {
    __setIdentityProviderForTests(idp("stranger@notallowed.com"));
    const { state, cookie } = await startLogin();
    const res = await SELF.fetch(`https://x/auth/callback?code=g&state=${state}`,
      { redirect: "manual", headers: { cookie } });
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>()).toMatchObject({ n: 0 });
  });

  it("(ii) a member is blocked from an instance-config admin route; an admin is allowed", async () => {
    await upsertUser(env.DB, "member@org");
    await upsertUser(env.DB, "boss@org", "admin");
    const app = new Hono();
    app.get("/admin/instance-config", requireAccess, requireAdmin, (c) => c.json({ ok: true }));

    __setVerifierForTests(async () => ({ payload: { email: "member@org" } }));
    const denied = await app.request("/admin/instance-config", { headers: { "cf-access-jwt-assertion": "s" } }, env);
    expect(denied.status).toBe(403);

    __setVerifierForTests(async () => ({ payload: { email: "boss@org" } }));
    const allowed = await app.request("/admin/instance-config", { headers: { "cf-access-jwt-assertion": "s" } }, env);
    expect(allowed.status).toBe(200);
  });

  it("(iii) offboarding removes all of a user's stores AND stops their webhook channel", async () => {
    const SUBJECT = "leaver@org";
    await upsertUser(env.DB, SUBJECT);
    await env.DB.prepare("INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?,?,?,?,?,?)")
      .bind("t1", SUBJECT, "{}", "pending", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z").run();
    await env.DB.prepare("INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url) VALUES (?,?,?,?,?,?,?,?)")
      .bind(SUBJECT, "primary", null, "chan-Z", "tok", "2099-01-01T00:00:00Z", "res-Z", "https://cb").run();

    const stopped: Array<{ channelId: string; resourceId: string }> = [];
    await offboardUser(env, SUBJECT, "boss@org", {
      calendarFor: () => ({ stopChannel: async (channelId: string, resourceId: string) => { stopped.push({ channelId, resourceId }); } }) as any,
    });

    expect(stopped).toEqual([{ channelId: "chan-Z", resourceId: "res-Z" }]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM tasks WHERE owner_subject = ?").bind(SUBJECT).first<{ n: number }>()).toMatchObject({ n: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM calendar_sync WHERE owner_subject = ?").bind(SUBJECT).first<{ n: number }>()).toMatchObject({ n: 0 });
    expect((await getUser(env.DB, SUBJECT))?.is_active).toBe(0);
  });

  it("(iv) the CSRF binding rejects a callback whose nonce cookie does not match the state", async () => {
    __setIdentityProviderForTests(idp("operator@example.com"));
    const attacker = await startLogin();
    const victim = await startLogin();
    const res = await SELF.fetch(`https://x/auth/callback?code=g&state=${victim.state}`,
      { redirect: "manual", headers: { cookie: attacker.cookie } });
    expect(res.status).toBe(400);
  });
});
