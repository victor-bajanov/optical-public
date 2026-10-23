import type { Env } from "../env";
import type { CalendarProvider } from "../providers/calendar-provider";
import type { ProviderName } from "../providers/provider-name";
import { ensureSubscription } from "./subscription-manager";
import { webhookCallbackUrl } from "./callback-url";
import { defaultCalendarProvider } from "../index-providers";
import { logErrorText, logPseudonym } from "../util/log-redact";

/**
 * Make sure a freshly signed-in subject has a push channel, so calendar edits
 * trigger webhook replans without anyone calling subscribeWebhook by hand.
 * Runs after the OAuth callback has stored the grant (the membership gate has
 * already passed by then). Idempotent through ensureSubscription: a fresh
 * channel costs one D1 read and no provider call, so a repeat sign-in never
 * rotates it.
 *
 * Best-effort: never throws. A failure (provider disabled, a grant missing
 * the calendar scope, a provider 5xx) is logged and left for the daily
 * renewal sweep, which creates missing channels too. Neither log line carries
 * the subject: in the failure line's error text it is replaced by its log
 * pseudonym, and the text is whitespace-collapsed and capped.
 */
export async function ensureSubscriptionOnSignIn(
  env: Env,
  subject: string,
  provider: ProviderName,
  makeCalendar: (subject: string, provider: ProviderName) => CalendarProvider | Promise<CalendarProvider> =
    (s, p) => defaultCalendarProvider(env, s, p),
): Promise<void> {
  try {
    const result = await ensureSubscription({
      db: env.DB,
      ownerSubject: subject,
      calendar: await makeCalendar(subject, provider),
      callbackUrl: webhookCallbackUrl(env, provider),
    });
    console.info("sign_in_subscribe", { provider, subscribed: result.subscribed });
  } catch (e) {
    const pseudonym = await logPseudonym(env, subject);
    console.warn("sign_in_subscribe_failed", { provider, error: logErrorText(e, { subject, pseudonym }) });
  }
}

type SignInSubscriber = (env: Env, subject: string, provider: ProviderName) => Promise<void>;

// Test seam, same idiom as identity-provider.ts __setIdentityProviderForTests:
// the real subscriber builds a live provider, so test/setup.ts installs a
// no-op and the callback tests install recording or mock-backed ones.
let injectedSubscriber: SignInSubscriber | null = null;
export function __setSignInSubscriberForTests(fn: SignInSubscriber | null): void {
  injectedSubscriber = fn;
}
export function signInSubscriber(): SignInSubscriber {
  return injectedSubscriber ?? ((env, subject, provider) => ensureSubscriptionOnSignIn(env, subject, provider));
}
