-- 0026_task_last_committed_move_at.sql — cascade-stability stamp.
-- ISO-8601 instant set by commitPlan ONLY when a meeting's calendar time actually
-- moved. resolve-internal freezes a meeting stamped within
-- MEETING_COMMIT_STABILITY_MINUTES. A system column (like scheduled_for): never
-- in task body, never PATCHable.
ALTER TABLE tasks ADD COLUMN last_committed_move_at TEXT;
