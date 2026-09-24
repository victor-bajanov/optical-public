import { describe, it, expect, vi } from "vitest";
import {
  renderInviteEmail,
  renderNudgeEmail,
  renderEscalationEmail,
  renderBookingNoticeEmail,
  renderDeadlineExtendedEmail,
  renderPollBookedEmail,
  renderPollResponseSavedEmail,
  renderPollCancelledEmail,
  renderInviteeRemovedEmail,
} from "../../src/polls/emails";
import { GmailNotificationProvider } from "../../src/providers/gmail-notification-provider";
import { MockNotificationProvider } from "../../src/providers/mock-notification-provider";
import type { PollEmail } from "../../src/providers/notification-provider";

function decodeIcsAttachment(email: { attachments?: PollEmail["attachments"] }): string {
  const ics = email.attachments?.find((a) => a.filename === "invite.ics");
  if (!ics) throw new Error("no invite.ics attachment");
  const bin = atob(ics.contentBase64);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

describe("renderInviteEmail", () => {
  const base = {
    pollTitle: "Q3 planning sync",
    organiserName: "Victor",
    durationMin: 60,
    rangeStart: "2026-08-20",
    rangeEnd: "2026-09-03",
    deadlineUtc: "2026-08-19T04:00:00Z",
    inviteeUrl: "https://scheduler.example.com/poll/p_abc123?t=tok_xyz",
  };

  it("includes the invitee's tokenised URL in both text and html parts", () => {
    const email = renderInviteEmail(base);
    expect(email.text).toContain(base.inviteeUrl);
    expect(email.html).toContain(base.inviteeUrl);
  });

  it("escapes a hostile poll title in the html part but not the text part", () => {
    const email = renderInviteEmail({ ...base, pollTitle: '<img src=x onerror=alert(1)>' });
    expect(email.html).not.toContain("<img src=x onerror=alert(1)>");
    expect(email.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(email.text).toContain("<img src=x onerror=alert(1)>");
  });

  it("escapes a hostile organiser name in the html part", () => {
    const email = renderInviteEmail({ ...base, organiserName: '<script>alert(1)</script>' });
    expect(email.html).not.toContain("<script>alert(1)</script>");
    expect(email.html).toContain("&lt;script&gt;");
  });

  it("formats the deadline in the invitee's timezone when given", () => {
    const email = renderInviteEmail({ ...base, inviteeTz: "Australia/Sydney" });
    // 2026-08-19T04:00:00Z is 2026-08-19T14:00 in Australia/Sydney (AEST, +10)
    expect(email.text).toContain("2:00 PM");
    expect(email.text).not.toContain("UTC");
  });

  it("falls back to UTC with an explicit label when no invitee timezone is given", () => {
    const email = renderInviteEmail(base);
    expect(email.text).toContain("UTC");
    expect(email.text).toContain("4:00 AM");
  });

  it("has a subject naming the poll", () => {
    const email = renderInviteEmail(base);
    expect(email.subject).toContain("Q3 planning sync");
  });

  it("does not include a `to` field (recipient is set by the caller, not the renderer)", () => {
    const email = renderInviteEmail(base);
    expect((email as unknown as { to?: string }).to).toBeUndefined();
  });
});

describe("renderNudgeEmail", () => {
  const base = {
    pollTitle: "Q3 planning sync",
    organiserName: "Victor",
    durationMin: 60,
    rangeStart: "2026-08-20",
    rangeEnd: "2026-09-03",
    deadlineUtc: "2026-08-19T04:00:00Z",
    inviteeUrl: "https://scheduler.example.com/poll/p_abc123?t=tok_xyz",
    respondedCount: 3,
    totalCount: 5,
  };

  it("reports responses so far", () => {
    const email = renderNudgeEmail(base);
    expect(email.text).toContain("3 of 5");
    expect(email.html).toContain("3 of 5");
  });

  it("includes the invitee's tokenised URL", () => {
    const email = renderNudgeEmail(base);
    expect(email.text).toContain(base.inviteeUrl);
    expect(email.html).toContain(base.inviteeUrl);
  });

  it("escapes a hostile poll title in the html part", () => {
    const email = renderNudgeEmail({ ...base, pollTitle: '<img src=x onerror=alert(1)>' });
    expect(email.html).not.toContain("<img src=x onerror=alert(1)>");
    expect(email.html).toContain("&lt;img");
  });

  it("has a subject naming the poll", () => {
    const email = renderNudgeEmail(base);
    expect(email.subject).toContain("Q3 planning sync");
  });
});

describe("renderEscalationEmail", () => {
  const base = {
    poll: {
      id: "p_abc123",
      title: "Q3 planning sync",
      durationMin: 60,
      deadlineUtc: "2026-08-19T04:00:00Z",
    },
    nearMisses: [
      { slotStartUtc: "2026-08-21T05:00:00Z", droppedInvitee: "Anonymous sea otter" },
      { slotStartUtc: "2026-08-22T06:00:00Z", droppedInvitee: "Jess" },
    ],
  };

  it("lists near-miss slots with who would need to be dropped", () => {
    const email = renderEscalationEmail(base);
    expect(email.text).toContain("Anonymous sea otter");
    expect(email.text).toContain("Jess");
  });

  it("includes the resolveMeetingPoll book/bookBest and updateMeetingPoll deadlineUtc/removeInviteeIds actions as plain instructions", () => {
    const email = renderEscalationEmail(base);
    const lowered = email.text.toLowerCase();
    expect(lowered).toContain("book");
    expect(lowered).toContain("more time");
    expect(lowered).toContain("drop");
    // The remedies are book/bookBest (resolveMeetingPoll) and
    // deadlineUtc/removeInviteeIds (updateMeetingPoll) — extendDeadline and
    // dropInvitee moved out of resolveMeetingPoll's action set (Card C).
    expect(email.text).toContain('resolveMeetingPoll(action: "book"');
    expect(email.text).toContain('resolveMeetingPoll(action: "bookBest")');
    expect(email.text).toContain("updateMeetingPoll(deadlineUtc:");
    expect(email.text).toContain("updateMeetingPoll(removeInviteeIds:");
    expect(email.text).not.toContain("extendDeadline");
    expect(email.text).not.toContain("dropInvitee");
  });

  it("escapes a hostile poll title in the html part", () => {
    const email = renderEscalationEmail({
      ...base,
      poll: { ...base.poll, title: '<img src=x onerror=alert(1)>' },
    });
    expect(email.html).not.toContain("<img src=x onerror=alert(1)>");
    expect(email.html).toContain("&lt;img");
  });

  it("escapes a hostile near-miss invitee name in the html part", () => {
    const email = renderEscalationEmail({
      poll: base.poll,
      nearMisses: [{ slotStartUtc: "2026-08-21T05:00:00Z", droppedInvitee: '<script>alert(1)</script>' }],
    });
    expect(email.html).not.toContain("<script>alert(1)</script>");
    expect(email.html).toContain("&lt;script&gt;");
  });

  it("handles an empty near-misses list without throwing", () => {
    const email = renderEscalationEmail({ poll: base.poll, nearMisses: [] });
    expect(email.text).toContain("Q3 planning sync");
  });

  it("has a subject naming the poll and signalling action is needed", () => {
    const email = renderEscalationEmail(base);
    expect(email.subject).toContain("Q3 planning sync");
  });

  it("tells the organiser invitees can still update their availability from their existing links until booked", () => {
    const email = renderEscalationEmail(base);
    expect(email.text).toContain("Invitees can still update their availability from their existing links until you book.");
    expect(email.html).toContain("Invitees can still update their availability from their existing links until you book.");
  });

  it("renders the still-update-availability line as its own paragraph, not a fourth resolveMeetingPoll action", () => {
    const email = renderEscalationEmail(base);
    // It is a standalone note, not one of the "You can:" bullets — it must
    // not render as a <li> under that <ul>.
    expect(email.html).not.toContain("<li>Invitees can still");
    expect(email.html).toContain("<p>Invitees can still update their availability from their existing links until you book.</p>");
    // In text, it's set off from the action bullets by a blank line, not
    // jammed against them.
    expect(email.text).toContain("\n\nInvitees can still update their availability from their existing links until you book.");
  });
});

describe("renderBookingNoticeEmail", () => {
  const base = {
    pollId: "p_abc123",
    pollTitle: "Q3 planning sync",
    organiserName: "Victor",
    durationMin: 60,
    slotStartUtc: "2026-08-21T05:00:00Z",
    slotEndUtc: "2026-08-21T06:00:00Z",
    now: new Date("2026-08-14T00:00:00Z"),
  };

  it("mentions the poll title, organiser, and time in text and html", () => {
    const email = renderBookingNoticeEmail(base);
    expect(email.text).toContain("Q3 planning sync");
    expect(email.text).toContain("Victor");
    expect(email.html).toContain("Q3 planning sync");
  });

  it("includes the location when given, omits a Where line when not", () => {
    const withLoc = renderBookingNoticeEmail({ ...base, location: "Room 4B" });
    expect(withLoc.text).toContain("Room 4B");
    const withoutLoc = renderBookingNoticeEmail(base);
    expect(withoutLoc.text).not.toContain("Where:");
  });

  it("escapes a hostile poll title and location in the html part", () => {
    const email = renderBookingNoticeEmail({
      ...base,
      pollTitle: "<img src=x onerror=alert(1)>",
      location: "<script>alert(1)</script>",
    });
    expect(email.html).not.toContain("<img src=x onerror=alert(1)>");
    expect(email.html).not.toContain("<script>alert(1)</script>");
    expect(email.html).toContain("&lt;img");
    expect(email.html).toContain("&lt;script&gt;");
  });

  it("attaches a minimal METHOD:PUBLISH VEVENT with the right UID/times/summary", () => {
    const email = renderBookingNoticeEmail(base);
    expect(email.attachments).toHaveLength(1);
    expect(email.attachments![0]!.filename).toBe("invite.ics");
    expect(email.attachments![0]!.mimeType).toContain("text/calendar");
    const ics = decodeIcsAttachment(email);
    expect(ics).toContain("METHOD:PUBLISH");
    expect(ics).toContain("UID:poll-p_abc123@optical");
    expect(ics).toContain("DTSTART:20260821T050000Z");
    expect(ics).toContain("DTEND:20260821T060000Z");
    expect(ics).toContain("SUMMARY:Q3 planning sync");
    expect(ics).toMatch(/\r\n/); // CRLF line endings (house ICS style)
  });

  it("includes LOCATION in the ICS only when a location is given", () => {
    const withLoc = decodeIcsAttachment(renderBookingNoticeEmail({ ...base, location: "Room 4B" }));
    expect(withLoc).toContain("LOCATION:Room 4B");
    const withoutLoc = decodeIcsAttachment(renderBookingNoticeEmail(base));
    expect(withoutLoc).not.toContain("LOCATION:");
  });

  it("escapes ICS-special characters in SUMMARY per RFC 5545", () => {
    const ics = decodeIcsAttachment(renderBookingNoticeEmail({ ...base, pollTitle: "Sync; planning, review" }));
    expect(ics).toContain("SUMMARY:Sync\\; planning\\, review");
  });

  it("does not include a `to` field (recipient is set by the caller, not the renderer)", () => {
    const email = renderBookingNoticeEmail(base);
    expect((email as unknown as { to?: string }).to).toBeUndefined();
  });
});

describe("renderDeadlineExtendedEmail", () => {
  const base = {
    pollTitle: "Q3 planning sync",
    organiserName: "Victor",
    durationMin: 60,
    rangeStart: "2026-08-20",
    rangeEnd: "2026-09-03",
    deadlineUtc: "2026-08-25T04:00:00Z",
    inviteeUrl: "https://scheduler.example.com/poll/p_abc123?t=tok_new",
  };

  it("includes the new deadline and the fresh invitee link", () => {
    const email = renderDeadlineExtendedEmail(base);
    expect(email.text).toContain(base.inviteeUrl);
    expect(email.html).toContain(base.inviteeUrl);
  });

  it("has a subject naming the poll and signalling the extension", () => {
    const email = renderDeadlineExtendedEmail(base);
    expect(email.subject.toLowerCase()).toContain("extend");
    expect(email.subject).toContain("Q3 planning sync");
  });

  it("escapes a hostile poll title in the html part", () => {
    const email = renderDeadlineExtendedEmail({ ...base, pollTitle: "<img src=x onerror=alert(1)>" });
    expect(email.html).not.toContain("<img src=x onerror=alert(1)>");
    expect(email.html).toContain("&lt;img");
  });
});

describe("renderPollCancelledEmail", () => {
  const base = {
    pollTitle: "Q3 planning sync",
    organiserName: "Victor",
    durationMin: 60,
    rangeStart: "2026-08-20",
    rangeEnd: "2026-09-03",
  };

  it("has a subject naming the poll and signalling cancellation", () => {
    const email = renderPollCancelledEmail(base);
    expect(email.subject).toBe("Cancelled: Q3 planning sync");
  });

  it("says the poll is cancelled, no meeting will be booked, and existing links can be disregarded", () => {
    const email = renderPollCancelledEmail(base);
    for (const part of [email.text, email.html]) {
      expect(part.toLowerCase()).toContain("cancelled");
      expect(part.toLowerCase()).toContain("no meeting will be booked");
      expect(part.toLowerCase()).toContain("disregard");
    }
  });

  it("escapes a hostile poll title in the html part but not the text part", () => {
    const email = renderPollCancelledEmail({ ...base, pollTitle: "<img src=x onerror=alert(1)>" });
    expect(email.html).not.toContain("<img src=x onerror=alert(1)>");
    expect(email.html).toContain("&lt;img");
    expect(email.text).toContain("<img src=x onerror=alert(1)>");
  });

  it("escapes a hostile organiser name in the html part", () => {
    const email = renderPollCancelledEmail({ ...base, organiserName: "<script>alert(1)</script>" });
    expect(email.html).not.toContain("<script>alert(1)</script>");
    expect(email.html).toContain("&lt;script&gt;");
  });

  it("carries no link or call-to-action — links are dead by design", () => {
    const email = renderPollCancelledEmail(base);
    expect(email.html).not.toContain("<a ");
    expect(email.html).not.toContain("href=");
  });

  it("does not include a `to` field (recipient is set by the caller, not the renderer)", () => {
    const email = renderPollCancelledEmail(base);
    expect((email as unknown as { to?: string }).to).toBeUndefined();
  });
});

describe("renderInviteeRemovedEmail", () => {
  const base = {
    pollTitle: "Q3 planning sync",
    organiserName: "Victor",
    durationMin: 60,
    rangeStart: "2026-08-20",
    rangeEnd: "2026-09-03",
  };

  it("has a subject naming the poll and signalling removal", () => {
    const email = renderInviteeRemovedEmail(base);
    expect(email.subject).toBe("Removed: Q3 planning sync");
  });

  it("says the organiser removed them, no action is needed, no calendar invite will follow, and apologises for time spent", () => {
    const email = renderInviteeRemovedEmail(base);
    for (const part of [email.text, email.html]) {
      expect(part.toLowerCase()).toContain("removed");
      expect(part.toLowerCase()).toContain("no action is needed");
      expect(part.toLowerCase()).toContain("will not receive a calendar invite");
      expect(part.toLowerCase()).toContain("apolog");
    }
  });

  it("mentions the duration and the candidate window in text and html", () => {
    const email = renderInviteeRemovedEmail(base);
    for (const part of [email.text, email.html]) {
      expect(part).toContain("60 minutes");
      expect(part).toContain("Thu 20 August – Thu 3 September");
    }
  });

  it("escapes a hostile poll title in the html part but not the text part", () => {
    const email = renderInviteeRemovedEmail({ ...base, pollTitle: "<img src=x onerror=alert(1)>" });
    expect(email.html).not.toContain("<img src=x onerror=alert(1)>");
    expect(email.html).toContain("&lt;img");
    expect(email.text).toContain("<img src=x onerror=alert(1)>");
  });

  it("escapes a hostile organiser name in the html part", () => {
    const email = renderInviteeRemovedEmail({ ...base, organiserName: "<script>alert(1)</script>" });
    expect(email.html).not.toContain("<script>alert(1)</script>");
    expect(email.html).toContain("&lt;script&gt;");
  });

  it("carries no link or call-to-action — their link is dead and a link would read as a bug", () => {
    const email = renderInviteeRemovedEmail(base);
    expect(email.html).not.toContain("<a ");
    expect(email.html).not.toContain("href=");
    expect(email.text).not.toContain("http");
  });

  it("does not include a `to` field (recipient is set by the caller, not the renderer)", () => {
    const email = renderInviteeRemovedEmail(base);
    expect((email as unknown as { to?: string }).to).toBeUndefined();
  });
});

describe("renderPollBookedEmail (organiser notification on booking)", () => {
  const base = {
    pollTitle: "Q3 planning sync",
    slotStartUtc: "2026-08-21T05:00:00Z",
    durationMin: 60,
    attendeeNames: ["Alice", "Bob"],
    hiddenNames: [] as string[],
    hiddenFailedNames: [] as string[],
  };

  it("mentions the poll title, duration, and calendar attendees in text and html", () => {
    const email = renderPollBookedEmail(base);
    expect(email.text).toContain("Q3 planning sync");
    expect(email.text).toContain("60 minutes");
    expect(email.text).toContain("Alice");
    expect(email.text).toContain("Bob");
    expect(email.html).toContain("Q3 planning sync");
    expect(email.html).toContain("Alice");
  });

  it("formats the booked time in the organiser's timezone when given", () => {
    const email = renderPollBookedEmail({ ...base, organiserTz: "Australia/Sydney" });
    // 2026-08-21T05:00:00Z is 2026-08-21T15:00 in Australia/Sydney (AEST, +10)
    expect(email.text).toContain("3:00 PM");
    expect(email.text).not.toContain("UTC");
  });

  it("falls back to UTC with an explicit label when no organiser timezone is given", () => {
    const email = renderPollBookedEmail(base);
    expect(email.text).toContain("UTC");
    expect(email.text).toContain("5:00 AM");
  });

  it("includes the location when given, omits a Where line when not", () => {
    const withLoc = renderPollBookedEmail({ ...base, location: "Room 4B" });
    expect(withLoc.text).toContain("Room 4B");
    const withoutLoc = renderPollBookedEmail(base);
    expect(withoutLoc.text).not.toContain("Where:");
  });

  it("names hidden invitees as privately notified, separate from the calendar attendee list", () => {
    const email = renderPollBookedEmail({ ...base, hiddenNames: ["Carol"] });
    expect(email.text).toContain("Carol");
    expect(email.text.toLowerCase()).toContain("privately");
  });

  it("omits the privately-notified line when there are no hidden invitees", () => {
    const email = renderPollBookedEmail(base);
    expect(email.text.toLowerCase()).not.toContain("privately");
  });

  it("says which hidden invitees could NOT be notified when their booking-notice send failed", () => {
    const email = renderPollBookedEmail({ ...base, hiddenFailedNames: ["Dana"] });
    expect(email.text).toContain("Dana");
    expect(email.text.toLowerCase()).toContain("could not notify");
    expect(email.html).toContain("Dana");
  });

  it("omits the failed-notice line when every hidden-invitee send succeeded", () => {
    const email = renderPollBookedEmail({ ...base, hiddenNames: ["Carol"] });
    expect(email.text.toLowerCase()).not.toContain("could not notify");
  });

  it("lists a succeeded and a failed hidden invitee separately, not conflated", () => {
    const email = renderPollBookedEmail({ ...base, hiddenNames: ["Carol"], hiddenFailedNames: ["Dana"] });
    expect(email.text).toMatch(/Notified privately.*Carol/);
    expect(email.text).toMatch(/[Cc]ould not notify.*Dana/);
    // Dana must not appear in the succeeded line, nor Carol in the failed one.
    const notifiedLine = email.text.split("\n").find((l) => l.startsWith("Notified privately"))!;
    const failedLine = email.text.split("\n").find((l) => l.toLowerCase().startsWith("could not notify"))!;
    expect(notifiedLine).not.toContain("Dana");
    expect(failedLine).not.toContain("Carol");
  });

  it("adds a Where line pointing at the calendar event for a Google Meet booking", () => {
    const email = renderPollBookedEmail({ ...base, location: "Google Meet (link is on the calendar event)" });
    expect(email.text).toContain("Where:");
    expect(email.text).toContain("Google Meet");
    expect(email.text).toContain("calendar event");
  });

  it("says no one is listed when every invitee is hidden (empty attendee list)", () => {
    const email = renderPollBookedEmail({ ...base, attendeeNames: [], hiddenNames: ["Carol"] });
    expect(email.text.toLowerCase()).toContain("no one");
  });

  it("escapes a hostile poll title in the html part but not the text part", () => {
    const email = renderPollBookedEmail({ ...base, pollTitle: "<img src=x onerror=alert(1)>" });
    expect(email.html).not.toContain("<img src=x onerror=alert(1)>");
    expect(email.html).toContain("&lt;img");
    expect(email.text).toContain("<img src=x onerror=alert(1)>");
  });

  it("escapes a hostile attendee name in the html part", () => {
    const email = renderPollBookedEmail({ ...base, attendeeNames: ["<script>alert(1)</script>"] });
    expect(email.html).not.toContain("<script>alert(1)</script>");
    expect(email.html).toContain("&lt;script&gt;");
  });

  it("has a subject naming the poll and signalling it's booked", () => {
    const email = renderPollBookedEmail(base);
    expect(email.subject.toLowerCase()).toContain("booked");
    expect(email.subject).toContain("Q3 planning sync");
  });

  it("has a subject distinct from the hidden-invitee booking-notice email's subject (R8)", () => {
    // Two different audiences for "Booked: <title>" would otherwise share a
    // subject line — distinguish the organiser's own copy so it doesn't read
    // as a duplicate of (or get threaded with) the notice a hidden invitee
    // gets.
    const notice = renderBookingNoticeEmail({
      pollId: "p_abc123",
      pollTitle: base.pollTitle,
      organiserName: "Victor",
      durationMin: base.durationMin,
      slotStartUtc: base.slotStartUtc,
      slotEndUtc: "2026-08-21T06:00:00Z",
      now: new Date("2026-08-14T00:00:00Z"),
    });
    const booked = renderPollBookedEmail(base);
    expect(booked.subject).not.toBe(notice.subject);
  });

  it("does not include a `to` field (recipient is set by the caller, not the renderer)", () => {
    const email = renderPollBookedEmail(base);
    expect((email as unknown as { to?: string }).to).toBeUndefined();
  });
});

describe("renderPollResponseSavedEmail (organiser notification on invitee response)", () => {
  const base = {
    pollTitle: "Q3 planning sync",
    respondentName: "Alice",
    isFirstResponse: true,
    respondedCount: 2,
    totalCount: 5,
  };

  it("reports who responded and the running count", () => {
    const email = renderPollResponseSavedEmail(base);
    expect(email.text).toContain("Alice");
    expect(email.text).toContain("2 of 5");
    expect(email.html).toContain("Alice");
    expect(email.html).toContain("2 of 5");
  });

  it("distinguishes a first response from an update in wording", () => {
    const first = renderPollResponseSavedEmail({ ...base, isFirstResponse: true });
    const update = renderPollResponseSavedEmail({ ...base, isFirstResponse: false });
    expect(first.text).not.toBe(update.text);
    expect(update.text.toLowerCase()).toContain("updated");
  });

  it("has a subject naming the poll", () => {
    const email = renderPollResponseSavedEmail(base);
    expect(email.subject).toContain("Q3 planning sync");
  });

  it("escapes a hostile respondent name in the html part but not the text part", () => {
    const email = renderPollResponseSavedEmail({ ...base, respondentName: "<script>alert(1)</script>" });
    expect(email.html).not.toContain("<script>alert(1)</script>");
    expect(email.html).toContain("&lt;script&gt;");
    expect(email.text).toContain("<script>alert(1)</script>");
  });

  it("escapes a hostile poll title in the html part", () => {
    const email = renderPollResponseSavedEmail({ ...base, pollTitle: "<img src=x onerror=alert(1)>" });
    expect(email.html).not.toContain("<img src=x onerror=alert(1)>");
    expect(email.html).toContain("&lt;img");
  });

  it("does not include a `to` field (recipient is set by the caller, not the renderer)", () => {
    const email = renderPollResponseSavedEmail(base);
    expect((email as unknown as { to?: string }).to).toBeUndefined();
  });
});

describe("GmailNotificationProvider.sendPollEmail", () => {
  const email: PollEmail = {
    to: "invitee@example.com",
    subject: "You're invited: Q3 planning sync",
    text: "Pick your availability: https://scheduler.example.com/poll/p_abc123?t=tok_xyz",
    html: "<p>Pick your availability: <a href=\"https://scheduler.example.com/poll/p_abc123?t=tok_xyz\">link</a></p>",
  };

  it("POSTs a multipart RFC822 message to gmail.send that parses back to the same content", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toContain("gmail/v1/users/me/messages/send");
      const body = JSON.parse((init?.body as string) ?? "{}");
      const decoded = atob(body.raw.replace(/-/g, "+").replace(/_/g, "/"));
      expect(decoded).toContain("To: invitee@example.com");
      expect(decoded).toContain("Subject: You're invited: Q3 planning sync");
      expect(decoded).toContain("Content-Type: multipart/alternative");
      expect(decoded).toContain("text/plain");
      expect(decoded).toContain("text/html");
      expect(decoded).toContain("Pick your availability");
      return new Response(JSON.stringify({ id: "msg-1" }), { status: 200 });
    });
    const p = new GmailNotificationProvider({
      from: "scheduler@example.com",
      getAccessToken: async () => "t",
      fetch: fetchFn as unknown as typeof fetch,
    });
    await p.sendPollEmail(email);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("still supports sendReplanNotification unchanged (both methods coexist)", () => {
    // Compile-time + smoke check that widening the interface didn't remove the original method.
    const p = new GmailNotificationProvider({ from: "scheduler@example.com", getAccessToken: async () => "t" });
    expect(typeof p.sendReplanNotification).toBe("function");
    expect(typeof p.sendPollEmail).toBe("function");
  });

  it("pin (T-notify finding 10): a guest-supplied name with CR/LF reaching renderPollResponseSavedEmail's subject cannot inject a header line", async () => {
    // renderPollResponseSavedEmail itself does not sanitize — an invitee's
    // submitted name (no CR/LF allowlist at either join or response-save
    // validation) is spliced straight into the subject string. This test
    // pins that the PROVIDER, not the renderer, is what neutralises it —
    // headerValue() is applied to every header value in sendMime, subject
    // included.
    const hostile = renderPollResponseSavedEmail({
      pollTitle: "Q3 planning sync",
      respondentName: "Eve\r\nBcc: attacker@evil.test",
      isFirstResponse: true,
      respondedCount: 1,
      totalCount: 2,
    });
    // The renderer itself is confirmed NOT to be the sanitizing layer.
    expect(hostile.subject).toContain("\r\n");

    const fetchFn = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ id: "msg-1" }), { status: 200 }));
    const p = new GmailNotificationProvider({
      from: "scheduler@example.com",
      getAccessToken: async () => "t",
      fetch: fetchFn as unknown as typeof fetch,
    });
    await p.sendPollEmail({ to: "owner@example.com", ...hostile });

    const body = JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string);
    const decoded = atob(body.raw.replace(/-/g, "+").replace(/_/g, "/"));
    const lines = decoded.split("\r\n");
    // No standalone injected "Bcc:" header line — the CRLF that would have
    // started one was collapsed to a space, folding it harmlessly into the
    // Subject value's own text instead.
    expect(lines).not.toContain("Bcc: attacker@evil.test");
    const subjectLine = lines.find((l) => l.startsWith("Subject:"));
    expect(subjectLine).toBeTruthy();
    // The header immediately following Subject is still the real next
    // header, not an injected one.
    expect(lines[lines.indexOf(subjectLine!) + 1]).toBe("MIME-Version: 1.0");
  });
});

describe("MockNotificationProvider.sendPollEmail", () => {
  it("records sent poll emails", async () => {
    const p = new MockNotificationProvider();
    const email: PollEmail = {
      to: "invitee@example.com",
      subject: "You're invited",
      text: "plain",
      html: "<p>html</p>",
    };
    await p.sendPollEmail(email);
    expect(p.sentPollEmails).toEqual([email]);
  });
});
