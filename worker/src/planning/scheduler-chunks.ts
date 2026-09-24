import type { CalendarProvider } from "../providers/calendar-provider";
import type { CalendarEvent } from "../providers/types";
import { SCHEDULER_CHUNK_ID_KEY } from "../providers/types";

/** Furthest a single /resolve could place a chunk — mirrors offboard's sweep
 *  horizon (lifecycle/offboard.ts). A committed task can own chunks anywhere in
 *  this forward window, and there is no later reconcile to clean them. */
export const SCHEDULER_HORIZON_MS = 366 * 24 * 60 * 60 * 1000;

/** Extract a chunk's task_id from its scheduler chunk id: everything before the
 *  last '#', or the whole id when there is none. */
export function taskIdOfChunk(chunkId: string): string {
  const hash = chunkId.lastIndexOf("#");
  return hash === -1 ? chunkId : chunkId.slice(0, hash);
}

/** Every in-window scheduler chunk event belonging to `taskId`. Events with no
 *  scheduler_chunk_id (external/user events) or another task's id are excluded. */
export async function schedulerChunkEventsForTask(
  cal: CalendarProvider,
  taskId: string,
  windowStart: string,
  windowEnd: string,
): Promise<CalendarEvent[]> {
  const { events } = await cal.fetchEventsInWindow(windowStart, windowEnd, { syncToken: false });
  return events.filter((e) => {
    const chunkId = e.extendedProperties?.private?.[SCHEDULER_CHUNK_ID_KEY];
    return chunkId != null && taskIdOfChunk(chunkId) === taskId;
  });
}

/** Delete every in-window scheduler chunk belonging to `taskId`. Returns the
 *  number deleted. Callers invoke best-effort: a Calendar error must not fail
 *  the originating request. */
export async function deleteTaskChunks(
  cal: CalendarProvider,
  taskId: string,
  windowStart: string,
  windowEnd: string,
): Promise<number> {
  const events = await schedulerChunkEventsForTask(cal, taskId, windowStart, windowEnd);
  for (const e of events) await cal.deleteEvent(e.id);
  return events.length;
}
