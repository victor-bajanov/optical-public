import type { Env } from "../env";
import { offboardUser, type OffboardOptions } from "./offboard";
import { writeAudit } from "../db/audit";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Parse RETENTION_DAYS to a positive integer, else null (→ strict no-op).
function parseRetentionDays(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// Plan 6 brief C: offboard ACTIVE users idle longer than RETENTION_DAYS.
// Runs ONLY when RETENTION_DAYS parses to a positive integer; otherwise a strict
// no-op. Users with a NULL last_seen are NEVER swept (unknown activity is not
// staleness). Each offboard is audited under actor 'cron-sweep', source 'cron'
// (in addition to offboardUser's own audit). Returns the subjects it offboarded.
export async function sweepInactiveUsers(
  env: Env,
  now: Date = new Date(),
  opts: OffboardOptions = {},
): Promise<string[]> {
  const days = parseRetentionDays(env.RETENTION_DAYS);
  if (days === null) return [];

  const cutoffIso = new Date(now.getTime() - days * MS_PER_DAY).toISOString();
  const r = await env.DB
    .prepare(
      "SELECT subject FROM users WHERE is_active = 1 AND last_seen IS NOT NULL AND last_seen < ?",
    )
    .bind(cutoffIso)
    .all<{ subject: string }>();
  const stale = (r.results ?? []).map((row) => row.subject);

  const swept: string[] = [];
  for (const subject of stale) {
    try {
      await offboardUser(env, subject, "cron-sweep", { ...opts, auditSource: "cron" });
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
    }
  }
  return swept;
}
