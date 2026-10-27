// worker/src/handlers/subscribe.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Env } from "../env";
import type { AppVariables } from "../index-providers";
import { requireOwner } from "../middleware/owner-gate";
import { ensureSubscription } from "../webhooks/subscription-manager";
import { defaultCalendarProvider, ProviderDisabledError } from "../index-providers";
import {
  getSubjectProvider,
  IdentityCredentialMissingError,
  IDENTITY_CHANGED_DURING_REFRESH,
} from "../auth/identity-store";
import { webhookCallbackUrl } from "../webhooks/callback-url";
import { getCalendarSync, PRIMARY_CALENDAR_ID } from "../db/calendar-sync";

// Errors that mean the caller's upstream grant can't be used: no push channel
// works without one, whatever calendar_sync still says, so the user must sign
// in again. A refused refresh is a plain Error carrying the IdP's
// `invalid_grant` body (google/microsoft-identity-provider.ts).
function grantUnusable(e: unknown): boolean {
  if (e instanceof IdentityCredentialMissingError || e instanceof ProviderDisabledError) return true;
  if (!(e instanceof Error)) return false;
  if (e.message === IDENTITY_CHANGED_DURING_REFRESH) return true;
  return /^(google|microsoft) refresh failed:/.test(e.message) && e.message.includes("invalid_grant");
}

export function mountSubscribeRoute(
  v1: OpenAPIHono<{ Bindings: Env; Variables: AppVariables }>,
) {
  const route = createRoute({
    method: "post",
    path: "/webhook/subscribe",
    operationId: "subscribeWebhook",
    summary: "Subscribe the caller's primary calendar to push notifications.",
    description:
      "Ensure a push channel (a Google Calendar watch channel or a Microsoft Graph subscription, per the caller's sign-in provider) exists for the caller's primary calendar, so calendar edits trigger replans. Idempotent: a live channel is kept, one near expiry is renewed or rotated, and a missing one is created. `subscribed` reports whether push works after the call, not whether this call did any work. Provider errors are reported through `subscribed`, not as an error status.",
    security: [{ BearerAuth: [] }],
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({
              ok: z.boolean(),
              subscribed: z
                .boolean()
                .describe(
                  "True when, after the call, a live push channel for this deployment's callback URL is stored for the caller's primary calendar (newly created, renewed or already present) and nothing this call did found the caller's upstream grant unusable. A failed renewal of a channel that has not yet expired still answers true; a fresh channel needs no provider call, so the grant is not re-checked then. False means there is no working push channel: the grant was refused, revoked or wiped, the caller's provider is switched off, or no unexpired channel for this callback is stored. Treat false as needing action: retry later, or ask the user to sign in again.",
                ),
            }),
          },
        },
        description: "Subscription state",
      },
      401: {
        content: {
          "application/json": {
            schema: z.object({ error: z.string() }),
          },
        },
        description: "Missing/invalid bearer",
      },
      403: {
        content: {
          "application/json": {
            schema: z.object({ error: z.string() }),
          },
        },
        description: "Token carries no subject",
      },
    },
  });

  v1.openapi(route, async (c) => {
    const owner = await requireOwner(c);
    if (owner instanceof Response) return owner as any;
    const providerName = await getSubjectProvider(c.env, owner);
    const callbackUrl = webhookCallbackUrl(c.env, providerName);
    const now = new Date();
    try {
      // Prefer an injected provider (tests); otherwise build the per-subject
      // provider so the watch addresses THIS owner's primary calendar.
      const calendar =
        c.var.calendarProvider ?? (await defaultCalendarProvider(c.env, owner, providerName));
      await ensureSubscription({
        db: c.env.DB,
        calendar,
        callbackUrl,
        ownerSubject: owner,
        now,
      });
    } catch (e) {
      // Only the class name is logged: provider error bodies can carry the
      // calendar id, which is an email.
      const unusable = grantUnusable(e);
      console.warn("subscribe_webhook_failed", {
        provider: providerName,
        reason: unusable ? "grant_unusable" : "error",
        error: e instanceof Error ? e.name : typeof e,
      });
      if (unusable) return c.json({ ok: true, subscribed: false }, 200);
      // Anything else (an upstream 5xx, a lost write) falls through: a
      // channel that is still live keeps working.
    }
    // ensureSubscription's own result means "this call created or renewed a
    // channel" (false for an already-live one), which the cron and sign-in
    // logging rely on. The route reports whether a working channel exists,
    // so re-read what is stored.
    const row = await getCalendarSync(c.env.DB, owner, PRIMARY_CALENDAR_ID);
    const subscribed =
      !!row?.channel_id &&
      !!row.channel_expires_at &&
      Date.parse(row.channel_expires_at) > now.getTime() &&
      row.channel_callback_url === callbackUrl;
    return c.json({ ok: true, subscribed }, 200);
  });
}
