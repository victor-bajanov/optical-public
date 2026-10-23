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

describe("GoogleIdentityProvider.revokeGrant", () => {
  const idp = new GoogleIdentityProvider({ clientId: "cid", clientSecret: "sec" });
  const stub = (res: () => Response) => {
    const f = vi.fn(async () => res());
    vi.stubGlobal("fetch", f);
    return f;
  };
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs the token form-encoded to Google's revoke endpoint", async () => {
    const f = stub(() => new Response("{}", { status: 200 }));
    await idp.revokeGrant("1//refresh-abc");
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://oauth2.googleapis.com/revoke");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
    const body = new URLSearchParams(String(init.body));
    expect([...body.keys()]).toEqual(["token"]);
    expect(body.get("token")).toBe("1//refresh-abc");
  });

  it("accepts an access token as well (the callback revokes a fresh grant before any refresh token is stored)", async () => {
    const f = stub(() => new Response("{}", { status: 200 }));
    await idp.revokeGrant("ya29.access-xyz");
    const [, init] = f.mock.calls[0]! as unknown as [string, RequestInit];
    expect(new URLSearchParams(String(init.body)).get("token")).toBe("ya29.access-xyz");
  });

  it("treats 400 invalid_token (already revoked / expired) as done", async () => {
    stub(() => new Response(JSON.stringify({ error: "invalid_token", error_description: "Token expired or revoked" }), { status: 400 }));
    await expect(idp.revokeGrant("gone")).resolves.toBeUndefined();
  });

  it("throws on any other 400 error code", async () => {
    stub(() => new Response(JSON.stringify({ error: "invalid_request" }), { status: 400 }));
    await expect(idp.revokeGrant("t")).rejects.toThrow(/google revoke failed: 400 invalid_request/);
  });

  it("throws on a 5xx", async () => {
    stub(() => new Response("upstream sad", { status: 503 }));
    await expect(idp.revokeGrant("t")).rejects.toThrow(/google revoke failed: 503/);
  });

  it("never puts the token in the thrown error", async () => {
    stub(() => new Response("echo secret-tok", { status: 500 }));
    const err = await idp.revokeGrant("secret-tok").catch((e: unknown) => e);
    expect(String(err)).not.toContain("secret-tok");
  });
});
