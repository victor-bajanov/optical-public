// worker/src/handlers/calendar-access-token.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Env } from "../env";
import type { AppVariables } from "../index-providers";
import { requireOwner } from "../middleware/owner-gate";
import { getAccessToken, getSubjectProvider } from "../auth/identity-store";
import { defaultIdentityProvider } from "../index-providers";

export function mountCalendarAccessTokenRoute(
  v1: OpenAPIHono<{ Bindings: Env; Variables: AppVariables }>,
) {
  const route = createRoute({
    method: "get",
    path: "/calendar-access-token",
    operationId: "getCalendarAccessToken",
    summary: "Hand the caller's raw identity-provider (Google or Microsoft) access token to the client.",
    description:
      "Return the caller's own short-lived OAuth access token, issued by their identity provider: a Google token for a Google account, " +
      "a Microsoft Graph token for a Microsoft account. This is the user's raw provider credential handed to the client, not an Optical token. " +
      "Until it expires, whoever holds it can act as the user directly against the provider, outside Optical and bypassing every Optical check: " +
      "read, create, change and delete their calendar events, and send mail from their mailbox " +
      "(Google: calendar.events, calendar.freebusy, gmail.send; Microsoft: Calendars.ReadWrite, Mail.Send; plus any extra scope that deployment requests). " +
      "PRIVILEGED: requires the calendar:raw-token scope. That scope is checked against the OAuth client's allowlist only, not the user's role, " +
      "so grant it only to operator/automation clients. Distinct from the per-endpoint busy-feed secrets managed at /v1/calendar-feeds.",
    security: [{ BearerAuth: [] }],
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ access_token: z.string().describe("The caller's raw, short-lived provider access token: Google OAuth for a Google account, Microsoft Graph for a Microsoft account.") }) } },
        description: "Raw provider access token",
      },
      401: {
        content: { "application/json": { schema: z.object({ error: z.string() }) } },
        description: "Missing/invalid bearer",
      },
      403: {
        content: {
          "application/json": {
            schema: z.object({ error: z.string(), required: z.string().optional().describe("The scope that was required but missing (present on insufficient_scope errors).") }),
          },
        },
        description: "Token carries no subject, or lacks calendar:raw-token scope",
      },
    },
  });

  v1.openapi(route, async (c) => {
    const owner = await requireOwner(c);
    if (owner instanceof Response) return owner as any;
    const scopes = (c.get("scopes" as never) as string[] | undefined) ?? [];
    if (!scopes.includes("calendar:raw-token")) {
      return c.json({ error: "insufficient_scope", required: "calendar:raw-token" }, 403);
    }
    const provider = await getSubjectProvider(c.env, owner);
    const access_token = await getAccessToken(c.env, defaultIdentityProvider(c.env, provider), owner);
    return c.json({ access_token }, 200);
  });
}
