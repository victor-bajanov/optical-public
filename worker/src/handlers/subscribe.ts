// worker/src/handlers/subscribe.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Env } from "../env";
import type { AppVariables } from "../index-providers";
import { requireOwner } from "../middleware/owner-gate";
import { ensureSubscription } from "../webhooks/subscription-manager";
import { defaultCalendarProvider } from "../index-providers";
import { getSubjectProvider } from "../auth/identity-store";
import { webhookCallbackUrl } from "../webhooks/callback-url";

export function mountSubscribeRoute(
  v1: OpenAPIHono<{ Bindings: Env; Variables: AppVariables }>,
) {
  const route = createRoute({
    method: "post",
    path: "/webhook/subscribe",
    operationId: "subscribeWebhook",
    summary: "Subscribe the caller's primary calendar to push notifications.",
    description:
      "Ensure a Google Calendar watch channel exists for the caller's primary calendar so edits trigger replans. Idempotent.",
    security: [{ BearerAuth: [] }],
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({ ok: z.boolean(), subscribed: z.boolean().describe("Whether an active watch channel now exists for the caller's primary calendar (true whether newly created or already present).") }),
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
    // Prefer an injected provider (tests); otherwise build the per-subject
    // Google provider so the watch addresses THIS owner's primary calendar.
    const calendar =
      c.var.calendarProvider ?? (await defaultCalendarProvider(c.env, owner, providerName));
    const result = await ensureSubscription({
      db: c.env.DB,
      calendar,
      callbackUrl,
      ownerSubject: owner,
    });
    return c.json({ ok: true, subscribed: result.subscribed }, 200);
  });
}
