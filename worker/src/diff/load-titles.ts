export async function loadTitleMap(
  db: D1Database,
  ownerSubject: string,
  ids: string[],
): Promise<Record<string, string>> {
  if (!ownerSubject) throw new Error("owner_scope_missing");
  const out: Record<string, string> = {};
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => "?").join(",");
  const r = await db
    .prepare(`SELECT id, body FROM tasks WHERE id IN (${placeholders}) AND owner_subject = ?`)
    .bind(...ids, ownerSubject)
    .all<{ id: string; body: string }>();
  for (const row of r.results ?? []) {
    const parsed = JSON.parse(row.body) as { title?: string };
    if (parsed.title) out[row.id] = parsed.title;
  }
  return out;
}
