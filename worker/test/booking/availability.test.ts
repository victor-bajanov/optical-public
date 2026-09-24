import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { computeAvailability, PageOutOfRangeError } from "../../src/booking/availability";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { SCHEDULER_CHUNK_ID_KEY } from "../../src/providers/types";
import type { CalendarEvent } from "../../src/providers/types";
import { saveBookingPage } from "../../src/db/booking-page";
import type { BusinessHours } from "../../src/planning/solver-contract";

const OWNER = "avail-owner@org";
const HOURS = {
  days: ["mon", "tue", "wed", "thu", "fri"],
  start: "10:00",
  end: "16:00",
} as BusinessHours;

// Mon 2026-08-03, Australia/Sydney (+10): 10:00 local == 2026-08-03T00:00:00Z.
const MON_10 = "2026-08-03T00:00:00Z";
const MON_11 = "2026-08-03T01:00:00Z";
const MON_12 = "2026-08-03T02:00:00Z";
const MON_13 = "2026-08-03T03:00:00Z";
const NOW = new Date("2026-08-01T00:00:00Z");

function chunk(id: string, taskId: string, start = MON_10, end = MON_11): CalendarEvent {
  return {
    id,
    summary: "task chunk",
    start,
    end,
    extendedProperties: { private: { [SCHEDULER_CHUNK_ID_KEY]: `${taskId}#0` } },
  } as CalendarEvent;
}

async function seedTask(id: string, pinned: boolean) {
  const body = JSON.stringify({ title: "t", pinned_at: pinned ? "2026-07-30T00:00:00Z" : null });
  await env.DB.prepare(
    "INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?,?,?,?,?,?)",
  ).bind(id, OWNER, body, "committed", "2026-07-30T00:00:00Z", "2026-07-30T00:00:00Z").run();
}

/** An owned movable meeting with a fresh ok:true verdict, as a resolve would
 *  have left it while OWNED_MEETINGS_ENABLED was on. */
async function seedMovableMeetingTask(id: string, eventId: string) {
  const body = JSON.stringify({
    title: "1:1",
    pinned_at: null,
    source: { kind: "meeting", external_id: eventId },
    movable_verdict: { at: "2026-07-31T23:00:00Z", ok: true, reason: null },
  });
  await env.DB.prepare(
    "INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?,?,?,?,?,?)",
  ).bind(id, OWNER, body, "committed", "2026-07-30T00:00:00Z", "2026-07-30T00:00:00Z").run();
}

function meetingEvent(id: string, start: string, end: string): CalendarEvent {
  return {
    id,
    summary: "1:1",
    start,
    end,
    organizer: { self: true },
    attendees: [{ email: "teammate@org" }],
  } as CalendarEvent;
}

beforeEach(async () => {
  for (const t of ["tasks", "bookings", "config_booking_page"]) {
    await env.DB.prepare(`DELETE FROM ${t} WHERE owner_subject = ?`).bind(OWNER).run();
  }
  await saveBookingPage(env.DB, OWNER, {
    slug: "avail",
    enabled: true,
    hours: HOURS,
    horizon_days: 5,
    buffer_minutes: { before: 0, after: 0 },
  });
});

describe("computeAvailability", () => {
  it("offers time occupied by a MOVABLE task chunk", async () => {
    await seedTask("t-movable", false);
    const provider = new MockCalendarProvider({ events: [chunk("evt-1", "t-movable")] });
    const { slots } = await computeAvailability(env.DB, env, OWNER, provider, 30, NOW);
    expect(slots).toContain("2026-08-03T00:00:00.000Z");
  });

  it("does NOT offer time occupied by a PINNED task chunk", async () => {
    await seedTask("t-pinned", true);
    const provider = new MockCalendarProvider({ events: [chunk("evt-1", "t-pinned")] });
    const { slots } = await computeAvailability(env.DB, env, OWNER, provider, 30, NOW);
    expect(slots).not.toContain("2026-08-03T00:00:00.000Z");
    expect(slots).toContain("2026-08-03T01:00:00.000Z");
  });

  it("does not offer time occupied by an external meeting", async () => {
    const external = { id: "evt-x", summary: "client call", start: MON_10, end: MON_11 } as CalendarEvent;
    const provider = new MockCalendarProvider({ events: [external] });
    const { slots } = await computeAvailability(env.DB, env, OWNER, provider, 30, NOW);
    expect(slots).not.toContain("2026-08-03T00:00:00.000Z");
  });

  it("does not offer a slot already claimed by another booking", async () => {
    await env.DB.prepare(
      `INSERT INTO bookings (id, owner_subject, slug, start_utc, end_utc, duration_minutes,
         booker_name, booker_email, ip_hash, status, created_at, updated_at)
       VALUES ('b1',?,'avail',?,?,60,'Sam','sam@x.com','h','confirmed',?,?)`,
    ).bind(OWNER, MON_10, MON_11, NOW.toISOString(), NOW.toISOString()).run();
    const provider = new MockCalendarProvider({ events: [] });
    const { slots } = await computeAvailability(env.DB, env, OWNER, provider, 30, NOW);
    expect(slots).not.toContain("2026-08-03T00:00:00.000Z");
  });

  it("re-offers a slot whose booking was auto-cancelled (decline flow)", async () => {
    // listBookings is the slot-blocking set claimSlot/availability read from —
    // it must stay ('reserving','confirmed') only. A 'cancelled' row (the
    // outcome of the decline auto-cancel sweep) must not black out its slot,
    // or a booker who declined can never re-book the same time.
    await env.DB.prepare(
      `INSERT INTO bookings (id, owner_subject, slug, start_utc, end_utc, duration_minutes,
         booker_name, booker_email, ip_hash, status, created_at, updated_at)
       VALUES ('b-cancelled',?,'avail',?,?,60,'Sam','sam@x.com','h','cancelled',?,?)`,
    ).bind(OWNER, MON_10, MON_11, NOW.toISOString(), NOW.toISOString()).run();
    const provider = new MockCalendarProvider({ events: [] });
    const { slots } = await computeAvailability(env.DB, env, OWNER, provider, 30, NOW);
    expect(slots).toContain("2026-08-03T00:00:00.000Z");
  });

  it("separates the three busy sources within one window", async () => {
    // 10:00 movable chunk (offered), 11:00 pinned chunk (withheld),
    // 12:00 external meeting (withheld), 13:00 nothing at all (offered).
    await seedTask("t-movable", false);
    await seedTask("t-pinned", true);
    const provider = new MockCalendarProvider({
      events: [
        chunk("evt-mov", "t-movable", MON_10, MON_11),
        chunk("evt-pin", "t-pinned", MON_11, MON_12),
        { id: "evt-ext", summary: "client call", start: MON_12, end: MON_13 } as CalendarEvent,
      ],
    });
    const { slots } = await computeAvailability(env.DB, env, OWNER, provider, 60, NOW);
    expect(slots).toContain("2026-08-03T00:00:00.000Z");
    expect(slots).not.toContain("2026-08-03T01:00:00.000Z");
    expect(slots).not.toContain("2026-08-03T02:00:00.000Z");
    expect(slots).toContain("2026-08-03T03:00:00.000Z");
  });

  it("never publishes 24/7 when no business-hours row exists", async () => {
    // loadBusinessHours returns null with neither an owner row nor the
    // '__default__' one, and businessHoursIntervals reads null as "the entire
    // window" — a deployment missing the seed would offer every hour of the
    // horizon to the public internet.
    await saveBookingPage(env.DB, OWNER, { hours: null });
    const seeded = await env.DB
      .prepare("SELECT body FROM config_business_hours WHERE owner_subject = '__default__'")
      .first<{ body: string }>();
    await env.DB
      .prepare("DELETE FROM config_business_hours WHERE owner_subject IN (?, '__default__')")
      .bind(OWNER).run();
    try {
      const provider = new MockCalendarProvider({ events: [] });
      const { slots } = await computeAvailability(env.DB, env, OWNER, provider, 30, NOW);
      expect(slots).not.toContain("2026-08-02T16:00:00.000Z"); // Mon 02:00 Sydney
      expect(slots).not.toContain("2026-08-01T23:00:00.000Z"); // SUNDAY 09:00 Sydney
      expect(slots).toContain("2026-08-02T23:00:00.000Z"); // Mon 09:00 Sydney
    } finally {
      if (seeded) {
        await env.DB
          .prepare("INSERT INTO config_business_hours (owner_subject, body) VALUES ('__default__', ?)")
          .bind(seeded.body).run();
      }
    }
  });

  it("does not offer an owned meeting's slot when OWNED_MEETINGS_ENABLED is off, even with the per-user flag on and a fresh ok:true verdict", async () => {
    // Bug: availability.ts passed only the per-user flag into
    // resolveBookableOverIds and never consulted the env kill-switch. With
    // OWNED_MEETINGS_ENABLED off, resolves stop re-stamping/clearing verdicts,
    // so a stale-but-still-fresh ok:true verdict must not keep the slot offered.
    await seedMovableMeetingTask("t-meet", "evt-meet");
    await saveBookingPage(env.DB, OWNER, { bookable_over_movable_meetings: true });
    const provider = new MockCalendarProvider({
      events: [meetingEvent("evt-meet", MON_10, MON_11)],
    });
    const offEnv = { ...env, OWNED_MEETINGS_ENABLED: "false" };
    const { slots } = await computeAvailability(env.DB, offEnv, OWNER, provider, 30, NOW);
    expect(slots).not.toContain("2026-08-03T00:00:00.000Z");
  });

  it("offers an owned movable meeting's slot with the flags on and a fresh ok:true verdict", async () => {
    await seedMovableMeetingTask("t-meet", "evt-meet");
    await saveBookingPage(env.DB, OWNER, { bookable_over_movable_meetings: true });
    const provider = new MockCalendarProvider({
      events: [meetingEvent("evt-meet", MON_10, MON_11)],
    });
    const { slots } = await computeAvailability(env.DB, env, OWNER, provider, 30, NOW);
    expect(slots).toContain("2026-08-03T00:00:00.000Z");
  });

  it("still offers the slot when MEETING_MIN_NOTICE_MINUTES is a garbage string (falls back to the 1440 default)", async () => {
    // Bug: availability.ts parsed the var with a bare Number(...), so a
    // misconfigured value made the notice floor NaN and every `start >= floor`
    // comparison answered false — silently withdrawing all bookable-over slots
    // instead of falling back to the default. The meeting sits 48h out, well
    // beyond 1440 + 60min headroom, so the default must offer it.
    await seedMovableMeetingTask("t-meet", "evt-meet");
    await saveBookingPage(env.DB, OWNER, { bookable_over_movable_meetings: true });
    const provider = new MockCalendarProvider({
      events: [meetingEvent("evt-meet", MON_10, MON_11)],
    });
    const garbageEnv = { ...env, MEETING_MIN_NOTICE_MINUTES: "soon" };
    const { slots } = await computeAvailability(env.DB, garbageEnv, OWNER, provider, 30, NOW);
    expect(slots).toContain("2026-08-03T00:00:00.000Z");
  });

  it("returns the loaded config and the owner's timezone", async () => {
    const provider = new MockCalendarProvider({ events: [] });
    const { config, tz } = await computeAvailability(env.DB, env, OWNER, provider, 30, NOW);
    expect(config.slug).toBe("avail");
    expect(config.horizon_days).toBe(5);
    expect(tz).toBe(env.SCHEDULER_TZ);
  });
});

describe("computeAvailability — paging", () => {
  const DAY = 86_400_000;
  const iso = (ms: number) => new Date(ms).toISOString();

  it("page 0 with no reach set is exactly the pre-paging window, read once", async () => {
    const provider = new MockCalendarProvider({ events: [] });
    const fetch = vi.spyOn(provider, "fetchEventsInWindow");
    const r = await computeAvailability(env.DB, env, OWNER, provider, 30, NOW);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]!.slice(0, 2)).toEqual([iso(NOW.getTime()), iso(NOW.getTime() + 5 * DAY)]);
    expect(r.page).toBe(0);
    expect(r.hasMore).toBe(false);
    expect(r.window).toEqual({ startMs: NOW.getTime(), endMs: NOW.getTime() + 5 * DAY, hasMore: false });
  });

  it("a later page reads only its own window — one calendar read, sized to one page", async () => {
    await saveBookingPage(env.DB, OWNER, { max_horizon_days: 12 });
    // Mon 2026-08-10 10:00 Sydney — inside page 1 ([Aug 6, Aug 11) from a
    // Sat Aug 1 `now`) and on a weekday, so it would be offered if free.
    const MON2_10 = "2026-08-10T00:00:00Z";
    const MON2_11 = "2026-08-10T01:00:00Z";
    await env.DB.prepare(
      `INSERT INTO bookings (id, owner_subject, slug, start_utc, end_utc, duration_minutes,
         booker_name, booker_email, ip_hash, status, created_at, updated_at)
       VALUES ('b-p1',?,'avail',?,?,60,'Sam','sam@x.com','h','confirmed',?,?)`,
    ).bind(OWNER, MON2_10, MON2_11, NOW.toISOString(), NOW.toISOString()).run();
    const provider = new MockCalendarProvider({ events: [] });
    const fetch = vi.spyOn(provider, "fetchEventsInWindow");

    const r = await computeAvailability(env.DB, env, OWNER, provider, 30, NOW, 1);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]!.slice(0, 2)).toEqual([iso(NOW.getTime() + 5 * DAY), iso(NOW.getTime() + 10 * DAY)]);
    expect(r.page).toBe(1);
    expect(r.hasMore).toBe(true);
    expect(r.slots.length).toBeGreaterThan(0);
    expect(r.slots.every((s) => Date.parse(s) >= NOW.getTime() + 5 * DAY)).toBe(true);
    expect(r.slots.every((s) => Date.parse(s) < NOW.getTime() + 10 * DAY)).toBe(true);
    // The bookings read is page-windowed too: a booking inside page 1 blocks there.
    expect(r.slots).not.toContain("2026-08-10T00:00:00.000Z");
    expect(r.slots).toContain("2026-08-10T01:00:00.000Z");
  });

  it("the last page is clamped to the reach and reports no more", async () => {
    await saveBookingPage(env.DB, OWNER, { max_horizon_days: 12 });
    const provider = new MockCalendarProvider({ events: [] });
    const fetch = vi.spyOn(provider, "fetchEventsInWindow");
    const r = await computeAvailability(env.DB, env, OWNER, provider, 30, NOW, 2);
    expect(fetch.mock.calls[0]!.slice(0, 2)).toEqual([iso(NOW.getTime() + 10 * DAY), iso(NOW.getTime() + 12 * DAY)]);
    expect(r.hasMore).toBe(false);
  });

  it("refuses a page past the reach before touching the calendar", async () => {
    const provider = new MockCalendarProvider({ events: [] });
    const fetch = vi.spyOn(provider, "fetchEventsInWindow");
    await expect(computeAvailability(env.DB, env, OWNER, provider, 30, NOW, 1)).rejects.toThrow(PageOutOfRangeError);
    await saveBookingPage(env.DB, OWNER, { max_horizon_days: 12 });
    await expect(computeAvailability(env.DB, env, OWNER, provider, 30, NOW, 3)).rejects.toThrow(PageOutOfRangeError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
