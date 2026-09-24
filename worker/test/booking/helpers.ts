import { env } from "cloudflare:test";
import { hashToken } from "../../src/auth/tokens";
import { hashingKey } from "../../src/auth/crypto-keys";
import { v1 } from "../../src/v1";

/** Default caller for the booking management suite. Every suite under
 *  test/booking/ shares one database, so each scopes its rows to its own
 *  subject rather than truncating tables. */
export const OWNER = "book-mgmt@org";
export const OWNER_TOKEN = "book-mgmt-tok";

/** Mint a bearer for `subject`, as test/calendar-feed/management.test.ts does:
 *  an oauth_clients row plus an oauth_tokens row keyed by the hashed token.
 *  `hashingKey(env)` is the resolver requireBearer uses (HASHING_KEY falling
 *  back to TOKEN_HASH_PEPPER) — hashing with the pepper directly would not
 *  match on a deployment that splits the two. */
export async function seedBearer(subject: string = OWNER, token: string = OWNER_TOKEN): Promise<void> {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO oauth_clients (id, name, type, redirect_uris, created_at) VALUES (?,?,?,?,?)",
  ).bind("book-client", "booking-test", "pkce", null, "2026-01-01T00:00:00Z").run();
  const hashed = await hashToken(token, hashingKey(env));
  await env.DB.prepare(
    `INSERT OR REPLACE INTO oauth_tokens
       (hashed_token, client_id, scopes, expires_at, refresh_of, revoked_at, subject)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(hashed, "book-client", "scheduler:read scheduler:write", "2099-01-01T00:00:00Z", null, null, subject).run();
}

/** The management routes are gated on BOOKING_PAGE_ENABLED, which wrangler.toml
 *  leaves "false" at the top level (the config the test pool loads). Turn it on
 *  here so each suite states its own flag position instead of inheriting one. */
const ON = { ...env, BOOKING_PAGE_ENABLED: "true" };

/** A `v1` request bound to a bearer token: `authedApp().request("/booking-page")`.
 *  Pass a different token to act as a different caller. */
export function authedApp(token: string = OWNER_TOKEN) {
  return {
    request(path: string, init: RequestInit = {}): Promise<Response> {
      return v1.request(
        path,
        { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } },
        ON,
      ) as Promise<Response>;
    },
  };
}
