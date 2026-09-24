import { Hono } from "hono";
import { renderProviderChooserPage } from "../web/provider-chooser-page";
import type { Context } from "hono";
import type { Env } from "../env";
import { requireBearer } from "../middleware/auth-bearer";
import { generateAuthCode, generateOpaqueToken, hashToken } from "./tokens";
import { defaultIdentityProvider, enabledProviders } from "../index-providers";
import { storeIdentityTokens, resolveSubject } from "./identity-store";
import { isProviderName } from "../providers/provider-name";
import type { ProviderName } from "../providers/provider-name";
import { isMember, csv } from "./membership";
import { upsertUser, touchLastSeen, getUser, seedDoneColorIdIfUnset } from "../db/users";
import { OPTICAL_DONE_CATEGORY } from "../providers/graph-event-mapping";
import { hashingKey, capabilityHmacKey } from "./crypto-keys";
import { intersectClientScopes, applyRoleEntitlement } from "./scope-policy";
import { timingSafeEqual } from "./timing-safe";

const LOGIN_PREFIX = "login:";
const CALLBACK_PATH = "/auth/callback";

const NONCE_COOKIE = "__Host-login_nonce";

function b64urlBytes(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// HMAC(loginState) keyed by the capability/CSRF key. The cookie carries this so
// /auth/callback can prove the browser that returns is the one that started.
async function stateNonce(loginState: string, key: string): Promise<string> {
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`login-csrf:${key}`));
  const k = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(loginState));
  return b64urlBytes(new Uint8Array(sig));
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

const ACCESS_TOKEN_TTL_SECONDS = 3600;
// Refresh tokens are long-lived: 90 days.
const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 90;

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let s = btoa(String.fromCharCode(...new Uint8Array(digest)));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function issueTokens(env: Env, clientId: string, scopes: string, subject: string | null): Promise<{ access: string; refresh: string; expires_in: number }> {
  const access = generateOpaqueToken();
  const refresh = generateOpaqueToken();
  const accessHash = await hashToken(access, hashingKey(env));
  const refreshHash = await hashToken(refresh, hashingKey(env));
  const now = Date.now();
  const accessExpiry = new Date(now + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString();
  const refreshExpiry = new Date(now + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO oauth_tokens (hashed_token, client_id, scopes, expires_at, refresh_of, revoked_at, subject) VALUES (?,?,?,?,?,?,?)`,
    ).bind(accessHash, clientId, scopes, accessExpiry, null, null, subject),
    env.DB.prepare(
      `INSERT INTO oauth_tokens (hashed_token, client_id, scopes, expires_at, refresh_of, revoked_at, subject) VALUES (?,?,?,?,?,?,?)`,
    ).bind(refreshHash, clientId, scopes, refreshExpiry, accessHash, null, subject),
  ]);
  return { access, refresh, expires_in: ACCESS_TOKEN_TTL_SECONDS };
}

export const oauthProviderApp = new Hono<{ Bindings: Env }>();

interface ClientRow { id: string; name: string; type: string; redirect_uris: string | null; allowed_scopes: string }

async function loadClient(env: Env, id: string): Promise<ClientRow | null> {
  return await env.DB.prepare(
    "SELECT id, name, type, redirect_uris, allowed_scopes FROM oauth_clients WHERE id = ?",
  ).bind(id).first<ClientRow>();
}

/**
 * Narrow a client's REQUESTED scopes to what may actually be granted to
 * `subject`: intersect with the client's allowed_scopes (fail loud if any
 * requested scope is outside it), then drop `admin` unless the subject is an
 * admin. Returns the space-joined grant, or { ok:false } for a client-capability
 * violation (caller should redirect back with error=invalid_scope).
 */
export async function narrowScopesForGrant(
  env: Env, clientId: string, requestedScope: string, subject: string,
): Promise<{ ok: true; scopes: string } | { ok: false }> {
  const client = await loadClient(env, clientId);
  const clientAllowed = (client?.allowed_scopes ?? "").split(" ").filter(Boolean);
  const requested = requestedScope.split(" ").filter(Boolean);
  const afterClient = intersectClientScopes(requested, clientAllowed);
  if (afterClient === null) return { ok: false };
  const isAdmin = (await getUser(env.DB, subject))?.role === "admin";
  return { ok: true, scopes: applyRoleEntitlement(afterClient, isAdmin).join(" ") };
}

oauthProviderApp.get("/authorize", async (c) => {
  const q = c.req.query();
  if (q.response_type !== "code") return c.json({ error: "unsupported_response_type" }, 400);
  if (!q.client_id) return c.json({ error: "missing_client_id" }, 400);
  if (!q.redirect_uri) return c.json({ error: "missing_redirect_uri" }, 400);
  if (q.code_challenge_method !== "S256") return c.json({ error: "code_challenge_method_must_be_S256" }, 400);
  if (!q.code_challenge) return c.json({ error: "missing_code_challenge" }, 400);
  if (!q.state) return c.json({ error: "missing_state" }, 400);
  if (!q.scope) return c.json({ error: "missing_scope" }, 400);

  const client = await loadClient(c.env, q.client_id);
  if (!client || client.type !== "pkce") return c.json({ error: "unknown_client" }, 400);
  const allowed = client.redirect_uris ? (JSON.parse(client.redirect_uris) as string[]) : [];
  if (!allowed.includes(q.redirect_uri)) return c.json({ error: "redirect_uri_not_allowed" }, 400);

  const offered = enabledProviders(c.env);
  const requestedProvider = q.provider ?? "google";
  if (!isProviderName(requestedProvider) || !offered.includes(requestedProvider)) {
    return c.json({ error: "unknown_provider" }, 400);
  }
  if (!q.provider && offered.length > 1) {
    // Provider chooser: re-enter this route with ?provider= appended, all
    // OAuth params intact. Plain HTML — no client JS.
    const here = new URL(c.req.url);
    const link = (p: string) => {
      const u = new URL(here);
      u.searchParams.set("provider", p);
      return `${u.pathname}${u.search}`;
    };
    // The links carry the client's OAuth state and PKCE challenge: never cache,
    // never index, never frame (same posture as the reveal/dev-ui HTML routes).
    return c.html(renderProviderChooserPage({ google: link("google"), microsoft: link("microsoft") }), 200, {
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "X-Robots-Tag": "noindex",
    });
  }

  const loginState = generateOpaqueToken();
  await c.env.GOOGLE_TOKEN_CACHE.put(
    LOGIN_PREFIX + loginState,
    JSON.stringify({
      client_id: q.client_id, redirect_uri: q.redirect_uri,
      code_challenge: q.code_challenge, scope: q.scope, client_state: q.state,
      provider: requestedProvider,
    }),
    { expirationTtl: 600 },
  );

  const idp = defaultIdentityProvider(c.env, requestedProvider);
  const redirectUri = new URL(CALLBACK_PATH, c.env.OAUTH_ISSUER).toString();
  const nonce = await stateNonce(loginState, capabilityHmacKey(c.env));
  // __Host- prefix forces Secure + Path=/ + no Domain; HttpOnly + SameSite=Lax
  // so the cookie rides the top-level redirect back from the IdP. 600s matches
  // the KV login TTL.
  c.header("Set-Cookie",
    `${NONCE_COOKIE}=${nonce}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`);
  return c.redirect(idp.authorizeUrl({ state: loginState, redirectUri }), 302);
});

// Mounted at /auth/callback in index.ts. Public: security is the single-use
// login state + the IdP login itself.
export async function handleAuthCallback(c: Context<{ Bindings: Env }>): Promise<Response> {
  const code = c.req.query("code");
  const loginState = c.req.query("state");
  if (!code || !loginState) return c.html("<p>Missing code or state.</p>", 400);

  const parkedRaw = await c.env.GOOGLE_TOKEN_CACHE.get(LOGIN_PREFIX + loginState);
  if (!parkedRaw) return c.html("<p>Login expired or invalid. Please start again.</p>", 400);
  await c.env.GOOGLE_TOKEN_CACHE.delete(LOGIN_PREFIX + loginState);

  // CSRF binding (Plan 4 brief F): the browser that returns must present the
  // nonce cookie set at /authorize, bound to THIS loginState. Without it an
  // attacker could feed a victim their own state+code (login fixation).
  const presentedNonce = readCookie(c.req.header("cookie"), NONCE_COOKIE);
  const expectedNonce = await stateNonce(loginState, capabilityHmacKey(c.env));
  if (!presentedNonce || !timingSafeEqual(presentedNonce, expectedNonce)) {
    return c.html("<p>Login session mismatch. Please start again.</p>", 400);
  }

  const parked = JSON.parse(parkedRaw) as {
    client_id: string; redirect_uri: string; code_challenge: string; scope: string; client_state: string;
    provider?: string;
  };
  const provider: ProviderName = isProviderName(parked.provider ?? "") ? (parked.provider as ProviderName) : "google";

  const back = (params: Record<string, string>) => {
    const u = new URL(parked.redirect_uri);
    Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
    return c.redirect(u.toString(), 302);
  };

  let subject: string;
  try {
    // Inside the try: with the Microsoft kill switch flipped off mid-login the
    // factory throws ms_provider_disabled, and the browser must still get a
    // redirect back to the client (the parked state is already consumed).
    const idp = defaultIdentityProvider(c.env, provider);
    const redirectUri = new URL(CALLBACK_PATH, c.env.OAUTH_ISSUER).toString();
    const tokens = await idp.exchangeCode(code, redirectUri);
    let email: string;
    let providerSubject: string;
    ({ email, providerSubject } = await idp.fetchIdentity(tokens.accessToken, { idToken: tokens.idToken }));
    // Normalise ONCE, here: every downstream key (identity_tokens, users,
    // oauth_codes.subject, calendar_sync owner) is the raw string with no
    // COLLATE NOCASE, and Entra echoes a UPN in its stored casing — without
    // this a mixed-case login misses the existing row and provisions a
    // duplicate user (and the provider-switch reset never fires).
    email = email.trim().toLowerCase();
    // Anchor on the IdP's immutable subject, not the (mutable) email: a row
    // already keyed by (provider, providerSubject) wins and keeps its
    // original account_email as `subject` for life, even if the token's
    // email has since changed (renamed UPN, domain consolidation, ...). No
    // match (first sign-in, or a legacy pre-0037 row) falls back to the
    // token's email. Everything downstream — membership, token store, users
    // touch, done-colour seed, the minted code's subject — uses `subject`,
    // never the raw token email.
    subject = await resolveSubject(c.env, provider, providerSubject, email);
    // Plan 4 membership gate (replaces the OPERATOR_EMAIL allow-list). Only a
    // member (allow-list match, OPERATOR_EMAIL seed admin, or existing active
    // user) may complete login. Checked against `subject` so a renamed-but-
    // existing active user passes via the existing-user branch even if their
    // new email isn't allow-listed; a brand-new user (subject === email) is
    // still gated by allow-list on their email, unchanged.
    if (!(await isMember(subject, c.env))) return back({ error: "access_denied", state: parked.client_state });
    await storeIdentityTokens(c.env, subject, tokens, provider, providerSubject);
    // Seed/touch the canonical users row. An OPERATOR_EMAIL identity becomes the
    // initial admin; everyone else is a member. touchLastSeen keeps role intact
    // for returning users.
    const isSeedAdmin = csv(c.env.OPERATOR_EMAIL).includes(subject.trim().toLowerCase());
    if (isSeedAdmin) {
      await upsertUser(c.env.DB, subject, "admin");
    } else {
      await touchLastSeen(c.env.DB, subject);
    }
    // Microsoft has no numeric colorId (Outlook uses categories), so the
    // env-level DONE_COLOR_ID default is meaningless for these users — seed
    // their done_color_id to the Optical Done category so done-marking works
    // out of the box. Only if unset, so it never clobbers a value the user (or
    // an earlier login) already set.
    if (provider === "microsoft") {
      await seedDoneColorIdIfUnset(c.env.DB, subject, OPTICAL_DONE_CATEGORY);
    }
  } catch (err) {
    // The browser only ever sees an opaque server_error; without this line the
    // cause (IdP exchange, Graph /me, D1) is unrecoverable from logs.
    console.error(`auth_callback_failed provider=${provider} err=${err instanceof Error ? err.message : String(err)}`);
    return back({ error: "server_error", state: parked.client_state });
  }

  // Narrow the requested scopes to what this client+subject may be granted.
  // A client-capability violation fails loud; admin is silently downscoped
  // for non-admins (see scope-policy.ts).
  const narrowed = await narrowScopesForGrant(c.env, parked.client_id, parked.scope, subject);
  if (!narrowed.ok) return back({ error: "invalid_scope", state: parked.client_state });
  const grantedScopes = narrowed.scopes;

  const opticalCode = generateAuthCode();
  const codeHash = await hashToken(opticalCode, hashingKey(c.env));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await c.env.DB.prepare(
    `INSERT INTO oauth_codes (code_hash, client_id, kind, user_code, pkce_challenge, pkce_method, redirect_uri, scopes, expires_at, authorized_at, used_at, subject)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(codeHash, parked.client_id, "auth", null, parked.code_challenge, "S256", parked.redirect_uri, grantedScopes, expiresAt, new Date().toISOString(), null, subject).run();

  return back({ code: opticalCode, state: parked.client_state });
}

oauthProviderApp.post("/token", async (c) => {
  const ct = c.req.header("content-type") ?? "";
  if (!ct.startsWith("application/x-www-form-urlencoded")) return c.json({ error: "invalid_request", error_description: "form encoding required" }, 400);
  const form = await c.req.parseBody();
  const grant = form.grant_type;

  if (grant === "authorization_code") {
    const code = String(form.code ?? "");
    const clientId = String(form.client_id ?? "");
    const redirectUri = String(form.redirect_uri ?? "");
    const verifier = String(form.code_verifier ?? "");
    if (!code || !clientId || !redirectUri || !verifier) return c.json({ error: "invalid_request" }, 400);

    const codeHash = await hashToken(code, hashingKey(c.env));
    const row = await c.env.DB.prepare(
      `SELECT client_id, kind, pkce_challenge, redirect_uri, scopes, expires_at, used_at, authorized_at, subject FROM oauth_codes WHERE code_hash = ?`,
    ).bind(codeHash).first<{
      client_id: string; kind: string; pkce_challenge: string | null; redirect_uri: string | null;
      scopes: string; expires_at: string; used_at: string | null; authorized_at: string | null;
      subject: string | null;
    }>();
    if (!row) return c.json({ error: "invalid_grant" }, 400);
    if (row.used_at) return c.json({ error: "invalid_grant", error_description: "code reused" }, 400);
    if (row.client_id !== clientId) return c.json({ error: "invalid_grant" }, 400);
    if (row.kind !== "auth") return c.json({ error: "invalid_grant" }, 400);
    if (row.redirect_uri !== redirectUri) return c.json({ error: "invalid_grant" }, 400);
    if (row.expires_at < new Date().toISOString()) return c.json({ error: "invalid_grant", error_description: "expired" }, 400);
    if (!row.pkce_challenge || (await s256(verifier)) !== row.pkce_challenge) {
      return c.json({ error: "invalid_grant", error_description: "pkce mismatch" }, 400);
    }

    // Atomic single-use gate: only one concurrent /token request can flip used_at
    // from NULL. If 0 rows change, the code was already consumed by a racing
    // request → reject before issuing tokens. (The earlier `if (row.used_at)`
    // check is a cheap fast-path; this CAS is the actual serialization point.)
    const consume = await c.env.DB
      .prepare(`UPDATE oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL`)
      .bind(new Date().toISOString(), codeHash)
      .run();
    if (((consume.meta?.changes ?? 0)) !== 1) {
      return c.json({ error: "invalid_grant", error_description: "code reused" }, 400);
    }
    const t = await issueTokens(c.env, clientId, row.scopes, row.subject);
    return c.json({
      access_token: t.access,
      refresh_token: t.refresh,
      token_type: "Bearer",
      expires_in: t.expires_in,
      scope: row.scopes,
    });
  }

  if (grant === "refresh_token") {
    const presented = String(form.refresh_token ?? "");
    const clientId = String(form.client_id ?? "");
    if (!presented || !clientId) return c.json({ error: "invalid_request" }, 400);
    const presentedHash = await hashToken(presented, hashingKey(c.env));
    const row = await c.env.DB.prepare(
      `SELECT client_id, scopes, expires_at, refresh_of, revoked_at, subject FROM oauth_tokens WHERE hashed_token = ?`,
    ).bind(presentedHash).first<{
      client_id: string; scopes: string; expires_at: string | null; refresh_of: string | null; revoked_at: string | null;
      subject: string | null;
    }>();
    if (!row) return c.json({ error: "invalid_grant" }, 400);
    if (!row.refresh_of) return c.json({ error: "invalid_grant", error_description: "not a refresh token" }, 400);
    if (row.revoked_at) return c.json({ error: "invalid_grant", error_description: "revoked" }, 400);
    if (row.client_id !== clientId) return c.json({ error: "invalid_grant" }, 400);
    if (row.expires_at && row.expires_at < new Date().toISOString()) return c.json({ error: "invalid_grant", error_description: "expired" }, 400);

    // Rotate: revoke the presented refresh + its access; issue new pair.
    const now = new Date().toISOString();
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE oauth_tokens SET revoked_at = ? WHERE hashed_token = ?`).bind(now, presentedHash),
      c.env.DB.prepare(`UPDATE oauth_tokens SET revoked_at = ? WHERE hashed_token = ?`).bind(now, row.refresh_of),
    ]);
    const t = await issueTokens(c.env, clientId, row.scopes, row.subject);
    return c.json({
      access_token: t.access,
      refresh_token: t.refresh,
      token_type: "Bearer",
      expires_in: t.expires_in,
      scope: row.scopes,
    });
  }

  return c.json({ error: "unsupported_grant_type" }, 400);
});

oauthProviderApp.post("/revoke", async (c) => {
  const ct = c.req.header("content-type") ?? "";
  if (!ct.startsWith("application/x-www-form-urlencoded")) return c.json({ error: "invalid_request" }, 400);
  const form = await c.req.parseBody();
  const token = String(form.token ?? "");
  if (!token) return c.json({ error: "invalid_request" }, 400);
  const hashed = await hashToken(token, hashingKey(c.env));
  await c.env.DB.prepare(
    `UPDATE oauth_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE hashed_token = ?`,
  ).bind(new Date().toISOString(), hashed).run();
  return c.json({ ok: true });
});

oauthProviderApp.get("/userinfo", requireBearer, async (c) => {
  const subject = c.get("subject" as never) as string | undefined;
  const sub = subject ?? (c.get("clientId" as never) as string);
  return c.json(subject ? { sub, email: subject } : { sub });
});
