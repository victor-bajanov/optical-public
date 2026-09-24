import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Env } from "../env";
import type { CalendarProvider } from "../providers/calendar-provider";
import { TaskCreate, TaskPatch, TaskStatus } from "../schema/task";
import { TaskResponse } from "../schema/task-response";
import { D } from "../schema/descriptions";
import { putTaskRow, getTaskRow, listTasks, deleteRow, patchTaskRowStmt } from "../db/d1";
import { getDoneColorId } from "../db/users";
import { defaultCalendarProvider } from "../index-providers";
import { recolorTaskChunks } from "../planning/recolor-done";
import { deleteTaskChunks, SCHEDULER_HORIZON_MS } from "../planning/scheduler-chunks";
import { localWeekWindow } from "../planning/datetime";
import { recordChunkCompletionStmt, deleteTaskCompletions, deleteTaskCompletionsStmt } from "../db/chunk-completions";
import { chunkIdsOfTask } from "../planning/chunk-ids";

type Vars = { ownerSubject: string; calendarProvider?: CalendarProvider };

export const tasksApp = new OpenAPIHono<{ Bindings: Env; Variables: Vars }>();

// ── POST /tasks ────────────────────────────────────────────────────────────

const postTaskRoute = createRoute({
  method: "post",
  path: "/",
  operationId: "createTask",
  summary: "Create a new task in optical's planner.",
  description: "Create a task for the planner. The request body is the full constraint surface: timing (deadline, earliest_start, preferred_windows, pinned_at), shape (duration_minutes XOR chunks + group_policy), and relationships (dependencies, project_id). Returns the created task with its server-assigned id.",
  security: [{ BearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: TaskCreate } }, required: true },
  },
  responses: {
    201: {
      content: { "application/json": { schema: TaskResponse } },
      description: "Created task",
    },
    400: {
      content: {
        "application/json": {
          schema: z.object({ error: z.string(), issues: z.array(z.unknown()).optional() }),
        },
      },
      description: "Validation error",
    },
  },
});

tasksApp.openapi(postTaskRoute, async (c) => {
  const ownerSubject = c.get("ownerSubject") as string;
  const parsed = c.req.valid("json");
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const status = parsed.status ?? "pending";
  const body = { ...parsed, id, status, created_at: now, updated_at: now };
  await putTaskRow(c.env.DB, ownerSubject, {
    id,
    body,
    template_id: parsed.template_id ?? null,
    project_id: parsed.project_id ?? null,
    status,
    created_at: now,
    updated_at: now,
  });
  return c.json(body as z.infer<typeof TaskResponse>, 201);
});

// ── GET /tasks ─────────────────────────────────────────────────────────────

const ListQuery = z.object({
  status: TaskStatus.describe(D.taskList.status).optional(),
  project_id: z.string().uuid().describe(D.taskList.project_id).optional(),
  from: z.string().describe(D.taskList.from).optional(),
  to: z.string().describe(D.taskList.to).optional(),
});

const getTasksRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "listTasks",
  summary: "List tasks, optionally filtered by status / project / date range.",
  description: "List tasks, optionally filtered by status, project_id, or a date range. Returns an array of full task objects.",
  security: [{ BearerAuth: [] }],
  request: { query: ListQuery },
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ tasks: z.array(TaskResponse).describe(D.response.tasks) }) },
      },
      description: "List of tasks",
    },
  },
});

tasksApp.openapi(getTasksRoute, async (c) => {
  const ownerSubject = c.get("ownerSubject") as string;
  const q = c.req.valid("query");
  const rows = await listTasks<Record<string, unknown>>(c.env.DB, ownerSubject, q);
  return c.json({
    tasks: rows.map((r) => ({ ...r.body, id: r.id, status: r.status, created_at: r.created_at, updated_at: r.updated_at })) as z.infer<typeof TaskResponse>[],
  });
});

// ── GET /tasks/:id ─────────────────────────────────────────────────────────

const getTaskRoute = createRoute({
  method: "get",
  path: "/{id}",
  operationId: "getTask",
  summary: "Retrieve a single task by id.",
  description: "Retrieve a single task by id, including all constraints and current status.",
  security: [{ BearerAuth: [] }],
  responses: {
    200: {
      content: { "application/json": { schema: TaskResponse } },
      description: "Task",
    },
    404: {
      content: { "application/json": { schema: z.object({ error: z.string() }) } },
      description: "Not found",
    },
  },
});

tasksApp.openapi(getTaskRoute, async (c) => {
  const ownerSubject = c.get("ownerSubject") as string;
  const row = await getTaskRow(c.env.DB, ownerSubject, c.req.param("id"));
  if (!row) return c.json({ error: "not_found" }, 404) as any;
  return c.json({ ...(row.body as object), id: row.id, status: row.status, created_at: row.created_at, updated_at: row.updated_at } as z.infer<typeof TaskResponse>) as any;
});

// ── PATCH /tasks/:id ───────────────────────────────────────────────────────

const patchTaskRoute = createRoute({
  method: "patch",
  path: "/{id}",
  operationId: "updateTask",
  summary: "Update fields on an existing task.",
  description: "Patch fields on an existing task. Only provided fields change; the duration_minutes/chunks/group_policy invariant is re-checked on the merged result. A pending→done transition also best-effort recolors the task's scheduler calendar chunks to the done color (scanning 28 days back and forward of the current week), and each chunk's completion is color-confirmed only when its event was actually reached — so the un-done-by-color revive can only ever be triggered by repainting that exact verified event. Patching any timing field (pinned_at, earliest_start, preferred_windows, deadline — including setting one to null) clears the system placement stamp left by the last committed plan, so the task re-enters the backlog for the resolve window implied by its new constraints; this is the supported way to bring a dropped or past-week task forward (no delete-and-re-create needed).",
  security: [{ BearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: TaskPatch } }, required: true },
  },
  responses: {
    200: {
      content: { "application/json": { schema: TaskResponse } },
      description: "Updated task",
    },
    400: {
      content: {
        "application/json": {
          schema: z.object({ error: z.string(), issues: z.array(z.unknown()).optional() }),
        },
      },
      description: "Validation error",
    },
    404: {
      content: { "application/json": { schema: z.object({ error: z.string() }) } },
      description: "Not found",
    },
  },
});

tasksApp.openapi(patchTaskRoute, async (c) => {
  const ownerSubject = c.get("ownerSubject") as string;
  const id = c.req.param("id");
  const existing = await getTaskRow<Record<string, unknown>>(c.env.DB, ownerSubject, id);
  if (!existing) return c.json({ error: "not_found" }, 404) as any;
  const patch = c.req.valid("json");
  const { id: _id, created_at: _ca, updated_at: _ua, ...existingBody } = existing.body as Record<string, unknown>;
  const merged = { ...existingBody, ...patch };
  const reparsed = TaskCreate.safeParse(merged);
  if (!reparsed.success) return c.json({ error: "validation_failed", issues: reparsed.error.issues }, 400) as any;
  const now = new Date().toISOString();

  // Column is authoritative for status (D3). Only adopt a patched status; otherwise
  // keep the column's current value so PATCH never re-derives status from the
  // (possibly stale) body JSON and clobbers a concurrent commit/done flip (X7/L1).
  const statusPatched = "status" in patch;
  const status = statusPatched ? (reparsed.data.status as string) : existing.status;
  const next = { ...reparsed.data, id, status, created_at: existing.created_at, updated_at: now };

  const TIMING_KEYS = ["pinned_at", "earliest_start", "preferred_windows", "deadline"];
  const timingPatched = TIMING_KEYS.some((k) => k in patch);
  const chunksPatched = "chunks" in patch || "duration_minutes" in patch;
  const toDone = statusPatched && status === "done" && existing.status !== "done";
  const fromDone = statusPatched && existing.status === "done" && status !== "done";

  // Best-effort calendar recolor — Google I/O, cannot join a D1 batch. Runs BEFORE
  // the batch so color_confirmed_at reflects PER-CHUNK recolor coverage (DC2).
  // Records, not color, are the source of truth for done-ness. The scan reaches
  // 28 days back as well as forward: a task is often done-marked after its
  // chunk's week has elapsed (incident 2026-07-06), and a past-week event left
  // off the done color while its record claimed confirmation is exactly the
  // false-revival landmine.
  const weekStart = localWeekWindow(now, c.env.SCHEDULER_TZ).start;
  const scanStart = new Date(Date.parse(weekStart) - 28 * 24 * 3600 * 1000).toISOString();
  const scanEnd = new Date(Date.parse(weekStart) + 28 * 24 * 3600 * 1000).toISOString();
  // chunk_id → confirming event id, populated only for chunks whose event the
  // recolor actually SAW (repainted or already done-colored). A chunk outside
  // the scan, or with no event at all, stays unconfirmed — the revive-scan then
  // can never mistake its stale color for a user un-paint.
  let confirmedEvents = new Map<string, string>();
  if (toDone) {
    try {
      const cal = c.var.calendarProvider ?? await defaultCalendarProvider(c.env, ownerSubject);
      // Provider-shaped floor under users.done_color_id, above env.DONE_COLOR_ID
      // (Card H) — a NULL row on a Microsoft-provider subject must resolve to
      // "Optical Done", not Google's numeric env default.
      const doneColorId = await getDoneColorId(c.env.DB, ownerSubject, cal.defaultDoneColorId ?? c.env.DONE_COLOR_ID ?? "");
      confirmedEvents = (await recolorTaskChunks(cal, id, doneColorId, scanStart, scanEnd)).seenEvents;
    } catch (err) {
      console.warn(`done-recolor failed for task ${id}: ${String(err)}`);
    }
  } else if (fromDone) {
    try {
      const cal = c.var.calendarProvider ?? await defaultCalendarProvider(c.env, ownerSubject);
      // ?? (not ||): a provider's undoneColorId can legitimately be "" (Microsoft
      // category clear), which must survive the fallback to CREATE_COLOR_ID.
      const createColorId = cal.undoneColorId ?? c.env.CREATE_COLOR_ID ?? "5";
      await recolorTaskChunks(cal, id, createColorId, scanStart, scanEnd);
    } catch (err) {
      console.warn(`undo-recolor failed for task ${id}: ${String(err)}`);
    }
  }

  // One atomic batch: the touched-surfaces task UPDATE + completion-record writes.
  // body/updated_at always; status/template_id/project_id only when patched; clear
  // scheduled_for in the SAME statement on a timing edit (X7 — closes L1/L2/L10).
  const stmts: D1PreparedStatement[] = [
    patchTaskRowStmt(c.env.DB, ownerSubject, id, {
      body: next,
      updatedAt: now,
      ...(statusPatched ? { status } : {}),
      ...("template_id" in patch ? { templateId: reparsed.data.template_id ?? null } : {}),
      ...("project_id" in patch ? { projectId: reparsed.data.project_id ?? null } : {}),
      clearScheduledFor: timingPatched,
    }),
  ];
  // A chunks/duration edit re-defines chunk identity, and a done→non-done undo must
  // clear stale completion records (DC1) — both drop every record for the task.
  if (chunksPatched || fromDone) {
    stmts.push(deleteTaskCompletionsStmt(c.env.DB, ownerSubject, id));
  }
  // non-done→done: record a completion for every chunk. color_confirmed_at is
  // set PER CHUNK, only when the recolor actually saw that chunk's event, and
  // the confirming event id is stamped alongside — so neither a failed recolor
  // nor an unreachable/absent event is ever read as a user un-paint by the
  // revive-scan, and only that exact event's repaint can revive it (DC2).
  if (toDone) {
    for (const chunkId of chunkIdsOfTask(next as any)) {
      const eventId = confirmedEvents.get(chunkId) ?? null;
      stmts.push(recordChunkCompletionStmt(c.env.DB, ownerSubject, id, chunkId, now, "api", eventId ? now : null, eventId));
    }
  }
  await c.env.DB.batch(stmts);

  return c.json(next as z.infer<typeof TaskResponse>);
});

// ── DELETE /tasks/:id ──────────────────────────────────────────────────────

const deleteTaskRoute = createRoute({
  method: "delete",
  path: "/{id}",
  operationId: "deleteTask",
  summary: "Delete a task by id.",
  description:
    "Delete a task by id. Returns 204 on success, 404 if it does not exist. " +
    "Deleting a materialised recurring instance (one created from a template) is " +
    "treated as a permanent skip of that occurrence (RFC-5545 EXDATE): the row is " +
    "removed and the occurrence is never re-created by a future sweep. There is no " +
    "API to un-skip an occurrence; recreate the task manually to restore it.",
  security: [{ BearerAuth: [] }],
  responses: {
    204: { description: "Deleted" },
    404: {
      content: { "application/json": { schema: z.object({ error: z.string() }) } },
      description: "Not found",
    },
  },
});

tasksApp.openapi(deleteTaskRoute, async (c) => {
  const ownerSubject = c.get("ownerSubject") as string;
  const id = c.req.param("id");
  const existing = await getTaskRow<Record<string, unknown>>(c.env.DB, ownerSubject, id);
  if (!existing) return c.json({ error: "not_found" }, 404);

  // X1: best-effort cleanup of the task's scheduler chunk events before the row
  // is removed. There is no later commit reconcile for a deleted task, so any
  // chunk left on the calendar orphans permanently and the next resolve places
  // other work over it. Best-effort: a Calendar error must never block the
  // delete (same contract as the offboard sweep / done-recolor). Calendar first,
  // while the task context is still present; D1 delete below.
  try {
    const now = new Date().toISOString();
    const horizonEnd = new Date(Date.now() + SCHEDULER_HORIZON_MS).toISOString();
    const cal = c.var.calendarProvider ?? await defaultCalendarProvider(c.env, ownerSubject);
    await deleteTaskChunks(cal, id, now, horizonEnd);
  } catch (err) {
    console.warn(`DELETE task ${id}: scheduler-chunk cleanup failed (continuing): ${String(err)}`);
  }

  // For a materialised recurring instance, deletion is an RFC-5545 EXDATE "skip":
  // hard-delete the row AND record the occurrence so the sweep never re-creates it.
  // Atomic batch so we never delete without recording (or vice versa). RC2.
  if (existing.template_id && existing.occurrence_date) {
    const now = new Date().toISOString();
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM tasks WHERE id = ? AND owner_subject = ?").bind(id, ownerSubject),
      c.env.DB
        .prepare("INSERT OR IGNORE INTO template_exclusions (owner_subject, template_id, occurrence_date, created_at) VALUES (?, ?, ?, ?)")
        .bind(ownerSubject, existing.template_id, existing.occurrence_date, now),
      c.env.DB.prepare("DELETE FROM chunk_completions WHERE owner_subject = ? AND task_id = ?").bind(ownerSubject, id),
    ]);
    return c.body(null, 204);
  }

  // Template instance with no occurrence_date should not exist post-backfill;
  // there is no key to exclude on, so hard-delete and warn.
  if (existing.template_id && !existing.occurrence_date) {
    console.warn(`DELETE task ${id}: template instance missing occurrence_date — deleting without EXDATE`);
  }

  await deleteRow(c.env.DB, ownerSubject, "tasks", id);
  await deleteTaskCompletions(c.env.DB, ownerSubject, id);
  return c.body(null, 204);
});
