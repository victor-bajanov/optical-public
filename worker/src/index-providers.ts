import { GoogleCalendarProvider } from "./providers/google-calendar-provider";
import { GmailNotificationProvider } from "./providers/gmail-notification-provider";
import { MicrosoftCalendarProvider } from "./providers/microsoft-calendar-provider";
import { MicrosoftGraphNotificationProvider } from "./providers/microsoft-graph-notification-provider";
import type { CalendarProvider } from "./providers/calendar-provider";
import type { NotificationProvider } from "./providers/notification-provider";
import type { IdentityProvider } from "./auth/identity-provider";
import { injectedIdentityProvider } from "./auth/identity-provider";
import { GoogleIdentityProvider } from "./auth/google-identity-provider";
import { MicrosoftIdentityProvider } from "./auth/microsoft-identity-provider";
import { getAccessToken, getSubjectProvider } from "./auth/identity-store";
import type { ProviderName } from "./providers/provider-name";
import type { Env } from "./env";

export interface AppVariables {
  calendarProvider: CalendarProvider;
  notificationProvider: NotificationProvider;
  subject?: string; // set by requireBearer (a later task)
  ownerSubject?: string; // set by requireSubject on owned routes
}

export function microsoftEnabled(env: Env): boolean {
  return env.MS_PROVIDER_ENABLED === "true";
}

/** Providers a user may SIGN IN with, in chooser order. Microsoft is offered
 *  only when the kill switch is on AND the Entra client id is real — the
 *  wrangler.toml placeholder (`<set after …>`) or an empty value would send
 *  the user to an AADSTS error page. This gates /oauth/authorize only; the
 *  kill switch for already-provisioned subjects is microsoftEnabled() alone. */
export function enabledProviders(env: Env): ProviderName[] {
  const clientId = (env.MICROSOFT_OAUTH_CLIENT_ID ?? "").trim();
  const entraConfigured = clientId.length > 0 && !clientId.startsWith("<");
  return microsoftEnabled(env) && entraConfigured ? ["google", "microsoft"] : ["google"];
}

/** Thrown by defaultIdentityProvider when Microsoft sign-in is requested but
 *  MS_PROVIDER_ENABLED !== "true" (the kill switch). Callers that treat
 *  provider-construction failure as best-effort (e.g. lifecycle/offboard.ts's
 *  calendar cleanup) must check `instanceof ProviderDisabledError`
 *  specifically and rethrow anything else — a transient error (D1 outage,
 *  KV failure) is not the same as "this subject's provider is intentionally
 *  disabled" and must not be silently swallowed. Message is kept exactly
 *  "ms_provider_disabled" for log readability. */
export class ProviderDisabledError extends Error {
  constructor() {
    super("ms_provider_disabled");
    this.name = "ProviderDisabledError";
  }
}

export function defaultIdentityProvider(env: Env, provider: ProviderName = "google"): IdentityProvider {
  const injected = injectedIdentityProvider();
  if (injected) return injected;
  if (provider === "microsoft") {
    if (!microsoftEnabled(env)) throw new ProviderDisabledError();
    return new MicrosoftIdentityProvider({
      clientId: env.MICROSOFT_OAUTH_CLIENT_ID ?? "",
      clientSecret: env.MICROSOFT_OAUTH_CLIENT_SECRET ?? "",
      tenant: env.MICROSOFT_TENANT,
      mailReadScopeEnabled: env.MICROSOFT_MAIL_READ_SCOPE_ENABLED === "true",
    });
  }
  return new GoogleIdentityProvider({
    clientId: env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    aclScopeEnabled: env.GOOGLE_ACL_SCOPE_ENABLED === "true",
    gmailReadScopeEnabled: env.GOOGLE_GMAIL_READ_SCOPE_ENABLED === "true",
  });
}

export async function defaultCalendarProvider(
  env: Env, subject: string, providerArg?: ProviderName,
): Promise<CalendarProvider> {
  const provider = providerArg ?? await getSubjectProvider(env, subject);
  const idp = defaultIdentityProvider(env, provider);
  const getToken = async (opts?: { forceRefresh?: boolean }) => getAccessToken(env, idp, subject, opts);
  if (provider === "microsoft") {
    return new MicrosoftCalendarProvider({ getAccessToken: getToken });
  }
  return new GoogleCalendarProvider({ calendarId: "primary", getAccessToken: getToken });
}

export async function defaultNotificationProvider(
  env: Env, subject: string, providerArg?: ProviderName,
): Promise<NotificationProvider> {
  const provider = providerArg ?? await getSubjectProvider(env, subject);
  const idp = defaultIdentityProvider(env, provider);
  const getToken = async (opts?: { forceRefresh?: boolean }) => getAccessToken(env, idp, subject, opts);
  if (provider === "microsoft") {
    return new MicrosoftGraphNotificationProvider({ getAccessToken: getToken });
  }
  return new GmailNotificationProvider({ getFrom: () => Promise.resolve(subject), getAccessToken: getToken });
}

/**
 * Bundle factory used by the four call sites that previously duplicated the
 * "resolve the provider name, then build both providers" preamble
 * (cron/scheduled-entry.ts, durable-objects/resolve-coordinator.ts,
 * admin/run-cron-route.ts, handlers/replan-now.ts). Resolves the provider
 * name exactly once and builds calendar + notification off the same
 * identity provider / token getter.
 *
 * ALWAYS resolves the subject's stored provider via getSubjectProvider,
 * even when MS_PROVIDER_ENABLED is off. MS_PROVIDER_ENABLED is a runtime
 * kill switch over ALREADY-PROVISIONED rows, not just a new-signup gate
 * (see CLAUDE.md, M365 provider section): flipping it off must block token
 * refresh and Graph access for existing Microsoft users too. A subject
 * stored as "microsoft" must still resolve to "microsoft" so it reaches
 * defaultIdentityProvider and throws ProviderDisabledError — silently
 * falling back to "google" here would instead read that subject's live
 * Graph token out of the provider-agnostic GOOGLE_TOKEN_CACHE and hand it to
 * googleapis.com, or on a cache miss, POST their Microsoft refresh token to
 * Google's token endpoint. No caller passes an explicit provider name
 * (unlike defaultCalendarProvider/defaultNotificationProvider, which keep
 * that parameter for their own callers), so there is no legitimate way to
 * bypass this lookup — none is offered.
 */
export async function defaultProviders(
  env: Env, subject: string,
): Promise<{ calendar: CalendarProvider; notification: NotificationProvider }> {
  const provider = await getSubjectProvider(env, subject);
  const idp = defaultIdentityProvider(env, provider);
  const getToken = async (opts?: { forceRefresh?: boolean }) => getAccessToken(env, idp, subject, opts);
  if (provider === "microsoft") {
    return {
      calendar: new MicrosoftCalendarProvider({ getAccessToken: getToken }),
      notification: new MicrosoftGraphNotificationProvider({ getAccessToken: getToken }),
    };
  }
  return {
    calendar: new GoogleCalendarProvider({ calendarId: "primary", getAccessToken: getToken }),
    notification: new GmailNotificationProvider({ getFrom: () => Promise.resolve(subject), getAccessToken: getToken }),
  };
}
