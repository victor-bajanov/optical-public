import { env, applyD1Migrations } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import guestRateLimitSql from "../../migrations/0033_poll_guest_rate_limit.sql?raw";
import joinAttemptsSql from "../../migrations/0034_poll_join_attempts.sql?raw";
import { mountPollRoutes, __setMaybeBookOnAllInForTests } from "../../src/polls/route";
import { __setForTests as __setPollBookingForTests, bookPollSlot } from "../../src/polls/booking";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { MockNotificationProvider } from "../../src/providers/mock-notification-provider";
import { saveBookingPage } from "../../src/db/booking-page";
import { claimSlot, confirmBooking } from "../../src/db/bookings";
import { createPoll, insertInvitee, newInviteeId, aggregateResponses, type Poll } from "../../src/db/polls";
import { signCapabilityWithEnv } from "../../src/auth/capability";
import { hashToken } from "../../src/auth/tokens";
import { hashingKey } from "../../src/auth/crypto-keys";
import { identityAnchorTag } from "../../src/auth/identity-rebind";
import type { RateLimitBinding } from "../../src/public-read/rate-limit";
import type { AppVariables } from "../../src/index-providers";
import type { Env } from "../../src/env";
import type { BusinessHours } from "../../src/planning/solver-contract";

// Public read cache + limiter on the invitee grid reads (finding #5):
// GET /poll/{id}/grid and PUT /poll/{id}/response both recompute the
// organiser's paintable region from their calendar. Every test gets its own
// organiser, since neither the Cache API nor the limiter resets per test.

type App = Hono<{ Bindings: Env; Variables: AppVariables }>;

const ALL_DAY: BusinessHours = {
  days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
  start: "00:00",
  end: "23:45",
} as BusinessHours;

const TEST_ENV = env as unknown as Env;
const ON: Env = { ...TEST_ENV, MEETING_POLL_ENABLED: "true", PUBLIC_READ_CACHE_TTL_SECONDS: "60" };

let seq = 0;
let owner = "";

function appWith(provider: MockCalendarProvider): App {
  const app: App = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("calendarProvider", provider);
    c.set("notificationProvider", new MockNotificationProvider());
    await next();
  });
  mountPollRoutes(app);
  return app;
}

function countedProvider() {
  const provider = new MockCalendarProvider();
  const fetches = vi.spyOn(provider, "fetchEventsInWindow");
  return { provider, fetches };
}

async function seedPollWithInvitee(): Promise<{ poll: Poll; token: string }> {
  const now = new Date();
  const poll = await createPoll(env.DB, {
    subject: owner,
    title: "Weekly sync",
    durationMin: 30,
    rangeStart: now.toISOString().slice(0, 10),
    rangeEnd: new Date(now.getTime() + 14 * 86_400_000).toISOString().slice(0, 10),
    deadlineUtc: new Date(now.getTime() + 30 * 86_400_000).toISOString(),
    location: { kind: "meet" },
    guestTokenHash: null,
    now: now.toISOString(),
  });
  const inviteeId = newInviteeId();
  const token = await signCapabilityWithEnv(
    { purpose: "poll-response", pollId: poll.id, inviteeId, subject: poll.subject, ttlSeconds: 3600 },
    TEST_ENV,
  );
  await insertInvitee(env.DB, {
    id: inviteeId,
    pollId: poll.id,
    email: "invitee@x.com",
    name: "Sam",
    kind: "invited",
    tokenHash: await hashToken(token, hashingKey(TEST_ENV)),
    pseudonym: `curious-${seq}`,
    now: now.toISOString(),
  });
  return { poll, token };
}

function grid(app: App, poll: Poll, token: string, e: Env = ON, headers: Record<string, string> = {}) {
  return app.request(`/poll/${poll.id}/grid?t=${encodeURIComponent(token)}`, { headers }, e);
}

function respond(app: App, poll: Poll, token: string, cells: string[], e: Env = ON, headers: Record<string, string> = {}) {
  return app.request(
    `/poll/${poll.id}/response?t=${encodeURIComponent(token)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ cells: cells.map((cell) => ({ cell, state: "free" })), hideName: false, name: "Sam" }),
    },
    e,
  );
}

function limiter(success: boolean): RateLimitBinding & { keys: string[] } {
  const keys: string[] = [];
  return { keys, limit: async ({ key }) => { keys.push(key); return { success }; } };
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, [
    { name: "0033_poll_guest_rate_limit.sql", queries: [guestRateLimitSql] },
    { name: "0034_poll_join_attempts.sql", queries: [joinAttemptsSql] },
  ]);
});

beforeEach(async () => {
  seq += 1;
  owner = `poll-public-read-${Date.now()}-${seq}@org`;
  await saveBookingPage(env.DB, owner, {
    enabled: true,
    hours: ALL_DAY,
    horizon_days: 90,
    min_notice_minutes: 0,
    buffer_minutes: { before: 0, after: 0 },
  });
  // The all-in auto-book is not what these tests are about.
  __setMaybeBookOnAllInForTests(async () => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  __setMaybeBookOnAllInForTests(null);
  __setPollBookingForTests(null);
});

describe("poll grid reads — calendar cache", () => {
  it("a burst of grid GETs costs one calendar read", async () => {
    const { provider, fetches } = countedProvider();
    const app = appWith(provider);
    const { poll, token } = await seedPollWithInvitee();
    for (let i = 0; i < 5; i++) expect((await grid(app, poll, token)).status).toBe(200);
    expect(fetches).toHaveBeenCalledTimes(1);
  });

  it("a response save validates against the same cached read", async () => {
    const { provider, fetches } = countedProvider();
    const app = appWith(provider);
    const { poll, token } = await seedPollWithInvitee();
    const body = (await (await grid(app, poll, token)).json()) as { paintableCells: string[] };
    const res = await respond(app, poll, token, body.paintableCells.slice(0, 2));
    expect(res.status).toBe(200);
    expect(fetches).toHaveBeenCalledTimes(1);
  });

  it("another poll's booking for the same organiser blocks its cell at once, despite a warm cache", async () => {
    // A poll booking writes the calendar AND a bookings row; the row is read
    // fresh, so no cache invalidation (and no smoke-harness wait) is needed.
    const { provider, fetches } = countedProvider();
    const app = appWith(provider);
    const { poll, token } = await seedPollWithInvitee();
    const before = ((await (await grid(app, poll, token)).json()) as { paintableCells: string[] }).paintableCells;
    const cell = before[0]!;
    const end = new Date(Date.parse(cell) + 30 * 60_000).toISOString();
    const { poll: other } = await seedPollWithInvitee();
    const claim = await claimSlot(env.DB, {
      ownerSubject: owner,
      slug: "",
      startUtc: cell,
      endUtc: end,
      durationMinutes: 30,
      bookerName: "poll",
      bookerEmail: "poll@x.com",
      bookerNote: null,
      locationKind: "meet",
      locationDetail: null,
      ipHash: "",
      guardStartUtc: cell,
      guardEndUtc: end,
      now: new Date(),
      pollId: other.id,
    });
    expect(claim).not.toBeNull();
    await confirmBooking(env.DB, claim!.id, "evt-other-poll", new Date());

    const after = ((await (await grid(app, poll, token)).json()) as { paintableCells: string[] }).paintableCells;
    expect(after).not.toContain(cell);
    expect(fetches).toHaveBeenCalledTimes(1);
  });

  it("the organiser status page reads the calendar live, even with a warm cache", async () => {
    const { provider, fetches } = countedProvider();
    const app = appWith(provider);
    const { poll, token } = await seedPollWithInvitee();
    expect((await grid(app, poll, token)).status).toBe(200);
    expect(fetches).toHaveBeenCalledTimes(1);
    const statusToken = await signCapabilityWithEnv(
      {
        purpose: "poll-status",
        pollId: poll.id,
        subject: owner,
        ttlSeconds: 3600,
        anchor: await identityAnchorTag(TEST_ENV, owner),
      },
      TEST_ENV,
    );
    for (let i = 0; i < 2; i++) {
      const res = await app.request(`/poll/${poll.id}/status?t=${encodeURIComponent(statusToken)}`, {}, ON);
      expect(res.status).toBe(200);
    }
    expect(fetches).toHaveBeenCalledTimes(3);
  });

  it("the poll booking engine reads the calendar live, even with a warm cache", async () => {
    const { provider, fetches } = countedProvider();
    const app = appWith(provider);
    const { poll, token } = await seedPollWithInvitee();
    const body = (await (await grid(app, poll, token)).json()) as { paintableCells: string[] };
    expect(fetches).toHaveBeenCalledTimes(1);
    __setPollBookingForTests({ calendar: provider, notification: new MockNotificationProvider() });
    await bookPollSlot(ON, poll.id, body.paintableCells[0]!);
    expect(fetches.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("poll grid reads — rate limits", () => {
  it("grid over the per-IP limit: 429 with Retry-After, no calendar read", async () => {
    const { provider, fetches } = countedProvider();
    const { poll, token } = await seedPollWithInvitee();
    const ip = limiter(false);
    const res = await grid(appWith(provider), poll, token, { ...ON, PUBLIC_READ_IP_LIMITER: ip }, { "cf-connecting-ip": "203.0.113.20" });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(await res.json()).toEqual({ error: "rate_limited" });
    expect(ip.keys).toEqual(["ip:203.0.113.20"]);
    expect(fetches).not.toHaveBeenCalled();
  });

  it("grid over the per-poll aggregate: 429 keyed on the poll id", async () => {
    const { provider, fetches } = countedProvider();
    const { poll, token } = await seedPollWithInvitee();
    const target = limiter(false);
    const res = await grid(appWith(provider), poll, token, { ...ON, PUBLIC_READ_IP_LIMITER: limiter(true), PUBLIC_READ_TARGET_LIMITER: target });
    expect(res.status).toBe(429);
    expect(target.keys).toEqual([`poll:${poll.id}`]);
    expect(fetches).not.toHaveBeenCalled();
  });

  it("the per-poll budget is spent only on a miss: a warm grid and a save still work when it is exhausted", async () => {
    const { provider, fetches } = countedProvider();
    const app = appWith(provider);
    const { poll, token } = await seedPollWithInvitee();
    const body = (await (await grid(app, poll, token)).json()) as { paintableCells: string[] };
    const target = limiter(false);
    const exhausted = { ...ON, PUBLIC_READ_TARGET_LIMITER: target };
    expect((await grid(app, poll, token, exhausted)).status).toBe(200);
    const cell = body.paintableCells[0]!;
    expect((await respond(app, poll, token, [cell], exhausted)).status).toBe(200);
    expect(target.keys).toEqual([]);
    expect(fetches).toHaveBeenCalledTimes(1);
    const { byInvitee } = await aggregateResponses(env.DB, poll.id);
    expect(byInvitee.flatMap((b) => b.cells.map((c) => c.cellStartUtc))).toEqual([cell]);
  });

  it("a save refused on its miss is a 429 that saves nothing", async () => {
    const { provider, fetches } = countedProvider();
    const app = appWith(provider);
    const { poll, token } = await seedPollWithInvitee();
    const res = await respond(app, poll, token, [], { ...ON, PUBLIC_READ_TARGET_LIMITER: limiter(false) });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    expect(fetches).not.toHaveBeenCalled();
    const { byInvitee } = await aggregateResponses(env.DB, poll.id);
    expect(byInvitee).toEqual([]);
  });

  it("a rate-limited save is a 429 that saves nothing and reads no calendar", async () => {
    const { provider, fetches } = countedProvider();
    const app = appWith(provider);
    const { poll, token } = await seedPollWithInvitee();
    const res = await respond(app, poll, token, [], { ...ON, PUBLIC_READ_TARGET_LIMITER: limiter(false) });
    expect(res.status).toBe(429);
    expect(fetches).not.toHaveBeenCalled();
    const { byInvitee } = await aggregateResponses(env.DB, poll.id);
    expect(byInvitee).toEqual([]);
  });

  it("a bad token, the flag off or a delisted organiser never reach the limiter or the cache", async () => {
    const { provider, fetches } = countedProvider();
    const app = appWith(provider);
    const { poll, token } = await seedPollWithInvitee();
    await grid(app, poll, token); // warm
    const match = vi.spyOn(caches.default, "match");
    const ip = limiter(false);
    const target = limiter(false);
    const limited = { ...ON, PUBLIC_READ_IP_LIMITER: ip, PUBLIC_READ_TARGET_LIMITER: target };
    const h = { "cf-connecting-ip": "1.1.1.1" };
    expect((await grid(app, poll, "bogus", limited, h)).status).toBe(401);
    expect((await grid(app, poll, token, { ...limited, MEETING_POLL_ENABLED: "false" }, h)).status).toBe(404);
    expect((await grid(app, poll, token, { ...limited, MEMBERSHIP_ALLOWLIST: "someone-else@org" }, h)).status).toBe(401);
    expect((await respond(app, poll, "bogus", [], limited, h)).status).toBe(401);
    expect(ip.keys).toEqual([]);
    expect(target.keys).toEqual([]);
    expect(match).not.toHaveBeenCalled();
    expect(fetches).toHaveBeenCalledTimes(1);
  });
});
