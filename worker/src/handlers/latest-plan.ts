// worker/src/handlers/latest-plan.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Env } from "../env";
import type { AppVariables } from "../index-providers";
import { requireOwner } from "../middleware/owner-gate";
import {
  getLatestProposedPlanForSubject,
  getLatestProposedPlanForSubjectCovering,
} from "../planning/proposed-plans";

const PlanResponse = z.object({
  plan: z
    .object({
      plan_hash: z.string().describe("Content hash identifying this proposed plan; pass to /v1/plans/{plan_hash}/commit to accept it."),
      created_at: z.string().describe("When the plan was proposed (ISO 8601)."),
      expires_at: z.string().describe("When the proposal expires and may no longer be committed (ISO 8601)."),
      window: z.object({
        start: z.string().describe("Inclusive start of the plan's scheduling window (ISO 8601)."),
        end: z.string().describe("Exclusive end of the plan's scheduling window (ISO 8601)."),
      }).nullable().describe("The week/window the plan covers, or null if the plan body carries no window."),
      render_snapshot: z.unknown().nullable().describe("Cached render of the plan for display, or null if not snapshotted."),
    })
    .nullable()
    .describe("The latest uncommitted proposed plan, or null if the caller has none."),
});

export function mountLatestPlanRoute(
  v1: OpenAPIHono<{ Bindings: Env; Variables: AppVariables }>,
) {
  const route = createRoute({
    method: "get",
    path: "/plans/latest",
    operationId: "getLatestProposedPlan",
    summary: "The caller's latest uncommitted proposed plan.",
    description:
      "Return the caller's most recent uncommitted proposed plan. With ?covers=<ISO instant>, return the latest plan whose window covers that instant (the week containing it) instead of the global most-recent — used to deterministically read back a webhook-triggered replan.",
    security: [{ BearerAuth: [] }],
    request: { query: z.object({ covers: z.string().optional().describe("Optional ISO 8601 instant. When given, return the latest plan whose window covers that instant (the week containing it) instead of the global most-recent.") }) },
    responses: {
      200: {
        content: { "application/json": { schema: PlanResponse } },
        description: "Latest proposed plan (or null)",
      },
      401: {
        content: { "application/json": { schema: z.object({ error: z.string() }) } },
        description: "Missing/invalid bearer",
      },
      403: {
        content: { "application/json": { schema: z.object({ error: z.string() }) } },
        description: "Token carries no subject",
      },
    },
  });

  v1.openapi(route, async (c) => {
    const owner = await requireOwner(c);
    if (owner instanceof Response) return owner as any;
    const covers = c.req.query("covers");
    const coversDate = covers ? new Date(covers) : null;
    const plan =
      coversDate && !Number.isNaN(coversDate.getTime())
        ? await getLatestProposedPlanForSubjectCovering(
            c.env.DB,
            owner,
            new Date(),
            coversDate,
          )
        : await getLatestProposedPlanForSubject(c.env.DB, owner, new Date());
    if (!plan) return c.json({ plan: null }, 200);
    const window = plan.body.window as { start: string; end: string } | undefined;
    return c.json(
      {
        plan: {
          plan_hash: plan.plan_hash,
          created_at: plan.created_at,
          expires_at: plan.expires_at,
          window: window ?? null,
          render_snapshot: plan.render_snapshot ?? null,
        },
      },
      200,
    );
  });
}
