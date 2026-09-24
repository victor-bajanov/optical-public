import type { IdentityProvider, UpstreamTokens } from "./identity-provider";

// Delegated Graph scopes. Calendars.ReadWrite covers getSchedule (freebusy);
// Mail.Send covers replan emails from the user's own mailbox. All are
// user-consentable (no admin consent) outside locked-down tenants.
const MICROSOFT_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "https://graph.microsoft.com/Calendars.ReadWrite",
  "https://graph.microsoft.com/Mail.Send",
  // No User.Read: identity comes from the id_token, not Graph /me (below).
];

// Non-prod only: appended when the host env opts in via mailReadScopeEnabled.
// Lets a raw token read the organiser's Sent Items so poll-smoke can pull
// invitee capability tokens straight out of the mailbox instead of an
// operator pasting them in — the exact Microsoft counterpart of Google's
// GOOGLE_GMAIL_READ_SCOPE_ENABLED / gmail.readonly. NEVER set under the
// top-level (prod) vars.
const MICROSOFT_MAIL_READ_SCOPE = "https://graph.microsoft.com/Mail.Read";

interface IdTokenClaims {
  aud?: string;
  exp?: number;
  tid?: string;
  oid?: string;
  email?: string;
  xms_edov?: boolean | string;
  preferred_username?: string;
}

function decodeJwtPayload(token: string): IdTokenClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("id_token_malformed");
  const b64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  let parsed: unknown;
  try {
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("id_token_malformed");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("id_token_malformed");
  return parsed as IdTokenClaims;
}

export interface MicrosoftConfig {
  clientId: string;
  clientSecret: string;
  /** Entra tenant segment: "common" (work/school + personal, the product
   *  decision), "organizations", "consumers", or a tenant GUID. */
  tenant?: string;
  /** Non-prod only: when true, append Mail.Read to the requested scope list. */
  mailReadScopeEnabled?: boolean;
}

export class MicrosoftIdentityProvider implements IdentityProvider {
  readonly scopes: string[];
  private readonly tenant: string;
  constructor(private cfg: MicrosoftConfig) {
    this.tenant = cfg.tenant ?? "common";
    this.scopes = [...MICROSOFT_SCOPES];
    if (cfg.mailReadScopeEnabled) this.scopes.push(MICROSOFT_MAIL_READ_SCOPE);
  }

  private tokenEndpoint(): string {
    return `https://login.microsoftonline.com/${this.tenant}/oauth2/v2.0/token`;
  }

  authorizeUrl({ state, redirectUri }: { state: string; redirectUri: string }): string {
    const u = new URL(`https://login.microsoftonline.com/${this.tenant}/oauth2/v2.0/authorize`);
    u.searchParams.set("client_id", this.cfg.clientId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", this.scopes.join(" "));
    // No prompt=consent (unlike Google): offline_access alone yields a refresh
    // token, and forcing re-consent every login is hostile. select_account lets
    // multi-account users pick.
    u.searchParams.set("prompt", "select_account");
    u.searchParams.set("state", state);
    return u.toString();
  }

  async exchangeCode(code: string, redirectUri: string): Promise<UpstreamTokens> {
    const resp = await fetch(this.tokenEndpoint(), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code, client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret,
        redirect_uri: redirectUri, grant_type: "authorization_code",
      }),
    });
    if (!resp.ok) throw new Error(`microsoft token exchange failed: ${await resp.text()}`);
    const t = (await resp.json()) as {
      access_token: string; refresh_token?: string; expires_in: number; scope?: string; id_token?: string;
    };
    return {
      accessToken: t.access_token, refreshToken: t.refresh_token, expiresIn: t.expires_in,
      scope: t.scope ?? "", idToken: t.id_token,
    };
  }

  /**
   * Identity is derived from the id_token, never from Graph /me.
   *
   * Why: /me.mail (and the unverified `email` claim) are free-text attributes
   * any tenant admin can set to someone else's address. Under the multi-tenant
   * `common` endpoint that is an account-takeover primitive (the "nOAuth"
   * class): an attacker tenant sets a user's mail to an allow-listed address
   * and signs in as them. Verified identifiers only:
   *   1. `email` when `xms_edov` is true (Entra attests the domain owner);
   *   2. else `preferred_username` — the UPN, whose domain suffix is always a
   *      domain verified by the issuing tenant (for the consumer tenant it is
   *      the MSA address itself);
   *   3. guests (`#EXT#` UPNs) and anything else are rejected.
   * The token came straight from the token endpoint over TLS in a confidential-
   * client exchange, so the payload is trusted without a signature check; aud,
   * exp and the tid/oid subject claims are still validated.
   */
  async fetchIdentity(_accessToken: string, opts?: { idToken?: string }): Promise<{ email: string; providerSubject: string }> {
    if (!opts?.idToken) throw new Error("missing_id_token");
    const claims = decodeJwtPayload(opts.idToken);
    if (claims.aud !== this.cfg.clientId) throw new Error("id_token_aud_mismatch");
    if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) throw new Error("id_token_expired");
    if (!claims.tid || !claims.oid) throw new Error("id_token_missing_subject_claims");
    // Immutable across email/UPN renames — tid:oid identifies the Entra
    // object across the tenant, whereas email/UPN can be changed by an admin.
    const providerSubject = `${claims.tid}:${claims.oid}`;

    const domainVerified = claims.xms_edov === true || claims.xms_edov === "true";
    if (domainVerified && claims.email && claims.email.includes("@")) {
      return { email: claims.email, providerSubject };
    }
    const upn = claims.preferred_username;
    if (!upn || !upn.includes("@") || upn.includes("#EXT#")) throw new Error("unverified_identity");
    // Work/school and consumer (tid 9188040d-6c67-4c5b-b112-36a304b66dad)
    // alike: the UPN is a tenant-verified identifier.
    return { email: upn, providerSubject };
  }

  async refreshAccessToken(refreshToken: string) {
    const resp = await fetch(this.tokenEndpoint(), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret,
        refresh_token: refreshToken, grant_type: "refresh_token",
      }),
    });
    if (!resp.ok) throw new Error(`microsoft refresh failed: ${await resp.text()}`);
    const t = (await resp.json()) as { access_token: string; expires_in: number; refresh_token?: string };
    // Microsoft rotates: pass the new refresh token up so identity-store persists it.
    return { accessToken: t.access_token, expiresIn: t.expires_in, refreshToken: t.refresh_token };
  }
}
