export type AuditSource = "cron" | "webhook" | "api" | "admin";

export interface AuditEntry {
  subject?: string | null;
  actor?: string | null;
  action: string;
  table_name?: string | null;
  source: AuditSource;
}

// Append-only audit write. Best-effort: a failed audit insert must NEVER break
// the caller's operation, so all errors are swallowed (and logged for ops).
export async function writeAudit(
  db: D1Database,
  entry: AuditEntry,
  now: string = new Date().toISOString(),
): Promise<void> {
  try {
    const id = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO audit_log (id, subject, actor, action, table_name, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        entry.subject ?? null,
        entry.actor ?? null,
        entry.action,
        entry.table_name ?? null,
        entry.source,
        now,
      )
      .run();
  } catch (e) {
    console.error("writeAudit failed", { action: entry.action, source: entry.source, error: String(e) });
  }
}
