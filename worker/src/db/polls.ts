/** Meeting-poll DB layer: polls, their invitees, and per-cell responses.
 *  Plain functions over D1Database, narrow interfaces, no classes — mirrors
 *  db/bookings.ts. Every timestamp column is a UTC ISO string; times are
 *  never manipulated here, only stored and compared as strings. */

export type PollStatus = "open" | "booked" | "cancelled" | "needs_attention";
export type InviteeKind = "invited" | "guest";
export type ResponseState = "free" | "if_needed";

export interface Poll {
  id: string;
  subject: string;
  title: string;
  durationMin: number;
  rangeStart: string;
  rangeEnd: string;
  deadlineUtc: string;
  /** Booking-page location shape (JSON in the row) — db/ takes no dependency
   *  on booking/location.ts, same reasoning as ClaimRequest.locationKind in
   *  db/bookings.ts. Validation against the real union belongs at the route
   *  layer. */
  location: unknown;
  guestTokenHash: string | null;
  status: PollStatus;
  bookedSlotUtc: string | null;
  gcalEventId: string | null;
  nudgedMidpointAt: string | null;
  nudgedFinalAt: string | null;
  escalatedAt: string | null;
  createdAt: string;
}

export interface PollInvitee {
  id: string;
  pollId: string;
  email: string;
  name: string | null;
  kind: InviteeKind;
  tokenHash: string;
  pseudonym: string;
  hideName: boolean;
  respondedAt: string | null;
  dropped: boolean;
}

export interface ResponseCell {
  cellStartUtc: string;
  state: ResponseState;
}

export interface CellAggregate {
  cellStartUtc: string;
  free: number;
  ifNeeded: number;
}

export interface InviteeCells {
  inviteeId: string;
  cells: ResponseCell[];
}

interface PollRow {
  id: string;
  subject: string;
  title: string;
  duration_min: number;
  range_start: string;
  range_end: string;
  deadline_utc: string;
  location: string;
  guest_token_hash: string | null;
  status: string;
  booked_slot_utc: string | null;
  gcal_event_id: string | null;
  nudged_midpoint_at: string | null;
  nudged_final_at: string | null;
  escalated_at: string | null;
  created_at: string;
}

interface InviteeRow {
  id: string;
  poll_id: string;
  email: string;
  name: string | null;
  kind: string;
  token_hash: string;
  pseudonym: string;
  hide_name: number;
  responded_at: string | null;
  dropped: number;
}

function rowToPoll(row: PollRow): Poll {
  return {
    id: row.id,
    subject: row.subject,
    title: row.title,
    durationMin: row.duration_min,
    rangeStart: row.range_start,
    rangeEnd: row.range_end,
    deadlineUtc: row.deadline_utc,
    location: JSON.parse(row.location),
    guestTokenHash: row.guest_token_hash,
    status: row.status as PollStatus,
    bookedSlotUtc: row.booked_slot_utc,
    gcalEventId: row.gcal_event_id,
    nudgedMidpointAt: row.nudged_midpoint_at,
    nudgedFinalAt: row.nudged_final_at,
    escalatedAt: row.escalated_at,
    createdAt: row.created_at,
  };
}

function rowToInvitee(row: InviteeRow): PollInvitee {
  return {
    id: row.id,
    pollId: row.poll_id,
    email: row.email,
    name: row.name,
    kind: row.kind as InviteeKind,
    tokenHash: row.token_hash,
    pseudonym: row.pseudonym,
    hideName: row.hide_name === 1,
    respondedAt: row.responded_at,
    dropped: row.dropped === 1,
  };
}

const POLL_COLUMNS =
  "id, subject, title, duration_min, range_start, range_end, deadline_utc, location, " +
  "guest_token_hash, status, booked_slot_utc, gcal_event_id, nudged_midpoint_at, " +
  "nudged_final_at, escalated_at, created_at";

const INVITEE_COLUMNS =
  "id, poll_id, email, name, kind, token_hash, pseudonym, hide_name, responded_at, dropped";

export interface CreatePollInput {
  subject: string;
  title: string;
  durationMin: number;
  rangeStart: string;
  rangeEnd: string;
  deadlineUtc: string;
  location: unknown;
  guestTokenHash: string | null;
  now: string;
}

export async function createPoll(db: D1Database, input: CreatePollInput): Promise<Poll> {
  const id = `p_${crypto.randomUUID()}`;
  await db
    .prepare(
      `INSERT INTO polls (id, subject, title, duration_min, range_start, range_end, deadline_utc,
         location, guest_token_hash, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
    )
    .bind(
      id, input.subject, input.title, input.durationMin, input.rangeStart, input.rangeEnd,
      input.deadlineUtc, JSON.stringify(input.location), input.guestTokenHash, input.now,
    )
    .run();
  const poll = await getPoll(db, id);
  if (!poll) throw new Error("createPoll: row missing immediately after insert");
  return poll;
}

export async function getPoll(db: D1Database, id: string): Promise<Poll | null> {
  const row = await db.prepare(`SELECT ${POLL_COLUMNS} FROM polls WHERE id = ?`).bind(id).first<PollRow>();
  return row ? rowToPoll(row) : null;
}

/** Ownership-checked lookup: a poll id that exists but belongs to a different
 *  subject is indistinguishable from an unknown one (callers 404, not 403). */
export async function getPollForSubject(db: D1Database, subject: string, id: string): Promise<Poll | null> {
  const row = await db
    .prepare(`SELECT ${POLL_COLUMNS} FROM polls WHERE id = ? AND subject = ?`)
    .bind(id, subject)
    .first<PollRow>();
  return row ? rowToPoll(row) : null;
}

/** The invitee id scheme, exported so callers that must know an invitee's id
 *  BEFORE the row exists (minting its capability token — the token's claims
 *  bind pollId+inviteeId, and only the token's HASH is ever persisted, so the
 *  id has to be chosen first) generate it the same way insertInvitee expects,
 *  instead of drifting their own prefix/format. */
export function newInviteeId(): string {
  return `pi_${crypto.randomUUID()}`;
}

export interface InsertInviteeInput {
  /** Caller-supplied (see newInviteeId) — insertInvitee never generates one,
   *  so the id is stable across "mint token, then insert the row it names". */
  id: string;
  pollId: string;
  email: string;
  name: string | null;
  kind: InviteeKind;
  tokenHash: string;
  pseudonym: string;
  now: string;
  /** Hash of the joining request's client IP (0033) — only the guest-join
   *  route ever supplies this; the organiser-invite path leaves it undefined
   *  (stored NULL), since an organiser-added invitee was never "joined" from
   *  a browser at all. Purely a "which IP created this row" audit trail —
   *  the actual per-IP rate limit is countRecentJoinAttempts (0034) below,
   *  which counts every join ATTEMPT (not every inserted row). */
  ipHash?: string;
}

/** Inserts an invitee row. The UNIQUE(poll_id, email) violation is left to
 *  propagate as a rejected promise — callers that need duplicate-email
 *  handling (e.g. the guest-join route) catch it there. `now` is always
 *  stamped into `created_at` (0033) regardless of whether `ipHash` is
 *  supplied — every insert has a creation time, only the IP is guest-join
 *  specific. */
export async function insertInvitee(db: D1Database, input: InsertInviteeInput): Promise<PollInvitee> {
  await db
    .prepare(
      `INSERT INTO poll_invitees (id, poll_id, email, name, kind, token_hash, pseudonym, hide_name, responded_at, dropped, ip_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, 0, ?, ?)`,
    )
    .bind(
      input.id, input.pollId, input.email, input.name, input.kind, input.tokenHash, input.pseudonym,
      input.ipHash ?? null, input.now,
    )
    .run();
  return {
    id: input.id, pollId: input.pollId, email: input.email, name: input.name, kind: input.kind,
    tokenHash: input.tokenHash, pseudonym: input.pseudonym, hideName: false, respondedAt: null, dropped: false,
  };
}

/** Records one join ATTEMPT against the (poll_id, ip_hash) budget (0034) —
 *  called once per POST /poll/:id/join that gets far enough to be rate-
 *  limited, BEFORE the route branches on new-guest / already-invited /
 *  dropped / at-cap. Fixes R1-F1/R4-H2: the prior design (countRecentJoinsByIp
 *  over poll_invitees.ip_hash) only saw an attempt when a NEW invitee row
 *  was inserted, so the already-invited and dropped-invitee arms — which
 *  never insert a row — were invisible to the limit and could be hammered
 *  unboundedly against any known invitee address. A dedicated attempts log
 *  makes every attempt count, regardless of what the route does with it. */
export async function recordJoinAttempt(db: D1Database, pollId: string, ipHash: string, now: string): Promise<void> {
  await db
    .prepare("INSERT INTO poll_join_attempts (poll_id, ip_hash, created_at) VALUES (?, ?, ?)")
    .bind(pollId, ipHash, now)
    .run();
}

/** Windowed per-IP join-ATTEMPT count for one poll (0034) — the guest-join
 *  route's real rate limit, shaped like db/bookings.ts's countRecentByIp:
 *  counts poll_join_attempts rows for this poll whose ip_hash matches and
 *  whose created_at falls at or after `sinceIso`. Uses the (poll_id,
 *  ip_hash, created_at) index migration 0034 adds. */
export async function countRecentJoinAttempts(
  db: D1Database, pollId: string, ipHash: string, sinceIso: string,
): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM poll_join_attempts WHERE poll_id = ? AND ip_hash = ? AND created_at >= ?",
    )
    .bind(pollId, ipHash, sinceIso)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Replaces a stored token hash IN PLACE (id and every other column stable) —
 *  used when a nudge re-issues an invitee's link: mint a fresh token, then
 *  overwrite the hash so the OLD token stops resolving immediately. */
export async function setInviteeTokenHash(db: D1Database, inviteeId: string, tokenHash: string): Promise<void> {
  await db.prepare("UPDATE poll_invitees SET token_hash = ? WHERE id = ?").bind(tokenHash, inviteeId).run();
}

export async function listInvitees(db: D1Database, pollId: string): Promise<PollInvitee[]> {
  const r = await db
    .prepare(`SELECT ${INVITEE_COLUMNS} FROM poll_invitees WHERE poll_id = ? ORDER BY email`)
    .bind(pollId)
    .all<InviteeRow>();
  return (r.results ?? []).map(rowToInvitee);
}

/** Resolves a presented token's hash to its invitee, scoped to the poll the
 *  token claims to be for — a hash that matches a DIFFERENT poll's invitee
 *  (shouldn't happen given the HMAC binding, but is cheap to guard here too)
 *  resolves to null rather than leaking a cross-poll row. */
export async function getInviteeByTokenHash(
  db: D1Database, pollId: string, tokenHash: string,
): Promise<PollInvitee | null> {
  const row = await db
    .prepare(`SELECT ${INVITEE_COLUMNS} FROM poll_invitees WHERE poll_id = ? AND token_hash = ?`)
    .bind(pollId, tokenHash)
    .first<InviteeRow>();
  return row ? rowToInvitee(row) : null;
}

/** Delete-then-insert in one batch: a full replace of this invitee's painted
 *  cells (revise-until-close), so a shrunk selection leaves no stale rows. */
export async function replaceResponses(db: D1Database, inviteeId: string, cells: ResponseCell[]): Promise<void> {
  const stmts = [
    db.prepare("DELETE FROM poll_responses WHERE invitee_id = ?").bind(inviteeId),
    ...cells.map((c) =>
      db
        .prepare("INSERT INTO poll_responses (invitee_id, cell_start_utc, state) VALUES (?, ?, ?)")
        .bind(inviteeId, c.cellStartUtc, c.state),
    ),
  ];
  await db.batch(stmts);
}

export async function markResponded(db: D1Database, inviteeId: string, now: string): Promise<void> {
  await db.prepare("UPDATE poll_invitees SET responded_at = ? WHERE id = ?").bind(now, inviteeId).run();
}

export async function setHideName(db: D1Database, inviteeId: string, hideName: boolean): Promise<void> {
  await db
    .prepare("UPDATE poll_invitees SET hide_name = ? WHERE id = ?")
    .bind(hideName ? 1 : 0, inviteeId)
    .run();
}

/** Updates the display name — the invitee page's submit bar lets a
 *  respondent adjust their name from what the organiser originally typed. */
export async function setInviteeName(db: D1Database, inviteeId: string, name: string): Promise<void> {
  await db.prepare("UPDATE poll_invitees SET name = ? WHERE id = ?").bind(name, inviteeId).run();
}

export async function dropInvitee(db: D1Database, inviteeId: string): Promise<void> {
  await db.prepare("UPDATE poll_invitees SET dropped = 1 WHERE id = ?").bind(inviteeId).run();
}

/** Flips `dropped` 1->0 (updateMeetingPoll's re-add-by-email arm). Every
 *  other column — id, email, pseudonym, responded_at, and the invitee's
 *  painted poll_responses rows (a separate table, untouched here) — is left
 *  exactly as it was, so a restore revives the row rather than recreating
 *  it. Restoring an already-non-dropped row is a harmless no-op (the WHERE
 *  clause still matches and sets dropped = 0, which it already was). */
export async function restoreInvitee(db: D1Database, inviteeId: string): Promise<void> {
  await db.prepare("UPDATE poll_invitees SET dropped = 0 WHERE id = ?").bind(inviteeId).run();
}

/** Two queries, as the card specifies: per-cell free/if_needed counts (for
 *  the heatmap, dropped invitees excluded — they're out of the required set
 *  and their stale paint shouldn't shade the aggregate), and the raw
 *  per-invitee cell list (unfiltered; callers that need to exclude dropped
 *  invitees already have that flag from listInvitees). */
export async function aggregateResponses(
  db: D1Database, pollId: string,
): Promise<{ cellCounts: CellAggregate[]; byInvitee: InviteeCells[] }> {
  const countsResult = await db
    .prepare(
      `SELECT r.cell_start_utc AS cellStartUtc,
              SUM(CASE WHEN r.state = 'free' THEN 1 ELSE 0 END) AS free,
              SUM(CASE WHEN r.state = 'if_needed' THEN 1 ELSE 0 END) AS ifNeeded
         FROM poll_responses r
         JOIN poll_invitees i ON i.id = r.invitee_id
        WHERE i.poll_id = ? AND i.dropped = 0
        GROUP BY r.cell_start_utc
        ORDER BY r.cell_start_utc`,
    )
    .bind(pollId)
    .all<CellAggregate>();

  const cellsResult = await db
    .prepare(
      `SELECT r.invitee_id AS inviteeId, r.cell_start_utc AS cellStartUtc, r.state AS state
         FROM poll_responses r
         JOIN poll_invitees i ON i.id = r.invitee_id
        WHERE i.poll_id = ?
        ORDER BY r.invitee_id, r.cell_start_utc`,
    )
    .bind(pollId)
    .all<{ inviteeId: string; cellStartUtc: string; state: ResponseState }>();

  const byInviteeMap = new Map<string, ResponseCell[]>();
  for (const row of cellsResult.results ?? []) {
    const list = byInviteeMap.get(row.inviteeId) ?? [];
    list.push({ cellStartUtc: row.cellStartUtc, state: row.state });
    byInviteeMap.set(row.inviteeId, list);
  }

  return {
    cellCounts: countsResult.results ?? [],
    byInvitee: [...byInviteeMap.entries()].map(([inviteeId, cells]) => ({ inviteeId, cells })),
  };
}

/** Sets `status`. Entering `needs_attention` stamps `escalated_at` — but only
 *  the FIRST time (COALESCE keeps an earlier stamp); a poll only escalates
 *  once per episode, and repeated cron sweeps over an already-escalated poll
 *  must not keep moving the timestamp (T9/T10 idempotency requirement). */
export async function setPollStatus(db: D1Database, pollId: string, status: PollStatus, now: string): Promise<void> {
  if (status === "needs_attention") {
    await db
      .prepare("UPDATE polls SET status = ?, escalated_at = COALESCE(escalated_at, ?) WHERE id = ?")
      .bind(status, now, pollId)
      .run();
  } else {
    await db.prepare("UPDATE polls SET status = ? WHERE id = ?").bind(status, pollId).run();
  }
}

/** Conditional `setPollStatus`, same COALESCE semantics for `escalated_at`
 *  (first stamp wins within an episode). Returns whether the row moved — a
 *  `false` means the poll left `fromStatuses` under the caller's feet
 *  (booked or cancelled by a concurrent path), and the caller must NOT treat
 *  the transition as having happened (in particular: must not send the
 *  escalation email that normally accompanies it). */
export async function casSetPollStatus(
  db: D1Database,
  pollId: string,
  status: PollStatus,
  fromStatuses: readonly PollStatus[],
  now: string,
): Promise<boolean> {
  if (fromStatuses.length === 0) throw new Error("casSetPollStatus: fromStatuses must not be empty");
  const placeholders = fromStatuses.map(() => "?").join(", ");
  const res =
    status === "needs_attention"
      ? await db
          .prepare(
            `UPDATE polls SET status = ?, escalated_at = COALESCE(escalated_at, ?)
              WHERE id = ? AND status IN (${placeholders})`,
          )
          .bind(status, now, pollId, ...fromStatuses)
          .run()
      : await db
          .prepare(`UPDATE polls SET status = ? WHERE id = ? AND status IN (${placeholders})`)
          .bind(status, pollId, ...fromStatuses)
          .run();
  return res.meta.changes === 1;
}

export async function setBooked(
  db: D1Database, pollId: string, slotStartUtc: string, gcalEventId: string,
): Promise<void> {
  await db
    .prepare("UPDATE polls SET status = 'booked', booked_slot_utc = ?, gcal_event_id = ? WHERE id = ?")
    .bind(slotStartUtc, gcalEventId, pollId)
    .run();
}

/** Conditional `setBooked`: only transitions a poll whose status is still one
 *  of `fromStatuses`. Returns whether the row actually moved. The booking
 *  engine calls this AFTER the calendar event exists, so a `false` result is
 *  the signal that the poll was cancelled (or booked by a concurrent attempt)
 *  mid-flight and the just-created event must be compensated away. */
export async function casSetBooked(
  db: D1Database,
  pollId: string,
  slotStartUtc: string,
  gcalEventId: string,
  fromStatuses: readonly PollStatus[],
): Promise<boolean> {
  if (fromStatuses.length === 0) throw new Error("casSetBooked: fromStatuses must not be empty");
  const placeholders = fromStatuses.map(() => "?").join(", ");
  const res = await db
    .prepare(
      `UPDATE polls SET status = 'booked', booked_slot_utc = ?, gcal_event_id = ?
        WHERE id = ? AND status IN (${placeholders})`,
    )
    .bind(slotStartUtc, gcalEventId, pollId, ...fromStatuses)
    .run();
  return res.meta.changes === 1;
}

/** Updates ONLY deadline_utc — used by updateMeetingPoll's deadlineUtc arm.
 *  Deliberately narrow: an escalated poll's status flip back to 'open' is a
 *  separate, explicit setPollStatus call the caller makes, not folded in
 *  here, so this primitive can't accidentally revive a cancelled poll. */
export async function setPollDeadline(db: D1Database, pollId: string, deadlineUtc: string): Promise<void> {
  await db.prepare("UPDATE polls SET deadline_utc = ? WHERE id = ?").bind(deadlineUtc, pollId).run();
}

/** Updates ONLY title — used by updateMeetingPoll's title arm. Same narrow
 *  shape as setPollDeadline: no status side effect. */
export async function setPollTitle(db: D1Database, pollId: string, title: string): Promise<void> {
  await db.prepare("UPDATE polls SET title = ? WHERE id = ?").bind(title, pollId).run();
}

/** Updates ONLY location, JSON-serialised the same way createPoll stores it
 *  (getPoll/rowToPoll parses it back out) — used by updateMeetingPoll's
 *  location arm. Same narrow shape as setPollDeadline: no status side
 *  effect. */
export async function setPollLocation(db: D1Database, pollId: string, location: unknown): Promise<void> {
  await db.prepare("UPDATE polls SET location = ? WHERE id = ?").bind(JSON.stringify(location), pollId).run();
}

/** Sets or clears (null) ONLY guest_token_hash — used by updateMeetingPoll's
 *  guestLink arm (enable mints+stores a hash, disable NULLs it, which lifts
 *  the guest-link wait-for-deadline guard at booking.ts:736). Same narrow
 *  shape as setPollDeadline: no status side effect. */
export async function setGuestTokenHash(db: D1Database, pollId: string, hash: string | null): Promise<void> {
  await db.prepare("UPDATE polls SET guest_token_hash = ? WHERE id = ?").bind(hash, pollId).run();
}

export async function markNudged(db: D1Database, pollId: string, which: "midpoint" | "final", now: string): Promise<void> {
  const column = which === "midpoint" ? "nudged_midpoint_at" : "nudged_final_at";
  await db.prepare(`UPDATE polls SET ${column} = ? WHERE id = ?`).bind(now, pollId).run();
}

/** Clears the three per-episode stamps (`escalated_at`, `nudged_midpoint_at`,
 *  `nudged_final_at`) in one statement. Called by updateMeetingPoll's
 *  deadlineUtc arm: pushing the deadline out opens a NEW response episode, and
 *  a stale stamp silently disables both the escalation email and the nudge
 *  cadences for the rest of the poll's life. Unconditional by design — the
 *  caller has already established the poll is neither booked nor cancelled,
 *  and clearing stamps on a terminal poll is harmless. */
export async function clearPollEpisodeStamps(db: D1Database, pollId: string): Promise<void> {
  await db
    .prepare("UPDATE polls SET escalated_at = NULL, nudged_midpoint_at = NULL, nudged_final_at = NULL WHERE id = ?")
    .bind(pollId)
    .run();
}

/** Open polls for one subject, for the cron sweep's per-subject fan-out (the
 *  (subject, status) index makes this a single indexed lookup). `now` is
 *  accepted here for signature symmetry with the rest of the sweep, but the
 *  row set is defined purely by status='open' — per-poll due-ness (deadline
 *  passed vs which nudge is due) is time arithmetic the caller (cron) does
 *  against `now`, not a WHERE clause here. A poll parked in needs_attention
 *  stays out of the sweep until resolveMeetingPoll moves it, so it isn't
 *  re-escalated or re-nudged on every tick. */
export async function listOpenPollsDue(db: D1Database, subject: string, now: string): Promise<Poll[]> {
  void now;
  const r = await db
    .prepare(`SELECT ${POLL_COLUMNS} FROM polls WHERE subject = ? AND status = 'open' ORDER BY deadline_utc ASC`)
    .bind(subject)
    .all<PollRow>();
  return (r.results ?? []).map(rowToPoll);
}
