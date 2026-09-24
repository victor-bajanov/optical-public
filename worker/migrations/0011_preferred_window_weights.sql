-- 0011_preferred_window_weights.sql — add soft preferred-window weights to the
-- weights config. preferred_day_miss penalises each day-of-week off a soft
-- window's preferred day; preferred_time_miss_per_15min penalises each 15 min
-- the chunk falls outside the window's [start, end). See spec 2026-05-25.

UPDATE config_weights
SET body = json_set(
  body,
  '$.preferred_day_miss', 40,
  '$.preferred_time_miss_per_15min', 5
)
WHERE id = 1;
