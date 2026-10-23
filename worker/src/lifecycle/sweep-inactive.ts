import type { Env } from "../env";
import { offboardUser, type OffboardOptions } from "./offboard";
import { writeAudit } from "../db/audit";
import { systemMailer, type SystemMailer } from "../mail/system-mailer";
import { retentionDeletedEmail, retentionWarningEmail } from "../mail/lifecycle-templates";
import { parsePurgeDays, purgeDeletedAccounts } from "./purge-deleted";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Days between the retention warning and the deletion it announces. */
export const RETENTION_WARNING_LEAD_DAYS = 14;

// Parse RETENTION_DAYS to a positive integer, else null (→ strict no-op).
function parseRetentionDays(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/** Idle days after which the warning goes out: R - 14, so deletion lands at
 *  about R days idle. With R <= 14 there is no room for a 14-day lead, so warn
 *  once the user has been idle a full day (deletion then follows 14 days after
 *  the warning, i.e. at ~15 days idle rather than R). */
export function warnAfterDays(retentionDays: number): number {
  return Math.max(retentionDays - RETENTION_WARNING_LEAD_DAYS, 1);
}

function startOfUtcDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export interface SweepOptions extends OffboardOptions {
  // Test seam: the first-party sender. Defaults to systemMailer(env).
  mailer?: SystemMailer;
}

// The daily lifecycle sweep: the retention sweep below (only when
// RETENTION_DAYS is a positive integer), then the purge window
// (purge-deleted.ts, only when DELETED_ACCOUNT_RETENTION_DAYS is a positive
// integer). The two are independent: an operator offboard or a self-serve
// delete starts the purge window too. Returns the subjects the retention
// sweep offboarded this run.
export async function sweepInactiveUsers(
  env: Env,
  now: Date = new Date(),
  opts: SweepOptions = {},
): Promise<string[]> {
  const days = parseRetentionDays(env.RETENTION_DAYS);
  const swept = days === null ? [] : await retentionSweep(env, now, days, opts);
  try {
    await purgeDeletedAccounts(env, now);
  } catch (e) {
    console.error("sweepInactiveUsers: purge failed", { error: String(e) });
  }
  return swept;
}

// Retention sweep (Plan 6 brief C, hosted-trial O10b). Runs ONLY when
// RETENTION_DAYS (R) parses to a positive integer.
// Users with a NULL last_seen are NEVER touched (unknown activity is not
// staleness). Two phases, both over ACTIVE users only:
//
//   1. Warn: last_seen older than warnAfterDays(R) and not yet warned. Send the
//      deletion warning through the first-party SystemMailer and stamp
//      users.retention_warned_at = now on success. A failed send leaves no
//      stamp (retried next run, so a user is never deleted unwarned while mail
//      is on). With SYSTEM_MAIL_ENABLED off, stamp without sending and log
//      retention_warning_unsent, so mail-less deployments still delete, 14 days
//      later than the plain R rule.
//   2. Delete: last_seen older than R days AND warned on a UTC date at least 14
//      days before today's. UTC-day granularity, so the deletion date the
//      warning names (UTC date of warning + 14 d) is the day the daily sweep
//      deletes, despite cron-time jitter. After each offboard, send a
//      best-effort deletion notice.
//
// Any activity (sign-in, or the last_seen bump on authenticated use) clears the
// stamp, which cancels the pending deletion, even mid-sweep: phase 2 re-checks
// its predicate per user right before offboarding (retention_delete_raced). Each offboard is audited under
// actor 'cron-sweep', source 'cron' (on top of offboardUser's own audit); each
// warning stamp as 'retention_warned'.
//
// Unwarnable users (decision E): a user whose warning never sends is never
// deleted (phase 2 needs the stamp). After phase 1 the sweep logs one
// `retention_unwarnable {count}` line: active users idle past R with no
// stamp. warn level when count > 0 (alert on it), info at 0. Never an
// address; `bin/optical-admin.py list-users` flags the same rows
// (overdue_unwarned). Returns the subjects it offboarded.
async function retentionSweep(
  env: Env,
  now: Date,
  days: number,
  opts: SweepOptions,
): Promise<string[]> {
  const { mailer: injectedMailer, ...offboardOpts } = opts;
  const mailer = injectedMailer ?? systemMailer(env);
  const mailEnabled = env.SYSTEM_MAIL_ENABLED === "true";
  const nowIso = now.toISOString();

  // Phase 1: warn.
  const warnCutoffIso = new Date(now.getTime() - warnAfterDays(days) * MS_PER_DAY).toISOString();
  const toWarn = await env.DB
    .prepare(
      `SELECT subject FROM users
        WHERE is_active = 1 AND last_seen IS NOT NULL AND last_seen < ?
          AND retention_warned_at IS NULL`,
    )
    .bind(warnCutoffIso)
    .all<{ subject: string }>();
  const deletionDate = new Date(now.getTime() + RETENTION_WARNING_LEAD_DAYS * MS_PER_DAY);
  for (const { subject } of toWarn.results ?? []) {
    try {
      if (mailEnabled) {
        const mail = retentionWarningEmail({
          deletionDate,
          retentionDays: days,
          deploymentLabel: env.DEPLOYMENT_LABEL,
        });
        const { ok } = await mailer.send({ to: subject, ...mail });
        if (!ok) continue; // no stamp: retry next run (the mailer logged why)
      } else {
        // Never the address: the subject is the user's email.
        console.warn("retention_warning_unsent", { reason: "system_mail_disabled" });
      }
      // Send before stamping: claiming the stamp first risks deleting an
      // unwarned user if the send fails and the release write fails too.
      // Re-check idleness in the UPDATE: activity between the SELECT and here
      // must not be stamped as a warning.
      const res = await env.DB
        .prepare(
          `UPDATE users SET retention_warned_at = ?
            WHERE subject = ? AND is_active = 1 AND retention_warned_at IS NULL
              AND last_seen IS NOT NULL AND last_seen < ?`,
        )
        .bind(nowIso, subject, warnCutoffIso)
        .run();
      if ((res.meta?.changes ?? 0) !== 1) {
        // Activity (or another sweep) won the race: no stamp, so no audit row.
        // No subject: it is the user's email address.
        console.warn("retention_warning_raced");
        continue;
      }
      await writeAudit(env.DB, { subject, actor: "cron-sweep", action: "retention_warned", source: "cron" });
    } catch (e) {
      // One user's failure must not abort the rest of the sweep.
      // No subject: it is the user's email address.
      console.error("sweepInactiveUsers: warn failed", { error: String(e) });
    }
  }

  const idleCutoffIso = new Date(now.getTime() - days * MS_PER_DAY).toISOString();

  // Operator alert: idle past R, still unwarned after phase 1.
  try {
    const stuck = await env.DB
      .prepare(
        `SELECT COUNT(*) AS n FROM users
          WHERE is_active = 1 AND last_seen IS NOT NULL AND last_seen < ?
            AND retention_warned_at IS NULL`,
      )
      .bind(idleCutoffIso)
      .first<{ n: number }>();
    const count = stuck?.n ?? 0;
    (count > 0 ? console.warn : console.log)("retention_unwarnable", { count });
  } catch (e) {
    console.error("sweepInactiveUsers: unwarnable count failed", { error: String(e) });
  }

  // Phase 2: delete.
  // Warned on a UTC date <= today - 14  ⇔  warned_at < start of (today - 13).
  const warnedCutoffIso = new Date(
    startOfUtcDay(now) - (RETENTION_WARNING_LEAD_DAYS - 1) * MS_PER_DAY,
  ).toISOString();
  const deletePredicate = `is_active = 1 AND last_seen IS NOT NULL AND last_seen < ?
          AND retention_warned_at IS NOT NULL AND retention_warned_at < ?`;
  const r = await env.DB
    .prepare(`SELECT subject FROM users WHERE ${deletePredicate}`)
    .bind(idleCutoffIso, warnedCutoffIso)
    .all<{ subject: string }>();
  const stale = (r.results ?? []).map((row) => row.subject);

  const swept: string[] = [];
  for (const subject of stale) {
    try {
      // `stale` was read once, and offboarding earlier users takes a while
      // (calendar sweep, upstream revoke), so re-run the predicate for this
      // subject right before deleting: activity since the SELECT (which
      // clears the warning stamp and bumps last_seen) cancels the deletion.
      // A residual window remains between this re-check and offboardUser's
      // D1 batch; closing it needs the predicate inside that batch.
      const still = await env.DB
        .prepare(`SELECT 1 AS one FROM users WHERE subject = ? AND ${deletePredicate}`)
        .bind(subject, idleCutoffIso, warnedCutoffIso)
        .first<{ one: number }>();
      if (!still) {
        // No subject: it is the user's email address.
        console.warn("retention_delete_raced");
        continue;
      }
      await offboardUser(env, subject, "cron-sweep", { ...offboardOpts, auditSource: "cron" });
      await writeAudit(env.DB, {
        subject,
        actor: "cron-sweep",
        action: "sweep_offboard",
        source: "cron",
      });
      swept.push(subject);
    } catch (e) {
      // One user's failure must not abort the rest of the sweep.
      console.error("sweepInactiveUsers: offboard failed", { subject, error: String(e) });
      continue;
    }
    // Best-effort: the mailer never throws and logs its own failures; a lost
    // notice never undoes or blocks the offboard.
    await mailer.send({
      to: subject,
      ...retentionDeletedEmail({
        retentionDays: days,
        purgeAfterDays: parsePurgeDays(env.DELETED_ACCOUNT_RETENTION_DAYS),
        deploymentLabel: env.DEPLOYMENT_LABEL,
      }),
    });
  }
  return swept;
}
