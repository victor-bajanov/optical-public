import type { CalendarProvider } from "../providers/calendar-provider";
import type { CalendarEvent } from "../providers/types";
import { OPTICAL_DEPLOYMENT_KEY, SCHEDULER_CHUNK_ID_KEY } from "../providers/types";
import { getExistingTaskIds } from "../db/tasks";

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

type Tagged = Pick<CalendarEvent, "extendedProperties">;
const chunkIdOf = (e: Tagged) => e.extendedProperties?.private?.[SCHEDULER_CHUNK_ID_KEY];
/** Unstamped: created before stamping, so it may equally be another
 *  deployment's (providers/deployment-scope.ts). */
const isLegacyChunk = (e: Tagged) =>
  chunkIdOf(e) !== undefined && e.extendedProperties?.private?.[OPTICAL_DEPLOYMENT_KEY] === undefined;

/** The legacy chunks among `events` this deployment can PROVE are its own: the
 *  task UUID in the chunk id is a tasks row of this D1 for the subject (UUIDs
 *  never collide across deployments). One batched D1 read. */
async function provenLegacy<T extends Tagged>(db: D1Database, ownerSubject: string, events: T[]): Promise<Set<T>> {
  const legacy = events.filter(isLegacyChunk);
  const ours = await getExistingTaskIds(db, ownerSubject, legacy.map((e) => taskIdOfChunk(chunkIdOf(e)!)));
  return new Set(legacy.filter((e) => ours.has(taskIdOfChunk(chunkIdOf(e)!))));
}

/** Of `chunks` (events carrying a scheduler chunk id), the ones this
 *  deployment may delete on its own say-so, with no plan entry proving them:
 *  a STAMPED chunk (another deployment's never gets here — the provider strips
 *  its tag on read), and an UNSTAMPED legacy chunk only when it is proven ours
 *  (provenLegacy). Used by commit's delete loop and the offboard sweep. */
export async function deletableChunks<T extends Tagged>(db: D1Database, ownerSubject: string, chunks: T[]): Promise<T[]> {
  const proven = await provenLegacy(db, ownerSubject, chunks);
  return chunks.filter((e) => !isLegacyChunk(e) || proven.has(e));
}

/** `events` with every UNPROVEN legacy chunk turned into an ordinary external
 *  event (its chunk tag dropped), exactly as a foreign-stamped chunk already
 *  arrives from the provider. runResolve applies it to its window read, so
 *  such a chunk is busy time for the solver and never enters the diff baseline
 *  (priorEvents), the churn fallback or the done-scan. Without it the diff
 *  would report the chunk "removed" on every replan, and since commit won't
 *  delete it (deletableChunks), no accept could ever clear that email. */
export async function externaliseUnprovenChunks(
  db: D1Database,
  ownerSubject: string,
  events: CalendarEvent[],
): Promise<CalendarEvent[]> {
  const proven = await provenLegacy(db, ownerSubject, events);
  return events.map((e) => {
    if (!isLegacyChunk(e) || proven.has(e)) return e;
    const { [SCHEDULER_CHUNK_ID_KEY]: _dropped, ...rest } = e.extendedProperties.private!;
    return { ...e, extendedProperties: { ...e.extendedProperties, private: rest } };
  });
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
