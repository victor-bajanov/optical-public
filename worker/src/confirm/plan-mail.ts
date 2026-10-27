// Decision K/L: a plan's accept email (the replan email with a capability
// accept link) is sent at most once per plan_hash while its link is live, and
// counts toward the owner's live-action cap and system-mailer fallback limit.
// Shared by the gated commit/acceptPlan deferral (planning/commit-confirm.ts)
// and replanNow (webhooks/google-calendar.ts with dedupeMail). Both key the
// same plan.commit-mail marker, so a plan replanNow already mailed isn't
// mailed again by a gated commit of it, and vice versa. The marker frees its
// slot once the plan is committed, expired or superseded
// (releaseSettledPlanMarkers).
import type { Env } from "../env";
import { PLAN_COMMIT_MAIL_OP } from "../db/pending-actions";
import { canonicalJson, deliverConfirmation, reserveConfirmation } from "./defer";
import { ownerNotificationEmail } from "../db/owner-email";

export type PlanMailOutcome =
  | { kind: "sent" }
  | { kind: "duplicate"; expiresAt: string }
  | { kind: "capped" }
  | { kind: "undeliverable" };

export async function sendPlanAcceptEmailOnce(
  env: Env,
  args: {
    owner: string;
    planHash: string;
    /** When the marker stops deduping: the accept link's expiry. */
    expiresAt: string;
    /** Op name for log lines only (no PII). */
    logOp: string;
    /** Sends to `to`, the owner's notification address (deliverConfirmation). */
    viaProvider: (to: string) => Promise<void>;
    viaSystem: { subject: string; text: string };
  },
): Promise<PlanMailOutcome> {
  // Before the reserve: a failed read must leave no marker, or every retry is
  // deduped onto an email that never went out (deliverConfirmation).
  const to = await ownerNotificationEmail(env.DB, args.owner);
  const now = new Date();
  const rowId = crypto.randomUUID();
  const reserved = await reserveConfirmation(env.DB, {
    id: rowId,
    owner_subject: args.owner,
    op: PLAN_COMMIT_MAIL_OP,
    payload: canonicalJson({ plan_hash: args.planHash }),
    summary: "{}",
    created_at: now.toISOString(),
    expires_at: args.expiresAt,
  }, now);
  if (reserved.kind === "existing") {
    console.log("plan_mail_deduped", { op: args.logOp, plan_hash: args.planHash });
    return { kind: "duplicate", expiresAt: reserved.row.expires_at };
  }
  if (reserved.kind === "capped") {
    console.warn("confirm_action_capped", { op: args.logOp });
    return { kind: "capped" };
  }
  const delivered = await deliverConfirmation(env, {
    owner: args.owner,
    to,
    rowId,
    logOp: args.logOp,
    viaProvider: args.viaProvider,
    viaSystem: args.viaSystem,
  });
  return delivered ? { kind: "sent" } : { kind: "undeliverable" };
}
