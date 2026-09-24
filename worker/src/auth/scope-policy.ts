// worker/src/auth/scope-policy.ts
// Pure scope-narrowing policy applied at OAuth issuance. See
// internal design notes §2.

// Privileged scopes that must be explicitly granted. `calendar:raw-token` is
// gated by the client allowlist only; `admin` additionally requires the
// subject's admin role (see applyRoleEntitlement).
export const PRIVILEGED_SCOPES = ["calendar:raw-token", "admin"] as const;

/**
 * Client-capability gate. Returns the requested scopes if EVERY one is in the
 * client's allowed set, else null — the caller fails loud (400 invalid_scope),
 * because a client requesting a scope it is not configured for is a static
 * misconfiguration, not a runtime condition.
 */
export function intersectClientScopes(
  requested: string[],
  clientAllowed: string[],
): string[] | null {
  for (const s of requested) {
    if (!clientAllowed.includes(s)) return null;
  }
  return requested;
}

/**
 * User-entitlement gate. Silently drops the `admin` scope unless the subject is
 * an admin. Silent (not 400) because which subject logs in through a given
 * client is runtime: the same authorize URL serves admins and members, and a
 * member must still be able to mint a (non-admin) token.
 */
export function applyRoleEntitlement(scopes: string[], isAdmin: boolean): string[] {
  return isAdmin ? scopes : scopes.filter((s) => s !== "admin");
}
