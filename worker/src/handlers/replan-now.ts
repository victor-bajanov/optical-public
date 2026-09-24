// worker/src/handlers/replan-now.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Env } from "../env";
import type { AppVariables } from "../index-providers";
import { requireOwner } from "../middleware/owner-gate";
import { defaultProviders } from "../index-providers";
import { runWebhookReplan } from "../webhooks/google-calendar";

export function mountReplanNowRoute(v1: OpenAPIHono<{ Bindings: Env; Variables: AppVariables }>) {
  const route = createRoute({
    method: "post",
    path: "/replan-now",
    operationId: "replanNow",
    summary: "Manually trigger the caller's webhook-style replan.",
    description:
      "Run the same diff-and-email replan pipeline the Google push fires, for the caller's own account: auto-detect affected weeks, diff vs the calendar, and (unless dry_run) send the diff email. Query: dry_run, force, trigger.",
    security: [{ BearerAuth: [] }],
    request: {
      query: z.object({
        dry_run: z.string().optional().describe("When 'true', run the diff but do not send the replan email."),
        force: z.string().optional().describe("When 'true', force re-resolution of affected weeks even if no change is detected."),
        trigger: z.string().optional().describe("Optional invite title to simulate as the triggering calendar change."),
      }),
    },
    responses: {
      200: {
        content: { "application/json": { schema: z.record(z.unknown()) } },
        description: "Replan result",
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

    const dryRun = c.req.query("dry_run") === "true";
    const force = c.req.query("force") === "true";
    const trigger = c.req.query("trigger") ?? undefined;

    // Only build the default provider bundle when at least one of the two
    // factories below will actually need it (test seams override
    // c.var.*Provider directly, skipping the factory — and the D1 lookup).
    const built = (!c.var.calendarProvider || !c.var.notificationProvider)
      ? await defaultProviders(c.env, owner)
      : undefined;
    const calendar = c.var.calendarProvider ?? built!.calendar;
    const notify = c.var.notificationProvider ?? built!.notification;

    const result = await runWebhookReplan({
      env: c.env,
      calendar,
      notify,
      accountEmail: owner,
      oauthIssuer: c.env.OAUTH_ISSUER,
      dryRun,
      forceResolve: force,
      triggerInviteTitle: trigger,
    });

    if (result.kind === "no_changes") {
      return c.json({ ok: true, replanned: false, reason: "no_changes" }, 200);
    }
    if (result.kind === "no_diff") {
      return c.json({ ok: true, replanned: false, reason: "no_diff" }, 200);
    }
    if (result.kind === "unsat") {
      return c.json({ ok: true, replanned: false, unsat: true, unsat_core: result.unsatCore }, 200);
    }
    if (result.kind === "solver_error") {
      return c.json(
        { ok: true, replanned: false, solver_error: { status: result.status, detail: result.detail } },
        200,
      );
    }

    return c.json(
      {
        ok: true,
        replanned: true,
        plan_hash: result.planHash,
        email_sent: result.sent,
        model: result.model,
      },
      200,
    );
  });
}
