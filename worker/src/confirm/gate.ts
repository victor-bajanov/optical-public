// O9.1 agent-confirm gating. AGENT_CONFIRM_CLIENT_IDS names the OAuth clients
// (agents) whose consequential actions are deferred until the user confirms
// them by email: a comma-separated list of client ids, or "*" for every OAuth
// client. Unset or empty gates nobody (every env but the trial today).
import type { Env } from "../env";
import { bearerClientId } from "../middleware/auth-bearer";

export function isAgentConfirmClient(
  env: Pick<Env, "AGENT_CONFIRM_CLIENT_IDS">,
  clientId: string | undefined,
): boolean {
  // No OAuth client (a capability link, a public page, a cron) is never an
  // agent, so even "*" can't gate it.
  if (!clientId) return false;
  const ids = (env.AGENT_CONFIRM_CLIENT_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.includes("*") || ids.includes(clientId);
}

/** Cross-site guard for the human-confirm POSTs (/confirm/{id} and the
 *  acceptPlan capability branch): their only legitimate source is the form on
 *  our own page, which a browser sends with Sec-Fetch-Site: same-origin. Any
 *  other value (cross-site, same-site, none) is refused. An absent header
 *  (old browsers, non-browser clients) passes: the Authorization guard and
 *  the unguessable token cover those. Origin isn't used: with
 *  Referrer-Policy no-referrer a genuine form POST sends Origin: null. */
export function isForeignFetchSite(secFetchSite: string | undefined): boolean {
  return secFetchSite !== undefined && secFetchSite !== "same-origin";
}

/** True when this request's bearer belongs to a gated client, so the handler
 *  must call deferForConfirmation instead of acting. Call after requireOwner
 *  (requireBearer is what records the client id). */
export function confirmationRequired(c: { env: Env; get: (key: never) => unknown }): boolean {
  return isAgentConfirmClient(c.env, bearerClientId(c));
}
