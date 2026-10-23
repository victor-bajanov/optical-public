import { describe, it, expect } from "vitest";
import { renderSignInRefusedPage } from "../../src/web/sign-in-refused-page";

describe("renderSignInRefusedPage not_invited", () => {
  it("says Optical is invitation-only and names the configured contact", () => {
    const html = renderSignInRefusedPage({ kind: "not_invited", contact: "the trial admin at ops@example.com" });
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toMatch(/invitation-only/i);
    expect(html).toContain("Ask the trial admin at ops@example.com for an invite.");
  });

  it("HTML-escapes the contact text", () => {
    const html = renderSignInRefusedPage({ kind: "not_invited", contact: `<script>alert("x")</script> & co` });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; co");
  });

  it("omits the ask-for-an-invite sentence when no contact is configured (no hardcoded name)", () => {
    for (const contact of [undefined, "", "   "]) {
      const html = renderSignInRefusedPage({ kind: "not_invited", contact });
      expect(html).toMatch(/invitation-only/i);
      expect(html, String(contact)).not.toMatch(/for an invite/i);
      expect(html).not.toMatch(/victor/i);
    }
  });

  it("shows the deployment label as a badge, escaped, like the chooser", () => {
    const html = renderSignInRefusedPage({ kind: "not_invited", contact: "x", label: "Trial <b>" });
    expect(html).toContain('<span class="badge">Trial &lt;b&gt;</span>');
    expect(renderSignInRefusedPage({ kind: "not_invited" })).not.toContain('class="badge"');
  });

  it("carries no links, scripts or forms", () => {
    const html = renderSignInRefusedPage({ kind: "not_invited", contact: "x" });
    expect(html).not.toMatch(/<a\s|<script|<form/i);
  });
});

describe("renderSignInRefusedPage missing_scopes", () => {
  it("lists each missing permission (escaped) and links an http-path retry", () => {
    const html = renderSignInRefusedPage({
      kind: "missing_scopes",
      missing: ["See and edit your calendar", "Send email <as you>"],
      retryUrl: "/oauth/authorize?a=1&b=2",
    });
    expect(html).toMatch(/needs all of/i);
    expect(html).toContain("<li>See and edit your calendar</li>");
    expect(html).toContain("<li>Send email &lt;as you&gt;</li>");
    expect(html).toContain('href="/oauth/authorize?a=1&amp;b=2"');
  });

  it("drops protocol-relative, backslash and control-char retry URLs (open-redirect shapes)", () => {
    for (const retryUrl of ["/\\evil.com", "//evil.com", "/\\/evil.com", "/ok\\path", "/a\nb", "/a\tb", "/a\u0000b", "/a\u007fb"]) {
      const html = renderSignInRefusedPage({ kind: "missing_scopes", missing: ["x"], retryUrl });
      expect(html, JSON.stringify(retryUrl)).not.toMatch(/<a\s/);
    }
  });

  it("drops a non-path retry URL (no javascript: links)", () => {
    const html = renderSignInRefusedPage({ kind: "missing_scopes", missing: ["x"], retryUrl: "javascript:alert(1)" });
    expect(html).not.toContain("javascript:");
    expect(html).not.toMatch(/<a\s/);
  });
});

describe("renderSignInRefusedPage stored-nothing line", () => {
  // The old "Nothing from your account was stored." is false for an existing
  // member refused on a partial re-consent, and for a delisted user whose
  // data still exists: only THIS sign-in stored nothing.
  for (const r of [
    { kind: "not_invited" as const },
    { kind: "missing_scopes" as const, missing: ["Send email on your behalf"] },
  ]) {
    it(`${r.kind}: says nothing from this sign-in was stored`, () => {
      const html = renderSignInRefusedPage(r);
      expect(html).toContain("Nothing from this sign-in was stored.");
      expect(html).not.toContain("from your account was stored");
    });
  }
});

describe("renderSignInRefusedPage account_bound (REFUSE_PROVIDER_REBIND)", () => {
  it("says the email is already linked to a different Google or Microsoft account and names the contact", () => {
    const html = renderSignInRefusedPage({ kind: "account_bound", contact: "the trial admin at ops@example.com" });
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain("Account already linked");
    expect(html).toMatch(/already linked to a different Google or Microsoft account/);
    expect(html).toContain("ask the trial admin at ops@example.com for help");
    expect(html).toContain("Nothing from this sign-in was stored.");
  });

  it("HTML-escapes the contact text", () => {
    const html = renderSignInRefusedPage({ kind: "account_bound", contact: `<script>x</script> & co` });
    expect(html).not.toContain("<script>x");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt; &amp; co");
  });

  it("omits the contact clause when none is configured (no hardcoded name)", () => {
    for (const contact of [undefined, "", "  "]) {
      const html = renderSignInRefusedPage({ kind: "account_bound", contact });
      expect(html).toMatch(/already linked/);
      expect(html, String(contact)).not.toMatch(/for help/);
      expect(html).not.toMatch(/victor/i);
    }
  });

  it("shows the label badge and carries no links, scripts or forms", () => {
    const html = renderSignInRefusedPage({ kind: "account_bound", contact: "x", label: "Trial" });
    expect(html).toContain('<span class="badge">Trial</span>');
    expect(html).not.toMatch(/<a\s|<script|<form/i);
  });
});
