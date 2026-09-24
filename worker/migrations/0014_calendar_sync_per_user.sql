-- 0014_calendar_sync_per_user.sql — re-key calendar_sync on (owner_subject, calendar_id).
--
-- SQLite cannot change a table's primary key in place, so we rebuild the table.
-- The legacy single 'primary' row is intentionally NOT carried over: in pure SQL
-- we cannot know which owner it belonged to. It is re-created at cutover by a
-- verified per-user re-subscribe (see docs/runbook.md "Plan 3 cutover"). Stale
-- Google push channels self-expire (~7 days) or are stopped by the operator.
--
-- v1 supports the PRIMARY Google calendar only (calendar_id is always 'primary').
-- Shared/secondary calendars are out of scope, which keeps channel_id → single
-- owner routing valid (UNIQUE index below). NULL channel_id values are distinct
-- in SQLite, so unsubscribed owner rows never collide on the UNIQUE index.

ALTER TABLE calendar_sync RENAME TO calendar_sync_legacy;

CREATE TABLE calendar_sync (
  owner_subject TEXT NOT NULL,
  calendar_id TEXT NOT NULL,
  next_sync_token TEXT,
  channel_id TEXT,
  channel_token TEXT,
  channel_expires_at TEXT,
  channel_resource_id TEXT,
  channel_callback_url TEXT,
  PRIMARY KEY (owner_subject, calendar_id)
);

CREATE UNIQUE INDEX calendar_sync_channel_id ON calendar_sync(channel_id);

DROP TABLE calendar_sync_legacy;
