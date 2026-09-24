// Typed default-deny repository for the owned tables (tasks, task_templates,
// projects). EVERY helper requires an ownerSubject and fails closed on an empty
// one, so an unscoped call is impossible to write and any caller that forgets
// the owner is a compile error. Owner is enforced in SQL, not in the handler.

export function requireOwner(ownerSubject: string): string {
  if (!ownerSubject) throw new Error("owner_scope_missing");
  return ownerSubject;
}

export async function putJsonRow(
  db: D1Database, ownerSubject: string, table: string, id: string, body: unknown,
): Promise<void> {
  const owner = requireOwner(ownerSubject);
  // Owner-guarded upsert: a colliding id owned by someone else updates 0 rows
  // (the WHERE fails), so this can neither overwrite nor leak across owners.
  await db
    .prepare(
      `INSERT INTO ${table} (id, owner_subject, body) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET body = excluded.body
       WHERE ${table}.owner_subject = excluded.owner_subject`,
    )
    .bind(id, owner, JSON.stringify(body))
    .run();
}

export async function getJsonRow<T>(
  db: D1Database, ownerSubject: string, table: string, id: string,
): Promise<T | null> {
  const owner = requireOwner(ownerSubject);
  const row = await db
    .prepare(`SELECT body FROM ${table} WHERE id = ? AND owner_subject = ?`)
    .bind(id, owner)
    .first<{ body: string }>();
  return row ? (JSON.parse(row.body) as T) : null;
}

export async function deleteRow(
  db: D1Database, ownerSubject: string, table: string, id: string,
): Promise<void> {
  const owner = requireOwner(ownerSubject);
  await db.prepare(`DELETE FROM ${table} WHERE id = ? AND owner_subject = ?`).bind(id, owner).run();
}

export async function listJsonRows<T>(
  db: D1Database, ownerSubject: string, table: string,
): Promise<Array<{ id: string; body: T }>> {
  const owner = requireOwner(ownerSubject);
  const rs = await db
    .prepare(`SELECT id, body FROM ${table} WHERE owner_subject = ?`)
    .bind(owner)
    .all<{ id: string; body: string }>();
  return rs.results.map((r) => ({ id: r.id, body: JSON.parse(r.body) as T }));
}

export interface TaskRow<TBody> {
  id: string;
  body: TBody;
  template_id: string | null;
  occurrence_date?: string | null;
  project_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export async function putTaskRow<TBody>(
  db: D1Database, ownerSubject: string, row: TaskRow<TBody>,
): Promise<void> {
  const owner = requireOwner(ownerSubject);
  // Owner-guarded upsert: a colliding id owned by someone else updates 0 rows
  // (the WHERE fails), so this can neither overwrite nor leak across owners.
  await db
    .prepare(
      `INSERT INTO tasks (id, owner_subject, body, template_id, project_id, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         body=excluded.body,
         template_id=excluded.template_id,
         project_id=excluded.project_id,
         status=excluded.status,
         updated_at=excluded.updated_at
       WHERE tasks.owner_subject = excluded.owner_subject`,
    )
    .bind(
      row.id, owner, JSON.stringify(row.body), row.template_id, row.project_id,
      row.status, row.created_at, row.updated_at,
    )
    .run();
}

/**
 * Null the system-owned `scheduled_for` stamp. The stamp means "the last
 * committed plan placed this task here"; callers invoke this when a user edit
 * to the placement surface makes that claim stale. putTaskRow deliberately
 * never touches the column — this is the only writer besides commitPlan. See
 * internal design notes.
 */
export async function clearScheduledFor(
  db: D1Database, ownerSubject: string, id: string,
): Promise<void> {
  const owner = requireOwner(ownerSubject);
  await db
    .prepare("UPDATE tasks SET scheduled_for = NULL WHERE id = ? AND owner_subject = ?")
    .bind(id, owner)
    .run();
}

/**
 * Re-stamp `scheduled_for` (and touch `updated_at`) for a live task — used by
 * the webhook manual-move write-back so the task row follows a hand-dragged
 * chunk. Same status guard as the commit drop-reset: done/cancelled rows are
 * never resurrected or modified. See
 * internal design notes (rider).
 */
export async function restampScheduledFor(
  db: D1Database, ownerSubject: string, id: string, scheduledFor: string, now: string,
): Promise<void> {
  await restampScheduledForStmt(db, ownerSubject, id, scheduledFor, now).run();
}

/** Bound (but not yet run) re-stamp UPDATE for one task. Lets the webhook
 *  manual-move write-back collect this together with the committed-plan body
 *  patch into a single atomic `db.batch([...])`, so a re-stamp failure rolls the
 *  body patch back too instead of leaving the plan ahead of the row (X4). */
export function restampScheduledForStmt(
  db: D1Database, ownerSubject: string, id: string, scheduledFor: string, now: string,
): D1PreparedStatement {
  const owner = requireOwner(ownerSubject);
  return db
    .prepare(
      "UPDATE tasks SET scheduled_for = ?, updated_at = ? WHERE id = ? AND owner_subject = ? AND status IN ('pending', 'scheduled', 'committed')",
    )
    .bind(scheduledFor, now, id, owner);
}

/** Bound (but not yet run) manual-move UPDATE: re-stamps `scheduled_for`, touches
 *  `updated_at`, AND rewrites `body` (for constraint reconciliation — earliest_start
 *  lowered / pinned_at moved) in one guarded statement. Lets the webhook write-back
 *  batch every moved-task write atomically with the committed-plan body patches
 *  (X4/X5). Same status guard as restampScheduledForStmt: done/cancelled rows are
 *  never resurrected or modified. The body is passed through unchanged when there is
 *  no constraint patch — one statement, no branching. See
 *  internal design notes. */
export function applyManualMoveStmt<TBody>(
  db: D1Database, ownerSubject: string, id: string, scheduledFor: string, body: TBody, now: string,
): D1PreparedStatement {
  const owner = requireOwner(ownerSubject);
  return db
    .prepare(
      "UPDATE tasks SET scheduled_for = ?, updated_at = ?, body = ? WHERE id = ? AND owner_subject = ? AND status IN ('pending', 'scheduled', 'committed')",
    )
    .bind(scheduledFor, now, JSON.stringify(body), id, owner);
}

/** Bound (but not yet run) touched-surfaces UPDATE for the PATCH handler. Always
 *  writes `body` and `updated_at`; writes `status` / `template_id` / `project_id`
 *  ONLY when that field is supplied, so a concurrent system flip on an un-patched
 *  column survives (X7/L1 — PATCH must not re-derive un-touched columns from a stale
 *  read). Optionally clears `scheduled_for` in the SAME statement (a timing edit
 *  invalidates the stamp — no separate clearScheduledFor write, closing L2/L10). The
 *  row is known to exist (PATCH reads it first), so a plain UPDATE, not an upsert.
 *  Owner-guarded in SQL. See
 *  internal design notes. */
export function patchTaskRowStmt<TBody>(
  db: D1Database,
  ownerSubject: string,
  id: string,
  fields: {
    body: TBody;
    updatedAt: string;
    status?: string;
    templateId?: string | null;
    projectId?: string | null;
    clearScheduledFor?: boolean;
  },
): D1PreparedStatement {
  const owner = requireOwner(ownerSubject);
  const sets: string[] = ["body = ?", "updated_at = ?"];
  const binds: unknown[] = [JSON.stringify(fields.body), fields.updatedAt];
  if (fields.status !== undefined) { sets.push("status = ?"); binds.push(fields.status); }
  if ("templateId" in fields) { sets.push("template_id = ?"); binds.push(fields.templateId ?? null); }
  if ("projectId" in fields) { sets.push("project_id = ?"); binds.push(fields.projectId ?? null); }
  if (fields.clearScheduledFor) { sets.push("scheduled_for = NULL"); }
  return db
    .prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ? AND owner_subject = ?`)
    .bind(...binds, id, owner);
}

export async function getTaskRow<TBody>(
  db: D1Database, ownerSubject: string, id: string,
): Promise<TaskRow<TBody> | null> {
  const owner = requireOwner(ownerSubject);
  const r = await db
    .prepare(
      `SELECT id, body, template_id, occurrence_date, project_id, status, created_at, updated_at
       FROM tasks WHERE id = ? AND owner_subject = ?`,
    )
    .bind(id, owner)
    .first<{
      id: string; body: string; template_id: string | null; occurrence_date: string | null;
      project_id: string | null; status: string; created_at: string; updated_at: string;
    }>();
  if (!r) return null;
  return { ...r, body: JSON.parse(r.body) as TBody };
}

export interface TaskQuery {
  status?: string;
  project_id?: string;
  from?: string; // updated_at >= from
  to?: string;   // updated_at <= to
}

export async function listTasks<TBody>(
  db: D1Database, ownerSubject: string, q: TaskQuery,
): Promise<Array<TaskRow<TBody>>> {
  const owner = requireOwner(ownerSubject);
  const where: string[] = ["owner_subject = ?"];
  const binds: unknown[] = [owner];
  if (q.status) { where.push("status = ?"); binds.push(q.status); }
  if (q.project_id) { where.push("project_id = ?"); binds.push(q.project_id); }
  if (q.from) { where.push("updated_at >= ?"); binds.push(q.from); }
  if (q.to) { where.push("updated_at <= ?"); binds.push(q.to); }
  const sql = `SELECT id, body, template_id, project_id, status, created_at, updated_at
    FROM tasks WHERE ${where.join(" AND ")} ORDER BY created_at DESC`;
  const rs = await db.prepare(sql).bind(...binds).all<{
    id: string; body: string; template_id: string | null; project_id: string | null;
    status: string; created_at: string; updated_at: string;
  }>();
  return rs.results.map((r) => ({ ...r, body: JSON.parse(r.body) as TBody }));
}
