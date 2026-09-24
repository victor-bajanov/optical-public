import type { Task } from "../types/task";

/** Of the given task ids, the subset whose row is status='done' for this owner.
 *  Owner-scoped, de-dups ids. Empty input → empty Set with no DB round-trip. */
export async function getDoneTaskIds(
  db: D1Database,
  ownerSubject: string,
  taskIds: string[],
): Promise<Set<string>> {
  if (taskIds.length === 0) return new Set();
  const ids = [...new Set(taskIds)];
  const placeholders = ids.map(() => "?").join(", ");
  const r = await db
    .prepare(
      `SELECT id FROM tasks WHERE owner_subject = ? AND status = 'done' AND id IN (${placeholders})`,
    )
    .bind(ownerSubject, ...ids)
    .all<{ id: string }>();
  return new Set((r.results ?? []).map((row) => row.id));
}

/** Load specific task bodies by id for this owner, with NO status filter (we
 *  need to load tasks that are currently 'done'). Owner-scoped, de-dups ids.
 *  Empty input → []. Mirrors loadPendingTasks's row→Task merge: spread the
 *  parsed body, then overwrite id/created_at/updated_at from the columns. */
export async function loadTasksByIds(
  db: D1Database,
  ownerSubject: string,
  taskIds: string[],
): Promise<Task[]> {
  if (taskIds.length === 0) return [];
  const ids = [...new Set(taskIds)];
  const placeholders = ids.map(() => "?").join(", ");
  const r = await db
    .prepare(
      `SELECT id, body, created_at, updated_at FROM tasks WHERE owner_subject = ? AND id IN (${placeholders})`,
    )
    .bind(ownerSubject, ...ids)
    .all<{ id: string; body: string; created_at: string; updated_at: string }>();
  return (r.results ?? []).map((row) => ({
    ...(JSON.parse(row.body) as Task),
    id: row.id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

/** Ids of the owner's pinned tasks. A pinned task's calendar chunks occupy real
 *  committed time, so surfaces that publish or offer availability (the busy ICS
 *  feed, the booking page) must treat them as busy — unlike movable chunks,
 *  which are flexible time the planner will move. */
export async function loadPinnedTaskIds(db: D1Database, owner: string): Promise<Set<string>> {
  const r = await db
    .prepare(
      "SELECT id FROM tasks WHERE owner_subject = ? AND json_extract(body, '$.pinned_at') IS NOT NULL",
    )
    .bind(owner)
    .all<{ id: string }>();
  return new Set((r.results ?? []).map((row) => row.id));
}
