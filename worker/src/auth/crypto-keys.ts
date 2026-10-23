import type { Env } from "../env";

// Purpose-specific key resolvers (Plan 4 brief E). Each reads its own var and
// falls back to TOKEN_HASH_PEPPER when that var is unset OR empty, so a
// deployment that has not split its secrets keeps working with the single
// pepper, and the test env (which sets only TOKEN_HASH_PEPPER) stays green.
//
// Fail closed (O14 #8): with neither set, the derivations would interpolate
// `undefined` into a publicly known key (forgeable capability links, a
// predictable token hash). Throw instead. The message names the vars, never a
// value.
function resolve(env: Env, name: "HASHING_KEY" | "ENCRYPTION_KEY" | "HMAC_KEY"): string {
  const k = env[name] || env.TOKEN_HASH_PEPPER;
  if (!k) throw new Error(`crypto_key_missing: set ${name} or TOKEN_HASH_PEPPER`);
  return k;
}

// hashToken (oauth_tokens / oauth_codes lookups, bearer auth).
export function hashingKey(env: Env): string {
  return resolve(env, "HASHING_KEY");
}

// AES-GCM encryption of identity_tokens.refresh_token_encrypted.
export function encryptionKey(env: Env): string {
  return resolve(env, "ENCRYPTION_KEY");
}

// Capability-token HMAC and the OAuth-state CSRF cookie HMAC.
export function capabilityHmacKey(env: Env): string {
  return resolve(env, "HMAC_KEY");
}
