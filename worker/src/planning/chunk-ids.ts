import type { Task } from "../types/task";

/** The full set of chunk ids a task owns, matching build-problem.ts's
 *  assignment: `<id>#<index>` per explicit chunk, or a single `<id>#0` for an
 *  atomic (duration_minutes) task. The single place this rule lives. */
export function chunkIdsOfTask(task: Pick<Task, "id" | "chunks">): string[] {
  if (task.chunks && task.chunks.length > 0) {
    return task.chunks.map((_c, i) => `${task.id}#${i}`);
  }
  return [`${task.id}#0`];
}
