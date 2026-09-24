-- 0021_recurrence_occurrence_key.sql — immutable occurrence key for recurrence dedupe.
-- The UNIQUE index on tasks(owner_subject, template_id, occurrence_date) is NOT
-- created here: it cannot be applied against existing duplicated prod rows. It is
-- authored + applied by bin/backfill-occurrence-date.py at cutover (migration 0022).

ALTER TABLE tasks ADD COLUMN occurrence_date TEXT;

CREATE TABLE template_exclusions (
  owner_subject   TEXT NOT NULL,
  template_id     TEXT NOT NULL,
  occurrence_date TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  UNIQUE(owner_subject, template_id, occurrence_date)
);
