import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";
import { hashToken } from "../auth/tokens";
import { hashingKey } from "../auth/crypto-keys";

type Vars = { clientId: string; scopes: string[]; subject?: string };

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
  const row = await c.env.DB.prepare(
    `SELECT client_id, scopes, subject, expires_at, revoked_at FROM oauth_tokens WHERE hashed_token = ? AND refresh_of IS NULL`,
  ).bind(hashed).first<{ client_id: string; scopes: string; subject: string | null; expires_at: string | null; revoked_at: string | null }>();
  if (!row) return c.json({ error: "invalid_token" }, 401);
  if (row.revoked_at) return c.json({ error: "revoked_token" }, 401);
  if (row.expires_at && row.expires_at < new Date().toISOString()) return c.json({ error: "expired_token" }, 401);
  c.set("clientId", row.client_id);
  c.set("scopes", row.scopes.split(" ").filter(Boolean));
  if (row.subject) c.set("subject", row.subject);
  await next();
};
