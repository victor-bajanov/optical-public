// O9.1 deferral: what a gated handler returns instead of acting.
//
//   const owner = await requireOwner(c); ...
//   if (confirmationRequired(c)) {
//     return deferForConfirmation(c, { op: "createMeetingPoll", payload, summary });
//   }
//
// Stores a pending_actions row (24 h), emails the user a single-use confirm
// link from their own mailbox to themselves (SystemMailer if that fails), and
// answers 202 awaiting_confirmation. Add `...confirmationResponses` to the
// route's OpenAPI responses so the 202 (and 503) are in the spec.
import type { Context } from "hono";
import { z } from "@hono/zod-openapi";
import type { Env } from "../env";
import type { AppVariables } from "../index-providers";
import { defaultNotificationProvider } from "../index-providers";
import { signCapabilityWithEnv } from "../auth/capability";
import { systemMailer } from "../mail/system-mailer";
import {
  claimSystemFallback,
  deletePendingAction,
  PENDING_ACTION_LIVE_CAP,
  pruneExpiredPendingActions,
  releaseSettledPlanMarkers,
  reservePendingAction,
  type PendingActionRow,
} from "../db/pending-actions";
import { getConfirmableOp } from "./registry";
import { confirmActionEmail } from "./page";

export const PENDING_ACTION_TTL_SECONDS = 24 * 3600;

type Ctx = Context<{ Bindings: Env; Variables: AppVariables }>;

const AWAITING_MESSAGE =
  "Not done yet. Optical emailed the user a link to review and confirm this action; it runs only when they confirm it in their browser, within 24 hours. Don't retry or ask again: tell the user to check their email.";

export const AwaitingConfirmationResponse = z
  .object({
    status: z.literal("awaiting_confirmation").describe("The action was NOT performed. It waits for the user's emailed confirmation."),
    action_id: z.string().describe("Opaque id of the deferred action. Nothing in the API acts on it; the user confirms through the emailed link."),
    expires_at: z.string().describe("ISO 8601 UTC instant after which the confirmation link no longer works and the action is dropped."),
    message: z.string().describe("Plain-language explanation to relay to the user."),
  })
  // No .openapi("Name"): a named component becomes a $ref, and
  // test/openapi.test.ts requires every schema inlined.
  .describe(
    "Returned instead of performing the action when the calling OAuth client is listed in AGENT_CONFIRM_CLIENT_IDS: the user is emailed a single-use link, and the action runs (after re-checking that it still applies) only if they confirm it in their browser within 24 hours.",
  );

const ConfirmationUnavailable = z.object({
  error: z.literal("confirmation_unavailable").describe("The confirmation email could not be sent, so nothing was stored or done."),
});

const TooManyPendingActions = z.object({
  error: z.literal("too_many_pending_actions").describe("The account already has the maximum number of actions waiting for the user's confirmation. Nothing was stored, sent or done."),
});

/** The live-action cap's 429, worded to stand alone or to be appended to a
 *  route's own 429 description (polls' mail_cap_exceeded). */
export const TOO_MANY_PENDING_ACTIONS_429 =
  `too_many_pending_actions (agent-confirm clients only): the account already has ${PENDING_ACTION_LIVE_CAP} actions waiting for the user's emailed confirmation; nothing was stored or emailed. A request identical to one still waiting is not refused: it returns that action's 202 again without a second email. Retry after the user confirms some, or they expire (24 hours; a plan's accept email frees its slot once accepted or superseded, else after 72 hours).`;

/** Spread into a gated route's `responses`. */
export const confirmationResponses = {
  202: {
    content: { "application/json": { schema: AwaitingConfirmationResponse } },
    description: "awaiting_confirmation: deferred for the user's emailed confirmation (agent-confirm clients only). Nothing was done yet.",
  },
  503: {
    content: { "application/json": { schema: ConfirmationUnavailable } },
    description: "confirmation_unavailable: an agent-confirm client's action could not be deferred because the confirmation email failed (or the per-account limit on confirmation emails sent through Optical's own mailer when the user's mailbox fails was reached). Nothing was done.",
  },
  429: {
    content: { "application/json": { schema: TooManyPendingActions } },
    description: TOO_MANY_PENDING_ACTIONS_429,
  },
} as const;

/** JSON with object keys sorted at every depth, so equal payloads stringify
 *  equal (the dedupe compares stored text). */
export function canonicalJson(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === "object") {
      return Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, norm((x as Record<string, unknown>)[k])]));
    }
    return x;
  };
  return JSON.stringify(norm(v));
}

/** Decision K front door shared by deferForConfirmation and the plan-commit
 *  deferral: housekeeping, then the atomic dedupe + cap reserve. */
export async function reserveConfirmation(
  db: D1Database,
  row: Omit<PendingActionRow, "consumed_at">,
  now: Date,
): ReturnType<typeof reservePendingAction> {
  await pruneExpiredPendingActions(db, now);
  await releaseSettledPlanMarkers(db, row.owner_subject, now);
  return reservePendingAction(db, row, now);
}

/** Sends a reserved action's confirmation: the user's own mailbox first; if
 *  that fails, the shared system mailer, within the owner's fallback limit.
 *  Undelivered → the reserved row is deleted (no one can confirm a link that
 *  never arrived, and a retry must not be deduped onto it). */
export async function deliverConfirmation(
  env: Env,
  args: {
    owner: string;
    rowId: string;
    logOp: string;
    viaProvider: () => Promise<void>;
    viaSystem: { subject: string; text: string };
  },
): Promise<boolean> {
  try {
    await args.viaProvider();
    return true;
  } catch (e) {
    console.error("confirm_mail_provider_failed", { op: args.logOp, error: e instanceof Error ? e.name : "unknown" });
  }
  let delivered = false;
  if (await claimSystemFallback(env.DB, args.rowId, args.owner, new Date())) {
    delivered = (await systemMailer(env).send({ to: args.owner, ...args.viaSystem })).ok;
  } else {
    console.warn("confirm_system_fallback_capped", { op: args.logOp });
  }
  if (!delivered) {
    await deletePendingAction(env.DB, args.rowId, args.owner);
    console.error("confirm_action_undeliverable", { op: args.logOp });
  }
  return delivered;
}

export async function deferForConfirmation(
  c: Ctx,
  args: { op: string; payload: unknown; summary: unknown },
): Promise<Response> {
  const owner = c.var.ownerSubject;
  if (!owner) throw new Error("deferForConfirmation called without an owner (run requireOwner first)");
  const def = getConfirmableOp(args.op);
  if (!def) throw new Error(`confirmable op not registered: ${args.op} (add its module to confirm/ops.ts)`);
  // Programmer errors throw: the handler built a payload its own op rejects.
  const payload = def.payloadSchema.parse(args.payload);
  const summary = def.summarySchema.parse(args.summary);

  const now = new Date();
  const id = crypto.randomUUID();
  const expiresAt = new Date(now.getTime() + PENDING_ACTION_TTL_SECONDS * 1000).toISOString();
  const reserved = await reserveConfirmation(c.env.DB, {
    id,
    owner_subject: owner,
    op: args.op,
    payload: canonicalJson(payload),
    summary: JSON.stringify(summary),
    created_at: now.toISOString(),
    expires_at: expiresAt,
  }, now);
  if (reserved.kind === "existing") {
    // Same request while the first is still waiting: its 202 again, no mail.
    console.log("confirm_action_deduped", { op: args.op, action_id: reserved.row.id });
    return c.json(
      { status: "awaiting_confirmation" as const, action_id: reserved.row.id, expires_at: reserved.row.expires_at, message: AWAITING_MESSAGE },
      202,
    );
  }
  if (reserved.kind === "capped") {
    console.warn("confirm_action_capped", { op: args.op });
    return c.json({ error: "too_many_pending_actions" as const }, 429);
  }

  const token = await signCapabilityWithEnv(
    { purpose: "confirm-action", actionId: id, subject: owner, ttlSeconds: PENDING_ACTION_TTL_SECONDS },
    c.env,
  );
  const url = `${c.env.OAUTH_ISSUER}/confirm/${encodeURIComponent(id)}?t=${encodeURIComponent(token)}`;
  const mail = confirmActionEmail({ label: def.label, url });

  const delivered = await deliverConfirmation(c.env, {
    owner,
    rowId: id,
    logOp: args.op,
    viaProvider: async () => {
      const notify = c.var.notificationProvider ?? await defaultNotificationProvider(c.env, owner);
      await notify.sendPollEmail({ to: owner, ...mail });
    },
    viaSystem: { subject: mail.subject, text: mail.text },
  });
  if (!delivered) {
    // Nobody can confirm an action whose link never arrived: tell the agent
    // plainly rather than leaving it waiting 24 h.
    return c.json({ error: "confirmation_unavailable" as const }, 503);
  }
  console.log("confirm_action_deferred", { op: args.op, action_id: id });
  return c.json(
    { status: "awaiting_confirmation" as const, action_id: id, expires_at: expiresAt, message: AWAITING_MESSAGE },
    202,
  );
}
