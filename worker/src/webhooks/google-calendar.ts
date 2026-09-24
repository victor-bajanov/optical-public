import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Env } from "../env";
import type { CalendarProvider } from "../providers/calendar-provider";
import type { NotificationProvider } from "../providers/notification-provider";
import { getCalendarSync, upsertCalendarSync, getCalendarSyncByChannelId, PRIMARY_CALENDAR_ID } from "../db/calendar-sync";
import { timingSafeEqual } from "../auth/timing-safe";
import { runResolve } from "../planning/resolve-internal";
import { computePlanDiff, type PlanBody } from "../diff/compute-diff";
import { buildReplanEmailModel, type ReplanEmailModel } from "../diff/email-model";
import { loadTitleMap } from "../diff/load-titles";
import { attachRenderSnapshot, deleteProposedPlan, getCommittedDroppedForWeek, getCommittedPlansForSubject, updateCommittedPlanBodyStmt } from "../planning/proposed-plans";
import { computeMovedPlanPatch, reconcileMovedTask, type PatchablePlanBody } from "../planning/manual-move-writeback";
import { signCapabilityWithEnv } from "../auth/capability";
import { ACCEPT_TTL_SECONDS } from "../planning/accept-ttl";
import { localWeekWindow } from "../planning/datetime";
import { getDoneColorId } from "../db/users";
import { getDoneTaskIds } from "../db/tasks";
import { loadCompletionsByTask } from "../db/chunk-completions";
import { applyManualMoveStmt, getTaskRow } from "../db/d1";
import { debugLog } from "../log";
import { detectBookingDeclines } from "../booking/decline-cancel";
import { SCHEDULER_CHUNK_ID_KEY } from "../providers/types";
import type { Change, CalendarEvent } from "../providers/types";
import { D } from "../schema/descriptions";

type AppVars = { calendarProvider: CalendarProvider; notificationProvider: NotificationProvider };

export interface MountOptions {
  // Retained for compatibility; the webhook handler no longer uses this for
  // routing — owner is derived from x-goog-channel-id → calendar_sync lookup.
  accountEmail?: string;
  windowMinutes?: number;
}

// Horizon for the fallback FULL fetch (no prior sync token, or Google
// invalidated it). It bounds change *detection* only — the resolve window is
// derived per-event from localWeekWindow, so the normal incremental path
// (which returns changes regardless of date) is unaffected by this value.
const DEFAULT_DETECT_DAYS = 7;

export const isSchedulerOwned = (e: CalendarEvent): boolean =>
  Boolean(e.extendedProperties?.private?.[SCHEDULER_CHUNK_ID_KEY]);

export interface ReplanArgs {
  env: Env;
  calendar: CalendarProvider;
  notify: NotificationProvider;
  accountEmail: string;
  oauthIssuer: string;
  dryRun?: boolean;
  // When true, skip the incremental-fetch short-circuit and always resolve.
  // Used by /admin/replan-now to exercise the flow without an external event.
  forceResolve?: boolean;
  windowDays?: number;
  // Optional override for the invite title used in the email subject.
  triggerInviteTitle?: string;
}

export type ReplanResult =
  | { kind: "no_changes"; nextSyncToken: string | null }
  | { kind: "no_diff" }
  | { kind: "unsat"; unsatCore: unknown }
  | { kind: "solver_error"; status: number; detail: string }
  | { kind: "replanned"; planHash: string; sent: boolean; model: ReplanEmailModel };

/** A calendar week to re-resolve, plus a representative human invite title for
 *  the diff email subject. Keyed elsewhere by window.start. */
interface AffectedWeek {
  window: { start: string; end: string };
  inviteTitle: string;
  triggerEventIds: string[];
}

/** Significance order for picking the result to report when a debounced burst
 *  touches several weeks. Higher wins; errors surface over a quiet replan so
 *  the DO log and /admin/replan-now don't hide a failure. */
const RESULT_RANK: Record<ReplanResult["kind"], number> = {
  solver_error: 4,
  unsat: 3,
  replanned: 2,
  no_diff: 1,
  no_changes: 0,
};

/**
 * Runs the webhook replan flow without HTTP framing. Shared by the real
 * Google-driven webhook route and the /admin/replan-now developer trigger.
 *
 * The resolve window is derived per-changed-event from the LOCAL week that
 * event falls in (see localWeekWindow), not a fixed forward window. A schedule
 * lives weeks ahead, so a fixed [now,+7d) window was empty and silently
 * produced no diff/email (bug 2026-05-26). A debounced burst spanning several
 * weeks re-resolves each distinct week.
 */
export async function runWebhookReplan(args: ReplanArgs): Promise<ReplanResult> {
  const {
    env,
    calendar,
    notify,
    accountEmail,
    oauthIssuer,
    dryRun = false,
    forceResolve = false,
    windowDays = DEFAULT_DETECT_DAYS,
    triggerInviteTitle,
  } = args;

  const sync = await getCalendarSync(env.DB, accountEmail, PRIMARY_CALENDAR_ID);

  let newSyncToken: string | null = sync?.next_sync_token ?? null;
  // Human (non-scheduler-owned) events that changed. Deletes carry no time and
  // cannot be bucketed into a week, so — as before — they do not trigger a replan.
  let changedEvents: CalendarEvent[] = [];
  const detectStart = new Date().toISOString();
  const detectEnd = new Date(Date.now() + windowDays * 24 * 3600 * 1000).toISOString();

  // Raw events from whichever fetch branch ran, BEFORE the scheduler-owned
  // filter — debugLog reports both so a color-change push is visible as
  // raw=1/sched_owned=true → changed=0 (filtered → no_changes), the exact
  // shape that explains "done-by-color does not self-trigger a resolve".
  let fetchPath: string;
  let rawEvents: CalendarEvent[] = [];
  if (sync?.next_sync_token) {
    const incremental = await calendar.fetchIncrementalChanges(sync.next_sync_token);
    if (incremental.syncTokenInvalidated) {
      fetchPath = "full_resync";
      const full = await calendar.fetchEventsInWindow(detectStart, detectEnd);
      newSyncToken = full.nextSyncToken;
      rawEvents = full.events;
    } else {
      fetchPath = "incremental";
      newSyncToken = incremental.nextSyncToken;
      rawEvents = incremental.changes
        .filter((ch: Change): ch is Extract<Change, { kind: "upsert" }> => ch.kind === "upsert")
        .map((ch) => ch.event);
    }
  } else {
    fetchPath = "full_notoken";
    const full = await calendar.fetchEventsInWindow(detectStart, detectEnd);
    newSyncToken = full.nextSyncToken;
    rawEvents = full.events;
  }
  // Scheduler-owned events are normally filtered out (feedback-loop guard), BUT
  // a chunk painted the user's DONE color is a real signal — it is how the user
  // marks a task finished. Let those through so the recolour triggers its week's
  // resolve, where the done-scan (resolve-internal) flips the task to 'done'.
  // Without this, a pure done-recolour is changed=0 → no_changes → the scan
  // never runs, so done-by-color only worked as a side effect of some OTHER
  // change resolving that week (prod bug 2026-06-04).
  // The discriminator is the task's D1 done-state, applied symmetrically: a
  // done-colored chunk passes only when the task is NOT yet done (a fresh user
  // done-paint), and a non-done-colored chunk passes only when the task IS done
  // (the symmetric "un-done" tomato→banana repaint). A done-colored chunk whose
  // task is already done is OUR OWN recolor echo (the PATCH-done handler) and is
  // dropped — that is the case the unified rule below resolves.
  // Provider-shaped floor under users.done_color_id, above env.DONE_COLOR_ID
  // (Card H) — a NULL row on a Microsoft-provider subject must resolve to
  // "Optical Done", not Google's numeric env default, or the pinhole below
  // never recognises a real category repaint as a signal.
  const doneColorId = await getDoneColorId(env.DB, accountEmail, calendar.defaultDoneColorId ?? env.DONE_COLOR_ID ?? "");
  // Extract a chunk's task_id from its scheduler chunk id (everything before the
  // last '#', or the whole id when there is none), mirroring the done-scan.
  const taskIdOf = (e: CalendarEvent): string => {
    const chunkId = e.extendedProperties?.private?.[SCHEDULER_CHUNK_ID_KEY] ?? "";
    const hash = chunkId.lastIndexOf("#");
    return hash === -1 ? chunkId : chunkId.slice(0, hash);
  };
  // One batched D1 read over ALL scheduler-owned candidates gives their done
  // state; a pure external change set queries D1 zero times (empty-set path).
  const schedulerCandidates = rawEvents.filter(isSchedulerOwned);
  const doneInDb =
    schedulerCandidates.length === 0
      ? new Set<string>()
      : await getDoneTaskIds(env.DB, accountEmail, schedulerCandidates.map(taskIdOf));

  // Chunk ids with a CONFIRMED completion record (color_confirmed_at set). A
  // non-done-colored chunk that carries one is a per-chunk UN-PAINT — the user
  // reverting a recorded chunk, including on a still-pending partially-completed
  // task. The task-level doneInDb set misses these (the task is not status=done),
  // so the evidence-gated revive in runResolve would never be triggered.
  const confirmedChunkIds = new Set<string>();
  if (schedulerCandidates.length > 0) {
    const byTask = await loadCompletionsByTask(env.DB, accountEmail, schedulerCandidates.map(taskIdOf));
    for (const rows of byTask.values()) {
      for (const row of rows) if (row.color_confirmed_at) confirmedChunkIds.add(row.chunk_id);
    }
  }

  // Unified pinhole. A scheduler-owned event is a real signal only when:
  //  - it is painted the done color AND its task is NOT yet done  → a fresh
  //    user done-paint that the done-scan must act on; OR
  //  - it is NOT done-colored AND its task IS currently done      → a tomato→
  //    banana repaint, i.e. the un-done revive signal (pinhole b); OR
  //  - it is NOT done-colored AND THIS chunk has a CONFIRMED completion record
  //    → a per-chunk un-paint, the user reverting a single recorded chunk. This
  //    fires even on a still-pending partially-completed task (only some chunks
  //    recorded), which the task-level doneInDb set misses; without it the
  //    evidence-gated per-chunk revive in runResolve would never be triggered
  //    from the live webhook (bug 2026-06-15). Echo-safe: the DC1-undo (PATCH
  //    done→pending) DELETES the completion records BEFORE repainting chunks to
  //    the create color, and a freshly committed chunk has no record, so neither
  //    create-color repaint is in confirmedChunkIds → both stay non-signals.
  // A done-colored chunk whose task is already done is OUR OWN recolor echo
  // (the PATCH-done handler) and is dropped. Everything else scheduler-owned is
  // filtered by the feedback-loop guard.
  const isSignal = (e: CalendarEvent): boolean => {
    if (!isSchedulerOwned(e)) return true;
    const tid = taskIdOf(e);
    const doneColored = doneColorId !== "" && e.colorId === doneColorId;
    if (doneColored) return !doneInDb.has(tid); // fresh done-paint (unless our echo)
    // NOT done-colored → un-paint signal when the task is fully done (revert of a
    // done task) OR this specific chunk has a confirmed completion record (a
    // per-chunk un-paint, incl. a partially-completed pending task).
    const chunkId = e.extendedProperties?.private?.[SCHEDULER_CHUNK_ID_KEY] ?? "";
    return doneInDb.has(tid) || confirmedChunkIds.has(chunkId);
  };
  changedEvents = rawEvents.filter(isSignal);
  const undoneCount = changedEvents.filter(
    (e) => isSchedulerOwned(e) && !(doneColorId !== "" && e.colorId === doneColorId),
  ).length;

  debugLog(env, "dbg_webhook_fetch", {
    owner: accountEmail,
    path: fetchPath,
    raw: rawEvents.length,
    changed: changedEvents.length,
    undone: undoneCount,
    forceResolve,
    events: rawEvents.map((e) => ({
      id: e.id,
      summary: e.summary,
      start: e.start,
      sched_owned: isSchedulerOwned(e),
      colorId: e.colorId,
    })),
  });

  // Manual-move write-back. A hand-dragged scheduler-owned event must (1) update
  // the churn baseline (the committed plan that CONTAINS the chunk — not just the
  // latest, X5) so the next replan isn't biased to revert, and (2) drag the task's
  // own surfaces along: re-stamp scheduled_for and reconcile constraints, since a
  // drag is authoritative intent — earliest_start lowers to the drop (X6), pinned_at
  // moves to it (L6). All writes land in ONE atomic db.batch() (X4): a failure rolls
  // every surface back, so re-delivery sees changed=true and heals. D1 write only —
  // never triggers a replan. See
  // internal design notes.
  if (schedulerCandidates.length > 0) {
    const nowMs = Date.parse(new Date().toISOString());
    // Bounded scan, then drop fully-elapsed weeks (their churn baseline is never
    // resolved against again — runResolve short-circuits on isWeekFullyPast). A plan
    // with no parseable window can't be proven past, so it is kept.
    const plans = (await getCommittedPlansForSubject(env.DB, accountEmail)).filter((p) => {
      const w = p.body.window as { end?: string } | undefined;
      const endMs = w?.end ? Date.parse(w.end) : NaN;
      return !Number.isFinite(endMs) || endMs >= nowMs;
    });

    const planPatches: { plan_hash: string; body: PatchablePlanBody }[] = [];
    const movedTarget = new Map<string, string>(); // task_id → earliest moved start across plans
    for (const plan of plans) {
      const patch = computeMovedPlanPatch(plan.body as unknown as PatchablePlanBody, schedulerCandidates);
      if (!patch.changed) continue;
      planPatches.push({ plan_hash: plan.plan_hash, body: patch.body });
      const movedSet = new Set(patch.movedTaskIds);
      for (const entry of patch.body.schedule) {
        if (!movedSet.has(entry.task_id)) continue;
        const cur = movedTarget.get(entry.task_id);
        if (cur === undefined || Date.parse(entry.start) < Date.parse(cur)) {
          movedTarget.set(entry.task_id, entry.start);
        }
      }
    }

    if (movedTarget.size > 0) {
      const movedNow = new Date().toISOString();
      const stmts: D1PreparedStatement[] = planPatches.map((p) =>
        updateCommittedPlanBodyStmt(env.DB, p.plan_hash, accountEmail, p.body),
      );
      // Read-modify-write on each moved task's body. This is the X7 non-atomicity
      // class (no version predicate); a concurrent PATCH/commit between this read and
      // the batch can be clobbered. Deliberately left to X7's fix — see the X7 entry
      // in docs/fable-review.md. N is tiny (chunks moved in one delivery), so the
      // sequential reads are fine.
      for (const [taskId, newStart] of movedTarget) {
        const row = await getTaskRow<Record<string, unknown>>(env.DB, accountEmail, taskId);
        if (!row || row.status === "done" || row.status === "cancelled") continue;
        const { scheduledFor, bodyPatch } = reconcileMovedTask(row.body, newStart);
        const nextBody = bodyPatch ? { ...row.body, ...bodyPatch } : row.body;
        stmts.push(applyManualMoveStmt(env.DB, accountEmail, taskId, scheduledFor, nextBody, movedNow));
      }
      await env.DB.batch(stmts);
      debugLog(env, "dbg_webhook_move_writeback", {
        owner: accountEmail,
        plans: planPatches.length,
        movedTasks: movedTarget.size,
      });
    }
  }

  if (changedEvents.length === 0 && !forceResolve) {
    debugLog(env, "dbg_webhook_no_changes", { owner: accountEmail, path: fetchPath });
    if (newSyncToken) {
      await upsertCalendarSync(env.DB, accountEmail, PRIMARY_CALENDAR_ID, { next_sync_token: newSyncToken });
    }
    return { kind: "no_changes", nextSyncToken: newSyncToken };
  }

  // Booking-page decline detection (internal design notes,
  // Card C). Purely additive: it only ever writes `bookings.cancel_pending_at`
  // for optical_booking-tagged events among the SAME changed-event list the
  // replan below uses — never touches isSignal or the scheduler-owned filter
  // above.
  //
  // Placement: after the zero-changes early return (line 295) and the
  // manual-move write-back above, so a delivery with nothing for the replan
  // to act on skips detection too — a decline is only actionable alongside
  // some change worth reporting, and a delivery that's genuinely a no-op for
  // BOTH is naturally replayed on the next webhook delivery for that event,
  // so deferring here costs nothing. Before the week bucketing below, so
  // detection always sees the exact same changed-event list the replan does.
  //
  // Isolated in its own try/catch in the OTHER direction only: a detection
  // failure must never break the replan, but a replan failure below is
  // allowed to propagate as usual — this catch does not, and must not,
  // shield anything past this point.
  try {
    await detectBookingDeclines(env.DB, accountEmail, changedEvents, new Date());
  } catch (err) {
    debugLog(env, "dbg_webhook_decline_detect_error", {
      owner: accountEmail,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Bucket the changed events into the distinct local weeks they touch. The
  // first event seen in a week supplies that week's email subject title.
  const weeks = new Map<string, AffectedWeek>();
  for (const e of changedEvents) {
    const window = localWeekWindow(e.start, env.SCHEDULER_TZ);
    const existing = weeks.get(window.start);
    if (existing) {
      existing.triggerEventIds.push(e.id);
    } else {
      weeks.set(window.start, { window, inviteTitle: triggerInviteTitle ?? e.summary, triggerEventIds: [e.id] });
    }
  }
  if (weeks.size === 0) {
    // forceResolve with no detected human change → resolve the current week.
    const window = localWeekWindow(detectStart, env.SCHEDULER_TZ);
    weeks.set(window.start, { window, inviteTitle: triggerInviteTitle ?? "manual replan", triggerEventIds: [] });
  }

  debugLog(env, "dbg_webhook_weeks", {
    owner: accountEmail,
    count: weeks.size,
    weeks: [...weeks.values()].map((w) => ({
      start: w.window.start,
      end: w.window.end,
      triggers: w.triggerEventIds,
    })),
  });

  const results: ReplanResult[] = [];
  for (const week of weeks.values()) {
    results.push(
      await resolveWeek({ env, calendar, notify, accountEmail, oauthIssuer, dryRun, week }),
    );
  }

  // Persist the webhook-derived sync token AFTER the resolves, since runResolve
  // also writes calendar_sync.next_sync_token from its own fetchEventsInWindow call.
  if (newSyncToken) {
    await upsertCalendarSync(env.DB, accountEmail, PRIMARY_CALENDAR_ID, { next_sync_token: newSyncToken });
  }

  // Report the most significant outcome across the weeks (errors over replans
  // over no-ops). Per-week emails have already been sent as a side effect.
  return results.reduce((a, b) => (RESULT_RANK[b.kind] > RESULT_RANK[a.kind] ? b : a));
}

/** Resolve one week and, if the plan differs from the calendar, email a diff
 *  with an accept link. The per-week unit of runWebhookReplan. */
async function resolveWeek(args: {
  env: Env;
  calendar: CalendarProvider;
  notify: NotificationProvider;
  accountEmail: string;
  oauthIssuer: string;
  dryRun: boolean;
  week: AffectedWeek;
}): Promise<ReplanResult> {
  const { env, calendar, notify, accountEmail, oauthIssuer, dryRun, week } = args;

  const result = await runResolve({
    env,
    calendar,
    windowStart: week.window.start,
    windowEnd: week.window.end,
    accountEmail,
    trigger: "webhook",
  });

  if (result.kind === "unsat") {
    return { kind: "unsat", unsatCore: result.unsatCore };
  }
  if (result.kind === "solver_error") {
    return { kind: "solver_error", status: result.status, detail: result.detail };
  }

  // Drop baseline = the last accepted plan's dropped set for this calendar
  // week (however its window was anchored), so a task already dropped there
  // and still dropped is not re-emailed (2026-07-07). SCHEDULER_TZ is the tz
  // that produced this window (above), and the churn baseline buckets it the
  // same way — the two baselines must agree on which plan they are reading.
  const committedDropped = await getCommittedDroppedForWeek(env.DB, accountEmail, result.body.window.start, env.SCHEDULER_TZ);
  const baseline: PlanBody = {
    schedule: result.priorEvents,
    dropped: committedDropped,
    window: result.body.window,
  };
  const diff = computePlanDiff(result.body as unknown as PlanBody, baseline);

  if (diff.isEmpty) {
    // No-op replan: drop the row runResolve just inserted. Leaving it pending
    // would never be emailed yet would later surface as the "latest pending"
    // plan on the accept page (bare Accept button, no body). See the internal backlog.
    await deleteProposedPlan(env.DB, result.planHash, accountEmail);
    return { kind: "no_diff" };
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
  const acceptUrl = `${oauthIssuer}/v1/plans/${result.planHash}/accept?t=${encodeURIComponent(cap)}`;

  const model = buildReplanEmailModel({
    diff,
    titles,
    priorEvents: result.priorEvents,
    proposedSchedule: result.body.schedule,
    externalEvents: result.externalEvents,
    window: result.body.window,
    tz: env.SCHEDULER_TZ,
    trigger: { kind: "webhook", inviteTitle: week.inviteTitle },
    triggerEventIds: week.triggerEventIds,
    warnings: result.body.warnings ?? [],
    meetingTaskIds: result.meetingTaskIds,
  });
  await attachRenderSnapshot(env.DB, result.planHash, model);

  let sent = false;
  if (!dryRun) {
    await notify.sendReplanNotification(accountEmail, model, { acceptUrl, planHash: result.planHash });
    sent = true;
  }

  return { kind: "replanned", planHash: result.planHash, sent, model };
}

export function mountGoogleCalendarWebhookRoute(
  v1: OpenAPIHono<{ Bindings: Env; Variables: AppVars }>,
  opts: MountOptions,
) {
  const webhookRoute = createRoute({
    method: "post",
    path: "/webhook/google-calendar",
    tags: ["webhook"],
    operationId: "googleCalendarWebhook",
    summary: "Receive Google Calendar push notifications.",
    description:
      "Called by Google Calendar push notifications. Auth is validated via X-Goog-Channel-Token, not Bearer. Not for end-user clients.",
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({
              ok: z.literal(true),
              queued: z.boolean().optional().describe(D.webhook.queued),
              state: z.string().optional().describe(D.webhook.state),
            }),
          },
        },
        description: "Webhook processed",
      },
      401: {
        content: { "application/json": { schema: z.object({ error: z.string() }) } },
        description: "Channel token mismatch",
      },
      404: {
        content: { "application/json": { schema: z.object({ error: z.string() }) } },
        description: "Unknown push channel",
      },
    },
  });

  v1.openapi(webhookRoute, async (c) => {
    const channelId = c.req.header("x-goog-channel-id");
    const channelToken = c.req.header("x-goog-channel-token");
    const resourceState = c.req.header("x-goog-resource-state") ?? "";

    if (!channelId) {
      return c.json({ error: "unknown_channel" }, 404);
    }

    // Discover the OWNER from the push's channel id. channel_id is UNIQUE
    // (migration 0014), so this maps to at most one owner. This — not the
    // first connected identity — is who the push belongs to, which is the
    // whole point of per-user routing.
    const row = await getCalendarSyncByChannelId(c.env.DB, channelId);
    if (!row) {
      return c.json({ error: "unknown_channel" }, 404);
    }
    if (!row.channel_token || !channelToken || !timingSafeEqual(row.channel_token, channelToken)) {
      return c.json({ error: "channel_token_mismatch" }, 401);
    }

    const accountEmail = row.owner_subject;

    if (resourceState === "sync") {
      return c.json({ ok: true as const, state: "sync" }, 200);
    }

    // Hand off to THIS owner's coordinator. It debounces a burst into one
    // resolve (~10s) and runs runWebhookReplan from its alarm, off the request
    // path. Return immediately so Google sees a fast 200 and does not cancel.
    const id = c.env.RESOLVE_COORDINATOR.idFromName(accountEmail);
    const stub = c.env.RESOLVE_COORDINATOR.get(id);
    await stub.notifyChange(accountEmail);
    return c.json({ ok: true as const, queued: true }, 200);
  });
}
