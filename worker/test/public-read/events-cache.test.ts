import { env } from "cloudflare:test";
// The per-target limiter is spent only on a miss (finding #5 review): a hit
// costs no provider read, so it costs no shared budget either.
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  cachedEventsReader,
  projectForAvailability,
  publicReadCacheTtlSeconds,
  publicReadCacheKey,
  ownerWriteGeneration,
  DEFAULT_PUBLIC_READ_CACHE_TTL_SECONDS,
  MAX_PUBLIC_READ_CACHE_TTL_SECONDS,
  type EventsReader,
} from "../../src/public-read/events-cache";
import { deriveBusyBlocks } from "../../src/planning/busy-blocks";
import { taskIdOfEvent } from "../../src/calendar-feed/build-busy-ics";
import { isOwnedMovableMeeting } from "../../src/meetings/identify";
import type { CalendarEvent } from "../../src/providers/types";
import { PublicReadRateLimitedError, type RateLimitBinding } from "../../src/public-read/rate-limit";
import type { Env } from "../../src/env";

const ORIGIN = "https://scheduler.test";
const BASE_ENV = { ...(env as unknown as Env), PUBLIC_READ_CACHE_TTL_SECONDS: "60" } as Env;

/** A reader that counts live fetches and records the windows it was asked
 *  for. Every test uses its own owner so no two share a cache entry. */
function countingReader(events: CalendarEvent[] = []) {
  const calls: Array<{ start: string; end: string; opts?: { syncToken?: boolean } }> = [];
  const reader: EventsReader = {
    async fetchEventsInWindow(start, end, opts) {
      calls.push({ start, end, opts });
      return { events: events.map((e) => ({ ...e })), nextSyncToken: "" };
    },
  };
  return { reader, calls };
}

let ownerSeq = 0;
function freshOwner(): string {
  ownerSeq += 1;
  return `cache-owner-${Date.now()}-${ownerSeq}@org`;
}

function readerFor(live: EventsReader, owner: string, now: Date, over: Partial<{ env: Env; provider: string }> = {}) {
  return cachedEventsReader(live, {
    env: over.env ?? BASE_ENV,
    owner,
    provider: over.provider ?? "google",
    origin: ORIGIN,
    now,
    // Per-owner, so the pool's real per-target limiter never shares a key
    // across tests.
    limitTarget: `book:${owner}`,
  });
}

/** A per-target limiter that answers `success` and records its keys. */
function limiter(success: boolean): RateLimitBinding & { keys: string[] } {
  const keys: string[] = [];
  return { keys, limit: async ({ key }) => { keys.push(key); return { success }; } };
}

const NOW = new Date("2031-03-04T09:17:23.456Z");
const START = NOW.toISOString();
const END = new Date(NOW.getTime() + 7 * 86_400_000).toISOString();

const MEETING: CalendarEvent = {
  id: "evt-meeting",
  summary: "Board strategy — confidential",
  start: "2031-03-05T01:00:00.000Z",
  end: "2031-03-05T02:00:00.000Z",
  organizer: { email: "owner@org", self: true },
  attendees: [
    { email: "owner@org", self: true, responseStatus: "accepted" },
    { email: "ceo@other.org", responseStatus: "accepted" },
    { email: "room-1@resource.org", resource: true },
  ],
  extendedProperties: { private: { some_other_key: "x" }, shared: { s: "y" } },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("publicReadCacheTtlSeconds", () => {
  it.each([
    [undefined, DEFAULT_PUBLIC_READ_CACHE_TTL_SECONDS],
    ["", DEFAULT_PUBLIC_READ_CACHE_TTL_SECONDS],
    ["abc", DEFAULT_PUBLIC_READ_CACHE_TTL_SECONDS],
    ["-5", DEFAULT_PUBLIC_READ_CACHE_TTL_SECONDS],
    ["0", 0],
    ["30", 30],
    ["9999", MAX_PUBLIC_READ_CACHE_TTL_SECONDS],
  ])("%s -> %i", (raw, want) => {
    expect(publicReadCacheTtlSeconds({ PUBLIC_READ_CACHE_TTL_SECONDS: raw } as Env)).toBe(want);
  });

  it("defaults to 60 s and caps at 300 s", () => {
    expect(DEFAULT_PUBLIC_READ_CACHE_TTL_SECONDS).toBe(60);
    expect(MAX_PUBLIC_READ_CACHE_TTL_SECONDS).toBe(300);
  });
});

describe("cachedEventsReader", () => {
  it("a sequential burst for one window costs one live read", async () => {
    const owner = freshOwner();
    const { reader, calls } = countingReader([MEETING]);
    for (let i = 0; i < 5; i++) {
      const got = await readerFor(reader, owner, new Date(NOW.getTime() + i * 1000)).fetchEventsInWindow(START, END);
      expect(got.events.map((e) => e.id)).toEqual(["evt-meeting"]);
    }
    expect(calls).toHaveLength(1);
  });

  it("reads the quantised (hour-widened) window live, with syncToken off", async () => {
    const owner = freshOwner();
    const { reader, calls } = countingReader();
    await readerFor(reader, owner, NOW).fetchEventsInWindow(START, END);
    expect(calls[0]).toEqual({
      start: "2031-03-04T09:00:00.000Z",
      end: "2031-03-11T10:00:00.000Z",
      opts: { syncToken: false },
    });
  });

  it("windows in the same hour quantum share an entry; another page does not", async () => {
    const owner = freshOwner();
    const { reader, calls } = countingReader();
    const r = readerFor(reader, owner, NOW);
    await r.fetchEventsInWindow(START, END);
    // Same quanta: a few minutes later, still inside 09:00-10:00 / 10:00-11:00.
    await r.fetchEventsInWindow(
      new Date(NOW.getTime() + 5 * 60_000).toISOString(),
      new Date(Date.parse(END) + 5 * 60_000).toISOString(),
    );
    expect(calls).toHaveLength(1);
    // Page 1: a distinct window.
    await r.fetchEventsInWindow(END, new Date(Date.parse(END) + 7 * 86_400_000).toISOString());
    expect(calls).toHaveLength(2);
  });

  it("re-reads once the entry is older than the TTL, not before", async () => {
    const owner = freshOwner();
    const { reader, calls } = countingReader();
    await readerFor(reader, owner, NOW).fetchEventsInWindow(START, END);
    await readerFor(reader, owner, new Date(NOW.getTime() + 59_000)).fetchEventsInWindow(START, END);
    expect(calls).toHaveLength(1);
    await readerFor(reader, owner, new Date(NOW.getTime() + 60_001)).fetchEventsInWindow(START, END);
    expect(calls).toHaveLength(2);
  });

  it("keys on owner, provider and deployment", async () => {
    const owner = freshOwner();
    const { reader, calls } = countingReader();
    await readerFor(reader, owner, NOW).fetchEventsInWindow(START, END);
    await readerFor(reader, freshOwner(), NOW).fetchEventsInWindow(START, END);
    expect(calls).toHaveLength(2);
    await readerFor(reader, owner, NOW, { provider: "microsoft" }).fetchEventsInWindow(START, END);
    expect(calls).toHaveLength(3);
    const otherDeployment = { ...BASE_ENV, OAUTH_ISSUER: "https://scheduler-other.test" } as Env;
    await readerFor(reader, owner, NOW, { env: otherDeployment }).fetchEventsInWindow(START, END);
    expect(calls).toHaveLength(4);
    // And the original is still warm.
    await readerFor(reader, owner, NOW).fetchEventsInWindow(START, END);
    expect(calls).toHaveLength(4);
  });

  it("the key carries no owner, window or deployment in clear", async () => {
    const owner = freshOwner();
    const key = await publicReadCacheKey(BASE_ENV, ORIGIN, "google", owner, await ownerWriteGeneration(env.DB, owner), START, END);
    expect(key.startsWith(`${ORIGIN}/`)).toBe(true);
    expect(key).not.toContain(owner);
    expect(key).not.toContain("2031");
  });

  it("TTL 0 disables the cache: every read is live and nothing is stored", async () => {
    const owner = freshOwner();
    const off = { ...BASE_ENV, PUBLIC_READ_CACHE_TTL_SECONDS: "0" } as Env;
    const put = vi.spyOn(caches.default, "put");
    const { reader, calls } = countingReader();
    await readerFor(reader, owner, NOW, { env: off }).fetchEventsInWindow(START, END);
    await readerFor(reader, owner, NOW, { env: off }).fetchEventsInWindow(START, END);
    expect(calls).toHaveLength(2);
    expect(put).not.toHaveBeenCalled();
  });

  it("stores only the projected fields — no titles, attendee addresses or organiser address", async () => {
    const owner = freshOwner();
    const { reader } = countingReader([MEETING]);
    const got = await readerFor(reader, owner, NOW).fetchEventsInWindow(START, END);
    const stored = await caches.default.match(await publicReadCacheKey(BASE_ENV, ORIGIN, "google", owner, await ownerWriteGeneration(env.DB, owner), START, END));
    expect(stored).toBeDefined();
    const raw = await stored!.text();
    for (const secret of ["Board strategy", "ceo@other.org", "owner@org", "room-1@resource.org", "some_other_key"]) {
      expect(raw).not.toContain(secret);
      expect(JSON.stringify(got.events)).not.toContain(secret);
    }
  });

  it("serves the same projection on a miss and on a hit", async () => {
    const owner = freshOwner();
    const { reader } = countingReader([MEETING]);
    const miss = await readerFor(reader, owner, NOW).fetchEventsInWindow(START, END);
    const hit = await readerFor(reader, owner, NOW).fetchEventsInWindow(START, END);
    expect(hit.events).toEqual(miss.events);
  });

  it("degrades to a live read when the cache itself fails", async () => {
    const owner = freshOwner();
    vi.spyOn(caches.default, "match").mockRejectedValue(new Error("cache down"));
    vi.spyOn(caches.default, "put").mockRejectedValue(new Error("cache down"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { reader, calls } = countingReader([MEETING]);
    const got = await readerFor(reader, owner, NOW).fetchEventsInWindow(START, END);
    expect(got.events.map((e) => e.id)).toEqual(["evt-meeting"]);
    expect(calls).toHaveLength(1);
  });

  it("a live read failure propagates (the route turns it into its 502) and is not cached", async () => {
    const owner = freshOwner();
    let fail = true;
    const calls: number[] = [];
    const reader: EventsReader = {
      async fetchEventsInWindow() {
        calls.push(1);
        if (fail) throw new Error("provider 500");
        return { events: [], nextSyncToken: "" };
      },
    };
    await expect(readerFor(reader, owner, NOW).fetchEventsInWindow(START, END)).rejects.toThrow("provider 500");
    fail = false;
    await readerFor(reader, owner, NOW).fetchEventsInWindow(START, END);
    expect(calls).toHaveLength(2);
  });

  it("a cache hit never consults the per-target limiter", async () => {
    const owner = freshOwner();
    const { reader, calls } = countingReader();
    const allow = limiter(true);
    await readerFor(reader, owner, NOW, { env: { ...BASE_ENV, PUBLIC_READ_TARGET_LIMITER: allow } as Env })
      .fetchEventsInWindow(START, END);
    expect(allow.keys).toEqual([`book:${owner}`]);
    const deny = limiter(false);
    const got = await readerFor(reader, owner, NOW, { env: { ...BASE_ENV, PUBLIC_READ_TARGET_LIMITER: deny } as Env })
      .fetchEventsInWindow(START, END);
    expect(got.events).toEqual([]);
    expect(deny.keys).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("a refused miss throws PublicReadRateLimitedError and reads nothing", async () => {
    const owner = freshOwner();
    const { reader, calls } = countingReader();
    const deny = limiter(false);
    await expect(
      readerFor(reader, owner, NOW, { env: { ...BASE_ENV, PUBLIC_READ_TARGET_LIMITER: deny } as Env })
        .fetchEventsInWindow(START, END),
    ).rejects.toBeInstanceOf(PublicReadRateLimitedError);
    expect(deny.keys).toEqual([`book:${owner}`]);
    expect(calls).toHaveLength(0);
  });

  it("with TTL 0 every read is a miss, so every read consults the limiter", async () => {
    const owner = freshOwner();
    const { reader, calls } = countingReader();
    const allow = limiter(true);
    const off = { ...BASE_ENV, PUBLIC_READ_CACHE_TTL_SECONDS: "0", PUBLIC_READ_TARGET_LIMITER: allow } as Env;
    await readerFor(reader, owner, NOW, { env: off }).fetchEventsInWindow(START, END);
    await readerFor(reader, owner, NOW, { env: off }).fetchEventsInWindow(START, END);
    expect(allow.keys).toHaveLength(2);
    expect(calls).toHaveLength(2);
    const deny = { ...off, PUBLIC_READ_TARGET_LIMITER: limiter(false) } as Env;
    await expect(readerFor(reader, owner, NOW, { env: deny }).fetchEventsInWindow(START, END))
      .rejects.toBeInstanceOf(PublicReadRateLimitedError);
    expect(calls).toHaveLength(2);
  });

  it("a cache failure still spends the target budget before the live read", async () => {
    const owner = freshOwner();
    vi.spyOn(caches.default, "match").mockRejectedValue(new Error("cache down"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { reader, calls } = countingReader();
    const deny = limiter(false);
    await expect(
      readerFor(reader, owner, NOW, { env: { ...BASE_ENV, PUBLIC_READ_TARGET_LIMITER: deny } as Env })
        .fetchEventsInWindow(START, END),
    ).rejects.toBeInstanceOf(PublicReadRateLimitedError);
    expect(calls).toHaveLength(0);
  });

  it("DEBUG_LOG logs each lookup's hit flag; off, nothing", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { reader } = countingReader();
    const owner = freshOwner();
    const dbg = { ...BASE_ENV, DEBUG_LOG: "true" } as Env;
    await readerFor(reader, owner, NOW, { env: dbg }).fetchEventsInWindow(START, END);
    await readerFor(reader, owner, NOW, { env: dbg }).fetchEventsInWindow(START, END);
    const lines = info.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("dbg_public_read_cache"));
    expect(lines).toEqual(['dbg_public_read_cache {"hit":false}', 'dbg_public_read_cache {"hit":true}']);
    info.mockClear();
    const quiet = { ...BASE_ENV, DEBUG_LOG: "false" } as Env;
    await readerFor(reader, freshOwner(), NOW, { env: quiet }).fetchEventsInWindow(START, END);
    expect(info.mock.calls.filter((c) => String(c[0]).startsWith("dbg_public_read_cache"))).toEqual([]);
  });

  describe("own-write generation (tasks rows this deployment writes after its calendar writes)", () => {
    async function upsertTask(owner: string, id: string, updatedAt: string) {
      await env.DB.prepare(
        `INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
      ).bind(id, owner, JSON.stringify({ title: "t" }), "committed", "2031-01-01T00:00:00Z", updatedAt).run();
    }

    it("a commit (tasks.updated_at bumped) invalidates the owner's entry at once", async () => {
      const owner = freshOwner();
      await upsertTask(owner, `${owner}-t1`, "2031-03-01T00:00:00Z");
      const { reader, calls } = countingReader();
      await readerFor(reader, owner, NOW).fetchEventsInWindow(START, END);
      await readerFor(reader, owner, NOW).fetchEventsInWindow(START, END);
      expect(calls).toHaveLength(1);
      await upsertTask(owner, `${owner}-t1`, "2031-03-04T09:17:00Z");
      await readerFor(reader, owner, NOW).fetchEventsInWindow(START, END);
      expect(calls).toHaveLength(2);
      await readerFor(reader, owner, NOW).fetchEventsInWindow(START, END);
      expect(calls).toHaveLength(2);
    });

    it("adding or deleting a task row invalidates too", async () => {
      const owner = freshOwner();
      await upsertTask(owner, `${owner}-t1`, "2031-03-02T00:00:00Z");
      const { reader, calls } = countingReader();
      await readerFor(reader, owner, NOW).fetchEventsInWindow(START, END);
      await upsertTask(owner, `${owner}-t0`, "2031-03-01T00:00:00Z");
      await readerFor(reader, owner, NOW).fetchEventsInWindow(START, END);
      expect(calls).toHaveLength(2);
      // Deleting the newest row: the count drops and the newest stamp moves
      // back. (Returning to an earlier generation exactly can reuse that
      // generation's entry, which is still within its own TTL — no staler than
      // the cache already allows.)
      await env.DB.prepare("DELETE FROM tasks WHERE id = ?").bind(`${owner}-t1`).run();
      await readerFor(reader, owner, NOW).fetchEventsInWindow(START, END);
      expect(calls).toHaveLength(3);
    });

    it("another owner's writes leave this owner's entry warm", async () => {
      const owner = freshOwner();
      const { reader, calls } = countingReader();
      await readerFor(reader, owner, NOW).fetchEventsInWindow(START, END);
      await upsertTask(freshOwner(), "someone-elses-task", "2031-03-04T09:00:00Z");
      await readerFor(reader, owner, NOW).fetchEventsInWindow(START, END);
      expect(calls).toHaveLength(1);
    });
  });
});

describe("projectForAvailability", () => {
  const TZ = "Australia/Sydney";
  const events: CalendarEvent[] = [
    MEETING,
    {
      id: "chunk-pinned",
      summary: "Write report",
      start: "2031-03-05T03:00:00.000Z",
      end: "2031-03-05T04:00:00.000Z",
      extendedProperties: { private: { scheduler_chunk_id: "task-1#0" } },
    },
    {
      id: "all-day",
      summary: "Holiday",
      start: "2031-03-06T00:00:00.000Z",
      end: "2031-03-07T00:00:00.000Z",
      isAllDay: true,
      extendedProperties: {},
    },
    {
      id: "ooo",
      summary: "Away",
      start: "2031-03-07T02:00:00.000Z",
      end: "2031-03-07T05:00:00.000Z",
      eventType: "outOfOffice",
      extendedProperties: {},
    },
    {
      id: "tentative",
      summary: "Maybe",
      start: "2031-03-05T05:00:00.000Z",
      end: "2031-03-05T05:30:00.000Z",
      status: "tentative",
      extendedProperties: {},
    },
    {
      id: "cancelled",
      summary: "Gone",
      start: "2031-03-05T06:00:00.000Z",
      end: "2031-03-05T06:30:00.000Z",
      status: "cancelled",
      extendedProperties: {},
    },
    {
      id: "poll-booked",
      summary: "Poll meeting",
      start: "2031-03-05T07:00:00.000Z",
      end: "2031-03-05T07:30:00.000Z",
      organizer: { self: true },
      attendees: [{ email: "x@y.org" }],
      extendedProperties: { private: { optical_poll_id: "poll-1" } },
    },
    {
      id: "not-mine",
      summary: "Their meeting",
      start: "2031-03-05T08:00:00.000Z",
      end: "2031-03-05T08:30:00.000Z",
      organizer: { email: "boss@org", self: false },
      attendees: [{ email: "me@org", self: true }],
      extendedProperties: {},
    },
  ];
  const projected = events.map(projectForAvailability);

  it("keeps every decision the availability path makes", () => {
    for (const tentativeIsBusy of [true, false]) {
      for (const exclude of [new Set<string>(), new Set(["evt-meeting"])]) {
        const opts = { tz: TZ, tentativeIsBusy, excludeEventIds: exclude };
        const strip = (bs: ReturnType<typeof deriveBusyBlocks>) => bs.map(({ title: _t, ...rest }) => rest);
        expect(strip(deriveBusyBlocks(projected, opts))).toEqual(strip(deriveBusyBlocks(events, opts)));
      }
    }
    expect(projected.map(taskIdOfEvent)).toEqual(events.map(taskIdOfEvent));
    expect(projected.map(isOwnedMovableMeeting)).toEqual(events.map(isOwnedMovableMeeting));
    expect(projected.map((e) => [e.id, e.start, e.end, e.status])).toEqual(
      events.map((e) => [e.id, e.start, e.end, e.status]),
    );
  });

  it("drops titles and every address", () => {
    const text = JSON.stringify(projected);
    for (const secret of ["Board strategy", "Write report", "Holiday", "@"]) {
      expect(text).not.toContain(secret);
    }
  });
});
