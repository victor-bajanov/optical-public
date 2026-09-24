import { describe, it, expect } from "vitest";
import { GmailDiffRenderer } from "../../src/diff/gmail-diff-renderer";
import type { ReplanEmailModel } from "../../src/diff/email-model";

const baseModel: ReplanEmailModel = {
  tz: "Australia/Sydney",
  window: { start: "2026-06-14T14:00:00Z", end: "2026-06-21T14:00:00Z" },
  trigger: { kind: "webhook", inviteTitle: "Client call" },
  isEmpty: false,
  days: [{
    date: "2026-06-15",
    before: [{ title: "BAS prep", start: "2026-06-15T01:30:00.000Z", end: "2026-06-15T03:30:00.000Z", role: "moved-from" }],
    after: [{ title: "BAS prep", start: "2026-06-15T04:45:00.000Z", end: "2026-06-15T06:45:00.000Z", role: "moved-to", movedFrom: "2026-06-15T01:30:00.000Z" }],
  }],
  dropped: [],
  warnings: [],
};

const renderer = new GmailDiffRenderer();
const opts = { acceptUrl: "https://s.example.com/v1/plans/abc1234def/accept?t=TOK", planHash: "abc1234def567" };

describe("GmailDiffRenderer", () => {
  it("subject names the webhook invite and the short hash", () => {
    const out = renderer.render(baseModel, opts);
    expect(out.subject).toBe('Scheduler: replan for invite "Client call" (abc1234)');
  });

  it("html is a full doc with the calendar fragment and an accept link", () => {
    const out = renderer.render(baseModel, opts);
    expect(out.html.startsWith("<!doctype html>")).toBe(true);
    expect(out.html).toContain("BAS prep");
    expect(out.html).toContain("2:45 PM");
    expect(out.html).toContain('href="https://s.example.com/v1/plans/abc1234def/accept?t=TOK"');
    expect(out.html).toContain("Accept this plan");
  });

  it("plaintext includes the body and the accept URL", () => {
    const out = renderer.render(baseModel, opts);
    expect(out.plaintext).toContain("BAS prep");
    expect(out.plaintext).toContain("Accept this plan: https://s.example.com/v1/plans/abc1234def/accept?t=TOK");
  });

  it("threads warnings into the full html document", () => {
    const withWarnings: ReplanEmailModel = { ...baseModel, warnings: ["Standup: attendee_availability_unknown"] };
    const out = renderer.render(withWarnings, opts);
    expect(out.html).toContain("Before you accept");
    // Rendered warnings are humanized (see humanizeWarning); the stored code
    // is a machine-readable detail that must not leak into user-facing copy.
    expect(out.html).toContain("We couldn&#39;t check everyone&#39;s availability");
    expect(out.html).not.toContain("attendee_availability_unknown");
    expect(out.plaintext).toContain("We couldn't check everyone's availability");
    expect(out.plaintext).not.toContain("attendee_availability_unknown");
  });

  it("monday-cron subjects differ for empty vs non-empty", () => {
    const empty = renderer.render({ ...baseModel, isEmpty: true, days: [], trigger: "monday-cron" }, opts);
    expect(empty.subject).toBe("Scheduler: weekly plan unchanged (abc1234)");
    const full = renderer.render({ ...baseModel, trigger: "monday-cron" }, opts);
    expect(full.subject).toBe("Scheduler: weekly replan ready (abc1234)");
  });
});
