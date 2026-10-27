export interface CleanupResult {
  /** Expired, never-committed plans deleted. */
  deleted: number;
  /** Committed plans whose third-party text was scrubbed this run. */
  scrubbed: number;
}

import { SCRUB_THIRD_PARTY_SET_SQL } from "../planning/proposed-plans";

// A committed plan's third-party text (render_snapshot, body.warnings; see
// SCRUB_THIRD_PARTY_SET_SQL) is scrubbed at acceptance, by the commit-mark
// UPDATE itself. This daily pass is the backfill. It catches rows committed
// before that build, and snapshots re-attached to an already-committed row
// afterwards: the webhook and Monday-cron paths call the unscoped
// attachRenderSnapshot, and a resolve can reproduce a committed plan's hash.
// body.schedule / body.dropped / window stay as the churn and drop baselines.
// Idempotent: a row with neither field is not touched.
const SCRUB_COMMITTED_SQL = `
UPDATE proposed_plans
   SET ${SCRUB_THIRD_PARTY_SET_SQL}
 WHERE committed_at IS NOT NULL
   AND (render_snapshot IS NOT NULL OR json_type(body, '$.warnings') IS NOT NULL)`;

function changes(r: unknown): number {
  return (r as { meta?: { changes?: number } }).meta?.changes ?? 0;
}

export async function runCleanupExpiredPlans(db: D1Database, now: Date): Promise<CleanupResult> {
  const nowIso = now.toISOString();
  const del = await db
    .prepare("DELETE FROM proposed_plans WHERE expires_at < ? AND committed_at IS NULL")
    .bind(nowIso)
    .run();
  const scrub = await db.prepare(SCRUB_COMMITTED_SQL).run();
  const result: CleanupResult = { deleted: changes(del), scrubbed: changes(scrub) };
  console.info("plans_cleanup", result);
  return result;
}
