import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Env } from "../env";
import type { AppVariables } from "../index-providers";
import { requireOwner } from "../middleware/owner-gate";
import { PlanBodySchema } from "../schema/plan-response";
import { getLatestCommittedPlanForSubject } from "./proposed-plans";

export function mountScheduleRoute(
  v1: OpenAPIHono<{ Bindings: Env; Variables: AppVariables }>,
) {
  const scheduleRoute = createRoute({
    method: "get",
    path: "/schedule",
    operationId: "getSchedule",
    summary: "Retrieve the latest committed plan body (current schedule).",
    description: "Return the body of the latest committed plan — the current live schedule.",
    security: [{ BearerAuth: [] }],
    responses: {
      200: {
        content: { "application/json": { schema: PlanBodySchema } },
        description: "Latest committed plan body",
      },
      404: {
        content: { "application/json": { schema: z.object({ error: z.string() }) } },
        description: "No committed plan",
      },
      403: {
        content: { "application/json": { schema: z.object({ error: z.string() }) } },
        description: "No subject on token",
      },
    },
  });

  v1.openapi(scheduleRoute, async (c) => {
    const owner = await requireOwner(c);
    if (owner instanceof Response) return owner as any;
    // Scope the read to the token subject — a token may only ever see its own
    // committed plan, never the globally-latest one.
    const plan = await getLatestCommittedPlanForSubject(c.env.DB, owner);
    if (!plan) return c.json({ error: "no_committed_plan" }, 404);
    return c.json(plan.body as z.infer<typeof PlanBodySchema>);
  });
}
