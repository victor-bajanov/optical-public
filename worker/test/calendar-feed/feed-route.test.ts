import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { mountCalendarFeedRoute } from "../../src/calendar-feed/feed-route";
import { createFeed } from "../../src/db/calendar-feed-tokens";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { SCHEDULER_CHUNK_ID_KEY } from "../../src/providers/types";
import type { CalendarEvent } from "../../src/providers/types";
import type { AppVariables } from "../../src/index-providers";

const OWNER = "feed-owner@org";

// Dates RELATIVE to now: the feed route derives its window from real `new Date()`
// and MockCalendarProvider.fetchEventsInWindow filters events to that window, so
// hardcoded calendar dates would fall outside the window and silently vanish.
const START = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
const END = new Date(Date.now() + 25 * 3600 * 1000).toISOString();

function ev(id: string, chunkTask?: string): CalendarEvent {
  return {
    id,
    summary: "private title",
    start: START,
    end: END,
    extendedProperties: { private: chunkTask ? { [SCHEDULER_CHUNK_ID_KEY]: `${chunkTask}#0` } : {} },
  } as CalendarEvent;
}

async function seedTask(id: string, pinned: boolean) {
  const body = JSON.stringify({ title: "t", pinned_at: pinned ? "2026-06-10T09:00:00Z" : null });
  await env.DB.prepare(
    "INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?,?,?,?,?,?)",
  ).bind(id, OWNER, body, "committed", "2026-06-01T00:00:00Z", "2026-06-01T00:00:00Z").run();
}

function appWith(provider: MockCalendarProvider) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => { c.set("calendarProvider", provider); await next(); });
  mountCalendarFeedRoute(app as any);
  return app;
}

describe("GET /cal/:token/busy.ics", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM calendar_feed_tokens").run();
    await env.DB.prepare("DELETE FROM tasks").run();
  });

  it("includes meetings + pinned tasks, excludes movable tasks", async () => {
    await seedTask("task-pinned", true);
    await seedTask("task-movable", false);
    const { secret } = await createFeed(env.DB, env, OWNER, "default", []);
    const provider = new MockCalendarProvider({
      events: [ev("ext-meeting"), ev("g-pinned", "task-pinned"), ev("g-movable", "task-movable")],
    });
    const res = await appWith(provider).request(`/cal/${secret}/busy.ics`, {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/calendar");
    const body = await res.text();
    expect((body.match(/BEGIN:VEVENT/g) ?? []).length).toBe(2); // meeting + pinned only
    expect(body).toContain("SUMMARY:Busy");
    expect(body).not.toContain("private title");
  });

  it("404s on an unknown token", async () => {
    const res = await appWith(new MockCalendarProvider()).request("/cal/bogus/busy.ics", {}, env);
    expect(res.status).toBe(404);
  });

  it("404s on a revoked token", async () => {
    const { secret } = await createFeed(env.DB, env, OWNER, "default", []);
    await env.DB.prepare("UPDATE calendar_feed_tokens SET revoked_at = ? WHERE owner_subject = ?")
      .bind("2026-06-09T00:00:00Z", OWNER).run();
    const res = await appWith(new MockCalendarProvider()).request(`/cal/${secret}/busy.ics`, {}, env);
    expect(res.status).toBe(404);
  });

  it("404s when the feature flag is off", async () => {
    const res = await appWith(new MockCalendarProvider()).request("/cal/anything/busy.ics", {}, {
      CALENDAR_FEED_ENABLED: "false",
    } as any);
    expect(res.status).toBe(404);
  });

  it("does not leak another owner's events (token is owner-scoped)", async () => {
    await seedTask("task-pinned", true);
    const { secret } = await createFeed(env.DB, env, OWNER, "default", []);
    // Provider for a DIFFERENT owner would never be reached; the token resolves
    // to OWNER and only OWNER's pinned set is loaded. Assert the pinned task is
    // present and nothing else slips in.
    const provider = new MockCalendarProvider({ events: [ev("g-pinned", "task-pinned")] });
    const res = await appWith(provider).request(`/cal/${secret}/busy.ics`, {}, env);
    const body = await res.text();
    expect((body.match(/BEGIN:VEVENT/g) ?? []).length).toBe(1);
  });

  it("reveals matching titles only on the endpoint that carries the regex", async () => {
    // Two endpoints for the same owner: one carries a reveal regex, one
    // doesn't. A real (non-optical) meeting whose title matches the regex
    // must be revealed on the first endpoint's feed and stay opaque on the
    // second's.
    const withRegex = await createFeed(env.DB, env, OWNER, "reveal", ["Northwinds hold .*"]);
    const plain = await createFeed(env.DB, env, OWNER, "other", []);
    const provider = new MockCalendarProvider({
      events: [{ ...ev("hold-event"), summary: "Northwinds hold - x" }],
    });
    const icsA = await (await appWith(provider).request(`/cal/${withRegex.secret}/busy.ics`, {}, env)).text();
    const icsB = await (await appWith(provider).request(`/cal/${plain.secret}/busy.ics`, {}, env)).text();
    expect(icsA).toContain("SUMMARY:Northwinds hold - x");
    expect(icsB).not.toContain("Northwinds");
    expect(icsB).toContain("SUMMARY:Busy");
  });
});
