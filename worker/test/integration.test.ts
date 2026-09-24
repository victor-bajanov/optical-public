import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { __setIdentityProviderForTests } from "../src/auth/identity-provider";
import type { IdentityProvider } from "../src/auth/identity-provider";

const mockIdp: IdentityProvider = {
  scopes: ["s"],
  authorizeUrl: ({ state }) => `https://idp.test/auth?state=${state}`,
  exchangeCode: async () => ({ accessToken: "a", refreshToken: "r", expiresIn: 3600, scope: "s" }),
  fetchIdentity: async () => ({ email: "operator@example.com", providerSubject: "sub-operator" }),
  refreshAccessToken: async () => ({ accessToken: "a", expiresIn: 3600 }),
};

const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

async function fullLogin(scope: string, clientState = "s"): Promise<string> {
  const a = new URL("https://x/oauth/authorize");
  Object.entries({
    response_type: "code", client_id: "codemode", redirect_uri: "https://cb.test/cb",
    code_challenge: CHALLENGE, code_challenge_method: "S256", scope, state: clientState,
  }).forEach(([k, v]) => a.searchParams.set(k, v));
  const r1 = await SELF.fetch(a.toString(), { redirect: "manual" });
  const state = new URL(r1.headers.get("location")!).searchParams.get("state")!;
  // Forward the nonce cookie set by /authorize so the CSRF check in /auth/callback passes.
  const nonceCookie = (r1.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const r2 = await SELF.fetch(`https://x/auth/callback?code=g&state=${state}`,
    { redirect: "manual", headers: nonceCookie ? { cookie: nonceCookie } : {} });
  return new URL(r2.headers.get("location")!).searchParams.get("code")!;
}

beforeAll(() => __setIdentityProviderForTests(mockIdp));
afterAll(() => __setIdentityProviderForTests(null));

beforeEach(async () => {
  for (const t of ["oauth_codes", "oauth_tokens", "oauth_clients", "tasks", "identity_tokens"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
  await env.DB.prepare(
    "INSERT INTO oauth_clients (id, name, type, redirect_uris, created_at) VALUES (?,?,?,?,?)",
  ).bind("codemode", "Code Mode", "pkce", JSON.stringify(["https://cb.test/cb"]), "2026-01-01T00:00:00Z").run();
});

describe("end-to-end auth + CRUD", () => {
  it("authorize → token → create task → list", async () => {
    const code = await fullLogin("scheduler:read scheduler:write");

    const tokRes = await SELF.fetch("https://x/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code, client_id: "codemode",
        redirect_uri: "https://cb.test/cb",
        code_verifier: VERIFIER,
      }),
    });
    const { access_token } = (await tokRes.json()) as { access_token: string };

    const create = await SELF.fetch("https://x/v1/tasks", {
      method: "POST",
      headers: { Authorization: `Bearer ${access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "smoke", context: "admin", priority: 10, duration_minutes: 15 }),
    });
    expect(create.status).toBe(201);

    const list = await SELF.fetch("https://x/v1/tasks", { headers: { Authorization: `Bearer ${access_token}` } });
    const body = (await list.json()) as { tasks: Array<{ title: string }> };
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0]!.title).toBe("smoke");
  });
});
