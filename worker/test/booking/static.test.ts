import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { mountBookingRoutes } from "../../src/booking/route";
import type { AppVariables } from "../../src/index-providers";
import { BOOKING_CLIENT_JS, BOOKING_CLIENT_HASH } from "../../src/booking/booking-client-source.generated";
import { renderBookingPage } from "../../src/booking/page";
// Vite's `?raw` text-import (resolved by vite-node before the module ever
// reaches the workerd runtime) reads the real source for comparison below.
// node:fs is not available inside the workers pool, so this is the only way
// to get the actual file bytes into a test running under that pool.
import bookingClientSource from "../../src/booking/booking.client.js?raw";

const ON = { ...env, BOOKING_PAGE_ENABLED: "true" } as any;

const HASHED_PATH = `/book/_static/booking.${BOOKING_CLIENT_HASH}.js`;

describe("GET /book/_static/booking.<hash>.js", () => {
  it("serves the client module as JavaScript", async () => {
    const app = new Hono<{ Variables: AppVariables }>();
    mountBookingRoutes(app as any);
    const res = await app.request(HASHED_PATH, {}, ON);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(await res.text()).toContain("export function dotCount");
  });

  it("404s when the feature flag is off", async () => {
    const app = new Hono<{ Variables: AppVariables }>();
    mountBookingRoutes(app as any);
    const res = await app.request(HASHED_PATH, {}, { ...ON, BOOKING_PAGE_ENABLED: "false" });
    expect(res.status).toBe(404);
  });

  it("is cached immutably, which the hash in the name is what makes safe", async () => {
    // The whole point of the rename. Previously this was max-age=3600 on a
    // FIXED url with no ETag and no Last-Modified, so a browser would not even
    // revalidate: every booker who had loaded the page in the previous hour
    // kept running the old client after a deploy. That shipped a parser fix
    // that silently did not reach people.
    const app = new Hono<{ Variables: AppVariables }>();
    mountBookingRoutes(app as any);
    const res = await app.request(HASHED_PATH, {}, ON);
    const cc = res.headers.get("cache-control") ?? "";
    expect(cc).toContain("immutable");
    expect(cc).toMatch(/max-age=\d{7,}/); // a year, not an hour
  });

  it("no longer serves the unversioned path, so a stale url cannot resolve", async () => {
    const app = new Hono<{ Variables: AppVariables }>();
    mountBookingRoutes(app as any);
    const res = await app.request("/book/_static/booking.js", {}, ON);
    expect(res.status).toBe(404);
  });

  it("does not serve some other hash", async () => {
    const app = new Hono<{ Variables: AppVariables }>();
    mountBookingRoutes(app as any);
    const res = await app.request("/book/_static/booking.0123456789abcdef.js", {}, ON);
    expect(res.status).toBe(404);
  });
});

describe("client asset cache-busting", () => {
  it("derives the hash from the client source, so any edit changes the url", async () => {
    // Not hand-maintained: bin/build-client-js.sh computes it. If this drifts,
    // a deploy would reuse a url whose content changed — the exact failure the
    // hash exists to prevent.
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(BOOKING_CLIENT_JS));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(BOOKING_CLIENT_HASH).toBe(hex.slice(0, 16));
  });

  it("points the page's script tag at the hashed url", () => {
    const html = renderBookingPage({
      slug: "s",
      durations: [30],
      siteKey: "k",
      modes: [{ kind: "phone" }],
    });
    expect(html).toContain(`src="${HASHED_PATH}"`);
    expect(html).not.toContain('src="/book/_static/booking.js"');
  });
});

describe("booking-client-source.generated.ts", () => {
  // The vitest workers pool can't resolve a wrangler Text-module import
  // (`?raw-text`), so the served copy lives in a generated TS string module
  // instead (bin/build-client-js.sh) rather than the source .js directly.
  // That means booking.client.js is no longer the ONLY copy — a generated
  // copy can silently drift from it. Guard against that by comparing full
  // content, not just presence of one exported name: a byte anywhere in
  // booking.client.js changing without a re-run of the generator must fail
  // this test.
  it("is byte-identical to booking.client.js, re-wrapped as a string literal", () => {
    expect(BOOKING_CLIENT_JS).toBe(bookingClientSource);
  });
});
