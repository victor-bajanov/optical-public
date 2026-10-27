import type { Env } from "../env";

/** The Workers Rate Limiting binding's surface (`[[ratelimits]]` in
 *  wrangler.toml). Declared structurally so tests can hand in a fake. */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** Both limiters count over a 60 s period (the binding allows 10 or 60), so
 *  a caller turned away can retry after at most this long. */
export const PUBLIC_READ_RETRY_AFTER_SECONDS = 60;

type LimiterName = "PUBLIC_READ_IP_LIMITER" | "PUBLIC_READ_TARGET_LIMITER";

/** Thrown by the cached reader (public-read/events-cache.ts) when a cache
 *  miss would read the calendar but the page's per-target budget is spent.
 *  The routes map it to `rateLimitedResponse()`. */
export class PublicReadRateLimitedError extends Error {
  constructor(target: string) {
    super(`public read limit reached for ${target}`);
    this.name = "PublicReadRateLimitedError";
  }
}

/** The one 429 every public read limit answers with. */
export function rateLimitedResponse(): Response {
  return new Response(JSON.stringify({ error: "rate_limited" }), {
    status: 429,
    headers: {
      "content-type": "application/json",
      "retry-after": String(PUBLIC_READ_RETRY_AFTER_SECONDS),
      "X-Robots-Tag": "noindex",
    },
  });
}

/** The per-IP limiter key. IPv4 is the address. IPv6 is its /64: one
 *  subscriber is routinely handed a whole /64, so keying on the full address
 *  would give a single client 2^64 budgets. Anything unparseable is keyed
 *  as given. */
export function ipLimitKey(ip: string): string {
  if (!ip.includes(":")) return `ip:${ip}`;
  const halves = ip.toLowerCase().split("::");
  if (halves.length > 2) return `ip:${ip}`;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return `ip:${ip}`;
  const hextets = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (!hextets.every((h) => /^[0-9a-f]{1,4}$/.test(h))) return `ip:${ip}`;
  const prefix = hextets.slice(0, 4).map((h) => parseInt(h, 16).toString(16));
  return `ip:${prefix.join(":")}::/64`;
}

/** true = allowed. An unbound or failing limiter allows the request: the
 *  calendar cache still bounds provider reads, and a limiter outage must not
 *  take every public page down with it. wrangler.toml declares both bindings
 *  in every env block (test/public-read/wiring.test.ts pins it), so unbound
 *  only happens off-platform. */
async function allowed(env: Env, name: LimiterName, key: string): Promise<boolean> {
  const binding = env[name];
  if (!binding) {
    console.warn("public_read_limiter_unbound", { binding: name });
    return true;
  }
  try {
    return (await binding.limit({ key })).success;
  } catch (err) {
    console.warn("public_read_limiter_error", { binding: name, error: String(err) });
    return true;
  }
}

/** The public availability reads (`GET /book/{slug}/slots`,
 *  `GET /poll/{id}/grid`, `PUT /poll/{id}/response`) have two limits, and
 *  they guard different things.
 *
 *  Per client IP (`ip:<addr>`, an IPv6 /64; shared by the booking and poll
 *  routes): every request, checked by the route AFTER its flag, slug/token
 *  and membership checks (so a disabled or delisted page is still the same
 *  404/401, never a 429) and before anything else. Returns the 429 to send,
 *  or null. With no client IP (a request that did not come through
 *  Cloudflare's edge) it is skipped.
 *
 *  Per page (`book:<slug>` / `poll:<id>`): only on a cache MISS, inside the
 *  cached reader, right before the provider call (`publicReadTargetAllowed`).
 *  It exists to bound provider reads, and a cache hit costs none, so a burst
 *  of hits on a warm page never locks other visitors out of it.
 *
 *  The binding counts per Cloudflare location and is eventually consistent,
 *  so these are abuse ceilings, not exact quotas. Limits live in
 *  wrangler.toml (runbook §K). */
export async function checkPublicReadIpLimit(env: Env, ip: string): Promise<Response | null> {
  if (ip === "") return null;
  return (await allowed(env, "PUBLIC_READ_IP_LIMITER", ipLimitKey(ip))) ? null : rateLimitedResponse();
}

/** Spends one unit of the page's per-target budget; see above. */
export function publicReadTargetAllowed(env: Env, target: string): Promise<boolean> {
  return allowed(env, "PUBLIC_READ_TARGET_LIMITER", target);
}
