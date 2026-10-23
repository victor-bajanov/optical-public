import type { Env } from "../env";
import type { IdentityProvider } from "./identity-provider";
import { ProviderDisabledError } from "../index-providers";

/** Anything that can revoke a grant (an IdentityProvider, or a test double). */
export type RevokeCapable = Pick<IdentityProvider, "revokeGrant">;

export type RevokeOutcome = "disabled" | "no_token" | "revoked" | "provider_disabled" | "failed";

/** UPSTREAM_REVOKE_ENABLED gate (exactly "true"; see env.ts for why it is
 *  trial-only). */
export function upstreamRevokeEnabled(env: Pick<Env, "UPSTREAM_REVOKE_ENABLED">): boolean {
  return env.UPSTREAM_REVOKE_ENABLED === "true";
}

/**
 * Best-effort upstream grant revocation, shared by offboard and the OAuth
 * callback. The single home for the flag check and the failure contract:
 *
 * - Flag off: returns "disabled" without reading the token or building the
 *   IdP, and logs nothing.
 * - NEVER throws. A ProviderDisabledError (MS kill switch) logs
 *   `<logPrefix>_skipped`. Any other error from the token source, IdP
 *   construction or the revoke logs `<logPrefix>_failed`.
 * - The token never reaches a log line. Errors are redacted in case an IdP
 *   (or a double) echoes it back.
 *
 * `token` and `idp` may be plain values or lazy factories. Factories let a
 * caller defer the decrypt and the provider lookup until the flag says the
 * step runs, and route their errors through the same contract.
 */
export async function revokeUpstreamGrant(
  env: Pick<Env, "UPSTREAM_REVOKE_ENABLED">,
  args: {
    token: string | null | (() => Promise<string | null>);
    idp: RevokeCapable | (() => RevokeCapable | Promise<RevokeCapable>);
    logPrefix: string;
    context?: Record<string, unknown>;
  },
): Promise<RevokeOutcome> {
  if (!upstreamRevokeEnabled(env)) return "disabled";
  let token: string | null = null;
  try {
    token = typeof args.token === "function" ? await args.token() : args.token;
    if (!token) return "no_token";
    const idp = typeof args.idp === "function" ? await args.idp() : args.idp;
    await idp.revokeGrant(token);
    return "revoked";
  } catch (e) {
    if (e instanceof ProviderDisabledError) {
      console.warn(`${args.logPrefix}_skipped`, { ...args.context, reason: "provider_disabled" });
      return "provider_disabled";
    }
    const error = token ? String(e).split(token).join("[redacted]") : String(e);
    console.warn(`${args.logPrefix}_failed`, { ...args.context, error });
    return "failed";
  }
}
