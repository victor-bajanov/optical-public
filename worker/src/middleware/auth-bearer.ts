import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";
import { hashToken } from "../auth/tokens";
import { hashingKey } from "../auth/crypto-keys";
import { bumpLastSeenBestEffort, isActivityBumpDue } from "../db/users";

type Vars = { clientId: string; scopes: string[]; subject?: string };

/** The OAuth client id requireBearer authenticated this request with, or
 *  undefined when no bearer ran (capability links, public pages, cron). Read
 *  through this accessor rather than c.var: AppVariables (index-providers.ts)
 *  doesn't declare `clientId`, since only bearer routes ever have one. */
export function bearerClientId(c: { get: (key: never) => unknown }): string | undefined {
  const v = c.get("clientId" as never);
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export const requireBearer: MiddlewareHandler<{ Bindings: Env; Variables: Vars }> = async (c, next) => {
  const auth = c.req.header("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return c.json({ error: "missing_bearer" }, 401);
  const token = m[1]!;
  // hashingKey (HASHING_KEY, falling back to TOKEN_HASH_PEPPER) is the key the
  // OAuth provider hashes access tokens with at issue/refresh time. requireBearer
  // MUST use the same resolver — using TOKEN_HASH_PEPPER directly breaks bearer
  // auth on any deployment that splits HASHING_KEY from the pepper (e.g. dev).
  const hashed = await hashToken(token, hashingKey(c.env));
  // refresh_of IS NULL excludes refresh tokens: they share this table but must
  // never authenticate as access tokens (token-confusion / rotation bypass).
  // The LEFT JOIN reads the subject's users row in the same round trip, so the
  // last_seen bump below costs no extra query on the (common) throttled path.
  const row = await c.env.DB.prepare(
    `SELECT t.client_id, t.scopes, t.subject, t.expires_at, t.revoked_at,
            u.is_active AS user_is_active, u.last_seen AS user_last_seen,
            u.retention_warned_at AS user_retention_warned_at
       FROM oauth_tokens t LEFT JOIN users u ON u.subject = t.subject
      WHERE t.hashed_token = ? AND t.refresh_of IS NULL`,
  ).bind(hashed).first<{
    client_id: string; scopes: string; subject: string | null; expires_at: string | null; revoked_at: string | null;
    user_is_active: number | null; user_last_seen: string | null; user_retention_warned_at: string | null;
  }>();
  if (!row) return c.json({ error: "invalid_token" }, 401);
  if (row.revoked_at) return c.json({ error: "revoked_token" }, 401);
  if (row.expires_at && row.expires_at < new Date().toISOString()) return c.json({ error: "expired_token" }, 401);
  c.set("clientId", row.client_id);
  c.set("scopes", row.scopes.split(" ").filter(Boolean));
  if (row.subject) {
    c.set("subject", row.subject);
    // O10a: authenticated use is activity, so retention (RETENTION_DAYS) never
    // sweeps a user who works only through refreshed bearer tokens. Only an
    // ACTIVE users row is bumped (no row / offboarded: skip; the UPDATE's own
    // WHERE re-checks both, so a stale read here can't insert or reactivate),
    // at most once per throttle window. Runs before next() so requireOwner's
    // inline call (dummy next) bumps too. Awaited but best-effort: a failure
    // logs last_seen_bump_failed and never fails the request. O10b: a stamped
    // retention warning bypasses the throttle, so the warned user's next call
    // clears it (activity cancels the pending deletion).
    if (row.user_is_active === 1 && isActivityBumpDue(row.user_last_seen, row.user_retention_warned_at)) {
      await bumpLastSeenBestEffort(c.env.DB, row.subject, "bearer");
    }
  }
  await next();
};
