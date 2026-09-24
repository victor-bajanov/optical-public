import type { CalendarProvider } from "../providers/calendar-provider";
import { SCHEDULER_CHUNK_ID_KEY } from "../providers/types";
import { schedulerChunkEventsForTask } from "./scheduler-chunks";

export interface RecolorOutcome {
  /** Events actually repainted (excludes ones already the target color). */
  recolored: number;
  /** chunk_id → event id for every chunk event of the task FOUND in the scan
   *  window — repainted or already the target color. Only these chunks may be
   *  stamped color-confirmed by the caller: a chunk absent from this map was
   *  never verified against the calendar (its event lies beyond the scan, or
   *  has no event at all), and treating it as confirmed is what armed the
   *  2026-07-06 false-revival incident. When one chunk id maps to several
   *  events (a duplicate), the first seen wins. */
  seenEvents: Map<string, string>;
}

/**
 * Recolor every in-window scheduler chunk belonging to `taskId` to
 * `targetColorId`. Used in both directions (done color / create color).
 * Best-effort: a Calendar failure must not fail the originating request. The
 * scan window is bounded; a chunk beyond it is not recolored here — and is
 * therefore absent from `seenEvents`, so the caller must not claim its color
 * was confirmed.
 */
export async function recolorTaskChunks(
  cal: CalendarProvider,
  taskId: string,
  targetColorId: string,
  windowStart: string,
  windowEnd: string,
): Promise<RecolorOutcome> {
  const events = await schedulerChunkEventsForTask(cal, taskId, windowStart, windowEnd);
  const seenEvents = new Map<string, string>();
  let recolored = 0;
  for (const e of events) {
    const chunkId = e.extendedProperties?.private?.[SCHEDULER_CHUNK_ID_KEY];
    if (chunkId && !seenEvents.has(chunkId)) seenEvents.set(chunkId, e.id);
    if (e.colorId === targetColorId) continue; // already that color: seen, no repaint
    await cal.updateEvent(e.id, { colorId: targetColorId });
    recolored++;
  }
  return { recolored, seenEvents };
}
