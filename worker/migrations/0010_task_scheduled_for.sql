-- 0010_task_scheduled_for.sql — window-relative task shedding.
--
-- System-owned, nullable. ISO datetime = the start of a task's most recently
-- committed chunk; stamped by commitPlan (worker/src/planning/commit.ts) and
-- read by loadPendingTasks (worker/src/planning/resolve-internal.ts) as the
-- task's "claimed week". NOT part of the user-facing task schema
-- (worker/src/schema/task.ts): never accepted on create/patch, never echoed.
-- No backfill — legacy committed rows keep NULL; the overdue-deadline rule in
-- the inclusion predicate still sheds the ones that crash resolves.
ALTER TABLE tasks ADD COLUMN scheduled_for TEXT;
