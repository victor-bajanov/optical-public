// worker/src/handlers/account.ts
// Hosted-trial card O2: DELETE /v1/account (op deleteAccount) — self-serve
// deletion of the CALLER's own account, gated by SELF_SERVE_DELETE_ENABLED.
// Runs the same offboardUser an operator would (audit source "api"), which
// deletes the caller's oauth_tokens too, so the bearer dies with the account.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { Env } from "../env";
import type { AppVariables } from "../index-providers";
import { requireOwner } from "../middleware/owner-gate";
import { requireScope } from "../middleware/require-scope";
import { offboardUser } from "../lifecycle/offboard";
import { systemMailer } from "../mail/system-mailer";
import { accountDeletedEmail } from "../mail/lifecycle-templates";
import { parsePurgeDays } from "../lifecycle/purge-deleted";
import { D } from "../schema/descriptions";
import { getUser } from "../db/users";
import { confirmationRequired } from "../confirm/gate";
import { confirmationResponses, deferForConfirmation } from "../confirm/defer";
import { registerConfirmableOp } from "../confirm/registry";
import { ownerNotificationEmail } from "../db/owner-email";

type Ctx = Context<{ Bindings: Env; Variables: AppVariables }>;

const REQUIRED_SCOPE = "scheduler:write";

const DeleteAccountBody = z
  .object({
    confirm: z.string().describe(
      "The caller's own email address (as GET /v1/whoami returns it), confirming the deletion. Matched case-insensitively, otherwise exactly; any other value is 400 confirmation_mismatch and nothing is deleted.",
    ),
  })
  .strict()
  .describe("Deletion confirmation. Unknown keys are rejected (400): no other account can be named.");

const DeleteAccountResponse = z.object({
  ok: z.literal(true).describe("Always true: the caller's account was deleted."),
});

const ErrorResponse = z.object({
  error: z.string().describe("Machine-readable error code."),
  required: z.string().optional().describe("On 403 insufficient_scope: the scope the bearer lacks."),
});

function json(description: string) {
  return { content: { "application/json": { schema: ErrorResponse } }, description };
}

export function selfServeDeleteEnabled(env: Pick<Env, "SELF_SERVE_DELETE_ENABLED">): boolean {
  return env.SELF_SERVE_DELETE_ENABLED === "true";
}

/** The deletion itself, shared by the direct call and the confirmed replay.
 *  The confirmation mail is best-effort: systemMailer never throws, no-ops
 *  with system mail off, and logs its own failures (never the address). */
async function deleteOwnAccount(env: Env, owner: string): Promise<void> {
  // Resolved first: offboardUser deletes the identity_tokens row holding the
  // latest verified sign-in address, and the subject itself can belong to
  // someone else after an IdP rename (db/owner-email.ts).
  const to = await ownerNotificationEmail(env.DB, owner);
  await offboardUser(env, owner, owner, { auditSource: "api" });
  await systemMailer(env).send({ to, ...accountDeletedEmail({
    purgeAfterDays: parsePurgeDays(env.DELETED_ACCOUNT_RETENTION_DAYS),
    deploymentLabel: env.DEPLOYMENT_LABEL,
  }) });
}

// Decision B: an agent-confirm client's deleteAccount is deferred; this op
// runs it once the user confirms in their browser. The owner comes from the
// stored row (never the payload), so there is nothing to carry but {}.
const DELETE_ACCOUNT_OP = "deleteAccount";
registerConfirmableOp(DELETE_ACCOUNT_OP, {
  label: "Delete your Optical account",
  payloadSchema: z.object({}).strict(),
  summarySchema: z.object({ email: z.string() }).strict(),
  render: (s) => ({
    heading: `Permanently delete the Optical account ${s.email}`,
    notes: [
      "This deletes your tasks, templates, projects, plans, bookings, polls, settings and calendar connection, and signs out every app and assistant connected to this account.",
      "Upcoming Optical work blocks are removed from your calendar; past ones and booked meetings stay.",
      "This cannot be undone. Signing in again later starts a new, empty account.",
    ],
  }),
  replay: async (env, owner) => {
    // Re-validate: up to 24 h have passed since the agent asked.
    if (!selfServeDeleteEnabled(env)) {
      return { ok: false, reason: "self_serve_delete_disabled", message: "Account deletion is no longer available here. Nothing was deleted." };
    }
    const user = await getUser(env.DB, owner);
    if (!user || user.is_active !== 1) {
      return { ok: false, reason: "account_not_active", message: "This account has already been deleted or deactivated. Nothing more was done." };
    }
    await deleteOwnAccount(env, owner);
    return { ok: true, message: "Your Optical account has been deleted. Any app or assistant connected to it has been signed out." };
  },
});

export function mountAccountRoutes(v1: OpenAPIHono<{ Bindings: Env; Variables: AppVariables }>) {
  // Order is load-bearing, and all of it runs before the zod body validator:
  // flag off -> 404 (the route doesn't exist, whoever asks), then 401/403 from
  // the owner gate, then 403 without scheduler:write. Only then is the body
  // looked at, so neither a disabled deployment nor an unauthorised caller
  // learns anything from a malformed body.
  v1.use("/account", async (c: Ctx, next) => {
    if (!selfServeDeleteEnabled(c.env)) return c.json({ error: "not_found" }, 404);
    const owner = await requireOwner(c);
    if (owner instanceof Response) return owner;
    const denied = await requireScope(REQUIRED_SCOPE)(c as any, async () => undefined as any);
    if (denied) return denied as unknown as Response;
    await next();
    return;
  });

  const del = createRoute({
    method: "delete",
    path: "/account",
    operationId: "deleteAccount",
    tags: ["account"],
    summary: "Delete the caller's own account (deployment-gated).",
    description: D.account.deleteAccount,
    security: [{ BearerAuth: [] }],
    request: { body: { content: { "application/json": { schema: DeleteAccountBody } }, required: true } },
    responses: {
      200: { content: { "application/json": { schema: DeleteAccountResponse } }, description: "Account deleted; the bearer used is now invalid." },
      400: json("validation_failed (confirm missing, not a string, or an unknown key) or confirmation_mismatch (confirm is not the caller's email). Nothing is deleted."),
      401: json("Missing/invalid bearer."),
      403: json("no_subject (token carries no subject) or insufficient_scope (bearer lacks scheduler:write)."),
      404: json("not_found: self-serve deletion is not enabled on this deployment (SELF_SERVE_DELETE_ENABLED is not \"true\")."),
      ...confirmationResponses,
    },
  });
  v1.openapi(del, async (c) => {
    // The subject is ALWAYS the bearer's own (set by the gate above); the body
    // only confirms it. Captured before the offboard, which removes the token.
    const owner = c.var.ownerSubject!;
    const { confirm } = c.req.valid("json");
    if (confirm.toLowerCase() !== owner.toLowerCase()) {
      return c.json({ error: "confirmation_mismatch" }, 400);
    }
    // Decision B: an agent never deletes the account by itself; the user
    // confirms from the emailed link. Every check above still ran first.
    if (confirmationRequired(c)) {
      return deferForConfirmation(c, { op: DELETE_ACCOUNT_OP, payload: {}, summary: { email: owner } }) as any;
    }
    await deleteOwnAccount(c.env, owner);
    return c.json({ ok: true as const }, 200);
  });
}
