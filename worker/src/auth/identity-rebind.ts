import type { Env } from "../env";
import { hashingKey } from "./crypto-keys";
import { hashToken } from "./tokens";
import type { ProviderName } from "../providers/provider-name";
import { isProviderName } from "../providers/provider-name";

/** One subject's identity_tokens anchor, as the admin rebind reads it. */
export interface RebindTarget {
  provider: ProviderName;
  /** The column as stored (NOT coerced): the clear compares against it. */
  storedProvider: string | null;
  providerSubject: string | null;
  loginEmail: string | null;
}

/** The subject's anchor, or null when it has no identity_tokens row. A NULL or
 *  unknown provider reads as google, as everywhere else (identity-store.ts). */
export async function readRebindTarget(db: D1Database, subject: string): Promise<RebindTarget | null> {
  const row = await db
    .prepare("SELECT provider, provider_subject, login_email FROM identity_tokens WHERE account_email = ?")
    .bind(subject)
    .first<{ provider: string | null; provider_subject: string | null; login_email: string | null }>();
  if (!row) return null;
  return {
    provider: row.provider && isProviderName(row.provider) ? row.provider : "google",
    storedProvider: row.provider,
    providerSubject: row.provider_subject,
    loginEmail: row.login_email,
  };
}

/**
 * Admin rebind: clear `subject`'s identity anchor (provider_subject → NULL) so
 * the NEXT sign-in to that address binds whichever IdP identity carries it,
 * and reset its calendar_sync sync token and push-channel columns in the same
 * D1 batch. Every rebind hands the address to a different upstream identity,
 * whose calendar the old sync token and channel don't describe.
 *
 * The same statement wipes the stored refresh credential
 * (refresh_token_encrypted = X'', a zero-length blob: the column is NOT NULL
 * since 0001), so the account is idle until that next sign-in stores a new
 * one: no cron, webhook replan, poll sweep or booking page refreshes with the
 * previous holder's grant meanwhile (identity-store.ts reads an empty
 * credential as none). The row itself stays, carrying provider and
 * login_email for the next sign-in and owner mail. users.done_color_id is
 * kept: a cross-provider binder gets the store's own switch reset (done
 * colour included), while same-provider colour ids stay meaningful.
 *
 * The previous holder's Optical sessions end in the same batch, as offboard
 * ends them (owner-scoped-tables.ts): every live oauth_tokens row of the
 * subject (access and refresh) is revoked, and its unredeemed oauth_codes and
 * its pending_actions (agent-confirm links) are deleted. Otherwise whoever
 * held a bearer, refresh token or confirm link before the handover would keep
 * acting on the account once the next identity's credential is behind it.
 * Connected clients must re-authorise.
 *
 * The same batch deletes the subject's pending (uncommitted) proposed_plans,
 * which the previous holder's emailed accept links name, and revokes its live
 * calendar feed tokens, whose URLs would otherwise serve the next identity's
 * busy times to whoever the previous holder subscribed. Committed plans are
 * history and stay. The accept links themselves, and organiser poll-status
 * links, also die by anchor (identityAnchorTag below), which covers the plans
 * resolves make later.
 *
 * A compare-and-set on `expected` (the read the caller decided on): a sign-in
 * or offboard that lands between that read and this batch makes every
 * statement match nothing, so a decision made on stale state (the drift
 * check) never clears a row it didn't see. Returns whether the anchor was
 * cleared.
 */
export async function clearIdentityAnchor(
  db: D1Database, subject: string, expected: RebindTarget,
): Promise<boolean> {
  const unchanged =
    "account_email = ? AND provider IS ? AND provider_subject IS ? AND login_email IS ?";
  const cas = [subject, expected.storedProvider, expected.providerSubject, expected.loginEmail];
  const guard = `EXISTS (SELECT 1 FROM identity_tokens WHERE ${unchanged})`;
  const results = await db.batch([
    db.prepare(
      `UPDATE calendar_sync SET next_sync_token = NULL, channel_id = NULL, channel_token = NULL,
         channel_expires_at = NULL, channel_resource_id = NULL, channel_callback_url = NULL
       WHERE owner_subject = ? AND ${guard}`,
    ).bind(subject, ...cas),
    db.prepare(`UPDATE oauth_tokens SET revoked_at = ? WHERE subject = ? AND revoked_at IS NULL AND ${guard}`)
      .bind(new Date().toISOString(), subject, ...cas),
    db.prepare(`DELETE FROM oauth_codes WHERE subject = ? AND ${guard}`).bind(subject, ...cas),
    db.prepare(`DELETE FROM pending_actions WHERE owner_subject = ? AND ${guard}`).bind(subject, ...cas),
    db.prepare(`DELETE FROM proposed_plans WHERE subject = ? AND committed_at IS NULL AND ${guard}`)
      .bind(subject, ...cas),
    db.prepare(
      `UPDATE calendar_feed_tokens SET revoked_at = ? WHERE owner_subject = ? AND revoked_at IS NULL AND ${guard}`,
    ).bind(new Date().toISOString(), subject, ...cas),
    // Last: the guard above reads the row this statement changes.
    db.prepare(
      `UPDATE identity_tokens SET provider_subject = NULL, refresh_token_encrypted = X'' WHERE ${unchanged}`,
    ).bind(...cas),
  ]);
  const res = results[results.length - 1];
  return (res?.meta?.changes ?? 0) > 0;
}

/**
 * A short, opaque tag of `subject`'s identity anchor (provider and provider
 * subject; "no credential row" is a tag of its own). Accept links carry the tag
 * their subject had when they were minted (auth/capability.ts), as do
 * organiser poll-status links, and acceptLinkAnchorHolds /
 * pollStatusLinkAnchorHolds refuse one whose subject is now anchored elsewhere.
 * A keyed hash (hashToken under hashingKey(env), like every other stored token
 * hash), so the IdP subject never travels in an emailed URL and a leaked link
 * can't be checked offline against a guessed subject.
 *
 * An accept link is a capability for ANY pending plan of its subject (the
 * superseded flow in planning/accept.ts offers the week's replacement under
 * the same token), so deleting the pending plans at rebind can't end it by
 * itself: the next holder's first resolve would make a plan the previous
 * holder's link could show and commit. The tag changes when the rebind clears
 * the anchor and again when the next identity binds, and it also changes on a
 * provider switch, the other way an address passes to another identity.
 * The tag also changes when the stored credential is emptied (the rebind's
 * wipe), which is what kills the links of a legacy row whose provider_subject
 * was already NULL, since the anchor clear changes nothing there. A
 * same-identity sign-in keeps it, with one exception: a legacy (pre-0037) row
 * whose provider_subject is NULL gets it backfilled at its first sign-in, and
 * that changes the tag, so that user's own in-flight accept and poll-status
 * links die once.
 */
export async function identityAnchorTag(env: Env, subject: string): Promise<string> {
  const row = await env.DB
    .prepare(
      `SELECT provider, provider_subject, length(refresh_token_encrypted) > 0 AS has_credential
         FROM identity_tokens WHERE account_email = ?`,
    )
    .bind(subject)
    .first<{ provider: string | null; provider_subject: string | null; has_credential: number }>();
  let material = "no-credential";
  if (row) {
    const provider = row.provider && isProviderName(row.provider) ? row.provider : "google";
    // A row with a credential reads the material it always did, so links
    // minted before the wipe marker existed keep verifying. An emptied one
    // (the rebind's wipe) reads a material of its own: a legacy row's rebind
    // has no provider_subject to clear, and the wipe must still rotate it.
    material = `${row.has_credential ? "anchor" : "wiped"}\n${provider}\n${row.provider_subject ?? ""}`;
  }
  return hashToken(`identity-anchor:${material}`, hashingKey(env));
}

/** Whether an accept link still speaks for its subject: its anchor claim
 *  matches the subject's current identityAnchorTag. A link minted before the
 *  claim existed carries none and holds: every signer has stamped the claim
 *  since (signCapabilityWithEnv requires it), and a link's life is
 *  ACCEPT_TTL_SECONDS (72 h), so claim-less links are gone 72 h after deploy. */
export async function acceptLinkAnchorHolds(
  env: Env, claims: { subject: string; anchor?: string },
): Promise<boolean> {
  if (claims.anchor === undefined) return true;
  return claims.anchor === (await identityAnchorTag(env, claims.subject));
}

/** The same check for an organiser's poll-status link, with no claim-less
 *  transition: that link lives until the poll deadline + 7 days, and a deadline
 *  has no upper bound, so a claim-less link is refused outright. The organiser
 *  still opens the status page with a bearer (polls/route.ts). */
export async function pollStatusLinkAnchorHolds(
  env: Env, claims: { subject: string; anchor?: string },
): Promise<boolean> {
  return claims.anchor !== undefined && claims.anchor === (await identityAnchorTag(env, claims.subject));
}
