import { describe, it, expect } from "vitest";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";

describe("MockCalendarProvider", () => {
  it("returns events that fall inside the requested window", async () => {
    const p = new MockCalendarProvider({
      events: [
        {
          id: "e1",
          summary: "Inside",
          start: "2026-05-19T09:00:00Z",
          end: "2026-05-19T10:00:00Z",
          extendedProperties: {},
        },
        {
          id: "e2",
          summary: "Outside",
          start: "2026-06-01T09:00:00Z",
          end: "2026-06-01T10:00:00Z",
          extendedProperties: {},
        },
      ],
    });
    const r = await p.fetchEventsInWindow("2026-05-18T00:00:00Z", "2026-05-25T00:00:00Z");
    expect(r.events.map((e) => e.id)).toEqual(["e1"]);
    expect(r.nextSyncToken).toMatch(/^mock-/);
  });

  it("createEvent stamps the scheduler_chunk_id into extendedProperties.private", async () => {
    const p = new MockCalendarProvider();
    const r = await p.createEvent(
      {
        id: "",
        summary: "Deep work",
        start: "2026-05-19T09:00:00Z",
        end: "2026-05-19T10:30:00Z",
        extendedProperties: {},
      },
      { scheduler_chunk_id: "chunk-42" },
    );
    expect(r.eventId).toBeTruthy();
    expect(p.getCreated().at(-1)?.extendedProperties.private?.scheduler_chunk_id).toBe("chunk-42");
  });

  it("deleteEvent removes the event so subsequent fetches do not see it", async () => {
    const p = new MockCalendarProvider({
      events: [
        {
          id: "e1",
          summary: "x",
          start: "2026-05-19T09:00:00Z",
          end: "2026-05-19T10:00:00Z",
          extendedProperties: {},
        },
      ],
    });
    await p.deleteEvent("e1");
    const r = await p.fetchEventsInWindow("2026-05-18T00:00:00Z", "2026-05-25T00:00:00Z");
    expect(r.events).toEqual([]);
  });

  it("getEvent returns a seeded event by id, and null after deleteEvent", async () => {
    const p = new MockCalendarProvider({
      events: [
        {
          id: "e1",
          summary: "x",
          start: "2026-05-19T09:00:00Z",
          end: "2026-05-19T10:00:00Z",
          extendedProperties: {},
        },
      ],
    });
    await expect(p.getEvent("e1")).resolves.toMatchObject({ id: "e1", summary: "x" });
    await p.deleteEvent("e1");
    await expect(p.getEvent("e1")).resolves.toBeNull();
  });

  it("deleteEvent records eventId + opts in deleteOptions", async () => {
    const p = new MockCalendarProvider({
      events: [
        {
          id: "e1",
          summary: "x",
          start: "2026-05-19T09:00:00Z",
          end: "2026-05-19T10:00:00Z",
          extendedProperties: {},
        },
      ],
    });
    await p.deleteEvent("e1", { notifyAttendees: true });
    expect(p.deleteOptions).toEqual([{ eventId: "e1", opts: { notifyAttendees: true } }]);
  });
});
