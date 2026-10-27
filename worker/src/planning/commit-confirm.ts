// O9.2 agent-confirm for commit and acceptPlan's bearer branch.
//
// For a client listed in AGENT_CONFIRM_CLIENT_IDS these ops apply nothing.
// They email the user the plan's own accept email (the replan email with the
// capability accept link, the same one the webhook and Monday cron send) and
// answer 202 awaiting_confirmation. The only thing that then commits is the
// existing capability POST /v1/plans/{h}/accept: the user's click on that
// email's page. That keeps ONE human-confirmed path to a commit, with the
// guards it already has (Authorization and foreign Sec-Fetch-Site refused,
// delisted owners refused, exact-hash commit with its committed_at CAS, 409
// plan_superseded with the week's newer plan, the stale-timezone refusal).
// A generic /confirm/{id} replay of commitPlan would have been a second path
// to keep in step with all of that, and a second page showing the same diff.
//
// So nothing here goes through the O9.1 registry or pending_actions: the
// proposed_plans row IS the pending action, and its plan_hash is the 202's
// action_id.
import type { Context } from "hono";
import { z } from "@hono/zod-openapi";
import type { Env } from "../env";
import type { AppVariables } from "../index-providers";
import { defaultNotificationProvider } from "../index-providers";
import { signCapabilityWithEnv } from "../auth/capability";
import { identityAnchorTag } from "../auth/identity-rebind";
import { AwaitingConfirmationResponse, confirmationResponses } from "../confirm/defer";
import { sendPlanAcceptEmailOnce } from "../confirm/plan-mail";
import { computePlanDiff, type PlanBody } from "../diff/compute-diff";
import { buildReplanEmailModel, type ReplanEmailModel } from "../diff/email-model";
import { loadTitleMap } from "../diff/load-titles";
import { getHomeTz } from "../db/users";
import { ACCEPT_TTL_SECONDS } from "./accept-ttl";
import { attachPendingRenderSnapshot, getCommittedDroppedForWeek, type ProposedPlanRow } from "./proposed-plans";
import type { ResolveResult } from "./resolve-internal";

type Ctx = Context<{ Bindings: Env; Variables: AppVariables }>;
export type PlanCommitOp = "commit" | "acceptPlan";

const AWAITING_MESSAGE =
  "Not done yet. Optical emailed the user this plan with an Accept button; it is applied only when they accept it themselves in their browser, before expires_at. Don't retry or ask again: tell the user to check their email.";

const PlanNotReviewable = z.object({
  error: z.literal("plan_not_reviewable").describe(
    "The plan has no reviewable change set to email (it changes nothing on the calendar, or it was resolved by a client that isn't agent-confirm gated), so it can't be sent for confirmation. Nothing was committed.",
  ),
});

/** Spread into commit's and acceptPlan's `responses`. */
export const planConfirmResponses = {
  202: {
    content: {
      "application/json": {
        schema: AwaitingConfirmationResponse.extend({
          action_id: z.string().describe(
            "The plan_hash of the plan the user was emailed to accept (the same plan_hash the request named). The plan is committed only through the emailed link; re-sending this request while it waits returns this same 202 without a second email.",
          ),
        }).describe(
          "Returned instead of committing when the calling OAuth client is listed in AGENT_CONFIRM_CLIENT_IDS: the user is emailed this plan's accept email, and the plan is committed only if they accept it on that email's page before expires_at (the plan's own expiry or the 72-hour link, whichever is first). action_id is the plan_hash.",
        ),
      },
    },
    description:
      "awaiting_confirmation: agent-confirm clients only. Nothing was committed; the user was emailed the plan to accept themselves.",
  },
  503: confirmationResponses[503],
  429: confirmationResponses[429],
} as const;


export const planNotReviewableResponse = {
  content: { "application/json": { schema: PlanNotReviewable } },
  description:
    "plan_not_reviewable: agent-confirm clients only. The plan has no reviewable changes to email (an empty diff, or no review snapshot because a non-gated client resolved it); nothing was committed. Re-resolve if the calendar has changed.",
} as const;

/** What the accept page will offer an Accept button for (accept.ts: a
 *  snapshot that isn't an empty diff). A change set of drops only has no
 *  days but is still reviewable. */
function isReviewable(snap: unknown): snap is ReplanEmailModel {
  if (typeof snap !== "object" || snap === null) return false;
  const s = snap as Partial<ReplanEmailModel>;
  return s.isEmpty === false && Array.isArray(s.days);
}

/** Defers a commit of `plan` (already through checkPlanCommittable, so owned,
 *  pending, current-tz and unexpired) by emailing its accept email. */
export async function deferPlanCommit(c: Ctx, plan: ProposedPlanRow, owner: string, op: PlanCommitOp): Promise<Response> {
  // The accept page offers no Accept button for an empty or missing snapshot,
  // so mailing one would leave the agent waiting on something no one can do.
  if (!isReviewable(plan.render_snapshot)) {
    return c.json({ error: "plan_not_reviewable" as const }, 409);
  }
  const window = plan.body.window as { start: string; end: string };
  const token = await signCapabilityWithEnv(
    {
      purpose: "accept", planHash: plan.plan_hash, subject: owner, ttlSeconds: ACCEPT_TTL_SECONDS, window,
      anchor: await identityAnchorTag(c.env, owner),
    },
    c.env,
  );
  const expiresAt = new Date(Math.min(Date.now() + ACCEPT_TTL_SECONDS * 1000, Date.parse(plan.expires_at))).toISOString();
  // Decision K: one emailed accept link per plan while it's live, and the
  // owner's live pending actions capped (confirm/plan-mail.ts).
  const acceptUrl = `${c.env.OAUTH_ISSUER}/v1/plans/${encodeURIComponent(plan.plan_hash)}/accept?t=${encodeURIComponent(token)}`;
  // The stored (unredacted) snapshot is the user's own email, framed as their
  // assistant's request whatever produced the plan.
  const model: ReplanEmailModel = { ...plan.render_snapshot, trigger: "api" };

  const mailed = await sendPlanAcceptEmailOnce(c.env, {
    owner,
    planHash: plan.plan_hash,
    expiresAt,
    logOp: op,
    viaProvider: async (to) => {
      const notify = c.var.notificationProvider ?? await defaultNotificationProvider(c.env, owner);
      await notify.sendReplanNotification(to, model, { acceptUrl, planHash: plan.plan_hash });
    },
    // Static copy and the link only: the plan's titles stay off the
    // third-party system mailer, and the page behind the link shows them.
    viaSystem: {
      subject: "Confirm: apply a plan to your calendar",
      text:
        "Your assistant asked Optical to apply a plan to your calendar.\n\n" +
        "Nothing has changed yet. Review the plan and accept it here:\n" +
        `${acceptUrl}\n\n` +
        "If you didn't ask your assistant for this, ignore this email and nothing will change.\n",
    },
  });
  if (mailed.kind === "duplicate") {
    return c.json(
      { status: "awaiting_confirmation" as const, action_id: plan.plan_hash, expires_at: mailed.expiresAt, message: AWAITING_MESSAGE },
      202,
    );
  }
  if (mailed.kind === "capped") return c.json({ error: "too_many_pending_actions" as const }, 429);
  if (mailed.kind === "undeliverable") return c.json({ error: "confirmation_unavailable" as const }, 503);
  console.log("plan_commit_deferred", { op, plan_hash: plan.plan_hash });
  return c.json(
    { status: "awaiting_confirmation" as const, action_id: plan.plan_hash, expires_at: expiresAt, message: AWAITING_MESSAGE },
    202,
  );
}

/** For an agent-confirm client's /v1/resolve: store the review snapshot the
 *  accept email and page render (the webhook and cron attach theirs when they
 *  mail). Built exactly as theirs are: diff against the calendar the resolve
 *  read and the week's last accepted drops, in the subject's effective tz. */
export async function attachAgentReviewSnapshot(
  env: Env,
  owner: string,
  result: Extract<ResolveResult, { kind: "ok" }>,
): Promise<void> {
  const tz = await getHomeTz(env.DB, owner, env.SCHEDULER_TZ);
  const committedDropped = await getCommittedDroppedForWeek(env.DB, owner, result.body.window.start, tz, env.SCHEDULER_TZ);
  const baseline: PlanBody = { schedule: result.priorEvents, dropped: committedDropped, window: result.body.window };
  const diff = computePlanDiff(result.body as unknown as PlanBody, baseline);
  const ids = Array.from(new Set([
    ...result.body.schedule.map((e) => e.task_id),
    ...baseline.schedule.map((e) => e.task_id),
    ...result.body.dropped.map((d) => d.task_id),
  ]));
  const model = buildReplanEmailModel({
    diff,
    titles: await loadTitleMap(env.DB, owner, ids),
    priorEvents: result.priorEvents,
    proposedSchedule: result.body.schedule,
    externalEvents: result.externalEvents,
    window: result.body.window,
    tz,
    trigger: "api",
    warnings: result.body.warnings ?? [],
    meetingTaskIds: result.meetingTaskIds,
  });
  await attachPendingRenderSnapshot(env.DB, result.planHash, owner, model);
}
