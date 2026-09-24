import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Env } from "../env";
import type { AppVariables } from "../index-providers";
import { requireOwner } from "../middleware/owner-gate";
import { loadBusinessHours } from "../db/business-hours";
import { BusinessHoursResponseSchema } from "../schema/business-hours-response";

export function mountBusinessHoursRoute(
  v1: OpenAPIHono<{ Bindings: Env; Variables: AppVariables }>,
) {
  const businessHoursRoute = createRoute({
    method: "get",
    path: "/business-hours",
    operationId: "getBusinessHours",
    summary: "Retrieve the caller's effective business-hours placement floor.",
    description:
      "Return the business-hours window a task without a pin or a hard preferred window is confined to when scheduled. Owner-scoped: the caller's own configured hours, else the instance default, else null when none is configured.",
    security: [{ BearerAuth: [] }],
    responses: {
      200: {
        content: { "application/json": { schema: BusinessHoursResponseSchema } },
        description: "Effective business hours (null when none configured)",
      },
      403: {
        content: { "application/json": { schema: z.object({ error: z.string() }) } },
        description: "No subject on token",
      },
    },
  });

  v1.openapi(businessHoursRoute, async (c) => {
    const owner = await requireOwner(c);
    if (owner instanceof Response) return owner as any;
    const business_hours = await loadBusinessHours(c.env.DB, owner);
    return c.json({ business_hours } as z.infer<typeof BusinessHoursResponseSchema>);
  });
}
