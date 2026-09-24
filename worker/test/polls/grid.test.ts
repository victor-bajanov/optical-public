import { describe, it, expect } from "vitest";
import { candidateStarts, paintableCells, CELL_MINUTES } from "../../src/polls/grid";

// Wide-open business hours (every day) so tests exercise range clipping and
// min-notice in isolation, without business-hours gaps confounding them.
const OPEN_HOURS = { days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], start: "00:00", end: "23:45" } as any;
const CLOSED_HOURS = { days: [], start: "09:00", end: "17:00" } as any;

function availability(over: Record<string, unknown> = {}) {
  return {
    tz: "UTC",
    hours: OPEN_HOURS,
    busy: [] as Array<{ startUtc: string; endUtc: string }>,
    ...over,
  };
}

function bookingCfg(over: Record<string, unknown> = {}) {
  return {
    min_notice_minutes: 0,
    buffer_minutes: { before: 0, after: 0 },
    ...over,
  };
}

describe("CELL_MINUTES", () => {
  it("is the single source of truth for grid cell width", () => {
    expect(CELL_MINUTES).toBe(30);
  });
});

describe("candidateStarts", () => {
  it("clips to the poll range even when the booking horizon spans more days", () => {
    const now = new Date("2026-08-01T00:00:00Z"); // Sat
    const poll = { duration_min: 30, range_start: "2026-08-05", range_end: "2026-08-06" }; // Wed-Thu
    const starts = candidateStarts(poll, availability(), bookingCfg(), now);

    expect(starts.length).toBeGreaterThan(0);
    for (const s of starts) {
      const t = Date.parse(s);
      expect(t).toBeGreaterThanOrEqual(Date.parse("2026-08-05T00:00:00Z"));
      expect(t).toBeLessThan(Date.parse("2026-08-07T00:00:00Z")); // range_end is inclusive of the whole day
    }
    expect(starts).toContain("2026-08-05T00:00:00.000Z");
    expect(starts).not.toContain("2026-08-01T00:00:00.000Z"); // before range_start, even though open
    expect(starts).not.toContain("2026-08-04T23:30:00.000Z"); // last slot before range_start
  });

  it("returns empty for a range entirely in the past", () => {
    const now = new Date("2026-08-10T00:00:00Z");
    const poll = { duration_min: 30, range_start: "2026-08-01", range_end: "2026-08-03" };
    const starts = candidateStarts(poll, availability(), bookingCfg(), now);
    expect(starts).toEqual([]);
  });

  it("excludes starts inside the min-notice window", () => {
    const now = new Date("2026-08-05T00:00:00Z"); // Wed
    const poll = { duration_min: 30, range_start: "2026-08-05", range_end: "2026-08-05" };
    const starts = candidateStarts(poll, availability(), bookingCfg({ min_notice_minutes: 120 }), now);
    expect(starts[0]).toBe("2026-08-05T02:00:00.000Z");
    expect(starts).not.toContain("2026-08-05T00:00:00.000Z");
    expect(starts).not.toContain("2026-08-05T01:30:00.000Z");
  });

  it("returns nothing when the organiser has no bookable hours at all", () => {
    const now = new Date("2026-08-05T00:00:00Z");
    const poll = { duration_min: 30, range_start: "2026-08-05", range_end: "2026-08-10" };
    const starts = candidateStarts(poll, availability({ hours: CLOSED_HOURS }), bookingCfg(), now);
    expect(starts).toEqual([]);
  });
});

describe("candidateStarts — DST-gap range boundaries", () => {
  // America/Santiago springs forward at local midnight: on 2026-09-06, local
  // time jumps from 2026-09-05T23:59:59 straight to 2026-09-06T01:00:00, so
  // "2026-09-06T00:00:00" never occurs in this zone (verified against this
  // runtime's tz database: offset is UTC-4 through 2026-09-05T12:00 UTC noon
  // and UTC-3 from 2026-09-06T12:00 UTC noon, with the jump landing exactly
  // at local midnight on 2026-09-06).
  const GAP_DATE = "2026-09-06";
  const DAY_BEFORE_GAP = "2026-09-05";
  const SANTIAGO = "America/Santiago";
  // businessHoursIntervals (planning/business-hours-intervals.ts, not this
  // card's fence) independently converts bh.start/bh.end via fromLocalNaive
  // for every local day in its window, so hours starting exactly at local
  // midnight hit the SAME gap for an unrelated reason. Keep this test's hours
  // clear of 00:00-01:00 so it isolates candidateStarts' own range-boundary
  // fix instead of tripping that separate, out-of-fence call site.
  const GAP_SAFE_HOURS = { days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], start: "06:00", end: "22:00" } as any;

  function localDate(iso: string, tz: string): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(
      new Date(iso),
    );
  }

  it("does not throw when range_start lands on a DST-gap local midnight", () => {
    const now = new Date("2026-09-01T00:00:00Z");
    const poll = { duration_min: 30, range_start: GAP_DATE, range_end: "2026-09-08" };
    const starts = candidateStarts(poll, availability({ tz: SANTIAGO, hours: GAP_SAFE_HOURS }), bookingCfg(), now);

    expect(Array.isArray(starts)).toBe(true);
    expect(starts.length).toBeGreaterThan(0);
    // On or after the range start, expressed as a local calendar date (not a
    // hardcoded UTC offset) — the fix must not silently start the range early.
    const first = starts[0];
    if (first === undefined) throw new Error("unreachable: length just asserted > 0");
    expect(localDate(first, SANTIAGO) >= GAP_DATE).toBe(true);
  });

  it("does not clip range_end when range_end + 1 day is a DST-gap local midnight", () => {
    const now = new Date("2026-09-01T00:00:00Z");
    const poll = { duration_min: 30, range_start: "2026-09-01", range_end: DAY_BEFORE_GAP };
    const starts = candidateStarts(poll, availability({ tz: SANTIAGO, hours: GAP_SAFE_HOURS }), bookingCfg(), now);

    expect(Array.isArray(starts)).toBe(true);
    // The exclusive upper bound is itself on the gap date — it must not clip
    // away legitimate candidates on range_end's own day.
    expect(starts.some((s) => localDate(s, SANTIAGO) === DAY_BEFORE_GAP)).toBe(true);
  });

  it("is inert on an ordinary week in a non-gap zone (Australia/Sydney)", () => {
    // Same shape as the "clips to the poll range" test above, but through a
    // real IANA zone with a UTC offset (AEST, no DST in early August) instead
    // of UTC — a regression guard that the gap-tolerant helper produces the
    // same local-midnight instant as before on a date with no gap.
    const now = new Date("2026-08-01T00:00:00Z");
    const poll = { duration_min: 30, range_start: "2026-08-05", range_end: "2026-08-05" };
    const starts = candidateStarts(poll, availability({ tz: "Australia/Sydney" }), bookingCfg(), now);

    expect(starts[0]).toBe("2026-08-04T14:00:00.000Z"); // 2026-08-05T00:00 AEST (UTC+10)
  });
});

describe("paintableCells", () => {
  it("returns empty for no candidates", () => {
    expect(paintableCells([], 60)).toEqual([]);
  });

  it("marks both cells for a 60-minute candidate with no overhang", () => {
    const cells = paintableCells(["2026-08-05T00:00:00.000Z"], 60);
    expect(cells).toEqual(["2026-08-05T00:00:00.000Z", "2026-08-05T00:30:00.000Z"]);
  });

  it("marks a partially-covered tail cell for a 45-minute candidate", () => {
    // [00:00, 00:45) fully covers the 00:00-00:30 cell and half-covers 00:30-01:00.
    const cells = paintableCells(["2026-08-05T00:00:00.000Z"], 45);
    expect(cells).toEqual(["2026-08-05T00:00:00.000Z", "2026-08-05T00:30:00.000Z"]);
  });

  it("marks three cells for a 90-minute candidate", () => {
    const cells = paintableCells(["2026-08-05T00:00:00.000Z"], 90);
    expect(cells).toEqual([
      "2026-08-05T00:00:00.000Z",
      "2026-08-05T00:30:00.000Z",
      "2026-08-05T01:00:00.000Z",
    ]);
  });

  it("dedupes and sorts cells across overlapping candidates", () => {
    const cells = paintableCells(
      ["2026-08-05T01:00:00.000Z", "2026-08-05T00:00:00.000Z", "2026-08-05T00:30:00.000Z"],
      45,
    );
    expect(cells).toEqual([
      "2026-08-05T00:00:00.000Z",
      "2026-08-05T00:30:00.000Z",
      "2026-08-05T01:00:00.000Z",
      "2026-08-05T01:30:00.000Z",
    ]);
  });
});
