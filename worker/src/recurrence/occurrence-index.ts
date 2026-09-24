/**
 * Single source of truth for the recurrence occurrence UNIQUE index DDL.
 *
 * This index is NOT shipped as a committed migrations/*.sql file: deploy.sh
 * applies the entire migrations folder in one shot, and this index cannot be
 * created over the duplicated rows that exist in prod today. Instead
 * bin/backfill-occurrence-date.py dedups, then writes migrations/0022_*.sql with
 * this exact DDL and applies it via `wrangler d1 migrations apply` (so the folder
 * and wrangler's applied-migrations metadata stay consistent).
 *
 * The Python backfill script carries a byte-identical copy of this string;
 * keep the two in sync (there is a guard test asserting the wording).
 */
export const OCCURRENCE_UNIQUE_INDEX_NAME = "tasks_template_occurrence";

export const OCCURRENCE_UNIQUE_INDEX_DDL =
  `CREATE UNIQUE INDEX ${OCCURRENCE_UNIQUE_INDEX_NAME} ON tasks(owner_subject, template_id, occurrence_date);`;
