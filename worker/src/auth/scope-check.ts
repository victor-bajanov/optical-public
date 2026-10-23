import type { Env } from "../env";
import type { ProviderName } from "../providers/provider-name";
import { googleRequestedScopes, type GoogleConfig } from "./google-identity-provider";
import { microsoftRequestedScopes, type MicrosoftConfig } from "./microsoft-identity-provider";

// Granular consent fails closed (O6). Google's consent screen lets a person
// untick individual permissions, and the token endpoint then returns a grant
// for a subset of what /authorize requested. Optical has no degraded mode, so
// the callback compares the returned `scope` against the PRODUCT scopes it
// requested and refuses the sign-in when any is missing.
//
// The required list is derived from the providers' own requested-scope
// builders (googleRequestedScopes / microsoftRequestedScopes), never a second
// hand-kept list: a provider scope change is checked here with no edit. The
// harness-only scopes (calendar.acls, gmail.readonly, Mail.Read) are in the
// requested list only when their flag is exactly "true", so they count only
// then.
//
// Sign-in/identity scopes are not checked:
//  - Google userinfo.email (and openid/email/profile) is a sign-in scope the
//    consent screen never offers as a checkbox, and fetchIdentity already
//    fails closed when userinfo returns no email.
//  - Microsoft openid/profile/email/offline_access are not reliably echoed in
//    the token response's `scope`.

export type ScopeFlagEnv = Partial<Pick<Env,
  "GOOGLE_ACL_SCOPE_ENABLED" | "GOOGLE_GMAIL_READ_SCOPE_ENABLED" | "MICROSOFT_MAIL_READ_SCOPE_ENABLED">>;

/** Env flags -> GoogleIdentityProvider scope options. Shared with
 *  index-providers.ts so the request and the check read the flags the same
 *  way. */
export function googleScopeOptions(env: ScopeFlagEnv): Pick<GoogleConfig, "aclScopeEnabled" | "gmailReadScopeEnabled"> {
  return {
    aclScopeEnabled: env.GOOGLE_ACL_SCOPE_ENABLED === "true",
    gmailReadScopeEnabled: env.GOOGLE_GMAIL_READ_SCOPE_ENABLED === "true",
  };
}

/** Env flags -> MicrosoftIdentityProvider scope options (see above). */
export function microsoftScopeOptions(env: ScopeFlagEnv): Pick<MicrosoftConfig, "mailReadScopeEnabled"> {
  return { mailReadScopeEnabled: env.MICROSOFT_MAIL_READ_SCOPE_ENABLED === "true" };
}

const GRAPH_PREFIX = "https://graph.microsoft.com/";

const IDENTITY_SCOPES: Record<ProviderName, ReadonlySet<string>> = {
  google: new Set([
    "openid", "email", "profile",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
  ]),
  microsoft: new Set(["openid", "profile", "email", "offline_access"]),
};

/** One scope in comparison form: lower-case; for Microsoft, the Graph
 *  resource prefix stripped (the token response may echo either form). */
function normalise(provider: ProviderName, scope: string): string {
  const s = scope.trim().toLowerCase();
  if (provider === "microsoft" && s.startsWith(GRAPH_PREFIX)) return s.slice(GRAPH_PREFIX.length);
  return s;
}

/** Product scopes the callback requires, normalised, in request order. */
export function requiredProductScopes(provider: ProviderName, env: ScopeFlagEnv): string[] {
  const requested = provider === "microsoft"
    ? microsoftRequestedScopes(microsoftScopeOptions(env))
    : googleRequestedScopes(googleScopeOptions(env));
  return requested.map((s) => normalise(provider, s)).filter((s) => !IDENTITY_SCOPES[provider].has(s));
}

/** The token response's space-delimited `scope`, normalised. A missing or
 *  empty field parses to the empty set. */
export function parseGranted(provider: ProviderName, raw: string | null | undefined): Set<string> {
  return new Set((raw ?? "").split(/\s+/).filter(Boolean).map((s) => normalise(provider, s)));
}

/**
 * Required product scopes absent from the grant (empty = pass). A superset
 * grant passes: Google's include_granted_scopes=true returns the union with
 * earlier grants, and Graph's grant covers every scope consented so far.
 *
 * A response with NO scope field fails closed (everything is missing). Both
 * IdPs always return `scope` on a successful code exchange, so its absence is
 * an unexpected response this check cannot verify, and the card's posture is
 * fail closed rather than degraded.
 */
export function missingProductScopes(provider: ProviderName, env: ScopeFlagEnv, rawGranted: string | null | undefined): string[] {
  const granted = parseGranted(provider, rawGranted);
  return requiredProductScopes(provider, env).filter((s) => !granted.has(s));
}

/**
 * Require exact provider scopes (REQUIRE_EXACT_PROVIDER_SCOPES). True unless
 * the var is exactly "false": absent, blank or any other spelling keeps the
 * fail-closed check above. "false" lets a sign-in whose grant lacks product
 * scopes through (the callback logs auth_callback_scopes_relaxed and revokes
 * nothing); the calls needing the missing scope then fail at the provider.
 */
export function requireExactProviderScopes(env: Partial<Pick<Env, "REQUIRE_EXACT_PROVIDER_SCOPES">>): boolean {
  return env.REQUIRE_EXACT_PROVIDER_SCOPES !== "false";
}

// Human words for the refusal page, close to what each consent screen shows.
// Keyed by normalised scope (Google URLs and bare Graph names cannot collide).
const LABELS: Record<string, string> = {
  "https://www.googleapis.com/auth/calendar.events": "View and edit events on your calendars",
  "https://www.googleapis.com/auth/calendar.freebusy": "See your availability on your calendars",
  "https://www.googleapis.com/auth/gmail.send": "Send email on your behalf",
  "https://www.googleapis.com/auth/calendar.acls": "See and change the sharing permissions of calendars you own",
  "https://www.googleapis.com/auth/gmail.readonly": "View your email messages and settings",
  "calendars.readwrite": "Have full access to your calendars",
  "mail.send": "Send mail as you",
  "mail.read": "Read your mail",
};

/** Human-readable name for a normalised scope; unknown scopes fall back to
 *  the scope string itself. */
export function scopeLabel(scope: string): string {
  return LABELS[scope] ?? scope;
}
