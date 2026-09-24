-- 0015_users.sql — canonical active-users source (Plan 4 brief A).
-- identity_tokens remains the credential store; this table governs membership
-- and role. Single-org model: subject is the user's email (= owner_subject).
CREATE TABLE users (
  subject TEXT PRIMARY KEY,
  role TEXT NOT NULL DEFAULT 'member',
  is_active INTEGER NOT NULL DEFAULT 1,
  last_seen TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX users_active ON users(is_active);
