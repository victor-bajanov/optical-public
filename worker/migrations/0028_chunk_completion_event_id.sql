-- 0028_chunk_completion_event_id.sql — stamp WHICH calendar event confirmed a
-- chunk completion. The revive-scan then only honours an un-paint of that exact
-- event: a second event that happens to carry the same scheduler_chunk_id (the
-- 2026-07-06 duplicate-event incident) can no longer masquerade as a user
-- un-painting the confirmed chunk. NULL = legacy row / unconfirmed record; the
-- revive-scan falls back to the pre-0028 any-event rule for those.

ALTER TABLE chunk_completions ADD COLUMN event_id TEXT;
