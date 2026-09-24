import type { Env } from "../env";
import type { ProviderName } from "../providers/provider-name";

/** The webhook path Google/Microsoft push notifications land on, keyed by
 *  which provider the callback is being registered with. Both routes are
 *  mounted under /v1/webhook/* — see webhooks/google-calendar.ts and
 *  webhooks/microsoft-calendar.ts. */
export function webhookCallbackUrl(env: Env, provider: ProviderName): string {
  return provider === "microsoft"
    ? `${env.OAUTH_ISSUER}/v1/webhook/microsoft-calendar`
    : `${env.OAUTH_ISSUER}/v1/webhook/google-calendar`;
}
