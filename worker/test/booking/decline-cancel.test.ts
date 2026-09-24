import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { claimSlot, confirmBooking, markCancelPending } from "../../src/db/bookings";
import { detectBookingDeclines, isAllDeclined } from "../../src/booking/decline-cancel";
import type { CalendarEvent } from "../../src/providers/types";

const OWNER = "decline-detect-owner@org";

function req(over: Partial<Parameters<typeof claimSlot>[1]> = {}) {
  return {
    ownerSubject: OWNER,
    slug: "victor",
    startUtc: "2026-08-04T00:00:00Z",
    endUtc: "2026-08-04T00:30:00Z",
    durationMinutes: 30,
    bookerName: "Sam",
    bookerEmail: "sam@x.com",
    bookerNote: null,
    ipHash: "iphash",
    guardStartUtc: "2026-08-04T00:00:00Z",
    guardEndUtc: "2026-08-04T00:40:00Z",
    now: new Date("2026-08-01T00:00:00Z"),
    locationKind: "meet",
    locationDetail: null,
    ...over,
  };
}

async function confirmedBooking(
  eventId: string,
  over: Partial<Parameters<typeof claimSlot>[1]> = {},
): Promise<string> {
  const claim = await claimSlot(env.DB, req(over));
  if (!claim) throw new Error(`claimSlot returned null for ${eventId} — slot override probably overlaps another test fixture`);
  await confirmBooking(env.DB, claim.id, eventId, new Date("2026-08-01T00:01:00Z"));
  return claim.id;
}

async function stampOf(id: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT cancel_pending_at FROM bookings WHERE id = ?")
    .bind(id)
    .first<{ cancel_pending_at: string | null }>();
  return row?.cancel_pending_at ?? null;
}

// Well before every fixture's start_utc below, so "hasn't started yet" holds
// unless a test deliberately puts the event's start before it.
const NOW = new Date("2026-08-02T00:00:00Z");
// db/bookings.ts's canonicalIso drops the ".000Z" millisecond suffix that
// Date#toISOString() emits, so stamp assertions compare against this
// already-canonical literal, not NOW.toISOString() itself.
const NOW_ISO = "2026-08-02T00:00:00Z";

function bookingEvent(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "gcal-decline-detect-default",
    summary: "Booked meeting",
    start: "2026-08-04T00:00:00Z",
    end: "2026-08-04T00:30:00Z",
    attendees: [{ email: "sam@x.com", responseStatus: "declined" }],
    extendedProperties: {},
    ...over,
  };
}

describe("detectBookingDeclines", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM bookings WHERE owner_subject = ?").bind(OWNER).run();
  });

  // Test 1
  it("stamps cancel_pending_at: tagged, single non-self attendee declined, start in future, matching confirmed row", async () => {
    const id = await confirmedBooking("gcal-detect-1");
    const event = bookingEvent({ id: "gcal-detect-1", extendedProperties: { private: { optical_booking: id } } });
    await detectBookingDeclines(env.DB, OWNER, [event], NOW);
    expect(await stampOf(id)).toBe(NOW_ISO);
  });

  // Test 2
  it("does not stamp an untagged event with the identical 1:1 shape (non-booking-page events are never touched)", async () => {
    const id = await confirmedBooking("gcal-detect-2", {
      startUtc: "2026-08-05T00:00:00Z", endUtc: "2026-08-05T00:30:00Z",
      guardStartUtc: "2026-08-05T00:00:00Z", guardEndUtc: "2026-08-05T00:40:00Z",
    });
    const event = bookingEvent({ id: "gcal-detect-2", start: "2026-08-05T00:00:00Z", end: "2026-08-05T00:30:00Z", extendedProperties: {} });
    await detectBookingDeclines(env.DB, OWNER, [event], NOW);
    expect(await stampOf(id)).toBeNull();
  });

  it("does not stamp an optical_poll_id-tagged event", async () => {
    const id = await confirmedBooking("gcal-detect-2b", {
      startUtc: "2026-08-06T00:00:00Z", endUtc: "2026-08-06T00:30:00Z",
      guardStartUtc: "2026-08-06T00:00:00Z", guardEndUtc: "2026-08-06T00:40:00Z",
    });
    const event = bookingEvent({
      id: "gcal-detect-2b", start: "2026-08-06T00:00:00Z", end: "2026-08-06T00:30:00Z",
      extendedProperties: { private: { optical_poll_id: "poll-xyz" } },
    });
    await detectBookingDeclines(env.DB, OWNER, [event], NOW);
    expect(await stampOf(id)).toBeNull();
  });

  it("does not stamp an event carrying BOTH optical_booking and optical_poll_id (poll guard wins even with a real matching booking id)", async () => {
    // Distinct from the previous test: this event's optical_booking value is
    // a REAL confirmed row's id, and the row otherwise matches perfectly
    // (event id, future start, all-declined). Only the optical_poll_id guard
    // stops the stamp — deleting that guard would leave this test the only
    // thing catching the regression.
    const id = await confirmedBooking("gcal-detect-2c", {
      startUtc: "2026-08-06T12:00:00Z", endUtc: "2026-08-06T12:30:00Z",
      guardStartUtc: "2026-08-06T12:00:00Z", guardEndUtc: "2026-08-06T12:40:00Z",
    });
    const event = bookingEvent({
      id: "gcal-detect-2c", start: "2026-08-06T12:00:00Z", end: "2026-08-06T12:30:00Z",
      extendedProperties: { private: { optical_booking: id, optical_poll_id: "poll-xyz" } },
    });
    await detectBookingDeclines(env.DB, OWNER, [event], NOW);
    expect(await stampOf(id)).toBeNull();
  });

  it("does not stamp when the event's start is unparseable (fails closed, not open)", async () => {
    // Date.parse("") is NaN, and NaN <= anything is false — a naive
    // `Date.parse(event.start) <= now.getTime()` guard would let this THROUGH
    // as "not yet started" and stamp it. It must instead be treated as
    // unverifiable and refused.
    const id = await confirmedBooking("gcal-detect-2d", {
      startUtc: "2026-08-06T18:00:00Z", endUtc: "2026-08-06T18:30:00Z",
      guardStartUtc: "2026-08-06T18:00:00Z", guardEndUtc: "2026-08-06T18:40:00Z",
    });
    const event = bookingEvent({
      id: "gcal-detect-2d", start: "", end: "",
      extendedProperties: { private: { optical_booking: id } },
    });
    await detectBookingDeclines(env.DB, OWNER, [event], NOW);
    expect(await stampOf(id)).toBeNull();
  });

  // Test 3
  it("does not stamp when the event's start is already in the past", async () => {
    const id = await confirmedBooking("gcal-detect-3", {
      startUtc: "2026-08-07T00:00:00Z", endUtc: "2026-08-07T00:30:00Z",
      guardStartUtc: "2026-08-07T00:00:00Z", guardEndUtc: "2026-08-07T00:40:00Z",
    });
    const event = bookingEvent({
      id: "gcal-detect-3", start: "2026-08-01T00:00:00Z", end: "2026-08-01T00:30:00Z", // before NOW
      extendedProperties: { private: { optical_booking: id } },
    });
    await detectBookingDeclines(env.DB, OWNER, [event], NOW);
    expect(await stampOf(id)).toBeNull();
  });

  // Test 4
  it("does not stamp when the booking row is not status='confirmed'", async () => {
    const claim = await claimSlot(env.DB, req({
      startUtc: "2026-08-08T00:00:00Z", endUtc: "2026-08-08T00:30:00Z",
      guardStartUtc: "2026-08-08T00:00:00Z", guardEndUtc: "2026-08-08T00:40:00Z",
    }));
    // still 'reserving', never confirmed
    const event = bookingEvent({
      id: "gcal-detect-4", start: "2026-08-08T00:00:00Z", end: "2026-08-08T00:30:00Z",
      extendedProperties: { private: { optical_booking: claim!.id } },
    });
    await detectBookingDeclines(env.DB, OWNER, [event], NOW);
    expect(await stampOf(claim!.id)).toBeNull();
  });

  it("does not stamp when the event id doesn't match the booking's google_event_id", async () => {
    const id = await confirmedBooking("gcal-detect-5-real", {
      startUtc: "2026-08-09T00:00:00Z", endUtc: "2026-08-09T00:30:00Z",
      guardStartUtc: "2026-08-09T00:00:00Z", guardEndUtc: "2026-08-09T00:40:00Z",
    });
    const event = bookingEvent({
      id: "gcal-detect-5-wrong", start: "2026-08-09T00:00:00Z", end: "2026-08-09T00:30:00Z",
      extendedProperties: { private: { optical_booking: id } },
    });
    await detectBookingDeclines(env.DB, OWNER, [event], NOW);
    expect(await stampOf(id)).toBeNull();
  });

  it("does not stamp a poll-booked row", async () => {
    const claim = await claimSlot(env.DB, req({
      startUtc: "2026-08-10T00:00:00Z", endUtc: "2026-08-10T00:30:00Z",
      guardStartUtc: "2026-08-10T00:00:00Z", guardEndUtc: "2026-08-10T00:40:00Z",
      pollId: "poll-detect-1",
    }));
    await confirmBooking(env.DB, claim!.id, "gcal-detect-6", new Date("2026-08-01T00:01:00Z"));
    const event = bookingEvent({
      id: "gcal-detect-6", start: "2026-08-10T00:00:00Z", end: "2026-08-10T00:30:00Z",
      extendedProperties: { private: { optical_booking: claim!.id } },
    });
    await detectBookingDeclines(env.DB, OWNER, [event], NOW);
    expect(await stampOf(claim!.id)).toBeNull();
  });

  // Test 5
  it("does not reset an existing stamp on a repeat webhook delivery of the same declined event", async () => {
    const id = await confirmedBooking("gcal-detect-7", {
      startUtc: "2026-08-11T00:00:00Z", endUtc: "2026-08-11T00:30:00Z",
      guardStartUtc: "2026-08-11T00:00:00Z", guardEndUtc: "2026-08-11T00:40:00Z",
    });
    const event = bookingEvent({
      id: "gcal-detect-7", start: "2026-08-11T00:00:00Z", end: "2026-08-11T00:30:00Z",
      extendedProperties: { private: { optical_booking: id } },
    });
    await detectBookingDeclines(env.DB, OWNER, [event], NOW);
    expect(await stampOf(id)).toBe(NOW_ISO);

    const later = new Date("2026-08-02T00:05:00Z");
    await detectBookingDeclines(env.DB, OWNER, [event], later);
    expect(await stampOf(id)).toBe(NOW_ISO);
  });

  // Test 6
  it("clears an existing stamp when the attendee is back to accepted/needsAction/tentative", async () => {
    const id = await confirmedBooking("gcal-detect-8", {
      startUtc: "2026-08-12T00:00:00Z", endUtc: "2026-08-12T00:30:00Z",
      guardStartUtc: "2026-08-12T00:00:00Z", guardEndUtc: "2026-08-12T00:40:00Z",
    });
    await markCancelPending(env.DB, id, OWNER, "gcal-detect-8", NOW.toISOString());
    expect(await stampOf(id)).toBe(NOW_ISO);

    for (const responseStatus of ["accepted", "needsAction", "tentative"] as const) {
      const event = bookingEvent({
        id: "gcal-detect-8", start: "2026-08-12T00:00:00Z", end: "2026-08-12T00:30:00Z",
        attendees: [{ email: "sam@x.com", responseStatus }],
        extendedProperties: { private: { optical_booking: id } },
      });
      // Re-stamp between iterations so each responseStatus is independently
      // proven to clear it (not just carried-over emptiness from a prior one).
      await markCancelPending(env.DB, id, OWNER, "gcal-detect-8", NOW.toISOString());
      await detectBookingDeclines(env.DB, OWNER, [event], new Date("2026-08-02T00:10:00Z"));
      expect(await stampOf(id)).toBeNull();
    }
  });

  // Test 7
  it("ignores a status:'cancelled' event entirely: no stamp on a fresh decline", async () => {
    const id = await confirmedBooking("gcal-detect-9", {
      startUtc: "2026-08-13T00:00:00Z", endUtc: "2026-08-13T00:30:00Z",
      guardStartUtc: "2026-08-13T00:00:00Z", guardEndUtc: "2026-08-13T00:40:00Z",
    });
    const event = bookingEvent({
      id: "gcal-detect-9", start: "2026-08-13T00:00:00Z", end: "2026-08-13T00:30:00Z",
      status: "cancelled",
      extendedProperties: { private: { optical_booking: id } },
    });
    await detectBookingDeclines(env.DB, OWNER, [event], NOW);
    expect(await stampOf(id)).toBeNull();
  });

  it("ignores a status:'cancelled' event entirely: does not clear a pre-existing stamp either", async () => {
    const id = await confirmedBooking("gcal-detect-9b", {
      startUtc: "2026-08-14T00:00:00Z", endUtc: "2026-08-14T00:30:00Z",
      guardStartUtc: "2026-08-14T00:00:00Z", guardEndUtc: "2026-08-14T00:40:00Z",
    });
    await markCancelPending(env.DB, id, OWNER, "gcal-detect-9b", NOW.toISOString());
    const event = bookingEvent({
      id: "gcal-detect-9b", start: "2026-08-14T00:00:00Z", end: "2026-08-14T00:30:00Z",
      status: "cancelled",
      attendees: [{ email: "sam@x.com", responseStatus: "accepted" }], // even un-declined, cancelled wins
      extendedProperties: { private: { optical_booking: id } },
    });
    await detectBookingDeclines(env.DB, OWNER, [event], new Date("2026-08-02T00:10:00Z"));
    expect(await stampOf(id)).toBe(NOW_ISO);
  });
});

// Test 8
describe("isAllDeclined", () => {
  it("ignores self and resource attendees", () => {
    const event = bookingEvent({
      attendees: [
        { email: "organizer@x.com", self: true, responseStatus: "accepted" },
        { email: "room@x.com", resource: true, responseStatus: "needsAction" },
        { email: "sam@x.com", responseStatus: "declined" },
      ],
    });
    expect(isAllDeclined(event)).toBe(true);
  });

  it("requires at least one counted attendee", () => {
    const event = bookingEvent({
      attendees: [{ email: "organizer@x.com", self: true, responseStatus: "accepted" }],
    });
    expect(isAllDeclined(event)).toBe(false);
  });

  it("is false when no attendees are present at all", () => {
    const event = bookingEvent({ attendees: undefined });
    expect(isAllDeclined(event)).toBe(false);
  });

  it("requires ALL counted attendees to have declined", () => {
    const event = bookingEvent({
      attendees: [
        { email: "sam@x.com", responseStatus: "declined" },
        { email: "jo@x.com", responseStatus: "accepted" },
      ],
    });
    expect(isAllDeclined(event)).toBe(false);
  });

  it("is false when a counted attendee's responseStatus is missing", () => {
    const event = bookingEvent({
      attendees: [{ email: "sam@x.com" }],
    });
    expect(isAllDeclined(event)).toBe(false);
  });

  it("is false when only resource attendees are present (zero counted)", () => {
    const event = bookingEvent({
      attendees: [
        { email: "room-a@x.com", resource: true, responseStatus: "accepted" },
        { email: "room-b@x.com", resource: true, responseStatus: "needsAction" },
      ],
    });
    expect(isAllDeclined(event)).toBe(false);
  });
});
