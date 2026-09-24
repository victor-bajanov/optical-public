import { describe, it, expect, vi, afterEach } from "vitest";
import { MicrosoftIdentityProvider } from "../../src/auth/microsoft-identity-provider";

const cfg = { clientId: "cid", clientSecret: "sec" };
afterEach(() => vi.unstubAllGlobals());

/** Unsigned JWT with the given payload — the token endpoint hands id_tokens
 *  straight to the confidential client over TLS, so the provider decodes the
 *  payload and does not verify the signature. */
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64({ alg: "RS256", typ: "JWT" })}.${b64(payload)}.sig`;
}

describe("MicrosoftIdentityProvider", () => {
  it("builds a v2.0 authorize URL on the common tenant with required scopes", () => {
    const idp = new MicrosoftIdentityProvider(cfg);
    const u = new URL(idp.authorizeUrl({ state: "st", redirectUri: "https://app/cb" }));
    expect(u.origin + u.pathname).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(u.searchParams.get("client_id")).toBe("cid");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("redirect_uri")).toBe("https://app/cb");
    expect(u.searchParams.get("state")).toBe("st");
    const scope = u.searchParams.get("scope")!;
    for (const s of ["openid", "profile", "email", "offline_access",
      "https://graph.microsoft.com/Calendars.ReadWrite", "https://graph.microsoft.com/Mail.Send"]) {
      expect(scope).toContain(s);
    }
    // Identity comes from the id_token now; Graph /me (and User.Read) are gone.
    expect(scope).not.toContain("User.Read");
  });

  describe("mailReadScopeEnabled", () => {
    const MAIL_READ = "https://graph.microsoft.com/Mail.Read";

    it("omits Mail.Read by default", () => {
      const idp = new MicrosoftIdentityProvider(cfg);
      expect(idp.scopes).not.toContain(MAIL_READ);
    });

    it("omits Mail.Read when explicitly false", () => {
      const idp = new MicrosoftIdentityProvider({ ...cfg, mailReadScopeEnabled: false });
      expect(idp.scopes).not.toContain(MAIL_READ);
    });

    it("appends Mail.Read to scopes (and the authorize URL) when true", () => {
      const idp = new MicrosoftIdentityProvider({ ...cfg, mailReadScopeEnabled: true });
      expect(idp.scopes).toContain(MAIL_READ);
      const u = new URL(idp.authorizeUrl({ state: "st", redirectUri: "https://app/cb" }));
      expect(u.searchParams.get("scope")).toContain(MAIL_READ);
    });
  });

  it("exchanges a code for tokens", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      access_token: "at", refresh_token: "rt", expires_in: 3599, scope: "openid Calendars.ReadWrite",
    }))));
    const t = await new MicrosoftIdentityProvider(cfg).exchangeCode("code123", "https://app/cb");
    expect(t).toEqual({ accessToken: "at", refreshToken: "rt", expiresIn: 3599, scope: "openid Calendars.ReadWrite" });
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/token");
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("code123");
  });

  it("exchangeCode surfaces the id_token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      access_token: "at", refresh_token: "rt", expires_in: 3599, scope: "s", id_token: "h.p.s",
    }))));
    const t = await new MicrosoftIdentityProvider(cfg).exchangeCode("code123", "https://app/cb");
    expect(t.idToken).toBe("h.p.s");
  });

  describe("fetchIdentity (id_token based — never Graph /me.mail)", () => {
    const WORK_TID = "11111111-2222-3333-4444-555555555555";
    const MSA_TID = "9188040d-6c67-4c5b-b112-36a304b66dad";
    const base = { aud: "cid", exp: Math.floor(Date.now() / 1000) + 600, tid: WORK_TID, oid: "oid-1" };
    const noFetch = () => vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network must not be used"); }));

    it("uses the email claim when Entra marks its domain owner-verified (xms_edov)", async () => {
      noFetch();
      const idToken = jwt({ ...base, email: "victor@example.org", xms_edov: true, preferred_username: "victor@t.onmicrosoft.com" });
      expect(await new MicrosoftIdentityProvider(cfg).fetchIdentity("at", { idToken })).toEqual({ email: "victor@example.org", providerSubject: `${WORK_TID}:oid-1` });
    });

    it("falls back to the UPN (preferred_username) when the email claim is not domain-verified", async () => {
      noFetch();
      const idToken = jwt({ ...base, email: "victim@example.com", preferred_username: "attacker@evil.onmicrosoft.com" });
      expect(await new MicrosoftIdentityProvider(cfg).fetchIdentity("at", { idToken })).toEqual({ email: "attacker@evil.onmicrosoft.com", providerSubject: `${WORK_TID}:oid-1` });
    });

    it("accepts a consumer (MSA) account by its UPN", async () => {
      noFetch();
      const idToken = jwt({ ...base, tid: MSA_TID, preferred_username: "someone@outlook.com" });
      expect(await new MicrosoftIdentityProvider(cfg).fetchIdentity("at", { idToken })).toEqual({ email: "someone@outlook.com", providerSubject: `${MSA_TID}:oid-1` });
    });

    it("keys the same oid in two different tenants as two different provider subjects (no cross-tenant collision)", async () => {
      // nOAuth follow-on: an attacker tenant can mint any oid it likes, but it
      // can never mint a victim's tid, so tid must be part of the anchor. Two
      // tokens that share an oid but differ in tid must not resolve to the same
      // provider_subject — otherwise Card G's subject-match lookup would hand
      // the attacker the victim's account.
      noFetch();
      const victim = jwt({ ...base, tid: WORK_TID, oid: "shared-oid", email: "victim@example.com", xms_edov: true, preferred_username: "victim@example.com" });
      const attacker = jwt({ ...base, tid: "99999999-8888-7777-6666-555555555555", oid: "shared-oid", preferred_username: "attacker@evil.onmicrosoft.com" });
      const idp = new MicrosoftIdentityProvider(cfg);
      const a = await idp.fetchIdentity("at", { idToken: victim });
      const b = await idp.fetchIdentity("at", { idToken: attacker });
      expect(a.providerSubject).toBe(`${WORK_TID}:shared-oid`);
      expect(b.providerSubject).toBe("99999999-8888-7777-6666-555555555555:shared-oid");
      expect(a.providerSubject).not.toBe(b.providerSubject);
    });

    it("rejects a guest (#EXT#) UPN", async () => {
      noFetch();
      const idToken = jwt({ ...base, preferred_username: "victim_gmail.com#EXT#@evil.onmicrosoft.com" });
      await expect(new MicrosoftIdentityProvider(cfg).fetchIdentity("at", { idToken })).rejects.toThrow("unverified_identity");
    });

    it("rejects when no id_token is supplied (never consults Graph /me)", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ mail: "victim@example.com" }))));
      await expect(new MicrosoftIdentityProvider(cfg).fetchIdentity("at")).rejects.toThrow("missing_id_token");
      expect(fetch).not.toHaveBeenCalled();
    });

    it("rejects an id_token for another client (aud)", async () => {
      noFetch();
      const idToken = jwt({ ...base, aud: "other", preferred_username: "v@t.onmicrosoft.com" });
      await expect(new MicrosoftIdentityProvider(cfg).fetchIdentity("at", { idToken })).rejects.toThrow("id_token_aud_mismatch");
    });

    it("rejects an expired id_token", async () => {
      noFetch();
      const idToken = jwt({ ...base, exp: Math.floor(Date.now() / 1000) - 5, preferred_username: "v@t.onmicrosoft.com" });
      await expect(new MicrosoftIdentityProvider(cfg).fetchIdentity("at", { idToken })).rejects.toThrow("id_token_expired");
    });

    it("rejects an id_token without tid/oid", async () => {
      noFetch();
      const idToken = jwt({ aud: "cid", exp: base.exp, preferred_username: "v@t.onmicrosoft.com" });
      await expect(new MicrosoftIdentityProvider(cfg).fetchIdentity("at", { idToken })).rejects.toThrow("id_token_missing_subject_claims");
    });

    it("decodes non-ASCII claims as UTF-8", async () => {
      noFetch();
      const payload = JSON.stringify({ ...base, email: "jürgen@example.org", xms_edov: true });
      const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const idToken = `${b64(new TextEncoder().encode('{"alg":"RS256"}'))}.${b64(new TextEncoder().encode(payload))}.sig`;
      expect(await new MicrosoftIdentityProvider(cfg).fetchIdentity("at", { idToken })).toEqual({ email: "jürgen@example.org", providerSubject: `${WORK_TID}:oid-1` });
    });

    it("rejects a payload that is not a JSON object", async () => {
      noFetch();
      const b64 = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const idToken = `${b64('{"alg":"RS256"}')}.${b64('"just a string"')}.sig`;
      await expect(new MicrosoftIdentityProvider(cfg).fetchIdentity("at", { idToken })).rejects.toThrow("id_token_malformed");
    });

    it("rejects when neither a verified email nor a UPN is present", async () => {
      noFetch();
      const idToken = jwt({ ...base, email: "x@y.z" });
      await expect(new MicrosoftIdentityProvider(cfg).fetchIdentity("at", { idToken })).rejects.toThrow("unverified_identity");
    });
  });

  it("refreshAccessToken surfaces the ROTATED refresh token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      access_token: "at2", refresh_token: "rt2", expires_in: 3599,
    }))));
    const r = await new MicrosoftIdentityProvider(cfg).refreshAccessToken("rt1");
    expect(r).toEqual({ accessToken: "at2", expiresIn: 3599, refreshToken: "rt2" });
  });
});
