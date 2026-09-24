import { describe, it, expect } from "vitest";
import {
  renderBookingDeclineCancelledEmail,
  renderBookingDeclineCancelledOwnerEmail,
} from "../../src/booking/emails";

describe("renderBookingDeclineCancelledEmail (booker)", () => {
  it("names the cancelled slot, explains the decline cause, and CTAs back to the booking page", () => {
    const email = renderBookingDeclineCancelledEmail({
      slug: "victor",
      startUtc: "2026-08-19T02:00:00Z",
      ownerTz: "Australia/Sydney",
      oauthIssuer: "https://scheduler.example.com",
    });

    expect(email.subject).toContain("Wed 19 August");
    expect(email.text).toContain("declined the calendar invite");
    expect(email.text).toContain("book a new (or the same) time");
    expect(email.text).toContain("https://scheduler.example.com/book/victor");
    expect(email.html).toContain("https://scheduler.example.com/book/victor");
    expect(email.html).toContain("declined the calendar invite");
  });

  // Regression: a booker in a different timezone than the owner must see an
  // explicit label — 12:00 PM with no zone hint silently reads as their own
  // local time, which for a London booker whose "3:00 AM London" is the
  // owner's "12:00 PM Sydney" is actively misleading, not just unclear.
  it("renders the instant in the given tz (not UTC) and labels which tz it is", () => {
    const email = renderBookingDeclineCancelledEmail({
      slug: "victor",
      startUtc: "2026-08-19T02:00:00Z", // 12:00 PM in Australia/Sydney (AEST, UTC+10)
      ownerTz: "Australia/Sydney",
      oauthIssuer: "https://scheduler.example.com",
    });
    expect(email.text).toContain("12:00 PM");
    expect(email.text).not.toContain("2:00 AM");
    expect(email.text).toContain("Australia/Sydney");
  });

  it("falls back to UTC with an explicit label when no owner tz is available", () => {
    const email = renderBookingDeclineCancelledEmail({
      slug: "victor",
      startUtc: "2026-08-19T02:00:00Z",
      oauthIssuer: "https://scheduler.example.com",
    });
    expect(email.text).toContain("2:00 AM");
    expect(email.text).toContain("UTC");
  });
});

describe("renderBookingDeclineCancelledOwnerEmail", () => {
  it("names the booker and the slot (owner tz), and notes the booker was invited to re-book", () => {
    const email = renderBookingDeclineCancelledOwnerEmail({
      bookerName: "Sam Booker",
      startUtc: "2026-08-19T02:00:00Z",
      ownerTz: "Australia/Sydney",
    });

    expect(email.subject).toContain("Sam Booker");
    expect(email.text).toContain("Sam Booker");
    expect(email.text).toContain("Wed 19 August");
    expect(email.text).toContain("12:00 PM");
    expect(email.text).not.toContain("2:00 AM");
    expect(email.text).toContain("Australia/Sydney");
    expect(email.text).toContain("invited to book a new time");
    expect(email.html).toContain("Sam Booker");
  });

  it("falls back to UTC with an explicit label when no owner tz is available", () => {
    const email = renderBookingDeclineCancelledOwnerEmail({
      bookerName: "Sam",
      startUtc: "2026-08-19T02:00:00Z",
    });
    expect(email.text).toContain("UTC");
  });

  it("escapes a booker name containing HTML-significant characters in the html body", () => {
    const email = renderBookingDeclineCancelledOwnerEmail({
      bookerName: "Sam <script>",
      startUtc: "2026-08-19T02:00:00Z",
      ownerTz: "Australia/Sydney",
    });
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;");
  });
});
