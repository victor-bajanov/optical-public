import type { IdentityProvider, UpstreamTokens } from "./identity-provider";

const BASE_GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/userinfo.email",
];

// Granular ACL management scope (NOT full `calendar`). Appended only when the
// host env opts in via aclScopeEnabled — dev only. Lets a raw token insert/delete
// freeBusyReader sharing rules so the meeting-smoke harness can set its own topology.
const GOOGLE_ACL_SCOPE = "https://www.googleapis.com/auth/calendar.acls";

// Read-only Gmail scope. Appended only when the host env opts in via
// gmailReadScopeEnabled — dev only. Lets a raw token read the organiser's Sent
// mail so poll-smoke can pull invitee capability tokens straight out of the
// mailbox instead of an operator pasting them in.
const GOOGLE_GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  /** Dev only: when true, append calendar.acls to the requested scope list. */
  aclScopeEnabled?: boolean;
  /** Dev only: when true, append gmail.readonly to the requested scope list. */
  gmailReadScopeEnabled?: boolean;
}

export class GoogleIdentityProvider implements IdentityProvider {
  readonly scopes: string[];
  constructor(private cfg: GoogleConfig) {
    this.scopes = [...BASE_GOOGLE_SCOPES];
    if (cfg.aclScopeEnabled) this.scopes.push(GOOGLE_ACL_SCOPE);
    if (cfg.gmailReadScopeEnabled) this.scopes.push(GOOGLE_GMAIL_READ_SCOPE);
  }

  authorizeUrl({ state, redirectUri }: { state: string; redirectUri: string }): string {
    const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    u.searchParams.set("client_id", this.cfg.clientId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", this.scopes.join(" "));
    u.searchParams.set("access_type", "offline");
    u.searchParams.set("prompt", "consent");
    u.searchParams.set("include_granted_scopes", "true");
    u.searchParams.set("state", state);
    return u.toString();
  }

  async exchangeCode(code: string, redirectUri: string): Promise<UpstreamTokens> {
    const resp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code, client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret,
        redirect_uri: redirectUri, grant_type: "authorization_code",
      }),
    });
    if (!resp.ok) throw new Error(`google token exchange failed: ${await resp.text()}`);
    const t = (await resp.json()) as {
      access_token: string; refresh_token?: string; expires_in: number; scope: string;
    };
    return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresIn: t.expires_in, scope: t.scope };
  }

  async fetchIdentity(accessToken: string, _opts?: { idToken?: string }): Promise<{ email: string; providerSubject: string }> {
    const resp = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) throw new Error(`google userinfo failed: ${await resp.text()}`);
    const u = (await resp.json()) as { id?: string; email?: string; verified_email?: boolean };
    if (!u.email) throw new Error("no_email_in_userinfo");
    // Google's guidance: `email` is trustworthy only when verified_email is
    // true (legacy Google-account-on-a-non-Google-address flows can carry an
    // unverified one). Fail closed when the flag is absent — same posture as
    // the Microsoft provider's unverified_identity reject.
    if (u.verified_email !== true) throw new Error("unverified_email");
    // `id` is the Google account's immutable numeric identifier — stable
    // across email changes, unlike `email` itself. Fail closed if absent
    // (same posture as unverified_email) rather than silently anchoring on
    // nothing.
    if (!u.id) throw new Error("no_subject_in_userinfo");
    return { email: u.email, providerSubject: u.id };
  }

  async refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresIn: number }> {
    const resp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret,
        refresh_token: refreshToken, grant_type: "refresh_token",
      }),
    });
    if (!resp.ok) throw new Error(`google refresh failed: ${await resp.text()}`);
    const t = (await resp.json()) as { access_token: string; expires_in: number };
    return { accessToken: t.access_token, expiresIn: t.expires_in };
  }
}
