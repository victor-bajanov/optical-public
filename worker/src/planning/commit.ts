import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Env } from "../env";
import type { CalendarProvider } from "../providers/calendar-provider";
import type { AppVariables } from "../index-providers";
import { SCHEDULER_CHUNK_ID_KEY } from "../providers/types";
import { SCHEDULER_HORIZON_MS } from "./scheduler-chunks";
import { requireOwner } from "../middleware/owner-gate";
import { defaultCalendarProvider } from "../index-providers";
import { getProposedPlan, markProposedPlanCommittedStmt } from "./proposed-plans";
import { syncBookingTime } from "../db/bookings";
import { D } from "../schema/descriptions";

const CommitBodySchema = z.object({ plan_hash: z.string().describe(D.response.plan_hash) });

const CommitResponseSchema = z.union([
  z.object({
    plan_hash: z.string().describe(D.response.plan_hash),
    committed: z.number().describe(D.response.committed),
  }),
  z.object({
    plan_hash: z.string().describe(D.response.plan_hash),
    already_committed: z.literal(true).describe(D.response.already_committed),
  }),
]);

interface ScheduleEntry {
  task_id: string;
  chunk_id: string;
  start: string;
  end: string;
  context: string;
}

function chunkKey(entry: ScheduleEntry): string {
  return entry.chunk_id;
}

async function loadScheduleTasks(
  db: D1Database,
  ownerSubject: string,
  taskIds: string[],
): Promise<Map<string, { status: string; title: string; source?: { kind?: string; external_id?: string | null } }>> {
  const out = new Map<string, { status: string; title: string; source?: { kind?: string; external_id?: string | null } }>();
  if (taskIds.length === 0) return out;
  const placeholders = taskIds.map(() => "?").join(", ");
  const { results } = await db
    .prepare(`SELECT id, body, status FROM tasks WHERE owner_subject = ? AND id IN (${placeholders})`)
    .bind(ownerSubject, ...taskIds)
    .all<{ id: string; body: string; status: string }>();
  for (const r of results) {
    const body = JSON.parse(r.body) as { title?: string; source?: { kind?: string; external_id?: string | null } };
    out.set(r.id, { status: r.status, title: body.title ?? r.id, source: body.source });
  }
  return out;
}

const LIVE_STATUSES = new Set(["pending", "scheduled", "committed"]);

/** How far the stray-chunk sweep looks beyond the plan window before minting a
 *  new event for a chunk (duplicate-mint guard). Backward covers a revived done
 *  task whose old event lingers some weeks in the past (incident 2026-07-06:
 *  ~5 weeks); forward mirrors the offboard/scheduler horizon, the furthest a
 *  prior commit could have placed the chunk. */
const STRAY_SCAN_BACK_MS = 92 * 24 * 60 * 60 * 1000;

export interface CommitOptions {
  /** Color painted onto a stray event relocated into the plan window (a fresh
   *  placement must not keep a stale done-paint). Callers thread
   *  env.CREATE_COLOR_ID; the fallback mirrors the PATCH handler's default. */
  createColorId?: string;
}

export async function commitPlan(
  db: D1Database,
  cal: CalendarProvider,
  planHash: string,
  ownerSubject: string,
  opts: CommitOptions = {},
): Promise<{ status: number; body: unknown }> {
  const plan = await getProposedPlan(db, planHash);
  if (!plan) return { status: 404, body: { error: "not_found" } };
  // OS1: owner-scope BEFORE any calendar/DB side effect. A foreign or legacy
  // NULL-subject plan_hash must mutate nothing and is indistinguishable from
  // "not found" (no existence leak). markProposedPlanCommitted's owner predicate
  // below stays as defense-in-depth.
  if (plan.subject !== ownerSubject) return { status: 404, body: { error: "not_found" } };
  if (plan.committed_at) {
    return { status: 200, body: { plan_hash: planHash, already_committed: true } };
  }
  if (Date.parse(plan.expires_at) < Date.now()) {
    return { status: 410, body: { error: "plan_expired" } };
  }

  const schedule = plan.body.schedule as ScheduleEntry[];

  const windowStart = (plan.body.window as { start: string; end: string }).start;
  const windowEnd = (plan.body.window as { start: string; end: string }).end;
  const existing = await cal.fetchEventsInWindow(windowStart, windowEnd, { syncToken: false });
  const existingByChunk = new Map<
    string,
    { eventId: string; start: string; end: string; summary: string }
  >();
  for (const e of existing.events) {
    const chunkId = e.extendedProperties?.private?.[SCHEDULER_CHUNK_ID_KEY];
    if (chunkId) {
      existingByChunk.set(chunkId, {
        eventId: e.id,
        start: e.start,
        end: e.end,
        summary: e.summary,
      });
    }
  }

  // Index live calendar events by id for the meeting-move "did it move?" check.
  const existingById = new Map<string, { eventId: string; start: string; end: string }>();
  for (const e of existing.events) {
    existingById.set(e.id, { eventId: e.id, start: e.start, end: e.end });
  }

  const scheduleTaskIds = [...new Set(schedule.map((e) => e.task_id))];
  const taskInfo = await loadScheduleTasks(db, ownerSubject, scheduleTaskIds);

  const MEETING_KIND = "meeting";
  const proposedByChunk = new Map<string, { start: string; end: string; title: string }>();
  const meetingMoves: Array<{ taskId: string; eventId: string; start: string; end: string; title: string }> = [];
  for (const entry of schedule) {
    const info = taskInfo.get(entry.task_id);
    // Non-live (missing / done / cancelled) tasks are excluded: not created here,
    // and any existing event is removed by the delete-loop below (releasing the
    // slot — a task done early frees its time). See the X1+X2 ghost-event spec.
    if (!info || !LIVE_STATUSES.has(info.status)) continue;
    if (info.source?.kind === MEETING_KIND && info.source.external_id) {
      meetingMoves.push({
        taskId: entry.task_id,
        eventId: info.source.external_id,
        start: entry.start,
        end: entry.end,
        title: info.title,
      });
      continue; // meetings are NEVER created/deleted as chunk events
    }
    proposedByChunk.set(chunkKey(entry), { start: entry.start, end: entry.end, title: info.title });
  }

  // Duplicate-mint guard: a chunk with no event INSIDE the plan window may
  // still have a live event in another week (a revived task's old placement —
  // the 2026-07-06 incident). Creating a second event would leave two calendar
  // events sharing one scheduler_chunk_id, which then confuses the color-based
  // done/revive scans. Sweep a wide window around the plan and index any such
  // strays so the reconcile below MOVES them instead of minting duplicates.
  // One extra fetch, and only when at least one chunk would otherwise be created.
  const strayByChunk = new Map<string, { eventId: string }[]>();
  const missingChunkIds = [...proposedByChunk.keys()].filter((id) => !existingByChunk.has(id));
  if (missingChunkIds.length > 0) {
    const missing = new Set(missingChunkIds);
    const wideStart = new Date(Date.parse(windowStart) - STRAY_SCAN_BACK_MS).toISOString();
    const wideEnd = new Date(Date.parse(windowStart) + SCHEDULER_HORIZON_MS).toISOString();
    const wide = await cal.fetchEventsInWindow(wideStart, wideEnd, { syncToken: false });
    for (const e of wide.events) {
      const chunkId = e.extendedProperties?.private?.[SCHEDULER_CHUNK_ID_KEY];
      if (!chunkId || !missing.has(chunkId)) continue;
      if (existingByChunk.get(chunkId)?.eventId === e.id) continue; // in-window copy, already indexed
      const list = strayByChunk.get(chunkId) ?? [];
      list.push({ eventId: e.id });
      strayByChunk.set(chunkId, list);
    }
  }

  // Reconcile keyed by chunk_id. Order: PATCH/create first, delete last, so a
  // crash leaves stale (recoverable) events rather than lost ones. Reconcile is
  // idempotent — re-running converges to the proposed state.
  for (const [chunkId, proposed] of proposedByChunk) {
    const current = existingByChunk.get(chunkId);
    if (current) {
      const differs =
        Date.parse(current.start) !== Date.parse(proposed.start) ||
        Date.parse(current.end) !== Date.parse(proposed.end) ||
        current.summary !== proposed.title;
      if (differs) {
        // Omit extendedProperties so the stored chunk_id and per-event state survive.
        await cal.updateEvent(current.eventId, {
          start: proposed.start,
          end: proposed.end,
          summary: proposed.title,
        });
      }
      continue;
    }
    const strays = strayByChunk.get(chunkId) ?? [];
    if (strays.length > 0) {
      // Relocate the chunk's existing event into the planned slot instead of
      // minting a duplicate, and repaint it the create color — a re-placed chunk
      // is open work, and a lingering done-paint would immediately re-record it
      // complete. Extras (an already-duplicated chunk) are deleted: one chunk,
      // one event.
      const [keep, ...extras] = strays;
      await cal.updateEvent(keep!.eventId, {
        start: proposed.start,
        end: proposed.end,
        summary: proposed.title,
        // ?? not ||: a provider's undoneColorId can legitimately be "" (the
        // Microsoft category-clear sentinel — see handlers/tasks.ts). Using
        // opts.createColorId here would keep painting the done category on
        // Microsoft, so the next scan would immediately flip the relocated
        // (open) task back to done.
        colorId: cal.undoneColorId ?? opts.createColorId ?? "5",
      });
      for (const extra of extras) await cal.deleteEvent(extra.eventId);
      console.info("commit_stray_chunk_relocated", { chunk: chunkId, kept: keep!.eventId, deleted: extras.length });
      continue;
    }
    await cal.createEvent(
      {
        id: "",
        summary: proposed.title,
        start: proposed.start,
        end: proposed.end,
        // Explicit: the provider no longer paints every created event the chunk
        // colour (a booking is a real meeting and must not wear it).
        colorId: opts.createColorId ?? "5",
        extendedProperties: {},
      },
      { [SCHEDULER_CHUNK_ID_KEY]: chunkId },
    );
  }
  for (const [chunkId, current] of existingByChunk) {
    if (!proposedByChunk.has(chunkId)) {
      await cal.deleteEvent(current.eventId);
    }
  }

  // Meeting moves: patch the REAL event time and notify attendees. Only when the
  // time actually changed (avoids a needless attendee email + calendar bump).
  const movedMeetingTaskIds: string[] = [];
  for (const mv of meetingMoves) {
    const current = existingById.get(mv.eventId);
    if (!current) continue; // event vanished between resolve and commit — skip
    const moved =
      Date.parse(current.start) !== Date.parse(mv.start) ||
      Date.parse(current.end) !== Date.parse(mv.end);
    if (moved) {
      await cal.updateEvent(
        mv.eventId,
        { start: mv.start, end: mv.end },
        { notifyAttendees: true },
      );
      // The moved event may also be a claimed public-booking slot (its
      // google_event_id). A no-match update is a silent no-op — most moved
      // meetings are not bookings.
      await syncBookingTime(db, ownerSubject, mv.eventId, mv.start, mv.end, new Date());
      movedMeetingTaskIds.push(mv.taskId);
    }
  }

  // A task may span multiple chunks; scheduled_for is the earliest committed
  // chunk start for that task. Update every task in the plan regardless of
  // whether its calendar event moved. Numeric comparison guards against plans
  // or test seeds that omit milliseconds.
  const earliestStartByTask = new Map<string, string>();
  for (const entry of schedule) {
    const current = earliestStartByTask.get(entry.task_id);
    if (current === undefined || Date.parse(entry.start) < Date.parse(current)) {
      earliestStartByTask.set(entry.task_id, entry.start);
    }
  }
  const now = new Date().toISOString();
  const writes: D1PreparedStatement[] = [];
  for (const [taskId, earliestStart] of earliestStartByTask) {
    writes.push(
      db
        .prepare(
          "UPDATE tasks SET status = 'committed', scheduled_for = ?, updated_at = ? WHERE id = ? AND owner_subject = ? AND status IN ('pending', 'scheduled', 'committed')",
        )
        .bind(earliestStart, now, taskId, ownerSubject),
    );
  }

  // Cascade-stability stamp: record when a meeting's calendar time actually moved
  // (movedMeetingTaskIds is only populated on a real PATCH above, never on a no-op).
  // resolve-internal reads this to freeze a freshly-moved meeting for
  // MEETING_COMMIT_STABILITY_MINUTES. System column: owner-scoped, never PATCHable.
  for (const taskId of movedMeetingTaskIds) {
    writes.push(
      db
        .prepare("UPDATE tasks SET last_committed_move_at = ? WHERE id = ? AND owner_subject = ?")
        .bind(now, taskId, ownerSubject),
    );
  }

  // A committed plan that drops a task supersedes that task's previous placement:
  // reset it to the live backlog (status 'pending', stamp cleared). The status guard
  // keeps a task the user marked done/cancelled between resolve and commit from being
  // resurrected. See internal design notes.
  const droppedEntries = (plan.body.dropped ?? []) as Array<{ task_id: string }>;
  for (const d of droppedEntries) {
    writes.push(
      db
        .prepare(
          "UPDATE tasks SET status = 'pending', scheduled_for = NULL, updated_at = ? WHERE id = ? AND owner_subject = ? AND status IN ('pending', 'scheduled', 'committed')",
        )
        .bind(now, d.task_id, ownerSubject),
    );
  }

  // The commit-mark joins the SAME batch (LAST) so committed_at lands atomically with
  // the task updates: a mid-sequence failure leaves no half-committed rows and the
  // plan uncommitted, so a re-click converges (X3). Owner-scoped; a foreign or
  // already-gone plan updates 0 rows → 404 (same as a missing plan).
  writes.push(markProposedPlanCommittedStmt(db, planHash, now, ownerSubject));
  const results = await db.batch(writes);
  const markChanges = results[results.length - 1]!.meta.changes;
  if (markChanges === 0) return { status: 404, body: { error: "not_found" } };

  const committedTaskCount = scheduleTaskIds.filter((tid) => {
    const info = taskInfo.get(tid);
    return info != null && LIVE_STATUSES.has(info.status);
  }).length;
  return { status: 200, body: { plan_hash: planHash, committed: committedTaskCount } };
}

export function mountCommitRoute(
  v1: OpenAPIHono<{ Bindings: Env; Variables: AppVariables }>,
) {
  const commitRoute = createRoute({
    method: "post",
    path: "/commit",
    operationId: "commit",
    summary: "Commit a proposed plan to Google Calendar.",
    description: "Commit a proposed plan (by plan_hash) to Google Calendar, creating/updating the corresponding events. Irreversible from the API's perspective. Tasks listed as dropped in the plan are reset to status 'pending' with their placement stamp cleared, so they re-enter the backlog for future resolves. Schedule entries whose task is no longer live at commit time (deleted, done, or cancelled between resolve and commit) are skipped: no event is created and any existing event for that chunk is removed, releasing its slot. The 'committed' count reflects only the live tasks committed.",
    security: [{ BearerAuth: [] }],
    request: {
      body: { content: { "application/json": { schema: CommitBodySchema } }, required: true },
    },
    responses: {
      200: {
        content: { "application/json": { schema: CommitResponseSchema } },
        description: "Commit result",
      },
      400: {
        content: { "application/json": { schema: z.object({ error: z.string() }) } },
        description: "Validation error",
      },
      404: {
        content: { "application/json": { schema: z.object({ error: z.string() }) } },
        description: "Plan not found",
      },
      410: {
        content: { "application/json": { schema: z.object({ error: z.string() }) } },
        description: "Plan expired",
      },
      403: {
        content: { "application/json": { schema: z.object({ error: z.string() }) } },
        description: "Token carries no subject (no_subject)",
      },
    },
  });

  v1.openapi(commitRoute, async (c) => {
    const owner = await requireOwner(c);
    if (owner instanceof Response) return owner as any;
    const parsed = c.req.valid("json");
    const cal = c.var.calendarProvider ?? await defaultCalendarProvider(c.env, owner);
    const result = await commitPlan(c.env.DB, cal, parsed.plan_hash, owner, { createColorId: c.env.CREATE_COLOR_ID });
    return c.json(result.body as Record<string, unknown>, result.status as 200 | 400 | 404 | 410);
  });
}
