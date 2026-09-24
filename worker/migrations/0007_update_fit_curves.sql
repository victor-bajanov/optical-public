-- 0007_update_fit_curves.sql
-- Tune per-context optimal placement windows from operator feedback:
--   deep:     peak 12:00-16:00 (afternoon focus), falloff 17:00
--   admin:    peak 09:00-12:00 (morning), falloff 15:00
--   physical: peak 11:00-15:00 (daylight), falloff 18:00
-- meeting and family stay as 0005 set them.

UPDATE config_contexts
SET body = json('{"context":"deep","fit_curve":{"peak_start":"12:00","peak_end":"16:00","falloff_end":"17:00"},"max_minutes_per_day":240,"max_contiguous_minutes":90,"over_daily_cap_penalty_per_15min":25,"over_streak_cap_penalty_per_15min":25}')
WHERE context = 'deep';

UPDATE config_contexts
SET body = json('{"context":"admin","fit_curve":{"peak_start":"09:00","peak_end":"12:00","falloff_end":"15:00"},"max_minutes_per_day":120,"max_contiguous_minutes":60,"over_daily_cap_penalty_per_15min":25,"over_streak_cap_penalty_per_15min":25}')
WHERE context = 'admin';

UPDATE config_contexts
SET body = json('{"context":"physical","fit_curve":{"peak_start":"11:00","peak_end":"15:00","falloff_end":"18:00"},"max_minutes_per_day":null,"max_contiguous_minutes":null,"over_daily_cap_penalty_per_15min":0,"over_streak_cap_penalty_per_15min":0}')
WHERE context = 'physical';
