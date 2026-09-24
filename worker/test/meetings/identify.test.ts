import { describe, it, expect } from "vitest";
import {
  isOwnedMovableMeeting,
  attendeeCountForChurn,
  constrainingAttendeeEmails,
  MEETING_SOURCE_KIND,
} from "../../src/meetings/identify";
import type { CalendarEvent } from "../../src/providers/types";

function evt(over: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: "e1",
    summary: "M",
    start: "2026-05-19T09:00:00Z",
    end: "2026-05-19T09:30:00Z",
    extendedProperties: {},
    ...over,
  } as CalendarEvent;
}

describe("isOwnedMovableMeeting", () => {
  it("true when organizer.self and >=1 non-resource non-self attendee", () => {
    expect(
      isOwnedMovableMeeting(
        evt({
          organizer: { self: true },
          attendees: [
            { email: "a@x.com", responseStatus: "accepted" },
            { email: "me@x.com", self: true },
          ],
        }),
      ),
    ).toBe(true);
  });
  it("false when not organizer", () => {
    expect(isOwnedMovableMeeting(evt({ organizer: { self: false }, attendees: [{ email: "a@x.com" }] }))).toBe(false);
  });
  it("false when only resources/self attend", () => {
    expect(
      isOwnedMovableMeeting(
        evt({
          organizer: { self: true },
          attendees: [
            { email: "room@x.com", resource: true },
            { email: "me@x.com", self: true },
          ],
        }),
      ),
    ).toBe(false);
  });
});

describe("attendeeCountForChurn", () => {
  it("counts non-resource, non-declined, non-organiser; includes optional; floor 1; capped", () => {
    const e = evt({
      organizer: { self: true, email: "me@x.com" },
      attendees: [
        { email: "a@x.com", responseStatus: "accepted" },
        { email: "b@x.com", responseStatus: "tentative", optional: true },
        { email: "c@x.com", responseStatus: "declined" },
        { email: "room@x.com", responseStatus: "accepted", resource: true },
        { email: "me@x.com", self: true, responseStatus: "accepted" },
      ],
    });
    expect(attendeeCountForChurn(e, 20)).toBe(2); // a + b
  });
  it("floors at 1 when no countable attendees", () => {
    const e = evt({ organizer: { self: true }, attendees: [{ email: "room@x.com", resource: true }] });
    expect(attendeeCountForChurn(e, 20)).toBe(1);
  });
  it("caps the count", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ email: `u${i}@x.com`, responseStatus: "accepted" as const }));
    expect(attendeeCountForChurn(evt({ organizer: { self: true }, attendees: many }), 20)).toBe(20);
  });
});

it("exports the source-kind marker", () => {
  expect(MEETING_SOURCE_KIND).toBe("meeting");
});

function mixedEvent(): CalendarEvent {
  return {
    id: "e", summary: "m", start: "2026-05-20T03:00:00Z", end: "2026-05-20T03:30:00Z",
    attendees: [
      { email: "self@x", self: true, responseStatus: "accepted" },
      { email: "acc@x", responseStatus: "accepted" },
      { email: "tent@x", responseStatus: "tentative" },
      { email: "need@x", responseStatus: "needsAction" },
      { email: "dec@x", responseStatus: "declined" },
      { email: "room@x", resource: true, responseStatus: "accepted" },
    ],
  } as CalendarEvent;
}

describe("constrainingAttendeeEmails", () => {
  it("'accepted' → only accepted, never self/resource/declined", () => {
    expect(constrainingAttendeeEmails(mixedEvent(), "accepted")).toEqual(["acc@x"]);
  });
  it("'accepted_or_tentative' → accepted + tentative", () => {
    expect(constrainingAttendeeEmails(mixedEvent(), "accepted_or_tentative").sort()).toEqual(["acc@x", "tent@x"]);
  });
  it("'not_declined' → accepted + tentative + needsAction; never declined/resource/self", () => {
    expect(constrainingAttendeeEmails(mixedEvent(), "not_declined").sort()).toEqual(["acc@x", "need@x", "tent@x"]);
  });
});
