import { describe, it, expect } from "vitest";
import { computeAvailabilityWindows } from "../../src/meetings/availability";
import type { Weekday } from "../../src/planning/solver-contract";

const BH = { days: ["mon", "tue", "wed", "thu", "fri"] as Weekday[], start: "09:00", end: "17:00" };

describe("computeAvailabilityWindows", () => {
  const base = {
    tz: "UTC",
    businessHours: BH,
    windowStartMs: Date.parse("2026-05-19T00:00:00Z"), // Tue
    windowEndMs: Date.parse("2026-05-19T23:59:00Z"),
    nowMs: Date.parse("2026-05-18T00:00:00Z"),
    minNoticeMs: 0,
    currentStartMs: Date.parse("2026-05-19T09:00:00Z"),
    currentEndMs: Date.parse("2026-05-19T09:30:00Z"),
    durationMinutes: 30,
  };

  it("free where no attendee is busy, clipped to business hours", () => {
    const r = computeAvailabilityWindows({ ...base, acceptedBusy: [] });
    // The whole 09:00-17:00 business window is available on Tue.
    expect(r.windows[0]!.start).toBe("2026-05-19T09:00:00Z");
    expect(r.windows[r.windows.length - 1]!.end).toBe("2026-05-19T17:00:00Z");
    expect(r.warnings).toEqual([]);
  });

  it("subtracts an accepted attendee's busy interval", () => {
    const r = computeAvailabilityWindows({
      ...base,
      acceptedBusy: [{ start: "2026-05-19T11:00:00Z", end: "2026-05-19T12:00:00Z" }],
    });
    // Expect a gap 11:00-12:00 — no window fully covers it.
    const covers11 = r.windows.some(
      (w) => Date.parse(w.start) <= Date.parse("2026-05-19T11:00:00Z") && Date.parse(w.end) >= Date.parse("2026-05-19T11:30:00Z"),
    );
    expect(covers11).toBe(false);
  });

  it("always includes the current slot even when an attendee is busy then", () => {
    const r = computeAvailabilityWindows({
      ...base,
      acceptedBusy: [{ start: "2026-05-19T09:00:00Z", end: "2026-05-19T09:30:00Z" }], // busy over current slot
    });
    const coversCurrent = r.windows.some(
      (w) =>
        Date.parse(w.start) <= base.currentStartMs && Date.parse(w.end) >= base.currentEndMs,
    );
    expect(coversCurrent).toBe(true); // C1 fallback
  });

  it("excludes the min-notice horizon from movable windows but keeps current slot", () => {
    const r = computeAvailabilityWindows({
      ...base,
      nowMs: Date.parse("2026-05-19T08:00:00Z"),
      minNoticeMs: 4 * 60 * 60 * 1000, // until 12:00
      acceptedBusy: [],
    });
    // No NEW window may start before 12:00 (except the current-slot union at 09:00).
    const earlyNonCurrent = r.windows.find((w) => w.start !== "2026-05-19T09:00:00Z");
    expect(earlyNonCurrent && Date.parse(earlyNonCurrent.start) >= Date.parse("2026-05-19T12:00:00Z")).toBe(true);
  });

  // Regression: an empty mask is read by the solver as UNCONSTRAINED (place
  // anywhere), so the mask must NEVER be empty for a promoted meeting — even an
  // off-grid or non-15-multiple ("speedy" 25/50-min) meeting whose attendees are
  // all busy must keep its current slot. Quarter-rounding the current slot INWARD
  // used to collapse it below the duration and drop it, emptying the mask and
  // letting the meeting relocate onto attendee-busy time (bug 2026-06-27).
  const allDayBusy = [{ start: "2026-05-19T09:00:00Z", end: "2026-05-19T17:00:00Z" }];

  it("keeps a non-empty current-slot mask for a 50-min speedy meeting fully busy", () => {
    const r = computeAvailabilityWindows({
      ...base,
      currentStartMs: Date.parse("2026-05-19T10:00:00Z"),
      currentEndMs: Date.parse("2026-05-19T10:50:00Z"), // 50 min — ends off the 15-grid
      durationMinutes: 50,
      acceptedBusy: allDayBusy,
    });
    expect(r.windows.length).toBeGreaterThan(0);
    // The stay-put window must hold the reserved (rounded-up to 60) chunk at the
    // quarter-aligned current start.
    const cur = r.windows.find((w) => Date.parse(w.start) <= Date.parse("2026-05-19T10:00:00Z"));
    expect(cur && Date.parse(cur.end) - Date.parse(cur.start) >= 60 * 60_000).toBe(true);
  });

  it("keeps a non-empty current-slot mask for an off-grid 30-min meeting fully busy", () => {
    const r = computeAvailabilityWindows({
      ...base,
      currentStartMs: Date.parse("2026-05-19T09:50:00Z"), // starts off the 15-grid
      currentEndMs: Date.parse("2026-05-19T10:20:00Z"),
      durationMinutes: 30,
      acceptedBusy: allDayBusy,
    });
    expect(r.windows.length).toBeGreaterThan(0);
  });
});
