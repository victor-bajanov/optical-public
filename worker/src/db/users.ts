import { canonicalZoneName } from "../schema/common";
export type UserRole = "admin" | "member";

export interface UserRow {
  subject: string;
  role: UserRole;
  is_active: number;
  last_seen: string | null;
  created_at: string;
  home_tz: string | null;
  done_color_id: string | null;
}

// Insert-or-keep. On first sight, seed the row with the given role (default
// 'member'). On re-upsert WITHOUT a role, leave the existing role untouched so a
// later plain auth never downgrades an admin. Reactivates a previously
// offboarded subject (is_active -> 1).
export async function upsertUser(
  db: D1Database,
  subject: string,
  role?: UserRole,
  now: string = new Date().toISOString(),
): Promise<void> {
  if (role) {
    await db
      .prepare(
        `INSERT INTO users (subject, role, is_active, created_at) VALUES (?, ?, 1, ?)
         ON CONFLICT(subject) DO UPDATE SET role = excluded.role, is_active = 1`,
      )
      .bind(subject, role, now)
      .run();
    return;
  }
  await db
    .prepare(
      `INSERT INTO users (subject, role, is_active, created_at) VALUES (?, 'member', 1, ?)
       ON CONFLICT(subject) DO UPDATE SET is_active = 1`,
    )
    .bind(subject, now)
    .run();
}

// Record activity. Creates the row (member, active) if missing; otherwise sets
// last_seen and reactivates. Never changes role.
export async function touchLastSeen(
  db: D1Database,
  subject: string,
  now: string = new Date().toISOString(),
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO users (subject, role, is_active, last_seen, created_at) VALUES (?, 'member', 1, ?, ?)
       ON CONFLICT(subject) DO UPDATE SET last_seen = excluded.last_seen, is_active = 1`,
    )
    .bind(subject, now, now)
    .run();
}

export async function listActiveSubjects(db: D1Database): Promise<string[]> {
  const r = await db
    .prepare(`SELECT subject FROM users WHERE is_active = 1 ORDER BY last_seen DESC`)
    .all<{ subject: string }>();
  return r.results.map((x) => x.subject);
}

export async function deactivateUser(db: D1Database, subject: string): Promise<void> {
  await db.prepare(`UPDATE users SET is_active = 0 WHERE subject = ?`).bind(subject).run();
}

export async function getUser(db: D1Database, subject: string): Promise<UserRow | null> {
  const row = await db
    .prepare(`SELECT subject, role, is_active, last_seen, created_at, home_tz, done_color_id FROM users WHERE subject = ?`)
    .bind(subject)
    .first<UserRow>();
  return row ?? null;
}

// Per-user timezone (Plan 6 brief B). The user's home_tz if set, else the
// instance default schedulerTz. Threaded into the resolve path wherever
// SCHEDULER_TZ was read directly. Callers pass db and env.SCHEDULER_TZ
// directly so this function stays at the db layer (no Env coupling).
export async function getHomeTz(db: D1Database, subject: string, schedulerTz: string): Promise<string> {
  const user = await getUser(db, subject);
  return user?.home_tz ?? schedulerTz;
}

/** Canonical spelling of an IANA zone, as Intl resolves it, so
 *  "europe/london" is stored as "Europe/London". Throws RangeError for an
 *  unknown zone or a UTC offset, so neither can ever reach the users row. */
export function canonicalIanaZone(tz: string): string {
  return canonicalZoneName(tz);
}

/** Bound (not yet run) home_tz UPDATE, so the /v1/timezone handler can batch
 *  it atomically with the pending-plan delete. UPDATE-only: a config write
 *  never creates a users row (that would grant membership and add the subject
 *  to the active fan-out). `tz` must already be canonical, or null to clear. */
export function setHomeTzStmt(db: D1Database, subject: string, tz: string | null): D1PreparedStatement {
  return db.prepare(`UPDATE users SET home_tz = ? WHERE subject = ?`).bind(tz, subject);
}

/** Set the subject's home_tz (internal design notes, Card A) to the
 *  canonical zone name and return it, or null if the subject has no users row
 *  (nothing is written). Throws RangeError for an unknown zone. */
export async function setHomeTz(db: D1Database, subject: string, tz: string): Promise<string | null> {
  const canonical = canonicalIanaZone(tz);
  const res = await setHomeTzStmt(db, subject, canonical).run();
  return (res.meta?.changes ?? 0) > 0 ? canonical : null;
}

/** Clear the subject's home_tz so they inherit the instance SCHEDULER_TZ again.
 *  A no-op for a subject with no users row. */
export async function clearHomeTz(db: D1Database, subject: string): Promise<void> {
  await setHomeTzStmt(db, subject, null).run();
}

// Per-user done color id (task done-marking feature). The user's done_color_id
// if set, else the instance default envDefault (env.DONE_COLOR_ID). Callers
// pass db and env.DONE_COLOR_ID directly so this function stays at the db layer
// (no Env coupling).
//
// CONSTRAINT: the resolved color MUST NOT equal "5" — that is the color used
// when creating new scheduler events (createEvent default colorId). Using the
// same color for "done" and "created" events would make them visually
// indistinguishable. Throw if the resolved value is "5" to catch
// misconfiguration early.
// Seed done_color_id only if unset. Used to give Microsoft sign-ins a working
// done_color_id (Outlook has no numeric colorId, so the env-level
// DONE_COLOR_ID default is meaningless for them) without clobbering a value
// the user (or an earlier login) already set.
export async function seedDoneColorIdIfUnset(db: D1Database, subject: string, value: string): Promise<void> {
  await db
    .prepare(`UPDATE users SET done_color_id = ? WHERE subject = ? AND done_color_id IS NULL`)
    .bind(value, subject)
    .run();
}

export async function getDoneColorId(db: D1Database, subject: string, envDefault: string): Promise<string> {
  const user = await getUser(db, subject);
  const resolved = user?.done_color_id ?? envDefault;
  if (resolved === "5") {
    throw new Error(
      `getDoneColorId: resolved color "5" conflicts with the scheduler create color. ` +
        `Set DONE_COLOR_ID (or the user's done_color_id) to any value other than "5".`,
    );
  }
  return resolved;
}

/** Forget the user's done marker. It is provider-shaped (a Google colorId vs
 *  the Outlook "Optical Done" category), so an identity-provider switch clears
 *  it and the login callback re-seeds the new provider's default. */
export async function clearDoneColorId(db: D1Database, subject: string): Promise<void> {
  await db.prepare(`UPDATE users SET done_color_id = NULL WHERE subject = ?`).bind(subject).run();
}
