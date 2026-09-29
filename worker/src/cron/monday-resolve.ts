// Cron expression: `0 15 * * SUN` (UTC) = 01:00 AEST Monday.
// During AEDT (UTC+11, ~Oct-Apr), this fires at 02:00 local — still well before
// normal work hours, so we deliberately do NOT shift with DST per spec §8.1.
//
// The schedule is one instance-wide instant, but each subject's week is their
// own: the window, drop baseline and email are all in the subject's effective
// tz (users.home_tz, else SCHEDULER_TZ). West of about UTC+9 the cron fires on
// the user's Sunday, so the window is the UPCOMING local week
// (upcomingLocalWeekWindow), not the one still ending; those users get their
// "Monday" email on Sunday (an accepted v1 limitation, internal design notes
// decision 7).
import type { Env } from "../env";
import type { CalendarProvider } from "../providers/calendar-provider";
import type { NotificationProvider } from "../providers/notification-provider";
import { runResolve } from "../planning/resolve-internal";
import { upcomingLocalWeekWindow } from "../planning/datetime";
import { getHomeTz } from "../db/users";
import { computePlanDiff, type PlanBody } from "../diff/compute-diff";
import { buildReplanEmailModel } from "../diff/email-model";
import { attachRenderSnapshot, deleteProposedPlan, getCommittedDroppedForWeek } from "../planning/proposed-plans";
import { loadTitleMap } from "../diff/load-titles";
import { signCapabilityWithEnv } from "../auth/capability";
import { ACCEPT_TTL_SECONDS } from "../planning/accept-ttl";

export interface MondayResolveArgs {
  env: Env;
  calendar: CalendarProvider;
  notification: NotificationProvider;
  accountEmail: string;
  now?: Date;
}

export type MondayResolveResult =
  | { kind: "ok"; planHash: string }
  | { kind: "unsat" }
  | { kind: "solver_error"; status: number };

export async function runMondayResolve(args: MondayResolveArgs): Promise<MondayResolveResult> {
  const { env, calendar, notification } = args;
  const accountEmail = args.accountEmail;
  const now = args.now ?? new Date();
  // Week identity is in the subject's effective tz, the same tz every other
  // producer and consumer (webhook, resolve, supersede, accept) uses for them.
  const tz = await getHomeTz(env.DB, accountEmail, env.SCHEDULER_TZ);
  // The week starting on the user's nearest local Monday: the one just begun in
  // Sydney (01:00/02:00 Mon at fire time), the one about to begin anywhere
  // still on Sunday. Anchoring to the local Monday (not UTC) keeps the window
  // aligned with how weeks are committed — a UTC-Monday window started at 10:00
  // local and dropped Monday-morning chunks. See upcomingLocalWeekWindow.
  const window = upcomingLocalWeekWindow(now.toISOString(), tz);

  const result = await runResolve({
    env,
    calendar,
    windowStart: window.start,
    windowEnd: window.end,
    accountEmail,
    trigger: "cron",
    // The user's live upcoming week, even where it starts after fire time:
    // their backlog must populate it (not be shed as for a future week).
    upcomingWeek: true,
  });

  if (result.kind === "unsat") {
    console.warn("monday-resolve: unsat", { unsatCore: result.unsatCore });
    return { kind: "unsat" };
  }
  if (result.kind === "solver_error") {
    console.error("monday-resolve: solver_error", { status: result.status, detail: result.detail });
    return { kind: "solver_error", status: result.status };
  }

  // Drop baseline = the last accepted plan's dropped set for this calendar
  // week (however its window was anchored), so a task already dropped there
  // and still dropped is not re-emailed (2026-07-07). `tz` is the tz that
  // derived this window (above), and the churn baseline (resolve-internal)
  // buckets it in the same subject tz — the two baselines must agree on which
  // plan they are reading.
  const committedDropped = await getCommittedDroppedForWeek(env.DB, accountEmail, result.body.window.start, tz, env.SCHEDULER_TZ);
  const baseline: PlanBody = {
    schedule: result.priorEvents,
    dropped: committedDropped,
    window: result.body.window,
  };
  const diff = computePlanDiff(result.body as unknown as PlanBody, baseline);

  if (diff.isEmpty) {
    // No-op resolve: drop the row runResolve just inserted. Leaving it pending
    // would never be emailed yet would later surface as the "latest pending"
    // plan on the accept page (bare Accept button, no body). See the internal backlog.
    await deleteProposedPlan(env.DB, result.planHash, accountEmail);
    return { kind: "ok", planHash: result.planHash };
  }

  const ids = Array.from(new Set([
    ...result.body.schedule.map((e) => e.task_id),
    ...baseline.schedule.map((e) => e.task_id),
    ...result.body.dropped.map((d) => d.task_id),
  ]));
  const titles = await loadTitleMap(env.DB, accountEmail, ids);

  const cap = await signCapabilityWithEnv(
    { planHash: result.planHash, subject: accountEmail, purpose: "accept", ttlSeconds: ACCEPT_TTL_SECONDS, window: result.body.window },
    env,
  );
  const acceptUrl = `${env.OAUTH_ISSUER}/v1/plans/${result.planHash}/accept?t=${encodeURIComponent(cap)}`;
  const model = buildReplanEmailModel({
    diff,
    titles,
    priorEvents: result.priorEvents,
    proposedSchedule: result.body.schedule,
    externalEvents: result.externalEvents,
    window: result.body.window,
    tz,
    trigger: "monday-cron",
    warnings: result.body.warnings ?? [],
    meetingTaskIds: result.meetingTaskIds,
  });
  await attachRenderSnapshot(env.DB, result.planHash, model);
  await notification.sendReplanNotification(accountEmail, model, { acceptUrl, planHash: result.planHash });

  return { kind: "ok", planHash: result.planHash };
}
