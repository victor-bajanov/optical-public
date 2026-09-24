// worker/src/handlers/whoami.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Env } from "../env";
import type { AppVariables } from "../index-providers";
import { requireOwner } from "../middleware/owner-gate";
import { getHomeTz } from "../db/users";
import { getSubjectProvider } from "../auth/identity-store";

export function mountWhoamiRoute(v1: OpenAPIHono<{ Bindings: Env; Variables: AppVariables }>) {
  const route = createRoute({
    method: "get", path: "/whoami", operationId: "whoami",
    summary: "The caller's own identity and effective timezone.",
    description: "Return the bearer subject's email, effective home timezone (their configured home_tz, else the instance default SCHEDULER_TZ), and connected calendar provider.",
    security: [{ BearerAuth: [] }],
    responses: {
      200: { content: { "application/json": { schema: z.object({ email: z.string().describe("The caller's email — the bearer token's subject."), home_tz: z.string().describe("The caller's effective home timezone (their configured home_tz, else the instance default SCHEDULER_TZ)."), provider: z.enum(["google", "microsoft"]).describe("The caller's connected calendar/identity provider (same lookup calendar-access-token.ts uses; defaults to google for a subject with no identity_tokens row).") }) } }, description: "Caller identity" },
      401: { content: { "application/json": { schema: z.object({ error: z.string() }) } }, description: "Missing/invalid bearer" },
      403: { content: { "application/json": { schema: z.object({ error: z.string() }) } }, description: "Token carries no subject" },
    },
  });
  v1.openapi(route, async (c) => {
    const owner = await requireOwner(c);
    if (owner instanceof Response) return owner as any;
    const [home_tz, provider] = await Promise.all([
      getHomeTz(c.env.DB, owner, c.env.SCHEDULER_TZ),
      getSubjectProvider(c.env, owner),
    ]);
    return c.json({ email: owner, home_tz, provider }, 200);
  });
}
