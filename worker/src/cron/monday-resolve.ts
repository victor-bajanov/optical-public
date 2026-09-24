// Cron expression: `0 15 * * SUN` (UTC) = 01:00 AEST Monday.
// During AEDT (UTC+11, ~Oct-Apr), this fires at 02:00 local — still well before
// normal work hours, so we deliberately do NOT shift with DST per spec §8.1.
import type { Env } from "../env";
import type { CalendarProvider } from "../providers/calendar-provider";
import type { NotificationProvider } from "../providers/notification-provider";
import { runResolve } from "../planning/resolve-internal";
import { localWeekWindow } from "../planning/datetime";
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
  // The cron fires at 01:00/02:00 *local* Monday, so localWeekWindow(now) is the
  // week just starting. Anchoring to the local Monday (not UTC) keeps the window
  // aligned with how weeks are committed — a UTC-Monday window started at 10:00
  // local and dropped Monday-morning chunks. See localWeekWindow.
  const window = localWeekWindow(now.toISOString(), env.SCHEDULER_TZ);

  const result = await runResolve({
    env,
    calendar,
    windowStart: window.start,
    windowEnd: window.end,
    accountEmail,
    trigger: "cron",
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
  // and still dropped is not re-emailed (2026-07-07). SCHEDULER_TZ is the tz
  // that derived this window (localWeekWindow above), and the churn baseline
  // buckets it the same way — the two baselines must agree on which plan they
  // are reading.
  const committedDropped = await getCommittedDroppedForWeek(env.DB, accountEmail, result.body.window.start, env.SCHEDULER_TZ);
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
    tz: env.SCHEDULER_TZ,
    trigger: "monday-cron",
    warnings: result.body.warnings ?? [],
    meetingTaskIds: result.meetingTaskIds,
  });
  await attachRenderSnapshot(env.DB, result.planHash, model);
  await notification.sendReplanNotification(accountEmail, model, { acceptUrl, planHash: result.planHash });

  return { kind: "ok", planHash: result.planHash };
}
