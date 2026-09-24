/** Durable per-chunk completion records. A row = "this chunk is done". The
 *  source of truth for completion; calendar color is only the trigger. See
 *  internal design notes. */

/** Shape of the SELECT projection used by the load helpers below. The projection
 *  intentionally excludes `owner_subject` (callers always scope by owner already)
 *  — do not back this with `SELECT *`. */
export interface ChunkCompletionRow {
  task_id: string;
  chunk_id: string;
  done_at: string;
  color_confirmed_at: string | null;
  source: "color" | "api";
  /** The calendar event whose color confirmed this completion. The revive-scan
   *  only honors an un-paint of THIS event; NULL (legacy / unconfirmed row)
   *  falls back to the any-event rule. */
  event_id: string | null;
}

/** Bound (but not yet run) INSERT statement for one completion. Keeps the SQL in
 *  this module while letting a caller collect many statements into a single
 *  `db.batch([...])` (the done-scan records N chunks per resolve). INSERT OR
 *  IGNORE keyed on (owner_subject, chunk_id): re-recording is a no-op. */
export function recordChunkCompletionStmt(
  db: D1Database,
  ownerSubject: string,
  taskId: string,
  chunkId: string,
  doneAt: string,
  source: "color" | "api",
  colorConfirmedAt: string | null,
  eventId: string | null = null,
): D1PreparedStatement {
  return db
    .prepare(
      "INSERT OR IGNORE INTO chunk_completions (owner_subject, task_id, chunk_id, done_at, color_confirmed_at, source, event_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(ownerSubject, taskId, chunkId, doneAt, colorConfirmedAt, source, eventId);
}

/** Bound (but not yet run) DELETE statement for one chunk's record (the revive /
 *  undo path), batchable like recordChunkCompletionStmt. */
export function deleteChunkCompletionStmt(
  db: D1Database,
  ownerSubject: string,
  chunkId: string,
): D1PreparedStatement {
  return db
    .prepare("DELETE FROM chunk_completions WHERE owner_subject = ? AND chunk_id = ?")
    .bind(ownerSubject, chunkId);
}

/** Insert a completion record. INSERT OR IGNORE keyed on (owner_subject,
 *  chunk_id): re-recording an already-completed chunk is a no-op, so the
 *  done-scan can run idempotently each resolve. */
export async function recordChunkCompletion(
  db: D1Database,
  ownerSubject: string,
  taskId: string,
  chunkId: string,
  doneAt: string,
  source: "color" | "api",
  colorConfirmedAt: string | null,
  eventId: string | null = null,
): Promise<void> {
  await recordChunkCompletionStmt(db, ownerSubject, taskId, chunkId, doneAt, source, colorConfirmedAt, eventId).run();
}

/** Delete one chunk's completion record (the revive / undo path). */
export async function deleteChunkCompletion(
  db: D1Database,
  ownerSubject: string,
  chunkId: string,
): Promise<void> {
  await deleteChunkCompletionStmt(db, ownerSubject, chunkId).run();
}

/** Bound (but not yet run) DELETE of every completion record for a task, so the
 *  PATCH handler can drop completions inside the same atomic db.batch as the task
 *  UPDATE (X7). Owner-scoped. */
export function deleteTaskCompletionsStmt(
  db: D1Database,
  ownerSubject: string,
  taskId: string,
): D1PreparedStatement {
  return db
    .prepare("DELETE FROM chunk_completions WHERE owner_subject = ? AND task_id = ?")
    .bind(ownerSubject, taskId);
}

/** Delete every completion record for a task (the API done→pending undo, and
 *  chunks-edit invalidation). */
export async function deleteTaskCompletions(
  db: D1Database,
  ownerSubject: string,
  taskId: string,
): Promise<void> {
  await db
    .prepare("DELETE FROM chunk_completions WHERE owner_subject = ? AND task_id = ?")
    .bind(ownerSubject, taskId)
    .run();
}

/** Full completion rows for the given tasks, grouped by task_id. Owner-scoped,
 *  de-dups ids, no DB round-trip on empty input. Used by the revive-scan (needs
 *  color_confirmed_at). */
export async function loadCompletionsByTask(
  db: D1Database,
  ownerSubject: string,
  taskIds: string[],
): Promise<Map<string, ChunkCompletionRow[]>> {
  const out = new Map<string, ChunkCompletionRow[]>();
  if (taskIds.length === 0) return out;
  const ids = [...new Set(taskIds)];
  const placeholders = ids.map(() => "?").join(", ");
  const r = await db
    .prepare(
      `SELECT task_id, chunk_id, done_at, color_confirmed_at, source, event_id FROM chunk_completions WHERE owner_subject = ? AND task_id IN (${placeholders})`,
    )
    .bind(ownerSubject, ...ids)
    .all<ChunkCompletionRow>();
  for (const row of r.results ?? []) {
    const list = out.get(row.task_id) ?? [];
    list.push(row);
    out.set(row.task_id, list);
  }
  return out;
}

/** Convenience over loadCompletionsByTask: just the completed chunk_id set per
 *  task. Used by build-problem (only needs which chunks to drop). */
export async function loadCompletedChunkIdsByTask(
  db: D1Database,
  ownerSubject: string,
  taskIds: string[],
): Promise<Map<string, Set<string>>> {
  const byTask = await loadCompletionsByTask(db, ownerSubject, taskIds);
  const out = new Map<string, Set<string>>();
  for (const [taskId, rows] of byTask) {
    out.set(taskId, new Set(rows.map((row) => row.chunk_id)));
  }
  return out;
}
