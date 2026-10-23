import type { Env } from "../env";
import type { IdentityProvider, UpstreamTokens } from "./identity-provider";
import { encryptionKey } from "./crypto-keys";
import { upsertUser, listActiveSubjects, clearDoneColorId } from "../db/users";
import { resetCalendarSyncForOwner } from "../db/calendar-sync";
import type { ProviderName } from "../providers/provider-name";
import { isProviderName } from "../providers/provider-name";
import { encryptString, decryptString } from "./encryption";

export const ACCESS_PREFIX = "idp_access_token:";

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

export async function storeIdentityTokens(
  env: Env, subject: string, t: UpstreamTokens, provider: ProviderName = "google", providerSubject?: string,
): Promise<void> {
  if (!t.refreshToken) throw new Error("no_refresh_token_returned");
  // Provider switch (same email, other IdP): the stored sync token, push
  // channel and done marker are all provider-shaped and would poison the new
  // provider — reset them before the credential flips. Nothing stops a user
  // doing this (unless REFUSE_PROVIDER_REBIND, below); "one provider per
  // user" means one AT A TIME.
  const prior = await env.DB.prepare(
    `SELECT provider, provider_subject FROM identity_tokens WHERE account_email = ?`,
  ).bind(subject).first<{ provider: string | null; provider_subject: string | null }>();
  // REFUSE_PROVIDER_REBIND (trial): an account already bound to one IdP
  // identity is never handed to another — not a second account at the same
  // IdP, not the same email at the other IdP. Refused before the provider-
  // switch reset below, so nothing is written. The guarded upsert further
  // down is the actual serialization point for two racing first sign-ins.
  const refuse = refuseProviderRebind(env);
  if (refuse) {
    const mismatch = rebindMismatch(prior, provider, providerSubject);
    if (mismatch) throw new ProviderRebindRefusedError(mismatch);
  }
  if (prior && coerceProvider(prior.provider) !== provider) {
    await resetCalendarSyncForOwner(env.DB, subject);
    await clearDoneColorId(env.DB, subject);
  } else if (prior && prior.provider_subject && prior.provider_subject !== (providerSubject ?? null)) {
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
  const res = await env.DB.prepare(
    `INSERT INTO identity_tokens (account_email, refresh_token_encrypted, scopes, updated_at, provider, provider_subject)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(account_email) DO UPDATE SET
       refresh_token_encrypted = excluded.refresh_token_encrypted,
       scopes = excluded.scopes,
       updated_at = excluded.updated_at,
       provider = excluded.provider,
       provider_subject = excluded.provider_subject` +
    (refuse
      ? `
     WHERE identity_tokens.provider_subject IS NULL
        OR (identity_tokens.provider_subject = excluded.provider_subject
            AND COALESCE(identity_tokens.provider, 'google') = excluded.provider)`
      : ""),
  ).bind(subject, enc, t.scope, new Date().toISOString(), provider, providerSubject ?? null).run();
  if (refuse && (res.meta?.changes ?? 0) === 0) {
    const now = await env.DB.prepare(
      `SELECT provider, provider_subject FROM identity_tokens WHERE account_email = ?`,
    ).bind(subject).first<{ provider: string | null; provider_subject: string | null }>();
    throw new ProviderRebindRefusedError(rebindMismatch(now, provider, providerSubject) ?? "subject");
  }
  // Storing a credential implies an active user. Idempotent; never downgrades a
  // pre-existing admin (upsertUser without a role keeps the existing role).
  await upsertUser(env.DB, subject);
  await env.GOOGLE_TOKEN_CACHE.put(ACCESS_PREFIX + subject, t.accessToken, { expirationTtl: Math.max(60, t.expiresIn - 60) });
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
    `SELECT provider, provider_subject FROM identity_tokens WHERE account_email = ?`,
  ).bind(subject).first<{ provider: string | null; provider_subject: string | null }>();
  // The stored grant must be THIS upstream account's: a row bound to another
  // provider_subject belongs to a different account, whose grant revoking
  // this one cannot touch. A legacy NULL provider_subject can't be told
  // apart, so it counts as a match (skip the revoke, as before).
  return row !== null && coerceProvider(row.provider) === provider &&
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

export async function getAccessToken(
  env: Env, idp: IdentityProvider, subject: string, opts: { forceRefresh?: boolean } = {},
): Promise<string> {
  if (!opts.forceRefresh) {
    const cached = await env.GOOGLE_TOKEN_CACHE.get(ACCESS_PREFIX + subject);
    if (cached) return cached;
  }
  const row = await env.DB.prepare(
    `SELECT refresh_token_encrypted, provider FROM identity_tokens WHERE account_email = ?`,
  ).bind(subject).first<{ refresh_token_encrypted: ArrayBuffer; provider: string | null }>();
  if (!row) throw new Error(`no identity tokens for ${subject}`);
  const refresh = await decryptString(row.refresh_token_encrypted, encryptionKey(env), "identity-refresh");
  const t = await idp.refreshAccessToken(refresh);
  // Re-read the provider after the upstream round-trip: if it changed, the
  // subject switched IdP mid-flight and this token belongs to the OLD provider
  // — hand it to the caller (their request was made on the old provider) but
  // persist and cache nothing.
  const after = await env.DB.prepare(
    `SELECT provider FROM identity_tokens WHERE account_email = ?`,
  ).bind(subject).first<{ provider: string | null }>();
  if (!after || coerceProvider(after.provider) !== coerceProvider(row.provider)) return t.accessToken;
  if (t.refreshToken && t.refreshToken !== refresh) {
    const enc = await encryptString(t.refreshToken, encryptionKey(env), "identity-refresh");
    // Guarded by the provider we read the token FROM: if the user switched IdP
    // while this refresh was in flight, the rotated token belongs to the old
    // provider and must not overwrite the new provider's credential.
    await env.DB.prepare(
      `UPDATE identity_tokens SET refresh_token_encrypted = ?, updated_at = ? WHERE account_email = ? AND provider IS ?`,
    ).bind(enc, new Date().toISOString(), subject, row.provider).run();
  }
  await env.GOOGLE_TOKEN_CACHE.put(ACCESS_PREFIX + subject, t.accessToken, { expirationTtl: Math.max(60, t.expiresIn - 60) });
  return t.accessToken;
}

/** The subject's decrypted upstream refresh token, or null when no credential
 *  is stored. Throws when the stored ciphertext cannot be decrypted (same
 *  posture as getAccessToken) — callers decide whether that is fatal. Used by
 *  offboard to revoke the grant upstream before the row is deleted. */
export async function readRefreshToken(env: Env, subject: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT refresh_token_encrypted FROM identity_tokens WHERE account_email = ?`,
  ).bind(subject).first<{ refresh_token_encrypted: ArrayBuffer }>();
  if (!row) return null;
  return decryptString(row.refresh_token_encrypted, encryptionKey(env), "identity-refresh");
}

// Canonical active-user source is the users table (Plan 4 brief A).
// identity_tokens remains the credential store; an orphaned credential without
// an active user is intentionally NOT listed.
export async function listSubjects(env: Env): Promise<string[]> {
  return listActiveSubjects(env.DB);
}
