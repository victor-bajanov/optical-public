import { describe, it, expect, vi, afterEach } from "vitest";
import { GoogleIdentityProvider } from "../../src/auth/google-identity-provider";

const ACL = "https://www.googleapis.com/auth/calendar.acls";
const GMAIL_READ = "https://www.googleapis.com/auth/gmail.readonly";

describe("GoogleIdentityProvider scopes", () => {
  it("requests the calendar.freebusy scope", () => {
    const p = new GoogleIdentityProvider({ clientId: "c", clientSecret: "s" });
    expect(p.scopes).toContain("https://www.googleapis.com/auth/calendar.freebusy");
  });
  it("still includes calendar.events and gmail.send", () => {
    const p = new GoogleIdentityProvider({ clientId: "c", clientSecret: "s" });
    expect(p.scopes).toContain("https://www.googleapis.com/auth/calendar.events");
    expect(p.scopes).toContain("https://www.googleapis.com/auth/gmail.send");
  });
  it("omits calendar.acls by default", () => {
    const p = new GoogleIdentityProvider({ clientId: "c", clientSecret: "s" });
    expect(p.scopes).not.toContain(ACL);
  });
  it("appends calendar.acls when aclScopeEnabled is true", () => {
    const p = new GoogleIdentityProvider({ clientId: "c", clientSecret: "s", aclScopeEnabled: true });
    expect(p.scopes).toContain(ACL);
    expect(p.scopes).toContain("https://www.googleapis.com/auth/calendar.events");
    expect(p.scopes).toContain("https://www.googleapis.com/auth/calendar.freebusy");
  });

  describe("gmailReadScopeEnabled", () => {
    it("omits gmail.readonly when both flags are off", () => {
      const p = new GoogleIdentityProvider({ clientId: "c", clientSecret: "s" });
      expect(p.scopes).not.toContain(GMAIL_READ);
      expect(p.scopes).not.toContain(ACL);
    });
    it("appends only calendar.acls when acl-only is enabled", () => {
      const p = new GoogleIdentityProvider({ clientId: "c", clientSecret: "s", aclScopeEnabled: true });
      expect(p.scopes).toContain(ACL);
      expect(p.scopes).not.toContain(GMAIL_READ);
    });
    it("appends only gmail.readonly when gmail-only is enabled", () => {
      const p = new GoogleIdentityProvider({ clientId: "c", clientSecret: "s", gmailReadScopeEnabled: true });
      expect(p.scopes).toContain(GMAIL_READ);
      expect(p.scopes).not.toContain(ACL);
    });
    it("appends both scopes when both flags are enabled", () => {
      const p = new GoogleIdentityProvider({
        clientId: "c", clientSecret: "s", aclScopeEnabled: true, gmailReadScopeEnabled: true,
      });
      expect(p.scopes).toContain(ACL);
      expect(p.scopes).toContain(GMAIL_READ);
      expect(p.scopes).toContain("https://www.googleapis.com/auth/calendar.events");
    });
  });
});

describe("GoogleIdentityProvider.fetchIdentity", () => {
  const idp = new GoogleIdentityProvider({ clientId: "cid", clientSecret: "sec", aclScopeEnabled: false, gmailReadScopeEnabled: false });
  const userinfo = (body: Record<string, unknown>) =>
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body))));
  afterEach(() => vi.unstubAllGlobals());

  it("accepts a Google-verified email and returns userinfo's id as providerSubject", async () => {
    userinfo({ id: "1234567890", email: "operator@example.com", verified_email: true });
    await expect(idp.fetchIdentity("at")).resolves.toEqual({ email: "operator@example.com", providerSubject: "1234567890" });
  });

  it("rejects an email Google reports as unverified", async () => {
    // Google's guidance: trust `email` only when verified_email is true (legacy
    // Google-account-on-a-non-Google-address flows can carry unverified ones).
    userinfo({ id: "1234567890", email: "victim@example.com", verified_email: false });
    await expect(idp.fetchIdentity("at")).rejects.toThrow("unverified_email");
  });

  it("rejects when verified_email is absent (fail closed)", async () => {
    userinfo({ id: "1234567890", email: "victim@example.com" });
    await expect(idp.fetchIdentity("at")).rejects.toThrow("unverified_email");
  });

  it("rejects when userinfo has no id — same fail-closed posture as unverified_email", async () => {
    userinfo({ email: "operator@example.com", verified_email: true });
    await expect(idp.fetchIdentity("at")).rejects.toThrow("no_subject_in_userinfo");
  });
});
