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
    summary: "Mint a raw Google Calendar access token for the caller.",
    description:
      "Return a short-lived Google OAuth access token for the caller's connected Google account. " +
      "PRIVILEGED: requires the calendar:raw-token scope (granted only to operator/automation clients) — " +
      "it is the user's raw Google credential, distinct from the per-endpoint busy-feed secrets managed at /v1/calendar-feeds.",
    security: [{ BearerAuth: [] }],
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ access_token: z.string().describe("A short-lived Google OAuth access token for the caller's connected Google account.") }) } },
        description: "Google access token",
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
