import { materialiseTemplate, type TemplateRow, type NewTaskInsert } from "./materialise";

export interface SweepResult {
  created: number;
}

/**
 * Pre-solve sweep. For every active template OWNED BY `ownerSubject`, materialise
 * concrete tasks for occurrences inside [windowStart, windowEnd) that don't
 * already have an instance (matched by template_id + the immutable occurrence_date
 * column) and aren't on the EXDATE skip list (template_exclusions). The INSERT uses
 * INSERT OR IGNORE against the tasks(owner_subject, template_id, occurrence_date)
 * UNIQUE index so concurrent sweeps can't double-create. Reads and the INSERT are
 * owner-scoped so a sweep for one user can never see or create another user's
 * rows; fails closed on an empty owner.
 */
export async function runRecurrenceSweep(
  db: D1Database,
  ownerSubject: string,
  windowStart: string,
  windowEnd: string,
  homeTz: string,
): Promise<SweepResult> {
  if (!ownerSubject) throw new Error("owner_scope_missing");

  // active_from/active_until live in body and are read by materialiseTemplate from
  // the parsed body, so the row only needs id + body here.
  const tplRows = await db
    .prepare("SELECT id, body FROM task_templates WHERE owner_subject = ?")
    .bind(ownerSubject)
    .all<{ id: string; body: string }>();

  // Existing occurrences: read the immutable occurrence_date column directly — no
  // body parsing, no instant-date reconstruction (that was RC1).
  const existing = await db
    .prepare("SELECT template_id, occurrence_date FROM tasks WHERE template_id IS NOT NULL AND occurrence_date IS NOT NULL AND owner_subject = ?")
    .bind(ownerSubject)
    .all<{ template_id: string; occurrence_date: string }>();

  // EXDATE skip list: occurrences the user deleted must not be re-materialised.
  const excluded = await db
    .prepare("SELECT template_id, occurrence_date FROM template_exclusions WHERE owner_subject = ?")
    .bind(ownerSubject)
    .all<{ template_id: string; occurrence_date: string }>();

  const occurrencesByTemplate = new Map<string, Set<string>>();
  for (const row of existing.results ?? []) {
    let set = occurrencesByTemplate.get(row.template_id);
    if (!set) { set = new Set(); occurrencesByTemplate.set(row.template_id, set); }
    set.add(row.occurrence_date);
  }

  const exclusionsByTemplate = new Map<string, Set<string>>();
  for (const row of excluded.results ?? []) {
    let set = exclusionsByTemplate.get(row.template_id);
    if (!set) { set = new Set(); exclusionsByTemplate.set(row.template_id, set); }
    set.add(row.occurrence_date);
  }

  const inserts: NewTaskInsert[] = [];
  for (const row of tplRows.results ?? []) {
    const tpl: TemplateRow = { id: row.id, body: JSON.parse(row.body) };
    const existingDates = occurrencesByTemplate.get(row.id) ?? new Set<string>();
    const excludedDates = exclusionsByTemplate.get(row.id) ?? new Set<string>();
    const newRows = materialiseTemplate(tpl, windowStart, windowEnd, existingDates, homeTz, excludedDates);
    inserts.push(...newRows);
  }

  let created = 0;
  if (inserts.length > 0) {
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO tasks (id, owner_subject, body, template_id, project_id, status, created_at, updated_at, occurrence_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const batch = inserts.map((r) =>
      stmt.bind(r.id, ownerSubject, JSON.stringify(r.body), r.template_id, r.project_id, r.status, r.created_at, r.updated_at, r.occurrence_date),
    );
    const results = await db.batch(batch);
    // INSERT OR IGNORE: a row absorbed by the UNIQUE constraint reports changes=0.
    created = results.reduce((n, res) => n + (res.meta.changes ?? 0), 0);
  }

  return { created };
}
