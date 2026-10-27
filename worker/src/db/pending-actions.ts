// O9.1 pending_actions (migration 0042): actions a gated agent asked for,
// waiting for the user's emailed confirmation. All timestamps are
// Date#toISOString() strings, so text comparison orders them correctly.

export interface PendingActionRow {
  id: string;
  owner_subject: string;
  op: string;
  payload: string;
  summary: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
  /** 0045: 'system' when the confirmation went out via the system mailer. */
  mail_channel?: string | null;
}

/** Rows expired longer than this are deleted at the next deferral (anyone's;
 *  offboard deletes a leaver's rows outright). The grace keeps an expired
 *  link saying "expired" rather than "invalid" for a week; the row's payload
 *  and summary are blanked as soon as it is consumed or seen expired. */
export const PENDING_ACTION_PRUNE_GRACE_MS = 7 * 24 * 3600 * 1000;

/** Decision K: an owner's live (unconsumed, unexpired) pending actions are
 *  capped, plan-commit mail included, so a looping agent can't flood the
 *  user's inbox. Past it a gated op answers 429 too_many_pending_actions. */
export const PENDING_ACTION_LIVE_CAP = 20;

/** Decision K: at most this many confirmation emails per owner per rolling
 *  24 h go out through the shared SMTP2GO system mailer (the fallback when
 *  the user's own mailbox send fails). That quota also carries every user's
 *  retention warning and deletion notice, so one looping agent must not be
 *  able to drain it. Low on purpose: a user whose mailbox send keeps failing
 *  has a broken grant, and three links a day is enough to act on. */
export const SYSTEM_FALLBACK_DAILY_LIMIT = 3;
const SYSTEM_FALLBACK_WINDOW_MS = 24 * 3600 * 1000;

/** The pending_actions op that records a plan's emailed accept link
 *  (planning/commit-confirm.ts), for the decision K dedupe and live-action cap
 *  only. Never registered for /confirm replay and no confirm-action token is
 *  ever minted for it: the accept page stays the one path to a commit. */
export const PLAN_COMMIT_MAIL_OP = "plan.commit-mail";

/** Frees the live-cap slot of the owner's plan markers whose plan can no
 *  longer be accepted: committed, expired, or superseded (supersede
 *  hard-deletes the pending row) or otherwise gone. Marks them consumed rather than deleting,
 *  so the 24 h system-mail fallback count still sees them. Run before every
 *  reserve; without it an accepted plan held a slot for up to 72 h.
 *  json_extract only ever sees valid JSON (the CASE yields NULL otherwise):
 *  consumed markers have a blanked '' payload, and SQLite doesn't promise to
 *  evaluate `consumed_at IS NULL` first. A live marker whose payload isn't
 *  valid JSON names no plan, so it is released too. */
export async function releaseSettledPlanMarkers(db: D1Database, owner: string, now: Date): Promise<void> {
  const iso = now.toISOString();
  await db
    .prepare(
      `UPDATE pending_actions SET consumed_at = ?1, payload = '', summary = ''
        WHERE owner_subject = ?2 AND op = ?3 AND consumed_at IS NULL AND expires_at > ?1
          AND NOT EXISTS (SELECT 1 FROM proposed_plans p
                           WHERE p.plan_hash = json_extract(
                                   CASE WHEN json_valid(pending_actions.payload) THEN pending_actions.payload END,
                                   '$.plan_hash')
                             AND p.subject = ?2 AND p.committed_at IS NULL AND p.expires_at > ?1)`,
    )
    .bind(iso, owner, PLAN_COMMIT_MAIL_OP)
    .run();
}

export type ReserveOutcome =
  | { kind: "created" }
  | { kind: "existing"; row: PendingActionRow }
  | { kind: "capped" };

/** Atomically stores a new pending action unless (a) the owner already has a
 *  live one with the same op and payload, which is returned instead (dedupe:
 *  no second row, no second email), or (b) the owner is at
 *  PENDING_ACTION_LIVE_CAP live actions. One INSERT … SELECT … WHERE, so
 *  concurrent identical requests can't both insert (D1 runs statements one at
 *  a time). `payload` must be canonical JSON for (a) to match. */
export async function reservePendingAction(
  db: D1Database,
  row: Omit<PendingActionRow, "consumed_at">,
  now: Date,
): Promise<ReserveOutcome> {
  const iso = now.toISOString();
  const r = await db
    .prepare(
      `INSERT INTO pending_actions (id, owner_subject, op, payload, summary, created_at, expires_at, consumed_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL
        WHERE NOT EXISTS (SELECT 1 FROM pending_actions
                           WHERE owner_subject = ?2 AND op = ?3 AND payload = ?4
                             AND consumed_at IS NULL AND expires_at > ?8)
          AND (SELECT COUNT(*) FROM pending_actions
                WHERE owner_subject = ?2 AND consumed_at IS NULL AND expires_at > ?8) < ?9`,
    )
    .bind(row.id, row.owner_subject, row.op, row.payload, row.summary, row.created_at, row.expires_at, iso, PENDING_ACTION_LIVE_CAP)
    .run();
  if ((r.meta.changes ?? 0) === 1) return { kind: "created" };
  const existing = await db
    .prepare(
      `SELECT * FROM pending_actions WHERE owner_subject = ? AND op = ? AND payload = ?
         AND consumed_at IS NULL AND expires_at > ? ORDER BY created_at LIMIT 1`,
    )
    .bind(row.owner_subject, row.op, row.payload, iso)
    .first<PendingActionRow>();
  return existing ? { kind: "existing", row: existing } : { kind: "capped" };
}

/** Claims one of the owner's system-mailer fallback sends for row `id`
 *  (marks it mail_channel='system') if fewer than SYSTEM_FALLBACK_DAILY_LIMIT
 *  of their rows were system-mailed in the last 24 h. Atomic, like the
 *  reserve. Consumed rows still count (their mail was sent); a row deleted
 *  because its send failed does not. */
export async function claimSystemFallback(db: D1Database, id: string, owner: string, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - SYSTEM_FALLBACK_WINDOW_MS).toISOString();
  const r = await db
    .prepare(
      `UPDATE pending_actions SET mail_channel = 'system'
        WHERE id = ?1 AND owner_subject = ?2
          AND (SELECT COUNT(*) FROM pending_actions
                WHERE owner_subject = ?2 AND mail_channel = 'system' AND created_at > ?3) < ?4`,
    )
    .bind(id, owner, since, SYSTEM_FALLBACK_DAILY_LIMIT)
    .run();
  return (r.meta.changes ?? 0) === 1;
}

/** Lookup scoped to the owner: another subject's row reads as absent. */
export async function getPendingAction(db: D1Database, id: string, owner: string): Promise<PendingActionRow | null> {
  return db
    .prepare("SELECT * FROM pending_actions WHERE id = ? AND owner_subject = ?")
    .bind(id, owner)
    .first<PendingActionRow>();
}

/** The single-use CAS: true for exactly one caller, and only while the row
 *  is unconsumed and unexpired at `now`. It also blanks payload and summary:
 *  the caller has already parsed the payload, and a consumed row keeps no
 *  action data. */
export async function consumePendingAction(db: D1Database, id: string, owner: string, now: Date): Promise<boolean> {
  const iso = now.toISOString();
  const r = await db
    .prepare(
      "UPDATE pending_actions SET consumed_at = ?, payload = '', summary = '' WHERE id = ? AND owner_subject = ? AND consumed_at IS NULL AND expires_at > ?",
    )
    .bind(iso, id, owner, iso)
    .run();
  return (r.meta.changes ?? 0) === 1;
}

export async function deletePendingAction(db: D1Database, id: string, owner: string): Promise<void> {
  await db.prepare("DELETE FROM pending_actions WHERE id = ? AND owner_subject = ?").bind(id, owner).run();
}

/** Housekeeping across all owners, run at every deferral and by the daily
 *  CLEANUP_CRON (so an idle deployment still gets cleaned): blank every
 *  expired row's data, and delete rows a week past expiry, consumed or not.
 *  Returns the row counts each statement changed. */
export async function pruneExpiredPendingActions(
  db: D1Database,
  now: Date,
): Promise<{ deleted: number; blanked: number }> {
  const iso = now.toISOString();
  const cutoff = new Date(now.getTime() - PENDING_ACTION_PRUNE_GRACE_MS).toISOString();
  const [del, blank] = await db.batch([
    db.prepare("DELETE FROM pending_actions WHERE expires_at < ?").bind(cutoff),
    db.prepare("UPDATE pending_actions SET payload = '', summary = '' WHERE expires_at <= ? AND (payload != '' OR summary != '')").bind(iso),
  ]);
  return { deleted: del?.meta.changes ?? 0, blanked: blank?.meta.changes ?? 0 };
}

/** Blank one expired row's data the moment a link reaches it. */
export async function blankExpiredPendingAction(db: D1Database, id: string, owner: string, now: Date): Promise<void> {
  await db
    .prepare("UPDATE pending_actions SET payload = '', summary = '' WHERE id = ? AND owner_subject = ? AND expires_at <= ?")
    .bind(id, owner, now.toISOString())
    .run();
}
