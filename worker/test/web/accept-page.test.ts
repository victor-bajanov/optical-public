import { describe, it, expect } from "vitest";
import { renderConfirmPage, renderAcceptedPage, renderNoticePage } from "../../src/web/accept-page";
import type { ReplanEmailModel } from "../../src/diff/email-model";

const model: ReplanEmailModel = {
  tz: "Australia/Sydney",
  window: { start: "2026-07-06T00:00:00Z", end: "2026-07-13T00:00:00Z" },
  trigger: "monday-cron",
  isEmpty: false,
  days: [{ date: "2026-07-06", before: [], after: [{ title: "Deep work", start: "2026-07-06T00:00:00.000Z", end: "2026-07-06T01:00:00.000Z", role: "added" }] }],
  dropped: [],
  warnings: [],
} as ReplanEmailModel;

const tabs = [
  { label: "Week of Mon 6 July", href: "/v1/plans/h1/accept?t=tok&ws=a&we=b", current: true },
  { label: "Week of Mon 13 July", href: "/v1/plans/h2/accept?t=tok&ws=c&we=d", current: false },
];

describe("renderConfirmPage", () => {
  it("renders week tabs with the current week highlighted and others as links", () => {
    const html = renderConfirmPage({ model, action: "/v1/plans/h1/accept", capToken: "tok", weekTabs: tabs, windowStart: "a", windowEnd: "b" });
    expect(html).toContain("Week of Mon 6 July");
    expect(html).toContain(`href="/v1/plans/h2/accept?t=tok&amp;ws=c&amp;we=d"`);
    expect(html).toContain("You have proposed changes for 2 weeks");
  });

  it("omits the selector for a single week", () => {
    const html = renderConfirmPage({ model, action: "/v1/plans/h1/accept", capToken: "tok", weekTabs: [tabs[0]!], windowStart: "a", windowEnd: "b" });
    expect(html).not.toContain("proposed changes for");
    expect(html).not.toContain("class=\"tabs\"");
  });

  it("includes hidden ws/we fields and the banner when given", () => {
    const html = renderConfirmPage({ model, action: "/v1/plans/h1/accept", capToken: "tok", banner: "Plan was updated.", weekTabs: [], windowStart: "2026-07-06T00:00:00Z", windowEnd: "2026-07-13T00:00:00Z" });
    expect(html).toContain(`name="ws" value="2026-07-06T00:00:00Z"`);
    expect(html).toContain(`name="we" value="2026-07-13T00:00:00Z"`);
    expect(html).toContain("Plan was updated.");
  });
});

describe("renderNoticePage", () => {
  it("neutralises hostile markup in headings, labels and hrefs", () => {
    const html = renderNoticePage({
      heading: "Review <script>alert(1)</script>",
      message: 'Done & "dusted"',
      weekTabs: [
        { label: "<img src=x onerror=alert(1)>", href: "/v1/plans/h1/accept", current: true },
        { label: "Week two", href: '/v1/plans/h"x/accept', current: false },
      ],
    });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x");
    expect(html).toContain('href="/v1/plans/h&quot;x/accept"');
  });

  it("renders heading, message and tabs, without an accept form", () => {
    const html = renderNoticePage({ heading: "Already accepted", message: "You've already accepted this plan — your calendar is up to date.", weekTabs: tabs });
    expect(html).toContain("Already accepted");
    expect(html).toContain("your calendar is up to date");
    expect(html).toContain("Week of Mon 13 July");
    expect(html).not.toContain("<form");
  });
});

describe("renderAcceptedPage", () => {
  it("offers remaining weeks after accepting", () => {
    const html = renderAcceptedPage({ otherWeeks: [{ label: "Week of Mon 13 July", href: "/v1/plans/h2/accept?t=tok" }] });
    expect(html).toContain("Plan accepted");
    expect(html).toContain("You also have proposed changes");
    expect(html).toContain(`href="/v1/plans/h2/accept?t=tok"`);
  });

  it("plain accepted page when nothing else is pending", () => {
    const html = renderAcceptedPage();
    expect(html).toContain("Plan accepted");
    expect(html).not.toContain("You also have");
  });
});
