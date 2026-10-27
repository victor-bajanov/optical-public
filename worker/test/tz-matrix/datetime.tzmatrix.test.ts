// tz-matrix mirror of test/planning/datetime.test.ts,
// test/planning/busy-blocks.test.ts and
// test/planning/business-hours-intervals.test.ts. Expectations are derived per
// zone from the brute-force oracle in ./zones.ts.
import { describe, it, expect } from "vitest";
import {
  toLocalNaive,
  fromLocalNaive,
  localWeekWindow,
  upcomingLocalWeekWindow,
} from "../../src/planning/datetime";
import { deriveBusyBlocks } from "../../src/planning/busy-blocks";
import { businessHoursIntervals } from "../../src/planning/business-hours-intervals";
import type { BusinessHours, LocalNaive } from "../../src/planning/solver-contract";
import type { CalendarEvent } from "../../src/providers/types";
import {
  MATRIX_ZONES,
  MIDNIGHT_GAP_ZONES,
  addDays,
  dayStart,
  dayStartIso,
  local,
  midnightGapDate,
  transitions,
  wall,
  wallInstants,
  wallIso,
  weekContaining,
} from "./zones";

const ALL_ZONES = [...new Set([...MATRIX_ZONES, ...MIDNIGHT_GAP_ZONES])];
const YEAR = 2026;

describe("oracle self-check", () => {
  it.each([...MIDNIGHT_GAP_ZONES])("%s has a spring-forward at local midnight in 2026", (tz) => {
    expect(midnightGapDate(tz, YEAR)).not.toBeNull();
  });
  it("Sydney week oracle matches the hard-coded original test", () => {
    expect(weekContaining(Date.parse("2026-06-16T03:00:00.000Z"), "Australia/Sydney")).toEqual({
      start: "2026-06-14T14:00:00.000Z",
      end: "2026-06-21T14:00:00.000Z",
    });
  });
});

describe.each(ALL_ZONES)("datetime in %s", (tz) => {
  it("toLocalNaive / fromLocalNaive round-trip at 10:00 local, winter and summer", () => {
    for (const date of ["2026-01-15", "2026-06-21"]) {
      const iso = wallIso(date, "10:00", tz);
      expect(toLocalNaive(iso, tz)).toBe(`${date}T10:00:00`);
      expect(fromLocalNaive(`${date}T10:00:00` as LocalNaive, tz)).toBe(iso);
    }
  });

  it("fromLocalNaive throws inside every 2026 spring-forward gap and picks the earlier instant in every overlap", () => {
    for (const tr of transitions(tz, YEAR)) {
      if (tr.after > tr.before) {
        // Gap: the wall clock of the instant just before + 15 min does not exist.
        const gapLocal = local(tr.atMs - 15 * 60_000, tz);
        const pretend = Date.parse(gapLocal.naive + "Z") + 15 * 60_000;
        const missing = new Date(pretend).toISOString().slice(0, 19);
        expect(wallInstants(missing.slice(0, 10), missing.slice(11, 16), tz)).toEqual([]);
        expect(() => fromLocalNaive(missing as LocalNaive, tz)).toThrow(/DST gap|does not exist/);
      } else {
        const repeated = tr.localAfter;
        const c = wallInstants(repeated.slice(0, 10), repeated.slice(11, 16), tz);
        expect(c.length).toBe(2);
        expect(fromLocalNaive(repeated as LocalNaive, tz)).toBe(new Date(c[0]!).toISOString());
      }
    }
  });

  it("localWeekWindow: Monday morning, mid-week and late Sunday all map to the local week", () => {
    for (const date of ["2026-01-12", "2026-06-15", "2026-10-05"]) {
      const want = weekContaining(wall(date, "11:30", tz), tz);
      expect(localWeekWindow(wallIso(date, "11:30", tz), tz)).toEqual(want);
      expect(localWeekWindow(wallIso(addDays(date, 1), "13:00", tz), tz)).toEqual(want);
      expect(localWeekWindow(wallIso(addDays(date, 6), "22:59", tz), tz)).toEqual(want);
      // Start is the first instant of a local Monday; end is exclusive next Monday.
      expect(local(Date.parse(want.start), tz).date).toBe(date);
    }
  });

  it("upcomingLocalWeekWindow at the Sun 15:00Z cron fire picks the nearest local Monday", () => {
    for (const fire of ["2026-05-17T15:00:00.000Z", "2026-01-11T15:00:00.000Z", "2026-10-04T15:00:00.000Z"]) {
      const fireMs = Date.parse(fire);
      const l = local(fireMs, tz);
      // Sunday local -> tomorrow; Monday local -> today.
      const mon = l.weekday === 1 ? l.date : addDays(l.date, 1);
      expect(upcomingLocalWeekWindow(fire, tz)).toEqual({
        start: dayStartIso(mon, tz),
        end: dayStartIso(addDays(mon, 7), tz),
      });
    }
  });
});

describe.each([...MIDNIGHT_GAP_ZONES])("midnight DST gap in %s", (tz) => {
  const gapDate = midnightGapDate(tz, YEAR)!;

  it("localWeekWindow for an instant on the gap date does not throw and spans the local week", () => {
    const at = wall(gapDate, "12:00", tz);
    expect(() => localWeekWindow(new Date(at).toISOString(), tz)).not.toThrow();
    expect(localWeekWindow(new Date(at).toISOString(), tz)).toEqual(weekContaining(at, tz));
  });

  it("localWeekWindow for the week after the gap date does not throw", () => {
    const at = wall(addDays(gapDate, 7), "12:00", tz);
    expect(localWeekWindow(new Date(at).toISOString(), tz)).toEqual(weekContaining(at, tz));
  });

  it("localWeekWindow for the week before the gap date does not throw (its end is the gap day's start when the gap is on a Monday)", () => {
    const at = wall(addDays(gapDate, -7), "12:00", tz);
    expect(localWeekWindow(new Date(at).toISOString(), tz)).toEqual(weekContaining(at, tz));
  });
});

function allDay(id: string, startDate: string, endDateExcl: string): CalendarEvent {
  // The shape BOTH providers hand busy-blocks for an all-day event: Google's
  // start.date coerced to "<date>T00:00:00Z" (google-calendar-provider.ts
  // toCalendarEvent), and Graph's floating midnight read with
  // outlook.timezone="UTC" (graph-event-mapping.ts isoZ).
  return {
    id,
    summary: "Vacation",
    start: `${startDate}T00:00:00.000Z`,
    end: `${endDateExcl}T00:00:00.000Z`,
    isAllDay: true,
    extendedProperties: {},
  } as CalendarEvent;
}

describe.each(ALL_ZONES)("deriveBusyBlocks in %s", (tz) => {
  const opts = { tz, tentativeIsBusy: false, excludeEventIds: new Set<string>() };

  it.each(["2026-08-04", "2026-01-20"])("a one-day all-day event on %s blocks exactly that local day", (d) => {
    const blocks = deriveBusyBlocks([allDay("leave", d, addDays(d, 1))], opts);
    expect(blocks).toEqual([
      expect.objectContaining({
        startUtc: dayStartIso(d, tz),
        endUtc: dayStartIso(addDays(d, 1), tz),
      }),
    ]);
  });

  it("a three-day all-day event blocks exactly those local days", () => {
    const blocks = deriveBusyBlocks([allDay("leave", "2026-05-19", "2026-05-22")], opts);
    expect(blocks.map((b) => [b.startUtc, b.endUtc])).toEqual([
      [dayStartIso("2026-05-19", tz), dayStartIso("2026-05-22", tz)],
    ]);
  });

  it("a timed outOfOffice event blocks its whole local day(s)", () => {
    const s = wallIso("2026-08-04", "10:00", tz);
    const e = wallIso("2026-08-04", "15:00", tz);
    const blocks = deriveBusyBlocks(
      [{ id: "ooo", summary: "OOO", start: s, end: e, eventType: "outOfOffice", extendedProperties: {} } as CalendarEvent],
      opts,
    );
    expect(blocks.map((b) => [b.startUtc, b.endUtc])).toEqual([
      [dayStartIso("2026-08-04", tz), dayStartIso("2026-08-05", tz)],
    ]);
  });

  it("a timed event passes through unchanged", () => {
    const s = wallIso("2026-08-04", "10:00", tz);
    const e = wallIso("2026-08-04", "11:00", tz);
    const blocks = deriveBusyBlocks(
      [{ id: "m", summary: "M", start: s, end: e, extendedProperties: {} } as CalendarEvent],
      opts,
    );
    expect(blocks.map((b) => [b.startUtc, b.endUtc])).toEqual([[s, e]]);
  });
});

describe.each([...MIDNIGHT_GAP_ZONES])("deriveBusyBlocks on the midnight-gap date in %s", (tz) => {
  const gapDate = midnightGapDate(tz, YEAR)!;
  const opts = { tz, tentativeIsBusy: false, excludeEventIds: new Set<string>() };

  it("an all-day event ON the gap date does not throw and blocks from the day's first instant", () => {
    const run = () => deriveBusyBlocks([allDay("leave", gapDate, addDays(gapDate, 1))], opts);
    expect(run).not.toThrow();
    expect(run().map((b) => [b.startUtc, b.endUtc])).toEqual([
      [dayStartIso(gapDate, tz), dayStartIso(addDays(gapDate, 1), tz)],
    ]);
  });

  it("an all-day event ENDING on the gap date (exclusive) does not throw", () => {
    const prev = addDays(gapDate, -1);
    const run = () => deriveBusyBlocks([allDay("leave", prev, gapDate)], opts);
    expect(run).not.toThrow();
    expect(run().map((b) => [b.startUtc, b.endUtc])).toEqual([[dayStartIso(prev, tz), dayStartIso(gapDate, tz)]]);
  });

  it("a timed OOO event on the day before the gap date does not throw (its end is the gap day's start)", () => {
    const prev = addDays(gapDate, -1);
    const s = wallIso(prev, "10:00", tz);
    const e = wallIso(prev, "15:00", tz);
    const run = () =>
      deriveBusyBlocks(
        [{ id: "ooo", summary: "OOO", start: s, end: e, eventType: "outOfOffice", extendedProperties: {} } as CalendarEvent],
        opts,
      );
    expect(run).not.toThrow();
    expect(run().map((b) => [b.startUtc, b.endUtc])).toEqual([[dayStartIso(prev, tz), dayStartIso(gapDate, tz)]]);
  });
});

describe.each(ALL_ZONES)("businessHoursIntervals in %s", (tz) => {
  const bh: BusinessHours = { days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" };

  it("Mon-Fri 09:00-17:00 over a local week yields five local-day intervals", () => {
    for (const mon of ["2026-01-12", "2026-06-15"]) {
      const ws = dayStart(mon, tz);
      const we = dayStart(addDays(mon, 7), tz);
      const want = [0, 1, 2, 3, 4].map((i) => {
        const d = addDays(mon, i);
        return { s: wall(d, "09:00", tz), e: wall(d, "17:00", tz) };
      });
      expect(businessHoursIntervals(ws, we, bh, tz)).toEqual(want);
    }
  });

  it("does not skip or repeat a local day across any 2026 DST transition", () => {
    const every: BusinessHours = { ...bh, days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] };
    for (const tr of transitions(tz, YEAR)) {
      const d0 = addDays(local(tr.atMs, tz).date, -3);
      // Window starts 23:30 local (where it exists) to mirror the original.
      const ws = wallInstants(d0, "23:30", tz)[0] ?? dayStart(addDays(d0, 1), tz);
      const we = ws + 7 * 86_400_000;
      const got = businessHoursIntervals(ws, we, every, tz);
      const want: Array<{ s: number; e: number }> = [];
      for (let i = 0; i <= 8; i++) {
        const d = addDays(d0, i);
        const s = Math.max(wall(d, "09:00", tz), ws);
        const e = Math.min(wall(d, "17:00", tz), we);
        if (e > s) want.push({ s, e });
      }
      expect(got).toEqual(want);
    }
  });
});

describe.each([...MIDNIGHT_GAP_ZONES])("businessHoursIntervals on the midnight-gap date in %s", (tz) => {
  const gapDate = midnightGapDate(tz, YEAR)!;
  const every: BusinessHours = { days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], start: "00:00", end: "06:00" };

  it("a 00:00 business-hours start on the gap date does not throw", () => {
    const ws = dayStart(addDays(gapDate, -1), tz);
    const we = dayStart(addDays(gapDate, 2), tz);
    expect(() => businessHoursIntervals(ws, we, every, tz)).not.toThrow();
  });

  it("09:00-17:00 business hours over a window containing the gap date do not throw", () => {
    const bh: BusinessHours = { ...every, start: "09:00", end: "17:00" };
    const ws = dayStart(addDays(gapDate, -3), tz);
    const we = dayStart(addDays(gapDate, 4), tz);
    expect(() => businessHoursIntervals(ws, we, bh, tz)).not.toThrow();
  });
});
