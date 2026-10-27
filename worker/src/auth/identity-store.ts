import type { Env } from "../env";
import type { IdentityProvider, UpstreamTokens } from "./identity-provider";
import { encryptionKey, hashingKey } from "./crypto-keys";
import { upsertUser, listActiveSubjects } from "../db/users";
import type { ProviderName } from "../providers/provider-name";
import { isProviderName } from "../providers/provider-name";
import { encryptString, decryptString } from "./encryption";
import { hashToken } from "./tokens";

// ---------------------------------------------------------------------------
// IdP access-token cache (GOOGLE_TOKEN_CACHE KV, provider-agnostic despite the
// binding name). Every reader, writer and deleter goes through the four
// helpers below; nothing touches the key names directly.
//
// At rest the entry holds no plaintext token and its name holds no email: the
// key is a keyed hash of the internal subject and the value is AES-GCM under
// its own purpose ("identity-access", a key independent of the
// "identity-refresh" one). Lives at most 1 h for both providers.
// ---------------------------------------------------------------------------

const ACCESS_KEY_PREFIX = "idp_at:";
const ACCESS_PURPOSE = "identity-access";
/** The longest any entry lives, whatever the IdP's expires_in says (Graph
 *  tokens can last 90 min). */
const ACCESS_TTL_MAX_S = 3600;
/** KV's minimum expirationTtl. */
const ACCESS_TTL_MIN_S = 60;

/** Pre-encryption builds stored the plaintext token under
 *  `idp_access_token:<subject>`. Never read; only deleted by
 *  dropCachedAccessToken (offboard, rebind). The legacy delete can go once
 *  every env has been on this build for more than 2 h, the longest legacy TTL. */
const LEGACY_ACCESS_PREFIX = "idp_access_token:";

/** The cache key for `subject`. hashingKey(env), never TOKEN_HASH_PEPPER
 *  directly (dev splits its secrets). The "idp-access:" domain prefix keeps
 *  this hash from ever equalling an opaque-token hash. */
export async function accessCacheKey(env: Env, subject: string): Promise<string> {
  return ACCESS_KEY_PREFIX + await hashToken(`idp-access:${subject}`, hashingKey(env));
}

/** Cache `token` encrypted, for `expiresIn - 60` s clamped to [60, 3600]. */
export async function cacheAccessToken(env: Env, subject: string, token: string, expiresIn: number): Promise<void> {
  const enc = await encryptString(token, encryptionKey(env), ACCESS_PURPOSE);
  const expirationTtl = Math.min(ACCESS_TTL_MAX_S, Math.max(ACCESS_TTL_MIN_S, expiresIn - 60));
  await env.GOOGLE_TOKEN_CACHE.put(await accessCacheKey(env, subject), enc, { expirationTtl });
}

/** The cached token, or null on a miss. A value that does not decrypt (a key
 *  rotation, a corrupt or plaintext value) is a miss too: the caller refreshes
 *  and overwrites it. Logs nothing, so the value never reaches a log. */
export async function readCachedAccessToken(env: Env, subject: string): Promise<string | null> {
  const buf = await env.GOOGLE_TOKEN_CACHE.get(await accessCacheKey(env, subject), "arrayBuffer");
  if (!buf) return null;
  try {
    return await decryptString(buf, encryptionKey(env), ACCESS_PURPOSE);
  } catch {
    return null;
  }
}

/** Drop `subject`'s cached token, and its legacy plaintext entry. */
export async function dropCachedAccessToken(env: Env, subject: string): Promise<void> {
  await env.GOOGLE_TOKEN_CACHE.delete(await accessCacheKey(env, subject));
  await env.GOOGLE_TOKEN_CACHE.delete(LEGACY_ACCESS_PREFIX + subject);
}

/** SQL: 1 when the row holds a refresh credential. An admin rebind wipes it to
 *  a zero-length blob (X'': the column is NOT NULL since 0001), which every
 *  reader treats exactly like no row. */
const HAS_CREDENTIAL = "(length(refresh_token_encrypted) > 0)";

/** Stored provider → ProviderName. NULL / unknown (pre-0036 rows) read as
 *  google everywhere, so a legacy row rewritten as 'google' is not a switch. */
function coerceProvider(v: string | null | undefined): ProviderName {
  return v && isProviderName(v) ? v : "google";
}

/** REFUSE_PROVIDER_REBIND (decision D, trial only): exactly "true" refuses a
 *  rebind; anything else keeps the documented provider switch. */
export function refuseProviderRebind(env: Pick<Env, "REFUSE_PROVIDER_REBIND">): boolean {
  return env.REFUSE_PROVIDER_REBIND === "true";
}

/** Thrown by storeIdentityTokens, before any write, when REFUSE_PROVIDER_REBIND
 *  is on and the account_email is already bound to a different IdP identity.
 *  `mismatch` says which part differed; it carries no email or subject. */
export class ProviderRebindRefusedError extends Error {
  constructor(readonly mismatch: "provider" | "subject") {
    super("provider_rebind_refused");
    this.name = "ProviderRebindRefusedError";
  }
}

/** How a stored binding differs from the incoming identity, or null when it
 *  may (re)bind: no row, a legacy row with NULL provider_subject, or the same
 *  (provider, provider_subject). */
function rebindMismatch(
  prior: { provider: string | null; provider_subject: string | null } | null,
  provider: ProviderName, providerSubject: string | undefined,
): "provider" | "subject" | null {
  if (!prior || !prior.provider_subject) return null;
  if (coerceProvider(prior.provider) !== provider) return "provider";
  return prior.provider_subject !== (providerSubject ?? null) ? "subject" : null;
}

/**
 * `loginEmail` is the verified, normalised email this sign-in carried. It is
 * stored as identity_tokens.login_email, the owner's notification address
 * (db/owner-email.ts), and differs from `subject` once the IdP-side address
 * has been renamed: the subject stays the address the account was first
 * created under. Omitting it (callers other than /auth/callback) keeps the
 * stored value. It rides the guarded upsert, so a refused sign-in writes none.
 */
export async function storeIdentityTokens(
  env: Env, subject: string, t: UpstreamTokens, provider: ProviderName = "google", providerSubject?: string,
  loginEmail?: string,
): Promise<void> {
  if (!t.refreshToken) throw new Error("no_refresh_token_returned");
  const prior = await env.DB.prepare(
    `SELECT provider, provider_subject FROM identity_tokens WHERE account_email = ?`,
  ).bind(subject).first<{ provider: string | null; provider_subject: string | null }>();
  // REFUSE_PROVIDER_REBIND (trial): an account already bound to one IdP
  // identity is never handed to another — not a second account at the same
  // IdP, not the same email at the other IdP. Refused before any write. The
  // guarded upsert further down is the actual serialization point for two
  // racing first sign-ins.
  const refuse = refuseProviderRebind(env);
  if (refuse) {
    const mismatch = rebindMismatch(prior, provider, providerSubject);
    if (mismatch) throw new ProviderRebindRefusedError(mismatch);
  }
  if (prior && coerceProvider(prior.provider) === provider && prior.provider_subject && prior.provider_subject !== (providerSubject ?? null)) {
    // Same account_email, same provider, but the incoming provider_subject
    // differs from what's stored: the IdP-side identity was re-created
    // under the same mailbox (e.g. an Entra object deleted and recreated —
    // new oid, same UPN). Correct to keep overwriting (it IS the same
    // mailbox), but silent otherwise — log for operator visibility. Gated
    // on prior.provider_subject being non-NULL so a legacy-row backfill
    // (NULL -> a value) never logs this.
    console.warn(
      `identity_subject_rebound provider=${provider} email=${subject} old=${prior.provider_subject} new=${providerSubject}`,
    );
  }
  const enc = await encryptString(t.refreshToken, encryptionKey(env), "identity-refresh");
  // provider_subject is written on every store (not merged with any prior
  // value) — the caller always has it fresh from fetchIdentity by the time
  // this runs in the real callback path (oauth-provider.ts), so this is also
  // how a legacy (pre-0037, NULL provider_subject) row gets backfilled: same
  // account_email, upserted in place, now with a provider_subject attached.
  //
  // ON CONFLICT(account_email) DO UPDATE, NOT `INSERT OR REPLACE`: REPLACE
  // resolves a conflict on ANY unique constraint (including the partial
  // unique index on (provider, provider_subject)) by deleting the
  // conflicting row first — so if `subject` collided with a DIFFERENT
  // account_email that already owns this (provider, provider_subject) pair,
  // REPLACE would silently delete that other row's credential. The
  // callback can't reach this today (resolveSubject always resolves to the
  // row that already owns the pair), but the write path shouldn't rely on
  // that being every caller forever — upserting only on account_email means
  // a genuine (provider, provider_subject) collision under a DIFFERENT
  // account_email throws `UNIQUE constraint failed` instead of deleting data.
  //
  // With REFUSE_PROVIDER_REBIND the DO UPDATE only applies while the stored
  // row is unbound (NULL provider_subject) or bound to this same identity, so
  // a concurrent first sign-in that committed after the pre-check read above
  // wins and this write changes nothing (0 rows): refused, as above.
  const upsert = env.DB.prepare(
    `INSERT INTO identity_tokens (account_email, refresh_token_encrypted, scopes, updated_at, provider, provider_subject, login_email)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(account_email) DO UPDATE SET
       refresh_token_encrypted = excluded.refresh_token_encrypted,
       scopes = excluded.scopes,
       updated_at = excluded.updated_at,
       provider = excluded.provider,
       provider_subject = excluded.provider_subject,
       login_email = COALESCE(excluded.login_email, identity_tokens.login_email)` +
    (refuse
      ? `
     WHERE identity_tokens.provider_subject IS NULL
        OR (identity_tokens.provider_subject = excluded.provider_subject
            AND COALESCE(identity_tokens.provider, 'google') = excluded.provider)`
      : ""),
  ).bind(subject, enc, t.scope, new Date().toISOString(), provider, providerSubject ?? null, loginEmail ?? null);
  // Provider switch (same email, other IdP): the stored sync token, push
  // channel and done marker are all provider-shaped and would poison the new
  // provider, so they are reset. Nothing stops a user doing this (unless
  // REFUSE_PROVIDER_REBIND); "one provider per user" means one AT A TIME.
  //
  // The resets ride in ONE batch (one D1 transaction) with the credential
  // flip, ahead of it, so a failing reset rolls the flip back (a retry still
  // sees the old provider and resets) and a failing flip rolls the resets
  // back. Each is guarded in SQL, inside that transaction, on the stored row
  // being under ANOTHER provider and the upsert being about to apply to it —
  // not on the pre-check read above, which a concurrent sign-in can make
  // stale either way: a refused or raced switch touches nothing, and a switch
  // that landed after the read is still reset when this store flips it back.
  // Under REFUSE_PROVIDER_REBIND a cross-provider upsert applies only to an
  // unanchored row (see its WHERE), hence the extra provider_subject term.
  //
  // The sync token and push channel are also reset when this store ANCHORS an
  // unanchored row under the same provider (a legacy row, or one an admin
  // rebind cleared): it binds whichever upstream identity signed in, whose
  // calendar they may not describe (a legacy row's sync state is the previous
  // sign-in's, and a renewal in flight at the rebind can still land a channel
  // after it wiped the credential). The done colour id stays meaningful
  // under the same provider, so it keeps the provider-only guard.
  const onlyIfApplies = refuse ? ` AND provider_subject IS NULL` : ``;
  const switching =
    `EXISTS (SELECT 1 FROM identity_tokens WHERE account_email = ? AND COALESCE(provider, 'google') <> ?${onlyIfApplies})`;
  const switchingOrAnchoring =
    `EXISTS (SELECT 1 FROM identity_tokens WHERE account_email = ?
       AND (COALESCE(provider, 'google') <> ? OR (provider_subject IS NULL AND ? IS NOT NULL))${onlyIfApplies})`;
  const [, , res] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE calendar_sync SET next_sync_token = NULL, channel_id = NULL, channel_token = NULL,
         channel_expires_at = NULL, channel_resource_id = NULL, channel_callback_url = NULL
       WHERE owner_subject = ? AND ${switchingOrAnchoring}`,
    ).bind(subject, subject, provider, providerSubject ?? null),
    env.DB.prepare(`UPDATE users SET done_color_id = NULL WHERE subject = ? AND ${switching}`)
      .bind(subject, subject, provider),
    upsert,
  ]);
  if (refuse && (res?.meta?.changes ?? 0) === 0) {
    const now = await env.DB.prepare(
      `SELECT provider, provider_subject FROM identity_tokens WHERE account_email = ?`,
    ).bind(subject).first<{ provider: string | null; provider_subject: string | null }>();
    throw new ProviderRebindRefusedError(rebindMismatch(now, provider, providerSubject) ?? "subject");
  }
  // Storing a credential implies an active user. Idempotent; never downgrades a
  // pre-existing admin (upsertUser without a role keeps the existing role).
  await upsertUser(env.DB, subject);
  await cacheAccessToken(env, subject, t.accessToken, t.expiresIn);
}

/**
 * Resolve the internal `subject` key for a login, anchored on the IdP's
 * immutable provider_subject rather than the (mutable) email the token
 * carries this time around.
 *
 * - A row already keyed by (provider, providerSubject) exists: that row's
 *   account_email IS the subject for life, even if the token's email has
 *   since changed (renamed UPN, domain consolidation, ...). No rename is
 *   performed — email drift is logged only, for operator visibility. This
 *   also covers the rule-6 conflict case (a second, unrelated row already
 *   sitting under the token's new email): the subject match wins and that
 *   other row is left untouched, since only the resolved subject is ever
 *   written to.
 * - No such row (brand-new subject, OR a legacy pre-0037 row that has never
 *   been keyed by a provider_subject yet): the token's email is the subject.
 *   This covers both first-ever sign-in and the backfill case — the caller's
 *   subsequent storeIdentityTokens call writes providerSubject onto whatever
 *   row that email resolves to (existing legacy row or a freshly created one).
 */
export async function resolveSubject(
  env: Env, provider: ProviderName, providerSubject: string, email: string,
): Promise<string> {
  const bySubject = await env.DB.prepare(
    `SELECT account_email FROM identity_tokens WHERE provider = ? AND provider_subject = ?`,
  ).bind(provider, providerSubject).first<{ account_email: string }>();
  if (bySubject) {
    if (bySubject.account_email !== email) {
      console.warn(
        `identity_email_drift provider=${provider} provider_subject=${providerSubject} stored=${bySubject.account_email} token=${email}`,
      );
    }
    return bySubject.account_email;
  }
  return email;
}

/**
 * Does this login's identity already hold a stored upstream grant for
 * `provider`? Resolves the subject exactly as the callback would
 * (resolveSubject: provider_subject first, else the email), then checks for
 * an identity_tokens row under it whose provider matches (a legacy NULL
 * provider counts as google, as in getSubjectProvider) and whose
 * provider_subject is this identity's (a legacy NULL one counts as a match).
 *
 * The O6 partial-grant refusal uses this to skip the upstream revoke: Google
 * revokes the whole user-app grant, so revoking a returning member's partial
 * re-consent would also kill the refresh token Optical already stores.
 * `email` must already be normalised (trim + lower-case).
 */
export async function hasStoredGrant(
  env: Env, provider: ProviderName, providerSubject: string, email: string,
): Promise<boolean> {
  const subject = await resolveSubject(env, provider, providerSubject, email);
  const row = await env.DB.prepare(
    `SELECT provider, provider_subject, ${HAS_CREDENTIAL} AS has_credential FROM identity_tokens WHERE account_email = ?`,
  ).bind(subject).first<{ provider: string | null; provider_subject: string | null; has_credential: number }>();
  // The stored grant must be THIS upstream account's: a row bound to another
  // provider_subject belongs to a different account, whose grant revoking
  // this one cannot touch. A legacy NULL provider_subject can't be told
  // apart, so it counts as a match (skip the revoke, as before). A row whose
  // credential an admin rebind wiped stores no grant at all.
  return row !== null && row.has_credential === 1 && coerceProvider(row.provider) === provider &&
    (row.provider_subject === null || row.provider_subject === providerSubject);
}

/** The IdP this subject signed in with. Unknown subjects default to google —
 *  preserves pre-0036 behaviour for injected-provider tests and never blocks
 *  the factory on a missing row (token fetch fails later with a clearer error). */
export async function getSubjectProvider(env: Env, subject: string): Promise<ProviderName> {
  const row = await env.DB.prepare(
    `SELECT provider FROM identity_tokens WHERE account_email = ?`,
  ).bind(subject).first<{ provider: string }>();
  return coerceProvider(row?.provider);
}

/** getAccessToken's error when the stored IdP identity changed while an
 *  upstream refresh was in flight. PII-free by design. */
export const IDENTITY_CHANGED_DURING_REFRESH = "identity_changed_during_refresh";

/**
 * Thrown by getAccessToken when `subject` has no usable upstream credential:
 * no identity_tokens row, or a credential an admin rebind wiped (the account
 * is idle until its next sign-in stores a new one). A condition, not a fault:
 * callers that run without a user present (crons, the webhook replan, public
 * pages) skip the subject with one log line, and API routes answer a clean
 * 409 identity_credential_missing. The message is fixed and names no subject,
 * so it is safe on any log line.
 */
export class IdentityCredentialMissingError extends Error {
  readonly code = "identity_credential_missing";
  constructor() {
    super("identity_credential_missing");
    this.name = "IdentityCredentialMissingError";
  }
}

/** The one line a caller logs when it skips work for
 *  IdentityCredentialMissingError: `path` names the caller, and nothing names
 *  the subject (an email). */
export function logCredentialMissingSkip(path: string, extra: Record<string, unknown> = {}): void {
  console.warn("credential_missing_skip", { path, reason: "identity_credential_missing", ...extra });
}

/** Whether `subject` holds a usable refresh credential (a row whose
 *  credential an admin rebind has not wiped). For callers that must decide
 *  before doing anything irreversible, e.g. rotating a poll invitee's link
 *  ahead of a send that can't happen. */
export async function hasRefreshCredential(env: Env, subject: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT ${HAS_CREDENTIAL} AS has_credential FROM identity_tokens WHERE account_email = ?`,
  ).bind(subject).first<{ has_credential: number }>();
  return row?.has_credential === 1;
}

export async function getAccessToken(
  env: Env, idp: IdentityProvider, subject: string, opts: { forceRefresh?: boolean } = {},
): Promise<string> {
  if (!opts.forceRefresh) {
    const cached = await readCachedAccessToken(env, subject);
    if (cached) return cached;
  }
  const row = await env.DB.prepare(
    `SELECT refresh_token_encrypted, provider, provider_subject, ${HAS_CREDENTIAL} AS has_credential
       FROM identity_tokens WHERE account_email = ?`,
  ).bind(subject).first<{ refresh_token_encrypted: ArrayBuffer } & Anchor>();
  if (!row || row.has_credential !== 1) throw new IdentityCredentialMissingError();
  const refresh = await decryptString(row.refresh_token_encrypted, encryptionKey(env), "identity-refresh");
  const t = await idp.refreshAccessToken(refresh);
  // Re-read the provider after the upstream round-trip: if it changed, the
  // subject switched IdP mid-flight and this token belongs to the OLD provider
  // — hand it to the caller (their request was made on the old provider) but
  // persist and cache nothing.
  const moved = identityMoved(row, await readAnchor(env, subject));
  if (moved === "gone" || moved === "provider") return t.accessToken;
  // An admin rebind wiped the credential mid-flight (the only signal on a
  // legacy row, whose NULL anchor the rebind leaves as it was): the token is
  // the previous holder's, so treat it as a change of identity, failing the
  // call with nothing written back or cached.
  if (moved === "credential") throw new IdentityCredentialMissingError();
  // Same provider, different identity (an admin rebind, then another person
  // signed in as this address mid-flight): the access token is the previous
  // holder's. Caching it would point the new holder's requests at the wrong
  // calendar for up to an hour, and handing it back would act on it once, so
  // fail the call and cache nothing; a retry reads the new credential. This
  // holds whether or not the refresh token rotated (Google never rotates).
  // The message carries no subject: it reaches logs.
  if (moved === "subject") throw new Error(IDENTITY_CHANGED_DURING_REFRESH);
  if (t.refreshToken && t.refreshToken !== refresh) {
    const enc = await encryptString(t.refreshToken, encryptionKey(env), "identity-refresh");
    // Guarded by the provider, provider_subject AND ciphertext we read the
    // token FROM: a switch, rebind or sign-in that lands after the re-read
    // above must not let this rotation overwrite (or, after a rebind's wipe,
    // resurrect) the credential that replaced it. The ciphertext term is the
    // only guard that sees a rebind of a legacy NULL-anchor row.
    const res = await env.DB.prepare(
      `UPDATE identity_tokens SET refresh_token_encrypted = ?, updated_at = ?
        WHERE account_email = ? AND provider IS ? AND provider_subject IS ? AND refresh_token_encrypted = ?`,
    ).bind(enc, new Date().toISOString(), subject, row.provider, row.provider_subject, row.refresh_token_encrypted).run();
    if ((res.meta?.changes ?? 0) === 0) {
      // Matched nothing: say why. A wipe (an admin rebind) is the missing
      // credential; a moved identity or a deleted row is today's error.
      // Otherwise the same identity's credential was rotated under us by a
      // concurrent refresh or sign-in: Microsoft rotates on every use and
      // keeps the old token valid, so both refreshes succeeded upstream and
      // this access token is as good as theirs. Keep the newer credential,
      // skip this write-back and carry on.
      const writeMoved = identityMoved(row, await readAnchor(env, subject));
      if (writeMoved === "credential") throw new IdentityCredentialMissingError();
      if (writeMoved) throw new Error(IDENTITY_CHANGED_DURING_REFRESH);
    }
  }
  await cacheAccessToken(env, subject, t.accessToken, t.expiresIn);
  // The re-read above is a point in time: a switch, rebind-then-sign-in or
  // offboard can still commit between it and this put, and Google's
  // non-rotating refresh has no write-back to catch it. Read once more AFTER
  // the put. A sign-in commits its row before it caches its own token, so if
  // this read still sees our identity, any later sign-in's put lands after
  // ours and wins; if it doesn't, drop the key (the next call refreshes from
  // the new credential) and fail the same way as above.
  const late = identityMoved(row, await readAnchor(env, subject));
  if (late) {
    await dropCachedAccessToken(env, subject);
    if (late === "subject") throw new Error(IDENTITY_CHANGED_DURING_REFRESH);
    if (late === "credential") throw new IdentityCredentialMissingError();
  }
  return t.accessToken;
}

type Anchor = { provider: string | null; provider_subject: string | null; has_credential: number };

function readAnchor(env: Env, subject: string): Promise<Anchor | null> {
  return env.DB.prepare(
    `SELECT provider, provider_subject, ${HAS_CREDENTIAL} AS has_credential FROM identity_tokens WHERE account_email = ?`,
  ).bind(subject).first<Anchor>();
}

/** How the stored identity moved since `before` was read: the row is gone,
 *  its provider changed, its credential was wiped (an admin rebind), or
 *  (same provider) its provider_subject changed; null when it is still the
 *  same identity. A wipe outranks a subject change: the account now has no
 *  credential, whatever its anchor says. */
function identityMoved(before: Anchor, now: Anchor | null): "gone" | "provider" | "credential" | "subject" | null {
  if (!now) return "gone";
  if (coerceProvider(now.provider) !== coerceProvider(before.provider)) return "provider";
  if (now.has_credential !== 1) return "credential";
  return now.provider_subject !== before.provider_subject ? "subject" : null;
}

/** The subject's decrypted upstream refresh token, or null when no credential
 *  is stored (no row, or one an admin rebind wiped). Throws when the stored
 *  ciphertext cannot be decrypted (same posture as getAccessToken) — callers
 *  decide whether that is fatal. Used by offboard and the admin rebind to
 *  revoke the grant upstream before the credential is deleted. */
export async function readRefreshToken(env: Env, subject: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT refresh_token_encrypted, ${HAS_CREDENTIAL} AS has_credential FROM identity_tokens WHERE account_email = ?`,
  ).bind(subject).first<{ refresh_token_encrypted: ArrayBuffer; has_credential: number }>();
  if (!row || row.has_credential !== 1) return null;
  return decryptString(row.refresh_token_encrypted, encryptionKey(env), "identity-refresh");
}

// Canonical active-user source is the users table (Plan 4 brief A).
// identity_tokens remains the credential store; an orphaned credential without
// an active user is intentionally NOT listed.
export async function listSubjects(env: Env): Promise<string[]> {
  return listActiveSubjects(env.DB);
}
