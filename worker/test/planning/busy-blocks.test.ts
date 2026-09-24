import { describe, it, expect } from "vitest";
import { deriveBusyBlocks } from "../../src/planning/busy-blocks";
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
});
