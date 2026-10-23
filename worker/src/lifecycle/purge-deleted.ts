import type { Env } from "../env";
import { hashingKey } from "../auth/crypto-keys";
import { keyedSubjectMac } from "../util/log-redact";
import { writeAudit } from "../db/audit";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** DELETED_ACCOUNT_RETENTION_DAYS as a positive integer, else null: unset,
 *  empty, "0", negative or non-integer all mean keep indefinitely. */
export function parsePurgeDays(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/** The stable, non-reversible stand-in for a purged subject in audit_log:
 *  "deleted:" + HMAC-SHA256(hashingKey, "audit-pseudonym:" + subject), hex.
 *  Keyed, so it can't be recomputed from a guessed address without the
 *  deployment's key; stable, so one subject's rows still group together.
 *  Throws (crypto_key_missing) when the deployment has no hashing key. */
export async function auditPseudonym(env: Env, subject: string): Promise<string> {
  return `deleted:${await keyedSubjectMac(env, "audit-pseudonym:", subject)}`;
}

// Purge window (hosted-trial decision F). When DELETED_ACCOUNT_RETENTION_DAYS
// (N) is a positive integer, delete every users row that has been deactivated
// (offboarded) for MORE than N days, and in the same D1 batch replace that
// subject in audit_log.subject and audit_log.actor with auditPseudonym. Audit
// rows are otherwise left intact (id, action, table_name, source, created_at),
// and the purge itself is audited as 'account_purged' under the pseudonym.
//
// Only is_active = 0 rows are ever touched; every reactivation path clears
// deactivated_at, and the DELETE re-checks the predicate inside the batch, so
// a user who signs back in between the SELECT and the batch is not purged
// (the audit UPDATEs are guarded on the users row being gone). A later
// sign-in after a purge simply creates a fresh row.
//
// Rows deactivated before migration 0043 have deactivated_at NULL. They are
// stamped with `now` by the first run that has N set, so they are purged N
// days after that run: their real offboard time isn't recorded reliably
// (audit writes are best-effort), and a flag flip must never mass-delete rows
// at once with no window for the operator to notice.
//
// Fails closed: without a hashing key nothing is deleted (a row is never
// purged without its audit trail being pseudonymised). Logs counts only,
// never an address. Returns the number of rows purged.
export async function purgeDeletedAccounts(env: Env, now: Date = new Date()): Promise<number> {
  const days = parsePurgeDays(env.DELETED_ACCOUNT_RETENTION_DAYS);
  if (days === null) return 0;
  try {
    hashingKey(env);
  } catch {
    console.error("deleted_account_purge_skipped", { reason: "crypto_key_missing" });
    return 0;
  }

  const nowIso = now.toISOString();
  await env.DB
    .prepare(`UPDATE users SET deactivated_at = ? WHERE is_active = 0 AND deactivated_at IS NULL`)
    .bind(nowIso)
    .run();

  const cutoffIso = new Date(now.getTime() - days * MS_PER_DAY).toISOString();
  const predicate = `is_active = 0 AND deactivated_at IS NOT NULL AND deactivated_at < ?`;
  const due = await env.DB
    .prepare(`SELECT subject FROM users WHERE ${predicate}`)
    .bind(cutoffIso)
    .all<{ subject: string }>();

  let purged = 0;
  for (const { subject } of due.results ?? []) {
    try {
      const pseudonym = await auditPseudonym(env, subject);
      const gone = `NOT EXISTS (SELECT 1 FROM users WHERE subject = ?)`;
      const [del] = await env.DB.batch([
        env.DB.prepare(`DELETE FROM users WHERE subject = ? AND ${predicate}`).bind(subject, cutoffIso),
        env.DB.prepare(`UPDATE audit_log SET subject = ? WHERE subject = ? AND ${gone}`).bind(pseudonym, subject, subject),
        env.DB.prepare(`UPDATE audit_log SET actor = ? WHERE actor = ? AND ${gone}`).bind(pseudonym, subject, subject),
      ]);
      if ((del?.meta?.changes ?? 0) !== 1) {
        // Reactivated since the SELECT. No subject: it is the email address.
        console.warn("deleted_account_purge_raced");
        continue;
      }
      purged++;
      await writeAudit(env.DB, { subject: pseudonym, actor: "cron-sweep", action: "account_purged", source: "cron" }, nowIso);
    } catch (e) {
      // One row's failure must not abort the rest. No subject in the log.
      console.error("deleted_account_purge_failed", { error: String(e) });
    }
  }
  console.log("deleted_accounts_purged", { count: purged });
  return purged;
}
