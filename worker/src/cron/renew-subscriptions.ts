import type { Env } from "../env";
import type { CalendarProvider } from "../providers/calendar-provider";
import { ensureSubscription } from "../webhooks/subscription-manager";
import { listCalendarSyncChannelOwnersWithProvider, listGrantHoldersWithoutChannel } from "../db/calendar-sync";
import { defaultCalendarProvider, ProviderDisabledError } from "../index-providers";
import { webhookCallbackUrl } from "../webhooks/callback-url";
import type { ProviderName } from "../providers/provider-name";
import { isActiveMember } from "../auth/membership";
import { logErrorText, logPseudonym } from "../util/log-redact";

export interface RenewSubscriptionsResult {
  checked: number;
  renewed: number;
  created: number;
  // Create-pass failures, kept apart from `failed` (renew failures only), which
  // alone drives /admin/renew-subscriptions' ok/500: a grant holder with a dead
  // refresh token fails every create attempt, and must not fail the sweep.
  create_failed: number;
  failed: number;
}

// Daily sweep keeping Google push channels alive. Google watch channels expire
// after ~7 days and expiry is silent — no error, pushes just stop — so webhook
// replans go dark unless something re-subscribes before channel_expires_at.
// ensureSubscription only re-subscribes inside its renewal threshold, so running
// this daily is cheap: most days it's a read per owner and no Google calls.
//
// Two passes. RENEW: owners with a channel (above). CREATE (trial finding 1):
// active users holding a stored grant but no channel get their first one, so
// a user whose sign-in subscribe failed (webhooks/sign-in-subscribe.ts), or
// whose channel was nulled by a provider switch, self-heals within a day.
export async function runRenewSubscriptions(
  env: Env,
  now: Date,
  makeCalendar: (subject: string, provider: ProviderName) => CalendarProvider | Promise<CalendarProvider> =
    (subject, provider) => defaultCalendarProvider(env, subject, provider),
): Promise<RenewSubscriptionsResult> {
  const owners = await listCalendarSyncChannelOwnersWithProvider(env.DB);
  let renewed = 0;
  let failed = 0;
  // Sequential per-owner fan-out, one failure never aborts the others — same
  // posture as the Monday-resolve cron.
  for (const { owner_subject: owner, provider: providerName } of owners) {
    try {
      // Card C: renewing is a call with the owner's grant, so a delisted-but-
      // not-offboarded owner's channel is left to lapse while an allow-list
      // is set (counted in `checked` only). Self-healing: the row keeps its
      // channel_id, so once re-listed the next run sees it expired and
      // re-subscribes.
      if (!(await isActiveMember(env, owner, "subscription_renewal"))) continue;
      const callbackUrl = webhookCallbackUrl(env, providerName);
      const result = await ensureSubscription({
        db: env.DB,
        ownerSubject: owner,
        calendar: await makeCalendar(owner, providerName),
        callbackUrl,
        now,
      });
      if (result.subscribed) renewed += 1;
    } catch (e) {
      failed += 1;
      // Daily, so never the address itself: a keyed pseudonym an operator can
      // recompute for a known subject (runbook), also substituted for the
      // address inside the error text, which is collapsed and capped.
      const pseudonym = await logPseudonym(env, owner);
      console.error("subscription-renewal failed", { subject: pseudonym, error: logErrorText(e, { subject: owner, pseudonym }) });
    }
  }

  // Read after the renew pass, so the two sets stay disjoint. Same per-owner
  // isolation and delisted skip. A deliberately disabled provider (the
  // Microsoft kill switch) is a skip, not a failure: it would otherwise fail
  // every day for every Microsoft user while the switch is off.
  const channelless = await listGrantHoldersWithoutChannel(env.DB);
  let created = 0;
  let createFailed = 0;
  for (const { owner_subject: owner, provider: providerName } of channelless) {
    try {
      if (!(await isActiveMember(env, owner, "subscription_renewal"))) continue;
      const result = await ensureSubscription({
        db: env.DB,
        ownerSubject: owner,
        calendar: await makeCalendar(owner, providerName),
        callbackUrl: webhookCallbackUrl(env, providerName),
        now,
      });
      if (result.subscribed) created += 1;
    } catch (e) {
      if (e instanceof ProviderDisabledError) continue;
      createFailed += 1;
      const pseudonym = await logPseudonym(env, owner);
      console.error("subscription-create failed", { subject: pseudonym, error: logErrorText(e, { subject: owner, pseudonym }) });
    }
  }

  const summary = { checked: owners.length + channelless.length, renewed, created, create_failed: createFailed, failed };
  console.info("subscription_renewal", summary);
  return summary;
}
