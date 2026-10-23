import { describe, it, expect } from "vitest";
import {
  renderBookingDeclineCancelledEmail,
  renderBookingDeclineCancelledOwnerEmail,
  renderBookingOwnerNotifiedEmail,
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

describe("renderBookingOwnerNotifiedEmail", () => {
  const base = {
    bookerName: "Sam Booker",
    bookerEmail: "sam@x.com",
    startUtc: "2026-08-19T02:00:00Z", // 12:00 PM in Australia/Sydney
    durationMinutes: 30,
    ownerTz: "Australia/Sydney",
    locationKind: "meet" as const,
    locationDetail: null,
    note: null,
  };

  it("names the booker, their address, the slot in the owner's tz (zone named) and the duration", () => {
    const email = renderBookingOwnerNotifiedEmail(base);
    expect(email.subject).toContain("Sam Booker");
    expect(email.subject).toContain("Wed 19 August");
    for (const body of [email.text, email.html]) {
      expect(body).toContain("Sam Booker");
      expect(body).toContain("sam@x.com");
      expect(body).toContain("Wed 19 August, 12:00 PM");
      expect(body).toContain("Australia/Sydney");
      expect(body).toContain("30 minutes");
    }
    expect(email.text).not.toContain("2:00 AM");
  });

  it("falls back to UTC with an explicit label when no owner tz is given", () => {
    const email = renderBookingOwnerNotifiedEmail({ ...base, ownerTz: undefined });
    expect(email.text).toContain("2:00 AM UTC");
  });

  it("says a video call's join link is on the calendar event (the link isn't known at send time)", () => {
    const email = renderBookingOwnerNotifiedEmail(base);
    expect(email.text).toContain("Video call (the join link is on the calendar event)");
  });

  it("gives the number for a phone booking, the place for in-person, and the owner's text for custom", () => {
    expect(
      renderBookingOwnerNotifiedEmail({ ...base, locationKind: "phone", locationDetail: "+61 400 000 000" }).text,
    ).toContain("Phone call: +61 400 000 000");
    expect(
      renderBookingOwnerNotifiedEmail({ ...base, locationKind: "in_person", locationDetail: "1 George St" }).text,
    ).toContain("In person: 1 George St");
    expect(
      renderBookingOwnerNotifiedEmail({ ...base, locationKind: "custom", locationDetail: "My office, level 3" }).text,
    ).toContain("My office, level 3");
  });

  it("omits the note section when the booker left no note", () => {
    const email = renderBookingOwnerNotifiedEmail(base);
    expect(email.text).not.toContain("own words");
    expect(email.html).not.toContain("own words");
  });

  it("labels the note as the booker's own words and escapes it in the html body", () => {
    const email = renderBookingOwnerNotifiedEmail({
      ...base,
      note: "Hi! <a href=\"https://evil.example\">click</a>\nline two",
    });
    expect(email.text).toContain("Note from Sam Booker (their own words, not checked by Optical):");
    expect(email.text).toContain("line two");
    expect(email.html).toContain("their own words, not checked by Optical");
    expect(email.html).not.toContain("<a href=");
    expect(email.html).toContain("&lt;a href=");
  });

  it("escapes booker-supplied name and location detail in the html body", () => {
    const email = renderBookingOwnerNotifiedEmail({
      ...base,
      bookerName: "Sam <b>",
      locationKind: "in_person",
      locationDetail: "Cafe \"<i>\"",
    });
    expect(email.html).not.toContain("<b>");
    expect(email.html).not.toContain("<i>");
    expect(email.html).toContain("Sam &lt;b&gt;");
  });
});
