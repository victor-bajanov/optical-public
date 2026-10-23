import { Hono } from "hono";
import { renderProviderChooserPage } from "../web/provider-chooser-page";
import { renderSignInRefusedPage } from "../web/sign-in-refused-page";
import { revokeUpstreamGrant, upstreamRevokeEnabled } from "./upstream-revoke";
import { missingProductScopes, requireExactProviderScopes, scopeLabel } from "./scope-check";
import { debugLog } from "../log";
import { signInSubscriber } from "../webhooks/sign-in-subscribe";
import type { Context } from "hono";
import type { Env } from "../env";
import type { IdentityProvider, UpstreamTokens } from "./identity-provider";
import { requireBearer } from "../middleware/auth-bearer";
import { generateAuthCode, generateOpaqueToken, hashToken } from "./tokens";
import { defaultIdentityProvider, enabledProviders } from "../index-providers";
import { storeIdentityTokens, resolveSubject, hasStoredGrant, ProviderRebindRefusedError } from "./identity-store";
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

/** Mint and store a new access + refresh pair. `pre` statements run first in
 *  the same D1 batch (one transaction), so a write that must stand or fall
 *  with the new pair (refresh rotation's paired-access revoke) can't commit
 *  without it. */
async function issueTokens(
  env: Env, clientId: string, scopes: string, subject: string | null, pre: D1PreparedStatement[] = [],
): Promise<{ access: string; refresh: string; expires_in: number }> {
  const access = generateOpaqueToken();
  const refresh = generateOpaqueToken();
  const accessHash = await hashToken(access, hashingKey(env));
  const refreshHash = await hashToken(refresh, hashingKey(env));
  const now = Date.now();
  const accessExpiry = new Date(now + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString();
  const refreshExpiry = new Date(now + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString();
  await env.DB.batch([
    ...pre,
    env.DB.prepare(
      `INSERT INTO oauth_tokens (hashed_token, client_id, scopes, expires_at, refresh_of, revoked_at, subject) VALUES (?,?,?,?,?,?,?)`,
    ).bind(accessHash, clientId, scopes, accessExpiry, null, null, subject),
    env.DB.prepare(
      `INSERT INTO oauth_tokens (hashed_token, client_id, scopes, expires_at, refresh_of, revoked_at, subject) VALUES (?,?,?,?,?,?,?)`,
    ).bind(refreshHash, clientId, scopes, refreshExpiry, accessHash, null, subject),
  ]);
  return { access, refresh, expires_in: ACCESS_TOKEN_TTL_SECONDS };
}

/** Why the refresh grant refused a request. Fixed vocabulary for the
 *  `oauth_refresh_refused` log line (runbook §S "Single-use refresh rotation"). */
type RefreshRefusal =
  | "missing_params" | "unknown_token" | "not_refresh_token" | "revoked"
  | "client_mismatch" | "expired" | "not_member" | "lost_race";

// client_id is caller-supplied and unvalidated on some paths; cap it so a huge
// form field can't bloat the log.
const LOGGED_CLIENT_ID_MAX = 64;

/** One line per refused refresh: the reason and the PRESENTED client_id only.
 *  Never token material (plaintext or hash), the subject or an email. */
function logRefreshRefused(reason: RefreshRefusal, clientId: string): void {
  console.warn("oauth_refresh_refused", { reason, client_id: clientId.slice(0, LOGGED_CLIENT_ID_MAX) });
}

export const oauthProviderApp = new Hono<{ Bindings: Env }>();

interface ClientRow { id: string; name: string; type: string; redirect_uris: string | null; allowed_scopes: string }

async function loadClient(env: Env, id: string): Promise<ClientRow | null> {
  return await env.DB.prepare(
    "SELECT id, name, type, redirect_uris, allowed_scopes FROM oauth_clients WHERE id = ?",
  ).bind(id).first<ClientRow>();
}

/** The client-capability half of narrowScopesForGrant: the requested scopes
 *  when every one is in the client's allowed_scopes, else null. Subject-free,
 *  so the callback runs it before the IdP exchange too. */
async function clientPermittedScopes(env: Env, clientId: string, requestedScope: string): Promise<string[] | null> {
  const client = await loadClient(env, clientId);
  const clientAllowed = (client?.allowed_scopes ?? "").split(" ").filter(Boolean);
  return intersectClientScopes(requestedScope.split(" ").filter(Boolean), clientAllowed);
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
  const afterClient = await clientPermittedScopes(env, clientId, requestedScope);
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
  // A configured PRIVACY_URL (hosted trial) makes the chooser render even with
  // one provider: it carries the in-app disclosure before consent. Unset, a
  // Google-only deployment keeps its straight 302 (prod parity).
  const disclose = (c.env.PRIVACY_URL ?? "").trim().length > 0;
  if (!q.provider && (offered.length > 1 || disclose)) {
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
    const page = renderProviderChooserPage(
      { google: link("google"), microsoft: link("microsoft") },
      {
        providers: offered,
        privacyUrl: c.env.PRIVACY_URL,
        termsUrl: c.env.TERMS_URL,
        label: c.env.DEPLOYMENT_LABEL,
      },
    );
    return c.html(page, 200, {
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

interface ParkedLogin {
  client_id: string; redirect_uri: string; code_challenge: string; scope: string; client_state: string;
  provider?: string;
}

// A refused sign-in page is terminal and may carry the client's OAuth state:
// never cache, never index, never frame.
const REFUSED_PAGE_HEADERS = { "Cache-Control": "no-store", "X-Frame-Options": "DENY", "X-Robots-Tag": "noindex" };

/**
 * Same-origin path that restarts sign-in after a refused partial grant (O6).
 * The parked login state is single-use and already consumed, so the restart
 * re-enters /oauth/authorize with the client's ORIGINAL params (all validated
 * there again). The client is still waiting on its redirect_uri with the same
 * state and PKCE verifier, so a retry that completes lands back in it as if
 * the first attempt had succeeded. `provider` is deliberately omitted: the
 * chooser (and its disclosure) shows again where it would on a first visit.
 */
function restartAuthorizePath(parked: ParkedLogin): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: parked.client_id,
    redirect_uri: parked.redirect_uri,
    code_challenge: parked.code_challenge,
    code_challenge_method: "S256",
    scope: parked.scope,
    state: parked.client_state,
  });
  return `/oauth/authorize?${q.toString()}`;
}

/** Best-effort: does the identity behind a refused partial grant already
 *  hold a stored grant for this provider? Never throws; any failure (identity
 *  lookup, D1) answers false so the caller revokes. Logs nothing itself;
 *  hasStoredGrant → resolveSubject may log identity_email_drift (stored and
 *  token email), as every sign-in can. No token reaches a log. */
async function partialGrantHasStoredGrant(
  env: Env, idp: IdentityProvider, provider: ProviderName, tokens: UpstreamTokens,
): Promise<boolean> {
  try {
    const { email, providerSubject } = await idp.fetchIdentity(tokens.accessToken, { idToken: tokens.idToken });
    return await hasStoredGrant(env, provider, providerSubject, email.trim().toLowerCase());
  } catch {
    return false;
  }
}

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

  const parked = JSON.parse(parkedRaw) as ParkedLogin;
  const provider: ProviderName = isProviderName(parked.provider ?? "") ? (parked.provider as ProviderName) : "google";

  const back = (params: Record<string, string>) => {
    const u = new URL(parked.redirect_uri);
    Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
    return c.redirect(u.toString(), 302);
  };

  // A client-capability violation (a requested scope outside the client's
  // allowed_scopes) fails loud before the IdP exchange, so nothing is stored:
  // no grant, no users row, and so nothing for the renewal sweep's create
  // pass to subscribe. It depends only on the parked request, not the subject.
  // narrowScopesForGrant below re-checks it and applies the role entitlement.
  if ((await clientPermittedScopes(c.env, parked.client_id, parked.scope)) === null) {
    return back({ error: "invalid_scope", state: parked.client_state });
  }

  let subject: string;
  try {
    // Inside the try: with the Microsoft kill switch flipped off mid-login the
    // factory throws ms_provider_disabled, and the browser must still get a
    // redirect back to the client (the parked state is already consumed).
    const idp = defaultIdentityProvider(c.env, provider);
    const redirectUri = new URL(CALLBACK_PATH, c.env.OAUTH_ISSUER).toString();
    const tokens = await idp.exchangeCode(code, redirectUri);
    // Diagnostics only (DEBUG_LOG exactly "true"): the raw scope string the
    // IdP returned, to see what a consent screen actually granted. Never a
    // token, never an email.
    debugLog(c.env, "dbg_auth_callback_granted_scopes", { provider, scope: tokens.scope ?? null });
    // Granular consent fails closed (O6). Google lets a person untick
    // individual permissions; the grant then lacks a product scope Optical
    // requested, and there is no degraded mode. Checked before anything is
    // stored: revoke the partial grant (best-effort, gated by
    // UPSTREAM_REVOKE_ENABLED) and show a terminal page naming what was
    // unticked, with a link that restarts sign-in from /authorize.
    //
    // Except for a returning member: Google revokes the WHOLE user-app grant,
    // so revoking their partial re-consent would also kill the refresh token
    // Optical already stores. With the flag on, resolve the identity
    // best-effort; if it already holds a stored grant for this provider, skip
    // the revoke. Any failure there falls back to revoking (fail closed).
    // With the flag off nothing is revoked, so identity is never resolved.
    //
    // Require exact provider scopes (REQUIRE_EXACT_PROVIDER_SCOPES): exactly
    // "false" lets a grant missing product scopes through instead — logged,
    // nothing revoked — and every later gate (membership, rebind) still runs.
    const missing = missingProductScopes(provider, c.env, tokens.scope);
    if (missing.length > 0 && !requireExactProviderScopes(c.env)) {
      console.warn("auth_callback_scopes_relaxed", { provider, missing });
    } else if (missing.length > 0) {
      console.warn("auth_callback_missing_scopes", { provider, missing });
      if (upstreamRevokeEnabled(c.env) && (await partialGrantHasStoredGrant(c.env, idp, provider, tokens))) {
        console.warn("auth_callback_revoke_skipped", { provider, reason: "existing_grant" });
      } else {
        await revokeUpstreamGrant(c.env, {
          token: tokens.refreshToken ?? tokens.accessToken,
          idp,
          logPrefix: "auth_callback_revoke",
          context: { provider, reason: "missing_scopes" },
        });
      }
      return c.html(
        renderSignInRefusedPage({
          kind: "missing_scopes",
          missing: missing.map(scopeLabel),
          retryUrl: restartAuthorizePath(parked),
          label: c.env.DEPLOYMENT_LABEL,
        }),
        403,
        REFUSED_PAGE_HEADERS,
      );
    }
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
    // Membership gate (see membership.ts). Checked against `subject`, the
    // stable first-sign-in email, so a renamed user is matched on their
    // ORIGINAL address. With MEMBERSHIP_ALLOWLIST set, the allow-list (plus
    // OPERATOR_EMAIL) is authoritative and an existing active users row does
    // NOT pass by itself; with no allow-list, an existing active user passes
    // (prod parity).
    //
    // A miss (O4): revoke the grant we were just handed (best-effort, gated by
    // UPSTREAM_REVOKE_ENABLED, never logs the token), store nothing, and show
    // the person a terminal page. No redirect to the client: it can do
    // nothing useful with access_denied, and the person needs to read why.
    if (!(await isMember(subject, c.env))) {
      await revokeUpstreamGrant(c.env, {
        token: tokens.refreshToken ?? tokens.accessToken,
        idp,
        logPrefix: "auth_callback_revoke",
        context: { provider, reason: "not_member" },
      });
      return c.html(
        renderSignInRefusedPage({ kind: "not_invited", contact: c.env.INVITE_CONTACT, label: c.env.DEPLOYMENT_LABEL }),
        403,
        REFUSED_PAGE_HEADERS,
      );
    }
    // Provider rebind refusal (REFUSE_PROVIDER_REBIND, trial only): after the
    // membership gate, so a non-member learns nothing about whether an
    // account exists. storeIdentityTokens refuses, before writing anything,
    // when `subject` is already bound to a different IdP identity (another
    // provider_subject, or the other provider); a legacy NULL
    // provider_subject still binds. The grant just received belongs to that
    // OTHER upstream identity, so revoking it cannot touch the stored one.
    try {
      await storeIdentityTokens(c.env, subject, tokens, provider, providerSubject);
    } catch (err) {
      if (!(err instanceof ProviderRebindRefusedError)) throw err;
      console.warn("auth_callback_rebind_refused", { provider, mismatch: err.mismatch });
      await revokeUpstreamGrant(c.env, {
        token: tokens.refreshToken ?? tokens.accessToken,
        idp,
        logPrefix: "auth_callback_revoke",
        context: { provider, reason: "account_bound" },
      });
      return c.html(
        renderSignInRefusedPage({ kind: "account_bound", contact: c.env.INVITE_CONTACT, label: c.env.DEPLOYMENT_LABEL }),
        403,
        REFUSED_PAGE_HEADERS,
      );
    }
    // Seed/touch the canonical users row. An OPERATOR_EMAIL identity becomes the
    // initial admin; everyone else is a member. touchLastSeen keeps role intact
    // for returning users.
    const isSeedAdmin = csv(c.env.OPERATOR_EMAIL).includes(subject.trim().toLowerCase());
    if (isSeedAdmin) await upsertUser(c.env.DB, subject, "admin");
    // Every sign-in, the seed admin's included, is activity (O10b): stamps
    // last_seen and clears any retention warning. Never changes role.
    await touchLastSeen(c.env.DB, subject);
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

  // The sign-in has succeeded (grant stored, scopes narrowed, code written):
  // only now make sure the subject has a push channel, so calendar edits
  // trigger webhook replans without a manual subscribeWebhook. Never earlier:
  // a sign-in refused at any step above (membership, partial grant, rebind,
  // invalid_scope, server_error) must not provision a channel. Off the
  // redirect's critical path (waitUntil) and best-effort: the subscriber logs
  // its own outcome and never throws, and the catch guards the seam anyway.
  const subscribe = signInSubscriber()(c.env, subject, provider).catch(() => {});
  try {
    c.executionCtx.waitUntil(subscribe);
  } catch {
    // No ExecutionContext (`app.request()` in tests): await inline, same
    // fallback idiom as calendar-feed/feed-route.ts.
    await subscribe;
  }

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
    if (!presented || !clientId) {
      logRefreshRefused("missing_params", clientId);
      return c.json({ error: "invalid_request" }, 400);
    }
    const presentedHash = await hashToken(presented, hashingKey(c.env));
    const row = await c.env.DB.prepare(
      `SELECT client_id, scopes, expires_at, refresh_of, revoked_at, subject FROM oauth_tokens WHERE hashed_token = ?`,
    ).bind(presentedHash).first<{
      client_id: string; scopes: string; expires_at: string | null; refresh_of: string | null; revoked_at: string | null;
      subject: string | null;
    }>();
    // Cheap fast paths. revoked_at here is a pre-check only; the CAS below is
    // the real single-use gate.
    if (!row) {
      logRefreshRefused("unknown_token", clientId);
      return c.json({ error: "invalid_grant" }, 400);
    }
    if (!row.refresh_of) {
      logRefreshRefused("not_refresh_token", clientId);
      return c.json({ error: "invalid_grant", error_description: "not a refresh token" }, 400);
    }
    if (row.revoked_at) {
      logRefreshRefused("revoked", clientId);
      return c.json({ error: "invalid_grant", error_description: "revoked" }, 400);
    }
    // Log the presented client_id, never row.client_id: that would hint at who
    // owns a token the caller doesn't legitimately hold.
    if (row.client_id !== clientId) {
      logRefreshRefused("client_mismatch", clientId);
      return c.json({ error: "invalid_grant" }, 400);
    }
    if (row.expires_at && row.expires_at < new Date().toISOString()) {
      logRefreshRefused("expired", clientId);
      return c.json({ error: "invalid_grant", error_description: "expired" }, 400);
    }

    const now = new Date().toISOString();
    // Allow-list mode (O4): a delisted subject's refresh is refused and the
    // presented chain (this refresh + its paired access) is revoked, so an
    // uninvite bites at the client's next refresh, not only at next sign-in.
    // Other access tokens already issued live out ACCESS_TOKEN_TTL_SECONDS.
    // No allow-list configured: unchanged (prod parity), since isMember's
    // existing-active-user branch is not meant to gate refresh there.
    if (row.subject && csv(c.env.MEMBERSHIP_ALLOWLIST).length > 0 && !(await isMember(row.subject, c.env))) {
      await c.env.DB.batch([
        c.env.DB.prepare(`UPDATE oauth_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE hashed_token = ?`).bind(now, presentedHash),
        c.env.DB.prepare(`UPDATE oauth_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE hashed_token = ?`).bind(now, row.refresh_of),
      ]);
      logRefreshRefused("not_member", clientId);
      return c.json({ error: "invalid_grant", error_description: "not a member" }, 400);
    }

    // Re-apply the role entitlement (O14 #5) against the subject's live role,
    // so a demoted admin's rotated pair stops carrying `admin`. It filters
    // row.scopes, so it can only narrow the stored grant, never widen it.
    const scopes = row.subject
      ? applyRoleEntitlement(
          row.scopes.split(" ").filter(Boolean),
          (await getUser(c.env.DB, row.subject))?.role === "admin",
        ).join(" ")
      : row.scopes;

    // Rotate, single-use. Every request that read the row before the first
    // rotation landed passed the revoked_at fast path above, so an
    // unconditional revoke would let each of a concurrent burst mint its own
    // chain. This CAS is the serialization point (same idiom as the
    // authorization_code branch's used_at CAS): exactly one request flips
    // revoked_at from NULL. A loser gets the body the sequential `revoked`
    // path would give it a moment later, and writes nothing.
    const rotate = await c.env.DB
      .prepare(`UPDATE oauth_tokens SET revoked_at = ? WHERE hashed_token = ? AND revoked_at IS NULL`)
      .bind(now, presentedHash)
      .run();
    if ((rotate.meta?.changes ?? 0) !== 1) {
      logRefreshRefused("lost_race", clientId);
      return c.json({ error: "invalid_grant", error_description: "revoked" }, 400);
    }
    // Winner only: revoke the paired access token in the same transaction as
    // the new pair's inserts, so it can't be revoked without a replacement
    // being issued. COALESCE keeps an earlier /oauth/revoke time.
    const revokePairedAccess = c.env.DB
      .prepare(`UPDATE oauth_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE hashed_token = ?`)
      .bind(now, row.refresh_of);
    const t = await issueTokens(c.env, clientId, scopes, row.subject, [revokePairedAccess]);
    return c.json({
      access_token: t.access,
      refresh_token: t.refresh,
      token_type: "Bearer",
      expires_in: t.expires_in,
      scope: scopes,
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
