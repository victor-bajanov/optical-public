// worker/src/handlers/replan-now.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Env } from "../env";
import type { AppVariables } from "../index-providers";
import { requireOwner } from "../middleware/owner-gate";
import { defaultProviders } from "../index-providers";
import { runWebhookReplan } from "../webhooks/google-calendar";
import { redactRenderSnapshot } from "../diff/redact-snapshot";
import { RenderSnapshotSchema, type RenderSnapshot } from "../schema/render-snapshot";
import { IdentityCredentialMissingError, logCredentialMissingSkip } from "../auth/identity-store";
import { CredentialMissingResponse } from "../planning/resolve";
import { D } from "../schema/descriptions";

const ReplanNowResponse = z.object({
  ok: z.literal(true),
  replanned: z.boolean().describe("Whether a new proposed plan was produced."),
  reason: z.enum(["no_changes", "no_diff"]).optional().describe("Why nothing was replanned: no_changes = no relevant calendar change; no_diff = the resolve matched the calendar."),
  unsat: z.boolean().optional().describe("True when the week is infeasible; see unsat_core."),
  unsat_core: z.unknown().optional().describe("Solver infeasibility core, when unsat."),
  solver_error: z.object({
    status: z.number().describe("Solver HTTP status."),
    detail: z.string().describe("Solver error detail."),
  }).optional().describe("Present when the solver failed."),
  plan_hash: z.string().optional().describe("Hash of the new proposed plan, when replanned."),
  email_sent: z.boolean().optional().describe("Whether the replan email was sent (false on dry_run, and when email_skipped is set)."),
  email_skipped: z.enum(["duplicate", "too_many_pending_actions", "undeliverable"]).optional().describe(
    "Why no email went out although the plan was produced and stored (absent when sent or on dry_run). duplicate: this plan's accept email was already sent and its link is still live (sent at most once per plan_hash for up to 72 hours). too_many_pending_actions: the account already has 20 emailed plans/actions waiting for the user. undeliverable: the user's mailbox send failed and Optical's own fallback mailer was off or at its per-account limit (3 per 24 hours). In every case nothing was applied; the plan can still be accepted from an earlier email or committed directly.",
  ),
  model: RenderSnapshotSchema.optional().describe("The plan's render model, when replanned. Titles of calendar events the user does not organise are redacted to \"Busy\"; the emailed copy keeps the real titles."),
}).describe("Replan result.");

export function mountReplanNowRoute(v1: OpenAPIHono<{ Bindings: Env; Variables: AppVariables }>) {
  const route = createRoute({
    method: "post",
    path: "/replan-now",
    operationId: "replanNow",
    summary: "Manually trigger the caller's webhook-style replan.",
    description:
      "Run the same diff-and-email replan pipeline the Google push fires, for the caller's own account: auto-detect affected weeks, diff vs the calendar, and (unless dry_run) send the diff email. Each plan's email goes out at most once while its accept link is live: a repeat call that lands on the same plan_hash sends nothing and reports email_skipped=\"duplicate\". The email also counts toward the account's limit of 20 emailed plans/actions waiting for the user (email_skipped=\"too_many_pending_actions\"). Query: dry_run, force, trigger.",
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
        content: { "application/json": { schema: ReplanNowResponse } },
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
      409: {
        content: { "application/json": { schema: CredentialMissingResponse } },
        description: D.error.credential_missing,
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

    let result: Awaited<ReturnType<typeof runWebhookReplan>>;
    try {
      result = await runWebhookReplan({
        env: c.env,
        calendar,
        notify,
        accountEmail: owner,
        oauthIssuer: c.env.OAUTH_ISSUER,
        dryRun,
        forceResolve: force,
        triggerInviteTitle: trigger,
        // Decision L: a looping caller can't flood the inbox (confirm/plan-mail.ts).
        dedupeMail: true,
      });
    } catch (e) {
      if (!(e instanceof IdentityCredentialMissingError)) throw e;
      logCredentialMissingSkip("replan_now");
      return c.json({ error: "identity_credential_missing" as const }, 409);
    }

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
        ...(result.mailSkipped ? { email_skipped: result.mailSkipped } : {}),
        // The API copy is redacted (O9.6); the email already went out unredacted.
        model: redactRenderSnapshot(result.model) as RenderSnapshot,
      },
      200,
    );
  });
}
