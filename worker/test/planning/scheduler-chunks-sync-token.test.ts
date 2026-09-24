import { describe, it, expect, vi } from "vitest";
import { schedulerChunkEventsForTask } from "../../src/planning/scheduler-chunks";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";

// Contract 2 (internal design notes): fetchEventsInWindow(start,
// end, opts?: { syncToken?: boolean }). Every caller that discards
// nextSyncToken must pass { syncToken: false } so Microsoft can use a plain
// bounded /me/calendarView read instead of paying for a /delta call whose
// token is thrown away. schedulerChunkEventsForTask is one of the seven
// token-less callers (planning/scheduler-chunks.ts:25) — representative of
// the other six (booking/availability.ts, polls/booking.ts, polls/route.ts,
// handlers/polls.ts, calendar-feed/feed-route.ts, lifecycle/offboard.ts),
// which all follow the same one-line fix.
describe("schedulerChunkEventsForTask forwards { syncToken: false }", () => {
  it("passes { syncToken: false } as the third fetchEventsInWindow argument", async () => {
    const cal = new MockCalendarProvider();
    const spy = vi.spyOn(cal, "fetchEventsInWindow");

    await schedulerChunkEventsForTask(cal, "task-1", "2026-01-01T00:00:00Z", "2026-01-08T00:00:00Z");

    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]).toEqual([
      "2026-01-01T00:00:00Z",
      "2026-01-08T00:00:00Z",
      { syncToken: false },
    ]);
  });
});
