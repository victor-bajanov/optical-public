import type { CalendarProvider } from "../providers/calendar-provider";
import type { CalendarEvent } from "../providers/types";
import { OPTICAL_MEETING_TASK_ID_KEY } from "../providers/types";
import { isOwnedMovableMeeting, MEETING_SOURCE_KIND } from "./identify";

interface SyncOpts {
  churnMultiplierCap: number; // reserved for future per-row stamping; not stored today
}

function durationMinutes(e: CalendarEvent): number {
  return Math.max(15, Math.round((Date.parse(e.end) - Date.parse(e.start)) / 60_000));
}

interface MeetingRow {
  id: string;
  body: string;
  status: string;
}

/** Reconcile owned movable meetings in `events` against the tasks table.
 *  Runs BEFORE loadPendingTasks (like runRecurrenceSweep) so freshly-imported
 *  meetings are placed the same resolve. Idempotent. Feature-flag gating is the
 *  caller's responsibility (only call when meetingConfig.enabled). */
export async function syncOwnedMeetings(
  db: D1Database,
  cal: CalendarProvider,
  ownerSubject: string,
  events: CalendarEvent[],
  windowStartMs: number,
  windowEndMs: number,
  _opts: SyncOpts,
): Promise<void> {
  const owned = events.filter(isOwnedMovableMeeting);

  // Existing meeting rows for this owner, indexed by external event id.
  const { results } = await db
    .prepare(
      "SELECT id, body, status FROM tasks WHERE owner_subject = ? AND json_extract(body, '$.source.kind') = ?",
    )
    .bind(ownerSubject, MEETING_SOURCE_KIND)
    .all<MeetingRow>();
  const rowByEventId = new Map<string, MeetingRow & { eventId: string }>();
  for (const r of results) {
    const body = JSON.parse(r.body) as { source?: { external_id?: string } };
    const eventId = body.source?.external_id;
    if (eventId) rowByEventId.set(eventId, { ...r, eventId });
  }

  const now = new Date().toISOString();
  const seenEventIds = new Set<string>();

  for (const e of owned) {
    seenEventIds.add(e.id);
    const tagged = e.extendedProperties?.private?.[OPTICAL_MEETING_TASK_ID_KEY];
    const existing = rowByEventId.get(e.id);

    if (existing) {
      // Refresh title/duration/start from the live event; preserve user-set
      // priority/pin/must_include/status.
      const body = JSON.parse(existing.body) as Record<string, unknown>;
      const changed =
        body.title !== e.summary ||
        body.duration_minutes !== durationMinutes(e) ||
        body.earliest_start !== e.start;
      if (changed) {
        body.title = e.summary;
        body.duration_minutes = durationMinutes(e);
        body.earliest_start = e.start; // live meeting-time MARKER only; build-problem floors the wire earliest_start at now+min-notice so the meeting can still move earlier
        body.updated_at = now;
        await db
          .prepare("UPDATE tasks SET body = ?, updated_at = ? WHERE id = ? AND owner_subject = ?")
          .bind(JSON.stringify(body), now, existing.id, ownerSubject)
          .run();
      }
      continue;
    }

    // New owned meeting → create a row, then tag the event so a future sync
    // recognises it. (If the event already carries a tag but we have no row —
    // e.g. a row was deleted — we still create a fresh row and re-tag.)
    void tagged;
    const taskId = crypto.randomUUID();
    const body = {
      id: taskId,
      title: e.summary,
      context: "meeting" as const,
      priority: 100,
      duration_minutes: durationMinutes(e),
      must_include: true,
      earliest_start: e.start,
      source: { kind: MEETING_SOURCE_KIND, external_id: e.id },
      status: "pending" as const,
      created_at: now,
      updated_at: now,
    };
    await db
      .prepare(
        "INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      )
      .bind(taskId, ownerSubject, JSON.stringify(body), "pending", now, now)
      .run();
    // Tag the event (merge into private extended properties). Best-effort: a
    // failure here just means the next sync re-imports — guard against dupes by
    // the source.external_id row lookup above, so re-import is a no-op.
    try {
      await cal.updateEvent(e.id, {
        extendedProperties: { private: { [OPTICAL_MEETING_TASK_ID_KEY]: taskId } },
      });
    } catch {
      // swallow — idempotent on next run
    }
  }

  // Cancellation: a meeting row whose meeting time is inside THIS window but
  // whose event is absent from the fetched owned set was deleted/cancelled.
  // Window-scoped so meetings in other weeks are never touched.
  for (const [eventId, row] of rowByEventId) {
    if (seenEventIds.has(eventId)) continue;
    if (row.status === "cancelled") continue;
    const body = JSON.parse(row.body) as { earliest_start?: string };
    const startMs = body.earliest_start ? Date.parse(body.earliest_start) : NaN;
    if (Number.isFinite(startMs) && startMs >= windowStartMs && startMs < windowEndMs) {
      await db
        .prepare(
          "UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ? AND owner_subject = ?",
        )
        .bind(now, row.id, ownerSubject)
        .run();
    }
  }
}
