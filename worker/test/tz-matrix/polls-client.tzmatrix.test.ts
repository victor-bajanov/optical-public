// tz-matrix mirror of test/polls/grid.test.ts (candidateStarts),
// test/polls/scoring.test.ts (organiserFit), test/polls/client-grid.test.ts
// (bucketSlotsByLocalDate across DST) and test/booking/client-logic.test.ts
// (parseIcsBusy TZID / all-day / DST recurrence, bucketSlotsByLocalDate).
import { describe, it, expect } from "vitest";
import { candidateStarts, paintableCells } from "../../src/polls/grid";
import { organiserFit, fitScoreForChunk } from "../../src/polls/scoring";
import { bucketSlotsByLocalDate as pollBucket } from "../../src/polls/poll.client.js";
import { parseIcsBusy, bucketSlotsByLocalDate as bookBucket } from "../../src/booking/booking.client.js";
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
  wallIso,
} from "./zones";

const ALL_ZONES = [...new Set([...MATRIX_ZONES, ...MIDNIGHT_GAP_ZONES])];
const OPEN_HOURS = { days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], start: "00:00", end: "23:45" } as any;
const GAP_SAFE_HOURS = { days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], start: "06:00", end: "22:00" } as any;
const cfg = (over: Record<string, unknown> = {}) => ({ min_notice_minutes: 0, buffer_minutes: { before: 0, after: 0 }, ...over });

describe.each(ALL_ZONES)("candidateStarts in %s", (tz) => {
  it("clips to the poll range [local range_start 00:00, local range_end+1 00:00)", () => {
    const now = new Date(dayStart("2026-08-01", tz));
    const poll = { duration_min: 30, range_start: "2026-08-05", range_end: "2026-08-06" };
    const starts = candidateStarts(poll, { tz, hours: OPEN_HOURS, busy: [] }, cfg(), now);
    expect(starts.length).toBeGreaterThan(0);
    expect(starts[0]).toBe(dayStartIso("2026-08-05", tz));
    for (const s of starts) {
      expect(["2026-08-05", "2026-08-06"]).toContain(local(Date.parse(s), tz).date);
    }
  });

  it("every candidate and paintable cell sits on the LOCAL half-hour grid", () => {
    const now = new Date(dayStart("2026-08-01", tz));
    const poll = { duration_min: 60, range_start: "2026-08-05", range_end: "2026-08-05" };
    const starts = candidateStarts(poll, { tz, hours: GAP_SAFE_HOURS, busy: [] }, cfg(), now);
    expect(starts[0]).toBe(wallIso("2026-08-05", "06:00", tz));
    const cells = paintableCells(starts, 60, tz);
    const offGrid = [...starts, ...cells].filter((s) => !/:(00|30)$/.test(local(Date.parse(s), tz).time));
    expect(offGrid).toEqual([]);
  });

  it("excludes starts inside the min-notice window", () => {
    const now = new Date(wall("2026-08-05", "08:00", tz));
    const poll = { duration_min: 30, range_start: "2026-08-05", range_end: "2026-08-05" };
    const starts = candidateStarts(poll, { tz, hours: OPEN_HOURS, busy: [] }, cfg({ min_notice_minutes: 120 }), now);
    expect(starts[0]).toBe(wallIso("2026-08-05", "10:00", tz));
  });
});

describe.each([...MIDNIGHT_GAP_ZONES])("candidateStarts on the midnight-gap date in %s", (tz) => {
  const gap = midnightGapDate(tz, 2026)!;
  const now = new Date(dayStart(addDays(gap, -5), tz));

  it("range_start on the gap date with gap-safe hours starts on the gap date", () => {
    const poll = { duration_min: 30, range_start: gap, range_end: addDays(gap, 2) };
    const starts = candidateStarts(poll, { tz, hours: GAP_SAFE_HOURS, busy: [] }, cfg(), now);
    expect(starts[0]).toBe(wallIso(gap, "06:00", tz));
  });

  it("range_end the day before the gap date keeps that day's candidates", () => {
    const poll = { duration_min: 30, range_start: addDays(gap, -3), range_end: addDays(gap, -1) };
    const starts = candidateStarts(poll, { tz, hours: GAP_SAFE_HOURS, busy: [] }, cfg(), now);
    expect(starts.some((s) => local(Date.parse(s), tz).date === addDays(gap, -1))).toBe(true);
  });

  it("all-day-open hours (00:00 start) over the gap date do not throw", () => {
    const poll = { duration_min: 30, range_start: addDays(gap, -1), range_end: addDays(gap, 1) };
    expect(() => candidateStarts(poll, { tz, hours: OPEN_HOURS, busy: [] }, cfg(), now)).not.toThrow();
  });
});

describe.each(ALL_ZONES)("organiserFit in %s", (tz) => {
  const curve = { peak_start: "10:00", peak_end: "12:00", falloff_end: "17:00" };
  it("reads minute-of-day in the organiser's zone on both sides of every 2026 transition", () => {
    const dates = ["2026-01-14", "2026-07-14", ...transitions(tz, 2026).map((t) => addDays(local(t.atMs, tz).date, 1))];
    for (const d of dates) {
      for (const [hhmm, minute] of [["09:00", 540], ["11:00", 660], ["14:30", 870]] as const) {
        const want = (100 * 2 - fitScoreForChunk(curve as any, minute, 30)) / (100 * 2);
        expect(organiserFit(curve as any, wallIso(d, hhmm, tz), 30, tz)).toBeCloseTo(want, 10);
      }
    }
  });
});

describe.each(ALL_ZONES)("client bucketSlotsByLocalDate in %s", (tz) => {
  it("poll and booking clients bucket 30-min cells around every transition by the oracle's local date", () => {
    const anchors = [Date.parse("2026-08-03T00:00:00Z"), ...transitions(tz, 2026).map((t) => t.atMs)];
    for (const a of anchors) {
      const cells: string[] = [];
      for (let t = a - 26 * 3_600_000; t <= a + 26 * 3_600_000; t += 30 * 60_000) cells.push(new Date(t).toISOString());
      const want = new Map<string, string[]>();
      for (const c of cells) {
        const k = local(Date.parse(c), tz).date;
        want.set(k, [...(want.get(k) ?? []), c]);
      }
      expect(pollBucket(cells, tz)).toEqual(want);
      expect(bookBucket(cells, tz)).toEqual(want);
    }
  });
});

const ics = (...lines: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", ...lines, "END:VEVENT", "END:VCALENDAR"].join("\r\n");
const WINDOW = { fromMs: Date.parse("2026-01-01T00:00:00Z"), toMs: Date.parse("2026-12-31T00:00:00Z") };

describe.each(ALL_ZONES)("booking client parseIcsBusy in %s", (tz) => {
  it("converts a TZID-bound 10:00-11:00 event to the zone's instants", () => {
    const busy = parseIcsBusy(
      ics(`DTSTART;TZID=${tz}:20260803T100000`, `DTEND;TZID=${tz}:20260803T110000`),
      { ...WINDOW, defaultTz: "UTC" },
    );
    expect(busy).toEqual([{ s: wall("2026-08-03", "10:00", tz), e: wall("2026-08-03", "11:00", tz) }]);
  });

  it("an all-day DATE event (no TZID) is that whole LOCAL day in the viewer zone", () => {
    for (const d of ["2026-01-20", "2026-08-03"]) {
      const compact = d.replaceAll("-", "");
      const next = addDays(d, 1).replaceAll("-", "");
      const busy = parseIcsBusy(ics(`DTSTART;VALUE=DATE:${compact}`, `DTEND;VALUE=DATE:${next}`), { ...WINDOW, defaultTz: tz });
      expect(busy).toEqual([{ s: dayStart(d, tz), e: dayStart(addDays(d, 1), tz) }]);
    }
  });

  it("a daily 09:00 local recurrence holds 09:00 local across every 2026 transition", () => {
    const busy = parseIcsBusy(
      ics(`DTSTART;TZID=${tz}:20150105T090000`, `DTEND;TZID=${tz}:20150105T093000`, "RRULE:FREQ=DAILY"),
      { fromMs: Date.parse("2026-01-01T00:00:00Z"), toMs: Date.parse("2026-12-30T00:00:00Z"), defaultTz: "UTC" },
    );
    const drift = busy.filter((b: { s: number }) => local(b.s, tz).time !== "09:00");
    expect(busy.length).toBeGreaterThan(300);
    expect(drift).toEqual([]);
  });
});

describe.each([...MIDNIGHT_GAP_ZONES])("booking client all-day on the midnight-gap date in %s", (tz) => {
  it("an all-day event on the gap date covers the gap date (starts at its first instant)", () => {
    const gap = midnightGapDate(tz, 2026)!;
    const busy = parseIcsBusy(
      ics(`DTSTART;VALUE=DATE:${gap.replaceAll("-", "")}`, `DTEND;VALUE=DATE:${addDays(gap, 1).replaceAll("-", "")}`),
      { ...WINDOW, defaultTz: tz },
    );
    expect(busy).toEqual([{ s: dayStart(gap, tz), e: dayStart(addDays(gap, 1), tz) }]);
  });
});
