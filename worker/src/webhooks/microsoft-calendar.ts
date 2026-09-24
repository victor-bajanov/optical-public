import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Env } from "../env";
import type { AppVariables } from "../index-providers";
import { timingSafeEqual } from "../auth/timing-safe";
import { getCalendarSyncByChannelId } from "../db/calendar-sync";
import { defaultCalendarProvider } from "../index-providers";
import { ensureSubscription } from "./subscription-manager";
import { webhookCallbackUrl } from "./callback-url";

interface GraphNotification {
  subscriptionId?: string;
  changeType?: string;
  lifecycleEvent?: string;
  clientState?: string;
  resource?: string;
  resourceData?: { id?: string };
}

interface GraphNotificationBody {
  value?: GraphNotification[];
}

// Retained for parity with mountGoogleCalendarWebhookRoute's MountOptions;
// unused today (owner is derived per-notification from subscriptionId, not
// from a mount-time argument).
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface MountOptions {}

/**
 * Mounted like mountGoogleCalendarWebhookRoute (see webhooks/google-calendar.ts:427),
 * but registered with plain `v1.post` rather than `createRoute`/`v1.openapi`:
 * the validation handshake must echo an arbitrary caller-supplied token as a
 * bare text/plain 200, which doesn't fit zod-openapi's schema-shaped response
 * typing alongside the batch notification's empty-body 202.
 */
export function mountMicrosoftCalendarWebhookRoute(
  v1: OpenAPIHono<{ Bindings: Env; Variables: AppVariables }>,
  _opts: MountOptions,
) {
  v1.post("/webhook/microsoft-calendar", async (c) => {
    // Subscription validation handshake (create AND renew): Graph requires the
    // token echoed back as text/plain within 10s or it rejects the subscription.
    // c.req.query() already URL-decodes, so a token containing e.g. "%20" comes
    // back with a literal space — echo it verbatim, do not re-decode.
    const validationToken = c.req.query("validationToken");
    if (validationToken) return c.text(validationToken, 200);

    // Notifications arrive batched, possibly spanning subscriptions. Always
    // 202 fast — Graph penalizes slow/erroring endpoints by dropping them —
    // and never leak subscription validity to the caller.
    let body: GraphNotificationBody | null;
    try {
      body = await c.req.json();
    } catch {
      return c.body(null, 202);
    }

    // body.value can be present but the wrong shape (e.g. `{"value":"abc"}`)
    // on an unauthenticated route — never trust it's an array.
    const notifications = Array.isArray(body?.value) ? body.value : [];

    // Batch notifications routinely repeat the same subscriptionId (a Graph
    // batch can carry many resourceData entries per subscription) — look each
    // distinct one up once instead of once per notification. Empty-string ids
    // are skipped (never a real subscription, so never worth a query), and
    // the distinct set is capped — this is an unauthenticated route, so an
    // oversized or adversarial batch must not fan out unboundedly many D1
    // lookups.
    const MAX_DISTINCT_SUBSCRIPTION_LOOKUPS = 100;
    const distinctSubscriptionIds = [
      ...new Set(notifications.map((n) => n.subscriptionId).filter((id): id is string => typeof id === "string" && id.length > 0)),
    ].slice(0, MAX_DISTINCT_SUBSCRIPTION_LOOKUPS);
    const rowById = new Map<string, Awaited<ReturnType<typeof getCalendarSyncByChannelId>>>();
    await Promise.all(
      distinctSubscriptionIds.map(async (id) => {
        rowById.set(id, await getCalendarSyncByChannelId(c.env.DB, id));
      }),
    );

    const owners = new Set<string>();
    const lifecycleOwners = new Set<string>();
    for (const n of notifications) {
      if (!n.subscriptionId || typeof n.clientState !== "string") continue;
      const row = rowById.get(n.subscriptionId);
      if (!row?.channel_token) continue;
      if (!timingSafeEqual(row.channel_token, n.clientState)) continue; // spoof → drop silently
      if (n.lifecycleEvent) {
        lifecycleOwners.add(row.owner_subject);
        // "missed" means Graph could not guarantee delivery of some change
        // notifications during an outage — unlike reauthorizationRequired/
        // subscriptionRemoved (which are about the subscription itself, not
        // about missed data), this one also warrants an immediate replan on
        // top of the re-ensure below, since a real change may otherwise sit
        // unnoticed until the next unrelated trigger.
        if (n.lifecycleEvent === "missed") owners.add(row.owner_subject);
      } else {
        owners.add(row.owner_subject);
      }
    }

    if (owners.size > 0 || lifecycleOwners.size > 0) {
      // Both the notifyChange fan-out and the lifecycle re-ensure are off the
      // request path, in the SAME deferred work — the 202 must not be gated
      // on N sequential DO round-trips any more than on a slow re-ensure.
      const deferred = (async () => {
        for (const owner of owners) {
          try {
            const id = c.env.RESOLVE_COORDINATOR.idFromName(owner);
            await c.env.RESOLVE_COORDINATOR.get(id).notifyChange(owner);
          } catch (e) {
            // One owner's rejecting DO RPC must not abort the loop — Graph
            // never redelivers after our 202, so skipping every remaining
            // owner (and the lifecycle re-ensure below) silently would be
            // much worse than one owner missing this particular replan.
            console.error("ms webhook notifyChange failed", { owner, error: String(e) });
          }
        }
        for (const owner of lifecycleOwners) {
          try {
            const calendar = c.var.calendarProvider ?? (await defaultCalendarProvider(c.env, owner));
            await ensureSubscription({
              db: c.env.DB,
              ownerSubject: owner,
              calendar,
              callbackUrl: webhookCallbackUrl(c.env, "microsoft"),
              // A lifecycle notification proves the stored expiry can't be
              // trusted (Graph is telling us the subscription is in trouble
              // right now), so bypass the normal 48h freshness gate.
              force: true,
            });
          } catch (e) {
            console.error("ms lifecycle re-ensure failed", { owner, error: String(e) });
          }
        }
      })();
      try {
        c.executionCtx.waitUntil(deferred);
      } catch {
        // No ExecutionContext (e.g. Hono's app.request() in tests without one
        // supplied) — run it inline instead of dropping the work.
        await deferred;
      }
    }

    return c.body(null, 202);
  });
}
