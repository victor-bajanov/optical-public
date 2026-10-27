import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Env } from "../env";
import type { AppVariables } from "../index-providers";
import { requireOwner } from "../middleware/owner-gate";
import { PlanBodySchema } from "../schema/plan-response";
import { getExistingTaskIds } from "../db/tasks";
import { getLatestCommittedPlanForSubject } from "./proposed-plans";

export function mountScheduleRoute(
  v1: OpenAPIHono<{ Bindings: Env; Variables: AppVariables }>,
) {
  const scheduleRoute = createRoute({
    method: "get",
    path: "/schedule",
    operationId: "getSchedule",
    summary: "Retrieve the latest committed plan body (current schedule).",
    description:
      "Return the body of the latest committed plan — the current live schedule. Entries (in both schedule and dropped) whose task has since been deleted are omitted: the response reflects the caller's tasks as they exist now, even though the committed plan itself is not rewritten. Owned meetings follow the same rule.",
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
    // body.warnings carries other people's event titles ("<summary>: <code>")
    // and is not part of PlanBodySchema: never serve it (the daily cleanup
    // also scrubs it from committed rows).
    const { warnings: _warnings, ...body } = plan.body as z.infer<typeof PlanBodySchema> & { warnings?: unknown };
    // The committed plan is a snapshot: a task deleted after commit (its chunk
    // events already removed by DELETE /v1/tasks/{id}) would otherwise linger
    // here until the next commit, which an empty-diff plan can't produce on
    // agent-confirm deployments. Filter read-side, owner-scoped; the stored
    // plan row is left untouched.
    const existing = await getExistingTaskIds(c.env.DB, owner, [
      ...body.schedule.map((e) => e.task_id),
      ...body.dropped.map((e) => e.task_id),
    ]);
    return c.json({
      ...body,
      schedule: body.schedule.filter((e) => existing.has(e.task_id)),
      dropped: body.dropped.filter((e) => existing.has(e.task_id)),
    });
  });
}
