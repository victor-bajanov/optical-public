-- 0003_plans_and_sync.sql — proposed_plans + calendar_sync

CREATE TABLE proposed_plans (
  plan_hash TEXT PRIMARY KEY,
  body JSON NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  committed_at TEXT
);
CREATE INDEX plans_expires ON proposed_plans(expires_at);
CREATE INDEX plans_committed ON proposed_plans(committed_at);

CREATE TABLE calendar_sync (
  calendar_id TEXT PRIMARY KEY,
  next_sync_token TEXT,
  channel_id TEXT,
  channel_token TEXT,
  channel_expires_at TEXT
);
