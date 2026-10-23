-- 0042_pending_actions.sql — O9.1 agent-confirm mechanism.
--
-- When the calling OAuth client is listed in AGENT_CONFIRM_CLIENT_IDS, a
-- consequential op is not run: the handler stores it here and emails the user
-- a single-use confirm link (capability purpose "confirm-action"). The
-- browser POST to /confirm/{id} consumes the row with a CAS
-- (consumed_at IS NULL AND expires_at > now) and replays the op through the
-- registry in worker/src/confirm/.
--
--   op          registered op name (worker/src/confirm/registry.ts)
--   payload     JSON the op's replay needs, validated by the op's schema
--   summary     JSON the confirm page shows, validated by the op's schema
--   expires_at  created_at + 24 h (ISO 8601 UTC; compared as text)
--   consumed_at set once by the confirm POST's CAS; NULL = still pending
--
-- Owner-scoped: registered in lifecycle/owner-scoped-tables.ts, so offboard
-- deletes a leaver's rows. A consumed row's payload and summary are blanked
-- by the consume CAS. At every deferral, expired rows (any owner) are blanked
-- and rows over 7 days past expiry deleted; a link reaching an expired row
-- blanks it too.
CREATE TABLE pending_actions (
  id            TEXT PRIMARY KEY,
  owner_subject TEXT NOT NULL,
  op            TEXT NOT NULL,
  payload       TEXT NOT NULL,
  summary       TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  consumed_at   TEXT
);

CREATE INDEX idx_pending_actions_owner ON pending_actions(owner_subject, expires_at);
CREATE INDEX idx_pending_actions_expires ON pending_actions(expires_at);
