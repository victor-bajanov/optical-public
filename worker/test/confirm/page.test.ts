// The confirm pages' rendering: links in a replay outcome become real,
// escaped anchors (only http(s)); long text wraps instead of overflowing the
// card; the expiry is in the user's own timezone; an op's preview is shown in
// a sandboxed srcdoc iframe ahead of the details and the Confirm button.
import { describe, it, expect } from "vitest";
import { renderConfirmActionPage, renderConfirmNoticePage } from "../../src/confirm/page";

const LONG = "https://scheduler.example.com/poll/p1?t=" + "a".repeat(300);

describe("renderConfirmNoticePage", () => {
  it("renders each link as an escaped anchor, not as text inside the message", () => {
    const html = renderConfirmNoticePage("Done", "The poll was created.", [
      { label: "Open your poll status page", url: `${LONG}&x="y"` },
    ]);
    expect(html).toContain(`<a class="btn" href="${LONG}&amp;x=&quot;y&quot;"`);
    expect(html).toContain(">Open your poll status page</a>");
    expect(html).toContain("<p>The poll was created.</p>");
  });

  it("puts a copy link in a read-only field the user can select, plus an anchor", () => {
    const html = renderConfirmNoticePage("Done", "ok", [{ label: "Guest link to share", url: LONG, copy: true }]);
    const input = /<input[^>]*>/.exec(html)?.[0] ?? "";
    expect(input).toMatch(/\sreadonly[\s>]/);
    expect(input).toContain(`value="${LONG}"`);
    expect(html).toContain("Guest link to share");
    expect(html).toContain(`href="${LONG}"`);
  });

  it("never renders a non-http(s) url as a link", () => {
    const html = renderConfirmNoticePage("Done", "ok", [
      { label: "x", url: "javascript:alert(1)" },
      { label: "y", url: "data:text/html,hi", copy: true },
    ]);
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:text");
  });

  it("escapes link labels", () => {
    const html = renderConfirmNoticePage("Done", "ok", [{ label: "<b>x</b>", url: LONG }]);
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  it("wraps long unbroken text instead of overflowing the card", () => {
    expect(renderConfirmNoticePage("Done", LONG)).toMatch(/overflow-wrap:anywhere/);
  });
});

describe("renderConfirmActionPage", () => {
  const base = {
    label: "Do it",
    view: { heading: "Heading", text: [{ label: "L", value: "V" }], notes: ["A note"] },
    actionId: "id-1",
    token: "tok",
    expiresAt: "2026-10-16T02:30:00.000Z",
    tz: "Australia/Sydney",
  };

  it("shows the expiry in the user's timezone and names the zone", () => {
    const html = renderConfirmActionPage(base);
    expect(html).toMatch(/expires Fri 16 October, 1:30 PM \(Australia\/Sydney\)/);
    expect(html).not.toMatch(/UTC/);
  });

  it("shows an op's preview in a sandboxed srcdoc iframe, before the details and the Confirm button", () => {
    const inner = `<!doctype html><p class="x">Hi & "bye"</p>`;
    const html = renderConfirmActionPage({ ...base, view: { ...base.view, preview: { caption: "Preview: what bookers see", html: inner } } });
    const iframe = /<iframe[^>]*>/.exec(html)?.[0] ?? "";
    expect(iframe).toMatch(/\ssandbox(=""|\s|>)/);
    expect(iframe).toContain(`srcdoc="&lt;!doctype html&gt;&lt;p class=&quot;x&quot;&gt;Hi &amp; &quot;bye&quot;&lt;/p&gt;"`);
    expect(html).toContain("Preview: what bookers see");
    const at = (s: string) => html.indexOf(s);
    expect(at("<iframe")).toBeGreaterThan(0);
    expect(at("<iframe")).toBeLessThan(at("A note"));
    expect(at("<iframe")).toBeLessThan(at(">V<"));
    expect(at("A note")).toBeLessThan(at("<form"));
  });

  it("has no iframe when the op has no preview", () => {
    expect(renderConfirmActionPage(base)).not.toContain("<iframe");
  });
});
