import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { mountBookingRoutes } from "../../src/booking/route";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { MockNotificationProvider } from "../../src/providers/mock-notification-provider";
import { saveBookingPage } from "../../src/db/booking-page";
import { claimSlot } from "../../src/db/bookings";
import type { RateLimitBinding } from "../../src/public-read/rate-limit";
import type { AppVariables } from "../../src/index-providers";
import type { Env } from "../../src/env";
import type { BusinessHours } from "../../src/planning/solver-contract";

// Public read cache + limiter on GET /book/{slug}/slots (finding #5). Every
// test gets its own owner and slug: the Cache API and the toml-declared
// limiters are not reset between tests.

type App = Hono<{ Bindings: Env; Variables: AppVariables }>;

const ALL_DAY: BusinessHours = {
  days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
  start: "00:00",
  end: "23:45",
} as BusinessHours;

const TEST_ENV = env as unknown as Env;
const ON: Env = {
  ...TEST_ENV,
  BOOKING_PAGE_ENABLED: "true",
  TURNSTILE_SECRET: "s",
  PUBLIC_READ_CACHE_TTL_SECONDS: "60",
};

let seq = 0;
let owner = "";
let slug = "";

function appWith(provider: MockCalendarProvider): App {
  const app: App = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("calendarProvider", provider);
    c.set("notificationProvider", new MockNotificationProvider());
    await next();
  });
  mountBookingRoutes(app);
  return app;
}

/** A provider whose live reads are counted. */
function countedProvider() {
  const provider = new MockCalendarProvider();
  const fetches = vi.spyOn(provider, "fetchEventsInWindow");
  return { provider, fetches };
}

function slots(app: App, e: Env = ON, q = "duration=30", headers: Record<string, string> = {}) {
  return app.request(`/book/${slug}/slots?${q}`, { headers }, e);
}

function denyAll(): RateLimitBinding & { keys: string[] } {
  const keys: string[] = [];
  return { keys, limit: async ({ key }) => { keys.push(key); return { success: false }; } };
}
function allowAll(): RateLimitBinding & { keys: string[] } {
  const keys: string[] = [];
  return { keys, limit: async ({ key }) => { keys.push(key); return { success: true }; } };
}

beforeEach(async () => {
  seq += 1;
  owner = `public-read-${Date.now()}-${seq}@org`;
  slug = `pr-${Date.now().toString(36)}-${seq}`;
  await saveBookingPage(env.DB, owner, {
    slug,
    enabled: true,
    hours: ALL_DAY,
    horizon_days: 7,
    max_horizon_days: 14,
    min_notice_minutes: 0,
    durations_minutes: [30, 60],
    buffer_minutes: { before: 0, after: 0 },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /book/{slug}/slots — calendar cache", () => {
  it("a burst costs one calendar read", async () => {
    const { provider, fetches } = countedProvider();
    const app = appWith(provider);
    const bodies: unknown[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await slots(app);
      expect(res.status).toBe(200);
      bodies.push(((await res.json()) as { slots: string[] }).slots);
    }
    expect(fetches).toHaveBeenCalledTimes(1);
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
  });

  it("durations share a page's read; another page is its own read", async () => {
    const { provider, fetches } = countedProvider();
    const app = appWith(provider);
    expect((await slots(app, ON, "duration=30")).status).toBe(200);
    expect((await slots(app, ON, "duration=60")).status).toBe(200);
    expect(fetches).toHaveBeenCalledTimes(1);
    expect((await slots(app, ON, "duration=30&page=1")).status).toBe(200);
    expect(fetches).toHaveBeenCalledTimes(2);
    expect((await slots(app, ON, "duration=60&page=1")).status).toBe(200);
    expect(fetches).toHaveBeenCalledTimes(2);
  });

  it("a new D1 booking blocks its slot at once, despite a warm cache", async () => {
    const { provider, fetches } = countedProvider();
    const app = appWith(provider);
    const before = ((await (await slots(app)).json()) as { slots: string[] }).slots;
    const start = before[0]!;
    const end = new Date(Date.parse(start) + 30 * 60_000).toISOString();
    const claim = await claimSlot(env.DB, {
      ownerSubject: owner,
      slug,
      startUtc: start,
      endUtc: end,
      durationMinutes: 30,
      bookerName: "Sam",
      bookerEmail: "sam@x.com",
      bookerNote: null,
      locationKind: "meet",
      locationDetail: null,
      ipHash: "h",
      guardStartUtc: start,
      guardEndUtc: end,
      now: new Date(),
    });
    expect(claim).not.toBeNull();
    const after = ((await (await slots(app)).json()) as { slots: string[] }).slots;
    expect(after).not.toContain(start);
    expect(fetches).toHaveBeenCalledTimes(1);
  });

  it("a commit's calendar write shows at once: the tasks stamp moves the cache generation", async () => {
    const { provider, fetches } = countedProvider();
    const app = appWith(provider);
    const start = ((await (await slots(app)).json()) as { slots: string[] }).slots[0]!;
    // What commit does for a pinned task: write its chunk to the calendar,
    // THEN stamp the task row (status/scheduled_for/updated_at).
    const taskId = `pinned-${owner}`;
    await provider.createEvent(
      {
        id: "",
        summary: "Pinned focus",
        start,
        end: new Date(Date.parse(start) + 30 * 60_000).toISOString(),
        extendedProperties: {},
      },
      { scheduler_chunk_id: `${taskId}#0` },
    );
    const nowIso = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    ).bind(taskId, owner, JSON.stringify({ title: "Pinned focus", pinned_at: start }), "committed", nowIso, nowIso).run();

    const after = ((await (await slots(app)).json()) as { slots: string[] }).slots;
    expect(after).not.toContain(start);
    expect(fetches).toHaveBeenCalledTimes(2);
  });

  it("the claim re-verifies against the live calendar, never the cache", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(JSON.stringify({ success: true, hostname: "localhost" }), { status: 200 }),
    );
    const { provider, fetches } = countedProvider();
    const app = appWith(provider);
    const start = ((await (await slots(app)).json()) as { slots: string[] }).slots[0]!;
    expect(fetches).toHaveBeenCalledTimes(1);

    // The owner takes that time on their calendar after the page was cached.
    provider.injectExternalEvent({
      id: "late-meeting",
      summary: "Dentist",
      start,
      end: new Date(Date.parse(start) + 30 * 60_000).toISOString(),
    });
    // The public list may still offer it for up to the TTL...
    expect(((await (await slots(app)).json()) as { slots: string[] }).slots).toContain(start);
    expect(fetches).toHaveBeenCalledTimes(1);

    // ...but the claim reads live and refuses it.
    const res = await app.request(
      `/book/${slug}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": `198.51.100.${seq % 250}` },
        body: JSON.stringify({
          start,
          duration_minutes: 30,
          name: "Sam",
          email: "sam@x.com",
          note: null,
          location_kind: "meet",
          location_detail: null,
          turnstile_token: "tok",
        }),
      },
      ON,
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { slots: string[] }).slots).not.toContain(start);
    expect(fetches.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("the cached entry holds no event titles", async () => {
    const { provider } = countedProvider();
    provider.injectExternalEvent({
      id: "secret",
      summary: "Board strategy offsite",
      start: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      end: new Date(Date.now() + 2 * 86_400_000 + 3_600_000).toISOString(),
    });
    const original = caches.default.put.bind(caches.default);
    const stored: string[] = [];
    vi.spyOn(caches.default, "put").mockImplementation(async (key, res) => {
      stored.push(await res.clone().text());
      return original(key, res);
    });
    await slots(appWith(provider));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toContain("secret");
    expect(stored[0]).not.toContain("Board strategy");
  });
});

describe("GET /book/{slug}/slots — rate limits", () => {
  it("over the per-IP limit: 429 rate_limited with Retry-After, and no calendar read", async () => {
    const { provider, fetches } = countedProvider();
    const ip = denyAll();
    const res = await slots(
      appWith(provider),
      { ...ON, PUBLIC_READ_IP_LIMITER: ip, PUBLIC_READ_TARGET_LIMITER: allowAll() },
      "duration=30",
      { "cf-connecting-ip": "203.0.113.9" },
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(await res.json()).toEqual({ error: "rate_limited" });
    expect(ip.keys).toEqual(["ip:203.0.113.9"]);
    expect(fetches).not.toHaveBeenCalled();
  });

  it("over the per-slug aggregate: 429, and no calendar read", async () => {
    const { provider, fetches } = countedProvider();
    const target = denyAll();
    const res = await slots(
      appWith(provider),
      { ...ON, PUBLIC_READ_IP_LIMITER: allowAll(), PUBLIC_READ_TARGET_LIMITER: target },
      "duration=30",
      { "cf-connecting-ip": "203.0.113.10" },
    );
    expect(res.status).toBe(429);
    expect(target.keys).toEqual([`book:${slug}`]);
    expect(fetches).not.toHaveBeenCalled();
  });

  it("the per-slug budget is spent only on a cache miss: a warm page still serves when it is exhausted", async () => {
    const { provider, fetches } = countedProvider();
    const app = appWith(provider);
    expect((await slots(app)).status).toBe(200);
    const target = denyAll();
    const res = await slots(app, { ...ON, PUBLIC_READ_TARGET_LIMITER: target }, "duration=30", { "cf-connecting-ip": "203.0.113.11" });
    expect(res.status).toBe(200);
    expect(target.keys).toEqual([]);
    expect(fetches).toHaveBeenCalledTimes(1);
  });

  it("the pool's per-IP limiter binding is live: 30 a minute, then 429", async () => {
    // Bound by vitest.workspace.ts (mirroring wrangler.toml's [[ratelimits]]);
    // without it the limiter fails open and this would never see a 429.
    expect(TEST_ENV.PUBLIC_READ_IP_LIMITER).toBeDefined();
    expect(TEST_ENV.PUBLIC_READ_TARGET_LIMITER).toBeDefined();
    const { provider, fetches } = countedProvider();
    const app = appWith(provider);
    // A fresh IP and slug, so neither counter carries over from other tests.
    const ip = `192.0.2.${(Date.now() % 200) + seq % 50}`;
    // The binding's window is the wall-clock minute. A run that straddles a
    // boundary resets once, so a 429 still lands within 61 requests, after at
    // least 30 allowed.
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) {
      const status = (await slots(app, ON, "duration=30", { "cf-connecting-ip": ip })).status;
      statuses.push(status);
      if (status === 429) break;
    }
    expect(statuses.at(-1)).toBe(429);
    expect(statuses.filter((s) => s === 200).length).toBeGreaterThanOrEqual(30);
    expect(fetches).toHaveBeenCalledTimes(1);
  });

  it("flag off and an unknown slug are 404 before the limiter or the cache", async () => {
    const { provider, fetches } = countedProvider();
    const app = appWith(provider);
    await slots(app); // warm
    const match = vi.spyOn(caches.default, "match");
    const ip = denyAll();
    const target = denyAll();
    const limited = { PUBLIC_READ_IP_LIMITER: ip, PUBLIC_READ_TARGET_LIMITER: target };
    expect((await slots(app, { ...ON, ...limited, BOOKING_PAGE_ENABLED: "false" })).status).toBe(404);
    expect(
      (await app.request(`/book/nope-${slug}/slots?duration=30`, { headers: { "cf-connecting-ip": "1.1.1.1" } }, { ...ON, ...limited })).status,
    ).toBe(404);
    expect(match).not.toHaveBeenCalled();
    expect(ip.keys).toEqual([]);
    expect(target.keys).toEqual([]);
    expect(fetches).toHaveBeenCalledTimes(1);
  });

  it("a delisted owner's page is 404 before the limiter or the cache, even when warm", async () => {
    const { provider, fetches } = countedProvider();
    const app = appWith(provider);
    await slots(app); // warm
    const match = vi.spyOn(caches.default, "match");
    const ip = denyAll();
    const res = await slots(
      app,
      { ...ON, MEMBERSHIP_ALLOWLIST: "someone-else@org", PUBLIC_READ_IP_LIMITER: ip },
      "duration=30",
      { "cf-connecting-ip": "1.1.1.1" },
    );
    expect(res.status).toBe(404);
    expect(match).not.toHaveBeenCalled();
    expect(ip.keys).toEqual([]);
    expect(fetches).toHaveBeenCalledTimes(1);
  });
});
