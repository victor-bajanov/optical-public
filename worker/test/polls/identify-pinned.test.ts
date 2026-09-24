import { describe, it, expect } from "vitest";
import { isOwnedMovableMeeting } from "../../src/meetings/identify";
import type { CalendarEvent } from "../../src/providers/types";

function ownedMovableEvent(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "e1",
    summary: "1:1",
    start: "2026-08-19T00:00:00Z",
    end: "2026-08-19T00:30:00Z",
    organizer: { self: true },
    attendees: [
      { email: "a@x.com", responseStatus: "accepted" },
      { email: "me@x.com", self: true },
    ],
    extendedProperties: {},
    ...over,
  } as CalendarEvent;
}

describe("isOwnedMovableMeeting — poll-tagged pinning", () => {
  it("is true for an otherwise-owned-movable event with no poll tag (control)", () => {
    expect(isOwnedMovableMeeting(ownedMovableEvent())).toBe(true);
  });

  it("is false when extendedProperties.private.optical_poll_id is set, even though every other owned-movable condition holds", () => {
    const tagged = ownedMovableEvent({
      extendedProperties: { private: { optical_poll_id: "p_abc123" } },
    });
    expect(isOwnedMovableMeeting(tagged)).toBe(false);
  });

  it("stays false for a poll-tagged event regardless of the OWNED_MEETINGS_ENABLED flag — the flag only gates whether isOwnedMovableMeeting is consulted at all, and this proves the function itself never says true for a tagged event", () => {
    // isOwnedMovableMeeting takes no env/flag argument; this test documents the
    // contract that no caller-side flag can turn a poll-tagged event movable —
    // there is no flag branch to disable.
    const tagged = ownedMovableEvent({
      extendedProperties: { private: { optical_poll_id: "p_xyz" } },
    });
    expect(isOwnedMovableMeeting(tagged)).toBe(false);
  });
});
