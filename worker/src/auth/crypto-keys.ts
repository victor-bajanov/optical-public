import type { Env } from "../env";

// Purpose-specific key resolvers (Plan 4 brief E). Each reads its own var and
// falls back to TOKEN_HASH_PEPPER when that var is unset OR empty, so a
// deployment that has not split its secrets keeps working with the single
// pepper, and the test env (which sets only TOKEN_HASH_PEPPER) stays green.

// hashToken (oauth_tokens / oauth_codes lookups, bearer auth).
export function hashingKey(env: Env): string {
  return env.HASHING_KEY || env.TOKEN_HASH_PEPPER;
}

// AES-GCM encryption of identity_tokens.refresh_token_encrypted.
export function encryptionKey(env: Env): string {
  return env.ENCRYPTION_KEY || env.TOKEN_HASH_PEPPER;
}

// Capability-token HMAC and the OAuth-state CSRF cookie HMAC.
export function capabilityHmacKey(env: Env): string {
  return env.HMAC_KEY || env.TOKEN_HASH_PEPPER;
}
