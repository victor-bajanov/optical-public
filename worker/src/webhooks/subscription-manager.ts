import type { CalendarProvider } from "../providers/calendar-provider";
import { getCalendarSync, upsertCalendarSync, PRIMARY_CALENDAR_ID } from "../db/calendar-sync";
import { requireOwner } from "../db/d1";

// 48h, not 24h: the renewal cron runs daily, so a 24h threshold gives exactly
// one shot at renewing before expiry — a single failed run goes dark. 48h means
// two consecutive runs must fail before pushes stop.
const RENEW_THRESHOLD_MS = 48 * 3600 * 1000;

export interface EnsureSubscriptionArgs {
  db: D1Database;
  ownerSubject: string;
  calendar: CalendarProvider;
  callbackUrl: string;
  now?: Date;
  // Bypasses the freshness gate ONLY — a lifecycle notification (Graph
  // reauthorizationRequired/subscriptionRemoved/missed) proves the stored
  // expiry is stale even when it looks far off, so the caller re-ensures
  // unconditionally. Does NOT change the renew-then-rotate order below:
  // in-place renewal is still attempted first (correct for
  // reauthorizationRequired — the subscription itself is still there, it
  // just needs re-authing), and only falls through to a full rotate on
  // renew failure (the path subscriptionRemoved takes, since renewing a
  // subscription Graph has already deleted 404s).
  force?: boolean;
}

export interface EnsureSubscriptionResult {
  subscribed: boolean;
}

function generateChannelToken(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  let s = "";
  for (const b of buf) s += b.toString(16).padStart(2, "0");
  return s;
}

export async function ensureSubscription(args: EnsureSubscriptionArgs): Promise<EnsureSubscriptionResult> {
  const { db, calendar, callbackUrl } = args;
  const owner = requireOwner(args.ownerSubject);
  const now = args.now ?? new Date();
  const existing = await getCalendarSync(db, owner, PRIMARY_CALENDAR_ID);

  const expiresAt = existing?.channel_expires_at ? Date.parse(existing.channel_expires_at) : 0;
  const needSubscribe =
    args.force === true ||
    !existing ||
    !existing.channel_id ||
    !existing.channel_expires_at ||
    expiresAt - now.getTime() < RENEW_THRESHOLD_MS ||
    existing.channel_callback_url !== callbackUrl;

  if (!needSubscribe) return { subscribed: false };

  // In-place renewal (Microsoft): PATCH the existing subscription instead of
  // rotating. Only when the channel exists, the callback is unchanged, and the
  // provider supports it. Failure (expired server-side, 404) falls through to
  // the rotate path below, which always works.
  //
  // Also force the full rotate path once a week (UTC Sunday), even when
  // renewal would otherwise succeed: an in-place renew keeps the same
  // channel_token/clientState forever, so without this the webhook secret
  // would never rotate.
  const forceWeeklyRotate = now.getUTCDay() === 0;
  if (
    !forceWeeklyRotate &&
    existing?.channel_id &&
    existing.channel_callback_url === callbackUrl &&
    typeof calendar.renewSubscription === "function"
  ) {
    try {
      const renewed = await calendar.renewSubscription(existing.channel_id);
      await upsertCalendarSync(db, owner, PRIMARY_CALENDAR_ID, {
        channel_expires_at: renewed.expiresAt,
      });
      return { subscribed: true };
    } catch (e) {
      console.warn("ensureSubscription: renew failed, rotating", {
        channelId: existing.channel_id, error: String(e),
      });
    }
  }

  const priorChannelId = existing?.channel_id ?? null;
  const priorResourceId = existing?.channel_resource_id ?? null;

  const token = generateChannelToken();
  const sub = await calendar.subscribeToChanges(callbackUrl, token);
  // Log the new channelId immediately, before the D1 write below — if that
  // write throws, the just-created Graph subscription is otherwise orphaned
  // (no D1 row references it) with no trail to find it by; this log line is
  // what makes it recoverable via the /admin/stop-channel one-shot.
  console.info("ensureSubscription: new subscription created", { channelId: sub.channelId });
  await upsertCalendarSync(db, owner, PRIMARY_CALENDAR_ID, {
    channel_id: sub.channelId,
    channel_token: sub.channelToken,
    channel_expires_at: sub.expiresAt,
    channel_resource_id: sub.resourceId,
    channel_callback_url: callbackUrl,
  });

  // Subscribe the new channel FIRST (never go dark), then best-effort stop the
  // old one so Google stops delivering on it. A stale channel that 404s is fine
  // — that is the very state we are cleaning up. Swallow errors so a failed stop
  // never blocks rotation.
  // Truthiness on the channel id (an empty string is not a real prior
  // channel to stop — stopping it would be a doomed call), but `!= null` on
  // the resource id, since Microsoft legitimately stores "" there (Graph has
  // no analogue of Google's resourceId) and that must still be passed through.
  if (priorChannelId && priorResourceId != null) {
    try {
      await calendar.stopChannel(priorChannelId, priorResourceId);
    } catch (e) {
      // Log the IDs so a failed stop leaves an actionable trail for the
      // /admin/stop-channel one-shot (Task 8), which needs both.
      console.warn("ensureSubscription: stopChannel failed (continuing)", {
        channelId: priorChannelId,
        resourceId: priorResourceId,
        error: String(e),
      });
    }
  }

  return { subscribed: true };
}
