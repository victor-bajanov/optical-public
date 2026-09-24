-- 0018_user_home_tz.sql — per-user timezone (Plan 6 brief B).
-- Nullable: an unset home_tz falls back to env.SCHEDULER_TZ in getHomeTz().
ALTER TABLE users ADD COLUMN home_tz TEXT;
