import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { runBookingDeclineSweep } from "../../src/cron/booking-decline-sweep";
import { dispatchScheduled, __setHandlersForTests, BOOKING_DECLINE_CRON } from "../../src/cron/scheduled-entry";
import { claimSlot, confirmBooking, markCancelPending, listCancelPendingDue } from "../../src/db/bookings";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { MockNotificationProvider } from "../../src/providers/mock-notification-provider";
import type { CalendarEvent } from "../../src/providers/types";
import type { CalendarProvider } from "../../src/providers/calendar-provider";
import type { NotificationProvider } from "../../src/providers/notification-provider";

const OWNER = "decline-sweep-owner@org";
const OWNER2 = "decline-sweep-owner-2@org";
const TEST_ENV = { ...env, OAUTH_ISSUER: "https://scheduler.test" };

function req(over: Partial<Parameters<typeof claimSlot>[1]> = {}) {
  return {
    ownerSubject: OWNER,
    slug: "victor",
    startUtc: "2026-08-19T02:00:00Z",
    endUtc: "2026-08-19T02:30:00Z",
    durationMinutes: 30,
    bookerName: "Sam Booker",
    bookerEmail: "sam@x.com",
    bookerNote: null,
    ipHash: "iphash",
    guardStartUtc: "2026-08-19T02:00:00Z",
    guardEndUtc: "2026-08-19T02:40:00Z",
    now: new Date("2026-08-18T00:00:00Z"),
    locationKind: "meet",
    locationDetail: null,
    ...over,
  };
}

/** Seed a confirmed, grace-stamped booking. Returns its id. */
async function seedDueBooking(
  eventId: string,
  stampIso: string,
  over: Partial<Parameters<typeof claimSlot>[1]> = {},
): Promise<string> {
  const claim = await claimSlot(env.DB, req(over));
  if (!claim) throw new Error(`claimSlot returned null for ${eventId} — slot override probably overlaps another fixture`);
  await confirmBooking(env.DB, claim.id, eventId, new Date("2026-08-18T00:01:00Z"));
  const changed = await markCancelPending(env.DB, claim.id, over.ownerSubject ?? OWNER, eventId, stampIso);
  if (!changed) throw new Error(`markCancelPending failed to stamp ${eventId}`);
  return claim.id;
}

// A booking-page event: exactly one non-self attendee, declined, carrying the
// optical_booking tag that ties it back to the booking row that created it
// (bookingId — see route.ts's claim handler). Card D's defense-in-depth check
// (sweepOneRow) refuses to touch an event whose tag doesn't match the row
// it's re-verifying, so fixtures must set it explicitly rather than to an
// arbitrary placeholder.
function declinedEvent(id: string, bookingId: string, over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id,
    summary: "Meeting with Sam Booker",
    start: "2026-08-19T02:00:00Z",
    end: "2026-08-19T02:30:00Z",
    status: "confirmed",
    attendees: [{ email: "sam@x.com", responseStatus: "declined" }],
    extendedProperties: { private: { optical_booking: bookingId } },
    ...over,
  };
}

async function statusOf(id: string): Promise<string> {
  const row = await env.DB.prepare("SELECT status FROM bookings WHERE id = ?").bind(id).first<{ status: string }>();
  return row!.status;
}

async function stampOf(id: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT cancel_pending_at FROM bookings WHERE id = ?")
    .bind(id)
    .first<{ cancel_pending_at: string | null }>();
  return row?.cancel_pending_at ?? null;
}

function deps(cal: CalendarProvider, notify: NotificationProvider) {
  return { makeCalendar: () => cal, makeNotification: () => notify };
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM bookings WHERE owner_subject = ?").bind(OWNER).run();
  await env.DB.prepare("DELETE FROM bookings WHERE owner_subject = ?").bind(OWNER2).run();
  __setHandlersForTests(null);
});

describe("runBookingDeclineSweep — happy path", () => {
  it("deletes with notifyAttendees, CAS-cancels the row, and emails booker then owner", async () => {
    const id = await seedDueBooking("gcal-happy", "2026-08-19T00:00:00Z");
    const cal = new MockCalendarProvider({ events: [declinedEvent("gcal-happy", id)] });
    const notify = new MockNotificationProvider();

    const result = await runBookingDeclineSweep(TEST_ENV, new Date("2026-08-19T00:11:00Z"), deps(cal, notify));

    expect(result.cancelled).toBe(1);
    expect(await statusOf(id)).toBe("cancelled");
    expect(cal.getDeleted()).toEqual(["gcal-happy"]);
    expect(cal.deleteOptions).toEqual([{ eventId: "gcal-happy", opts: { notifyAttendees: true } }]);

    expect(notify.sentPollEmails).toHaveLength(2);
    expect(notify.sentPollEmails[0]!.to).toBe("sam@x.com");
    expect(notify.sentPollEmails[1]!.to).toBe(OWNER);
    expect(notify.sentPollEmails[0]!.text).toContain("declined the calendar invite");
    expect(notify.sentPollEmails[1]!.text).toContain("Sam Booker");
  });

  // Regression: the row's own start_utc can go stale (an owner manually
  // dragging the event in Google leaves it untouched — only Optical's own
  // relocation calls syncBookingTime). The re-fetched LIVE event is already
  // in hand at this point in the sweep and must be the source of truth for
  // what the emails say happened.
  it("renders the LIVE event's start time in the emails, not a possibly-stale row.start_utc", async () => {
    const id = await seedDueBooking("gcal-stale-start", "2026-08-19T00:00:00Z"); // row.start_utc = 2026-08-19T02:00:00Z
    const cal = new MockCalendarProvider({
      events: [declinedEvent("gcal-stale-start", id, { start: "2026-08-19T05:00:00Z", end: "2026-08-19T05:30:00Z" })],
    });
    const notify = new MockNotificationProvider();

    await runBookingDeclineSweep(TEST_ENV, new Date("2026-08-19T00:11:00Z"), deps(cal, notify));

    // 2026-08-19T05:00:00Z is 3:00 PM in Australia/Sydney (SCHEDULER_TZ); the
    // row's own start_utc would have rendered 12:00 PM instead.
    expect(notify.sentPollEmails[0]!.text).toContain("3:00 PM");
    expect(notify.sentPollEmails[0]!.text).not.toContain("12:00 PM");
    expect(notify.sentPollEmails[1]!.text).toContain("3:00 PM");
  });
});

describe("runBookingDeclineSweep — re-verify outcomes", () => {
  it("un-declined attendee: clears the stamp, does not delete, sends no email", async () => {
    const id = await seedDueBooking("gcal-undeclined", "2026-08-19T00:00:00Z");
    const cal = new MockCalendarProvider({
      events: [
        declinedEvent("gcal-undeclined", id, { attendees: [{ email: "sam@x.com", responseStatus: "accepted" }] }),
      ],
    });
    const notify = new MockNotificationProvider();

    await runBookingDeclineSweep(TEST_ENV, new Date("2026-08-19T00:11:00Z"), deps(cal, notify));

    expect(cal.getDeleted()).toEqual([]);
    expect(notify.sentPollEmails).toHaveLength(0);
    expect(await statusOf(id)).toBe("confirmed");
    expect(await stampOf(id)).toBeNull();
  });

  it("event gone (getEvent returns null): marks cancelled quietly, no emails", async () => {
    const id = await seedDueBooking("gcal-gone", "2026-08-19T00:00:00Z");
    const cal = new MockCalendarProvider({ events: [] }); // getEvent -> null
    const notify = new MockNotificationProvider();

    await runBookingDeclineSweep(TEST_ENV, new Date("2026-08-19T00:11:00Z"), deps(cal, notify));

    expect(cal.getDeleted()).toEqual([]);
    expect(notify.sentPollEmails).toHaveLength(0);
    expect(await statusOf(id)).toBe("cancelled");
  });

  it("event status cancelled: marks cancelled quietly, no emails", async () => {
    const id = await seedDueBooking("gcal-cancelled-status", "2026-08-19T00:00:00Z");
    const cal = new MockCalendarProvider({
      events: [
        declinedEvent("gcal-cancelled-status", id, { status: "cancelled", start: "", end: "", attendees: undefined }),
      ],
    });
    const notify = new MockNotificationProvider();

    await runBookingDeclineSweep(TEST_ENV, new Date("2026-08-19T00:11:00Z"), deps(cal, notify));

    expect(cal.getDeleted()).toEqual([]);
    expect(notify.sentPollEmails).toHaveLength(0);
    expect(await statusOf(id)).toBe("cancelled");
  });

  it("event start now in the past: clears the stamp, leaves the event alone", async () => {
    const id = await seedDueBooking("gcal-past", "2026-08-19T00:00:00Z");
    const cal = new MockCalendarProvider({ events: [declinedEvent("gcal-past", id)] });
    const notify = new MockNotificationProvider();

    // Sweep runs well after the booked slot (02:00-02:30) has started.
    await runBookingDeclineSweep(TEST_ENV, new Date("2026-08-19T03:00:00Z"), deps(cal, notify));

    expect(cal.getDeleted()).toEqual([]);
    expect(notify.sentPollEmails).toHaveLength(0);
    expect(await statusOf(id)).toBe("confirmed");
    expect(await stampOf(id)).toBeNull();
  });

  it("unparseable event start: fails closed — clears the stamp, never deletes", async () => {
    const id = await seedDueBooking("gcal-nan-start", "2026-08-19T00:00:00Z");
    // Not Google's "cancelled" shape (status is fine, attendees declined) but
    // the start is unparseable — the sweep deletes live events, so unknown
    // time must abort, mirroring the detector's fail-closed stamp guard.
    const cal = new MockCalendarProvider({
      events: [declinedEvent("gcal-nan-start", id, { start: "", end: "" })],
    });
    const notify = new MockNotificationProvider();

    await runBookingDeclineSweep(TEST_ENV, new Date("2026-08-19T01:00:00Z"), deps(cal, notify));

    expect(cal.getDeleted()).toEqual([]);
    expect(notify.sentPollEmails).toHaveLength(0);
    expect(await statusOf(id)).toBe("confirmed");
    expect(await stampOf(id)).toBeNull();
  });

  it("markCancelled CAS loses (row closed out by something else between delete and CAS): counted as aborted, no emails, logged by booking id", async () => {
    const id = await seedDueBooking("gcal-raced", "2026-08-19T00:00:00Z");
    const cal = new MockCalendarProvider({ events: [declinedEvent("gcal-raced", id)] });
    const realDelete = cal.deleteEvent.bind(cal);
    // Simulate a concurrent close-out landing exactly between the sweep's
    // delete call and its own markCancelled CAS.
    cal.deleteEvent = async (eventId, opts) => {
      await env.DB.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").bind(id).run();
      return realDelete(eventId, opts);
    };
    const notify = new MockNotificationProvider();
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});

    const result = await runBookingDeclineSweep(TEST_ENV, new Date("2026-08-19T00:11:00Z"), deps(cal, notify));

    // Delete still fires (ordering is delete-then-CAS by design) but no email follows.
    expect(cal.getDeleted()).toEqual(["gcal-raced"]);
    expect(notify.sentPollEmails).toHaveLength(0);
    expect(result.aborted).toBe(1);

    const loggedFields = consoleInfo.mock.calls.find((c) => String(c[0]).includes("raced"))?.[1] as
      | Record<string, unknown>
      | undefined;
    expect(loggedFields?.bookingId).toBe(id);

    consoleInfo.mockRestore();
  });
});

describe("runBookingDeclineSweep — optical_booking tag defense-in-depth", () => {
  // Blast-radius guard: if google_event_id ever pointed at an event that
  // ISN'T the one this booking's row created (e.g. the id got reused for an
  // unrelated event after ours was deleted out-of-band), the sweep must
  // never delete it just because it happens to look all-declined.
  it("refuses to delete an event whose optical_booking tag doesn't match this row: clears the stamp instead", async () => {
    const id = await seedDueBooking("gcal-mismatch", "2026-08-19T00:00:00Z");
    const cal = new MockCalendarProvider({
      events: [declinedEvent("gcal-mismatch", "some-other-booking-id")],
    });
    const notify = new MockNotificationProvider();

    const result = await runBookingDeclineSweep(TEST_ENV, new Date("2026-08-19T00:11:00Z"), deps(cal, notify));

    expect(cal.getDeleted()).toEqual([]);
    expect(notify.sentPollEmails).toHaveLength(0);
    expect(result.cleared).toBe(1);
    expect(await statusOf(id)).toBe("confirmed");
    expect(await stampOf(id)).toBeNull();
  });
});

describe("runBookingDeclineSweep — notification failure after a won CAS", () => {
  it("a throwing sendPollEmail is caught: the row stays cancelled, the event stays deleted, and the row drops out of future sweeps (lost notification, no retry — by design)", async () => {
    const id = await seedDueBooking("gcal-emailfail", "2026-08-19T00:00:00Z");
    const cal = new MockCalendarProvider({ events: [declinedEvent("gcal-emailfail", id)] });
    const notify = new MockNotificationProvider();
    notify.sendPollEmail = async () => {
      throw new Error("gmail 500");
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await runBookingDeclineSweep(TEST_ENV, new Date("2026-08-19T00:11:00Z"), deps(cal, notify));

    expect(result.failed).toBe(1);
    expect(cal.getDeleted()).toEqual(["gcal-emailfail"]);
    expect(await statusOf(id)).toBe("cancelled");

    // The row is no longer 'confirmed', so it's no longer visible to
    // listCancelPendingDue — the accepted trade-off is a lost notification,
    // not a retry loop that would re-delete an already-gone event.
    const dueRows = await listCancelPendingDue(env.DB, "2026-08-19T01:00:00Z");
    expect(dueRows.map((r) => r.id)).not.toContain(id);

    consoleError.mockRestore();
  });
});

describe("runBookingDeclineSweep — grace clamp (parse default 10, clamp to >= 1)", () => {
  // A stamp 5 minutes old at sweep time: due under a 1-minute floor, not due
  // under the 10-minute default — the boundary the clamp bug lived at.
  async function checkedCountAt5MinOld(graceMinutes: string | undefined, eventId: string): Promise<number> {
    const id = await seedDueBooking(eventId, "2026-08-19T00:05:00Z");
    const cal = new MockCalendarProvider({ events: [declinedEvent(eventId, id)] });
    const notify = new MockNotificationProvider();
    const testEnv = graceMinutes === undefined ? TEST_ENV : { ...TEST_ENV, BOOKING_DECLINE_GRACE_MINUTES: graceMinutes };
    const result = await runBookingDeclineSweep(testEnv, new Date("2026-08-19T00:10:00Z"), deps(cal, notify));
    return result.checked;
  }

  it("unset: falls back to the 10-minute default (not yet due)", async () => {
    expect(await checkedCountAt5MinOld(undefined, "gcal-clamp-unset")).toBe(0);
  });

  it('empty string: falls back to the 10-minute default (not yet due)', async () => {
    expect(await checkedCountAt5MinOld("", "gcal-clamp-empty")).toBe(0);
  });

  it('non-numeric ("abc"): falls back to the 10-minute default (not yet due)', async () => {
    expect(await checkedCountAt5MinOld("abc", "gcal-clamp-nan")).toBe(0);
  });

  it('"0": clamps to a 1-minute floor, not the 10-minute default (due)', async () => {
    expect(await checkedCountAt5MinOld("0", "gcal-clamp-zero")).toBe(1);
  });

  it('"-5": clamps to a 1-minute floor, not the 10-minute default (due)', async () => {
    expect(await checkedCountAt5MinOld("-5", "gcal-clamp-neg")).toBe(1);
  });

  it('honours a valid override ("1") to shrink the window and actually cancels', async () => {
    const id = await seedDueBooking("gcal-shortgrace", "2026-08-19T00:05:00Z");
    const cal = new MockCalendarProvider({ events: [declinedEvent("gcal-shortgrace", id)] });
    const notify = new MockNotificationProvider();

    const result = await runBookingDeclineSweep(
      { ...TEST_ENV, BOOKING_DECLINE_GRACE_MINUTES: "1" },
      new Date("2026-08-19T00:10:00Z"),
      deps(cal, notify),
    );

    expect(result.checked).toBe(1);
    expect(await statusOf(id)).toBe("cancelled");
  });

  it('a fractional override ("10.7") floors to a 10-minute grace, not the raw 10.7 (card G note (g))', async () => {
    // A stamp 10 min 21 s (10.35 min) old at sweep time: due under the
    // correct floor(10.7) = 10-minute grace, NOT yet due under the raw,
    // unfloored 10.7-minute value — the exact boundary that would flip if
    // graceMinutes ever stopped flooring before the clamp.
    const id = await seedDueBooking("gcal-fractional-grace", "2026-08-19T00:29:39Z");
    const cal = new MockCalendarProvider({ events: [declinedEvent("gcal-fractional-grace", id)] });
    const notify = new MockNotificationProvider();

    const result = await runBookingDeclineSweep(
      { ...TEST_ENV, BOOKING_DECLINE_GRACE_MINUTES: "10.7" },
      new Date("2026-08-19T00:40:00Z"),
      deps(cal, notify),
    );

    expect(result.checked).toBe(1);
  });
});

describe("runBookingDeclineSweep — per-row isolation", () => {
  it("a throwing row is caught and logged (booking id, never an address); the stamp survives; other rows still process", async () => {
    const failingId = await seedDueBooking("gcal-boom", "2026-08-19T00:00:00Z", {
      startUtc: "2026-08-19T04:00:00Z",
      endUtc: "2026-08-19T04:30:00Z",
      guardStartUtc: "2026-08-19T04:00:00Z",
      guardEndUtc: "2026-08-19T04:40:00Z",
    });
    const okId = await seedDueBooking("gcal-ok", "2026-08-19T00:00:00Z", {
      startUtc: "2026-08-19T05:00:00Z",
      endUtc: "2026-08-19T05:30:00Z",
      guardStartUtc: "2026-08-19T05:00:00Z",
      guardEndUtc: "2026-08-19T05:40:00Z",
    });

    const cal = new MockCalendarProvider({
      events: [
        declinedEvent("gcal-boom", failingId, { start: "2026-08-19T04:00:00Z", end: "2026-08-19T04:30:00Z" }),
        declinedEvent("gcal-ok", okId, { start: "2026-08-19T05:00:00Z", end: "2026-08-19T05:30:00Z" }),
      ],
    });
    cal.deleteEvent = async (eventId: string) => {
      if (eventId === "gcal-boom") throw new Error("google 500");
    };
    const notify = new MockNotificationProvider();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await runBookingDeclineSweep(TEST_ENV, new Date("2026-08-19T00:11:00Z"), deps(cal, notify));

    expect(result.failed).toBe(1);
    expect(result.cancelled).toBe(1);
    expect(await statusOf(failingId)).toBe("confirmed"); // untouched: the stamp survives for the next tick
    expect(await stampOf(failingId)).not.toBeNull();
    expect(await statusOf(okId)).toBe("cancelled");

    const loggedFields = consoleError.mock.calls.find((c) => String(c[0]).includes("booking-decline-sweep"))?.[1] as
      | Record<string, unknown>
      | undefined;
    expect(loggedFields?.bookingId).toBe(failingId);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("sam@x.com");

    consoleError.mockRestore();
  });
});

describe("runBookingDeclineSweep — per-owner provider construction isolation", () => {
  it("makeCalendar throwing for one owner (e.g. kill-switch-disabled Microsoft provider) doesn't abort the sweep for other owners; skippedOwners/skippedRows track it distinctly from failed", async () => {
    // Owner 1 has TWO due rows — skippedRows must reflect both, and
    // skippedOwners counts the one owner (not per row).
    const failId1 = await seedDueBooking("gcal-owner1-a", "2026-08-19T00:00:00Z", {
      startUtc: "2026-08-19T04:00:00Z", endUtc: "2026-08-19T04:30:00Z",
      guardStartUtc: "2026-08-19T04:00:00Z", guardEndUtc: "2026-08-19T04:40:00Z",
    });
    const failId2 = await seedDueBooking("gcal-owner1-b", "2026-08-19T00:00:00Z", {
      startUtc: "2026-08-19T06:00:00Z", endUtc: "2026-08-19T06:30:00Z",
      guardStartUtc: "2026-08-19T06:00:00Z", guardEndUtc: "2026-08-19T06:40:00Z",
    });
    const okId = await seedDueBooking("gcal-owner2-ok", "2026-08-19T00:00:00Z", {
      ownerSubject: OWNER2,
      startUtc: "2026-08-19T05:00:00Z", endUtc: "2026-08-19T05:30:00Z",
      guardStartUtc: "2026-08-19T05:00:00Z", guardEndUtc: "2026-08-19T05:40:00Z",
    });

    const cal2 = new MockCalendarProvider({
      events: [declinedEvent("gcal-owner2-ok", okId, { start: "2026-08-19T05:00:00Z", end: "2026-08-19T05:30:00Z" })],
    });
    const notify = new MockNotificationProvider();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const makeCalendar = (subject: string) => {
      if (subject === OWNER) throw new Error("ms_provider_disabled");
      return cal2;
    };

    const result = await runBookingDeclineSweep(TEST_ENV, new Date("2026-08-19T00:11:00Z"), {
      makeCalendar,
      makeNotification: () => notify,
    });

    expect(result.skippedOwners).toBe(1);
    expect(result.skippedRows).toBe(2);
    expect(result.failed).toBe(0); // never overloads `failed` — nothing was actually attempted
    expect(await statusOf(failId1)).toBe("confirmed"); // untouched: never reached per-row processing
    expect(await stampOf(failId1)).not.toBeNull();
    expect(await statusOf(failId2)).toBe("confirmed");
    expect(await stampOf(failId2)).not.toBeNull();
    expect(await statusOf(okId)).toBe("cancelled"); // owner2 still fully processed

    consoleError.mockRestore();
  });
});

describe("dispatchScheduled — BOOKING_DECLINE_CRON", () => {
  it("is inert when BOOKING_PAGE_ENABLED is not 'true'", async () => {
    const bookingDeclineSweep = vi.fn(async () => ({ checked: 0, cancelled: 0, cleared: 0, closedQuietly: 0, aborted: 0, failed: 0, skippedOwners: 0, skippedRows: 0 }));
    __setHandlersForTests({ monday: vi.fn(), cleanup: vi.fn(), bookingDeclineSweep });

    await dispatchScheduled(
      { cron: BOOKING_DECLINE_CRON, scheduledTime: Date.now() } as unknown as ScheduledEvent,
      { ...env, BOOKING_PAGE_ENABLED: undefined },
      { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
    );

    expect(bookingDeclineSweep).not.toHaveBeenCalled();
  });

  it("dispatches to the injected sweep handler when the flag is 'true'", async () => {
    const bookingDeclineSweep = vi.fn(async () => ({ checked: 0, cancelled: 0, cleared: 0, closedQuietly: 0, aborted: 0, failed: 0, skippedOwners: 0, skippedRows: 0 }));
    __setHandlersForTests({ monday: vi.fn(), cleanup: vi.fn(), bookingDeclineSweep });

    const tasks: Promise<unknown>[] = [];
    await dispatchScheduled(
      { cron: BOOKING_DECLINE_CRON, scheduledTime: Date.now() } as unknown as ScheduledEvent,
      { ...env, BOOKING_PAGE_ENABLED: "true" },
      { waitUntil: (p: Promise<unknown>) => { tasks.push(p); }, passThroughOnException: () => {} } as unknown as ExecutionContext,
    );
    await Promise.all(tasks);

    expect(bookingDeclineSweep).toHaveBeenCalledTimes(1);
  });
});

// Sanity check that the fixtures above actually exercise listCancelPendingDue
// the way the sweep does, so a change to that query's shape fails loudly here
// too, not just in test/db/booking-cancel-pending.test.ts.
describe("fixtures sanity", () => {
  it("seedDueBooking rows are visible to listCancelPendingDue", async () => {
    await seedDueBooking("gcal-sanity", "2026-08-19T00:00:00Z");
    const rows = await listCancelPendingDue(env.DB, "2026-08-19T00:10:00Z");
    expect(rows.map((r) => r.google_event_id)).toContain("gcal-sanity");
  });
});
