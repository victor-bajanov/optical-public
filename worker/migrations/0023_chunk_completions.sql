-- 0023_chunk_completions.sql — durable per-chunk completion records.
-- A row means "this chunk's work is done". The source of truth for completion;
-- calendar color is only the trigger that creates/clears a row. See
-- internal design notes.
-- (Migration 0022 is reserved for the recurrence-backfill unique index applied
-- by bin/backfill-occurrence-date.py at cutover.)

CREATE TABLE chunk_completions (
  owner_subject      TEXT NOT NULL,
  task_id            TEXT NOT NULL,
  chunk_id           TEXT NOT NULL,
  done_at            TEXT NOT NULL,
  color_confirmed_at TEXT,
  source             TEXT NOT NULL,            -- 'color' | 'api'
  PRIMARY KEY (owner_subject, chunk_id)
);

CREATE INDEX idx_chunk_completions_task
  ON chunk_completions (owner_subject, task_id);
