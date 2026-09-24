export interface CleanupResult {
  deleted: number;
}

export async function runCleanupExpiredPlans(db: D1Database, now: Date): Promise<CleanupResult> {
  const nowIso = now.toISOString();
  const r = await db
    .prepare("DELETE FROM proposed_plans WHERE expires_at < ? AND committed_at IS NULL")
    .bind(nowIso)
    .run();
  const meta = (r as unknown as { meta?: { changes?: number } }).meta ?? {};
  return { deleted: meta.changes ?? 0 };
}
