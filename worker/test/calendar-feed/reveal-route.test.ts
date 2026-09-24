import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { mountCalendarRevealRoute } from "../../src/calendar-feed/reveal-route";
import { createReveal } from "../../src/db/calendar-feed-reveals";
import type { AppVariables } from "../../src/index-providers";

const OWNER = "o@x";
const FEED_URL = "https://s.example/cal/sekrit/busy.ics";

// Local app mounting only the route under test, same pattern as
// feed-route.test.ts's appWith(): the root app's default export is an
// ExportedHandler ({fetch, scheduled}), not a Hono instance, so it has no
// .request(path, init, env) — building a minimal typed Hono app here is how
// the env-override 3rd arg (used below to flip CALENDAR_FEED_ENABLED) works.
const app = new Hono<{ Variables: AppVariables }>();
mountCalendarRevealRoute(app as any);

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM calendar_feed_reveals").run();
});

describe("/cal-reveal/:token", () => {
  it("404s when the feature flag is off (GET and POST)", async () => {
    const off = Object.assign(Object.create(env), { CALENDAR_FEED_ENABLED: "false" });
    expect((await app.request("/cal-reveal/abc", {}, off)).status).toBe(404);
    expect((await app.request("/cal-reveal/abc", { method: "POST" }, off)).status).toBe(404);
  });

  it("GET shows the button page and does NOT consume", async () => {
    const token = await createReveal(env.DB, env, "f1", OWNER, FEED_URL, new Date());
    const res = await app.request(`/cal-reveal/${token}`, {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    const html = await res.text();
    expect(html).toContain("Reveal secret");
    expect(html).not.toContain(FEED_URL);
    // Still consumable afterwards:
    const post = await app.request(`/cal-reveal/${token}`, { method: "POST" }, env);
    expect(await post.text()).toContain(FEED_URL);
  });

  it("POST reveals once; the second POST gets the expired page", async () => {
    const token = await createReveal(env.DB, env, "f1", OWNER, FEED_URL, new Date());
    const first = await app.request(`/cal-reveal/${token}`, { method: "POST" }, env);
    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    expect(first.headers.get("X-Frame-Options")).toBe("DENY");
    expect(await first.text()).toContain(FEED_URL);
    const second = await app.request(`/cal-reveal/${token}`, { method: "POST" }, env);
    expect(second.status).toBe(410);
    expect(await second.text()).not.toContain(FEED_URL);
  });

  it("unknown token POST gets the same expired page", async () => {
    const res = await app.request("/cal-reveal/nope", { method: "POST" }, env);
    expect(res.status).toBe(410);
  });
});
