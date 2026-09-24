-- 0005_fix_config_contexts.sql
-- Repair seeded context shapes to match the solver wire contract.
-- The 0002 seed encoded §3.4's descriptive table literally with avoid_*,
-- peak_windows, derived_from, and allowed_* keys; the solver schema
-- (FitCurve in solver/src/solver/schema.py) only accepts the
-- {peak_start, peak_end, falloff_end} triple. This migration collapses
-- each context to the supported shape.
--
-- Also clears proposed_plans: pre-prod data in old chunk_index shape
-- won't deserialise after this change; the next /v1/resolve regenerates.

DELETE FROM proposed_plans;

INSERT INTO config_contexts (context, body) VALUES
  ('deep',     json('{"context":"deep","fit_curve":{"peak_start":"09:00","peak_end":"12:00","falloff_end":"16:00"},"max_minutes_per_day":240,"max_contiguous_minutes":90,"over_daily_cap_penalty_per_15min":25,"over_streak_cap_penalty_per_15min":25}')),
  ('admin',    json('{"context":"admin","fit_curve":{"peak_start":"13:00","peak_end":"17:00","falloff_end":"17:00"},"max_minutes_per_day":120,"max_contiguous_minutes":60,"over_daily_cap_penalty_per_15min":25,"over_streak_cap_penalty_per_15min":25}')),
  ('physical', json('{"context":"physical","fit_curve":{"peak_start":"16:00","peak_end":"20:00","falloff_end":"22:00"},"max_minutes_per_day":null,"max_contiguous_minutes":null,"over_daily_cap_penalty_per_15min":0,"over_streak_cap_penalty_per_15min":0}')),
  ('family',   json('{"context":"family","fit_curve":{"peak_start":"17:00","peak_end":"20:00","falloff_end":"22:00"},"max_minutes_per_day":null,"max_contiguous_minutes":null,"over_daily_cap_penalty_per_15min":0,"over_streak_cap_penalty_per_15min":0}')),
  ('meeting',  json('{"context":"meeting","fit_curve":{"peak_start":"10:00","peak_end":"11:00","falloff_end":"17:00"},"max_minutes_per_day":180,"max_contiguous_minutes":120,"over_daily_cap_penalty_per_15min":25,"over_streak_cap_penalty_per_15min":25}'))
ON CONFLICT(context) DO UPDATE SET body = excluded.body;
