import type { DroppedEntry } from "../diff/compute-diff";
import { localWeekWindow } from "./datetime";

export interface ProposedPlanRow {
  plan_hash: string;
  body: Record<string, unknown> & { schedule: unknown[]; dropped: unknown[] };
  subject: string | null;
  created_at: string;
  expires_at: string;
  committed_at: string | null;
  render_snapshot: unknown | null;
  window_start: string | null;
  window_end: string | null;
}

interface RawRow {
  plan_hash: string;
  body: string;
  subject: string | null;
  created_at: string;
  expires_at: string;
  committed_at: string | null;
  render_snapshot: string | null;
  window_start?: string | null;
  window_end?: string | null;
}

/** True iff `candidateWindowStart` falls in the local week starting at
 *  `targetWeekStart` (both compared via localWeekWindow in `tz`). A value that
 *  won't parse is not a match rather than an exception: these buckets are
 *  computed inside every successful resolve, and migration 0027's backfill
 *  copied window strings out of body JSON without validating them, so a single
 *  malformed row must not take the whole resolve down with it. */
function weekBucketMatches(candidateWindowStart: string, tz: string, targetWeekStart: string): boolean {
  try {
    return localWeekWindow(candidateWindowStart, tz).start === targetWeekStart;
  } catch {
    return false;
  }
}

function rowFromRaw(row: RawRow): ProposedPlanRow {
  const body = JSON.parse(row.body) as ProposedPlanRow["body"];
  const w = body.window as { start?: string; end?: string } | undefined;
  return {
    plan_hash: row.plan_hash,
    body,
    subject: row.subject,
    created_at: row.created_at,
    expires_at: row.expires_at,
    committed_at: row.committed_at,
    render_snapshot: row.render_snapshot ? JSON.parse(row.render_snapshot) : null,
    // Fallback to body.window covers legacy rows and SELECTs that don't project
    // the columns; new logic never needs to re-parse JSON for the window.
    window_start: row.window_start ?? w?.start ?? null,
    window_end: row.window_end ?? w?.end ?? null,
  };
}

export async function insertProposedPlan(
  db: D1Database,
  planHash: string,
  body: Record<string, unknown>,
  createdAt: string,
  expiresAt: string,
  subject?: string | null,
): Promise<void> {
  // plan_hash is a pure content hash, so a re-resolve reproducing an earlier
  // solution conflicts. Re-arm the TTL (created_at/expires_at) for an
  // uncommitted row so callers who just signed a fresh 72h accept link don't hit
  // a stale expires_at and 410 at commit (PP1). Never touch a committed row —
  // `WHERE committed_at IS NULL` makes the conflict a no-op there, preserving the
  // committed plan's timestamps (sibling guard to deleteProposedPlan's).
  const w = (body as { window?: { start?: string; end?: string } }).window;
  await db
    .prepare(
      `INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject, window_start, window_end)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
       ON CONFLICT(plan_hash) DO UPDATE SET
         created_at = excluded.created_at,
         expires_at = excluded.expires_at,
         window_start = excluded.window_start,
         window_end = excluded.window_end
       WHERE committed_at IS NULL`,
    )
    .bind(planHash, JSON.stringify(body), createdAt, expiresAt, subject ?? null, w?.start ?? null, w?.end ?? null)
    .run();
}

export async function getProposedPlan(
  db: D1Database,
  planHash: string,
): Promise<ProposedPlanRow | null> {
  const row = await db
    .prepare(
      "SELECT plan_hash, body, subject, created_at, expires_at, committed_at, render_snapshot FROM proposed_plans WHERE plan_hash = ?",
    )
    .bind(planHash)
    .first<RawRow>();
  return row ? rowFromRaw(row) : null;
}

// Owner-scoped: a tenant may only delete its own pending plan. The subject
// predicate is the isolation boundary — never delete by plan_hash alone, or any
// tenant who learns another's hash could delete their plan. Returns true iff an
// owned row was removed (caller maps false → 404, which also avoids leaking the
// existence of another tenant's plan).
//
// committed_at IS NULL guards the no-diff cleanup paths: plan_hash is a pure
// content hash, so a post-commit no-op replan reproduces the committed row's
// hash, and the cleanup would otherwise DELETE the committed row out from under
// getLatestCommittedPlanForSubject (silently killing the manual-move write-back).
// Harmless to the HTTP DELETE route, which already 409s on committed plans first.
export async function deleteProposedPlan(
  db: D1Database,
  planHash: string,
  ownerSubject: string,
): Promise<boolean> {
  const res = await db
    .prepare("DELETE FROM proposed_plans WHERE plan_hash = ? AND subject = ? AND committed_at IS NULL")
    .bind(planHash, ownerSubject)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/** Week-scoped supersede: a fresh resolve makes every OTHER pending plan for
 *  the same (subject, local calendar week) obsolete — hard-delete them,
 *  consistent with the no-diff and expiry-sweep cleanups. Week identity is the
 *  [Mon 00:00, next Mon) week in `tz` containing window_start, NOT the exact
 *  (start,end) pair: a mid-week replan legitimately narrows window_start to
 *  "now" so the solver can't place into the past, and exact-pair identity left
 *  the Mon-anchored sibling pending — the accept page then showed the same week
 *  twice ("Week of Mon 27" AND "Week of Wed 29"). A window spanning several
 *  weeks buckets by its start week only. Committed rows are never touched
 *  (plan_hash is a content hash, so a post-commit no-op replan can reproduce a
 *  committed row's hash — same guard rationale as deleteProposedPlan). The
 *  keepPlanHash guard protects the ON CONFLICT re-arm case where the "new"
 *  plan reuses an existing row. Returns the number of superseded rows. */
export async function supersedeOtherPendingPlansForWeek(
  db: D1Database,
  subject: string,
  windowStart: string,
  tz: string,
  keepPlanHash: string,
): Promise<number> {
  // window_start strings mix formats (Z vs +10:00 offsets), so the week bucket
  // can't be computed in SQL — select the subject's pending rows and bucket here.
  const weekStart = localWeekWindow(windowStart, tz).start;
  const rs = await db
    .prepare(
      `SELECT plan_hash, body, window_start FROM proposed_plans
        WHERE subject = ? AND committed_at IS NULL AND plan_hash != ?`,
    )
    .bind(subject, keepPlanHash)
    .all<{ plan_hash: string; body: string; window_start: string | null }>();
  const doomed: string[] = [];
  for (const r of rs.results ?? []) {
    const ws = r.window_start
      ?? (JSON.parse(r.body) as { window?: { start?: string } }).window?.start;
    if (!ws) continue; // no identifiable window → leave for the expiry sweep
    if (weekBucketMatches(ws, tz, weekStart)) doomed.push(r.plan_hash);
  }
  if (doomed.length === 0) return 0;
  const res = await db
    .prepare(
      `DELETE FROM proposed_plans
        WHERE subject = ? AND committed_at IS NULL
          AND plan_hash IN (${doomed.map(() => "?").join(",")})`,
    )
    .bind(subject, ...doomed)
    .run();
  return res.meta?.changes ?? 0;
}

// Owner-scoped for the same reason: the commit path may only flip a plan the
// caller owns. Returns true iff an owned row was updated.
export async function markProposedPlanCommitted(
  db: D1Database,
  planHash: string,
  committedAt: string,
  ownerSubject: string,
): Promise<boolean> {
  const res = await db
    .prepare("UPDATE proposed_plans SET committed_at = ? WHERE plan_hash = ? AND subject = ?")
    .bind(committedAt, planHash, ownerSubject)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/** Bound (but not yet run) commit-mark UPDATE, so commitPlan can land committed_at
 *  in the SAME atomic db.batch as the task commit/drop UPDATEs (X3). Identical
 *  predicate to markProposedPlanCommitted; inspect the batch result's meta.changes
 *  for the 0-row (foreign / already-marked) case. */
export function markProposedPlanCommittedStmt(
  db: D1Database,
  planHash: string,
  committedAt: string,
  ownerSubject: string,
): D1PreparedStatement {
  return db
    .prepare("UPDATE proposed_plans SET committed_at = ? WHERE plan_hash = ? AND subject = ?")
    .bind(committedAt, planHash, ownerSubject);
}

/** @deprecated Global, cross-tenant. Do NOT use for owned reads — use
 *  getLatestCommittedPlanForSubject. Retained only until all callers migrate. */
export async function getLatestCommittedPlan(db: D1Database): Promise<ProposedPlanRow | null> {
  const row = await db
    .prepare(
      "SELECT plan_hash, body, subject, created_at, expires_at, committed_at, render_snapshot FROM proposed_plans WHERE committed_at IS NOT NULL ORDER BY committed_at DESC LIMIT 1",
    )
    .first<RawRow>();
  return row ? rowFromRaw(row) : null;
}

export async function getLatestCommittedPlanForSubject(
  db: D1Database,
  subject: string,
): Promise<ProposedPlanRow | null> {
  const row = await db
    .prepare(
      "SELECT plan_hash, body, subject, created_at, expires_at, committed_at, render_snapshot FROM proposed_plans WHERE committed_at IS NOT NULL AND subject = ? ORDER BY committed_at DESC LIMIT 1",
    )
    .bind(subject)
    .first<RawRow>();
  return row ? rowFromRaw(row) : null;
}

/**
 * The committed plans for a subject, newest-committed first, capped at 16. Replaces
 * the single-latest lookup on the manual-move write-back path: a dragged chunk may
 * belong to an OLDER committed week (X5), so the write-back must scan, not just take
 * the most recent. 16 weeks of forward horizon bounds the work even for a pathological
 * history. The caller drops fully-elapsed windows (their churn baseline is never
 * consulted again). See internal design notes.
 */
export async function getCommittedPlansForSubject(
  db: D1Database,
  subject: string,
): Promise<ProposedPlanRow[]> {
  const rs = await db
    .prepare(
      "SELECT plan_hash, body, subject, created_at, expires_at, committed_at, render_snapshot FROM proposed_plans WHERE committed_at IS NOT NULL AND subject = ? ORDER BY committed_at DESC LIMIT 16",
    )
    .bind(subject)
    .all<RawRow>();
  return (rs.results ?? []).map(rowFromRaw);
}

/**
 * The last accepted (committed) plan for the same local calendar week as
 * `windowStart` (the [Mon 00:00, next Mon) week in `tz`, via localWeekWindow),
 * or null when the subject has no committed plan for that week. Week identity,
 * not the exact (start,end) pair, for the same reason as
 * supersedeOtherPendingPlansForWeek: a mid-week replan narrows window_start to
 * "now", and exact-pair matching misses the committed Mon-anchored plan.
 *
 * `tz` must be the tz that PRODUCED the window — env.SCHEDULER_TZ for every
 * caller today (webhook, cron, accept, resolve). Bucketing in a user's home_tz
 * instead splits the week: a Sydney week straddles two UTC weeks, so a
 * UTC-home_tz user's mid-week resolve lands in the UTC week after its own
 * Mon-anchored plan's and misses it entirely. See the internal backlog follow-up
 * for what a real home_tz migration would have to move in one go.
 *
 * Both week baselines read this one lookup — drops (below) and churn
 * (resolve-internal) — so they can never select different plans for the same
 * week. Churn used to take the globally-latest committed plan instead, and a
 * newer plan for ANOTHER week emptied the baseline (an internal issue, prod
 * 2026-08-25).
 *
 * The week bucket is tz-dependent, but its BOUNDS are instants, so the range
 * IS expressible in SQL. Filtering a recency-ordered scan instead would be
 * wrong at prod scale: one subject has 245 committed rows whose 16 newest span
 * 3 days and 2 weeks, so any week outside that slice would silently read as
 * "no plan". datetime() normalization is required on both sides — stored
 * window_start strings mix Z and +HH:MM offset forms (see
 * supersedeOtherPendingPlansForWeek), and raw string comparison would order
 * them wrongly; datetime() parses both to a UTC instant. Rows with a NULL
 * window_start are excluded: insert always populates it and migration 0027
 * backfilled the pre-existing rows.
 *
 * Note that datetime(window_start) is not sargable — plans_subject_window
 * prefilters by subject and the date comparison runs as a per-row residual,
 * which is fine at current row counts (see the internal backlog note on the
 * expression index that would restore the seek). The JS bucket check below is
 * a second opinion, not a strictly stronger one: for the Z and +HH:MM forms
 * every producer writes, SQL and JS agree exactly, but a zoneless string is
 * read as UTC by SQLite and as engine-local by Date.parse, so the two layers
 * can disagree on that form alone.
 */
export async function getCommittedPlanForWeek(
  db: D1Database,
  subject: string,
  windowStart: string,
  tz: string,
): Promise<ProposedPlanRow | null> {
  const week = localWeekWindow(windowStart, tz);
  const rs = await db
    .prepare(
      `SELECT plan_hash, body, subject, created_at, expires_at, committed_at, render_snapshot, window_start, window_end
         FROM proposed_plans
        WHERE subject = ? AND committed_at IS NOT NULL AND window_start IS NOT NULL
          AND datetime(window_start) >= datetime(?)
          AND datetime(window_start) < datetime(?)
        ORDER BY committed_at DESC
        LIMIT 16`,
    )
    .bind(subject, week.start, week.end)
    .all<RawRow>();
  for (const raw of rs.results ?? []) {
    const row = rowFromRaw(raw);
    if (row.window_start && weekBucketMatches(row.window_start, tz, week.start)) return row;
  }
  return null;
}

/**
 * The `dropped` list of that week's committed plan, or `[]` when there is
 * none. This is the diff baseline for drops: a task already dropped in the
 * last accepted plan and still dropped is not a change worth re-emailing
 * (2026-07-07 incident) — only a NEWLY dropped task is.
 */
export async function getCommittedDroppedForWeek(
  db: D1Database,
  subject: string,
  windowStart: string,
  tz: string,
): Promise<DroppedEntry[]> {
  const plan = await getCommittedPlanForWeek(db, subject, windowStart, tz);
  return (plan?.body.dropped ?? []) as DroppedEntry[];
}

export async function getLatestProposedPlanForSubject(
  db: D1Database,
  subject: string,
  now: Date,
): Promise<ProposedPlanRow | null> {
  const row = await db
    .prepare(
      `SELECT plan_hash, body, subject, created_at, expires_at, committed_at, render_snapshot
         FROM proposed_plans
        WHERE subject = ? AND committed_at IS NULL AND expires_at >= ?
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .bind(subject, now.toISOString())
    .first<RawRow>();
  return row ? rowFromRaw(row) : null;
}

/** All pending (non-committed, non-expired) plans for the subject, newest
 *  first. Post-supersede this is at most one per window; the accept page still
 *  defensively groups by window. LIMIT 50 mirrors the covering query's bound
 *  (getLatestProposedPlanForSubjectCovering, below). */
export async function getPendingPlansForSubject(
  db: D1Database,
  subject: string,
  now: Date,
): Promise<ProposedPlanRow[]> {
  const rs = await db
    .prepare(
      `SELECT plan_hash, body, subject, created_at, expires_at, committed_at, render_snapshot, window_start, window_end
         FROM proposed_plans
        WHERE subject = ? AND committed_at IS NULL AND expires_at >= ?
        ORDER BY created_at DESC
        LIMIT 50`,
    )
    .bind(subject, now.toISOString())
    .all<RawRow>();
  return (rs.results ?? []).map(rowFromRaw);
}

/**
 * The newest non-committed, non-expired plan for the subject whose window
 * COVERS the given instant. Unlike getLatestProposedPlanForSubject (which is a
 * pure recency query and thus a moving target while other weeks resolve), this
 * deterministically selects the plan for the week containing `instant` — used
 * by the webhook smoke to read back the replan it triggered, immune to
 * unrelated background resolves. Scans recent rows and compares parsed
 * instants (window.start/end formats vary), returning the most-recent match.
 */
export async function getLatestProposedPlanForSubjectCovering(
  db: D1Database,
  subject: string,
  now: Date,
  instant: Date,
): Promise<ProposedPlanRow | null> {
  const rs = await db
    .prepare(
      `SELECT plan_hash, body, subject, created_at, expires_at, committed_at, render_snapshot
         FROM proposed_plans
        WHERE subject = ? AND committed_at IS NULL AND expires_at >= ?
        ORDER BY created_at DESC
        LIMIT 50`,
    )
    .bind(subject, now.toISOString())
    .all<RawRow>();
  const ms = instant.getTime();
  for (const raw of rs.results ?? []) {
    const row = rowFromRaw(raw);
    const w = row.body.window as { start: string; end: string } | undefined;
    if (!w) continue;
    const start = Date.parse(w.start);
    const end = Date.parse(w.end);
    if (Number.isFinite(start) && Number.isFinite(end) && start <= ms && ms < end) {
      return row;
    }
  }
  return null;
}

export async function attachRenderSnapshot(
  db: D1Database,
  planHash: string,
  snapshot: unknown,
): Promise<void> {
  await db
    .prepare("UPDATE proposed_plans SET render_snapshot = ? WHERE plan_hash = ?")
    .bind(JSON.stringify(snapshot), planHash)
    .run();
}

/** Overwrite a committed plan's body. Used by the manual-move write-back to keep
 *  the churn baseline (the latest committed plan's schedule) in sync with events
 *  the user has hand-dragged on the calendar. Owner-scoped and committed-only for
 *  isolation parity with the other updaters; returns true iff an owned committed
 *  row was updated. */
export async function updateCommittedPlanBody(
  db: D1Database,
  planHash: string,
  ownerSubject: string,
  body: Record<string, unknown>,
): Promise<boolean> {
  const res = await updateCommittedPlanBodyStmt(db, planHash, ownerSubject, body).run();
  return (res.meta?.changes ?? 0) > 0;
}

/** Bound (but not yet run) committed-plan body UPDATE. Lets the webhook
 *  manual-move write-back batch this atomically with the task re-stamp (X4).
 *  Leaves window_start/window_end untouched: they denormalize body.window,
 *  which is invariant for a committed plan — re-derive them here if the
 *  window ever becomes mutable. */
export function updateCommittedPlanBodyStmt(
  db: D1Database,
  planHash: string,
  ownerSubject: string,
  body: Record<string, unknown>,
): D1PreparedStatement {
  return db
    .prepare(
      "UPDATE proposed_plans SET body = ? WHERE plan_hash = ? AND subject = ? AND committed_at IS NOT NULL",
    )
    .bind(JSON.stringify(body), planHash, ownerSubject);
}
