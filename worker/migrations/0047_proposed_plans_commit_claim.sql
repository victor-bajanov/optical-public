-- 0047_proposed_plans_commit_claim.sql — T3 (#2) of the 2026-10-27 review fixes.
--
-- A short lease commitPlan (worker/src/planning/commit.ts) takes on a pending
-- plan before its first calendar read, so two concurrent commits of one plan
-- (a double-click on the accept page, an agent's commit racing the user's
-- emailed link) can't both write the calendar. commit_claim is a random UUID
-- per attempt; commit_claimed_at is when it was taken. A claim older than
-- COMMIT_CLAIM_LEASE_MS (120 s, planning/proposed-plans.ts) is reclaimable,
-- so a worker killed mid-commit blocks re-clicks for at most that long. The
-- commit-mark requires the caller's own claim and clears both columns; a
-- failed commit releases its claim. NULL on every existing row (unclaimed).
--
-- Load-bearing: commitPlan reads and writes both columns, so deploying ahead
-- of this migration fails every commit.
ALTER TABLE proposed_plans ADD COLUMN commit_claim TEXT;
ALTER TABLE proposed_plans ADD COLUMN commit_claimed_at TEXT;
