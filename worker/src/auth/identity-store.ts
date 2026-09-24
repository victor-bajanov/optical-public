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

export async function storeIdentityTokens(
  env: Env, subject: string, t: UpstreamTokens, provider: ProviderName = "google", providerSubject?: string,
): Promise<void> {
  if (!t.refreshToken) throw new Error("no_refresh_token_returned");
  // Provider switch (same email, other IdP): the stored sync token, push
  // channel and done marker are all provider-shaped and would poison the new
  // provider — reset them before the credential flips. Nothing stops a user
  // doing this; "one provider per user" means one AT A TIME.
  const prior = await env.DB.prepare(
    `SELECT provider, provider_subject FROM identity_tokens WHERE account_email = ?`,
  ).bind(subject).first<{ provider: string | null; provider_subject: string | null }>();
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
  await env.DB.prepare(
    `INSERT INTO identity_tokens (account_email, refresh_token_encrypted, scopes, updated_at, provider, provider_subject)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(account_email) DO UPDATE SET
       refresh_token_encrypted = excluded.refresh_token_encrypted,
       scopes = excluded.scopes,
       updated_at = excluded.updated_at,
       provider = excluded.provider,
       provider_subject = excluded.provider_subject`,
  ).bind(subject, enc, t.scope, new Date().toISOString(), provider, providerSubject ?? null).run();
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

// Canonical active-user source is the users table (Plan 4 brief A).
// identity_tokens remains the credential store; an orphaned credential without
// an active user is intentionally NOT listed.
export async function listSubjects(env: Env): Promise<string[]> {
  return listActiveSubjects(env.DB);
}
