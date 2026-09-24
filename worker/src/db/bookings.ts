export interface ClaimRequest {
  ownerSubject: string;
  slug: string;
  startUtc: string;
  endUtc: string;
  durationMinutes: number;
  bookerName: string;
  bookerEmail: string;
  bookerNote: string | null;
  /** How the booker chose to meet, and the number or place they supplied.
   *  `locationDetail` is null for kinds that collect nothing. Typed as a bare
   *  `string`, not the `LocationKind` union from booking/location.ts: db/ has
   *  no dependency on booking/, and importing that taxonomy here to validate
   *  it would invert that direction. Validation against the real union
   *  belongs at the route layer, which already owns the offered-modes check. */
  locationKind: string;
  locationDetail: string | null;
  ipHash: string;
  /** Set only by a meeting-poll auto-book/resolve claim (worker/src/polls/booking.ts);
   *  undefined/null for every booking-page claim, which is what keeps this
   *  table's existing uniqueness domain (one claim guard across both claimants)
   *  unchanged for booking-page callers — they simply never set it. */
  pollId?: string | null;
  /** Buffer-expanded bounds used ONLY for the overlap guard, so a booking also
   *  reserves its padding against the next claimant. */
  guardStartUtc: string;
  guardEndUtc: string;
  now: Date;
}

export interface BookingRow {
  id: string;
  owner_subject: string;
  slug: string;
  start_utc: string;
  end_utc: string;
  duration_minutes: number;
  booker_name: string;
  booker_email: string;
  booker_note: string | null;
  /** Null for bookings written before location modes existed (pre-migration
   *  0031); a real, reachable state, not defensive typing. */
  location_kind: string | null;
  location_detail: string | null;
  status: string;
  google_event_id: string | null;
  created_at: string;
  /** Null for every booking-page claim; set for a meeting-poll auto-book. */
  poll_id: string | null;
  /** Non-null while a decline-triggered grace period is running (see
   *  markCancelPending). A pending-cancel row is still 'confirmed' — it keeps
   *  blocking its slot — until the sweep either cancels it or clears the
   *  stamp. */
  cancel_pending_at: string | null;
}

/** Row shape returned by listCancelPendingDue: only the columns the sweep
 *  (worker/src/cron/booking-decline-sweep.ts) needs to re-verify, delete the
 *  calendar event, and email the booker/owner. */
export interface CancelPendingRow {
  id: string;
  owner_subject: string;
  slug: string;
  google_event_id: string;
  booker_name: string;
  booker_email: string;
  start_utc: string;
  end_utc: string;
  location_kind: string | null;
}

/** The one instant format this table stores: second-precision UTC,
 *  `YYYY-MM-DDTHH:MM:SSZ`.
 *
 *  Every time comparison here is a string comparison under SQLite's BINARY
 *  collation, and lexicographic order only tracks chronological order while
 *  both operands share a format: '...:00Z' sorts AFTER '...:00.000Z', because
 *  '.' (0x2E) precedes 'Z' (0x5A), which silently reads a touching pair as an
 *  overlapping one. Callers legitimately supply either precision — the route
 *  builds bounds with `new Date(ms).toISOString()`, which emits milliseconds —
 *  so normalising one side of the guard is not enough. Every instant is
 *  canonicalised here, both the values written into a row and the bounds
 *  compared against them; this module is the table's only writer, so rows are
 *  canonical by construction. Slot bounds are minute-aligned, so dropping
 *  sub-second precision loses nothing. Throws on an unparseable instant, which
 *  is the right outcome at a write boundary. */
function canonicalIso(iso: string): string {
  return new Date(iso).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Shift an instant by N minutes, in canonical form. */
function shiftIso(iso: string, minutes: number): string {
  return canonicalIso(new Date(Date.parse(iso) + minutes * 60_000).toISOString());
}

/** Reserve a slot, or return null if it is taken.
 *
 *  D1 has no exclusion constraints and no interactive transactions, but a
 *  single SQLite statement IS atomic — so INSERT ... SELECT ... WHERE NOT EXISTS
 *  is a complete mutual-exclusion primitive, and no Durable Object is needed.
 *  The guard is interval-based (start < other.end AND end > other.start): a
 *  unique index on start_utc would miss a 60-minute booking colliding with a
 *  30-minute one half an hour later.
 *
 *  Both sides of that test are buffer-expanded. The incoming claim arrives
 *  pre-expanded as guardStart/guardEnd, but a stored row keeps its TRUE bounds,
 *  so an existing booking's padding would be invisible to the next claimant
 *  unless we re-expand it here. The buffer is owner-level config, so the same
 *  padding the caller applied to this claim applies to the existing rows:
 *  recover it from the guard deltas and fold it into the probe bounds, which
 *  keeps the comparison a plain indexed column test rather than SQLite date
 *  arithmetic. Blocked iff
 *    (other.start - before) < guardEnd  AND  (other.end + after) > guardStart. */
export async function claimSlot(db: D1Database, r: ClaimRequest): Promise<{ id: string } | null> {
  const id = crypto.randomUUID();
  const iso = canonicalIso(r.now.toISOString());
  const bufferBefore = (Date.parse(r.startUtc) - Date.parse(r.guardStartUtc)) / 60_000;
  const bufferAfter = (Date.parse(r.guardEndUtc) - Date.parse(r.endUtc)) / 60_000;
  const probeEnd = shiftIso(r.guardEndUtc, bufferBefore);
  const probeStart = shiftIso(r.guardStartUtc, -bufferAfter);
  const res = await db
    .prepare(
      `INSERT INTO bookings (id, owner_subject, slug, start_utc, end_utc, duration_minutes,
         booker_name, booker_email, booker_note, location_kind, location_detail,
         ip_hash, status, google_event_id, created_at, updated_at, poll_id)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserving', NULL, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM bookings
         WHERE owner_subject = ?
           AND status IN ('reserving', 'confirmed')
           AND start_utc < ?
           AND end_utc   > ?
       )
       AND NOT EXISTS (
         -- At most one LIVE booking per poll, enforced here rather than by a
         -- caller-side read-then-write: two concurrent auto-book attempts for
         -- the SAME poll can honestly rank two DIFFERENT, non-overlapping
         -- slots (each one's own 'reserving' row only makes ITS winning slot
         -- busy to the other's availability recompute), so the overlap guard
         -- above never fires between them. This clause is what actually stops
         -- a poll from getting two calendar events. Inert for every
         -- booking-page claim: they never set poll_id, and 'poll_id = NULL'
         -- is never true in SQL, so this subquery is a no-op for them and
         -- their existing single-uniqueness-domain behaviour is unchanged.
         SELECT 1 FROM bookings
         WHERE poll_id IS NOT NULL AND poll_id = ?
           AND status IN ('reserving', 'confirmed')
       )`,
    )
    .bind(
      id, r.ownerSubject, r.slug, canonicalIso(r.startUtc), canonicalIso(r.endUtc), r.durationMinutes,
      r.bookerName, r.bookerEmail, r.bookerNote, r.locationKind, r.locationDetail,
      r.ipHash, iso, iso, r.pollId ?? null,
      r.ownerSubject, probeEnd, probeStart, r.pollId ?? null,
    )
    .run();
  return res.meta.changes === 1 ? { id } : null;
}

/** Re-point a confirmed booking's stored bounds after its real calendar event
 *  is relocated out from under it (an owned-meeting move — see commit.ts).
 *  Matched by google_event_id, not id: the caller only knows the event that
 *  moved. No matching row is the common case (most moved meetings are not
 *  public bookings) and is a silent no-op, not an error. The table has no
 *  guard columns to carry forward — only true bounds are stored — so this
 *  never touches duration_minutes or the buffer. */
export async function syncBookingTime(
  db: D1Database,
  owner: string,
  googleEventId: string,
  startUtc: string,
  endUtc: string,
  now: Date,
): Promise<void> {
  await db
    .prepare(
      "UPDATE bookings SET start_utc = ?, end_utc = ?, updated_at = ? WHERE owner_subject = ? AND google_event_id = ? AND status = 'confirmed'",
    )
    .bind(canonicalIso(startUtc), canonicalIso(endUtc), canonicalIso(now.toISOString()), owner, googleEventId)
    .run();
}

export async function confirmBooking(db: D1Database, id: string, eventId: string, now: Date): Promise<void> {
  await db
    .prepare("UPDATE bookings SET status = 'confirmed', google_event_id = ?, updated_at = ? WHERE id = ?")
    .bind(eventId, canonicalIso(now.toISOString()), id)
    .run();
}

/** Release a reservation whose calendar write failed, so the slot re-opens. */
export async function failBooking(db: D1Database, id: string, now: Date): Promise<void> {
  await db
    .prepare("UPDATE bookings SET status = 'failed', updated_at = ? WHERE id = ?")
    .bind(canonicalIso(now.toISOString()), id)
    .run();
}

/** Start the decline-cancel grace clock, iff the row is still exactly the
 *  live booking the caller thinks it is: 'confirmed', matching event id, and
 *  not a poll booking (poll meetings are relocatable/managed elsewhere, so
 *  they're out of scope for this flow — see decline-cancel.ts). CAS on
 *  `cancel_pending_at IS NULL` so a repeat webhook delivery for the same
 *  decline never resets the clock. Returns whether this call was the one that
 *  stamped it. */
export async function markCancelPending(
  db: D1Database, id: string, ownerSubject: string, googleEventId: string, nowIso: string,
): Promise<boolean> {
  const iso = canonicalIso(nowIso);
  const res = await db
    .prepare(
      `UPDATE bookings SET cancel_pending_at = ?, updated_at = ?
       WHERE id = ? AND owner_subject = ? AND google_event_id = ?
         AND status = 'confirmed' AND poll_id IS NULL AND cancel_pending_at IS NULL`,
    )
    .bind(iso, iso, id, ownerSubject, googleEventId)
    .run();
  return res.meta.changes === 1;
}

/** Abort a running grace clock (the attendee un-declined). Scoped to
 *  'confirmed' rows only — a row that already fired (now 'cancelled') or
 *  never had a clock running is left alone, so the stamp survives on a
 *  cancelled row as a record of why it was cancelled. Also requires
 *  `cancel_pending_at IS NOT NULL`, so a row with no clock running is a true
 *  no-op (no `updated_at` bump either) — the webhook detector
 *  (booking/decline-cancel.ts) calls this unconditionally on every
 *  not-all-declined delivery of a tagged event, which is normally the
 *  common case with nothing to clear, and that must not churn every such
 *  row's `updated_at` on every webhook delivery (including the full-window
 *  7-day fallback fetch, which can carry many unrelated tagged events).
 *  Returns whether this call was the one that cleared it. */
export async function clearCancelPending(
  db: D1Database, id: string, ownerSubject: string, googleEventId: string, nowIso: string,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE bookings SET cancel_pending_at = NULL, updated_at = ?
       WHERE id = ? AND owner_subject = ? AND google_event_id = ?
         AND status = 'confirmed' AND cancel_pending_at IS NOT NULL`,
    )
    .bind(canonicalIso(nowIso), id, ownerSubject, googleEventId)
    .run();
  return res.meta.changes === 1;
}

/** Confirmed bookings whose grace clock has run out, across all owners — the
 *  sweep (cron/booking-decline-sweep.ts) is global, same shape as
 *  runPollSweep. Only the columns the sweep needs to re-verify, delete, and
 *  email are selected. `poll_id IS NULL AND google_event_id IS NOT NULL` is
 *  defense-in-depth, not load-bearing today (markCancelPending's own CAS
 *  clause already refuses to stamp either shape of row) — this query is the
 *  one that goes on to delete a live calendar event, so its invariant should
 *  not depend solely on some other function's write path staying correct. */
export async function listCancelPendingDue(db: D1Database, cutoffIso: string): Promise<CancelPendingRow[]> {
  const r = await db
    .prepare(
      `SELECT id, owner_subject, slug, google_event_id, booker_name, booker_email,
              start_utc, end_utc, location_kind
       FROM bookings
       WHERE status = 'confirmed' AND cancel_pending_at IS NOT NULL AND cancel_pending_at <= ?
         AND poll_id IS NULL AND google_event_id IS NOT NULL`,
    )
    .bind(canonicalIso(cutoffIso))
    .all<CancelPendingRow>();
  return r.results ?? [];
}

/** Fire the cancellation, CAS-guarded against a concurrent close-out (e.g.
 *  the owner deleted the event themselves and some other path already
 *  touched the row). Returns whether this call won the race. */
export async function markCancelled(db: D1Database, id: string, nowIso: string): Promise<boolean> {
  const res = await db
    .prepare("UPDATE bookings SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'confirmed'")
    .bind(canonicalIso(nowIso), id)
    .run();
  return res.meta.changes === 1;
}

/** Whether this poll already holds a live (reserving or confirmed) booking.
 *  Only used to explain a NULL from `claimSlot`: the poll-scoped exclusion in
 *  that statement is what actually enforces the invariant — this is the
 *  read-back that tells the booking engine "you lost the race for this poll"
 *  rather than "this particular slot was taken". */
export async function hasLiveBookingForPoll(db: D1Database, pollId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 FROM bookings WHERE poll_id = ? AND status IN ('reserving','confirmed') LIMIT 1")
    .bind(pollId)
    .first();
  return row !== null;
}

/** Live bookings (reserving or confirmed) overlapping [from, to). This IS the
 *  slot-blocking set: booking/availability.ts, polls/route.ts, polls/booking.ts,
 *  and handlers/polls.ts all map these rows straight into a `busy` array, so
 *  adding 'cancelled' here would black out an auto-cancelled slot instead of
 *  re-offering it. Use listBookingsForOwner below for a view that also shows
 *  cancelled rows. */
export async function listBookings(
  db: D1Database, owner: string, fromUtc: string, toUtc: string,
): Promise<BookingRow[]> {
  const r = await db
    .prepare(
      `SELECT * FROM bookings
       WHERE owner_subject = ? AND status IN ('reserving','confirmed')
         AND start_utc < ? AND end_utc > ?
       ORDER BY start_utc ASC`,
    )
    .bind(owner, canonicalIso(toUtc), canonicalIso(fromUtc))
    .all<BookingRow>();
  return r.results ?? [];
}

/** Bookings overlapping [from, to), for the owner's management view ONLY
 *  (handlers/booking-page.ts's GET /v1/bookings) — includes 'cancelled' rows
 *  so the owner can see what auto-cancel did. NOT the slot-blocking set: do
 *  not use this for availability computation. See listBookings above. */
export async function listBookingsForOwner(
  db: D1Database, owner: string, fromUtc: string, toUtc: string,
): Promise<BookingRow[]> {
  const r = await db
    .prepare(
      `SELECT * FROM bookings
       WHERE owner_subject = ? AND status IN ('reserving','confirmed','cancelled')
         AND start_utc < ? AND end_utc > ?
       ORDER BY start_utc ASC`,
    )
    .bind(owner, canonicalIso(toUtc), canonicalIso(fromUtc))
    .all<BookingRow>();
  return r.results ?? [];
}

export async function countRecentByIp(
  db: D1Database, ipHash: string, now: Date, windowHours: number,
): Promise<number> {
  const since = canonicalIso(new Date(now.getTime() - windowHours * 3600_000).toISOString());
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM bookings WHERE ip_hash = ? AND created_at >= ? AND status != 'failed'")
    .bind(ipHash, since)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function countTodayByOwner(db: D1Database, owner: string, now: Date): Promise<number> {
  const since = canonicalIso(new Date(now.getTime() - 24 * 3600_000).toISOString());
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM bookings WHERE owner_subject = ? AND created_at >= ? AND status != 'failed'")
    .bind(owner, since)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
