-- 0032_meeting_poll.sql — meeting-poll schema (open-range availability
-- painting + auto-book).
--
-- All schema this feature needs — including columns only later waves read —
-- lands here up front (plan §2.1: this is the ONLY migration in the whole
-- feature). Cells are stored UTC-canonical; every timestamp column in these
-- tables is a UTC ISO string, same convention as `bookings`.
CREATE TABLE polls (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  title TEXT NOT NULL,
  duration_min INTEGER NOT NULL,
  range_start TEXT NOT NULL,
  range_end TEXT NOT NULL,
  deadline_utc TEXT NOT NULL,
  location TEXT NOT NULL,
  guest_token_hash TEXT,
  status TEXT NOT NULL DEFAULT 'open',   -- open|booked|cancelled|needs_attention
  booked_slot_utc TEXT,
  gcal_event_id TEXT,
  nudged_midpoint_at TEXT,               -- cron idempotency stamps
  nudged_final_at TEXT,
  escalated_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE poll_invitees (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL REFERENCES polls(id),
  email TEXT NOT NULL,
  name TEXT,
  kind TEXT NOT NULL DEFAULT 'invited',  -- invited|guest
  token_hash TEXT NOT NULL,
  pseudonym TEXT NOT NULL,
  hide_name INTEGER NOT NULL DEFAULT 0,
  responded_at TEXT,
  dropped INTEGER NOT NULL DEFAULT 0,
  UNIQUE (poll_id, email)
);
CREATE TABLE poll_responses (
  invitee_id TEXT NOT NULL REFERENCES poll_invitees(id),
  cell_start_utc TEXT NOT NULL,
  state TEXT NOT NULL,                   -- free|if_needed
  PRIMARY KEY (invitee_id, cell_start_utc)
);
CREATE INDEX idx_poll_invitees_poll ON poll_invitees(poll_id);
CREATE INDEX idx_polls_subject_status ON polls(subject, status);
ALTER TABLE bookings ADD COLUMN poll_id TEXT;
