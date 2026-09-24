-- 0027_plan_window_columns.sql — window identity for proposed plans.
-- The resolve window lives inside body JSON (body.window.{start,end}); lift it
-- into columns so supersede + per-week grouping are plain SQL. Window identity
-- is the PAIR (window_start, window_end) compared exactly; only window_start is
-- indexed (seek aid — the end comparison rides along unindexed).
ALTER TABLE proposed_plans ADD COLUMN window_start TEXT;
ALTER TABLE proposed_plans ADD COLUMN window_end TEXT;
UPDATE proposed_plans SET window_start = json_extract(body, '$.window.start'), window_end = json_extract(body, '$.window.end') WHERE window_start IS NULL;
CREATE INDEX plans_subject_window ON proposed_plans(subject, window_start);
