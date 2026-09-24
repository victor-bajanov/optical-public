import { describe, it, expect } from "vitest";
import { renderDiffCalendarHtml, renderDiffPlaintext, humanizeWarning } from "../../src/diff/render-diff-calendar";
import type { ReplanEmailModel } from "../../src/diff/email-model";

const model: ReplanEmailModel = {
  tz: "Australia/Sydney",
  window: { start: "2026-06-14T14:00:00Z", end: "2026-06-21T14:00:00Z" },
  trigger: { kind: "webhook", inviteTitle: "Client call" },
  isEmpty: false,
  days: [{
    date: "2026-06-15",
    before: [
      { title: "Client call", start: "2026-06-15T01:00:00.000Z", end: "2026-06-15T02:00:00.000Z", role: "new-clash" },
      { title: "BAS prep", start: "2026-06-15T01:30:00.000Z", end: "2026-06-15T03:30:00.000Z", role: "moved-from" },
    ],
    after: [
      { title: "Client call", start: "2026-06-15T01:00:00.000Z", end: "2026-06-15T02:00:00.000Z", role: "existing" },
      { title: "BAS prep", start: "2026-06-15T04:45:00.000Z", end: "2026-06-15T06:45:00.000Z", role: "moved-to", movedFrom: "2026-06-15T01:30:00.000Z" },
    ],
  }],
  dropped: [{ title: "Tax return", reason: "no_fit", constraints: ["deadline"] }],
  warnings: [],
};

describe("renderDiffCalendar", () => {
  it("renders local times, the day header, the moved-from caption, and the dropped section", () => {
    const html = renderDiffCalendarHtml(model);
    expect(html).toContain("Mon 15 June");
    expect(html).toContain("BAS prep");
    expect(html).toContain("2:45 PM");          // moved-to local time
    expect(html).toContain("moved from 11:30 AM"); // caption from movedFrom
    expect(html).not.toMatch(/\dT\d\d:\d\d/);    // no raw ISO-Z timestamps
    expect(html).toContain("Tax return");        // dropped section
    expect(html).not.toContain("<style");        // email-safe: inline styles only
    expect(html.toLowerCase()).not.toContain("position:absolute");
  });

  it("plaintext lists the move with local times", () => {
    const txt = renderDiffPlaintext(model);
    expect(txt).toContain("BAS prep");
    expect(txt).toContain("11:30 AM");
    expect(txt).toContain("2:45 PM");
    expect(txt).toContain("Tax return");
  });

  it("an ordinary plan with no warnings and no meetings renders no warnings block or meeting note", () => {
    // Additive guarantee: the existing diff output for a plain task move must be
    // unchanged — no "Before you accept" block, no "Meeting" chip / notify note.
    const html = renderDiffCalendarHtml(model);
    expect(html).not.toContain("Before you accept");
    expect(html).not.toContain("Meeting");
    expect(html).not.toContain("notified when you accept");
    const txt = renderDiffPlaintext(model);
    expect(txt).not.toContain("Before you accept");
    expect(txt).not.toContain("attendees notified");
  });

  describe("meeting moves and warnings", () => {
    const meetingModel: ReplanEmailModel = {
      ...model,
      days: [{
        date: "2026-06-15",
        before: [
          { title: "Standup", start: "2026-06-15T01:30:00.000Z", end: "2026-06-15T02:00:00.000Z", role: "moved-from", isMeeting: true },
        ],
        after: [
          { title: "Standup", start: "2026-06-15T04:45:00.000Z", end: "2026-06-15T05:15:00.000Z", role: "moved-to", movedFrom: "2026-06-15T01:30:00.000Z", isMeeting: true },
        ],
      }],
      dropped: [],
      warnings: ["Standup: attendee_availability_unknown"],
    };

    it("renders a meeting move distinctly with the attendee-notification note", () => {
      const html = renderDiffCalendarHtml(meetingModel);
      expect(html).toContain("Standup");
      expect(html).toContain("Meeting");                          // distinct label/chip
      expect(html).toContain("Attendees will be notified when you accept"); // notification note
    });

    it("surfaces resolve warnings in a prominent block before the days", () => {
      const html = renderDiffCalendarHtml(meetingModel);
      expect(html).toContain("Before you accept");
      expect(html).toContain("We couldn&#39;t check everyone&#39;s availability");
      expect(html).not.toContain("attendee_availability_unknown");
      // The warnings block appears before the day's content (so it's seen first).
      expect(html.indexOf("Before you accept")).toBeLessThan(html.indexOf("Standup"));
    });

    it("warnings render even on an empty (no-change) plan", () => {
      const emptyWithWarnings: ReplanEmailModel = {
        ...model, isEmpty: true, days: [], dropped: [], warnings: ["heads up"],
      };
      const html = renderDiffCalendarHtml(emptyWithWarnings);
      expect(html).toContain("Before you accept");
      expect(html).toContain("heads up");
    });

    it("plaintext marks the meeting move and lists the warnings", () => {
      const txt = renderDiffPlaintext(meetingModel);
      expect(txt).toContain("Standup");
      expect(txt).toContain("meeting");                 // meeting marker
      expect(txt).toContain("Before you accept:");
      expect(txt).toContain("We couldn't check everyone's availability");
      expect(txt).not.toContain("attendee_availability_unknown");
    });
  });
});

describe("humanizeWarning", () => {
  it("translates attendee_availability_unknown into end-user copy", () => {
    expect(humanizeWarning("Quarterly review: attendee_availability_unknown")).toBe(
      "We couldn't check everyone's availability for “Quarterly review”, so it stays at its current time.",
    );
  });

  it("keeps the summary intact when it contains a colon", () => {
    expect(humanizeWarning("Sync: weekly: attendee_availability_unknown")).toBe(
      "We couldn't check everyone's availability for “Sync: weekly”, so it stays at its current time.",
    );
  });

  it("unknown trailing codes get the generic fallback", () => {
    expect(humanizeWarning("Standup: some_future_code")).toBe(
      "“Standup” needs attention — we've left it unchanged this time.",
    );
  });

  it("strips the must_include_meeting_with_dropped_task prefix and keeps the prose", () => {
    expect(
      humanizeWarning('must_include_meeting_with_dropped_task: Task "X" (priority 90) was dropped while a meeting was kept; re-prioritise or pin the meeting to release it.'),
    ).toBe('Task "X" (priority 90) was dropped while a meeting was kept; re-prioritise or pin the meeting to release it.');
  });

  it("plain prose passes through unchanged", () => {
    expect(humanizeWarning("Something readable already.")).toBe("Something readable already.");
  });
});

describe("warning rendering uses humanized copy", () => {
  const model = {
    tz: "Australia/Sydney",
    window: { start: "2026-07-06T00:00:00Z", end: "2026-07-13T00:00:00Z" },
    trigger: "monday-cron",
    isEmpty: true,
    days: [],
    dropped: [],
    warnings: ["Quarterly review: attendee_availability_unknown"],
  } as never;

  it("HTML block shows translated copy, not the machine code", () => {
    const html = renderDiffCalendarHtml(model);
    // esc() escapes apostrophes too (&#39;), unlike the plaintext renderer.
    expect(html).toContain("We couldn&#39;t check everyone&#39;s availability");
    expect(html).not.toContain("attendee_availability_unknown");
  });

  it("plaintext shows translated copy, not the machine code", () => {
    const text = renderDiffPlaintext(model);
    expect(text).toContain("We couldn't check everyone's availability");
    expect(text).not.toContain("attendee_availability_unknown");
  });
});
