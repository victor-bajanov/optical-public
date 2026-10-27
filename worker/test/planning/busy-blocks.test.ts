import { describe, it, expect } from "vitest";
import { allDayFloatingDate, deriveBusyBlocks, eventBucketInstant } from "../../src/planning/busy-blocks";
import { SCHEDULER_CHUNK_ID_KEY } from "../../src/providers/types";
import type { CalendarEvent } from "../../src/providers/types";

const TZ = "Australia/Sydney";

function ev(over: Partial<CalendarEvent> & { id: string }): CalendarEvent {
  return {
    summary: "busy thing",
    start: "2026-08-04T00:00:00Z",
    end: "2026-08-04T01:00:00Z",
    ...over,
  } as CalendarEvent;
}

describe("deriveBusyBlocks", () => {
  it("drops optical chunks, cancelled events, and excluded ids", () => {
    const blocks = deriveBusyBlocks(
      [
        ev({ id: "chunk", extendedProperties: { private: { [SCHEDULER_CHUNK_ID_KEY]: "t1#0" } } }),
        ev({ id: "cancelled", status: "cancelled" }),
        ev({ id: "excluded" }),
        ev({ id: "keep" }),
      ],
      { tz: TZ, tentativeIsBusy: false, excludeEventIds: new Set(["excluded"]) },
    );
    expect(blocks.map((b) => b.id)).toEqual(["keep"]);
  });

  it("drops tentative events unless tentativeIsBusy", () => {
    const events = [ev({ id: "maybe", status: "tentative" })];
    const opts = { tz: TZ, excludeEventIds: new Set<string>() };
    expect(deriveBusyBlocks(events, { ...opts, tentativeIsBusy: false })).toEqual([]);
    expect(deriveBusyBlocks(events, { ...opts, tentativeIsBusy: true })).toHaveLength(1);
  });

  it("expands an all-day event to whole local days, not shifted UTC days", () => {
    // Google coerces the exclusive end.date to UTC midnight; in +10 that instant
    // is 10am local, so a naive read yields a two-day block. The whole-local-day
    // block for a start.date=2026-08-04/end.date=2026-08-05 (exclusive) all-day
    // event is local 2026-08-04 00:00 -> 2026-08-05 00:00, i.e. UTC 2026-08-03
    // 14:00 -> 2026-08-04 14:00 (verified against build-problem.test.ts's
    // "expands an all-day busy event" case).
    const blocks = deriveBusyBlocks(
      [ev({ id: "leave", isAllDay: true, start: "2026-08-04T00:00:00Z", end: "2026-08-05T00:00:00Z" })],
      { tz: TZ, tentativeIsBusy: false, excludeEventIds: new Set() },
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.startUtc).toBe("2026-08-03T14:00:00.000Z"); // 2026-08-04 00:00 +10
    expect(blocks[0]!.endUtc).toBe("2026-08-04T14:00:00.000Z"); // 2026-08-05 00:00 +10
  });

  it("merges overlapping blocks", () => {
    const blocks = deriveBusyBlocks(
      [
        ev({ id: "a", start: "2026-08-04T00:00:00Z", end: "2026-08-04T02:00:00Z" }),
        ev({ id: "b", start: "2026-08-04T01:00:00Z", end: "2026-08-04T03:00:00Z" }),
      ],
      { tz: TZ, tentativeIsBusy: false, excludeEventIds: new Set() },
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.endUtc).toBe("2026-08-04T03:00:00.000Z");
  });
  it("blocks a floating all-day date as that LOCAL day west of UTC, not the day before", () => {
    // UTC midnight of 2026-08-04 is the evening of 08-03 in Los Angeles; the
    // provider string carries the floating date, so the block is local 08-04.
    const blocks = deriveBusyBlocks(
      [ev({ id: "leave", isAllDay: true, start: "2026-08-04T00:00:00Z", end: "2026-08-05T00:00:00Z" })],
      { tz: "America/Los_Angeles", tentativeIsBusy: false, excludeEventIds: new Set() },
    );
    expect(blocks.map((b) => [b.startUtc, b.endUtc])).toEqual([
      ["2026-08-04T07:00:00.000Z", "2026-08-05T07:00:00.000Z"],
    ]);
  });

  it("keeps localising an all-day event whose start is a converted instant, not UTC midnight", () => {
    // A provider that sent the all-day start already converted to an instant
    // (2026-05-19 00:00 Sydney = 2026-05-18T14:00Z) still blocks local 05-19.
    const blocks = deriveBusyBlocks(
      [ev({ id: "leave", isAllDay: true, start: "2026-05-18T14:00:00.000Z", end: "2026-05-19T14:00:00.000Z" })],
      { tz: TZ, tentativeIsBusy: false, excludeEventIds: new Set() },
    );
    expect(blocks.map((b) => [b.startUtc, b.endUtc])).toEqual([
      ["2026-05-18T14:00:00.000Z", "2026-05-19T14:00:00.000Z"],
    ]);
  });
});

describe("allDayFloatingDate", () => {
  it("reads the floating date off a UTC-midnight string, with or without millis", () => {
    expect(allDayFloatingDate("2026-08-04T00:00:00Z")).toBe("2026-08-04");
    expect(allDayFloatingDate("2026-08-04T00:00:00.000Z")).toBe("2026-08-04");
  });

  it("returns null for anything that is not UTC midnight", () => {
    expect(allDayFloatingDate("2026-05-18T14:00:00.000Z")).toBeNull();
    expect(allDayFloatingDate("2026-08-04T00:00:00+10:00")).toBeNull();
    expect(allDayFloatingDate("2026-08-04")).toBeNull();
  });
});

describe("eventBucketInstant", () => {
  it("buckets a floating all-day event at local noon of its date", () => {
    const e = ev({ id: "a", isAllDay: true, start: "2026-07-13T00:00:00Z", end: "2026-07-14T00:00:00Z" });
    expect(eventBucketInstant(e, "America/Los_Angeles")).toBe("2026-07-13T19:00:00.000Z");
    expect(eventBucketInstant(e, TZ)).toBe("2026-07-13T02:00:00.000Z");
  });

  it("leaves a timed event, and an all-day event with a converted start, at its start", () => {
    expect(eventBucketInstant(ev({ id: "t" }), TZ)).toBe("2026-08-04T00:00:00Z");
    const conv = ev({ id: "c", isAllDay: true, start: "2026-05-18T14:00:00.000Z", end: "2026-05-19T14:00:00.000Z" });
    expect(eventBucketInstant(conv, TZ)).toBe("2026-05-18T14:00:00.000Z");
  });
});
