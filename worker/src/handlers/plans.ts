import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Env } from "../env";
import type { AppVariables } from "../index-providers";
import { requireOwner } from "../middleware/owner-gate";
import { PlanResponse } from "../schema/plan-response";
import { deleteProposedPlan, getPendingPlansForSubject, getProposedPlan } from "../planning/proposed-plans";

const PendingPlanSummary = z.object({
  plan_hash: z.string().describe("Content hash identifying the plan; feed to GET/DELETE /plans/{plan_hash} or the accept flow."),
  window: z
    .object({
      start: z.string().describe("Window start instant (inclusive)."),
      end: z.string().describe("Window end instant (exclusive)."),
    })
    .nullable()
    .describe("The week this plan re-schedules, or null for a legacy row with no recorded window."),
  created_at: z.string().describe("When this plan was proposed."),
  expires_at: z.string().describe("After this instant the plan can no longer be accepted."),
});

const PendingPlansResponse = z.object({
  plans: z.array(PendingPlanSummary).describe("Every live pending plan, ordered by window start."),
});

export function mountPlansRoutes(
  v1: OpenAPIHono<{ Bindings: Env; Variables: AppVariables }>,
) {
  // ── GET /plans ───────────────────────────────────────────────────────────

  const listPlansRoute = createRoute({
    method: "get",
    path: "/plans",
    operationId: "listPendingPlans",
    summary: "List every pending (uncommitted, unexpired) proposed plan.",
    description:
      "List all of the caller's pending proposed plans — uncommitted and unexpired — as lightweight summaries, ordered by window start. A burst of replans can leave pending plans strewn across widely separated weeks; this is the one-call way to enumerate (and then review or DELETE) all of them, instead of probing week-by-week via /plans/latest?covers. Fetch a specific plan's full body via GET /plans/{plan_hash}.",
    security: [{ BearerAuth: [] }],
    responses: {
      200: {
        content: { "application/json": { schema: PendingPlansResponse } },
        description: "Pending plans (possibly empty)",
      },
      403: {
        content: { "application/json": { schema: z.object({ error: z.string() }) } },
        description: "No subject on token",
      },
    },
  });

  v1.openapi(listPlansRoute, async (c) => {
    const owner = await requireOwner(c);
    if (owner instanceof Response) return owner as any;
    const rows = await getPendingPlansForSubject(c.env.DB, owner, new Date());
    const plans = rows
      .map((row) => ({
        plan_hash: row.plan_hash,
        window:
          row.window_start && row.window_end
            ? { start: row.window_start, end: row.window_end }
            : null,
        created_at: row.created_at,
        expires_at: row.expires_at,
      }))
      .sort((a, b) => (a.window?.start ?? "").localeCompare(b.window?.start ?? ""));
    return c.json({ plans } as z.infer<typeof PendingPlansResponse>);
  });

  // ── GET /plans/:plan_hash ────────────────────────────────────────────────

  const getPlanRoute = createRoute({
    method: "get",
    path: "/plans/{plan_hash}",
    operationId: "getPlan",
    summary: "Retrieve a proposed plan by hash.",
    description: "Retrieve a proposed plan by its plan_hash, including the placed schedule, dropped tasks, and expiry.",
    security: [{ BearerAuth: [] }],
    // Note: middleware field omitted — v0.19.10 supports the field but causes
    // TypeScript union-type mismatch when requireBearer's Variables: Vars
    // conflicts with AppVariables. Using v1.use() for auth wiring instead.
    responses: {
      200: {
        content: { "application/json": { schema: PlanResponse } },
        description: "Proposed plan",
      },
      403: {
        content: { "application/json": { schema: z.object({ error: z.string() }) } },
        description: "No subject on token",
      },
      404: {
        content: { "application/json": { schema: z.object({ error: z.string() }) } },
        description: "Not found",
      },
    },
  });

  v1.openapi(getPlanRoute, async (c) => {
    const owner = await requireOwner(c);
    if (owner instanceof Response) return owner as any;
    const hash = c.req.param("plan_hash");
    const row = await getProposedPlan(c.env.DB, hash);
    if (!row) return c.json({ error: "not_found" }, 404);
    // plan_hash is a content hash disclosed to the owner, not a secret. 404 (not
    // 403) on mismatch so existence doesn't leak; legacy NULL-subject rows are
    // also treated as not-found.
    if (row.subject !== owner) return c.json({ error: "not_found" }, 404);
    // render_snapshot is internal presentation data, subject is owner-internal,
    // and window_start/window_end just denormalize body.window; none are part
    // of PlanResponse — strip all before serializing.
    const { render_snapshot: _omit, subject: _owner, window_start: _ws, window_end: _we, ...rest } = row;
    return c.json(rest as z.infer<typeof PlanResponse>);
  });

  // ── DELETE /plans/:plan_hash ─────────────────────────────────────────────

  const deletePlanRoute = createRoute({
    method: "delete",
    path: "/plans/{plan_hash}",
    operationId: "deletePlan",
    summary: "Delete a non-committed proposed plan by hash.",
    description: "Delete a proposed plan that has not been committed, by plan_hash.",
    security: [{ BearerAuth: [] }],
    // Note: middleware field omitted — same reason as getPlanRoute above.
    responses: {
      204: { description: "Deleted" },
      403: {
        content: { "application/json": { schema: z.object({ error: z.string() }) } },
        description: "No subject on token",
      },
      404: {
        content: { "application/json": { schema: z.object({ error: z.string() }) } },
        description: "Not found",
      },
      409: {
        content: { "application/json": { schema: z.object({ error: z.string() }) } },
        description: "Plan already committed",
      },
    },
  });

  v1.openapi(deletePlanRoute, async (c) => {
    const owner = await requireOwner(c);
    if (owner instanceof Response) return owner;
    const hash = c.req.param("plan_hash");
    const row = await getProposedPlan(c.env.DB, hash);
    if (!row) return c.json({ error: "not_found" }, 404);
    if (row.committed_at) return c.json({ error: "already_committed" }, 409);
    // Scope the delete to the caller. A row owned by another tenant matches no
    // predicate → deleted === false → 404 (same shape as a missing plan).
    const deleted = await deleteProposedPlan(c.env.DB, hash, owner);
    if (!deleted) return c.json({ error: "not_found" }, 404);
    return new Response(null, { status: 204 });
  });
}
