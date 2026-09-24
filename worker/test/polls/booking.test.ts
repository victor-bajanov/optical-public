import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { saveBookingPage } from "../../src/db/booking-page";
import { createPoll, insertInvitee, newInviteeId, replaceResponses, markResponded, dropInvitee, setPollStatus, getPoll, setHideName } from "../../src/db/polls";
import { claimSlot } from "../../src/db/bookings";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { MockNotificationProvider } from "../../src/providers/mock-notification-provider";
import type { CalendarProvider, DeleteEventOptions, FreeBusyResult, UpdateEventOptions } from "../../src/providers/calendar-provider";
import type { CalendarEvent, IncrementalResult, Subscription } from "../../src/providers/types";
import type { PollEmail } from "../../src/providers/notification-provider";
import { maybeBookOnAllIn, bookPollSlot, bookAtDeadline, bookBestNow, loadMeetingFitCurve, __setForTests } from "../../src/polls/booking";
import { rankCandidates, organiserFit, type InviteeResponse } from "../../src/polls/scoring";

const OWNER = "poll-book@org";
const NOW = new Date("2026-08-01T00:00:00Z");
// Mon 2026-08-10 - Fri 2026-08-14, Australia/Sydney (AEST, +10 in August).
const RANGE_START = "2026-08-10";
const RANGE_END = "2026-08-14";
// makePoll()'s default deadlineUtc — pin `now` here (or later) to simulate
// bookAtDeadline being called once the deadline has actually arrived.
const AT_DEADLINE = new Date("2026-08-09T00:00:00Z");

async function seedConfig() {
  await saveBookingPage(env.DB, OWNER, {
    slug: "poll-book",
    enabled: true,
    hours: { days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" },
    horizon_days: 5,
    min_notice_minutes: 0,
    buffer_minutes: { before: 0, after: 0 },
  });
}

async function makePoll(overrides: Partial<Parameters<typeof createPoll>[1]> = {}) {
  return createPoll(env.DB, {
    subject: OWNER,
    title: "Team sync",
    durationMin: 30,
    rangeStart: RANGE_START,
    rangeEnd: RANGE_END,
    deadlineUtc: "2026-08-09T00:00:00Z",
    location: { kind: "meet" },
    guestTokenHash: null,
    now: NOW.toISOString(),
    ...overrides,
  });
}

async function addInvitee(pollId: string, email: string, name: string) {
  return insertInvitee(env.DB, {
    id: newInviteeId(),
    pollId,
    email,
    name,
    kind: "invited",
    tokenHash: `hash-${email}`,
    pseudonym: `pseudo-${email}`,
    now: NOW.toISOString(),
  });
}

/** Paints every 30-min cell across the whole test window as "free" for one
 *  invitee — broad enough to cover any candidate the business-hours window
 *  could produce, so tests can focus on poll-level behaviour (trigger timing,
 *  claim races, escalation) rather than on scoring.ts's own coverage math
 *  (that module owns its own fixtures). */
async function paintWholeWindow(inviteeId: string, state: "free" | "if_needed" = "free") {
  const cells: { cellStartUtc: string; state: "free" | "if_needed" }[] = [];
  let t = Date.parse("2026-08-08T00:00:00Z");
  const end = Date.parse("2026-08-16T00:00:00Z");
  while (t < end) {
    cells.push({ cellStartUtc: new Date(t).toISOString(), state });
    t += 30 * 60_000;
  }
  await replaceResponses(env.DB, inviteeId, cells);
}

/** Only the disjoint slice of the window this invitee can attend. Used to
 *  build a poll with no common qualifying slot but a real leave-one-out
 *  near-miss for the OTHER invitee. */
async function paintOnly(inviteeId: string, startIso: string, endIso: string) {
  const cells: { cellStartUtc: string; state: "free" }[] = [];
  let t = Date.parse(startIso);
  const end = Date.parse(endIso);
  while (t < end) {
    cells.push({ cellStartUtc: new Date(t).toISOString(), state: "free" });
    t += 30 * 60_000;
  }
  await replaceResponses(env.DB, inviteeId, cells);
}

/** Delegates every CalendarProvider method to an inner MockCalendarProvider,
 *  except fetchEventsInWindow, which is stubbed to simulate the calendar
 *  changing between the initial ranking pass and bookPollSlot's own live
 *  re-check: empty (all free) on the first call, busy over `staleBusyStart`
 *  onward from the second call. */
class StaleningCalendarProvider implements CalendarProvider {
  private calls = 0;
  readonly inner = new MockCalendarProvider();
  constructor(private readonly staleEvent: CalendarEvent) {}
  async fetchEventsInWindow(start: string, end: string) {
    this.calls += 1;
    if (this.calls === 1) return { events: [], nextSyncToken: "t1" };
    return { events: [this.staleEvent], nextSyncToken: "t2" };
  }
  subscribeToChanges(callbackUrl: string, channelToken: string): Promise<Subscription> {
    return this.inner.subscribeToChanges(callbackUrl, channelToken);
  }
  fetchIncrementalChanges(syncToken: string): Promise<IncrementalResult> {
    return this.inner.fetchIncrementalChanges(syncToken);
  }
  createEvent(...args: Parameters<CalendarProvider["createEvent"]>) {
    return this.inner.createEvent(...args);
  }
  updateEvent(eventId: string, changes: Partial<CalendarEvent>, opts?: UpdateEventOptions): Promise<void> {
    return this.inner.updateEvent(eventId, changes, opts);
  }
  queryFreeBusy(calendarIds: string[], window: { start: string; end: string }): Promise<Map<string, FreeBusyResult>> {
    return this.inner.queryFreeBusy(calendarIds, window);
  }
  deleteEvent(eventId: string, opts?: DeleteEventOptions): Promise<void> {
    return this.inner.deleteEvent(eventId, opts);
  }
  getEvent(eventId: string): Promise<CalendarEvent | null> {
    return this.inner.getEvent(eventId);
  }
  verifyWebhook(headers: Headers, body: string): boolean {
    return this.inner.verifyWebhook(headers, body);
  }
  stopChannel(channelId: string, resourceId: string): Promise<void> {
    return this.inner.stopChannel(channelId, resourceId);
  }
}

/** A CalendarProvider whose createEvent always throws, delegating everything
 *  else to an inner MockCalendarProvider (so claimSlot's row can still be
 *  inspected afterwards). `calls` counts createEvent invocations — used by
 *  the bookBest abort-on-first-write-failure regression (FIX 1) to assert
 *  the walk does NOT try every remaining candidate. */
class ThrowingCreateCalendarProvider implements CalendarProvider {
  readonly inner = new MockCalendarProvider();
  calls = 0;
  fetchEventsInWindow(start: string, end: string) {
    return this.inner.fetchEventsInWindow(start, end);
  }
  subscribeToChanges(callbackUrl: string, channelToken: string): Promise<Subscription> {
    return this.inner.subscribeToChanges(callbackUrl, channelToken);
  }
  fetchIncrementalChanges(syncToken: string): Promise<IncrementalResult> {
    return this.inner.fetchIncrementalChanges(syncToken);
  }
  async createEvent(): ReturnType<CalendarProvider["createEvent"]> {
    this.calls += 1;
    throw new Error("calendar unavailable");
  }
  updateEvent(eventId: string, changes: Partial<CalendarEvent>, opts?: UpdateEventOptions): Promise<void> {
    return this.inner.updateEvent(eventId, changes, opts);
  }
  queryFreeBusy(calendarIds: string[], window: { start: string; end: string }): Promise<Map<string, FreeBusyResult>> {
    return this.inner.queryFreeBusy(calendarIds, window);
  }
  deleteEvent(eventId: string, opts?: DeleteEventOptions): Promise<void> {
    return this.inner.deleteEvent(eventId, opts);
  }
  getEvent(eventId: string): Promise<CalendarEvent | null> {
    return this.inner.getEvent(eventId);
  }
  verifyWebhook(headers: Headers, body: string): boolean {
    return this.inner.verifyWebhook(headers, body);
  }
  stopChannel(channelId: string, resourceId: string): Promise<void> {
    return this.inner.stopChannel(channelId, resourceId);
  }
}

/** A CalendarProvider whose createEvent throws on its FIRST call only,
 *  succeeding (delegating to an inner MockCalendarProvider) on every call
 *  after that — a transient calendar-write outage. Used by the FIX 1
 *  regression pinning attemptBookOrEscalate's existing behaviour: it must
 *  keep walking to the next ranked candidate after a write failure (unlike
 *  bookBestNow, which aborts on the first one). */
class FailFirstCreateCalendarProvider extends MockCalendarProvider {
  calls = 0;
  async createEvent(...args: Parameters<CalendarProvider["createEvent"]>): ReturnType<CalendarProvider["createEvent"]> {
    this.calls += 1;
    if (this.calls === 1) throw new Error("transient calendar outage");
    return super.createEvent(...args);
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Blocks the FIRST createEvent call until released, so a second concurrent
 *  booking attempt can run while the first is mid-flight (a real Google API
 *  call is seconds long — this is not an exotic interleaving). Race-condition
 *  regression harness for C-T9 round B (F1/F1b/F2/F3/F4). */
class GatedCalendar extends MockCalendarProvider {
  calls = 0;
  readonly firstStarted = deferred();
  private readonly gate = deferred();
  async createEvent(...args: Parameters<CalendarProvider["createEvent"]>) {
    this.calls += 1;
    if (this.calls === 1) {
      this.firstStarted.resolve();
      await this.gate.promise;
    }
    return super.createEvent(...args);
  }
  release() {
    this.gate.resolve();
  }
}

let calendar: MockCalendarProvider;
let notification: MockNotificationProvider;

beforeEach(async () => {
  for (const t of ["polls", "poll_invitees", "poll_responses", "bookings", "config_booking_page"]) {
    await env.DB.prepare(`DELETE FROM ${t} WHERE 1=1`).run();
  }
  await seedConfig();
  calendar = new MockCalendarProvider();
  notification = new MockNotificationProvider();
  __setForTests({ calendar, notification, now: () => NOW });
});

// __setForTests is a module-level singleton (booking.ts has no per-call
// injection room — see its own comment), so it survives past this file's own
// tests if left set: another suite collected in the same worker/module
// registry (e.g. test/polls/route.test.ts, which relies on NO override being
// set so its own real-provider path throws predictably) would silently
// inherit this file's mock calendar/notification instead. Reset it here so
// nothing leaks across files.
afterEach(() => {
  __setForTests(null);
});

describe("maybeBookOnAllIn — trigger timing", () => {
  it("does nothing while a required (non-dropped) invitee has not responded", async () => {
    const poll = await makePoll();
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    await addInvitee(poll.id, "b@x.com", "Bob");
    await paintWholeWindow(a.id);
    await markResponded(env.DB, a.id, NOW.toISOString());

    await maybeBookOnAllIn(env, poll.id);

    const after = await getPoll(env.DB, poll.id);
    expect(after!.status).toBe("open");
    expect(calendar.getCreated()).toHaveLength(0);
    expect(notification.sentPollEmails).toHaveLength(0);
  });

  it("ignores a dropped invitee's missing response and books once every OTHER required invitee is in", async () => {
    const poll = await makePoll();
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    const b = await addInvitee(poll.id, "b@x.com", "Bob");
    const c = await addInvitee(poll.id, "c@x.com", "Carol"); // never responds, but is dropped
    await dropInvitee(env.DB, c.id);
    await paintWholeWindow(a.id);
    await paintWholeWindow(b.id);
    await markResponded(env.DB, a.id, NOW.toISOString());
    await markResponded(env.DB, b.id, NOW.toISOString());

    await maybeBookOnAllIn(env, poll.id);

    const after = await getPoll(env.DB, poll.id);
    expect(after!.status).toBe("booked");
    expect(calendar.getCreated()).toHaveLength(1);
  });

  it("books an event tagging the poll id, all non-dropped attendees, notifyAttendees, and a poll_id-carrying bookings row", async () => {
    const poll = await makePoll({ location: { kind: "meet" } });
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    const b = await addInvitee(poll.id, "b@x.com", "Bob");
    const c = await addInvitee(poll.id, "c@x.com", "Carol");
    await dropInvitee(env.DB, c.id);
    await paintWholeWindow(a.id);
    await paintWholeWindow(b.id);
    await markResponded(env.DB, a.id, NOW.toISOString());
    await markResponded(env.DB, b.id, NOW.toISOString());

    await maybeBookOnAllIn(env, poll.id);

    const created = calendar.getCreated();
    expect(created).toHaveLength(1);
    const event = created[0]!;
    expect(event.attendees?.map((x) => x.email).sort()).toEqual(["a@x.com", "b@x.com"]);
    expect(event.extendedProperties?.private?.optical_poll_id).toBe(poll.id);
    expect(calendar.createOptions[0]).toMatchObject({ notifyAttendees: true, addMeet: true });

    const after = await getPoll(env.DB, poll.id);
    expect(after!.status).toBe("booked");
    expect(after!.gcalEventId).toBe(event.id);
    expect(after!.bookedSlotUtc).toBeTruthy();

    const row = await env.DB
      .prepare("SELECT poll_id, status FROM bookings WHERE poll_id = ?")
      .bind(poll.id)
      .first<{ poll_id: string; status: string }>();
    expect(row).toEqual({ poll_id: poll.id, status: "confirmed" });
  });

  it("D1: created attendees carry no `optional` marker (Google default = required)", async () => {
    const poll = await makePoll();
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    const b = await addInvitee(poll.id, "b@x.com", "Bob");
    await paintWholeWindow(a.id);
    await paintWholeWindow(b.id);
    await markResponded(env.DB, a.id, NOW.toISOString());
    await markResponded(env.DB, b.id, NOW.toISOString());

    await maybeBookOnAllIn(env, poll.id);

    const event = calendar.getCreated()[0]!;
    expect(event.attendees).toHaveLength(2);
    for (const attendee of event.attendees!) {
      expect(attendee.optional).not.toBe(true);
    }
  });
});

describe("D2: hidden invitees excluded from the booked event's attendees", () => {
  it("omits a hidden non-dropped invitee from the calendar event's attendees", async () => {
    const poll = await makePoll();
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    const b = await addInvitee(poll.id, "b@x.com", "Bob (hidden)");
    await setHideName(env.DB, b.id, true);
    await paintWholeWindow(a.id);
    await paintWholeWindow(b.id);
    await markResponded(env.DB, a.id, NOW.toISOString());
    await markResponded(env.DB, b.id, NOW.toISOString());

    await maybeBookOnAllIn(env, poll.id);

    const event = calendar.getCreated()[0]!;
    expect(event.attendees?.map((x) => x.email)).toEqual(["a@x.com"]);
  });

  it("sends the hidden invitee a booking-notice email (with ICS attachment) after the event is confirmed", async () => {
    const poll = await makePoll({ title: "Team sync" });
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    const b = await addInvitee(poll.id, "b@x.com", "Bob");
    await setHideName(env.DB, b.id, true);
    await paintWholeWindow(a.id);
    await paintWholeWindow(b.id);
    await markResponded(env.DB, a.id, NOW.toISOString());
    await markResponded(env.DB, b.id, NOW.toISOString());

    await maybeBookOnAllIn(env, poll.id);

    expect(calendar.getCreated()).toHaveLength(1); // event was actually booked, not orphaned
    const notices = notification.sentPollEmails.filter((e) => e.to === "b@x.com");
    expect(notices).toHaveLength(1);
    expect(notices[0]!.subject).toContain("Team sync");
    expect(notices[0]!.attachments).toHaveLength(1);
    expect(notices[0]!.attachments![0]!.filename).toBe("invite.ics");
    // Alice (not hidden, listed as attendee) gets no separate BCC-equivalent notice.
    expect(notification.sentPollEmails.some((e) => e.to === "a@x.com")).toBe(false);
  });

  it("still books the event when every invitee is hidden (attendee list has no invitees)", async () => {
    const poll = await makePoll();
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    await setHideName(env.DB, a.id, true);
    await paintWholeWindow(a.id);
    await markResponded(env.DB, a.id, NOW.toISOString());

    await maybeBookOnAllIn(env, poll.id);

    const after = await getPoll(env.DB, poll.id);
    expect(after!.status).toBe("booked");
    const event = calendar.getCreated()[0]!;
    expect(event.attendees ?? []).toHaveLength(0);
    expect(notification.sentPollEmails.filter((e) => e.to === "a@x.com")).toHaveLength(1);
  });

  it("a booking-notice send failure is logged and does not fail the booking", async () => {
    const poll = await makePoll();
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    const b = await addInvitee(poll.id, "b@x.com", "Bob");
    await setHideName(env.DB, b.id, true);
    await paintWholeWindow(a.id);
    await paintWholeWindow(b.id);
    await markResponded(env.DB, a.id, NOW.toISOString());
    await markResponded(env.DB, b.id, NOW.toISOString());

    const failingNotification = new MockNotificationProvider();
    failingNotification.sendPollEmail = async () => {
      throw new Error("smtp unavailable");
    };
    __setForTests({ calendar, notification: failingNotification, now: () => NOW });
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    await maybeBookOnAllIn(env, poll.id);

    const after = await getPoll(env.DB, poll.id);
    expect(after!.status).toBe("booked"); // the event booking itself still succeeded
    expect(calendar.getCreated()).toHaveLength(1);

    // R1-F6: the failure log must not carry the hidden invitee's real email
    // address — that's the exact datum hide-name protects. It's fine (and
    // useful for support) to log the invitee id instead.
    expect(consoleErr).toHaveBeenCalled();
    for (const call of consoleErr.mock.calls) {
      const joined = call.map((a) => String(a)).join(" ");
      expect(joined).not.toContain("b@x.com");
    }
    expect(consoleErr.mock.calls.some((call) => call.map((a) => String(a)).join(" ").includes(b.id))).toBe(true);

    consoleErr.mockRestore();
  });
});

describe("empty intersection — escalation", () => {
  it("escalates exactly once (idempotent stamp + single email) even when re-attempted after being reopened", async () => {
    const poll = await makePoll();
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    const b = await addInvitee(poll.id, "b@x.com", "Bob");
    // Disjoint availability: no common candidate exists.
    await paintOnly(a.id, "2026-08-10T00:00:00Z", "2026-08-10T02:00:00Z"); // Mon 10:00-12:00 Sydney
    await paintOnly(b.id, "2026-08-11T00:00:00Z", "2026-08-11T02:00:00Z"); // Tue 10:00-12:00 Sydney
    await markResponded(env.DB, a.id, NOW.toISOString());
    await markResponded(env.DB, b.id, NOW.toISOString());

    await maybeBookOnAllIn(env, poll.id);

    const first = await getPoll(env.DB, poll.id);
    expect(first!.status).toBe("needs_attention");
    expect(first!.escalatedAt).toBeTruthy();
    expect(notification.sentPollEmails).toHaveLength(1);
    // Near-miss computation: each invitee's leave-one-out unlocks the other's
    // slots, so both names should surface in the escalation content.
    expect(notification.sentPollEmails[0]!.text).toContain("Alice");
    expect(notification.sentPollEmails[0]!.text).toContain("Bob");
    expect(notification.sentPollEmails[0]!.to).toBe(OWNER);
    const stampAfterFirst = first!.escalatedAt;

    // Simulate T8's dropInvitee-then-retry re-opening a stuck poll without
    // actually resolving the conflict — escalatedAt must not move and no
    // second email should go out.
    await setPollStatus(env.DB, poll.id, "open", "2026-08-05T00:00:00Z");
    await maybeBookOnAllIn(env, poll.id);

    const second = await getPoll(env.DB, poll.id);
    expect(second!.status).toBe("needs_attention");
    expect(second!.escalatedAt).toBe(stampAfterFirst);
    expect(notification.sentPollEmails).toHaveLength(1);
  });
});

describe("Card C: guest-link polls wait for the deadline", () => {
  it("an open poll with guestTokenHash set books nothing once all named invitees are in, even with a clean overlap", async () => {
    const poll = await makePoll({ guestTokenHash: "hash-guest" });
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    const b = await addInvitee(poll.id, "b@x.com", "Bob");
    await paintWholeWindow(a.id);
    await paintWholeWindow(b.id);
    await markResponded(env.DB, a.id, NOW.toISOString());
    await markResponded(env.DB, b.id, NOW.toISOString());

    await maybeBookOnAllIn(env, poll.id);

    const after = await getPoll(env.DB, poll.id);
    expect(after!.status).toBe("open");
    expect(calendar.getCreated()).toHaveLength(0);
    const row = await env.DB.prepare("SELECT poll_id FROM bookings WHERE poll_id = ?").bind(poll.id).first();
    expect(row).toBeNull();
  });

  it("an open poll with guestTokenHash set does not escalate on a disjoint intersection either — that would also block guest joins", async () => {
    const poll = await makePoll({ guestTokenHash: "hash-guest" });
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    const b = await addInvitee(poll.id, "b@x.com", "Bob");
    // Disjoint availability: no common candidate exists.
    await paintOnly(a.id, "2026-08-10T00:00:00Z", "2026-08-10T02:00:00Z"); // Mon 10:00-12:00 Sydney
    await paintOnly(b.id, "2026-08-11T00:00:00Z", "2026-08-11T02:00:00Z"); // Tue 10:00-12:00 Sydney
    await markResponded(env.DB, a.id, NOW.toISOString());
    await markResponded(env.DB, b.id, NOW.toISOString());

    await maybeBookOnAllIn(env, poll.id);

    const after = await getPoll(env.DB, poll.id);
    expect(after!.status).toBe("open");
    expect(after!.escalatedAt).toBeNull();
    expect(notification.sentPollEmails).toHaveLength(0);
  });

  it("a needs_attention poll with guestTokenHash still lets the dropInvitee rescue path book — joins are already impossible once escalated", async () => {
    const poll = await makePoll({ guestTokenHash: "hash-guest" });
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    const b = await addInvitee(poll.id, "b@x.com", "Bob"); // the blocker: never responds
    await paintWholeWindow(a.id);
    await markResponded(env.DB, a.id, NOW.toISOString());
    await setPollStatus(env.DB, poll.id, "needs_attention", NOW.toISOString());

    // Organiser drops the blocker; the handler then calls maybeBookOnAllIn.
    await dropInvitee(env.DB, b.id);
    await maybeBookOnAllIn(env, poll.id);

    const after = await getPoll(env.DB, poll.id);
    expect(after!.status).toBe("booked");
  });

  it("bookAtDeadline books an open guest-link poll normally — the deadline path is exempt from the guest-link wait", async () => {
    const poll = await makePoll({ guestTokenHash: "hash-guest" });
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    const b = await addInvitee(poll.id, "b@x.com", "Bob");
    await paintWholeWindow(a.id);
    await paintWholeWindow(b.id);
    await markResponded(env.DB, a.id, NOW.toISOString());
    await markResponded(env.DB, b.id, NOW.toISOString());
    __setForTests({ calendar, notification, now: () => AT_DEADLINE });

    await bookAtDeadline(env, poll.id);

    const after = await getPoll(env.DB, poll.id);
    expect(after!.status).toBe("booked");
    expect(calendar.getCreated()).toHaveLength(1);
  });
});

describe("bookAtDeadline re-checks the fresh deadline (review finding)", () => {
  it("does nothing when the freshly fetched deadline is still in the future — the sweep's due-ness snapshot can go stale behind a resolveMeetingPoll{extendDeadline}", async () => {
    // makePoll()'s default deadlineUtc ("2026-08-09T00:00:00Z") is still
    // 8 days out relative to the pinned clock (NOW, "2026-08-01T00:00:00Z")
    // from beforeEach — exactly the shape of a poll whose cron-loop due-ness
    // snapshot (poll-sweep.ts's sweepOnePoll, taken before this poll's turn
    // in the loop) was already stale by the time bookAtDeadline actually
    // runs, because an earlier poll in the same sweep did a multi-second
    // calendar round-trip and the organiser extended this poll's deadline in
    // that window.
    const poll = await makePoll();
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    await paintWholeWindow(a.id);
    await markResponded(env.DB, a.id, NOW.toISOString());

    await bookAtDeadline(env, poll.id);

    const after = await getPoll(env.DB, poll.id);
    expect(after!.status).toBe("open");
    expect(after!.escalatedAt).toBeNull();
    expect(calendar.getCreated()).toHaveLength(0);
    expect(notification.sentPollEmails).toHaveLength(0);
  });

  it("still escalates a guest-link poll at its (now-arrived) deadline on a disjoint intersection — the deadline path remains exempt from the guest-link wait", async () => {
    __setForTests({ calendar, notification, now: () => AT_DEADLINE });
    const poll = await makePoll({ guestTokenHash: "hash-guest" });
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    const b = await addInvitee(poll.id, "b@x.com", "Bob");
    // Disjoint availability: no common candidate exists.
    await paintOnly(a.id, "2026-08-10T00:00:00Z", "2026-08-10T02:00:00Z"); // Mon 10:00-12:00 Sydney
    await paintOnly(b.id, "2026-08-11T00:00:00Z", "2026-08-11T02:00:00Z"); // Tue 10:00-12:00 Sydney
    await markResponded(env.DB, a.id, NOW.toISOString());
    await markResponded(env.DB, b.id, NOW.toISOString());

    await bookAtDeadline(env, poll.id);

    const after = await getPoll(env.DB, poll.id);
    expect(after!.status).toBe("needs_attention");
    expect(after!.escalatedAt).toBeTruthy();
    expect(calendar.getCreated()).toHaveLength(0);
    expect(notification.sentPollEmails).toHaveLength(1);
  });
});

describe("claim races and staleness", () => {
  it("falls through to the next candidate when the top-ranked slot was already claimed by a pre-existing booking", async () => {
    const poll = await makePoll();
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    const b = await addInvitee(poll.id, "b@x.com", "Bob");
    await paintWholeWindow(a.id);
    await paintWholeWindow(b.id);
    await markResponded(env.DB, a.id, NOW.toISOString());
    await markResponded(env.DB, b.id, NOW.toISOString());

    // Pre-claim the earliest bookable Monday slot as an ordinary booking-page
    // booking, before the poll ever tries to book — a real prior claim, not a
    // simulated one.
    await claimSlot(env.DB, {
      ownerSubject: OWNER,
      slug: "poll-book",
      startUtc: "2026-08-09T23:00:00Z", // Mon 09:00 Sydney
      endUtc: "2026-08-09T23:30:00Z",
      durationMinutes: 30,
      bookerName: "Someone else",
      bookerEmail: "else@x.com",
      bookerNote: null,
      locationKind: "meet",
      locationDetail: null,
      ipHash: "prior",
      guardStartUtc: "2026-08-09T23:00:00Z",
      guardEndUtc: "2026-08-09T23:30:00Z",
      now: NOW,
    });

    await maybeBookOnAllIn(env, poll.id);

    const after = await getPoll(env.DB, poll.id);
    expect(after!.status).toBe("booked");
    expect(after!.bookedSlotUtc).not.toBe("2026-08-09T23:00:00.000Z");
    expect(after!.bookedSlotUtc).not.toBe("2026-08-09T23:00:00Z");
  });

  it("bookPollSlot lets exactly one of two concurrent calls for the identical slot win (atomic claim)", async () => {
    const poll = await makePoll();
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    await paintWholeWindow(a.id);
    await markResponded(env.DB, a.id, NOW.toISOString());

    const slot = "2026-08-09T23:00:00.000Z"; // Mon 09:00 Sydney
    const [x, y] = await Promise.all([
      bookPollSlot(env, poll.id, slot),
      bookPollSlot(env, poll.id, slot),
    ]);
    const outcomes = [x, y];
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.ok)).toHaveLength(1);
  });

  it("falls through when the candidate list changes between the rank pass and bookPollSlot's own re-check (stale winner)", async () => {
    const poll = await makePoll();
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    await paintWholeWindow(a.id);
    await markResponded(env.DB, a.id, NOW.toISOString());

    const stale = new StaleningCalendarProvider({
      id: "conflict",
      summary: "surprise meeting",
      // Covers the earliest bookable Monday slot only.
      start: "2026-08-09T23:00:00Z",
      end: "2026-08-10T00:00:00Z",
      extendedProperties: {},
    } as CalendarEvent);
    __setForTests({ calendar: stale, notification, now: () => NOW });

    await maybeBookOnAllIn(env, poll.id);

    const after = await getPoll(env.DB, poll.id);
    expect(after!.status).toBe("booked");
    // The stale (first-ranked) 09:00 Monday slot must have been skipped.
    expect(after!.bookedSlotUtc).not.toBe("2026-08-09T23:00:00.000Z");
    expect(stale.inner.getCreated()).toHaveLength(1);
  });
});

// W1 — candidateStarts (the grid) must never offer a slot that claimSlot's
// own overlap guard would then reject. Before the fix, a candidate ending
// exactly `after` minutes before an existing same-owner bookings row's start
// was still offered (the grid only widened the row by `before` on that
// side), so bookPollSlot proceeded past its own feasibility re-check straight
// into a claim that was always going to fail — silently, as `slot_taken` —
// rather than being turned away up front as infeasible. Live evidence,
// 2026-08-17: HIDDEN poll p_930ec249 (before:0, after:10) walked two such
// candidates (23:00Z, 2026-08-18T01:30Z) into `slot_taken` against adjacent
// booking rows and escalated to `needs_attention` with a real qualifying
// slot never actually tried.
describe("W1: candidateStarts excludes what claimSlot's guard would reject", () => {
  it("a frontier candidate ending exactly at an existing booking row's start is slot_not_feasible, not slot_taken", async () => {
    await saveBookingPage(env.DB, OWNER, {
      slug: "poll-book",
      enabled: true,
      hours: { days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" },
      horizon_days: 5,
      min_notice_minutes: 0,
      buffer_minutes: { before: 0, after: 10 },
    });
    const poll = await makePoll();

    // A pre-existing same-owner booking, Mon 09:30-10:00 Sydney.
    await claimSlot(env.DB, {
      ownerSubject: OWNER,
      slug: "poll-book",
      startUtc: "2026-08-09T23:30:00Z",
      endUtc: "2026-08-10T00:00:00Z",
      durationMinutes: 30,
      bookerName: "Someone else",
      bookerEmail: "else@x.com",
      bookerNote: null,
      locationKind: "meet",
      locationDetail: null,
      ipHash: "prior",
      guardStartUtc: "2026-08-09T23:30:00Z",
      guardEndUtc: "2026-08-10T00:00:00Z",
      now: NOW,
    });

    // The frontier candidate: Mon 09:00-09:30 Sydney, ending exactly where
    // the existing row starts. Pre-fix the grid offers it (bug); post-fix it
    // is excluded outright, so bookPollSlot never even attempts the claim.
    const outcome = await bookPollSlot(env, poll.id, "2026-08-09T23:00:00.000Z");
    expect(outcome.ok).toBe(false);
    expect((outcome as { reason: string }).reason).toBe("slot_not_feasible");
    expect(calendar.getCreated()).toHaveLength(0);
  });

  it("a candidate with at least `after` minutes' clearance from the same row still books fine", async () => {
    await saveBookingPage(env.DB, OWNER, {
      slug: "poll-book",
      enabled: true,
      hours: { days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" },
      horizon_days: 5,
      min_notice_minutes: 0,
      buffer_minutes: { before: 0, after: 10 },
    });
    const poll = await makePoll();

    await claimSlot(env.DB, {
      ownerSubject: OWNER,
      slug: "poll-book",
      startUtc: "2026-08-09T23:30:00Z",
      endUtc: "2026-08-10T00:00:00Z",
      durationMinutes: 30,
      bookerName: "Someone else",
      bookerEmail: "else@x.com",
      bookerNote: null,
      locationKind: "meet",
      locationDetail: null,
      ipHash: "prior",
      guardStartUtc: "2026-08-09T23:30:00Z",
      guardEndUtc: "2026-08-10T00:00:00Z",
      now: NOW,
    });

    // Mon 10:30-11:00 Sydney — 30 min clear of the existing row's end
    // (10:00), comfortably past the 10-min `after` requirement on the grid's
    // own 30-min step (the tight `after`-minutes boundary isn't expressible
    // as a candidate start here: candidates only land on :00/:30 UTC).
    const outcome = await bookPollSlot(env, poll.id, "2026-08-10T00:30:00.000Z");
    expect(outcome.ok).toBe(true);
    expect(calendar.getCreated()).toHaveLength(1);
  });
});

describe("event-create failure", () => {
  it("releases the claim (failBooking) and leaves the poll open", async () => {
    const poll = await makePoll();
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    await paintWholeWindow(a.id);
    await markResponded(env.DB, a.id, NOW.toISOString());

    const throwing = new ThrowingCreateCalendarProvider();
    __setForTests({ calendar: throwing, notification, now: () => NOW });

    const outcome = await bookPollSlot(env, poll.id, "2026-08-09T23:00:00.000Z");
    expect(outcome.ok).toBe(false);

    const after = await getPoll(env.DB, poll.id);
    expect(after!.status).toBe("open");
    expect(after!.gcalEventId).toBeNull();

    const row = await env.DB
      .prepare("SELECT status FROM bookings WHERE poll_id = ?")
      .bind(poll.id)
      .first<{ status: string }>();
    expect(row!.status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// FIX 1 (adversarial review, bookBest fix pass) — attemptBookOrEscalate's
// pre-existing behaviour on a transient calendar-write failure must NOT
// change: it keeps walking the ranked candidate list rather than aborting.
// This is what pins that behaviour so the bookBest-only abort added below
// can never regress it.
// ---------------------------------------------------------------------------

describe("FIX 1 regression: attemptBookOrEscalate keeps walking past a transient calendar-write failure", () => {
  it("books the second-ranked candidate after the top-ranked one fails to write", async () => {
    const failFirst = new FailFirstCreateCalendarProvider();
    __setForTests({ calendar: failFirst, notification, now: () => NOW });

    const poll = await makePoll();
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    await paintWholeWindow(a.id); // many candidates available, not just one
    await markResponded(env.DB, a.id, NOW.toISOString());

    await maybeBookOnAllIn(env, poll.id);

    const after = await getPoll(env.DB, poll.id);
    expect(after!.status).toBe("booked");
    expect(failFirst.calls).toBe(2); // 1 failed write + 1 successful write
    expect(failFirst.getCreated()).toHaveLength(1); // only the successful one is a real event
  });
});

describe("bookAtDeadline", () => {
  it("books among responders only (partial responders), ignoring anyone who never answered", async () => {
    const poll = await makePoll();
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    const b = await addInvitee(poll.id, "b@x.com", "Bob"); // never responds
    await paintWholeWindow(a.id);
    await markResponded(env.DB, a.id, NOW.toISOString());
    __setForTests({ calendar, notification, now: () => AT_DEADLINE });

    await bookAtDeadline(env, poll.id);

    const after = await getPoll(env.DB, poll.id);
    expect(after!.status).toBe("booked");
    const created = calendar.getCreated();
    expect(created[0]!.attendees?.map((x) => x.email)).toEqual(
      expect.arrayContaining(["a@x.com", "b@x.com"]),
    ); // still invited as an attendee — "required" only shrank for scoring
  });

  it("escalates and never books when zero invitees have responded", async () => {
    const poll = await makePoll();
    await addInvitee(poll.id, "a@x.com", "Alice");
    await addInvitee(poll.id, "b@x.com", "Bob");
    // Nobody responds.
    __setForTests({ calendar, notification, now: () => AT_DEADLINE });

    await bookAtDeadline(env, poll.id);

    const after = await getPoll(env.DB, poll.id);
    expect(after!.status).toBe("needs_attention");
    expect(calendar.getCreated()).toHaveLength(0);
    expect(notification.sentPollEmails).toHaveLength(1);
  });
});

describe("bookPollSlot — direct call", () => {
  it("returns ok:false without booking for an unknown poll id", async () => {
    const outcome = await bookPollSlot(env, "p_does_not_exist", "2026-08-09T23:00:00.000Z");
    expect(outcome.ok).toBe(false);
  });

  it("returns ok:false when the poll is already booked/closed", async () => {
    const poll = await makePoll();
    await setPollStatus(env.DB, poll.id, "cancelled", NOW.toISOString());
    const outcome = await bookPollSlot(env, poll.id, "2026-08-09T23:00:00.000Z");
    expect(outcome.ok).toBe(false);
  });
});

describe("loadMeetingFitCurve — live default (C-T9b)", () => {
  it("returns the '__default__' meeting triple for a subject with no own config_contexts rows", async () => {
    // OWNER has never customised config_contexts, so this reads '__default__'
    // — migration 0005 collapsed the original multi-window seed into exactly
    // this single-window shape, and 0007/0017 carry it forward unchanged.
    const curve = await loadMeetingFitCurve(env.DB, OWNER);
    expect(curve).toEqual({ peak_start: "10:00", peak_end: "11:00", falloff_end: "17:00" });
  });

  it("returns the '__default__' meeting triple for a subject with a custom row for another context but no custom 'meeting' row (per-context merge)", async () => {
    // A user who customised only `deep` must NOT lose the default meeting
    // curve here — poll ranking has to follow the same per-context merge the
    // resolve pipeline uses (db/context-config.ts), not the pre-Card-A
    // wholesale policy.
    const deepBody = await env.DB.prepare(
      "SELECT body FROM config_contexts WHERE owner_subject = '__default__' AND context = 'deep'",
    ).first<{ body: string }>();
    await env.DB.prepare(
      "INSERT INTO config_contexts (owner_subject, context, body) VALUES (?, 'deep', ?)",
    )
      .bind(OWNER, deepBody!.body)
      .run();
    const curve = await loadMeetingFitCurve(env.DB, OWNER);
    expect(curve).toEqual({ peak_start: "10:00", peak_end: "11:00", falloff_end: "17:00" });
  });

  it("feeds a real (non-flat) curve into scoring: organiserFit prefers 10:30 Sydney (inside the peak window) over 16:30 (near falloff_end)", async () => {
    const curve = await loadMeetingFitCurve(env.DB, OWNER);
    expect(curve).not.toBeNull();
    const tz = "Australia/Sydney";
    const durationMin = 30;
    const morning = "2026-08-10T00:30:00Z"; // Mon 10:30 Sydney (AEST +10)
    const afternoon = "2026-08-10T06:30:00Z"; // Mon 16:30 Sydney

    const morningFit = organiserFit(curve!, morning, durationMin, tz);
    const afternoonFit = organiserFit(curve!, afternoon, durationMin, tz);
    expect(morningFit).toBeGreaterThan(afternoonFit);
    expect(morningFit).toBe(1); // fully inside [peak_start, peak_end]

    // Cell keys must match scoring.ts's own cellsOverlappingSlot output
    // exactly, which builds them via `new Date(ms).toISOString()` — always
    // millisecond-precision (".000Z"). A 30-min slot starting on a cell
    // boundary overlaps exactly one cell (its own start), so only that key
    // is needed.
    const invitee = "inv-1";
    const responses: InviteeResponse[] = [
      {
        inviteeId: invitee,
        cells: new Map([
          [new Date(morning).toISOString(), "free"],
          [new Date(afternoon).toISOString(), "free"],
        ]),
      },
    ];
    const ranked = rankCandidates([morning, afternoon], responses, [invitee], curve!, durationMin, tz);
    expect(ranked).toHaveLength(2);
    expect(ranked[0]!.slotStartUtc).toBe(morning); // best-first: the peak-window slot ranks ahead
  });
});

describe("bookPollSlot — location detail per kind (organiser is the sole detail-supplier)", () => {
  async function bookWithLocation(location: { kind: string; detail?: string | null }) {
    const poll = await makePoll({ location });
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    await paintWholeWindow(a.id);
    await markResponded(env.DB, a.id, NOW.toISOString());
    await maybeBookOnAllIn(env, poll.id);
    const after = await getPoll(env.DB, poll.id);
    expect(after!.status).toBe("booked");
    return calendar.getCreated().at(-1)!;
  }

  it("meet: addMeet true, no location string", async () => {
    const event = await bookWithLocation({ kind: "meet" });
    expect(calendar.createOptions.at(-1)).toMatchObject({ addMeet: true });
    expect(event.location).toBeUndefined();
  });

  it("phone: event location carries the organiser's number, prefixed", async () => {
    const event = await bookWithLocation({ kind: "phone", detail: "+61 400 000 000" });
    expect(event.location).toBe("Phone: +61 400 000 000");
    expect(calendar.createOptions.at(-1)).toMatchObject({ addMeet: false });
  });

  it("in_person: event location carries the organiser's address verbatim", async () => {
    const event = await bookWithLocation({ kind: "in_person", detail: "123 Main St" });
    expect(event.location).toBe("123 Main St");
  });

  it("custom: event location carries the organiser's custom text verbatim", async () => {
    const event = await bookWithLocation({ kind: "custom", detail: "Room 4B" });
    expect(event.location).toBe("Room 4B");
  });
});

// ---------------------------------------------------------------------------
// C-T9 round B — race-condition regression suite, adapted from the reviewer's
// preserved PoC at scratchpad/r3-races.poc.test.ts (F1, F1b, F2, F3, F4, F7).
// Each test asserts the DESIRED behaviour, so it was red-as-proof against the
// pre-correction code (except F7, a green control).
// ---------------------------------------------------------------------------

const MON_0900 = "2026-08-09T23:00:00.000Z"; // Mon 2026-08-10 09:00 Sydney

describe("F1: poll-level double-book", () => {
  it("two concurrent maybeBookOnAllIn calls create at most ONE calendar event for the poll", async () => {
    const cal = new GatedCalendar();
    __setForTests({ calendar: cal, notification, now: () => NOW });

    const poll = await makePoll();
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    const b = await addInvitee(poll.id, "b@x.com", "Bob");
    await paintWholeWindow(a.id);
    await paintWholeWindow(b.id);
    await markResponded(env.DB, a.id, NOW.toISOString());
    await markResponded(env.DB, b.id, NOW.toISOString());

    // Invitee A's PUT fires the all-in check; it claims its winner and is now
    // awaiting Google's createEvent.
    const first = maybeBookOnAllIn(env, poll.id);
    await cal.firstStarted.promise;

    // Invitee B's near-simultaneous PUT fires a second all-in check. The poll
    // row still says "open" (setBooked has not run yet).
    await maybeBookOnAllIn(env, poll.id);

    cal.release();
    await first;

    expect(cal.getCreated()).toHaveLength(1);
  });

  it("a booking-page claim for a non-overlapping slot still succeeds while a poll booking is live (inert for booking-page callers)", async () => {
    const poll = await makePoll();
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    await paintWholeWindow(a.id);
    await markResponded(env.DB, a.id, NOW.toISOString());

    const outcome = await bookPollSlot(env, poll.id, MON_0900);
    expect(outcome.ok).toBe(true);

    // A booking-page claim (no pollId) for a DIFFERENT, non-overlapping slot
    // must be unaffected by the poll-scoped exclusion.
    const pageClaim = await claimSlot(env.DB, {
      ownerSubject: OWNER,
      slug: "poll-book",
      startUtc: "2026-08-10T23:00:00Z", // Tue 09:00 Sydney
      endUtc: "2026-08-10T23:30:00Z",
      durationMinutes: 30,
      bookerName: "Someone else",
      bookerEmail: "else@x.com",
      bookerNote: null,
      locationKind: "meet",
      locationDetail: null,
      ipHash: "page",
      guardStartUtc: "2026-08-10T23:00:00Z",
      guardEndUtc: "2026-08-10T23:30:00Z",
      now: NOW,
    });
    expect(pageClaim).not.toBeNull();
  });
});

describe("F1b: deadline sweep vs all-in trigger", () => {
  it("a cron bookAtDeadline racing a response-triggered maybeBookOnAllIn creates ONE event", async () => {
    const cal = new GatedCalendar();
    __setForTests({ calendar: cal, notification, now: () => AT_DEADLINE });

    const poll = await makePoll();
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    await paintWholeWindow(a.id);
    await markResponded(env.DB, a.id, NOW.toISOString());

    const cron = bookAtDeadline(env, poll.id);
    await cal.firstStarted.promise;
    await maybeBookOnAllIn(env, poll.id);
    cal.release();
    await cron;

    expect(cal.getCreated()).toHaveLength(1);
  });
});

describe("F7: claim release (control — expected to pass)", () => {
  it("a slot released by failBooking can be claimed again", async () => {
    const throwing = new ThrowingCreateCalendarProvider();
    __setForTests({ calendar: throwing, notification, now: () => NOW });

    const poll = await makePoll();
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    await paintWholeWindow(a.id);
    await markResponded(env.DB, a.id, NOW.toISOString());

    const failed = await bookPollSlot(env, poll.id, MON_0900);
    expect(failed.ok).toBe(false);

    const working = new MockCalendarProvider();
    __setForTests({ calendar: working, notification, now: () => NOW });
    const retry = await bookPollSlot(env, poll.id, MON_0900);
    expect(retry.ok).toBe(true);
  });
});

describe("F2: escalate() clobbers a booked poll", () => {
  it("a concurrent attempt that finds no free candidate must not flip a just-booked poll to needs_attention", async () => {
    // Exactly one bookable candidate in the whole range: Mon 09:00-09:30.
    await saveBookingPage(env.DB, OWNER, {
      slug: "poll-book",
      enabled: true,
      hours: { days: ["mon"], start: "09:00", end: "09:30" },
      horizon_days: 5,
      min_notice_minutes: 0,
      buffer_minutes: { before: 0, after: 0 },
    });

    const cal = new GatedCalendar();
    __setForTests({ calendar: cal, notification, now: () => NOW });

    const poll = await makePoll();
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    const b = await addInvitee(poll.id, "b@x.com", "Bob");
    await paintWholeWindow(a.id);
    await paintWholeWindow(b.id);
    await markResponded(env.DB, a.id, NOW.toISOString());
    await markResponded(env.DB, b.id, NOW.toISOString());

    // First claims the only slot (its 'reserving' bookings row is written
    // before createEvent is called) and is now awaiting Google's createEvent.
    const first = maybeBookOnAllIn(env, poll.id);
    await cal.firstStarted.promise;

    // Second trigger: the only slot is now reserved FOR THIS POLL, so its own
    // ranking pass finds nothing (the first attempt's reserving row shadows
    // it as generically busy) and it heads for escalate() — which must see
    // the poll's own live booking row and stand down without ever emailing,
    // rather than racing the winner. No gating needed: with the fix, this
    // resolves without touching the calendar or the notification provider.
    await maybeBookOnAllIn(env, poll.id);

    // First finishes: real event created, poll marked booked.
    cal.release();
    await first;

    const after = await getPoll(env.DB, poll.id);
    expect(after!.status).toBe("booked");
    expect(after!.escalatedAt).toBeNull();
    // The real invariant under test: the concurrent escalate() attempt must
    // stand down without ever emailing. The one email that DOES go out is
    // the winner's own organiser booked-notification (T-notify) — not an
    // escalation, so assert on subject rather than a bare zero count.
    expect(notification.sentPollEmails).toHaveLength(1);
    expect(notification.sentPollEmails[0]!.subject.toLowerCase()).not.toContain("action needed");
  });
});

describe("F3: cancel-during-book", () => {
  it("a poll cancelled while a booking is mid-flight stays cancelled, and the orphaned event is deleted + claim released", async () => {
    const cal = new GatedCalendar();
    __setForTests({ calendar: cal, notification, now: () => NOW });

    const poll = await makePoll();
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    await paintWholeWindow(a.id);
    await markResponded(env.DB, a.id, NOW.toISOString());

    const first = maybeBookOnAllIn(env, poll.id);
    await cal.firstStarted.promise;

    // Organiser hits cancelMeetingPoll. Its own guard sees status='open' (the
    // booking has not committed), so it passes and writes 'cancelled' — this
    // is verbatim what handlers/polls.ts's cancel route does.
    await setPollStatus(env.DB, poll.id, "cancelled", NOW.toISOString());

    cal.release();
    await first;

    const after = await getPoll(env.DB, poll.id);
    expect(after!.status).toBe("cancelled");
    expect(cal.getDeleted()).toEqual(cal.getCreated().map((e) => e.id));
    expect(cal.getDeleted()).toHaveLength(1);

    const row = await env.DB
      .prepare("SELECT status FROM bookings WHERE poll_id = ?")
      .bind(poll.id)
      .first<{ status: string }>();
    expect(row!.status).toBe("failed");
  });
});

describe("T-notify: organiser booked notification", () => {
  it("emails the organiser after a successful booking, naming the slot, duration, and attendees", async () => {
    const poll = await makePoll({ title: "Launch review" });
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    const b = await addInvitee(poll.id, "b@x.com", "Bob");
    await paintWholeWindow(a.id);
    await paintWholeWindow(b.id);
    await markResponded(env.DB, a.id, NOW.toISOString());
    await markResponded(env.DB, b.id, NOW.toISOString());

    await maybeBookOnAllIn(env, poll.id);

    const after = await getPoll(env.DB, poll.id);
    expect(after!.status).toBe("booked");
    const booked = notification.sentPollEmails.filter(
      (e) => e.to === OWNER && e.subject.includes("Launch review"),
    );
    expect(booked).toHaveLength(1);
    expect(booked[0]!.text).toContain("Alice");
    expect(booked[0]!.text).toContain("Bob");
    expect(booked[0]!.text).toContain("30 minutes");
  });

  it("names a hidden invitee's real name to the organiser even though they're excluded from the calendar invite", async () => {
    const poll = await makePoll({ title: "Launch review" });
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    const b = await addInvitee(poll.id, "b@x.com", "Bob");
    await setHideName(env.DB, b.id, true);
    await paintWholeWindow(a.id);
    await paintWholeWindow(b.id);
    await markResponded(env.DB, a.id, NOW.toISOString());
    await markResponded(env.DB, b.id, NOW.toISOString());

    await maybeBookOnAllIn(env, poll.id);

    const booked = notification.sentPollEmails.find(
      (e) => e.to === OWNER && e.subject.includes("Launch review"),
    );
    expect(booked).toBeTruthy();
    expect(booked!.text).toContain("Bob"); // organiser sees the real name, never the pseudonym
  });

  it("sends no organiser booked email when the calendar write fails", async () => {
    const poll = await makePoll();
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    await paintWholeWindow(a.id);
    await markResponded(env.DB, a.id, NOW.toISOString());

    const throwing = new ThrowingCreateCalendarProvider();
    __setForTests({ calendar: throwing, notification, now: () => NOW });

    const outcome = await bookPollSlot(env, poll.id, "2026-08-09T23:00:00.000Z");
    expect(outcome.ok).toBe(false);
    expect(notification.sentPollEmails).toHaveLength(0);
  });

  it("sends no organiser booked email when the poll is cancelled mid-flight (CAS-to-booked lost)", async () => {
    const cal = new GatedCalendar();
    __setForTests({ calendar: cal, notification, now: () => NOW });

    const poll = await makePoll();
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    await paintWholeWindow(a.id);
    await markResponded(env.DB, a.id, NOW.toISOString());

    const first = maybeBookOnAllIn(env, poll.id);
    await cal.firstStarted.promise;
    await setPollStatus(env.DB, poll.id, "cancelled", NOW.toISOString());
    cal.release();
    await first;

    const after = await getPoll(env.DB, poll.id);
    expect(after!.status).toBe("cancelled");
    expect(notification.sentPollEmails).toHaveLength(0);
  });

  it("a booked-notification send failure is logged and does not fail the booking", async () => {
    const poll = await makePoll({ title: "Launch review" });
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    await paintWholeWindow(a.id);
    await markResponded(env.DB, a.id, NOW.toISOString());

    const failingNotification = new MockNotificationProvider();
    failingNotification.sendPollEmail = async () => {
      throw new Error("smtp unavailable");
    };
    __setForTests({ calendar, notification: failingNotification, now: () => NOW });
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    await maybeBookOnAllIn(env, poll.id);

    const after = await getPoll(env.DB, poll.id);
    expect(after!.status).toBe("booked"); // the event booking itself still succeeded
    expect(calendar.getCreated()).toHaveLength(1);

    expect(consoleErr).toHaveBeenCalled();
    // Pins two things together (finding 5): the log must carry the poll id
    // (so it's actually diagnosable) AND must never carry the organiser's
    // address. The not.toContain(OWNER) half only catches OUR code splicing
    // the address in directly — String(err)'s own content is the
    // notification provider's responsibility (same pre-existing pattern as
    // the hidden-invitee failure log above), not something this call site
    // controls or needs to re-verify.
    const joinedLogs = consoleErr.mock.calls.map((call) => call.map((a) => String(a)).join(" "));
    expect(joinedLogs.some((joined) => joined.includes(poll.id))).toBe(true);
    for (const joined of joinedLogs) {
      expect(joined).not.toContain(OWNER);
    }

    consoleErr.mockRestore();
  });

  it("bookPollSlot still returns {ok:true} when the organiser booked-notification fails (findings 2/3: nothing after confirmBooking may escape uncaught)", async () => {
    const poll = await makePoll();
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    await paintWholeWindow(a.id);
    await markResponded(env.DB, a.id, NOW.toISOString());

    const failingNotification = new MockNotificationProvider();
    failingNotification.sendPollEmail = async () => {
      throw new Error("smtp unavailable");
    };
    __setForTests({ calendar, notification: failingNotification, now: () => NOW });
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    // Direct call (not via maybeBookOnAllIn) so the return value itself —
    // not just the poll's eventual DB status — is asserted: a throw
    // escaping bookPollSlotInternal after confirmBooking would otherwise
    // surface as an unhandled rejection here, not a clean {ok:false}.
    const outcome = await bookPollSlot(env, poll.id, "2026-08-09T23:00:00.000Z");
    expect(outcome).toEqual({ ok: true, eventId: expect.any(String) });

    consoleErr.mockRestore();
  });

  it("does not re-query the organiser's home timezone for the booked email (finding 2: reuses the live availability.tz already computed for the feasibility re-check)", async () => {
    const poll = await makePoll();
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    await paintWholeWindow(a.id);
    await markResponded(env.DB, a.id, NOW.toISOString());

    const prepareSpy = vi.spyOn(env.DB, "prepare");

    // Direct call: bookPollSlotInternal's own single assembleAvailability
    // re-check is the ONLY place that should read the users table in this
    // call — attemptBookOrEscalate's separate ranking pass (maybeBookOnAllIn)
    // would add its own, unrelated read and confuse the count.
    const outcome = await bookPollSlot(env, poll.id, "2026-08-09T23:00:00.000Z");
    expect(outcome.ok).toBe(true);

    const usersQueries = prepareSpy.mock.calls.filter(([sql]) => String(sql).includes("FROM users WHERE subject"));
    expect(usersQueries).toHaveLength(1);

    prepareSpy.mockRestore();
  });

  it("adds a Where line pointing at the calendar event for a default (Google Meet) poll booking (finding 4)", async () => {
    const poll = await makePoll({ title: "Launch review", location: { kind: "meet" } });
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    await paintWholeWindow(a.id);
    await markResponded(env.DB, a.id, NOW.toISOString());

    await maybeBookOnAllIn(env, poll.id);

    const booked = notification.sentPollEmails.find((e) => e.to === OWNER && e.subject.includes("Launch review"));
    expect(booked).toBeTruthy();
    expect(booked!.text).toContain("Where:");
    expect(booked!.text).toContain("Google Meet");
  });
});

describe("finding 6: booked email reflects actual hidden-notice send outcomes, not intent", () => {
  it("lists a hidden invitee under 'notified privately' when their booking-notice email actually sent", async () => {
    const poll = await makePoll({ title: "Launch review" });
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    const b = await addInvitee(poll.id, "b@x.com", "Bob");
    await setHideName(env.DB, b.id, true);
    await paintWholeWindow(a.id);
    await paintWholeWindow(b.id);
    await markResponded(env.DB, a.id, NOW.toISOString());
    await markResponded(env.DB, b.id, NOW.toISOString());

    await maybeBookOnAllIn(env, poll.id);

    const booked = notification.sentPollEmails.find((e) => e.to === OWNER && e.subject.includes("Launch review"));
    expect(booked).toBeTruthy();
    expect(booked!.text).toMatch(/Notified privately.*Bob/);
    expect(booked!.text.toLowerCase()).not.toContain("could not notify");
  });

  it("lists a hidden invitee under 'could not notify', not 'notified privately', when their booking-notice email failed to send", async () => {
    const poll = await makePoll({ title: "Launch review" });
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    const b = await addInvitee(poll.id, "b@x.com", "Bob");
    await setHideName(env.DB, b.id, true);
    await paintWholeWindow(a.id);
    await paintWholeWindow(b.id);
    await markResponded(env.DB, a.id, NOW.toISOString());
    await markResponded(env.DB, b.id, NOW.toISOString());

    // Fails ONLY the hidden invitee's own booking-notice send (to ===
    // b@x.com) — the organiser's own booked email must still succeed so the
    // "could not notify" line has somewhere to be observed.
    class SelectiveFailNotification extends MockNotificationProvider {
      async sendPollEmail(email: PollEmail): Promise<void> {
        if (email.to === "b@x.com") throw new Error("smtp unavailable");
        return super.sendPollEmail(email);
      }
    }
    const selective = new SelectiveFailNotification();
    __setForTests({ calendar, notification: selective, now: () => NOW });
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    await maybeBookOnAllIn(env, poll.id);

    const booked = selective.sentPollEmails.find((e) => e.to === OWNER && e.subject.includes("Launch review"));
    expect(booked).toBeTruthy();
    expect(booked!.text).toMatch(/[Cc]ould not notify.*Bob/);
    expect(booked!.text).not.toMatch(/Notified privately.*Bob/);

    consoleErr.mockRestore();
  });
});

describe("F4: needs_attention absorbing trap", () => {
  it("resolveMeetingPoll{action:'book'} can book an escalated (needs_attention) poll", async () => {
    const poll = await makePoll();
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    await paintWholeWindow(a.id);
    await markResponded(env.DB, a.id, NOW.toISOString());
    // The poll escalated (empty intersection at the deadline), exactly the
    // state the escalation email tells the organiser to resolve.
    await setPollStatus(env.DB, poll.id, "needs_attention", NOW.toISOString());

    const outcome = await bookPollSlot(env, poll.id, MON_0900);
    expect(outcome.ok).toBe(true);
  });

  it("resolveMeetingPoll{action:'dropInvitee'} re-books an escalated poll once the blocker is dropped", async () => {
    const poll = await makePoll();
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    const b = await addInvitee(poll.id, "b@x.com", "Bob"); // the blocker: never responds
    await paintWholeWindow(a.id);
    await markResponded(env.DB, a.id, NOW.toISOString());
    await setPollStatus(env.DB, poll.id, "needs_attention", NOW.toISOString());

    // Organiser drops the blocker; the handler then calls maybeBookOnAllIn.
    await dropInvitee(env.DB, b.id);
    await maybeBookOnAllIn(env, poll.id);

    const after = await getPoll(env.DB, poll.id);
    expect(after!.status).toBe("booked");
  });
});

// ---------------------------------------------------------------------------
// bookBestNow — resolveMeetingPoll{action:"bookBest"}'s engine: ranks with
// whoever has responded (bookAtDeadline's exact required-set rule) and books
// synchronously, on demand, pre-deadline. Unlike attemptBookOrEscalate's other
// two callers, a failure here must NEVER escalate (locked design decision 1).
// ---------------------------------------------------------------------------

describe("bookBestNow", () => {
  it("books the top-ranked slot ranked against the single responder; the non-responder is still invited on the event", async () => {
    const poll = await makePoll();
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    await addInvitee(poll.id, "b@x.com", "Bob"); // never responds
    await paintWholeWindow(a.id);
    await markResponded(env.DB, a.id, NOW.toISOString());

    const outcome = await bookBestNow(env, poll.id);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    // Pinned, not just "truthy" (FIX 3): the whole window is painted free, so
    // the default 'meeting' fit curve's peak (10:00-11:00 Sydney) decides the
    // top-ranked candidate — the earliest Monday in range at its peak start.
    expect(outcome.slotStartUtc).toBe("2026-08-10T00:00:00.000Z"); // Mon 10:00 Sydney
    expect(outcome.eventId).toBeTruthy();

    const created = calendar.getCreated();
    expect(created).toHaveLength(1);
    expect(created[0]!.start).toBe("2026-08-10T00:00:00.000Z");
    expect(created[0]!.attendees?.map((x) => x.email).sort()).toEqual(["a@x.com", "b@x.com"]);

    const after = await getPoll(env.DB, poll.id);
    expect(after!.status).toBe("booked");
    expect(after!.bookedSlotUtc).toBe(outcome.slotStartUtc);
  });

  it("parity: books the same slot bookAtDeadline would book, given identical responses (FIX 4: 2 invitees, only 1 responds, so a wrong required-set rule would actually fail this)", async () => {
    // A distinct organiser subject for pollB — reusing OWNER for both would
    // have pollA's own booking occupy OWNER's booking-page slug/hours, so
    // pollB's candidate list would (correctly) exclude the very slot this
    // test wants to prove they'd both pick.
    const OWNER2 = "poll-book-parity@org";
    await saveBookingPage(env.DB, OWNER2, {
      slug: "poll-book-parity",
      enabled: true,
      hours: { days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" },
      horizon_days: 5,
      min_notice_minutes: 0,
      buffer_minutes: { before: 0, after: 0 },
    });

    // TWO invitees on each poll, but only Alice ever responds (paints the
    // whole window free) — Bob never paints anything. If bookBestNow's
    // required set wrongly included non-responders like Bob, ranking would
    // score every candidate null (Bob's unpainted cells -> coverage "none")
    // and this poll would come back no_qualifying_slot instead of matching
    // bookAtDeadline's own (correctly Bob-excluding) booked slot.
    const pollA = await makePoll();
    const a1 = await addInvitee(pollA.id, "a@x.com", "Alice");
    await addInvitee(pollA.id, "b@x.com", "Bob"); // never responds
    await paintWholeWindow(a1.id);
    await markResponded(env.DB, a1.id, NOW.toISOString());

    const outcome = await bookBestNow(env, pollA.id);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");

    // Fresh poll (different organiser, identical painted data), run through
    // bookAtDeadline instead. A FRESH calendar mock too — MockCalendarProvider
    // isn't subject-scoped (unlike the real per-subject provider resolveCalendar
    // builds), so reusing the same one would have pollA's just-created event
    // show up as pollB's own busy time.
    const pollB = await makePoll({ subject: OWNER2 });
    const a2 = await addInvitee(pollB.id, "a@x.com", "Alice");
    await addInvitee(pollB.id, "b@x.com", "Bob"); // never responds
    await paintWholeWindow(a2.id);
    await markResponded(env.DB, a2.id, NOW.toISOString());
    __setForTests({ calendar: new MockCalendarProvider(), notification, now: () => AT_DEADLINE });

    await bookAtDeadline(env, pollB.id);
    const afterB = await getPoll(env.DB, pollB.id);
    expect(afterB!.status).toBe("booked");
    expect(afterB!.bookedSlotUtc).toBe(outcome.slotStartUtc);
  });

  it("returns no_qualifying_slot when the responder painted nothing free, leaving status/escalatedAt untouched and no emails", async () => {
    const poll = await makePoll();
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    await markResponded(env.DB, a.id, NOW.toISOString()); // responded, but never painted anything free
    await addInvitee(poll.id, "b@x.com", "Bob"); // never responds

    const outcome = await bookBestNow(env, poll.id);

    expect(outcome).toEqual({ ok: false, reason: "no_qualifying_slot" });
    const after = await getPoll(env.DB, poll.id);
    expect(after!.status).toBe("open");
    expect(after!.escalatedAt).toBeNull();
    expect(calendar.getCreated()).toHaveLength(0);
    expect(notification.sentPollEmails).toHaveLength(0);
  });

  it("returns no_responders and leaves the poll untouched when nobody has responded", async () => {
    const poll = await makePoll();
    await addInvitee(poll.id, "a@x.com", "Alice");
    await addInvitee(poll.id, "b@x.com", "Bob");

    const outcome = await bookBestNow(env, poll.id);

    expect(outcome).toEqual({ ok: false, reason: "no_responders" });
    const after = await getPoll(env.DB, poll.id);
    expect(after!.status).toBe("open");
    expect(after!.escalatedAt).toBeNull();
    expect(calendar.getCreated()).toHaveLength(0);
    expect(notification.sentPollEmails).toHaveLength(0);
  });

  it("books a guest-link poll while still open and pre-deadline — the guest-join wait guards automatic triggers only, not this organiser override", async () => {
    const poll = await makePoll({ guestTokenHash: "hash-guest" });
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    await paintWholeWindow(a.id);
    await markResponded(env.DB, a.id, NOW.toISOString());

    const outcome = await bookBestNow(env, poll.id);

    expect(outcome.ok).toBe(true);
    const after = await getPoll(env.DB, poll.id);
    expect(after!.status).toBe("booked");
  });

  it("books an escalated (needs_attention) poll — a rescue, same as the explicit book action", async () => {
    const poll = await makePoll();
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    await paintWholeWindow(a.id);
    await markResponded(env.DB, a.id, NOW.toISOString());
    await setPollStatus(env.DB, poll.id, "needs_attention", NOW.toISOString());

    const outcome = await bookBestNow(env, poll.id);

    expect(outcome.ok).toBe(true);
    const after = await getPoll(env.DB, poll.id);
    expect(after!.status).toBe("booked");
  });

  it("stays needs_attention (does not escalate further) when a needs_attention poll still has no qualifying slot", async () => {
    const poll = await makePoll();
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    await markResponded(env.DB, a.id, NOW.toISOString()); // never painted
    await setPollStatus(env.DB, poll.id, "needs_attention", NOW.toISOString());

    const outcome = await bookBestNow(env, poll.id);

    expect(outcome).toEqual({ ok: false, reason: "no_qualifying_slot" });
    const after = await getPoll(env.DB, poll.id);
    expect(after!.status).toBe("needs_attention");
    expect(notification.sentPollEmails).toHaveLength(0);
  });

  it.each(["booked", "cancelled"] as const)("returns poll_not_actionable for a %s poll", async (status) => {
    const poll = await makePoll();
    await setPollStatus(env.DB, poll.id, status, NOW.toISOString());

    const outcome = await bookBestNow(env, poll.id);

    expect(outcome).toEqual({ ok: false, reason: "poll_not_actionable" });
  });

  it("returns poll_not_found for an unknown poll id", async () => {
    const outcome = await bookBestNow(env, "p_does_not_exist");
    expect(outcome).toEqual({ ok: false, reason: "poll_not_found" });
  });

  it("returns poll_already_claimed (no escalation) when a concurrent attempt already holds this poll's live booking", async () => {
    // Exactly one bookable candidate in the whole range: Mon 09:00-09:30.
    await saveBookingPage(env.DB, OWNER, {
      slug: "poll-book",
      enabled: true,
      hours: { days: ["mon"], start: "09:00", end: "09:30" },
      horizon_days: 5,
      min_notice_minutes: 0,
      buffer_minutes: { before: 0, after: 0 },
    });

    const cal = new GatedCalendar();
    __setForTests({ calendar: cal, notification, now: () => NOW });

    const poll = await makePoll();
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    await paintWholeWindow(a.id);
    await markResponded(env.DB, a.id, NOW.toISOString());

    // First call claims the only slot and is now awaiting Google's createEvent.
    const first = bookBestNow(env, poll.id);
    await cal.firstStarted.promise;

    // Second call, mid-flight: the only slot is already reserved for this
    // poll, so its own ranking pass finds nothing — must stand down with
    // poll_already_claimed rather than reporting no_qualifying_slot.
    const second = await bookBestNow(env, poll.id);
    expect(second).toEqual({ ok: false, reason: "poll_already_claimed" });

    cal.release();
    const firstResult = await first;
    expect(firstResult.ok).toBe(true);

    const after = await getPoll(env.DB, poll.id);
    expect(after!.status).toBe("booked");
    // No escalation email ever — only the winner's own booked-notification.
    expect(notification.sentPollEmails).toHaveLength(1);
    expect(notification.sentPollEmails[0]!.subject.toLowerCase()).not.toContain("action needed");
  });

  it("returns calendar_unavailable (not a throw) when the calendar provider throws while computing candidates", async () => {
    const poll = await makePoll();
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    await paintWholeWindow(a.id);
    await markResponded(env.DB, a.id, NOW.toISOString());

    class ThrowingFetchCalendar extends MockCalendarProvider {
      async fetchEventsInWindow(): ReturnType<CalendarProvider["fetchEventsInWindow"]> {
        throw new Error("google down");
      }
    }
    __setForTests({ calendar: new ThrowingFetchCalendar(), notification, now: () => NOW });

    const outcome = await bookBestNow(env, poll.id);

    expect(outcome).toEqual({ ok: false, reason: "calendar_unavailable" });
    const after = await getPoll(env.DB, poll.id);
    expect(after!.status).toBe("open");
    expect(notification.sentPollEmails).toHaveLength(0);
  });

  it("FIX 1: aborts on the FIRST calendar-write failure (calendar_unavailable), never walking the remaining ranked candidates", async () => {
    const poll = await makePoll();
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    await paintWholeWindow(a.id); // many ranked candidates available, not just one
    await markResponded(env.DB, a.id, NOW.toISOString());

    const throwing = new ThrowingCreateCalendarProvider();
    __setForTests({ calendar: throwing, notification, now: () => NOW });

    const outcome = await bookBestNow(env, poll.id);

    expect(outcome).toEqual({ ok: false, reason: "calendar_unavailable" });
    // The regression this pins: pre-fix, a write failure was treated like
    // any other non-ok reason and the walk kept trying every remaining
    // ranked candidate (each one also failing), reporting no_qualifying_slot
    // at the end instead of surfacing the real outage.
    expect(throwing.calls).toBe(1);
    const after = await getPoll(env.DB, poll.id);
    expect(after!.status).toBe("open");
    expect(notification.sentPollEmails).toHaveLength(0);
  });

  it("FIX 2: a poll cancelled mid-flight (during createEvent) reports poll_not_actionable, not no_qualifying_slot", async () => {
    // Exactly one bookable candidate, so a naive implementation that keeps
    // walking on poll_not_open would otherwise exhaust the ranked list and
    // fall through to no_qualifying_slot.
    await saveBookingPage(env.DB, OWNER, {
      slug: "poll-book",
      enabled: true,
      hours: { days: ["mon"], start: "09:00", end: "09:30" },
      horizon_days: 5,
      min_notice_minutes: 0,
      buffer_minutes: { before: 0, after: 0 },
    });

    const cal = new GatedCalendar();
    __setForTests({ calendar: cal, notification, now: () => NOW });

    const poll = await makePoll();
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    await paintWholeWindow(a.id);
    await markResponded(env.DB, a.id, NOW.toISOString());

    const first = bookBestNow(env, poll.id);
    await cal.firstStarted.promise; // claim taken, createEvent in flight

    // Organiser (or something else) cancels the poll while the calendar
    // write is still outstanding.
    await setPollStatus(env.DB, poll.id, "cancelled", NOW.toISOString());

    cal.release();
    const result = await first;

    expect(result).toEqual({ ok: false, reason: "poll_not_actionable" });
    const after = await getPoll(env.DB, poll.id);
    expect(after!.status).toBe("cancelled"); // untouched by the failed booking
    expect(cal.getDeleted()).toHaveLength(1); // the orphaned event was cleaned up
    expect(notification.sentPollEmails).toHaveLength(0); // no escalation, no false booked email
  });

  it("FIX 5a: a dropped invitee who responded is excluded from both ranking and the booked event's attendees", async () => {
    const poll = await makePoll();
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    const b = await addInvitee(poll.id, "b@x.com", "Bob");
    await paintWholeWindow(a.id);
    // Bob paints a DISJOINT slice only — if his response still constrained
    // ranking despite being dropped, no candidate would qualify at all.
    await paintOnly(b.id, "2026-08-11T00:00:00Z", "2026-08-11T02:00:00Z"); // Tue 10:00-12:00 Sydney
    await markResponded(env.DB, a.id, NOW.toISOString());
    await markResponded(env.DB, b.id, NOW.toISOString());
    await dropInvitee(env.DB, b.id);

    const outcome = await bookBestNow(env, poll.id);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.slotStartUtc).toBe("2026-08-10T00:00:00.000Z"); // Alice's own top slot, unconstrained by dropped Bob

    const created = calendar.getCreated();
    expect(created[0]!.attendees?.map((x) => x.email)).toEqual(["a@x.com"]); // Bob (dropped) excluded entirely
  });

  it("FIX 5b: returns no_responders when the only invitee who responded has since been dropped, even though a non-dropped invitee exists", async () => {
    const poll = await makePoll();
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    await addInvitee(poll.id, "b@x.com", "Bob"); // non-dropped, never responds
    await paintWholeWindow(a.id);
    await markResponded(env.DB, a.id, NOW.toISOString());
    await dropInvitee(env.DB, a.id); // Alice — the only responder — is dropped

    const outcome = await bookBestNow(env, poll.id);

    expect(outcome).toEqual({ ok: false, reason: "no_responders" });
    const after = await getPoll(env.DB, poll.id);
    expect(after!.status).toBe("open");
    expect(calendar.getCreated()).toHaveLength(0);
  });

  it("FIX 5c: a hidden ('hide my name') responder is excluded from the booked event's attendees and gets the private booking-notice email", async () => {
    const poll = await makePoll({ title: "Team sync" });
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    await setHideName(env.DB, a.id, true);
    await paintWholeWindow(a.id);
    await markResponded(env.DB, a.id, NOW.toISOString());

    const outcome = await bookBestNow(env, poll.id);

    expect(outcome.ok).toBe(true);
    const created = calendar.getCreated();
    expect(created[0]!.attendees ?? []).toHaveLength(0); // hidden, sole invitee -> no attendees at all
    const notice = notification.sentPollEmails.filter((e) => e.to === "a@x.com");
    expect(notice).toHaveLength(1);
    expect(notice[0]!.attachments).toHaveLength(1);
    expect(notice[0]!.attachments![0]!.filename).toBe("invite.ics");
  });

  it("FIX 5d: books via bookBest even though the deadline has already passed (deadline exemption asserted, not just implemented)", async () => {
    const poll = await makePoll(); // default deadlineUtc "2026-08-09T00:00:00Z"
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    await paintWholeWindow(a.id);
    await markResponded(env.DB, a.id, NOW.toISOString());
    const wellPastDeadline = new Date("2026-08-09T12:00:00Z"); // 12h after deadlineUtc
    __setForTests({ calendar, notification, now: () => wellPastDeadline });

    const outcome = await bookBestNow(env, poll.id);

    expect(outcome.ok).toBe(true);
    const after = await getPoll(env.DB, poll.id);
    expect(after!.status).toBe("booked");
  });
});

describe("L2: assembleAvailability's horizon floor", () => {
  it("keeps the calendar fetch window non-inverted even when 'now' is well past rangeEnd+3d", async () => {
    const poll = await makePoll(); // RANGE_END = 2026-08-14
    const a = await addInvitee(poll.id, "a@x.com", "Alice");
    await paintWholeWindow(a.id);
    await markResponded(env.DB, a.id, NOW.toISOString());

    const calls: { start: string; end: string }[] = [];
    class RecordingCalendar extends MockCalendarProvider {
      async fetchEventsInWindow(start: string, end: string) {
        calls.push({ start, end });
        return super.fetchEventsInWindow(start, end);
      }
    }
    const recording = new RecordingCalendar();
    // 11 days after RANGE_END — well past the un-floored rangeEnd+3d horizon
    // (2026-08-17), which would otherwise invert the fetch window (start >
    // end) and have it silently swallowed rather than erroring (L2).
    const wellPastRangeEnd = new Date("2026-08-25T00:00:00Z");
    __setForTests({ calendar: recording, notification, now: () => wellPastRangeEnd });

    await bookAtDeadline(env, poll.id);

    expect(calls.length).toBeGreaterThan(0);
    for (const { start, end } of calls) {
      expect(Date.parse(end)).toBeGreaterThan(Date.parse(start));
    }
  });
});
