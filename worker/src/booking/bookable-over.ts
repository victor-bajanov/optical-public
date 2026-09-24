import type { CalendarEvent } from "../providers/types";
import { isOwnedMovableMeeting, MEETING_SOURCE_KIND } from "../meetings/identify";
import { isMovableVerdictUsable } from "../meetings/movable-verdict";

export interface BookableOverOptions {
  /** The per-user bookable_over_movable_meetings flag. */
  enabled: boolean;
  minNoticeMinutes: number;
  now: Date;
}

/** resolve-internal.ts freezes an owned meeting as `imminent_notice` at
 *  exactly `start >= now + MEETING_MIN_NOTICE_MINUTES`. Offering a slot right
 *  at that boundary would let it be claimed and then, minutes later, fall
 *  inside the notice window before the webhook-triggered follow-up resolve
 *  runs — freezing a meeting that already has a confirmed booking on top of
 *  it. This headroom keeps the follow-up resolve outside the notice window
 *  when it runs; 60 minutes covers webhook + resolve latency with margin. */
export const RESOLVE_HEADROOM_MINUTES = 60;

/** json_extract of an object returns its JSON text; a corrupt body must read as
 *  "no verdict", never throw the availability request. */
function parseVerdict(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Event ids whose time may be OFFERED to a booker even though a meeting sits
 *  there, because Optical can relocate that meeting.
 *
 *  All conditions matter:
 *   - isOwnedMovableMeeting: the user organises it and someone else attends.
 *   - a task row exists carrying a FRESH, positive movable_verdict: the last
 *     resolve actually promoted this meeting to the solver as movable. A
 *     meeting frozen upstream — unreadable attendee free/busy, inside the
 *     notice window, held by commit-stability — is stamped ok:false and
 *     excluded, because promising a reschedule Optical will never perform
 *     double-books the calendar permanently. A row with NO verdict (never
 *     resolved, or resolved before this field existed) is excluded for the
 *     same reason: absence is not permission. `opts.enabled` itself is gated
 *     on OWNED_MEETINGS_ENABLED by the caller — while that env flag is off,
 *     resolves stop maintaining these rows at all, so a lingering fresh
 *     ok:true verdict must not be trusted either; see the caller for that gate.
 *   - the row is UNPINNED and not in a terminal status: a pin is user intent to
 *     hold the meeting where it is, and a done/cancelled row has left the
 *     planner's solver set — both are newer information than the verdict, so
 *     they are checked live rather than inferred from it.
 *   - it starts beyond the meeting notice window PLUS RESOLVE_HEADROOM_MINUTES:
 *     inside the notice window, no move is allowed, and the headroom keeps a
 *     claimed slot from falling into that window before the next resolve runs.
 *   - it has no confirmed booking of its own: otherwise a second booker could
 *     take a slot the first booker already holds. */
export async function resolveBookableOverIds(
  db: D1Database,
  owner: string,
  events: CalendarEvent[],
  opts: BookableOverOptions,
): Promise<Set<string>> {
  if (!opts.enabled) return new Set();

  const noticeFloorMs =
    opts.now.getTime() + (opts.minNoticeMinutes + RESOLVE_HEADROOM_MINUTES) * 60_000;
  const candidates = events.filter(
    (e) => isOwnedMovableMeeting(e) && Date.parse(e.start) >= noticeFloorMs,
  );
  if (candidates.length === 0) return new Set();

  // The verdict is fetched whole (not filtered in SQL) so freshness is judged by
  // Date.parse rather than a lexicographic compare that a non-canonical
  // timestamp would silently get wrong.
  //
  // Terminal rows are excluded on the `status` COLUMN, which is authoritative
  // (the body's copy can be stale — see the PATCH handler's D3 note). A done or
  // cancelled meeting task has dropped out of the resolve's solver set, so it is
  // no longer re-stamped and its last ok:true verdict would otherwise linger
  // until it aged out.
  const movable = await db
    .prepare(
      `SELECT json_extract(body, '$.source.external_id') AS event_id,
              json_extract(body, '$.movable_verdict') AS verdict
         FROM tasks
        WHERE owner_subject = ?
          AND json_extract(body, '$.source.kind') = ?
          AND json_extract(body, '$.pinned_at') IS NULL
          AND status NOT IN ('done', 'cancelled')`,
    )
    .bind(owner, MEETING_SOURCE_KIND)
    .all<{ event_id: string | null; verdict: string | null }>();
  const movableEventIds = new Set(
    (movable.results ?? [])
      .filter((r) => isMovableVerdictUsable(parseVerdict(r.verdict), opts.now))
      .map((r) => r.event_id)
      .filter((v): v is string => !!v),
  );

  // Bounded to future bookings: rows are never deleted (only offboard clears
  // them), so an unbounded scan grows forever, and every candidate event
  // starts at or beyond noticeFloorMs — a past booking's event id can never
  // match a future candidate. `now` (not noticeFloorMs) keeps the margin
  // generous against clock skew between this query and the candidate filter
  // above, at the cost of scanning a little more than strictly necessary.
  const nowIso = opts.now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const booked = await db
    .prepare(
      `SELECT google_event_id FROM bookings
        WHERE owner_subject = ? AND status = 'confirmed' AND google_event_id IS NOT NULL
          AND start_utc > ?`,
    )
    .bind(owner, nowIso)
    .all<{ google_event_id: string | null }>();
  const bookedEventIds = new Set(
    (booked.results ?? []).map((r) => r.google_event_id).filter((v): v is string => !!v),
  );

  return new Set(
    candidates
      .map((e) => e.id)
      .filter((id) => movableEventIds.has(id) && !bookedEventIds.has(id)),
  );
}
