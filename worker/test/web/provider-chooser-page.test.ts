import { describe, it, expect } from "vitest";
import { renderProviderChooserPage, LIMITED_USE_SENTENCE } from "../../src/web/provider-chooser-page";

const LINKS = { google: "/oauth/authorize?a=1&provider=google", microsoft: "/oauth/authorize?a=1&provider=microsoft" };
const POLICY_URL = "https://developers.google.com/terms/api-services-user-data-policy";

describe("renderProviderChooserPage disclosure", () => {
  it("carries the verbatim Limited Use sentence and links the Google policy", () => {
    expect(LIMITED_USE_SENTENCE).toBe(
      "Optical's use and transfer to any other app of information received from Google APIs will adhere to Google API Services User Data Policy, including the Limited Use requirements.",
    );
    const html = renderProviderChooserPage(LINKS, { providers: ["google"], privacyUrl: "https://p.example/privacy" });
    // Rendered text is HTML-escaped (the apostrophe), so compare on the escaped form.
    expect(html).toContain(LIMITED_USE_SENTENCE.replace("'", "&#39;").replace(
      "Google API Services User Data Policy",
      `<a href="${POLICY_URL}" rel="noopener">Google API Services User Data Policy</a>`,
    ));
  });

  it("discloses what is read and written, AI-client-on-request, and no model training", () => {
    const html = renderProviderChooserPage(LINKS, { providers: ["google"], privacyUrl: "https://p.example/privacy" });
    expect(html).toMatch(/calendar events/i);
    expect(html).toMatch(/free\/busy/i);
    expect(html).toMatch(/sends? (e-?mail|mail) as you/i);
    expect(html).toMatch(/AI (assistant|client)[^<]*only when you ask/i);
    expect(html).toMatch(/never used to train/i);
  });

  it("links privacy and terms when set, attribute-escaped", () => {
    const html = renderProviderChooserPage(LINKS, {
      providers: ["google"],
      privacyUrl: 'https://p.example/privacy?a=1&b="x"<y>',
      termsUrl: "https://p.example/terms",
    });
    expect(html).toContain('href="https://p.example/privacy?a=1&amp;b=&quot;x&quot;&lt;y&gt;"');
    expect(html).toContain('href="https://p.example/terms"');
    expect(html).toMatch(/>Privacy policy</);
    expect(html).toMatch(/>Terms of service</);
    expect(html).not.toContain('"x"<y>');
  });

  it("renders no disclosure, links or badge when privacyUrl is unset (today's two-provider chooser)", () => {
    for (const privacyUrl of [undefined, "", "  "]) {
      const html = renderProviderChooserPage(LINKS, {
        providers: ["google", "microsoft"], privacyUrl, termsUrl: "https://p.example/terms", label: "Trial",
      });
      expect(html).not.toContain('class="disclosure"');
      expect(html).not.toContain("Limited Use");
      expect(html).not.toMatch(/Privacy policy/);
      expect(html).not.toMatch(/Terms of service/);
      expect(html).not.toContain('class="badge"');
    }
  });

  it("omits the terms link when only privacyUrl is set", () => {
    const html = renderProviderChooserPage(LINKS, { providers: ["google"], privacyUrl: "https://p.example/privacy" });
    expect(html).toMatch(/>Privacy policy</);
    expect(html).not.toMatch(/Terms of service/);
  });

  it("refuses non-http(s) privacy/terms URLs rather than rendering them as links", () => {
    const html = renderProviderChooserPage(LINKS, {
      providers: ["google"], privacyUrl: "javascript:alert(1)", termsUrl: "not a url",
    });
    expect(html).not.toContain("javascript:");
    expect(html).not.toMatch(/Privacy policy/);
    expect(html).not.toMatch(/Terms of service/);
  });

  it("shows the deployment label badge escaped, and no badge when unset", () => {
    const priv = "https://p.example/privacy";
    const html = renderProviderChooserPage(LINKS, { providers: ["google"], privacyUrl: priv, label: "Trial <b>&" });
    expect(html).toContain('<span class="badge">Trial &lt;b&gt;&amp;</span>');
    expect(renderProviderChooserPage(LINKS, { providers: ["google"], privacyUrl: priv })).not.toContain('class="badge"');
    expect(renderProviderChooserPage(LINKS, { providers: ["google"], privacyUrl: priv, label: "  " })).not.toContain('class="badge"');
  });

  it("shows a Microsoft button only when microsoft is offered", () => {
    const googleOnly = renderProviderChooserPage(LINKS, { providers: ["google"] });
    expect(googleOnly).toContain('class="btn btn-google"');
    expect(googleOnly).not.toContain("btn-microsoft");
    const both = renderProviderChooserPage(LINKS, { providers: ["google", "microsoft"] });
    expect(both).toContain('class="btn btn-google"');
    expect(both).toContain('class="btn btn-microsoft"');
  });

  it("defaults to both buttons when no options are given (pre-trial callers)", () => {
    const html = renderProviderChooserPage(LINKS);
    expect(html).toContain("btn-google");
    expect(html).toContain("btn-microsoft");
  });
});
