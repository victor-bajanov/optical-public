import { describe, it, expect } from "vitest";
import {
  parseIcsBusy,
  filterSlots,
  dotCount,
  MAX_DOTS,
  warnings,
  unfoldLines,
  parseProperty,
  toUtcMs,
  expandRRule,
  bucketSlotsByLocalDate,
  stripDays,
  stripMonths,
  monthLabel,
  weekOf,
  weekColumns,
  readSlotCache,
  writeSlotCache,
  appendSlotPage,
  applyConflictSlots,
  clearSlotCache,
  MAX_RULE_INSTANCES,
  MAX_TOTAL_INSTANCES,
  MAX_ICS_CHARS,
  overlayWindow,
  OVERLAY_HEADROOM_MS,
  OVERLAY_MAX_SPAN_MS,
  confirmNeedsRebuild,
  confirmWhenText,
  onTurnstileReady,
  TURNSTILE_READY_CALLBACK,
  resetTurnstile,
  claimOutcome,
  tzSelectZones,
  locationFieldFor,
  locationPayload,
  overlayStatusText,
  stats,
  parseIcsBusy as parseForStats,
} from "../../src/booking/booking.client.js";
import published from "../../../schema/openapi.json";

const WINDOW = { fromMs: Date.parse("2026-08-01T00:00:00Z"), toMs: Date.parse("2026-08-31T00:00:00Z") };

// booking.client.js is plain ESM with no annotations (it is served verbatim to
// browsers), so filterSlots' element type is inferred as `any` here.
type Marked = { iso: string; clashes: boolean };

function ics(...vevents: string[]): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", ...vevents, "END:VCALENDAR"].join("\r\n");
}

describe("parseIcsBusy", () => {
  it("reads a UTC timed event", () => {
    const busy = parseIcsBusy(
      ics(["BEGIN:VEVENT", "DTSTART:20260803T000000Z", "DTEND:20260803T010000Z", "END:VEVENT"].join("\r\n")),
      WINDOW,
    );
    expect(busy).toEqual([{ s: Date.parse("2026-08-03T00:00:00Z"), e: Date.parse("2026-08-03T01:00:00Z") }]);
  });

  it("converts a TZID-bound event to UTC", () => {
    const busy = parseIcsBusy(
      ics(["BEGIN:VEVENT", "DTSTART;TZID=Australia/Sydney:20260803T100000",
           "DTEND;TZID=Australia/Sydney:20260803T110000", "END:VEVENT"].join("\r\n")),
      WINDOW,
    );
    expect(busy[0]!.s).toBe(Date.parse("2026-08-03T00:00:00Z")); // 10:00 +10
  });

  it("treats an all-day event as a whole day", () => {
    const busy = parseIcsBusy(
      ics(["BEGIN:VEVENT", "DTSTART;VALUE=DATE:20260803", "DTEND;VALUE=DATE:20260804", "END:VEVENT"].join("\r\n")),
      WINDOW,
    );
    expect(busy[0]!.e - busy[0]!.s).toBe(86_400_000);
  });

  it("expands a weekly recurrence", () => {
    const busy = parseIcsBusy(
      ics(["BEGIN:VEVENT", "DTSTART:20260803T000000Z", "DTEND:20260803T003000Z",
           "RRULE:FREQ=WEEKLY;COUNT=3", "END:VEVENT"].join("\r\n")),
      WINDOW,
    );
    expect(busy).toHaveLength(3);
    expect(busy[2]!.s).toBe(Date.parse("2026-08-17T00:00:00Z"));
  });

  it("returns an empty list for junk input rather than throwing", () => {
    expect(parseIcsBusy("not a calendar", WINDOW)).toEqual([]);
  });
});

const SLOTS = [
  "2026-08-03T00:00:00.000Z", // Mon 10:00 +10
  "2026-08-03T00:30:00.000Z",
  "2026-08-03T01:00:00.000Z",
  "2026-08-04T00:00:00.000Z", // Tue
];

describe("overlayStatusText", () => {
  // A booker loaded a real export and was told "2 busy blocks read locally
  // (4 parts could not be read)". Both halves misled: the 2 counted MERGED
  // intervals (29 were parsed), and nothing had failed to read — the 4 were
  // FREQ=MONTHLY rules that were read and collapsed to their first occurrence.
  it("reports how many events produced the blocks, so merging is not mistaken for a short read", () => {
    expect(overlayStatusText({ events: 29, blocks: 16 }, [])).toBe(
      "✓ 16 busy blocks read locally (from 29 events)",
    );
  });

  it("omits the event count when it would just repeat the block count", () => {
    expect(overlayStatusText({ events: 3, blocks: 3 }, [])).toBe("✓ 3 busy blocks read locally");
  });

  it("says plainly when a calendar contributed no busy time", () => {
    expect(overlayStatusText({ events: 0, blocks: 0 }, [])).toBe("✓ No busy time found in that calendar");
  });

  it("never claims something could not be read when it merely warned", () => {
    const text = overlayStatusText({ events: 29, blocks: 16 }, ["Unsupported RRULE FREQ=MONTHLY; keeping first instance only"]);
    expect(text).not.toContain("could not be read");
    expect(text).toContain("1 warning");
    expect(text).not.toContain("1 warnings");
  });

  it("pluralises several warnings", () => {
    expect(overlayStatusText({ events: 29, blocks: 16 }, ["a", "b", "c", "d"])).toContain("4 warnings");
  });
});

describe("parse stats", () => {
  it("counts the events that contributed, not the merged blocks", () => {
    // Two back-to-back events merge into one block; the count must still say 2.
    const text = [
      "BEGIN:VEVENT", "DTSTART:20260803T000000Z", "DTEND:20260803T010000Z", "END:VEVENT",
      "BEGIN:VEVENT", "DTSTART:20260803T010000Z", "DTEND:20260803T020000Z", "END:VEVENT",
    ].join("\r\n");
    const busy = parseForStats(ics(text), WINDOW);
    expect(busy).toHaveLength(1); // merged
    expect(stats.events).toBe(2);
    expect(stats.blocks).toBe(1);
  });

  it("does not count an event that contributed nothing to the window", () => {
    const text = ["BEGIN:VEVENT", "DTSTART:20250101T000000Z", "DTEND:20250101T010000Z", "END:VEVENT"].join("\r\n");
    parseForStats(ics(text), WINDOW);
    expect(stats.events).toBe(0);
  });
});

describe("filterSlots", () => {
  it("marks slots that clash with the overlay, keeping them selectable", () => {
    const overlay = [{ s: Date.parse("2026-08-03T00:00:00Z"), e: Date.parse("2026-08-03T00:45:00Z") }];
    const marked = filterSlots(SLOTS, 30, overlay);
    expect(marked.map((m: Marked) => m.clashes)).toEqual([true, true, false, false]);
    expect(marked).toHaveLength(SLOTS.length); // never hidden, only dimmed
  });

  it("marks nothing when there is no overlay", () => {
    expect(filterSlots(SLOTS, 30, []).every((m: Marked) => !m.clashes)).toBe(true);
  });
});

describe("dotCount", () => {
  it("counts only slots free for both parties", () => {
    const overlay = [{ s: Date.parse("2026-08-03T00:00:00Z"), e: Date.parse("2026-08-03T00:45:00Z") }];
    expect(dotCount("2026-08-03", SLOTS, 30, [], "Australia/Sydney")).toBe(3);
    expect(dotCount("2026-08-03", SLOTS, 30, overlay, "Australia/Sydney")).toBe(1);
  });

  it("caps at four", () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      new Date(Date.parse("2026-08-03T00:00:00Z") + i * 1800_000).toISOString());
    expect(dotCount("2026-08-03", many, 30, [], "Australia/Sydney")).toBe(MAX_DOTS);
    expect(MAX_DOTS).toBe(4);
  });

  it("groups by LOCAL date, not UTC date", () => {
    // 2026-08-03T22:00Z is Tue 4 Aug 08:00 in Sydney.
    expect(dotCount("2026-08-04", ["2026-08-03T22:00:00.000Z"], 30, [], "Australia/Sydney")).toBe(1);
  });

  it("groups by the SELECTED zone, so switching moves a slot between days", () => {
    const iso = "2026-08-03T22:00:00.000Z"; // Tue 4 Aug 08:00 Sydney, Mon 3 Aug 22:00 UTC
    expect(dotCount("2026-08-04", [iso], 30, [], "Australia/Sydney")).toBe(1);
    expect(dotCount("2026-08-03", [iso], 30, [], "UTC")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Regression tests for the two CRITICAL defects: both under-reported the
// booker's busy time on ordinary calendar exports, which is the unsafe
// direction (a clashing slot renders as free).
// ---------------------------------------------------------------------------

const HALF_HOUR = 30 * 60_000;
const noop = (): void => {};

describe("expandRRule", () => {
  it("seeks to the window rather than stepping to it", () => {
    // A daily standup running since 2015 is >3700 days before the window, so
    // stepping one day at a time exhausted the cap before arriving.
    const inst = expandRRule(
      Date.parse("2015-01-01T23:00:00Z"), HALF_HOUR, { FREQ: "DAILY" },
      WINDOW.fromMs, WINDOW.toMs, noop, null, "UTC",
    );
    expect(inst).toHaveLength(30);
    expect(inst[0]!.s).toBe(Date.parse("2026-08-01T23:00:00Z"));
  });

  it("does not resurrect a recurrence whose COUNT ran out before the window", () => {
    const inst = expandRRule(
      Date.parse("2015-01-01T23:00:00Z"), HALF_HOUR, { FREQ: "DAILY", COUNT: "10" },
      WINDOW.fromMs, WINDOW.toMs, noop, null, "UTC",
    );
    expect(inst).toEqual([]);
  });

  it("honours UNTIL after seeking", () => {
    const inst = expandRRule(
      Date.parse("2015-01-01T23:00:00Z"), HALF_HOUR, { FREQ: "DAILY", UNTIL: "20260805T000000Z" },
      WINDOW.fromMs, WINDOW.toMs, noop, null, "UTC",
    );
    expect(inst).toHaveLength(4); // 23:00 on Aug 1, 2, 3, 4
  });

  it("keeps an instance that starts before the window but ends inside it", () => {
    const inst = expandRRule(
      Date.parse("2015-01-01T23:00:00Z"), 2 * 60 * 60_000, { FREQ: "DAILY" },
      WINDOW.fromMs, WINDOW.toMs, noop, null, "UTC",
    );
    expect(inst[0]!.s).toBe(Date.parse("2026-07-31T23:00:00Z"));
  });

  it("stops a single rule at the per-rule cap and says so", () => {
    const seen: string[] = [];
    const inst = expandRRule(
      Date.parse("2026-08-01T00:00:00Z"), 60_000, { FREQ: "DAILY" },
      Date.parse("2026-08-01T00:00:00Z"), Date.parse("2126-08-01T00:00:00Z"),
      (msg: string) => seen.push(msg), null, "UTC",
    );
    expect(inst).toHaveLength(MAX_RULE_INSTANCES);
    expect(seen.join(" ")).toMatch(/safety cap/);
  });

  it("keeps an unsupported FREQ as a single instance", () => {
    const seen: string[] = [];
    const inst = expandRRule(
      WINDOW.fromMs, HALF_HOUR, { FREQ: "MONTHLY" },
      WINDOW.fromMs, WINDOW.toMs, (msg: string) => seen.push(msg), null, "UTC",
    );
    expect(inst).toHaveLength(1);
    expect(seen.join(" ")).toMatch(/Unsupported RRULE/);
  });
});

describe("parseIcsBusy — recurrence seeking (CRITICAL 1)", () => {
  it("finds in-window instances of a daily rule that started years ago", () => {
    const busy = parseIcsBusy(
      ics(["BEGIN:VEVENT", "DTSTART:20150101T230000Z", "DTEND:20150101T233000Z",
           "RRULE:FREQ=DAILY", "END:VEVENT"].join("\r\n")),
      WINDOW,
    );
    expect(busy).toHaveLength(30);
    expect(busy[0]!.s).toBe(Date.parse("2026-08-01T23:00:00Z"));
  });

  it("holds local wall-clock time across a DST transition", () => {
    // Sydney leaves AEST on 2026-10-04; a 09:00 local standup must stay at
    // 09:00 local, not drift to 08:00, after the seek jumps over the boundary.
    const hourInSydney = (ms: number): number =>
      Number(new Intl.DateTimeFormat("en-US", {
        timeZone: "Australia/Sydney", hour: "2-digit", hour12: false,
      }).format(new Date(ms)));
    const busy = parseIcsBusy(
      ics(["BEGIN:VEVENT", "DTSTART;TZID=Australia/Sydney:20150105T090000",
           "DTEND;TZID=Australia/Sydney:20150105T093000",
           "RRULE:FREQ=DAILY", "END:VEVENT"].join("\r\n")),
      { fromMs: Date.parse("2026-09-27T00:00:00Z"), toMs: Date.parse("2026-10-15T00:00:00Z") },
    );
    expect(busy.length).toBeGreaterThan(10);
    for (const b of busy) expect(hourInSydney(b.s)).toBe(9);
  });
});

describe("parseIcsBusy — bounded work (CRITICAL 2)", () => {
  it("bounds total instances across many recurring events", () => {
    const vevents = Array.from({ length: 20 }, (_, i) => {
      const hh = String(i).padStart(2, "0");
      return ["BEGIN:VEVENT", `DTSTART:20260801T${hh}0000Z`, `DTEND:20260801T${hh}3000Z`,
              "RRULE:FREQ=DAILY", "END:VEVENT"].join("\r\n");
    });
    const started = Date.now();
    const busy = parseIcsBusy(ics(vevents.join("\r\n")), {
      fromMs: Date.parse("2026-08-01T00:00:00Z"), toMs: Date.parse("2126-08-01T00:00:00Z"),
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(busy.length).toBeLessThanOrEqual(MAX_TOTAL_INSTANCES + MAX_RULE_INSTANCES);
    expect(warnings.join(" ")).toMatch(/too large to read fully/i);
  });

  it("refuses an oversize file with a warning instead of parsing it", () => {
    expect(parseIcsBusy("x".repeat(MAX_ICS_CHARS + 1), WINDOW)).toEqual([]);
    expect(warnings.join(" ")).toMatch(/too large/i);
  });
});

describe("parseIcsBusy — non-IANA timezones (IMPORTANT 3)", () => {
  it("falls back to the default zone for a Windows TZID rather than dropping the event", () => {
    const busy = parseIcsBusy(
      ics(["BEGIN:VEVENT", "DTSTART;TZID=W. Europe Standard Time:20260803T100000",
           "DTEND;TZID=W. Europe Standard Time:20260803T110000", "END:VEVENT"].join("\r\n")),
      { ...WINDOW, defaultTz: "Australia/Sydney" },
    );
    expect(busy).toHaveLength(1);
    expect(busy[0]!.e - busy[0]!.s).toBe(60 * 60_000);
    expect(busy[0]!.s).toBe(Date.parse("2026-08-03T00:00:00Z")); // read as 10:00 Sydney
  });

  it("warns once per distinct unknown TZID, not once per property", () => {
    parseIcsBusy(
      ics(["BEGIN:VEVENT", "DTSTART;TZID=W. Europe Standard Time:20260803T100000",
           "DTEND;TZID=W. Europe Standard Time:20260803T110000", "END:VEVENT"].join("\r\n")),
      { ...WINDOW, defaultTz: "Australia/Sydney" },
    );
    expect(warnings.filter((w: string) => w.includes("W. Europe Standard Time"))).toHaveLength(1);
  });
});

describe("line-level helpers", () => {
  it("unfolds RFC 5545 continuation lines", () => {
    expect(unfoldLines("DTSTART;TZID=Australia/\r\n Sydney:20260803T100000"))
      .toEqual(["DTSTART;TZID=Australia/Sydney:20260803T100000"]);
  });

  it("reads a folded property through a full parse", () => {
    const busy = parseIcsBusy(
      ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "DTSTART;TZID=Australia/", "\tSydney:20260803T100000",
       "DTEND;TZID=Australia/Sydney:20260803T110000", "END:VEVENT", "END:VCALENDAR"].join("\r\n"),
      WINDOW,
    );
    expect(busy[0]!.s).toBe(Date.parse("2026-08-03T00:00:00Z"));
  });

  it("splits a property on the first colon only", () => {
    const p = parseProperty("DTSTART;TZID=Australia/Sydney:20260803T100000");
    expect(p.name).toBe("DTSTART");
    expect((p.params as Record<string, string>).TZID).toBe("Australia/Sydney");
    expect(p.value).toBe("20260803T100000");
  });

  it("converts UTC, TZID and DATE values", () => {
    expect(toUtcMs("20260803T000000Z", null, "UTC")).toEqual({ ms: Date.parse("2026-08-03T00:00:00Z"), allDay: false });
    expect(toUtcMs("20260803T100000", "Australia/Sydney", "UTC").ms).toBe(Date.parse("2026-08-03T00:00:00Z"));
    expect(toUtcMs("20260803", null, "UTC")).toEqual({ ms: Date.parse("2026-08-03T00:00:00Z"), allDay: true });
  });
});

describe("bucketSlotsByLocalDate (IMPORTANT 4)", () => {
  it("agrees with the array path", () => {
    const buckets = bucketSlotsByLocalDate(SLOTS, "Australia/Sydney");
    expect(dotCount("2026-08-03", buckets, 30, [], "Australia/Sydney")).toBe(3);
    expect(dotCount("2026-08-04", buckets, 30, [], "Australia/Sydney")).toBe(1);
    const overlay = [{ s: Date.parse("2026-08-03T00:00:00Z"), e: Date.parse("2026-08-03T00:45:00Z") }];
    expect(dotCount("2026-08-03", buckets, 30, overlay, "Australia/Sydney")).toBe(1);
  });

  it("keys buckets by LOCAL date", () => {
    const buckets = bucketSlotsByLocalDate(["2026-08-03T22:00:00.000Z"], "Australia/Sydney");
    expect([...buckets.keys()]).toEqual(["2026-08-04"]);
  });
});

describe("stripDays", () => {
  it("lists every bookable day, so the tail of a long horizon stays selectable", () => {
    // horizon_days defaults to 21 and the config schema allows 120. The strip
    // is the ONLY way to select a day, so capping it hides days that /slots
    // returns and that a claim would be accepted on.
    const slots = Array.from({ length: 21 }, (_, i) =>
      new Date(Date.parse("2026-08-03T00:00:00Z") + i * 86_400_000).toISOString());
    const days: string[] = stripDays(bucketSlotsByLocalDate(slots, "Australia/Sydney"));
    expect(days).toHaveLength(21);
    expect(days[days.length - 1]).toBe("2026-08-23");
  });
});

// ---------------------------------------------------------------------------
// Desktop week grid. mount() cannot be exercised here (no DOM in the workers
// pool), so the column layout it renders is decided by these two functions.
// ---------------------------------------------------------------------------

type Column = { day: string; slots: Marked[] };

describe("weekOf", () => {
  it("returns Monday through Sunday around the given day", () => {
    expect(weekOf("2026-08-05")).toEqual([
      "2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06",
      "2026-08-07", "2026-08-08", "2026-08-09",
    ]);
  });

  it("gives every day of one week the same seven columns", () => {
    // Otherwise picking a neighbouring day would reshuffle the grid under the
    // booker instead of just moving the highlight.
    expect(weekOf("2026-08-09")).toEqual(weekOf("2026-08-03"));
  });

  it("crosses a month boundary", () => {
    expect(weekOf("2026-08-01")).toEqual([
      "2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30",
      "2026-07-31", "2026-08-01", "2026-08-02",
    ]);
  });
});

describe("weekColumns", () => {
  const buckets = bucketSlotsByLocalDate(SLOTS, "Australia/Sydney");

  it("files each day's slots under its own column", () => {
    const cols: Column[] = weekColumns("2026-08-03", buckets, 30, []);
    expect(cols.map((c) => c.day)).toEqual(weekOf("2026-08-03"));
    expect(cols[0]!.slots.map((s) => s.iso)).toEqual(SLOTS.slice(0, 3)); // Mon
    expect(cols[1]!.slots.map((s) => s.iso)).toEqual([SLOTS[3]]); // Tue
  });

  it("leaves a day with no availability empty, for the hatched cell", () => {
    const cols: Column[] = weekColumns("2026-08-03", buckets, 30, []);
    expect(cols[2]!.slots).toEqual([]); // Wed — nothing on offer
  });

  it("marks clashing slots in place rather than dropping them from the column", () => {
    const overlay = [{ s: Date.parse("2026-08-03T00:00:00Z"), e: Date.parse("2026-08-03T00:45:00Z") }];
    const cols: Column[] = weekColumns("2026-08-03", buckets, 30, overlay);
    expect(cols[0]!.slots.map((s) => s.clashes)).toEqual([true, true, false]);
  });

  it("reaches the tail of a 21-day horizon", () => {
    // The grid must not become a second cap on the horizon: day 21 has to be
    // renderable, and horizon_days may be as high as 120.
    const slots = Array.from({ length: 21 }, (_, i) =>
      new Date(Date.parse("2026-08-03T00:00:00Z") + i * 86_400_000).toISOString());
    const cols: Column[] = weekColumns("2026-08-23", bucketSlotsByLocalDate(slots, "Australia/Sydney"), 30, []);
    expect(cols[6]!.day).toBe("2026-08-23");
    expect(cols[6]!.slots).toHaveLength(1);
  });

  it("has no columns at all when nothing is on offer", () => {
    expect(weekColumns(null, new Map(), 30, [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Per-duration slot cache. Every /slots fetch costs a full calendar read
// server-side, so toggling 30 → 60 → 30 must cost two, not three.
// ---------------------------------------------------------------------------

describe("slot cache", () => {
  it("misses for a duration that has not been fetched", () => {
    expect(readSlotCache(new Map(), 30)).toBeNull();
  });

  it("returns what was written, per duration", () => {
    const cache = new Map();
    writeSlotCache(cache, 30, { slots: ["a"], timezone: "Australia/Sydney" });
    writeSlotCache(cache, 60, { slots: ["b"], timezone: "Australia/Sydney" });
    expect(readSlotCache(cache, 30).slots).toEqual(["a"]);
    expect(readSlotCache(cache, 60).slots).toEqual(["b"]);
  });

  it("replaces the cached list for the duration that lost the race", () => {
    // A 409 carries a fresh list. Keeping the old one would re-offer the slot
    // another booker just took.
    const cache = new Map();
    writeSlotCache(cache, 30, { slots: ["a", "b"], timezone: "UTC" });
    expect(applyConflictSlots(cache, 30, ["b"], "UTC")).toEqual(["b"]);
    expect(readSlotCache(cache, 30).slots).toEqual(["b"]);
  });

  it("drops the entry when the conflict response carries no list", () => {
    // Nothing trustworthy to cache, so the next selection of this duration
    // must go back to the server.
    const cache = new Map();
    writeSlotCache(cache, 30, { slots: ["a", "b"], timezone: "UTC" });
    expect(applyConflictSlots(cache, 30, undefined, "UTC")).toBeNull();
    expect(readSlotCache(cache, 30)).toBeNull();
  });

  it("leaves the other durations alone on a conflict", () => {
    const cache = new Map();
    writeSlotCache(cache, 30, { slots: ["a"], timezone: "UTC" });
    writeSlotCache(cache, 60, { slots: ["c"], timezone: "UTC" });
    applyConflictSlots(cache, 30, ["b"], "UTC");
    expect(readSlotCache(cache, 60).slots).toEqual(["c"]);
  });

  it("forgets every duration once a booking succeeds", () => {
    // The booked slot blocks more than its own start — a 60-minute booking
    // also kills the 30-minute starts it covers, plus the buffers either side.
    const cache = new Map();
    writeSlotCache(cache, 30, { slots: ["a"], timezone: "UTC" });
    writeSlotCache(cache, 60, { slots: ["b"], timezone: "UTC" });
    clearSlotCache(cache);
    expect(readSlotCache(cache, 30)).toBeNull();
    expect(readSlotCache(cache, 60)).toBeNull();
  });
});

describe("slot cache — pages", () => {
  // Each `/slots` response is one page: `{ slots, timezone, page, has_more,
  // window }`. The entry for a duration holds the UNION of the pages loaded so
  // far, in order, plus how many it holds and whether the server has more.
  const P0 = { slots: ["2026-08-03T00:00:00.000Z", "2026-08-10T00:00:00.000Z"], timezone: "UTC", page: 0, has_more: true,
    window: { start: "2026-08-01T00:00:00.000Z", end: "2026-08-15T00:00:00.000Z" } };
  const P1 = { slots: ["2026-08-17T00:00:00.000Z", "2026-08-24T00:00:00.000Z"], timezone: "UTC", page: 1, has_more: false,
    window: { start: "2026-08-15T00:00:00.000Z", end: "2026-08-29T00:00:00.000Z" } };

  it("starts an entry from page 0, recording the reach", () => {
    const cache = new Map();
    const entry = appendSlotPage(cache, 30, P0);
    expect(entry).toEqual({ slots: P0.slots, timezone: "UTC", pages: 1, hasMore: true });
    expect(readSlotCache(cache, 30)).toBe(entry);
  });

  it("appends the next page in order and counts it", () => {
    const cache = new Map();
    appendSlotPage(cache, 30, P0);
    const entry = appendSlotPage(cache, 30, P1)!;
    expect(entry.slots).toEqual([...P0.slots, ...P1.slots]);
    expect(entry.pages).toBe(2);
    expect(entry.hasMore).toBe(false);
  });

  it("re-sorts when a page boundary splits a day — the union must read as one list", () => {
    // Pages are ms-exact windows off the server's `now`, so a day can straddle
    // two pages; the strip buckets by local date and must see a sorted union.
    const cache = new Map();
    appendSlotPage(cache, 30, { ...P0, slots: ["2026-08-15T01:00:00.000Z"] });
    const entry = appendSlotPage(cache, 30, { ...P1, slots: ["2026-08-15T00:00:00.000Z"] })!;
    expect(entry.slots).toEqual(["2026-08-15T00:00:00.000Z", "2026-08-15T01:00:00.000Z"]);
  });

  it("ignores a page that is not the next one — a duplicate response, or one for an entry that was reset", () => {
    const cache = new Map();
    appendSlotPage(cache, 30, P0);
    appendSlotPage(cache, 30, P0); // duplicate of page 0
    expect(readSlotCache(cache, 30).slots).toEqual(P0.slots);
    expect(readSlotCache(cache, 30).pages).toBe(1);
    expect(appendSlotPage(new Map(), 30, P1)).toBeNull(); // page 1 with nothing held
  });

  it("a conflict splices only the page it names, keeping the others and the reach", () => {
    const cache = new Map();
    appendSlotPage(cache, 30, P0);
    appendSlotPage(cache, 30, { ...P1, has_more: true });
    const fresh = ["2026-08-24T00:00:00.000Z"]; // Aug 17 was taken
    expect(applyConflictSlots(cache, 30, fresh, "UTC", P1.window)).toEqual([...P0.slots, ...fresh]);
    const entry = readSlotCache(cache, 30);
    expect(entry.slots).toEqual([...P0.slots, ...fresh]);
    expect(entry.pages).toBe(2);
    expect(entry.hasMore).toBe(true);
  });
});

describe("overlayWindow", () => {
  const NOW = Date.parse("2026-08-01T00:00:00Z");
  const day = (n: number) => new Date(NOW + n * 86_400_000).toISOString();

  it("starts at now", () => {
    expect(overlayWindow([day(1)], NOW).fromMs).toBe(NOW);
  });

  it("reaches past the last offered slot", () => {
    const w = overlayWindow([day(3), day(21), day(7)], NOW);
    expect(w.toMs).toBe(Date.parse(day(21)) + OVERLAY_HEADROOM_MS);
  });

  it("covers a 120-day horizon, which the old 90-day constant did not", () => {
    // An owner with horizon_days: 120 publishes slots on days 91-120. Parsed
    // over a fixed 90-day window they carry no busy time at all, so the page
    // told the booker they were free when they were not.
    const w = overlayWindow([day(118)], NOW);
    expect(w.toMs).toBeGreaterThan(NOW + 90 * 86_400_000);
    expect(w.toMs).toBeGreaterThan(Date.parse(day(118)));
  });

  it("falls back to the largest horizon the config allows when no slots are known yet", () => {
    expect(overlayWindow([], NOW).toMs).toBe(NOW + OVERLAY_MAX_SPAN_MS);
  });

  it("never runs past the largest horizon, whatever the slot list says", () => {
    expect(overlayWindow([day(9000)], NOW).toMs).toBe(NOW + OVERLAY_MAX_SPAN_MS);
  });

  it("ignores unparseable entries rather than producing NaN bounds", () => {
    const w = overlayWindow(["not-a-date", day(5)], NOW);
    expect(Number.isFinite(w.toMs)).toBe(true);
    expect(w.toMs).toBe(Date.parse(day(5)) + OVERLAY_HEADROOM_MS);
  });

  it("reports a day-100 event as busy against a day-100 slot", () => {
    // End to end: the whole point of deriving the window. Under the old
    // hardcoded 90 days this clash was invisible and the slot showed a full
    // set of dots.
    const start = new Date(NOW + 100 * 86_400_000);
    const startIso = start.toISOString();
    const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const text = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT",
      `DTSTART:${stamp(start)}`,
      `DTEND:${stamp(new Date(start.getTime() + 30 * 60_000))}`,
      "END:VEVENT", "END:VCALENDAR",
    ].join("\r\n");

    const busy = parseIcsBusy(text, overlayWindow([startIso], NOW));
    expect(busy).toHaveLength(1);
    expect((filterSlots([startIso], 30, busy) as Marked[])[0]!.clashes).toBe(true);

    // ...and the old window is what made it invisible.
    const stale = parseIcsBusy(text, { fromMs: NOW, toMs: NOW + 90 * 86_400_000 });
    expect(stale).toHaveLength(0);
  });
});

describe("confirmNeedsRebuild", () => {
  // The confirm form holds what the booker has typed AND a solved Turnstile
  // challenge. An overlay load, a timezone switch and a phone rotation all
  // re-render, and rebuilding on any of them throws both away.
  it("does not rebuild while the same slot stays selected", () => {
    expect(confirmNeedsRebuild("2026-08-03T00:00:00.000Z", "2026-08-03T00:00:00.000Z")).toBe(false);
  });

  it("rebuilds when the booker picks a different slot", () => {
    expect(confirmNeedsRebuild("2026-08-03T00:00:00.000Z", "2026-08-03T00:30:00.000Z")).toBe(true);
  });

  it("rebuilds when a slot is selected for the first time", () => {
    expect(confirmNeedsRebuild(null, "2026-08-03T00:00:00.000Z")).toBe(true);
  });

  it("rebuilds (to empty) when the selection is cleared", () => {
    expect(confirmNeedsRebuild("2026-08-03T00:00:00.000Z", null)).toBe(true);
  });

  it("leaves the pane alone when nothing is selected and nothing was", () => {
    // This is what lets a "that time was just taken" message survive a resize.
    expect(confirmNeedsRebuild(null, null)).toBe(false);
  });
});

describe("confirmWhenText", () => {
  const ISO = "2026-08-03T00:00:00.000Z";

  it("names the duration and the zone the times are read in", () => {
    const text = confirmWhenText(ISO, 45, "Australia/Sydney");
    expect(text).toContain("45 min");
    expect(text).toContain("Australia/Sydney");
  });

  it("follows the selected zone, so it can be refreshed without a rebuild", () => {
    expect(confirmWhenText(ISO, 30, "Australia/Sydney")).not.toBe(confirmWhenText(ISO, 30, "UTC"));
  });
});

describe("onTurnstileReady", () => {
  it("runs immediately when api.js has already executed", () => {
    let ran = 0;
    onTurnstileReady({ turnstile: { render: () => "w" } }, () => { ran += 1; });
    expect(ran).toBe(1);
  });

  it("waits for the onload callback when api.js has not arrived yet", () => {
    // The race the guard used to lose: a booker on a slow connection selects a
    // slot before the challenge script executes, and nothing ever retries.
    const w: any = {};
    let ran = 0;
    onTurnstileReady(w, () => { ran += 1; });
    expect(ran).toBe(0);
    expect(typeof w[TURNSTILE_READY_CALLBACK]).toBe("function");

    w.turnstile = { render: () => "w" };
    w[TURNSTILE_READY_CALLBACK]();
    expect(ran).toBe(1);
  });

  it("chains rather than clobbering an already-registered callback", () => {
    const w: any = {};
    const order: string[] = [];
    onTurnstileReady(w, () => order.push("first"));
    onTurnstileReady(w, () => order.push("second"));
    w[TURNSTILE_READY_CALLBACK]();
    expect(order).toEqual(["first", "second"]);
  });

  it("does not run a callback twice when the API arrives after registration", () => {
    const w: any = {};
    let ran = 0;
    onTurnstileReady(w, () => { ran += 1; });
    w.turnstile = { render: () => "w" };
    w[TURNSTILE_READY_CALLBACK]();
    w[TURNSTILE_READY_CALLBACK]();
    expect(ran).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Code-review bug fixes: Turnstile single-use tokens must be reset after any
// failed claim, both fetches need to survive a network failure, and the
// browser's own zone must never drop out of the tz dropdown.
// ---------------------------------------------------------------------------

describe("resetTurnstile (bug 1 — reset after a failed claim)", () => {
  // Turnstile siteverify tokens are single-use and the server verifies
  // BEFORE the failure paths, so every claim response other than 201 has
  // already consumed the solved token. Without a reset, every retry
  // resubmits the dead token and 403s again.
  it("resets the widget when the API and a widget id are both present", () => {
    let resetWith: unknown;
    const w = { turnstile: { reset: (id: unknown) => { resetWith = id; } } };
    expect(resetTurnstile(w, "widget-1")).toBe(true);
    expect(resetWith).toBe("widget-1");
  });

  it("does nothing when there is no widget id yet", () => {
    const w = { turnstile: { reset: () => { throw new Error("should not be called"); } } };
    expect(resetTurnstile(w, null)).toBe(false);
  });

  it("does nothing when the Turnstile API has not loaded", () => {
    expect(resetTurnstile({}, "widget-1")).toBe(false);
  });

  it("swallows a throw from reset rather than propagating it", () => {
    const w = { turnstile: { reset: () => { throw new Error("boom"); } } };
    expect(resetTurnstile(w, "widget-1")).toBe(false);
  });
});

describe("claimOutcome (bug 1 + bug 2 — failed/errored claim decisions)", () => {
  it("books on 201, without asking for a Turnstile reset", () => {
    expect(claimOutcome({ status: 201, body: {} })).toEqual({ kind: "booked" });
  });

  it("treats 409 as a conflict carrying the fresh slot list, no reset", () => {
    expect(claimOutcome({ status: 409, body: { slots: ["a"] } })).toEqual({
      kind: "conflict",
      slots: ["a"],
      message: "That time was just taken. Please choose another.",
    });
  });

  it("resets Turnstile on a 403 (token consumed by the failed verify)", () => {
    expect(claimOutcome({ status: 403, body: {} })).toEqual({
      kind: "error",
      message: "Please complete the verification and try again.",
      resetTurnstile: true,
    });
  });

  it("resets Turnstile on any other non-2xx status (e.g. 429/500)", () => {
    expect(claimOutcome({ status: 500, body: {} })).toEqual({
      kind: "error",
      message: "Something went wrong. Please try again.",
      resetTurnstile: true,
    });
  });

  it("treats a network failure as an error too, also resetting Turnstile", () => {
    // The submit handler now wraps fetch in try/catch; a rejected fetch (no
    // status at all) must not be treated as success or leave the button
    // disabled forever.
    expect(claimOutcome({ networkError: true })).toEqual({
      kind: "error",
      message: "Could not reach the server. Please try again.",
      resetTurnstile: true,
    });
  });
});

describe("claimOutcome — paged conflicts", () => {
  it("carries the 409's page window through, so the handler can splice rather than replace", () => {
    const window = { start: "2026-08-15T00:00:00.000Z", end: "2026-08-29T00:00:00.000Z" };
    const d = claimOutcome({ status: 409, body: { error: "slot_unavailable", slots: ["x"], page: 1, window } });
    expect(d.kind).toBe("conflict");
    expect(d.slots).toEqual(["x"]);
    expect(d.window).toEqual(window);
  });

  it("has no window when the 409 carries none — the whole entry is then replaced or dropped", () => {
    const d = claimOutcome({ status: 409, body: { error: "slot_unavailable" } });
    expect(d.kind).toBe("conflict");
    expect(d.slots).toBeUndefined();
    expect(d.window).toBeUndefined();
  });
});

describe("tzSelectZones (bug 3 — browser zone must not vanish)", () => {
  it("keeps the browser zone even after switching viewTz away from it", () => {
    // Regression: rebuilding the <select> from [viewTz, tz] alone drops the
    // browser's own zone once viewTz has moved to the owner's zone, with no
    // way back short of reloading the page.
    expect(tzSelectZones("America/New_York", "Australia/Sydney", "Australia/Sydney")).toEqual([
      "America/New_York",
      "Australia/Sydney",
    ]);
  });

  it("keeps all three zones distinct when browser, owner and view differ", () => {
    expect(tzSelectZones("America/New_York", "Australia/Sydney", "Europe/London")).toEqual([
      "America/New_York",
      "Australia/Sydney",
      "Europe/London",
    ]);
  });

  it("dedupes when the browser zone is the one currently selected", () => {
    expect(tzSelectZones("Australia/Sydney", "Australia/Sydney", "Australia/Sydney")).toEqual([
      "Australia/Sydney",
    ]);
  });

  it("drops a zone Intl does not recognise", () => {
    expect(tzSelectZones("America/New_York", "Not/AZone", "America/New_York")).toEqual([
      "America/New_York",
    ]);
  });
});

describe("locationFieldFor", () => {
  it("asks for a number on phone", () => {
    expect(locationFieldFor("phone")).toEqual({
      needed: true,
      label: "Your phone number",
      type: "tel",
      placeholder: "",
    });
  });

  it("asks where to meet in person, and accepts TBC", () => {
    const f = locationFieldFor("in_person");
    expect(f.needed).toBe(true);
    expect(f.label).toBe("Where should we meet?");
    expect(f.type).toBe("text");
    expect(f.placeholder).toBe("TBC");
  });

  it("asks for nothing on meet or custom", () => {
    expect(locationFieldFor("meet").needed).toBe(false);
    expect(locationFieldFor("custom").needed).toBe(false);
  });
});

describe("locationPayload", () => {
  it("sends null rather than an empty string when nothing is collected", () => {
    expect(locationPayload("meet", "")).toEqual({
      location_kind: "meet",
      location_detail: null,
    });
  });

  it("trims what the booker typed", () => {
    expect(locationPayload("phone", "  +61 400 000 000  ")).toEqual({
      location_kind: "phone",
      location_detail: "+61 400 000 000",
    });
  });

  it("treats whitespace-only input the same as empty — nothing collected", () => {
    expect(locationPayload("in_person", "   ")).toEqual({
      location_kind: "in_person",
      location_detail: null,
    });
  });
});

describe("overlay ceiling vs the published reach", () => {
  // OVERLAY_MAX_SPAN_MS is hand-tied to the furthest day the config can put a
  // slot on — `max_horizon_days`' maximum, now that a booker can page past
  // `horizon_days`. Raise that maximum without raising the ceiling and the
  // overlay silently stops covering the tail of the reach — slots there would
  // clash with nothing and a booker who uploaded their calendar would be told
  // they are free when they are not. That is the one direction this file must
  // never take, and the coupling is otherwise only a comment, so assert it.
  it("covers the furthest reach the API will accept, with headroom", () => {
    const props = (published as any).paths["/v1/booking-page"].get
      .responses["200"].content["application/json"].schema.properties;
    const reachDays = props.max_horizon_days.maximum;
    expect(reachDays).toBeTypeOf("number");
    expect(reachDays).toBeGreaterThanOrEqual(props.horizon_days.maximum);
    expect(OVERLAY_MAX_SPAN_MS).toBeGreaterThanOrEqual(
      reachDays * 86_400_000 + OVERLAY_HEADROOM_MS,
    );
  });
});

// ---------------------------------------------------------------------------
// Month indicator. With max_horizon_days the strip can span several months,
// and a scrolled strip of bare day numbers ("29 30 1 2 5 6") gives no clue
// which month they belong to. Each month gets its own group with a label.
// ---------------------------------------------------------------------------

describe("stripMonths", () => {
  it("groups the strip's days by calendar month, in order", () => {
    const days = ["2026-09-28", "2026-09-29", "2026-10-01", "2026-10-02", "2026-11-30"];
    expect(stripMonths(days)).toEqual([
      { month: "2026-09", days: ["2026-09-28", "2026-09-29"] },
      { month: "2026-10", days: ["2026-10-01", "2026-10-02"] },
      { month: "2026-11", days: ["2026-11-30"] },
    ]);
  });

  it("is empty for an empty strip", () => {
    expect(stripMonths([])).toEqual([]);
  });
});

describe("monthLabel", () => {
  it("names the month, adding the year only once it differs from the strip's first month", () => {
    // Locale pinned: the browser's is the right default for a booker, but the
    // runner's (en-AU says "Sept") must not decide the test.
    expect(monthLabel("2026-09", "2026-09", "en-US")).toBe("Sep");
    expect(monthLabel("2026-12", "2026-09", "en-US")).toBe("Dec");
    expect(monthLabel("2027-01", "2026-09", "en-US")).toBe("Jan 2027");
  });
});
