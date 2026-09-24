-- 0019_user_done_color_id.sql — per-user done color id (task done-marking feature).
-- Nullable: an unset done_color_id falls back to env.DONE_COLOR_ID in getDoneColorId().
ALTER TABLE users ADD COLUMN done_color_id TEXT;
