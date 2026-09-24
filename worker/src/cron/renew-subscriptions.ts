import type { Env } from "../env";
import type { CalendarProvider } from "../providers/calendar-provider";
import { ensureSubscription } from "../webhooks/subscription-manager";
import { listCalendarSyncChannelOwnersWithProvider } from "../db/calendar-sync";
import { defaultCalendarProvider } from "../index-providers";
import { webhookCallbackUrl } from "../webhooks/callback-url";
import type { ProviderName } from "../providers/provider-name";

export interface RenewSubscriptionsResult {
  checked: number;
  renewed: number;
  failed: number;
}

// Daily sweep keeping Google push channels alive. Google watch channels expire
// after ~7 days and expiry is silent — no error, pushes just stop — so webhook
// replans go dark unless something re-subscribes before channel_expires_at.
// ensureSubscription only re-subscribes inside its renewal threshold, so running
// this daily is cheap: most days it's a read per owner and no Google calls.
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
      console.error("subscription-renewal failed", { subject: owner, error: String(e) });
    }
  }
  const summary = { checked: owners.length, renewed, failed };
  console.info("subscription_renewal", summary);
  return summary;
}
