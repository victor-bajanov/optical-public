-- 0006_business_hours.sql — hard global business-hours policy.
--
-- buildSolverProblem injects this as a synthetic hard preferred_window on
-- any task whose pinned_at is null AND that carries no preferred_windows
-- of its own. Pinned tasks and tasks with explicit per-task windows
-- bypass — see spec §2.1.

CREATE TABLE config_business_hours (
  id INTEGER PRIMARY KEY,
  body TEXT NOT NULL  -- JSON: { days: Weekday[], start: "HH:MM", end: "HH:MM" }
);

INSERT INTO config_business_hours (id, body) VALUES (
  1,
  json('{"days":["mon","tue","wed","thu","fri"],"start":"09:00","end":"17:00"}')
);
