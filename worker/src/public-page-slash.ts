import type { MiddlewareHandler } from "hono";

/** Public HTML pages a person opens from a link or types by hand. Hono
 *  matches routes strictly, so `/book/x/` used to 404; these alone get a 301
 *  to the slashless path. JSON endpoints, assets, `/v1/*` (bar the emailed
 *  accept page), `/oauth/*`, `/auth/*`, `/admin/*` and webhooks stay strict.
 *  Each pattern is anchored and its segments are non-empty with no `/`, so
 *  only a single trailing slash on a known page shape is ever stripped. */
const PUBLIC_PAGES: readonly RegExp[] = [
  /^\/book\/[^/]+$/,
  /^\/poll\/[^/]+$/,
  /^\/poll\/[^/]+\/status$/,
  /^\/confirm\/[^/]+$/,
  /^\/cal-reveal\/[^/]+$/,
  /^\/v1\/plans\/[^/]+\/accept$/,
];

/** 301 a GET/HEAD for a public page with one trailing slash to the same path
 *  without it, query string kept verbatim (pages carry `?t=` capability
 *  tokens). The Location is a relative path built from the request path, and
 *  every pattern starts with a fixed segment, so it can never be `//host`. */
export const publicPageTrailingSlash: MiddlewareHandler = async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
  const url = new URL(c.req.url);
  if (!url.pathname.endsWith("/") || url.pathname === "/") return next();
  const stripped = url.pathname.slice(0, -1);
  if (!PUBLIC_PAGES.some((re) => re.test(stripped))) return next();
  return new Response(null, { status: 301, headers: { location: stripped + url.search } });
};
