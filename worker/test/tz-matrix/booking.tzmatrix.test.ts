// tz-matrix mirror of test/booking/slots.test.ts (computeBookableSlots) and
// test/booking/availability.test.ts (computeAvailability). The original
// fixtures are "Mon 2026-08-03 10:00 Sydney"; here every instant is the same
// LOCAL wall clock in the zone under test, derived by the oracle.
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { computeBookableSlots } from "../../src/booking/slots";
import { computeAvailability } from "../../src/booking/availability";
import { saveBookingPage } from "../../src/db/booking-page";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import type { CalendarEvent } from "../../src/providers/types";
import type { BusinessHours } from "../../src/planning/solver-contract";
import { MATRIX_ZONES, MIDNIGHT_GAP_ZONES, addDays, dayStart, local, midnightGapDate, wall, wallIso } from "./zones";

const ALL_ZONES = [...new Set([...MATRIX_ZONES, ...MIDNIGHT_GAP_ZONES])];
const HOURS = { days: ["mon", "tue", "wed", "thu", "fri"], start: "10:00", end: "16:00" } as BusinessHours;
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

describe.each(ALL_ZONES)("computeBookableSlots in %s", (tz) => {
  // Sat 2026-08-01 00:00 local; Mon 2026-08-03 10:00 local.
  const NOW = dayStart("2026-08-01", tz);
  const MON_10 = wall("2026-08-03", "10:00", tz);
  const at = (t: string, d = "2026-08-03") => wall(d, t, tz);
  function params(over: Record<string, unknown> = {}) {
    return {
      tz,
      hours: HOURS,
      nowMs: NOW,
      minNoticeMinutes: 0,
      windowStartMs: NOW,
      windowEndMs: NOW + 3 * DAY,
      durationMinutes: 30,
      slotStepMinutes: 30,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      busy: [] as Array<{ startUtc: string; endUtc: string }>,
      ...over,
    } as Parameters<typeof computeBookableSlots>[0];
  }

  it("offers slots only inside business hours, on the grid", () => {
    const slots = computeBookableSlots(params());
    expect(slots[0]).toBe(iso(MON_10));
    expect(slots).toContain(iso(at("15:30")));
    expect(slots).not.toContain(iso(at("16:00")));
    expect(slots.every((s) => !["2026-08-01", "2026-08-02"].includes(local(Date.parse(s), tz).date))).toBe(true);
  });

  it("every offered start sits on the LOCAL half-hour grid (:00 / :30 local)", () => {
    const slots = computeBookableSlots(params());
    const offGrid = slots.filter((s) => !/:(00|30)$/.test(local(Date.parse(s), tz).time));
    expect(offGrid).toEqual([]);
  });

  it("subtracts busy time", () => {
    const slots = computeBookableSlots(params({ busy: [{ startUtc: iso(at("10:00")), endUtc: iso(at("11:00")) }] }));
    expect(slots).not.toContain(iso(at("10:00")));
    expect(slots).not.toContain(iso(at("10:30")));
    expect(slots).toContain(iso(at("11:00")));
  });

  it("applies asymmetric buffers around busy time", () => {
    const slots = computeBookableSlots(
      params({ bufferAfterMinutes: 30, busy: [{ startUtc: iso(at("10:00")), endUtc: iso(at("11:00")) }] }),
    );
    expect(slots).not.toContain(iso(at("11:00")));
    expect(slots).toContain(iso(at("11:30")));
  });

  it("respects the minimum-notice floor", () => {
    const slots = computeBookableSlots(params({ nowMs: MON_10, minNoticeMinutes: 120 }));
    expect(slots[0]).toBe(iso(at("12:00")));
  });

  it("respects the window ceiling (Sat + 1 day is still the weekend)", () => {
    expect(computeBookableSlots(params({ windowEndMs: NOW + 1 * DAY }))).toHaveLength(0);
  });

  it("uses a 15-minute grid when asked", () => {
    const slots = computeBookableSlots(params({ durationMinutes: 15, slotStepMinutes: 15 }));
    expect(slots).toContain(iso(at("10:15")));
    expect(slots[0]).toBe(iso(MON_10));
  });

  it("only offers a start whose whole duration fits one free interval", () => {
    const slots = computeBookableSlots(
      params({ durationMinutes: 60, busy: [{ startUtc: iso(at("10:30")), endUtc: iso(at("11:00")) }] }),
    );
    expect(slots).not.toContain(iso(at("10:00")));
    expect(slots).toContain(iso(at("11:00")));
  });
});

describe.each([...MIDNIGHT_GAP_ZONES])("computeBookableSlots across the midnight-gap date in %s", (tz) => {
  const gapDate = midnightGapDate(tz, 2026)!;
  const every = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

  it("09:00-17:00 every day over a window containing the gap date does not throw and offers the gap day", () => {
    const ws = dayStart(addDays(gapDate, -2), tz);
    const run = () =>
      computeBookableSlots({
        tz, hours: { days: every, start: "09:00", end: "17:00" } as BusinessHours, nowMs: ws,
        minNoticeMinutes: 0, windowStartMs: ws, windowEndMs: ws + 5 * DAY, durationMinutes: 30,
        slotStepMinutes: 30, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, busy: [],
      });
    expect(run).not.toThrow();
    expect(run()).toContain(wallIso(gapDate, "09:00", tz));
  });

  it("booking hours starting 00:00 over a window containing the gap date do not throw", () => {
    const ws = dayStart(addDays(gapDate, -2), tz);
    const run = () =>
      computeBookableSlots({
        tz, hours: { days: every, start: "00:00", end: "08:00" } as BusinessHours, nowMs: ws,
        minNoticeMinutes: 0, windowStartMs: ws, windowEndMs: ws + 5 * DAY, durationMinutes: 30,
        slotStepMinutes: 30, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, busy: [],
      });
    expect(run).not.toThrow();
  });
});

const OWNER = "tzm-avail-owner@org";

describe.each(ALL_ZONES)("computeAvailability in %s", (tz) => {
  const tzEnv = { ...env, SCHEDULER_TZ: tz } as typeof env;
  const NOW = new Date(dayStart("2026-08-01", tz)); // Sat 00:00 local

  beforeEach(async () => {
    for (const t of ["tasks", "bookings", "config_booking_page"]) {
      await env.DB.prepare(`DELETE FROM ${t} WHERE owner_subject = ?`).bind(OWNER).run();
    }
    await saveBookingPage(env.DB, OWNER, {
      slug: "tzm-avail",
      enabled: true,
      hours: HOURS,
      horizon_days: 5,
      buffer_minutes: { before: 0, after: 0 },
    });
  });

  it("reports the owner's tz and offers Mon 10:00 local when free", async () => {
    const r = await computeAvailability(env.DB, tzEnv, OWNER, new MockCalendarProvider({ events: [] }), 30, NOW);
    expect(r.tz).toBe(tz);
    expect(r.slots[0]).toBe(wallIso("2026-08-03", "10:00", tz));
  });

  it("an external timed meeting Mon 10:00-11:00 local withholds those slots", async () => {
    const ext = {
      id: "evt-x", summary: "client call",
      start: wallIso("2026-08-03", "10:00", tz), end: wallIso("2026-08-03", "11:00", tz),
    } as CalendarEvent;
    const { slots } = await computeAvailability(env.DB, tzEnv, OWNER, new MockCalendarProvider({ events: [ext] }), 30, NOW);
    expect(slots).not.toContain(wallIso("2026-08-03", "10:00", tz));
    expect(slots).toContain(wallIso("2026-08-03", "11:00", tz));
  });

  it("an all-day 'Vacation' on Tue 2026-08-04 withholds all of Tuesday and none of Monday or Wednesday", async () => {
    const vac = {
      id: "evt-vac", summary: "Vacation", isAllDay: true,
      start: "2026-08-04T00:00:00.000Z", end: "2026-08-05T00:00:00.000Z", extendedProperties: {},
    } as CalendarEvent;
    const { slots } = await computeAvailability(env.DB, tzEnv, OWNER, new MockCalendarProvider({ events: [vac] }), 30, NOW);
    const days = new Set(slots.map((s) => local(Date.parse(s), tz).date));
    expect(days.has("2026-08-04")).toBe(false);
    expect(days.has("2026-08-03")).toBe(true);
    expect(days.has("2026-08-05")).toBe(true);
  });

  it("never publishes 24/7 when no business-hours row exists (falls back to Mon-Fri 09-17 local)", async () => {
    await saveBookingPage(env.DB, OWNER, { hours: null });
    const seeded = await env.DB
      .prepare("SELECT body FROM config_business_hours WHERE owner_subject = '__default__'")
      .first<{ body: string }>();
    await env.DB.prepare("DELETE FROM config_business_hours WHERE owner_subject IN (?, '__default__')").bind(OWNER).run();
    try {
      const { slots } = await computeAvailability(env.DB, tzEnv, OWNER, new MockCalendarProvider({ events: [] }), 30, NOW);
      expect(slots).not.toContain(wallIso("2026-08-03", "02:00", tz));
      expect(slots).not.toContain(wallIso("2026-08-02", "09:00", tz));
      expect(slots).toContain(wallIso("2026-08-03", "09:00", tz));
    } finally {
      if (seeded) {
        await env.DB.prepare("INSERT INTO config_business_hours (owner_subject, body) VALUES ('__default__', ?)").bind(seeded.body).run();
      }
    }
  });
});
