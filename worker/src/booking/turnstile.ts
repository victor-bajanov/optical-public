import type { Env } from "../env";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Circuit breakers, not scheduling preferences — deliberately constants rather
 *  than per-user config. */
export const MAX_CLAIMS_PER_IP_24H = 5;
export const MAX_CLAIMS_PER_PAGE_24H = 20;

/** Verify a Turnstile token. Fails CLOSED: a network error, a malformed
 *  response, a missing token, or a token solved somewhere else all deny the
 *  claim, because this gate is the only thing standing between a public
 *  endpoint and invites sent from the owner's account.
 *
 *  `expectedHostname` is the host that served the page carrying the widget —
 *  the caller derives it from the incoming request URL. Cloudflare returns the
 *  hostname the challenge was actually solved on, and checking it is what stops
 *  a token minted for this sitekey on somebody else's page from being replayed
 *  here; `success: true` alone does not distinguish the two. A response with no
 *  hostname at all is denied rather than waved through.
 *
 *  The one exception is Cloudflare's published always-passes *testing* secret,
 *  which answers `hostname: "example.com"` for every caller and marks itself
 *  with `metadata.result_with_testing_key`. Only that flag waives the check, so
 *  a deployment holding a real secret can never skip it — and a deployment
 *  holding the testing secret has no effective challenge to weaken anyway
 *  (runbook §K). */
export async function verifyTurnstile(
  env: Env,
  token: string,
  remoteIp: string,
  expectedHostname: string,
): Promise<boolean> {
  if (!token) return false;
  const secret = env.TURNSTILE_SECRET;
  if (!secret) return false;
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (remoteIp) form.append("remoteip", remoteIp);
  try {
    const res = await fetch(SITEVERIFY, { method: "POST", body: form });
    if (!res.ok) return false;
    const body = (await res.json()) as {
      success?: boolean;
      hostname?: string;
      metadata?: { result_with_testing_key?: boolean };
    };
    if (body.success !== true) return false;
    if (body.metadata?.result_with_testing_key === true) return true;
    return body.hostname === expectedHostname;
  } catch {
    return false;
  }
}
