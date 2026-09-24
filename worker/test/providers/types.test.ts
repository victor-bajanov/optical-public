import { describe, it, expect } from "vitest";
import { CalendarEventSchema, IncrementalResultSchema, OPTICAL_MEETING_TASK_ID_KEY } from "../../src/providers/types";

describe("CalendarEventSchema free/busy fields", () => {
  it("parses an event carrying status, eventType, and isAllDay", () => {
    const parsed = CalendarEventSchema.parse({
      id: "e1",
      summary: "OOO",
      start: "2026-06-03T00:00:00Z",
      end: "2026-06-04T00:00:00Z",
      status: "confirmed",
      eventType: "outOfOffice",
      isAllDay: true,
      extendedProperties: {},
    });
    expect(parsed.status).toBe("confirmed");
    expect(parsed.eventType).toBe("outOfOffice");
    expect(parsed.isAllDay).toBe(true);
  });

  it("still parses an event omitting the new fields (fields stay undefined)", () => {
    const parsed = CalendarEventSchema.parse({
      id: "e2",
      summary: "Meeting",
      start: "2026-06-03T01:00:00Z",
      end: "2026-06-03T02:00:00Z",
      extendedProperties: {},
    });
    expect(parsed.status).toBeUndefined();
    expect(parsed.eventType).toBeUndefined();
    expect(parsed.isAllDay).toBeUndefined();
  });
});

describe("CalendarEvent ownership/attendee fields", () => {
  it("parses organizer, guestsCanModify and attendees", () => {
    const e = CalendarEventSchema.parse({
      id: "evt1",
      summary: "Standup",
      start: "2026-05-19T09:00:00Z",
      end: "2026-05-19T09:30:00Z",
      organizer: { email: "me@example.com", self: true },
      guestsCanModify: false,
      attendees: [
        { email: "a@example.com", responseStatus: "accepted" },
        { email: "room1@example.com", responseStatus: "accepted", resource: true },
        { email: "me@example.com", self: true, responseStatus: "accepted" },
      ],
    });
    expect(e.organizer?.self).toBe(true);
    expect(e.attendees).toHaveLength(3);
    expect(e.attendees?.[1]?.resource).toBe(true);
  });

  it("still parses an event with none of the new fields (additive)", () => {
    const e = CalendarEventSchema.parse({
      id: "evt2",
      summary: "Lunch",
      start: "2026-05-19T12:00:00Z",
      end: "2026-05-19T13:00:00Z",
    });
    expect(e.organizer).toBeUndefined();
    expect(e.attendees).toBeUndefined();
  });

  it("exports the meeting-tag key", () => {
    expect(OPTICAL_MEETING_TASK_ID_KEY).toBe("optical_meeting_task_id");
  });
});

describe("provider types", () => {
  it("CalendarEventSchema accepts a minimal valid event", () => {
    const ok = CalendarEventSchema.safeParse({
      id: "evt-1",
      summary: "Meeting",
      start: "2026-05-19T09:00:00Z",
      end: "2026-05-19T10:00:00Z",
      extendedProperties: {},
    });
    expect(ok.success).toBe(true);
  });

  it("CalendarEventSchema rejects an event missing end", () => {
    const bad = CalendarEventSchema.safeParse({
      id: "evt-1",
      summary: "Meeting",
      start: "2026-05-19T09:00:00Z",
    });
    expect(bad.success).toBe(false);
  });

  it("IncrementalResultSchema accepts changes plus nextSyncToken", () => {
    const ok = IncrementalResultSchema.safeParse({
      changes: [
        {
          kind: "upsert",
          event: {
            id: "e",
            summary: "x",
            start: "2026-05-19T09:00:00Z",
            end: "2026-05-19T10:00:00Z",
            extendedProperties: {},
          },
        },
      ],
      nextSyncToken: "tok-2",
      syncTokenInvalidated: false,
    });
    expect(ok.success).toBe(true);
  });
});
