import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { runBookingDeclineSweep } from "../../src/cron/booking-decline-sweep";
import { claimSlot, confirmBooking, markCancelPending } from "../../src/db/bookings";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { MockNotificationProvider } from "../../src/providers/mock-notification-provider";
import { utcDay, withOutboundMailCap } from "../../src/mail/outbound-cap";
import type { Env } from "../../src/env";

// O9.8: a capped booker email must not swallow the owner's self-addressed
// heads-up (self mail is never capped).

const OWNER = "decline-cap-owner@org";
const TEST_ENV = { ...(env as unknown as Env), OAUTH_ISSUER: "https://scheduler.test", OUTBOUND_MAIL_DAILY_CAP: "3" };

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM bookings WHERE owner_subject = ?").bind(OWNER).run();
  await env.DB.prepare("DELETE FROM outbound_mail_counts").run();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("runBookingDeclineSweep at the owner's mail cap", () => {
  it("still sends the owner's heads-up when the booker email is capped, and counts the row failed", async () => {
    const claim = await claimSlot(env.DB, {
      ownerSubject: OWNER, slug: "victor", startUtc: "2026-08-19T02:00:00Z", endUtc: "2026-08-19T02:30:00Z",
      durationMinutes: 30, bookerName: "Sam Booker", bookerEmail: "sam@x.com", bookerNote: null, ipHash: "iphash",
      guardStartUtc: "2026-08-19T02:00:00Z", guardEndUtc: "2026-08-19T02:40:00Z", now: new Date("2026-08-18T00:00:00Z"),
      locationKind: "meet", locationDetail: null,
    });
    await confirmBooking(env.DB, claim!.id, "gcal-cap", new Date("2026-08-18T00:01:00Z"));
    await markCancelPending(env.DB, claim!.id, OWNER, "gcal-cap", "2026-08-19T00:00:00Z");
    await env.DB.prepare("INSERT INTO outbound_mail_counts (subject, utc_day, count) VALUES (?, ?, 3)").bind(OWNER, utcDay(new Date())).run();

    const cal = new MockCalendarProvider({
      events: [{
        id: "gcal-cap", summary: "Meeting with Sam Booker", start: "2026-08-19T02:00:00Z", end: "2026-08-19T02:30:00Z",
        status: "confirmed", attendees: [{ email: "sam@x.com", responseStatus: "declined" }],
        extendedProperties: { private: { optical_booking: claim!.id } },
      }],
    });
    const inner = new MockNotificationProvider();
    const result = await runBookingDeclineSweep(TEST_ENV, new Date("2026-08-19T00:11:00Z"), {
      makeCalendar: () => cal,
      makeNotification: (s: string) => withOutboundMailCap(TEST_ENV, s, inner),
    });

    expect(result.failed).toBe(1);
    expect(inner.sentPollEmails.map((e) => e.to)).toEqual([OWNER]);
  });
});
