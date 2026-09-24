import { describe, it, expect } from "vitest";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import type { CalendarEvent } from "../../src/providers/types";

describe("createEvent options", () => {
  it("records attendees and the notify/meet options", async () => {
    const provider = new MockCalendarProvider();
    const event = {
      summary: "Meeting with Sam",
      start: "2026-08-03T00:00:00Z",
      end: "2026-08-03T00:30:00Z",
      attendees: [{ email: "sam@x.com" }],
    } as CalendarEvent;

    const { eventId } = await provider.createEvent(event, { optical_booking: "b1" }, {
      notifyAttendees: true,
      addMeet: true,
      conferenceRequestId: "b1",
    });

    const created = provider.getCreated().find((e) => e.id === eventId)!;
    expect(created.attendees).toEqual([{ email: "sam@x.com" }]);
    expect(created.extendedProperties?.private?.optical_booking).toBe("b1");
    expect(provider.createOptions.at(-1)).toEqual({
      notifyAttendees: true,
      addMeet: true,
      conferenceRequestId: "b1",
    });
  });

  it("records undefined options when the caller passes none", async () => {
    const provider = new MockCalendarProvider();
    await provider.createEvent(
      { summary: "Chunk", start: "2026-08-03T00:00:00Z", end: "2026-08-03T00:30:00Z" } as CalendarEvent,
      { scheduler_chunk_id: "c#0" },
    );
    expect(provider.createOptions).toEqual([undefined]);
  });
});
