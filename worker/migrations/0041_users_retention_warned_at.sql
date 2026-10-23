-- 0041_users_retention_warned_at.sql — hosted-trial O10b retention warning.
--
-- When RETENTION_DAYS is set, the daily sweep emails an idle user a deletion
-- warning (through the first-party SystemMailer) and stamps this column, so the
-- warning goes out once. Any activity (sign-in, or the throttled last_seen bump
-- on authenticated use) clears it back to NULL. The sweep deletes only users
-- warned at least 14 days earlier who are still idle past RETENTION_DAYS.
--
-- NULL = not warned since the user's last activity (every existing row).
ALTER TABLE users ADD COLUMN retention_warned_at TEXT;
