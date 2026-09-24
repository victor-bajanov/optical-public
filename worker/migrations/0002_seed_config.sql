-- 0002_seed_config.sql — initial weights + context curves per §3.4.

INSERT INTO config_weights (id, body) VALUES (
  1,
  json('{"time_of_day_fit_per_15min":5,"churn_per_15min_moved":10,"priority_unit":1,"base_drop_penalty":200}')
);

INSERT INTO config_contexts (context, body) VALUES
  ('deep', json('{"context":"deep","fit_curve":{"peak_start":"09:00","peak_end":"12:00","falloff_end":"16:00"},"max_minutes_per_day":240,"max_contiguous_minutes":90,"over_daily_cap_penalty_per_15min":25,"over_streak_cap_penalty_per_15min":25}')),
  ('admin', json('{"context":"admin","fit_curve":{"peak_start":"13:00","peak_end":"17:00","falloff_end":"17:00"},"max_minutes_per_day":120,"max_contiguous_minutes":60,"over_daily_cap_penalty_per_15min":25,"over_streak_cap_penalty_per_15min":25}')),
  ('physical', json('{"context":"physical","fit_curve":{"peak_start":"16:00","peak_end":"16:00","falloff_end":"20:00","avoid_start":"09:00","avoid_end":"11:00"},"max_minutes_per_day":null,"max_contiguous_minutes":null,"over_daily_cap_penalty_per_15min":25,"over_streak_cap_penalty_per_15min":25}')),
  ('family', json('{"context":"family","fit_curve":{"derived_from":"pinned_at"},"max_minutes_per_day":null,"max_contiguous_minutes":null,"over_daily_cap_penalty_per_15min":25,"over_streak_cap_penalty_per_15min":25}')),
  ('meeting', json('{"context":"meeting","fit_curve":{"peak_windows":[{"start":"10:00","end":"11:00"},{"start":"14:00","end":"15:00"}],"allowed_start":"09:00","allowed_end":"17:00"},"max_minutes_per_day":180,"max_contiguous_minutes":120,"over_daily_cap_penalty_per_15min":25,"over_streak_cap_penalty_per_15min":25}'));
